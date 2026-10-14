import {
  BALL_FRICTION,
  COLLISION_SUBSTEP_RATIO,
  GOAL_HALF_WIDTH,
  MAN_RADIUS,
  MAN_RESTITUTION,
  MAN_SWING,
  MAX_BALL_SPEED,
  MAX_ROD_ANGLE,
  MAX_ROD_SLIDE,
  MAX_SUBSTEPS,
  RODS,
  STUCK_SPEED,
  STUCK_TICKS,
  TABLE,
  WALL_RESTITUTION,
  type Team,
} from "./constants";
import type { HitEvent, PlayerInput, RodState, Snapshot, Vec3 } from "./types";

/** Contacts slower than this (m/s) are just resting touches, not events. */
const HIT_MIN_SPEED = 0.35;

/** Cap on events recorded per tick, so a ball jammed in a corner can't spam. */
const MAX_HITS_PER_TICK = 4;

/**
 * Deterministic simulation of the ball and rods.
 *
 * The same code runs on the server (authoritative truth) and can run on the
 * client (prediction), so this module must stay free of wall-clock time,
 * randomness and I/O. Given the same state, inputs and dt it produces
 * bit-identical output on both sides.
 *
 * Model
 * -----
 * The ball is a circle of `TABLE.ballRadius` confined to the x–z plane and
 * rolling on the surface. Each man is a circle of `MAN_RADIUS` whose centre
 * hangs `MAN_SWING` below its rod, so rotating the rod by `a` sweeps the
 * foot `MAN_SWING * sin(a)` along x, and sliding the rod shifts it along z.
 *
 * Men move fast enough to pass through the ball in a single 60 Hz tick, so
 * each tick is subdivided: rods are interpolated between their old and new
 * states and the ball is advanced in small steps, which makes collisions
 * swept rather than sampled.
 */

/** A man's collision circle in the x–z plane. */
export interface Man {
  x: number;
  z: number;
}

