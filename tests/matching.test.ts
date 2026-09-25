import { describe, it, expect } from 'vitest';
import { matchTracks } from '../src/matching';
import { albumsFrom, playable, reorder } from '../src/library';
import type { Track, SpotifyTrack, Collection } from '../src/types';
const local = (p: Partial<Track> = {}): Track => ({
  id: 'a',
  path: 'a.flac',
  folder: '',
  title: 'Black Hole Sun',
  artist: 'Soundgarden',
  album: 'Superunknown',
  albumArtist: 'Soundgarden',
  duration: 318,
  track: 1,
  disc: 1,
  year: 1994,
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
const remote = (p: Partial<SpotifyTrack> = {}): SpotifyTrack => ({
  id: 'spotify-a',
  name: 'Black Hole Sun',
  artists: [{ name: 'Soundgarden' }],
  duration_ms: 318000,
  track_number: 1,
  disc_number: 1,
  ...p,
});
describe('Spotify local matching', () => {
  it('matches punctuation and case while preserving remote order', () => {
    const out = matchTracks(
      [remote({ name: 'BLACK HOLE SUN!' }), remote({ id: 'b', name: 'Absent song' })],
      [local()],
    );
    expect(out.map((e) => e.status)).toEqual(['available', 'missing']);
    expect(out[0].trackId).toBe('a');
  });
  it('never silently substitutes live, acoustic, instrumental, or remix recordings', () => {
    for (const v of ['Live', 'Acoustic', 'Instrumental', 'Demo', 'Remix'])
      expect(
        matchTracks([remote()], [local({ title: `Black Hole Sun (${v})` })])[0].status,
      ).not.toBe('available');
  });
  it('requires review for a different remix or remaster', () => {
    expect(
      matchTracks(
        [remote({ name: 'Black Hole Sun (Club Remix)' })],
        [local({ title: 'Black Hole Sun (Radio Remix)' })],
      )[0].status,
    ).not.toBe('available');
    expect(
      matchTracks([remote()], [local({ title: 'Black Hole Sun (2014 Remaster)' })])[0].status,
    ).toBe('uncertain');
  });
  it('flags ambiguous duplicates', () =>
    expect(matchTracks([remote()], [local(), local({ id: 'b' })])[0].status).toBe('uncertain'));
  it('excludes missing files', () =>
    expect(matchTracks([remote()], [local({ missing: true })])[0].status).toBe('missing'));
  it('flags large duration differences', () =>
    expect(matchTracks([remote()], [local({ duration: 370 })])[0].status).toBe('uncertain'));
  it('does not match a different artist with identical title', () =>
    expect(matchTracks([remote()], [local({ artist: 'Cover artist' })])[0].status).not.toBe(
      'available',
    ));
  it('normalizes accented titles', () =>
    expect(
      matchTracks([remote({ name: 'Déjà vu' })], [local({ title: 'Deja Vu' })])[0].status,
    ).toBe('available'));
});
describe('library ordering and queues', () => {
  it('orders multidisc albums by disc then track', () =>
    expect(
      albumsFrom([
        local({ id: '3', disc: 2, track: 1 }),
        local({ id: '2', track: 2 }),
        local({ id: '1', track: 1 }),
      ])[0].tracks.map((t) => t.id),
    ).toEqual(['1', '2', '3']));
  it('separates albums with different album artists', () =>
    expect(albumsFrom([local(), local({ id: 'b', albumArtist: 'Other' })])).toHaveLength(2));
  it('uncertain and missing entries never enter queue', () => {
    const entries = matchTracks([remote()], [local()]);
    const c: Collection = {
      id: 'x',
      name: 'Album',
      kind: 'virtual',
      created: 0,
      entries: [
        ...entries,
        { ...entries[0], status: 'uncertain' },
        { ...entries[0], status: 'missing' },
      ],
    };
    expect(playable(c, [local()])).toHaveLength(1);
    expect(playable(c, [local({ missing: true })])).toHaveLength(0);
  });
  it('reorders with bounds safety', () => {
    expect(reorder([1, 2, 3], 2, 0)).toEqual([3, 1, 2]);
    expect(reorder([1, 2], 0, -1)).toEqual([1, 2]);
  });
});
