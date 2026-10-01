# 1.1.0 review findings (2026-10-01)

Full review of everything changed since 1.0.3 (b2f26af), before releasing 1.1.0. Four reviewers read the audio engine, the Rust services, the app logic and the screens. Checks were also re-run in the test copy. Status: **[x] fixed**, **[ ] to do**. All findings are fixed (October 1, 2026); each item notes where.

## Fixed

- [x] Now Playing slid up near the end of a song: the top bar disappeared and the app showed underneath. Cause: `scrollIntoView` on the current lyric also scrolled the Now Playing view. Fixed with `scrollInside` (components.tsx) and `overflow: clip`. The lyrics also return to the top for a new song, and the Ctrl+K list uses the same helper. Covered by a new qa.mjs scenario.

## Fixed after the review (highest first)

### App logic and screens
1. [x] **Duplicate songs in a playlist share one selection key.** Deleting one copy deletes every copy; dragging one moves all of them. Key Collection rows by entry index (`shown.entries[i]`) and pass the row keys to TrackTable.
    - _Fixed in fc93d1a (rows picked per playlist entry)._
2. [x] **The previous song's lyrics stay up while the new song's lyrics load.** Call `setLyrics(null)` when the track changes (NowPlaying.tsx effect).
    - _Fixed in fc93d1a._
3. [x] **Queue selection is stored as queue positions and goes stale.** Play next, shuffle, removing a row and similar all shift the positions. Clear `picked` when `pb.queue` changes on the Queue page, except right after our own move_many.
    - _Fixed in fc93d1a (picks cleared when the queue changes; drags map rows)._
4. [x] **"New smart playlist" from Ctrl+K edits the smart playlist being viewed.** It can overwrite it. Use separate new/edit state (store the id being edited).
    - _Fixed in fc93d1a._
5. [x] **Shortcuts reach the page behind Now Playing and the palette.**
   - Delete works behind Now Playing.
   - Esc, Space and arrows act while the palette is open but unfocused.
   - Space on a lyric line toggles playback instead of jumping to it.
    - _Fixed in fc93d1a._
6. [x] **Some palette choices happen out of sight behind Now Playing.** Artist results and every "Go to …" command navigate without closing it. Close Now Playing in `navigate()`.
    - _Fixed in fc93d1a (navigating closes Now Playing)._
7. [x] **The bit-perfect verdict doesn't match the engine.**
   - It says "Not bit-perfect" when nothing changes the sound: gainKind 'unmeasured' (gain is 1.0), and an EQ that is on but flat.
   - It says "Bit-perfect" when the sound is changed: 32-bit files (decoding keeps 24 bits), files with more than 2 channels (folded down), and an unknown sample rate.
   - Settings' "Songs reach it exactly as they are in the file" is too broad. It ignores what the device accepts, so the wording should be softer or use the same rule.
    - _Fixed in 819c63e._
8. [x] **Exclusive mode still trims silence at the start of songs.** The preload skip uses `r.state.crossfade` instead of the effective crossfade (0 in exclusive mode and for the end-of-song sleep timer) (audio.rs ~1279).
    - _Fixed: the preload uses the effective crossfade (`effective_crossfade()`)._
9. [x] **Signal path panel overflows on short windows** (880x620, 1366x768). It runs under the transport buttons. Let `.np-art` scroll or shrink the cover.
    - _Fixed in 819c63e._
10. [x] **Some Settings text is wrong.**
    - The crossfade text should follow `pb.output?.exclusive`, not the setting.
    - "Gapless" isn't true in exclusive mode when the sample rate changes.
    - In shared mode the Mixing row should mention the device rate.
    - _Fixed in 819c63e (Settings text follows the actual output)._
11. [x] **Performance.** The palette rebuilds its whole index on every playback update (about 4 times a second), because `paletteCommands()` is a new array each render. Split the memo. Also memoize the smart-playlist counts on the Playlists page.
    - _Fixed in 819c63e._
