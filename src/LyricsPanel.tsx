import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ArrowDownToLine, Minus, Plus } from 'lucide-react';
import type { Playback } from './types';
import { currentLine, parseLrc, showLyrics, sungByCharacter, wordProgress, type ShownLine } from './lrc';
import { PlaybackClock } from './playbackClock';
import { deviceDelay, MOST, setSongShift, songShift } from './lyricTiming';

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

/** Where the line being sung rests in the panel, as a share of its height from the top. */
export const REST = 0.42;
/** How long the list takes to glide to the next line. */
const GLIDE_MS = 650;
const ease = (t: number) => 1 - (1 - t) ** 4;
/** Lines this far or further from the one being sung all look alike. */
const FAR = 4;
/** A seek lands on the audio frame at or just before the time asked for; this much slack
 * keeps a line you seek to from showing the one before it. */
const EDGE = 0.002;
/** What is drawn in a frame is seen about a frame later, so a playing song is drawn that far
 * on: one frame of this screen, and never more than a 60 Hz one. */
const FRAME_MS = 1000 / 60;
/** Seconds one press of the timing buttons moves the lyrics. */
const STEP = 0.1;

/** Draws the lyrics every frame, straight to the page: which line is sung, how far each of its
 * words is lit, and where the list is scrolled. React renders the rows once and leaves them. */
class Stage {
  private rows: HTMLElement[];
  private words: (HTMLElement[] | undefined)[] = [];
  private lit: (number[] | undefined)[] = [];
  private active = -2;
  private glide: { from: number; to: number; start: number } | null = null;
  private frame = 0;
  private drawn = 0;
  private framed = 0;
  private pace = FRAME_MS;
  /** Seconds added to the song's position: output delay and your own adjustments. */
  offset = 0;
  reduced = false;
  /** Keep the line being sung in view (off while you read ahead). */
  follow = true;

  constructor(
    private box: HTMLElement,
    private lines: ShownLine[],
    private clock: PlaybackClock,
  ) {
    this.rows = [...box.querySelectorAll<HTMLElement>('[data-line]')];
  }
  /** Draws now, and again every frame for as long as anything is moving. */
  draw = (now = performance.now()) => {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    // Draws also happen between frames (a new snapshot, a seek while paused), a little after
    // the time the next frame will report: never step back for it.
    now = this.drawn = now < this.drawn && this.drawn - now < 50 ? this.drawn : now;
    const time = this.clock.read(now + (this.clock.running ? this.pace : 0)) + this.offset;
    const active = currentLine(this.lines, time + EDGE);
    if (active !== this.active) {
      // Opening the view, and jumps while paused, land at once; everything else glides.
      const glide = this.active !== -2 && this.clock.running;
      this.activate(active);
      this.aim(now, glide);
    }
    const line = this.lines[active];
    if (line) this.light(active, line, time);
    if (this.glide) {
      const t = (now - this.glide.start) / GLIDE_MS;
      this.box.scrollTop = t >= 1 ? this.glide.to : this.glide.from + (this.glide.to - this.glide.from) * ease(Math.max(0, t));
      if (t >= 1) this.glide = null;
    }
    if (this.clock.running || this.glide) this.frame = requestAnimationFrame(this.tick);
    else this.framed = 0;
  };
  /** One frame of the screen. Learns how long this screen's frames are as it goes. */
  private tick = (now: number) => {
    const since = now - this.framed;
    this.framed = now;
    if (since > 0 && since < 50) this.pace += (Math.min(FRAME_MS, since) - this.pace) * 0.1;
    this.draw(now);
  };
  private activate(active: number) {
    this.active = active;
    this.rows.forEach((row, i) => {
      row.classList.toggle('active', i === active);
      row.classList.toggle('past', i < active);
      if (i === active) row.setAttribute('aria-current', 'true');
      else row.removeAttribute('aria-current');
      row.dataset.far = String(Math.min(FAR, Math.abs(i - active)));
    });
  }
  private light(index: number, line: ShownLine, time: number) {
    const row = this.rows[index];
    if (!row) return;
    const lit = (this.lit[index] ??= []);
    const set = (el: HTMLElement | undefined, k: number, progress: number) => {
      const p = Math.round(progress * 1000) / 1000;
      if (lit[k] === p) return;
      lit[k] = p;
      el?.style.setProperty('--p', String(p));
    };
    if (line.gap) {
      const passed = line.end > line.time ? Math.min(1, Math.max(0, (time - line.time) / (line.end - line.time))) : 1;
      // With motion reduced the three dots light one at a time.
      set(row, 0, this.reduced ? Math.floor(passed * 3) / 3 : passed);
      return;
    }
    const words = (this.words[index] ??= [...row.querySelectorAll<HTMLElement>('.np-word')]);
    // With motion reduced, whole words switch on at their start.
    line.words.forEach((word, k) =>
      set(words[k], k, this.reduced ? (time >= word.time ? 1 : 0) : wordProgress(word, time)),
    );
  }
  /** Scrolls the line being sung to its resting place. */
  aim(now: number, glide: boolean) {
    if (!this.follow) return;
    const row = this.rows[this.active];
    const top = row
      ? Math.max(0, Math.min(this.box.scrollHeight - this.box.clientHeight,
          row.offsetTop + row.offsetHeight / 2 - this.box.clientHeight * REST))
      : 0;
    if (glide && !this.reduced && Math.abs(top - this.box.scrollTop) > 1) {
      this.glide = { from: this.box.scrollTop, to: top, start: now };
    } else {
      this.glide = null;
      this.box.scrollTop = top;
    }
  }
  /** Room above the first line and below the last for them to reach the resting place (the
   * list's spacers in styles.css). */
  measure() {
    const height = this.box.clientHeight;
    this.box.style.setProperty('--np-above', Math.round(height * REST) + 'px');
    this.box.style.setProperty('--np-below', Math.round(height * (1 - REST)) + 'px');
  }
  /** You scrolled: the list is yours until you ask for the current line again. */
  release() {
    this.follow = false;
    this.glide = null;
  }
  stop() {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
  }
}

