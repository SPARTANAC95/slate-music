# Contributing to Slate Music

Start with an [issue](https://github.com/SPARTANAC95/slate-music/issues) for a bug, a specific improvement, or a question about an existing feature.

## Report a problem

Include your Slate Music version, Windows version, file format, the steps you took, what you expected and what happened. For playback problems, mention the audio device and whether the problem affects one file or several.

Do not attach music, library databases, Spotify credentials, signing keys or personal folder listings. Remove personal information from screenshots and logs. A short description or a synthetic reproduction is usually enough.

## Work on the app

Follow the [setup guide](docs/GUIDE.md#develop). Set `SLATE_MUSIC_DATA_DIR` to a disposable folder when testing changes that alter playlists, settings or library state. Never use a contributor's personal database as a fixture.

Keep changes focused, describe the user-visible result, and run the checks appropriate to the change. App changes normally need:

```powershell
npm test
npm run build
cargo test --locked --manifest-path src-tauri/Cargo.toml --lib
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
```

Native behavior needs native verification. Browser-only UI checks cannot establish working playback, file watching or persistence. See [validation](docs/VALIDATION.md) for fixture and integration checks.

## Work on the website

The static landing page lives in `site/`. It has no framework build step. Run `node tools/check-site.mjs`, serve that directory locally, and check desktop/mobile layout, keyboard access, screenshot switching and download links. Keep screenshots separate from personal music libraries. See the [presentation guide](docs/PRESENTATION.md).

Contributions are licensed under this repository's MIT license. Do not add third-party music or artwork without the required rights.
