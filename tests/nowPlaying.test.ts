import { describe, it, expect } from 'vitest';
import { currentLine, parseLrc, showLyrics, wordProgress } from '../src/lrc';
import { isStale, PlaybackClock } from '../src/playbackClock';
import { deviceDelay, MOST, setDeviceDelay, setSongShift, songShift } from '../src/lyricTiming';
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

describe('lyrics laid out for display', () => {
  const shown = (source: string, duration = 0) => showLyrics(parseLrc(source), duration);
  /** The sung lines only, without the pauses between them. */
  const sung = (source: string, duration = 0) => shown(source, duration).filter((row) => !row.gap);
  it('spreads a line-timed line over its words, ending before the next line', () => {
    const [first, second] = sung('[00:10]Paper lanterns on the water\n[00:14]Home', 60);
    expect(first.estimated).toBe(true);
    expect(first.words.map((w) => w.text + w.space).join('')).toBe('Paper lanterns on the water');
    expect(first.words[0].time).toBe(10);
    first.words.forEach((word, i) => {
      expect(word.end).toBeGreaterThan(word.time);
      if (i) expect(word.time).toBeCloseTo(first.words[i - 1].end, 9);
    });
    expect(first.end).toBeGreaterThan(13);
    expect(first.end).toBeLessThan(14);
    // Longer words take longer than short ones.
    const length = (text: string) => {
      const word = first.words.find((w) => w.text === text)!;
      return word.end - word.time;
    };
    expect(length('lanterns')).toBeGreaterThan(length('on'));
    expect(second.time).toBe(14);
  });
  it('does not stretch a line across a long pause or past the end of the song', () => {
    const [line, last] = sung('[00:10]Coming home\n[00:40]\n[00:50]Stay', 52);
    expect(line.end).toBeLessThan(13);
    expect(last.end).toBeLessThanOrEqual(52);
    expect(sung('[00:10]No length known')[0].end).toBeLessThan(15);
  });
  it('keeps the source’s own word times and never marks them as estimated', () => {
    const [line] = sung('[00:05]<00:05>Drift<00:05.5>ing <00:06>out <00:07>beyond\n[00:20]Next', 60);
    expect(line.estimated).toBe(false);
    expect(line.words.map((w) => [w.text, w.space, w.time])).toEqual([
      ['Drift', '', 5], ['ing', ' ', 5.5], ['out', ' ', 6], ['beyond', '', 7],
    ]);
    expect(line.words.slice(0, 3).map((w) => w.end)).toEqual([5.5, 6, 7]);
    // The source left the last word open: it ends in good time, well before the next line.
    expect(line.words[3].end).toBeGreaterThan(7.3);
    expect(line.words[3].end).toBeLessThan(10);
    expect(line.end).toBe(line.words[3].end);
    // Spaces around a time stamp are kept once, between the words.
    expect(shown('[00:01] <00:01> One <00:02> two <00:03>')[0].words.map((w) => w.text + '|' + w.space))
      .toEqual(['One| ', 'two|']);
  });
  it('shows pauses in the singing, and a lead-in before a late first line', () => {
    const rows = shown('[00:12]First\n[00:20]\n[00:30]Second', 40);
    expect(rows.map((row) => [row.time, row.gap])).toEqual([[0, true], [12, false], [20, true], [30, false]]);
    expect(rows[0].end).toBe(12);
    expect(rows[2].end).toBe(30);
    expect(currentLine(rows, 5)).toBe(0);
    expect(shown('[00:02]Early start')[0].gap).toBe(false);
    expect(shown('[00:00]\n[00:12]After an opening the source marks itself').filter((row) => row.gap)).toHaveLength(1);
  });
  it('lights scripts written without spaces one character at a time', () => {
    const [line] = shown('[00:01]静かな海に 灯り\n[00:06]次', 10);
    expect(line.words.map((w) => w.text)).toEqual(['静', 'か', 'な', '海', 'に', '灯', 'り']);
    expect(line.words[4].space).toBe(' ');
    expect(shown('[00:01]Hello、世界！')[0].words.map((w) => w.text)).toEqual(['Hello、', '世', '界！']);
  });
});