/** Syllables of one word stay on one line; words and characters may wrap between them. */
function wordsOf(line: ShownLine): ReactNode[] {
  const out: ReactNode[] = [];
  let run: ReactNode[] = [];
  let joinable = true;
  line.words.forEach((word, k) => {
    run.push(<span className="np-word" key={k}>{word.text}</span>);
    joinable &&= !sungByCharacter(word.text);
    if (!word.space && k < line.words.length - 1) return;
    out.push(run.length > 1 && joinable ? <span className="np-syllables" key={'s' + k}>{run}</span>
      : <Fragment key={'s' + k}>{run}</Fragment>);
    if (word.space) out.push(word.space);
    run = [];
    joinable = true;
  });
  return out;
}

const Row = memo(function Row({ line, index, onSeek }: {
  line: ShownLine; index: number; onSeek: (seconds: number) => void;
}) {
  return (
    <button data-line={index} className={'np-line' + (line.gap ? ' gap' : '')}
      aria-label={line.gap ? 'Instrumental break' : line.text}
      onClick={() => onSeek(line.time)}>
      <span aria-hidden="true" className={line.gap ? 'np-instrumental' : undefined}>
        {line.gap ? <><i /><i /><i /></> : wordsOf(line)}
      </span>
    </button>
  );
});

