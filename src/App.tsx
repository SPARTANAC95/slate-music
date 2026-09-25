import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import {
  Home,
  Music2,
  Disc3,
  Users,
  Heart,
  History,
  ListMusic,
  Settings as SettingsIcon,
  Search,
  Plus,
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Shuffle,
  Repeat,
  Repeat1,
  Volume2,
  VolumeX,
  PanelRightClose,
  PanelRightOpen,
  Minimize2,
  Minus,
  Maximize2,
  X,
  ArrowLeft,
  ArrowRight,
  FolderPlus,
  RefreshCw,
  Link2,
  MoreHorizontal,
  Check,
  ChevronRight,
  Headphones,
  HardDrive,
  Download,
  Trash2,
  Pencil,
} from 'lucide-react';
import type { Album, Collection, Playback, Scan, Settings, Snapshot, Track } from './types';
import {
  albumsFrom,
  duplicates,
  durationLabel,
  entryFrom,
  normalize,
  playable,
  time,
} from './library';
import { Art, Empty, IconButton, Modal, TrackTable } from './components';
import SettingsPanel from './SettingsPanel';
import ImportPanel from './ImportPanel';
import { useUpdater } from './updater';

type Page =
  | 'Home'
  | 'Songs'
  | 'Albums'
  | 'Artists'
  | 'Favorites'
  | 'Recently played'
  | 'Playlists'
  | 'Queue'
  | 'Album'
  | 'Artist'
  | 'Collection';
type Dialog =
  | 'settings'
  | 'import'
  | 'newPlaylist'
  | 'addToPlaylist'
  | 'editCollection'
  | 'deleteCollection'
  | 'install'
  | null;
