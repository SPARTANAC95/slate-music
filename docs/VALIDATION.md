# Validation — 1.1.4

## October 7 Opus, welcome and release checks

Version 1.1.4 was built and run as a native Windows application under a separate application identifier, on disposable profiles with generated songs. The owner's installed copy kept running and was not touched.

| Check | Result |
|---|---|
| TypeScript and frontend | 81 tests passed; TypeScript and Vite production build passed |
| Browser components | 24 Now Playing checks and 10 selection, filter, Settings and first-launch checks passed in headless Edge |
| Native engine and services | 111 Rust tests passed on Windows; `cargo clippy --all-targets` reports no warnings; formatting checked |
| Opus decoder choice | `unsafe-libopus` (libopus translated to Rust) and `opus-decoder` were each compared with ffmpeg's libopus on five files: 16 kbit/s mono speech, 32 kbit/s hybrid, and 48, 128 and 256 kbit/s music with 10, 20 and 60 ms frames. `unsafe-libopus` differed by at most 0.000015 on every file; `opus-decoder` refused the 60 ms file and was 34 dB and 48 dB from the reference on two others, and a hundred times slower |
| Opus in the app's own reader | The ignored test `matches_the_reference_decoder_on_real_files` gave the same number of samples as the reference for all five files (run-in and padding trimmed) and at most 0.000015 difference. A generated nine-second song decoded to exactly its length with the right pitch in each channel, and seeking to four places landed on the very samples straight playback reaches |
| Opus in the native app | A tagged 95-second Opus song was scanned with its title, artist and length, played, sought to 60 s (found at 60.00, and at 62.01 two seconds later), repeated with repeat-one, and with repeat off handed over to the next song at its end |
| First launch | With no music folder the welcome appeared, no folder was added or asked for, the Windows Music folder was offered, switches saved, and the sidebar had no Spotify button |
| Native interface | All 28 scenarios in `tools/qa.mjs` passed (Spotify import is now reached from Playlists) |
| Native lyrics | All 6 checks in `tools/check-native-lyrics.mjs` passed with Word by word set to On, which they need |

Limits. Opus files with more than two channels are refused. Chained Ogg streams play their first stream only. The Windows Music folder button was not pressed in the QA run, so as not to scan the owner's own music into a test profile; the browser check covers what it sends. The native run was a debug build; the released installer is built by GitHub Actions.

# Validation — 1.1.3

## October 7 Discord cover fix, lyric animation and release checks

1.1.2 was released without its covers having been seen in a Discord client, and the owner then saw a question mark in place of a cover. The cause: the Cover Art Archive listed a cover (a redirect), but the Internet Archive, which serves its pictures, answered 503 for that file; 1.1.2 had only checked the listing. 1.1.3 was checked inside Discord before release, with the owner's permission.

| Check | Result |
|---|---|
| TypeScript and frontend | 81 tests passed; TypeScript and Vite production build passed |
| Browser components | 23 Now Playing checks and 9 selection, filter and Settings checks passed in headless Edge. The new check follows the light every frame: no step back, no jump, and the soft edge lying across the gap between two words |
| Native engine and services | 109 Rust tests passed on Windows; `cargo clippy --all-targets` reports no warnings; formatting checked. The cover lookup's ignored online test found covers that load for "The Highlights", "Bad 25th Anniversary" and "Abbey Road (Remastered)", reported a made-up album as missing, and rejected an address that answers with an error page |
| Discord client | One status with each of three pictures was sent to a running Discord and Discord's image service asked for each: iTunes cover 200 (JPEG), Slate Music icon 200 (PNG), the Cover Art Archive address used by 1.1.2 502 |
| Native interface | All 28 scenarios in `tools/qa.mjs` passed on a new profile, twice |
| Native lyrics | All 6 checks in `tools/check-native-lyrics.mjs` passed |
| Lyric animation in the native app | 2,878 frames in 20 seconds at 144 frames a second: median 7.0 ms, worst 7.2 ms, none late; the light never stepped back or jumped |
| Upgrade from 1.1.2 | On the profile left by 1.1.2, Find lyrics online was switched on once and the other settings left alone; the cover address 1.1.2 had saved was not reused, the album was looked up again and the new cover loaded; an album in no catalogue showed the icon; pausing cleared the status |
| The lyrics default | A new profile starts with it on; switched off after the update, it was still off after a restart |

