// Run against a disposable native profile with the generated silent QA library.
// SLATE_QA_LYRICS_DIR must name its sole indexed folder. Put lyrics-enhanced.lrc
// and lyrics-lines.lrc from tests/fixtures beside songs 1 and 2, with matching names.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

assert(process.env.SLATE_QA_LYRICS_DIR, 'Explicit synthetic fixture directory required');
const fixtureDir = path.resolve(process.env.SLATE_QA_LYRICS_DIR).toLowerCase();
const output = path.resolve(process.env.SLATE_QA_OUTPUT || 'output/lyrics-native');
const browser = await chromium.connectOverCDP(process.env.SLATE_CDP || 'http://127.0.0.1:9327');
const page = browser.contexts()[0].pages().find((p) => p.url().includes('tauri.localhost') && !p.url().includes('mini'));
assert(page, 'Native WebView2 must be running');
page.setDefaultTimeout(10000);
const invoke = (command, args = {}) => page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args });
const command = (action, value = null) => invoke('playback', { action, value });
const snapshot = () => invoke('snapshot');
const results = [];
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const pass = (name) => { results.push(name); console.log('PASS ' + name); };
async function until(fn) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await page.waitForTimeout(60);
  }
  throw Error('Condition timed out');
}
let authorizedFixture = false;
try {
  await until(async () => !(await snapshot()).scan.scanning);
  const initial = await snapshot();
  assert.deepEqual(initial.folders.map((folder) => path.resolve(folder).toLowerCase()), [fixtureDir]);
  assert.equal(initial.tracks.length, 6);
  assert(initial.tracks.every((track) => track.artist === 'Slate Test Artist' && /^Fixture Song [1-6]$/.test(track.title)));
  assert.equal(initial.playback.exclusive, false, 'This check must use shared output');
  authorizedFixture = true;
  await fs.mkdir(output, { recursive: true });
  await invoke('plugin:window|set_size', { label: 'main', value: { Logical: { width: 1440, height: 940 } } });
  const first = initial.tracks.find((track) => track.title === 'Fixture Song 1');
  const second = initial.tracks.find((track) => track.title === 'Fixture Song 2');
  const source = await invoke('song_lyrics', { id: first.id });
  assert.equal(source.source, 'file');
  assert(source.synced.includes('<00:06>follow '));
  assert(source.synced.includes('[offset:-500]'));
  await command('queue', { ids: [first.id, second.id], index: 0 });
  await command('pause');
  await command('seek', 7);
  await page.getByRole('button', { name: 'Now Playing (Ctrl+L)', exact: true }).click();
  const player = page.getByRole('dialog', { name: 'Now playing', exact: true });
  await player.locator('.np-lyrics-panel[data-timing="Word + line synced"]').waitFor();
  const active = () => player.locator('.np-line.active').textContent();
  // How far the second word is lit, in percent. Lyrics follow what is heard, so they trail
  // the engine's position by the output delay Windows reports for this device.
  const fill = () => player.locator('.np-line.active .np-word').nth(1).evaluate((el) => Number(el.style.getPropertyValue('--p')) * 100);
  const delay = (await snapshot()).playback.outputLatency ?? 0;
  assert(delay >= 0 && delay < 0.3, 'Output delay of the QA device should be small, was ' + delay);
  const half = 50 - delay * 100;
  await until(async () => Math.abs(await fill() - half) < 0.25);
  assert.equal(await active(), 'We follow the light');
  await page.waitForTimeout(650);
  assert(Math.abs(await fill() - half) < 0.25);
  pass('Native sidecar preserves word boundaries and applies negative offset while paused');

  await command('seek', 5.4 + delay);
  await until(async () => await active() === 'When the city settles');
  await command('seek', 5.5 + delay);
  await until(async () => await active() === 'We follow the light');
  pass('Native paused seeks switch at the exact offset line boundary without early highlighting');

  const slider = player.getByRole('slider', { name: 'Volume', exact: true });
  await slider.fill('0.37');
  await until(async () => Math.abs((await snapshot()).playback.volume - 0.37) < 0.0001);
  await player.getByRole('button', { name: 'Mute', exact: true }).focus();
  await page.keyboard.press('Space');
  await until(async () => (await snapshot()).playback.volume === 0);
  assert.equal((await snapshot()).playback.playing, false, 'Mute keyboard action must not start playback');
  await player.getByRole('button', { name: 'Unmute', exact: true }).click();
  await until(async () => Math.abs((await snapshot()).playback.volume - 0.37) < 0.0001);
  await page.keyboard.press('Escape');
  assert(Math.abs(Number(await page.getByRole('slider', { name: 'Volume', exact: true }).inputValue()) - 0.37) < 0.0001);
  pass('Lyrics volume and keyboard mute control native gain and agree with the main player');

  await page.getByRole('button', { name: 'Now Playing (Ctrl+L)', exact: true }).click();
  await player.locator('.np-line.active').waitFor();
  await command('seek', 7);
  await page.waitForTimeout(600);
  await command('play');
  await until(async () => (await snapshot()).playback.position > 7.2);
  const mapping = await page.evaluate(async () => {
    const state = await window.__TAURI_INTERNALS__.invoke('snapshot');
    const word = document.querySelectorAll('.np-line.active .np-word')[1];
    return { pb: state.playback, fill: Number(word.style.getPropertyValue('--p')) * 100 };
  });
  assert(mapping.pb.clockRunning);
  // Supplied word range is 6.5..7.5 after the offset; normal IPC/sample buffering
  // can differ from a separately requested snapshot. This is not acoustic latency.
  assert(Math.abs(6.5 + mapping.fill / 100 - mapping.pb.position) < 0.35);
  await command('pause');
  await until(async () => !(await snapshot()).playback.clockRunning);
  await page.waitForTimeout(300);
  const pausedFill = await fill();
  await page.waitForTimeout(550);
  assert.equal(await fill(), pausedFill);
  pass('Native playback snapshots drive the word clock; pause and resume do not accumulate paused time');

  await command('seek', 46);
  await until(async () => await player.locator('.np-line.active').getAttribute('data-line') === '9');
  await player.getByRole('tab', { name: 'Up next' }).click();
  await player.getByRole('tab', { name: 'Lyrics', exact: true }).click();
  await player.locator('.np-line.active').waitFor();
  await until(async () => player.locator('.np-line.active').evaluate((line) => {
    const box = line.closest('.np-lyrics').getBoundingClientRect(), rect = line.getBoundingClientRect();
    return Math.abs(rect.top + rect.height / 2 - box.top - box.height * 0.42) < 6;
  }));
  await command('next');
  await command('pause');
  await command('seek', 6);
  await player.locator('.np-lyrics-panel[data-timing="Line synced"]').waitFor();
  await until(async () => await active() === 'With a different line');
  assert((await player.locator('.np-line.active .np-word').count()) > 1);
  pass('Native tab return follows the current line and track changes replace timed words with line timing');

  await command('previous');
  await command('previous');
  await command('pause');
  await command('seek', 7);
  await player.locator('.np-lyrics-panel[data-timing="Word + line synced"]').waitFor();
  await until(async () => Math.abs(await fill() - half) < 0.25);
  await player.getByRole('button', { name: 'Close Now Playing (Esc)', exact: true }).focus();
  await page.screenshot({ path: path.join(output, 'desktop.png') });
  await invoke('plugin:window|set_size', { label: 'main', value: { Logical: { width: 880, height: 620 } } });
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(output, 'minimum.png') });
  for (const selector of ['.np-volume', '.np-controls .progress', '.np-lyrics-panel']) {
    assert(await player.locator(selector).evaluate((el) => {
      const rect = el.getBoundingClientRect();
      return rect.x >= 0 && rect.y >= 34 && rect.right <= innerWidth && rect.bottom <= innerHeight;
    }), selector + ' stays in the native minimum window');
  }
  pass('Production native view keeps lyrics, seek and volume visible at 880x620');
  assert.deepEqual(errors, []);
} finally {
  if (authorizedFixture) {
    await command('pause').catch(() => {});
    await invoke('plugin:window|set_size', { label: 'main', value: { Logical: { width: 1440, height: 940 } } }).catch(() => {});
    await page.keyboard.press('Escape').catch(() => {});
    await fs.writeFile(path.join(output, 'results.json'), JSON.stringify({ date: new Date().toISOString(), results, errors }, null, 2));
  }
  await browser.close();
}
console.log(results.length + ' native lyrics checks passed.');
