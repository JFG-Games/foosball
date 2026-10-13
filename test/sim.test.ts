import assert from "node:assert/strict";
import test from "node:test";
import { MAX_ROD_SLIDE, STUCK_TICKS, TABLE, TEAM_RODS } from "@shared/constants";
import { initialState, manPositions, step } from "@shared/sim";
import type { PlayerInput, Snapshot } from "@shared/types";

/** Build an input bundle for one tick on a single rod. */
function input(tick: number, rods: Record<number, { angle: number; offset: number }>): PlayerInput {
  return { seq: tick, tick, rods };
}

/** Advance a state by `steps` ticks, reusing one input generator. */
function run(steps: number, makeInputs: (tick: number, state: Snapshot) => PlayerInput[]): Snapshot {
  let state = initialState();
  for (let tick = 0; tick < steps; tick++) {
    state = step(state, makeInputs(tick, state), 1000 / 60).next;
  }
  return state;
}

/** A deterministic, varied input stream — no Math.random. */
function scripted(tick: number): PlayerInput[] {
  const angle = Math.sin(tick * 0.11) * Math.PI;
  const offset = Math.sin(tick * 0.07);
  return [
    input(tick, { 0: { angle, offset }, 2: { angle: -angle, offset }, 4: { angle, offset: -offset } }),
    input(tick, { 7: { angle: -angle, offset }, 5: { angle, offset: -offset } }),
  ];
}

test("identical inputs produce identical state", () => {
  const a = run(400, scripted);
  const b = run(400, scripted);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.equal(a.tick, 400);
});

test("a match is deterministic end to end", () => {
  // Two independent 900-tick runs must agree on the final score too.
  const first = run(900, scripted);
  const second = run(900, scripted);
  assert.deepEqual(first.score, second.score);
  assert.equal(first.serverTimeMs, second.serverTimeMs);
});

test("rods follow input and clamp to their limits", () => {
  const state = step(initialState(), [input(0, { 0: { angle: 99, offset: 99 } })], 1000 / 60).next;
  assert.equal(state.rods[0].angle, Math.PI, "angle clamped to MAX_ROD_ANGLE");
  assert.equal(state.rods[0].offset, 1, "offset clamped to 1");

  const slid = step(initialState(), [input(0, { 0: { angle: 0, offset: -99 } })], 1000 / 60).next;
  assert.equal(slid.rods[0].offset, -1, "offset clamped to -1");
});

test("sliding a rod moves its men across the table, not along it", () => {
  const centred = manPositions(4, { angle: 0, offset: 0 });
  const slid = manPositions(4, { angle: 0, offset: 1 });
  assert.equal(slid[0].z - centred[0].z, MAX_ROD_SLIDE, "full slide shifts z by the limit");
  assert.equal(slid[0].x, centred[0].x, "sliding must not move a man along x");
});

test("a stopped ball is re-served instead of soft-locking the match", () => {
  // A pocket near the goal that no rod can reach — the live-test dead zone.
  const start = initialState();
  start.ball.pos = { x: -0.459, y: TABLE.ballRadius, z: 0.253 };

  const before = step(start, [], 1000 / 60).next;
  assert.equal(before.ball.pos.x, -0.459, "the ball stays put while the grace period runs");

  let state = start;
  for (let tick = 0; tick < STUCK_TICKS; tick++) {
    state = step(state, [], 1000 / 60).next;
  }
  assert.equal(state.ball.pos.x, 0, "re-served to the centre spot");
  assert.equal(state.ball.pos.z, 0);
  assert.equal(state.stuckTicks, 0, "the counter resets after a re-serve");
});

test("the ball never leaves the table", () => {
  const state = run(600, (tick) => [
    input(tick, { 4: { angle: (tick % 2) * Math.PI, offset: 0 } }),
    input(tick, { 3: { angle: (tick % 3) * Math.PI, offset: 0 } }),
  ]);

  assert.ok(Math.abs(state.ball.pos.x) <= TABLE.length / 2, "x within the table");
  assert.ok(Math.abs(state.ball.pos.z) <= TABLE.width / 2, "z within the table");
  assert.ok(Number.isFinite(state.ball.pos.x) && Number.isFinite(state.ball.pos.z));
  assert.ok(Math.hypot(state.ball.vel.x, state.ball.vel.z) <= 6.0000001, "speed stays capped");
});

test("spinning a rod kicks a resting ball", () => {
  const start = initialState();
  // Rod 4 is the left midfield (5 men, centred on z = 0). Put the ball on the
  // foot's path and sweep the rod a quarter turn in one tick.
  start.ball.pos.x = 0.08 + 0.02;
  start.ball.pos.z = 0;
  const next = step(start, [input(0, { 4: { angle: Math.PI / 2, offset: 0 } })], 1000 / 60).next;
  const speed = Math.hypot(next.ball.vel.x, next.ball.vel.z);
  assert.ok(speed > 0.5, `ball should be moving, got ${speed}`);
});

test("a fast sweep does not tunnel through the ball", () => {
  const start = initialState();
  start.rods[4] = { angle: -Math.PI / 2, offset: 0 };
  start.ball.pos.x = 0.08;
  start.ball.pos.z = 0;
  // The foot travels 0.1 m in this single tick — far more than its radius.
  const next = step(start, [input(0, { 4: { angle: Math.PI / 2, offset: 0 } })], 1000 / 60).next;
  const speed = Math.hypot(next.ball.vel.x, next.ball.vel.z);
  assert.ok(speed > 0.5, `swept collision should connect, got ${speed}`);
});

test("a ball crossing the goal mouth scores for the other team", () => {
  const start = initialState();
  start.ball.pos.x = TABLE.length / 2 - TABLE.ballRadius - 0.005;
  start.ball.pos.z = 0; // inside the mouth
  start.ball.vel.x = 3;

  const result = step(start, [], 1000 / 60);
  assert.equal(result.scored, "left", "the left team scores in the right goal");
  assert.equal(result.next.score.left, 1);
  assert.equal(result.next.score.right, 0);
  assert.equal(result.next.ball.pos.x, 0, "ball is re-served from the centre");
  assert.equal(result.next.ball.vel.x, 0);
});

test("a shot outside the mouth rebounds instead of scoring", () => {
  const start = initialState();
  start.ball.pos.x = TABLE.length / 2 - TABLE.ballRadius - 0.005;
  start.ball.pos.z = TABLE.width / 2 - 0.05; // outside the goal band
  start.ball.vel.x = 3;

  const result = step(start, [], 1000 / 60);
  assert.equal(result.scored, null);
  assert.equal(result.next.score.left, 0);
  assert.ok(result.next.ball.vel.x < 0, "ball rebounds off the end rail");
});

test("each team controls four rods, goal to attack", () => {
  assert.equal(TEAM_RODS.left.length, 4);
  assert.equal(TEAM_RODS.right.length, 4);
  assert.deepEqual(TEAM_RODS.left, [0, 2, 4, 6]);
  assert.deepEqual(TEAM_RODS.right, [7, 5, 3, 1]);
});
