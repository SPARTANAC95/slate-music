//! Discord Rich Presence: while a song plays, Discord shows "Listening to <your app name>" with
//! the title, artist and a progress bar. It talks to the Discord app on this PC through its local
//! pipe (nothing is sent over the internet by Slate Music) using the user's own Discord
//! application ID. Paused or stopped clears the status.
use crate::db::{now, Database, Track};
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
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

struct Client {
    pipe: std::fs::File,
    nonce: u64,
}
impl Client {
    fn connect(id: &str) -> Result<Client, String> {
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
                return Ok(Client { pipe, nonce: 0 });
            }
            return Err(format!(
                "Discord didn't accept this Application ID ({}).",
                reply["message"].as_str().unwrap_or("no reason given")
            ));
        }
        Err("Discord isn't running.".into())
    }
    fn send(&mut self, activity: &Value) -> std::io::Result<Value> {
        self.nonce += 1;
        let nonce = self.nonce.to_string();
        let message = json!({
            "cmd": "SET_ACTIVITY",
            "args": { "pid": std::process::id(), "activity": activity },
            "nonce": nonce,
        });
        self.pipe.write_all(&frame(1, &message))?;
        loop {
            let (op, reply) = read_frame(&mut self.pipe)?;
            match op {
                2 => return Err(std::io::Error::other("Discord closed the connection")),
                3 => self.pipe.write_all(&frame(4, &reply))?,
                _ if reply["nonce"] == nonce.as_str() => return Ok(reply),
                _ => {}
            }
        }
    }
    /// Sets the activity; if Discord rejects the listening type, falls back to a plain one.
    fn set(&mut self, activity: &Value) -> std::io::Result<()> {
        let reply = self.send(activity)?;
        if reply["evt"] == "ERROR" && !activity.is_null() {
            let mut plain = activity.clone();
            plain.as_object_mut().map(|a| a.remove("type"));
            let again = self.send(&plain)?;
            if again["evt"] == "ERROR" {
                set_status(
                    true,
                    Some(format!(
                        "Discord refused the status: {}",
                        again["data"]["message"]
                            .as_str()
                            .unwrap_or("unknown reason")
                    )),
                );
            }
        }
        Ok(())
    }
}

/// Keeps Discord's status in step with playback, once a second, while it is switched on.
pub fn start(db: Arc<Database>, engine: Arc<crate::audio::Engine>) {
    std::thread::spawn(move || {
        let mut client: Option<(String, Client)> = None;
        let mut retry_at = Instant::now();
        // What Discord shows: the song and when it started (Unix ms), or nothing.
        let mut shown: Option<(String, i64)> = None;
        loop {
            std::thread::sleep(Duration::from_secs(1));
            let on = db.get("settings")["discordPresence"].as_bool() == Some(true);
            let id = client_id(&db);
            let wanted_id = if on { id } else { None };
            if client.as_ref().map(|(i, _)| i) != wanted_id.as_ref() {
                if let Some((_, mut c)) = client.take() {
                    let _ = c.set(&Value::Null);
                }
                shown = None;
                set_status(false, None);
                retry_at = Instant::now();
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
                        client = Some((id, c));
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
            if !changed {
                continue;
            }
            let activity = wanted
                .as_ref()
                .and_then(|(id, start)| db.track(id).ok().map(|t| activity(&t, *start)))
                .unwrap_or(Value::Null);
            let Some((_, c)) = client.as_mut() else {
                continue;
            };
            match c.set(&activity) {
                Ok(()) => shown = wanted,
                Err(_) => {
                    client = None;
                    shown = None;
                    set_status(false, Some("Discord was closed.".into()));
                    retry_at = Instant::now() + Duration::from_secs(15);
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
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
