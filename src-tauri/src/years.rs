//! Original release years from MusicBrainz, for songs whose files only carry the year of the
//! album they are on (compilations, remasters). Runs in the background when enabled in
//! Settings, one request per second as MusicBrainz asks, and never changes music files.
use crate::db::{err, Database, Result};
use serde_json::Value;
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use tauri::Emitter;

static RUNNING: AtomicBool = AtomicBool::new(false);
const AGENT: &str = concat!(
    "SlateMusic/",
    env!("CARGO_PKG_VERSION"),
    " ( https://github.com/SPARTANAC95/slate-music )"
);

pub fn enabled(db: &Database) -> bool {
    db.get("settings")["lookupYears"].as_bool() == Some(true)
}

fn words(text: &str) -> String {
    text.to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}
/// A title without reissue labels such as "(2011 Remaster)" or "- Mono Version", which name
/// the same recording.
pub fn plain_title(title: &str) -> String {
    let reissue = |part: &str| {
        let part = part.to_lowercase();
        ["remaster", "mono", "stereo", "deluxe", "bonus", "single version", "album version"]
            .iter()
            .any(|k| part.contains(k))
    };
    let mut t = title.to_string();
    while let Some(open) = t.rfind(['(', '[']) {
        if !reissue(&t[open..]) {
            break;
        }
        t.truncate(open);
    }
    if let Some(dash) = t.rfind(" - ") {
        if reissue(&t[dash..]) {
            t.truncate(dash);
        }
    }
    words(&t)
}
/// One lookup per song, shared by every copy of it in the library.
pub fn key(artist: &str, title: &str) -> String {
    format!("{}|{}", words(artist), plain_title(title))
}

/// The earliest first-release year among MusicBrainz recordings that match both the title
/// and the artist. Later live versions and reissues are ignored by taking the earliest.
pub fn earliest_year(response: &Value, artist: &str, title: &str) -> Option<u32> {
    let parts: Vec<String> = artist
        .split(['&', ',', ';', '/'])
        .flat_map(|p| p.split(" feat. ").flat_map(|p| p.split(" ft. ")).flat_map(|p| p.split(" and ")))
        .map(words)
        .filter(|p| !p.is_empty())
        .collect();
    let (artist, title) = (words(artist), plain_title(title));
    response["recordings"]
        .as_array()?
        .iter()
        .filter(|r| r["score"].as_u64().unwrap_or(0) >= 90)
        .filter(|r| plain_title(r["title"].as_str().unwrap_or_default()) == title)
        .filter(|r| {
            // Compare artist by artist: "Queen" matches a Queen & David Bowie recording but
            // not Queen Latifah, and a tag like "Queen & David Bowie" matches either credit.
            let credits: Vec<String> = r["artist-credit"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|a| a["name"].as_str())
                .map(words)
                .collect();
            !artist.is_empty()
                && (credits.join(" ") == artist
                    || credits.iter().any(|c| *c == artist || parts.contains(c)))
        })
        .filter_map(|r| r["first-release-date"].as_str()?.get(..4)?.parse().ok())
        .filter(|year| (1900..=2100).contains(year))
        .min()
}

fn quoted(text: &str) -> String {
    format!("\"{}\"", text.replace('\\', "\\\\").replace('"', "\\\""))
}
fn search(client: &reqwest::blocking::Client, artist: &str, title: &str) -> Result<Value> {
    // Search by the plain title: reissue labels ("- Remastered 2009") are rarely part of
    // MusicBrainz titles and would make the search miss.
    let query = format!("recording:{} AND artist:{}", quoted(&plain_title(title)), quoted(artist));
    for attempt in 0..3 {
        let r = client
            .get("https://musicbrainz.org/ws/2/recording")
            .query(&[("query", query.as_str()), ("fmt", "json"), ("limit", "25")])
            .send()
            .map_err(err)?;
        // 503 means "slow down"; wait and try again.
        if r.status().as_u16() == 503 && attempt < 2 {
            std::thread::sleep(Duration::from_secs(5));
            continue;
        }
        if !r.status().is_success() {
            return Err(format!("MusicBrainz answered {}", r.status()));
        }
        return r.json().map_err(err);
    }
    Err("MusicBrainz is busy".into())
}

