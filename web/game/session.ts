import { SIM_HZ, TEAM_RODS, type Team } from "@shared/constants";
import { Bot, type Difficulty } from "@shared/bot";
import { MatchCore, type MatchEvent } from "@shared/match";
import { PROTOCOL_VERSION, type ClientMessage, type ServerMessage } from "@shared/protocol";
import type { HitEvent, MatchStats, PlayerInput, RodState, Snapshot, Vec3 } from "@shared/types";
import { createConnection, type Connection } from "../net/socket";
import { SnapshotBuffer, type RenderState } from "./interpolate";

/**
 * A match, from the renderer's point of view.
 *
 * The game doesn't care whether the other side is a person on the other end
 * of a WebSocket or the bot running right here; both are a `Session` that
 * emits the same events and can be sampled each frame for what to draw.
 */
export type SessionEvent =
  | { t: "waiting"; message: string; roomCode?: string }
  | { t: "matched"; names: Record<Team, string>; roomCode?: string }
  /** The other player's readiness changed (false while they are in the tutorial). */
  | { t: "opponent"; ready: boolean }
  | { t: "start"; countdownMs: number }
  | { t: "hits"; hits: HitEvent[] }
  | { t: "goal"; team: Team; score: Record<Team, number>; ball: Vec3; vel: Vec3; pauseMs: number }
  | { t: "serve" }
  | { t: "end"; winner: Team | "draw"; score: Record<Team, number>; stats: MatchStats; forfeit?: boolean }
  | { t: "rematch" }
  /** Connection trouble: ours dropped / came back, or the opponent's did. */
  | { t: "link"; state: "reconnecting" | "restored" | "opponent_away" | "opponent_back" }
  | { t: "error"; code: string; message: string }
  | { t: "closed" };

export interface Session {
  readonly mode: "online" | "solo";
  /** Which side the local player controls. */
  readonly team: Team;
  readonly names: Record<Team, string>;
  /** Difficulty, for solo matches. */
  readonly difficulty?: Difficulty;
  /** Multiplies how fast time passes in solo matches (slow-motion). */
  timeScale: number;
  paused: boolean;
  onEvent: (event: SessionEvent) => void;
  /** Advance by `dtMs` of real time. */
  update(dtMs: number): void;
  /** What to draw right now. */
  view(): RenderState | null;
  /** I'm ready: the match can start as soon as the other side is, too. */
  ready(): void;
  /** Latest rod targets for the local player's four rods. */
  setRods(rods: Record<number, RodState>): void;
  rematch(): void;
  dispose(): void;
}

const TICK_MS = 1000 / SIM_HZ;

/** Blend two numbers. */
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/* ─────────────────────────────── solo ─────────────────────────────── */

/**
 * Single player: the shared `MatchCore` and a `Bot`, run locally at 60 Hz.
 * Zero latency, works without a server, and because the clock is ours we can
 * genuinely slow time down for the replay-style moments.
 */
export class LocalSession implements Session {
  readonly mode = "solo" as const;
  readonly team: Team = "left";
  readonly names: Record<Team, string>;
  timeScale = 1;
  paused = false;
  onEvent: (event: SessionEvent) => void = () => {};

  private readonly core = new MatchCore();
  private readonly bot: Bot;
  private rods: Record<number, RodState> = {};
  private prev: Snapshot;
  private accumulator = 0;
  private seq = 0;
  private begun = false;
  private started = false;

  constructor(
    playerName: string,
    readonly difficulty: Difficulty,
  ) {
    this.bot = new Bot("right", difficulty, (Date.now() & 0xffff) + 1);
    this.names = { left: playerName, right: botName(difficulty) };
    this.prev = this.core.state;
  }

  /** Announce the match once the listener is attached. Play starts at `ready()`. */
  begin(): void {
    if (this.begun) return;
    this.begun = true;
    this.onEvent({ t: "matched", names: this.names });
  }

  ready(): void {
    if (this.started) return;
    this.started = true;
    for (const e of this.core.begin()) this.emit(e);
  }

  setRods(rods: Record<number, RodState>): void {
    this.rods = rods;
  }

  update(dtMs: number): void {
    if (this.paused || !this.started) return;
    this.accumulator += Math.min(dtMs, 100) * this.timeScale;

    let steps = 0;
    while (this.accumulator >= TICK_MS && steps < 6) {
      this.accumulator -= TICK_MS;
      steps++;
      this.prev = this.core.state;
      this.seq++;
      const mine: PlayerInput = { seq: this.seq, tick: this.seq, rods: this.rods };
      const theirs = this.bot.think(this.core.state, TICK_MS);
      for (const e of this.core.tick([mine, theirs])) this.emit(e);
    }
    if (steps === 6) this.accumulator = 0;
  }

