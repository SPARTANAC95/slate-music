# 1.1.0 review findings (2026-10-01)

Full review of everything changed since 1.0.3 (b2f26af), before releasing 1.1.0. Four reviewers read the audio engine, the Rust services, the app logic and the screens. Checks were also re-run in the test copy. Status: **[x] fixed**, **[ ] to do**.

## Fixed

- [x] Now Playing slid up near the end of a song: the top bar disappeared and the app showed underneath. Cause: `scrollIntoView` on the current lyric also scrolled the Now Playing view. Fixed with `scrollInside` (components.tsx) and `overflow: clip`. The lyrics also return to the top for a new song, and the Ctrl+K list uses the same helper. Covered by a new qa.mjs scenario.

## To do: highest first

### App logic and screens
1. [ ] **Duplicate songs in a playlist share one selection key.** Deleting one copy deletes every copy; dragging one moves all of them. Key Collection rows by entry index (`shown.entries[i]`) and pass the row keys to TrackTable.
2. [ ] **The previous song's lyrics stay up while the new song's lyrics load.** Call `setLyrics(null)` when the track changes (NowPlaying.tsx effect).
3. [ ] **Queue selection is stored as queue positions and goes stale.** Play next, shuffle, removing a row and similar all shift the positions. Clear `picked` when `pb.queue` changes on the Queue page, except right after our own move_many.
4. [ ] **"New smart playlist" from Ctrl+K edits the smart playlist being viewed.** It can overwrite it. Use separate new/edit state (store the id being edited).
5. [ ] **Shortcuts reach the page behind Now Playing and the palette.**
   - Delete works behind Now Playing.
   - Esc, Space and arrows act while the palette is open but unfocused.
   - Space on a lyric line toggles playback instead of jumping to it.
6. [ ] **Some palette choices happen out of sight behind Now Playing.** Artist results and every "Go to …" command navigate without closing it. Close Now Playing in `navigate()`.
7. [ ] **The bit-perfect verdict doesn't match the engine.**
   - It says "Not bit-perfect" when nothing changes the sound: gainKind 'unmeasured' (gain is 1.0), and an EQ that is on but flat.
   - It says "Bit-perfect" when the sound is changed: 32-bit files (decoding keeps 24 bits), files with more than 2 channels (folded down), and an unknown sample rate.
   - Settings' "Songs reach it exactly as they are in the file" is too broad. It ignores what the device accepts, so the wording should be softer or use the same rule.
8. [ ] **Exclusive mode still trims silence at the start of songs.** The preload skip uses `r.state.crossfade` instead of the effective crossfade (0 in exclusive mode and for the end-of-song sleep timer) (audio.rs ~1279).
9. [ ] **Signal path panel overflows on short windows** (880x620, 1366x768). It runs under the transport buttons. Let `.np-art` scroll or shrink the cover.
10. [ ] **Some Settings text is wrong.**
    - The crossfade text should follow `pb.output?.exclusive`, not the setting.
    - "Gapless" isn't true in exclusive mode when the sample rate changes.
    - In shared mode the Mixing row should mention the device rate.
11. [ ] **Performance.** The palette rebuilds its whole index on every playback update (about 4 times a second), because `paletteCommands()` is a new array each render. Split the memo. Also memoize the smart-playlist counts on the Playlists page.
12. [ ] **Palette song counts are wrong.** Smart playlists show "0 songs", and counts read "1 songs".
13. [ ] **EQ sliders snap back while dragging, and every step saves.** Keep a local draft and commit on release, debounced.
14. [ ] **Smart rules.** An unknown year (0) matches "Year less than X". A number field holding NaN or empty breaks the date rules.
15. [ ] **Small logic issues.**
    - Queue drag uses visible row numbers as queue positions; map them via `visibleQueue[i].index`.
    - `shown.entries` isn't filtered along with search and filters.
    - Saved sort modes aren't validated, so an unknown mode crashes the app.
    - The Shift+click anchor is a row number and goes stale after re-sorting.
    - Search typo tolerance fails on partly typed words: use the minimum of the last DP row.
