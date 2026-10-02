import { describe, expect, it } from 'vitest';
import { queueMoveResult, sameQueueItems } from '../src/listView';

describe('selection after a queue move', () => {
  it('uses actual queue positions when a song is absent from the library', () => {
    const moved = queueMoveResult(['unknown', 'a', 'b', 'c'], [1], 4);
    expect(moved.queue).toEqual(['unknown', 'b', 'c', 'a']);
    expect([...moved.selection.keys]).toEqual(['3']);
  });

  it('tracks occurrences independently when the same song appears more than once', () => {
    const moved = queueMoveResult(['a', 'b', 'a', 'c'], [2], 0);
    expect(moved.queue).toEqual(['a', 'a', 'b', 'c']);
    expect([...moved.selection.keys]).toEqual(['0']);
  });

  it('recognizes unchanged queue contents without losing occurrence selection', () => {
    const queue = ['a', 'a', 'b'];
    const moved = queueMoveResult(queue, [0], 2);
    expect(sameQueueItems(queue, moved.queue)).toBe(true);
    expect([...moved.selection.keys]).toEqual(['1']);
    expect(sameQueueItems(queue, ['a', 'b', 'a'])).toBe(false);
    expect(sameQueueItems(queue, ['a', 'a'])).toBe(false);
  });
});
