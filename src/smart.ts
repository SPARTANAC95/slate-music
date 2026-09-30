import type { SmartField, SmartOp, SmartRule, SmartRules, Track } from './types';
import { normalize, quality } from './library';

const DAY = 24 * 3600 * 1000;
export type FieldKind = 'text' | 'number' | 'bool' | 'date';
/** Every rule field: its label, kind and (for numbers) unit. */
export const FIELDS: Record<SmartField, { label: string; kind: FieldKind; unit?: string }> = {
  title: { label: 'Title', kind: 'text' },
  artist: { label: 'Artist', kind: 'text' },
  album: { label: 'Album', kind: 'text' },
  format: { label: 'Format', kind: 'text' },
  year: { label: 'Year', kind: 'number' },
  plays: { label: 'Plays', kind: 'number' },
  duration: { label: 'Length', kind: 'number', unit: 'minutes' },
  favorite: { label: 'Favorite', kind: 'bool' },
  lossless: { label: 'Lossless', kind: 'bool' },
  lastPlayed: { label: 'Last played', kind: 'date' },
  added: { label: 'Added', kind: 'date' },
};
export const OPS: Record<FieldKind, { op: SmartOp; label: string }[]> = {
  text: [
    { op: 'contains', label: 'contains' },
    { op: 'is', label: 'is' },
    { op: 'isNot', label: 'is not' },
  ],
  number: [
    { op: 'gt', label: 'is more than' },
    { op: 'lt', label: 'is less than' },
    { op: 'is', label: 'is' },
  ],
  bool: [
    { op: 'is', label: 'is yes' },
    { op: 'isNot', label: 'is no' },
  ],
  date: [
    { op: 'withinDays', label: 'in the last (days)' },
    { op: 'olderThanDays', label: 'not in the last (days)' },
  ],
};

function valueOf(t: Track, field: SmartField): string | number | boolean {
  switch (field) {
    case 'year':
      return t.originalYear || t.year;
    case 'plays':
      return t.playCount;
    case 'duration':
      return t.duration / 60;
    case 'lossless':
      return quality(t).lossless;
    default:
      return t[field];
  }
}
/** Whether one song passes one rule. Never-played songs count as not played recently. */
export function matches(t: Track, rule: SmartRule, now: number): boolean {
  const kind = FIELDS[rule.field]?.kind;
  const v = valueOf(t, rule.field);
  if (kind === 'text') {
    const a = normalize(String(v)),
      b = normalize(String(rule.value));
    return rule.op === 'contains' ? a.includes(b) : rule.op === 'is' ? a === b : a !== b;
  }
  if (kind === 'number') {
    const a = Number(v),
      b = Number(rule.value);
    return rule.op === 'gt' ? a > b : rule.op === 'lt' ? a < b : Math.round(a) === Math.round(b);
  }
  if (kind === 'bool') return rule.op === 'is' ? v === true : v !== true;
  if (kind === 'date') {
    const at = Number(v);
    const within = at > 0 && now - at <= Number(rule.value) * DAY;
    return rule.op === 'withinDays' ? within : !within;
  }
  return false;
}
/** A shuffle that stays the same for a playlist through the day, so lists don't jump around. */
function seeded(seed: string) {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}
/** The songs a smart playlist holds right now. */
export function evaluateSmart(rules: SmartRules, tracks: Track[], now: number, seed = ''): Track[] {
  const test = (t: Track) =>
    !rules.rules.length ||
    (rules.match === 'all'
      ? rules.rules.every((r) => matches(t, r, now))
      : rules.rules.some((r) => matches(t, r, now)));
  let list = tracks.filter((t) => !t.missing && test(t));
  const by: Record<Exclude<SmartRules['sort'], 'random'>, (a: Track, b: Track) => number> = {
    plays: (a, b) => b.playCount - a.playCount,
    recent: (a, b) => b.lastPlayed - a.lastPlayed,
    added: (a, b) => b.added - a.added,
    year: (a, b) => (a.originalYear || a.year) - (b.originalYear || b.year),
    title: (a, b) => a.title.localeCompare(b.title),
  };
  if (rules.sort === 'random') {
    const rand = seeded(`${seed}|${new Date(now).toDateString()}`);
    list = list.map((t) => [rand(), t] as const).sort((a, b) => a[0] - b[0]).map(([, t]) => t);
  } else list = [...list].sort(by[rules.sort]);
  return rules.limit > 0 ? list.slice(0, rules.limit) : list;
}
/** Ready-made smart playlists. */
export const SMART_PRESETS: { name: string; rules: SmartRules }[] = [
  {
    name: 'Forgotten favourites',
    rules: { match: 'all', rules: [{ field: 'favorite', op: 'is', value: true }, { field: 'lastPlayed', op: 'olderThanDays', value: 90 }], sort: 'random', limit: 0 },
  },
  { name: 'Most played', rules: { match: 'all', rules: [{ field: 'plays', op: 'gt', value: 0 }], sort: 'plays', limit: 50 } },
  { name: 'Recently added', rules: { match: 'all', rules: [{ field: 'added', op: 'withinDays', value: 30 }], sort: 'added', limit: 0 } },
  { name: 'Never played', rules: { match: 'all', rules: [{ field: 'plays', op: 'is', value: 0 }], sort: 'random', limit: 100 } },
  { name: 'Lossless only', rules: { match: 'all', rules: [{ field: 'lossless', op: 'is', value: true }], sort: 'random', limit: 0 } },
  {
    name: 'Songs from the 80s',
    rules: { match: 'all', rules: [{ field: 'year', op: 'gt', value: 1979 }, { field: 'year', op: 'lt', value: 1990 }], sort: 'year', limit: 0 },
  },
];
