//! Album covers for the Discord status. Discord can only show a picture that has a public web
//! address, and fetches it itself, so the cover is not the one in the music file: the album is
//! looked for in Apple's iTunes catalogue, then Deezer's, then on MusicBrainz with its cover at
//! the Cover Art Archive. A cover counts only once its picture has actually loaded, because an
//! address that fails shows as a question mark in Discord. Each album is looked up once, in the
//! background, when enabled in Settings; only the album's name and its artist are sent.
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
const DAY_MS: i64 = 24 * 3600 * 1000;
/// Albums without a cover online are looked up again after this long.
const RETRY_MS: i64 = 30 * DAY_MS;
/// A cover that was found is checked again after this long, in case its address has gone.
const RECHECK_MS: i64 = 90 * DAY_MS;
/// After a lookup that could not be made (offline), the album is left alone for this long.
const FAILED_RETRY: Duration = Duration::from_secs(300);
/// Raised when where covers come from changes, so lookups saved before are made again.
/// (1 was the Cover Art Archive alone, whose pictures did not always load.)
const SOURCES: u64 = 2;

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

/// Words that name an edition of an album rather than a different album.
fn edition_word(word: &str) -> bool {
    const EDITION: [&str; 30] = [
        "anniversary",
        "bonus",
        "clean",
        "collector",
        "collectors",
        "complete",
        "deluxe",
        "edition",
        "ep",
        "expanded",
        "explicit",
        "extended",
        "international",
        "legacy",
        "mono",
        "original",
        "platinum",
        "reissue",
        "remaster",
        "remastered",
        "single",
        "special",
        "stereo",
        "super",
        "track",
        "tracks",
        "tour",
        "version",
        "the",
        "s",
    ];
    // "25th", "2011", "3".
    let number = ["st", "nd", "rd", "th"]
        .iter()
        .find_map(|ending| word.strip_suffix(ending))
        .unwrap_or(word);
    EDITION.contains(&word) || (!number.is_empty() && number.chars().all(|c| c.is_ascii_digit()))
}
/// How well a catalogue's album title fits the one wanted: 2 the same title, 1 the same album
/// in another edition ("Bad" for "Bad 25th Anniversary"), 0 a different album.
pub fn title_fit(wanted: &str, found: &str) -> u8 {
    let (wanted, found) = (words(wanted), words(found));
    if wanted.is_empty() || found.is_empty() {
        return 0;
    }
    if wanted == found {
        return 2;
    }
    let (wanted, found): (Vec<&str>, Vec<&str>) =
        (wanted.split(' ').collect(), found.split(' ').collect());
    let (short, long) = if wanted.len() < found.len() {
        (&wanted, &found)
    } else {
        (&found, &wanted)
    };
    // "Greatest Hits II" is not an edition of "Greatest Hits".
    let same_start = long.starts_with(short);
    u8::from(same_start && long[short.len()..].iter().all(|w| edition_word(w)))
}
/// Whether a catalogue's artist is the one wanted, alone or among several ("A & B").
pub fn artist_fits(wanted: &str, found: &str) -> bool {
    let parts = |name: &str| -> Vec<String> {
        name.split(['&', ',', ';', '/'])
            .flat_map(|p| p.split(" feat. "))
            .flat_map(|p| p.split(" and "))
            .map(words)
            .filter(|p| !p.is_empty())
            .collect()
    };
    let (whole_wanted, whole_found) = (words(wanted), words(found));
    !whole_wanted.is_empty()
        && (whole_wanted == whole_found
            || parts(found).contains(&whole_wanted)
            || parts(wanted).contains(&whole_found))
}
/// The best of a catalogue's albums: (artist, title, cover address) in the catalogue's order.
/// The same title wins over another edition; nothing is better than a different album.
pub fn best<'a>(
    artist: &str,
    album: &str,
    found: impl Iterator<Item = (&'a str, &'a str, &'a str)>,
) -> Option<String> {
    let mut pick: Option<(u8, &str)> = None;
    for (by, title, cover) in found {
        let fit = title_fit(album, title);
        // Discord takes addresses of up to 256 characters.
        let usable = !cover.is_empty() && cover.len() <= 240;
        if fit > pick.map_or(0, |p| p.0) && usable && artist_fits(artist, by) {
            pick = Some((fit, cover));
        }
    }
    pick.map(|p| p.1.to_owned())
}
/// The album's cover in Apple's iTunes catalogue, 600 pixels wide.
pub fn from_itunes(response: &Value, artist: &str, album: &str) -> Option<String> {
    let albums = response["results"].as_array()?.iter().map(|r| {
        (
            r["artistName"].as_str().unwrap_or_default(),
            r["collectionName"].as_str().unwrap_or_default(),
            r["artworkUrl100"].as_str().unwrap_or_default(),
        )
    });
    // The catalogue lists a small picture; the same address serves other sizes.
    best(artist, album, albums).map(|url| url.replace("100x100bb", "600x600bb"))
}
/// The album's cover in Deezer's catalogue, 500 pixels wide.
pub fn from_deezer(response: &Value, artist: &str, album: &str) -> Option<String> {
    let albums = response["data"].as_array()?.iter().map(|r| {
        (
            r["artist"]["name"].as_str().unwrap_or_default(),
            r["title"].as_str().unwrap_or_default(),
            r["cover_big"].as_str().unwrap_or_default(),
        )
    });
    best(artist, album, albums)
}
/// The MusicBrainz albums (release groups) with this title by this artist, best match first.
pub fn from_musicbrainz(response: &Value, artist: &str, album: &str) -> Vec<String> {
    response["release-groups"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|g| g["score"].as_u64().unwrap_or(0) >= 90)
        .filter(|g| title_fit(album, g["title"].as_str().unwrap_or_default()) == 2)
        .filter(|g| {
            let credits: Vec<&str> = g["artist-credit"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|a| a["name"].as_str())
                .collect();
            artist_fits(artist, &credits.join(" & "))
        })
        .filter_map(|g| g["id"].as_str())
        .map(|id| format!("https://coverartarchive.org/release-group/{id}/front-500"))
        .take(3)
        .collect()
}
/// Whether a saved lookup still stands.
fn fresh(saved: &Value, at: i64) -> bool {
    let age = at - saved["checked"].as_i64().unwrap_or(0);
    saved["v"].as_u64() == Some(SOURCES)
        && age
            < if saved["url"].is_string() {
                RECHECK_MS
            } else {
                RETRY_MS
            }
}