  view(): RenderState | null {
    const cur = this.core.state;
    const a = cur.epoch !== this.prev.epoch ? 1 : Math.min(1, this.accumulator / TICK_MS);
    return {
      rods: cur.rods.map((r, i) => ({
        angle: lerp(this.prev.rods[i].angle, r.angle, a),
        offset: lerp(this.prev.rods[i].offset, r.offset, a),
      })),
      ball: {
        x: lerp(this.prev.ball.pos.x, cur.ball.pos.x, a),
        y: cur.ball.pos.y,
        z: lerp(this.prev.ball.pos.z, cur.ball.pos.z, a),
      },
      score: { ...cur.score },
    };
  }

  rematch(): void {
    // Handled by the game starting a fresh LocalSession.
  }

  dispose(): void {
    this.onEvent = () => {};
  }

  private emit(e: MatchEvent): void {
    switch (e.t) {
      case "start":
        this.onEvent({ t: "start", countdownMs: e.countdownMs });
        break;
      case "hits":
        this.onEvent({ t: "hits", hits: e.hits });
        break;
      case "goal":
        this.onEvent({ t: "goal", team: e.team, score: e.score, ball: e.ball, vel: e.vel, pauseMs: e.pauseMs });
        break;
      case "serve":
        this.onEvent({ t: "serve" });
        break;
      case "end":
        this.onEvent({ t: "end", winner: e.winner, score: e.score, stats: e.stats });
        break;
    }
  }
}

function botName(d: Difficulty): string {
  return d === "rookie" ? "Rookie Bot" : d === "pro" ? "Pro Bot" : "Legend Bot";
}

/* ────────────────────────────── online ────────────────────────────── */

/** Server events are shown a beat late so they line up with the interpolated ball. */
const EVENT_DELAY_MS = 55;
/** How often our rods are sent to the server. */
const SEND_INTERVAL_MS = 1000 / 30;
/** How long we keep trying to get back into a match after the connection drops. */
const RECONNECT_WINDOW_MS = 18_000;
const RECONNECT_RETRY_MS = 1000;

export interface JoinOptions {
  url: string;
  sessionToken: string;
  name: string;
  roomCode?: string;
  create?: boolean;
  vatarMatchId?: string;
  /** Fetch a fresh Vatar session token for a reconnect (tokens expire). */
  refreshToken?: () => Promise<string>;
}

export class OnlineSession implements Session {
  readonly mode = "online" as const;
  team: Team = "left";
  names: Record<Team, string> = { left: "You", right: "Opponent" };
  timeScale = 1;
  paused = false;
  onEvent: (event: SessionEvent) => void = () => {};

  private connection: Connection;
  private readonly buffer = new SnapshotBuffer();
  private readonly due: { at: number; event: SessionEvent }[] = [];
  private rods: Record<number, RodState> = {};
  private lastSend = 0;
  private roomCode: string | undefined;
  private myName: string;
  private opponentName = "Opponent";
  private closed = false;
  private started = false;
  /** The server has told us the match is over: a dropped socket is then normal. */
  private finished = false;
  /** Secret from `welcome` that lets us reclaim our seat. */
  private resumeToken: string | undefined;
  private reconnecting = false;
  private reconnectDeadline = 0;
  private retryTimer: number | null = null;

  constructor(private readonly options: JoinOptions) {
    this.myName = options.name;
    this.connection = this.connect(() => ({
      t: "join",
      sessionToken: options.sessionToken,
      roomCode: options.roomCode,
      create: options.create,
      vatarMatchId: options.vatarMatchId,
      protocol: PROTOCOL_VERSION,
      name: options.name,
    }));
  }

  private connect(makeJoin: () => ClientMessage): Connection {
    const connection = createConnection(this.options.url, makeJoin);
    connection.onMessage((m) => {
      if (connection === this.connection) this.receive(m);
    });
    connection.onClose(() => {
      if (connection === this.connection) this.lost();
    });
    return connection;
  }

  /** The socket closed. Mid-match, try to get our seat back before giving up. */
  private lost(): void {
    if (this.closed) return;
    const canResume = this.started && !this.finished && this.resumeToken !== undefined && this.roomCode !== undefined;
    if (!canResume) {
      this.onEvent({ t: "closed" });
      return;
    }
    if (!this.reconnecting) {
      this.reconnecting = true;
      this.reconnectDeadline = performance.now() + RECONNECT_WINDOW_MS;
      this.onEvent({ t: "link", state: "reconnecting" });
    }
    if (performance.now() >= this.reconnectDeadline) {
      this.reconnecting = false;
      this.onEvent({ t: "closed" });
      return;
    }
    this.retryTimer = window.setTimeout(() => void this.retry(), RECONNECT_RETRY_MS);
  }

