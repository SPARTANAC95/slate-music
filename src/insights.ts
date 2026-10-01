import type { Album, Track } from './types';

/** One play: [track ID, Unix ms]. */
export type Play = [string, number];
const DAY = 24 * 3600 * 1000;
const dayKey = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
};

/** Albums you played most recently, newest first. */
export function jumpBackIn(tracks: Track[], albums: Album[], limit = 6): Album[] {
  const byTrack = new Map<string, Album>();
  for (const a of albums) for (const t of a.tracks) byTrack.set(t.id, a);
  const seen = new Set<string>();
  return [...tracks]
    .filter((t) => t.lastPlayed > 0)
    .sort((a, b) => b.lastPlayed - a.lastPlayed)
    .flatMap((t) => {
      const a = byTrack.get(t.id);
      if (!a || seen.has(a.key)) return [];
      seen.add(a.key);
      return [a];
    })
    .slice(0, limit);
}
/** Albums added to the library most recently. */
export function recentlyAdded(albums: Album[], limit = 6): Album[] {
  const newest = (a: Album) => Math.max(...a.tracks.map((t) => t.added || 0));
  return [...albums].sort((a, b) => newest(b) - newest(a)).slice(0, limit);
}
/** Favourites not played for `days` days (or never), longest-forgotten first. */
export function forgottenFavorites(tracks: Track[], now: number, days = 60, limit = 8): Track[] {
  return tracks
    .filter((t) => t.favorite && !t.missing && now - t.lastPlayed > days * DAY)
    .sort((a, b) => a.lastPlayed - b.lastPlayed)
    .slice(0, limit);
}
/** Songs you played on today's date in earlier years, with the year of that play. */
export function onThisDay(plays: Play[], now: number): { id: string; year: number }[] {
  const today = new Date(now);
  const seen = new Set<string>();
  return plays
    .filter(([, at]) => {
      const d = new Date(at);
      return d.getMonth() === today.getMonth() && d.getDate() === today.getDate() && d.getFullYear() < today.getFullYear();
    })
    .reverse()
    .flatMap(([id, at]) => (seen.has(id) ? [] : (seen.add(id), [{ id, year: new Date(at).getFullYear() }])));
}

export interface YearStats {
  year: number;
  plays: number;
  minutes: number;
  songs: number;
  artists: number;
  topSongs: { track: Track; plays: number }[];
  topArtists: { name: string; plays: number; artwork: string | null }[];
  topAlbums: { album: string; artist: string; plays: number; artwork: string | null }[];
  /** Plays per month, January first. */
  months: number[];
  busiestDay: { date: number; plays: number } | null;
  longestStreak: number;
  /** Artists first played this year. */
  discoveries: string[];
}
const top = <T,>(counts: Map<string, number>, make: (key: string, n: number) => T, limit = 5) =>
  [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit).map(([k, n]) => make(k, n));

/** A year in review from local play history. `all` is every play ever, for discoveries. */
export function yearInReview(year: number, all: Play[], trackMap: Map<string, Track>): YearStats {
  const plays = all.filter(([, at]) => new Date(at).getFullYear() === year);
  const songs = new Map<string, number>(),
    artists = new Map<string, number>(),
    albums = new Map<string, number>(),
    days = new Map<string, number>(),
    art = new Map<string, string | null>();
  const months = Array(12).fill(0);
  let minutes = 0;
  for (const [id, at] of plays) {
    const t = trackMap.get(id);
    months[new Date(at).getMonth()] += 1;
    days.set(dayKey(at), (days.get(dayKey(at)) || 0) + 1);
    if (!t) continue;
    minutes += t.duration / 60;
    songs.set(id, (songs.get(id) || 0) + 1);
    artists.set(t.albumArtist, (artists.get(t.albumArtist) || 0) + 1);
    const album = `${t.album}\u0000${t.albumArtist}`;
    albums.set(album, (albums.get(album) || 0) + 1);
    if (t.artwork) {
      art.set(album, art.get(album) ?? t.artwork);
      art.set(t.albumArtist, art.get(t.albumArtist) ?? t.artwork);
    }
  }
  // Longest run of consecutive days with at least one play.
  const dayStarts = [...new Set(plays.map(([, at]) => new Date(new Date(at).toDateString()).getTime()))].sort((a, b) => a - b);
  let longest = 0,
    run = 0;
  dayStarts.forEach((d, i) => {
    run = i > 0 && Math.round((d - dayStarts[i - 1]) / DAY) === 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
  });
  const busiest = [...days.entries()].sort((a, b) => b[1] - a[1])[0];
  const firstYear = new Map<string, number>();
  for (const [id, at] of all) {
    const t = trackMap.get(id);
    if (t && !firstYear.has(t.albumArtist)) firstYear.set(t.albumArtist, new Date(at).getFullYear());
  }
  return {
    year,
    plays: plays.length,
    minutes: Math.round(minutes),
    songs: songs.size,
    artists: artists.size,
    topSongs: top(songs, (id, n) => ({ track: trackMap.get(id)!, plays: n })),
    topArtists: top(artists, (name, n) => ({ name, plays: n, artwork: art.get(name) ?? null })),
    topAlbums: top(albums, (key, n) => {
      const [album, artist] = key.split('\u0000');
      return { album, artist, plays: n, artwork: art.get(key) ?? null };
    }),
    months,
    busiestDay: busiest
      ? { date: plays.find(([, at]) => dayKey(at) === busiest[0])![1], plays: busiest[1] }
      : null,
    longestStreak: longest,
    discoveries: [...firstYear.entries()].filter(([, y]) => y === year).map(([name]) => name).sort(),
  };
}
