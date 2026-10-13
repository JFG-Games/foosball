/**
 * Simulation + table constants shared by the browser client and the server.
 * Keep every value here in one place so both sides simulate identically.
 */

/** Authoritative physics rate (Hz). The server steps the sim at this rate. */
export const SIM_HZ = 60;

/** Downstream snapshot broadcast rate (Hz). Lower than SIM_HZ to save bandwidth. */
export const SNAPSHOT_HZ = 20;

/** Max input packets accepted per second, per player (server-side rate limit). */
export const MAX_INPUTS_PER_SEC = 60;

/** First team to this many goals wins. */
export const MATCH_SCORE_TO_WIN = 5;

/** Pause after a goal, before the next ball is served (ms). */
export const GOAL_PAUSE_MS = 1200;

/** Length of a generated room code (e.g. "K4Q7Z"). */
export const ROOM_CODE_LENGTH = 5;

/** How long two players may sit in a room before the match starts (ms). */
export const COUNTDOWN_MS = 3000;

/** The two competing sides. `left` defends the -x goal; `right` defends +x. */
export type Team = "left" | "right";

/**
 * Stylised table dimensions in metres (not regulation). The playfield is
 * centred on the origin: x runs goal-to-goal, z across the width, y is up.
 * The playing surface sits at y = 0.
 */
export const TABLE = {
  /** Inner playfield length along x. */
  length: 1.2,
  /** Inner playfield width along z. */
  width: 0.68,
  /** Height of each rod's axis above the playing surface. */
  rodHeight: 0.08,
  /** Ball radius (a 34 mm ball -> ~0.017 m). */
  ballRadius: 0.017,
  /** Table top thickness. */
  surfaceThickness: 0.02,
} as const;

/** A single rod and the men mounted on it. */
export interface RodSpec {
  /** 0..7, ordered from the left goal to the right goal. */
  index: number;
  /** Which side controls this rod. */
  team: Team;
  /** Position along the table, from the controlling side's goal outward. */
  role: "goalie" | "defense" | "midfield" | "attack";
  /** Number of men on the rod. */
  men: number;
  /** x position of the rod along the table centre line. */
  x: number;
}

/**
 * Rod layout, ordered from the LEFT goal to the RIGHT goal.
 *
 * A standard single-goalie table has 11 men per team, and the man counts
 * read 1 · 3 · 2 · 5 · 5 · 2 · 3 · 1 across the table with ownership
 * alternating. The `left` team defends the -x goal, `right` defends +x.
 *
 * Tune `x` / `men` freely — this is our own stylised take, not ITSF spec.
 */
export const RODS = [
  { index: 0, team: "left", role: "goalie", men: 1, x: -0.5 },
  { index: 1, team: "right", role: "attack", men: 3, x: -0.36 },
  { index: 2, team: "left", role: "defense", men: 2, x: -0.22 },
  { index: 3, team: "right", role: "midfield", men: 5, x: -0.08 },
  { index: 4, team: "left", role: "midfield", men: 5, x: 0.08 },
  { index: 5, team: "right", role: "defense", men: 2, x: 0.22 },
  { index: 6, team: "left", role: "attack", men: 3, x: 0.36 },
  { index: 7, team: "right", role: "goalie", men: 1, x: 0.5 },
] as const satisfies readonly RodSpec[];

/** The rod indices controlled by each team, ordered from goal to attack. */
export const TEAM_RODS: Record<Team, readonly number[]> = {
  left: [0, 2, 4, 6],
  right: [7, 5, 3, 1],
};

/* ────────────────────────────── physics ────────────────────────────── */

/**
 * Distance from a rod's axis to the tip of a man's foot. A man hangs this
 * far below its rod, so rotating the rod by `a` moves the foot `MAN_SWING *
 * sin(a)` along x. Keep this in sync with the rendered mesh offset.
 */
export const MAN_SWING = 0.05;

/** Collision radius of a man in the x–z plane (the ball is a circle too). */
export const MAN_RADIUS = 0.019;

/** Half the goal mouth width. Shots outside this band hit the end rail. */
export const GOAL_HALF_WIDTH = 0.11;

/** Ball rolling friction (1/s), applied as `v *= exp(-k * dt)`. */
export const BALL_FRICTION = 0.45;

/** Ball bounce off the rails, 0..1. */
export const WALL_RESTITUTION = 0.7;

/** Ball bounce off a man, 0..1. A moving man also transfers its momentum. */
export const MAN_RESTITUTION = 0.55;

/** Hard cap on ball speed (m/s), to stop tunnelling and absurd shots. */
export const MAX_BALL_SPEED = 6;

/** Rod rotation limit (radians), in both directions. */
export const MAX_ROD_ANGLE = Math.PI;

/** Normalised rod slide (offset = -1..1) maps to this many metres. */
export const MAX_ROD_SLIDE = 0.12;

/** Ball slower than this (m/s) counts as stopped. */
export const STUCK_SPEED = 0.02;

/**
 * Consecutive stopped ticks before the ball is re-served (4 s at 60 Hz).
 *
 * The men hang from rods and only sweep a narrow band along x, so a ball can
 * come to rest in a pocket no rod can reach. Rather than let a match soft-lock,
 * a ball that has stopped for this long is returned to the centre spot.
 */
export const STUCK_TICKS = 240;

/** Fraction of a man's radius the ball may travel per substep. */
export const COLLISION_SUBSTEP_RATIO = 0.5;

/** Upper bound on physics substeps per tick, to bound worst-case cost. */
export const MAX_SUBSTEPS = 16;