Limits. Covers depend on Apple's and Deezer's catalogues continuing to answer without a key; if one stops, the next is used, and with none the icon is shown. The Last.fm account built into releases could not be exercised: the repository secrets were not set when this was written, in which case this release asks for an API account of the user's own as before. The native run was a debug build; the released installer is built by GitHub Actions.

# Validation — 1.1.2

## October 7 Discord covers, lyric timing and release checks

Version 1.1.2 was built and run as a native Windows application under a separate application identifier, with a disposable profile and generated silent FLAC files with generated artwork. The owner's installed copy kept running and was not touched, and nothing was sent to the owner's Discord.

| Check | Result |
|---|---|
| TypeScript and frontend | 81 tests passed; TypeScript and Vite production build passed |
| Browser components | 22 Now Playing checks and 8 selection, filter and Settings checks passed in headless Edge with the real components, including the lyrics options, the word-by-word choice and the version line |
| Native engine and services | 106 Rust tests passed on Windows; `cargo clippy --all-targets` reports no warnings; formatting checked. The cover lookup's ignored online test found a known album's cover and reported a made-up album as missing |
| Native interface | All 28 scenarios in `tools/qa.mjs` passed with no runtime errors; Settings showed "Slate Music 1.1.2" |
| Native lyrics | All 6 checks in `tools/check-native-lyrics.mjs` passed; with Word by word off, every word of the line being sung was lit at once |
| Discord status | Followed against a stand-in for Discord's local pipe (`SLATE_DISCORD_PIPE`): nothing sent while off; a song tagged as a known album was shown at once with the icon and again with its Cover Art Archive address once found; an album not online kept the icon; pausing cleared the status; with covers off no cover address was sent |
| Lyric word timing | Against the 79 hand-timed songs of the JamendoLyrics set (English, German, French, Spanish): mean word error 0.41 s before, 0.33 s now; words within 0.3 s 60% before, 66% now; better in each language and on songs left out of the fitting. With the true line ends known the same spread gives 0.25 s |
| Restart | The library and the paused session were restored and playback stayed paused |

Limits. Word times inside line-timed lyrics remain an estimate. How a real Discord client draws the cover (it fetches the Cover Art Archive address itself, through a redirect) was not observed before release. The native run was a debug build; the released installer is built by GitHub Actions.

# Validation — 1.1.1

## October 6 lyrics, audit and release checks

Version 1.1.1 was built and run as a native Windows application under a separate application identifier, with a disposable profile and six generated silent FLAC files with generated artwork. The owner's installed copy kept running and was not touched.

| Check | Result |
|---|---|
| TypeScript and frontend | 80 tests passed (lyric layout, the playback clock, timing memory, matching, search, lists); TypeScript and Vite production build passed |
| Browser components | 21 Now Playing checks and 5 selection and filter checks passed in headless Edge with the real components: word fill from source and line timing, a jittery engine (no backward step, within 60 ms), pauses, output delay, the per-song adjustment, lines that share a time stamp, reduced motion, focus and the 880x620 minimum window |
| Native engine and services | 103 Rust tests passed on Windows; `cargo clippy --all-targets` reports no warnings; formatting checked |
| Native interface | All 28 scenarios in `tools/qa.mjs` passed with no runtime errors |
| Native lyrics | All 6 checks in `tools/check-native-lyrics.mjs` passed; lyrics stored under `UNSYNCEDLYRICS` in a FLAC file and a UTF-16 .lrc file were read correctly; the per-device delay, the per-song buttons and the seek bar's arrow keys were exercised in the running app |
| Lyric timing against the real engine | Sampled every frame at 143 frames a second while playing: the word fill never stepped backwards, and at the moments the engine was asked for its position the lyrics were within 6 ms of it |
| Restart | Queue, current song, position, volume, favorite and playlist were restored and playback stayed paused; the database was not written while the player sat paused |

Limits. Word times inside line-timed lyrics are estimated from the length of each word, not measured from the recording. The output delay is the one Windows reports (11 ms for the wireless headset used here, which is certainly less than its real delay); wireless devices generally need the per-device Lyrics delay set by ear. Exclusive-mode output delay is calculated from the buffer size and the device's report and was not measured on a physical DAC. Live LRCLIB lookups were not exercised in the app; a manual query showed that its timed lyrics carry line times only. The audit read the lyric path, the playback clock, the engine's commands, the database layer, the scanner's cover handling and the main screens; the Spotify, Last.fm and Discord clients were not re-read after their October 3 review.

# Validation — 1.1.0

## October 1 review, fixes and release checks

