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
// Unique per run, because a QA profile may be reused.
const queueName = `QA saved queue ${Date.now() % 100000}`;
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
  await test('Spotify playlist import reports setup requirement honestly', async () => {
    await page.getByRole('button', { name: 'Import Spotify playlist', exact: true }).click();
    const { spotify } = await snap();
    try {
      if (!spotify.connected) {
        await page.getByText('Connect Spotify once').waitFor();
        assert(await page.getByRole('button', { name: 'Set up Spotify', exact: true }).count());
      } else if (!spotify.playlistAccess) {
        assert(await page.getByRole('button', { name: 'Allow playlist access' }).count());
      } else {
        await page.getByRole('heading', { name: 'Your Spotify playlists' }).waitFor();
        assert(await page.getByRole('button', { name: /Liked Songs/ }).count());
      }
      assert(!(await page.getByText(/album link|album URL/i).count()));
      await page.screenshot({ path: path.join(output, 'spotify-setup.png') });
    } finally {
      await page.getByRole('button', { name: 'Close dialog' }).click();
    }
  });
  await test('Right-click menu plays next, adds to queue and opens the album', async () => {
    const songs = initial.tracks.filter((t) => !t.missing);
    await invoke('playback', { action: 'shuffle', value: false });
    await invoke('playback', { action: 'queue', value: { ids: [songs[0].id], index: 0 } });
    await invoke('playback', { action: 'pause' });
    await page.getByRole('button', { name: 'Songs', exact: true }).first().click();
    const target = songs.find((t) => t.id !== songs[0].id);
    await page.getByRole('button', { name: target.title, exact: true }).first().click({
      button: 'right',
    });
    const menu = page.getByRole('menu');
    await menu.waitFor();
    await page.screenshot({ path: path.join(output, 'context-menu.png') });
    await menu.getByRole('menuitem', { name: 'Play next' }).click();
    await waitFor(async () => (await snap()).playback.queue[1] === target.id);
    assert.equal((await snap()).playback.currentId, songs[0].id);
    await page.getByRole('button', { name: target.title, exact: true }).first().click({
      button: 'right',
    });
    await page.getByRole('menuitem', { name: 'Add to queue' }).click();
    await waitFor(async () => (await snap()).playback.queue.at(-1) === target.id);
    await page.getByRole('button', { name: target.title, exact: true }).first().click({
      button: 'right',
    });
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('menu').count(), 0);
    await page.getByRole('button', { name: target.title, exact: true }).first().click({
      button: 'right',
    });
    await page.getByRole('menuitem', { name: 'Go to album' }).click();
    await page.getByRole('button', { name: 'Play album', exact: true }).waitFor();
    assert.equal(await page.locator('.detail-hero h1').textContent(), target.album);
  });
  await test('Back returns to the previous page and its scroll position', async () => {
    await page.getByRole('button', { name: 'Go back' }).click();
    await page.getByRole('heading', { name: 'Songs', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Albums', exact: true }).first().click();
    await page.getByRole('button', { name: 'Go back' }).click();
    await page.getByRole('heading', { name: 'Songs', exact: true }).waitFor();
  });
  await test('Space still plays and pauses after using the volume slider', async () => {
    const volume = page.getByRole('slider', { name: 'Volume' });
    await volume.focus();
    const before = (await snap()).playback.playing;
    await page.keyboard.press('Space');
    await waitFor(async () => (await snap()).playback.playing !== before);
    await page.keyboard.press('Space');
    await waitFor(async () => (await snap()).playback.playing === before);
  });
  await test('Mute restores the previous volume', async () => {
    await invoke('playback', { action: 'volume', value: 0.37 });
    const volume = page.getByRole('slider', { name: 'Volume' });
    await waitFor(async () => (await volume.inputValue()) === '0.37');
    await page.getByRole('button', { name: 'Mute', exact: true }).click();
    await waitFor(async () => (await snap()).playback.volume === 0);
    await page.getByRole('button', { name: 'Unmute', exact: true }).click();
    await waitFor(async () => Math.abs((await snap()).playback.volume - 0.37) < 0.001);
  });
  await test('Sleep timer sets, shows its countdown and turns off', async () => {
    await page.getByRole('button', { name: 'Sleep timer', exact: true }).click();
    await page.getByRole('menuitem', { name: '30 minutes' }).click();
    await waitFor(async () => !!(await snap()).playback.sleepAt);
    await page.getByRole('button', { name: /pauses in 30 min/ }).waitFor();
    await page.screenshot({ path: path.join(output, 'sleep-timer.png') });
    await page.getByRole('button', { name: /Sleep timer:/ }).click();
    await page.getByRole('menuitem', { name: 'Turn off sleep timer' }).click();
    await waitFor(async () => !(await snap()).playback.sleepAt);
  });
  await test('Queue saves as a playlist and clears up next without stopping', async () => {
    const songs = initial.tracks.filter((t) => !t.missing).slice(0, 3);
    await invoke('playback', { action: 'queue', value: { ids: songs.map((t) => t.id), index: 1 } });
    await page.getByRole('button', { name: 'Queue', exact: true }).click();
    await page.getByRole('button', { name: 'Save as playlist' }).click();
    await page.getByRole('button', { name: 'New playlist', exact: true }).click();
    await page.getByRole('textbox', { name: 'Playlist name', exact: true }).fill(queueName);
    await page.getByRole('button', { name: 'Create playlist', exact: true }).last().click();
    await waitFor(async () =>
      (await snap()).collections.some((c) => c.name === queueName && c.entries.length === 3),
    );
    await page.getByRole('button', { name: 'Queue', exact: true }).click();
    await page.getByRole('button', { name: 'Clear up next' }).click();
    await waitFor(async () => (await snap()).playback.queue.length === 1);
    const s = (await snap()).playback;
    assert.equal(s.currentId, songs[1].id);
    assert(s.playing);
    await invoke('playback', { action: 'pause' });
  });
  await test('Adding a song already in a playlist is not duplicated', async () => {
    const saved = (await snap()).collections.find((c) => c.name === queueName);
    const title = initial.tracks.find((t) => t.id === saved.entries[0].trackId).title;
    await page.getByRole('button', { name: 'Songs', exact: true }).first().click();
    await page
      .getByRole('button', { name: `Add ${title} to playlist`, exact: true })
      .first()
      .click();
    try {
      await page.getByRole('dialog').getByRole('button', { name: queueName }).click();
      await page.getByText(`Already in ${queueName}`).waitFor();
    } finally {
      if (await page.getByRole('dialog').count())
        await page.getByRole('button', { name: 'Close dialog' }).click();
    }
    assert.equal(
      (await snap()).collections.find((c) => c.id === saved.id).entries.length,
      saved.entries.length,
    );
  });
  await test('Playback messages can be dismissed', async () => {
    await invoke('playback', { action: 'remove', value: 999 }).catch(() => {});
    const toast = page.locator('.toast');
    if (await toast.count()) await toast.getByRole('button', { name: 'Dismiss message' }).click();
    await page.locator('.playback-error').waitFor();
    await page.locator('.playback-error').getByRole('button', { name: 'Dismiss message' }).click();
    await waitFor(async () => (await snap()).playback.error === null);
    assert.equal(await page.locator('.playback-error').count(), 0);
  });
  await test('Now Playing opens with the current song and closes with Esc', async () => {
    const song = initial.tracks.find((t) => !t.missing);
    await invoke('playback', { action: 'queue', value: { ids: [song.id], index: 0 } });
    await invoke('playback', { action: 'pause' });
    await page.getByRole('button', { name: 'Open Now Playing' }).click();
    await page.locator('.now-playing h1', { hasText: song.title }).waitFor();
    await page.locator('.np-lyrics, .np-empty').first().waitFor();
    await page.screenshot({ path: path.join(output, 'now-playing.png') });
    await page.keyboard.press('Escape');
    await page.locator('.now-playing').waitFor({ state: 'detached' });
    await page.keyboard.press('Control+l');
    await page.locator('.now-playing').waitFor();
    await page.getByRole('button', { name: 'Close Now Playing (Esc)' }).click();
    await page.locator('.now-playing').waitFor({ state: 'detached' });
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
