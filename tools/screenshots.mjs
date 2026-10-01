// Captures the website screenshots from the real interface, with a fictional demo library and
// a simulated native backend (no music, profiles or personal data are involved).
//
//   npm run dev          (in another terminal)
//   node tools/screenshots.mjs [http://127.0.0.1:1420] [site/assets]
//
// Every album, song, lyric and cover here is original to this project.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const base = process.argv[2] || 'http://127.0.0.1:1420';
const out = process.argv[3] || 'site/assets';
mkdirSync(out, { recursive: true });

const albums = [
  {
    name: 'Blue Hour', artist: 'Meridian', year: 2024, bits: 24, rate: 96000, look: 'sun',
    colors: ['#1d2a48', '#e9dfc0', '#4b6a9c'],
    songs: ['First Light', 'Blue Hour', 'In Between', 'A Quiet Place', 'Open Water', 'Paper Boats', 'Long Way Round', 'Afterglow'],
  },
  {
    name: 'After the Rain', artist: 'Mira Vale', year: 2023, look: 'bars',
    colors: ['#4a2f45', '#e9a9cf', '#a86a95'],
    songs: ['Petrichor', 'Umbrella Weather', 'Glass Streets', 'Slow Clouds', 'After the Rain', 'Gutter Rivers', 'Puddle Light', 'Dry by Morning'],
  },
  {
    name: 'Night Drive', artist: 'Northline', year: 2025, look: 'lines',
    colors: ['#173a36', '#d9e9a4', '#5fa894'],
    songs: ['Ignition', 'Night Drive', 'Mile Markers', 'Sodium Lights', 'Exit 41', 'Overpass', 'Radio Static', 'Home Before Dawn'],
  },
  {
    name: 'Slow Light', artist: 'Solenne', year: 2022, bits: 24, rate: 48000, look: 'arches',
    colors: ['#7a3b22', '#f0b46a', '#c9764a'],
    songs: ['Amber', 'Slow Light', 'Late September', 'Honey & Dust', 'Warm Static', 'The Long Table', 'Evening Field', 'Last Sun'],
  },
  {
    name: 'Soft Focus', artist: 'Cedar House', year: 2021, look: 'rings',
    colors: ['#4d4a35', '#d8d2a0', '#a29c66'],
    songs: ['Soft Focus', 'Film Grain', 'Polaroid', 'Old Friends', 'Light Leak', 'Darkroom', 'Developing', 'Contact Sheet'],
  },
  {
    name: 'Paper Lanterns', artist: 'Aurora Lane', year: 2026, look: 'dots',
    colors: ['#2b2340', '#f2c97d', '#8e74c4'],
    songs: ['Lantern Song', 'Festival', 'Rooftops', 'Paper Lanterns', 'Night Market', 'Fireflies', 'River of Lights', 'Last Train'],
  },
];
const hash = (s) => createHash('sha256').update(s).digest('hex');
const esc = (s) => s.replace(/&/g, '&amp;');