/** Keyed by track + lookup setting in NowPlaying; stale requests cannot cross tracks. */
export default function LyricsPanel({ trackId, pb, lookupLyrics, onSeek }: {
  trackId: string | null; pb: Playback; lookupLyrics: boolean; onSeek: (seconds: number) => void;
}) {
  // undefined while the lyrics are being looked for.
  const [lyrics, setLyrics] = useState<Lyrics | null | undefined>(trackId ? undefined : null);
  const [browsing, setBrowsing] = useState(false);
  const [shift, setShift] = useState(() => songShift(trackId));
  const reduced = useReducedMotion();
  const lines = useMemo(
    () => (lyrics?.synced ? showLyrics(parseLrc(lyrics.synced), pb.duration) : []),
    [lyrics, pb.duration],
  );
  const list = useRef<HTMLDivElement>(null);
  const clock = useRef<PlaybackClock | null>(null);
  clock.current ??= new PlaybackClock();
  const stage = useRef<Stage | null>(null);
  // Lyrics follow what is heard: later by the output's own delay, then as you adjusted them.
  const offset = shift - (pb.outputLatency ?? 0) - deviceDelay(pb.output?.device);
  const latest = useRef({ offset, onSeek });
  latest.current = { offset, onSeek };

  useEffect(() => {
    if (!trackId) return;
    let live = true;
    invoke<Lyrics>('song_lyrics', { id: trackId })
      .then((value) => { if (live) setLyrics(value); })
      .catch(() => { if (live) setLyrics(null); });
    return () => { live = false; };
  }, [trackId]);

  // Every snapshot from the engine steadies the clock; the stage reads it each frame.
  useLayoutEffect(() => {
    clock.current!.sync(pb);
    stage.current?.draw();
  }, [pb]);
  useLayoutEffect(() => {
    const box = list.current;
    if (!box || !lines.length) return;
    const made = new Stage(box, lines, clock.current!);
    stage.current = made;
    made.measure();
    // Sizes settle after the first layout (fonts, the window): keep the line in its place.
    const resize = new ResizeObserver(() => {
      made.measure();
      made.aim(performance.now(), false);
    });
    resize.observe(box);
    return () => {
      resize.disconnect();
      made.stop();
      stage.current = null;
    };
  }, [lines]);
  useLayoutEffect(() => {
    const made = stage.current;
    if (!made) return;
    const returning = !browsing && !made.follow;
    made.offset = offset;
    made.reduced = reduced;
    if (browsing) made.release();
    else made.follow = true;
    if (returning) made.aim(performance.now(), true);
    made.draw();
  }, [lines, offset, reduced, browsing]);

  const seek = useCallback((seconds: number) => {
    setBrowsing(false);
    // The song's position at which this line starts, allowing for the same offset.
    latest.current.onSeek(Math.max(0, seconds - latest.current.offset));
  }, []);
  const nudge = (by: number) => {
    const next = by ? Math.max(-MOST, Math.min(MOST, Math.round((shift + by) * 10) / 10)) : 0;
    if (trackId) setSongShift(trackId, next);
    setShift(next);
  };
  const sourced = lines.filter((line) => !line.gap && !line.estimated).length;
  const estimated = lines.some((line) => line.estimated);
  const timing = sourced ? (estimated ? 'Word + line synced' : 'Word synced')
    : lines.length ? 'Line synced' : lyrics?.plain ? 'Text lyrics' : null;
  return (
    <div className="np-lyrics-panel">
      <div className="np-lyrics-caption">
        <span>{timing || 'Lyrics'}</span>
        {lines.length > 0 && <span className="np-timing" role="group" aria-label="Lyrics timing">
          <button aria-label="Show lyrics later" title="Lyrics later" disabled={shift <= -MOST} onClick={() => nudge(-STEP)}><Minus size={12} /></button>
          <button className="np-timing-value" disabled={!shift} onClick={() => nudge(0)}
            aria-label={shift ? `Lyrics ${Math.abs(shift).toFixed(1)} seconds ${shift > 0 ? 'earlier' : 'later'}. Reset timing` : 'Lyrics timing not adjusted'}
            title={shift ? 'Reset timing for this song' : 'Lyrics early or late? Adjust this song with − and +'}>
            {shift ? `${Math.abs(shift).toFixed(1)}s ${shift > 0 ? 'earlier' : 'later'}` : 'Timing'}
          </button>
          <button aria-label="Show lyrics earlier" title="Lyrics earlier" disabled={shift >= MOST} onClick={() => nudge(STEP)}><Plus size={12} /></button>
        </span>}
        {timing && <small>{lyrics?.source === 'lrclib' ? 'LRCLIB' : lyrics?.source === 'file' ? 'Local LRC' : 'Embedded lyrics'}</small>}
      </div>
      <div className={'np-lyrics' + (lines.length ? ' synced' : '') + (browsing ? ' browsing' : '')} ref={list}
        onWheel={() => setBrowsing(true)} onTouchMove={() => setBrowsing(true)}
        onKeyDown={(e) => {
          if (['PageUp', 'PageDown', 'Home', 'End'].includes(e.key)) {
            e.stopPropagation();
            setBrowsing(true);
          }
        }}
        onFocus={(e) => {
          // Tabbing through the lines reads ahead; clicking one seeks instead.
          if ((e.target as HTMLElement).matches('.np-line:focus-visible')) setBrowsing(true);
        }}>
        {lyrics === undefined ? <p className="np-empty">Looking for lyrics.</p>
          : lines.length ? lines.map((line, i) => <Row key={i} line={line} index={i} onSeek={seek} />)
          : lyrics?.plain ? <p className="np-plain">{lyrics.plain}</p>
          : <div className="np-empty">
            <p>{lyrics?.instrumental ? 'This one is instrumental.' : 'No lyrics for this song yet.'}</p>
            {!lookupLyrics && !lyrics?.instrumental && <small>Turn on “Find lyrics online” in Settings, or put an .lrc file beside the song.</small>}
          </div>}
        {timing && <small className="np-source">
          {!lines.length ? 'This source has no timing.'
            : !estimated ? 'Word timing from the lyric source. Select a line to seek.'
            : sourced ? 'Word timing from the lyric source where it has it; other lines are timed by the line. Select a line to seek.'
            : 'This source times each line; words follow at an even pace within it. Select a line to seek.'}
        </small>}
      </div>
      {browsing && lines.length > 0 && <button className="np-follow" onClick={() => setBrowsing(false)}>
        <ArrowDownToLine size={14} />Return to current line</button>}
    </div>
  );
}
