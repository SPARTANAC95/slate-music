// Isolated real-component checks with synthetic lyrics. No native profile or audio device.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
const fixture = String.raw`
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import NowPlaying from '/src/NowPlaying.tsx';
import VolumeControl from '/src/VolumeControl.tsx';
import '/src/styles.css';
import '@fontsource-variable/inter';
const root = createRoot(document.getElementById('root'));
const track = { id: 'synthetic', title: 'Where the light settles', artist: 'Slate Sessions',
 album: 'After Hours', artwork: null, duration: 75, format: 'FLAC', sampleRate: 48000,
 bitDepth: 24, year: 2026, originalYear: 2026 };
let pb = { currentId: track.id, position: 1, duration: 75, playing: false, clockRunning: true,
 queue: [track.id], cursor: 0, volume: 0.7, gainKind: 'off', output: null };
let current = track, serial = 0, visible = true, savedVolume = .7, pending = false;
let lyrics = { synced: '[00:01]First\n[00:05]Second\n[00:10]Third\n[00:15]Fourth',
 plain: null, source: 'file', instrumental: false };
const deferred = [];
const update = (next) => { pb = { ...pb, ...next }; render(); };
window.__TAURI_INTERNALS__ = { invoke: async () => pending ? new Promise((resolve) => deferred.push(resolve)) : lyrics };
function render() {
 flushSync(() => root.render(visible ? React.createElement(NowPlaying, {
  track: current, pb, trackMap: new Map([[track.id, track]]), accent: null,
  transport: React.createElement('div', { className: 'transport' },
   React.createElement('button', { onClick: () => update({ playing: !pb.playing }), 'aria-label': 'Play or pause' }, pb.playing ? 'Pause' : 'Play')),
  progress: React.createElement('div', { className: 'progress' },
   React.createElement('span', null, '0:06'), React.createElement('input', { type: 'range', 'aria-label': 'Playback position' }), React.createElement('span', null, '1:15')),
  volume: React.createElement(VolumeControl, { volume: pb.volume,
   onChange: (volume) => update({ volume }),
   onMute: () => { if (pb.volume > 0) savedVolume = pb.volume; update({ volume: pb.volume === 0 ? savedVolume : 0 }); } }),
  lookupLyrics: false,
  onClose: () => { visible = false; render(); },
  onFavorite() {}, onSeek: (position) => update({ position }), onJump() {}, onAlbum() {},
 }) : null));
}
window.fixture = {
 update,
 pending: () => { pending = true; current = { ...track, id: 'pending' }; render(); },
 clear: () => { current = null; pb = { ...pb, currentId: null }; render(); },
 source: (next) => { pending = false; lyrics = { synced: null, plain: null, source: 'file', instrumental: false, ...next };
  current = { ...track, id: 'source-' + ++serial }; pb = { ...pb, currentId: current.id }; render(); },
 resolveOld: () => deferred.forEach((resolve) => resolve({ synced: '[00:00]STALE', source: 'file' })),
 show: () => { visible = true; render(); },
 state: () => pb,
};
document.getElementById('launcher').focus();
render();
`;
const server = await createServer({
 root: fileURLToPath(new URL('..', import.meta.url)), configFile: false,
 plugins: [react(), {
  name: 'now-playing-fixture',
  resolveId: (id) => id === '/__now-playing-fixture' ? '\0now-playing-fixture' : undefined,
  load: (id) => id === '\0now-playing-fixture' ? fixture : undefined,
  configureServer(server) {
   server.middlewares.use('/__now-playing.html', async (_req, res, next) => {
    try {
     const html = await server.transformIndexHtml('/__now-playing.html',
      '<!doctype html><button id="launcher">Open player</button><div id="root"></div><script type="module" src="/__now-playing-fixture"></script>');
     res.setHeader('Content-Type', 'text/html'); res.end(html);
    } catch (error) { next(error); }
   });
  },
 }],
 // Nothing here changes while the checks run, so nothing is watched (the native build folder
 // alone holds tens of thousands of files).
 optimizeDeps: { entries: ['src/main.tsx'] }, server: { host: '127.0.0.1', port: 0, watch: null },
});
let browser;
let checks = 0;
const pass = (name) => { checks++; console.log('PASS ' + name); };
try {
 await server.listen();
 browser = await chromium.launch({ headless: true, channel: process.env.SLATE_BROWSER_CHANNEL || 'msedge' });
 const page = await browser.newPage({ viewport: { width: 1440, height: 940 } });
 const errors = [];
 page.on('pageerror', (error) => errors.push(error.message));
 await page.goto(server.resolvedUrls.local[0] + '__now-playing.html');
 await page.locator('.np-line.active').waitFor();
 const active = () => page.locator('.np-line.active').textContent();
 const update = (next) => page.evaluate((value) => window.fixture.update(value), next);
 assert.equal(await active(), 'First');
 await update({ position: 4.9 });
 assert.equal(await active(), 'First', 'never anticipate a line timestamp by 150 ms');
 pass('no premature line highlighting');
 await update({ position: 6 });
 assert.equal(await active(), 'Second');
 pass('paused seek updates immediately');
 await page.evaluate(() => {
  // Half a minute passes while paused, as far as the page can tell.
  const original = performance.now;
  performance.now = () => original.call(performance) + 30000;
  window.fixture.update({ playing: true });
  performance.now = original;
 });
 assert.equal(await active(), 'Second');
 pass('resume excludes time spent paused');
 await update({ position: 11, playing: false });
 assert.equal(await active(), 'Third');
 pass('pause uses latest engine position');

 const enhanced = '[00:01]<00:01>When <00:02>the <00:03>city <00:04>settles<00:05>\n'
  + '[00:05]<00:05>We <00:06>follow <00:07>the <00:08>light<00:09>\n'
  + '[00:10]<00:10>Every <00:11>quiet <00:12>moment<00:14>\n'
  + '[00:15]Finds a place to stay\n[00:20]\n'
  + Array.from({ length: 8 }, (_, i) => '[00:' + (25 + i * 5) + ']A new horizon, softly').join('\n');
 await page.evaluate((synced) => window.fixture.source({ synced }), enhanced);
 await page.getByText('Word + line synced', { exact: true }).waitFor();
 await update({ position: 6.5 });
 // How far each word of the line being sung is lit, 0 to 1 (set by LyricsPanel every frame).
 const fills = () => page.locator('.np-line.active .np-word').evaluateAll((els) => els.map((el) => Number(el.style.getPropertyValue('--p'))));
 const word = page.locator('.np-line.active .np-word').nth(1);
 const fill = async () => (await fills())[1];
 assert.equal(await word.textContent(), 'follow');
 assert.equal(await active(), 'We follow the light');
 assert.deepEqual(await fills(), [1, 0.5, 0, 0]);
 assert.equal(await word.evaluate((el) => getComputedStyle(el).transitionDuration), '0s');
 pass('source word boundaries drive fill without CSS timing delay');
 await page.waitForTimeout(420);
 assert.equal(await fill(), 0.5);
 await update({ position: 6.9, clockRunning: false, playing: true });
 await page.waitForTimeout(450);
 assert.equal(await active(), 'We follow the light');
 assert.equal(await fill(), 0.9);
 pass('paused and buffering word clocks do not drift');

 // Playing, with the engine's updates arriving unevenly and up to 30 ms early or late: the
 // fill follows a steady clock, never stepping back, and stays close to the real position.
 const steady = await page.evaluate(async () => {
  const start = performance.now(), from = 5.1, seen = [];
  const truth = () => from + (performance.now() - start) / 1000;
  window.fixture.update({ position: from, playing: true, clockRunning: true, at: Date.now() });
  let n = 0;
  const report = setInterval(() => window.fixture.update({ position: truth() + (n++ % 2 ? 0.03 : -0.03), at: Date.now() }), 240);
  await new Promise((done) => {
   const frame = () => {
    const els = [...document.querySelectorAll('.np-line.active .np-word')];
    if (els.length === 4) seen.push({ at: truth(), shown: 5 + els.reduce((sum, el) => sum + Number(el.style.getPropertyValue('--p')), 0) });
    if (truth() < 8.6) requestAnimationFrame(frame); else done();
   };
   requestAnimationFrame(frame);
  });
  clearInterval(report);
  // The other checks set positions by hand, without saying when they were read.
  window.fixture.update({ position: 6.5, playing: false, at: undefined });
  const moving = seen.filter((s) => s.at > 5.4 && s.at < 8.6);
  return { frames: moving.length, back: moving.filter((s, i) => i && s.shown < moving[i - 1].shown - 1e-9).length,
   worst: Math.max(...moving.map((s) => Math.abs(s.shown - s.at))) };
 });
 assert.ok(steady.frames > 60, 'the fill is drawn every frame');
 assert.equal(steady.back, 0, 'the fill never steps backwards');
 assert.ok(steady.worst < 0.06, 'the fill stays within 60 ms of the real position, saw ' + steady.worst);
 pass('jittery engine updates give a smooth, accurate word fill');

 await update({ position: 6.5, clockRunning: true, playing: true });
 await page.waitForTimeout(1400);
 // 6.5 s plus the one second the clock runs on by itself: half-way through "the" (7 to 8 s).
 const capped = await fills();
 assert.equal(capped[1], 1);
 assert.ok(capped[2] >= 0.5 && capped[2] <= 0.53, 'a silent engine cannot carry the lyrics on for more than a second');
 await page.waitForTimeout(250);
 assert.deepEqual(await fills(), capped);
 await page.evaluate(() => window.fixture.update({}));
 assert.deepEqual(await fills(), [1, 0.5, 0, 0], 'the same position again means no sound is coming out: the lyrics return to it');
 pass('lyrics stop when the engine goes quiet or its position stops moving');
 await update({ position: 6.5, playing: false, clockRunning: true });
 await page.locator('[data-line="3"]').click();
 assert.equal(await active(), 'Finds a place to stay');
 assert.equal(await page.evaluate(() => window.fixture.state().position), 15);
 // A line the source times as a whole: its words follow at an even pace, in order.
 await update({ position: 16.5 });
 const paced = await fills();
 assert.equal(paced.length, 5);
 assert.ok(paced[0] === 1 && paced.at(-1) === 0 && paced.some((p) => p > 0 && p < 1));
 assert.ok(paced.every((p, i) => !i || p <= paced[i - 1]), 'words light from the left');
 pass('line click seeks, and line-timed rows are swept at an even pace');

 await update({ position: 22 });
 assert.equal(await page.locator('.np-line.active').getAttribute('aria-label'), 'Instrumental break');
 assert.equal(await page.locator('.np-line.active.gap').evaluate((el) => el.style.getPropertyValue('--p')), '0.4');
 pass('a pause in the singing shows how far through it the song is');

 // Lyrics follow what is heard: later by the output's delay, and by your own adjustment.
 await update({ position: 5.05, outputLatency: 0.1 });
 assert.equal(await active(), 'When the city settles');
 await update({ position: 5.05, outputLatency: 0 });
 assert.equal(await active(), 'We follow the light');
 await update({ position: 4.85 });
 assert.equal(await active(), 'When the city settles');
 const timing = page.getByRole('group', { name: 'Lyrics timing' });
 await timing.getByRole('button', { name: 'Show lyrics earlier' }).click();
 await timing.getByRole('button', { name: 'Show lyrics earlier' }).click();
 await timing.getByText('0.2s earlier', { exact: true }).waitFor();
 assert.equal(await active(), 'We follow the light');
 await page.locator('[data-line="3"]').click();
 assert.equal(await active(), 'Finds a place to stay');
 assert.ok(Math.abs(await page.evaluate(() => window.fixture.state().position) - 14.8) < 1e-9, 'seeking lands where the adjusted line starts');
 await page.getByRole('tab', { name: 'Up next' }).click();
 await page.getByRole('tab', { name: 'Lyrics', exact: true }).click();
 await timing.getByText('0.2s earlier', { exact: true }).waitFor();
 await timing.getByRole('button', { name: /Reset timing/ }).click();
 await timing.getByText('Timing', { exact: true }).waitFor();
 assert.equal(await active(), 'Every quiet moment');
 pass('output delay and a remembered per-song adjustment move the lyrics');

 await update({ position: 46 });
 await page.getByRole('tab', { name: 'Up next' }).click();
 await page.getByRole('tab', { name: 'Lyrics', exact: true }).click();
 await page.locator('.np-line.active').waitFor();
 const centered = await page.locator('.np-line.active').evaluate((line) => {
  const box = line.closest('.np-lyrics').getBoundingClientRect(), rect = line.getBoundingClientRect();
  // REST in LyricsPanel: the line being sung sits a little above the middle.
  return Math.abs(rect.top + rect.height / 2 - box.top - box.height * 0.42) < 4;
 });
 assert.equal(centered, true);
 pass('returning to Lyrics brings the current line to its resting place');
 await page.locator('.np-lyrics').hover();
 await page.mouse.wheel(0, -350);
 await page.getByRole('button', { name: 'Return to current line' }).waitFor();
 await page.getByRole('button', { name: 'Return to current line' }).click();
 assert.equal(await page.getByRole('button', { name: 'Return to current line' }).count(), 0);
 pass('manual scrolling has an explicit follow control');

 const volume = page.getByRole('slider', { name: 'Volume', exact: true });
 await volume.focus();
 await page.keyboard.press('ArrowLeft');
 assert.equal(await volume.inputValue(), '0.69');
 await page.getByRole('button', { name: 'Mute', exact: true }).focus();
 await page.keyboard.press('Space');
 assert.equal(await volume.inputValue(), '0');
 await page.getByRole('button', { name: 'Unmute', exact: true }).click();
 assert.equal(await volume.inputValue(), '0.69');
 pass('lyrics volume slider and keyboard mute restore the prior gain');

 await page.getByRole('tab', { name: 'Lyrics', exact: true }).focus();
 await page.keyboard.press('ArrowRight');
 assert.equal(await page.getByRole('tab', { name: 'Up next' }).getAttribute('aria-selected'), 'true');
 await page.keyboard.press('Home');
 assert.equal(await page.getByRole('tab', { name: 'Lyrics', exact: true }).getAttribute('aria-selected'), 'true');
 await page.getByRole('button', { name: 'Close Now Playing (Esc)', exact: true }).focus();
 await page.keyboard.press('Shift+Tab');
 assert.equal(await page.getByRole('slider', { name: 'Playback position' }).evaluate((el) => el === document.activeElement), true);
 await page.keyboard.press('Tab');
 assert.equal(await page.getByRole('button', { name: 'Close Now Playing (Esc)', exact: true }).evaluate((el) => el === document.activeElement), true);
 pass('tab navigation and modal focus stay inside the player');

 await update({ position: 6.5 });
 await page.getByRole('button', { name: 'Close Now Playing (Esc)', exact: true }).focus();
 await mkdir('output/lyrics-review', { recursive: true });
 await page.screenshot({ path: 'output/lyrics-review/desktop.png' });
 await page.setViewportSize({ width: 880, height: 620 });
 await page.screenshot({ path: 'output/lyrics-review/minimum.png' });
 for (const selector of ['.np-volume', '.np-controls .progress', '.np-lyrics-panel']) {
  const rect = await page.locator(selector).boundingBox();
  assert.ok(rect.x >= 0 && rect.y >= 34 && rect.x + rect.width <= 880 && rect.y + rect.height <= 620, selector + ' fits minimum window');
 }
 assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
 pass('lyrics and volume fit the supported minimum window');
 await page.emulateMedia({ reducedMotion: 'reduce' });
 await update({ position: 6.5 });
 // The page hears about the setting a moment later; then whole words switch on at their start.
 await page.waitForFunction(() => document.querySelectorAll('.np-line.active .np-word')[1]?.style.getPropertyValue('--p') === '1');
 assert.deepEqual(await fills(), [1, 1, 0, 0]);
 assert.equal(await page.locator('.np-line.active').evaluate((el) => getComputedStyle(el).transform), 'none');
 assert.equal(await page.locator('.np-line:not(.active)').first().evaluate((el) => getComputedStyle(el).filter), 'none');
 assert.equal(await page.locator('.now-playing').evaluate((el) => getComputedStyle(el).animationName), 'none');
 await update({ position: 22.5 });
 assert.equal(await page.locator('.np-line.active.gap').evaluate((el) => el.style.getPropertyValue('--p')), '0.334', 'the dots of a pause light one at a time');
 pass('reduced motion uses discrete word timing and no transforms');
 await page.emulateMedia({ reducedMotion: 'no-preference' });
 await page.waitForFunction(() => document.querySelector('.np-line.active.gap')?.style.getPropertyValue('--p') === '0.5');

 await page.evaluate(() => window.fixture.pending());
 await page.getByText('Looking for lyrics.', { exact: true }).waitFor();
 await page.evaluate(() => window.fixture.source({ synced: '[00:01]New song' }));
 await page.getByRole('button', { name: 'New song', exact: true }).waitFor();
 await page.evaluate(() => window.fixture.resolveOld());
 assert.equal(await page.getByText('STALE', { exact: true }).count(), 0);
 await page.evaluate(() => window.fixture.pending());
 await page.evaluate(() => window.fixture.clear());
 await page.getByText('No lyrics for this song yet.', { exact: true }).waitFor();
 pass('late requests and cleared tracks cannot show stale lyrics');
 await page.evaluate(() => window.fixture.source({ plain: 'Words without timing' }));
 await page.getByText('Text lyrics', { exact: true }).waitFor();
 assert.equal(await page.locator('.np-word').count(), 0);
 assert.equal(await page.getByRole('group', { name: 'Lyrics timing' }).count(), 0);
 await page.evaluate(() => window.fixture.source({ synced: '[00:10]Late first line\n[00:14]Second line' }));
 await page.getByText('Line synced', { exact: true }).waitFor();
 await update({ position: 2.5 });
 assert.equal(await page.locator('.np-line.active.gap').evaluate((el) => el.style.getPropertyValue('--p')), '0.25');
 await page.evaluate(() => window.fixture.source({ instrumental: true }));
 await page.getByText('This one is instrumental.', { exact: true }).waitFor();
 pass('plain and instrumental sources have appropriate states');

 for (let i = 0; i < 3; i++) {
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.now-playing').count(), 0);
  assert.equal(await page.locator('#launcher').evaluate((el) => el === document.activeElement), true);
  await page.evaluate(() => window.fixture.show());
 }
 pass('repeated opening and closing restores focus');
 assert.deepEqual(errors, []);
 console.log(checks + ' Now Playing browser checks passed.');
} finally {
 await browser?.close();
 await server.close();
}
