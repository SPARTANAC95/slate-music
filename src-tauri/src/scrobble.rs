//! Last.fm scrobbling with the user's own Last.fm API account. A song is scrobbled once it has
//! played for half its length or four minutes (Last.fm's rule; songs under 30 seconds never
//! are), and "now playing" is sent when it starts. Scrobbles wait in the database while offline.
//! The API secret and session key are kept with Windows DPAPI, like the Spotify sign-in.
use crate::db::{err, now, Database, Result, Track};
use md5::{Digest, Md5};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

const API: &str = "https://ws.audioscrobbler.com/2.0/";
/// Tests point Slate Music at a stand-in Last.fm with SLATE_LASTFM_API (and no browser opens).
fn api() -> Option<String> {
    std::env::var("SLATE_LASTFM_API").ok()
}
const FILE: &str = "lastfm.dpapi";
/// Error codes: not yet authorized by the user, invalid session, invalid key or signature.
const NOT_AUTHORIZED: i64 = 14;
const INVALID_SESSION: i64 = 9;

#[derive(Serialize, Deserialize, Default, Clone)]
struct Secrets {
    secret: String,
    #[serde(default)]
    session: Option<String>,
    #[serde(default)]
    user: Option<String>,
}
/// The last problem sending to Last.fm, shown in Settings; and whether a sign-in is pending.
static PROBLEM: Mutex<Option<String>> = Mutex::new(None);
static WAITING: Mutex<bool> = Mutex::new(false);

fn problem(message: Option<String>) {
    *PROBLEM.lock().unwrap() = message;
}
fn load(db: &Database) -> Option<Secrets> {
    let bytes = std::fs::read(db.directory.join(FILE)).ok()?;
    let plain = crate::spotify::protect(&bytes, true).ok()?;
    serde_json::from_slice(&plain).ok()
}
fn save(db: &Database, s: &Secrets) -> Result<()> {
    let plain = serde_json::to_string(s).map_err(err)?;
    let data = crate::spotify::protect(plain.as_bytes(), false)?;
    std::fs::write(db.directory.join(FILE), data).map_err(err)
}
fn api_key(db: &Database) -> Option<String> {
    db.get("lastfm_api_key")
        .as_str()
        .filter(|k| !k.is_empty())
        .map(str::to_owned)
}
fn enabled(db: &Database) -> bool {
    db.get("settings")["scrobble"].as_bool() == Some(true)
}

/// Last.fm's request signature: the parameters sorted by name, joined as name+value, then the
/// secret, as an MD5 hex digest. `format` and `callback` are never signed.
pub fn sign(params: &[(String, String)], secret: &str) -> String {
    let mut sorted: Vec<&(String, String)> = params
        .iter()
        .filter(|(k, _)| k != "format" && k != "callback")
        .collect();
    sorted.sort_by(|a, b| a.0.cmp(&b.0));
    let mut text = String::new();
    for (k, v) in sorted {
        text.push_str(k);
        text.push_str(v);
    }
    text.push_str(secret);
    hex::encode(Md5::digest(text.as_bytes()))
}

enum Failure {
    Api(i64, String),
    Network,
}
impl Failure {
    fn message(&self) -> String {
        match self {
            Failure::Api(10, _) => "Last.fm doesn't recognise this API key.".into(),
            Failure::Api(13, _) => {
                "Last.fm says the shared secret doesn't match the API key.".into()
            }
            Failure::Api(26, _) => "Last.fm has suspended this API key.".into(),
            Failure::Api(29, _) => "Last.fm asked Slate Music to slow down; it will retry.".into(),
            Failure::Api(11 | 16, _) => "Last.fm is busy right now; Slate Music will retry.".into(),
            Failure::Api(code, m) => format!("Last.fm answered: {m} (error {code})"),
            Failure::Network => {
                "Last.fm can't be reached right now; Slate Music will retry.".into()
            }
        }
    }
}
fn call(
    key: &str,
    secret: &str,
    method: &str,
    mut params: Vec<(String, String)>,
    post: bool,
) -> std::result::Result<Value, Failure> {
    params.push(("method".into(), method.into()));
    params.push(("api_key".into(), key.into()));
    let sig = sign(&params, secret);
    params.push(("api_sig".into(), sig));
    params.push(("format".into(), "json".into()));
    let client = reqwest::blocking::Client::builder()
        .user_agent(concat!("SlateMusic/", env!("CARGO_PKG_VERSION")))
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|_| Failure::Network)?;
    let url = api().unwrap_or_else(|| API.into());
    let request = if post {
        client.post(&url).form(&params)
    } else {
        client.get(&url).query(&params)
    };
    let response = request.send().map_err(|_| Failure::Network)?;
    let value: Value = response.json().map_err(|_| Failure::Network)?;
    match value["error"].as_i64() {
        Some(code) => Err(Failure::Api(
            code,
            value["message"].as_str().unwrap_or_default().to_owned(),
        )),
        None => Ok(value),
    }
}

