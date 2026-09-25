mod audio;
mod db;
mod library;
mod spotify;
use db::{err, Database, Result};
use serde_json::{json, Value};
use std::{path::PathBuf, sync::Arc};
use tauri::{Emitter, Manager};

struct AppState {
    db: Arc<Database>,
    library: Arc<library::Library>,
    engine: Arc<audio::Engine>,
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
    tauri::async_runtime::spawn_blocking(move||{let mut data=db.snapshot()?;data["scan"]=serde_json::to_value(scan).map_err(err)?;data["playback"]=serde_json::to_value(playback).map_err(err)?;data["spotify"]=json!({"connected":spotify::connected(&db),"clientId":db.get("spotify_client_id"),"redirectUri":spotify::REDIRECT});Ok(data)}).await.map_err(err)?
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
#[tauri::command]
async fn favorite(id: String, value: bool, state: tauri::State<'_, AppState>) -> Result<()> {
    state.db.favorite(&id, value)
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
async fn settings(value: Value, state: tauri::State<'_, AppState>) -> Result<()> {
    if !value.is_object() {
        return Err("Invalid settings".into());
    }
    state.db.set("settings", &value)
}
#[tauri::command]
fn rescan(app: tauri::AppHandle, state: tauri::State<'_, AppState>) {
    library::start_scan(state.db.clone(), state.library.clone(), app);
}
#[tauri::command]
async fn add_folder(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<Option<String>> {
    let selected = tauri::async_runtime::spawn_blocking(|| {
        rfd::FileDialog::new()
            .set_title("Choose your music folder")
            .pick_folder()
    })
    .await
    .map_err(err)?;
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
fn remove_folder(
    folder: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<()> {
    let mut folders = state.db.folders();
    folders.retain(|f| f != &folder);
    state.db.set("folders", &json!(folders))?;
    for t in state.db.tracks()?.iter().filter(|t| t.folder == folder) {
        state.db.missing(&t.id, true)?;
    }
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
fn spotify_disconnect(state: tauri::State<'_, AppState>) -> Result<()> {
    spotify::disconnect(&state.db)
}
#[tauri::command]
async fn spotify_album(url: String, state: tauri::State<'_, AppState>) -> Result<Value> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || spotify::album(&db, &url))
        .await
        .map_err(err)?
}
#[tauri::command]
fn open_link(url: String) -> Result<()> {
    let u = url::Url::parse(&url).map_err(err)?;
    if u.scheme() != "https"
        || !matches!(
            u.host_str(),
            Some("developer.spotify.com" | "open.spotify.com" | "github.com")
        )
    {
        return Err("This link is not supported".into());
    }
    open::that(url).map_err(err)
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
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
            }
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
            let id = request.uri().path().trim_start_matches('/');
            let app = context.app_handle();
            let state = app.state::<AppState>();
            let data = if id.len() == 64 && id.chars().all(|c| c.is_ascii_hexdigit()) {
                std::fs::read(state.db.directory.join("artwork").join(format!("{id}.jpg"))).ok()
            } else {
                None
            };
            tauri::http::Response::builder()
                .status(if data.is_some() { 200 } else { 404 })
                .header("Content-Type", "image/jpeg")
                .header("Cache-Control", "max-age=31536000, immutable")
                .header("Access-Control-Allow-Origin", "*")
                .body(data.unwrap_or_default())
                .unwrap()
        })
        .setup(|app| {
            let directory = std::env::var_os("SLATE_MUSIC_DATA_DIR")
                .map(PathBuf::from)
                .unwrap_or(app.path().app_data_dir()?);
            let db = Arc::new(Database::open(&directory).map_err(std::io::Error::other)?);
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
            let window = app.get_webview_window("main").unwrap();
            let hwnd = window.hwnd()?.0 as usize;
            app.manage(AppState {
                db: db.clone(),
                library: library.clone(),
                engine: engine.clone(),
            });
            engine.start(app.handle().clone(), hwnd);
            library::watch(db.clone(), library.clone(), app.handle().clone());
            library::start_scan(db, library, app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            quit_app,
            snapshot,
            playback,
            favorite,
            save_collection,
            delete_collection,
            settings,
            rescan,
            add_folder,
            remove_folder,
            spotify_connect,
            spotify_disconnect,
            spotify_album,
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