describe('playback clock for drawing', () => {
  const pb = { currentId: 'a', position: 5, duration: 30, playing: true, clockRunning: true };
  it('stands still while paused or while the engine waits, and never counts paused time', () => {
    const clock = new PlaybackClock();
    clock.sync({ ...pb, playing: false }, 1000, 0);
    expect(clock.running).toBe(false);
    expect(clock.read(31000)).toBe(5);
    clock.sync({ ...pb, clockRunning: false }, 31000, 0);
    expect(clock.read(40000)).toBe(5);
    clock.sync(pb, 40000, 0);
    expect(clock.read(40000)).toBe(5);
    expect(clock.read(40125)).toBeCloseTo(5.125, 9);
    expect(clock.read(39000)).toBe(5);
  });
  it('runs smoothly through jittery snapshots instead of hopping to each one', () => {
    const clock = new PlaybackClock();
    clock.sync(pb, 1000, 0);
    let previous = clock.read(1000);
    // Snapshots every 240 ms whose positions are up to 30 ms early or late.
    for (let i = 1; i <= 40; i++) {
      const now = 1000 + i * 240;
      const before = clock.read(now);
      clock.sync({ ...pb, position: 5 + (i * 240) / 1000 + (i % 2 ? 0.03 : -0.03) }, now, i * 240);
      expect(clock.read(now)).toBeCloseTo(before, 9);
      expect(clock.read(now)).toBeGreaterThan(previous);
      previous = clock.read(now);
    }
    expect(Math.abs(clock.read(1000 + 40 * 240) - (5 + 9.6))).toBeLessThan(0.02);
  });
  it('closes a steady difference without a visible step', () => {
    const clock = new PlaybackClock();
    clock.sync(pb, 0, 0);
    for (let i = 1; i <= 30; i++) clock.sync({ ...pb, position: 5.1 + i * 0.24 }, i * 240, i * 240);
    expect(clock.read(30 * 240)).toBeCloseTo(5.1 + 7.2, 1);
  });
  it('jumps for a seek, another song, or the same song starting again', () => {
    const clock = new PlaybackClock();
    clock.sync(pb, 0, 0);
    clock.sync({ ...pb, position: 20 }, 100, 100);
    expect(clock.read(100)).toBe(20);
    clock.sync({ ...pb, currentId: 'b', position: 20.05 }, 150, 150);
    expect(clock.read(150)).toBe(20.05);
    clock.sync({ ...pb, currentId: 'b', position: 0 }, 400, 400);
    expect(clock.read(400)).toBe(0);
  });
  it('allows for the time a snapshot took to arrive, but not for a changed PC clock', () => {
    const clock = new PlaybackClock();
    clock.sync({ ...pb, at: 99_970 }, 0, 100_000);
    expect(clock.read(0)).toBeCloseTo(5.03, 9);
    const late = new PlaybackClock();
    late.sync({ ...pb, at: 40_000 }, 0, 100_000);
    expect(late.read(0)).toBe(5);
    const early = new PlaybackClock();
    early.sync({ ...pb, at: 100_500 }, 0, 100_000);
    expect(early.read(0)).toBe(5);
  });
  it('stops when sound stops coming out, when the engine goes quiet, and at the end', () => {
    const clock = new PlaybackClock();
    clock.sync({ ...pb, at: 1000 }, 0, 1000);
    // A command answered a moment later can report the same position: that is not a stall.
    clock.sync({ ...pb, at: 1010 }, 10, 1010);
    expect(clock.running).toBe(true);
    clock.sync({ ...pb, at: 1250 }, 250, 1250);
    expect(clock.running).toBe(false);
    expect(clock.read(5000)).toBe(5);
    const quiet = new PlaybackClock();
    quiet.sync(pb, 0, 0);
    expect(quiet.read(90_000)).toBe(6);
    quiet.sync({ ...pb, position: 29.95 }, 0, 0);
    expect(quiet.read(200)).toBe(30);
  });
  it('recognises a snapshot that arrived after a newer one', () => {
    expect(isStale({ at: 1000 }, { at: 990 })).toBe(true);
    expect(isStale({ at: 1000 }, { at: 1000 })).toBe(false);
    expect(isStale({ at: 1000 }, { at: 1240 })).toBe(false);
    expect(isStale(null, { at: 5 })).toBe(false);
    expect(isStale({ at: 1000 }, {})).toBe(false);
    // The PC's clock was set back: carry on rather than ignore every snapshot.
    expect(isStale({ at: 9_000_000 }, { at: 1000 })).toBe(false);
  });
});

describe('remembered lyric timing', () => {
  it('keeps an adjustment per song and per device, within limits', () => {
    expect(songShift('song')).toBe(0);
    setSongShift('song', 0.30000000000000004);
    expect(songShift('song')).toBe(0.3);
    setSongShift('song', 99);
    expect(songShift('song')).toBe(MOST);
    setSongShift('song', 0);
    expect(songShift('song')).toBe(0);
    expect(songShift(null)).toBe(0);
    setDeviceDelay('Headphones', 0.18);
    expect(deviceDelay('Headphones')).toBe(0.18);
    expect(deviceDelay('Speakers')).toBe(0);
    expect(deviceDelay(undefined)).toBe(0);
    setDeviceDelay('Headphones', 0);
  });
  it('forgets the songs adjusted longest ago', () => {
    for (let i = 0; i < 520; i++) setSongShift('s' + i, 0.1);
    expect(songShift('s0')).toBe(0);
    expect(songShift('s519')).toBe(0.1);
  });
});
