import { describe, it, expect } from 'vitest';
import { currentLine, parseLrc, wordProgress } from '../src/lrc';
import { playbackPosition } from '../src/playbackClock';
import type { Playback } from '../src/types';
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

describe('source word timing', () => {
  it('keeps source boundaries, punctuation, Unicode and un-timed endings', () => {
    const [line] = parseLrc('[00:05]<00:05>One, <00:06.25>étoile <00:08>光');
    expect(line.text).toBe('One, étoile 光');
    expect(line.words).toEqual([
      { time: 5, end: 6.25, text: 'One, ' },
      { time: 6.25, end: 8, text: 'étoile ' },
      { time: 8, text: '光' },
    ]);
    expect(wordProgress(line.words![0], 4.99)).toBe(0);
    expect(wordProgress(line.words![0], 5.625)).toBe(0.5);
    expect(wordProgress(line.words![2], 7.999)).toBe(0);
    expect(wordProgress(line.words![2], 8)).toBe(1);
  });
  it('uses explicit terminal marks, line-start prefixes and zero-length boundaries', () => {
    const [line] = parseLrc('[00:01]First <00:02>second<00:02>!');
    expect(line.words).toEqual([
      { time: 1, end: 2, text: 'First ' }, { time: 2, end: 2, text: 'second' }, { time: 2, text: '!' },
    ]);
    expect(wordProgress(line.words![1], 2)).toBe(1);
    expect(parseLrc('[00:01]<00:01>Hold<00:04>')[0].words).toEqual([{ time: 1, end: 4, text: 'Hold' }]);
  });
  it('applies trailing positive/negative offsets to every word boundary', () => {
    const source = '[00:01]<00:01>First <00:02>second<00:03>';
    expect(parseLrc(source + '\n[offset:1500]')[0].words).toEqual([
      { time: 0, end: 0.5, text: 'First ' }, { time: 0.5, end: 1.5, text: 'second' },
    ]);
    expect(parseLrc(source + '\n[offset:-500]')[0].words?.[0].time).toBe(1.5);
  });
  it('falls back for ambiguous repetitions, invalid seconds and backward word marks', () => {
    for (const source of [
      '[00:01][00:10]<00:01>Repeated <00:02>line',
      '[00:05]<00:04>Too early', '[00:01]<00:03>First <00:02>second',
      '[00:01]<00:70>Invalid',
    ]) expect(parseLrc(source).every((line) => !line.words)).toBe(true);
    expect(parseLrc('[00:01]Plain line')[0]).toEqual({ time: 1, text: 'Plain line' });
  });
});

describe('playback-to-lyrics clock', () => {
  const pb = { position: 5, duration: 30, playing: true, clockRunning: true } as Playback;
  it('does not anticipate timestamps or accumulate elapsed paused time', () => {
    expect(playbackPosition(pb, 0)).toBe(5);
    expect(playbackPosition(pb, 125)).toBe(5.125);
    expect(playbackPosition({ ...pb, playing: false }, 30000)).toBe(5);
    expect(playbackPosition({ ...pb, position: 2, playing: false }, 30000)).toBe(2);
  });
  it('bounds stalled snapshots, stops at EOF and freezes during deck/rate waits', () => {
    expect(playbackPosition(pb, 90000)).toBe(5.3);
    expect(playbackPosition({ ...pb, clockRunning: false }, 90000)).toBe(5);
    expect(playbackPosition({ ...pb, position: 29.95 }, 200)).toBe(30);
    expect(playbackPosition(pb, -100)).toBe(5);
  });
});
