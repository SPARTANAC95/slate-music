# Third-party components

The application is MIT licensed. Dependencies retain their own licenses; exact versions are in `package-lock.json` and `src-tauri/Cargo.lock`. Principal components include:

| Component | License |
|---|---|
| Tauri and official plugins | MIT / Apache-2.0 |
| React | MIT |
| TypeScript | Apache-2.0 |
| Vite | MIT |
| TanStack Virtual | MIT |
| Lucide | ISC |
| Inter | SIL Open Font License 1.1 |
| SQLite | Public domain |
| rusqlite, Rodio | MIT |
| Symphonia | MPL-2.0 |
| ogg (RustAudio) | BSD-3-Clause |
| unsafe-libopus: libopus (Xiph.Org, Skype, Octasic, Jean-Marc Valin, Timothy B. Terriberry, CSIRO, Gregory Maxwell, Mark Borgerding, Erik de Castro Lopo) translated to Rust | BSD-3-Clause |
| Lofty | MIT / Apache-2.0 |
| notify | CC0-1.0 |
| Souvlaki | MIT |
| reqwest, image, md-5, windows | MIT / Apache-2.0 |
| ebur128 | MIT |

Symphonia is used as an unmodified dependency; its source is available from https://github.com/pdeljanov/Symphonia and the matching crates.io package versions. No original music, commercial album artwork or user library database is distributed in this repository. Artwork shown in the app is read from the user's files. Spotify names and marks belong to Spotify; Slate Music is an independent local-file player.

Optional online features use these services only when switched on: MusicBrainz (original years, artist identities and albums), Apple's iTunes Search, Deezer and the Cover Art Archive (album covers in the Discord status), Wikidata, Wikipedia and Wikimedia Commons (artist photos and bios, under their own licenses; each photo keeps a link to its file page), LRCLIB (lyrics), Last.fm (scrobbling, with your own API account) and Discord (the "Listening to" status, through the Discord app on your PC). Slate Music is not affiliated with any of them.