fn get(client: &reqwest::blocking::Client, url: &str, query: &[(&str, &str)]) -> Result<Value> {
    let r = client.get(url).query(query).send().map_err(err)?;
    if !r.status().is_success() {
        return Err(format!("{url} answered {}", r.status()));
    }
    r.json().map_err(err)
}
/// Whether the picture at this address really loads: what Discord will need it to do.
fn loads(client: &reqwest::blocking::Client, url: &str) -> bool {
    client.get(url).send().is_ok_and(|r| {
        r.status().is_success()
            && r.headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|t| t.to_str().ok())
                .is_some_and(|t| t.starts_with("image/"))
    })
}
/// Looks the album up in each catalogue in turn. Ok(None) when none has a cover that loads;
/// an error when no catalogue could be asked at all (offline), so it is tried again soon.
fn lookup(artist: &str, album: &str) -> Result<Option<String>> {
    let client = reqwest::blocking::Client::builder()
        .user_agent(AGENT)
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(err)?;
    let plain = words(album);
    let quoted = |text: &str| format!("\"{}\"", text.replace('\\', "\\\\").replace('"', "\\\""));
    let mut asked = false;

    let term = format!("{artist} {plain}");
    if let Ok(found) = get(
        &client,
        "https://itunes.apple.com/search",
        &[
            ("term", term.as_str()),
            ("media", "music"),
            ("entity", "album"),
            ("limit", "25"),
        ],
    ) {
        asked = true;
        if let Some(url) = from_itunes(&found, artist, album).filter(|url| loads(&client, url)) {
            return Ok(Some(url));
        }
    }
    let query = format!("artist:{} album:{}", quoted(artist), quoted(&plain));
    if let Ok(found) = get(
        &client,
        "https://api.deezer.com/search/album",
        &[("q", query.as_str()), ("limit", "25")],
    ) {
        asked = true;
        if let Some(url) = from_deezer(&found, artist, album).filter(|url| loads(&client, url)) {
            return Ok(Some(url));
        }
    }
    let query = format!(
        "releasegroup:{} AND artist:{}",
        quoted(&plain),
        quoted(artist)
    );
    crate::years::musicbrainz_turn();
    if let Ok(found) = get(
        &client,
        "https://musicbrainz.org/ws/2/release-group",
        &[("query", query.as_str()), ("fmt", "json"), ("limit", "10")],
    ) {
        asked = true;
        // The archive's pictures are served by the Internet Archive, which does not always
        // answer; the first that loads now is used.
        if let Some(url) = from_musicbrainz(&found, artist, album)
            .into_iter()
            .find(|url| loads(&client, url))
        {
            return Ok(Some(url));
        }
    }
    if asked {
        Ok(None)
    } else {
        Err("No cover catalogue could be reached".into())
    }
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
                let saved = json!({ "url": url, "checked": now(), "v": SOURCES });
                let _ = db.set_album_cover(&key, &saved);
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
    fn the_same_album_in_another_edition_fits_and_a_different_album_does_not() {
        assert_eq!(title_fit("Abbey Road", "abbey road"), 2);
        assert_eq!(title_fit("Abbey Road (2019 Remaster)", "Abbey Road"), 2);
        assert_eq!(title_fit("Bad 25th Anniversary", "Bad"), 1);
        assert_eq!(title_fit("The Highlights", "The Highlights (Deluxe)"), 2);
        assert_eq!(title_fit("Thriller", "Thriller 25 Super Deluxe Edition"), 1);
        assert_eq!(title_fit("Starboy", "Starboy - Single"), 1);
        assert_eq!(title_fit("Greatest Hits", "Greatest Hits II"), 0);
        assert_eq!(title_fit("Bad", "Bad Blood"), 0);
        assert_eq!(title_fit("", "Anything"), 0);
        assert!(artist_fits("The Weeknd", "the weeknd"));
        assert!(artist_fits("The Weeknd", "The Weeknd & ROSALÍA"));
        assert!(artist_fits("Queen & David Bowie", "Queen"));
        assert!(!artist_fits("Queen", "Queen Latifah"));
        assert!(!artist_fits("", "Anyone"));
    }
    #[test]
    fn picks_the_album_from_each_catalogue() {
        let itunes = json!({"results": [
            {"artistName": "The Weeknd", "collectionName": "Beauty Behind the Madness", "artworkUrl100": "https://a/1/100x100bb.jpg"},
            {"artistName": "Desi Valentine", "collectionName": "The Highlights", "artworkUrl100": "https://a/2/100x100bb.jpg"},
            {"artistName": "The Weeknd", "collectionName": "The Highlights - Single", "artworkUrl100": "https://a/3/100x100bb.jpg"},
            {"artistName": "The Weeknd", "collectionName": "The Highlights", "artworkUrl100": "https://a/4/100x100bb.jpg"},
        ]});
        assert_eq!(
            from_itunes(&itunes, "The Weeknd", "The Highlights").as_deref(),
            Some("https://a/4/600x600bb.jpg"),
            "the same title wins over an edition listed first"
        );
        assert_eq!(from_itunes(&itunes, "The Weeknd", "Dawn FM"), None);
        assert_eq!(
            from_itunes(&json!({}), "The Weeknd", "The Highlights"),
            None
        );
        let deezer = json!({"data": [
            {"artist": {"name": "Michael Jackson"}, "title": "Bad (Remastered)", "cover_big": "https://d/bad.jpg"},
            {"artist": {"name": "Michael Jackson"}, "title": "Dangerous", "cover_big": "https://d/dangerous.jpg"},
            {"artist": {"name": "Michael Jackson"}, "title": "Bad 25th Anniversary", "cover_big": ""},
        ]});
        assert_eq!(
            from_deezer(&deezer, "Michael Jackson", "Bad 25th Anniversary").as_deref(),
            Some("https://d/bad.jpg"),
            "an entry without a picture is passed over"
        );
        let g = |id: &str, title: &str, artists: &[&str], score: u64| {
            json!({"id": id, "title": title, "score": score,
                "artist-credit": artists.iter().map(|a| json!({"name": a})).collect::<Vec<_>>()})
        };
        let musicbrainz = json!({"release-groups": [
            g("low", "Abbey Road", &["The Beatles"], 60),
            g("tribute", "Abbey Road", &["The Tribute Band"], 100),
            g("other", "Abbey Road Sessions", &["The Beatles"], 100),
            g("album", "Abbey Road", &["The Beatles"], 100),
        ]});
        assert_eq!(
            from_musicbrainz(&musicbrainz, "the beatles", "Abbey Road (2019 Remaster)"),
            ["https://coverartarchive.org/release-group/album/front-500"]
        );
        assert_eq!(
            key("The Beatles", "Abbey Road [Deluxe Edition]"),
            key("THE BEATLES", "Abbey Road")
        );
    }
    #[test]
    fn saved_lookups_age_and_older_sources_are_asked_again() {
        let found = |v: u64| json!({"url": "https://x", "checked": 0, "v": v});
        assert!(fresh(&found(SOURCES), 80 * DAY_MS));
        assert!(!fresh(&found(SOURCES), 100 * DAY_MS));
        assert!(
            !fresh(&found(1), DAY_MS),
            "found before covers were checked"
        );
        assert!(!fresh(&json!({"url": "https://x", "checked": 0}), DAY_MS));
        let missed = json!({"url": null, "checked": 0, "v": SOURCES});
        assert!(fresh(&missed, 29 * DAY_MS));
        assert!(!fresh(&missed, 31 * DAY_MS));
    }
    #[test]
    #[ignore = "asks iTunes, Deezer, MusicBrainz and the Cover Art Archive"]
    fn finds_covers_that_load_online() {
        let client = reqwest::blocking::Client::new();
        for (artist, album) in [
            ("The Weeknd", "The Highlights"),
            ("Michael Jackson", "Bad 25th Anniversary"),
            ("The Beatles", "Abbey Road (Remastered)"),
        ] {
            let url = lookup(artist, album).unwrap().unwrap();
            println!("{artist} / {album}: {url}");
            assert!(loads(&client, &url));
        }
        assert_eq!(
            lookup("Nobody At All 5f3a", "An Album That Is Not There 91c2").unwrap(),
            None
        );
        // An address that answers with an error page is not a cover.
        assert!(!loads(
            &client,
            "https://archive.org/download/none/none.jpg"
        ));
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
        let saved = json!({"url": "https://example.org/cover.jpg", "checked": now(), "v": SOURCES});
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
