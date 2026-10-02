import { moveRows, type Selection } from './listTools';

export const sameQueueItems = (a: string[], b: string[]) =>
  a.length === b.length && a.every((id, i) => id === b[i]);

/** Queue positions include songs absent from the library, even when no search is active. */
export function queueMoveResult(queue: string[], rows: number[], to: number) {
  const moving = new Set(rows);
  const order = moveRows(queue.map((_, i) => i), rows, to);
  return {
    queue: order.map((i) => queue[i]),
    selection: {
      keys: new Set(order.flatMap((old, at) => moving.has(old) ? [String(at)] : [])),
      anchor: null,
    } satisfies Selection,
  };
}
