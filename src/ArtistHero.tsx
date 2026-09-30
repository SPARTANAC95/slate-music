import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ExternalLink, Play, Shuffle } from 'lucide-react';
import { Art } from './components';

export interface ArtistInfo {
  found: boolean;
  bio?: string;
  wikipedia?: string;
  photo?: string;
  photoPage?: string;
}

/** The top of an artist page: photo, name and a short bio from Wikipedia when available. */
export default function ArtistHero({
  name,
  songs,
  albums,
  lookup,
  fallbackArt,
  onPlay,
  onShuffle,
}: {
  name: string;
  songs: number;
  albums: number;
  /** Whether artist photos and bios may be looked up online. */
  lookup: boolean;
  fallbackArt?: string | null;
  onPlay: () => void;
  onShuffle: () => void;
}) {
  const [info, setInfo] = useState<ArtistInfo | null>(null);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    let live = true;
    setInfo(null);
    setExpanded(false);
    invoke<ArtistInfo>('artist_info', { name })
      .then((i) => live && setInfo(i))
      .catch(() => live && setInfo({ found: false }));
    return () => {
      live = false;
    };
  }, [name, lookup]);
  const photo = info?.photo;
  const open = (url?: string) => url && invoke('open_link', { url }).catch(() => undefined);
  return (
    <section className={`artist-hero${photo ? ' has-photo' : ''}`}>
      {photo && <img className="artist-backdrop" src={`http://art.localhost/${photo}`} alt="" aria-hidden />}
      <div className={`artist-photo${!info && lookup ? ' loading' : ''}`}>
        <Art hash={photo || fallbackArt} name={name} large={!!photo} />
      </div>
      <div className="artist-text">
        <p className="eyebrow">Artist</p>
        <h1>{name}</h1>
        <p className="artist-meta">
          {albums} album{albums === 1 ? '' : 's'} · {songs} song{songs === 1 ? '' : 's'} in your library
        </p>
        {info?.bio && (
          <div className="artist-bio">
            <p className={expanded ? 'open' : ''}>{info.bio}</p>
            <div className="artist-links">
              {info.bio.length > 260 && (
                <button className="link-button" onClick={() => setExpanded(!expanded)}>
                  {expanded ? 'Show less' : 'Show more'}
                </button>
              )}
              {info.wikipedia && (
                <button className="link-button" onClick={() => open(info.wikipedia)}>
                  Read more on Wikipedia <ExternalLink size={11} />
                </button>
              )}
              {photo && info.photoPage && (
                <button className="link-button subtle" onClick={() => open(info.photoPage)}>
                  Photo: Wikimedia Commons
                </button>
              )}
            </div>
          </div>
        )}
        <div className="button-row">
          <button className="primary" onClick={onPlay}>
            <Play size={16} />
            Play artist
          </button>
          <button onClick={onShuffle}>
            <Shuffle size={16} />
            Shuffle
          </button>
        </div>
      </div>
    </section>
  );
}
