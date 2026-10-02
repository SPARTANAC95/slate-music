//! Song lyrics, synced where possible. Looks in order at an .lrc file beside the song, lyrics
//! stored in the file's tags, and (only when enabled in Settings) LRCLIB, a free public
//! lyrics database. Online results are remembered; files are never changed.
use crate::db::{err, now, Database, Result, Track};
use lofty::{file::TaggedFileExt, tag::ItemKey};
use serde_json::{json, Value};
use std::{path::Path, time::Duration};

const AGENT: &str = concat!(
    "SlateMusic/",
    env!("CARGO_PKG_VERSION"),
    " ( https://github.com/SPARTANAC95/slate-music )"
);
/// Songs LRCLIB did not know are asked about again after this long.
const RETRY_MS: i64 = 30 * 24 * 3600 * 1000;

pub fn enabled(db: &Database) -> bool {
    db.get("settings")["lookupLyrics"].as_bool() == Some(true)
}

/// Whether text contains LRC time stamps such as "[01:23.45]".
pub fn is_synced(text: &str) -> bool {
    // Keep the accepted timestamp grammar in step with src/lrc.ts. Partial timestamps
    // must remain plain text, otherwise the renderer has no lines it can display.
    let digits = |s: &str, max: usize| {
        !s.is_empty() && s.len() <= max && s.bytes().all(|c| c.is_ascii_digit())
    };
    text.split('[').skip(1).any(|part| {
        let Some((stamp, _)) = part.split_once(']') else {
            return false;
        };
        let Some((minutes, seconds)) = stamp.split_once(':') else {
            return false;
        };
        let (seconds, fraction) = seconds
            .split_once(['.', ':'])
            .map_or((seconds, None), |(s, f)| (s, Some(f)));
        digits(minutes, 3)
            && digits(seconds, 2)
            && fraction.is_none_or(|fraction| digits(fraction, 3))
    })
}

fn answer(text: String, source: &str) -> Value {
    let text = text.replace("\r\n", "\n");
    if is_synced(&text) {
        json!({ "synced": text, "plain": null, "instrumental": false, "source": source })
    } else {
        json!({ "synced": null, "plain": text, "instrumental": false, "source": source })
    }
}

/// Lyrics already on this computer: an .lrc file beside the song, then the file's own tags.
fn local(track: &Track) -> Option<Value> {
    let path = Path::new(&track.path);
    if let Ok(bytes) = std::fs::read(path.with_extension("lrc")) {
        let text = String::from_utf8_lossy(&bytes)
            .trim_start_matches('\u{feff}')
            .to_string();
        if !text.trim().is_empty() {
            return Some(answer(text, "file"));
        }
    }
    let tagged = lofty::read_from_path(path).ok()?;
    let text = tagged
        .tags()
        .iter()
        .find_map(|tag| tag.get_string(&ItemKey::Lyrics).map(str::to_owned))?;
    (!text.trim().is_empty()).then(|| answer(text, "tag"))
}

fn cache_key(track: &Track) -> String {
    format!(
        "{}|{}",
        crate::years::key(&track.artist, &track.title),
        track.duration.round()
    )
}

/// Picks LRCLIB's best result: the exact match first, otherwise the closest length within
/// three seconds, preferring synced lyrics.
pub fn best_result(results: &[Value], duration: f64) -> Option<Value> {
    let has_text = |r: &Value, field: &str| {
        r[field]
            .as_str()
            .is_some_and(|text| !text.trim().is_empty())
    };
    results
        .iter()
        .filter(|r| {
            r["instrumental"] == true || has_text(r, "syncedLyrics") || has_text(r, "plainLyrics")
        })
        .filter(|r| {
            r["duration"]
                .as_f64()
                .is_none_or(|d| (d - duration).abs() <= 3.)
        })
        .min_by_key(|r| {
            let synced = has_text(r, "syncedLyrics");
            let delta = r["duration"].as_f64().map_or(3., |d| (d - duration).abs());
            (!synced, (delta * 10.) as i64)
        })
        .cloned()
}

fn lrclib(track: &Track) -> Result<Option<Value>> {
    let client = reqwest::blocking::Client::builder()
        .user_agent(AGENT)
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(err)?;
    let duration = track.duration.round().to_string();
    let r = client
        .get("https://lrclib.net/api/get")
        .query(&[
            ("track_name", track.title.as_str()),
            ("artist_name", track.artist.as_str()),
            ("album_name", track.album.as_str()),
            ("duration", duration.as_str()),
        ])
        .send()
        .map_err(err)?;
    if r.status().is_success() {
        return Ok(Some(r.json().map_err(err)?));
    }
    if r.status().as_u16() != 404 {
        return Err(format!("LRCLIB answered {}", r.status()));
    }
    let results: Vec<Value> = client
        .get("https://lrclib.net/api/search")
        .query(&[
            ("track_name", track.title.as_str()),
            ("artist_name", track.artist.as_str()),
        ])
        .send()
        .map_err(err)?
        .json()
        .map_err(err)?;
    Ok(best_result(&results, track.duration))
}

