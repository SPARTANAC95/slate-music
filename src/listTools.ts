import type { Track } from './types';

/** How a song list is ordered. 'custom' keeps the list's own order: an album's track order,
 * a playlist's order, the queue, or the best search matches first. */
export type SortMode =
  'custom' | 'title' | 'artist' | 'album' | 'year' | 'added' | 'duration' | 'plays' | 'recent';
export interface ListSort {
  mode: SortMode;
  /** Flips the mode's natural direction (A→Z, oldest year, longest, most played, newest). */
  reverse: boolean;
}
export const SORT_LABELS: Record<SortMode, string> = {
  custom: 'Custom order',
  title: 'Title',
  artist: 'Artist',
  album: 'Album order',
  year: 'Year released',
  added: 'Recently added',
  duration: 'Duration',
  plays: 'Most played',
  recent: 'Last played',
};

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
const inAlbum = (a: Track, b: Track) => a.disc - b.disc || a.track - b.track;
const compare: Record<Exclude<SortMode, 'custom'>, (a: Track, b: Track) => number> = {
  title: (a, b) => collator.compare(a.title, b.title),
  artist: (a, b) =>
    collator.compare(a.artist, b.artist) || collator.compare(a.album, b.album) || inAlbum(a, b),
  album: (a, b) => collator.compare(a.album, b.album) || inAlbum(a, b),
  year: (a, b) =>
    (a.originalYear || a.year || 9999) - (b.originalYear || b.year || 9999) ||
    collator.compare(a.artist, b.artist) ||
    inAlbum(a, b),
  added: (a, b) => b.added - a.added,
  duration: (a, b) => b.duration - a.duration,
  plays: (a, b) => b.playCount - a.playCount,
  recent: (a, b) => b.lastPlayed - a.lastPlayed,
};
/** The positions of the list's songs in the chosen order. Ties keep their original order. */
export function sortOrder(list: Track[], sort: ListSort): number[] {
  const order = list.map((_, i) => i);
  if (sort.mode === 'custom') return sort.reverse ? order.reverse() : order;
  const by = compare[sort.mode];
  const sign = sort.reverse ? -1 : 1;
  return order.sort((i, j) => sign * by(list[i], list[j]) || i - j);
}
/** The list in the chosen order. */
export const sortTracks = (list: Track[], sort: ListSort): Track[] =>
  sort.mode === 'custom' && !sort.reverse ? list : sortOrder(list, sort).map((i) => list[i]);
/** A click on a column heading: sort by it, then reverse, then (where the list has an order of
 * its own) go back to that order. */
export function columnSort(current: ListSort, column: SortMode, hasCustom: boolean): ListSort {
  if (current.mode !== column) return { mode: column, reverse: false };
  if (!current.reverse && column !== 'custom') return { mode: column, reverse: true };
  return hasCustom ? { mode: 'custom', reverse: false } : { mode: column, reverse: false };
}

export interface Selection {
  keys: Set<string>;
  /** The row a Shift+click range starts from. */
  anchor: number | null;
}
export const noSelection: Selection = { keys: new Set(), anchor: null };
/** Click to pick one row, Ctrl+click to add or drop a row, Shift+click to pick a range. */
export function nextSelection(
  prev: Selection,
  rowKeys: string[],
  index: number,
  mods: { ctrl?: boolean; shift?: boolean },
): Selection {
  const key = rowKeys[index];
  if (key === undefined) return prev;
  if (mods.shift && prev.anchor !== null && prev.anchor < rowKeys.length) {
    const [from, to] = prev.anchor < index ? [prev.anchor, index] : [index, prev.anchor];
    const keys = new Set(mods.ctrl ? prev.keys : []);
    for (let i = from; i <= to; i++) keys.add(rowKeys[i]);
    return { keys, anchor: prev.anchor };
  }
  if (mods.ctrl) {
    const keys = new Set(prev.keys);
    if (keys.has(key)) keys.delete(key);
    else keys.add(key);
    return { keys, anchor: index };
  }
  return { keys: new Set([key]), anchor: index };
}
/** The positions of the picked rows, in list order. */
export const pickedRows = (sel: Selection, rowKeys: string[]) =>
  rowKeys.flatMap((k, i) => (sel.keys.has(k) ? [i] : []));

/** The list after moving `rows` (kept in their order) to sit before position `to` of the
 * original list; `to === list.length` moves them to the end. Matches the engine's move_rows. */
export function moveRows<T>(list: T[], rows: number[], to: number): T[] {
  const moving = new Set(rows);
  const picked = list.filter((_, i) => moving.has(i));
  const rest = list.map((x, i) => [x, i] as const).filter(([, i]) => !moving.has(i));
  const at = rest.findIndex(([, i]) => i >= to);
  const out = rest.map(([x]) => x);
  out.splice(at < 0 ? out.length : at, 0, ...picked);
  return out;
}
