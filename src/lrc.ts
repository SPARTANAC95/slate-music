/** One timed lyric line. Empty text marks an instrumental gap. */
export interface LyricLine {
  time: number;
  text: string;
}
const STAMP = /\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/g;
/** Parses LRC text: several time stamps per line, an [offset:ms] tag, and word-level
 * <mm:ss.xx> marks (removed). Metadata tags such as [ar:…] are ignored. */
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
    const words = raw
      .replace(STAMP, '')
      .replace(/<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g, '')
      .trim();
    for (const [, minutes, seconds] of stamps)
      lines.push({
        time: Math.max(0, Number(minutes) * 60 + Number(seconds.replace(':', '.')) - offset),
        text: words,
      });
  }
  return lines.sort((a, b) => a.time - b.time);
}
/** Index of the line being sung at `position` seconds, or -1 before the first line. */
export function currentLine(lines: LyricLine[], position: number): number {
  let low = 0,
    high = lines.length - 1,
    found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (lines[mid].time <= position) {
      found = mid;
      low = mid + 1;
    } else high = mid - 1;
  }
  return found;
}
