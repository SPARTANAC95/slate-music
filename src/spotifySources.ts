import { invoke } from '@tauri-apps/api/core';
import type { Collection, Entry, Snapshot, SpotifyPlaylist, Track } from './types';
import { keepConfirmed, matchTracks } from './matching';

/** Slate's address for the Liked Songs collection (matches spotify.rs). */
export const LIKED_URL = 'https://open.spotify.com/collection/tracks';
/** Spotify's top-song periods; the address is `spotify:top:<range>`. */
export const TOP_RANGES = [
  { range: 'short_term', label: 'this month' },
  { range: 'medium_term', label: 'last 6 months' },
  { range: 'long_term', label: 'last year' },
] as const;
export const topUrl = (range: string) => `spotify:top:${range}`;

export type SourceKind = 'playlist' | 'liked' | 'top';
export function sourceKind(url?: string): SourceKind | null {
  if (!url) return null;
  if (url === LIKED_URL) return 'liked';
  if (url.startsWith('spotify:top:')) return 'top';
  if (url.includes('open.spotify.com/playlist/')) return 'playlist';
  return null;
}
/** Whether the current Spotify connection has the permission this source needs. */
export function canRead(spotify: Snapshot['spotify'], url?: string) {
  const kind = sourceKind(url);
  return (
    spotify.connected &&
    (kind === 'playlist'
      ? spotify.playlistAccess
      : kind === 'liked'
        ? spotify.likedAccess
        : kind === 'top'
          ? spotify.topAccess
          : false)
  );
}
export function readSource(url: string): Promise<SpotifyPlaylist> {
  const kind = sourceKind(url);
  return kind === 'liked'
    ? invoke('spotify_liked')
    : kind === 'top'
      ? invoke('spotify_top', { source: url })
      : invoke('spotify_playlist', { url });
}

/** Applies a fresh Spotify song list to a saved collection, keeping confirmed matches.
 * `hearts` lists songs matched for the first time, for collections that heart matches. */
export function applyUpdate(c: Collection, playlist: SpotifyPlaylist, tracks: Track[]) {
  const entries = keepConfirmed(c.entries, matchTracks(playlist.tracks, tracks));
  const signature = (list: Entry[]) =>
    JSON.stringify(list.map((e) => [e.spotifyId, e.title, e.trackId, e.status]));
  const before = new Set(c.entries.filter((e) => e.trackId && e.status === 'available').map((e) => e.trackId));
  const hearts = c.heartMatches
    ? entries.flatMap((e) =>
        e.trackId && e.status === 'available' && !before.has(e.trackId) ? [e.trackId] : [],
      )
    : [];
  return {
    collection: { ...c, entries },
    changed: signature(entries) !== signature(c.entries),
    hearts,
  };
}

/** Refreshes every imported collection that updates automatically. Collections Spotify
 * cannot currently be asked about (offline, missing permission) are left as they are. */
export async function updateAll(data: Snapshot): Promise<number> {
  let updated = 0;
  for (const c of data.collections) {
    if (c.autoUpdate === false || !canRead(data.spotify, c.sourceUrl)) continue;
    try {
      const result = applyUpdate(c, await readSource(c.sourceUrl!), data.tracks);
      if (result.hearts.length) await invoke('favorite_many', { ids: result.hearts });
      if (result.changed) {
        await invoke('save_collection', { collection: result.collection });
        updated += 1;
      }
    } catch {
      // Offline or refused: try again next time the app opens.
    }
  }
  return updated;
}