12. [x] **Palette song counts are wrong.** Smart playlists show "0 songs", and counts read "1 songs".
    - _Fixed in 819c63e (`plural()`)._
13. [x] **EQ sliders snap back while dragging, and every step saves.** Keep a local draft and commit on release, debounced.
    - _Fixed in 819c63e._
14. [x] **Smart rules.** An unknown year (0) matches "Year less than X". A number field holding NaN or empty breaks the date rules.
    - _Fixed in 819c63e._
15. [x] **Small logic issues.**
    - Queue drag uses visible row numbers as queue positions; map them via `visibleQueue[i].index`.
    - `shown.entries` isn't filtered along with search and filters.
    - Saved sort modes aren't validated, so an unknown mode crashes the app.
    - The Shift+click anchor is a row number and goes stale after re-sorting.
    - Search typo tolerance fails on partly typed words: use the minimum of the last DP row.
    - _Fixed in fc93d1a._
16. [x] **Accessibility.**
    - Now Playing has no focus trap and no `aria-modal`.
    - The palette has no `aria-activedescendant`.
    - Status text inside disabled buttons is hard to read.
    - _Fixed in 819c63e._

### Audio engine
17. [x] **Switching from exclusive to shared can play a song at the wrong speed** if reloading the song fails or is discarded (epoch check). Drop `current` when the reload fails, or output silence while `current.rate != rate` in shared mode.
    - _Fixed: a song left at the previous output's rate is reopened, or unloaded keeping its place (`fix_rate()`); the render never plays it at the wrong speed._
18. [x] **Left and right swap after a crossfade.** The mix starts on an odd sample index. `load()` with a seek sets an odd `samples` value; use `(target*rate) as u64 * 2`, and start fades on a frame boundary.
    - _Fixed: `sample()` advances the channel itself; a deck loaded or sought mid-frame waits for the next left sample; a crossfade joins on a left sample; seeks keep whole frames; a new shared stream starts on the left._
19. [x] **Large remove_many/move_many lock the audio.** `remove_queued` clones the queue per row (snapshot) under the render lock. Use one `retain` pass, and a HashSet in `move_rows`.
    - _Fixed: `remove_rows()` removes in one pass (also `forget`); `move_rows` uses a HashSet._
20. [x] **Editing the queue or settings in the last moments of a song stops playback.** These commands clear `next`, and Play then replays the same song. Stay "playing" (silent) until the loop installs the next deck. Cache album gains: `shape()` scans the whole library.
    - _Fixed: a song ending while the next is prepared waits silently (`waiting`); album gain reads one album through SQLite (`album_tracks`)._
21. [x] **"Exclusive mode stopped: …" is wiped about a second later** when the shared output opens (`notice` is None). Keep the reason until then.
    - _Fixed: the reason is kept until the shared output opens._
22. [x] **Smaller WASAPI issues.**
    - A rate change cuts the last ~40 ms of a song; wait one more buffer before Stop.
    - The event handle leaks on error paths.
    - A stale `lost`/`problem` flag from an old Exclusive thread can kill the new output.
    - Nothing loaded opens at 48 kHz/16-bit, which some devices reject.
    - _Fixed: the last buffer plays out before a rate change; the event handle closes on failed opens; stale flags are cleared when an output is replaced; nothing loaded no longer fails on 48 kHz._
23. [x] **EQ precision.** Use f64 coefficients and state: f32 is poor at 192–384 kHz. Reset the state when a sample is NaN or infinite.
    - _Fixed: f64 coefficients and memory; NaN/inf resets the filters._
24. [x] **Commands can be ignored and the UI can freeze.**
    - `load()` silently drops a next/jump/seek when the epoch changed during prepare.
    - The taskbar buttons call `engine.command` on the UI thread.
    - _Fixed: `load()` retries a request overtaken while the song opened. The taskbar buttons already ran on their own thread (no change needed)._

