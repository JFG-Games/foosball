import { randomBytes } from "node:crypto";
import type { WebSocket } from "ws";
import { COUNTDOWN_MS, MAX_INPUTS_PER_SEC, SIM_HZ, SNAPSHOT_HZ, TEAM_RODS, type Team } from "@shared/constants";
import { MatchCore, type MatchEvent } from "@shared/match";
import type { ServerMessage } from "@shared/protocol";
import type { Player, PlayerInput, RodState } from "@shared/types";
import { VATAR_LIVE, VATAR_RESULTS_SECRET } from "./config";
import { getMatch, submitMatchResult } from "./vatar/client";

interface Seat {
  player: Player;
  socket: WebSocket;
  /** The Vatar platform match this player says they are in, if any. */
  vatarMatchId?: string;
  /** Secret that lets the same player reclaim this seat on a new socket. */
  token: string;
  /** Connection dropped mid-match; the seat is held until `graceTimer` fires. */
  away: boolean;
  graceTimer: ReturnType<typeof setTimeout> | null;
}

const TEAMS: readonly Team[] = ["left", "right"];
const TICK_MS = 1000 / SIM_HZ;

/** Ticks between snapshot broadcasts (60 Hz sim, 20 Hz snapshot -> 3). */
const SNAPSHOT_EVERY = Math.max(1, Math.round(SIM_HZ / SNAPSHOT_HZ));

/** Never run more than this many catch-up ticks in one timer callback. */
const MAX_CATCHUP_TICKS = 6;

/** Once paired, how long we wait for both players to be ready (e.g. finishing the tutorial). */
const READY_WINDOW_MS = 120_000;

/** How long a dropped player's seat is held (play is paused meanwhile). */
const DEFAULT_GRACE_MS = 20_000;
/** Read at call time so tests can shorten it with RECONNECT_GRACE_MS. */
const graceMs = (): number => Number(process.env.RECONNECT_GRACE_MS) || DEFAULT_GRACE_MS;

/** A finished room waits this long for a rematch before it is torn down. */
const REMATCH_WINDOW_MS = 60_000;

/**
 * One foosball match between two seated players.
 *
 * The match flow itself (countdown, goals, celebration pauses, winning) lives
 * in `MatchCore`, shared with the offline solo mode. This class only owns the
 * transport: seats, input validation, the real-time loop and broadcasting.
 *
 * Inputs are the *only* thing a client may influence: each player may set
 * the angle and slide of their own four rods, nothing else.
 */
export class Room {
  readonly code: string;

  private readonly seats: Record<Team, Seat | null> = { left: null, right: null };
  private readonly queued: Record<Team, PlayerInput[]> = { left: [], right: [] };
  private readonly lastInputAt: Record<Team, number> = { left: 0, right: 0 };
  private readonly rematchVotes = new Set<Team>();
  private readonly ready: Record<Team, boolean> = { left: false, right: false };
  private readyTimer: ReturnType<typeof setTimeout> | null = null;

  private core = new MatchCore();
  private timer: ReturnType<typeof setInterval> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private lastTickAt = 0;
  private accumulatorMs = 0;
  private ticksSinceSnapshot = 0;
  private started = false;
  private closed = false;
  private resultReported = false;

  constructor(
    code: string,
    private readonly onClosed: (room: Room) => void,
  ) {
    this.code = code;
  }

  get isFull(): boolean {
    return this.seats.left !== null && this.seats.right !== null;
  }

  /** Seats a player on a free side. Returns the side, or null when full. */
  seat(player: Player, socket: WebSocket, vatarMatchId?: string): Team | null {
    const team: Team | null = this.seats.left === null ? "left" : this.seats.right === null ? "right" : null;
    if (team === null) return null;

    player.team = team;
    const token = randomBytes(16).toString("hex");
    this.seats[team] = { player, socket, vatarMatchId, token, away: false, graceTimer: null };

    this.send(socket, { t: "welcome", player, roomCode: this.code, tickRate: SIM_HZ, resumeToken: token });

    const other = this.seats[team === "left" ? "right" : "left"];
    if (other) {
      this.send(other.socket, { t: "peer", event: "join", player });
      this.send(socket, { t: "peer", event: "join", player: other.player });
      this.awaitReady();
    }

    return team;
  }

  teamOf(socket: WebSocket): Team | null {
    for (const team of TEAMS) {
      if (this.seats[team]?.socket === socket) return team;
    }
    return null;
  }

  /**
   * Queue a player's input. Rods they do not own are dropped, non-finite
   * numbers are discarded, and inputs beyond the rate limit are ignored, so a
   * hostile client cannot reach across the table, poison the simulation with
   * NaN, or spam it.
   */
  queueInput(team: Team, input: PlayerInput): void {
    const now = Date.now();
    if (now - this.lastInputAt[team] < 1000 / MAX_INPUTS_PER_SEC - 1) return;
    this.lastInputAt[team] = now;

    const rods: Record<number, RodState> = {};
    for (const index of TEAM_RODS[team]) {
      const wanted = input.rods?.[index];
      if (!wanted || !Number.isFinite(wanted.angle) || !Number.isFinite(wanted.offset)) continue;
      rods[index] = { angle: wanted.angle, offset: wanted.offset };
    }

    const batch = this.queued[team];
    batch.push({ seq: Number(input.seq) || 0, tick: Number(input.tick) || 0, rods });
    if (batch.length > 30) batch.shift();
  }