Before release, four reviewers read every 1.1.0 change (audio engine, Rust services, app logic and screens) and recorded 33 findings in [review-1.1.0.md](review-1.1.0.md). All were fixed, each with a note on where. Two owner reports were fixed as well: no sound after a long pause or after reconnecting headphones, and the Discord status needing an application of one's own.

| Check | Result |
|---|---|
| TypeScript and frontend | 54 tests passed; TypeScript and Vite production build passed |
| Native engine and services | Rust tests passed on Linux, including new tests for channel order after a mid-frame load and an odd-sample crossfade, waiting for a next song still being prepared, never playing at the wrong rate, following the default device and pausing when the playing device disappears, equalizer accuracy at 192/384 kHz, Discord refusals, Last.fm daily limits and repeat scrobbles, artist name encoding and the Spotify sign-in callback |
| Windows code | The whole crate, including the WASAPI exclusive output and taskbar code, type-checked for the Windows target; GitHub Actions runs every test and builds and signs the installer on Windows |
| Interface | The real 1.1.0 frontend was driven in Chromium with a simulated backend: favorites from another window, seek-slider keys, Shuffle starting at random, Back after reopening a page and virtual-album deletion (each failing before its fix), plus the website screenshots |
| Native interface scenarios | Before this round of fixes, all 28 `tools/qa.mjs` scenarios and the Phase 3–6 checks passed in the native app (see the review's test notes) |

Not yet measured on hardware for this release: the device-following and silence watchdog with real headphones, and exclusive-mode rate changes on a physical DAC. They are covered by unit tests of the decisions involved, not by listening tests.

# Validation — 1.0.3

## September 30 feature and review pass

Version 1.0.3 was built and run as a native Windows application with an isolated profile and a disposable library of silent, generated FLAC files. The owner's library was only read, for a start-up check. Two independent code reviews covered every 1.0.3 change; all confirmed findings were fixed and re-tested.

| Check | Result |
|---|---|
| TypeScript and frontend | 29 tests passed; TypeScript and Vite production build passed |
| Native engine, library and Spotify client | 37 Rust tests passed, including list paging by offset and a wait-and-retry after a 429 answer against a local test server |
| Native application | All 22 scenarios in `tools/qa.mjs` passed (right-click menu, back navigation, shortcuts after sliders, mute, sleep timer, queue save/clear, duplicate prevention, dismissible messages and the 14 earlier scenarios) |
| Spotify imports | Playlist picker, Liked Songs (with hearting), top songs, re-import updating the earlier import, "leave missing" surviving updates, unchanged playlists not re-downloaded, a playlist deleted during an update staying deleted, and start-up updates. All checked with simulated Spotify responses. A live check against a real account with the 2026 API awaits the owner's reconnect |
| Library | Moved songs kept favorites, plays, history and playlist places; covers named after the album were found; a broken cover fell back to the next image; removal of unavailable songs asked first and kept songs on an unplugged drive |
| Original years | A live MusicBrainz lookup returned 1981 for "Wired For Sound" on a 1994 compilation |
| Taskbar buttons | Windows accepted the preview buttons; simulated presses of Previous, Play/Pause, Next and Favorite acted on playback and favorites |

# Validation — 1.0.2

## September 26 reliability pass

Version 1.0.2 was built and run as a native Windows application. Personal music was read only; file removal/return tests used synthetic fixtures in a disposable folder. Test profiles and personal-library screenshots remain outside the public repository.

| Check | Result |
|---|---|
| TypeScript and frontend | 19 tests passed; TypeScript and Vite production build passed |
| Native audio, queue and library | All 18 Rust tests passed, including three local-fixture tests; every one of the 615 real FLAC files decoded and sought successfully |
| Final native application | All 14 main scenarios in `tools/qa.mjs` passed |
| Queue interface | Five additional scenarios passed: filtered removal; filtered move/play; duplicate occurrence selection and highlighting; append-to-empty playback; Recently played sorting |
| Restored queue | Removing the restored current entry selected the correct paused replacement; explicit Play loaded it successfully |
| Missing files and watcher | Five additional scenarios passed: failed replacement preserved current playback; missing file appeared correctly in the saved-match editor; returning file retained favorite and confirmed match; rescan bursts and a new file were handled; a short-file transition advanced the queue |
| Restart persistence | Queue, current track, playback position, favorites, collections and transport settings survived; audio stayed paused |
| Windows audio output | Per-process meter returned 30 nonzero samples, peak 0.1483 at application volume 0.15; signal output was measured, not subjective listening quality |
| Updater regression tests | Verified downloaded artifact survives later checks; failed checks cannot reuse stale artifacts; operations are serialized; download/install failures can be retried |
| Matching regressions | Different remaster details require review; unavailable saved matches display missing without overwriting their confirmed identity |
| Visual inspection | Inspected final queue, missing-match, Home and compact-window screenshots; controls and content remained visible |

The public website also passed desktop, tablet and 390/320-pixel mobile inspection, screenshot switching, FAQ keyboard operation, reduced-motion behavior, no-JavaScript fallback and asset/link checks. Its public images contain a fictional demonstration collection, not the owner's library. [Website deployment passed](https://github.com/SPARTANAC95/slate-music/actions/runs/36192376775).

[Windows CI passed](https://github.com/SPARTANAC95/slate-music/actions/runs/36195182608), including 19 TypeScript tests and 15 portable Rust tests. [The hosted release workflow passed](https://github.com/SPARTANAC95/slate-music/actions/runs/36195182896): it built source commit `934c5c5a8433e1b59b7a83fd5c7e34c54022e91f`, signed the installer using the encrypted Actions secret and published [version 1.0.2](https://github.com/SPARTANAC95/slate-music/releases/tag/v1.0.2). Anonymous download, checksums, the installed app's trusted signing key, signed version, tamper rejection and the production update endpoint were verified. The published installer is 6,852,980 bytes; its SHA-256 is `3355fcf8fe7ae7a593349fb213808be85dd74d87bc4751314037edff605f8f63`.

The installed 1.0.1 client downloaded and verified that public artifact while native playback continued. Installation remained disabled until paused and required confirmation. It installed and relaunched 1.0.2 with all 615 tracks, playlists/virtual albums, favorites, queue, original position and volume, transport settings, folders, preferences and encrypted Spotify connection preserved. Audio stayed paused, and the new client's latest-version check succeeded.

The retained evidence below describes the earlier release and is not presented as new testing of every scenario in 1.0.2.

## Earlier 1.0.1 validation

Tested on Windows x64, September 25, 2026. This report distinguishes measured behavior from implementation claims. Original music files were only read; synthetic fixtures and disposable profiles were kept outside the repository.

## Passed

| Check | Evidence |
|---|---|
| TypeScript production build | `tsc --noEmit` and Vite production bundle succeeded |
| Matching and library rules | 12 Vitest tests: normalization, recording variants, duplicates, missing files, duration, multidisc ordering and collection reordering |
| Native tests | All 9 Rust tests passed, including the three environment-dependent audio tests |
| Read-only real-library scan | 615 FLAC files indexed, 615 artwork entries, no scan errors |
| Real-file compatibility | Every one of the 615 real files decoded and sought to its midpoint |
| Codec fixtures | WAV, FLAC, MP3, M4A AAC, raw AAC, ALAC, Ogg Vorbis and AIFF decoded; indexed containers sought successfully |
| Gapless output | Two contiguous 48 kHz stereo FLAC fixtures produced all 384,000 expected interleaved samples, matching the reference WAV within 0.00001 |
| Crossfade | Mixer test verified overlapping tracks blend without inserted silence |
| Native audio output | Windows per-process audio meter measured nonzero output over 30 samples, peak approximately 0.227; this verifies output signal, not a subjective listening assessment |
| Native interface workflows | 14 integration scenarios passed in the real Tauri WebView: scan, incremental rescan, search/play, seek/pause, favorite, playlist create/edit, queue reorder/remove, transport modes, album/artist art, Spotify setup state, offline renderer/native playback, mini-player, settings, session persistence |
| Folder watching | Synthetic file removal became unavailable, playback was blocked, returning file retained its favorite, new file was discovered, short-file playback advanced automatically |
| Restart | Queue, current track, position, favorites and playlist restored; audio stayed paused |
| Clean exit | Main window close terminated the native process after a shutdown bug was fixed; retested with debug and installed release builds |
| Windows system controls | Media session registered; Windows media-session API successfully issued play and pause to the installed application |
| Keyboard controls | Space toggled native playback; Ctrl+K focused search |
| Real Spotify authorization | PKCE browser sign-in succeeded using the owner's supplied Client ID; tokens were stored with DPAPI |
| Real Spotify import | Album API returned 14 ordered tracks; all 14 matched local files. Manual missing/correction flows saved successfully; the missing row was excluded from the playable queue; full original order was restored after correction |
| Installer | Per-user NSIS installation returned exit code 0; Start-menu shortcut created; installed executable scanned and played the real library and sought successfully |
| Reinstallation | Installer returned 0; the full closed SQLite database retained the exact same SHA-256 hash |
| Update verification | Actual Tauri updater accepted a signed installer, rejected modified bytes and rejected a changed version in the manifest |
| Production update safeguards | Production build rejects the debug-only update fixture command; production configuration uses HTTPS and requires the signed version |
| Published download | Anonymous 1.0.1 download succeeded; SHA-256 matched the locally built installer byte for byte |
| Real production upgrade | Installed 1.0.0 downloaded and signature-verified published 1.0.1 while playback continued. Installation stayed disabled until paused; after confirmation the installer ran and relaunched 1.0.1 |
| State after upgrade | All 615 tracks, collections, queue, current song, position, folders, settings and encrypted Spotify connection survived; audio remained paused; latest-version check succeeded |
| UI inspection | Actual screenshots inspected at 1440×940 and compact 880×620, plus album, songs, queue, settings and mini-player. Hero spacing and compact sidebar clipping fixed |
| Dependency audit | `npm audit --omit=dev` reported no known production dependency vulnerabilities at test time |

The real-library interface scenarios are in `tools/qa.mjs`. They require a running native app with WebView2 remote debugging enabled and should use a disposable `SLATE_MUSIC_DATA_DIR`, because they create test playlists and change favorites/playback. Set `SLATE_QA_OUTPUT` for private results. They do not simulate a native backend.

Native fixture tests can be run with `SLATE_AUDIO_FIXTURES` pointing to generated fixtures and `SLATE_TEST_LIBRARY` pointing to a read-only real library, then `cargo test --manifest-path src-tauri/Cargo.toml --lib -- --include-ignored`. Fixture filenames are documented in the test code. Continuous integration runs the portable subset without private music or credentials.

## Release automation

The owner resolved the initial GitHub billing block on September 25, 2026. [Windows CI passed](https://github.com/SPARTANAC95/slate-music/actions/runs/36187070441): 12 Vitest tests, six portable Rust tests, the production frontend build and Rust formatting. The three native tests requiring local audio fixtures are intentionally excluded from hosted CI and passed locally as recorded above.

[Hosted release verification also passed](https://github.com/SPARTANAC95/slate-music/actions/runs/36187070416). It built the exact `v1.0.1` source commit (`07dab83bdb924e4fd6020757db26c8d6db89527c`), signed the Windows installer using the encrypted Actions secret, prepared the update manifest and checksums, and uploaded the verification artifact. Independent download verification confirmed the checksums, the signature against the public key trusted by the installed app, the signed version and rejection of modified installer bytes. The artifact was 6,849,238 bytes.

An initial packaging failure was reproduced and fixed: a CRLF checkout appeared dirty after Tauri rewrote `Cargo.toml` with LF, despite an empty content diff. The workflow now uses consistent line endings, locked dependencies and strict source-cleanliness checks. Existing release artifacts were preserved. Published 1.0.0 and 1.0.1 were originally built, tested, signed and published locally; hosted verification does not replace those installers. The next new version can use the configured tag-triggered publication workflow; that future publication is not claimed as already exercised.

## Limits

- Production 1.0.0 → 1.0.1 and 1.0.1 → 1.0.2 upgrades were exercised. Interrupted downloads, forced power loss during installation and rollback from a broken future release have not been exhaustively tested.
- Offline validation disabled the WebView network while using native local playback; the physical network adapter was not disconnected. The native audio and SQLite paths perform no network requests. Spotify and update requests intentionally require connectivity.
- Physical hardware media keys, device unplug/replug recovery, every possible codec/encoder variant, 100,000-track performance and long-duration unattended endurance have not been exhaustively tested.
- Raw ADTS AAC has limited seeking support. Opus, WMA, APE, protected files, multichannel, exclusive mode and bit-perfect output are not supported. Output is mixed at 48 kHz stereo.
- Playlist editing uses move-up/down controls rather than drag and drop. Externally renamed files receive a new identity. Folder artwork-only changes may require a metadata change to invalidate an existing cache.
- This release has signed updater artifacts but no Windows Authenticode certificate. A publisher certificate remains an owner-supplied release prerequisite if trusted-publisher installation is desired.
- Spotify quota and account eligibility remain controlled by Spotify. Successful testing on the owner's app does not establish access for every account.

Private library paths, API credentials, tokens and runtime screenshots of the owner's collection are excluded from source and public release assets.
