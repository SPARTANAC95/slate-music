// Isolated browser regression checks. No native app, audio device or personal profile is used.
// Run: node tools/check-now-playing.mjs
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

const fixture = `
  import React from 'react';
  import { createRoot } from 'react-dom/client';
  import { flushSync } from 'react-dom';
  import NowPlaying from '/src/NowPlaying.tsx';
  const root = createRoot(document.getElementById('root'));
  const track = {
    id: 'synthetic', title: 'Synthetic lyrics', artist: 'Fixture', album: 'Fixture',
    artwork: null, format: 'FLAC', sampleRate: 48000, bitDepth: 16, year: 0, originalYear: 0,
  };
  let pb = {
    currentId: track.id, position: 1, playing: false, queue: [track.id], cursor: 0,
    volume: 1, gainKind: 'off', output: null,
  };
  let current = track;
  let pending = false;
  window.__TAURI_INTERNALS__ = {
    invoke: async () => pending ? new Promise(() => {}) : {
      synced: '[00:01]First\\n[00:05]Second\\n[00:10]Third\\n[00:15]Fourth',
      plain: null, source: 'file', instrumental: false,
    },
  };
  const render = () => flushSync(() => root.render(React.createElement(NowPlaying, {
    track: current, pb, trackMap: new Map([[track.id, track]]), accent: null,
    transport: null, progress: null, lookupLyrics: false,
    onClose() {}, onFavorite() {}, onSeek() {}, onJump() {}, onAlbum() {},
  })));
  window.fixture = {
    update: (next) => { pb = { ...pb, ...next }; render(); },
    pending: () => { pending = true; current = { ...track, id: 'pending' }; render(); },
    clear: () => { current = null; pb = { ...pb, currentId: null }; render(); },
  };
  render();
`;

const server = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  configFile: false,
  plugins: [react(), {
    name: 'now-playing-fixture',
    resolveId: (id) => id === '/__now-playing-fixture' ? '\0now-playing-fixture' : undefined,
    load: (id) => id === '\0now-playing-fixture' ? fixture : undefined,
    configureServer(server) {
      server.middlewares.use('/__now-playing.html', async (_req, res, next) => {
        try {
          const html = await server.transformIndexHtml('/__now-playing.html',
            '<!doctype html><div id="root"></div><script type="module" src="/__now-playing-fixture"></script>');
          res.setHeader('Content-Type', 'text/html');
          res.end(html);
        } catch (error) { next(error); }
      });
    },
  }],
  server: { host: '127.0.0.1', port: 0 },
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true, channel: process.env.SLATE_BROWSER_CHANNEL || 'msedge' });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${server.resolvedUrls.local[0]}__now-playing.html`);
  await page.locator('.np-line.active').waitFor();
  const active = () => page.locator('.np-line.active').textContent();
  assert.equal(await active(), 'First');

  // A seek while paused has no interpolation timer to hide a stale render.
  await page.evaluate(() => window.fixture.update({ position: 6 }));
  assert.equal(await active(), 'Second', 'a paused seek immediately highlights the new line');
  console.log('PASS paused seek updates the lyric highlight');

  // Shift the browser's monotonic clock without waiting or using native playback.
  await page.evaluate(() => {
    const original = performance.now.bind(performance);
    performance.now = () => original() + 30000;
    window.fixture.update({ playing: true });
  });
  assert.equal(await active(), 'Second', 'resuming does not add time spent paused');
  console.log('PASS resuming excludes time spent paused');

  await page.evaluate(() => window.fixture.update({ position: 11, playing: false }));
  assert.equal(await active(), 'Third', 'pausing uses the latest engine position');
  console.log('PASS pause uses the latest playback position');

  await page.evaluate(() => window.fixture.pending());
  assert.match(await page.locator('.np-empty').textContent(), /^Looking for lyrics/);
  await page.evaluate(() => window.fixture.clear());
  assert.equal(await page.locator('.np-empty p').textContent(), 'No lyrics for this song yet.');
  console.log('PASS clearing a track cancels the loading indicator');
  assert.deepEqual(errors, [], 'the component emits no browser errors');
} finally {
  await browser?.close();
  await server.close();
}
