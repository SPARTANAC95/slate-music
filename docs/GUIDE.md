# Slate Music user guide

A Windows desktop player for your own music. Local files, native audio, an offline library, and a quiet interface inspired by [Slate](https://github.com/SPARTANAC95/slate).

## Install

Download the Windows x64 installer from [Releases](https://github.com/SPARTANAC95/slate-music/releases/latest). Run it, then open **Slate Music** from Start. Choose your music folder on first launch. The player reads your files; it never retags, renames, moves or deletes them.

Windows 10/11 x64 with WebView2 and a working audio output are required. WebView2 is normally already present; installing the runtime on a new PC can require internet. Once installed, library management and playback work offline. The installer has a cryptographically signed updater artifact, but does not have a Windows Authenticode publisher certificate. Windows may show an unknown-publisher warning.

## Listen and organize

- Home, Songs, Albums, Artists, Favorites, Recently Played, Playlists, saved virtual albums and Queue.
- Settings → Playback holds the sound controls: output device, loudness levelling (Smart uses album gain while an album plays in order), smart crossfade and a 10-band equalizer that each output device remembers. Loudness is measured once per song in the background. Now Playing's **Signal path** shows exactly what happens between the file and your speakers or headphones.
- Now Playing (click the song in the player bar or press Ctrl+L) shows a large cover and synced lyrics. Lyrics come from an .lrc file with the same name beside the song, lyrics stored in the file, or LRCLIB, a free lyrics database, unless you switch **Find lyrics online** off in Settings. Lyrics with their own word times (Enhanced LRC, `<mm:ss.xx>` before each word) light up word by word, exactly as sung. Lyrics that only time each line, such as LRCLIB's, light the line being sung as a whole. The view shows only the lyrics; the sliders button at its top right opens **Lyrics options**, which says which timing the song has. **Word by word** there chooses **Exact only** (the default: word by word only where the lyric source timed each word), **On** (every line word by word, with word times inside line-timed lines estimated from how fast the song is sung, which is close but not exact) or **Off** (every line lights as a whole). If a song's lyrics run early or late, **−** and **+** under **Timing** move them in tenths of a second, remembered for that song; for speakers or headphones that play late (Bluetooth), set **Lyrics delay** in Settings → Playback once for that device. Click a line to jump there, or scroll to read ahead and choose **Return to current line** to follow playback again. Volume and mute remain available below the lyrics, using the same level as the main player. Windows' reduced-motion preference disables the flowing transitions.
- Hover over Slate Music's taskbar button for Previous, Play/Pause, Next and Favorite buttons in the preview.
- Right-click a song or album for Play next, Add to queue, Add to playlist, Go to album or artist, Favorite and Show in File Explorer. The Queue page can save the queue as a playlist or clear everything after the current song. The moon button beside the volume sets a sleep timer.
- Search titles, artists and albums; small typos are forgiven, and matching artists and albums appear above the songs. Sort and filter songs, including unavailable files and potential duplicates. Album order respects disc and track numbers.
- Click a song row to pick it; Ctrl+click adds or removes songs and Shift+click picks a range (Ctrl+A picks the whole list). With several picked, a bar appears with Play, Play next, Add to queue, Add to playlist and Favorite; in the queue and your own playlists, Delete removes them. Esc clears the pick.
- Drag songs or albums onto a playlist in the sidebar to add them, onto Favorites to heart them, onto Playlists to start a new playlist, or onto Up next to queue them. Drag rows in the queue or one of your playlists to reorder them.
- Click a column heading (Title, Album, Year, Time) to sort by it and click again to reverse. On albums, playlists and search results, # returns to their own order. Songs, Favorites, Recently played and each playlist remember how you sorted them, and every list remembers where you scrolled.
- Press Ctrl+K anywhere for the command bar: type a song, album, artist, playlist or action (for example "shuffle" or "sleep") and press Enter.
- Home suggests albums to jump back into, recent additions, songs you played on this day in earlier years and favourites you have not heard in a while. **Your year** is a private year in review built from your listening history on this PC.
- Smart playlists (Playlists → **New smart playlist**) fill themselves from rules such as "Favorite is yes" and "Last played not in the last 90 days". Start from a preset or build your own; open one and choose **Edit rules** to change it.
- Artist pages show a photo and a short bio from Wikipedia when **Show artist photos and bios** is on in Settings. Each artist is looked up once when you open their page; only the name is sent.
- Add songs to a playlist using its folder button. Open a playlist and choose **Edit playlist** to rename, reorder or remove entries. This only changes Slate Music's database.
- Double-click a song or use its play button. Reorder upcoming songs in Queue. Play/pause, previous/next, seeking, volume, shuffle and repeat work with the native audio engine.
- Use the mini-player or Windows media controls. The app restores its queue and position paused, including after an update.
- A new library starts with a 4-second crossfade between songs and loudness levelling off; both are in Settings → Playback (crossfade from 2 to 12 seconds, or off). With smart crossfade on, as it is to begin with, an album played in order stays gapless, and with crossfade off everything is gapless.
- Removing a heart shows **Undo** for a few seconds. If several songs lost their hearts in the last 30 days, the Favorites page offers **Restore them**.
- Settings controls watched folders, rescanning, Spotify setup and updates. Disconnected drives retain their entries as unavailable; reconnect and rescan to restore them. Songs you move or rename inside a watched folder are recognized and keep their favorites, plays and playlist places. Settings can remove songs that stay unavailable.
- The Year column shows when each song was first released. Files only carry the year of the album they are on, so compilations and remasters show that album year dimmed. Turn on **Find each song's original release year** in Settings to look songs up on MusicBrainz, a free music database: only artists and titles are sent, about one song per second, and your files are never changed. Songs not found are tried again after 60 days.
- Album art comes from the file itself, or from an image in the album folder: `cover.jpg`, `folder.jpg`, `front.jpg`, any image named like a front cover, or the folder's only image (e.g. `Artist - Album [2008].jpg`). Songs in `CD1`/`Disc 2` folders also use the album folder's image.

| Shortcut | Action |
|---|---|
| Space | Play / pause |
| Left / Right | Seek 5 seconds |
| Ctrl + Left / Right | Previous / next |
| Ctrl + K | Command bar: search and actions |
| Ctrl + L | Now Playing |
| Ctrl + M | Mini-player |
| Ctrl + A | Pick every song in the list |
| Delete | Remove picked songs from the queue or playlist |
| Escape | Close dialog, or clear picked songs |

Shortcuts do not intercept typing in form fields. Standard media keys are routed through Windows system media controls.

### Audio support

Tested decoding: FLAC, MP3, WAV, AAC/M4A, ALAC, Ogg Vorbis, Opus (.opus, and .ogg files that hold Opus) and AIFF. Seeking was tested for the container formats above; raw ADTS AAC seeking depends on its available seek index. WMA, APE, DSD and protected files are not supported in this version, nor are Opus files with more than two channels. Opus is always decoded at 48 kHz, whatever it was recorded at.

Normally the engine mixes decoded audio at 48 kHz in stereo and plays it through Windows' shared output, which allows gapless playback, crossfades and other apps' sounds at the same time.

**Exclusive mode (bit-perfect)** in Settings → Playback gives Slate Music the chosen output device to itself. Each song is sent at its own sample rate (44.1, 48, 88.2, 96, 176.4 or 192 kHz and up, as the device allows) in whole-number samples with as many bits as the file has. Songs at the same rate play gaplessly; a song at another rate reopens the device between songs, with a short silence. Crossfades aren't used. With the volume at 100% and the equalizer and loudness levelling off, the device receives exactly the numbers in the file: Now Playing → Signal path confirms "Bit-perfect", or lists what changes the sound. When a device doesn't take a song's rate, the nearest rate it does take is used and the signal path says so.

While exclusive mode plays, other apps can't make sound through that device. Slate Music lets it go a few seconds after you pause and takes it back when you press play. If Windows doesn't allow exclusive use (Sound settings → the device → Properties → Advanced → "Allow applications to take exclusive control of this device"), or another app holds it, Slate Music says so and plays through Windows instead.

Slate Music follows Windows' default output: plug headphones in or reconnect them and the music moves to them. A device you chose in Settings → Playback is used whenever it is connected, and Slate Music returns to it when it comes back. A device that disconnects pauses playback, so music never suddenly plays out loud through another speaker.

## Spotify playlist import

This feature reads a Spotify playlist's song list and matches it to music you already own. It does not stream Spotify audio or download replacements.

1. Create an app in the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard). Select Web API access.
2. Register the exact redirect URI `http://127.0.0.1:43829/callback`.
3. Add your account under Users Management if required by Development Mode.
4. Paste the **Client ID** in Slate Music Settings and choose **Connect Spotify**. No client secret is used. Sign-in opens your browser and asks permission to read your playlists.
5. Open **Playlists**, choose **Import from Spotify** (or press Ctrl+K and type "Spotify") and pick one of your playlists, or paste an `open.spotify.com/playlist/...` link.
6. Review available, uncertain and missing matches. Correct uncertain songs manually, then save the playlist.

**Your top songs** (this month, last 6 months, last year) are listed next: Spotify's 50 most played songs for that period, saved as a playlist.

Imported playlists, Liked Songs and top songs update themselves each time Slate Music opens (after the library scan): the song list follows Spotify, confirmed matches stay, and newly matched Liked Songs are hearted if that option is on. Switch **Update automatically when Slate Music opens** off in a playlist's edit screen to keep it as it is, or to add, remove and reorder its songs yourself (a playlist that follows Spotify gets its songs from Spotify). Importing the same playlist again updates the earlier import.

**Liked Songs** appears first in the list. Importing it saves a "Liked Songs" playlist and, unless you switch it off on the review screen, adds every matched song to Favorites. Connections made before this feature need one **Reconnect** for it.

Spotify only lets apps read playlists you created or collaborate on. Other people's playlists and Spotify-made ones (Discover Weekly, Today's Top Hits and similar) appear locked; copy their songs into a playlist of your own in Spotify, then import that. Podcast episodes are left out. Connections made before playlist import need one **Reconnect** to grant playlist access.

