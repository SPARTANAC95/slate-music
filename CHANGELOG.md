# Changelog

## 1.1.0 — 2026-10-01

- **Now Playing:** a full-window view with a large, sharp cover, a backdrop blurred from the artwork, and synced lyrics that follow the song (click a line to jump to it), or the queue. Open it by clicking the song in the player bar or the cover in the listening panel, with the new button beside the volume, or with Ctrl+L; Esc closes it.
- **Lyrics** come from an .lrc file beside the song, lyrics stored in the file, or, when "Find lyrics online" is on, LRCLIB (a free lyrics database; artist, title, album and length are sent, and results are remembered).
- **Colours from the cover:** the progress bar, playing indicator and Now Playing view take their accent from the current album cover.
- **Sharper artwork:** covers are also kept at up to 1600 px for large views; existing covers are upgraded in the background.
- **Quality badges:** Lossless and Hi-Res Lossless, with the format, bit depth and sample rate.
- **Motion:** pages, covers and Now Playing ease in; turned off when Windows asks for reduced motion.
- **Loudness levelling:** every song is measured once in the background (EBU R128, the basis of ReplayGain 2; ReplayGain tags are preferred when present). Smart mode uses album gain while an album plays in order and song gain otherwise; boosts are limited to +12 dB, near-silent songs are never boosted, and peaks never clip.
- **Smart crossfade:** fades start where the music ends and skip silence at song edges; songs that run into each other on an album are never faded.
- **Equalizer:** 10 bands with a preamp and presets (Bass boost, Vocal, Loudness, Late night and more), remembered separately for each output device.
- **Output device:** choose where Slate Music plays; it switches immediately and falls back to the Windows default when the chosen device is disconnected.
- **Signal path:** Now Playing lists every step from the file to the device: source format, levelling, equalizer, conversion to 48 kHz, and the output device.
- **Command bar (Ctrl+K):** find songs, albums, artists and playlists and run actions (shuffle, sleep timer, new smart playlist, settings) from one box; Enter plays a song or opens the rest.
- **Better search:** tolerates typos and missing letters, ranks whole-word matches first, and groups matching artists and albums above the songs.
- **Home shelves:** Jump back in, Recently added, On this day, Forgotten favourites and Recently played, all worked out from your own listening on this PC.
- **Your year:** a private year in review with plays, minutes, longest streak, new artists, top songs, artists and albums, and plays per month. Earlier years are one click away.
- **Smart playlists:** build playlists from rules (artist, album, year, format, lossless, plays, favourite, length, last played, added) matched all or any, ordered and limited as you like. They update themselves; ready-made presets include Forgotten favourites, Most played, Never played and Songs from the 80s. Shuffled smart playlists keep the same order through the day.
- **Artist photos and bios:** with "Show artist photos and bios" on, opening an artist looks them up once on MusicBrainz, Wikidata and Wikipedia and saves a photo and short bio (only the artist's name is sent). The photos also appear on the Artists page, in search and in Your year.
- **Pick several songs:** click a row to pick it, Ctrl+click to add or drop one, Shift+click for a range, Ctrl+A for the whole list. A bar offers Play, Play next, Add to queue, Add to playlist, Favorite and (in the queue or your playlists) Remove; right-click works on all picked songs, Delete removes them and Esc clears the pick.
- **Drag and drop:** drag songs (or whole albums) onto a playlist in the sidebar, onto Favorites to heart them, onto Playlists to start a new playlist, or onto Up next to queue them. Drag rows to reorder the queue and your own playlists.
- **Sortable columns:** click Title, Album, Year or Time to sort, again to reverse, and # to return to an album's, playlist's or search's own order. Songs, Favorites, Recently played and each playlist remember their order.
- **Search results** now list the best matches first.
- **Lists keep their place:** each song list remembers where you scrolled, and long lists offer "Show playing song".
- Artist pages list songs album by album, oldest first.
- A right-click menu no longer disappears when a scroll was still settling as it opened.
- **Last.fm scrobbling:** with your own free Last.fm API account, songs are scrobbled once you have heard half of them (or four minutes) and shown as "now playing" while they play. Scrobbles made offline wait and are sent later. The secret and sign-in are encrypted with Windows DPAPI.
- **Discord status:** switch it on and Discord shows "Listening to Slate Music" with the song, artist and a progress bar while music plays, and nothing while paused. Nothing to set up; your own Discord application can be used instead. Slate Music only talks to the Discord app on this PC.
- A disabled main button no longer loses its label under the mouse.
- **Exclusive mode (bit-perfect):** Settings → Playback can give Slate Music the output device to itself (WASAPI exclusive mode). Each song is sent at its own sample rate as whole-number samples, with no Windows mixing or resampling; songs at the same rate stay gapless and a change of rate reopens the device between songs. With volume at 100% and the equalizer and levelling off, the device receives exactly what is in the file, and Now Playing's signal path says so (or says what changes the sound). The device is let go a few seconds after music pauses so other apps can play. If a device can't be used exclusively, Slate Music explains why and plays through Windows instead.
- Hearts set in the mini-player now appear in the main window right away, and the other way round.
- Spotify sign-in no longer fails when the browser opens an extra connection to Slate Music without sending anything; it keeps waiting for the real answer.
- Moving the seek slider with ↑/↓ or Page Up/Down plays from the new position instead of freezing the time display. ←/→ no longer show an error when nothing is loaded.
- "Shuffle your library" starts with a random song instead of always the library's first.
- Back no longer needs two presses after reopening the page already shown, such as after saving the open playlist.
- Deleting a virtual album returns to Albums instead of Playlists.
- The native tests build and run outside Windows too (checked on Linux).
- **Music follows your headphones.** Plugging headphones in or reconnecting them moves the music to them (it no longer stays silent on the old device after a long pause or a reconnect); a chosen device is used again when it comes back; unplugging the device that plays pauses the music. An output that silently stops is replaced.
- Fixes from the full 1.1.0 review: left and right no longer swap after a seek or crossfade; editing the queue in a song's last moments no longer stops playback; switching off exclusive mode never plays a song at the wrong speed; exclusive mode no longer cuts the end of a song before a rate change or trims its start; the equalizer stays accurate at high sample rates; large queue edits no longer stall the audio; Discord reconnects sensibly and notices a restart; Last.fm sign-in can be cancelled, keeps scrobbles over the daily limit and counts repeats with crossfade; MusicBrainz lookups share one pace; artist names with "/" work; slow settings no longer hold up the window.

## 1.0.3 — 2026-09-30

- Import Spotify playlists instead of albums. Pick from your own playlists or paste a playlist link, then update an imported playlist from Spotify later without losing songs you already matched. Uses Spotify's 2026 playlist API; earlier connections need one Reconnect for playlist access.
- Import Spotify Liked Songs as a playlist and, optionally, add the matched songs to Favorites (needs one Reconnect for the `user-library-read` permission). Large imports are matched much faster.
- Import your Spotify top songs (this month, last 6 months or last year) as playlists (`user-top-read`).
- Imported Spotify playlists, Liked Songs and top songs update themselves each time Slate Music opens, keeping confirmed matches. Each can be switched off in its edit screen.
- Optional original release years: when enabled in Settings, Slate Music asks MusicBrainz (artist and title only, about one song per second) when each song first came out. A new Year column and a "Year released" sort show it; songs without a known original year show their album's year dimmed, and the listening panel notes "First released" for compilation and remaster tracks. ORIGINALDATE tags are used when present.
- Use the album name to choose between an album cut and a compilation copy of the same song.
- Recognize songs whose files were moved or renamed inside the library: favorites, play counts, history, playlist places and the queue carry over, and no "Unavailable" copy is left behind. Songs on a disconnected drive are left alone, and ambiguous duplicates are not guessed.
- Settings can remove unavailable songs (deleted files or disconnected drives); playlists keep them as missing entries.
- Find album covers with other file names, such as "Artist - Album [2008].jpg" or a front image in the album folder above "CD1"/"Disc 2" folders, and pick up cover images added after a song was indexed.
- Right-click a song for Play next, Add to queue, Add to playlist, Go to album or artist, Favorite and Show in File Explorer; right-click an album to play or queue it. The browser's own context menu no longer appears.
- Add Play next, Clear up next (keeps the current song playing) and Save queue as playlist. Albums are added to the queue in one step.
- Add a sleep timer (15 minutes to 1½ hours, or end of the current song).
- Back returns to the previous page and its scroll position; the mouse back button and Alt+← work too.
- Keyboard shortcuts keep working after using the volume or seek slider or the sort menu. Mute restores the previous volume. Double-clicking a song plays it once.
- Playback messages can be dismissed and clear once a later action succeeds. The playing song's queue remove button is disabled instead of failing.
- Adding a song that is already in a playlist no longer duplicates it.
- Song lists are no longer re-sorted several times a second during playback, and the Artists page is computed once per library change.
- Show a system tray icon with playback controls and keep Slate Music grouped correctly on the taskbar.
- Previous, Play/Pause, Next and Favorite buttons in the taskbar preview (hover over Slate Music's taskbar button), like other Windows music players.
- Review fixes:
  - Spotify: read every page of long lists by offset (lists over 50 playlists failed before), wait and retry when Spotify asks to slow down, and explain errors more clearly (expired sign-in, missing permission, deleted playlist).
  - Automatic updates work from fresh data and re-read each playlist just before saving, so a playlist deleted, renamed or edited meanwhile is never overwritten. Playlists Spotify reports unchanged are not downloaded again; their missing songs are still matched against new files.
  - Importing the same Spotify source again updates the earlier import instead of adding a copy. "Leave this song missing" and matches for Spotify local files are remembered across updates; a match whose file has left the library can be matched again.
  - Saved playlists are stored compactly and may be much larger; songs are hearted only after the playlist saved. Playlists that follow Spotify are not offered for adding or removing songs by hand.
  - Sleep timer: "End of this song" plays to the real end with no crossfade and waits at the next song; a timer that runs out while paused no longer stops the next play.
  - Cover search is faster in large folders, and a broken cover image no longer causes re-reads on every scan (the next image is used).
  - Original years: search by the plain title (without "Remastered" labels) and match artists exactly.
  - "Remove unavailable songs" asks first and keeps songs on a drive that isn't connected. Songs added to a playlist while unavailable become playable when their file returns.
  - Back skips pages that no longer exist and no longer bounces between two pages.

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
