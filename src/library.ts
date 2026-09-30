import type { Album, Collection, Entry, Track } from './types';
export const normalize = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
export function albumsFrom(tracks: Track[]): Album[] {
  const map = new Map<string, Album>();
  for (const t of tracks) {
    const key = normalize(t.albumArtist) + '|' + normalize(t.album);
    let a = map.get(key);
    if (!a) {
      a = {
        key,
        name: t.album,
        artist: t.albumArtist,
        year: t.year,
        tracks: [],
        artwork: t.artwork,
      };
      map.set(key, a);
    }
    a.tracks.push(t);
    a.artwork ??= t.artwork;
  }
  return [...map.values()].map((a) => ({
    ...a,
    tracks: a.tracks.sort(
      (x, y) => x.disc - y.disc || x.track - y.track || x.title.localeCompare(y.title),
    ),
  }));
}
export const time = (seconds: number) => {
  const n = Math.max(0, Math.floor(seconds || 0));
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
};
export const durationLabel = (s: number) =>
  s >= 3600
    ? `${Math.floor(s / 3600)} hr ${Math.floor((s % 3600) / 60)} min`
    : `${Math.ceil(s / 60)} min`;
/** How a file is encoded, for quality badges: lossless formats, and "Hi-Res" for
 * 24-bit (or deeper) files above 48 kHz. ALAC shares the M4A extension with lossy AAC, so it
 * counts as lossless only when the file reports a bit depth. */
export function quality(t: Track) {
  const lossless =
    ['FLAC', 'WAV', 'AIF', 'AIFF'].includes(t.format) || (t.format === 'M4A' && t.bitDepth > 0);
  const hiRes = lossless && t.bitDepth >= 24 && t.sampleRate > 48000;
  const detail = [
    t.bitDepth > 0 ? `${t.bitDepth}-bit` : '',
    t.sampleRate > 0 ? `${Math.round(t.sampleRate / 100) / 10} kHz` : '',
  ]
    .filter(Boolean)
    .join(' / ');
  return { lossless, hiRes, label: hiRes ? 'Hi-Res Lossless' : lossless ? 'Lossless' : '', detail };
}
/** A confirmed playlist entry for a local song. It stays confirmed even if the file is
 * unavailable right now; it is shown as missing until the file returns (see entryStatus). */
export const entryFrom = (t: Track): Entry => ({
  trackId: t.id,
  title: t.title,
  artist: t.artist,
  duration: t.duration,
  status: 'available',
});
export function entryStatus(entry: Entry, tracks: Map<string, Track>): Entry['status'] {
  const track = entry.trackId ? tracks.get(entry.trackId) : undefined;
  return entry.status === 'available' && (!track || track.missing) ? 'missing' : entry.status;
}
/** Positions in `c.entries` of the songs that `playable` returns, in the same order. */
export function playableIndices(c: Collection, tracks: Track[]): number[] {
  const map = new Map(tracks.map((t) => [t.id, t]));
  return c.entries.flatMap((e, i) => {
    const t = e.trackId ? map.get(e.trackId) : null;
    return e.status === 'available' && t && !t.missing ? [i] : [];
  });
}
export function playable(c: Collection, tracks: Track[]): Track[] {
  const map = new Map(tracks.map((t) => [t.id, t]));
  return playableIndices(c, tracks).map((i) => map.get(c.entries[i].trackId!)!);
}
export function queueEntries(ids: string[], tracks: Map<string, Track>, query = '') {
  const needle = normalize(query);
  return ids.flatMap((id, index) => {
    const track = tracks.get(id);
    return track && normalize(`${track.title} ${track.artist} ${track.album}`).includes(needle)
      ? [{ track, index }]
      : [];
  });
}
export function duplicates(tracks: Track[]): Set<string> {
  const groups = new Map<string, string[]>();
  for (const t of tracks) {
    const key = normalize(t.title) + '|' + normalize(t.artist) + '|' + Math.round(t.duration / 2);
    groups.set(key, [...(groups.get(key) || []), t.id]);
  }
  return new Set([...groups.values()].filter((g) => g.length > 1).flat());
}
export function reorder<T>(list: T[], from: number, to: number): T[] {
  if (from < 0 || to < 0 || from >= list.length || to >= list.length) return list;
  const next = [...list];
  next.splice(to, 0, next.splice(from, 1)[0]);
  return next;
}