  /**
   * A player says they're set up. The match only starts once both are, so
   * someone working through the tutorial never starts a game on the back foot.
   */
  markReady(socket: WebSocket): void {
    const team = this.teamOf(socket);
    if (team === null || this.started || this.closed) return;
    this.ready[team] = true;
    const other: Team = team === "left" ? "right" : "left";
    const otherSeat = this.seats[other];
    if (otherSeat) this.send(otherSeat.socket, { t: "opponent", ready: true });
    if (this.ready.left && this.ready.right) {
      if (this.readyTimer) clearTimeout(this.readyTimer);
      this.readyTimer = null;
      this.begin();
    }
  }

  /** Both seated: tell each side whether the other is ready, and set a deadline. */
  private awaitReady(): void {
    for (const team of TEAMS) {
      const other: Team = team === "left" ? "right" : "left";
      const seat = this.seats[team];
      if (seat) this.send(seat.socket, { t: "opponent", ready: this.ready[other] });
    }
    this.readyTimer = setTimeout(() => {
      this.broadcast({ t: "error", code: "opponent_timeout", message: "Your opponent never got ready. Try again!" });
      this.close();
    }, READY_WINDOW_MS);
  }

  /** The player asked for another game after a finished match. */
  rematch(socket: WebSocket): void {
    const team = this.teamOf(socket);
    if (team === null || this.closed || this.core.phase !== "over") return;

    this.rematchVotes.add(team);
    const other: Team = team === "left" ? "right" : "left";
    const otherSeat = this.seats[other];
    if (otherSeat) this.send(otherSeat.socket, { t: "rematch", from: team });

    if (this.rematchVotes.size === 2) {
      this.rematchVotes.clear();
      this.resultReported = false;
      this.core = new MatchCore();
      this.queued.left.length = 0;
      this.queued.right.length = 0;
      this.ready.left = this.ready.right = true;
      if (this.idleTimer) clearTimeout(this.idleTimer);
      this.idleTimer = null;
      this.begin(true);
    }
  }

  /** A match is under way (so a dropped player can still come back to it). */
  get live(): boolean {
    return this.started && !this.closed && this.core.phase !== "over";
  }

  /**
   * A player's socket closed. Mid-match we hold their seat for a while and
   * pause play instead of forfeiting. Returns false when there is nothing to
   * hold (not started / already over), so the caller should `abandon` instead.
   */
  drop(socket: WebSocket): boolean {
    const team = this.teamOf(socket);
    if (team === null) return false;
    const seat = this.seats[team];
    if (!seat || !this.live) return false;

    seat.away = true;
    if (seat.graceTimer) clearTimeout(seat.graceTimer);
    seat.graceTimer = setTimeout(() => this.abandon(seat.socket), graceMs());

    const other = this.seats[team === "left" ? "right" : "left"];
    if (other) this.send(other.socket, { t: "away", away: true, graceMs: graceMs() });
    return true;
  }

  /**
   * Hand a held seat to a new socket if `token` matches. Returns the socket it
   * replaces (so the lobby can forget it), or null when the token is wrong.
   */
  resume(socket: WebSocket, token: string): WebSocket | null {
    if (this.closed) return null;
    for (const team of TEAMS) {
      const seat = this.seats[team];
      if (!seat || seat.token !== token) continue;

      const previous = seat.socket;
      if (seat.graceTimer) clearTimeout(seat.graceTimer);
      seat.graceTimer = null;
      seat.away = false;
      seat.socket = socket;

      this.send(socket, { t: "welcome", player: seat.player, roomCode: this.code, tickRate: SIM_HZ, resumeToken: seat.token });
      const other = this.seats[team === "left" ? "right" : "left"];
      if (other) {
        this.send(socket, { t: "peer", event: "join", player: other.player });
        this.send(socket, { t: "opponent", ready: true });
        this.send(other.socket, { t: "away", away: false });
      }
      this.send(socket, { t: "resume", snapshot: this.core.state });
      if (this.core.extraTime) this.send(socket, { t: "extra", ms: this.core.timeLeftMs });
      this.lastTickAt = performance.now();
      return previous;
    }
    return null;
  }

  /** A player dropped: tell the other side, end the match and close the room. */
  abandon(socket: WebSocket): void {
    const team = this.teamOf(socket);
    if (team === null) return;
    const gone = this.seats[team];
    this.seats[team] = null;
    if (gone?.graceTimer) clearTimeout(gone.graceTimer);

    const otherTeam: Team = team === "left" ? "right" : "left";
    const other = this.seats[otherTeam];
    if (other) {
      if (this.core.phase !== "over" && this.started) {
        this.send(other.socket, {
          t: "end",
          winner: otherTeam,
          score: { ...this.core.state.score },
          stats: this.core.finalStats(),
          forfeit: true,
        });
      } else {
        this.send(other.socket, {
          t: "peer",
          event: "leave",
          player: gone!.player,
        });
      }
    }
    this.close();
  }

