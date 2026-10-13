import { SNAPSHOT_HZ, type Team } from "@shared/constants";
import type { RodState, Snapshot, Vec3 } from "@shared/types";

/**
 * Buffers authoritative snapshots and interpolates between them.
 *
 * Snapshots arrive at 20 Hz but we render at 60+, so the ball and the
 * opponent's rods are drawn slightly in the past — between two known states.
 * That costs a little latency and buys perfectly smooth motion, and it
 * sidesteps predicted-ball drift entirely.
 */
const INTERP_DELAY_MS = (1000 / SNAPSHOT_HZ) * 1.5;

export interface RenderState {
  rods: RodState[];
  ball: Vec3;
  score: Record<Team, number>;
}

function cloneRod(rod: RodState): RodState {
  return { angle: rod.angle, offset: rod.offset };
}

function toRender(snap: Snapshot): RenderState {
  return {
    rods: snap.rods.map(cloneRod),
    ball: { ...snap.ball.pos },
    score: { ...snap.score },
  };
}

/** Interpolate the short way round, so a rod never spins the long way. */
function lerpAngle(a: number, b: number, t: number): number {
  let delta = b - a;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  return a + delta * t;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function blend(a: Snapshot, b: Snapshot, t: number): RenderState {
  return {
    rods: a.rods.map((rod, i) => ({
      angle: lerpAngle(rod.angle, b.rods[i].angle, t),
      offset: lerp(rod.offset, b.rods[i].offset, t),
    })),
    ball: {
      x: lerp(a.ball.pos.x, b.ball.pos.x, t),
      y: lerp(a.ball.pos.y, b.ball.pos.y, t),
      z: lerp(a.ball.pos.z, b.ball.pos.z, t),
    },
    score: { ...b.score },
  };
}

export class SnapshotBuffer {
  private samples: { at: number; snap: Snapshot }[] = [];
  private latest: Snapshot | null = null;

  /** Record a snapshot that just arrived. */
  push(snapshot: Snapshot, now = performance.now()): void {
    this.samples.push({ at: now, snap: snapshot });
    this.latest = snapshot;

    // Keep roughly a second of history; that is plenty to interpolate in.
    const cutoff = now - 1000;
    while (this.samples.length > 2 && this.samples[0].at < cutoff) this.samples.shift();
  }

  /** The most recent snapshot, for score and tick bookkeeping. */
  get last(): Snapshot | null {
    return this.latest;
  }

  /** Interpolated state for this frame, or null before the first snapshot. */
  sample(now = performance.now()): RenderState | null {
    if (!this.latest) return null;
    if (this.samples.length < 2) return toRender(this.latest);

    const target = now - INTERP_DELAY_MS;
    if (target <= this.samples[0].at) return toRender(this.latest);

    for (let i = this.samples.length - 2; i >= 0; i--) {
      const a = this.samples[i];
      const b = this.samples[i + 1];
      if (target >= a.at && target <= b.at) {
        const span = b.at - a.at;
        return blend(a.snap, b.snap, span <= 0 ? 0 : (target - a.at) / span);
      }
    }
    return toRender(this.latest);
  }

  reset(): void {
    this.samples = [];
    this.latest = null;
  }
}
