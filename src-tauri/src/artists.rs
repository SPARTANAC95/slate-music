//! Artist photos and short bios, when enabled in Settings: MusicBrainz identifies the artist,
//! Wikidata links it to Wikipedia and Wikimedia Commons, and the photo is stored with the
//! album artwork. Each artist is looked up once; only the artist's name is sent.
use crate::db::{err, now, Database, Result};
use serde_json::{json, Value};
use std::time::Duration;

const AGENT: &str = concat!(
    "SlateMusic/",
    env!("CARGO_PKG_VERSION"),
    " ( https://github.com/SPARTANAC95/slate-music )"
);
/// Artists that could not be found are looked up again after this long.
const RETRY_MS: i64 = 30 * 24 * 3600 * 1000;

pub fn enabled(db: &Database) -> bool {
    db.get("settings")["lookupArtists"].as_bool() == Some(true)
}
fn client() -> Result<reqwest::blocking::Client> {
    reqwest::blocking::Client::builder()
        .user_agent(AGENT)
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(err)
}
fn get(client: &reqwest::blocking::Client, url: &str, query: &[(&str, &str)]) -> Result<Value> {
    let r = client.get(url).query(query).send().map_err(err)?;
    if !r.status().is_success() {
        return Err(format!("{} answered {}", url, r.status()));
    }
    r.json().map_err(err)
}
fn words(s: &str) -> String {
    crate::years::key(s, "").trim_end_matches('|').to_string()
}

/// The MusicBrainz artist whose name (or an alias) matches exactly, best score first.
pub fn pick_artist(response: &Value, name: &str) -> Option<String> {
    let wanted = words(name);
    response["artists"].as_array()?.iter().find_map(|a| {
        let named = words(a["name"].as_str().unwrap_or_default()) == wanted
            || a["aliases"]
                .as_array()
                .into_iter()
                .flatten()
                .any(|al| words(al["name"].as_str().unwrap_or_default()) == wanted);
        (named && a["score"].as_u64().unwrap_or(0) >= 90)
            .then(|| a["id"].as_str().map(str::to_owned))
            .flatten()
    })
}
/// The Wikidata item linked from a MusicBrainz artist, e.g. "Q1141426".
pub fn wikidata_id(artist: &Value) -> Option<String> {
    artist["relations"].as_array()?.iter().find_map(|r| {
        (r["type"] == "wikidata")
            .then(|| {
                r["url"]["resource"]
                    .as_str()?
                    .rsplit('/')
                    .next()
                    .map(str::to_owned)
            })
            .flatten()
            .filter(|q| q.starts_with('Q') && q[1..].chars().all(|c| c.is_ascii_digit()))
    })
}

fn lookup(db: &Database, name: &str) -> Result<Value> {
    let c = client()?;
    let query = format!(
        "artist:\"{}\"",
        name.replace('\\', "\\\\").replace('"', "\\\"")
    );
    let found = get(
        &c,
        "https://musicbrainz.org/ws/2/artist",
        &[("query", query.as_str()), ("fmt", "json"), ("limit", "5")],
    )?;
    let Some(mbid) = pick_artist(&found, name) else {
        return Ok(json!({ "found": false }));
    };
    // MusicBrainz asks for at most one request per second.
    std::thread::sleep(Duration::from_millis(1100));
    let artist = get(
        &c,
        &format!("https://musicbrainz.org/ws/2/artist/{mbid}"),
        &[("inc", "url-rels"), ("fmt", "json")],
    )?;
    let mut info = json!({ "found": true, "mbid": mbid });
    let Some(q) = wikidata_id(&artist) else {
        return Ok(info);
    };
    let entity = get(
        &c,
        &format!("https://www.wikidata.org/wiki/Special:EntityData/{q}.json"),
        &[],
    )?;
    let entity = &entity["entities"][&q];
    let photo_file = entity["claims"]["P18"][0]["mainsnak"]["datavalue"]["value"].as_str();
    if let Some(title) = entity["sitelinks"]["enwiki"]["title"].as_str() {
        let summary = get(
            &c,
            &format!(
                "https://en.wikipedia.org/api/rest_v1/page/summary/{}",
                title.replace(' ', "_")
            ),
            &[],
        )?;
        info["bio"] = summary["extract"].clone();
        info["wikipedia"] = summary["content_urls"]["desktop"]["page"].clone();
        if photo_file.is_none() {
            info["photoUrl"] = summary["thumbnail"]["source"].clone();
        }
    }
    if let Some(file) = photo_file {
        info["photoUrl"] = json!(format!(
            "https://commons.wikimedia.org/wiki/Special:FilePath/{}?width=800",
            file.replace(' ', "_")
        ));
        info["photoPage"] = json!(format!(
            "https://commons.wikimedia.org/wiki/File:{}",
            file.replace(' ', "_")
        ));
    }
    if let Some(url) = info["photoUrl"].as_str() {
        let bytes = c
            .get(url)
            .send()
            .and_then(|r| r.error_for_status())
            .and_then(|r| r.bytes());
        if let Some(hash) = bytes.ok().and_then(|b| crate::library::store_art(&b, db)) {
            info["photo"] = json!(hash);
        }
    }
    Ok(info)
}