export interface StepResult {
  /** The state after this tick. */
  next: Snapshot;
  /** Set when a goal was scored during this tick. */
  scored: Team | null;
  /** Where the ball crossed the line and how fast, when `scored` is set. */
  goal: { pos: Vec3; vel: Vec3 } | null;
  /** Notable ball contacts this tick, in order. */
  hits: HitEvent[];
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Men on a rod, at the given rod state. */
export function manPositions(rodIndex: number, rod: RodState): Man[] {
  const spec = RODS[rodIndex];
  if (!spec) return [];

  const angle = clamp(rod.angle, -MAX_ROD_ANGLE, MAX_ROD_ANGLE);
  const swing = MAN_SWING * Math.sin(angle);
  const shift = clamp(rod.offset, -1, 1) * MAX_ROD_SLIDE;

  // Spread the men across most of the width, leaving a margin at each rail.
  const spacing = (TABLE.width * 0.86) / spec.men;
  const men: Man[] = [];
  for (let i = 0; i < spec.men; i++) {
    const baseZ = (i - (spec.men - 1) / 2) * spacing;
    men.push({ x: spec.x + swing, z: baseZ + shift });
  }
  return men;
}

/** Apply each player's inputs to the current rod states and clamp the result. */
function applyInputs(prevRods: RodState[], inputs: PlayerInput[]): RodState[] {
  const rods: RodState[] = prevRods.map((r) => ({ angle: r.angle, offset: r.offset }));

  // Iterate by index (not Object.keys) so the result never depends on key order.
  for (let i = 0; i < rods.length; i++) {
    for (const input of inputs) {
      const wanted = input.rods[i];
      if (!wanted) continue;
      rods[i] = {
        angle: clamp(wanted.angle, -MAX_ROD_ANGLE, MAX_ROD_ANGLE),
        offset: clamp(wanted.offset, -1, 1),
      };
    }
  }
  return rods;
}

/**
 * How many substeps this tick needs, from the fastest thing that moves:
 * either the ball, or the furthest any man sweeps.
 */
function substepCount(
  prevRods: RodState[],
  rods: RodState[],
  ball: { pos: Vec3; vel: Vec3 },
  dt: number,
): number {
  let maxTravel = Math.hypot(ball.vel.x, ball.vel.z) * dt;

  for (let i = 0; i < RODS.length; i++) {
    const before = manPositions(i, prevRods[i]);
    const after = manPositions(i, rods[i]);
    for (let m = 0; m < before.length; m++) {
      const travel = Math.hypot(after[m].x - before[m].x, after[m].z - before[m].z);
      if (travel > maxTravel) maxTravel = travel;
    }
  }

  const perStep = MAN_RADIUS * COLLISION_SUBSTEP_RATIO;
  return clamp(Math.ceil(maxTravel / perStep), 1, MAX_SUBSTEPS);
}

/**
 * Resolve one ball/man contact, treating the man as infinitely heavy.
 *
 * Reflecting the *relative* velocity is what makes a moving man transfer its
 * momentum to the ball, so a spinning rod genuinely shoots.
 */
function collideManBall(
  ball: { pos: Vec3; vel: Vec3 },
  man: Man,
  manVelX: number,
  manVelZ: number,
  rod: number,
  hits: HitEvent[],
): void {
  const dx = ball.pos.x - man.x;
  const dz = ball.pos.z - man.z;
  const minDist = MAN_RADIUS + TABLE.ballRadius;
  const distSq = dx * dx + dz * dz;
  if (distSq >= minDist * minDist) return;

  // Coincident centres have no defined normal; nudge along +x instead.
  const dist = Math.sqrt(distSq);
  const nx = dist === 0 ? 1 : dx / dist;
  const nz = dist === 0 ? 0 : dz / dist;

  // Push the ball out of the man so it can't stay embedded.
  const overlap = minDist - dist;
  ball.pos.x += nx * overlap;
  ball.pos.z += nz * overlap;

  const relX = ball.vel.x - manVelX;
  const relZ = ball.vel.z - manVelZ;
  const normalSpeed = relX * nx + relZ * nz;
  if (normalSpeed > 0) return; // already separating

  const vin = Math.hypot(ball.vel.x, ball.vel.z);
  const vx = ball.vel.x;

  const impulse = -(1 + MAN_RESTITUTION) * normalSpeed;
  ball.vel.x += nx * impulse;
  ball.vel.z += nz * impulse;

  if (-normalSpeed > HIT_MIN_SPEED && hits.length < MAX_HITS_PER_TICK) {
    hits.push({
      k: "man",
      x: ball.pos.x,
      z: ball.pos.z,
      rod,
      vin,
      vout: Math.hypot(ball.vel.x, ball.vel.z),
      vx,
    });
  }
}

/** Keep the ball on the table, or report a goal. */
function resolveBounds(ball: { pos: Vec3; vel: Vec3 }, hits: HitEvent[]): Team | null {
  const r = TABLE.ballRadius;
  const halfWidth = TABLE.width / 2 - r;
  const halfLength = TABLE.length / 2;

  const wall = (approach: number): void => {
    if (approach > HIT_MIN_SPEED && hits.length < MAX_HITS_PER_TICK) {
      hits.push({
        k: "wall",
        x: ball.pos.x,
        z: ball.pos.z,
        rod: -1,
        vin: Math.hypot(ball.vel.x, ball.vel.z),
        vout: approach * WALL_RESTITUTION,
        vx: ball.vel.x,
      });
    }
  };

  // Side rails.
  if (ball.pos.z < -halfWidth) {
    wall(-ball.vel.z);
    ball.pos.z = -halfWidth;
    ball.vel.z = Math.abs(ball.vel.z) * WALL_RESTITUTION;
  } else if (ball.pos.z > halfWidth) {
    wall(ball.vel.z);
    ball.pos.z = halfWidth;
    ball.vel.z = -Math.abs(ball.vel.z) * WALL_RESTITUTION;
  }

  const inMouth = Math.abs(ball.pos.z) < GOAL_HALF_WIDTH;

  // The left goal belongs to the left team, so crossing it scores for `right`.
  if (ball.pos.x - r < -halfLength) {
    if (inMouth) return "right";
    wall(-ball.vel.x);
    ball.pos.x = -halfLength + r;
    ball.vel.x = Math.abs(ball.vel.x) * WALL_RESTITUTION;
  } else if (ball.pos.x + r > halfLength) {
    if (inMouth) return "left";
    wall(ball.vel.x);
    ball.pos.x = halfLength - r;
    ball.vel.x = -Math.abs(ball.vel.x) * WALL_RESTITUTION;
  }

  return null;
}

function capSpeed(ball: { pos: Vec3; vel: Vec3 }): void {
  const speed = Math.hypot(ball.vel.x, ball.vel.z);
  if (speed <= MAX_BALL_SPEED) return;
  const scale = MAX_BALL_SPEED / speed;
  ball.vel.x *= scale;
  ball.vel.z *= scale;
}

/** Advance the simulation by one authoritative tick. */
export function step(state: Snapshot, inputs: PlayerInput[], dtMs: number): StepResult {
  const totalDt = dtMs / 1000;
  const prevRods = state.rods;
  const rods = applyInputs(prevRods, inputs);

  const substeps = substepCount(prevRods, rods, state.ball, totalDt);
  const dt = totalDt / substeps;

  const ball = {
    pos: { ...state.ball.pos },
    vel: { ...state.ball.vel },
  };

  let scored: Team | null = null;
  let goal: { pos: Vec3; vel: Vec3 } | null = null;
  const hits: HitEvent[] = [];
  let prevMen = prevRods.map((rod, i) => manPositions(i, rod));

  for (let s = 1; s <= substeps; s++) {
    const t = s / substeps;
    const blended = rods.map((rod, i) => ({
      angle: lerp(prevRods[i].angle, rod.angle, t),
      offset: lerp(prevRods[i].offset, rod.offset, t),
    }));
    const nextMen = blended.map((rod, i) => manPositions(i, rod));

    // Roll the ball, then collide it against every man at its swept position.
    const damp = Math.exp(-BALL_FRICTION * dt);
    ball.vel.x *= damp;
    ball.vel.z *= damp;
    ball.pos.x += ball.vel.x * dt;
    ball.pos.z += ball.vel.z * dt;

    for (let i = 0; i < RODS.length; i++) {
      const before = prevMen[i];
      const after = nextMen[i];
      for (let m = 0; m < after.length; m++) {
        collideManBall(
          ball,
          after[m],
          (after[m].x - before[m].x) / dt,
          (after[m].z - before[m].z) / dt,
          i,
          hits,
        );
      }
    }

    const crossed = resolveBounds(ball, hits);
    if (crossed) {
      scored = crossed;
      goal = { pos: { ...ball.pos }, vel: { ...ball.vel } };
      break;
    }

    prevMen = nextMen;
  }

  const score = { ...state.score };
  let stuckTicks = state.stuckTicks;
  let epoch = state.epoch;

  if (scored) {
    score[scored] += 1;
    // Park the ball on the centre spot; the match layer decides when to serve.
    ball.pos = { x: 0, y: TABLE.ballRadius, z: 0 };
    ball.vel = { x: 0, y: 0, z: 0 };
    stuckTicks = 0;
    epoch += 1;
  }
  capSpeed(ball);

  // A ball at rest may have settled somewhere no rod can reach, so return it
  // to the centre spot after a grace period instead of soft-locking the match.
  const speed = Math.hypot(ball.vel.x, ball.vel.z);
  stuckTicks = speed < STUCK_SPEED ? stuckTicks + 1 : 0;
  if (stuckTicks >= STUCK_TICKS) {
    ball.pos = { x: 0, y: TABLE.ballRadius, z: 0 };
    ball.vel = { x: 0, y: 0, z: 0 };
    stuckTicks = 0;
    epoch += 1;
  }

  return {
    next: {
      tick: state.tick + 1,
      ball,
      rods,
      score,
      serverTimeMs: state.serverTimeMs + dtMs,
      stuckTicks,
      epoch,
    },
    scored,
    goal,
    hits,
  };
}

/**
 * Advance only the rods (the ball is left exactly where it is). Used while
 * play is paused — countdown and goal celebrations — so players can still move.
 */
export function settleRods(state: Snapshot, inputs: PlayerInput[], dtMs: number): Snapshot {
  return {
    ...state,
    tick: state.tick + 1,
    rods: applyInputs(state.rods, inputs),
    serverTimeMs: state.serverTimeMs + dtMs,
  };
}

/**
 * Put the ball on the centre spot and give it a gentle push toward `toward`
 * (the side that just conceded, so they get first touch). The sideways
 * component comes from the tick counter, keeping this fully deterministic.
 */
export function serveBall(state: Snapshot, toward: Team | null): Snapshot {
  const dir = toward === "left" ? -1 : 1;
  const sideways = (((state.tick * 37) % 11) - 5) / 5; // -1..1
  return {
    ...state,
    ball: {
      pos: { x: 0, y: TABLE.ballRadius, z: 0 },
      vel: { x: dir * 0.55, y: 0, z: sideways * 0.35 },
    },
    stuckTicks: 0,
    epoch: state.epoch + 1,
  };
}

/** A fresh match: ball at the centre, rods centred, score 0–0. */
export function initialState(): Snapshot {
  return {
    tick: 0,
    ball: {
      pos: { x: 0, y: TABLE.ballRadius, z: 0 },
      vel: { x: 0, y: 0, z: 0 },
    },
    rods: RODS.map(() => ({ angle: 0, offset: 0 })),
    score: { left: 0, right: 0 } satisfies Record<Team, number>,
    serverTimeMs: 0,
    stuckTicks: 0,
    epoch: 0,
  };
}
