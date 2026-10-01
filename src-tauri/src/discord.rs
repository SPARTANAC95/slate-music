//! Discord Rich Presence: while a song plays, Discord shows "Listening to <your app name>" with
//! the title, artist and a progress bar. It talks to the Discord app on this PC through its local
//! pipe (nothing is sent over the internet by Slate Music) using the user's own Discord
//! application ID. Paused or stopped clears the status.
use crate::db::{now, Database, Track};
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

/// Whether Discord is connected, and why not when it isn't.
static STATUS: Mutex<(bool, Option<String>)> = Mutex::new((false, None));
fn set_status(connected: bool, problem: Option<String>) {
    *STATUS.lock().unwrap() = (connected, problem);
}
pub fn status(db: &Database) -> Value {
    let (connected, problem) = STATUS.lock().unwrap().clone();
    json!({
        "clientId": client_id(db),
        "connected": connected,
        "problem": problem,
    })
}
fn client_id(db: &Database) -> Option<String> {
    db.get("discord_client_id")
        .as_str()
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}
/// Saves the Discord application ID ("" removes it).
pub fn setup(db: &Database, id: &str) -> crate::db::Result<Value> {
    let id = id.trim();
    if !id.is_empty() && (!(17..=20).contains(&id.len()) || !id.chars().all(|c| c.is_ascii_digit()))
    {
        return Err("The Application ID is a long number (17 to 20 digits) from the General Information page of your Discord application.".into());
    }
    db.set("discord_client_id", &json!(id))?;
    Ok(status(db))
}

/// Discord's pipe frames: a little-endian opcode and length, then JSON.
pub fn frame(op: u32, data: &Value) -> Vec<u8> {
    let body = data.to_string().into_bytes();
    let mut out = Vec::with_capacity(body.len() + 8);
    out.extend_from_slice(&op.to_le_bytes());
    out.extend_from_slice(&(body.len() as u32).to_le_bytes());
    out.extend_from_slice(&body);
    out
}
pub fn read_frame(from: &mut impl Read) -> std::io::Result<(u32, Value)> {
    let mut head = [0u8; 8];
    from.read_exact(&mut head)?;
    let op = u32::from_le_bytes(head[..4].try_into().unwrap());
    let len = u32::from_le_bytes(head[4..].try_into().unwrap()) as usize;
    if len > 1 << 20 {
        return Err(std::io::Error::other("Discord sent an oversized message"));
    }
    let mut body = vec![0u8; len];
    from.read_exact(&mut body)?;
    Ok((op, serde_json::from_slice(&body).unwrap_or(Value::Null)))
}
/// Discord asks for 2 to 128 characters.
fn fit(s: &str) -> String {
    let s: String = s.chars().take(128).collect();
    if s.chars().count() < 2 {
        format!("{s} ♪")
    } else {
        s
    }
}
/// The activity for a song that started `start_ms` ago.
pub fn activity(t: &Track, start_ms: i64) -> Value {
    let by = if t.album.is_empty() {
        t.artist.clone()
    } else {
        format!("{} · {}", t.artist, t.album)
    };
    json!({
        "type": 2,
        "details": fit(&t.title),
        "state": fit(&by),
        "timestamps": {
            "start": start_ms,
            "end": start_ms + (t.duration * 1000.) as i64,
        },
    })
}

/// How long Discord gets to answer before the connection counts as lost.
const ANSWER: Duration = Duration::from_secs(5);

