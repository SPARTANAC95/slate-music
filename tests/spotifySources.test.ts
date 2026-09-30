import { describe, it, expect } from 'vitest';
import { applyUpdate, canRead, LIKED_URL, sourceKind, topUrl } from '../src/spotifySources';
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
});
