use crate::db::{err, Database, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    io::{Read, Write},
    net::TcpListener,
    time::{Duration, Instant},
};

pub const REDIRECT: &str = "http://127.0.0.1:43829/callback";
const SCOPES: &str =
    "playlist-read-private playlist-read-collaborative user-library-read user-top-read";
/// The Liked Songs collection has no playlist ID; this address stands for it.
pub const LIKED_URL: &str = "https://open.spotify.com/collection/tracks";
fn client() -> Result<reqwest::blocking::Client> {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(25))
        .build()
        .map_err(err)
}
fn response(r: reqwest::blocking::Response) -> Result<Value> {
    let status = r.status();
    let retry = r
        .headers()
        .get("retry-after")
        .and_then(|s| s.to_str().ok())
        .unwrap_or("60")
        .to_string();
    if status.as_u16() == 429 {
        return Err(format!("Spotify rate or quota limit reached. Try again after {retry} seconds; a daily quota may take longer."));
    }
    if status.as_u16() == 403 {
        return Err("Spotify refused access. Check the app owner's Premium subscription and add your account to the app's Users Management allowlist.".into());
    }
    if status.as_u16() == 401 {
        return Err("Spotify sign-in expired. Connect again in Settings.".into());
    }
    if !status.is_success() {
        return Err(format!(
            "Spotify request failed ({status}). Check your connection and Developer Dashboard."
        ));
    }
    r.json().map_err(err)
}
#[cfg(windows)]
fn protect(data: &[u8], decrypt: bool) -> Result<Vec<u8>> {
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::Cryptography::{
            CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
        },
    };
    let input = CRYPT_INTEGER_BLOB {
        cbData: data.len() as u32,
        pbData: data.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    let ok = unsafe {
        if decrypt {
            CryptUnprotectData(
                &input,
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        } else {
            CryptProtectData(
                &input,
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        }
    };
    if ok == 0 {
        return Err("Windows could not secure Spotify credentials".into());
    }
    let bytes =
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) }.to_vec();
    unsafe {
        LocalFree(output.pbData as *mut std::ffi::c_void);
    }
    Ok(bytes)
}
#[cfg(not(windows))]
fn protect(_data: &[u8], _decrypt: bool) -> Result<Vec<u8>> {
    Err("Secure token storage is currently Windows-only".into())
}
fn store(db: &Database, mut value: Value, previous: Option<&Value>) -> Result<()> {
    if value["refresh_token"].is_null() {
        if let Some(p) = previous {
            value["refresh_token"] = p["refresh_token"].clone();
        }
    }
    value["expires_at"] =
        json!(crate::db::now() + value["expires_in"].as_i64().unwrap_or(3600) * 1000 - 30000);
    if value["scope"].is_string() {
        db.set("spotify_scope", &value["scope"])?;
    }
    let encrypted = protect(value.to_string().as_bytes(), false)?;
    let path = db.directory.join("spotify.dpapi");
    std::fs::write(path, encrypted).map_err(err)
}
pub fn connected(db: &Database) -> bool {
    db.directory.join("spotify.dpapi").is_file()
}
pub fn disconnect(db: &Database) -> Result<()> {
    let p = db.directory.join("spotify.dpapi");
    if p.exists() {
        std::fs::remove_file(p).map_err(err)?;
    }
    db.set("spotify_scope", &Value::Null)
}
pub fn connect(db: &Database, client_id: &str) -> Result<()> {
    if client_id.len() != 32 || !client_id.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("Enter the 32-character Client ID from Spotify Developer Dashboard. No client secret is needed.".into());
    }
    let listener=TcpListener::bind("127.0.0.1:43829").map_err(|_|"Sign-in is already open, or port 43829 is in use. Finish the existing sign-in and try again.".to_string())?;
    listener.set_nonblocking(true).map_err(err)?;
    let verifier = URL_SAFE_NO_PAD.encode(rand::random::<[u8; 32]>());
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let state = hex::encode(rand::random::<[u8; 24]>());
    let mut u = url::Url::parse("https://accounts.spotify.com/authorize").unwrap();
    u.query_pairs_mut().extend_pairs(&[
        ("client_id", client_id),
        ("response_type", "code"),
        ("redirect_uri", REDIRECT),
        ("code_challenge_method", "S256"),
        ("code_challenge", &challenge),
        ("state", &state),
        ("scope", SCOPES),
    ]);
    open::that(u.as_str()).map_err(err)?;
    let start = Instant::now();
    let mut code = None;
    while start.elapsed() < Duration::from_secs(180) {
        if let Ok((mut stream, _)) = listener.accept() {
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .map_err(err)?;
            let mut buffer = [0u8; 8192];
            let n = stream.read(&mut buffer).map_err(err)?;
            let request = String::from_utf8_lossy(&buffer[..n]);
            let path = request
                .lines()
                .next()
                .unwrap_or("")
                .split_whitespace()
                .nth(1)
                .unwrap_or("/");
            let u = url::Url::parse(&format!("http://127.0.0.1:43829{path}")).map_err(err)?;
            let pairs: std::collections::HashMap<_, _> = u.query_pairs().into_owned().collect();
            if u.path() != "/callback" || pairs.get("state") != Some(&state) {
                let _ = stream.write_all(
                    b"HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\nInvalid sign-in state.",
                );
                continue;
            }
            let _=stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nConnection: close\r\n\r\n<html><body style='background:#0a0a0b;color:#ededf0;font:20px system-ui;padding:80px'><h1>Return to Slate Music.</h1><p>You can close this window.</p></body></html>");
            if pairs.contains_key("error") {
                return Err("Spotify sign-in was cancelled".into());
            }
            code = pairs.get("code").cloned();
            break;
        }
        std::thread::sleep(Duration::from_millis(120));
    }
    let code = code.ok_or("Spotify sign-in timed out. Try connecting again.")?;
    let value = response(
        client()?
            .post("https://accounts.spotify.com/api/token")
            .form(&[
                ("client_id", client_id),
                ("grant_type", "authorization_code"),
                ("code", &code),
                ("redirect_uri", REDIRECT),
                ("code_verifier", &verifier),
            ])
            .send()
            .map_err(|_| "Cannot reach Spotify. Check your internet connection.".to_string())?,
    )?;
    store(db, value, None)?;
    db.set("spotify_client_id", &json!(client_id))?;
    Ok(())
}
fn token(db: &Database) -> Result<String> {
    let bytes = std::fs::read(db.directory.join("spotify.dpapi")).map_err(|_| {
        "Connect Spotify in Settings first. You need a Spotify Developer app Client ID.".to_string()
    })?;
    let value: Value = serde_json::from_slice(&protect(&bytes, true)?).map_err(err)?;
    if value["expires_at"].as_i64().unwrap_or(0) > crate::db::now() {
        return value["access_token"]
            .as_str()
            .map(str::to_owned)
            .ok_or("Spotify token missing".into());
    }
    let id = db.get("spotify_client_id");
    let refresh = value["refresh_token"]
        .as_str()
        .ok_or("Connect Spotify again")?;
    let next = response(
        client()?
            .post("https://accounts.spotify.com/api/token")
            .form(&[
                ("grant_type", "refresh_token"),
                ("refresh_token", refresh),
                ("client_id", id.as_str().unwrap_or("")),
            ])
            .send()
            .map_err(|_| "Spotify is offline. Your saved playlists still work.".to_string())?,
    )?;
    let access = next["access_token"]
        .as_str()
        .ok_or("Spotify token missing")?
        .to_string();
    store(db, next, Some(&value))?;
    Ok(access)
}
fn granted(db: &Database, scope: &str) -> bool {
    db.get("spotify_scope")
        .as_str()
        .is_some_and(|s| s.split(' ').any(|granted| granted == scope))
}
pub fn playlist_access(db: &Database) -> bool {
    granted(db, "playlist-read-private")
}
pub fn liked_access(db: &Database) -> bool {
    granted(db, "user-library-read")
}
pub fn top_access(db: &Database) -> bool {
    granted(db, "user-top-read")
}
/// Spotify's time ranges for top songs and Slate's names for them.
const TOP_RANGES: [(&str, &str); 3] = [
    ("short_term", "this month"),
    ("medium_term", "last 6 months"),
    ("long_term", "last year"),
];
/// The user's 50 most played songs for a time range, in the same shape as a playlist.
/// `source` is Slate's address for it, e.g. `spotify:top:medium_term`.
pub fn top(db: &Database, source: &str) -> Result<Value> {
    let (range, label) = TOP_RANGES
        .iter()
        .find(|(range, _)| source.strip_prefix("spotify:top:") == Some(range))
        .ok_or("Unknown top songs period")?;
    if !top_access(db) {
        return Err("Reconnect Spotify to allow Slate Music to read your top songs.".into());
    }
    let data = response(
        client()?
            .get("https://api.spotify.com/v1/me/top/tracks")
            .query(&[("time_range", *range), ("limit", "50")])
            .bearer_auth(token(db)?)
            .send()
            .map_err(|_| "Cannot reach Spotify. Check your connection.".to_string())?,
    )?;
    // Top songs are plain track objects; wrap them like playlist items.
    let items: Vec<Value> = data["items"]
        .as_array()
        .ok_or("Spotify returned no top songs")?
        .iter()
        .map(|t| json!({ "item": t }))
        .collect();
    let (tracks, skipped) = playlist_tracks(&items);
    Ok(json!({
        "id": source,
        "name": format!("Top songs · {label}"),
        "owner": "",
        "url": source,
        "tracks": tracks,
        "skipped": skipped,
    }))
}
const NOT_YOURS: &str = "Spotify only lets apps read playlists you created or collaborate on. To import someone else's playlist, copy its songs into a new playlist of your own in Spotify, then import that.";
/// Playlist reads get their own messages: Spotify answers 403 for playlists the user does
/// not own or collaborate on, and 404 for Spotify-made mixes such as Discover Weekly.
fn playlist_response(r: reqwest::blocking::Response) -> Result<Value> {
    match r.status().as_u16() {
        403 => Err(NOT_YOURS.into()),
        404 => Err("Spotify could not find this playlist. Playlists made by Spotify, such as Discover Weekly or Today's Top Hits, cannot be read by apps; copy the songs into a playlist of your own first.".into()),
        _ => response(r),
    }
}
fn valid_id(id: &str) -> bool {
    id.len() == 22 && id.chars().all(|c| c.is_ascii_alphanumeric())
}
pub fn playlist_id(input: &str) -> Result<String> {
    let input = input.trim();
    if let Some(id) = input.strip_prefix("spotify:playlist:") {
        if valid_id(id) {
            return Ok(id.into());
        }
    }
    let u = url::Url::parse(input).map_err(|_| {
        "Paste a Spotify playlist link, such as https://open.spotify.com/playlist/…".to_string()
    })?;
    if u.host_str() == Some("spotify.link") {
        return Err("Short spotify.link addresses cannot be read. Choose the playlist from your list above, or open the link in a browser and copy the open.spotify.com address.".into());
    }
    if u.scheme() != "https" || u.host_str() != Some("open.spotify.com") {
        return Err("Use a https://open.spotify.com/playlist/ link".into());
    }
    let parts: Vec<_> = u.path_segments().map(|s| s.collect()).unwrap_or_default();
    let Some(pos) = parts.iter().position(|p| *p == "playlist") else {
        return Err(if parts.contains(&"album") {
            "That is an album link. Slate Music imports playlists; paste a link to a playlist instead."
        } else {
            "This is not a playlist link"
        }
        .into());
    };
    match parts.get(pos + 1) {
        Some(id) if valid_id(id) => Ok((*id).into()),
        _ => Err("Invalid Spotify playlist ID".into()),
    }
}
/// Follows Spotify's `next` links, refusing any page outside `path` on the API host.
fn pages(
    client: &reqwest::blocking::Client,
    token: &str,
    first: String,
    path: &str,
    max_pages: usize,
    read: fn(reqwest::blocking::Response) -> Result<Value>,
) -> Result<(Vec<Value>, Option<u64>)> {
    let (mut items, mut total, mut next, mut count) = (Vec::new(), None, Some(first), 0);
    while let Some(address) = next.take() {
        let url = url::Url::parse(&address).map_err(err)?;
        if url.scheme() != "https"
            || url.host_str() != Some("api.spotify.com")
            || url.path() != path
        {
            return Err("Spotify returned an unexpected pagination URL".into());
        }
        count += 1;
        if count > max_pages {
            return Err("This list is too large to import".into());
        }
        let data = read(
            client
                .get(url)
                .bearer_auth(token)
                .send()
                .map_err(|_| "Cannot reach Spotify. Check your connection.".to_string())?,
        )?;
        total = total.or(data["total"].as_u64());
        let page = data["items"]
            .as_array()
            .ok_or("Spotify returned no item list")?;
        items.extend(page.iter().cloned());
        next = data["next"].as_str().map(str::to_owned);
    }
    Ok((items, total))
}
/// The user's own and followed playlists. Only owned or collaborative ones can be read.
pub fn playlists(db: &Database) -> Result<Value> {
    let token = token(db)?;
    let client = client()?;
    let me = response(
        client
            .get("https://api.spotify.com/v1/me")
            .bearer_auth(&token)
            .send()
            .map_err(|_| "Cannot reach Spotify. Check your connection.".to_string())?,
    )?;
    let me = me["id"].as_str().unwrap_or_default();
    let (items, _) = pages(
        &client,
        &token,
        "https://api.spotify.com/v1/me/playlists?limit=50".into(),
        "/v1/me/playlists",
        40,
        response,
    )?;
    Ok(Value::Array(
        items
            .iter()
            .filter(|p| p["id"].as_str().is_some_and(valid_id))
            .map(|p| playlist_summary(p, me))
            .collect(),
    ))
}
fn playlist_summary(p: &Value, me: &str) -> Value {
    let owner = &p["owner"];
    let collaborative = p["collaborative"].as_bool().unwrap_or(false);
    json!({
        "id": p["id"],
        "name": p["name"].as_str().unwrap_or("Untitled playlist"),
        "owner": owner["display_name"].as_str().or(owner["id"].as_str()).unwrap_or_default(),
        // `items.total` replaced `tracks.total` in 2026; accept either.
        "total": p["items"]["total"].as_u64().or(p["tracks"]["total"].as_u64()),
        "readable": collaborative || (!me.is_empty() && owner["id"].as_str() == Some(me)),
    })
}
pub fn playlist(db: &Database, input: &str) -> Result<Value> {
    let id = playlist_id(input)?;
    let token = token(db)?;
    let client = client()?;
    let meta = playlist_response(
        client
            .get(format!("https://api.spotify.com/v1/playlists/{id}"))
            .query(&[("fields", "name,owner(id,display_name)")])
            .bearer_auth(&token)
            .send()
            .map_err(|_| "Cannot reach Spotify. Check your connection.".to_string())?,
    )?;
    let (items, total) = pages(
        &client,
        &token,
        format!("https://api.spotify.com/v1/playlists/{id}/items?limit=50&additional_types=track"),
        &format!("/v1/playlists/{id}/items"),
        250,
        playlist_response,
    )?;
    if total.is_some_and(|n| n as usize != items.len()) {
        return Err("Spotify returned an incomplete playlist. Please try again.".into());
    }
    let (tracks, skipped) = playlist_tracks(&items);
    let owner = &meta["owner"];
    Ok(json!({
        "id": id,
        "name": meta["name"].as_str().unwrap_or("Spotify playlist"),
        "owner": owner["display_name"].as_str().or(owner["id"].as_str()).unwrap_or_default(),
        "url": format!("https://open.spotify.com/playlist/{id}"),
        "tracks": tracks,
        "skipped": skipped,
    }))
}
/// The user's Liked Songs, newest first, in the same shape as a playlist.
pub fn liked(db: &Database) -> Result<Value> {
    if !liked_access(db) {
        return Err("Reconnect Spotify to allow Slate Music to read your Liked Songs.".into());
    }
    let token = token(db)?;
    let (items, total) = pages(
        &client()?,
        &token,
        "https://api.spotify.com/v1/me/tracks?limit=50".into(),
        "/v1/me/tracks",
        250,
        response,
    )?;
    if total.is_some_and(|n| n as usize != items.len()) {
        return Err("Spotify returned an incomplete list of Liked Songs. Please try again.".into());
    }
    let (tracks, skipped) = playlist_tracks(&items);
    Ok(json!({
        "id": "liked",
        "name": "Liked Songs",
        "owner": "",
        "url": LIKED_URL,
        "tracks": tracks,
        "skipped": skipped,
    }))
}
/// Songs in playlist order. Podcast episodes and removed/unavailable entries are counted, not kept.
fn playlist_tracks(items: &[Value]) -> (Vec<Value>, usize) {
    let mut skipped = 0;
    let tracks = items
        .iter()
        .filter_map(|entry| {
            // `item` replaced the deprecated `track` field in 2026; accept either.
            let item = if entry["item"].is_object() {
                &entry["item"]
            } else {
                &entry["track"]
            };
            let name = item["name"].as_str().unwrap_or_default();
            if name.is_empty() || item["type"].as_str().is_some_and(|t| t != "track") {
                skipped += 1;
                return None;
            }
            let artists: Vec<Value> = item["artists"]
                .as_array()
                .map(|a| a.iter().filter_map(|x| x["name"].as_str()).map(|n| json!({"name": n})).collect())
                .unwrap_or_default();
            Some(json!({
                "id": item["id"].as_str(),
                "name": name,
                "artists": artists,
                "album": item["album"]["name"].as_str().unwrap_or_default(),
                "duration_ms": item["duration_ms"].as_u64().unwrap_or(0),
            }))
        })
        .collect();
    (tracks, skipped)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_playlist_links() {
        let id = "37i9dQZF1DXcBWIGoYBM5M";
        assert_eq!(playlist_id(&format!("https://open.spotify.com/playlist/{id}?si=x")).unwrap(), id);
        assert_eq!(playlist_id(&format!(" https://open.spotify.com/intl-de/playlist/{id} ")).unwrap(), id);
        assert_eq!(playlist_id(&format!("spotify:playlist:{id}")).unwrap(), id);
        assert!(playlist_id(&format!("https://evil.test/playlist/{id}")).is_err());
        assert!(playlist_id(&format!("http://open.spotify.com/playlist/{id}")).is_err());
        assert!(playlist_id("https://open.spotify.com/playlist/short").is_err());
        assert!(playlist_id("https://spotify.link/AbCdEf").unwrap_err().contains("spotify.link"));
        assert!(playlist_id(&format!("https://open.spotify.com/album/{id}"))
            .unwrap_err()
            .contains("album link"));
    }
    #[test]
    fn reads_playlist_items_in_order_and_skips_non_songs() {
        let items = vec![
            json!({"item":{"type":"track","id":"a","name":"First","duration_ms":1000,"artists":[{"name":"A"},{"name":"B"}],"album":{"name":"Album"}}}),
            json!({"track":{"type":"track","id":"b","name":"Old shape","duration_ms":2000,"artists":[{"name":"C"}],"album":{"name":"X"}}}),
            json!({"item":{"type":"episode","id":"c","name":"A podcast","duration_ms":3000}}),
            json!({"item":null,"track":null}),
            json!({"is_local":true,"item":{"type":"track","id":null,"name":"My own file","duration_ms":4000,"artists":[{"name":"Me"}],"album":{"name":""}}}),
        ];
        let (tracks, skipped) = playlist_tracks(&items);
        assert_eq!(skipped, 2);
        let names: Vec<_> = tracks.iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert_eq!(names, ["First", "Old shape", "My own file"]);
        assert_eq!(tracks[0]["artists"], json!([{"name":"A"},{"name":"B"}]));
        assert_eq!(tracks[0]["album"], "Album");
        assert!(tracks[2]["id"].is_null());
    }
    #[test]
    fn top_songs_need_a_known_period_and_permission() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(dir.path()).unwrap();
        assert!(top(&db, "spotify:top:forever").unwrap_err().contains("Unknown"));
        assert!(top(&db, "spotify:top:short_term").unwrap_err().contains("Reconnect"));
        db.set("spotify_scope", &json!("user-library-read user-top-read")).unwrap();
        assert!(top_access(&db) && liked_access(&db) && !playlist_access(&db));
    }
    #[test]
    fn marks_only_owned_or_collaborative_playlists_readable() {
        let mine = json!({"id":"p1","name":"Mine","owner":{"id":"me","display_name":"Me"},"items":{"total":12}});
        let theirs = json!({"id":"p2","name":"Theirs","owner":{"id":"you"},"tracks":{"total":3}});
        let shared = json!({"id":"p3","name":"Shared","owner":{"id":"you"},"collaborative":true});
        assert_eq!(playlist_summary(&mine, "me")["readable"], true);
        assert_eq!(playlist_summary(&mine, "me")["total"], 12);
        assert_eq!(playlist_summary(&theirs, "me")["readable"], false);
        assert_eq!(playlist_summary(&theirs, "me")["total"], 3);
        assert_eq!(playlist_summary(&theirs, "me")["owner"], "you");
        assert_eq!(playlist_summary(&shared, "me")["readable"], true);
        assert_eq!(playlist_summary(&mine, "")["readable"], false);
    }
}