  private async retry(): Promise<void> {
    this.retryTimer = null;
    if (this.closed) return;
    let token = this.options.sessionToken;
    try {
      if (this.options.refreshToken) token = await this.options.refreshToken();
    } catch {
      /* fall back to the old token; the server may still accept it */
    }
    if (this.closed) return;
    this.connection = this.connect(() => ({
      t: "join",
      sessionToken: token,
      roomCode: this.roomCode,
      resume: this.resumeToken,
      protocol: PROTOCOL_VERSION,
      name: this.options.name,
    }));
  }

  setRods(rods: Record<number, RodState>): void {
    this.rods = rods;
  }

  update(): void {
    const now = performance.now();

    // Release events whose moment has come.
    while (this.due.length > 0 && this.due[0].at <= now) {
      this.onEvent(this.due.shift()!.event);
    }

    // Send our rods at a steady rate.
    if (now - this.lastSend >= SEND_INTERVAL_MS && this.buffer.last && !this.paused) {
      this.lastSend = now;
      const tick = this.buffer.last.tick + 1;
      this.connection.send({ t: "input", input: { seq: tick, tick, rods: this.rods } });
    }
  }

  view(): RenderState | null {
    return this.buffer.sample(performance.now());
  }

  ready(): void {
    this.connection.send({ t: "ready" });
  }

  rematch(): void {
    this.connection.send({ t: "rematch" });
  }

  dispose(): void {
    this.closed = true;
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
    this.connection.send({ t: "leave" });
    this.connection.close();
    this.onEvent = () => {};
  }

  private later(event: SessionEvent): void {
    this.due.push({ at: performance.now() + EVENT_DELAY_MS, event });
  }

  private receive(message: ServerMessage): void {
    switch (message.t) {
      case "waiting":
        this.roomCode = message.roomCode ?? this.roomCode;
        this.onEvent({ t: "waiting", message: message.message, roomCode: message.roomCode });
        break;

      case "welcome":
        this.team = message.player.team;
        this.myName = message.player.displayName;
        this.roomCode = message.roomCode;
        this.resumeToken = message.resumeToken ?? this.resumeToken;
        this.rods = Object.fromEntries(TEAM_RODS[this.team].map((i) => [i, { angle: 0, offset: 0 }]));
        break;

      case "peer":
        if (message.event === "leave" && !this.started) {
          this.onEvent({ t: "error", code: "opponent_left", message: "Your opponent left before the match started." });
        } else if (message.event === "join" && message.player.team !== this.team) {
          this.opponentName = message.player.displayName;
          this.names = this.team === "left"
            ? { left: this.myName, right: this.opponentName }
            : { left: this.opponentName, right: this.myName };
          this.onEvent({ t: "matched", names: this.names, roomCode: this.roomCode });
        }
        break;

      case "opponent":
        this.onEvent({ t: "opponent", ready: message.ready });
        break;

      case "start":
        this.started = true;
        this.buffer.reset();
        this.buffer.push(message.snapshot);
        this.due.length = 0;
        this.onEvent({ t: "start", countdownMs: message.countdownMs });
        break;

      case "snapshot":
        this.buffer.push(message.snapshot);
        break;

      case "fx":
        this.later({ t: "hits", hits: message.hits });
        break;

      case "goal":
        this.later({ t: "goal", team: message.team, score: message.score, ball: message.ball, vel: message.vel, pauseMs: message.pauseMs });
        break;

      case "serve":
        this.later({ t: "serve" });
        break;

      case "resume":
        // Back in our seat: take the live state and carry on.
        this.reconnecting = false;
        this.buffer.reset();
        this.buffer.push(message.snapshot);
        this.due.length = 0;
        this.onEvent({ t: "link", state: "restored" });
        break;

      case "away":
        this.onEvent({ t: "link", state: message.away ? "opponent_away" : "opponent_back" });
        break;

      case "end":
        this.finished = true;
        // Let the last goal's celebration play out first.
        this.later({ t: "end", winner: message.winner, score: message.score, stats: message.stats, forfeit: message.forfeit });
        break;

      case "rematch":
        this.onEvent({ t: "rematch" });
        break;

      case "error":
        // A refused reconnect means the match is gone: stop retrying.
        this.reconnecting = false;
        this.finished = true;
        this.onEvent({ t: "error", code: message.code, message: message.message });
        break;
    }
  }
}
