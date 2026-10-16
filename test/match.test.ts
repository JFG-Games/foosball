import assert from "node:assert/strict";
import test from "node:test";
import { COUNTDOWN_MS, GOAL_PAUSE_MS, SIM_HZ, TABLE } from "@shared/constants";
import { Bot, type Difficulty } from "@shared/bot";
import { MatchCore, type MatchEvent } from "@shared/match";
import { initialState, serveBall, step } from "@shared/sim";
import type { PlayerInput } from "@shared/types";

const TICK = 1000 / SIM_HZ;

/** Tick a match with no inputs until `phase` is reached (or a safety cap). */
function runUntil(core: MatchCore, phase: MatchCore["phase"], inputs: () => PlayerInput[] = () => []): MatchEvent[] {
  const events: MatchEvent[] = [];
  for (let i = 0; i < 60 * 600 && core.phase !== phase; i++) events.push(...core.tick(inputs()));
  return events;
}

/** A match that is already in open play. */
function inPlay(scoreToWin?: number): MatchCore {
  const core = new MatchCore(scoreToWin);
  runUntil(core, "play");
  return core;
}

/** Point the ball at the right-hand goal so the next tick scores for `left`. */
function aimAtRightGoal(core: MatchCore): void {
  core.state.ball.pos.x = TABLE.length / 2 - TABLE.ballRadius - 0.005;
  core.state.ball.pos.z = 0;
  core.state.ball.vel.x = 3;
}

test("a match opens with a countdown, then serves", () => {
  const core = new MatchCore();
  assert.equal(core.phase, "countdown");
  assert.deepEqual(core.begin(), [{ t: "start", countdownMs: COUNTDOWN_MS }]);

  const events = runUntil(core, "play");
  assert.deepEqual(events.map((e) => e.t), ["serve"]);
  assert.ok(Math.hypot(core.state.ball.vel.x, core.state.ball.vel.z) > 0, "served ball is moving");
});

test("the ball stays put during the countdown, even if rods move", () => {
  const core = new MatchCore();
  const before = { ...core.state.ball.pos };
  const move: PlayerInput = { seq: 1, tick: 1, rods: { 4: { angle: 2, offset: 1 } } };
  for (let i = 0; i < 30; i++) core.tick([move]);
  assert.deepEqual(core.state.ball.pos, before);
  assert.equal(core.state.rods[4].offset, 1, "rods still respond");
});

test("a goal pauses play, then serves toward the side that conceded", () => {
  const core = inPlay();
  aimAtRightGoal(core);

  const goalEvents = core.tick([]);
  const goal = goalEvents.find((e) => e.t === "goal");
  assert.ok(goal && goal.t === "goal");
  assert.equal(goal.team, "left");
  assert.equal(goal.score.left, 1);
  assert.equal(goal.pauseMs, GOAL_PAUSE_MS);
  assert.ok(goal.vel.x > 0, "goal event carries the ball's velocity");
  assert.equal(core.phase, "goal");

  const frozen = { ...core.state.ball.pos };
  for (let i = 0; i < 30; i++) core.tick([]);
  assert.deepEqual(core.state.ball.pos, frozen, "ball is frozen during the celebration");

  const epochBefore = core.state.epoch;
  const rest = runUntil(core, "play");
  assert.deepEqual(rest.map((e) => e.t), ["serve"]);
  assert.ok(core.state.epoch > epochBefore, "serving bumps the epoch");
  assert.ok(core.state.ball.vel.x > 0, "ball is pushed toward the team that conceded (right, at +x)");
});

test("the winning goal ends the match after the celebration", () => {
  const core = inPlay(1);
  aimAtRightGoal(core);
  core.tick([]);
  assert.equal(core.phase, "goal");

  const rest = runUntil(core, "over");
  const end = rest.find((e) => e.t === "end");
  assert.ok(end && end.t === "end");
  assert.equal(end.winner, "left");
  assert.equal(end.stats.goals.left, 1);
  assert.equal(core.tick([]).length, 0, "nothing happens once the match is over");
});

test("hits are reported with the rod that made them", () => {
  const core = inPlay();
  core.state.ball.pos = { x: 0.08 + 0.02, y: TABLE.ballRadius, z: 0 };
  core.state.ball.vel = { x: 0, y: 0, z: 0 };
  const events = core.tick([{ seq: 1, tick: 1, rods: { 4: { angle: Math.PI / 2, offset: 0 } } }]);
  const hits = events.flatMap((e) => (e.t === "hits" ? e.hits : []));
  assert.ok(hits.length > 0, "a kick produces a hit event");
  assert.equal(hits[0].k, "man");
  assert.equal(hits[0].rod, 4);
  assert.ok(hits[0].vout > 0.5);
});