/// Opens Discord's pipe and introduces Slate Music with the user's application ID.
fn open(id: &str) -> Result<std::fs::File, String> {
    // Tests use a stand-in Discord on other pipes (SLATE_DISCORD_PIPE).
    let prefix =
        std::env::var("SLATE_DISCORD_PIPE").unwrap_or_else(|_| r"\\.\pipe\discord-ipc-".into());
    for i in 0..10 {
        let path = format!("{prefix}{i}");
        let Ok(mut pipe) = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&path)
        else {
            continue;
        };
        let hello = frame(0, &json!({ "v": 1, "client_id": id }));
        pipe.write_all(&hello).map_err(|e| e.to_string())?;
        let (op, reply) = read_frame(&mut pipe).map_err(|e| e.to_string())?;
        if op == 1 && reply["evt"] == "READY" {
            return Ok(pipe);
        }
        return Err(format!(
            "Discord didn't accept this Application ID ({}).",
            reply["message"].as_str().unwrap_or("no reason given")
        ));
    }
    Err("Discord isn't running.".into())
}
fn send(
    pipe: &mut (impl Read + Write),
    nonce: &mut u64,
    activity: &Value,
) -> std::io::Result<Value> {
    *nonce += 1;
    let nonce = nonce.to_string();
    let message = json!({
        "cmd": "SET_ACTIVITY",
        "args": { "pid": std::process::id(), "activity": activity },
        "nonce": nonce,
    });
    pipe.write_all(&frame(1, &message))?;
    loop {
        let (op, reply) = read_frame(pipe)?;
        match op {
            2 => return Err(std::io::Error::other("Discord closed the connection")),
            3 => pipe.write_all(&frame(4, &reply))?,
            _ if reply["nonce"] == nonce.as_str() => return Ok(reply),
            _ => {}
        }
    }
}
/// Sets the activity; if Discord rejects the listening type, falls back to a plain one.
/// Returns why Discord refused it, or None when it is shown.
fn set(
    pipe: &mut (impl Read + Write),
    nonce: &mut u64,
    activity: &Value,
) -> std::io::Result<Option<String>> {
    let reply = send(pipe, nonce, activity)?;
    if reply["evt"] == "ERROR" && !activity.is_null() {
        let mut plain = activity.clone();
        plain.as_object_mut().map(|a| a.remove("type"));
        let again = send(pipe, nonce, &plain)?;
        if again["evt"] == "ERROR" {
            return Ok(Some(format!(
                "Discord refused the status: {}",
                again["data"]["message"]
                    .as_str()
                    .unwrap_or("unknown reason")
            )));
        }
    }
    Ok(None)
}
/// A connection to Discord. The pipe is used from a thread of its own, because reading a
/// Windows pipe can't time out: a Discord that stops answering is given up on after a few
/// seconds instead of freezing the status updates.
struct Client {
    requests: mpsc::Sender<Value>,
    answers: mpsc::Receiver<Result<Option<String>, String>>,
}
impl Client {
    fn connect(id: &str) -> Result<Client, String> {
        let (requests, inbox) = mpsc::channel::<Value>();
        let (outbox, answers) = mpsc::channel();
        let id = id.to_owned();
        std::thread::spawn(move || {
            let mut pipe = match open(&id) {
                Ok(pipe) => pipe,
                Err(why) => {
                    let _ = outbox.send(Err(why));
                    return;
                }
            };
            if outbox.send(Ok(None)).is_err() {
                return;
            }
            let mut nonce = 0;
            // Ends when the client is dropped or Discord goes away.
            for activity in inbox {
                let answer = set(&mut pipe, &mut nonce, &activity).map_err(|e| e.to_string());
                let failed = answer.is_err();
                if outbox.send(answer).is_err() || failed {
                    break;
                }
            }
        });
        match answers.recv_timeout(ANSWER) {
            Ok(Ok(_)) => Ok(Client { requests, answers }),
            Ok(Err(why)) => Err(why),
            Err(_) => Err("Discord isn't answering.".into()),
        }
    }
    /// Shows `activity` (null clears it). Ok(Some(reason)) when Discord refused it.
    fn set(&self, activity: &Value) -> Result<Option<String>, String> {
        self.requests
            .send(activity.clone())
            .map_err(|_| "Discord was closed.".to_string())?;
        match self.answers.recv_timeout(ANSWER) {
            Ok(Ok(problem)) => Ok(problem),
            Ok(Err(_)) => Err("Discord was closed.".into()),
            Err(_) => Err("Discord stopped answering.".into()),
        }
    }
}

