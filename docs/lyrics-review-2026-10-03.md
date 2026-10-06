# Source-timed lyrics and playback timing review

> Later changes (2026-10-06): lines with only a line time stamp now have their words paced within the line, the lyric clock runs steadily between snapshots instead of rebasing on each one (its silent-engine limit is one second, not 300 ms), and lyrics allow for the reported output delay plus per-song and per-device adjustments. `docs/ARCHITECTURE.md` and the changelog describe the current behaviour; the rest of this page records the review as it was made.

Built on correctness-review commit `ee951f2a3674106c94bc1790a96af5b6f3fb8a67`, itself based on current main `5b951ec965c6e5d3a1fe73b1c9bc52c1468085b0`. The original local checkout was clean at `819c63e`, which is an ancestor of that main commit: no additional unpublished commits or uncommitted changes were found there. The installed executable reports 1.1.0; its version alone does not identify an exact source commit. The installed app was not replaced or controlled.

## Behavior

- Enhanced LRC words illuminate between their supplied timestamps, with a subtle glow on the current segment. Line motion is separate from timing, so animation never postpones a timestamp change. Inactive text remains readable. No word timings are inferred from text length or a song's duration.
- A source segment can contain a word, syllable or phrase. An explicit terminal timestamp ends its fill. If the last segment has no end timestamp, it lights at its onset rather than receiving an invented duration. Standard LRC remains line synced; plain lyrics remain untimed. The caption identifies word, mixed, line or text coverage.
- Volume and mute stay visible in Now Playing and share the main player's native gain and remembered unmute level. The native mixer applies the same volume multiplier in shared and exclusive output; lowering volume still appears in the signal-path verdict.
- Seeking, track changes and returning from Up next center the current line. Reading ahead suspends following until **Return to current line** is selected. Tab controls have keyboard navigation; modal focus is contained and restored on close. Reduced motion uses discrete word highlighting with no scale/glow transitions or smooth scrolling.

## Why lyrics could appear ahead

The previous UI explicitly evaluated `currentLine(lines, position + 0.15)`, which highlights each line 150 ms before its source timestamp. That lead is removed. Before `ee951f2`, resuming without a changed position also included elapsed paused time in the lyric clock, and paused seeks could display a stale anchor. Those earlier fixes are preserved.

Interpolation previously had no limit, and unchanged positions did not reset its anchor. A deck/output wait or stalled update stream could therefore keep moving the lyrics while samples stopped advancing. The clock now rebases on every native snapshot, freezes when native `clockRunning` is false, and extrapolates at most 300 ms between roughly 240 ms updates. Native snapshot tests cover rendered frames at 44.1/48/96 kHz, pause, rate/deck waits and the incoming deck's real crossfade position. Word fills use this clock directly, with no CSS delay or anticipatory cue.

These are substantiated timing defects, not proof that they explain every audible mismatch reported on the installed app. The native position counts frames rendered into the output, not frames acoustically heard. Exclusive WASAPI requests at least 40 ms per buffer; driver/device buffering can add latency, and shared output/Bluetooth have their own queues. No arbitrary latency subtraction was introduced. Physical output delay was not measured, and no representative user song or measured offset was supplied. Source timestamps may also be inaccurate or describe another recording. There is no separate saved global lyrics-offset preference in the current code; an LRC file's own `[offset:ms]` remains authoritative and applies to both line and word timestamps (positive shows earlier, negative later). DSP applies in the sample path; crossfade tests verify that the incoming song retains the amount already rendered rather than restarting its displayed clock at zero.

## Source coverage

| Source | Word timing supported when supplied | Fallback |
| --- | --- | --- |
| Same-name `.lrc` sidecar | Enhanced LRC `<mm:ss.xx>` absolute timestamps, including millisecond and colon-fraction forms accepted by the parser | Ordinary `[mm:ss.xx]` line timestamps |
| Embedded Lyrics text tag | The same Enhanced LRC text syntax, passed through by the native tag reader | Line LRC or plain text |
| Optional LRCLIB `syncedLyrics` | The same markers if actually present in the response | Line timing when only line timestamps are supplied; no promise of word coverage from the service |

Multiple repeated `[]` stamps on one line do not imply repeated absolute word timestamps: those ambiguous lines use line timing. Backward, before-line or invalid-second word timestamps also fall back. This change does not add TTML, ID3 binary SYLT, proprietary lyric formats, another online provider or transcription/alignment. Online lookup remains opt-in.

## Validation

| Check | Result |
| --- | --- |
| `npm test` | 68 tests passed in 10 files. Includes source boundaries, Unicode/punctuation, offsets, repetitions, invalid timing and bounded playback-clock mapping. |
| `npm run build` | TypeScript and Vite production build passed. |
| Browser components | 17 Now Playing checks and 5 existing collection/filter checks passed in headless Edge. Covers exact onset, word fill, paused/buffering/stalled clocks, unchanged snapshots, seeking, track/request races, tab return, manual scrolling, volume/mute, focus, reduced motion, repeated navigation and 880x620 layout. |
| Rust library tests | 100 passed, 4 environment/manual tests ignored by default. |
| Rust formatting / whitespace | `cargo fmt -- --check` and `git diff --check` passed. |
| Clippy | Passed with the same six pre-existing warnings recorded in the correctness review. |
| Native build | Tauri debug build using the production frontend, separate QA identifier and no installer bundle passed. |
| Native lyrics integration | All 6 checks in `tools/check-native-lyrics.mjs` passed with generated silent FLAC, synthetic artwork and lyric sidecars, in a disposable profile. Native volume/mute, offset word fills, exact paused boundaries, playing snapshot mapping, pause/resume, track/tab changes and minimum-window layout passed. |
| Full native UI | All 28 existing `tools/qa.mjs` scenarios passed on the disposable generated library. |
| Native restart | Restored queue, current track, position, favorite and playlist; playback stayed paused. |

The first native tab-return assertion read UI state before the next asynchronous engine event. The harness now waits for the sought line before checking navigation; the complete rerun passed. Screenshots were reviewed at desktop and the supported minimum window size. Browser/native fixture artifacts are kept under ignored output/disposable QA folders, not published as personal library content.

Run browser checks with `npm run test:browser`. For native checks, run a separate QA build with `SLATE_MUSIC_DATA_DIR` pointing to a disposable profile, `SLATE_MUSIC_LIBRARY` to the six generated silent `Fixture Song 1` through `Fixture Song 6` FLAC files by `Slate Test Artist`, and WebView2 remote debugging enabled. Copy `tests/fixtures/lyrics-enhanced.lrc` beside `song-1.flac` as `song-1.lrc`, and `lyrics-lines.lrc` beside `song-2.flac` as `song-2.lrc`. Set `SLATE_QA_LYRICS_DIR` to that sole indexed folder and run `node tools/check-native-lyrics.mjs` (default CDP port 9327; override with `SLATE_CDP`). The script checks the fixture folder and metadata before changing playback.

## Remaining limits

Physical DAC sample-rate switching, device disconnect/recovery and acoustic latency were not tested. Exclusive volume/timing coverage is from native mixer tests, not a physical DAC session. Live lyric-service availability and timestamp quality were not verified; network service tests in the earlier review use synthetic responses. No personal-library decode or manual taskbar glyph export was performed. The earlier review's generated codec and gapless tests remain applicable; they are separate from acoustic synchronization.

The Windows CI workflow now also runs for `fix/**` pushes so the published branch receives verification without merging. No release, deployment, installer replacement or merge is part of this change. Neither this work nor the earlier correctness review establishes that the repository is entirely bug-free.
