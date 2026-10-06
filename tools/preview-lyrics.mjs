// Now Playing in a browser, driven by a stand-in for the audio engine: for looking at the
// lyrics view without the native app. Synthetic song and words; no library, no audio device.
// Run `npm run preview:lyrics`, then open the address it prints. ?jitter=40 exaggerates the
// engine's timing jitter, ?latency=120 pretends the output is that many milliseconds late.
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
const fixture = String.raw`
import React from 'react';
import { createRoot } from 'react-dom/client';
import NowPlaying from '/src/NowPlaying.tsx';
import VolumeControl from '/src/VolumeControl.tsx';
import '/src/styles.css';
import '@fontsource-variable/inter';
const query = new URLSearchParams(location.search);
const jitter = Number(query.get('jitter') ?? 12) / 1000, latency = Number(query.get('latency') ?? 20) / 1000;
const line = (at, text) => '[' + String(Math.floor(at / 60)).padStart(2, '0') + ':' + (at % 60).toFixed(2).padStart(5, '0') + ']' + text;
const word = (at) => '<' + line(at, '').slice(1, -1) + '>';
// Lines 1-4 carry the source's own word times; the rest are timed by the line only.
const sung = [
 [5, ['Paper ', 0.5, 'lanterns ', 0.7, 'on ', 0.2, 'the ', 0.2, 'water', 1.4]],
 [8.4, ['Drift', 0.5, 'ing ', 0.4, 'out ', 0.3, 'be', 0.25, 'yond ', 0.45, 'the ', 0.2, 'bay', 1.6]],
 [12.4, ['Every ', 0.5, 'little ', 0.5, 'light ', 0.6, 'remembers', 1.5]],
 [15.8, ['All ', 0.4, 'the ', 0.25, 'things ', 0.5, 'we ', 0.3, 'meant ', 0.5, 'to ', 0.25, 'say', 1.8]],
].map(([at, parts]) => { let t = at, out = line(at, ''); for (let i = 0; i < parts.length; i += 2) { out += word(t) + parts[i]; t += parts[i + 1]; } return out + word(t); });
const lines = [...sung, line(20.5, ''),
 line(27, 'Slow tide, carry what I couldn’t hold'), line(31, 'Silver in the morning, turning into gold'),
 line(35, 'If the shoreline is a promise'), line(38, 'Then I’m keeping it, I’m keeping it for you'),
 line(43, ''), line(50, '静かな海に 灯りがゆれる'), line(54.5, 'Paper lanterns on the water'),
 line(58, 'Coming home'), line(64, '')];
const track = { id: 'preview', title: 'Paper Lanterns', artist: 'Slate Sessions', album: 'Harbour Lights',
 artwork: null, duration: 72, format: 'FLAC', sampleRate: 48000, bitDepth: 24, year: 2026, originalYear: 2026 };
// The stand-in engine: a real clock, reported like the native one (see audio.rs): about every
// 240 ms, in steps the size of a sound-card buffer, a little late and a little unevenly.
const engine = { origin: performance.now(), base: 0, playing: true, volume: 0.7 };
const truth = () => Math.min(track.duration, engine.base + (engine.playing ? (performance.now() - engine.origin) / 1000 : 0));
const snapshot = () => ({ currentId: track.id, position: Math.floor(truth() / 0.01) * 0.01 + latency, duration: track.duration,
 playing: engine.playing, clockRunning: true, at: Date.now(), outputLatency: latency, queue: [track.id], cursor: 0,
 volume: engine.volume, gainKind: 'off', output: { device: 'Preview output', sampleRate: 48000, channels: 2, fallback: false } });
const set = (next) => { engine.base = next.position ?? truth(); engine.origin = performance.now(); Object.assign(engine, next); delete engine.position; render(snapshot()); };
window.__TAURI_INTERNALS__ = { invoke: async () => ({ synced: lines.join('\n'), plain: null, source: 'file', instrumental: false }) };
const root = createRoot(document.getElementById('root'));
const clock = (s) => Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
function render(pb) {
 root.render(React.createElement(NowPlaying, {
  track, pb, trackMap: new Map([[track.id, track]]), accent: 'hsl(265 60% 78%)',
  transport: React.createElement('div', { className: 'transport' },
   React.createElement('button', { className: 'primary', onClick: () => set({ playing: !engine.playing }) }, pb.playing ? 'Pause' : 'Play')),
  progress: React.createElement('div', { className: 'progress' }, React.createElement('span', null, clock(pb.position)),
   React.createElement('input', { type: 'range', 'aria-label': 'Playback position', min: 0, max: track.duration, step: 0.1, value: pb.position,
    onChange: (e) => set({ position: Number(e.target.value) }) }), React.createElement('span', null, clock(track.duration))),
  volume: React.createElement(VolumeControl, { volume: pb.volume, onChange: (volume) => set({ volume }), onMute: () => set({ volume: engine.volume ? 0 : 0.7 }) }),
  lookupLyrics: false, onClose() {}, onFavorite() {}, onSeek: (position) => set({ position }), onJump() {}, onAlbum() {},
 }));
}
window.preview = { set, truth };
const report = () => { const s = snapshot(); setTimeout(() => render(s), 2 + Math.random() * jitter * 1000); setTimeout(report, 240 + Math.random() * 30); };
if (truth() >= track.duration) set({ position: 0 });
report();
`;
const server = await createServer({
 root: fileURLToPath(new URL('..', import.meta.url)), configFile: false,
 // Its own cache, so it can stay open while the browser checks run their own servers.
 cacheDir: 'node_modules/.vite-lyrics-preview',
 plugins: [react(), {
  name: 'lyrics-preview',
  resolveId: (id) => id === '/__lyrics-preview' ? '\0lyrics-preview' : undefined,
  load: (id) => id === '\0lyrics-preview' ? fixture : undefined,
  configureServer(server) {
   server.middlewares.use('/lyrics', async (_req, res, next) => {
    try {
     res.setHeader('Content-Type', 'text/html');
     res.end(await server.transformIndexHtml('/lyrics',
      '<!doctype html><title>Slate Music lyrics preview</title><div id="root"></div><script type="module" src="/__lyrics-preview"></script>'));
    } catch (error) { next(error); }
   });
  },
 }],
 optimizeDeps: { entries: ['src/main.tsx'] },
 server: { host: '127.0.0.1', port: Number(process.env.PORT) || 5199, strictPort: true,
  watch: { ignored: ['**/src-tauri/**', '**/output/**', '**/site/**'] } },
});
await server.listen();
console.log('Lyrics preview: ' + server.resolvedUrls.local[0] + 'lyrics');
