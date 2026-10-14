import { MAX_ROD_SLIDE, RODS, SIM_HZ, TABLE, TEAM_RODS, type Team } from "./constants";
import type { PlayerInput, RodState, Snapshot } from "./types";

/**
 * A computer opponent that plays by the same rules as a human: it only sees
 * where the ball *was* a moment ago, its rods have a top slide speed, and it
 * can only kick by physically winding a rod back and swinging it through.
 *
 * It is fully deterministic (seeded PRNG, no clocks), so it is safe to run
 * inside the shared simulation loop and easy to test.
 */
export type Difficulty = "rookie" | "pro" | "legend";

export const DIFFICULTIES: readonly Difficulty[] = ["rookie", "pro", "legend"];

interface Tuning {
  /** How stale the ball position it reacts to is (ms). */
  reactionMs: number;
  /** Rod slide speed, in normalised offset units per second (full travel = 2). */
  slideSpeed: number;
  /** Aim wobble, metres; re-rolled twice a second. */
  aimError: number;
  /** Chance of taking a kick when the ball is in reach. */
  kickChance: number;
  /** Minimum time between kicks on one rod (ms). */
  cooldownMs: number;
  windMs: number;
  strikeMs: number;
  recoverMs: number;
  /** Lead the goalie on shots using the ball's velocity. */
  predict: boolean;
}

const TUNING: Record<Difficulty, Tuning> = {
  rookie: {
    reactionMs: 300,
    slideSpeed: 1.5,
    aimError: 0.032,
    kickChance: 0.45,
    cooldownMs: 700,
    windMs: 190,
    strikeMs: 150,
    recoverMs: 200,
    predict: false,
  },
  pro: {
    reactionMs: 130,
    slideSpeed: 3.2,
    aimError: 0.014,
    kickChance: 0.8,
    cooldownMs: 420,
    windMs: 130,
    strikeMs: 85,
    recoverMs: 140,
    predict: true,
  },
  legend: {
    reactionMs: 45,
    slideSpeed: 6.5,
    aimError: 0.004,
    kickChance: 1,
    cooldownMs: 260,
    windMs: 90,
    strikeMs: 55,
    recoverMs: 100,
    predict: true,
  },
};

const WIND_ANGLE = 1.0;
const STRIKE_ANGLE = 1.3;

/** Ball is in kicking range when this far ahead of the rod (metres). */
const REACH_MIN = -0.012;
const REACH_MAX = 0.05;
/** How far outside the ball a man stands to angle a shot toward the goal (m). */
const AIM_OFFSET = 0.024;
/** …and within this of a man across the table. */
const REACH_Z = 0.03;

type KickPhase = "idle" | "wind" | "strike" | "recover";

interface RodBrain {
  index: number;
  offset: number;
  angle: number;
  man: number;
  kick: KickPhase;
  kickMs: number;
  cooldownMs: number;
  angleFrom: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Small, fast, seedable PRNG. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fold a ball path back into the table, as if bouncing off the side rails. */
function reflectZ(z: number): number {
  const half = TABLE.width / 2 - TABLE.ballRadius;
  const span = half * 4;
  let m = (((z + half) % span) + span) % span;
  if (m > half * 2) m = span - m;
  return m - half;
}

export class Bot {
  private readonly tuning: Tuning;
  private readonly rng: () => number;
  private readonly brains: RodBrain[];
  private readonly history: { x: number; z: number }[] = [];
  private readonly attack: 1 | -1;
  private wobble = 0;
  private wobbleMs = 0;
  private seq = 0;

  constructor(
    readonly team: Team,
    readonly difficulty: Difficulty,
    seed = 1337,
  ) {
    this.tuning = TUNING[difficulty];
    this.rng = mulberry32(seed);
    this.attack = team === "left" ? 1 : -1;
    this.brains = TEAM_RODS[team].map((index) => ({
      index,
      offset: 0,
      angle: 0,
      man: Math.floor((RODS[index].men - 1) / 2),
      kick: "idle",
      kickMs: 0,
      cooldownMs: 0,
      angleFrom: 0,
    }));
  }