test("walls report a bounce, and a rolling ball does not spam events", () => {
  const start = initialState();
  start.ball.pos = { x: 0, y: TABLE.ballRadius, z: TABLE.width / 2 - TABLE.ballRadius - 0.004 };
  start.ball.vel = { x: 0, y: 0, z: 2 };
  const bounce = step(start, [], TICK);
  assert.equal(bounce.hits[0]?.k, "wall");

  // Roll between the men (z = 0.05 clears every rod's men) for 40 ticks.
  let state = initialState();
  state.ball.pos.z = 0.05;
  state.ball.vel = { x: 0.5, y: 0, z: 0 };
  let count = 0;
  for (let i = 0; i < 40; i++) {
    const r = step(state, [], TICK);
    count += r.hits.length;
    state = r.next;
  }
  assert.equal(count, 0, "free rolling is silent");
});

test("serveBall is deterministic and bumps the epoch", () => {
  const a = serveBall(initialState(), "left");
  const b = serveBall(initialState(), "left");
  assert.deepEqual(a, b);
  assert.equal(a.epoch, 1);
  assert.ok(a.ball.vel.x < 0);
});

/** Play a bot against a still opponent (or another bot) for `seconds`. */
function playBots(left: Difficulty | null, right: Difficulty | null, seconds: number): MatchCore {
  const core = new MatchCore(99);
  const botL = left ? new Bot("left", left, 11) : null;
  const botR = right ? new Bot("right", right, 22) : null;
  for (let i = 0; i < seconds * SIM_HZ; i++) {
    const inputs: PlayerInput[] = [];
    if (botL) inputs.push(botL.think(core.state, TICK));
    if (botR) inputs.push(botR.think(core.state, TICK));
    core.tick(inputs);
  }
  return core;
}

test("a bot is deterministic", () => {
  const a = playBots("pro", "pro", 40);
  const b = playBots("pro", "pro", 40);
  assert.equal(JSON.stringify(a.state), JSON.stringify(b.state));
});

test("a bot only ever sets its own rods, within limits", () => {
  const bot = new Bot("right", "legend", 5);
  const state = initialState();
  for (let i = 0; i < 120; i++) {
    const { rods } = bot.think(state, TICK);
    assert.deepEqual(Object.keys(rods).map(Number).sort(), [1, 3, 5, 7]);
    for (const rod of Object.values(rods)) {
      assert.ok(Math.abs(rod.offset) <= 1 && Math.abs(rod.angle) <= Math.PI);
    }
  }
});

test("a legend bot beats an idle table", () => {
  const core = playBots("legend", null, 150);
  assert.ok(core.state.score.left >= 1, `legend should score on a still opponent, got ${JSON.stringify(core.state.score)}`);
});

test("a stronger bot out-scores a weaker one", () => {
  let strong = 0;
  let weak = 0;
  for (const [l, r] of [
    ["legend", "rookie"],
    ["rookie", "legend"],
  ] as const) {
    const core = playBots(l, r, 240);
    strong += l === "legend" ? core.state.score.left : core.state.score.right;
    weak += l === "legend" ? core.state.score.right : core.state.score.left;
  }
  assert.ok(strong > weak, `legend ${strong} vs rookie ${weak}`);
});

/** Play (no inputs, ball parked at rest) until `core` reports its end, returning that event. */
function playToEnd(core: MatchCore): Extract<MatchEvent, { t: "end" }> {
  const events = runUntil(core, "over");
  const end = events.find((e) => e.t === "end");
  assert.ok(end && end.t === "end", "the match ended");
  return end;
}

/** Hold the ball still so only the clock can end the match. */
function parkBall(core: MatchCore): void {
  core.state.ball.vel.x = 0;
  core.state.ball.vel.z = 0;
  core.state.ball.pos.x = 0;
  core.state.ball.pos.z = 0;
}

test("the default is first to 3 goals within 3 minutes, then a minute of extra time", async () => {
  const { MATCH_SCORE_TO_WIN, MATCH_TIME, MATCH_EXTRA_TIME } = await import("@shared/constants");
  assert.equal(MATCH_SCORE_TO_WIN, 3);
  assert.equal(MATCH_TIME, 180_000);
  assert.equal(MATCH_EXTRA_TIME, 60_000);
});

test("when time runs out the higher score wins", () => {
  const core = new MatchCore(3, 1000);
  runUntil(core, "play");
  core.state = { ...core.state, score: { left: 1, right: 0 } };
  for (let i = 0; i < 70 && core.phase === "play"; i++) {
    parkBall(core);
    const events = core.tick([]);
    const end = events.find((e) => e.t === "end");
    if (end && end.t === "end") {
      assert.equal(end.winner, "left");
      assert.equal(end.byTime, true);
      assert.equal(core.phase, "over");
      return;
    }
  }
  assert.fail("time should have run out");
});

