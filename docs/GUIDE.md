# Slate Music user guide

A Windows desktop player for your own music. Local files, native audio, an offline library, and a quiet interface inspired by [Slate](https://github.com/SPARTANAC95/slate).

## Install

Download the Windows x64 installer from [Releases](https://github.com/SPARTANAC95/slate-music/releases/latest). Run it, then open **Slate Music** from Start. Choose your music folder on first launch. The player reads your files; it never retags, renames, moves or deletes them.

Windows 10/11 x64 with WebView2 and a working audio output are required. WebView2 is normally already present; installing the runtime on a new PC can require internet. Once installed, library management and playback work offline. The installer has a cryptographically signed updater artifact, but does not have a Windows Authenticode publisher certificate. Windows may show an unknown-publisher warning.

## Listen and organize

- Home, Songs, Albums, Artists, Favorites, Recently Played, Playlists, saved virtual albums and Queue.
- Search titles, artists and albums; sort and filter songs, including unavailable files and potential duplicates. Album order respects disc and track numbers.
- Add songs to a playlist using its folder button. Open a playlist and choose **Edit playlist** to rename, reorder or remove entries. This only changes Slate Music's database.
- Double-click a song or use its play button. Reorder upcoming songs in Queue. Play/pause, previous/next, seeking, volume, shuffle and repeat work with the native audio engine.
- Use the mini-player or Windows media controls. The app restores its queue and position paused, including after an update.
- Gapless playback is enabled with crossfade off. Choose an optional 2–12 second crossfade in Settings.
- Settings controls watched folders, rescanning, Spotify setup and updates. Disconnected drives retain their entries as unavailable; reconnect and rescan to restore them.

| Shortcut | Action |
|---|---|
| Space | Play / pause |
| Left / Right | Seek 5 seconds |
| Ctrl + Left / Right | Previous / next |
| Ctrl + K | Search |
| Ctrl + M | Mini-player |
| Escape | Close dialog |

Shortcuts do not intercept typing in form fields. Standard media keys are routed through Windows system media controls.

### Audio support

Tested decoding: FLAC, MP3, WAV, AAC/M4A, ALAC, Ogg Vorbis and AIFF. Seeking was tested for the container formats above; raw ADTS AAC seeking depends on its available seek index. Opus, WMA, APE, DSD and protected files are not supported in this version.

The engine streams decoded audio through one 48 kHz stereo mixer and the Windows default output device. This provides gapless transitions and crossfade; it is not a bit-perfect or exclusive-mode player. A disconnected audio device pauses playback; the engine attempts to reconnect without starting audio unexpectedly.

## Spotify album import

This feature retrieves metadata and matches music you already own. It does not stream Spotify audio or download replacements.

1. Create an app in the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard). Select Web API access.
2. Register the exact redirect URI `http://127.0.0.1:43829/callback`.
3. Add your account under Users Management if required by Development Mode.
4. Paste the **Client ID** in Slate Music Settings and choose **Connect Spotify**. No client secret is used. Sign-in opens your browser.
5. Choose **Import Spotify album**, paste an `open.spotify.com/album/...` URL, and retrieve the complete ordered track list.
6. Review available, uncertain and missing matches. Correct uncertain tracks manually. Save as a virtual album or playlist.

Only confirmed, available local matches enter the queue. Missing tracks remain visible in a saved virtual album. Saved results work offline. Matching compares normalized title, artist, duration and version labels, with conservative handling of duplicate candidates, live recordings, remixes, edits and remasters.

As verified September 25, 2026, Spotify Development Mode requires an active Premium subscription for the app owner and permits up to five authorized users. Spotify controls API availability and quota; some accounts/apps may require further approval. See [quota modes](https://developer.spotify.com/documentation/web-api/concepts/quota-modes), [PKCE authorization](https://developer.spotify.com/documentation/web-api/tutorials/code-pkce-flow) and the [2026 migration guide](https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide). Rate limits and access errors are reported in the app. Live account sign-in requires your own Client ID; no credentials are bundled.

## Privacy and persistence

The SQLite database and artwork cache live in `%APPDATA%\com.spartanac95.slate-music`. The database stores library paths, metadata, favorites, playlists, play counts, history, settings and the paused listening session. SQLite migrations and WAL journaling protect normal restarts. Settings includes a JSON export of favorites and playlists; to back up the full profile, close the app and copy its data directory. Do not publish that directory.

Spotify tokens are encrypted with Windows DPAPI for your Windows account. The app has no analytics. Network access is used only for optional Spotify requests and update checks/downloads. Disable automatic updates in Settings for a fully offline setup. Music and private library data are not part of this repository or releases.

Updates are checked and downloaded automatically by default. The updater verifies both the artifact signature and signed version. It only installs after you confirm while paused or choose the install option on exit. Installation keeps your database, artwork and settings.

## Develop

Install Node.js 22+, the stable Rust toolchain, Microsoft C++ Build Tools, WebView2 and the [Tauri Windows prerequisites](https://v2.tauri.app/start/prerequisites/).

```powershell
npm ci
npm run dev:app
npm test
npm run test:rust
npm run build
```

The browser-only Vite page is not a simulated library; native commands require Tauri. For an isolated test profile, set `SLATE_MUSIC_DATA_DIR` before launch. Set `SLATE_MUSIC_LIBRARY` on a fresh profile to seed a folder without the first-launch picker. These are optional developer environment variables, not bundled personal paths.

See [architecture](ARCHITECTURE.md), [validation](VALIDATION.md), [release engineering](RELEASING.md) and [changelog](../CHANGELOG.md).

## Build and release

`npm run build:app` produces a per-user NSIS installer and updater signature. Set `TAURI_SIGNING_PRIVATE_KEY` to the signing key contents or a local file path, and optionally `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Never put either value in source control.

GitHub Actions checks every push and pull request. Version tags run tests, build and sign the Windows installer, and publish the manifest and checksums. The repository's encrypted Actions secrets hold the signing material. An update key is distinct from an Authenticode certificate.

## Credits

Tauri, React, TypeScript, SQLite/rusqlite, Rodio/Symphonia, Lofty, notify, Souvlaki, Inter and Lucide power the application. See their respective licenses in installed dependencies and [THIRD_PARTY.md](THIRD_PARTY.md). The original application icon and design study were generated for this project; the study is inspiration, not a screenshot of a working library. Slate was inspected as a design reference and was not modified.

MIT license.