/// What Settings shows.
pub fn status(db: &Database) -> Value {
    let secrets = load(db);
    json!({
        "configured": api_key(db).is_some() && secrets.is_some(),
        "connected": secrets.as_ref().is_some_and(|s| s.session.is_some()),
        "user": secrets.and_then(|s| s.user),
        "waiting": *WAITING.lock().unwrap(),
        "pending": db.scrobbles_pending().unwrap_or(0),
        "problem": PROBLEM.lock().unwrap().clone(),
    })
}
fn looks_like_key(s: &str) -> bool {
    s.len() == 32 && s.chars().all(|c| c.is_ascii_hexdigit())
}
/// Saves the user's API key and shared secret after checking them with Last.fm.
pub fn setup(db: &Database, key: &str, secret: &str) -> Result<Value> {
    let (key, secret) = (key.trim(), secret.trim());
    if !looks_like_key(key) || !looks_like_key(secret) {
        return Err("The API key and shared secret are each 32 letters and numbers, as shown on your Last.fm API account page.".into());
    }
    match call(key, secret, "auth.getToken", vec![], false) {
        Err(f @ Failure::Api(..)) => return Err(f.message()),
        // Offline: keep them, they are checked again when you connect.
        Err(Failure::Network) | Ok(_) => {}
    }
    db.set("lastfm_api_key", &json!(key))?;
    save(
        db,
        &Secrets {
            secret: secret.into(),
            ..Default::default()
        },
    )?;
    problem(None);
    Ok(status(db))
}
/// Opens Last.fm in the browser to allow Slate Music, then waits (up to five minutes) for the
/// user to approve it there.
pub fn connect(db: Arc<Database>) -> Result<()> {
    let (Some(key), Some(secrets)) = (api_key(&db), load(&db)) else {
        return Err("Add your Last.fm API key and shared secret first.".into());
    };
    let token = call(&key, &secrets.secret, "auth.getToken", vec![], false)
        .map_err(|f| f.message())?["token"]
        .as_str()
        .ok_or("Last.fm didn't send a sign-in token")?
        .to_owned();
    if api().is_none() {
        open::that(format!(
            "https://www.last.fm/api/auth/?api_key={key}&token={token}"
        ))
        .map_err(err)?;
    }
    *WAITING.lock().unwrap() = true;
    problem(None);
    std::thread::spawn(move || {
        let started = Instant::now();
        while started.elapsed() < Duration::from_secs(300) {
            std::thread::sleep(Duration::from_secs(3));
            let params = vec![("token".to_string(), token.clone())];
            match call(&key, &secrets.secret, "auth.getSession", params, false) {
                Ok(v) => {
                    let mut s = secrets.clone();
                    s.session = v["session"]["key"].as_str().map(str::to_owned);
                    s.user = v["session"]["name"].as_str().map(str::to_owned);
                    if let Err(e) = save(&db, &s) {
                        problem(Some(e));
                    }
                    break;
                }
                Err(Failure::Api(NOT_AUTHORIZED, _)) | Err(Failure::Network) => continue,
                Err(f) => {
                    problem(Some(f.message()));
                    break;
                }
            }
        }
        *WAITING.lock().unwrap() = false;
    });
    Ok(())
}
/// Signs out of Last.fm but keeps the API key, so connecting again is one click.
pub fn disconnect(db: &Database) -> Result<()> {
    if let Some(mut s) = load(db) {
        s.session = None;
        s.user = None;
        save(db, &s)?;
    }
    problem(None);
    Ok(())
}
/// Removes the API key, secret and sign-in.
pub fn forget(db: &Database) -> Result<()> {
    let path = db.directory.join(FILE);
    if path.exists() {
        std::fs::remove_file(path).map_err(err)?;
    }
    db.set("lastfm_api_key", &Value::Null)?;
    problem(None);
    Ok(())
}

