import { useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ArrowLeft, ArrowUp, ArrowDown, Check, Link2, Search, X, ExternalLink } from 'lucide-react';
import type { Collection, Entry, SpotifyAlbum, Track } from './types';
import { matchTracks } from './matching';
import { normalize, time, reorder, entryStatus } from './library';
import { Art, IconButton } from './components';
export default function ImportPanel({
  tracks,
  existing,
  onSave,
  onSettings,
}: {
  tracks: Track[];
  existing?: Collection;
  onSave: (c: Collection) => Promise<void>;
  onSettings: () => void;
}) {
  const [url, setUrl] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [collection, setCollection] = useState<Collection | null>(existing || null),
    [picking, setPicking] = useState<number | null>(null),
    [query, setQuery] = useState('');
  const trackMap = useMemo(() => new Map(tracks.map((t) => [t.id, t])), [tracks]);
  async function fetchAlbum() {
    setBusy(true);
    setError('');
    try {
      const album = await invoke<SpotifyAlbum>('spotify_album', { url });
      setCollection({
        id: crypto.randomUUID(),
        name: album.name,
        artist: album.artists.map((a) => a.name).join(', '),
        year: Number(album.release_date.slice(0, 4)),
        kind: 'virtual',
        sourceUrl: album.url,
        created: Date.now(),
        entries: matchTracks(album.tracks, tracks),
      });
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
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
  return (
    <div className="import-content">
      {picking !== null && chosen ? (
        <>
          <button className="quiet" onClick={() => setPicking(null)}>
            <ArrowLeft size={16} />
            Back to album
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
          <button onClick={() => select(null)}>Leave this track missing</button>
        </>
      ) : collection ? (
        <>
          <div className="import-title">
            <label className="field">
              Name
              <input
                value={collection.name}
                onChange={(e) => setCollection({ ...collection, name: e.target.value })}
              />
            </label>
            <label className="field">
              Save as
              <select
                value={collection.kind}
                onChange={(e) =>
                  setCollection({ ...collection, kind: e.target.value as Collection['kind'] })
                }
              >
                <option value="virtual">Virtual album</option>
                <option value="playlist">Playlist</option>
              </select>
            </label>
          </div>
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
          </p>
          <div className="match-summary">
            {(['available', 'uncertain', 'missing'] as const).map((status) => (
              <span key={status} className={`status ${status}`}>
                {collection.entries.filter((e) => entryStatus(e, trackMap) === status).length}{' '}
                {status}
              </span>
            ))}
          </div>
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
                        label={`Move track ${i + 1} up`}
                        disabled={i === 0}
                        onClick={() => editEntries(reorder(collection.entries, i, i - 1))}
                      >
                        <ArrowUp size={14} />
                      </IconButton>
                      <IconButton
                        label={`Move track ${i + 1} down`}
                        disabled={i === collection.entries.length - 1}
                        onClick={() => editEntries(reorder(collection.entries, i, i + 1))}
                      >
                        <ArrowDown size={14} />
                      </IconButton>
                      <IconButton
                        label={`Remove track ${i + 1}`}
                        onClick={() => editEntries(collection.entries.filter((_, n) => i !== n))}
                      >
                        <X size={14} />
                      </IconButton>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <footer className="modal-footer">
            <span>{collection.entries.length} tracks, original order preserved</span>
            <button
              className="primary"
              disabled={busy || !collection.name.trim()}
              onClick={async () => {
                setBusy(true);
                try {
                  await onSave(collection);
                } catch (e) {
                  setError(String(e));
                  setBusy(false);
                }
              }}
            >
              Save {collection.kind === 'virtual' ? 'virtual album' : 'playlist'}
            </button>
          </footer>
        </>
      ) : (
        <>
          <div className="import-intro">
            <Link2 size={28} strokeWidth={1.4} />
            <h3>
              An album you love.
              <br />
              The files you already own.
            </h3>
            <p>
              Paste a Spotify album link. Slate Music matches its ordered track list against your
              local collection.
            </p>
          </div>
          <label className="field">
            Spotify album URL
            <input
              autoFocus
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://open.spotify.com/album/…"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && url) fetchAlbum();
              }}
            />
          </label>
          <div className="button-row">
            <button className="primary" onClick={fetchAlbum} disabled={busy || !url}>
              {busy ? 'Retrieving complete track list…' : 'Find matching files'}
            </button>
            <button onClick={onSettings}>Spotify setup</button>
          </div>
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
