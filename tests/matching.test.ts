import { describe, it, expect } from 'vitest';
import { keepConfirmed, matchTracks } from '../src/matching';
import {
  albumsFrom,
  playable,
  playableIndices,
  reorder,
  queueEntries,
  entryStatus,
  entryFrom,
} from '../src/library';
import type { Track, SpotifyTrack, Collection, Entry } from '../src/types';
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
  originalYear: 0,
  ...p,
});
const remote = (p: Partial<SpotifyTrack> = {}): SpotifyTrack => ({
  id: 'spotify-a',
  name: 'Black Hole Sun',
  artists: [{ name: 'Soundgarden' }],
  duration_ms: 318000,
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
  it('requires review when two remasters name different releases', () => {
    expect(
      matchTracks(
        [remote({ name: 'Black Hole Sun (2014 Remaster)' })],
        [local({ title: 'Black Hole Sun (2024 Remaster)' })],
      )[0].status,
    ).toBe('uncertain');
  });
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
  it('uses the playlist song’s album to choose between an album cut and a compilation', () => {
    const album = local(),
      compilation = local({ id: 'b', album: 'A-Sides' });
    const [entry] = matchTracks(
      [remote({ album: 'Superunknown' })],
      [compilation, album],
    );
    expect(entry.status).toBe('available');
    expect(entry.trackId).toBe('a');
    expect(
      matchTracks([remote({ album: 'Superunknown' })], [local({ title: 'Spoonman' })])[0].status,
    ).toBe('missing');
  });
  it('matches Spotify local files, which have no Spotify ID', () => {
    const [entry] = matchTracks([remote({ id: null })], [local()]);
    expect(entry.spotifyId).toBeUndefined();
    expect(entry.trackId).toBe('a');
  });
  it('keeps confirmed matches when a playlist is updated from Spotify', () => {
    const previous: Entry[] = [
      { spotifyId: 's1', trackId: 'manual', title: 'x', artist: 'y', duration: 1, status: 'available' },
      { spotifyId: 's2', trackId: null, title: 'x', artist: 'y', duration: 1, status: 'missing' },
      { spotifyId: 's3', trackId: 'old', title: 'x', artist: 'y', duration: 1, status: 'uncertain' },
    ];
    const next: Entry[] = [
      { spotifyId: 's4', trackId: 'new', title: 'n', artist: 'y', duration: 1, status: 'available' },
      { spotifyId: 's1', trackId: null, title: 'x', artist: 'y', duration: 1, status: 'uncertain' },
      { spotifyId: 's2', trackId: 'found', title: 'x', artist: 'y', duration: 1, status: 'available' },
      { spotifyId: 's3', trackId: null, title: 'x', artist: 'y', duration: 1, status: 'missing' },
      { trackId: null, title: 'local', artist: 'y', duration: 1, status: 'missing' },
    ];
    const merged = keepConfirmed(previous, next);
    expect(merged.map((e) => [e.trackId, e.status])).toEqual([
      ['new', 'available'],
      ['manual', 'available'],
      ['found', 'available'],
      [null, 'missing'],
      [null, 'missing'],
    ]);
  });
});
describe('library ordering and queues', () => {
  it('shows unavailable saved matches as missing without discarding their confirmed identity', () => {
    const track = local();
    const entry = entryFrom(track);
    expect(entryStatus(entry, new Map())).toBe('missing');
    expect(entryStatus(entry, new Map([[track.id, { ...track, missing: true }]]))).toBe('missing');
    expect(entry.trackId).toBe(track.id);
    expect(entry.status).toBe('available');
    expect(entryStatus(entry, new Map([[track.id, track]]))).toBe('available');
    expect(entryStatus({ ...entry, status: 'uncertain' }, new Map([[track.id, track]]))).toBe(
      'uncertain',
    );
  });
  it('keeps original queue positions through search, duplicate entries and unknown IDs', () => {
    const a = local(),
      b = local({ id: 'b', title: 'Spoonman' });
    const rows = queueEntries(
      ['gone', 'a', 'b', 'a'],
      new Map([
        [a.id, a],
        [b.id, b],
      ]),
      'black hole',
    );
    expect(rows.map((r) => r.index)).toEqual([1, 3]);
    expect(rows.map((r) => r.track.id)).toEqual(['a', 'a']);
    expect(
      queueEntries(
        ['a', 'b'],
        new Map([
          [a.id, a],
          [b.id, b],
        ]),
        'SPOONMAN',
      )[0].index,
    ).toBe(1);
  });
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
  it('maps playlist rows back to their entries, skipping unplayable ones', () => {
    const a = local(),
      b = local({ id: 'b' });
    const entry = (trackId: string | null, status: Entry['status'] = 'available'): Entry => ({
      trackId,
      title: '',
      artist: '',
      duration: 0,
      status,
    });
    const c: Collection = {
      id: 'p',
      name: 'Mix',
      kind: 'playlist',
      created: 0,
      entries: [entry('a'), entry(null, 'missing'), entry('b', 'uncertain'), entry('a'), entry('b')],
    };
    expect(playableIndices(c, [a, b])).toEqual([0, 3, 4]);
    expect(playable(c, [a, b]).map((t) => t.id)).toEqual(['a', 'a', 'b']);
  });
  it('reorders with bounds safety', () => {
    expect(reorder([1, 2, 3], 2, 0)).toEqual([3, 1, 2]);
    expect(reorder([1, 2], 0, -1)).toEqual([1, 2]);
  });
});
