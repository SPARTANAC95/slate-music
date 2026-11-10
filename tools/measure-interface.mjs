// Measures how the interface copes with a large library: the production build, a synthetic
// library and a stand-in for the native backend. Prints main-thread time for the things done
// all day (playback updates, opening pages, searching, a song finishing).
//
//   npm run build && node tools/measure-interface.mjs [songs=20000]
import { chromium } from 'playwright';
import { preview } from 'vite';

const SONGS = Number(process.argv[2] || 20000);
const server = await preview({ preview: { port: 0, host: '127.0.0.1' } });
const url = server.resolvedUrls.local[0];
const browser = await chromium.launch({ headless: true, channel: process.env.SLATE_BROWSER_CHANNEL || 'msedge' });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 940 } });
  page.setDefaultTimeout(60000);
  page.on('pageerror', (error) => console.error('page error:', error.message));
  await page.addInitScript((count) => {
    const DAY = 864e5, now = Date.now();
    const tracks = Array.from({ length: count }, (_, i) => ({
      id: 't' + i, path: `D:/Music/Artist ${Math.floor(i / 120)}/Album ${Math.floor(i / 12)}/${i % 12} Song number ${i}.flac`,
      folder: 'D:/Music', title: `Song number ${i}`, artist: `Artist ${Math.floor(i / 120)}`,
      album: `Album ${Math.floor(i / 12)}`, albumArtist: `Artist ${Math.floor(i / 120)}`,
      year: 1970 + (i % 50), track: (i % 12) + 1, disc: 1, duration: 180 + (i % 90), format: i % 7 ? 'FLAC' : 'MP3',
      sampleRate: 44100, bitDepth: i % 7 ? 16 : 0, artwork: null, favorite: i % 40 === 0, missing: false,
      playCount: i % 9 === 0 ? (i % 5) + 1 : 0, lastPlayed: i % 9 === 0 ? now - (i % 300) * DAY : 0,
      added: now - (i % 400) * DAY, size: 3e7, originalYear: 0,
    }));
    const entry = (t) => ({ trackId: t.id, title: t.title, artist: t.artist, duration: t.duration, status: 'available' });
    const queue = tracks.slice(0, 200).map((t) => t.id);
    const state = {
      tracks,
      collections: [
        ...Array.from({ length: 12 }, (_, n) => ({ id: 'p' + n, name: 'Playlist ' + n, kind: 'playlist', created: n, entries: tracks.slice(n * 300, n * 300 + 250).map(entry) })),
        { id: 's1', name: 'Forgotten favourites', kind: 'smart', created: 20, entries: [],
          rules: { match: 'all', rules: [{ field: 'favorite', op: 'is', value: true }, { field: 'lastPlayed', op: 'olderThanDays', value: 90 }], sort: 'random', limit: 0 } },
        { id: 's2', name: 'Most played', kind: 'smart', created: 21, entries: [],
          rules: { match: 'all', rules: [{ field: 'plays', op: 'gt', value: 0 }], sort: 'plays', limit: 50 } },
      ],
      folders: ['D:/Music'],
      settings: { autoCheck: false, autoDownload: false, showListening: true, lookupYears: false, lookupLyrics: false, lookupArtists: false },
      scan: { scanning: false, processed: count, changed: 0, errors: [], lastScan: now },
      loudnessMeasured: count,
      spotify: { connected: false, playlistAccess: false, likedAccess: false, topAccess: false, clientId: null, redirectUri: '' },
      playback: {
        queue, cursor: 3, currentId: queue[3], position: 12, duration: tracks[3].duration, playing: true, clockRunning: true,
        at: now, volume: 0.7, shuffle: false, repeat: 'off', crossfade: 4, error: null, engineReady: true, sleepAt: null,
        sleepEndOfTrack: false, levelling: 'off', smartCrossfade: true, eq: { enabled: false, preamp: 0, bands: Array(10).fill(0), preset: 'Flat' },
        outputDevice: null, output: { device: 'Speakers', sampleRate: 48000, channels: 2, fallback: false }, gainDb: null, gainKind: 'off',
      },
    };
    const plays = Array.from({ length: 4000 }, (_, i) => [tracks[(i * 37) % count].id, now - i * 3600e3]);
    const callbacks = new Map(), listeners = new Map();
    let callbackId = 0;
    window.__measure = {
      state,
      emit(event, payload) {
        for (const id of listeners.get(event) ?? []) callbacks.get(id)?.({ event, payload });
      },
      // What the engine sends about four times a second while a song plays.
      tick() {
        state.playback = { ...state.playback, position: state.playback.position + 0.25, at: Date.now() };
        this.emit('playback', JSON.parse(JSON.stringify(state.playback)));
      },
    };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      transformCallback(callback) { callbacks.set(++callbackId, callback); return callbackId; },
      unregisterCallback(id) { callbacks.delete(id); },
      convertFileSrc: (path) => path,
      async invoke(command, args = {}) {
        // The native side answers in JSON: parsing it is part of the cost.
        if (command === 'snapshot') return JSON.parse(JSON.stringify(state));
        if (command === 'listening_history') return plays;
        if (command === 'artist_photos') return {};
        if (command === 'plugin:event|listen') {
          listeners.set(args.event, [...(listeners.get(args.event) ?? []), args.handler]);
          return args.handler;
        }
        if (command === 'song_lyrics') return { synced: null, plain: null, source: null, instrumental: false };
        return null;
      },
    };
  }, SONGS);

  const client = await page.context().newCDPSession(page);
  await client.send('Performance.enable');
  const metrics = async () => Object.fromEntries((await client.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
  /** Runs `work`, lets the page settle, and reports the main-thread time it took. */
  const measure = async (name, work, per = 1) => {
    const before = await metrics();
    const started = Date.now();
    await work();
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, 50)))));
    const after = await metrics();
    const ms = (key) => ((after[key] - before[key]) * 1000) / per;
    console.log(
      `${name.padEnd(46)} ${ms('TaskDuration').toFixed(1).padStart(8)} ms busy  (script ${ms('ScriptDuration').toFixed(1)}, layout ${ms('LayoutDuration').toFixed(1)}, style ${ms('RecalcStyleDuration').toFixed(1)})` +
        (per === 1 ? `  ${Date.now() - started} ms elapsed` : `  each of ${per}`),
    );
    return ms('TaskDuration');
  };
  const ticks = (n) => page.evaluate(async (n) => {
    for (let i = 0; i < n; i++) {
      window.__measure.tick();
      await new Promise((r) => setTimeout(r, 30));
    }
  }, n);
  const nav = (name) => page.locator(`.nav-item[aria-label="${name}"]`).click();

  console.log(`${SONGS} songs, production build\n`);
  await measure('open the app (to Home)', async () => {
    await page.goto(url);
    await page.locator('.home-hero').waitFor();
  });
  const nodes = () => page.evaluate(() => document.querySelectorAll('*').length);
  console.log('  elements on the page:', await nodes());
  await measure('playback update, on Home', () => ticks(40), 40);
  await measure('open Songs', async () => { await nav('Songs'); await page.locator('.track-row').first().waitFor(); });
  console.log('  elements on the page:', await nodes());
  await measure('playback update, on Songs', () => ticks(40), 40);
  await measure('scroll Songs by 40 screens', async () => {
    for (let i = 0; i < 40; i++) { await page.mouse.move(700, 600); await page.mouse.wheel(0, 900); await page.waitForTimeout(16); }
  });
  await measure('type a search, per letter', async () => {
    await page.getByPlaceholder('Search your music').click();
    await page.keyboard.type('song number 1234', { delay: 60 });
    await page.waitForTimeout(400);
  }, 16);
  await measure('clear the search', async () => { await page.getByPlaceholder('Search your music').fill(''); await page.waitForTimeout(300); });
  await measure('open Albums', async () => { await nav('Albums'); await page.locator('.album-card').first().waitFor(); });
  console.log('  elements on the page:', await nodes());
  await measure('playback update, on Albums', () => ticks(40), 40);
  await measure('open Artists', async () => { await nav('Artists'); await page.waitForTimeout(300); });
  console.log('  elements on the page:', await nodes());
  await measure('open Playlists', async () => { await nav('Playlists'); await page.waitForTimeout(300); });
  await measure('open Your year', async () => { await nav('Your year'); await page.waitForTimeout(500); });
  await measure('open Favorites', async () => { await nav('Favorites'); await page.waitForTimeout(300); });
  await measure('back to Home', async () => { await nav('Home'); await page.locator('.home-hero').waitFor(); });
  await measure('a song finishes (library is read again)', async () => {
    await page.evaluate(() => window.__measure.emit('history-changed', null));
    await page.waitForTimeout(600);
  });
  await measure('heart the playing song', async () => {
    await page.getByRole('button', { name: 'Favorite playing song', exact: true }).click();
    await page.waitForTimeout(200);
  });
  await measure('open the command bar and type', async () => {
    await page.keyboard.press('Control+k');
    await page.keyboard.type('album 12', { delay: 60 });
    await page.waitForTimeout(300);
    await page.keyboard.press('Escape');
  }, 8);
  await measure('open Now Playing', async () => { await page.keyboard.press('Control+l'); await page.locator('.now-playing').waitFor(); });
  await measure('playback update, in Now Playing', () => ticks(40), 40);
  const heap = await page.evaluate(() => performance.memory?.usedJSHeapSize);
  if (heap) console.log(`\nJavaScript memory in use: ${(heap / 1e6).toFixed(0)} MB`);
} finally {
  await browser.close();
  server.httpServer.close();
}
