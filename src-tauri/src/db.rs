use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    sync::Mutex,
};

pub type Result<T> = std::result::Result<T, String>;
pub fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
pub fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    pub id: String,
    pub path: String,
    pub folder: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub album_artist: String,
    pub year: u32,
    pub track: u32,
    pub disc: u32,
    pub duration: f64,
    pub format: String,
    pub sample_rate: u32,
    pub bit_depth: u8,
    pub artwork: Option<String>,
    pub favorite: bool,
    pub missing: bool,
    pub play_count: u32,
    pub last_played: i64,
    pub added: i64,
    pub size: u64,
}
pub struct Database {
    pub conn: Mutex<Connection>,
    pub directory: PathBuf,
}
impl Database {
    pub fn open(directory: &Path) -> Result<Self> {
        std::fs::create_dir_all(directory).map_err(err)?;
        std::fs::create_dir_all(directory.join("artwork")).map_err(err)?;
        let conn = Connection::open(directory.join("library.sqlite3")).map_err(err)?;
        conn.busy_timeout(std::time::Duration::from_secs(10))
            .map_err(err)?;
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
   CREATE TABLE IF NOT EXISTS migrations(version INTEGER PRIMARY KEY, applied INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS tracks(id TEXT PRIMARY KEY,path TEXT UNIQUE NOT NULL,folder TEXT NOT NULL,mtime INTEGER NOT NULL,size INTEGER NOT NULL,data TEXT NOT NULL,favorite INTEGER NOT NULL DEFAULT 0,missing INTEGER NOT NULL DEFAULT 0,play_count INTEGER NOT NULL DEFAULT 0,last_played INTEGER NOT NULL DEFAULT 0);
   CREATE INDEX IF NOT EXISTS tracks_folder ON tracks(folder); CREATE INDEX IF NOT EXISTS tracks_recent ON tracks(last_played);
   CREATE TABLE IF NOT EXISTS state(key TEXT PRIMARY KEY,value TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS collections(id TEXT PRIMARY KEY,data TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS history(id INTEGER PRIMARY KEY AUTOINCREMENT,track_id TEXT NOT NULL,played INTEGER NOT NULL);
   INSERT OR IGNORE INTO migrations VALUES(1,strftime('%s','now'));
   PRAGMA user_version=1;").map_err(err)?;
        Ok(Self {
            conn: Mutex::new(conn),
            directory: directory.into(),
        })
    }
    pub fn get(&self, key: &str) -> Value {
        self.conn
            .lock()
            .unwrap()
            .query_row("SELECT value FROM state WHERE key=?", [key], |r| {
                r.get::<_, String>(0)
            })
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or(Value::Null)
    }
    pub fn set(&self, key: &str, value: &Value) -> Result<()> {
        self.conn
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO state VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                params![key, value.to_string()],
            )
            .map_err(err)?;
        Ok(())
    }
    pub fn folders(&self) -> Vec<String> {
        serde_json::from_value(self.get("folders")).unwrap_or_default()
    }
    pub fn tracks(&self) -> Result<Vec<Track>> {
        let c = self.conn.lock().unwrap();
        let mut s=c.prepare("SELECT data,favorite,missing,play_count,last_played FROM tracks ORDER BY path COLLATE NOCASE").map_err(err)?;
        let rows = s
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, bool>(1)?,
                    r.get::<_, bool>(2)?,
                    r.get::<_, u32>(3)?,
                    r.get::<_, i64>(4)?,
                ))
            })
            .map_err(err)?;
        let mut out = Vec::new();
        for row in rows {
            let (data, favorite, missing, play_count, last_played) = row.map_err(err)?;
            let mut t: Track = serde_json::from_str(&data).map_err(err)?;
            t.favorite = favorite;
            t.missing = missing;
            t.play_count = play_count;
            t.last_played = last_played;
            out.push(t);
        }
        Ok(out)
    }
    pub fn track(&self, id: &str) -> Result<Track> {
        let c = self.conn.lock().unwrap();
        let row = c
            .query_row(
                "SELECT data,favorite,missing,play_count,last_played FROM tracks WHERE id=?",
                [id],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, bool>(1)?,
                        r.get::<_, bool>(2)?,
                        r.get::<_, u32>(3)?,
                        r.get::<_, i64>(4)?,
                    ))
                },
            )
            .map_err(err)?;
        let mut t: Track = serde_json::from_str(&row.0).map_err(err)?;
        t.favorite = row.1;
        t.missing = row.2;
        t.play_count = row.3;
        t.last_played = row.4;
        Ok(t)
    }
    pub fn upsert(&self, t: &Track, mtime: i64) -> Result<()> {
        self.conn.lock().unwrap().execute("INSERT INTO tracks(id,path,folder,mtime,size,data) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET path=excluded.path,folder=excluded.folder,mtime=excluded.mtime,size=excluded.size,data=excluded.data,missing=0",params![t.id,t.path,t.folder,mtime,t.size,serde_json::to_string(t).map_err(err)?]).map_err(err)?;
        Ok(())
    }
    pub fn unchanged(&self, id: &str, mtime: i64, size: u64) -> bool {
        self.conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT mtime=? AND size=? AND missing=0 FROM tracks WHERE id=?",
                params![mtime, size, id],
                |r| r.get::<_, bool>(0),
            )
            .unwrap_or(false)
    }
    pub fn favorite(&self, id: &str, value: bool) -> Result<()> {
        self.conn
            .lock()
            .unwrap()
            .execute(
                "UPDATE tracks SET favorite=? WHERE id=?",
                params![value, id],
            )
            .map_err(err)?;
        Ok(())
    }
    pub fn missing(&self, id: &str, value: bool) -> Result<()> {
        self.conn
            .lock()
            .unwrap()
            .execute("UPDATE tracks SET missing=? WHERE id=?", params![value, id])
            .map_err(err)?;
        Ok(())
    }
    pub fn played(&self, id: &str) -> Result<()> {
        let mut c = self.conn.lock().unwrap();
        let tx = c.transaction().map_err(err)?;
        tx.execute(
            "UPDATE tracks SET play_count=play_count+1,last_played=? WHERE id=?",
            params![now(), id],
        )
        .map_err(err)?;
        tx.execute(
            "INSERT INTO history(track_id,played) VALUES(?,?)",
            params![id, now()],
        )
        .map_err(err)?;
        tx.execute("DELETE FROM history WHERE id NOT IN (SELECT id FROM history ORDER BY id DESC LIMIT 20000)",[]).map_err(err)?;
        tx.commit().map_err(err)
    }
    pub fn collections(&self) -> Result<Vec<Value>> {
        let c = self.conn.lock().unwrap();
        let mut s = c
            .prepare("SELECT data FROM collections ORDER BY rowid DESC")
            .map_err(err)?;
        let r = s.query_map([], |r| r.get::<_, String>(0)).map_err(err)?;
        r.map(|x| serde_json::from_str(&x.map_err(err)?).map_err(err))
            .collect()
    }
    pub fn save_collection(&self, value: Value) -> Result<()> {
        let id = value["id"].as_str().ok_or("Missing collection ID")?;
        if id.len() > 100
            || value["name"].as_str().unwrap_or("").trim().is_empty()
            || value.to_string().len() > 5_000_000
        {
            return Err("Invalid collection".into());
        }
        self.conn.lock().unwrap().execute("INSERT INTO collections VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",params![id,value.to_string()]).map_err(err)?;
        Ok(())
    }
    pub fn delete_collection(&self, id: &str) -> Result<()> {
        self.conn
            .lock()
            .unwrap()
            .execute("DELETE FROM collections WHERE id=?", [id])
            .map_err(err)?;
        Ok(())
    }
    pub fn snapshot(&self) -> Result<Value> {
        Ok(
            json!({"tracks":self.tracks()?,"collections":self.collections()?,"folders":self.folders(),"settings":self.get("settings")}),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn migration_persistence_and_scan_preserves_user_data() {
        let dir = tempfile::tempdir().unwrap();
        {
            let d = Database::open(dir.path()).unwrap();
            let t = Track {
                id: "a".into(),
                path: "one.flac".into(),
                title: "First".into(),
                ..Default::default()
            };
            d.upsert(&t, 1).unwrap();
            d.favorite("a", true).unwrap();
            d.played("a").unwrap();
            d.upsert(&t, 2).unwrap();
            d.set("session", &json!({"position":42,"playing":false}))
                .unwrap();
            d.save_collection(json!({"id":"p","name":"Evening","entries":[{"trackId":"a"}]}))
                .unwrap();
            d.missing("a", true).unwrap();
        }
        let d = Database::open(dir.path()).unwrap();
        let t = d.track("a").unwrap();
        assert!(t.favorite && t.missing);
        assert_eq!(t.play_count, 1);
        assert_eq!(d.get("session")["position"], 42);
        assert_eq!(d.collections().unwrap().len(), 1);
        assert_eq!(
            d.conn
                .lock()
                .unwrap()
                .query_row("PRAGMA user_version", [], |r| r.get::<_, u32>(0))
                .unwrap(),
            1
        );
    }
}