fn scrobble_of(t: &Track, started: i64) -> Value {
    json!({
        "artist": t.artist,
        "track": t.title,
        "album": t.album,
        "albumArtist": if t.album_artist != t.artist { t.album_artist.as_str() } else { "" },
        "duration": t.duration.round() as i64,
        "timestamp": started,
        "trackNumber": t.track,
    })
}
fn text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Number(n) if n.as_i64() != Some(0) => n.to_string(),
        _ => String::new(),
    }
}
const FIELDS: [&str; 7] = [
    "artist",
    "track",
    "album",
    "albumArtist",
    "duration",
    "timestamp",
    "trackNumber",
];
fn signed_out(db: &Database, secrets: &Secrets) {
    let mut s = secrets.clone();
    s.session = None;
    s.user = None;
    let _ = save(db, &s);
    problem(Some(
        "Last.fm signed Slate Music out. Connect again in Settings; waiting scrobbles are kept."
            .into(),
    ));
}
/// Sends waiting scrobbles, 50 at a time; they stay queued if Last.fm can't take them now.
fn flush(db: &Database) {
    let (Some(key), Some(secrets)) = (api_key(db), load(db)) else {
        return;
    };
    let Some(session) = secrets.session.clone() else {
        return;
    };
    loop {
        let batch = db.scrobbles(50).unwrap_or_default();
        if batch.is_empty() {
            break;
        }
        let mut params = vec![("sk".to_string(), session.clone())];
        for (i, (_, s)) in batch.iter().enumerate() {
            for field in FIELDS {
                let v = text(&s[field]);
                if !v.is_empty() {
                    params.push((format!("{field}[{i}]"), v));
                }
            }
        }
        match call(&key, &secrets.secret, "track.scrobble", params, true) {
            Ok(_) => {
                let ids: Vec<i64> = batch.iter().map(|(id, _)| *id).collect();
                let _ = db.remove_scrobbles(&ids);
                problem(None);
            }
            Err(Failure::Api(INVALID_SESSION, _)) => {
                signed_out(db, &secrets);
                break;
            }
            Err(f) => {
                problem(Some(f.message()));
                break;
            }
        }
    }
}
fn now_playing(db: &Database, t: &Track) {
    let (Some(key), Some(secrets)) = (api_key(db), load(db)) else {
        return;
    };
    let Some(session) = secrets.session.clone() else {
        return;
    };
    let mut params = vec![("sk".to_string(), session)];
    let s = scrobble_of(t, 0);
    for field in FIELDS {
        let v = text(&s[field]);
        if !v.is_empty() {
            params.push((field.to_string(), v));
        }
    }
    if let Err(Failure::Api(INVALID_SESSION, _)) = call(
        &key,
        &secrets.secret,
        "track.updateNowPlaying",
        params,
        true,
    ) {
        signed_out(db, &secrets);
    }
}

