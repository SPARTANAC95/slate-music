import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ArrowDownToLine, Minus, Plus, SlidersHorizontal } from 'lucide-react';
import type { Playback } from './types';
import { currentLine, parseLrc, showLyrics, sungByCharacter, wordProgress, type ShownLine } from './lrc';
import { PlaybackClock } from './playbackClock';
import { deviceDelay, MOST, setSongShift, setWordMode, songShift, wordMode, WORD_MODES, type WordMode } from './lyricTiming';

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
const MODE_NAMES: Record<WordMode, string> = { on: 'On', exact: 'Exact only', off: 'Off' };
const MODE_HINTS: Record<WordMode, string> = {
  on: 'Light every line word by word',
  exact: 'Word by word only where the lyric source timed each word',
  off: 'Light each line as a whole',
};

/** Draws the lyrics every frame, straight to the page: which line is sung, how far each of its
 * words is lit, and where the list is scrolled. React renders the rows once and leaves them. */
class Stage {
  private rows: HTMLElement[];
  private words: (HTMLElement[] | undefined)[] = [];
  private lit: (number[] | undefined)[] = [];
  private active = -2;
  /** The first row lit with the active one: lines sharing a time stamp are sung together. */
  private first = -2;
  private glide: { from: number; to: number; start: number } | null = null;
  private frame = 0;
  private drawn = 0;
  private framed = 0;
  private pace = FRAME_MS;
  /** Seconds added to the song's position: output delay and your own adjustments. */
  offset = 0;
  reduced = false;
  mode: WordMode = 'on';
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
    // A line and its translation carry the same time stamp: both are lit.
    for (let i = Math.max(0, this.first); i <= active; i++) this.light(i, this.lines[i], time);
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
    let first = active;
    while (first > 0 && this.lines[first - 1].time === this.lines[first].time) first -= 1;
    this.active = active;
    this.first = first;
    this.rows.forEach((row, i) => {
      const sung = i >= first && i <= active;
      row.classList.toggle('active', sung);
      row.classList.toggle('past', i < first);
      if (sung) row.setAttribute('aria-current', 'true');
      else row.removeAttribute('aria-current');
      row.dataset.far = String(Math.min(FAR, sung ? 0 : i < first ? first - i : i - active));
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
    // Word by word switched off, or kept for lines whose words the source timed: the line
    // being sung is lit whole. With motion reduced, whole words switch on at their start.
    const whole = this.mode === 'off' || (this.mode === 'exact' && line.estimated);
    line.words.forEach((word, k) =>
      set(words[k], k, whole ? 1 : this.reduced ? (time >= word.time ? 1 : 0) : wordProgress(word, time)),
    );
  }
  /** Scrolls the line being sung to its resting place. */
  aim(now: number, glide: boolean) {
    if (!this.follow) return;
    const row = this.rows[this.active];
    const from = this.rows[this.first] ?? row;
    // The middle of what is being sung (one line, or a line with its translation).
    const top = row
      ? Math.max(0, Math.min(this.box.scrollHeight - this.box.clientHeight,
          (from.offsetTop + row.offsetTop + row.offsetHeight) / 2 - this.box.clientHeight * REST))
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
  const [mode, setMode] = useState(wordMode);
  // Everything that can be adjusted sits behind one button, so the view is only lyrics.
  const [options, setOptions] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
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
    made.mode = mode;
    if (browsing) made.release();
    else made.follow = true;
    if (returning) made.aim(performance.now(), true);
    made.draw();
  }, [lines, offset, reduced, browsing, mode]);
  // The options close when you click anywhere else.
  useEffect(() => {
    if (!options) return;
    const away = (e: PointerEvent) => {
      if (!menu.current?.contains(e.target as Node)) setOptions(false);
    };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [options]);

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
  const choose = (next: WordMode) => {
    setWordMode(next);
    setMode(next);
  };
  return (
    <div className="np-lyrics-panel" data-timing={timing ?? undefined}>
      {lines.length > 0 && <div className="np-options-anchor" ref={menu}
        onKeyDown={(e) => {
          if (e.key !== 'Escape' || !options) return;
          // Esc closes the options first, not the whole view.
          e.stopPropagation();
          setOptions(false);
          menu.current?.querySelector<HTMLElement>('.np-options-button')?.focus();
        }}>
        <button className={'np-options-button' + (options ? ' open' : '')} aria-label="Lyrics options" title="Lyrics options"
          aria-haspopup="dialog" aria-expanded={options} onClick={() => setOptions((open) => !open)}>
          <SlidersHorizontal size={15} />
        </button>
        {options && <div className="np-options" role="dialog" aria-label="Lyrics options">
          <p className="np-options-source">
            <strong>{timing}</strong>
            <span>{lyrics?.source === 'lrclib' ? 'LRCLIB' : lyrics?.source === 'file' ? 'Local LRC' : 'Embedded lyrics'}</span>
          </p>
          <div className="np-option">
            <span>Timing</span>
            <span className="np-timing" role="group" aria-label="Lyrics timing">
              <button aria-label="Show lyrics later" title="Lyrics later" disabled={shift <= -MOST} onClick={() => nudge(-STEP)}><Minus size={12} /></button>
              <button className="np-timing-value" disabled={!shift} onClick={() => nudge(0)}
                aria-label={shift ? `Lyrics ${Math.abs(shift).toFixed(1)} seconds ${shift > 0 ? 'earlier' : 'later'}. Reset timing` : 'Lyrics timing not adjusted'}
                title={shift ? 'Reset timing for this song' : 'Lyrics early or late? Adjust this song with − and +'}>
                {shift ? `${Math.abs(shift).toFixed(1)}s ${shift > 0 ? 'earlier' : 'later'}` : 'As timed'}
              </button>
              <button aria-label="Show lyrics earlier" title="Lyrics earlier" disabled={shift >= MOST} onClick={() => nudge(STEP)}><Plus size={12} /></button>
            </span>
          </div>
          <div className="np-option">
            <span>Word by word</span>
            <span className="np-choice" role="radiogroup" aria-label="Word by word">
              {WORD_MODES.map((each) => (
                <button key={each} role="radio" aria-checked={mode === each} title={MODE_HINTS[each]}
                  className={mode === each ? 'active' : ''} onClick={() => choose(each)}>{MODE_NAMES[each]}</button>
              ))}
            </span>
          </div>
          <small>
            {!estimated ? 'This source timed every word.'
              : sourced ? 'This source timed the words of some lines; in the others, word times are estimated from the song’s pace.'
              : 'This source times each line. Word times inside a line are estimated from the song’s pace.'}
          </small>
        </div>}
      </div>}
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
      </div>
      {browsing && lines.length > 0 && <button className="np-follow" onClick={() => setBrowsing(false)}>
        <ArrowDownToLine size={14} />Return to current line</button>}
    </div>
  );
}
