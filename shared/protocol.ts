import type { Team } from "./constants";
import type { Player, PlayerInput, Snapshot } from "./types";

/** Bump whenever the wire format changes; both sides must match. */
export const PROTOCOL_VERSION = 1;

/** Messages sent from the browser client to the server. */
export type ClientMessage =
  | { t: "join"; sessionToken: string; roomCode?: string }
  | { t: "ready" }
  | { t: "input"; input: PlayerInput }
  | { t: "leave" };

/** Messages sent from the server to the browser client. */
export type ServerMessage =
  | { t: "waiting"; message: string }
  | { t: "welcome"; player: Player; roomCode: string; tickRate: number }
  | { t: "peer"; event: "join" | "leave"; player: Player }
  | { t: "start"; snapshot: Snapshot }
  | { t: "snapshot"; snapshot: Snapshot }
  | { t: "goal"; team: Team; score: Record<Team, number> }
  | { t: "end"; winner: Team | "draw" }
  | { t: "error"; code: string; message: string };