pub enum Event {
    NowPlaying(Track),
    Scrobble(Value),
}
struct Play {
    track: Track,
    /// When it first played (Unix seconds); 0 until then.
    started: i64,
    listened: f64,
    last_position: f64,
    announced: bool,
    scrobbled: bool,
}
/// Follows one song at a time and decides when it counts as listened to.
#[derive(Default)]
pub struct Tracker {
    play: Option<Play>,
}
impl Tracker {
    /// One look at playback, `elapsed` seconds after the last. Only time spent playing counts,
    /// so pausing or skipping around doesn't scrobble a song early.
    pub fn tick(
        &mut self,
        current: Option<&str>,
        position: f64,
        playing: bool,
        elapsed: f64,
        now_secs: i64,
        load: impl FnOnce(&str) -> Option<Track>,
    ) -> Vec<Event> {
        let Some(id) = current else {
            self.play = None;
            return vec![];
        };
        // The same song starting over (repeat one) is a new listen.
        let restarted = self.play.as_ref().is_some_and(|p| {
            p.track.id == id && position < 3.0 && position + 5.0 < p.last_position
        });
        if restarted || self.play.as_ref().is_none_or(|p| p.track.id != id) {
            self.play = load(id).map(|track| Play {
                track,
                started: 0,
                listened: 0.,
                last_position: position,
                announced: false,
                scrobbled: false,
            });
        }
        let Some(p) = self.play.as_mut() else {
            return vec![];
        };
        let mut events = vec![];
        p.last_position = position;
        if !playing {
            return events;
        }
        if p.started == 0 {
            p.started = now_secs;
        } else {
            p.listened += elapsed;
        }
        if !p.announced {
            p.announced = true;
            events.push(Event::NowPlaying(p.track.clone()));
        }
        let needed = (p.track.duration / 2.).min(240.);
        if !p.scrobbled && p.track.duration >= 30. && p.listened >= needed {
            p.scrobbled = true;
            events.push(Event::Scrobble(scrobble_of(&p.track, p.started)));
        }
        events
    }
}

