import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { compact, mergeUpdate, updateAll } from '../src/spotifySources';
import type { Collection, Entry, Track } from '../src/types';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
const invokeMock = vi.mocked(invoke);
const entry: Entry = {
  spotifyId: 'song', title: 'Night Drive', artist: 'Aurora Lane', duration: 200,
  trackId: null, status: 'uncertain',
  candidates: [{ id: 'old', score: 0.84, reason: 'Check version details' }],
};
const collection = (): Collection => ({
  id: 'collection', name: 'A playlist', kind: 'playlist', created: 0,
  sourceUrl: 'https://open.spotify.com/playlist/source', revision: 'unchanged',
  entries: [{ ...entry }],
});

describe('Spotify update persistence', () => {
  beforeEach(() => { invokeMock.mockReset(); });

  it('saves refreshed candidates even when the source revision and match status stay the same', async () => {
    const saved = collection();
    // Two equally good local files require review; the old candidate has left the library.
    const tracks = ['first', 'second'].map((id) => ({
      id, title: entry.title, artist: entry.artist, album: '', duration: entry.duration,
      missing: false,
    } as Track));
    invokeMock.mockImplementation(async (command) => {
      if (command === 'snapshot') return {
        tracks, collections: [saved], spotify: { connected: true, playlistAccess: true },
      };
      if (command === 'spotify_revision') return saved.revision;
      if (command === 'collection') return saved;
      if (command === 'save_collection') return undefined;
      throw new Error(`Unexpected command: ${command}`);
    });
    expect(await updateAll(() => false)).toBe(1);
    expect(invokeMock).toHaveBeenCalledWith('save_collection', {
      collection: expect.objectContaining({
        entries: [expect.objectContaining({
          status: 'uncertain', candidates: [
            expect.objectContaining({ id: 'first' }),
            expect.objectContaining({ id: 'second' }),
          ],
        })],
      }),
    });
    expect(invokeMock).not.toHaveBeenCalledWith('spotify_playlist', expect.anything());
  });

  it('detects artist and duration changes without a revision fingerprint', () => {
    const saved = { ...collection(), revision: null };
    expect(mergeUpdate(saved, [{ ...entry, artist: 'Corrected artist' }], [], null).changed).toBe(true);
    expect(mergeUpdate(saved, [{ ...entry, duration: 205 }], [], null).changed).toBe(true);
  });

  it('compares the compact saved representation and treats absent revisions consistently', () => {
    const matched: Entry[] = [{
      ...entry,
      candidates: [1, 2, 3, 4].map((n) => ({ id: String(n), score: 0.812345, reason: 'Title differs' })),
    }];
    const saved = compact({ ...collection(), revision: undefined, entries: matched });
    expect(mergeUpdate(saved, matched, [], null).changed).toBe(false);
    const available: Entry = { ...entry, trackId: 'file', status: 'available' };
    const confirmed = compact({ ...saved, entries: [available] });
    expect(mergeUpdate(confirmed, [available], [{ id: 'file', missing: false } as Track]).changed).toBe(false);
  });
});
