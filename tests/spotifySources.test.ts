import { describe, it, expect } from 'vitest';
import { applyUpdate, canRead, compact, followsSpotify, LIKED_URL, savedAsPlaylist, sourceKind, topUrl } from '../src/spotifySources';
import type { Collection, Snapshot, SpotifyPlaylist, Track } from '../src/types';

const track = (id: string, title: string): Track => ({
  id,
  path: `${id}.flac`,
  folder: '',
  title,
  artist: 'Aurora Lane',
  album: 'Night Drive',
  albumArtist: 'Aurora Lane',
  duration: 200,
  track: 1,
  disc: 1,
  year: 2024,
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
});
const song = (id: string, name: string) => ({
  id,
  name,
  artists: [{ name: 'Aurora Lane' }],
  album: 'Night Drive',
  duration_ms: 200000,
});
const list = (tracks: ReturnType<typeof song>[]): SpotifyPlaylist => ({
  id: 'p',
  name: 'Late drives',
  owner: 'Me',
  url: 'https://open.spotify.com/playlist/p',
  tracks,
  skipped: 0,
});
const spotify = (p: Partial<Snapshot['spotify']>): Snapshot['spotify'] => ({
  connected: true,
  playlistAccess: false,
  likedAccess: false,
  topAccess: false,
  clientId: null,
  redirectUri: '',
  ...p,
});

describe('Spotify sources', () => {
  it('recognizes playlists, Liked Songs and top songs', () => {
    expect(sourceKind('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M')).toBe('playlist');
    expect(sourceKind(LIKED_URL)).toBe('liked');
    expect(sourceKind(topUrl('short_term'))).toBe('top');
    expect(sourceKind('https://open.spotify.com/album/x')).toBeNull();
    expect(sourceKind(undefined)).toBeNull();
  });
  it('only reads a source the connection has permission for', () => {
    expect(canRead(spotify({ playlistAccess: true }), LIKED_URL)).toBe(false);
    expect(canRead(spotify({ likedAccess: true }), LIKED_URL)).toBe(true);
    expect(canRead(spotify({ topAccess: true, connected: false }), topUrl('long_term'))).toBe(false);
    expect(canRead(spotify({ playlistAccess: true }), undefined)).toBe(false);
  });
  it('updates a saved playlist, keeps confirmed matches and reports no change when equal', () => {
    const tracks = [track('a', 'Neon Rain'), track('b', 'Afterglow')];
    const saved: Collection = {
      id: 'c',
      name: 'Late drives',
      kind: 'playlist',
      created: 0,
      sourceUrl: 'https://open.spotify.com/playlist/p',
      entries: [
        { spotifyId: 's1', trackId: 'b', title: 'Neon Rain', artist: 'Aurora Lane', duration: 200, status: 'available' },
      ],
    };
    const same = applyUpdate(saved, list([song('s1', 'Neon Rain')]), tracks);
    expect(same.collection.entries[0].trackId).toBe('b');
    expect(same.changed).toBe(false);
    const grown = applyUpdate(saved, list([song('s1', 'Neon Rain'), song('s2', 'Afterglow')]), tracks);
    expect(grown.changed).toBe(true);
    expect(grown.collection.entries.map((e) => e.trackId)).toEqual(['b', 'b']);
    expect(grown.hearts).toEqual([]);
  });
  it('hearts only newly matched songs for collections that heart matches', () => {
    const tracks = [track('a', 'Neon Rain'), track('b', 'Afterglow')];
    const liked: Collection = {
      id: 'l',
      name: 'Liked Songs',
      kind: 'playlist',
      created: 0,
      sourceUrl: LIKED_URL,
      heartMatches: true,
      entries: [
        { spotifyId: 's1', trackId: 'a', title: 'Neon Rain', artist: 'Aurora Lane', duration: 200, status: 'available' },
      ],
    };
    const result = applyUpdate(liked, list([song('s2', 'Afterglow'), song('s1', 'Neon Rain')]), tracks);
    expect(result.hearts).toEqual(['b']);
  });
  it('keeps "leave missing" choices and local-file matches, and re-matches files that left', () => {
    const tracks = [track('a', 'Neon Rain'), track('b', 'Afterglow')];
    const saved: Collection = {
      id: 'c',
      name: 'Mix',
      kind: 'playlist',
      created: 0,
      sourceUrl: 'https://open.spotify.com/playlist/p',
      entries: [
        { spotifyId: 's1', trackId: null, title: 'Neon Rain', artist: 'Aurora Lane', duration: 200, status: 'missing', rejected: true },
        { trackId: 'b', title: 'Home recording', artist: 'Aurora Lane', duration: 200, status: 'available' },
        { spotifyId: 's3', trackId: 'gone', title: 'Afterglow', artist: 'Aurora Lane', duration: 200, status: 'available' },
      ],
    };
    const local = { id: null, name: 'Home recording', artists: [{ name: 'Aurora Lane' }], duration_ms: 200000 };
    const result = applyUpdate(saved, list([song('s1', 'Neon Rain'), local, song('s3', 'Afterglow')]), tracks);
    expect(result.collection.entries.map((e) => [e.trackId, e.status])).toEqual([
      [null, 'missing'], // rejected stays rejected
      ['b', 'available'], // local file keeps its manual match
      ['b', 'available'], // "gone" left the library, so Afterglow was matched again
    ]);
  });
  it('stores saved playlists compactly and re-matches them from their own entries', () => {
    const c: Collection = {
      id: 'c',
      name: 'Mix',
      kind: 'playlist',
      created: 0,
      sourceUrl: LIKED_URL,
      entries: [
        { trackId: 'a', title: 'x', artist: 'A, B', duration: 1, status: 'available', candidates: [{ id: 'a', score: 0.9912345, reason: 'r' }] },
        { trackId: null, title: 'y', artist: 'A', duration: 2, status: 'uncertain',
          candidates: [1, 2, 3, 4].map((n) => ({ id: `c${n}`, score: 0.7123456, reason: 'r' })) },
      ],
    };
    const small = compact(c);
    expect(small.entries[0].candidates).toBeUndefined();
    expect(small.entries[1].candidates).toHaveLength(3);
    expect(small.entries[1].candidates![0].score).toBe(0.712);
    expect(savedAsPlaylist(c).tracks[0].artists).toEqual([{ name: 'A' }, { name: 'B' }]);
    expect(followsSpotify(c)).toBe(true);
    expect(followsSpotify({ ...c, autoUpdate: false })).toBe(false);
  });
});
