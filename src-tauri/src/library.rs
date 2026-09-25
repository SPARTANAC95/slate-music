use crate::db::{err, now, Database, Result, Track};
use lofty::{
    file::{AudioFile, TaggedFileExt},
    tag::{Accessor, ItemKey},
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::UNIX_EPOCH,
};
use tauri::Emitter;

#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ScanStatus {
    pub scanning: bool,
    pub processed: usize,
    pub changed: usize,
    pub errors: Vec<String>,
    pub last_scan: i64,
}
pub struct Library {
    pub status: Mutex<ScanStatus>,
    busy: AtomicBool,
    pub watchers: Mutex<Vec<notify::RecommendedWatcher>>,
}
impl Library {
    pub fn new() -> Self {
        Self {
            status: Mutex::new(ScanStatus::default()),
            busy: AtomicBool::new(false),
            watchers: Mutex::new(Vec::new()),
        }
    }
}
pub fn id_for(path: &Path) -> String {
    hex::encode(Sha256::digest(
        path.to_string_lossy()
            .replace('/', "\\")
            .to_lowercase()
            .as_bytes(),
    ))
}
pub fn supported(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_lowercase()
            .as_str(),
        "flac" | "mp3" | "wav" | "ogg" | "m4a" | "aac" | "aif" | "aiff"
    )
}
fn cache_art(data: &[u8], db: &Database) -> Option<String> {
    if data.len() > 24_000_000 {
        return None;
    }
    let hash = hex::encode(Sha256::digest(data));
    let file = db.directory.join("artwork").join(format!("{hash}.jpg"));
    if !file.exists() {
        let reader = image::ImageReader::new(std::io::Cursor::new(data))
            .with_guessed_format()
            .ok()?;
        let img = reader.decode().ok()?;
        img.thumbnail(640, 640).to_rgb8().save(&file).ok()?;
    }
    Some(hash)
}
pub fn read_track(path: &Path, folder: &str, db: &Database) -> Result<Track> {
    let tagged = lofty::read_from_path(path).map_err(err)?;
    let props = tagged.properties();
    let tag = tagged.primary_tag().or_else(|| tagged.first_tag());
    let stem = path
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let title = tag
        .and_then(|t| t.title())
        .map(|v| v.to_string())
        .filter(|v| !v.trim().is_empty())
        .unwrap_or(stem);
    let artist = tag
        .and_then(|t| t.artist())
        .map(|v| v.to_string())
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| "Unknown artist".into());
    let album = tag
        .and_then(|t| t.album())
        .map(|v| v.to_string())
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| {
            path.parent()
                .and_then(|p| p.file_name())
                .unwrap_or_default()
                .to_string_lossy()
                .to_string()
        });
    let album_artist = tag
        .and_then(|t| t.get_string(&ItemKey::AlbumArtist))
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(&artist)
        .to_string();
    let mut artwork = tag
        .and_then(|t| t.pictures().first())
        .and_then(|p| cache_art(p.data(), db));
    if artwork.is_none() {
        for name in [
            "cover.jpg",
            "folder.jpg",
            "front.jpg",
            "cover.png",
            "Folder.jpg",
            "Cover.jpg",
        ] {
            if let Ok(data) = std::fs::read(path.parent().unwrap_or(Path::new(".")).join(name)) {
                artwork = cache_art(&data, db);
                if artwork.is_some() {
                    break;
                }
            }
        }
    }
    let meta = path.metadata().map_err(err)?;
    Ok(Track {
        id: id_for(path),
        path: path.to_string_lossy().into(),
        folder: folder.into(),
        title,
        artist,
        album,
        album_artist,
        year: tag.and_then(|t| t.year()).unwrap_or(0),
        track: tag.and_then(|t| t.track()).unwrap_or(0),
        disc: tag.and_then(|t| t.disk()).unwrap_or(1),
        duration: props.duration().as_secs_f64(),
        format: path
            .extension()
            .unwrap_or_default()
            .to_string_lossy()
            .to_uppercase(),
        sample_rate: props.sample_rate().unwrap_or(0),
        bit_depth: props.bit_depth().unwrap_or(0),
        artwork,
        added: now(),
        size: meta.len(),
        ..Default::default()
    })
}
pub fn scan(db: &Database, mut progress: impl FnMut(ScanStatus)) -> ScanStatus {
    let mut status = ScanStatus {
        scanning: true,
        ..Default::default()
    };
    let known = db.tracks().unwrap_or_default();
    for folder in db.folders() {
        let root = Path::new(&folder);
        let mut seen = HashSet::new();
        let mut complete = true;
        if !root.exists() {
            status.errors.push(format!("Folder unavailable: {folder}"));
            for t in known.iter().filter(|t| t.folder == folder) {
                let _ = db.missing(&t.id, true);
            }
            continue;
        }
        for entry in walkdir::WalkDir::new(root).follow_links(false) {
            let entry = match entry {
                Ok(e) => e,
                Err(e) => {
                    complete = false;
                    if status.errors.len() < 30 {
                        status.errors.push(e.to_string());
                    }
                    continue;
                }
            };
            if !entry.file_type().is_file() || !supported(entry.path()) {
                continue;
            }
            let path = entry.path();
            let id = id_for(path);
            seen.insert(id.clone());
            status.processed += 1;
            let meta = match path.metadata() {
                Ok(m) => m,
                Err(e) => {
                    complete = false;
                    status.errors.push(e.to_string());
                    continue;
                }
            };
            let mtime = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);
            if !db.unchanged(&id, mtime, meta.len()) {
                match read_track(path, &folder, db) {
                    Ok(mut t) => {
                        if let Some(old) = known.iter().find(|o| o.id == id) {
                            t.added = old.added;
                        }
                        if let Err(e) = db.upsert(&t, mtime) {
                            status.errors.push(e)
                        } else {
                            status.changed += 1
                        }
                    }
                    Err(e) => {
                        if status.errors.len() < 30 {
                            status.errors.push(format!(
                                "{}: {}",
                                path.file_name().unwrap_or_default().to_string_lossy(),
                                e
                            ));
                        }
                    }
                }
            }
            if status.processed % 12 == 0 {
                progress(status.clone());
            }
        }
        if complete {
            for t in known
                .iter()
                .filter(|t| t.folder == folder && !seen.contains(&t.id))
            {
                let _ = db.missing(&t.id, true);
            }
        }
    }
    status.scanning = false;
    status.last_scan = now();
    progress(status.clone());
    status
}
pub fn start_scan(db: Arc<Database>, lib: Arc<Library>, app: tauri::AppHandle) {
    if lib.busy.swap(true, Ordering::SeqCst) {
        return;
    }
    *lib.status.lock().unwrap() = ScanStatus {
        scanning: true,
        ..Default::default()
    };
    std::thread::spawn(move || {
        scan(&db, |s| {
            *lib.status.lock().unwrap() = s.clone();
            let _ = app.emit("scan", s);
        });
        lib.busy.store(false, Ordering::SeqCst);
        let _ = app.emit("library-changed", ());
    });
}
pub fn watch(db: Arc<Database>, lib: Arc<Library>, app: tauri::AppHandle) {
    use notify::Watcher;
    let (tx, rx) = std::sync::mpsc::channel();
    let mut watchers = lib.watchers.lock().unwrap();
    watchers.clear();
    for folder in db.folders() {
        let tx = tx.clone();
        if let Ok(mut w) = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            if let Ok(e) = res {
                if !matches!(e.kind, notify::EventKind::Access(_)) {
                    let _ = tx.send(());
                }
            }
        }) {
            if w.watch(Path::new(&folder), notify::RecursiveMode::Recursive)
                .is_ok()
            {
                watchers.push(w);
            }
        }
    }
    drop(watchers);
    drop(tx);
    std::thread::spawn(move || {
        while rx.recv().is_ok() {
            while rx.recv_timeout(std::time::Duration::from_secs(2)).is_ok() {}
            start_scan(db.clone(), lib.clone(), app.clone());
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn incremental_scan_missing_and_returning_file() {
        let d = tempfile::tempdir().unwrap();
        let music = d.path().join("music");
        std::fs::create_dir(&music).unwrap();
        let f = music.join("example.wav");
        let spec = hound::WavSpec {
            channels: 2,
            sample_rate: 48000,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut w = hound::WavWriter::create(&f, spec).unwrap();
        for _ in 0..9600 {
            w.write_sample(0i16).unwrap()
        }
        w.finalize().unwrap();
        let db = Database::open(&d.path().join("db")).unwrap();
        db.set("folders", &serde_json::json!([music])).unwrap();
        assert_eq!(scan(&db, |_| {}).changed, 1);
        assert_eq!(scan(&db, |_| {}).changed, 0);
        let id = db.tracks().unwrap()[0].id.clone();
        db.favorite(&id, true).unwrap();
        std::fs::rename(&f, music.join("example.tmp")).unwrap();
        scan(&db, |_| {});
        assert!(db.track(&id).unwrap().missing);
        std::fs::rename(music.join("example.tmp"), &f).unwrap();
        scan(&db, |_| {});
        let t = db.track(&id).unwrap();
        assert!(!t.missing && t.favorite);
    }
}
