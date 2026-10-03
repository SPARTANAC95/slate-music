/** A timed lyric line. Empty text marks an instrumental gap. */
export interface LyricLine {
  time: number;
  text: string;
  /** Source-timed words/syllables, never estimated from the line's length. */
  words?: LyricWord[];
}
export interface LyricWord {
  time: number;
  text: string;
  /** Only present when the source supplies the next boundary. */
  end?: number;
}
const STAMP = /\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/g;
const WORD = /<(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)>/g;
const secondsAt = (minutes: string, seconds: string) =>
  Number(minutes) * 60 + Number(seconds.replace(':', '.'));

function timedWords(content: string, start: number): LyricWord[] | undefined {
  const marks = [...content.matchAll(WORD)];
  if (!marks.length) return;
  const words: LyricWord[] = [];
  let previous = start;
  let from = 0;
  for (const mark of marks) {
    const at = secondsAt(mark[1], mark[2]);
    if (Number(mark[2].replace(':', '.')) >= 60 || at < previous) return;
    const text = content.slice(from, mark.index);
    if (text) words.push({ time: previous, text, end: at });
    previous = at;
    from = mark.index! + mark[0].length;
  }
  const tail = content.slice(from);
  if (tail) words.push({ time: previous, text: tail });
  return words.some((word) => word.text.trim()) ? words : undefined;
}

/** Standard and Enhanced LRC, including repeated lines and file-wide [offset:ms].
 * Enhanced <mm:ss.xx> markers are absolute source timestamps, not estimated timings. */
export function parseLrc(text: string): LyricLine[] {
  let offset = 0;
  const lines: LyricLine[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const shift = raw.match(/^\s*\[offset:\s*([+-]?\d+)\s*\]/i);
    if (shift) {
      // A positive offset shows lyrics sooner.
      offset = Number(shift[1]) / 1000;
      continue;
    }
    const stamps = [...raw.matchAll(STAMP)];
    if (!stamps.length) continue;
    const content = raw.replace(STAMP, '').trim();
    for (const [, minutes, seconds] of stamps) {
      const time = secondsAt(minutes, seconds);
      // Repeated line stamps don't imply repeated absolute word stamps.
      const words = stamps.length === 1 ? timedWords(content, time) : undefined;
      lines.push({ time, text: content.replace(WORD, '').trim(), ...(words && { words }) });
    }
  }
  // Offset is metadata even when an editor writes it after the timed lines.
  for (const line of lines) {
    line.time = Math.max(0, line.time - offset);
    for (const word of line.words ?? []) {
      word.time = Math.max(0, word.time - offset);
      if (word.end != null) word.end = Math.max(0, word.end - offset);
    }
  }
  return lines.sort((a, b) => a.time - b.time);
}

/** Fill only between supplied boundaries; an open-ended word lights at its onset. */
export function wordProgress(word: LyricWord, position: number): number {
  if (position < word.time) return 0;
  if (word.end == null || word.end <= word.time) return 1;
  return Math.min(1, (position - word.time) / (word.end - word.time));
}

/** Index of the line being sung, or -1 before the first line. */
export function currentLine(lines: LyricLine[], position: number): number {
  let low = 0, high = lines.length - 1, found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (lines[mid].time <= position) {
      found = mid;
      low = mid + 1;
    } else high = mid - 1;
  }
  return found;
}
