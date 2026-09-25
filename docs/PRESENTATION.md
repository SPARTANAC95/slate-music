# Public website and repository presentation

The landing page is hosted at **https://SPARTANAC95.github.io/slate-music/**. It lives in `site/` and deploys through `.github/workflows/pages.yml` when those files change. The workflow validates local assets and navigation before publishing only the static site directory. It never packages app profiles or development folders.

## Design and assets

The page uses the application's actual carbon/slate palette, lavender accent and self-hosted Inter variable font. Its screenshot switcher and FAQ work without external libraries. Primary content and download links remain usable with JavaScript disabled. There are no analytics or external font requests. GitHub Pages itself serves the website under GitHub's hosting policies.

- `site/assets/player-home.png`, `player-albums.png`, `player-album.png`, `player-queue.png`: real captures of Slate Music 1.0.1 using an isolated demo profile.
- Demo library: 48 synthetic silent FLAC fixtures across six fictional albums. Artwork was designed for this project. Only screenshots and one original cover illustration are published; fixture audio and runtime databases are excluded.
- `site/assets/social-preview.png`: 1200 × 630 share card for the website's Open Graph metadata. It can also be uploaded as the repository's social preview in GitHub Settings.
- `site/assets/icon.png`: existing original Slate Music app icon.
- `site/assets/inter-latin.woff2`: Inter, with its license beside the font.

Screenshots are identified as a demo collection on the website and in the README. The Spotify matching panel is explicitly labeled as an illustration; it is not a claim of a live import of these fictional albums.

## Maintenance

1. Edit `site/index.html`, `site/styles.css` and `site/site.js`.
2. Update the version and installer links in `site/index.html` when publishing a new app release. The secondary release link always opens the latest GitHub release.
3. Run `node tools/check-site.mjs` and inspect desktop and narrow mobile layouts in a browser. Check screenshot buttons, FAQ keyboard controls and real download targets.
4. Push to `main`; the Pages workflow publishes the updated site.

The app's build, installer, updater feed and SQLite migrations are independent of the website. The website deploy does not create an app release.
