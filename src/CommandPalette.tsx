import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Disc3, ListMusic, Music2, Search, Sparkles, Users, CornerDownLeft } from 'lucide-react';
import type { Album, Collection, Track } from './types';
import { Art, scrollInside } from './components';
import { index, search } from './search';

export interface PaletteCommand {
  label: string;
  hint?: string;
  icon: ReactNode;
  keywords?: string;
  run: () => void;
}
type Result =
  | { kind: 'command'; key: string; command: PaletteCommand }
  | { kind: 'artist'; key: string; name: string; art: string | null; songs: number }
  | { kind: 'album'; key: string; album: Album }
  | { kind: 'song'; key: string; track: Track }
  | { kind: 'playlist'; key: string; collection: Collection };

/** Ctrl+K: search the whole library and every action from one box, keyboard first. */
export default function CommandPalette({
  tracks,
  albums,
  collections,
  commands,
  onClose,
  onArtist,
  onAlbum,
  onSong,
  onPlaylist,
}: {
  tracks: Track[];
  albums: Album[];
  collections: Collection[];
  commands: PaletteCommand[];
  onClose: () => void;
  onArtist: (name: string) => void;
  onAlbum: (a: Album) => void;
  onSong: (t: Track) => void;
  onPlaylist: (c: Collection) => void;
}) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const indexes = useMemo(() => {
    const artists = new Map<string, { name: string; art: string | null; songs: number }>();
    for (const a of albums) {
      const e = artists.get(a.artist) || { name: a.artist, art: null, songs: 0 };
      e.art ??= a.artwork;
      e.songs += a.tracks.length;
      artists.set(a.artist, e);
    }
    return {
      commands: index(commands, (c) => `${c.label} ${c.keywords ?? ''}`),
      artists: index([...artists.values()], (a) => a.name),
      albums: index(albums, (a) => `${a.name} ${a.artist} ${a.year || ''}`),
      songs: index(tracks.filter((t) => !t.missing), (t) => `${t.title} ${t.artist} ${t.album}`),
      playlists: index(collections, (c) => c.name),
    };
  }, [tracks, albums, collections, commands]);
  const groups = useMemo(() => {
    if (!query.trim())
      return [{ title: 'Actions', items: commands.slice(0, 8).map((command) => ({ kind: 'command' as const, key: command.label, command })) }];
    const out: { title: string; items: Result[] }[] = [
      { title: 'Artists', items: search(query, indexes.artists, 4).map((a) => ({ kind: 'artist' as const, key: `ar-${a.name}`, ...a })) },
      { title: 'Albums', items: search(query, indexes.albums, 5).map((album) => ({ kind: 'album' as const, key: `al-${album.key}`, album })) },
      { title: 'Songs', items: search(query, indexes.songs, 8).map((track) => ({ kind: 'song' as const, key: `so-${track.id}`, track })) },
      { title: 'Playlists', items: search(query, indexes.playlists, 4).map((collection) => ({ kind: 'playlist' as const, key: `pl-${collection.id}`, collection })) },
      { title: 'Actions', items: search(query, indexes.commands, 5).map((command) => ({ kind: 'command' as const, key: command.label, command })) },
    ];
    return out.filter((g) => g.items.length);
  }, [query, indexes, commands]);
  const flat = groups.flatMap((g) => g.items);
  useEffect(() => setSelected(0), [query]);
  useEffect(() => {
    const box = list.current;
    const item = box?.querySelector<HTMLElement>(`[data-index="${selected}"]`);
    if (box && item) scrollInside(box, item, 'nearest');
  }, [selected]);
  function run(r: Result | undefined) {
    if (!r) return;
    onClose();
    if (r.kind === 'command') r.command.run();
    else if (r.kind === 'artist') onArtist(r.name);
    else if (r.kind === 'album') onAlbum(r.album);
    else if (r.kind === 'song') onSong(r.track);
    else onPlaylist(r.collection);
  }
  let n = -1;
  return (
    <div className="palette-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette" role="dialog" aria-label="Search and commands">
        <label className="palette-input">
          <Search size={18} />
          <input
            autoFocus
            value={query}
            placeholder="Search songs, albums, artists, playlists and actions…"
            aria-label="Search everything"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setSelected((i) => Math.min(flat.length - 1, i + 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setSelected((i) => Math.max(0, i - 1));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                run(flat[selected]);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                onClose();
              }
            }}
          />
          <kbd>Esc</kbd>
        </label>
        <div className="palette-results" ref={list} role="listbox">
          {groups.map((g) => (
            <section key={g.title}>
              <h4>{g.title}</h4>
              {g.items.map((r) => {
                n += 1;
                const i = n;
                return (
                  <button
                    key={r.key}
                    data-index={i}
                    role="option"
                    aria-selected={i === selected}
                    className={`palette-item ${i === selected ? 'selected' : ''}`}
                    onMouseMove={() => setSelected(i)}
                    onClick={() => run(r)}
                  >
                    {r.kind === 'command' ? (
                      <span className="palette-icon">{r.command.icon}</span>
                    ) : r.kind === 'artist' ? (
                      <span className="palette-art round">{r.art ? <Art hash={r.art} /> : <Users size={16} />}</span>
                    ) : r.kind === 'album' ? (
                      <span className="palette-art"><Art hash={r.album.artwork} /></span>
                    ) : r.kind === 'song' ? (
                      <span className="palette-art"><Art hash={r.track.artwork} /></span>
                    ) : (
                      <span className="palette-icon">{r.collection.kind === 'smart' ? <Sparkles size={16} /> : <ListMusic size={16} />}</span>
                    )}
                    <span className="palette-text">
                      <strong>
                        {r.kind === 'command'
                          ? r.command.label
                          : r.kind === 'artist'
                            ? r.name
                            : r.kind === 'album'
                              ? r.album.name
                              : r.kind === 'song'
                                ? r.track.title
                                : r.collection.name}
                      </strong>
                      <small>
                        {r.kind === 'command'
                          ? r.command.hint
                          : r.kind === 'artist'
                            ? `Artist · ${r.songs} songs`
                            : r.kind === 'album'
                              ? `Album · ${r.album.artist}${r.album.year ? ` · ${r.album.year}` : ''}`
                              : r.kind === 'song'
                                ? `Song · ${r.track.artist} · ${r.track.album}`
                                : `${r.collection.kind === 'smart' ? 'Smart playlist' : 'Playlist'} · ${r.collection.entries.length} songs`}
                      </small>
                    </span>
                    {i === selected && <CornerDownLeft size={14} className="palette-enter" />}
                  </button>
                );
              })}
            </section>
          ))}
          {!flat.length && (
            <p className="palette-empty">
              <Music2 size={18} /> Nothing matches “{query}”.
            </p>
          )}
        </div>
        <footer className="palette-foot">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> to move
          </span>
          <span>
            <kbd>Enter</kbd> to open or play
          </span>
          <span>
            <Disc3 size={12} /> Songs play right away; albums and artists open
          </span>
        </footer>
      </div>
    </div>
  );
}
