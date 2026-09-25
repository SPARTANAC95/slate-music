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
    Ok(())
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
            .map_err(|_| "Spotify is offline. Your saved albums still work.".to_string())?,
    )?;
    let access = next["access_token"]
        .as_str()
        .ok_or("Spotify token missing")?
        .to_string();
    store(db, next, Some(&value))?;
    Ok(access)
}
pub fn album_id(input: &str) -> Result<String> {
    if let Some(id) = input.strip_prefix("spotify:album:") {
        if id.len() == 22 && id.chars().all(|c| c.is_ascii_alphanumeric()) {
            return Ok(id.into());
        }
    }
    let u = url::Url::parse(input).map_err(|_| {
        "Paste a Spotify album URL, such as https://open.spotify.com/album/…".to_string()
    })?;
    if u.scheme() != "https" || u.host_str() != Some("open.spotify.com") {
        return Err("Use an https://open.spotify.com/album/ URL".into());
    }
    let parts: Vec<_> = u.path_segments().unwrap().collect();
    let pos = parts
        .iter()
        .position(|p| *p == "album")
        .ok_or("This is not an album link")?;
    let id = parts.get(pos + 1).ok_or("Album ID is missing")?;
    if id.len() != 22 || !id.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err("Invalid Spotify album ID".into());
    }
    Ok((*id).into())
}
pub fn album(db: &Database, input: &str) -> Result<Value> {
    let id = album_id(input)?;
    let token = token(db)?;
    let client = client()?;
    let album = response(
        client
            .get(format!("https://api.spotify.com/v1/albums/{id}"))
            .bearer_auth(&token)
            .send()
            .map_err(|_| "Cannot reach Spotify. Check your connection.".to_string())?,
    )?;
    let mut tracks = Vec::new();
    let mut next = Some(format!(
        "https://api.spotify.com/v1/albums/{id}/tracks?limit=50"
    ));
    let mut pages = 0;
    while let Some(address) = next.take() {
        let url = url::Url::parse(&address).map_err(err)?;
        if url.scheme() != "https"
            || url.host_str() != Some("api.spotify.com")
            || url.path() != format!("/v1/albums/{id}/tracks")
        {
            return Err("Spotify returned an unexpected pagination URL".into());
        }
        pages += 1;
        if pages > 200 {
            return Err("Album is too large".into());
        }
        let data = response(client.get(url).bearer_auth(&token).send().map_err(err)?)?;
        let items = data["items"]
            .as_array()
            .ok_or("Spotify returned no track list")?;
        tracks.extend(items.iter().cloned());
        next = data["next"].as_str().map(str::to_owned);
    }
    if album["total_tracks"]
        .as_u64()
        .is_some_and(|n| n as usize != tracks.len())
    {
        return Err("Spotify returned an incomplete album. Please try again.".into());
    }
    Ok(
        json!({"id":id,"name":album["name"],"artists":album["artists"],"release_date":album["release_date"],"url":format!("https://open.spotify.com/album/{id}"),"tracks":tracks}),
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_album_links() {
        assert!(album_id("https://open.spotify.com/album/1234567890123456789012?si=x").is_ok());
        assert!(album_id("https://open.spotify.com/intl-de/album/1234567890123456789012").is_ok());
        assert!(album_id("https://evil.test/album/1234567890123456789012").is_err());
        assert!(album_id("https://open.spotify.com/track/1234567890123456789012").is_err());
    }
}
