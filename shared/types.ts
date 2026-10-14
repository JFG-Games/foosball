import type { Team } from "./constants";

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** A player as the server knows them, derived from a verified Vatar session. */
export interface Player {
  /** Vatar pseudonymous player id — never an email or phone number. */
  id: string;
  displayName: string;
  avatarUrl?: string;
  /** Which side of the table this player owns. */
  team: Team;
}

/** A player's control of a single rod. */
export interface RodState {
  /** Rotation around the rod's long axis, in radians. */
  angle: number;
  /** Lateral slide along the rod axis, normalised to -1..1. */
  offset: number;
}

/** One player's input bundle for a given server tick. */
export interface PlayerInput {
  /** Client input sequence number, used for reconciliation. */
  seq: number;
  /** The server tick this input is intended for. */
  tick: number;
  /** Sparse map of rod index -> desired rod state. */
  rods: Record<number, RodState>;
}

/** Full authoritative game state, broadcast to clients as a snapshot. */
export interface Snapshot {
  tick: number;
  ball: { pos: Vec3; vel: Vec3 };
  /** Rod states indexed 0..7 (see RODS in constants). */
  rods: RodState[];
  score: Record<Team, number>;
  /** Server wall-clock time at emit, for client clock sync. */
  serverTimeMs: number;
  /** Ticks the ball has been stopped; drives the re-serve rule. */
  stuckTicks: number;
  /**
   * Bumped every time the ball is teleported (goal, serve, stuck re-serve).
   * Clients must not interpolate across an epoch change.
   */
  epoch: number;
}

/** A ball contact worth reacting to (sound, shake, particles, comic words). */
export interface HitEvent {
  /** `man` = struck by a player, `wall` = bounced off a rail. */
  k: "man" | "wall";
  /** Where on the table it happened. */
  x: number;
  z: number;
  /** Rod index for a `man` hit, -1 for a wall. */
  rod: number;
  /** Ball speed just before / after the contact (m/s). */
  vin: number;
  vout: number;
  /** Ball x-velocity before the contact (tells you which way it was heading). */
  vx: number;
}

/** Final numbers for a finished match. */
export interface MatchStats {
  goals: Record<Team, number>;
  /** Fastest ball speed produced by each team's men (m/s). */
  fastest: Record<Team, number>;
  /** Strong shots that a team's men blocked or deflected. */
  saves: Record<Team, number>;
  /** Total play time in ms (countdown and celebrations excluded). */
  playMs: number;
}
