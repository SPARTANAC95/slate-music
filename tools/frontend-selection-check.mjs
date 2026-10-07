// Browser regression checks only: synthetic library, mocked IPC, no native playback.
// Run with: node tools/frontend-selection-check.mjs
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const server = await createServer({ server: { port: 0, strictPort: false, host: '127.0.0.1' } });
await server.listen();
const url = server.resolvedUrls.local[0];
let browser;
try {
  browser = await chromium.launch({ headless: true, channel: process.env.SLATE_BROWSER_CHANNEL || 'msedge' });
  const errors = [];
  const failures = [];
  async function test(name, run) {
    try {
      await run();
      console.log(`PASS ${name}`);
    } catch (error) {
      failures.push({ name, error: error.message });
      console.error(`FAIL ${name}: ${error.message}`);
    }
  }
  async function fixture(queue = ['a', 'b', 'c']) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 940 } });
    page.setDefaultTimeout(5000);
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(({ queue }) => {
      const track = (id, format = 'FLAC', bitDepth = 16) => ({
        id, path: `fixture/${id}`, folder: 'fixture', title: `Song ${id.toUpperCase()}`,
        artist: 'Fixture Artist', album: 'Fixture Album', albumArtist: 'Fixture Artist',
        year: 2000, track: 1, disc: 1, duration: 180, format, sampleRate: 44100, bitDepth,
        artwork: null, favorite: false, missing: false, playCount: 0, lastPlayed: 0,
        added: 0, size: 1, originalYear: 0,
      });
      const tracks = [track('a'), track('b', 'WAV'), track('c', 'M4A'), track('d', 'M4A', 0)];
      const state = {
        tracks,
        collections: [{
          id: 'fixture-playlist', name: 'Fixture Playlist', kind: 'playlist', created: 0,
          entries: tracks.slice(0, 3).map((t) => ({
            trackId: t.id, title: t.title, artist: t.artist, duration: t.duration, status: 'available',
          })),
        }],
        folders: ['fixture'],
        settings: { autoCheck: false, autoDownload: false, showListening: false, lookupYears: false, lookupLyrics: false, lookupArtists: false },
        scan: { scanning: false, processed: 4, changed: 0, errors: [], lastScan: 0 },
        loudnessMeasured: 0,
        spotify: { connected: false, playlistAccess: false, likedAccess: false, topAccess: false, clientId: null, redirectUri: '' },
        playback: {
          queue, cursor: queue.length - 1, currentId: queue.at(-1), position: 0, duration: 180,
          playing: false, volume: 0, shuffle: false, repeat: 'off', crossfade: 0, error: null,
          engineReady: true, sleepAt: null, sleepEndOfTrack: false, levelling: 'off',
          smartCrossfade: false, eq: { enabled: false, preamp: 0, bands: Array(10).fill(0), preset: 'Flat' },
          outputDevice: null, output: null, gainDb: null, gainKind: 'off',
        },
      };
      const callbacks = new Map();
      const listeners = new Map();
      let callbackId = 0;
      const test = window.__selectionFixture = {
        state, saves: 0, moves: 0, failMove: false,
        emit(event, payload) {
          for (const id of listeners.get(event) ?? []) callbacks.get(id)?.({ event, payload: structuredClone(payload) });
        },
        replaceQueue(ids) {
          state.playback.queue = ids;
          this.emit('playback', state.playback);
        },
      };
      window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
      window.__TAURI_INTERNALS__ = {
        metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
        transformCallback(callback) { callbacks.set(++callbackId, callback); return callbackId; },
        unregisterCallback(id) { callbacks.delete(id); },
        async invoke(command, args = {}) {
          if (command === 'snapshot') return structuredClone(state);
          if (command === 'listening_history') return [];
          if (command === 'artist_photos') return {};
          if (command === 'plugin:app|version') return '9.8.7';
          if (command === 'lastfm_status') return { configured: true, builtIn: true, own: false, connected: false, user: null, waiting: false, pending: 0, problem: null };
          if (command === 'plugin:event|listen') {
            listeners.set(args.event, [...(listeners.get(args.event) ?? []), args.handler]);
            return args.handler;
          }
          if (command === 'plugin:event|unlisten') return;
          if (command === 'save_collection') {
            state.collections = state.collections.map((c) => c.id === args.collection.id ? structuredClone(args.collection) : c);
            test.saves++;
            return;
          }
          if (command === 'playback' && args.action === 'move_many') {
            test.moves++;
            if (test.failMove) throw new Error('Synthetic move failure');
            const positions = state.playback.queue.map((_, i) => i);
            const moving = new Set(args.value.rows);
            const picked = positions.filter((i) => moving.has(i));
            const rest = positions.filter((i) => !moving.has(i));
            const at = rest.findIndex((i) => i >= args.value.to);
            rest.splice(at < 0 ? rest.length : at, 0, ...picked);
            state.playback.cursor = rest.indexOf(state.playback.cursor);
            state.playback.queue = rest.map((i) => state.playback.queue[i]);
            return structuredClone(state.playback);
          }
          throw new Error(`Unexpected fixture IPC: ${command} ${args.action ?? ''}`);
        },
      };
    }, { queue });
    await page.goto(url);
    await page.getByRole('button', { name: 'Songs', exact: true }).waitFor();
    return page;
  }

  async function move(page, from, to, after = false) {
    const rows = page.locator('main .track-row');
    const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
    const source = rows.nth(from), target = rows.nth(to);
    await source.dispatchEvent('dragstart', { dataTransfer });
    const box = await target.boundingBox();
    await target.dispatchEvent('dragover', { dataTransfer, clientY: box.y + (after ? box.height - 2 : 2) });
    await page.waitForFunction(() => !!document.querySelector('.drop-before, .drop-after'));
    await target.dispatchEvent('drop', { dataTransfer });
    await dataTransfer.dispose();
  }

  async function openQueue(page) {
    await page.getByRole('button', { name: 'Queue', exact: true }).click();
    await page.locator('main .queue-table').waitFor();
  }

  await test('playlist drag clears stale selection', async () => {
    const page = await fixture();
    await page.getByRole('button', { name: 'Fixture Playlist', exact: true }).click();
    await move(page, 0, 2, true);
    await page.waitForFunction(() => window.__selectionFixture.saves === 1);
    await page.waitForFunction(() => document.querySelector('main .song-title')?.textContent === 'Song B');
    assert.equal(await page.locator('main .track-row.picked').count(), 0, 'playlist drag must discard old positional picks');
    await page.keyboard.press('Delete');
    assert.equal(await page.evaluate(() => window.__selectionFixture.saves), 1, 'Delete after moving must not remove a different song');
    await page.close();
  });

  for (const failed of [false, true]) {
    await test(`${failed ? 'failed' : 'unchanged'} queue move does not preserve stale selection`, async () => {
    const page = await fixture();
    await openQueue(page);
    if (failed) await page.evaluate(() => { window.__selectionFixture.failMove = true; });
    await move(page, 0, failed ? 1 : 0);
    await page.waitForFunction(() => window.__selectionFixture.moves === 1);
    if (failed) await page.getByText('Error: Synthetic move failure', { exact: true }).waitFor();
    assert.equal(await page.locator('main .track-row.picked').count(), 1);
    await page.evaluate(() => window.__selectionFixture.replaceQueue(['b', 'a', 'c']));
    await page.waitForFunction(() => document.querySelector('main .song-title')?.textContent === 'Song B');
    assert.equal(await page.locator('main .track-row.picked').count(), 0, 'later queue edits must discard positional picks');
    await page.close();
    });
  }

  await test('queue move accounts for entries absent from the library', async () => {
    const page = await fixture(['unknown', 'a', 'b', 'c']);
    await openQueue(page);
    await move(page, 0, 2, true);
    await page.waitForFunction(() => window.__selectionFixture.state.playback.queue.at(-1) === 'a');
    await page.waitForFunction(() => document.querySelector('main .track-row.picked .song-title')?.textContent === 'Song A');
    assert.deepEqual(await page.locator('main .track-row.picked .song-title').allTextContents(), ['Song A']);
    await page.close();
  });

  await test('Lossless filter includes ALAC and excludes AAC', async () => {
    const page = await fixture();
    await page.getByRole('button', { name: 'Songs', exact: true }).click();
    await page.getByRole('button', { name: 'Lossless', exact: true }).click();
    assert.deepEqual(await page.locator('main .song-title').allTextContents(), ['Song A', 'Song B', 'Song C']);
    await page.close();
  });

  await test('Settings shows the version of the installed app', async () => {
    const page = await fixture();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByText('Slate Music 9.8.7', { exact: true }).waitFor();
    await page.close();
  });

  await test('Discord covers are on unless switched off, and wait for the status itself', async () => {
    const page = await fixture();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const covers = page.getByRole('switch', { name: 'Show the album cover' });
    assert.equal(await covers.getAttribute('aria-checked'), 'true');
    assert.equal(await covers.isDisabled(), true, 'nothing to show while the status is off');
    await page.close();
  });

  await test('Last.fm needs no API account where Slate Music carries its own', async () => {
    const page = await fixture();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Connect Last.fm', exact: true }).waitFor();
    assert.equal(await page.getByLabel('API key').count(), 0, 'nothing to paste');
    await page.getByRole('button', { name: 'Use my own API account' }).click();
    await page.getByLabel('API key').waitFor();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('button', { name: 'Connect Last.fm', exact: true }).waitFor();
    await page.close();
  });
  assert.deepEqual(errors, [], 'no browser errors');
  assert.deepEqual(failures, [], 'all selection regression checks passed');
} finally {
  await browser?.close();
  await server.close();
}
