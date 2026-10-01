import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ChevronDown, Heart, ListMusic, MicVocal, Waves } from 'lucide-react';
import type { Playback, Track } from './types';
import { Art, IconButton, scrollInside } from './components';
import { quality, time } from './library';
import { currentLine, parseLrc } from './lrc';

interface Lyrics {
  synced: string | null;
  plain: string | null;
  instrumental: boolean;
  source: 'file' | 'tag' | 'lrclib' | null;
}
/** Playback position between the engine's updates (every ~240 ms), for smooth lyrics. */
function usePosition(pb: Playback) {
  const received = useRef({ position: pb.position, at: performance.now() });
  const [, redraw] = useState(0);
  useEffect(() => {
    received.current = { position: pb.position, at: performance.now() };
  }, [pb.position, pb.currentId]);
  useEffect(() => {
    if (!pb.playing) return;
    const timer = setInterval(() => redraw((n) => n + 1), 100);
    return () => clearInterval(timer);
  }, [pb.playing]);
  const { position, at } = received.current;
  return pb.playing ? position + (performance.now() - at) / 1000 : position;
}

export default function NowPlaying({
  track,
  pb,
  trackMap,
  accent,
  transport,
  progress,
  lookupLyrics,
  onClose,
  onFavorite,
  onSeek,
  onJump,
  onAlbum,
}: {
  track: Track | null;
  pb: Playback;
  trackMap: Map<string, Track>;
  accent: string | null;
  transport: ReactNode;
  progress: ReactNode;
  lookupLyrics: boolean;
  onClose: () => void;
  onFavorite: (t: Track) => void;
  onSeek: (seconds: number) => void;
  onJump: (index: number) => void;
  onAlbum: (t: Track) => void;
}) {
  const [tab, setTab] = useState<'lyrics' | 'next'>('lyrics');
  const [path, setPath] = useState(false);
  const [lyrics, setLyrics] = useState<Lyrics | null>(null);
  const [loading, setLoading] = useState(false);
  const position = usePosition(pb);
  const lines = useMemo(() => (lyrics?.synced ? parseLrc(lyrics.synced) : []), [lyrics]);
  const active = currentLine(lines, position + 0.15);
  const list = useRef<HTMLDivElement>(null);
  const userScrolled = useRef(0);
  const root = useRef<HTMLDivElement>(null);
  // Keyboard focus moves into the view, and back to where it was when the view closes.
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    root.current?.querySelector<HTMLElement>('button')?.focus();
    return () => before?.focus?.();
  }, []);
  useEffect(() => {
    if (!track) return setLyrics(null);
    let live = true;
    setLyrics(null);
    setLoading(true);
    invoke<Lyrics>('song_lyrics', { id: track.id })
      .then((l) => live && setLyrics(l))
      .catch(() => live && setLyrics(null))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [track?.id, lookupLyrics]);
  // Keep the sung line centred, unless the listener scrolled in the last few seconds. Only the
  // lyrics move: near the end of a song the line can't be centred, and scrolling anything
  // around it would shift the whole view.
  useEffect(() => {
    const box = list.current;
    if (!box || Date.now() - userScrolled.current < 4000) return;
    const line = active >= 0 ? box.querySelector<HTMLElement>(`[data-line="${active}"]`) : null;
    if (line) scrollInside(box, line, 'center', true);
    else box.scrollTo({ top: 0, behavior: 'smooth' });
  }, [active, lines]);
  // A new song starts at the top of its lyrics.
  useEffect(() => {
    userScrolled.current = 0;
    list.current?.scrollTo({ top: 0 });
  }, [track?.id]);
  const q = track ? quality(track) : null;
  const upNext = pb.queue.slice(pb.cursor + 1, pb.cursor + 31);
  const hasLyrics = !!(lyrics?.synced || lyrics?.plain);
  return (
    <div
      className="now-playing"
      role="dialog"
      aria-modal="true"
      aria-label="Now playing"
      ref={root}
      style={accent ? ({ '--np-accent': accent } as React.CSSProperties) : undefined}
    >
      <div className="np-backdrop" aria-hidden="true">
        {track?.artwork && <Art hash={track.artwork} key={track.artwork} />}
      </div>
      <header className="np-head">
        <IconButton label="Close Now Playing (Esc)" onClick={onClose}>
          <ChevronDown size={22} />
        </IconButton>
        <span>Now playing</span>
        <div className="np-tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'lyrics'} className={tab === 'lyrics' ? 'active' : ''} onClick={() => setTab('lyrics')}>
            <MicVocal size={15} />
            Lyrics
          </button>
          <button role="tab" aria-selected={tab === 'next'} className={tab === 'next' ? 'active' : ''} onClick={() => setTab('next')}>
            <ListMusic size={15} />
            Up next
          </button>
        </div>
      </header>
      <div className="np-body">
        <section className={`np-art ${path ? 'with-path' : ''}`}>
          <div className="np-cover" key={track?.id}>
            <Art hash={track?.artwork} name={track?.album} large />
          </div>
          <div className="np-meta">
            <div>
              <h1>{track?.title || 'Nothing playing'}</h1>
              <p>{track?.artist || 'Choose a song to begin.'}</p>
              {track && (
                <button className="text-button np-album" onClick={() => onAlbum(track)}>
                  {track.album}
                  {(track.originalYear || track.year) > 0 && ` · ${track.originalYear || track.year}`}
                </button>
              )}
            </div>
            {track && (
              <IconButton
                label={track.favorite ? 'Remove from favorites' : 'Add to favorites'}
                active={track.favorite}
                onClick={() => onFavorite(track)}
              >
                <Heart size={22} fill={track.favorite ? 'currentColor' : 'none'} />
              </IconButton>
            )}
          </div>
          {q && (
            <div className="np-quality">
              {q.label && <span className={`quality-badge ${q.hiRes ? 'hi-res' : ''}`}>{q.label}</span>}
              <span>
                {track!.format}
                {q.detail && ` · ${q.detail}`}
              </span>
              <button
                className={`np-path-toggle ${path ? 'active' : ''}`}
                aria-expanded={path}
                onClick={() => setPath((open) => !open)}
              >
                <Waves size={13} />
                Signal path
              </button>
            </div>
          )}
          {path && track && <SignalPath track={track} pb={pb} />}
        </section>
        <section className="np-side">
          {tab === 'lyrics' ? (
            <div
              className={`np-lyrics ${lines.length ? 'synced' : ''}`}
              ref={list}
              onWheel={() => (userScrolled.current = Date.now())}
            >
              {loading && !lyrics ? (
                <p className="np-empty">Looking for lyrics…</p>
              ) : lines.length ? (
                lines.map((line, i) => (
                  <button
                    key={i}
                    data-line={i}
                    className={`np-line ${i === active ? 'active' : i < active ? 'past' : ''}`}
                    onClick={() => onSeek(line.time)}
                  >
                    {line.text || '♪'}
                  </button>
                ))
              ) : lyrics?.plain ? (
                <p className="np-plain">{lyrics.plain}</p>
              ) : (
                <div className="np-empty">
                  <p>{lyrics?.instrumental ? 'This one is instrumental.' : 'No lyrics for this song yet.'}</p>
                  {!lookupLyrics && !lyrics?.instrumental && (
                    <small>
                      Turn on “Find lyrics online” in Settings, or put an .lrc file beside the song.
                    </small>
                  )}
                </div>
              )}
              {hasLyrics && lyrics?.source && (
                <small className="np-source">
                  {lyrics.source === 'lrclib'
                    ? 'Lyrics from LRCLIB'
                    : lyrics.source === 'file'
                      ? 'Lyrics from the .lrc file beside this song'
                      : 'Lyrics stored in this song'}
                </small>
              )}
            </div>
          ) : (
            <div className="np-next">
              {upNext.length ? (
                upNext.map((id, i) => {
                  const t = trackMap.get(id);
                  return t ? (
                    <button key={`${id}-${i}`} className="next-track" onClick={() => onJump(pb.cursor + i + 1)}>
                      <Art hash={t.artwork} />
                      <span>
                        <strong>{t.title}</strong>
                        <small>{t.artist}</small>
                      </span>
                      <span className="next-time">{time(t.duration)}</span>
                    </button>
                  ) : null;
                })
              ) : (
                <p className="np-empty">Nothing queued after this song.</p>
              )}
            </div>
          )}
        </section>
      </div>
      <footer className="np-controls">
        {transport}
        {progress}
      </footer>
    </div>
  );
}

