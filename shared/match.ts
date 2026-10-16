import {
  COUNTDOWN_MS,
  GOAL_PAUSE_MS,
  MATCH_SCORE_TO_WIN,
  MATCH_EXTRA_TIME,
  MATCH_TIME,
  RODS,
  SIM_HZ,
  type Team,
} from "./constants";
import { initialState, serveBall, settleRods, step } from "./sim";
import type { HitEvent, MatchStats, PlayerInput, Snapshot, Vec3 } from "./types";

/**
 * The match flow, independent of transport.
 *
 *   countdown ──▶ play ──goal──▶ goal ──▶ play …
 *                   └──── winning goal ──▶ goal ──▶ over
 *
 * The server's Room and the offline single-player session both drive one of
 * these, so "what happens after a goal" can never differ between modes.
 * Everything here is deterministic: time only enters through `tick(dtMs)`.
 */
export type Phase = "countdown" | "play" | "goal" | "over";

export type MatchEvent =
  | { t: "start"; countdownMs: number }
  | { t: "hits"; hits: HitEvent[] }
  | { t: "goal"; team: Team; score: Record<Team, number>; ball: Vec3; vel: Vec3; pauseMs: number }
  | { t: "serve" }
  /** Regulation time ended level: sudden-death extra time begins. */
  | { t: "extra"; ms: number }
  | { t: "end"; winner: Team | "draw"; score: Record<Team, number>; stats: MatchStats; byTime?: boolean };

const TICK_MS = 1000 / SIM_HZ;

/** A shot has to arrive at least this fast to count as a save when stopped. */
const SAVE_SPEED = 2.2;

export class MatchCore {
  state: Snapshot = initialState();
  phase: Phase = "countdown";

  private phaseLeftMs = COUNTDOWN_MS;
  private conceded: Team | null = null;
  private winner: Team | "draw" | null = null;
  private readonly stats: MatchStats = {
    goals: { left: 0, right: 0 },
    fastest: { left: 0, right: 0 },
    saves: { left: 0, right: 0 },
    playMs: 0,
  };

  private inExtra = false;

  constructor(
    private readonly scoreToWin = MATCH_SCORE_TO_WIN,
    private readonly timeLimitMs = MATCH_TIME,
    private readonly extraTimeMs = MATCH_EXTRA_TIME,
  ) {}

  /** Play time at which the current period ends. */
  private get limitMs(): number {
    return this.timeLimitMs + (this.inExtra ? this.extraTimeMs : 0);
  }

  /** Milliseconds of play left in the current period (regulation, then extra time). */
  get timeLeftMs(): number {
    return Math.max(0, this.limitMs - this.stats.playMs);
  }

  /** True once sudden-death extra time has begun. */
  get extraTime(): boolean {
    return this.inExtra;
  }

  /**
   * The play clock may have run out. Ends the match (returns true), or, if it
   * is level after regulation, starts extra time and play carries on.
   */
  private clockCheck(events: MatchEvent[]): boolean {
    if (this.stats.playMs < this.limitMs) return false;
    const leader = this.leader();
    if (leader === "draw" && !this.inExtra && this.extraTimeMs > 0) {
      this.inExtra = true;
      events.push({ t: "extra", ms: this.extraTimeMs });
      return false;
    }
    this.finish(leader, events, true);
    return true;
  }

  /** Who is ahead when time runs out: the higher score, or a draw. */
  private leader(): Team | "draw" {
    const { left, right } = this.state.score;
    return left === right ? "draw" : left > right ? "left" : "right";
  }

  private finish(winner: Team | "draw", events: MatchEvent[], byTime: boolean): void {
    this.winner = winner;
    this.phase = "over";
    events.push({ t: "end", winner, score: { ...this.state.score }, stats: this.finalStats(), byTime });
  }

  /** Events that describe the match as it begins. */
  begin(): MatchEvent[] {
    return [{ t: "start", countdownMs: COUNTDOWN_MS }];
  }

  /** Milliseconds left in the current countdown / celebration. */
  get remainingMs(): number {
    return this.phaseLeftMs;
  }

  /** Advance one fixed tick. Returns whatever happened during it. */
  tick(inputs: PlayerInput[]): MatchEvent[] {
    const events: MatchEvent[] = [];

    switch (this.phase) {
      case "countdown":
      case "goal":
        this.state = settleRods(this.state, inputs, TICK_MS);
        this.phaseLeftMs -= TICK_MS;
        if (this.phaseLeftMs <= 0) this.advanceFromPause(events);
        break;

      case "play":
        this.play(inputs, events);
        break;

      case "over":
        break;
    }

    return events;
  }

  private advanceFromPause(events: MatchEvent[]): void {
    if (this.phase === "goal" && this.winner !== null) {
      this.finish(this.winner, events, false);
      return;
    }
    // A goal at the buzzer: the clock ran out during the celebration, so it decides the match now.
    if (this.phase === "goal" && this.clockCheck(events)) return;
    this.state = serveBall(this.state, this.conceded);
    this.phase = "play";
    events.push({ t: "serve" });
  }

  private play(inputs: PlayerInput[], events: MatchEvent[]): void {
    const result = step(this.state, inputs, TICK_MS);
    const reserved = !result.scored && result.next.epoch !== this.state.epoch;
    this.state = result.next;
    this.stats.playMs += TICK_MS;

    // The sim parks a ball that has stopped somewhere unreachable on the
    // centre spot. A ball resting there is out of every rod's reach too, so
    // give it a push, exactly like a normal serve.
    if (reserved) {
      this.state = serveBall(this.state, this.conceded);
      events.push({ t: "serve" });
    }

    if (result.hits.length > 0) {
      this.tally(result.hits);
      events.push({ t: "hits", hits: result.hits });
    }

    if (result.scored && result.goal) {
      const team = result.scored;
      this.stats.goals[team] += 1;
      this.conceded = team === "left" ? "right" : "left";
      this.phase = "goal";
      this.phaseLeftMs = GOAL_PAUSE_MS;
      // In extra time the next goal wins, whatever the score.
      if (this.state.score[team] >= this.scoreToWin || this.inExtra) this.winner = team;

      events.push({
        t: "goal",
        team,
        score: { ...this.state.score },
        ball: result.goal.pos,
        vel: result.goal.vel,
        pauseMs: GOAL_PAUSE_MS,
      });
    } else {
      this.clockCheck(events);
    }
  }

  /** Credit shots and saves to whichever team owns the rod that hit the ball. */
  private tally(hits: HitEvent[]): void {
    for (const hit of hits) {
      if (hit.k !== "man") continue;
      const spec = RODS[hit.rod];
      if (!spec) continue;
      if (hit.vout > this.stats.fastest[spec.team]) this.stats.fastest[spec.team] = hit.vout;

      // A save: a quick ball that was heading for this team's goal got stopped.
      const towardOwnGoal = spec.team === "left" ? hit.vx < 0 : hit.vx > 0;
      if (towardOwnGoal && hit.vin >= SAVE_SPEED && Math.abs(hit.vx) > SAVE_SPEED * 0.6) {
        this.stats.saves[spec.team] += 1;
      }
    }
  }

  /** Stats snapshot. Safe to call at any time. */
  finalStats(): MatchStats {
    return {
      goals: { ...this.stats.goals },
      fastest: { ...this.stats.fastest },
      saves: { ...this.stats.saves },
      playMs: Math.round(this.stats.playMs),
    };
  }
}