16. [ ] **Accessibility.**
    - Now Playing has no focus trap and no `aria-modal`.
    - The palette has no `aria-activedescendant`.
    - Status text inside disabled buttons is hard to read.

### Audio engine
17. [ ] **Switching from exclusive to shared can play a song at the wrong speed** if reloading the song fails or is discarded (epoch check). Drop `current` when the reload fails, or output silence while `current.rate != rate` in shared mode.
18. [ ] **Left and right swap after a crossfade.** The mix starts on an odd sample index. `load()` with a seek sets an odd `samples` value; use `(target*rate) as u64 * 2`, and start fades on a frame boundary.
19. [ ] **Large remove_many/move_many lock the audio.** `remove_queued` clones the queue per row (snapshot) under the render lock. Use one `retain` pass, and a HashSet in `move_rows`.
20. [ ] **Editing the queue or settings in the last moments of a song stops playback.** These commands clear `next`, and Play then replays the same song. Stay "playing" (silent) until the loop installs the next deck. Cache album gains: `shape()` scans the whole library.
21. [ ] **"Exclusive mode stopped: …" is wiped about a second later** when the shared output opens (`notice` is None). Keep the reason until then.
22. [ ] **Smaller WASAPI issues.**
    - A rate change cuts the last ~40 ms of a song; wait one more buffer before Stop.
    - The event handle leaks on error paths.
    - A stale `lost`/`problem` flag from an old Exclusive thread can kill the new output.
    - Nothing loaded opens at 48 kHz/16-bit, which some devices reject.
23. [ ] **EQ precision.** Use f64 coefficients and state: f32 is poor at 192–384 kHz. Reset the state when a sample is NaN or infinite.
24. [ ] **Commands can be ignored and the UI can freeze.**
    - `load()` silently drops a next/jump/seek when the epoch changed during prepare.
    - The taskbar buttons call `engine.command` on the UI thread.

### Rust services
25. [ ] **Discord reconnect backoff never applies.** When no client exists, the "ID changed" check is always true, so it retries every second. Track `last_wanted`.
26. [ ] **Nothing paces MusicBrainz across years.rs and artists.rs.** Add one process-wide gate (≥1.1 s between requests). Run artist lookups one at a time and skip ones already in progress. years.rs should skip a failed song instead of stopping the whole run.
27. [ ] **The Last.fm sign-in poller can't be cancelled.** It can save old credentials over new ones, or rewrite the file after Remove. Add a generation counter, write files atomically, and have `signed_out` re-read before saving.
28. [ ] **Last.fm messages and retries.**
    - "Will retry" appears where nothing retries.
    - Polling should continue on errors 8, 11, 16 and 29.
    - A timed-out sign-in shows no message.
    - Ignored scrobbles are deleted even for code 5 (daily limit), which should stay queued.
    - The queue isn't cleared on Remove.
    - The loop doesn't break when the delete fails.
29. [ ] **Repeats with crossfade aren't scrobbled again.** Restart detection uses position < 3 s; use the engine's transition counter. Count listening by position progress. Add a cheap engine accessor instead of a full `snapshot()` every second.
30. [ ] **Artist lookup problems.**
    - Wikipedia titles with "/" (AC/DC) and Commons file names aren't URL-encoded.
    - A failed Wikipedia call aborts the whole lookup.
    - A failed photo download is cached forever.
31. [ ] **Sync commands run on the UI thread:** lastfm_status (polled every 2 s), discord_status/setup, lastfm_disconnect/forget and artist_photos. Make them async with spawn_blocking.
32. [ ] **Discord.**
    - A Discord restart isn't noticed until the song changes; re-send every ~60 s.
    - Pipe reads have no timeout.
    - The "refused" problem is never shown while connected and never cleared.
33. [ ] **Fallback covers and 404s are cached "immutable" for a year;** use no-cache. `open_link` should open the parsed URL.

## Test notes
- Passing: qa.mjs (28 scenarios), the Phase 3–6 checks, Now Playing, sound (with temporary tones), picker, taskbar, Spotify fixes (on a reset profile).
- `years-top-sync-check` and `new-features-check` assume an older test-profile state. They predate the 1.0.3 "skip unchanged playlists" change, so they need updating; this isn't an app regression.
