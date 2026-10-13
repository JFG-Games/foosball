import type { WebSocket } from "ws";
import {
  MATCH_SCORE_TO_WIN,
  MAX_INPUTS_PER_SEC,
  SIM_HZ,
  SNAPSHOT_HZ,
  TEAM_RODS,
  type Team,
} from "@shared/constants";
import type { ServerMessage } from "@shared/protocol";
import { initialState, step } from "@shared/sim";
import type { Player, PlayerInput, RodState, Snapshot } from "@shared/types";

interface Seat {
  player: Player;
  socket: WebSocket;
}

const TEAMS: readonly Team[] = ["left", "right"];

/** Ticks between snapshot broadcasts (60 Hz sim, 20 Hz snapshot -> 3). */
const SNAPSHOT_EVERY = Math.max(1, Math.round(SIM_HZ / SNAPSHOT_HZ));

/**
 * One foosball match. Owns the authoritative fixed-timestep simulation and
 * broadcasts snapshots to the two seated players.
 *
 * Inputs are the *only* thing a client may influence: each player may set
 * the angle and slide of their own four rods, nothing else. Everything else
 * (ball, opponent's rods, score) is decided here.
 */
export class Room {
  readonly code: string;

  private readonly seats: Record<Team, Seat | null> = { left: null, right: null };
  private readonly queued: Record<Team, PlayerInput[]> = { left: [], right: [] };
  private readonly lastInputAt: Record<Team, number> = { left: 0, right: 0 };

  private state: Snapshot = initialState();
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticksSinceSnapshot = 0;
  private finished = false;
  private started = false;

  constructor(code: string, private readonly onFinished: (room: Room) => void) {
    this.code = code;
  }

  /** Seats a player on a free side. Returns the side, or null when full. */
  seat(player: Player, socket: WebSocket): Team | null {
    const team: Team | null = this.seats.left === null ? "left" : this.seats.right === null ? "right" : null;
    if (team === null) return null;

    player.team = team;
    this.seats[team] = { player, socket };

    this.send(socket, {
      t: "welcome",
      player,
      roomCode: this.code,
      tickRate: SIM_HZ,
    });

    const other = this.seats[team === "left" ? "right" : "left"];
    if (other) {
      this.send(other.socket, { t: "peer", event: "join", player });
      this.send(socket, { t: "peer", event: "join", player: other.player });
      this.start();
    }

    return team;
  }

  teamOf(socket: WebSocket): Team | null {
    for (const team of TEAMS) {
      if (this.seats[team]?.socket === socket) return team;
    }
    return null;
  }

  get opponentOf(): (socket: WebSocket) => WebSocket | null {
    return (socket: WebSocket) => {
      const team = this.teamOf(socket);
      if (team === null) return null;
      return this.seats[team === "left" ? "right" : "left"]?.socket ?? null;
    };
  }

  /**
   * Queue a player's input. Rods they do not own are dropped, and inputs
   * beyond the rate limit are ignored, so a hostile client cannot reach
   * across the table or spam the simulation.
   */
  queueInput(team: Team, input: PlayerInput): void {
    const now = Date.now();
    if (now - this.lastInputAt[team] < 1000 / MAX_INPUTS_PER_SEC - 1) return;
    this.lastInputAt[team] = now;

    const rods: Record<number, RodState> = {};
    for (const index of TEAM_RODS[team]) {
      const wanted = input.rods[index];
      if (wanted) rods[index] = { angle: wanted.angle, offset: wanted.offset };
    }

    const batch = this.queued[team];
    batch.push({ seq: input.seq, tick: input.tick, rods });
    if (batch.length > 30) batch.shift();
  }

  start(): void {
    if (this.started) return;
    this.started = true;

    this.broadcast({ t: "start", snapshot: this.state });
    this.timer = setInterval(() => this.tick(), 1000 / SIM_HZ);
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /** A player dropped: tell the other side and end the match. */
  abandon(socket: WebSocket): void {
    const team = this.teamOf(socket);
    if (team === null) return;
    this.seats[team] = null;

    const other = this.seats[team === "left" ? "right" : "left"];
    if (other && !this.finished) {
      this.send(other.socket, { t: "end", winner: other.player.team });
    }
    this.finish();
  }

  private tick(): void {
    const inputs: PlayerInput[] = [];
    for (const team of TEAMS) {
      const batch = this.queued[team];
      if (batch.length === 0) continue;
      inputs.push(this.collapse(team, batch));
      batch.length = 0;
    }

    const { next, scored } = step(this.state, inputs, 1000 / SIM_HZ);
    this.state = next;

    if (scored) {
      this.broadcast({ t: "goal", team: scored, score: next.score });
      if (next.score[scored] >= MATCH_SCORE_TO_WIN) {
        this.broadcast({ t: "end", winner: scored });
        this.finish();
        return;
      }
    }

    this.ticksSinceSnapshot++;
    if (this.ticksSinceSnapshot >= SNAPSHOT_EVERY) {
      this.ticksSinceSnapshot = 0;
      this.broadcast({ t: "snapshot", snapshot: this.state });
    }
  }

  /** Fold a tick's inputs into one bundle: the newest value per rod wins. */
  private collapse(team: Team, batch: PlayerInput[]): PlayerInput {
    const rods: Record<number, RodState> = {};
    for (const index of TEAM_RODS[team]) {
      for (const item of batch) {
        const value = item.rods[index];
        if (value) rods[index] = value;
      }
    }
    const last = batch[batch.length - 1];
    return { seq: last.seq, tick: last.tick, rods };
  }

  private finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.stop();
    this.onFinished(this);
  }

  private broadcast(message: ServerMessage): void {
    for (const team of TEAMS) {
      const seat = this.seats[team];
      if (seat) this.send(seat.socket, message);
    }
  }

  private send(socket: WebSocket, message: ServerMessage): void {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
  }
}
