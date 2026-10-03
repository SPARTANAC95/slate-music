import type { Playback } from './types';

/** Interpolate between ~240 ms engine snapshots, without a lyric-specific lead.
 * Bound extrapolation when output or IPC stalls, and freeze during engine buffering. */
export function playbackPosition(pb: Playback, elapsedMs: number): number {
  const advance = pb.playing && pb.clockRunning !== false
    ? Math.max(0, Math.min(elapsedMs, 300)) / 1000
    : 0;
  const position = Math.max(0, pb.position + advance);
  return pb.duration > 0 ? Math.min(pb.duration, position) : position;
}
