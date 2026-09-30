//! Previous, play/pause, next and favorite buttons in the window's taskbar preview, shown when
//! the pointer rests on Slate Music's taskbar button (like other Windows music players).
use crate::AppState;
use std::{
    cell::RefCell,
    sync::OnceLock,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager};
use windows::{
    core::{w, BOOL},
    Win32::{
        Foundation::{HWND, LPARAM, LRESULT, WPARAM},
        Graphics::Gdi::{
            CreateBitmap, CreateDIBSection, DeleteObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB,
            DIB_RGB_COLORS,
        },
        System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER},
        UI::{
            Shell::{
                DefSubclassProc, ITaskbarList3, SetWindowSubclass, TaskbarList, THBF_DISABLED,
                THBF_ENABLED, THBN_CLICKED, THB_FLAGS, THB_ICON, THB_TOOLTIP, THUMBBUTTON,
            },
            WindowsAndMessaging::{
                CreateIconIndirect, RegisterWindowMessageW, HICON, ICONINFO, WM_COMMAND,
            },
        },
    },
};

const PREVIOUS: u32 = 1;
const TOGGLE: u32 = 2;
const NEXT: u32 = 3;
const FAVORITE: u32 = 4;

/// What the buttons show: the playing song and whether it is a favorite.
#[derive(Clone, Copy, PartialEq, Eq, Default, Debug)]
pub struct State {
    pub has_song: bool,
    pub playing: bool,
    pub favorite: bool,
}
struct Taskbar {
    list: ITaskbarList3,
    hwnd: HWND,
    icons: [HICON; 6],
}
thread_local! {
    // Lives on the window's own (main) thread, where the taskbar COM object must be used.
    static TASKBAR: RefCell<Option<Taskbar>> = const { RefCell::new(None) };
    static STATE: RefCell<State> = RefCell::new(State::default());
}
static APP: OnceLock<AppHandle> = OnceLock::new();
static CREATED: OnceLock<u32> = OnceLock::new();

/// Call on the main thread once the main window exists.
pub fn setup(app: &AppHandle, hwnd: usize) {
    let _ = APP.set(app.clone());
    let hwnd = HWND(hwnd as *mut _);
    unsafe {
        let _ = CREATED.set(RegisterWindowMessageW(w!("TaskbarButtonCreated")));
        let _ = SetWindowSubclass(hwnd, Some(subclass), 0x5147_4d42, 0);
    }
    // The taskbar button may already exist; otherwise "TaskbarButtonCreated" arrives later.
    add_buttons(hwnd);
    watch(app.clone());
}

fn add_buttons(hwnd: HWND) {
    let Ok(list) =
        (unsafe { CoCreateInstance::<_, ITaskbarList3>(&TaskbarList, None, CLSCTX_INPROC_SERVER) })
    else {
        return;
    };
    if unsafe { list.HrInit() }.is_err() {
        return;
    }
    let icons = TASKBAR
        .with(|t| t.borrow().as_ref().map(|t| t.icons))
        .unwrap_or_else(icons);
    let state = STATE.with(|s| *s.borrow());
    match unsafe { list.ThumbBarAddButtons(hwnd, &buttons(state, &icons)) } {
        Ok(()) => {
            eprintln!("Slate Music: taskbar preview buttons ready");
            TASKBAR.with(|t| *t.borrow_mut() = Some(Taskbar { list, hwnd, icons }));
        }
        // Normal before the taskbar button exists; "TaskbarButtonCreated" retries.
        Err(e) => eprintln!("Slate Music: taskbar preview buttons not added yet ({e})"),
    }
}

/// Shows the latest state; called on the main thread.
fn show(state: State) {
    STATE.with(|s| *s.borrow_mut() = state);
    TASKBAR.with(|t| {
        if let Some(t) = t.borrow().as_ref() {
            let _ = unsafe {
                t.list
                    .ThumbBarUpdateButtons(t.hwnd, &buttons(state, &t.icons))
            };
        }
    });
}

