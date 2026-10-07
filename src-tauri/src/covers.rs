//! Album covers for the Discord status. Discord can only show a picture that has a public web
//! address, so the cover is not the one in the music file: MusicBrainz identifies the album
//! and the Cover Art Archive holds its cover. Each album is looked up once, in the background,
//! when enabled in Settings; only the album's name and its artist are sent.
use crate::db::{err, now, Database, Result, Track};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

const AGENT: &str = concat!(
    "SlateMusic/",
    env!("CARGO_PKG_VERSION"),
    " ( https://github.com/SPARTANAC95/slate-music )"
);
/// Albums without a cover online are looked up again after this long.
const RETRY_MS: i64 = 30 * 24 * 3600 * 1000;
/// After a lookup that could not be made (offline), the album is left alone for this long.
const FAILED_RETRY: Duration = Duration::from_secs(300);

/// What is known about an album's cover while Slate Music runs.
enum Known {
    Cover(Option<String>),
    Looking,
    Failed(Instant),
}
static KNOWN: Mutex<Option<HashMap<String, Known>>> = Mutex::new(None);

pub fn enabled(db: &Database) -> bool {
    db.get("settings")["discordCovers"].as_bool() != Some(false)
}
fn words(s: &str) -> String {
    crate::years::plain_title(s)
}
/// The artist an album is filed under: the album artist, or the song's when there is none.
fn album_artist(t: &Track) -> &str {
    if t.album_artist.trim().is_empty() {
        &t.artist
    } else {
        &t.album_artist
    }
}
/// One lookup per album, shared by its songs and by reissues ("(Deluxe Edition)").
pub fn key(artist: &str, album: &str) -> String {
    format!("{}|{}", words(artist), words(album))
}
/// The MusicBrainz albums (release groups) with this title by this artist, best match first.
pub fn pick_albums(response: &Value, artist: &str, album: &str) -> Vec<String> {
    let (artist, album) = (words(artist), words(album));
    response["release-groups"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|g| g["score"].as_u64().unwrap_or(0) >= 90)
        .filter(|g| words(g["title"].as_str().unwrap_or_default()) == album)
        .filter(|g| {
            let credits: Vec<String> = g["artist-credit"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|a| a["name"].as_str())
                .map(words)
                .collect();
            credits.join(" ") == artist || credits.contains(&artist)
        })
        .filter_map(|g| g["id"].as_str().map(str::to_owned))
        .take(3)
        .collect()
}
/// Where the Cover Art Archive keeps an album's front cover, 500 pixels wide.
pub fn address(mbid: &str) -> String {
    format!("https://coverartarchive.org/release-group/{mbid}/front-500")
}
/// Whether a saved lookup still stands: a cover stays, a miss is tried again after 30 days.
fn fresh(saved: &Value, at: i64) -> bool {
    saved["url"].is_string() || at - saved["checked"].as_i64().unwrap_or(0) < RETRY_MS
}

fn lookup(artist: &str, album: &str) -> Result<Option<String>> {
    // The archive answers with a redirect to the picture when it has one, so redirects are
    // not followed: the answer itself says whether there is a cover.
    let client = reqwest::blocking::Client::builder()
        .user_agent(AGENT)
        .timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(err)?;
    let quoted = |text: &str| format!("\"{}\"", text.replace('\\', "\\\\").replace('"', "\\\""));
    let query = format!(
        "releasegroup:{} AND artist:{}",
        quoted(&words(album)),
        quoted(artist)
    );
    crate::years::musicbrainz_turn();
    let r = client
        .get("https://musicbrainz.org/ws/2/release-group")
        .query(&[("query", query.as_str()), ("fmt", "json"), ("limit", "10")])
        .send()
        .map_err(err)?;
    if !r.status().is_success() {
        return Err(format!("MusicBrainz answered {}", r.status()));
    }
    let found: Value = r.json().map_err(err)?;
    for mbid in pick_albums(&found, artist, album) {
        let url = address(&mbid);
        let status = client.get(&url).send().map_err(err)?.status();
        if status.is_redirection() || status.is_success() {
            return Ok(Some(url));
        }
        if status.as_u16() != 404 {
            return Err(format!("The Cover Art Archive answered {status}"));
        }
    }
    Ok(None)
}

