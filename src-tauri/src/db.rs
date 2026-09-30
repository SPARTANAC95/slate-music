use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
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
    /// The year the song was first released: from an ORIGINALDATE-style tag, or looked up
    /// online. 0 when unknown; `year` is the year of the album the file is on.
    #[serde(default)]
    pub original_year: u32,
}
/// A song that still needs its original year looked up.
pub struct YearRequest {
    pub key: String,
    pub artist: String,
    pub title: String,
    pub album_year: u32,
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
   CREATE TABLE IF NOT EXISTS original_years(key TEXT PRIMARY KEY,year INTEGER NOT NULL,checked INTEGER NOT NULL);
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
        let years: HashMap<String, u32> = {
            let mut s = c
                .prepare("SELECT key,year FROM original_years WHERE year>0")
                .map_err(err)?;
            let rows = s
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
                .map_err(err)?;
            rows.collect::<std::result::Result<_, _>>().map_err(err)?
        };
        for t in out.iter_mut().filter(|t| t.original_year == 0) {
            t.original_year = years
                .get(&crate::years::key(&t.artist, &t.title))
                .copied()
                .unwrap_or(0);
        }
        Ok(out)
    }
    /// Songs whose original year is unknown and has not been looked up recently.
    pub fn years_needed(&self) -> Result<Vec<YearRequest>> {
        let checked: HashMap<String, (u32, i64)> = {
            let c = self.conn.lock().unwrap();
            let mut s = c
                .prepare("SELECT key,year,checked FROM original_years")
                .map_err(err)?;
            let rows = s
                .query_map([], |r| Ok((r.get(0)?, (r.get(1)?, r.get(2)?))))
                .map_err(err)?;
            rows.collect::<std::result::Result<_, _>>().map_err(err)?
        };
        // Songs that were not found are tried again after 60 days.
        let retry_before = now() - 60 * 24 * 3600 * 1000;
        let mut needed: HashMap<String, YearRequest> = HashMap::new();
        for t in self.tracks()?.into_iter().filter(|t| !t.missing && t.original_year == 0) {
            let key = crate::years::key(&t.artist, &t.title);
            if checked.get(&key).is_some_and(|(year, at)| *year > 0 || *at > retry_before) {
                continue;
            }
            let request = needed.entry(key.clone()).or_insert(YearRequest {
                key,
                artist: t.artist.clone(),
                title: t.title.clone(),
                album_year: t.year,
            });
            // With several copies, the earliest album is the strictest check.
            if t.year > 0 && (request.album_year == 0 || t.year < request.album_year) {
                request.album_year = t.year;
            }
        }
        Ok(needed.into_values().collect())
    }
    pub fn set_original_year(&self, key: &str, year: u32) -> Result<()> {
        self.conn
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO original_years VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET year=excluded.year,checked=excluded.checked",
                params![key, year, now()],
            )
            .map_err(err)?;
        Ok(())
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
        if id.len() > 100 || value["name"].as_str().unwrap_or("").trim().is_empty() {
            return Err("Invalid collection".into());
        }
        if value.to_string().len() > 20_000_000 {
            return Err("This playlist is too large to save. Remove some songs and try again.".into());
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
    /// A file moved inside the library shows up as a new song while its old path turns
    /// unavailable. This pairs each such leftover with its identical new copy (same size, tags
    /// and length), carries over its favorite, plays, history and playlist entries, and removes
    /// the leftover. Songs in folders or drives that are not currently available are left
    /// alone, and ambiguous duplicates are skipped. Returns (old ID, new ID) pairs.
    pub fn relink_moved(&self) -> Result<Vec<(String, String)>> {
        let tracks = self.tracks()?;
        let key = |t: &Track| (t.size, t.title.clone(), t.artist.clone(), t.album.clone());
        let mut present: HashMap<_, Vec<&Track>> = HashMap::new();
        for t in tracks.iter().filter(|t| !t.missing) {
            present.entry(key(t)).or_default().push(t);
        }
        let file_name = |p: &str| Path::new(p).file_name().map(|n| n.to_ascii_lowercase());
        let mut pairs: Vec<(&Track, &Track)> = Vec::new();
        for ghost in tracks.iter().filter(|t| t.missing && t.size > 0) {
            if Path::new(&ghost.path).exists() || !Path::new(&ghost.folder).is_dir() {
                continue;
            }
            let same: Vec<&Track> = present
                .get(&key(ghost))
                .into_iter()
                .flatten()
                .copied()
                .filter(|c| (c.duration - ghost.duration).abs() < 0.5)
                .collect();
            let named: Vec<&Track> = same
                .iter()
                .copied()
                .filter(|c| file_name(&c.path) == file_name(&ghost.path))
                .collect();
            match (same.as_slice(), named.as_slice()) {
                ([only], _) | (_, [only]) => pairs.push((ghost, only)),
                _ => {}
            }
        }
        if pairs.is_empty() {
            return Ok(Vec::new());
        }
        let moved: HashMap<&str, &str> = pairs
            .iter()
            .map(|(old, new)| (old.id.as_str(), new.id.as_str()))
            .collect();
        let mut c = self.conn.lock().unwrap();
        let tx = c.transaction().map_err(err)?;
        for (old, new) in &pairs {
            tx.execute(
                "UPDATE tracks SET favorite=MAX(favorite,?1),play_count=play_count+?2,last_played=MAX(last_played,?3) WHERE id=?4",
                params![old.favorite, old.play_count, old.last_played, new.id],
            )
            .map_err(err)?;
            if old.added > 0 && old.added < new.added {
                let kept = Track {
                    added: old.added,
                    ..(*new).clone()
                };
                tx.execute(
                    "UPDATE tracks SET data=? WHERE id=?",
                    params![serde_json::to_string(&kept).map_err(err)?, new.id],
                )
                .map_err(err)?;
            }
            tx.execute(
                "UPDATE history SET track_id=? WHERE track_id=?",
                params![new.id, old.id],
            )
            .map_err(err)?;
            tx.execute("DELETE FROM tracks WHERE id=?", [&old.id])
                .map_err(err)?;
        }
        let saved: Vec<(String, String)> = {
            let mut s = tx.prepare("SELECT id,data FROM collections").map_err(err)?;
            let rows = s
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
                .map_err(err)?;
            rows.collect::<std::result::Result<_, _>>().map_err(err)?
        };
        for (id, data) in saved {
            let mut value: Value = serde_json::from_str(&data).map_err(err)?;
            let mut changed = false;
            let mut relink = |slot: &mut Value| {
                if let Some(new) = slot.as_str().and_then(|old| moved.get(old)) {
                    *slot = json!(new);
                    changed = true;
                }
            };
            for entry in value["entries"].as_array_mut().into_iter().flatten() {
                relink(&mut entry["trackId"]);
                for candidate in entry["candidates"].as_array_mut().into_iter().flatten() {
                    relink(&mut candidate["id"]);
                }
            }
            if changed {
                tx.execute(
                    "UPDATE collections SET data=? WHERE id=?",
                    params![value.to_string(), id],
                )
                .map_err(err)?;
            }
        }
        tx.commit().map_err(err)?;
        Ok(pairs
            .iter()
            .map(|(old, new)| (old.id.clone(), new.id.clone()))
            .collect())
    }
    /// Forgets unavailable songs: deleted files, and songs from folders no longer in the
    /// library. Songs whose library folder is only unreachable right now (an unplugged drive)
    /// are kept. Playlists keep their entries, shown as missing. Returns the removed IDs.
    pub fn remove_missing(&self) -> Result<Vec<String>> {
        let folders = self.folders();
        let offline = |folder: &str| folders.iter().any(|f| f == folder) && !Path::new(folder).is_dir();
        let c = self.conn.lock().unwrap();
        let candidates: Vec<(String, String)> = {
            let mut s = c
                .prepare("SELECT id,folder FROM tracks WHERE missing=1")
                .map_err(err)?;
            let rows = s.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).map_err(err)?;
            rows.collect::<std::result::Result<_, _>>().map_err(err)?
        };
        let ids: Vec<String> = candidates
            .into_iter()
            .filter(|(_, folder)| !offline(folder))
            .map(|(id, _)| id)
            .collect();
        for id in &ids {
            c.execute("DELETE FROM tracks WHERE id=?", [id]).map_err(err)?;
        }
        Ok(ids)
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
    fn looked_up_years_fill_every_copy_and_are_not_asked_again() {
        let dir = tempfile::tempdir().unwrap();
        let d = Database::open(dir.path()).unwrap();
        let song = |id: &str, title: &str, year| Track {
            id: id.into(),
            path: format!("{id}.flac"),
            title: title.into(),
            artist: "Cliff Richard".into(),
            year,
            ..Default::default()
        };
        d.upsert(&song("a", "Wired For Sound", 1994), 1).unwrap();
        d.upsert(&song("b", "Wired for Sound (2011 Remaster)", 2011), 1).unwrap();
        d.upsert(&song("c", "Living Doll", 1994), 1).unwrap();
        let mut needed = d.years_needed().unwrap();
        needed.sort_by(|a, b| a.key.cmp(&b.key));
        assert_eq!(needed.len(), 2, "both copies share one lookup");
        assert_eq!((needed[1].title.as_str(), needed[1].album_year), ("Wired For Sound", 1994));
        d.set_original_year(&needed[1].key, 1981).unwrap();
        d.set_original_year(&needed[0].key, 0).unwrap(); // not found
        let tracks = d.tracks().unwrap();
        let year = |id: &str| tracks.iter().find(|t| t.id == id).unwrap().original_year;
        assert_eq!((year("a"), year("b"), year("c")), (1981, 1981, 0));
        assert!(d.years_needed().unwrap().is_empty(), "a miss is not retried right away");
    }
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
