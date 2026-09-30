import {
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
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
  ListPlus,
  ListEnd,
  ListX,
  Moon,
  FolderSearch,
  Save,
  Expand,
} from 'lucide-react';
import type { Album, Collection, Playback, Scan, Settings, Snapshot, Track } from './types';
import {
  albumsFrom,
  duplicates,
  durationLabel,
  entryFrom,
  normalize,
  playable,
  playableIndices,
  queueEntries,
  time,
} from './library';
import {
  Art,
  ContextMenu,
  Empty,
  IconButton,
  Modal,
  TrackTable,
  type MenuItem,
} from './components';
import SettingsPanel from './SettingsPanel';
import ImportPanel from './ImportPanel';
import { useUpdater } from './updater';
import { followsSpotify, updateAll } from './spotifySources';
import NowPlaying from './NowPlaying';
import { useArtColor } from './artColor';

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
const defaults: Settings = {
  autoCheck: true,
  autoDownload: true,
  showListening: true,
  lookupYears: false,
  lookupLyrics: false,
};
const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
const noQueueEntries: ReturnType<typeof queueEntries> = [];
/** Playback updates arrive several times a second. Reusing the old queue array when nothing
 * changed keeps song lists from being filtered and sorted again on every update. */
const sameQueue = (previous: Playback | null, next: Playback): Playback =>
  previous &&
  previous.queue.length === next.queue.length &&
  previous.queue.every((id, i) => id === next.queue[i])
    ? { ...next, queue: previous.queue }
    : next;
