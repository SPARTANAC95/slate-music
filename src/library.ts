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
export const entryFrom = (t: Track): Entry => ({
  trackId: t.id,
  title: t.title,
  artist: t.artist,
  duration: t.duration,
  status: t.missing ? 'missing' : 'available',
});
export function entryStatus(entry: Entry, tracks: Map<string, Track>): Entry['status'] {
  const track = entry.trackId ? tracks.get(entry.trackId) : undefined;
  return entry.status === 'available' && (!track || track.missing) ? 'missing' : entry.status;
}
export function playable(c: Collection, tracks: Track[]): Track[] {
  const map = new Map(tracks.map((t) => [t.id, t]));
  return c.entries.flatMap((e) => {
    const t = e.trackId ? map.get(e.trackId) : null;
    return e.status === 'available' && t && !t.missing ? [t] : [];
  });
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