fn buttons(state: State, icons: &[HICON; 6]) -> [THUMBBUTTON; 4] {
    let [previous, play, pause, next, heart, heart_filled] = *icons;
    let button = |id: u32, icon: HICON, tip: &str, enabled: bool| {
        let mut sz_tip = [0u16; 260];
        for (slot, unit) in sz_tip.iter_mut().zip(tip.encode_utf16().take(259)) {
            *slot = unit;
        }
        THUMBBUTTON {
            dwMask: THB_ICON | THB_TOOLTIP | THB_FLAGS,
            iId: id,
            hIcon: icon,
            szTip: sz_tip,
            dwFlags: if enabled { THBF_ENABLED } else { THBF_DISABLED },
            ..Default::default()
        }
    };
    let on = state.has_song;
    [
        button(PREVIOUS, previous, "Previous", on),
        if state.playing {
            button(TOGGLE, pause, "Pause", on)
        } else {
            button(TOGGLE, play, "Play", on)
        },
        button(NEXT, next, "Next", on),
        if state.favorite {
            button(FAVORITE, heart_filled, "Remove from favorites", on)
        } else {
            button(FAVORITE, heart, "Add to favorites", on)
        },
    ]
}

unsafe extern "system" fn subclass(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _id: usize,
    _data: usize,
) -> LRESULT {
    if Some(&msg) == CREATED.get() {
        add_buttons(hwnd);
    } else if msg == WM_COMMAND && ((wparam.0 >> 16) & 0xffff) as u32 == THBN_CLICKED {
        let id = (wparam.0 & 0xffff) as u32;
        if let Some(app) = APP.get().cloned() {
            // Playback commands can take a moment (decoding); keep the window responsive.
            std::thread::spawn(move || click(&app, id));
        }
        return LRESULT(0);
    }
    unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) }
}

fn click(app: &AppHandle, id: u32) {
    let state = app.state::<AppState>();
    let action = match id {
        PREVIOUS => "previous",
        TOGGLE => "toggle",
        NEXT => "next",
        FAVORITE => {
            if let Some(current) = state.engine.snapshot().current_id {
                if let Ok(track) = state.db.track(&current) {
                    if state.db.favorite(&current, !track.favorite).is_ok() {
                        let _ = app.emit("library-changed", ());
                    }
                }
            }
            return;
        }
        _ => return,
    };
    let _ = state.engine.command(action, serde_json::Value::Null);
}

/// Follows playback and favorites, updating the buttons when something changes.
fn watch(app: AppHandle) {
    std::thread::spawn(move || {
        let mut shown = None;
        let mut last_id: Option<String> = None;
        let mut favorite = false;
        let mut checked = Instant::now();
        loop {
            std::thread::sleep(Duration::from_millis(300));
            let Some(state) = app.try_state::<AppState>() else {
                continue;
            };
            let s = state.engine.snapshot();
            // Favorites can change anywhere in the app; re-read about once a second.
            if s.current_id != last_id || checked.elapsed() > Duration::from_secs(1) {
                favorite = s
                    .current_id
                    .as_deref()
                    .and_then(|id| state.db.track(id).ok())
                    .is_some_and(|t| t.favorite);
                last_id = s.current_id.clone();
                checked = Instant::now();
            }
            let next = State {
                has_song: s.current_id.is_some(),
                playing: s.playing,
                favorite,
            };
            if shown != Some(next) {
                shown = Some(next);
                let _ = app.run_on_main_thread(move || show(next));
            }
        }
    });
}

