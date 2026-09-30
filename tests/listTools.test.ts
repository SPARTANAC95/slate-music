import { describe, it, expect } from 'vitest';
import {
  columnSort,
  moveRows,
  nextSelection,
  noSelection,
  pickedRows,
  sortTracks,
} from '../src/listTools';
import type { Track } from '../src/types';

const track = (id: string, p: Partial<Track> = {}): Track => ({
  id,
  path: `${id}.flac`,
  folder: '',
  title: id,
  artist: 'A',
  album: 'X',
  albumArtist: 'A',
  duration: 200,
  track: 1,
  disc: 1,
  year: 2000,
  originalYear: 0,
  format: 'FLAC',
  sampleRate: 44100,
  bitDepth: 16,
  artwork: null,
  favorite: false,
  missing: false,
  playCount: 0,
  lastPlayed: 0,
  added: 0,
  size: 1,
  ...p,
});
const list = [
  track('b', { duration: 100, year: 1990, track: 2 }),
  track('a', { duration: 300, year: 1985, originalYear: 1981, track: 3 }),
  track('c', { duration: 200, year: 2001, track: 1 }),
];
const ids = (l: Track[]) => l.map((t) => t.id);

describe('sorting song lists', () => {
  it('sorts by each column and reverses', () => {
    expect(ids(sortTracks(list, { mode: 'title', reverse: false }))).toEqual(['a', 'b', 'c']);
    expect(ids(sortTracks(list, { mode: 'title', reverse: true }))).toEqual(['c', 'b', 'a']);
    expect(ids(sortTracks(list, { mode: 'year', reverse: false }))).toEqual(['a', 'b', 'c']);
    expect(ids(sortTracks(list, { mode: 'duration', reverse: false }))).toEqual(['a', 'c', 'b']);
    expect(ids(sortTracks(list, { mode: 'album', reverse: false }))).toEqual(['c', 'b', 'a']);
    expect(sortTracks(list, { mode: 'custom', reverse: false })).toBe(list);
  });
  it('keeps the original order for ties', () => {
    const same = [track('x'), track('y'), track('z')].map((t) => ({ ...t, title: 'Same' }));
    expect(ids(sortTracks(same, { mode: 'title', reverse: false }))).toEqual(['x', 'y', 'z']);
    expect(ids(sortTracks(same, { mode: 'title', reverse: true }))).toEqual(['x', 'y', 'z']);
  });
  it('column clicks cycle through ascending, descending and the list’s own order', () => {
    const custom = { mode: 'custom' as const, reverse: false };
    const first = columnSort(custom, 'title', true);
    expect(first).toEqual({ mode: 'title', reverse: false });
    const second = columnSort(first, 'title', true);
    expect(second).toEqual({ mode: 'title', reverse: true });
    expect(columnSort(second, 'title', true)).toEqual(custom);
    expect(columnSort(second, 'title', false)).toEqual({ mode: 'title', reverse: false });
    expect(columnSort(second, 'year', true)).toEqual({ mode: 'year', reverse: false });
  });
});

describe('picking several songs', () => {
  const keys = ['a', 'b', 'c', 'd', 'e'];
  it('click picks one, Ctrl+click adds and removes, Shift+click picks a range', () => {
    let sel = nextSelection(noSelection, keys, 1, {});
    expect([...sel.keys]).toEqual(['b']);
    sel = nextSelection(sel, keys, 3, { ctrl: true });
    expect(pickedRows(sel, keys)).toEqual([1, 3]);
    sel = nextSelection(sel, keys, 1, { ctrl: true });
    expect(pickedRows(sel, keys)).toEqual([3]);
    // The range starts at the last clicked row, as in File Explorer.
    sel = nextSelection(sel, keys, 0, { shift: true });
    expect(pickedRows(sel, keys)).toEqual([0, 1]);
    sel = nextSelection(nextSelection(noSelection, keys, 3, {}), keys, 0, { shift: true });
    expect(pickedRows(sel, keys)).toEqual([0, 1, 2, 3]);
    sel = nextSelection(nextSelection(noSelection, keys, 0, {}), keys, 1, { ctrl: true });
    sel = nextSelection({ ...sel, anchor: 3 }, keys, 4, { shift: true, ctrl: true });
    expect(pickedRows(sel, keys)).toEqual([0, 1, 3, 4]);
  });
});

describe('moving rows', () => {
  it('moves one or several rows before a position, like the queue engine', () => {
    const l = ['a', 'b', 'c', 'd', 'e'];
    expect(moveRows(l, [1, 3], 0)).toEqual(['b', 'd', 'a', 'c', 'e']);
    expect(moveRows(l, [0, 1], 4)).toEqual(['c', 'd', 'a', 'b', 'e']);
    expect(moveRows(l, [0, 1], 5)).toEqual(['c', 'd', 'e', 'a', 'b']);
    expect(moveRows(l, [4], 0)).toEqual(['e', 'a', 'b', 'c', 'd']);
    expect(moveRows(l, [2], 2)).toEqual(l);
  });
});