Only confirmed, available local matches enter the queue. Missing songs stay visible in the saved playlist. Saved playlists work offline. To pick up later changes, open the playlist, choose **Edit playlist**, then **Update from Spotify**: the song list follows Spotify's current order and songs you already matched stay matched. Matching compares normalized title, artist, duration, album and version labels, with conservative handling of duplicate candidates, live recordings, remixes, edits and remasters. Virtual albums saved by earlier versions keep working.

As verified September 25, 2026, Spotify Development Mode requires an active Premium subscription for the app owner and permits up to five authorized users. Spotify controls API availability and quota; some accounts/apps may require further approval. See [quota modes](https://developer.spotify.com/documentation/web-api/concepts/quota-modes), [PKCE authorization](https://developer.spotify.com/documentation/web-api/tutorials/code-pkce-flow) and the [2026 migration guide](https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide). Rate limits and access errors are reported in the app. Live account sign-in requires your own Client ID; no credentials are bundled.

## Last.fm and Discord

Both are off until you switch them on in Settings, and neither needs anything set up first.

**Last.fm scrobbling**

1. In Settings → Last.fm scrobbling, choose **Connect Last.fm**.
2. Choose **Yes, allow access** in the browser. Settings shows "Scrobble to Last.fm as <your name>".

To scrobble through a Last.fm API account of your own instead, choose **Use my own API account**, then **Create an API account**: sign in to Last.fm, give the application a name such as "Slate Music" and a short description (callback URL and homepage can stay empty), submit, and copy the **API key** and **shared secret** into Settings. A copy of Slate Music you build yourself asks for these, because Slate Music's own Last.fm account is only in the released installer.

A song is scrobbled once you have heard half of it or four minutes, whichever comes first; songs under 30 seconds are not. Skipping around or pausing doesn't count as listening. Scrobbles made offline are kept and sent later.

**Discord status**

1. In Settings → Discord status, switch on **Show what I'm listening to on Discord**. Friends see "Listening to Slate Music".
2. Keep Discord open. Under Discord's Activity Privacy, sharing your activity must be allowed.

To show a different name, create an application in the Discord Developer Portal and save its **Application ID** under **Use your own Discord application**; **Use Slate Music's** switches back.

While a song plays, Discord shows the album cover, title, artist and album with a progress bar; paused music shows nothing.

Discord can only show a picture that is on the web, so the cover is not taken from your files: with **Show the album cover** on, Slate Music looks the album up in Apple's iTunes catalogue, then Deezer's, then on MusicBrainz and the Cover Art Archive (the album and artist name are sent), and Discord shows the cover from whichever has one that loads. Each album is looked up once and the cover can appear a few seconds into its first song. It can differ from the cover in your files, and albums that aren't found show the Slate Music icon. Switch it off to always show the icon and look nothing up.

## Privacy and persistence

The SQLite database and artwork cache live in `%APPDATA%\com.spartanac95.slate-music`. The database stores library paths, metadata, favorites, playlists, play counts, history, settings and the paused listening session. SQLite migrations and WAL journaling protect normal restarts. Settings includes a JSON export of favorites and playlists; to back up the full profile, close the app and copy its data directory. Do not publish that directory.

Spotify tokens are encrypted with Windows DPAPI for your Windows account. The app has no analytics. Network access is used only for optional Spotify requests, the optional MusicBrainz year lookup, optional LRCLIB lyrics, optional artist photos and bios (MusicBrainz, Wikidata, Wikipedia and Wikimedia Commons), optional Last.fm scrobbling (artist, title, album, length and when you listened) and update checks/downloads. The optional Discord status is passed only to the Discord app on this PC; its optional album covers are looked up in Apple's iTunes catalogue, Deezer's, and on MusicBrainz and the Cover Art Archive (album and artist name). Disable automatic updates in Settings for a fully offline setup. Music and private library data are not part of this repository or releases.

Updates are checked and downloaded automatically by default. The updater verifies both the artifact signature and signed version. It only installs after you confirm while paused or choose the install option on exit. Installation keeps your database, artwork and settings.

## Develop

Install Node.js 22+, the stable Rust toolchain, Microsoft C++ Build Tools, WebView2 and the [Tauri Windows prerequisites](https://v2.tauri.app/start/prerequisites/).

```powershell
npm ci
npm run dev:app
npm test
npm run test:rust
npm run build
```

The browser-only Vite page is not a simulated library; native commands require Tauri. For an isolated test profile, set `SLATE_MUSIC_DATA_DIR` before launch. Set `SLATE_MUSIC_LIBRARY` on a fresh profile to seed a folder without the first-launch picker. These are optional developer environment variables, not bundled personal paths.

See [architecture](ARCHITECTURE.md), [validation](VALIDATION.md), [release engineering](RELEASING.md) and [changelog](../CHANGELOG.md).

## Build and release

`npm run build:app` produces a per-user NSIS installer and updater signature. Set `TAURI_SIGNING_PRIVATE_KEY` to the signing key contents or a local file path, and optionally `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Never put either value in source control.

GitHub Actions checks every push and pull request. Version tags run tests, build and sign the Windows installer, and publish the manifest and checksums. The repository's encrypted Actions secrets hold the signing material. An update key is distinct from an Authenticode certificate.

## Credits

Tauri, React, TypeScript, SQLite/rusqlite, Rodio/Symphonia, Lofty, notify, Souvlaki, Inter and Lucide power the application. See their respective licenses in installed dependencies and [THIRD_PARTY.md](THIRD_PARTY.md). The original application icon and design study were generated for this project; the study is inspiration, not a screenshot of a working library. Slate was inspected as a design reference and was not modified.

MIT license.

