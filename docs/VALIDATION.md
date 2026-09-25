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