/// Looks up every song that still needs a year, unless a lookup is already running or the
/// setting is off. Stops quietly when offline and tries again after the next scan.
pub fn start(db: Arc<Database>, app: tauri::AppHandle) {
    if !enabled(&db) || RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || {
        let client = reqwest::blocking::Client::builder()
            .user_agent(AGENT)
            .timeout(Duration::from_secs(20))
            .build();
        let mut found = 0;
        if let (Ok(client), Ok(needed)) = (client, db.years_needed()) {
            for song in needed {
                if !enabled(&db) {
                    break;
                }
                let Ok(response) = search(&client, &song.artist, &song.title) else {
                    break;
                };
                // A year after the album's own release would contradict the file; skip it.
                let year = earliest_year(&response, &song.artist, &song.title)
                    .filter(|y| song.album_year == 0 || *y <= song.album_year)
                    .unwrap_or(0);
                if db.set_original_year(&song.key, year).is_err() {
                    break;
                }
                if year > 0 {
                    found += 1;
                    if found % 20 == 0 {
                        let _ = app.emit("library-changed", ());
                    }
                }
                std::thread::sleep(Duration::from_millis(1100));
            }
        }
        if found > 0 {
            let _ = app.emit("library-changed", ());
        }
        RUNNING.store(false, Ordering::SeqCst);
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn reissue_labels_do_not_change_the_song() {
        assert_eq!(plain_title("Wired For Sound"), "wired for sound");
        assert_eq!(plain_title("Wired for Sound (2011 Remaster)"), "wired for sound");
        assert_eq!(plain_title("Help! - Remastered 2009"), "help");
        assert_eq!(plain_title("Song [Mono] (Deluxe Edition)"), "song");
        assert_eq!(plain_title("Song (Live at Wembley)"), "song live at wembley");
        assert_eq!(key("Cliff Richard", "Wired For Sound"), key("CLIFF RICHARD", "Wired for Sound"));
    }
    #[test]
    fn picks_the_earliest_matching_release() {
        let r = |title: &str, artist: &str, date: &str, score: u64| {
            json!({"title": title, "score": score, "first-release-date": date, "artist-credit": [{"name": artist}]})
        };
        let response = json!({"recordings": [
            r("Wired for Sound", "Cliff Richard", "2010", 100),
            r("Wired for Sound", "Cliff Richard", "1981-08-24", 100),
            r("Wired for Sound", "Tribute Band", "1975", 100),
            r("Wired", "Cliff Richard", "1970", 100),
            r("Wired for Sound", "Cliff Richard", "1960", 50),
            r("Wired For Sound", "Cliff Richard", "", 100),
        ]});
        assert_eq!(earliest_year(&response, "Cliff Richard", "Wired For Sound"), Some(1981));
        assert_eq!(earliest_year(&response, "Nobody", "Wired For Sound"), None);
        let queen = json!({"recordings": [r("Ladies First", "Queen Latifah", "1989", 100)]});
        assert_eq!(earliest_year(&queen, "Queen", "Ladies First"), None, "whole words only");
        // MusicBrainz lists each artist of a joint recording separately.
        let duo = json!({"recordings": [{"title": "Under Pressure", "score": 100, "first-release-date": "1981-10-26",
            "artist-credit": [{"name": "Queen"}, {"name": "David Bowie"}]}]});
        assert_eq!(earliest_year(&duo, "Queen", "Under Pressure"), Some(1981));
        assert_eq!(earliest_year(&duo, "Queen & David Bowie", "Under Pressure"), Some(1981));
        assert_eq!(earliest_year(&json!({}), "Cliff Richard", "Wired For Sound"), None);
    }
}
