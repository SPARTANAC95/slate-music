import { describe, it, expect } from 'vitest';
import { forgottenFavorites, jumpBackIn, onThisDay, recentlyAdded, yearInReview, type Play } from '../src/insights';
import { albumsFrom } from '../src/library';
import type { Track } from '../src/types';

const track = (id: string, p: Partial<Track> = {}): Track => ({
  id,
  path: `${id}.flac`,
  folder: '',
  title: id,
  artist: 'A',
  album: 'One',
  albumArtist: 'A',
  duration: 180,
  track: 1,
  disc: 1,
  year: 2020,
  originalYear: 0,
  format: 'FLAC',
  sampleRate: 44100,
  bitDepth: 16,
  artwork: null,
  favorite: false,
  missing: false,
  playCount: 0,
  lastPlayed: 0,
  added: 0,
  size: 1,
  ...p,
});
const at = (y: number, m: number, d: number, h = 12) => new Date(y, m, d, h).getTime();

describe('home shelves', () => {
  const tracks = [
    track('a', { lastPlayed: 50, added: 1 }),
    track('b', { album: 'Two', lastPlayed: 90, added: 5 }),
    track('c', { album: 'Three', added: 9 }),
    track('d', { album: 'Two', lastPlayed: 10, favorite: true }),
    track('e', { album: 'One', favorite: true, lastPlayed: at(2026, 8, 29) }),
  ];
  const albums = albumsFrom(tracks);
  it('lists recently played albums once each, newest first', () => {
    expect(jumpBackIn(tracks, albums).map((a) => a.name)).toEqual(['One', 'Two']);
  });
  it('lists recently added albums', () => {
    expect(recentlyAdded(albums).map((a) => a.name)).toEqual(['Three', 'Two', 'One']);
  });
  it('finds favourites not played for a while', () => {
    expect(forgottenFavorites(tracks, at(2026, 8, 30)).map((t) => t.id)).toEqual(['d']);
  });
  it('finds songs played on this date in earlier years', () => {
    const plays: Play[] = [['a', at(2024, 8, 30)], ['b', at(2025, 8, 30)], ['a', at(2025, 8, 30, 20)], ['c', at(2026, 8, 30)], ['d', at(2025, 8, 29)]];
    expect(onThisDay(plays, at(2026, 8, 30))).toEqual([
      { id: 'a', year: 2025 },
      { id: 'b', year: 2025 },
    ]);
  });
});

describe('year in review', () => {
  const tracks = new Map(
    [track('a', { artwork: 'art1' }), track('b', { albumArtist: 'B', album: 'Bee', duration: 120 }), track('c', { albumArtist: 'C', album: 'Sea' })].map(
      (t) => [t.id, t],
    ),
  );
  const plays: Play[] = [
    ['c', at(2025, 5, 1)],
    ['a', at(2026, 0, 1)],
    ['a', at(2026, 0, 2)],
    ['b', at(2026, 0, 3)],
    ['a', at(2026, 2, 10)],
    ['c', at(2026, 2, 10, 15)],
    ['gone', at(2026, 2, 10, 16)],
  ];
  const y = yearInReview(2026, plays, tracks);
  it('counts plays, time and variety', () => {
    expect(y.plays).toBe(6);
    expect(y.minutes).toBe(3 * 3 + 2 + 3);
    expect([y.songs, y.artists]).toEqual([3, 3]);
    expect(y.months.slice(0, 3)).toEqual([3, 0, 3]);
  });
  it('ranks the tops and finds streaks, the busiest day and new artists', () => {
    expect(y.topSongs[0]).toMatchObject({ plays: 3, track: { id: 'a' } });
    expect(y.topArtists.map((a) => a.name)).toEqual(['A', 'B', 'C']);
    expect(y.topArtists[0].artwork).toBe('art1');
    expect(y.topAlbums[0]).toMatchObject({ album: 'One', artist: 'A', plays: 3 });
    expect(y.longestStreak).toBe(3);
    expect(y.busiestDay?.plays).toBe(3);
    expect(y.discoveries).toEqual(['A', 'B']);
  });
});
