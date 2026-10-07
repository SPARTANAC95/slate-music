/** Lyric timing you have adjusted by ear, kept in this PC's WebView storage: per song (a
 * lyric file that runs early or late) and per output device (Bluetooth plays late). How
 * lyrics are lit is kept with it. */
const KEY = 'slate-music.lyricTiming';
/** Songs remembered; the ones adjusted longest ago are forgotten first. */
const SONGS = 500;
/** Seconds: the furthest lyrics can be moved either way. */
export const MOST = 5;

/** How the line being sung is lit: word by word wherever there are word times ('on'), only
 * where the lyric source timed the words itself ('exact'), or as a whole line ('off'). */
export type WordMode = 'on' | 'exact' | 'off';
export const WORD_MODES: readonly WordMode[] = ['on', 'exact', 'off'];
/** Until you choose: word by word only where it is exact. Word times estimated inside a
 * line-timed line land about a third of a second from the singing on average, which reads as
 * slightly wrong; a line lit whole at the right moment does not. */
const USUAL: WordMode = 'exact';
interface Saved {
  songs: Record<string, number>;
  devices: Record<string, number>;
  words: WordMode;
}
let saved: Saved | null = null;
const seconds = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(-MOST, Math.min(MOST, value)) : 0;
const numbers = (value: unknown) =>
  Object.fromEntries(
    Object.entries(value && typeof value === 'object' ? value : {})
      .map(([key, v]) => [key, seconds(v)] as const)
      .filter(([, v]) => v !== 0),
  );
function load(): Saved {
  if (saved) return saved;
  try {
    // Anything unknown or damaged is ignored.
    const stored = JSON.parse(localStorage.getItem(KEY) || '{}') || {};
    saved = {
      songs: numbers(stored.songs),
      devices: numbers(stored.devices),
      words: WORD_MODES.includes(stored.words) ? stored.words : USUAL,
    };
  } catch {
    saved = { songs: {}, devices: {}, words: USUAL };
  }
  return saved;
}
function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(load()));
  } catch {
    // Storage full or unavailable: the choice lasts until the app closes.
  }
}
function store(table: Record<string, number>, key: string, value: number, limit = Infinity) {
  // Rounded to the millisecond, and re-added so the newest adjustment is last.
  const next = Math.round(seconds(value) * 1000) / 1000;
  delete table[key];
  if (next) table[key] = next;
  for (const old of Object.keys(table).slice(0, Math.max(0, Object.keys(table).length - limit)))
    delete table[old];
  save();
}
/** Seconds this song's lyrics are shown earlier (negative: later). */
export const songShift = (id: string | null) => (id && load().songs[id]) || 0;
export const setSongShift = (id: string, value: number) => store(load().songs, id, value, SONGS);
/** Seconds this output device plays late, so lyrics wait for it (negative: lyrics sooner). */
export const deviceDelay = (device: string | null | undefined) => load().devices[device ?? ''] || 0;
export const setDeviceDelay = (device: string | null | undefined, value: number) =>
  store(load().devices, device ?? '', value);
export const wordMode = () => load().words;
export function setWordMode(mode: WordMode) {
  load().words = mode;
  save();
}
