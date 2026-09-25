# Architecture

## Boundaries

React renders real state obtained through narrowly scoped Tauri commands. Rust owns indexing, SQLite, playback, credential encryption and Spotify requests. No music file write operation is exposed. Artwork uses a custom protocol that accepts a hexadecimal cache key rather than arbitrary paths. The content security policy disallows remote scripts and embedded pages.

`src/App.tsx` owns navigation and session presentation; `components.tsx` contains shared accessible controls and virtualized rows. `library.ts` groups and sorts metadata. `matching.ts` implements conservative Spotify matching. `ImportPanel.tsx`, `SettingsPanel.tsx` and `updater.ts` own their respective flows.

`src-tauri/src/lib.rs` wires native commands and windows. `db.rs` owns the SQLite schema and migrations. `library.rs` scans and watches directories on worker threads, uses Lofty to read tags, and caches resized artwork by content hash. `audio.rs` owns a continuously running Rodio output mixer and serializes queue mutations. `spotify.rs` implements PKCE, loopback authorization, DPAPI token storage, refresh and paginated album retrieval.

## Indexing and data

Files are identified by their absolute path. Modification time and size avoid reading unchanged tags. Folder removal only marks retained entries unavailable. A file moved externally is treated as a new path; favorites do not automatically follow renamed files. Album grouping uses album title and album artist (falling back to track artist). Disc and track numbers order multidisc albums. Possible duplicates are shown conservatively rather than deleted.

The scan accumulates results away from the rendering thread and commits to SQLite. Filesystem events trigger debounced incremental scans. Errors remain visible in Settings. Very large libraries have virtualized song rows; the metadata catalog is currently loaded into memory, so libraries with hundreds of thousands of entries have not been benchmarked. Changing only an external cover image may require an audio metadata change to refresh the existing cache.

SQLite WAL with full synchronization stores a migration version, tracks, application state and collections. Playback state is saved periodically and during native shutdown. History is capped at 20,000 entries. Restoration explicitly pauses audio. Data survives replacing the application binaries.

## Audio

Each deck streams a decoder through a 48 kHz, stereo format adapter. A worker preloads the next decoder; the output mixer crosses boundaries without reopening the Windows stream. Crossfade linearly blends the tail and head for the chosen duration. Gapless uses the same mixer with no overlap. Decoder seeks rebuild the deck at the requested position. Output device errors pause playback and trigger reconnection attempts.

This release measures sample continuity for contiguous 48 kHz FLAC fixtures. It does not promise gapless decoding for every unusual encoder/container combination or bit-perfect, multichannel or exclusive-mode output. SMTC carries track metadata and playback actions; the mini-player shares the same native engine.

## Updates and trust

Only HTTPS production endpoints are configured. Tauri checks the signed artifact and its signed version against the embedded public key. No private signing key ships in the app. A debug-only verification command permits loopback fixture URLs; release builds reject that command and never enable insecure updater transport. Downloading does not install. The UI gates installation while playing and requires user action.

Spotify credentials never enter the renderer. OAuth uses a random state and PKCE challenge, binds a loopback listener, and expires after a bounded wait. Album pagination is restricted to the Spotify API host and checks the retrieved total. Import results contain metadata and local track IDs, not audio.
