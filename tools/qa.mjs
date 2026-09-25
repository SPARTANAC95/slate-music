import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
const output = path.resolve(process.env.SLATE_QA_OUTPUT || '../../work/qa');
fs.mkdirSync(output, { recursive: true });
const browser = await chromium.connectOverCDP(process.env.SLATE_CDP || 'http://127.0.0.1:9224');
const context = browser.contexts()[0];
const page = context
  .pages()
  .find((p) => p.url().includes('tauri.localhost') && !p.url().includes('mini'));
assert(page, 'Native WebView2 page must be running');
page.setDefaultTimeout(10000);
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const results = [];
const invoke = (command, args = {}) =>
  page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), {
    command,
    args,
  });
const snap = () => invoke('snapshot');
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, passed: true });
    console.log('PASS ' + name);
  } catch (e) {
    results.push({ name, passed: false, error: e.message });
    console.log('FAIL ' + name + ': ' + e.message);
  }
}
async function waitFor(fn, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw Error('Condition timed out');
}
let initial = await snap();
await waitFor(async () => !(await snap()).scan.scanning, 60000);
initial = await snap();
const selectedTitle = initial.tracks.find((t) => !t.missing && t.duration > 60)?.title;
assert(selectedTitle, 'QA needs one available track longer than a minute');
let testCollectionId;
try {
  await test('Read-only scan indexed real library with artwork', async () => {
    assert(initial.tracks.length > 0);
    assert.equal(initial.scan.errors.length, 0);
    assert(initial.tracks.some((t) => t.artwork));
    assert(initial.playback.engineReady);
    assert.equal(initial.playback.playing, false);
  });
  await test('Incremental rescan skips unchanged files', async () => {
    await invoke('rescan');
    await new Promise((r) => setTimeout(r, 350));
    await waitFor(async () => !(await snap()).scan.scanning);
    assert.equal((await snap()).scan.changed, 0);
  });
  await test('Search and real FLAC playback', async () => {
    await page.getByRole('button', { name: 'Songs', exact: true }).click();
    await page.getByRole('textbox', { name: 'Search your music' }).fill(selectedTitle);
    await page
      .getByRole('button', { name: `Play ${selectedTitle}`, exact: true })
      .first()
      .click();
    await waitFor(async () => {
      const s = await snap();
      return s.playback.playing && s.playback.position > 1;
    });
    const s = await snap();
    assert.equal(s.tracks.find((t) => t.id === s.playback.currentId).title, selectedTitle);
    assert.equal(s.playback.error, null);
    await page.screenshot({ path: path.join(output, 'songs-playing.png') });
  });
  await test('Seek and pause retain position', async () => {
    await invoke('playback', { action: 'seek', value: 45 });
    await waitFor(async () => (await snap()).playback.position >= 45);
    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    const first = (await snap()).playback;
    await new Promise((r) => setTimeout(r, 700));
    const second = (await snap()).playback;
    assert.equal(second.playing, false);
    assert(Math.abs(second.position - first.position) < 0.1);
  });
  await test('Favorites toggle through UI', async () => {
    const s = await snap(),
      id = s.playback.currentId;
    const favoriteButton = page
      .getByRole('button', { name: `Favorite ${selectedTitle}`, exact: true })
      .first();
    if (await favoriteButton.count()) await favoriteButton.click();
    assert((await snap()).tracks.find((t) => t.id === id).favorite);
    await page.getByRole('button', { name: 'Favorites', exact: true }).click();
    assert((await page.getByRole('button', { name: selectedTitle, exact: true }).count()) > 0);
  });
  await test('Create and edit playlist through UI', async () => {
    await page
      .getByRole('button', { name: `Add ${selectedTitle} to playlist`, exact: true })
      .first()
      .click();
    await page.getByRole('button', { name: 'New playlist', exact: true }).click();
    await page
      .getByRole('textbox', { name: 'Playlist name', exact: true })
      .fill('QA listening session');
    await page.getByRole('button', { name: 'Create playlist', exact: true }).last().click();
    await waitFor(async () => {
      const c = (await snap()).collections.find((c) => c.name === 'QA listening session');
      testCollectionId = c?.id;
      return !!c;
    });
    assert.equal(
      (await snap()).collections.find((c) => c.id === testCollectionId).entries.length,
      1,
    );
    await page.getByRole('button', { name: 'Edit playlist', exact: true }).click();
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill('QA playlist renamed');
    await page.getByRole('button', { name: 'Save playlist', exact: true }).click();
    await waitFor(
      async () =>
        (await snap()).collections.find((c) => c.id === testCollectionId)?.name ===
        'QA playlist renamed',
    );
  });
  await test('Queue reordering and removal preserve current song', async () => {
    const songs = initial.tracks.filter((t) => !t.missing).slice(0, 4);
    await invoke('playback', { action: 'shuffle', value: false });
    await invoke('playback', { action: 'queue', value: { ids: songs.map((t) => t.id), index: 0 } });
    await invoke('playback', { action: 'pause' });
    await invoke('playback', { action: 'move', value: { from: 0, to: 2 } });
    let s = await snap();
    assert.equal(s.playback.currentId, songs[0].id);
    assert.equal(s.playback.cursor, 2);
    await invoke('playback', { action: 'remove', value: 0 });
    s = await snap();
    assert.equal(s.playback.cursor, 1);
    assert.equal(s.playback.queue.length, 3);
    await page.getByRole('button', { name: 'Queue', exact: true }).click();
    await page.screenshot({ path: path.join(output, 'queue.png') });
  });
  await test('Next, previous, repeat and crossfade controls', async () => {
    await invoke('playback', { action: 'next' });
    const a = (await snap()).playback;
    assert(a.playing);
    await invoke('playback', { action: 'previous' });
    assert((await snap()).playback.cursor <= a.cursor);
    await invoke('playback', { action: 'repeat', value: 'one' });
    await invoke('playback', { action: 'crossfade', value: 4 });
    await invoke('playback', { action: 'volume', value: 0.23 });
    const s = (await snap()).playback;
    assert.equal(s.repeat, 'one');
    assert.equal(s.crossfade, 4);
    assert(Math.abs(s.volume - 0.23) < 0.001);
    await invoke('playback', { action: 'pause' });
  });
  await test('Album and artist detail pages render real artwork', async () => {
    await page.getByRole('button', { name: 'Albums', exact: true }).first().click();
    await page.locator('.album-card').first().click();
    assert(await page.getByRole('button', { name: 'Play album', exact: true }).count());
    assert(
      await page.locator('.detail-hero img').evaluate((i) => i.complete && i.naturalWidth > 0),
    );
    await page.screenshot({ path: path.join(output, 'album.png') });
    await page.getByRole('button', { name: 'Artists', exact: true }).first().click();
    await page.locator('.artist-card').first().click();
    assert(await page.getByRole('button', { name: 'Play artist', exact: true }).count());
  });
  await test('Spotify import reports setup requirement honestly', async () => {
    await page.getByRole('button', { name: 'Import Spotify album', exact: true }).click();
    await page
      .getByRole('textbox', { name: 'Spotify album URL' })
      .fill('https://open.spotify.com/album/4eLPsYPBmXABThSJ821sqY');
    await page.getByRole('button', { name: 'Find matching files' }).click();
    await page.getByRole('alert').waitFor();
    assert.match(
      await page.getByRole('alert').innerText(),
      /Connect Spotify|Invalid Spotify album ID/,
    );
    await page.screenshot({ path: path.join(output, 'spotify-setup.png') });
    await page.getByRole('button', { name: 'Close dialog' }).click();
  });
  await test('Offline library and native playback', async () => {
    await context.setOffline(true);
    await page.getByRole('button', { name: 'Songs', exact: true }).click();
    await page.getByRole('button', { name: 'Play all', exact: true }).click();
    await waitFor(async () => (await snap()).playback.playing);
    assert.equal((await snap()).playback.error, null);
    await invoke('playback', { action: 'pause' });
    await context.setOffline(false);
  });
  await test('Mini-player controls real playback state', async () => {
    await page.getByRole('button', { name: 'Mini-player', exact: true }).click();
    await waitFor(() => context.pages().some((p) => p.url().includes('mini')));
    const mini = context.pages().find((p) => p.url().includes('mini'));
    await mini.getByRole('button', { name: 'Play', exact: true }).click();
    await waitFor(async () => (await snap()).playback.playing);
    await mini.getByRole('button', { name: 'Pause', exact: true }).click();
    await mini.screenshot({ path: path.join(output, 'mini-player.png') });
    await mini.getByRole('button', { name: 'Open full player' }).click();
    await waitFor(() => !context.pages().some((p) => p.url().includes('mini')));
  });
  await test('Settings and interface have no runtime errors', async () => {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    assert(
      (await page
        .getByRole('switch', { name: 'Check for updates automatically' })
        .getAttribute('aria-checked')) === 'true',
    );
    await page.screenshot({ path: path.join(output, 'settings.png') });
    await page.getByRole('button', { name: 'Close dialog' }).click();
    assert.deepEqual(errors, []);
  });
  await test('Session prepared for restart recovery', async () => {
    await invoke('playback', {
      action: 'queue',
      value: { ids: initial.tracks.slice(0, 5).map((t) => t.id), index: 2 },
    });
    await invoke('playback', { action: 'seek', value: 37 });
    await invoke('playback', { action: 'pause' });
    const s = await snap();
    fs.writeFileSync(
      path.join(output, 'restart-expected.json'),
      JSON.stringify({
        session: s.playback,
        favoriteId: s.tracks.find((t) => t.favorite)?.id,
        collectionId: testCollectionId,
      }),
    );
  });
  await page.getByRole('button', { name: 'Home', exact: true }).first().click();
  await page.screenshot({ path: path.join(output, 'home.png') });
} finally {
  await context.setOffline(false);
  fs.writeFileSync(
    path.join(output, 'results.json'),
    JSON.stringify(
      {
        date: new Date().toISOString(),
        trackCount: initial.tracks.length,
        artworkCount: initial.tracks.filter((t) => t.artwork).length,
        results,
        errors,
      },
      null,
      2,
    ),
  );
  await browser.close();
}
if (results.some((r) => !r.passed)) process.exitCode = 1;
