import { describe, it, expect } from 'vitest';
import { index, search } from '../src/search';

const titles = ['Black Hole Sun', 'Spoonman', 'Fell on Black Days', 'Wired For Sound', 'Hotel California', 'Blackbird'];
const entries = index(titles, (t) => t);

describe('search', () => {
  it('ranks whole-phrase starts and exact words first', () => {
    expect(search('black', entries)).toEqual(['Black Hole Sun', 'Fell on Black Days', 'Blackbird']);
    expect(search('black hole', entries)[0]).toBe('Black Hole Sun');
  });
  it('matches word prefixes and parts of words', () => {
    expect(search('spoon', entries)).toEqual(['Spoonman']);
    expect(search('bird', entries)).toEqual(['Blackbird']);
  });
  it('forgives a small typo in longer words', () => {
    expect(search('califronia', entries)).toEqual(['Hotel California']);
    expect(search('sonud', entries)).toEqual(['Wired For Sound']);
    expect(search('xyzzy', entries)).toEqual([]);
  });
  it('needs every word to match, ignores case and accents, and limits results', () => {
    expect(search('BLACK days', entries)).toEqual(['Fell on Black Days']);
    expect(search('black moon', entries)).toEqual([]);
    expect(search('', entries)).toEqual([]);
    expect(search('b', entries, 1)).toHaveLength(1);
    expect(search('deja', index(['Déjà Vu'], (t) => t))).toEqual(['Déjà Vu']);
  });
});
