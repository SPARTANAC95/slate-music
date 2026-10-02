import { describe, it, expect } from 'vitest';
import { currentLine, parseLrc } from '../src/lrc';
import { pickAccent } from '../src/artColor';

describe('synced lyrics', () => {
  it('parses times, repeated lines, offsets and word marks in order', () => {
    const lines = parseLrc(
      '[ar:Aurora Lane]\n[offset:+500]\n[00:12.30][00:40.00]Chorus line\n[00:05.5]<00:05.50>First <00:06.00>words\n[01:02]\n[1:10.123]Late',
    );
    expect(lines.map((l) => [Math.round(l.time * 100) / 100, l.text])).toEqual([
      [5, 'First words'],
      [11.8, 'Chorus line'],
      [39.5, 'Chorus line'],
      [61.5, ''],
      [69.62, 'Late'],
    ]);
  });
  it('ignores plain text and finds the line being sung', () => {
    expect(parseLrc('Just words\n[Chorus]\nMore')).toEqual([]);
    const lines = parseLrc('[00:01]a\n[00:03]b\n[00:07]c');
    expect(currentLine(lines, 0.5)).toBe(-1);
    expect(currentLine(lines, 1)).toBe(0);
    expect(currentLine(lines, 6.9)).toBe(1);
    expect(currentLine(lines, 100)).toBe(2);
    expect(currentLine([], 5)).toBe(-1);
  });
  it('applies a file-wide offset even when its tag follows the lyrics', () => {
    const words = '[00:01]First\n[00:03]Second';
    expect(parseLrc(`${words}\n[offset:+1500]`)).toEqual([
      { time: 0, text: 'First' },
      { time: 1.5, text: 'Second' },
    ]);
    expect(parseLrc(`[offset:-500]\n${words}`)).toEqual(parseLrc(`${words}\n[offset:-500]`));
  });
});

describe('cover colours', () => {
  const fill = (rgb: [number, number, number], n = 64) =>
    Array.from({ length: n }, () => [...rgb, 255]).flat();
  it('picks the vivid colour and brightens it for a dark background', () => {
    const accent = pickAccent([...fill([30, 30, 30], 40), ...fill([40, 90, 200], 24)]);
    expect(accent).toMatch(/^hsl\((21\d|22\d) \d+% 70%\)$/);
  });
  it('gives no accent for black-and-white covers', () => {
    expect(pickAccent([...fill([0, 0, 0]), ...fill([255, 255, 255]), ...fill([128, 128, 128])])).toBeNull();
    expect(pickAccent([])).toBeNull();
  });
});
