import assert from "node:assert/strict";
import test from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { PROTOCOL_VERSION, type ClientMessage, type ServerMessage } from "@shared/protocol";
import { Lobby } from "../server/lobby";

/** Boot a Lobby behind a real WebSocket server on a free port. */
async function boot(): Promise<{ url: string; close(): Promise<void> }> {
  const lobby = new Lobby();
  const wss = new WebSocketServer({ port: 0 });
  wss.on("connection", (socket) => {
    socket.on("message", (raw) => lobby.handle(socket, JSON.parse(raw.toString()) as ClientMessage));
    socket.on("close", () => lobby.disconnect(socket));
  });
  await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
  const { port } = wss.address() as { port: number };
  return {
    url: `ws://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => { for (const c of wss.clients) c.terminate(); wss.close(() => resolve()); }),
  };
}

/** A test client that records every message and lets you await one by type. */
async function client(url: string) {
  const socket = new WebSocket(url);
  const log: ServerMessage[] = [];
  const waiters: { t: string; resolve: (m: ServerMessage) => void }[] = [];
  socket.on("message", (raw) => {
    const msg = JSON.parse(raw.toString()) as ServerMessage;
    log.push(msg);
    for (const w of [...waiters]) {
      if (w.t === msg.t) { waiters.splice(waiters.indexOf(w), 1); w.resolve(msg); }
    }
  });
  await new Promise<void>((resolve) => socket.once("open", () => resolve()));
  return {
    log,
    send: (m: ClientMessage) => socket.send(JSON.stringify(m)),
    close: () => socket.close(),
    next: <T extends ServerMessage["t"]>(t: T, ms = 3000) =>
      new Promise<Extract<ServerMessage, { t: T }>>((resolve, reject) => {
        const found = log.find((m) => m.t === t);
        if (found) return resolve(found as Extract<ServerMessage, { t: T }>);
        const timer = setTimeout(() => reject(new Error(`timed out waiting for "${t}"`)), ms);
        waiters.push({ t, resolve: (m) => { clearTimeout(timer); resolve(m as Extract<ServerMessage, { t: T }>); } });
      }),
  };
}

const join = (extra: Partial<Extract<ClientMessage, { t: "join" }>> = {}): ClientMessage => ({
  t: "join", sessionToken: "sandbox-token", protocol: PROTOCOL_VERSION, ...extra,
});

test("two quick-match players are paired and the match starts", async () => {
  const server = await boot();
  try {
    const a = await client(server.url);
    const b = await client(server.url);
    a.send(join({ name: "Ada" }));
    assert.equal((await a.next("waiting")).message.length > 0, true);
    b.send(join({ name: "Bola" }));

    const [wa, wb] = await Promise.all([a.next("welcome"), b.next("welcome")]);
    assert.equal(wa.player.team, "left");
    assert.equal(wb.player.team, "right");
    assert.equal(wa.player.displayName, "Ada");

    // Nothing starts until both players say they're ready.
    assert.equal((await a.next("opponent")).ready, false);
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(a.log.some((m) => m.t === "start"), false, "no start before ready");
    a.send({ t: "ready" });
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(b.log.some((m) => m.t === "opponent" && m.ready), "the other side hears that A is ready");
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(a.log.some((m) => m.t === "start"), false, "still waiting for B (in the tutorial)");
    b.send({ t: "ready" });
    const start = await a.next("start");
    assert.ok(start.countdownMs > 0);
    const snap = await a.next("snapshot");
    assert.equal(snap.snapshot.epoch, 0);
    a.close(); b.close();
  } finally { await server.close(); }
});

test("a friend joins a private room with its code", async () => {
  const server = await boot();
  try {
    const host = await client(server.url);
    host.send(join({ create: true }));
    const waiting = await host.next("waiting");
    assert.ok(waiting.roomCode && waiting.roomCode.length === 5);

    const friend = await client(server.url);
    friend.send(join({ roomCode: waiting.roomCode!.toLowerCase() }));
    await Promise.all([host.next("welcome"), friend.next("welcome")]);
    host.send({ t: "ready" });
    friend.send({ t: "ready" });
    await Promise.all([host.next("start"), friend.next("start")]);

    const third = await client(server.url);
    third.send(join({ roomCode: waiting.roomCode }));
    assert.equal((await third.next("error")).code, "room_full");
    host.close(); friend.close(); third.close();
  } finally { await server.close(); }
});

test("an unknown code and an outdated client are rejected", async () => {
  const server = await boot();
  try {
    const a = await client(server.url);
    a.send(join({ roomCode: "ZZZZZ" }));
    assert.equal((await a.next("error")).code, "room_not_found");

    const old = await client(server.url);
    old.send({ ...join(), protocol: PROTOCOL_VERSION - 1 } as ClientMessage);
    assert.equal((await old.next("error")).code, "outdated");
    a.close(); old.close();
  } finally { await server.close(); }
});

test("hostile input cannot poison the simulation or reach the other side's rods", async () => {
  const server = await boot();
  try {
    const a = await client(server.url);
    const b = await client(server.url);
    a.send(join()); await a.next("waiting");
    b.send(join());
    await Promise.all([a.next("welcome"), b.next("welcome")]);
    a.send({ t: "ready" }); b.send({ t: "ready" });
    await Promise.all([a.next("start"), b.next("start")]);

    // NaN becomes null over JSON; also try an opponent rod (7 belongs to the right team).
    const rods = { 0: { angle: null, offset: 0.5 }, 7: { angle: 1, offset: 1 }, 2: { angle: 0.3, offset: -0.2 } };
    for (let i = 0; i < 20; i++) {
      a.send({ t: "input", input: { seq: i, tick: i, rods } as never });
      await new Promise((r) => setTimeout(r, 20));
    }
    await new Promise((r) => setTimeout(r, 200));
    const snaps = a.log.filter((m) => m.t === "snapshot");
    const last = snaps[snaps.length - 1];
    assert.ok(last && last.t === "snapshot");
    for (const rod of last.snapshot.rods) {
      assert.ok(Number.isFinite(rod.angle) && Number.isFinite(rod.offset));
    }
    assert.equal(last.snapshot.rods[7].offset, 0, "the right team's goalie is untouched");
    assert.equal(last.snapshot.rods[2].offset, -0.2, "own rods do move");
    a.close(); b.close();
  } finally { await server.close(); }
});

test("leaving mid-match awards the win to the one who stays", async () => {
  const server = await boot();
  try {
    const a = await client(server.url);
    const b = await client(server.url);
    a.send(join()); await a.next("waiting");
    b.send(join());
    await Promise.all([a.next("welcome"), b.next("welcome")]);
    a.send({ t: "ready" }); b.send({ t: "ready" });
    await Promise.all([a.next("start"), b.next("start")]);
    b.close();
    const end = await a.next("end");
    assert.equal(end.winner, "left");
    assert.equal(end.forfeit, true);
    a.close();
  } finally { await server.close(); }
});