const defaults: Settings = { autoCheck: true, autoDownload: true, showListening: true };
const nav = [
  { name: 'Home', icon: Home },
  { name: 'Songs', icon: Music2 },
  { name: 'Albums', icon: Disc3 },
  { name: 'Artists', icon: Users },
  { name: 'Favorites', icon: Heart },
  { name: 'Recently played', icon: History },
  { name: 'Playlists', icon: ListMusic },
] as const;
export default function App() {
  const [data, setData] = useState<Snapshot | null>(null),
    [pb, setPb] = useState<Playback | null>(null),
    [loading, setLoading] = useState(true),
    [fatal, setFatal] = useState(''),
    [page, setPage] = useState<Page>('Home'),
    [query, setQuery] = useState(''),
    [sort, setSort] = useState('title'),
    [filter, setFilter] = useState('all'),
    [selectedAlbum, setSelectedAlbum] = useState(''),
    [selectedArtist, setSelectedArtist] = useState(''),
    [selectedCollection, setSelectedCollection] = useState(''),
    [dialog, setDialog] = useState<Dialog>(null),
    [addTrack, setAddTrack] = useState<Track | null>(null),
    [playlistName, setPlaylistName] = useState(''),
    [toast, setToast] = useState(''),
    [settings, setSettings] = useState<Settings>(defaults),
    [seek, setSeek] = useState<number | null>(null);
  const searchRef = useRef<HTMLInputElement>(null),
    initialPicker = useRef(false),
    initialized = useRef(false),
    exitAllowed = useRef(false);
  const mini = new URLSearchParams(location.search).has('mini');
  const updater = useUpdater();
  const deferredQuery = useDeferredValue(query);
  const notify = useCallback((message: string) => setToast(message), []);
  const refresh = useCallback(async () => {
    try {
      const next = await invoke<Snapshot>('snapshot');
      setData(next);
      setPb(next.playback);
      setSettings({ ...defaults, ...next.settings });
      setLoading(false);
      setFatal('');
    } catch (e) {
      setFatal(String(e));
      setLoading(false);
    }
  }, []);
  const command = useCallback(
    async (action: string, value?: unknown) => {
      try {
        const next = await invoke<Playback>('playback', { action, value: value ?? null });
        setPb(next);
        return next;
      } catch (e) {
        notify(String(e));
        return null;
      }
    },
    [notify],
  );
  const task = useCallback(
    async (action: () => Promise<unknown>, message?: string) => {
      try {
        await action();
        if (message) notify(message);
      } catch (e) {
        notify(String(e));
      }
    },
    [notify],
  );
  useEffect(() => {
    refresh();
    const promises = [
      listen<Playback>('playback', (e) => setPb(e.payload)),
      listen<Scan>('scan', (e) => setData((d) => (d ? { ...d, scan: e.payload } : d))),
      listen('library-changed', refresh),
      listen('history-changed', refresh),
    ];
    return () => {
      for (const p of promises) p.then((fn) => fn());
    };
  }, [refresh]);
  useEffect(() => {
    if (!data || initialized.current || mini) return;
    initialized.current = true;
    if (data.folders.length === 0 && !initialPicker.current) {
      initialPicker.current = true;
      task(async () => {
        await invoke('add_folder');
        await refresh();
      });
    }
  }, [data, mini, refresh, task]);
  useEffect(() => {
    if (!data || mini || !settings.autoCheck) return;
    const t = setTimeout(() => updater.checkNow(settings.autoDownload), 30000);
    const i = setInterval(() => updater.checkNow(settings.autoDownload), 6 * 60 * 60 * 1000);
    return () => {
      clearTimeout(t);
      clearInterval(i);
    };
  }, [!!data, mini, settings.autoCheck, settings.autoDownload]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(''), 6500);
    return () => clearTimeout(t);
  }, [toast]);
  useEffect(() => {
    if (mini) return;
    const pending = getCurrentWindow().onCloseRequested((e) => {
      e.preventDefault();
      if (updater.ready && !exitAllowed.current) {
        setDialog('install');
      } else {
        task(() => invoke('quit_app'));
      }
    });
    return () => {
      pending.then((fn) => fn());
    };
  }, [updater.ready, mini, task]);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag) || dialog) return;
      if (e.ctrlKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.code === 'Space') {
        e.preventDefault();
        command('toggle');
      } else if (e.ctrlKey && e.key === 'ArrowRight') {
        e.preventDefault();
        command('next');
      } else if (e.ctrlKey && e.key === 'ArrowLeft') {
        e.preventDefault();
        command('previous');
      } else if (e.key === 'ArrowRight' && pb) {
        e.preventDefault();
        command('seek', pb.position + 5);
      } else if (e.key === 'ArrowLeft' && pb) {
        e.preventDefault();
        command('seek', Math.max(0, pb.position - 5));
      } else if (e.ctrlKey && e.key.toLowerCase() === 'm') {
        e.preventDefault();
        task(() => invoke('mini_player'));
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [pb, dialog, command, task]);
  const tracks = data?.tracks || [];
  const trackMap = useMemo(() => new Map(tracks.map((t) => [t.id, t])), [tracks]);
  const albums = useMemo(() => albumsFrom(tracks), [tracks]);
  const duplicateIds = useMemo(() => duplicates(tracks), [tracks]);
  const current = pb?.currentId ? trackMap.get(pb.currentId) : null;
  const album = albums.find((a) => a.key === selectedAlbum),
    collection = data?.collections.find((c) => c.id === selectedCollection);
  const artistNames = useMemo(
    () => [...new Set(tracks.map((t) => t.albumArtist))].sort((a, b) => a.localeCompare(b)),
    [tracks],
  );
  const favoriteCount = tracks.filter((t) => t.favorite).length;
  const recent = useMemo(
    () => tracks.filter((t) => t.lastPlayed > 0).sort((a, b) => b.lastPlayed - a.lastPlayed),
    [tracks],
  );
  const shownTracks = useMemo(() => {
    let result =
      page === 'Favorites'
        ? tracks.filter((t) => t.favorite)
        : page === 'Recently played'
          ? recent
          : page === 'Album'
            ? album?.tracks || []
            : page === 'Artist'
              ? tracks.filter((t) => t.albumArtist === selectedArtist)
              : page === 'Collection' && collection
                ? playable(collection, tracks)
                : page === 'Queue'
                  ? pb?.queue.map((id) => trackMap.get(id)).filter((t): t is Track => !!t) || []
                  : tracks;
    if (deferredQuery)
      result = result.filter((t) =>
        normalize(`${t.title} ${t.artist} ${t.album}`).includes(normalize(deferredQuery)),
      );
    if (filter === 'available') result = result.filter((t) => !t.missing);
    if (filter === 'missing') result = result.filter((t) => t.missing);
    if (filter === 'lossless')
      result = result.filter((t) => ['FLAC', 'WAV', 'AIF', 'AIFF'].includes(t.format));
    if (filter === 'duplicates') result = result.filter((t) => duplicateIds.has(t.id));
    if (['Songs', 'Favorites'].includes(page) || deferredQuery) {
      result = [...result].sort((a, b) =>
        sort === 'artist'
          ? a.artist.localeCompare(b.artist) ||
            a.album.localeCompare(b.album) ||
            a.disc - b.disc ||
            a.track - b.track
          : sort === 'album'
            ? a.album.localeCompare(b.album) || a.disc - b.disc || a.track - b.track
            : sort === 'added'
              ? b.added - a.added
              : sort === 'duration'
                ? b.duration - a.duration
                : sort === 'plays'
                  ? b.playCount - a.playCount
                  : a.title.localeCompare(b.title),
      );
    }
    return result;
  }, [
    tracks,
    page,
    recent,
    album,
    selectedArtist,
    collection,
    pb?.queue,
    trackMap,
    deferredQuery,
    filter,
    sort,
    duplicateIds,
  ]);
  function navigate(p: Page) {
    setPage(p);
    setQuery('');
    setFilter('all');
  }
  function openAlbum(a: Album) {
    setSelectedAlbum(a.key);
    navigate('Album');
  }
  function openCollection(c: Collection) {
    setSelectedCollection(c.id);
    navigate('Collection');
  }
  async function playList(list: Track[], index = 0) {
    if (!list.length) {
      notify('There are no available songs in this selection.');
      return;
    }
    await command('queue', { ids: list.map((t) => t.id), index });
  }
  async function favorite(t: Track) {
    await task(async () => {
      await invoke('favorite', { id: t.id, value: !t.favorite });
      setData((d) =>
        d
          ? {
              ...d,
              tracks: d.tracks.map((x) => (x.id === t.id ? { ...x, favorite: !t.favorite } : x)),
            }
          : d,
      );
    });
  }
  function addTo(t: Track) {
    setAddTrack(t);
    setDialog('addToPlaylist');
  }
  async function saveCollection(c: Collection) {
    await invoke('save_collection', { collection: c });
    await refresh();
    setDialog(null);
    openCollection(c);
    notify(`${c.kind === 'virtual' ? 'Virtual album' : 'Playlist'} saved`);
  }
  function changeSettings(next: Settings) {
    setSettings(next);
    task(() => invoke('settings', { value: next }));
  }
  async function createPlaylist() {
    if (!playlistName.trim()) return;
    await task(() =>
      saveCollection({
        id: crypto.randomUUID(),
        name: playlistName.trim(),
        kind: 'playlist',
        created: Date.now(),
        entries: addTrack ? [entryFrom(addTrack)] : [],
      }),
    );
    setPlaylistName('');
    setAddTrack(null);
  }
  const albumCard = (a: Album) => (
    <button className="album-card" key={a.key} onClick={() => openAlbum(a)}>
      <div className="cover-wrap">
        <Art hash={a.artwork} name={a.name} />
        <span className="cover-play">
          <Play size={22} fill="currentColor" />
        </span>
      </div>
      <strong title={a.name}>{a.name}</strong>
      <span>{a.artist}</span>
      <small>
        {a.year || 'Unknown year'}
        {a.tracks.every((t) => t.format === 'FLAC') && <em>FLAC</em>}
      </small>
    </button>
  );
  const table = (list: Track[], compact = false, isQueue = false) => (
    <TrackTable
      tracks={list}
      currentId={pb?.currentId}
      playing={pb?.playing || false}
      onPlay={(i) => (isQueue ? void command('jump', i) : void playList(list, i))}
      onFavorite={favorite}
      onAdd={addTo}
      onQueue={(t) =>
        task(async () => {
          await invoke('playback', { action: 'append', value: t.id });
          notify('Added to queue');
        })
      }
      compact={compact}
      queue={isQueue}
      onMove={(from, to) => command('move', { from, to })}
      onRemove={(i) => command('remove', i)}
    />
  );
  const transport = (small = false) => (
    <div className={`transport ${small ? 'small' : ''}`}>
      <IconButton
        label="Shuffle"
        active={pb?.shuffle}
        onClick={() => command('shuffle', !pb?.shuffle)}
      >
        <Shuffle size={16} />
      </IconButton>
      <IconButton
        label="Previous track"
        onClick={() => command('previous')}
        disabled={!pb?.queue.length}
      >
        <SkipBack size={20} fill="currentColor" />
      </IconButton>
      <button
        className="play-button"
        aria-label={pb?.playing ? 'Pause' : 'Play'}
        onClick={() => command('toggle')}
        disabled={!pb?.currentId}
      >
        {pb?.playing ? (
          <Pause size={22} fill="currentColor" />
        ) : (
          <Play size={22} fill="currentColor" />
        )}
      </button>
      <IconButton label="Next track" onClick={() => command('next')} disabled={!pb?.queue.length}>
        <SkipForward size={20} fill="currentColor" />
      </IconButton>
      <IconButton
        label={`Repeat: ${pb?.repeat || 'off'}`}
        active={pb?.repeat !== 'off'}
        onClick={() =>
          command('repeat', pb?.repeat === 'off' ? 'all' : pb?.repeat === 'all' ? 'one' : 'off')
        }
      >
        {pb?.repeat === 'one' ? <Repeat1 size={16} /> : <Repeat size={16} />}
      </IconButton>
    </div>
  );
  const progress = (
    <div className="progress">
      <span>{time(seek ?? pb?.position ?? 0)}</span>
      <input
        type="range"
        aria-label="Playback position"
        min={0}
        max={pb?.duration || 1}
        step={0.1}
        value={seek ?? Math.min(pb?.position || 0, pb?.duration || 1)}
        disabled={!pb?.currentId}
        style={
          {
            '--fill': `${(100 * (seek ?? pb?.position ?? 0)) / (pb?.duration || 1)}%`,
          } as React.CSSProperties
        }
        onChange={(e) => setSeek(Number(e.target.value))}
        onPointerUp={(e) => {
          const v = Number(e.currentTarget.value);
          command('seek', v).then(() => setSeek(null));
        }}
        onKeyUp={(e) => {
          if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
            command('seek', Number(e.currentTarget.value)).then(() => setSeek(null));
          }
        }}
      />
      <span>{time(pb?.duration || 0)}</span>
    </div>
  );
  if (loading)
    return (
      <div className="boot">
        <img src="/icon.png" alt="" />
        <span>
          slate <b>music</b>
        </span>
        <p>Opening your collection…</p>
        <div className="loader" />
      </div>
    );
  if (fatal || !data || !pb)
    return (
      <div className="fatal">
        <h1>Slate Music could not open your library.</h1>
        <p>{fatal || 'The native application is not connected.'}</p>
        <button onClick={refresh}>Try again</button>
        <p>Launch the installed Windows app to access your local files.</p>
      </div>
    );
  if (mini)
    return (
      <div className="mini-player">
        <div className="mini-title" data-tauri-drag-region>
          <span data-tauri-drag-region>slate music</span>
          <IconButton label="Open full player" onClick={() => task(() => invoke('show_main'))}>
            <Maximize2 size={14} />
          </IconButton>
          <IconButton label="Close mini-player" onClick={() => getCurrentWindow().close()}>
            <X size={15} />
          </IconButton>
        </div>
        <div className="mini-track">
          <Art hash={current?.artwork} />
          <div>
            <strong>{current?.title || 'Ready when you are'}</strong>
            <p>{current?.artist || 'Choose a song in your library'}</p>
          </div>
          <IconButton
            label="Favorite current track"
            active={current?.favorite}
            disabled={!current}
            onClick={() => current && favorite(current)}
          >
            <Heart size={17} />
          </IconButton>
        </div>
        {transport(true)}
        {progress}
        {toast && <div className="mini-toast">{toast}</div>}
      </div>
    );
  return (
    <div className={`app ${settings.showListening ? '' : 'without-listening'}`}>
      <header className="titlebar" data-tauri-drag-region>
        <span className="titlebar-word" data-tauri-drag-region>
          SLATE MUSIC
        </span>
        <span className="titlebar-caption" data-tauri-drag-region>
          Your library, beautifully yours.
        </span>
        <div>
          <IconButton label="Minimize window" onClick={() => getCurrentWindow().minimize()}>
            <Minus size={15} />
          </IconButton>
          <IconButton label="Maximize window" onClick={() => getCurrentWindow().toggleMaximize()}>
            <Maximize2 size={13} />
          </IconButton>
          <IconButton
            label="Close window"
            className="close-window"
            onClick={() => getCurrentWindow().close()}
          >
            <X size={16} />
          </IconButton>
        </div>
      </header>
      <aside className="sidebar">
        <button className="brand" onClick={() => navigate('Home')}>
          <img src="/icon.png" alt="Slate Music icon" />
          <span>
            slate<span className="brand-light"> music</span>
          </span>
        </button>
        <nav>
          {nav.map(({ name, icon: Icon }) => (
            <button
              key={name}
              aria-label={name}
              className={`nav-item ${page === name ? 'active' : ''}`}
              onClick={() => navigate(name)}
            >
              <Icon size={18} strokeWidth={1.65} />
              <span>{name}</span>
              {name === 'Favorites' && favoriteCount > 0 && <em>{favoriteCount}</em>}
            </button>
          ))}
        </nav>
        <div className="sidebar-heading">
          <span>Your playlists</span>
          <IconButton
            label="Create playlist"
            onClick={() => {
              setAddTrack(null);
              setDialog('newPlaylist');
            }}
          >
            <Plus size={16} />
          </IconButton>
        </div>
        <div className="sidebar-playlists">
          {data.collections
            .filter((c) => c.kind === 'playlist')
            .map((c) => (
              <button
                className={`playlist-link ${page === 'Collection' && c.id === selectedCollection ? 'active' : ''}`}
                key={c.id}
                onClick={() => openCollection(c)}
              >
                <span className="playlist-dot" />
                <span>{c.name}</span>
              </button>
            ))}
          {!data.collections.some((c) => c.kind === 'playlist') && (
            <p>
              Build a little world
              <br />
              of your favorite songs.
            </p>
          )}
        </div>
        <div className="sidebar-bottom">
          <button className="import-nav" onClick={() => setDialog('import')}>
            <Link2 size={17} />
            <span>Import Spotify album</span>
            <Plus size={14} />
          </button>
          <button className="nav-item" onClick={() => setDialog('settings')}>
            <SettingsIcon size={18} />
            <span>Settings</span>
          </button>
          <div className="library-status">
            <span className={`status-dot ${data.scan.scanning ? 'pulsing' : ''}`} />
            <span>
              {data.scan.scanning
                ? `Indexing · ${data.scan.processed} songs`
                : `${tracks.filter((t) => !t.missing).length} songs on this computer`}
            </span>
            <IconButton
              label="Rescan library"
              disabled={data.scan.scanning}
              onClick={() => task(() => invoke('rescan'))}
            >
              <RefreshCw size={12} className={data.scan.scanning ? 'spin' : ''} />
            </IconButton>
          </div>
        </div>
      </aside>
      <main className="main">
        <div className="topbar">
          <div className="breadcrumbs">
            <button className="icon-button" aria-label="Go home" onClick={() => navigate('Home')}>
              <ArrowLeft size={18} />
            </button>
            <span>
              {['Album', 'Artist', 'Collection'].includes(page)
                ? page === 'Album'
                  ? 'Albums'
                  : page === 'Artist'
                    ? 'Artists'
                    : 'Your library'
                : page}
            </span>
          </div>
          <label className="search-box">
            <Search size={17} />
            <input
              ref={searchRef}
              placeholder="Search your music"
              aria-label="Search your music"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                if (page !== 'Songs') {
                  setPage('Songs');
                  setFilter('all');
                }
              }}
            />
            {query ? (
              <IconButton label="Clear search" onClick={() => setQuery('')}>
                <X size={14} />
              </IconButton>
            ) : (
              <kbd>Ctrl K</kbd>
            )}
          </label>
          <IconButton
            label={settings.showListening ? 'Hide listening panel' : 'Show listening panel'}
            onClick={() => changeSettings({ ...settings, showListening: !settings.showListening })}
          >
            {settings.showListening ? <PanelRightClose size={18} /> : <PanelRightOpen size={18} />}
          </IconButton>
        </div>
        <div className="page-content" key={page}>
          {tracks.length === 0 ? (
            <Empty
              title={data.scan.scanning ? 'Finding your music…' : 'A home for your music.'}
              description={
                data.scan.scanning
                  ? `${data.scan.processed} songs found. You can start listening as soon as indexing finishes.`
                  : 'Choose a folder. Slate Music will find your songs, albums and artwork.'
              }
              action={
                <button
                  className="primary"
                  onClick={() =>
                    task(async () => {
                      await invoke('add_folder');
                      await refresh();
                    })
                  }
                >
                  <FolderPlus size={16} />
                  Choose music folder
                </button>
              }
            />
          ) : page === 'Home' ? (
            <>
              <section className="home-hero">
                <div>
                  <p className="hero-intro">
                    <span className="status-dot" />
                    Your collection. Always here.
                  </p>
                  <h1>
                    Your music.
                    <br />
                    <span>In its own space.</span>
                  </h1>
                  <p className="hero-description">
                    Rediscover the records you love.
                    <br />
                    No distractions. Just press play.
                  </p>
                  <button
                    className="primary hero-button"
                    onClick={async () => {
                      await command('shuffle', true);
                      playList(tracks.filter((t) => !t.missing));
                    }}
                  >
                    <Shuffle size={16} />
                    Shuffle your library
                  </button>
                </div>
                <div className="record-display" aria-hidden="true">
                  {albums
                    .filter((a) => a.artwork)
                    .slice(0, 3)
                    .map((a, i) => (
                      <div className={`record record-${i}`} key={a.key}>
                        <Art hash={a.artwork} />
                      </div>
                    ))}
                  <div className="record-caption">
                    <span>{albums.length} albums</span>
                    <span>{artistNames.length} artists</span>
                    <span>All yours</span>
                  </div>
                </div>
              </section>
              <section className="home-section">
                <div className="section-heading">
                  <div>
                    <h2>On your shelves</h2>
                    <p>A good album deserves another listen.</p>
                  </div>
                  <button className="text-button" onClick={() => navigate('Albums')}>
                    All albums <ArrowRight size={15} />
                  </button>
                </div>
                <div className="album-grid home-albums">{albums.slice(0, 5).map(albumCard)}</div>
              </section>
              <section className="home-section">
                <div className="section-heading">
                  <h2>{recent.length ? 'Recently played' : 'Start somewhere good'}</h2>
                  <button
                    className="text-button"
                    onClick={() => navigate(recent.length ? 'Recently played' : 'Songs')}
                  >
                    View all <ArrowRight size={15} />
                  </button>
                </div>
                {table(
                  (recent.length ? recent : tracks.filter((t) => !t.missing)).slice(0, 8),
                  true,
                )}
              </section>
            </>
          ) : page === 'Albums' ? (
            <>
              <div className="page-heading">
                <div>
                  <h1>Albums</h1>
                  <p>{albums.length} records in your collection</p>
                </div>
                <button onClick={() => setDialog('import')}>
                  <Link2 size={16} />
                  Import album
                </button>
              </div>
              {data.collections.some((c) => c.kind === 'virtual') && (
                <>
                  <h2 className="subheading">Virtual albums</h2>
                  <div className="collection-grid">
                    {data.collections
                      .filter((c) => c.kind === 'virtual')
                      .map((c) => (
                        <button
                          className="collection-card"
                          key={c.id}
                          onClick={() => openCollection(c)}
                        >
                          <Art
                            hash={c.entries
                              .map((e) => trackMap.get(e.trackId || '')?.artwork)
                              .find(Boolean)}
                          />
                          <strong>{c.name}</strong>
                          <span>
                            {c.artist} · {playable(c, tracks).length}/{c.entries.length} available
                          </span>
                        </button>
                      ))}
                  </div>
                  <h2 className="subheading">Local albums</h2>
                </>
              )}
              <div className="album-grid">
                {[...albums]
                  .sort((a, b) => a.artist.localeCompare(b.artist) || a.year - b.year)
                  .map(albumCard)}
              </div>
            </>
          ) : page === 'Artists' ? (
            <>
              <div className="page-heading">
                <div>
                  <h1>Artists</h1>
                  <p>The people behind your collection.</p>
                </div>
                <span className="count-pill">{artistNames.length} artists</span>
              </div>
              <div className="artist-grid">
                {artistNames.map((name) => {
                  const artistAlbums = albums.filter((a) => a.artist === name);
                  return (
                    <button
                      className="artist-card"
                      key={name}
                      onClick={() => {
                        setSelectedArtist(name);
                        navigate('Artist');
                      }}
                    >
                      <Art hash={artistAlbums.find((a) => a.artwork)?.artwork} />
                      <div>
                        <h2>{name}</h2>
                        <p>
                          {artistAlbums.length} albums ·{' '}
                          {tracks.filter((t) => t.albumArtist === name).length} songs
                        </p>
                      </div>
                      <ChevronRight size={18} />
                    </button>
                  );
                })}
              </div>
            </>
          ) : page === 'Playlists' ? (
            <>
              <div className="page-heading">
                <div>
                  <h1>Playlists</h1>
                  <p>For every mood, moment and long way home.</p>
                </div>
                <button
                  className="primary"
                  onClick={() => {
                    setAddTrack(null);
                    setDialog('newPlaylist');
                  }}
                >
                  <Plus size={16} />
                  New playlist
                </button>
              </div>
              {data.collections.filter((c) => c.kind === 'playlist').length ? (
                <div className="collection-grid">
                  {data.collections
                    .filter((c) => c.kind === 'playlist')
                    .map((c) => (
                      <button
                        className="collection-card"
                        key={c.id}
                        onClick={() => openCollection(c)}
                      >
                        <Art
                          hash={c.entries
                            .map((e) => trackMap.get(e.trackId || '')?.artwork)
                            .find(Boolean)}
                        />
                        <strong>{c.name}</strong>
                        <span>{c.entries.length} songs</span>
                      </button>
                    ))}
                </div>
              ) : (
                <Empty
                  title="A soundtrack of your own."
                  description="Create a playlist, then add songs using the folder button beside a track."
                />
              )}
            </>
          ) : page === 'Album' && album ? (
            <>
              <section className="detail-hero">
                <Art hash={album.artwork} name={album.name} />
                <div>
                  <span className="detail-type">Local album</span>
                  <h1>{album.name}</h1>
                  <button
                    className="text-button"
                    onClick={() => {
                      setSelectedArtist(album.artist);
                      navigate('Artist');
                    }}
                  >
                    {album.artist}
                  </button>
                  <p>
                    {album.year || 'Unknown year'} · {album.tracks.length} songs ·{' '}
                    {durationLabel(album.tracks.reduce((s, t) => s + t.duration, 0))}
                  </p>
                  <div className="button-row">
                    <button className="primary" onClick={() => playList(album.tracks)}>
                      <Play size={16} fill="currentColor" />
                      Play album
                    </button>
                    <button
                      onClick={() =>
                        task(async () => {
                          for (const t of album.tracks.filter((t) => !t.missing))
                            await invoke('playback', { action: 'append', value: t.id });
                          notify('Album added to queue');
                        })
                      }
                    >
                      <Plus size={16} />
                      Add to queue
                    </button>
                  </div>
                </div>
              </section>
              {table(shownTracks)}
            </>
          ) : page === 'Artist' ? (
            <>
              <div className="page-heading">
                <div>
                  <p>Artist</p>
                  <h1>{selectedArtist}</h1>
                  <p>{shownTracks.length} songs in your library</p>
                </div>
                <button className="primary" onClick={() => playList(shownTracks)}>
                  <Play size={16} />
                  Play artist
                </button>
              </div>
              <div className="album-grid artist-albums">
                {albums.filter((a) => a.artist === selectedArtist).map(albumCard)}
              </div>
              <h2 className="subheading">Songs</h2>
              {table(shownTracks)}
            </>
          ) : page === 'Collection' && collection ? (
            <>
              <section className="detail-hero">
                <Art
                  hash={collection.entries
                    .map((e) => trackMap.get(e.trackId || '')?.artwork)
                    .find(Boolean)}
                />
                <div>
                  <span className="detail-type">
                    {collection.kind === 'virtual' ? 'Virtual album' : 'Playlist'}
                  </span>
                  <h1>{collection.name}</h1>
                  <p>
                    {collection.artist || 'Made by you'} · {shownTracks.length} available of{' '}
                    {collection.entries.length} tracks
                  </p>
                  <div className="button-row">
                    <button
                      className="primary"
                      disabled={!shownTracks.length}
                      onClick={() => playList(shownTracks)}
                    >
                      <Play size={16} />
                      Play
                    </button>
                    <button onClick={() => setDialog('editCollection')}>
                      <Pencil size={15} />
                      Edit {collection.kind === 'virtual' ? 'matches' : 'playlist'}
                    </button>
                    <IconButton
                      label="Delete collection"
                      onClick={() => setDialog('deleteCollection')}
                    >
                      <Trash2 size={16} />
                    </IconButton>
                  </div>
                </div>
              </section>
              {collection.entries.some(
                (e) =>
                  e.status !== 'available' ||
                  !trackMap.get(e.trackId || '') ||
                  trackMap.get(e.trackId || '')?.missing,
              ) && (
                <div className="notice">
                  <span>
                    Some tracks need a match or are missing. They are excluded from playback.
                  </span>
                  <button onClick={() => setDialog('editCollection')}>Review tracks</button>
                </div>
              )}
              {shownTracks.length ? (
                table(shownTracks)
              ) : (
                <Empty
                  title="Ready for your first song."
                  description="Add local songs with the playlist button beside any track, or review this album’s matches."
                />
              )}
            </>
          ) : (
            <>
              <div className="page-heading">
                <div>
                  <h1>{query ? 'Search results' : page}</h1>
                  <p>
                    {page === 'Queue'
                      ? `${pb.queue.length} songs in this listening session`
                      : query
                        ? `${shownTracks.length} matches for “${query}”`
                        : page === 'Favorites'
                          ? 'The songs you keep coming back to.'
                          : page === 'Recently played'
                            ? 'Pick up where you left off.'
                            : `${tracks.length} songs. A collection that is all yours.`}
                  </p>
                </div>
                {page === 'Queue' ? (
                  <button onClick={() => command('clear')}>Clear queue</button>
                ) : (
                  <button
                    className="primary"
                    disabled={!shownTracks.length}
                    onClick={() => playList(shownTracks)}
                  >
                    <Play size={16} />
                    Play {page === 'Favorites' ? 'favorites' : 'all'}
                  </button>
                )}
              </div>
              {page !== 'Queue' && (
                <div className="list-tools">
                  <div className="filter-tabs">
                    {[
                      ['all', 'All songs'],
                      ['available', 'Available'],
                      ['lossless', 'Lossless'],
                      ['duplicates', 'Duplicates'],
                      ['missing', 'Missing'],
                    ].map(([v, label]) => (
                      <button
                        className={filter === v ? 'active' : ''}
                        key={v}
                        onClick={() => setFilter(v)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <select
                    aria-label="Sort songs"
                    value={sort}
                    onChange={(e) => setSort(e.target.value)}
                  >
                    <option value="title">Title</option>
                    <option value="artist">Artist</option>
                    <option value="album">Album order</option>
                    <option value="added">Recently added</option>
                    <option value="duration">Duration</option>
                    <option value="plays">Most played</option>
                  </select>
                </div>
              )}
              {shownTracks.length ? (
                table(shownTracks, false, page === 'Queue')
              ) : (
                <Empty
                  title={
                    query
                      ? 'No songs found.'
                      : page === 'Favorites'
                        ? 'Keep your favorites close.'
                        : page === 'Queue'
                          ? 'A quiet moment.'
                          : page === 'Recently played'
                            ? 'Your listening story starts here.'
                            : 'Nothing here yet.'
                  }
                  description={
                    query
                      ? 'Try another title, artist or album.'
                      : page === 'Favorites'
                        ? 'Tap the heart beside a song to save it here.'
                        : page === 'Queue'
                          ? 'Play a song or add something to your queue.'
                          : 'Choose a song from your library to begin.'
                  }
                />
              )}
            </>
          )}
          <footer className="page-footer">
            <span>
              <HardDrive size={12} />
              Local files. No compromises.
            </span>
            <span>SLATE MUSIC</span>
          </footer>
        </div>
      </main>
      {settings.showListening && (
        <aside className="listening-panel">
          <div className="listening-heading">
            <span>Now listening</span>
            <IconButton label="Open queue" onClick={() => navigate('Queue')}>
              <ListMusic size={18} />
            </IconButton>
          </div>
          <div className="listening-cover">
            <Art hash={current?.artwork} name={current?.album} />
            {current && (
              <span className="format-badge">
                {current.format}
                {current.bitDepth > 0 ? ` · ${current.bitDepth} bit` : ''}
              </span>
            )}
          </div>
          <div className="listening-title">
            <div>
              <h2>{current?.title || 'Ready when you are.'}</h2>
              <p>{current?.artist || 'Your next favorite is already here.'}</p>
            </div>
            <IconButton
              label="Favorite current track"
              active={current?.favorite}
              disabled={!current}
              onClick={() => current && favorite(current)}
            >
              <Heart size={18} fill={current?.favorite ? 'currentColor' : 'none'} />
            </IconButton>
          </div>
          {current && (
            <button
              className="album-link"
              onClick={() => {
                const a = albums.find((a) => a.tracks.some((t) => t.id === current.id));
                if (a) openAlbum(a);
              }}
            >
              {current.album}
              <ChevronRight size={14} />
            </button>
          )}
          <div className="listening-divider" />
          <div className="section-heading">
            <h3>Up next</h3>
            <button className="text-button" onClick={() => navigate('Queue')}>
              View queue
            </button>
          </div>
          <div className="next-tracks">
            {pb.queue.slice(pb.cursor + 1, pb.cursor + 5).map((id, i) => {
              const t = trackMap.get(id);
              return t ? (
                <button
                  className="next-track"
                  key={`${id}-${i}`}
                  onClick={() => command('jump', pb.cursor + i + 1)}
                >
                  <Art hash={t.artwork} />
                  <span>
                    <strong>{t.title}</strong>
                    <small>{t.artist}</small>
                  </span>
                  <span className="next-time">{time(t.duration)}</span>
                </button>
              ) : null;
            })}
            {pb.queue.length <= pb.cursor + 1 && (
              <p className="queue-empty">
                Let the next song find you.
                <br />
                <button className="text-button" onClick={() => navigate('Albums')}>
                  Explore your albums <ArrowRight size={13} />
                </button>
              </p>
            )}
          </div>
          <div className="listening-bottom">
            <Headphones size={17} />
            <span>
              {pb.playing ? 'A little space for listening.' : 'Good music is worth keeping.'}
            </span>
          </div>
        </aside>
      )}
      <footer className="player-bar">
        <div className="player-current">
          <Art hash={current?.artwork} />
          <div>
            <strong>{current?.title || 'Choose something you love'}</strong>
            <span>{current?.artist || 'Your library is ready'}</span>
          </div>
          <IconButton
            label="Favorite playing song"
            active={current?.favorite}
            disabled={!current}
            onClick={() => current && favorite(current)}
          >
            <Heart size={17} fill={current?.favorite ? 'currentColor' : 'none'} />
          </IconButton>
        </div>
        <div className="player-center">
          {transport()}
          {progress}
        </div>
        <div className="player-tools">
          <IconButton
            label={pb.volume === 0 ? 'Unmute' : 'Mute'}
            onClick={() => command('volume', pb.volume === 0 ? 0.7 : 0)}
          >
            {pb.volume === 0 ? <VolumeX size={18} /> : <Volume2 size={18} />}
          </IconButton>
          <input
            type="range"
            aria-label="Volume"
            min={0}
            max={1}
            step={0.01}
            value={pb.volume}
            onChange={(e) => command('volume', Number(e.target.value))}
          />
          <IconButton label="Mini-player" onClick={() => task(() => invoke('mini_player'))}>
            <Minimize2 size={18} />
          </IconButton>
          <IconButton label="Queue" active={page === 'Queue'} onClick={() => navigate('Queue')}>
            <ListMusic size={19} />
          </IconButton>
        </div>
      </footer>
      {toast && (
        <div className="toast" role="status">
          <span>{toast}</span>
          <IconButton label="Dismiss message" onClick={() => setToast('')}>
            <X size={16} />
          </IconButton>
        </div>
      )}
      {pb.error && !toast && (
        <div className="playback-error" role="status">
          <span>{pb.error}</span>
          <button onClick={() => setDialog('settings')}>Settings</button>
        </div>
      )}
      {dialog && (
        <Modal
          title={
            dialog === 'settings'
              ? 'Make yourself at home.'
              : dialog === 'import'
                ? 'Import a Spotify album'
                : dialog === 'newPlaylist'
                  ? 'A new playlist'
                  : dialog === 'addToPlaylist'
                    ? 'Add to a playlist'
                    : dialog === 'editCollection'
                      ? 'Edit your collection'
                      : dialog === 'deleteCollection'
                        ? 'Delete this collection?'
                        : 'An update is ready.'
          }
          onClose={() => setDialog(null)}
          wide={['settings', 'import', 'editCollection'].includes(dialog)}
        >
          {dialog === 'settings' && (
            <SettingsPanel
              data={data}
              pb={pb}
              settings={settings}
              onSettings={changeSettings}
              onPlayback={command}
              onRefresh={refresh}
              updater={updater}
              onInstall={() => setDialog('install')}
            />
          )}
          {(dialog === 'import' || dialog === 'editCollection') && (
            <ImportPanel
              tracks={tracks}
              existing={dialog === 'editCollection' ? collection : undefined}
              onSave={saveCollection}
              onSettings={() => setDialog('settings')}
            />
          )}
          {dialog === 'newPlaylist' && (
            <div className="dialog-body">
              <label className="field">
                Playlist name
                <input
                  autoFocus
                  value={playlistName}
                  onChange={(e) => setPlaylistName(e.target.value)}
                  placeholder="Late nights, long drives…"
                  onKeyDown={(e) => e.key === 'Enter' && createPlaylist()}
                />
              </label>
              <button className="primary" disabled={!playlistName.trim()} onClick={createPlaylist}>
                Create playlist
              </button>
            </div>
          )}
          {dialog === 'addToPlaylist' && (
            <div className="dialog-body">
              <p className="muted">{addTrack?.title}</p>
              <div className="playlist-choices">
                {data.collections
                  .filter((c) => c.kind === 'playlist')
                  .map((c) => (
                    <button
                      key={c.id}
                      onClick={() =>
                        task(async () => {
                          if (addTrack) {
                            await invoke('save_collection', {
                              collection: { ...c, entries: [...c.entries, entryFrom(addTrack)] },
                            });
                            await refresh();
                            setDialog(null);
                            notify(`Added to ${c.name}`);
                          }
                        })
                      }
                    >
                      <ListMusic size={18} />
                      <span>{c.name}</span>
                      <Plus size={16} />
                    </button>
                  ))}
              </div>
              <button className="primary" onClick={() => setDialog('newPlaylist')}>
                <Plus size={16} />
                New playlist
              </button>
            </div>
          )}
          {dialog === 'deleteCollection' && (
            <div className="dialog-body">
              <p>Remove “{collection?.name}” from Slate Music? Your music files stay untouched.</p>
              <button
                className="danger"
                onClick={() =>
                  task(async () => {
                    await invoke('delete_collection', { id: selectedCollection });
                    await refresh();
                    setDialog(null);
                    navigate('Playlists');
                  })
                }
              >
                Delete collection
              </button>
            </div>
          )}
          {dialog === 'install' && (
            <div className="dialog-body">
              <p>{updater.status}</p>
              <p>
                {pb.playing
                  ? 'Pause playback before installing.'
                  : 'Your library and settings will be kept.'}
              </p>
              <div className="button-row">
                <button
                  className="primary"
                  disabled={pb.playing}
                  onClick={() =>
                    task(async () => {
                      await command('pause');
                      await updater.install();
                    })
                  }
                >
                  <Download size={16} />
                  Install and restart
                </button>
                <button
                  onClick={() => {
                    exitAllowed.current = true;
                    getCurrentWindow().close();
                  }}
                >
                  Exit without installing
                </button>
                <button onClick={() => setDialog(null)}>Keep listening</button>
              </div>
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}
