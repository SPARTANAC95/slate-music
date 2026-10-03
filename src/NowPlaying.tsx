import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, Heart, ListMusic, MicVocal, Waves } from 'lucide-react';
import type { Playback, Track } from './types';
import { Art, IconButton } from './components';
import { quality, time } from './library';
import LyricsPanel from './LyricsPanel';

export default function NowPlaying({
  track,
  pb,
  trackMap,
  accent,
  transport,
  progress,
  volume,
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
  volume: ReactNode;
  lookupLyrics: boolean;
  onClose: () => void;
  onFavorite: (t: Track) => void;
  onSeek: (seconds: number) => void;
  onJump: (index: number) => void;
  onAlbum: (t: Track) => void;
}) {
  const [tab, setTab] = useState<'lyrics' | 'next'>('lyrics');
  const [path, setPath] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  // Keyboard focus moves into the view, and back to where it was when the view closes.
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    root.current?.querySelector<HTMLElement>('button')?.focus();
    return () => before?.focus?.();
  }, []);
  const q = track ? quality(track) : null;
  const upNext = pb.queue.slice(pb.cursor + 1, pb.cursor + 31);
  return (
    <div
      className="now-playing"
      role="dialog"
      aria-modal="true"
      aria-label="Now playing"
      ref={root}
      onKeyDown={(e) => {
        if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
        if (e.key === ' ' && (e.target as HTMLElement).closest('button')) e.stopPropagation();
        if (e.key !== 'Tab') return;
        const items = [...(root.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]') ?? [])]
          .filter((el) => el.tabIndex >= 0 && el.getClientRects().length > 0);
        const first = items[0], last = items.at(-1);
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }}
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
        <div className="np-tabs" role="tablist" aria-label="Now playing view" onKeyDown={(e) => {
          if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
            e.preventDefault();
            e.stopPropagation();
            const next = e.key === 'Home' ? 'lyrics' : e.key === 'End' ? 'next' : tab === 'lyrics' ? 'next' : 'lyrics';
            setTab(next);
            root.current?.querySelector<HTMLElement>('#np-tab-' + next)?.focus();
          }
        }}>
          <button role="tab" id="np-tab-lyrics" aria-controls="np-panel" tabIndex={tab === 'lyrics' ? 0 : -1} aria-selected={tab === 'lyrics'} className={tab === 'lyrics' ? 'active' : ''} onClick={() => setTab('lyrics')}>
            <MicVocal size={15} />
            Lyrics
          </button>
          <button role="tab" id="np-tab-next" aria-controls="np-panel" tabIndex={tab === 'next' ? 0 : -1} aria-selected={tab === 'next'} className={tab === 'next' ? 'active' : ''} onClick={() => setTab('next')}>
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
        <section className="np-side" role="tabpanel" id="np-panel" aria-labelledby={"np-tab-" + tab}>
          {tab === 'lyrics' ? (
            <LyricsPanel key={(track?.id ?? "empty") + ":" + lookupLyrics}
              trackId={track?.id ?? null} pb={pb} lookupLyrics={lookupLyrics} onSeek={onSeek} />
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
        <div className="np-volume">{volume}</div>
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
