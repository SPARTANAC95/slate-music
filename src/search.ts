import { normalize } from './library';

/** True when two words differ by at most `max` edits (insert, delete, change, swap). */
function near(a: string, b: string, max: number): boolean {
  if (Math.abs(a.length - b.length) > max) return false;
  let prev2: number[] = [];
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        v = Math.min(v, prev2[j - 2] + 1);
      row.push(v);
      best = Math.min(best, v);
    }
    if (best > max) return false;
    prev2 = prev;
    prev = row;
  }
  return prev[b.length] <= max;
}

/** A searchable entry: its normalized text split into words. */
export interface Indexed<T> {
  item: T;
  text: string;
  words: string[];
}
export function index<T>(items: T[], text: (item: T) => string): Indexed<T>[] {
  return items.map((item) => {
    const t = normalize(text(item));
    return { item, text: t, words: t.split(' ') };
  });
}

/** How well `query` matches an entry; 0 means no match. Every query word must match some
 * word: exactly (best), as a prefix, inside a word, or with a small typo (worst). */
export function score(queryWords: string[], entry: { text: string; words: string[] }): number {
  let total = 0;
  for (const q of queryWords) {
    let best = 0;
    for (const w of entry.words) {
      const s =
        w === q
          ? 10
          : w.startsWith(q)
            ? 7
            : q.length >= 3 && w.includes(q)
              ? 4
              : q.length >= 4 &&
                  (near(q, w.slice(0, q.length), q.length >= 8 ? 2 : 1) ||
                    near(q, w.slice(0, q.length + 1), q.length >= 8 ? 2 : 1))
                ? 2
                : 0;
      if (s > best) best = s;
      if (best === 10) break;
    }
    if (!best) return 0;
    total += best;
  }
  // Titles that begin with the whole phrase rank first ("black hole" → "Black Hole Sun"),
  // but only at a word boundary, so "Blackbird" does not beat an exact "Black".
  const phrase = queryWords.join(' ');
  if (entry.text === phrase || entry.text.startsWith(phrase + ' ')) total += 5;
  return total;
}

/** The best `limit` matches, best first; ties keep their original order. */
export function search<T>(query: string, entries: Indexed<T>[], limit = 50): T[] {
  const words = normalize(query).split(' ').filter(Boolean);
  if (!words.length) return [];
  const hits: { item: T; s: number; i: number }[] = [];
  entries.forEach((e, i) => {
    const s = score(words, e);
    if (s) hits.push({ item: e.item, s, i });
  });
  return hits
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .slice(0, limit)
    .map((h) => h.item);
}
