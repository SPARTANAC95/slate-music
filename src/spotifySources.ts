import { invoke } from '@tauri-apps/api/core';
import type { Collection, Entry, Snapshot, SpotifyPlaylist, Track } from './types';
import { keepConfirmed, matchInBatches, matchTracks } from './matching';

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
/** A collection that follows Spotify: its song list is replaced on every update, so songs
 * added or removed by hand would not last. */
export const followsSpotify = (c: Collection) =>
  sourceKind(c.sourceUrl) !== null && c.autoUpdate !== false;
export function readSource(url: string): Promise<SpotifyPlaylist> {
  const kind = sourceKind(url);
  return kind === 'liked'
    ? invoke('spotify_liked')
    : kind === 'top'
      ? invoke('spotify_top', { source: url })
      : invoke('spotify_playlist', { url });
}

/** Drops matching details that are only needed while reviewing, keeping saved playlists
 * small (Liked Songs can run to thousands of songs). */
export function compact(c: Collection): Collection {
  return {
    ...c,
    entries: c.entries.map((e) =>
      e.status === 'available' || !e.candidates?.length
        ? { ...e, candidates: undefined }
        : {
            ...e,
            candidates: e.candidates
              .slice(0, 3)
              .map((x) => ({ ...x, score: Math.round(x.score * 1000) / 1000 })),
          },
    ),
  };
}

/** Merges freshly matched entries into the current saved collection.
 * `hearts` lists songs matched for the first time, for collections that heart matches. */
export function mergeUpdate(
  current: Collection,
  matched: Entry[],
  tracks: Track[],
  revision?: string | null,
) {
  const byId = new Map(tracks.map((t) => [t.id, t]));
  const entries = keepConfirmed(current.entries, matched, byId);
  // Compare what will actually be saved, including metadata and review candidates. Raw
  // scores and extra candidates are deliberately compacted so they do not cause repeat saves.
  const signature = (list: Entry[]) =>
    JSON.stringify(compact({ ...current, entries: list }).entries.map((e) => [
      e.spotifyId ?? null, e.title, e.artist, e.duration, e.trackId, e.status, !!e.rejected,
      e.candidates?.map((c) => [c.id, c.score, c.reason]) ?? [],
    ]));
  const nextRevision = revision ?? current.revision ?? null;
  const before = new Set(
    current.entries.filter((e) => e.trackId && e.status === 'available').map((e) => e.trackId),
  );
  const hearts = current.heartMatches
    ? entries.flatMap((e) =>
        e.trackId && e.status === 'available' && !before.has(e.trackId) ? [e.trackId] : [],
      )
    : [];
  return {
    collection: { ...current, entries, revision: nextRevision },
    changed: signature(entries) !== signature(current.entries) || nextRevision !== (current.revision ?? null),
    hearts,
  };
}
export const applyUpdate = (c: Collection, playlist: SpotifyPlaylist, tracks: Track[]) =>
  mergeUpdate(c, matchTracks(playlist.tracks, tracks), tracks, playlist.revision);

/** The saved entries as a song list, to match them again against new local files without
 * asking Spotify (used when Spotify reports no change). */
export const savedAsPlaylist = (c: Collection): SpotifyPlaylist => ({
  id: c.id,
  name: c.name,
  owner: '',
  url: c.sourceUrl || '',
  skipped: 0,
  revision: c.revision,
  tracks: c.entries.map((e) => ({
    id: e.spotifyId ?? null,
    name: e.title,
    artists: e.artist.split(', ').map((name) => ({ name })),
    duration_ms: e.duration * 1000,
  })),
});

/** Brings every imported collection that updates automatically up to date. Works from a
 * fresh snapshot and re-reads each collection just before saving it, so a collection deleted,
 * renamed or edited meanwhile is never overwritten with an older copy. Sources Spotify says
 * are unchanged are not downloaded again; their missing songs are still matched against new
 * files. Sources that cannot be read now (offline, no permission) are left as they are. */
export async function updateAll(isEditing: (id: string) => boolean): Promise<number> {
  const start = await invoke<Snapshot>('snapshot');
  let updated = 0;
  for (const c of start.collections) {
    if (!followsSpotify(c) || !canRead(start.spotify, c.sourceUrl) || isEditing(c.id)) continue;
    try {
      const revision = await invoke<string | null>('spotify_revision', { source: c.sourceUrl });
      const source =
        revision && revision === c.revision ? savedAsPlaylist(c) : await readSource(c.sourceUrl!);
      const matched = await matchInBatches(source.tracks, start.tracks);
      const current = await invoke<Collection | null>('collection', { id: c.id });
      if (!current || !followsSpotify(current) || isEditing(c.id)) continue;
      const result = mergeUpdate(current, matched, start.tracks, source.revision ?? revision);
      if (!result.changed) continue;
      await invoke('save_collection', { collection: compact(result.collection) });
      if (result.hearts.length) await invoke('favorite_many', { ids: result.hearts });
      updated += 1;
    } catch {
      // Offline or refused: try again next time the app opens.
    }
  }
  return updated;
}
