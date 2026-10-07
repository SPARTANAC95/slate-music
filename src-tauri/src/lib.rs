mod artists;
mod audio;
mod covers;
mod db;
mod desktop;
mod discord;
mod dsp;
mod exclusive;
mod library;
mod loudness;
mod lyrics;
mod opus;
mod scrobble;
mod spotify;
#[cfg(windows)]
mod taskbar;
#[cfg(windows)]
mod wasapi;
mod years;
use db::{err, Database, Result};
use serde_json::{json, Value};
use std::{path::PathBuf, sync::Arc};
use tauri::{Emitter, Manager};

struct AppState {
    db: Arc<Database>,
    library: Arc<library::Library>,
    engine: Arc<audio::Engine>,
}
/// Runs `work` with the database on a background thread, so the window never waits for the
/// disk, decryption or the network.
async fn blocking<T: Send + 'static>(
    db: &Arc<Database>,
    work: impl FnOnce(&Database) -> T + Send + 'static,
) -> Result<T> {
    let db = db.clone();
    tauri::async_runtime::spawn_blocking(move || work(&db))
        .await
        .map_err(err)
}
#[tauri::command]
async fn quit_app(app: tauri::AppHandle, state: tauri::State<'_, AppState>) -> Result<()> {
    state.engine.save();
    app.exit(0);
    Ok(())
}
#[tauri::command]
async fn verify_update_fixture(app: tauri::AppHandle, endpoint: String) -> Result<Value> {
    #[cfg(not(debug_assertions))]
    {
        let _ = (app, endpoint);
        Err("Update verification fixtures are only available in debug builds".into())
    }
    #[cfg(debug_assertions)]
    {
        use tauri_plugin_updater::UpdaterExt;
        let url = url::Url::parse(&endpoint).map_err(err)?;
        if url.host_str() != Some("127.0.0.1") {
            return Err("Only loopback test endpoints are allowed".into());
        }
        let updater = app
            .updater_builder()
            .endpoints(vec![url])
            .map_err(err)?
            .version_comparator(|_, _| true)
            .build()
            .map_err(err)?;
        let update = updater
            .check()
            .await
            .map_err(err)?
            .ok_or("No update fixture")?;
        let bytes = update.download(|_, _| {}, || {}).await.map_err(err)?;
        Ok(json!({"verified":true,"bytes":bytes.len(),"version":update.version}))
    }
}
#[tauri::command]
async fn snapshot(state: tauri::State<'_, AppState>) -> Result<Value> {
    let db = state.db.clone();
    let scan = state.library.status.lock().unwrap().clone();
    let playback = state.engine.snapshot();
    tauri::async_runtime::spawn_blocking(move||{let mut data=db.snapshot()?;data["scan"]=serde_json::to_value(scan).map_err(err)?;data["playback"]=serde_json::to_value(playback).map_err(err)?;data["loudnessMeasured"]=json!(db.loudness_count().unwrap_or(0));data["spotify"]=json!({"connected":spotify::connected(&db),"playlistAccess":spotify::playlist_access(&db),"likedAccess":spotify::liked_access(&db),"topAccess":spotify::top_access(&db),"clientId":db.get("spotify_client_id"),"redirectUri":spotify::REDIRECT});Ok(data)}).await.map_err(err)?
}
#[tauri::command]
async fn playback(
    action: String,
    value: Option<Value>,
    state: tauri::State<'_, AppState>,
) -> Result<audio::Playback> {
    let engine = state.engine.clone();
    tauri::async_runtime::spawn_blocking(move || {
        engine.command(&action, value.unwrap_or(Value::Null))
    })
    .await
    .map_err(err)?
}
/// Tells every window (main and mini-player) which songs' favorite state changed.
fn favorites_changed(app: &tauri::AppHandle, ids: &[String], value: bool) {
    let _ = app.emit("favorites-changed", json!({"ids": ids, "value": value}));
}
#[tauri::command]
async fn favorite(
    id: String,
    value: bool,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<()> {
    state.db.favorite(&id, value)?;
    favorites_changed(&app, &[id], value);
    Ok(())
}
#[tauri::command]
async fn favorite_many(
    ids: Vec<String>,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<()> {
    let mut done = Vec::with_capacity(ids.len());
    let result = ids.into_iter().try_for_each(|id| {
        state.db.favorite(&id, true)?;
        done.push(id);
        Ok(())
    });
    if !done.is_empty() {
        favorites_changed(&app, &done, true);
    }
    result
}
#[tauri::command]
async fn save_collection(collection: Value, state: tauri::State<'_, AppState>) -> Result<()> {
    state.db.save_collection(collection)
}
#[tauri::command]
async fn delete_collection(id: String, state: tauri::State<'_, AppState>) -> Result<()> {
    state.db.delete_collection(&id)
}
#[tauri::command]
async fn settings(
    value: Value,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<()> {
    if !value.is_object() {
        return Err("Invalid settings".into());
    }
    state.db.set("settings", &value)?;
    years::start(state.db.clone(), app);
    Ok(())
}
#[tauri::command]
fn rescan(app: tauri::AppHandle, state: tauri::State<'_, AppState>) {
    library::start_scan(state.db.clone(), state.library.clone(), app);
}
/// Windows' own Music folder, offered on first launch (None when there isn't one).
#[tauri::command]
fn music_folder(app: tauri::AppHandle) -> Option<String> {
    app.path()
        .audio_dir()
        .ok()
        .filter(|path| path.is_dir())
        .map(|path| path.to_string_lossy().into_owned())
}
/// Adds a folder to the library: the one given, or one chosen in a dialog.
#[tauri::command]
async fn add_folder(
    path: Option<String>,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<Option<String>> {
    let selected = match path {
        Some(path) => Some(PathBuf::from(path)).filter(|path| path.is_dir()),
        None => tauri::async_runtime::spawn_blocking(|| {
            rfd::FileDialog::new()
                .set_title("Choose your music folder")
                .pick_folder()
        })
        .await
        .map_err(err)?,
    };
    if let Some(path) = selected {
        let path = path
            .canonicalize()
            .map_err(err)?
            .to_string_lossy()
            .trim_start_matches(r"\\?\")
            .to_string();
        let mut folders = state.db.folders();
        if !folders.iter().any(|f| f.eq_ignore_ascii_case(&path)) {
            folders.push(path.clone());
            state.db.set("folders", &json!(folders))?;
        }
        library::watch(state.db.clone(), state.library.clone(), app.clone());
        library::start_scan(state.db.clone(), state.library.clone(), app);
        return Ok(Some(path));
    }
    Ok(None)
}
#[tauri::command]
async fn remove_folder(
    folder: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<()> {
    blocking(&state.db, move |db| -> Result<()> {
        let mut folders = db.folders();
        folders.retain(|f| f != &folder);
        db.set("folders", &json!(folders))?;
        for t in db.tracks()?.iter().filter(|t| t.folder == folder) {
            db.missing(&t.id, true)?;
        }
        Ok(())
    })
    .await??;
    library::watch(state.db.clone(), state.library.clone(), app.clone());
    let _ = app.emit("library-changed", ());
    Ok(())
}
#[tauri::command]
async fn spotify_connect(client_id: String, state: tauri::State<'_, AppState>) -> Result<()> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || spotify::connect(&db, &client_id))
        .await
        .map_err(err)?
}
#[tauri::command]
async fn spotify_disconnect(state: tauri::State<'_, AppState>) -> Result<()> {
    blocking(&state.db, spotify::disconnect).await?
}
#[tauri::command]
async fn spotify_playlists(state: tauri::State<'_, AppState>) -> Result<Value> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || spotify::playlists(&db))
        .await
        .map_err(err)?
}
#[tauri::command]
async fn spotify_liked(state: tauri::State<'_, AppState>) -> Result<Value> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || spotify::liked(&db))
        .await
        .map_err(err)?
}
#[tauri::command]
async fn spotify_top(source: String, state: tauri::State<'_, AppState>) -> Result<Value> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || spotify::top(&db, &source))
        .await
        .map_err(err)?
}
#[tauri::command]
async fn spotify_revision(source: String, state: tauri::State<'_, AppState>) -> Result<Value> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || spotify::revision(&db, &source))
        .await
        .map_err(err)?
}
#[tauri::command]
async fn collection(id: String, state: tauri::State<'_, AppState>) -> Result<Value> {
    blocking(&state.db, move |db| {
        Ok(db
            .collections()?
            .into_iter()
            .find(|c| c["id"].as_str() == Some(id.as_str()))
            .unwrap_or(Value::Null))
    })
    .await?
}
#[tauri::command]
async fn spotify_playlist(url: String, state: tauri::State<'_, AppState>) -> Result<Value> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || spotify::playlist(&db, &url))
        .await
        .map_err(err)?
}
#[tauri::command]
fn open_link(url: String) -> Result<()> {
    let u = url::Url::parse(&url).map_err(err)?;
    if u.scheme() != "https"
        || !matches!(
            u.host_str(),
            Some(
                "developer.spotify.com"
                    | "open.spotify.com"
                    | "github.com"
                    | "en.wikipedia.org"
                    | "commons.wikimedia.org"
                    | "www.last.fm"
                    | "discord.com"
            )
        )
    {
        return Err("This link is not supported".into());
    }
    // Open exactly the address that was checked.
    open::that(u.as_str()).map_err(err)
}
/// Listening history between two times (Unix ms), as [track ID, time played] pairs.
#[tauri::command]
async fn listening_history(from: i64, to: i64, state: tauri::State<'_, AppState>) -> Result<Value> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || Ok(json!(db.history(from, to)?)))
        .await
        .map_err(err)?
}
/// An artist's photo and bio (see artists.rs); may look it up when enabled in Settings.
#[tauri::command]
async fn artist_info(name: String, state: tauri::State<'_, AppState>) -> Result<Value> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || artists::info(&db, &name))
        .await
        .map_err(err)?
}
/// Artist photos that are already saved, for the Artists page.
#[tauri::command]
async fn artist_photos(
    names: Vec<String>,
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Map<String, Value>> {
    blocking(&state.db, move |db| artists::photos(db, &names)).await?
}
/// Last.fm scrobbling: status, the user's API account, and signing in or out.
#[tauri::command]
async fn lastfm_status(state: tauri::State<'_, AppState>) -> Result<Value> {
    blocking(&state.db, scrobble::status).await
}
#[tauri::command]
async fn lastfm_setup(
    key: String,
    secret: String,
    state: tauri::State<'_, AppState>,
) -> Result<Value> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || scrobble::setup(&db, &key, &secret))
        .await
        .map_err(err)?
}
#[tauri::command]
async fn lastfm_connect(state: tauri::State<'_, AppState>) -> Result<()> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || scrobble::connect(db))
        .await
        .map_err(err)?
}
#[tauri::command]
async fn lastfm_disconnect(state: tauri::State<'_, AppState>) -> Result<()> {
    blocking(&state.db, scrobble::disconnect).await?
}
#[tauri::command]
async fn lastfm_forget(state: tauri::State<'_, AppState>) -> Result<()> {
    blocking(&state.db, scrobble::forget).await?
}
/// Discord's "Listening to" status: whether it is connected, and the user's application ID.
#[tauri::command]
async fn discord_status(state: tauri::State<'_, AppState>) -> Result<Value> {
    blocking(&state.db, discord::status).await
}
#[tauri::command]
async fn discord_setup(id: String, state: tauri::State<'_, AppState>) -> Result<Value> {
    blocking(&state.db, move |db| discord::setup(db, &id)).await?
}
/// Output devices Windows offers, for Settings.
#[tauri::command]
async fn audio_devices() -> Result<Value> {
    tauri::async_runtime::spawn_blocking(|| {
        let (devices, default) = audio::output_devices();
        json!({ "devices": devices, "default": default })
    })
    .await
    .map_err(err)
}
/// Lyrics for a song (see lyrics.rs). May ask LRCLIB when that is enabled in Settings.
#[tauri::command]
async fn song_lyrics(id: String, state: tauri::State<'_, AppState>) -> Result<Value> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || lyrics::find(&db, &db.track(&id)?))
        .await
        .map_err(err)?
}
/// Forgets songs whose files are gone. Returns how many were removed.
#[tauri::command]
async fn remove_missing(state: tauri::State<'_, AppState>) -> Result<usize> {
    let (db, engine) = (state.db.clone(), state.engine.clone());
    tauri::async_runtime::spawn_blocking(move || {
        let ids = db.remove_missing()?;
        engine.forget(&ids.iter().cloned().collect());
        Ok(ids.len())
    })
    .await
    .map_err(err)?
}
/// Opens File Explorer with the song selected. Only paths of indexed tracks are accepted.
#[tauri::command]
fn reveal_track(id: String, state: tauri::State<'_, AppState>) -> Result<()> {
    let path = std::path::PathBuf::from(state.db.track(&id)?.path);
    if !path.is_file() {
        return match path.parent().filter(|p| p.is_dir()) {
            Some(folder) => open::that(folder).map_err(err),
            None => Err("This song's folder is unavailable. Reconnect its drive or rescan.".into()),
        };
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // Windows paths cannot contain quotes, so quoting the whole path is safe.
        std::process::Command::new("explorer")
            .raw_arg(format!("/select,\"{}\"", path.display()))
            .spawn()
            .map(|_| ())
            .map_err(err)
    }
    #[cfg(not(windows))]
    open::that(path.parent().unwrap_or(&path)).map_err(err)
}
#[tauri::command]
async fn mini_player(app: tauri::AppHandle) -> Result<()> {
    if let Some(w) = app.get_webview_window("mini") {
        w.show().map_err(err)?;
        w.set_focus().map_err(err)?;
    } else {
        tauri::WebviewWindowBuilder::new(
            &app,
            "mini",
            tauri::WebviewUrl::App("index.html?mini".into()),
        )
        .title("Slate Music · Mini player")
        .inner_size(420., 226.)
        .min_inner_size(360., 226.)
        .decorations(false)
        .always_on_top(true)
        .resizable(false)
        .background_color(tauri::window::Color(10, 10, 11, 255))
        .build()
        .map_err(err)?;
    }
    Ok(())
}
#[tauri::command]
async fn show_main(app: tauri::AppHandle) -> Result<()> {
    if let Some(w) = app.get_webview_window("main") {
        w.show().map_err(err)?;
        w.unminimize().map_err(err)?;
        w.set_focus().map_err(err)?;
    }
    if let Some(w) = app.get_webview_window("mini") {
        w.close().map_err(err)?;
    }
    Ok(())
}
#[tauri::command]
async fn export_backup(state: tauri::State<'_, AppState>) -> Result<bool> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move||{let path=rfd::FileDialog::new().set_title("Export Slate Music backup").set_file_name("slate-music-backup.json").add_filter("JSON",&["json"]).save_file();
 if let Some(path)=path{let favorites:Vec<String>=db.tracks()?.into_iter().filter(|t|t.favorite).map(|t|t.id).collect();let data=json!({"version":1,"collections":db.collections()?,"favorites":favorites,"settings":db.get("settings"),"session":db.get("session")});std::fs::write(path,serde_json::to_vec_pretty(&data).map_err(err)?).map_err(err)?;Ok(true)}else{Ok(false)}}).await.map_err(err)?
}
pub fn run() {
    desktop::initialize_identity();
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            desktop::show_main(app);
        }))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::all()
                        & !tauri_plugin_window_state::StateFlags::VISIBLE,
                )
                .with_denylist(&["mini"])
                .build(),
        );
    builder
        .register_uri_scheme_protocol("art", |context, request| {
            // "<hash>" is the 640 px cover; "<hash>-xl" the large copy, falling back to 640 px.
            let path = request.uri().path().trim_start_matches('/');
            let (id, large) = path
                .strip_suffix("-xl")
                .map_or((path, false), |id| (id, true));
            let app = context.app_handle();
            let state = app.state::<AppState>();
            let dir = state.db.directory.join("artwork");
            let valid = id.len() == 64 && id.chars().all(|c| c.is_ascii_hexdigit());
            let exact = valid
                .then(|| {
                    let name = if large {
                        format!("{id}-xl.jpg")
                    } else {
                        format!("{id}.jpg")
                    };
                    std::fs::read(dir.join(name)).ok()
                })
                .flatten();
            // A large cover not made yet falls back to the 640 px one.
            let fallback = (valid && large && exact.is_none())
                .then(|| std::fs::read(dir.join(format!("{id}.jpg"))).ok())
                .flatten();
            // Only the exact file is cached for good: a stand-in or a miss is asked for again,
            // so a large cover (or artwork) made later appears.
            let cache = if exact.is_some() {
                "max-age=31536000, immutable"
            } else {
                "no-cache"
            };
            let data = exact.or(fallback);
            tauri::http::Response::builder()
                .status(if data.is_some() { 200 } else { 404 })
                .header("Content-Type", "image/jpeg")
                .header("Cache-Control", cache)
                .header("Access-Control-Allow-Origin", "*")
                .body(data.unwrap_or_default())
                .unwrap()
        })
        .setup(|app| {
            let directory = std::env::var_os("SLATE_MUSIC_DATA_DIR")
                .map(PathBuf::from)
                .unwrap_or(app.path().app_data_dir()?);
            let db = Arc::new(Database::open(&directory).map_err(std::io::Error::other)?);
            lyrics::on_by_default(&db).map_err(std::io::Error::other)?;
            if db.folders().is_empty() {
                if let Some(path) = std::env::var_os("SLATE_MUSIC_LIBRARY") {
                    let path = PathBuf::from(path);
                    if path.is_dir() {
                        db.set("folders", &json!([path.to_string_lossy()]))
                            .map_err(std::io::Error::other)?;
                    }
                }
            }
            let library = Arc::new(library::Library::new());
            let engine = audio::Engine::new(db.clone());
            // The window handle is only used by Windows (media controls, taskbar buttons); other
            // platforms build too, so the native tests can run anywhere.
            #[cfg(windows)]
            let hwnd = app.get_webview_window("main").unwrap().hwnd()?.0 as usize;
            #[cfg(not(windows))]
            let hwnd = 0usize;
            app.manage(AppState {
                db: db.clone(),
                library: library.clone(),
                engine: engine.clone(),
            });
            desktop::setup(app.handle())?;
            #[cfg(windows)]
            taskbar::setup(app.handle(), hwnd);
            engine.start(app.handle().clone(), hwnd);
            scrobble::start(db.clone(), engine.clone());
            discord::start(db.clone(), engine.clone());
            library::watch(db.clone(), library.clone(), app.handle().clone());
            library::start_scan(db, library, app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            quit_app,
            snapshot,
            playback,
            favorite,
            favorite_many,
            save_collection,
            delete_collection,
            settings,
            rescan,
            add_folder,
            music_folder,
            remove_folder,
            spotify_connect,
            spotify_disconnect,
            spotify_playlists,
            spotify_playlist,
            spotify_liked,
            spotify_top,
            spotify_revision,
            collection,
            reveal_track,
            remove_missing,
            song_lyrics,
            audio_devices,
            listening_history,
            artist_info,
            artist_photos,
            lastfm_status,
            lastfm_setup,
            lastfm_connect,
            lastfm_disconnect,
            lastfm_forget,
            discord_status,
            discord_setup,
            open_link,
            mini_player,
            show_main,
            export_backup,
            verify_update_fixture
        ])
        .build(tauri::generate_context!())
        .expect("Slate Music could not start")
        .run(|app, event| {
            if let tauri::RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::Destroyed,
                ..
            } = &event
            {
                if label == "main" {
                    app.exit(0);
                }
            }
            if let tauri::RunEvent::Exit = event {
                let state = app.state::<AppState>();
                state.engine.save();
                state.engine.render.lock().unwrap().stopping = true;
            }
        });
}