type View = { page: Page; album: string; artist: string; collection: string; scroll: number };
type Menu = { x: number; y: number; items: MenuItem[]; above?: boolean };
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
    [recentSort, setRecentSort] = useState('recent'),
    [filter, setFilter] = useState('all'),
    [selectedAlbum, setSelectedAlbum] = useState(''),
    [selectedArtist, setSelectedArtist] = useState(''),
    [selectedCollection, setSelectedCollection] = useState(''),
    [dialog, setDialog] = useState<Dialog>(null),
    [adding, setAdding] = useState<Track[]>([]),
    [playlistName, setPlaylistName] = useState(''),
    [toast, setToast] = useState(''),
    [settings, setSettings] = useState<Settings>(defaults),
    [seek, setSeek] = useState<number | null>(null),
    [menu, setMenu] = useState<Menu | null>(null),
    [nowPlaying, setNowPlaying] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null),
    mainRef = useRef<HTMLElement>(null),
    history = useRef<View[]>([]),
    restoreScroll = useRef<number | null>(null),
    unmuteVolume = useRef(0.7),
    initialPicker = useRef(false),
    initialized = useRef(false),
    spotifyChecked = useRef(false),
    editingRef = useRef<string | null>(null),
    exitAllowed = useRef(false),
    goBackRef = useRef<() => void>(() => {});
  const closeMenu = useCallback(() => setMenu(null), []);
  const mini = new URLSearchParams(location.search).has('mini');
  const updater = useUpdater();
  const deferredQuery = useDeferredValue(query);
  const notify = useCallback((message: string) => setToast(message), []);
  const refresh = useCallback(async () => {
    try {
      const next = await invoke<Snapshot>('snapshot');
      setData(next);
      setPb((previous) => sameQueue(previous, next.playback));
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
        setPb((previous) => sameQueue(previous, next));
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
      listen<Playback>('playback', (e) => setPb((previous) => sameQueue(previous, e.payload))),
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
    // Once per launch, after the first scan, bring imported Spotify playlists up to date.
    if (!data || mini || spotifyChecked.current || data.scan.scanning || !data.spotify.connected)
      return;
    spotifyChecked.current = true;
    // A playlist open in the editor is left alone, so the update never undoes an edit.
    updateAll((id) => editingRef.current === id).then(async (updated) => {
      if (!updated) return;
      await refresh();
      notify(`Updated ${updated} Spotify playlist${updated === 1 ? '' : 's'}`);
    });
  }, [data, mini, refresh, notify]);
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
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      const type = tag === 'INPUT' ? (el as HTMLInputElement).type : '';
      const typing =
        tag === 'TEXTAREA' || el?.isContentEditable || (tag === 'INPUT' && type !== 'range');
      if (typing || dialog || el?.closest('[role="menu"]')) return;
      // Sliders and the sort menu keep their own arrow keys (and Space for the menu); every
      // other shortcut still works after using them.
      const ownsKeys = type === 'range' || tag === 'SELECT';
      if (ownsKeys && !e.ctrlKey && !e.altKey && e.key.startsWith('Arrow')) return;
      if (tag === 'SELECT' && e.code === 'Space') return;
      if (e.key === 'Escape' && nowPlaying) {
        e.preventDefault();
        setNowPlaying(false);
      } else if (e.ctrlKey && e.key.toLowerCase() === 'l') {
        e.preventDefault();
        setNowPlaying((open) => !open);
      } else if (e.altKey && e.key === 'ArrowLeft') {
        e.preventDefault();
        goBackRef.current();
      } else if (e.ctrlKey && e.key.toLowerCase() === 'k') {
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
  }, [pb, dialog, command, task, nowPlaying]);
  useEffect(() => {
    // The mouse's back button goes back, and the browser's own right-click menu (Back,
    // Refresh, Print…) never appears outside text fields.
    const mouseBack = (e: MouseEvent) => {
      if (e.button === 3) {
        e.preventDefault();
        goBackRef.current();
      }
    };
    const browserMenu = (e: MouseEvent) => {
      if (!(e.target as HTMLElement)?.closest('input, textarea, [contenteditable="true"]'))
        e.preventDefault();
    };
    window.addEventListener('mouseup', mouseBack);
    window.addEventListener('contextmenu', browserMenu);
    return () => {
      window.removeEventListener('mouseup', mouseBack);
      window.removeEventListener('contextmenu', browserMenu);
    };
  }, []);
  useLayoutEffect(() => {
    if (restoreScroll.current !== null && mainRef.current) {
      mainRef.current.scrollTop = restoreScroll.current;
      restoreScroll.current = null;
    }
  });
  const tracks = data?.tracks || [];
  const trackMap = useMemo(() => new Map(tracks.map((t) => [t.id, t])), [tracks]);
  const albums = useMemo(() => albumsFrom(tracks), [tracks]);
  const duplicateIds = useMemo(() => duplicates(tracks), [tracks]);
  const current = pb?.currentId ? trackMap.get(pb.currentId) : null;
  const accent = useArtColor(current?.artwork);
  const album = albums.find((a) => a.key === selectedAlbum),
    collection = data?.collections.find((c) => c.id === selectedCollection);
  const artistNames = useMemo(
    () => [...new Set(tracks.map((t) => t.albumArtist))].sort(collator.compare),
    [tracks],
  );
  const artistStats = useMemo(() => {
    const stats = new Map<string, { albums: number; songs: number; artwork: string | null }>();
    for (const a of albums) {
      const s = stats.get(a.artist) || { albums: 0, songs: 0, artwork: null };
      s.albums += 1;
      s.songs += a.tracks.length;
      s.artwork ??= a.artwork;
      stats.set(a.artist, s);
    }
    return stats;
  }, [albums]);
  const favoriteCount = tracks.filter((t) => t.favorite).length;
  const recent = useMemo(
    () => tracks.filter((t) => t.lastPlayed > 0).sort((a, b) => b.lastPlayed - a.lastPlayed),
    [tracks],
  );
  const visibleQueue = useMemo(
    () =>
      page === 'Queue' ? queueEntries(pb?.queue || [], trackMap, deferredQuery) : noQueueEntries,
    [page, pb?.queue, trackMap, deferredQuery],
  );
  const sortMode = page === 'Recently played' ? recentSort : sort;
  const shownTracks = useMemo(() => {
    if (page === 'Queue') return visibleQueue.map((entry) => entry.track);
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
                : tracks;
    if (deferredQuery) {
      const needle = normalize(deferredQuery);
      result = result.filter((t) => normalize(`${t.title} ${t.artist} ${t.album}`).includes(needle));
    }
    if (filter === 'available') result = result.filter((t) => !t.missing);
    if (filter === 'missing') result = result.filter((t) => t.missing);
    if (filter === 'lossless')
      result = result.filter((t) => ['FLAC', 'WAV', 'AIF', 'AIFF'].includes(t.format));
    if (filter === 'duplicates') result = result.filter((t) => duplicateIds.has(t.id));
    if (['Songs', 'Favorites', 'Recently played'].includes(page) || deferredQuery) {
      result = [...result].sort((a, b) =>
        sortMode === 'recent'
          ? b.lastPlayed - a.lastPlayed
          : sortMode === 'artist'
            ? collator.compare(a.artist, b.artist) ||
              collator.compare(a.album, b.album) ||
              a.disc - b.disc ||
              a.track - b.track
            : sortMode === 'album'
              ? collator.compare(a.album, b.album) || a.disc - b.disc || a.track - b.track
              : sortMode === 'year'
                ? (a.originalYear || a.year || 9999) - (b.originalYear || b.year || 9999) ||
                  collator.compare(a.artist, b.artist) ||
                  a.disc - b.disc ||
                  a.track - b.track
                : sortMode === 'added'
                ? b.added - a.added
                : sortMode === 'duration'
                  ? b.duration - a.duration
                  : sortMode === 'plays'
                    ? b.playCount - a.playCount
                    : collator.compare(a.title, b.title),
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
    deferredQuery,
    filter,
    sortMode,
    duplicateIds,
    visibleQueue,
  ]);
  /** Records where the user is, so Back returns here with the same scroll position. */
  function remember() {
    history.current = [
      ...history.current.slice(-49),
      {
        page,
        album: selectedAlbum,
        artist: selectedArtist,
        collection: selectedCollection,
        scroll: mainRef.current?.scrollTop || 0,
      },
    ];
  }
  function navigate(p: Page) {
    if (p !== page || ['Album', 'Artist', 'Collection'].includes(p)) remember();
    setPage(p);
    setQuery('');
    setFilter('all');
    restoreScroll.current = 0;
  }
  function goBack() {
    // Skip pages that no longer exist (a deleted playlist, an album whose songs are gone).
    let view = history.current.pop();
    while (
      view &&
      ((view.page === 'Collection' && !data?.collections.some((c) => c.id === view!.collection)) ||
        (view.page === 'Album' && !albums.some((a) => a.key === view!.album)))
    )
      view = history.current.pop();
    if (!view) {
      if (page !== 'Home') {
        setPage('Home');
        setQuery('');
        setFilter('all');
        restoreScroll.current = 0;
      }
      return;
    }
    setSelectedAlbum(view.album);
    setSelectedArtist(view.artist);
    setSelectedCollection(view.collection);
    setPage(view.page);
    setQuery('');
    setFilter('all');
    restoreScroll.current = view.scroll;
  }
  goBackRef.current = goBack;
  editingRef.current = dialog === 'editCollection' ? selectedCollection : null;
  function openArtist(name: string) {
    setSelectedArtist(name);
    navigate('Artist');
  }
  function albumOf(t: Track) {
    return albums.find((a) => a.tracks.some((x) => x.id === t.id));
  }
  async function enqueue(list: Track[], next: boolean) {
    const available = list.filter((t) => !t.missing);
    if (!available.length) return notify('There are no available songs in this selection.');
    const done = await command(
      next ? 'insert_next' : 'append',
      available.map((t) => t.id),
    );
    const what = available.length === 1 ? available[0].title : `${available.length} songs`;
    if (done) notify(`${what} ${next ? 'will play next' : 'added to queue'}`);
  }
  function trackMenu(
    t: Track,
    x: number,
    y: number,
    remove?: { label: string; disabled?: boolean; run: () => void },
  ) {
    const a = albumOf(t);
    setMenu({
      x,
      y,
      items: [
        {
          label: 'Play next',
          icon: <ListPlus size={15} />,
          disabled: t.missing,
          onSelect: () => enqueue([t], true),
        },
        {
          label: 'Add to queue',
          icon: <ListEnd size={15} />,
          disabled: t.missing,
          onSelect: () => enqueue([t], false),
        },
        {
          label: 'Add to playlist…',
          icon: <ListMusic size={15} />,
          onSelect: () => addTo([t]),
        },
        'divider',
        {
          label: 'Go to album',
          icon: <Disc3 size={15} />,
          disabled: !a || (page === 'Album' && a.key === selectedAlbum),
          onSelect: () => a && openAlbum(a),
        },
        {
          label: 'Go to artist',
          icon: <Users size={15} />,
          disabled: page === 'Artist' && selectedArtist === t.albumArtist,
          onSelect: () => openArtist(t.albumArtist),
        },
        'divider',
        {
          label: t.favorite ? 'Remove from favorites' : 'Add to favorites',
          icon: <Heart size={15} />,
          onSelect: () => favorite(t),
        },
        {
          label: 'Show in File Explorer',
          icon: <FolderSearch size={15} />,
          onSelect: () => task(() => invoke('reveal_track', { id: t.id })),
        },
        ...(remove
          ? [
              'divider' as const,
              {
                label: remove.label,
                icon: <ListX size={15} />,
                disabled: remove.disabled,
                onSelect: remove.run,
              },
            ]
          : []),
      ],
    });
  }
  function albumMenu(a: Album, x: number, y: number) {
    setMenu({
      x,
      y,
      items: [
        { label: 'Play album', icon: <Play size={15} />, onSelect: () => playList(a.tracks) },
        { label: 'Play next', icon: <ListPlus size={15} />, onSelect: () => enqueue(a.tracks, true) },
        {
          label: 'Add to queue',
          icon: <ListEnd size={15} />,
          onSelect: () => enqueue(a.tracks, false),
        },
        {
          label: 'Add to playlist…',
          icon: <ListMusic size={15} />,
          onSelect: () => addTo(a.tracks.filter((t) => !t.missing)),
        },
        'divider',
        { label: 'Go to artist', icon: <Users size={15} />, onSelect: () => openArtist(a.artist) },
      ],
    });
  }
  const sleepLabel = (() => {
    if (pb?.sleepEndOfTrack) return 'Sleep timer: pauses after this song';
    if (!pb?.sleepAt) return 'Sleep timer';
    const minutes = Math.max(1, Math.ceil((pb.sleepAt - Date.now()) / 60000));
    return `Sleep timer: pauses in ${minutes} min`;
  })();
  function sleepMenu(x: number, y: number) {
    const set = (value: unknown, message: string) =>
      command('sleep', value).then((done) => done && notify(message));
    const active = !!pb?.sleepAt || !!pb?.sleepEndOfTrack;
    setMenu({
      x,
      y,
      above: true,
      items: [
        ...[15, 30, 45, 60, 90].map((minutes) => ({
          label: minutes < 60 ? `${minutes} minutes` : minutes === 60 ? '1 hour' : '1½ hours',
          onSelect: () =>
            set({ minutes }, `Music will pause in ${minutes < 60 ? `${minutes} minutes` : minutes === 60 ? '1 hour' : '1½ hours'}.`),
        })),
        {
          label: 'End of this song',
          disabled: !pb?.currentId,
          onSelect: () => set({ endOfTrack: true }, 'Music will pause when this song ends.'),
        },
        ...(active
          ? [
              'divider' as const,
              { label: 'Turn off sleep timer', onSelect: () => set(null, 'Sleep timer off.') },
            ]
          : []),
      ],
    });
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
  function addTo(list: Track[]) {
    setAdding(list);
    setDialog('addToPlaylist');
  }
  async function addToPlaylist(c: Collection) {
    const unique = adding.filter((t, i) => adding.indexOf(t) === i);
    const has = (t: Track) => c.entries.some((e) => e.trackId === t.id);
    // An old entry saved as missing (added while its file was unavailable) is repaired
    // instead of counting as "already there".
    const repaired = unique.filter((t) =>
      c.entries.some((e) => e.trackId === t.id && e.status !== 'available'),
    );
    const fresh = unique.filter((t) => !has(t));
    if (!fresh.length && !repaired.length) {
      setDialog(null);
      return notify(
        adding.length === 1 ? `Already in ${c.name}` : `These songs are already in ${c.name}`,
      );
    }
    const repairedIds = new Set(repaired.map((t) => t.id));
    const entries = c.entries.map((e) =>
      e.trackId && repairedIds.has(e.trackId) ? { ...e, status: 'available' as const } : e,
    );
    await invoke('save_collection', {
      collection: { ...c, entries: [...entries, ...fresh.map(entryFrom)] },
    });
    await refresh();
    setDialog(null);
    const added = [...repaired, ...fresh];
    const skipped = adding.length - added.length;
    notify(
      `Added ${added.length === 1 ? added[0].title : `${added.length} songs`} to ${c.name}${skipped ? ` (${skipped} already there)` : ''}`,
    );
  }
  /** `row` is the song's position among the playlist's playable songs. */
  function removeFromCollection(c: Collection, row: number) {
    const entry = playableIndices(c, tracks)[row];
    if (entry === undefined) return;
    task(async () => {
      await invoke('save_collection', {
        collection: { ...c, entries: c.entries.filter((_, i) => i !== entry) },
      });
      await refresh();
    }, `Removed from ${c.name}`);
  }
  /** Saves first and hearts afterwards, so nothing is hearted if saving fails. */
  async function saveCollection(c: Collection, hearts: string[] = []) {
    await invoke('save_collection', { collection: c });
    if (hearts.length) await invoke('favorite_many', { ids: hearts });
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
        entries: adding.map(entryFrom),
      }),
    );
    setPlaylistName('');
    setAdding([]);
  }
  const albumCard = (a: Album) => (
    <button
      className="album-card"
      key={a.key}
      onClick={() => openAlbum(a)}
      onContextMenu={(e) => {
        e.preventDefault();
        albumMenu(a, e.clientX, e.clientY);
      }}
    >
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
      onAdd={(t) => addTo([t])}
      onQueue={(t) => enqueue([t], false)}
      onContext={(t, index, x, y) =>
        trackMenu(
          t,
          x,
          y,
          isQueue
            ? {
                label: 'Remove from queue',
                disabled: index === pb?.cursor,
                run: () => command('remove', index),
              }
            : page === 'Collection' &&
                collection?.kind === 'playlist' &&
                !followsSpotify(collection) &&
                !compact
              ? {
                  label: 'Remove from this playlist',
                  run: () => removeFromCollection(collection, index),
                }
              : undefined,
        )
      }
      compact={compact}
      queue={isQueue}
      rowIndices={isQueue ? visibleQueue.map((entry) => entry.index) : undefined}
      currentIndex={isQueue ? pb?.cursor : undefined}
      queueLength={isQueue ? pb?.queue.length : undefined}
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
        disabled={!pb?.queue.length}
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
    <div
      className={`app ${settings.showListening ? '' : 'without-listening'}`}
      style={accent ? ({ '--art': accent } as React.CSSProperties) : undefined}
    >
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
              setAdding([]);
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
            <span>Import Spotify playlist</span>
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
      <main className="main" ref={mainRef}>
        <div className="topbar">
          <div className="breadcrumbs">
            <button
              className="icon-button"
              aria-label="Go back"
              title="Go back (Alt+←)"
              disabled={page === 'Home' && history.current.length === 0}
              onClick={goBack}
            >
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
              placeholder={page === 'Queue' ? 'Search queue' : 'Search your music'}
              aria-label={page === 'Queue' ? 'Search queue' : 'Search your music'}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                if (page !== 'Songs' && page !== 'Queue') {
                  remember();
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
                  const stats = artistStats.get(name);
                  return (
                    <button className="artist-card" key={name} onClick={() => openArtist(name)}>
                      <Art hash={stats?.artwork} />
                      <div>
                        <h2>{name}</h2>
                        <p>
                          {stats?.albums || 0} albums · {stats?.songs || 0} songs
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
                <div className="button-row">
                  <button onClick={() => setDialog('import')}>
                    <Link2 size={16} />
                    Import from Spotify
                  </button>
                  <button
                    className="primary"
                    onClick={() => {
                      setAdding([]);
                      setDialog('newPlaylist');
                    }}
                  >
                    <Plus size={16} />
                    New playlist
                  </button>
                </div>
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
                  description="Create a playlist and add songs with the folder button or by right-clicking a song. Or bring one over from Spotify."
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
                  <button className="text-button" onClick={() => openArtist(album.artist)}>
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
                    <button onClick={() => enqueue(album.tracks, true)}>
                      <ListPlus size={16} />
                      Play next
                    </button>
                    <button onClick={() => enqueue(album.tracks, false)}>
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
                  description={
                    collection.entries.length
                      ? 'None of these songs are matched to your files yet. Choose Review tracks to match them.'
                      : 'Add songs with the folder button beside any track, or right-click a song.'
                  }
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
                  <div className="button-row">
                    <button
                      disabled={!pb.queue.length}
                      onClick={() => addTo(pb.queue.flatMap((id) => trackMap.get(id) || []))}
                    >
                      <Save size={15} />
                      Save as playlist
                    </button>
                    <button
                      disabled={pb.queue.length <= 1}
                      title="Removes everything except the song that is playing"
                      onClick={() => command('clear_upcoming')}
                    >
                      <ListX size={15} />
                      Clear up next
                    </button>
                  </div>
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
                    value={sortMode}
                    onChange={(e) => {
                      if (page === 'Recently played') setRecentSort(e.target.value);
                      else setSort(e.target.value);
                      // Hand the keyboard back so Space plays and pauses again.
                      e.currentTarget.blur();
                    }}
                  >
                    {page === 'Recently played' && <option value="recent">Last played</option>}
                    <option value="title">Title</option>
                    <option value="artist">Artist</option>
                    <option value="album">Album order</option>
                    <option value="year">Year released</option>
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
          <div
            className="listening-cover"
            role={current ? 'button' : undefined}
            tabIndex={current ? 0 : undefined}
            title={current ? 'Open Now Playing (Ctrl+L)' : undefined}
            onClick={() => current && setNowPlaying(true)}
            onKeyDown={(e) => current && e.key === 'Enter' && setNowPlaying(true)}
          >
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
          {current && current.originalYear > 0 && current.originalYear !== current.year && (
            <p className="first-released">
              First released {current.originalYear}
              {current.year ? ` · this album ${current.year}` : ''}
            </p>
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
          <button
            className="player-open"
            aria-label="Open Now Playing"
            title="Now Playing (Ctrl+L)"
            disabled={!current}
            onClick={() => setNowPlaying(true)}
          >
            <Art hash={current?.artwork} />
            <div>
              <strong>{current?.title || 'Choose something you love'}</strong>
              <span>{current?.artist || 'Your library is ready'}</span>
            </div>
          </button>
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
          <button
            type="button"
            data-menu-anchor
            className={`icon-button sleep-button ${pb.sleepAt || pb.sleepEndOfTrack ? 'active' : ''}`}
            aria-label={sleepLabel}
            title={sleepLabel}
            onClick={(e) => {
              const box = e.currentTarget.getBoundingClientRect();
              if (menu?.above) closeMenu();
              else sleepMenu(box.left, box.top - 6);
            }}
          >
            <Moon size={17} />
            {pb.sleepAt && (
              <small>{Math.max(1, Math.ceil((pb.sleepAt - Date.now()) / 60000))}</small>
            )}
          </button>
          <IconButton
            label={pb.volume === 0 ? 'Unmute' : 'Mute'}
            onClick={() => {
              if (pb.volume > 0) unmuteVolume.current = pb.volume;
              command('volume', pb.volume === 0 ? unmuteVolume.current : 0);
            }}
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
          <IconButton
            label="Now Playing (Ctrl+L)"
            active={nowPlaying}
            disabled={!current}
            onClick={() => setNowPlaying((open) => !open)}
          >
            <Expand size={17} />
          </IconButton>
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
          {/audio|output|device/i.test(pb.error) && (
            <button onClick={() => setDialog('settings')}>Settings</button>
          )}
          <IconButton label="Dismiss message" onClick={() => command('dismiss_error')}>
            <X size={16} />
          </IconButton>
        </div>
      )}
      {nowPlaying && (
        <NowPlaying
          track={current ?? null}
          pb={pb}
          trackMap={trackMap}
          accent={accent}
          transport={transport()}
          progress={progress}
          lookupLyrics={settings.lookupLyrics}
          onClose={() => setNowPlaying(false)}
          onFavorite={favorite}
          onSeek={(seconds) => command('seek', seconds)}
          onJump={(index) => command('jump', index)}
          onAlbum={(t) => {
            const a = albumOf(t);
            if (a) {
              setNowPlaying(false);
              openAlbum(a);
            }
          }}
        />
      )}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          above={menu.above}
          items={menu.items}
          onClose={closeMenu}
        />
      )}
      {dialog && (
        <Modal
          title={
            dialog === 'settings'
              ? 'Make yourself at home.'
              : dialog === 'import'
                ? 'Import a Spotify playlist'
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
              collections={data.collections}
              spotify={data.spotify}
              onSave={saveCollection}
              onSettings={() => setDialog('settings')}
              onConnected={refresh}
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
              <p className="muted">
                {adding.length === 1 ? adding[0].title : `${adding.length} songs`}
              </p>
              <div className="playlist-choices">
                {data.collections
                  .filter((c) => c.kind === 'playlist' && !followsSpotify(c))
                  .map((c) => (
                    <button key={c.id} onClick={() => task(() => addToPlaylist(c))}>
                      <ListMusic size={18} />
                      <span>{c.name}</span>
                      <Plus size={16} />
                    </button>
                  ))}
              </div>
              {data.collections.some(followsSpotify) && (
                <p className="fine-print">
                  Playlists that follow Spotify aren’t listed: their songs come from Spotify.
                </p>
              )}
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
                  disabled={pb.playing || updater.busy}
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
