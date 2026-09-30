use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager,
};

const APP_ID: &str = "com.spartanac95.slate-music";

pub fn initialize_identity() {
    #[cfg(windows)]
    {
        let id: Vec<u16> = APP_ID.encode_utf16().chain(Some(0)).collect();
        // Set before creating windows so launches from another app get our taskbar group.
        let result = unsafe {
            windows_sys::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID(id.as_ptr())
        };
        if result < 0 {
            eprintln!("Could not register Slate Music's Windows application identity: {result}");
        }
    }
}

pub fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_skip_taskbar(false);
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

pub fn setup(app: &AppHandle) -> tauri::Result<()> {
    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or_else(|| tauri::Error::AssetNotFound("Application icon".into()))?;
    if let Some(window) = app.get_webview_window("main") {
        window.set_icon(icon.clone())?;
        window.set_skip_taskbar(false)?;
    }
    let open = MenuItem::with_id(app, "tray-open", "Open Slate Music", true, None::<&str>)?;
    let toggle = MenuItem::with_id(app, "tray-toggle", "Play / pause", true, None::<&str>)?;
    let previous = MenuItem::with_id(app, "tray-previous", "Previous track", true, None::<&str>)?;
    let next = MenuItem::with_id(app, "tray-next", "Next track", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "tray-quit", "Quit Slate Music", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &toggle, &previous, &next, &separator, &quit])?;
    TrayIconBuilder::with_id(APP_ID)
        .icon(icon)
        .tooltip("Slate Music")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                show_main(tray.app_handle());
            }
        })
        .on_menu_event(|app, event| match event.id.as_ref() {
            "tray-open" => show_main(app),
            "tray-quit" => {
                show_main(app);
                // Keep the existing close flow, including a pending-update confirmation.
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.close();
                }
            }
            id @ ("tray-toggle" | "tray-previous" | "tray-next") => {
                let action = match id {
                    "tray-previous" => "previous",
                    "tray-next" => "next",
                    _ => "toggle",
                };
                let engine = app.state::<crate::AppState>().engine.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    let _ = engine.command(action, serde_json::Value::Null);
                });
            }
            _ => {}
        })
        .build(app)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn desktop_identity_matches_installer_identity() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(super::APP_ID, config["identifier"].as_str().unwrap());
    }
}
