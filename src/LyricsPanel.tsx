import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ArrowDownToLine } from 'lucide-react';
import type { Playback } from './types';
import { scrollInside } from './components';
import { currentLine, parseLrc, wordProgress, type LyricLine } from './lrc';
import { playbackPosition } from './playbackClock';

interface Lyrics {
  synced: string | null;
  plain: string | null;
  instrumental: boolean;
  source: 'file' | 'tag' | 'lrclib' | null;
}

function useReducedMotion() {
  const [reduced, setReduced] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const query = matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return reduced;
}

/** Rebase on EVERY snapshot, including an unchanged position during a stall.
 * No elapsed paused time, no 150 ms anticipation, no animation delay on the clock. */
function usePosition(pb: Playback, reduced: boolean) {
  const at = useMemo(() => performance.now(), [pb]);
  const [, redraw] = useState(0);
  useEffect(() => {
    if (!pb.playing || pb.clockRunning === false) return;
    let frame = 0;
    let last = 0;
    const tick = (now: number) => {
      if (now - last >= (reduced ? 100 : 1000 / 60)) {
        last = now;
        redraw((n) => n + 1);
      }
      // The next snapshot restarts interpolation. Do not redraw forever after a stall.
      if (performance.now() - at < 300) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [pb.playing, pb.clockRunning, reduced, at]);
  return playbackPosition(pb, performance.now() - at);
}

const Line = memo(function Line({ line, index, phase, position, reduced, onSeek }: {
  line: LyricLine; index: number; phase: number; position: number;
  reduced: boolean; onSeek: (seconds: number) => void;
}) {
  return (
    <button data-line={index} className={'np-line ' + (phase === 0 ? 'active' : phase < 0 ? 'past' : '')}
      aria-current={phase === 0 ? 'true' : undefined}
      aria-label={line.text || 'Instrumental break'}
      onClick={() => onSeek(line.time)}>
      {line.text ? line.words ? line.words.map((word, i) => {
        const progress = phase < 0 ? 1 : phase > 0 ? 0 : wordProgress(word, position);
        const singing = phase === 0 && position >= word.time && (word.end == null || position < word.end);
        return <span key={i} aria-hidden="true"
          className={'np-word' + (singing ? ' singing' : '') + (progress === 1 ? ' sung' : '')}
          style={{ '--word-fill': (reduced ? (position >= word.time ? 100 : 0) : progress * 100) + '%' } as React.CSSProperties}
        >{word.text}</span>;
      }) : line.text : <span className="np-instrumental" aria-hidden="true"><i /><i /><i /></span>}
    </button>
  );
});

/** Keyed by track + lookup setting in NowPlaying; stale requests cannot cross tracks. */
export default function LyricsPanel({ trackId, pb, lookupLyrics, onSeek }: {
  trackId: string | null; pb: Playback; lookupLyrics: boolean; onSeek: (seconds: number) => void;
}) {
  const [lyrics, setLyrics] = useState<Lyrics | null>(null);
  const [loading, setLoading] = useState(!!trackId);
  const [browsing, setBrowsing] = useState(false);
  const reduced = useReducedMotion();
  const position = usePosition(pb, reduced);
  const lines = useMemo(() => lyrics?.synced ? parseLrc(lyrics.synced) : [], [lyrics]);
  const active = currentLine(lines, position);
  const list = useRef<HTMLDivElement>(null);
  const previous = useRef(-1);
  useEffect(() => {
    if (!trackId) return;
    let live = true;
    invoke<Lyrics>('song_lyrics', { id: trackId })
      .then((value) => { if (live) setLyrics(value); })
      .catch(() => { if (live) setLyrics(null); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [trackId]);

  useLayoutEffect(() => {
    const box = list.current;
    if (!box) return;
    const center = (smooth: boolean) => {
      if (browsing) return;
      const line = box.querySelector<HTMLElement>('[data-line="' + active + '"]');
      if (line) scrollInside(box, line, 'center', smooth && !reduced);
      else box.scrollTo({ top: 0, behavior: 'instant' });
    };
    // Adjacent lines flow; jumps, paused seeks and opening the view land immediately.
    center(pb.playing && previous.current >= 0 && Math.abs(active - previous.current) === 1);
    previous.current = active;
    const resize = new ResizeObserver(() => center(false));
    resize.observe(box);
    return () => resize.disconnect();
  }, [active, lines, browsing, reduced, pb.playing]);

  const seek = useMemo(() => (seconds: number) => {
    setBrowsing(false);
    onSeek(seconds);
  }, [onSeek]);
  const timedCount = lines.filter((line) => line.words).length;
  const timing = timedCount ? (lines.some((line) => line.text && !line.words) ? 'Word + line synced' : 'Word synced')
    : lines.length ? 'Line synced' : lyrics?.plain ? 'Text lyrics' : null;
  return (
    <div className="np-lyrics-panel">
      <div className="np-lyrics-caption">
        <span>{timing || 'Lyrics'}</span>
        {timing && <small>{lyrics?.source === 'lrclib' ? 'LRCLIB' : lyrics?.source === 'file' ? 'Local LRC' : 'Embedded lyrics'}</small>}
      </div>
      <div className={'np-lyrics ' + (lines.length ? 'synced' : '')} ref={list}
        onWheel={() => setBrowsing(true)} onTouchStart={() => setBrowsing(true)}
        onKeyDown={(e) => {
          if (['PageUp', 'PageDown', 'Home', 'End'].includes(e.key)) {
            e.stopPropagation();
            setBrowsing(true);
          }
        }}
        onFocus={(e) => { if ((e.target as HTMLElement).closest('.np-line')) setBrowsing(true); }}>
        {loading ? <p className="np-empty">Looking for lyrics.</p>
          : lines.length ? lines.map((line, i) =>
            <Line key={i} line={line} index={i} phase={i === active ? 0 : i < active ? -1 : 1}
              position={i === active ? position : 0} reduced={reduced} onSeek={seek} />)
          : lyrics?.plain ? <p className="np-plain">{lyrics.plain}</p>
          : <div className="np-empty">
            <p>{lyrics?.instrumental ? 'This one is instrumental.' : 'No lyrics for this song yet.'}</p>
            {!lookupLyrics && !lyrics?.instrumental && <small>Turn on “Find lyrics online” in Settings, or put an .lrc file beside the song.</small>}
          </div>}
        {timing && <small className="np-source">
          {timedCount ? 'Word timing from the lyric source. Select a line to seek.'
            : lines.length ? 'This source has line timing. Select a line to seek.' : 'This source has no timing.'}
        </small>}
      </div>
      {browsing && lines.length > 0 && <button className="np-follow" onClick={() => {
        setBrowsing(false);
        // Layout effect follows even if the active line has not changed.
      }}><ArrowDownToLine size={14} />Return to current line</button>}
    </div>
  );
}