/// The web address of the cover of the album this song is on, when it is known. An album not
/// looked up yet is looked up in the background, so the answer may come a few seconds later.
pub fn cover(db: &Arc<Database>, t: &Track) -> Option<String> {
    let artist = album_artist(t).to_owned();
    if !enabled(db) || words(&t.album).is_empty() || words(&artist).is_empty() {
        return None;
    }
    let key = key(&artist, &t.album);
    let mut known = KNOWN.lock().unwrap();
    let known = known.get_or_insert_with(HashMap::new);
    match known.get(&key) {
        Some(Known::Cover(url)) => return url.clone(),
        Some(Known::Looking) => return None,
        Some(Known::Failed(at)) if at.elapsed() < FAILED_RETRY => return None,
        _ => {}
    }
    if let Some(saved) = db
        .album_cover(&key)
        .ok()
        .flatten()
        .filter(|s| fresh(s, now()))
    {
        let url = saved["url"].as_str().map(str::to_owned);
        known.insert(key, Known::Cover(url.clone()));
        return url;
    }
    known.insert(key.clone(), Known::Looking);
    let (db, album) = (db.clone(), t.album.clone());
    std::thread::spawn(move || {
        let result = match lookup(&artist, &album) {
            Ok(url) => {
                let _ = db.set_album_cover(&key, &json!({ "url": url, "checked": now() }));
                Known::Cover(url)
            }
            Err(_) => Known::Failed(Instant::now()),
        };
        if let Some(known) = KNOWN.lock().unwrap().as_mut() {
            known.insert(key, result);
        }
    });
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn picks_the_album_by_title_and_artist() {
        let g = |id: &str, title: &str, artists: &[&str], score: u64| {
            json!({"id": id, "title": title, "score": score,
                "artist-credit": artists.iter().map(|a| json!({"name": a})).collect::<Vec<_>>()})
        };
        let response = json!({"release-groups": [
            g("low", "Abbey Road", &["The Beatles"], 60),
            g("tribute", "Abbey Road", &["The Tribute Band"], 100),
            g("other", "Abbey Road Sessions", &["The Beatles"], 100),
            g("album", "Abbey Road", &["The Beatles"], 100),
            g("joint", "Abbey Road", &["The Beatles", "Friends"], 95),
        ]});
        assert_eq!(
            pick_albums(&response, "the beatles", "Abbey Road (2019 Remaster)"),
            ["album", "joint"]
        );
        assert!(pick_albums(&response, "Beatles", "Abbey Road").is_empty());
        assert!(pick_albums(&json!({}), "The Beatles", "Abbey Road").is_empty());
        assert_eq!(
            key("The Beatles", "Abbey Road [Deluxe Edition]"),
            key("THE BEATLES", "Abbey Road")
        );
        assert_eq!(
            address("9162580e"),
            "https://coverartarchive.org/release-group/9162580e/front-500"
        );
    }
    #[test]
    fn a_found_cover_stays_and_a_miss_is_tried_again_later() {
        let day = 24 * 3600 * 1000;
        assert!(fresh(&json!({"url": "https://x", "checked": 0}), 400 * day));
        assert!(fresh(&json!({"url": null, "checked": 0}), 29 * day));
        assert!(!fresh(&json!({"url": null, "checked": 0}), 31 * day));
    }
    #[test]
    #[ignore = "asks MusicBrainz and the Cover Art Archive"]
    fn finds_a_well_known_cover_online() {
        let url = lookup("The Beatles", "Abbey Road (Remastered)")
            .unwrap()
            .unwrap();
        assert!(url.starts_with("https://coverartarchive.org/release-group/"));
        assert_eq!(
            lookup("Nobody At All 5f3a", "An Album That Is Not There 91c2").unwrap(),
            None
        );
    }
    #[test]
    fn saved_covers_are_used_without_asking_again() {
        let dir = tempfile::tempdir().unwrap();
        let db = Arc::new(Database::open(dir.path()).unwrap());
        let mut t = Track {
            artist: "Cliff Richard".into(),
            album: "Wired for Sound".into(),
            ..Default::default()
        };
        let saved = json!({"url": "https://example.org/cover.jpg", "checked": now()});
        db.set_album_cover(&key("Cliff Richard", "Wired for Sound"), &saved)
            .unwrap();
        assert_eq!(
            cover(&db, &t).as_deref(),
            Some("https://example.org/cover.jpg")
        );
        // Switched off, or a song on no album: nothing is shown and nothing is asked.
        db.set("settings", &json!({"discordCovers": false}))
            .unwrap();
        assert_eq!(cover(&db, &t), None);
        db.set("settings", &json!({})).unwrap();
        t.album.clear();
        assert_eq!(cover(&db, &t), None);
    }
}
