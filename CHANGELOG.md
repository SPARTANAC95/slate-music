# Changelog

## 1.0.3 — unreleased

- Import Spotify playlists instead of albums. Pick from your own playlists or paste a playlist link, then update an imported playlist from Spotify later without losing songs you already matched. Uses Spotify's 2026 playlist API; earlier connections need one Reconnect for playlist access.
- Use the album name to choose between an album cut and a compilation copy of the same song.
- Right-click a song for Play next, Add to queue, Add to playlist, Go to album or artist, Favorite and Show in File Explorer; right-click an album to play or queue it. The browser's own context menu no longer appears.
- Add Play next, Clear up next (keeps the current song playing) and Save queue as playlist. Albums are added to the queue in one step.
- Add a sleep timer (15 minutes to 1½ hours, or end of the current song).
- Back returns to the previous page and its scroll position; the mouse back button and Alt+← work too.
- Keyboard shortcuts keep working after using the volume or seek slider or the sort menu. Mute restores the previous volume. Double-clicking a song plays it once.
- Playback messages can be dismissed and clear once a later action succeeds. The playing song's queue remove button is disabled instead of failing.
- Adding a song that is already in a playlist no longer duplicates it.
- Song lists are no longer re-sorted several times a second during playback, and the Artists page is computed once per library change.
- Show a system tray icon with playback controls and keep Slate Music grouped correctly on the taskbar.

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
