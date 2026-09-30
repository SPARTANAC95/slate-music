import { useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  ArrowLeft,
  ArrowUp,
  ArrowDown,
  Check,
  Link2,
  ListMusic,
  Heart,
  Lock,
  RefreshCw,
  Search,
  X,
  ExternalLink,
} from 'lucide-react';
import type {
  Collection,
  Entry,
  Snapshot,
  SpotifyPlaylist,
  SpotifyPlaylistSummary,
  Track,
} from './types';
import { keepConfirmed, matchTracks } from './matching';
import { normalize, time, reorder, entryStatus } from './library';
import { Art, IconButton, Toggle } from './components';
/** Slate's address for the Liked Songs collection (matches spotify.rs). */
const LIKED_URL = 'https://open.spotify.com/collection/tracks';
export default function ImportPanel({
  tracks,
  existing,
  spotify,
  onSave,
  onSettings,
  onConnected,
}: {
  tracks: Track[];
  existing?: Collection;
  spotify: Snapshot['spotify'];
  onSave: (c: Collection) => Promise<void>;
  onSettings: () => void;
  onConnected: () => Promise<void>;
}) {
  const [url, setUrl] = useState(''),
    [busy, setBusy] = useState<'' | 'list' | 'fetch' | 'connect' | 'save'>(''),
    [loading, setLoading] = useState<string | null>(null),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [collection, setCollection] = useState<Collection | null>(existing || null),
    [playlists, setPlaylists] = useState<SpotifyPlaylistSummary[] | null>(null),
    [filter, setFilter] = useState(''),
    [heartLiked, setHeartLiked] = useState(true),
    [picking, setPicking] = useState<number | null>(null),
    [query, setQuery] = useState('');
  const trackMap = useMemo(() => new Map(tracks.map((t) => [t.id, t])), [tracks]);
  const ready = spotify.connected && spotify.playlistAccess;
  const isLiked = collection?.sourceUrl === LIKED_URL;
  const fromSpotify = !!collection?.sourceUrl?.includes('/playlist/') || isLiked;
  async function loadPlaylists() {
    setBusy('list');
    setError('');
    try {
      setPlaylists(await invoke<SpotifyPlaylistSummary[]>('spotify_playlists'));
    } catch (e) {
      setError(String(e));
      setPlaylists([]);
    } finally {
      setBusy('');
    }
  }
  useEffect(() => {
    if (!existing && ready && playlists === null) loadPlaylists();
  }, [ready]);
  async function readPlaylist(source: string, key = source) {
    setBusy('fetch');
    setLoading(key);
    setError('');
    setNotice('');
    try {
      const playlist =
        source === LIKED_URL
          ? await invoke<SpotifyPlaylist>('spotify_liked')
          : await invoke<SpotifyPlaylist>('spotify_playlist', { url: source });
      const skipped = playlist.skipped
        ? ` ${playlist.skipped} podcast episode${playlist.skipped === 1 ? '' : 's'} or unavailable item${playlist.skipped === 1 ? ' was' : 's were'} left out.`
        : '';
      return { playlist, skipped };
    } finally {
      setBusy('');
      setLoading(null);
    }
  }
  async function importPlaylist(source: string, key?: string) {
    try {
      const { playlist, skipped } = await readPlaylist(source, key);
      setNotice(skipped.trim());
      setCollection({
        id: crypto.randomUUID(),
        name: playlist.name,
        artist: playlist.owner ? `From Spotify · ${playlist.owner}` : 'From Spotify',
        kind: 'playlist',
        sourceUrl: playlist.url,
        created: Date.now(),
        entries: matchTracks(playlist.tracks, tracks),
      });
    } catch (e) {
      setError(String(e));
    }
  }
  async function refreshFromSpotify() {
    if (!collection?.sourceUrl) return;
    try {
      const { playlist, skipped } = await readPlaylist(collection.sourceUrl);
      setCollection({
        ...collection,
        entries: keepConfirmed(collection.entries, matchTracks(playlist.tracks, tracks)),
      });
      setNotice(
        `Updated to Spotify's current ${playlist.tracks.length} songs. Songs you already matched stay matched. Save to keep the update.${skipped}`,
      );
    } catch (e) {
      setError(String(e));
    }
  }
  async function allowAccess() {
    if (!spotify.clientId) return onSettings();
    setBusy('connect');
    setError('');
    try {
      await invoke('spotify_connect', { clientId: spotify.clientId });
      await onConnected();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy('');
    }
  }
  function editEntries(entries: Entry[]) {
    if (collection) setCollection({ ...collection, entries });
  }
  function select(id: string | null) {
    if (collection && picking !== null) {
      editEntries(
        collection.entries.map((e, i) =>
          i === picking ? { ...e, trackId: id, status: id ? 'available' : 'missing' } : e,
        ),
      );
      setPicking(null);
      setQuery('');
    }
  }
  const chosen = picking !== null ? collection?.entries[picking] : null;
  const candidates =
    chosen?.candidates
      ?.map((c) => trackMap.get(c.id))
      .filter((t): t is Track => !!t && !t.missing) || [];
  const results = query
    ? tracks
        .filter(
          (t) =>
            !t.missing && normalize(`${t.title} ${t.artist} ${t.album}`).includes(normalize(query)),
        )
        .slice(0, 60)
    : candidates;
  const shownPlaylists = useMemo(() => {
    const needle = normalize(filter);
    return (playlists || [])
      .filter((p) => normalize(`${p.name} ${p.owner}`).includes(needle))
      .sort((a, b) => Number(b.readable) - Number(a.readable));
  }, [playlists, filter]);
  const kindLabel = collection?.kind === 'virtual' ? 'virtual album' : 'playlist';
  return (
    <div className="import-content">
      {picking !== null && chosen ? (
        <>
          <button className="quiet" onClick={() => setPicking(null)}>
            <ArrowLeft size={16} />
            Back to {kindLabel}
          </button>
          <h3>Match “{chosen.title}”</h3>
          <p>
            {chosen.artist} · {time(chosen.duration)}
          </p>
          <label className="search-box">
            <Search size={17} />
            <input
              autoFocus
              placeholder="Search your local files…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <div className="match-candidates">
            {results.map((t) => (
              <button className="candidate" onClick={() => select(t.id)} key={t.id}>
                <Art hash={t.artwork} />
                <span>
                  <strong>{t.title}</strong>
                  <small>
                    {t.artist} · {t.album}
                  </small>
                  <small>{t.path}</small>
                </span>
                <span>{time(t.duration)}</span>
                <Check size={16} />
              </button>
            ))}
            {results.length === 0 && <p>No candidates. Search by title or artist.</p>}
          </div>
          <button onClick={() => select(null)}>Leave this song missing</button>
        </>
      ) : collection ? (
        <>
          {!existing && (
            <button
              className="quiet"
              onClick={() => {
                setCollection(null);
                setNotice('');
              }}
            >
              <ArrowLeft size={16} />
              Choose another playlist
            </button>
          )}
          <label className="field">
            Name
            <input
              value={collection.name}
              onChange={(e) => setCollection({ ...collection, name: e.target.value })}
            />
          </label>
          <p>
            {collection.artist}
            {collection.sourceUrl && (
              <button
                className="text-button source-link"
                onClick={() => invoke('open_link', { url: collection.sourceUrl })}
              >
                View on Spotify <ExternalLink size={12} />
              </button>
            )}
            {existing && fromSpotify && (
              <button
                className="text-button source-link"
                disabled={!!busy || !ready}
                title={ready ? undefined : 'Connect Spotify with playlist access in Settings'}
                onClick={refreshFromSpotify}
              >
                <RefreshCw size={12} className={busy === 'fetch' ? 'spin' : ''} />
                {busy === 'fetch' ? 'Checking Spotify…' : 'Update from Spotify'}
              </button>
            )}
          </p>
          <div className="match-summary">
            {(['available', 'uncertain', 'missing'] as const).map((status) => (
              <span key={status} className={`status ${status}`}>
                {collection.entries.filter((e) => entryStatus(e, trackMap) === status).length}{' '}
                {status}
              </span>
            ))}
          </div>
          {notice && <p className="import-notice">{notice}</p>}
          {isLiked && (
            <Toggle
              label="Also add matched songs to Favorites"
              description="Hearts every song that has a confirmed match. Songs already in Favorites stay there."
              checked={heartLiked}
              onChange={setHeartLiked}
            />
          )}
          <p className="fine-print">
            Only confirmed, available files enter playback. Review uncertain versions before saving.
            Your files and tags stay unchanged.
          </p>
          <div className="import-tracks">
            {collection.entries.map((e, i) => {
              const t = e.trackId ? trackMap.get(e.trackId) : null;
              const status = entryStatus(e, trackMap);
              return (
                <div className="import-row" key={`${e.spotifyId || e.trackId}-${i}`}>
                  <span className="index">{i + 1}</span>
                  <div className="import-track-name">
                    <strong>{e.title}</strong>
                    <small>
                      {e.artist} · {time(e.duration)}
                    </small>
                    <small className={status === 'available' ? 'muted' : 'amber'}>
                      {t
                        ? `${t.title} · ${t.album}${t.missing ? ' · File unavailable' : ''}`
                        : e.candidates?.[0]?.reason || 'No matching local file'}
                    </small>
                  </div>
                  <button
                    className={`status ${status}`}
                    onClick={() => {
                      setPicking(i);
                      setQuery('');
                    }}
                  >
                    {status === 'available'
                      ? 'Matched'
                      : status === 'uncertain'
                        ? 'Review match'
                        : 'Find file'}
                  </button>
                  {collection.kind === 'playlist' && (
                    <div className="row-actions">
                      <IconButton
                        label={`Move song ${i + 1} up`}
                        disabled={i === 0}
                        onClick={() => editEntries(reorder(collection.entries, i, i - 1))}
                      >
                        <ArrowUp size={14} />
                      </IconButton>
                      <IconButton
                        label={`Move song ${i + 1} down`}
                        disabled={i === collection.entries.length - 1}
                        onClick={() => editEntries(reorder(collection.entries, i, i + 1))}
                      >
                        <ArrowDown size={14} />
                      </IconButton>
                      <IconButton
                        label={`Remove song ${i + 1}`}
                        onClick={() => editEntries(collection.entries.filter((_, n) => i !== n))}
                      >
                        <X size={14} />
                      </IconButton>
                    </div>
                  )}
                </div>
              );
            })}
            {collection.entries.length === 0 && <p>This {kindLabel} has no songs yet.</p>}
          </div>
          <footer className="modal-footer">
            <span>
              {collection.entries.length} song{collection.entries.length === 1 ? '' : 's'}
              {fromSpotify && !existing ? ', in Spotify’s order' : ''}
            </span>
            <button
              className="primary"
              disabled={!!busy || !collection.name.trim()}
              onClick={async () => {
                setBusy('save');
                try {
                  if (isLiked && heartLiked) {
                    const ids = collection.entries.flatMap((e) =>
                      e.trackId && entryStatus(e, trackMap) === 'available' ? [e.trackId] : [],
                    );
                    await invoke('favorite_many', { ids });
                  }
                  await onSave(collection);
                } catch (e) {
                  setError(String(e));
                  setBusy('');
                }
              }}
            >
              Save {kindLabel}
            </button>
          </footer>
        </>
      ) : (
        <>
          <div className="import-intro">
            <Link2 size={28} strokeWidth={1.4} />
            <h3>
              A playlist you love.
              <br />
              The files you already own.
            </h3>
            <p>
              Choose one of your Spotify playlists. Slate Music finds each song in your local
              collection and keeps the playlist’s order.
            </p>
          </div>
          {!spotify.connected ? (
            <div className="import-callout">
              <p>Connect Spotify once, and your playlists will appear here.</p>
              <button className="primary" onClick={onSettings}>
                Set up Spotify
              </button>
            </div>
          ) : !spotify.playlistAccess ? (
            <div className="import-callout">
              <p>
                Spotify needs one more permission: letting Slate Music read your playlists. Your
                browser opens for a quick approval.
              </p>
              <button className="primary" disabled={!!busy} onClick={allowAccess}>
                {busy === 'connect' ? 'Waiting for approval in your browser…' : 'Allow playlist access'}
              </button>
            </div>
          ) : (
            <>
              <section className="playlist-picker">
                <div className="picker-heading">
                  <h4>Your Spotify playlists</h4>
                  <IconButton label="Reload playlists" disabled={!!busy} onClick={loadPlaylists}>
                    <RefreshCw size={14} className={busy === 'list' ? 'spin' : ''} />
                  </IconButton>
                </div>
                {(playlists?.length || 0) > 8 && (
                  <label className="search-box">
                    <Search size={16} />
                    <input
                      placeholder="Find a playlist…"
                      value={filter}
                      onChange={(e) => setFilter(e.target.value)}
                    />
                  </label>
                )}
                <div className="playlist-list">
                  <button
                    className="playlist-option liked"
                    disabled={!!busy}
                    onClick={() =>
                      spotify.likedAccess ? importPlaylist(LIKED_URL, 'liked') : allowAccess()
                    }
                  >
                    <Heart size={17} />
                    <span>
                      <strong>Liked Songs</strong>
                      <small>
                        {loading === 'liked'
                          ? 'Reading every song…'
                          : busy === 'connect'
                            ? 'Waiting for approval in your browser…'
                            : spotify.likedAccess
                              ? 'Import as a playlist and add matches to Favorites'
                              : 'Needs one more approval in your browser'}
                      </small>
                    </span>
                  </button>
                  {playlists === null ? (
                    <p className="fine-print">Loading your playlists…</p>
                  ) : playlists.length === 0 ? (
                    <p className="fine-print">No playlists found. Paste a link below instead.</p>
                  ) : (
                    shownPlaylists.map((p) => (
                      <button
                        key={p.id}
                        className="playlist-option"
                        disabled={!p.readable || !!busy}
                        title={
                          p.readable
                            ? undefined
                            : 'Spotify only shares playlists you created or collaborate on. Copy its songs into a playlist of your own to import it.'
                        }
                        onClick={() => importPlaylist(`spotify:playlist:${p.id}`, p.id)}
                      >
                        {p.readable ? <ListMusic size={17} /> : <Lock size={15} />}
                        <span>
                          <strong>{p.name}</strong>
                          <small>
                            {loading === p.id
                              ? 'Reading every song…'
                              : p.readable
                                ? `${p.total ?? '?'} songs · ${p.owner}`
                                : `By ${p.owner} · Spotify doesn’t share this one`}
                          </small>
                        </span>
                      </button>
                    ))
                  )}
                </div>
              </section>
              <label className="field">
                Or paste a playlist link
                <input
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://open.spotify.com/playlist/…"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && url.trim() && !busy) importPlaylist(url);
                  }}
                />
              </label>
            </>
          )}
          {spotify.connected && (
            <div className="button-row">
              {ready && (
                <button
                  className="primary"
                  onClick={() => importPlaylist(url)}
                  disabled={!!busy || !url.trim()}
                >
                  {loading === url ? 'Reading every song…' : 'Find matching files'}
                </button>
              )}
              <button onClick={onSettings}>Spotify setup</button>
            </div>
          )}
          <p className="fine-print">
            Metadata matching only. No streaming, downloads or changes to your music files.
          </p>
        </>
      )}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