/** An original geometric cover for each album, as SVG. */
function cover(a) {
  const [bg, fg, mid] = a.colors;
  const shapes = {
    sun: `<circle cx="300" cy="270" r="92" fill="${fg}"/>` +
      Array.from({ length: 13 }, (_, i) => `<rect x="${110 + Math.abs(6 - i) * 9}" y="${300 + i * 15}" width="${380 - Math.abs(6 - i) * 18}" height="5" fill="${mid}"/>`).join('') +
      Array.from({ length: 7 }, (_, i) => `<rect x="130" y="${190 + i * 13}" width="340" height="4" fill="${mid}" opacity=".7"/>`).join(''),
    bars: Array.from({ length: 9 }, (_, i) => `<rect x="${132 + i * 38}" y="${210 + ((i * 37) % 70)}" width="16" height="${220 - ((i * 37) % 70) * 1.4}" rx="8" fill="${i % 2 ? mid : fg}"/>`).join(''),
    lines: Array.from({ length: 16 }, (_, i) => `<line x1="110" y1="${170 + i * 18}" x2="490" y2="${130 + i * 18}" stroke="${mid}" stroke-width="4"/>`).join('') +
      `<circle cx="340" cy="300" r="66" fill="${fg}"/>`,
    arches: Array.from({ length: 6 }, (_, i) => `<path d="M ${150 + i * 18} 380 A ${150 - i * 18} ${150 - i * 18} 0 0 1 ${450 - i * 18} 380" fill="none" stroke="${i % 2 ? mid : fg}" stroke-width="12"/>`).join('') +
      `<rect x="140" y="390" width="320" height="44" fill="${fg}"/>`,
    rings: `<circle cx="250" cy="270" r="105" fill="none" stroke="${fg}" stroke-width="16"/><circle cx="350" cy="320" r="95" fill="none" stroke="${fg}" stroke-width="16"/><circle cx="290" cy="380" r="50" fill="none" stroke="${mid}" stroke-width="14"/>`,
    dots: Array.from({ length: 20 }, (_, i) => `<circle cx="${150 + (i % 5) * 75}" cy="${190 + Math.floor(i / 5) * 75}" r="${16 + ((i * 7) % 3) * 8}" fill="${i % 3 ? fg : mid}" opacity="${0.55 + ((i * 5) % 4) * 0.15}"/>`).join(''),
  };
  return `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600" viewBox="0 0 600 600">
<rect width="600" height="600" fill="${bg}"/>${shapes[a.look]}
<text x="34" y="64" font-family="Inter, Segoe UI, sans-serif" font-size="30" fill="${fg}" opacity=".92">${esc(a.name)}</text>
<text x="34" y="566" font-family="Inter, Segoe UI, sans-serif" font-size="15" fill="${fg}" opacity=".7">${esc(a.artist)}</text></svg>`;
}

// The library: 48 songs. Times are fixed so every capture comes out the same.
const NOW = Date.UTC(2026, 9, 1, 18, 30);
const DAY = 86400000;
let seed = 7;
const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const tracks = albums.flatMap((a, ai) =>
  a.songs.map((title, i) => ({
    id: hash(`${a.name}/${title}`),
    path: `D:\\Music\\${a.artist}\\${a.name}\\${String(i + 1).padStart(2, '0')} ${title}.flac`,
    folder: 'D:\\Music',
    title,
    artist: a.artist,
    album: a.name,
    albumArtist: a.artist,
    year: a.year,
    originalYear: 0,
    track: i + 1,
    disc: 1,
    duration: 178 + ((ai * 31 + i * 47) % 120),
    format: 'FLAC',
    sampleRate: a.rate || 44100,
    bitDepth: a.bits || 16,
    artwork: hash(a.name),
    favorite: [0, 4, 9, 13, 18, 26, 33, 41].includes(ai * 8 + i),
    missing: false,
    playCount: 0,
    lastPlayed: 0,
    added: NOW - (ai * 23 + i) * DAY,
    size: 30_000_000,
  })),
);
// A year of listening, heavier on some albums, plus a few plays on this date in 2025.
const plays = [];
for (let d = 273; d >= 0; d--)
  for (let n = Math.floor(random() * 9); n > 0; n--) {
    const pick = Math.floor(Math.pow(random(), 1.7) * tracks.length);
    plays.push([tracks[pick].id, NOW - d * DAY - Math.floor(random() * 50000000)]);
  }
