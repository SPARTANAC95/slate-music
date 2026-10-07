import { beforeEach, expect, it } from 'vitest';
import { forgetRemoved, KEEP_DAYS, rememberRemoved, removedFavorites } from '../src/removedFavorites';

const DAY = 24 * 3600 * 1000;
const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  globalThis.localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
  } as Storage;
});
it('remembers removed hearts for 30 days, until they are back or dismissed', () => {
  const now = 1_000 * DAY;
  rememberRemoved(['a', 'b'], now);
  rememberRemoved(['c'], now + DAY);
  expect(removedFavorites(now + DAY)).toEqual(['a', 'b', 'c']);
  // Hearted again: no longer something to restore. Removed again: counted once, as the newest.
  forgetRemoved(['b'], now + DAY);
  rememberRemoved(['a'], now + 2 * DAY);
  expect(removedFavorites(now + 2 * DAY)).toEqual(['c', 'a']);
  expect(removedFavorites(now + (KEEP_DAYS + 1.5) * DAY)).toEqual(['a']);
  expect(removedFavorites(now + (KEEP_DAYS + 3) * DAY)).toEqual([]);
});
it('ignores damaged storage', () => {
  store.set('slate-music.removedFavorites', '{"not": "a list"');
  expect(removedFavorites()).toEqual([]);
  store.set('slate-music.removedFavorites', JSON.stringify([{ id: 5 }, null, { id: 'ok', at: Date.now() }]));
  expect(removedFavorites()).toEqual(['ok']);
});
