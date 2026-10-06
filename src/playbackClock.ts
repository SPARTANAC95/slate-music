import type { Playback } from './types';

type Tick = Pick<Playback, 'currentId' | 'position' | 'duration' | 'playing' | 'clockRunning' | 'at'>;
/** A snapshot this far from where the clock expected it is a seek, not jitter. */
const JUMP = 0.18;
/** Jitter is absorbed by running this much faster or slower at most, never by stepping. */
const TRIM = 0.06;
/** With no word from the engine for this long the clock stops rather than guess on. */
const SILENCE_MS = 1000;
/** Snapshots this far apart that report the same position mean no sound is coming out. */
const STALL_MS = 150;
/** A snapshot can't have been on its way for longer than this; more means a changed PC clock. */
const TRAVEL_MS = 400;

/** A steady clock for the playing song, for anything drawn every frame.
 *
 * The engine reports its position about four times a second, in steps the size of the sound
 * card's buffer, and each report takes a few milliseconds to arrive. Restarting from every
 * report makes the clock hop back and forth by that jitter. This one keeps running smoothly
 * between reports and leans gently towards them, jumping only for a real seek. */
export class PlaybackClock {
  private position = 0;
  private from = 0;
  private rate = 0;
  private duration = 0;
  private id: string | null = null;
  private reported = NaN;
  private stamp = 0;

  /** Whether time is passing: playing, and sound is actually coming out. */
  get running() {
    return this.rate > 0;
  }
  /** Takes a new snapshot from the engine. `now` is `performance.now()`, `wall` is `Date.now()`. */
  sync(pb: Tick, now = performance.now(), wall = Date.now()) {
    const expected = this.read(now);
    const moving = pb.playing && pb.clockRunning !== false;
    const stamp = pb.at || wall;
    const same = pb.currentId === this.id;
    // The same position after a real pause between snapshots: the output has stopped taking
    // sound (a device on its way out, a stream being reopened), whatever the engine intends.
    const stalled = moving && this.running && same && pb.position === this.reported && stamp - this.stamp >= STALL_MS;
    this.duration = pb.duration;
    if (!moving || stalled) {
      this.position = pb.position;
      this.rate = 0;
    } else {
      // Where the song is now: the snapshot's position plus the time it took to get here.
      const travel = pb.at ? wall - pb.at : 0;
      const target = pb.position + (travel > 0 && travel < TRAVEL_MS ? travel / 1000 : 0);
      const error = target - expected;
      if (!this.running || !same || Math.abs(error) > JUMP) {
        this.position = target;
        this.rate = 1;
      } else {
        this.position = expected;
        this.rate = 1 + Math.max(-TRIM, Math.min(TRIM, error));
      }
    }
    this.from = now;
    this.id = pb.currentId;
    this.reported = pb.position;
    this.stamp = stamp;
  }
  /** The song's position in seconds at `now` (`performance.now()`). */
  read(now = performance.now()): number {
    const elapsed = Math.max(0, Math.min(now - this.from, SILENCE_MS)) / 1000;
    const position = Math.max(0, this.position + this.rate * elapsed);
    return this.duration > 0 ? Math.min(this.duration, position) : position;
  }
}

/** Of two snapshots, the one to show: `next`, unless it was taken just before `previous` and
 * arrived late (a command's answer can overtake the regular update sent a moment earlier). */
export function isStale(previous: Pick<Playback, 'at'> | null, next: Pick<Playback, 'at'>): boolean {
  if (!previous?.at || !next.at) return false;
  const behind = previous.at - next.at;
  return behind > 0 && behind < 2000;
}
