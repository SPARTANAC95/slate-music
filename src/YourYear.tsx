import { useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Flame, Play, Sparkles } from 'lucide-react';
import type { Album, Track } from './types';
import { Art } from './components';
import { yearInReview, type Play as PlayRow } from './insights';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "1 play", "12 plays". */
const count = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

/** A private year in review, worked out from Slate Music's own listening history. */
export default function YourYear({
  plays,
  trackMap,
  albums,
  onPlay,
  onArtist,
  onAlbum,
}: {
  plays: PlayRow[] | null;
  trackMap: Map<string, Track>;
  albums: Album[];
  onPlay: (tracks: Track[]) => void;
  onArtist: (name: string) => void;
  onAlbum: (a: Album) => void;
}) {
  const years = useMemo(
    () => [...new Set((plays || []).map(([, at]) => new Date(at).getFullYear()))].sort((a, b) => b - a),
    [plays],
  );
  const [chosen, setChosen] = useState<number | null>(null);
  const year = chosen ?? years[0] ?? new Date().getFullYear();
  const stats = useMemo(() => (plays ? yearInReview(year, plays, trackMap) : null), [plays, year, trackMap]);
  const [photos, setPhotos] = useState<Record<string, string>>({});
  const topNames = (stats?.topArtists || []).map((a) => a.name).join('\n');
  useEffect(() => {
    if (!topNames) return;
    invoke<Record<string, string>>('artist_photos', { names: topNames.split('\n') })
      .then(setPhotos)
      .catch(() => undefined);
  }, [topNames]);
  if (!plays) return <p className="year-empty">Gathering your listening history…</p>;
  if (!stats || !stats.plays)
    return (
      <div className="year-empty">
        <Sparkles size={34} strokeWidth={1.2} />
        <h1>Your year starts with a song.</h1>
        <p>Play some music and your year in review will build itself here, privately, on this PC.</p>
      </div>
    );
  const peak = Math.max(...stats.months, 1);
  const hours = Math.floor(stats.minutes / 60);
  return (
    <div className="your-year">
      <header className="year-hero">
        <div>
          <p className="year-kicker">Your year in music</p>
          <h1>{year}</h1>
          <p>
            {hours > 0
              ? `${count(hours, 'hour')}${stats.minutes % 60 ? ` ${count(stats.minutes % 60, 'minute')}` : ''}`
              : count(stats.minutes, 'minute')}{' '}
            of
            listening across {count(stats.songs, 'song')} by {count(stats.artists, 'artist')}.
          </p>
        </div>
        {years.length > 1 && (
          <div className="year-pills" role="tablist">
            {years.map((y) => (
              <button key={y} role="tab" aria-selected={y === year} className={y === year ? 'active' : ''} onClick={() => setChosen(y)}>
                {y}
              </button>
            ))}
          </div>
        )}
      </header>
      <div className="year-numbers">
        <div>
          <strong>{stats.plays.toLocaleString()}</strong>
          <span>{stats.plays === 1 ? 'play' : 'plays'}</span>
        </div>
        <div>
          <strong>{stats.minutes.toLocaleString()}</strong>
          <span>{stats.minutes === 1 ? 'minute' : 'minutes'}</span>
        </div>
        <div>
          <strong>
            <Flame size={20} />
            {stats.longestStreak}
          </strong>
          <span>{stats.longestStreak === 1 ? 'day' : 'days in a row'}, longest streak</span>
        </div>
        <div>
          <strong>{stats.discoveries.length}</strong>
          <span>{stats.discoveries.length === 1 ? 'new artist' : 'new artists'}</span>
        </div>
      </div>
      <div className="year-grid">
        <section>
          <div className="section-heading">
            <h2>Top songs</h2>
            <button className="text-button" onClick={() => onPlay(stats.topSongs.map((s) => s.track))}>
              <Play size={13} /> Play them
            </button>
          </div>
          <ol className="year-list">
            {stats.topSongs.map(({ track, plays: n }, i) => (
              <li key={track.id}>
                <span className="year-rank">{i + 1}</span>
                <Art hash={track.artwork} />
                <span>
                  <strong>{track.title}</strong>
                  <small>{track.artist}</small>
                </span>
                <em>{count(n, 'play')}</em>
              </li>
            ))}
          </ol>
        </section>
        <section>
          <h2>Top artists</h2>
          <ol className="year-list artists">
            {stats.topArtists.map(({ name, plays: n, artwork }, i) => (
              <li key={name}>
                <span className="year-rank">{i + 1}</span>
                <Art hash={photos[name] || artwork} className={photos[name] ? 'photo' : ''} />
                <button className="text-button" onClick={() => onArtist(name)}>
                  <strong>{name}</strong>
                </button>
                <em>{count(n, 'play')}</em>
              </li>
            ))}
          </ol>
        </section>
      </div>
      <section>
        <h2>Top albums</h2>
        <div className="year-albums">
          {stats.topAlbums.map(({ album, artist, plays: n, artwork }) => {
            const a = albums.find((x) => x.name === album && x.artist === artist);
            return (
              <button key={`${album}-${artist}`} className="year-album" onClick={() => a && onAlbum(a)}>
                <Art hash={artwork} />
                <strong>{album}</strong>
                <small>
                  {artist} · {count(n, 'play')}
                </small>
              </button>
            );
          })}
        </div>
      </section>
      <section>
        <h2>Month by month</h2>
        <div className="year-months" aria-label="Plays per month">
          {stats.months.map((n, i) => (
            <div key={MONTHS[i]} title={`${MONTHS[i]}: ${count(n, 'play')}`}>
              <span style={{ height: `${Math.max(2, (n / peak) * 100)}%` }} className={n === peak ? 'peak' : ''} />
              <small>{MONTHS[i]}</small>
            </div>
          ))}
        </div>
        {stats.busiestDay && (
          <p className="fine-print">
            Busiest day:{' '}
            {new Date(stats.busiestDay.date).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}{' '}
            with {count(stats.busiestDay.plays, 'play')}.
            {stats.discoveries.length > 0 &&
              ` New to you this year: ${stats.discoveries.slice(0, 6).join(', ')}${stats.discoveries.length > 6 ? ` and ${stats.discoveries.length - 6} more` : ''}.`}
          </p>
        )}
      </section>
      <p className="fine-print">
        Worked out on this PC from Slate Music’s own history. A play counts when a song starts.
      </p>
    </div>
  );
}