const SIZE: i32 = 32;
fn icons() -> [HICON; 6] {
    glyphs().map(|pixels| icon(SIZE, &pixels))
}
/// Draws the six button glyphs (previous, play, pause, next, heart, filled heart) as white
/// shapes with smooth edges, in premultiplied BGRA.
fn glyphs() -> [Vec<u8>; 6] {
    fn inside_triangle(x: f32, y: f32, a: (f32, f32), b: (f32, f32), c: (f32, f32)) -> bool {
        let side = |p: (f32, f32), q: (f32, f32)| (q.0 - p.0) * (y - p.1) - (q.1 - p.1) * (x - p.0);
        let (d1, d2, d3) = (side(a, b), side(b, c), side(c, a));
        !((d1 < 0. || d2 < 0. || d3 < 0.) && (d1 > 0. || d2 > 0. || d3 > 0.))
    }
    let bar =
        |x: f32, y: f32, left: f32, right: f32| x >= left && x <= right && (7. ..=25.).contains(&y);
    let heart = |x: f32, y: f32, scale: f32| {
        // The classic implicit heart curve, centred and flipped for screen coordinates.
        let (u, v) = ((x - 16.) / (10.5 * scale), -(y - 17.) / (10.5 * scale));
        (u * u + v * v - 1.).powi(3) - u * u * v * v * v <= 0.
    };
    let shapes: [&dyn Fn(f32, f32) -> bool; 6] = [
        &|x, y| bar(x, y, 7., 10.) || inside_triangle(x, y, (25., 7.), (25., 25.), (11., 16.)),
        &|x, y| inside_triangle(x, y, (10., 6.), (10., 26.), (26., 16.)),
        &|x, y| bar(x, y, 9., 14.) || bar(x, y, 18., 23.),
        &|x, y| bar(x, y, 22., 25.) || inside_triangle(x, y, (7., 7.), (7., 25.), (21., 16.)),
        &|x, y| heart(x, y, 1.) && !heart(x, y, 0.78),
        &|x, y| heart(x, y, 1.),
    ];
    shapes.map(|shape| {
        let mut pixels = vec![0u8; (SIZE * SIZE * 4) as usize];
        for py in 0..SIZE {
            for px in 0..SIZE {
                // 4×4 samples per pixel give anti-aliased edges.
                let hits = (0..16)
                    .filter(|s| {
                        let (sx, sy) = ((s % 4) as f32 + 0.5, (s / 4) as f32 + 0.5);
                        shape(px as f32 + sx / 4., py as f32 + sy / 4.)
                    })
                    .count() as u32;
                let alpha = (hits * 255 / 16) as u8;
                let i = ((py * SIZE + px) * 4) as usize;
                // Premultiplied white: BGRA all equal to alpha.
                pixels[i..i + 4].copy_from_slice(&[alpha, alpha, alpha, alpha]);
            }
        }
        pixels
    })
}

fn icon(size: i32, bgra: &[u8]) -> HICON {
    unsafe {
        let header = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: size,
                biHeight: -size, // top-down rows
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut bits = std::ptr::null_mut();
        let Ok(color) = CreateDIBSection(None, &header, DIB_RGB_COLORS, &mut bits, None, 0) else {
            return HICON::default();
        };
        std::ptr::copy_nonoverlapping(bgra.as_ptr(), bits as *mut u8, bgra.len());
        let mask = CreateBitmap(size, size, 1, 1, None);
        let info = ICONINFO {
            fIcon: BOOL(1),
            hbmMask: mask,
            hbmColor: color,
            ..Default::default()
        };
        let icon = CreateIconIndirect(&info).unwrap_or_default();
        // The icon keeps its own copies of both bitmaps.
        let _ = DeleteObject(color.into());
        let _ = DeleteObject(mask.into());
        icon
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    /// Saves the glyphs as PNG files for a visual check: set SLATE_GLYPHS to a folder.
    #[test]
    #[ignore = "writes images for manual review"]
    fn save_glyphs_for_review() {
        let dir = std::path::PathBuf::from(std::env::var("SLATE_GLYPHS").unwrap());
        for (name, bgra) in ["previous", "play", "pause", "next", "heart", "heart-filled"]
            .iter()
            .zip(glyphs())
        {
            let rgba: Vec<u8> = bgra.chunks(4).flat_map(|p| [255, 255, 255, p[3]]).collect();
            image::RgbaImage::from_raw(SIZE as u32, SIZE as u32, rgba)
                .unwrap()
                .save(dir.join(format!("{name}.png")))
                .unwrap();
        }
    }
    #[test]
    fn buttons_follow_playback_and_favorite() {
        let icons = [HICON::default(); 6];
        let idle = buttons(State::default(), &icons);
        assert!(idle.iter().all(|b| b.dwFlags == THBF_DISABLED));
        let playing = buttons(
            State {
                has_song: true,
                playing: true,
                favorite: true,
            },
            &icons,
        );
        assert!(playing.iter().all(|b| b.dwFlags == THBF_ENABLED));
        let tip = |b: &THUMBBUTTON| {
            String::from_utf16_lossy(&b.szTip)
                .trim_end_matches('\0')
                .to_string()
        };
        assert_eq!(tip(&playing[1]), "Pause");
        assert_eq!(tip(&playing[3]), "Remove from favorites");
        let paused = buttons(
            State {
                has_song: true,
                playing: false,
                favorite: false,
            },
            &icons,
        );
        assert_eq!(tip(&paused[1]), "Play");
        assert_eq!(tip(&paused[3]), "Add to favorites");
        assert_eq!(paused.map(|b| b.iId), [PREVIOUS, TOGGLE, NEXT, FAVORITE]);
    }
}