  /** Decide this tick's rod targets. Call once per simulation tick. */
  think(state: Snapshot, dtMs: number): PlayerInput {
    const t = this.tuning;
    const dt = dtMs / 1000;

    this.history.push({ x: state.ball.pos.x, z: state.ball.pos.z });
    const keep = Math.ceil((t.reactionMs / 1000) * SIM_HZ) + 6;
    if (this.history.length > keep) this.history.shift();

    const lag = Math.min(this.history.length - 1, Math.round((t.reactionMs / 1000) * SIM_HZ));
    const seen = this.history[this.history.length - 1 - lag];
    const earlier = this.history[Math.max(0, this.history.length - 1 - lag - 4)];
    const vx = (seen.x - earlier.x) / (4 * dt);
    const vz = (seen.z - earlier.z) / (4 * dt);

    this.wobbleMs -= dtMs;
    if (this.wobbleMs <= 0) {
      this.wobbleMs = 500;
      this.wobble = (this.rng() * 2 - 1) * t.aimError;
    }

    const rods: Record<number, RodState> = {};
    for (const brain of this.brains) {
      this.updateRod(brain, seen, vx, vz, dtMs);
      rods[brain.index] = { angle: brain.angle, offset: brain.offset };
    }

    this.seq += 1;
    return { seq: this.seq, tick: state.tick + 1, rods };
  }

  private updateRod(
    brain: RodBrain,
    ball: { x: number; z: number },
    vx: number,
    vz: number,
    dtMs: number,
  ): void {
    const t = this.tuning;
    const dt = dtMs / 1000;
    const spec = RODS[brain.index];
    const spacing = (TABLE.width * 0.86) / spec.men;
    const baseZ = (i: number): number => (i - (spec.men - 1) / 2) * spacing;

    // ── Where should a man stand? ──────────────────────────────────────
    let target = ball.z;
    const incoming = vx * this.attack < -0.3; // heading for our goal
    if (t.predict) {
      if (spec.role === "goalie" && incoming) {
        const secs = (spec.x - ball.x) / vx;
        if (secs > 0 && secs < 1.5) target = reflectZ(ball.z + vz * secs);
      } else {
        target = ball.z + vz * 0.06;
      }
    }
    // Line up so the contact normal sends the ball toward the middle of the
    // goal: stand a little to the outside of the ball when it is off-centre.
    const rodAhead = (ball.x - spec.x) * this.attack;
    if (rodAhead > REACH_MIN && rodAhead < REACH_MAX * 2) {
      target += clamp(ball.z / 0.3, -1, 1) * AIM_OFFSET;
    }
    target += this.wobble;
    if (spec.role === "goalie") target = clamp(target, -MAX_ROD_SLIDE, MAX_ROD_SLIDE);

    // Pick the man with the least distance to travel, but don't flip-flop.
    const reach = (i: number): number => Math.abs(target - baseZ(i));
    let best = brain.man;
    for (let i = 0; i < spec.men; i++) {
      if (reach(i) < reach(best) * 0.6 || (reach(brain.man) > MAX_ROD_SLIDE && reach(i) < reach(best))) {
        best = i;
      }
    }
    brain.man = best;

    const desired = clamp((target - baseZ(brain.man)) / MAX_ROD_SLIDE, -1, 1);
    const maxMove = t.slideSpeed * dt;
    brain.offset += clamp(desired - brain.offset, -maxMove, maxMove);

    // ── Kicking: wind back, swing through, recover ─────────────────────
    brain.cooldownMs = Math.max(0, brain.cooldownMs - dtMs);
    const ahead = (ball.x - spec.x) * this.attack;
    const manZ = baseZ(brain.man) + brain.offset * MAX_ROD_SLIDE;
    const inReach = ahead > REACH_MIN && ahead < REACH_MAX && Math.abs(ball.z - manZ) < REACH_Z;

    if (brain.kick === "idle") {
      brain.angle += clamp(-brain.angle, -8 * dt, 8 * dt);
      if (inReach && brain.cooldownMs <= 0) {
        if (this.rng() < t.kickChance) {
          brain.kick = "wind";
          brain.kickMs = 0;
          brain.angleFrom = brain.angle;
        } else {
          brain.cooldownMs = t.cooldownMs;
        }
      }
      return;
    }

    brain.kickMs += dtMs;
    const sweep = (from: number, to: number, ms: number, next: KickPhase): void => {
      const k = clamp(brain.kickMs / ms, 0, 1);
      brain.angle = from + (to - from) * k;
      if (k >= 1) {
        brain.kick = next;
        brain.kickMs = 0;
        brain.angleFrom = brain.angle;
      }
    };

    switch (brain.kick) {
      case "wind":
        sweep(brain.angleFrom, -this.attack * WIND_ANGLE, t.windMs, "strike");
        break;
      case "strike":
        sweep(brain.angleFrom, this.attack * STRIKE_ANGLE, t.strikeMs, "recover");
        break;
      case "recover":
        sweep(brain.angleFrom, 0, t.recoverMs, "idle");
        if ((brain.kick as KickPhase) === "idle") brain.cooldownMs = t.cooldownMs;
        break;
    }
  }
}