for (const i of [3, 12, 27]) plays.push([tracks[i].id, Date.UTC(2025, 9, 1, 20, i)]);
plays.sort((a, b) => a[1] - b[1]);
for (const [id, at] of plays) {
  const t = tracks.find((x) => x.id === id);
  t.playCount += 1;
  t.lastPlayed = Math.max(t.lastPlayed, at);
}
const playing = tracks[0];
const entry = (t) => ({ trackId: t.id, title: t.title, artist: t.artist, duration: t.duration, status: 'available' });
const snapshot = {
  tracks,
  collections: [
    { id: 'p1', name: 'Slow mornings', kind: 'playlist', created: 1, entries: [0, 9, 17, 25, 33, 41, 4, 12].map((i) => entry(tracks[i])) },
    { id: 'p2', name: 'After hours', kind: 'playlist', created: 2, entries: [16, 18, 21, 23, 40, 46, 47].map((i) => entry(tracks[i])) },
    { id: 's1', name: 'Forgotten favourites', kind: 'smart', created: 3, entries: [],
      rules: { match: 'all', rules: [{ field: 'favorite', op: 'is', value: true }, { field: 'lastPlayed', op: 'olderThanDays', value: 30 }], sort: 'random', limit: 0 } },
  ],
  folders: ['D:\\Music'],
  settings: { autoCheck: false, autoDownload: false, showListening: true, lookupYears: false, lookupLyrics: true, lookupArtists: false, scrobble: true, discordPresence: true },
  scan: { scanning: false, processed: 48, changed: 0, errors: [], lastScan: NOW },
  loudnessMeasured: 48,
  playback: {
    queue: tracks.slice(0, 8).map((t) => t.id),
    cursor: 0,
    currentId: playing.id,
    position: 67,
    duration: playing.duration,
    playing: false,
    volume: 1,
    shuffle: false,
    repeat: 'off',
    crossfade: 0,
    error: null,
    engineReady: true,
    sleepAt: null,
    sleepEndOfTrack: false,
    levelling: 'off',
    smartCrossfade: true,
    eq: { enabled: false, preamp: 0, bands: Array(10).fill(0), preset: 'Flat' },
    outputDevice: null,
    exclusive: true,
    output: { device: 'Studio DAC', sampleRate: 96000, channels: 2, fallback: false, exclusive: true, bits: 24 },
    gainDb: null,
    gainKind: 'off',
  },
  spotify: { connected: false, playlistAccess: false, likedAccess: false, topAccess: false, clientId: null, redirectUri: 'http://127.0.0.1:43829/callback' },
};
const lyrics = `[00:12.00]Morning finds the window first
[00:18.40]Grey to gold along the street
[00:25.10]Every light I left still burning
[00:31.60]Fading softly at my feet
[00:39.00]
[00:44.20]Hold on to the quiet hour
[00:50.80]Before the city wakes
[00:57.30]Hold on to the blue that's leaving
[01:03.90]Every colour that it takes
[01:10.50]First light, first light
[01:16.80]Carry me across the line
[01:23.20]First light, first light
[01:29.70]Everything is yours and mine`;

/** Runs in the page before the app: answers its calls the way the native app would. */
function backend({ snapshot, plays, lyrics, now }) {
  const RealDate = Date;
  // A fixed "today", so Home and Your year always show the same demo.
  globalThis.Date = class extends RealDate {
    constructor(...a) { super(...(a.length ? a : [now])); }
    static now() { return now; }
  };
  const callbacks = new Map();
  let next = 1;
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
    transformCallback(cb) { const id = next++; callbacks.set(id, cb); return id; },
    unregisterCallback(id) { callbacks.delete(id); },
    convertFileSrc: (p) => p,
    async invoke(cmd, args) {
      switch (cmd) {
        case 'plugin:event|listen': return args.handler;
        case 'snapshot': return structuredClone(snapshot);
        case 'playback': return structuredClone(snapshot.playback);
        case 'listening_history': return plays;
        case 'song_lyrics': return { synced: lyrics, plain: null, instrumental: false, source: 'file' };
        case 'artist_info': return { found: false };
        case 'artist_photos': return {};
        case 'audio_devices': return { devices: ['Studio DAC', 'Speakers'], default: 'Studio DAC' };
        case 'lastfm_status': return { configured: true, connected: true, user: 'demo', waiting: false, pending: 0, problem: null };
        case 'discord_status': return { clientId: '1555080359019020409', customId: null, connected: true, problem: null };
        default: return null;
      }
    },
  };
}

const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const page = await browser.newPage({ viewport: { width: 1440, height: 940 } });
page.on('pageerror', (e) => console.error('page error:', e.message));
const covers = Object.fromEntries(albums.map((a) => [hash(a.name), cover(a)]));
await page.route('http://art.localhost/**', (route) => {
  const id = new URL(route.request().url()).pathname.slice(1).replace(/-xl$/, '');
  const svg = covers[id];
  return svg
    ? route.fulfill({ status: 200, contentType: 'image/svg+xml', headers: { 'Access-Control-Allow-Origin': '*' }, body: svg })
    : route.fulfill({ status: 404, body: '' });
});
await page.addInitScript(backend, { snapshot, plays, lyrics, now: NOW });
await page.emulateMedia({ reducedMotion: 'reduce' });
await page.goto(base);
await page.locator('.home-hero, .page-heading').first().waitFor();
await page.waitForTimeout(600);

