import { describe, it, expect } from 'vitest';
import { evaluateSmart, filled, matches, ruleCounts, ruleText, SMART_PRESETS, whyEmpty } from '../src/smart';
import type { SmartRules, Track } from '../src/types';

const DAY = 24 * 3600 * 1000;
const now = new Date(2026, 8, 30).getTime();
const track = (id: string, p: Partial<Track> = {}): Track => ({
  id,
  path: `${id}.flac`,
  folder: '',
  title: id,
  artist: 'Cliff Richard',
  album: 'Collection',
  albumArtist: 'Cliff Richard',
  duration: 200,
  track: 1,
  disc: 1,
  year: 1994,
  originalYear: 0,
  format: 'FLAC',
  sampleRate: 44100,
  bitDepth: 16,
  artwork: null,
  favorite: false,
  missing: false,
  playCount: 0,
  lastPlayed: 0,
  added: now - 100 * DAY,
  size: 1,
  ...p,
});
const lib = [
  track('wired', { originalYear: 1981, favorite: true, lastPlayed: now - 200 * DAY, playCount: 4 }),
  track('living', { originalYear: 1959, favorite: true, lastPlayed: now - 2 * DAY, playCount: 9 }),
  track('mp3', { format: 'MP3', artist: 'Someone Else', added: now - DAY, duration: 150 }),
  track('gone', { missing: true, favorite: true }),
];
const rules = (r: Partial<SmartRules>): SmartRules => ({ match: 'all', rules: [], sort: 'title', limit: 0, ...r });

describe('smart playlists', () => {
  it('matches text, numbers, yes/no and dates', () => {
    expect(matches(lib[0], { field: 'artist', op: 'contains', value: 'cliff' }, now)).toBe(true);
    expect(matches(lib[2], { field: 'artist', op: 'isNot', value: 'Cliff Richard' }, now)).toBe(true);
    expect(matches(lib[0], { field: 'year', op: 'lt', value: 1990 }, now)).toBe(true);
    expect(matches(lib[2], { field: 'duration', op: 'lt', value: 3 }, now)).toBe(true);
    expect(matches(lib[2], { field: 'lossless', op: 'isNot', value: true }, now)).toBe(true);
    expect(matches(lib[1], { field: 'lastPlayed', op: 'withinDays', value: 7 }, now)).toBe(true);
    expect(matches(lib[2], { field: 'lastPlayed', op: 'olderThanDays', value: 7 }, now)).toBe(true);
  });
  it('combines rules with all or any, sorts, limits and skips unavailable songs', () => {
    const favs = evaluateSmart(rules({ rules: [{ field: 'favorite', op: 'is', value: true }], sort: 'plays' }), lib, now);
    expect(favs.map((t) => t.id)).toEqual(['living', 'wired']);
    const either = evaluateSmart(
      rules({ match: 'any', rules: [{ field: 'format', op: 'is', value: 'mp3' }, { field: 'plays', op: 'gt', value: 5 }] }),
      lib,
      now,
    );
    expect(either.map((t) => t.id)).toEqual(['living', 'mp3']);
    expect(evaluateSmart(rules({ limit: 1 }), lib, now)).toHaveLength(1);
  });
  it('keeps a random order steady through the day', () => {
    const r = rules({ sort: 'random' });
    const a = evaluateSmart(r, lib, now, 'p1').map((t) => t.id);
    expect(evaluateSmart(r, lib, now + 3600e3, 'p1').map((t) => t.id)).toEqual(a);
    expect(a.sort()).toEqual(['living', 'mp3', 'wired']);
  });
  it('leaves out a rule that is still being typed', () => {
    const artist = { field: 'artist', op: 'contains', value: '' } as const;
    const plays = { field: 'plays', op: 'gt', value: '' } as const;
    expect([filled(artist), filled(plays), filled({ field: 'favorite', op: 'is', value: true })]).toEqual([false, false, true]);
    const mp3 = { field: 'format', op: 'is', value: 'mp3' } as const;
    // With "any", an empty rule used to let every song in; with "all", an empty number kept every song out.
    expect(evaluateSmart(rules({ match: 'any', rules: [mp3, artist] }), lib, now).map((t) => t.id)).toEqual(['mp3']);
    expect(evaluateSmart(rules({ rules: [mp3, plays] }), lib, now).map((t) => t.id)).toEqual(['mp3']);
    expect(evaluateSmart(rules({ rules: [artist] }), lib, now)).toHaveLength(3);
  });
  it('says why a smart playlist is empty', () => {
    const forgotten = SMART_PRESETS.find((p) => p.name === 'Forgotten favourites')!.rules;
    const nothingLoved = lib.map((t) => ({ ...t, favorite: false }));
    expect(ruleCounts(forgotten, nothingLoved, now)).toEqual([0, 2]);
    expect(forgotten.rules.map(ruleText)).toEqual(['Favorite is yes', 'Last played not in the last 90 days']);
    expect(whyEmpty(forgotten, nothingLoved, now)).toBe(
      'A song has to match every rule, and none does. Favorite is yes: no songs · Last played not in the last 90 days: 2 songs. ' +
        'You have no favorites yet: tap the heart beside a song to make it one.',
    );
    expect(whyEmpty(rules({ rules: [{ field: 'duration', op: 'gt', value: 30 }] }), lib, now)).toBe('Length is more than 30 minutes: no songs.');
    expect(whyEmpty(rules({ match: 'any', rules: [{ field: 'artist', op: 'is', value: 'Nobody' }, { field: 'year', op: 'lt', value: 1900 }] }), lib, now))
      .toBe('No song matches any of the rules. Artist is “Nobody”: no songs · Year is less than 1900: no songs.');
  });
  it('ships working presets', () => {
    const find = (name: string) => SMART_PRESETS.find((p) => p.name === name)!.rules;
    expect(evaluateSmart(find('Forgotten favourites'), lib, now).map((t) => t.id)).toEqual(['wired']);
    expect(evaluateSmart(find('Songs from the 80s'), lib, now).map((t) => t.id)).toEqual(['wired']);
    expect(evaluateSmart(find('Recently added'), lib, now).map((t) => t.id)).toEqual(['mp3']);
  });
});
