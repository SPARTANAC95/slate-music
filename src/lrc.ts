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

/** A word (or syllable) as it is shown: `text` is lit between `time` and `end`. */
export interface ShownWord {
  time: number;
  end: number;
  text: string;
  /** White space after the word, kept out of the lit part. */
  space: string;
}
/** A row of the lyrics view: a sung line, or a pause in the singing when `gap` is set. */
export interface ShownLine {
  time: number;
  end: number;
  text: string;
  words: ShownWord[];
  gap: boolean;
  /** Word times were worked out from the line's own start and end, not given by the source. */
  estimated: boolean;
}
/** A song that starts with at least this much music before the first line shows a lead-in. */
const LEAD_IN = 4;
const VOWELS = /[aeiouyàáâãäåæèéêëìíîïòóôõöøœùúûüýÿаеёиоуыэюяіїєαεηιουω]+/gi;
/** Scripts written without spaces, where each character is sung on its own. */
const UNSPACED = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;
const LETTER = /[\p{L}\p{N}]/u;
/** Whether text is in a script sung one character at a time (and wrapped anywhere). */
export const sungByCharacter = (text: string) => UNSPACED.test(text);

/** Roughly how many beats a piece of text takes to sing. */
function beats(text: string): number {
  const letters = [...text].filter((c) => LETTER.test(c)).length;
  if (!letters) return 0.25;
  const vowels = text.match(VOWELS)?.length ?? 0;
  // Unknown scripts: about one beat per three letters.
  const count = vowels || Math.max(1, Math.round(letters / 3));
  // A comma or a full stop is a breath.
  return count + (/[,;:.!?…—–]["'”’)]*\s*$/.test(text) ? 0.5 : 0);
}
/** Splits a line into the pieces that light up one after another. */
function pieces(text: string): { text: string; space: string }[] {
  const out: { text: string; space: string }[] = [];
  for (const [, word, space] of text.matchAll(/(\S+)(\s*)/g)) {
    if (!UNSPACED.test(word)) {
      out.push({ text: word, space });
      continue;
    }
    // Each character on its own; punctuation and Latin letters stay with their neighbours.
    let run = '';
    const flush = () => {
      if (run) out.push({ text: run, space: '' });
      run = '';
    };
    for (const c of word) {
      if (UNSPACED.test(c)) {
        flush();
        run = c;
      } else if (run && UNSPACED.test(run[0]) && LETTER.test(c)) {
        flush();
        run = c;
      } else run += c;
    }
    flush();
    out[out.length - 1].space = space;
  }
  return out;
}
/** How long a word plausibly takes to sing when nothing follows it closely. */
const unhurried = (total: number) => 0.5 + 0.4 * total;

// Line-timed lyrics say when each line starts, not when its words are sung. The numbers below
// were fitted to 79 songs in four languages whose words were timed by hand (the JamendoLyrics
// set) and checked on songs left out of the fitting: words land a fifth closer to where they
// are sung than with one fixed pace for every song. The words of such lines remain an estimate.
/** How long a piece of text takes to sing, compared with others in the same song: its
 * syllables, with longer words a little longer. */
function weight(text: string): number {
  return beats(text) + 0.2 * [...text].filter((c) => LETTER.test(c)).length;
}
/** Added to a line's last word: lines end on a held note. */
const HELD = 1.5;
/** A line is usually over a little before the next one starts. */
const SHARE = 0.92;
/** Seconds a line takes beyond its words at the song's pace. */
const BREATH = 0.6;
/** Seconds per unit of weight when a song has too few lines to show its own pace. */
const USUAL_PACE = 0.19;
/** A song's pace is read from its quicker lines: slower ones are followed by a pause. */
const QUICKER = 0.25;
/** How fast this song is sung: seconds per unit of weight. `rates` are each line's time to
 * the next line over its weight, which is the pace wherever no pause follows. */
function songPace(rates: number[]): number {
  if (rates.length < 4) return USUAL_PACE;
  const sorted = [...rates].sort((a, b) => a - b);
  const at = (sorted.length - 1) * QUICKER;
  const low = Math.floor(at);
  const high = Math.min(sorted.length - 1, low + 1);
  return sorted[low] + (sorted[high] - sorted[low]) * (at - low);
}

/** Lays lyrics out for display. Lines keep the source's times; every word gets a start and an
 * end: the source's own where it has them (Enhanced LRC), otherwise spread across the line by
 * the length of each word, ending before the next line. `duration` is the song's length. */
export function showLyrics(lines: LyricLine[], duration = 0): ShownLine[] {
  const rows: ShownLine[] = [];
  const first = lines.find((line) => line.text);
  if (first && first.time >= LEAD_IN && lines[0] === first)
    rows.push({ time: 0, end: first.time, text: '', words: [], gap: true, estimated: false });
  // The next line that starts later (lines sharing a time stamp are sung together).
  const following = lines.map((line, i) => lines.slice(i + 1).find((next) => next.time > line.time));
  // Lines whose words the source did not time: their pieces, and how long each takes to sing.
  const drafts = lines.map((line) => {
    if (!line.text || line.words) return null;
    const parts = pieces(line.text);
    const weights = parts.map((part) => weight(part.text + part.space));
    weights[weights.length - 1] += HELD;
    return { parts, weights, total: weights.reduce((sum, w) => sum + w, 0) };
  });
  const pace = songPace(
    drafts.flatMap((draft, i) => (draft && following[i] ? [(following[i]!.time - lines[i].time) / draft.total] : [])),
  );
  lines.forEach((line, i) => {
    const later = following[i]?.time;
    const until = later ?? (duration > line.time ? duration : Infinity);
    if (!line.text) {
      rows.push({
        time: line.time,
        end: Number.isFinite(until) ? until : line.time,
        text: '',
        words: [],
        gap: true,
        estimated: false,
      });
      return;
    }
    if (line.words) {
      const words: ShownWord[] = [];
      for (const word of line.words) {
        const text = word.text.trimEnd();
        const space = word.text.slice(text.length);
        const last = words.at(-1);
        // White space with its own time stamp belongs to the word before it.
        if (!text.trim()) {
          if (last && !last.space) last.space = word.text;
          continue;
        }
        const lead = text.length - text.trimStart().length;
        if (lead && last && !last.space) last.space = text.slice(0, lead);
        words.push({ time: word.time, end: word.end ?? NaN, text: text.slice(lead), space });
      }
      words.forEach((word, k) => {
        if (!Number.isNaN(word.end)) return;
        // The source left the last word open: it lasts as long as it plausibly takes to sing.
        const next = words[k + 1]?.time ?? until;
        word.end = Math.max(word.time, Math.min(next, word.time + unhurried(beats(word.text))));
      });
      if (words.length) words[words.length - 1].space = '';
      const end = Math.max(line.time, ...words.map((word) => word.end));
      rows.push({ time: line.time, end, text: line.text, words, gap: false, estimated: false });
      return;
    }
    const { parts, weights, total } = drafts[i]!;
    // A blank time stamp after the line is the source saying where the singing stops; otherwise
    // the line ends a little before the next one. Either way it lasts no longer than its words
    // take at this song's pace, so it is not stretched across a pause.
    const share = following[i] && !following[i]!.text ? 1 : SHARE;
    const span = Math.max(0, Math.min((until - line.time) * share, pace * total + BREATH));
    let sung = 0;
    const words = parts.map((part, k) => {
      const time = line.time + (span * sung) / total;
      sung += weights[k];
      return { ...part, time, end: line.time + (span * sung) / total };
    });
    rows.push({ time: line.time, end: line.time + span, text: line.text, words, gap: false, estimated: true });
  });
  return rows;
}

/** Fill only between supplied boundaries; an open-ended word lights at its onset. */
export function wordProgress(word: { time: number; end?: number }, position: number): number {
  if (position < word.time) return 0;
  if (word.end == null || word.end <= word.time) return 1;
  return Math.min(1, (position - word.time) / (word.end - word.time));
}

/** Index of the line being sung, or -1 before the first line. */
export function currentLine(lines: { time: number }[], position: number): number {
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
