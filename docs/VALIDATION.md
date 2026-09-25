# Validation — 1.0.1

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

The public source and version tags were pushed successfully. Both GitHub Actions workflows were dispatched, but GitHub refused to start their jobs: “The job was not started because your account is locked due to a billing issue.” No CI test result is claimed. The owner explicitly authorized the updater key to be stored in encrypted Actions secrets; configuration is complete, but the account billing lock must be resolved before hosted automation can run. Releases 1.0.0 and 1.0.1 were signed and published from the tested local Windows build. The failed run is [visible here](https://github.com/SPARTANAC95/slate-music/actions/runs/36182039043).

## Limits

- The production 1.0.0 → 1.0.1 upgrade was exercised. Interrupted downloads, forced power loss during installation and rollback from a broken future release have not been exhaustively tested.
- Offline validation disabled the WebView network while using native local playback; the physical network adapter was not disconnected. The native audio and SQLite paths perform no network requests. Spotify and update requests intentionally require connectivity.
- Physical hardware media keys, device unplug/replug recovery, every possible codec/encoder variant, 100,000-track performance and long-duration unattended endurance have not been exhaustively tested.
- Raw ADTS AAC has limited seeking support. Opus, WMA, APE, protected files, multichannel, exclusive mode and bit-perfect output are not supported. Output is mixed at 48 kHz stereo.
- Playlist editing uses move-up/down controls rather than drag and drop. Externally renamed files receive a new identity. Folder artwork-only changes may require a metadata change to invalidate an existing cache.
- This release has signed updater artifacts but no Windows Authenticode certificate. A publisher certificate remains an owner-supplied release prerequisite if trusted-publisher installation is desired.
- Spotify quota and account eligibility remain controlled by Spotify. Successful testing on the owner's app does not establish access for every account.

Private library paths, API credentials, tokens and runtime screenshots of the owner's collection are excluded from source and public release assets.
