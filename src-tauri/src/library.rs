use crate::db::{err, now, Database, Result, Track};
use lofty::{
    file::{AudioFile, FileType, TaggedFile, TaggedFileExt},
    tag::{Accessor, ItemKey},
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc, Arc, Condvar, Mutex,
    },
    time::{Duration, Instant, UNIX_EPOCH},
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
        "flac" | "mp3" | "wav" | "ogg" | "opus" | "m4a" | "aac" | "aif" | "aiff"
    )
}
/// Stores an image with the artwork (both sizes) and returns its hash, as covers are.
pub fn store_art(data: &[u8], db: &Database) -> Option<String> {
    cache_art(data, db)
}
/// Covers being made right now. A scan reads songs on several threads, and the songs of an
/// album share one cover: the first thread makes it and the others wait for that one.
static COVERS_BEING_MADE: Mutex<Option<HashSet<String>>> = Mutex::new(None);
static COVER_MADE: Condvar = Condvar::new();
fn cache_art(data: &[u8], db: &Database) -> Option<String> {
    if data.len() > 24_000_000 {
        return None;
    }
    let hash = hex::encode(Sha256::digest(data));
    let dir = db.directory.join("artwork");
    let (file, large) = (
        dir.join(format!("{hash}.jpg")),
        dir.join(format!("{hash}-xl.jpg")),
    );
    {
        let mut busy = COVERS_BEING_MADE.lock().unwrap();
        while busy.get_or_insert_with(HashSet::new).contains(&hash) {
            busy = COVER_MADE.wait(busy).unwrap();
        }
        if file.exists() && large.exists() {
            return Some(hash);
        }
        busy.get_or_insert_with(HashSet::new).insert(hash.clone());
    }
    let made = (|| {
        let img = image::ImageReader::new(std::io::Cursor::new(data))
            .with_guessed_format()
            .ok()?
            .decode()
            .ok()?;
        // Written under another name first, so a cover is never shown half-written.
        let write = |image: image::RgbImage, to: &Path| {
            let part = to.with_extension("part.jpg");
            image.save(&part).ok()?;
            std::fs::rename(&part, to).ok()
        };
        if !file.exists() {
            write(fit(&img, 640), &file)?;
        }
        // A sharper copy for full-screen views and large, high-DPI screens.
        let _ = write(fit(&img, 1600), &large);
        Some(())
    })();
    if let Some(busy) = COVERS_BEING_MADE.lock().unwrap().as_mut() {
        busy.remove(&hash);
    }
    COVER_MADE.notify_all();
    made.map(|_| hash)
}
/// Shrinks to fit `max` pixels, never enlarging a smaller image.
fn fit(img: &image::DynamicImage, max: u32) -> image::RgbImage {
    if img.width() <= max && img.height() <= max {
        img.to_rgb8()
    } else {
        img.thumbnail(max, max).to_rgb8()
    }
}
/// Covers indexed before large copies existed get one in the background, by finding the
/// original image again (embedded or beside the song) and checking it is the same picture.
pub fn upgrade_artwork(db: Arc<Database>) {
    std::thread::spawn(move || {
        let Ok(tracks) = db.tracks() else { return };
        let dir = db.directory.join("artwork");
        let mut done = HashSet::new();
        for t in tracks.iter().filter(|t| !t.missing) {
            let Some(hash) = t.artwork.as_deref() else {
                continue;
            };
            if !done.insert(hash.to_string()) || dir.join(format!("{hash}-xl.jpg")).exists() {
                continue;
            }
            let path = Path::new(&t.path);
            let embedded = lofty::read_from_path(path).ok().map(|tagged| {
                tagged
                    .tags()
                    .iter()
                    .flat_map(|tag| tag.pictures().iter().map(|p| p.data().to_vec()))
                    .collect::<Vec<_>>()
            });
            let beside = folder_covers(path)
                .into_iter()
                .filter_map(|f| std::fs::read(f).ok());
            if let Some(data) = embedded
                .into_iter()
                .flatten()
                .chain(beside)
                .find(|d| hex::encode(Sha256::digest(d)) == hash)
            {
                let _ = cache_art(&data, &db);
            }
        }
    });
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
/// Reads a file's tags, going by its name first and then by what it really holds: an Opus
/// song in an .ogg file, an MP3 that was named .flac. The flag says the name was wrong.
fn read_tags(path: &Path) -> std::result::Result<(TaggedFile, bool), String> {
    let by_name = match lofty::read_from_path(path) {
        Ok(tagged) => return Ok((tagged, false)),
        Err(e) => e,
    };
    lofty::probe::Probe::open(path)
        .ok()
        .and_then(|probe| probe.guess_file_type().ok())
        .and_then(|probe| probe.read().ok())
        .map(|tagged| (tagged, true))
        .ok_or_else(|| by_name.to_string())
}
/// What a file's name says about a song without tags: (track number, artist, title).
/// "07 Title", "07 - Title", "7. Title" and "Artist - Title" are understood. A bare number
/// before a space ("10 Years Gone", "99 Luftballons") is part of the name, unless the folder
/// is `numbered`: its files are plainly numbered, so "10 Title" there is the tenth song.
pub fn from_file_name(stem: &str, numbered: bool) -> (u32, Option<String>, String) {
    let stem = stem.trim();
    let digits = stem.chars().take_while(char::is_ascii_digit).count();
    let (number, rest) = stem.split_at(digits);
    let after = rest.trim_start();
    let marked = after.strip_prefix(['.', '-', '_', ')']);
    let spaced = after.len() < rest.len() && !after.is_empty();
    let (track, name) = match (digits, marked) {
        (1..=3, Some(name)) if !name.trim().is_empty() => (number.parse().unwrap_or(0), name),
        (2..=3, None) if spaced && (numbered || number.starts_with('0')) => {
            (number.parse().unwrap_or(0), after)
        }
        _ => (0, stem),
    };
    let name = name.trim().trim_start_matches(['-', '_']).trim();
    match name.split_once(" - ") {
        Some((artist, title)) if !artist.trim().is_empty() && !title.trim().is_empty() => {
            (track, Some(artist.trim().into()), title.trim().into())
        }
        _ if name.is_empty() => (0, None, stem.into()),
        _ => (track, None, name.into()),
    }
}
/// Whether the files beside this one are numbered the way ripped albums are ("01 Title",
/// "02 - Title"), which tells a track number from a title that starts with a number.
fn in_numbered_folder(path: &Path) -> bool {
    let numbered = |name: &str| {
        let mut c = name.chars();
        c.next() == Some('0')
            && c.next().is_some_and(|d| d.is_ascii_digit())
            && c.next().is_some_and(|sep| " .-_".contains(sep))
    };
    path.parent()
        .and_then(|dir| std::fs::read_dir(dir).ok())
        .is_some_and(|entries| {
            entries
                .flatten()
                .any(|entry| numbered(&entry.file_name().to_string_lossy()))
        })
}
pub fn read_track(path: &Path, folder: &str, db: &Database) -> Result<Track> {
    let tags = read_tags(path);
    // The length and rate the player itself finds, asked for only when the tags can't say:
    // a file whose tags can't be read at all (raw AAC), or one that ends early.
    let played = |known: f64| {
        (known <= 0.)
            .then(|| crate::audio::open(&path.to_string_lossy()).ok())
            .flatten()
            .map(|song| {
                (
                    song.total_duration().map_or(0., |d| d.as_secs_f64()),
                    song.sample_rate(),
                )
            })
    };
    let (tagged, misnamed) = match tags {
        Ok((tagged, misnamed)) => (Some(tagged), misnamed),
        // No tags to read, but if it plays it belongs in the library, named after its file.
        Err(why) => match played(0.) {
            Some(_) => (None, false),
            None => return Err(why),
        },
    };
    let props = tagged.as_ref().map(|t| t.properties());
    let tag = tagged
        .as_ref()
        .and_then(|t| t.primary_tag().or_else(|| t.first_tag()));
    let stem = path
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let tagged_title = tag
        .and_then(|t| t.title())
        .map(|v| v.to_string())
        .filter(|v| !v.trim().is_empty());
    let tagged_track = tag.and_then(|t| t.track()).filter(|n| *n > 0);
    // The folder is only looked at for a name that could go either way ("10 Something").
    let ambiguous = (tagged_title.is_none() || tagged_track.is_none())
        && stem.chars().take_while(char::is_ascii_digit).count() >= 2
        && !stem.starts_with('0');
    let (named_track, named_artist, named_title) =
        from_file_name(&stem, ambiguous && in_numbered_folder(path));
    let tagged_artist = tag
        .and_then(|t| t.artist())
        .map(|v| v.to_string())
        .filter(|v| !v.trim().is_empty());
    // The file's name speaks only where the tags are silent: with a title in the tags, an
    // "Artist - Title" file name is not taken apart.
    let artist = tagged_artist
        .or_else(|| named_artist.filter(|_| tagged_title.is_none()))
        .unwrap_or_else(|| "Unknown artist".into());
    let title = tagged_title.unwrap_or(named_title);
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
    let mut duration = props.map_or(0., |p| p.duration().as_secs_f64());
    let mut sample_rate = props.and_then(|p| p.sample_rate()).unwrap_or(0);
    if let Some((length, rate)) = played(duration) {
        duration = length;
        if sample_rate == 0 {
            sample_rate = rate;
        }
    }
    // Named for what the file holds when its name says something else.
    let format = match tagged.as_ref().filter(|_| misnamed).map(|t| t.file_type()) {
        Some(FileType::Flac) => "FLAC".into(),
        Some(FileType::Mpeg) => "MP3".into(),
        Some(FileType::Mp4) => "M4A".into(),
        Some(FileType::Opus) => "OPUS".into(),
        Some(FileType::Vorbis) => "OGG".into(),
        Some(FileType::Wav) => "WAV".into(),
        Some(FileType::Aiff) => "AIFF".into(),
        Some(FileType::Aac) => "AAC".into(),
        _ => path
            .extension()
            .unwrap_or_default()
            .to_string_lossy()
            .to_uppercase(),
    };
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
        track: tagged_track.unwrap_or(named_track),
        disc: tag.and_then(|t| t.disk()).unwrap_or(1),
        duration,
        format,
        sample_rate,
        bit_depth: props.and_then(|p| p.bit_depth()).unwrap_or(0),
        artwork,
        added: now(),
        size: meta.len(),
        ..Default::default()
    })
}
/// A file a scan has to read: new, changed, or with a cover that has since appeared.
struct ToRead {
    path: PathBuf,
    id: String,
    mtime: i64,
}
/// Songs are saved this many at a time, or sooner when this long has passed.
const WRITE_BATCH: usize = 200;
const WRITE_EVERY: Duration = Duration::from_millis(400);
/// Reads `files` on several threads (tags, and covers, which take the longest) while this one
/// saves what they find, a batch at a time. Returns the IDs of songs the library did not know.
fn read_files(
    db: &Database,
    folder: &str,
    files: &[ToRead],
    known: &HashMap<&str, &Track>,
    status: &mut ScanStatus,
    progress: &mut impl FnMut(ScanStatus),
) -> HashSet<String> {
    let mut new_ids = HashSet::new();
    // One core is left for the music.
    let readers = std::thread::available_parallelism()
        .map_or(2, |n| n.get().saturating_sub(1))
        .clamp(1, 6)
        .min(files.len());
    let next = AtomicUsize::new(0);
    let (found, results) = mpsc::channel();
    std::thread::scope(|scope| {
        for _ in 0..readers {
            let found = found.clone();
            let next = &next;
            scope.spawn(move || {
                while let Some((i, file)) = Some(next.fetch_add(1, Ordering::Relaxed))
                    .and_then(|i| Some((i, files.get(i)?)))
                {
                    if found.send((i, read_track(&file.path, folder, db))).is_err() {
                        break;
                    }
                }
            });
        }
        drop(found);
        let mut batch: Vec<(Track, i64)> = Vec::new();
        let mut written = Instant::now();
        let write = |batch: &mut Vec<(Track, i64)>,
                     status: &mut ScanStatus,
                     new_ids: &mut HashSet<String>| {
            if batch.is_empty() {
                return;
            }
            // Together when possible; if one song can't be saved, the others still are.
            if db.upsert_many(batch).is_ok() {
                status.changed += batch.len();
            } else {
                for (t, mtime) in batch.iter() {
                    match db.upsert(t, *mtime) {
                        Ok(()) => status.changed += 1,
                        Err(e) => {
                            new_ids.remove(&t.id);
                            status.errors.push(e)
                        }
                    }
                }
            }
            batch.clear();
        };
        for (i, read) in results {
            let file = &files[i];
            status.processed += 1;
            match read {
                Ok(mut t) => {
                    match known.get(file.id.as_str()) {
                        Some(old) => t.added = old.added,
                        None => {
                            new_ids.insert(file.id.clone());
                        }
                    }
                    batch.push((t, file.mtime));
                }
                Err(e) => {
                    if status.errors.len() < 30 {
                        status.errors.push(format!(
                            "{}: {}",
                            file.path.file_name().unwrap_or_default().to_string_lossy(),
                            e
                        ));
                    }
                }
            }
            if batch.len() >= WRITE_BATCH || written.elapsed() >= WRITE_EVERY {
                write(&mut batch, status, &mut new_ids);
                written = Instant::now();
                progress(status.clone());
            }
        }
        write(&mut batch, status, &mut new_ids);
    });
    new_ids
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
    let mut new_ids = HashSet::new();
    // Whether a folder has a usable cover, looked up once per folder per scan.
    let mut cover_here: HashMap<PathBuf, bool> = HashMap::new();
    for folder in db.folders() {
        let root = Path::new(&folder);
        let mut seen = HashSet::new();
        let mut complete = true;
        let in_folder = |t: &&Track| t.folder == folder;
        if !root.exists() {
            status.errors.push(format!("Folder unavailable: {folder}"));
            let gone: Vec<String> = known
                .iter()
                .filter(in_folder)
                .map(|t| t.id.clone())
                .collect();
            let _ = db.missing_many(&gone, true);
            continue;
        }
        // First, a quick walk to see what is there; the files that need reading are read
        // afterwards, several at a time.
        let mut to_read = Vec::new();
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
            let meta = match path.metadata() {
                Ok(m) => m,
                Err(e) => {
                    complete = false;
                    status.processed += 1;
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
                to_read.push(ToRead {
                    path: path.to_path_buf(),
                    id,
                    mtime,
                });
            } else {
                status.processed += 1;
                if status.processed.is_multiple_of(500) {
                    progress(status.clone());
                }
            }
        }
        progress(status.clone());
        new_ids.extend(read_files(
            db,
            &folder,
            &to_read,
            &known_by_id,
            &mut status,
            &mut progress,
        ));
        if complete {
            let gone: Vec<String> = known
                .iter()
                .filter(in_folder)
                .filter(|t| !t.missing && !seen.contains(&t.id))
                .map(|t| t.id.clone())
                .collect();
            let _ = db.missing_many(&gone, true);
        }
    }
    match db.relink_moved(&new_ids) {
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
static ARTWORK_UPGRADED: AtomicBool = AtomicBool::new(false);
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
        crate::loudness::start(db.clone());
        if !ARTWORK_UPGRADED.swap(true, Ordering::SeqCst) {
            upgrade_artwork(db.clone());
        }
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
    fn a_file_without_tags_is_named_after_its_file() {
        let read = |stem: &str, numbered: bool| {
            let (track, artist, title) = from_file_name(stem, numbered);
            (track, artist.unwrap_or_default(), title)
        };
        let name = |stem: &str| read(stem, false);
        let is =
            |track: u32, artist: &str, title: &str| (track, artist.to_string(), title.to_string());
        assert_eq!(name("07 just a number"), is(7, "", "just a number"));
        assert_eq!(name("07 - Title"), is(7, "", "Title"));
        assert_eq!(name("7. Title"), is(7, "", "Title"));
        assert_eq!(name("12_title"), is(12, "", "title"));
        assert_eq!(name("Some Band - A Song"), is(0, "Some Band", "A Song"));
        assert_eq!(
            name("01 - Some Band - A Song - Live"),
            is(1, "Some Band", "A Song - Live")
        );
        // Numbers that are part of the name stay in it.
        assert_eq!(name("99 Luftballons"), is(0, "", "99 Luftballons"));
        assert_eq!(name("7 Years"), is(0, "", "7 Years"));
        assert_eq!(name("1979"), is(0, "", "1979"));
        assert_eq!(name("2112 - Overture"), is(0, "2112", "Overture"));
        assert_eq!(name("04 7 Years"), is(4, "", "7 Years"));
        assert_eq!(name("Blink-182"), is(0, "", "Blink-182"));
        assert_eq!(name("01 "), is(0, "", "01"));
        assert_eq!(name("07 -"), is(0, "", "07 -"));
        // Beside files numbered "01 ...", "02 ...", a bare number is a track number too.
        assert_eq!(name("10 Years Gone"), is(0, "", "10 Years Gone"));
        assert_eq!(read("10 Years Gone", true), is(10, "", "Years Gone"));
        assert_eq!(read("1979", true), is(0, "", "1979"));
        assert_eq!(read("7 Years", true), is(0, "", "7 Years"));
        assert_eq!(name("夜に駆ける"), is(0, "", "夜に駆ける"));
    }
    /// Writes a one-second WAV file, which needs no encoder.
    fn second_of_sound(path: &Path) {
        let spec = hound::WavSpec {
            channels: 2,
            sample_rate: 44100,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut w = hound::WavWriter::create(path, spec).unwrap();
        for i in 0..88200 {
            w.write_sample((i % 100) as i16).unwrap();
        }
        w.finalize().unwrap();
    }
    #[test]
    fn untagged_and_misnamed_files_are_still_added() {
        let dir = tempfile::tempdir().unwrap();
        let music = dir.path().join("music");
        std::fs::create_dir_all(music.join("Loose Songs")).unwrap();
        let db = Database::open(&dir.path().join("profile")).unwrap();
        let folder = music.to_string_lossy().to_string();
        db.set("folders", &serde_json::json!([folder])).unwrap();
        second_of_sound(&music.join("Loose Songs/03 Some Band - A Song.wav"));
        // A WAV file that was named .flac: read for what it is.
        second_of_sound(&music.join("Loose Songs/wrong name.flac"));
        // Not music at all, whatever its name says.
        std::fs::write(music.join("Loose Songs/notes.mp3"), "just some text").unwrap();
        let status = scan(&db, |_| {});
        assert_eq!((status.processed, status.changed), (3, 2));
        assert_eq!(status.errors.len(), 1, "{:?}", status.errors);
        assert!(status.errors[0].starts_with("notes.mp3"));
        let tracks = db.tracks().unwrap();
        let named = tracks.iter().find(|t| t.title == "A Song").unwrap();
        assert_eq!(
            (named.track, named.artist.as_str(), named.album.as_str()),
            (3, "Some Band", "Loose Songs")
        );
        assert!((named.duration - 1.).abs() < 0.01);
        let misnamed = tracks.iter().find(|t| t.title == "wrong name").unwrap();
        assert_eq!(
            (misnamed.format.as_str(), misnamed.sample_rate),
            ("WAV", 44100)
        );
        // Nothing is read twice.
        let again = scan(&db, |_| {});
        assert_eq!((again.processed, again.changed), (3, 0));
    }
    #[test]
    fn a_large_folder_is_read_on_several_threads_and_saved_whole() {
        let dir = tempfile::tempdir().unwrap();
        let music = dir.path().join("music");
        let db = Database::open(&dir.path().join("profile")).unwrap();
        db.set("folders", &serde_json::json!([music.to_string_lossy()]))
            .unwrap();
        // More songs than one batch of writes, sharing one cover per album.
        for album in 0..5 {
            let folder = music.join(format!("Album {album}"));
            std::fs::create_dir_all(&folder).unwrap();
            image::RgbImage::from_pixel(64, 64, image::Rgb([album as u8 * 40, 90, 120]))
                .save(folder.join("cover.jpg"))
                .unwrap();
            for song in 0..90 {
                second_of_sound(&folder.join(format!("{song:02} Song {album}-{song}.wav")));
            }
        }
        let mut reports = 0;
        let status = scan(&db, |_| reports += 1);
        assert_eq!((status.processed, status.changed), (450, 450));
        assert!(status.errors.is_empty(), "{:?}", status.errors);
        assert!(reports >= 4, "progress is reported as batches are saved");
        let tracks = db.tracks().unwrap();
        assert_eq!(tracks.len(), 450);
        let covers: HashSet<_> = tracks.iter().map(|t| t.artwork.clone().unwrap()).collect();
        assert_eq!(covers.len(), 5, "one cover per album, made once");
        assert!(tracks
            .iter()
            .all(|t| t.track < 90 && t.title.starts_with("Song ")));
        let left: Vec<_> = std::fs::read_dir(dir.path().join("profile/artwork"))
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .filter(|name| name.contains(".part"))
            .collect();
        assert!(left.is_empty(), "no half-written covers are left: {left:?}");
        // A folder taken away marks every song of it unavailable at once.
        std::fs::rename(&music, dir.path().join("elsewhere")).unwrap();
        scan(&db, |_| {});
        assert!(db.tracks().unwrap().iter().all(|t| t.missing));
    }
    /// How long a first scan and a rescan of a real folder take. The music is only read.
    /// `SLATE_BENCH_LIBRARY=<folder> cargo test --release --lib real_folder -- --ignored --nocapture`
    #[test]
    #[ignore = "a measurement, not a check"]
    fn real_folder_scan_timings() {
        let folder = std::env::var("SLATE_BENCH_LIBRARY").unwrap();
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(dir.path()).unwrap();
        db.set("folders", &serde_json::json!([folder])).unwrap();
        for pass in ["first scan", "rescan, nothing changed"] {
            let started = std::time::Instant::now();
            let status = scan(&db, |_| {});
            println!(
                "{pass}: {:?} for {} songs ({} changed, {} notices)",
                started.elapsed(),
                status.processed,
                status.changed,
                status.errors.len()
            );
        }
        let covers = std::fs::read_dir(dir.path().join("artwork"))
            .unwrap()
            .count();
        println!("{covers} cover files written");
    }
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
    fn deleting_a_duplicate_does_not_relink_it_to_an_existing_copy() {
        let d = tempfile::tempdir().unwrap();
        let music = d.path().join("music");
        let before = music.join("a").join("Album").join("song.wav");
        let surviving = music.join("b").join("Album").join("song.wav");
        wav(&before, 4800);
        wav(&surviving, 4800);
        let db = library(d.path(), &[&music]);
        scan(&db, |_| {});
        let old = id_for(&before);
        let kept = id_for(&surviving);
        db.favorite(&old, true).unwrap();
        db.played(&old).unwrap();
        db.save_collection(serde_json::json!({"id":"p","name":"Mix","entries":[{"trackId":old}]}))
            .unwrap();

        std::fs::remove_file(&before).unwrap();
        let status = scan(&db, |_| {});

        assert!(status.relinked.is_empty());
        assert_eq!(db.tracks().unwrap().len(), 2);
        assert!(db.track(&old).unwrap().missing);
        assert!(db.track(&old).unwrap().favorite);
        assert_eq!(db.track(&old).unwrap().play_count, 1);
        assert!(!db.track(&kept).unwrap().favorite);
        assert_eq!(db.track(&kept).unwrap().play_count, 0);
        assert_eq!(db.collections().unwrap()[0]["entries"][0]["trackId"], old);
    }
    #[test]
    fn two_missing_copies_do_not_merge_into_one_new_destination() {
        let d = tempfile::tempdir().unwrap();
        let music = d.path().join("music");
        let first = music.join("a").join("Album").join("song.wav");
        let second = music.join("b").join("Album").join("song.wav");
        let after = music.join("c").join("Album").join("song.wav");
        wav(&first, 4800);
        wav(&second, 4800);
        let db = library(d.path(), &[&music]);
        scan(&db, |_| {});
        let old = [id_for(&first), id_for(&second)];
        db.favorite(&old[0], true).unwrap();
        db.played(&old[1]).unwrap();
        std::fs::create_dir_all(after.parent().unwrap()).unwrap();
        std::fs::rename(&first, &after).unwrap();
        std::fs::remove_file(&second).unwrap();

        let status = scan(&db, |_| {});

        assert!(
            status.relinked.is_empty(),
            "the move is ambiguous in reverse"
        );
        assert_eq!(db.tracks().unwrap().len(), 3);
        assert!(old.iter().all(|id| db.track(id).unwrap().missing));
        let new = db.track(&id_for(&after)).unwrap();
        assert!(!new.favorite);
        assert_eq!(new.play_count, 0);
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