/// Keeps Discord's status in step with playback, once a second, while it is switched on.
pub fn start(db: Arc<Database>, engine: Arc<crate::audio::Engine>) {
    std::thread::spawn(move || {
        let mut client: Option<Client> = None;
        // The application ID Discord should be used with (None while switched off).
        let mut last_wanted: Option<String> = None;
        let mut retry_at = Instant::now();
        // What Discord shows: the song and when it started (Unix ms), or nothing.
        let mut shown: Option<(String, i64)> = None;
        let mut last_sent = Instant::now();
        loop {
            std::thread::sleep(Duration::from_secs(1));
            let on = db.get("settings")["discordPresence"].as_bool() == Some(true);
            let id = client_id(&db);
            let wanted_id = if on { id } else { None };
            // Only a real change of setting or ID starts afresh, so the waits below between
            // connection attempts apply.
            if wanted_id != last_wanted {
                if let Some(c) = client.take() {
                    let _ = c.set(&Value::Null);
                }
                shown = None;
                set_status(false, None);
                retry_at = Instant::now();
                last_wanted = wanted_id.clone();
            }
            let Some(id) = wanted_id else {
                continue;
            };
            if client.is_none() {
                if Instant::now() < retry_at {
                    continue;
                }
                match Client::connect(&id) {
                    Ok(c) => {
                        client = Some(c);
                        shown = None;
                        last_sent = Instant::now();
                        set_status(true, None);
                    }
                    Err(problem) => {
                        // A refused ID won't start working by itself; look less often.
                        let wait = if problem.starts_with("Discord didn't accept") {
                            60
                        } else {
                            15
                        };
                        set_status(false, Some(problem));
                        retry_at = Instant::now() + Duration::from_secs(wait);
                        continue;
                    }
                }
            }
            let s = engine.snapshot();
            let wanted = s
                .current_id
                .filter(|_| s.playing)
                .map(|id| (id, now() - (s.position * 1000.) as i64));
            // Seeking moves the start time; small drifts are left alone.
            let changed = match (&shown, &wanted) {
                (None, None) => false,
                (Some(a), Some(b)) => a.0 != b.0 || (a.1 - b.1).abs() > 2000,
                _ => true,
            };
            // Sent again about once a minute anyway, so a restarted Discord shows the song
            // again (and a closed one is noticed) without waiting for the next song.
            if !changed && last_sent.elapsed() < Duration::from_secs(60) {
                continue;
            }
            let activity = wanted
                .as_ref()
                .and_then(|(id, start)| db.track(id).ok().map(|t| activity(&t, *start)))
                .unwrap_or(Value::Null);
            let Some(c) = client.as_ref() else {
                continue;
            };
            last_sent = Instant::now();
            match c.set(&activity) {
                Ok(problem) => {
                    shown = wanted;
                    // A refusal shows while connected, and clears once a status is accepted.
                    set_status(true, problem);
                }
                Err(why) => {
                    client = None;
                    shown = None;
                    set_status(false, Some(why));
                    retry_at = Instant::now() + Duration::from_secs(15);
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    /// A stand-in for Discord's pipe: reads come from scripted replies, writes are kept.
    struct Fake {
        replies: std::io::Cursor<Vec<u8>>,
        sent: Vec<u8>,
    }
    impl Fake {
        fn new(replies: &[(u32, Value)]) -> Fake {
            Fake {
                replies: std::io::Cursor::new(
                    replies.iter().flat_map(|(op, v)| frame(*op, v)).collect(),
                ),
                sent: Vec::new(),
            }
        }
    }
    impl Read for Fake {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            self.replies.read(buf)
        }
    }
    impl Write for Fake {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.sent.write(buf)
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    #[test]
    fn a_refused_listening_status_falls_back_and_reports_why() {
        let song = json!({"type": 2, "details": "Song"});
        let ok = |n: &str| (1, json!({"evt": null, "nonce": n}));
        let refused = |n: &str| {
            (
                1,
                json!({"evt": "ERROR", "nonce": n, "data": {"message": "Invalid activity"}}),
            )
        };
        let mut nonce = 0;
        // Accepted straight away: nothing to report (an earlier refusal is cleared).
        assert_eq!(
            set(&mut Fake::new(&[ok("1")]), &mut nonce, &song).unwrap(),
            None
        );
        // The listening type refused, the plain one accepted.
        let mut nonce = 0;
        let mut pipe = Fake::new(&[refused("1"), ok("2")]);
        assert_eq!(set(&mut pipe, &mut nonce, &song).unwrap(), None);
        let (_, second) = {
            let mut sent = std::io::Cursor::new(pipe.sent.clone());
            read_frame(&mut sent).unwrap();
            read_frame(&mut sent).unwrap()
        };
        assert!(second["args"]["activity"].get("type").is_none());
        // Both refused: the reason is reported, the connection stays.
        let mut nonce = 0;
        let problem = set(
            &mut Fake::new(&[refused("1"), refused("2")]),
            &mut nonce,
            &song,
        )
        .unwrap()
        .unwrap();
        assert!(problem.contains("Invalid activity"));
        // Discord closing the connection is an error.
        let mut nonce = 0;
        assert!(set(&mut Fake::new(&[(2, json!({}))]), &mut nonce, &song).is_err());
    }
    #[test]
    fn frames_round_trip() {
        let bytes = frame(1, &json!({"cmd": "SET_ACTIVITY"}));
        assert_eq!(&bytes[..4], &1u32.to_le_bytes());
        let (op, v) = read_frame(&mut bytes.as_slice()).unwrap();
        assert_eq!((op, v["cmd"].as_str()), (1, Some("SET_ACTIVITY")));
    }
    #[test]
    fn listening_activity_shows_the_song_with_a_progress_bar() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(dir.path()).unwrap();
        let mut t = crate::db::Track {
            id: "a".into(),
            path: "a.flac".into(),
            folder: String::new(),
            title: "X".into(),
            artist: "Cliff Richard".into(),
            album: "The Collection".into(),
            album_artist: "Cliff Richard".into(),
            year: 1994,
            track: 1,
            disc: 1,
            duration: 219.,
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
            original_year: 1981,
        };
        let a = activity(&t, 1_000);
        assert_eq!(a["type"], 2);
        assert_eq!(a["details"], "X ♪");
        assert_eq!(a["state"], "Cliff Richard · The Collection");
        assert_eq!(a["timestamps"]["end"], 220_000);
        t.title = "y".repeat(300);
        assert_eq!(activity(&t, 0)["details"].as_str().unwrap().len(), 128);
        assert!(setup(&db, "123").is_err());
        assert!(setup(&db, "12345678901234567a").is_err());
        assert_eq!(
            setup(&db, " 123456789012345678 ").unwrap()["clientId"],
            "123456789012345678"
        );
        assert_eq!(setup(&db, "").unwrap()["clientId"], Value::Null);
    }
}