/** Whether the equalizer changes the sound: on, with a band or the preamp away from 0 dB. */
export const eqChanges = (pb: Playback) =>
  !!pb.eq?.enabled && (pb.eq.preamp !== 0 || pb.eq.bands.some((b) => b !== 0));
/** Every step between the file and the speakers, stated plainly. */
function SignalPath({ track, pb }: { track: Track; pb: Playback }) {
  const q = quality(track);
  const rate = track.sampleRate;
  const out = pb.output;
  const kHz = (hz: number) => `${Math.round(hz / 100) / 10} kHz`;
  const exclusive = !!out?.exclusive;
  // What keeps the device from getting exactly what is in the file. A flat equalizer and an
  // unmeasured song leave the samples untouched; 32-bit files are decoded at 24-bit precision.
  const changes = [
    !q.lossless && 'a lossy file',
    pb.volume < 1 && `volume at ${Math.round(pb.volume * 100)}%`,
    eqChanges(pb) && 'the equalizer',
    (pb.gainKind === 'track' || pb.gainKind === 'album') && 'loudness levelling',
    !rate && 'an unknown sample rate',
    out && rate && out.sampleRate !== rate && 'a rate conversion',
    out?.bits && track.bitDepth > out.bits && `${out.bits}-bit output`,
    track.bitDepth > 24 && '32-bit samples decoded at 24-bit precision',
  ].filter(Boolean) as string[];
  const steps: [string, string][] = [
    ['Source', `${track.format}${q.detail ? ` · ${q.detail}` : ''}${q.label ? ` · ${q.label}` : ''}`],
    [
      'Loudness',
      pb.gainKind === 'off'
        ? 'Levelling off'
        : pb.gainKind === 'unmeasured' || pb.gainDb == null
          ? 'Not measured yet'
          : `${pb.gainDb > 0 ? '+' : ''}${pb.gainDb.toFixed(1)} dB (${pb.gainKind === 'album' ? 'album' : 'song'})`,
    ],
    [
      'Equalizer',
      pb.eq?.enabled ? `${pb.eq.preset || 'Custom'}${pb.eq.preamp ? ` · preamp ${pb.eq.preamp} dB` : ''}` : 'Off',
    ],
    ['Volume', pb.volume >= 1 ? '100%' : `${Math.round(pb.volume * 100)}%`],
    [
      'Mixing',
      !rate
        ? 'Source rate unknown'
        : exclusive && out
          ? rate !== out.sampleRate
            ? `Converted from ${kHz(rate)} to ${kHz(out.sampleRate)}; the device doesn’t take ${kHz(rate)}`
            : `${kHz(out.sampleRate)}, no conversion`
          : `${rate !== 48000 ? `Converted from ${kHz(rate)} to 48 kHz` : '48 kHz, no conversion'}${
              out && out.sampleRate !== 48000 ? `, then by Windows to ${kHz(out.sampleRate)}` : ''
            }`,
    ],
    [
      'Output',
      out
        ? `${out.device} · ${exclusive ? `Exclusive mode · ${kHz(out.sampleRate)} · ${out.bits}-bit` : `Windows shared mode · ${kHz(out.sampleRate)}`}${out.fallback ? ' (chosen device not connected)' : ''}`
        : 'No output device',
    ],
  ];
  const verdict = !exclusive
    ? null
    : changes.length
      ? `Not bit-perfect: ${changes.join(', ')}.`
      : 'Bit-perfect: the device receives exactly what is in the file.';
  return (
    <ol className="np-path">
      {steps.map(([label, value]) => (
        <li key={label}>
          <span>{label}</span>
          <strong>{value}</strong>
        </li>
      ))}
      {verdict && <li className={`np-verdict ${changes.length ? '' : 'perfect'}`}>{verdict}</li>}
    </ol>
  );
}