/// Names that stand for no one in particular are never looked up.
fn nameless(key: &str) -> bool {
    matches!(
        key,
        "" | "various artists" | "various" | "va" | "unknown artist" | "unknown" | "soundtrack"
    )
}
/// Photo and bio for an artist, from the cache or (when enabled) looked up now.
pub fn info(db: &Database, name: &str) -> Result<Value> {
    let key = words(name);
    if nameless(&key) {
        return Ok(json!({ "found": false }));
    }
    let cached = db.artist_info(&key)?;
    let fresh = cached.as_ref().is_some_and(|c| {
        c["found"] == true || now() - c["checked"].as_i64().unwrap_or(0) < RETRY_MS
    });
    if !fresh && enabled(db) {
        if let Ok(mut found) = lookup(db, name) {
            found["checked"] = json!(now());
            db.set_artist_info(&key, &found)?;
            return Ok(found);
        }
    }
    Ok(cached.unwrap_or(json!({ "found": false })))
}

/// Photos already saved for these artists (no lookups), by the names given.
pub fn photos(db: &Database, names: &[String]) -> Result<serde_json::Map<String, Value>> {
    let saved = db.artist_photos()?;
    Ok(names
        .iter()
        .filter_map(|n| Some((n.clone(), json!(saved.get(&words(n))?))))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn picks_the_exact_artist_and_its_wikidata_item() {
        let response = json!({"artists": [
            {"id": "x", "name": "Empire of the Sun Tribute", "score": 100},
            {"id": "ac7e", "name": "Empire of the Sun", "score": 100},
            {"id": "low", "name": "Empire Of The Sun", "score": 40},
        ]});
        assert_eq!(
            pick_artist(&response, "Empire Of The Sun").as_deref(),
            Some("ac7e")
        );
        let alias = json!({"artists": [{"id": "q", "name": "Queen (band)", "score": 95, "aliases": [{"name": "Queen"}]}]});
        assert_eq!(pick_artist(&alias, "Queen").as_deref(), Some("q"));
        assert_eq!(pick_artist(&json!({"artists": []}), "Nobody"), None);
        let artist = json!({"relations": [
            {"type": "official homepage", "url": {"resource": "https://example.com"}},
            {"type": "wikidata", "url": {"resource": "https://www.wikidata.org/wiki/Q1141426"}},
        ]});
        assert_eq!(wikidata_id(&artist).as_deref(), Some("Q1141426"));
        assert_eq!(wikidata_id(&json!({"relations": []})), None);
    }
    #[test]
    fn nothing_is_looked_up_while_the_setting_is_off() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(dir.path()).unwrap();
        assert_eq!(info(&db, "Anyone").unwrap()["found"], false);
        db.set_artist_info(
            &words("Anyone"),
            &json!({"found": true, "bio": "Known", "checked": now()}),
        )
        .unwrap();
        assert_eq!(info(&db, "ANYONE").unwrap()["bio"], "Known");
        db.set_artist_info(&words("Pictured"), &json!({"found": true, "photo": "abc"}))
            .unwrap();
        let names = ["pictured".to_string(), "Anyone".to_string()];
        assert_eq!(
            Value::Object(photos(&db, &names).unwrap()),
            json!({"pictured": "abc"})
        );
        assert_eq!(info(&db, "Various Artists").unwrap()["found"], false);
    }
}
