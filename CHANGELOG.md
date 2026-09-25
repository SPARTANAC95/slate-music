# Changelog

## 1.0.2 — 2026-09-26

- Search within the queue while keeping play, move and remove actions attached to the correct entry. Repeated songs retain their individual positions and only the active occurrence is highlighted.
- Repair restored queue cursors, select a paused replacement when removing the restored current entry, and enable playback after adding to an empty queue.
- Keep the current listening session intact when a replacement file cannot be opened. Correct queue positions when a missing preload is skipped at a repeat boundary.
- Limit crossfade overlap for very short following tracks.
- Retain rescan requests that arrive during active indexing and speed up unchanged-file lookup.
- Require review when Spotify and local files identify different remasters. Show unavailable saved matches as missing while retaining their identity for returning files.
- Make Recently played sorting work, with listening order as its default.
- Retain an already downloaded, verified update across later checks, serialize update operations, and allow failed downloads or installations to be retried.
- Add the public product website, illustrated README, original demonstration artwork and contributor/issue guides.

## 1.0.1 — 2026-09-25

- Use stable hyphenated release asset names so updater download URLs match GitHub's stored filenames.
- Retain the same updater signing key and persistent data format.

## 1.0.0 — 2026-09-25

First Windows release of Slate Music.

- Read-only recursive music indexing, embedded artwork caching and incremental folder watching.
- Offline songs, albums, artists, favorites, history, playlists, saved virtual albums and editable queue.
- Native playback with seeking, shuffle, repeat, tested FLAC gapless transitions and optional crossfade.
- Mini-player, keyboard shortcuts and Windows system media controls.
- SQLite persistence and paused session restoration.
- Spotify album metadata import with PKCE sign-in, conservative local matching and manual correction.
- Signed updater artifacts, automatic checks/downloads and installation after user confirmation.

Known limits and verification coverage are recorded in `docs/VALIDATION.md`.