const shot = async (name) => {
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${out}/player-${name}.png` });
  console.log(`saved ${out}/player-${name}.png`);
};
const nav = async (name) => {
  await page.locator(`.nav-item[aria-label="${name}"]`).click();
  await page.waitForTimeout(300);
};

await shot('home');
await nav('Albums');
await shot('albums');
await page.locator('.album-card', { hasText: 'Blue Hour' }).first().click();
await shot('album');
await nav('Your year');
await shot('year');
await nav('Home');
await page.keyboard.press('Control+l');
await page.locator('.now-playing, [aria-label="Now Playing"]').first().waitFor();
await shot('now-playing');
await page.getByRole('button', { name: /signal path/i }).first().click().catch(() => {});
await shot('signal-path');
await page.keyboard.press('Escape');
await page.keyboard.press('Control+k');
await page.keyboard.type('blue');
await shot('command-bar');

// The Blue Hour cover, for the website's matching illustration.
const art = await browser.newPage({ viewport: { width: 640, height: 640 } });
await art.setContent(`<body style="margin:0">${cover(albums[0]).replace('width="600" height="600"', 'width="640" height="640"')}</body>`);
await art.screenshot({ path: `${out}/demo-blue-hour.png` });
console.log(`saved ${out}/demo-blue-hour.png`);

// The share card for links to the website (1200 × 630).
const data = (file, type) => `data:${type};base64,${readFileSync(file).toString('base64')}`;
const card = await browser.newPage({ viewport: { width: 1200, height: 630 } });
await card.setContent(`<!doctype html><style>
@font-face { font-family: Inter; src: url(${data('site/assets/inter-latin.woff2', 'font/woff2')}); font-weight: 100 900; }
body { margin: 0; width: 1200px; height: 630px; overflow: hidden; background: radial-gradient(circle at 75% 40%, #1c1a24, #0a0a0b 70%); color: #ededf0; font-family: Inter, sans-serif; }
.brand { position: absolute; left: 58px; top: 50px; display: flex; align-items: center; gap: 14px; font-size: 25px; letter-spacing: -0.02em; }
.brand img { width: 40px; height: 40px; border-radius: 10px; }
.brand span { color: #b8b3c2; }
h1 { position: absolute; left: 56px; top: 136px; margin: 0; font-size: 60px; line-height: 1.04; letter-spacing: -0.045em; font-weight: 560; }
h1 em { font-style: normal; color: #a49fb0; }
p { position: absolute; left: 58px; top: 320px; width: 440px; margin: 0; font-size: 24px; line-height: 1.45; color: #bdb8c7; }
.foot { position: absolute; left: 58px; bottom: 46px; font-size: 16px; color: #baa3e4; }
.frame { position: absolute; left: 600px; top: 116px; width: 860px; border-radius: 14px; overflow: hidden; border: 1px solid #ffffff1f; box-shadow: 0 40px 100px #000c; }
.frame img { display: block; width: 100%; }
.note { position: absolute; right: 40px; top: 78px; font-size: 13px; color: #8f8a99; }
</style>
<div class="brand"><img src="${data('site/assets/icon.png', 'image/png')}" alt="">slate&nbsp;<span>music</span></div>
<h1>Your music.<br><em>In its own space.</em></h1>
<p>Synced lyrics, bit-perfect sound and your year in music, for the collection you own.</p>
<div class="foot">For Windows · Free &amp; open source</div>
<div class="frame"><img src="${data(`${out}/player-now-playing.png`, 'image/png')}" alt=""></div>
<div class="note">Actual app · Demo collection</div>`);
await card.waitForTimeout(300);
await card.screenshot({ path: `${out}/social-preview.png` });
console.log(`saved ${out}/social-preview.png`);
await browser.close();
