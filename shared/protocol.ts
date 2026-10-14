import type { Team } from "./constants";
import type { HitEvent, MatchStats, Player, PlayerInput, Snapshot, Vec3 } from "./types";

/** Bump whenever the wire format changes; both sides must match. */
export const PROTOCOL_VERSION = 3;

/** Messages sent from the browser client to the server. */
export type ClientMessage =
  | {
      t: "join";
      sessionToken: string;
      /** Join a friend's private room instead of the quick-match queue. */
      roomCode?: string;
      /** Open a private room and wait for a friend. */
      create?: boolean;
      /** A Vatar platform match this game belongs to (results are reported to it). */
      vatarMatchId?: string;
      protocol?: number;
      /** Display name for local development only; ignored once Vatar verifies the session. */
      name?: string;
    }
  | { t: "input"; input: PlayerInput }
  | { t: "rematch" }
  /** I'm set up (tutorial done, scene ready). The match starts once both players are. */
  | { t: "ready" }
  | { t: "leave" };

/** Messages sent from the server to the browser client. */
export type ServerMessage =
  | { t: "waiting"; message: string; roomCode?: string }
  | { t: "welcome"; player: Player; roomCode: string; tickRate: number }
  | { t: "peer"; event: "join" | "leave"; player: Player }
  /** Whether the other player is ready yet (false while they're in the tutorial, say). */
  | { t: "opponent"; ready: boolean }
  | { t: "start"; snapshot: Snapshot; countdownMs: number }
  | { t: "snapshot"; snapshot: Snapshot }
  /** Ball contacts, for sound and effects. Purely cosmetic. */
  | { t: "fx"; hits: HitEvent[] }
  | {
      t: "goal";
      team: Team;
      score: Record<Team, number>;
      /** Where the ball crossed the line, and how it was travelling. */
      ball: Vec3;
      vel: Vec3;
      /** How long play stays paused for the celebration (ms). */
      pauseMs: number;
    }
  | { t: "serve" }
  | { t: "end"; winner: Team | "draw"; score: Record<Team, number>; stats: MatchStats; forfeit?: boolean }
  /** The other player wants a rematch. */
  | { t: "rematch"; from: Team }
  | { t: "error"; code: string; message: string };