enum Job {
    NowPlaying(Box<Track>),
    Flush,
}
/// Watches playback once a second while scrobbling is on and you are connected.
pub fn start(db: Arc<Database>, engine: Arc<crate::audio::Engine>) {
    let (jobs, inbox) = mpsc::channel::<Job>();
    let worker_db = db.clone();
    // Network calls run apart from the watcher, so a slow answer never skews listening time.
    std::thread::spawn(move || {
        for job in inbox {
            match job {
                Job::NowPlaying(t) => now_playing(&worker_db, &t),
                Job::Flush => flush(&worker_db),
            }
        }
    });
    std::thread::spawn(move || {
        let mut tracker = Tracker::default();
        let mut last_tick = Instant::now();
        let mut last_flush = Instant::now();
        let mut checked: Option<Instant> = None;
        let mut ready = false;
        loop {
            std::thread::sleep(Duration::from_secs(1));
            let elapsed = last_tick.elapsed().as_secs_f64().min(2.0);
            last_tick = Instant::now();
            if checked.is_none_or(|c| c.elapsed() > Duration::from_secs(10)) {
                let was = ready;
                ready = enabled(&db)
                    && api_key(&db).is_some()
                    && load(&db).is_some_and(|s| s.session.is_some());
                checked = Some(Instant::now());
                if ready && !was && db.scrobbles_pending().unwrap_or(0) > 0 {
                    let _ = jobs.send(Job::Flush);
                }
            }
            if !ready {
                tracker = Tracker::default();
                continue;
            }
            let s = engine.snapshot();
            let events = tracker.tick(
                s.current_id.as_deref(),
                s.position,
                s.playing,
                elapsed,
                now() / 1000,
                |id| db.track(id).ok(),
            );
            for event in events {
                match event {
                    Event::NowPlaying(t) => {
                        let _ = jobs.send(Job::NowPlaying(Box::new(t)));
                    }
                    Event::Scrobble(v) => {
                        let _ = db.queue_scrobble(&v);
                        let _ = jobs.send(Job::Flush);
                        last_flush = Instant::now();
                    }
                }
            }
            if last_flush.elapsed() > Duration::from_secs(300) {
                last_flush = Instant::now();
                if db.scrobbles_pending().unwrap_or(0) > 0 {
                    let _ = jobs.send(Job::Flush);
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    fn song(id: &str, duration: f64) -> Track {
        Track {
            id: id.into(),
            path: format!("{id}.flac"),
            folder: String::new(),
            title: format!("Title {id}"),
            artist: "Artist".into(),
            album: "Album".into(),
            album_artist: "Various Artists".into(),
            year: 2000,
            track: 3,
            disc: 1,
            duration,
            format: "FLAC".into(),
            sample_rate: 44100,
            bit_depth: 16,
            artwork: None,
            favorite: false,
            missing: false,
            play_count: 0,
            last_played: 0,
            added: 0,
            size: 1,
            original_year: 0,
        }
    }
    #[test]
    fn signs_requests_like_last_fm() {
        let params = vec![
            ("token".to_string(), "xyz".to_string()),
            ("method".to_string(), "auth.getSession".to_string()),
            ("api_key".to_string(), "abc".to_string()),
            ("format".to_string(), "json".to_string()),
        ];
        assert_eq!(sign(&params, "secret"), "f81f920d21fa903b7fa44ae2857c6bbd");
    }
    fn run(
        tracker: &mut Tracker,
        id: &str,
        duration: f64,
        seconds: usize,
        playing: bool,
        start: i64,
        from: f64,
    ) -> Vec<Event> {
        (0..seconds)
            .flat_map(|i| {
                tracker.tick(
                    Some(id),
                    if playing { from + i as f64 } else { from },
                    playing,
                    1.0,
                    start + i as i64,
                    |id| Some(song(id, duration)),
                )
            })
            .collect()
    }
    #[test]
    fn scrobbles_after_half_the_song_or_four_minutes_of_listening() {
        let mut t = Tracker::default();
        let events = run(&mut t, "a", 200., 100, true, 1_000, 0.);
        assert!(matches!(events[0], Event::NowPlaying(_)));
        assert_eq!(events.len(), 1, "99 seconds heard is not yet half");
        let events = run(&mut t, "a", 200., 3, true, 1_100, 100.);
        let Event::Scrobble(s) = &events[0] else {
            panic!("scrobbles at half the song")
        };
        assert_eq!(s["timestamp"], 1_000);
        assert_eq!(s["albumArtist"], "Various Artists");
        assert_eq!(
            run(&mut t, "a", 200., 90, true, 1_200, 103.).len(),
            0,
            "only once"
        );

        let mut long = Tracker::default();
        let events = run(&mut long, "b", 3600., 242, true, 0, 0.);
        assert!(events.iter().any(|e| matches!(e, Event::Scrobble(_))));
        let mut short = Tracker::default();
        let events = run(&mut short, "c", 25., 25, true, 0, 0.);
        assert!(!events.iter().any(|e| matches!(e, Event::Scrobble(_))));
    }
    #[test]
    fn paused_time_does_not_count_and_repeats_count_again() {
        let mut t = Tracker::default();
        assert!(run(&mut t, "a", 100., 500, false, 0, 0.).is_empty());
        assert_eq!(
            run(&mut t, "a", 100., 50, true, 500, 0.).len(),
            1,
            "only now playing"
        );
        let events = run(&mut t, "a", 100., 2, true, 550, 50.);
        assert!(matches!(events[0], Event::Scrobble(_)));
        // Repeat one: the song starts over and is heard again.
        t.tick(Some("a"), 95., true, 1., 200, |id| Some(song(id, 100.)));
        let events = run(&mut t, "a", 100., 52, true, 300, 0.);
        assert!(events.iter().any(|e| matches!(e, Event::Scrobble(_))));
    }
    #[test]
    fn waiting_scrobbles_are_kept_in_order() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(dir.path()).unwrap();
        db.queue_scrobble(&json!({"track": "one"})).unwrap();
        db.queue_scrobble(&json!({"track": "two"})).unwrap();
        assert_eq!(db.scrobbles_pending().unwrap(), 2);
        let batch = db.scrobbles(50).unwrap();
        assert_eq!(batch[0].1["track"], "one");
        db.remove_scrobbles(&[batch[0].0]).unwrap();
        assert_eq!(db.scrobbles(50).unwrap()[0].1["track"], "two");
        assert_eq!(status(&db)["configured"], false);
    }
}
