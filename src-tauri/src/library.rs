use crate::db::{err, now, Database, Result, Track};
use lofty::{
    file::{AudioFile, TaggedFileExt},
    tag::{Accessor, ItemKey},
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::UNIX_EPOCH,
};
use tauri::{Emitter, Manager};

#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ScanStatus {
    pub scanning: bool,
    pub processed: usize,
    pub changed: usize,
    pub errors: Vec<String>,
    pub last_scan: i64,
    /// (old ID, new ID) for songs recognized as moved during this scan.
    #[serde(skip)]
    pub relinked: Vec<(String, String)>,
}
pub struct Library {
    pub status: Mutex<ScanStatus>,
    busy: AtomicBool,
    pending: AtomicBool,
    pub watchers: Mutex<Vec<notify::RecommendedWatcher>>,
}
impl Library {
    pub fn new() -> Self {
        Self {
            status: Mutex::new(ScanStatus::default()),
            busy: AtomicBool::new(false),
            pending: AtomicBool::new(false),
            watchers: Mutex::new(Vec::new()),
        }
    }
    fn request_scan(&self) -> bool {
        self.pending.store(true, Ordering::SeqCst);
        !self.busy.swap(true, Ordering::SeqCst)
    }
    fn continue_scan(&self) -> bool {
        self.busy.store(false, Ordering::SeqCst);
        self.pending.load(Ordering::SeqCst) && !self.busy.swap(true, Ordering::SeqCst)
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
/// Album images next to the songs, used when a file has no embedded artwork.
const COVER_NAMES: [&str; 6] = [
    "cover.jpg",
    "folder.jpg",
    "front.jpg",
    "cover.png",
    "Folder.jpg",
    "Cover.jpg",
];
/// Cover images that could not be read (empty, corrupt, too large). They are skipped for the
/// rest of the session so their songs are not re-read on every scan.
static FAILED_COVERS: Mutex<Option<HashSet<PathBuf>>> = Mutex::new(None);
fn cover_failed(file: &Path) -> bool {
    FAILED_COVERS
        .lock()
        .unwrap()
        .as_ref()
        .is_some_and(|set| set.contains(file))
}
/// Album art candidates beside a song, best first: the usual names, then images named like a
/// front cover, then the folder's only image (e.g. "Artist - Album [2008].jpg"). Songs in disc
/// folders ("CD1", "Disc 2") also look in the album folder above.
fn folder_covers(path: &Path) -> Vec<PathBuf> {
    let Some(folder) = path.parent() else {
        return Vec::new();
    };
    let is_disc = |name: &str| {
        let name = name.to_lowercase();
        ["cd", "disc", "disk"].iter().any(|p| {
            name.strip_prefix(p).is_some_and(|rest| {
                rest.trim_start_matches([' ', '-', '_', '.'])
                    .starts_with(|c: char| c.is_ascii_digit())
            })
        })
    };
    let parent = folder
        .file_name()
        .and_then(|n| n.to_str())
        .filter(|n| is_disc(n))
        .and_then(|_| folder.parent());
    let mut found = Vec::new();
    for dir in std::iter::once(folder).chain(parent) {
        // The extension is checked from the listing first, so large folders of songs cost
        // no extra file-system calls.
        let images: Vec<PathBuf> = std::fs::read_dir(dir)
            .into_iter()
            .flatten()
            .flatten()
            .filter(|e| {
                Path::new(&e.file_name())
                    .extension()
                    .and_then(|x| x.to_str())
                    .is_some_and(|x| {
                        matches!(x.to_lowercase().as_str(), "jpg" | "jpeg" | "png" | "webp")
                    })
                    && e.file_type().is_ok_and(|t| t.is_file())
            })
            .map(|e| e.path())
            .collect();
        let stem = |p: &PathBuf| {
            p.file_stem()
                .map(|s| s.to_string_lossy().to_lowercase())
                .unwrap_or_default()
        };
        let named = |name: &str| {
            images
                .iter()
                .find(|p| p.file_name().is_some_and(|f| f.eq_ignore_ascii_case(name)))
        };
        found.extend(COVER_NAMES.iter().filter_map(|n| named(n)).cloned());
        found.extend(
            images
                .iter()
                .filter(|p| {
                    let s = stem(p);
                    ["cover", "front", "folder", "albumart"]
                        .iter()
                        .any(|k| s.contains(k))
                        && !s.contains("back")
                })
                .cloned(),
        );
        if let [one] = images.as_slice() {
            if !["back", "inlay", "tray", "cd", "disc", "booklet"]
                .iter()
                .any(|k| stem(one).contains(k))
            {
                found.push(one.clone());
            }
        }
    }
    let mut seen = HashSet::new();
    found.retain(|f| seen.insert(f.clone()) && !cover_failed(f));
    found
}
fn folder_cover(path: &Path) -> Option<PathBuf> {
    folder_covers(path).into_iter().next()
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
        for file in folder_covers(path) {
            artwork = std::fs::read(&file)
                .ok()
                .and_then(|data| cache_art(&data, db));
            if artwork.is_some() {
                break;
            }
            FAILED_COVERS
                .lock()
                .unwrap()
                .get_or_insert_with(HashSet::new)
                .insert(file);
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
        original_year: tag
            .and_then(|t| t.get_string(&ItemKey::OriginalReleaseDate))
            .and_then(|date| date.get(..4)?.parse().ok())
            .unwrap_or(0),
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
    let known_by_id: HashMap<_, _> = known
        .iter()
        .map(|track| (track.id.as_str(), track))
        .collect();
    // Whether a folder has a usable cover, looked up once per folder per scan.
    let mut cover_here: HashMap<PathBuf, bool> = HashMap::new();
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
            // An unchanged song is read again when a cover image has since appeared beside it.
            let new_cover = known_by_id
                .get(id.as_str())
                .is_some_and(|t| t.artwork.is_none())
                && *cover_here
                    .entry(path.parent().map(Path::to_path_buf).unwrap_or_default())
                    .or_insert_with(|| folder_cover(path).is_some());
            if new_cover || !db.unchanged(&id, mtime, meta.len()) {
                match read_track(path, &folder, db) {
                    Ok(mut t) => {
                        if let Some(old) = known_by_id.get(id.as_str()) {
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
    match db.relink_moved() {
        Ok(moved) => status.relinked = moved,
        Err(e) => status
            .errors
            .push(format!("Could not update moved songs: {e}")),
    }
    status.scanning = false;
    status.last_scan = now();
    progress(status.clone());
    status
}
pub fn start_scan(db: Arc<Database>, lib: Arc<Library>, app: tauri::AppHandle) {
    if !lib.request_scan() {
        return;
    }
    *lib.status.lock().unwrap() = ScanStatus {
        scanning: true,
        ..Default::default()
    };
    std::thread::spawn(move || loop {
        lib.pending.store(false, Ordering::SeqCst);
        let status = scan(&db, |s| {
            *lib.status.lock().unwrap() = s.clone();
            let _ = app.emit("scan", s);
        });
        if let Some(state) = app.try_state::<crate::AppState>() {
            state.engine.remap(&status.relinked);
        }
        crate::years::start(db.clone(), app.clone());
        let _ = app.emit("library-changed", ());
        if !lib.continue_scan() {
            break;
        }
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
    fn scan_requests_arriving_during_a_scan_are_not_dropped() {
        let library = Library::new();
        assert!(library.request_scan());
        library.pending.store(false, Ordering::SeqCst);
        assert!(!library.request_scan());
        assert!(!library.request_scan());
        assert!(library.continue_scan());
        library.pending.store(false, Ordering::SeqCst);
        assert!(!library.continue_scan());
        assert!(library.request_scan());
    }
    fn wav(path: &Path, frames: u32) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let spec = hound::WavSpec {
            channels: 2,
            sample_rate: 48000,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut w = hound::WavWriter::create(path, spec).unwrap();
        for _ in 0..frames * 2 {
            w.write_sample(0i16).unwrap()
        }
        w.finalize().unwrap();
    }
    fn library(root: &Path, folders: &[&Path]) -> Database {
        let db = Database::open(&root.join("db")).unwrap();
        db.set("folders", &serde_json::json!(folders)).unwrap();
        db
    }
    #[test]
    fn moved_song_keeps_favorite_plays_history_and_playlist_places() {
        let d = tempfile::tempdir().unwrap();
        let music = d.path().join("music");
        // Untagged files take their album name from the folder, so the album folder is kept.
        let before = music.join("Downloads").join("Night Drive").join("song.wav");
        let after = music
            .join("Aurora Lane")
            .join("Night Drive")
            .join("song.wav");
        wav(&before, 9600);
        let db = library(d.path(), &[&music]);
        scan(&db, |_| {});
        let old = db.tracks().unwrap()[0].id.clone();
        db.favorite(&old, true).unwrap();
        db.played(&old).unwrap();
        db.save_collection(serde_json::json!({"id":"p","name":"Mix","entries":[{"trackId":old,"candidates":[{"id":old}]}]}))
            .unwrap();
        std::fs::create_dir_all(after.parent().unwrap()).unwrap();
        std::fs::rename(&before, &after).unwrap();
        let status = scan(&db, |_| {});
        let tracks = db.tracks().unwrap();
        assert_eq!(tracks.len(), 1, "the leftover entry is gone");
        let t = &tracks[0];
        assert_eq!(status.relinked, vec![(old.clone(), t.id.clone())]);
        assert!(!t.missing && t.favorite);
        assert_eq!(t.play_count, 1);
        let history: String = db
            .conn
            .lock()
            .unwrap()
            .query_row("SELECT track_id FROM history", [], |r| r.get(0))
            .unwrap();
        assert_eq!(history, t.id);
        let entry = &db.collections().unwrap()[0]["entries"][0];
        assert_eq!(entry["trackId"], t.id.as_str());
        assert_eq!(entry["candidates"][0]["id"], t.id.as_str());
    }
    #[test]
    fn unavailable_folders_and_ambiguous_copies_are_left_alone() {
        let d = tempfile::tempdir().unwrap();
        let (music, other) = (d.path().join("music"), d.path().join("usb"));
        let song = |root: &Path, sub: &str| root.join(sub).join("Album").join("song.wav");
        wav(&song(&other, "a"), 4800);
        wav(&song(&music, "b"), 4800);
        let db = library(d.path(), &[&music, &other]);
        scan(&db, |_| {});
        std::fs::remove_dir_all(&other).unwrap(); // the drive is unplugged
        let status = scan(&db, |_| {});
        assert!(status.relinked.is_empty());
        assert_eq!(db.tracks().unwrap().iter().filter(|t| t.missing).count(), 1);
        // A moved song with two identical candidates is not guessed.
        wav(&song(&music, "c"), 2400);
        scan(&db, |_| {});
        wav(&song(&music, "d"), 2400);
        wav(&song(&music, "e"), 2400);
        std::fs::remove_file(song(&music, "c")).unwrap();
        let status = scan(&db, |_| {});
        assert!(status.relinked.is_empty());
        // Cleanup removes the deleted file but keeps the song on the unplugged drive.
        assert_eq!(db.remove_missing().unwrap().len(), 1);
        let left: Vec<_> = db
            .tracks()
            .unwrap()
            .into_iter()
            .filter(|t| t.missing)
            .collect();
        assert_eq!(left.len(), 1);
        assert!(left[0].path.contains("usb"));
    }
    #[test]
    fn a_cover_added_later_is_picked_up_without_changing_the_song() {
        let d = tempfile::tempdir().unwrap();
        let music = d.path().join("music");
        let file = music.join("Album").join("song.wav");
        wav(&file, 4800);
        let db = library(d.path(), &[&music]);
        scan(&db, |_| {});
        assert!(db.tracks().unwrap()[0].artwork.is_none());
        image::RgbImage::new(8, 8)
            .save(music.join("Album").join("cover.png"))
            .unwrap();
        assert_eq!(scan(&db, |_| {}).changed, 1);
        assert!(db.tracks().unwrap()[0].artwork.is_some());
        assert_eq!(scan(&db, |_| {}).changed, 0);
    }
    #[test]
    fn a_broken_cover_falls_back_to_the_next_image_and_is_not_retried_every_scan() {
        let d = tempfile::tempdir().unwrap();
        let music = d.path().join("music");
        wav(&music.join("A").join("song.wav"), 4800);
        std::fs::write(music.join("A").join("cover.jpg"), b"").unwrap(); // empty file
        image::RgbImage::new(8, 8)
            .save(music.join("A").join("front.png"))
            .unwrap();
        wav(&music.join("B").join("song.wav"), 2400);
        std::fs::write(music.join("B").join("folder.jpg"), b"not an image").unwrap();
        let db = library(d.path(), &[&music]);
        assert_eq!(scan(&db, |_| {}).changed, 2);
        let tracks = db.tracks().unwrap();
        let art = |dir: &str| {
            tracks
                .iter()
                .find(|t| {
                    Path::new(&t.path)
                        .parent()
                        .is_some_and(|p| p.ends_with(dir))
                })
                .unwrap()
                .artwork
                .clone()
        };
        assert!(art("A").is_some(), "front.png is used instead");
        assert!(art("B").is_none(), "an unreadable cover is not used");
        assert_eq!(
            scan(&db, |_| {}).changed,
            0,
            "the broken cover does not cause re-reads"
        );
    }
    #[test]
    fn finds_covers_named_after_the_album_and_above_disc_folders() {
        let d = tempfile::tempdir().unwrap();
        let root = d.path();
        let img = |p: PathBuf| image::RgbImage::new(4, 4).save(p).unwrap();
        let named = root.join("Walking On A Dream");
        wav(&named.join("01.wav"), 10);
        img(named.join("Empire Of The Sun - Walking On A Dream [2008].jpg"));
        assert!(folder_cover(&named.join("01.wav")).is_some());
        let back_only = root.join("Back only");
        wav(&back_only.join("01.wav"), 10);
        img(back_only.join("Back.jpg"));
        assert!(folder_cover(&back_only.join("01.wav")).is_none());
        let album = root.join("Trilogy");
        wav(&album.join("Disc 1 - House").join("01.wav"), 10);
        img(album.join("front.png"));
        img(album.join("back.png"));
        assert_eq!(
            folder_cover(&album.join("Disc 1 - House").join("01.wav")),
            Some(album.join("front.png"))
        );
        let several = root.join("Several");
        wav(&several.join("01.wav"), 10);
        img(several.join("a.jpg"));
        img(several.join("b.jpg"));
        assert!(
            folder_cover(&several.join("01.wav")).is_none(),
            "no guessing between images"
        );
    }
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