test("a tie with no extra time allowed is a draw", () => {
  const core = new MatchCore(3, 1000, 0);
  runUntil(core, "play");
  core.state = { ...core.state, score: { left: 2, right: 2 } };
  for (let i = 0; i < 70 && core.phase === "play"; i++) {
    parkBall(core);
    const end = core.tick([]).find((e) => e.t === "end");
    if (end && end.t === "end") {
      assert.equal(end.winner, "draw");
      assert.equal(end.byTime, true);
      return;
    }
  }
  assert.fail("time should have run out");
});

test("only time with the ball in play counts toward the clock", () => {
  const core = new MatchCore(3, 5000);
  assert.equal(core.timeLeftMs, 5000);
  runUntil(core, "play"); // the countdown does not use up the clock
  assert.equal(core.timeLeftMs, 5000);
  parkBall(core);
  for (let i = 0; i < 30; i++) {
    parkBall(core);
    core.tick([]);
  }
  assert.ok(core.timeLeftMs < 5000 && core.timeLeftMs > 4000);
});

test("reaching 3 goals ends the match before time runs out", () => {
  const core = inPlay(); // default: first to 3
  for (let g = 0; g < 3; g++) {
    aimAtRightGoal(core);
    core.tick([]);
    assert.equal(core.phase, "goal");
    if (g < 2) runUntil(core, "play");
  }
  const end = playToEnd(core);
  assert.equal(end.winner, "left");
  assert.equal(end.byTime, false);
  assert.deepEqual(end.score, { left: 3, right: 0 });
});

test("a goal at the buzzer still counts, then the clock decides", () => {
  const core = new MatchCore(3, 1500);
  runUntil(core, "play");
  // Run the clock down to the last tick, then score on it.
  while (core.timeLeftMs > TICK * 1.5) {
    parkBall(core);
    core.tick([]);
  }
  aimAtRightGoal(core);
  const events = core.tick([]);
  assert.ok(events.some((e) => e.t === "goal"), "the buzzer-beater counts");
  const end = playToEnd(core);
  assert.equal(end.winner, "left");
  assert.equal(end.byTime, true);
});

/** Run a parked-ball match until `phase`/event, returning every event seen. */
function drain(core: MatchCore, ticks: number): MatchEvent[] {
  const events: MatchEvent[] = [];
  for (let i = 0; i < ticks && core.phase !== "over"; i++) {
    if (core.phase === "play") parkBall(core);
    events.push(...core.tick([]));
  }
  return events;
}

test("a tie after regulation goes to sudden-death extra time", () => {
  const core = new MatchCore(3, 1000, 2000);
  runUntil(core, "play");
  core.state = { ...core.state, score: { left: 1, right: 1 } };
  const events = drain(core, 90); // just past the first second of play
  const extra = events.find((e) => e.t === "extra");
  assert.ok(extra && extra.t === "extra", "extra time starts");
  assert.equal(extra.ms, 2000);
  assert.equal(core.extraTime, true);
  assert.equal(core.phase, "play", "play carries on");
  assert.ok(!events.some((e) => e.t === "end"), "the match is not over");
  assert.ok(core.timeLeftMs > 1000, "the clock now counts the extra period");
});

test("the first goal in extra time wins, even from level", () => {
  const core = new MatchCore(3, 1000, 5000);
  runUntil(core, "play");
  core.state = { ...core.state, score: { left: 1, right: 1 } };
  drain(core, 90);
  assert.equal(core.extraTime, true);
  aimAtRightGoal(core);
  const goal = core.tick([]).find((e) => e.t === "goal");
  assert.ok(goal && goal.t === "goal");
  const end = playToEnd(core);
  assert.equal(end.winner, "left");
  assert.deepEqual(end.score, { left: 2, right: 1 });
});

test("still level when extra time runs out is a draw", () => {
  const core = new MatchCore(3, 500, 500);
  runUntil(core, "play");
  const events = drain(core, 200);
  assert.ok(events.some((e) => e.t === "extra"));
  const end = events.find((e) => e.t === "end");
  assert.ok(end && end.t === "end");
  assert.equal(end.winner, "draw");
  assert.equal(end.byTime, true);
});

test("a lead at the end of regulation wins without extra time", () => {
  const core = new MatchCore(3, 500, 5000);
  runUntil(core, "play");
  core.state = { ...core.state, score: { left: 0, right: 1 } };
  const events = drain(core, 120);
  assert.ok(!events.some((e) => e.t === "extra"), "no extra time when someone leads");
  const end = events.find((e) => e.t === "end");
  assert.ok(end && end.t === "end");
  assert.equal(end.winner, "right");
});