  stop(): void {
    for (const team of TEAMS) {
      const timer = this.seats[team]?.graceTimer;
      if (timer) clearTimeout(timer);
    }
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (this.readyTimer !== null) clearTimeout(this.readyTimer);
    this.readyTimer = null;
  }

  /** Kick off (or restart) the match and the real-time loop. */
  private begin(isRematch = false): void {
    if (this.started && !isRematch) return;
    this.started = true;

    this.broadcast({ t: "start", snapshot: this.core.state, countdownMs: COUNTDOWN_MS });
    this.ticksSinceSnapshot = 0;
    this.accumulatorMs = 0;
    this.lastTickAt = performance.now();
    if (this.timer === null) this.timer = setInterval(() => this.pump(), TICK_MS / 2);
  }

  /** Run as many fixed ticks as real time demands, then return. */
  private pump(): void {
    const now = performance.now();
    // Someone is reconnecting: hold the match still rather than let them concede goals.
    if (TEAMS.some((team) => this.seats[team]?.away)) {
      this.lastTickAt = now;
      return;
    }
    this.accumulatorMs += now - this.lastTickAt;
    this.lastTickAt = now;

    let steps = 0;
    while (this.accumulatorMs >= TICK_MS && steps < MAX_CATCHUP_TICKS) {
      this.accumulatorMs -= TICK_MS;
      steps += 1;
      this.tick();
    }
    // Fell too far behind (e.g. the process was suspended): drop the debt.
    if (steps === MAX_CATCHUP_TICKS) this.accumulatorMs = 0;
  }

  private tick(): void {
    const inputs: PlayerInput[] = [];
    for (const team of TEAMS) {
      const batch = this.queued[team];
      if (batch.length === 0) continue;
      inputs.push(this.collapse(team, batch));
      batch.length = 0;
    }

    const events = this.core.tick(inputs);
    let forceSnapshot = false;
    for (const event of events) forceSnapshot = this.dispatch(event) || forceSnapshot;

    this.ticksSinceSnapshot++;
    if (forceSnapshot || this.ticksSinceSnapshot >= SNAPSHOT_EVERY) {
      this.ticksSinceSnapshot = 0;
      this.broadcast({ t: "snapshot", snapshot: this.core.state });
    }
  }

  /** Translate a match event to the wire. Returns true if a snapshot should follow now. */
  private dispatch(event: MatchEvent): boolean {
    switch (event.t) {
      case "hits":
        this.broadcast({ t: "fx", hits: event.hits });
        return false;
      case "goal":
        this.broadcast({
          t: "goal",
          team: event.team,
          score: event.score,
          ball: event.ball,
          vel: event.vel,
          pauseMs: event.pauseMs,
        });
        return true;
      case "serve":
        this.broadcast({ t: "serve" });
        return true;
      case "extra":
        this.broadcast({ t: "extra", ms: event.ms });
        return false;
      case "end":
        this.broadcast({ t: "end", winner: event.winner, score: event.score, stats: event.stats, byTime: event.byTime });
        void this.reportResult(event.winner);
        this.idleTimer = setTimeout(() => this.close(), REMATCH_WINDOW_MS);
        return false;
      case "start":
        return false;
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

  /**
   * Tell Lagos Life who won, if this game belongs to a platform match.
   *
   * Only done when both players name the same match *and* the platform lists
   * both of them as its players, so a client can't point us at someone else's
   * match. Failures are logged, never thrown: the game result stands either way.
   */
  private async reportResult(winner: Team | "draw"): Promise<void> {
    if (this.resultReported) return;
    const left = this.seats.left;
    const right = this.seats.right;
    if (!left || !right || !left.vatarMatchId || left.vatarMatchId !== right.vatarMatchId) {
      console.log(`[room ${this.code}] no shared Vatar match; result not reported`);
      return;
    }
    if (!VATAR_LIVE || !VATAR_RESULTS_SECRET) {
      console.log(`[room ${this.code}] VATAR_SECRET / VATAR_RESULTS_SECRET not set; result not reported`);
      return;
    }

    this.resultReported = true;
    try {
      const match = await getMatch(left.vatarMatchId);
      const ids = new Set(match.players.map((p) => p.playerId));
      if (!ids.has(left.player.id) || !ids.has(right.player.id)) {
        console.warn(`[room ${this.code}] players are not in Vatar match ${match.id}; not reporting`);
        return;
      }
      const winnerId = winner === "draw" ? "draw" : this.seats[winner]?.player.id;
      if (!winnerId) return;
      await submitMatchResult(match.id, winnerId);
      console.log(`[room ${this.code}] reported result for Vatar match ${match.id}`);
    } catch (error) {
      console.warn(`[room ${this.code}] could not report result:`, error instanceof Error ? error.message : error);
    }
  }

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stop();
    this.onClosed(this);
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