### Rust services
25. [x] **Discord reconnect backoff never applies.** When no client exists, the "ID changed" check is always true, so it retries every second. Track `last_wanted`.
    - _Fixed: only a real change of setting or ID starts afresh (`last_wanted`)._
26. [x] **Nothing paces MusicBrainz across years.rs and artists.rs.** Add one process-wide gate (≥1.1 s between requests). Run artist lookups one at a time and skip ones already in progress. years.rs should skip a failed song instead of stopping the whole run.
    - _Fixed: `years::musicbrainz_turn()` paces every MusicBrainz request; artist lookups run one at a time, skipping one in progress; years skip a failed song and stop after three in a row._
27. [x] **The Last.fm sign-in poller can't be cancelled.** It can save old credentials over new ones, or rewrite the file after Remove. Add a generation counter, write files atomically, and have `signed_out` re-read before saving.
    - _Fixed: a sign-in generation counter, a file lock, atomic writes and a re-read in `signed_out`._
28. [x] **Last.fm messages and retries.**
    - "Will retry" appears where nothing retries.
    - Polling should continue on errors 8, 11, 16 and 29.
    - A timed-out sign-in shows no message.
    - Ignored scrobbles are deleted even for code 5 (daily limit), which should stay queued.
    - The queue isn't cleared on Remove.
    - The loop doesn't break when the delete fails.
    - _Fixed: honest messages; polling continues on 8/11/16/29 and reports a timeout; code 5 stays queued; Remove clears the queue; a failed delete stops the loop._
29. [x] **Repeats with crossfade aren't scrobbled again.** Restart detection uses position < 3 s; use the engine's transition counter. Count listening by position progress. Add a cheap engine accessor instead of a full `snapshot()` every second.
    - _Fixed: restarts follow the engine's transition counter; listening follows position progress; watchers read `Engine::listening()`._
30. [x] **Artist lookup problems.**
    - Wikipedia titles with "/" (AC/DC) and Commons file names aren't URL-encoded.
    - A failed Wikipedia call aborts the whole lookup.
    - A failed photo download is cached forever.
    - _Fixed: titles and file names are encoded as one path segment; failed steps keep what was found and retry after a day._
31. [x] **Sync commands run on the UI thread:** lastfm_status (polled every 2 s), discord_status/setup, lastfm_disconnect/forget and artist_photos. Make them async with spawn_blocking.
    - _Fixed: these (and remove_folder, collection, spotify_disconnect) run through `blocking()`._
32. [x] **Discord.**
    - A Discord restart isn't noticed until the song changes; re-send every ~60 s.
    - Pipe reads have no timeout.
    - The "refused" problem is never shown while connected and never cleared.
    - _Fixed: pipe I/O on its own thread with a 5 s answer limit; the status is re-sent about once a minute; refusals show while connected and clear on success._
33. [x] **Fallback covers and 404s are cached "immutable" for a year;** use no-cache. `open_link` should open the parsed URL.
    - _Fixed: only the exact cover is cached for good; stand-ins and misses use no-cache; `open_link` opens the parsed URL._

## Test notes
- Passing: qa.mjs (28 scenarios), the Phase 3–6 checks, Now Playing, sound (with temporary tones), picker, taskbar, Spotify fixes (on a reset profile).
- `years-top-sync-check` and `new-features-check` assume an older test-profile state. They predate the 1.0.3 "skip unchanged playlists" change, so they need updating; this isn't an app regression.

## Also fixed before release
- No sound after a long pause or after reconnecting headphones (owner report): the engine follows Windows' default device, returns to a chosen device that is back, and replaces a shared output that stopped asking for samples; exclusive mode looks the device up each time music starts.
- Discord status works without setting anything up (Slate Music's own application), the Spotify sign-in callback tolerates spare browser connections, favorites stay in step between the main window and the mini-player, and the 1.0.3 follow-up fixes are merged.