/// Lyrics for a song: `{synced, plain, instrumental, source}`, all null when none were found.
pub fn find(db: &Database, track: &Track) -> Result<Value> {
    if let Some(found) = local(track) {
        return Ok(found);
    }
    let key = cache_key(track);
    let cached = db.lyrics(&key)?;
    let fresh = cached.as_ref().is_some_and(|c| {
        c["synced"].is_string()
            || c["plain"].is_string()
            || c["instrumental"] == true
            || now() - c["checked"].as_i64().unwrap_or(0) < RETRY_MS
    });
    if !fresh && enabled(db) {
        // Offline or refused: answer from the cache, and try again another time.
        if let Ok(result) = lrclib(track) {
            let r = result.unwrap_or(Value::Null);
            let entry = json!({
                "synced": r["syncedLyrics"].as_str().filter(|s| !s.trim().is_empty()),
                "plain": r["plainLyrics"].as_str().filter(|s| !s.trim().is_empty()),
                "instrumental": r["instrumental"].as_bool().unwrap_or(false),
                "checked": now(),
            });
            db.set_lyrics(&key, &entry)?;
            return Ok(with_source(entry, "lrclib"));
        }
    }
    Ok(cached.map_or(
        json!({ "synced": null, "plain": null, "instrumental": false, "source": null }),
        |c| with_source(c, "lrclib"),
    ))
}
fn with_source(mut entry: Value, source: &str) -> Value {
    let found = entry["synced"].is_string() || entry["plain"].is_string();
    entry["source"] = if found { json!(source) } else { Value::Null };
    entry
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn recognizes_synced_lyrics() {
        assert!(is_synced(
            "[ar:Someone]\n[00:12.30]First line\n[00:15.00]Second"
        ));
        assert!(is_synced("  [1:02]Late start"));
        assert!(!is_synced("Just words\n[Chorus]\nMore words"));
        assert!(!is_synced(""));
    }
    #[test]
    fn only_treats_complete_supported_timestamps_as_synced() {
        for text in [
            "[1:2 people] sing",
            "[00:12.30 without a closing bracket",
            "[1234:05]Words",
        ] {
            assert!(!is_synced(text), "not a supported timestamp: {text}");
            assert_eq!(answer(text.into(), "file")["plain"], text);
        }
        // The renderer also understands a timestamp after a BOM or another tag.
        assert!(is_synced("\u{feff}[00:01.00]Hello"));
        assert!(is_synced("[ar:Someone][01:02:300]Hello"));
    }
    #[test]
    fn search_does_not_let_empty_results_hide_available_lyrics() {
        let results = vec![
            json!({"duration": 200.0, "plainLyrics": "", "syncedLyrics": "   "}),
            json!({"duration": 201.0, "plainLyrics": "Words", "syncedLyrics": null}),
        ];
        assert_eq!(
            best_result(&results, 200.0).unwrap()["plainLyrics"],
            "Words"
        );
        assert!(best_result(&results[..1], 200.0).is_none());
        assert_eq!(
            best_result(&[json!({"duration": 200.0, "instrumental": true})], 200.0).unwrap()
                ["instrumental"],
            true
        );
    }
    #[test]
    fn prefers_synced_results_with_the_closest_length() {
        let results = vec![
            json!({"duration": 200.0, "plainLyrics": "plain", "syncedLyrics": null}),
            json!({"duration": 202.0, "syncedLyrics": "[00:01]far"}),
            json!({"duration": 199.0, "syncedLyrics": "[00:01]near"}),
            json!({"duration": 260.0, "syncedLyrics": "[00:01]live version"}),
        ];
        assert_eq!(
            best_result(&results, 199.4).unwrap()["syncedLyrics"],
            "[00:01]near"
        );
        assert!(
            best_result(&results[3..], 199.4).is_none(),
            "a different length is not used"
        );
    }
    #[test]
    fn reads_an_lrc_file_beside_the_song_and_caches_online_misses() {
        let dir = tempfile::tempdir().unwrap();
        let song = dir.path().join("song.flac");
        std::fs::write(&song, b"not audio").unwrap();
        std::fs::write(
            dir.path().join("song.lrc"),
            "\u{feff}[00:01.00]Hello\r\n[00:03.00]World",
        )
        .unwrap();
        let db = Database::open(&dir.path().join("db")).unwrap();
        let track = Track {
            path: song.to_string_lossy().into(),
            title: "Song".into(),
            artist: "Someone".into(),
            duration: 5.,
            ..Default::default()
        };
        let found = find(&db, &track).unwrap();
        assert_eq!(found["source"], "file");
        assert_eq!(found["synced"], "[00:01.00]Hello\n[00:03.00]World");
        std::fs::remove_file(dir.path().join("song.lrc")).unwrap();
        // Online lookups are off by default, so nothing is found and nothing is asked.
        let none = find(&db, &track).unwrap();
        assert!(none["source"].is_null() && none["synced"].is_null());
        db.set_lyrics(&cache_key(&track), &json!({"synced": null, "plain": "From the web", "instrumental": false, "checked": now()}))
            .unwrap();
        assert_eq!(find(&db, &track).unwrap()["plain"], "From the web");
    }
}
