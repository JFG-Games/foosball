import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import test, { after, before } from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { PROTOCOL_VERSION, type ClientMessage, type ServerMessage } from "@shared/protocol";

/**
 * The Vatar sandbox test bot: a platform match whose second player never
 * connects. The server plays that seat and posts the signed result.
 */
const RESULTS_SECRET = "vtr_rsec_test_fake";
const NONCE = "nonce-123";

interface Posted {
  path: string;
  body: string;
  timestamp: string;
  signature: string;
  auth: string;
}
const posted: Posted[] = [];

let vatar: Server;
let ws: WebSocketServer;
let url = "";
let lobbyModule: typeof import("../server/lobby");
let roomModule: typeof import("../server/room");

before(async () => {
  vatar = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const send = (status: number, body: unknown): void => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.method === "GET" && req.url === "/api/games/v1/matches/m1") {
        return send(200, {
          id: "m1",
          status: "playing",
          stake: 0,
          seats: 2,
          players: [
            { playerId: "dev-1", name: "Tester" },
            { playerId: "t_testbot", name: "Test Bot" },
          ],
          winner: null,
          nonce: NONCE,
          mode: "test",
        });
      }
      if (req.method === "POST" && req.url === "/api/games/v1/matches/m1/result") {
        posted.push({
          path: req.url,
          body: Buffer.concat(chunks).toString(),
          timestamp: String(req.headers["x-vatar-timestamp"]),
          signature: String(req.headers["x-vatar-signature"]),
          auth: String(req.headers.authorization),
        });
        return send(200, { id: "m1", status: "done" });
      }
      send(404, { error: "not_found" });
    });
  });
  await new Promise<void>((resolve) => vatar.listen(0, "127.0.0.1", () => resolve()));
  process.env.VATAR_API_BASE = `http://127.0.0.1:${(vatar.address() as AddressInfo).port}/api/games/v1`;
  process.env.VATAR_SECRET = "vtr_test_fake";
  process.env.VATAR_RESULTS_SECRET = RESULTS_SECRET;
  process.env.VATAR_SANDBOX = "true";
  process.env.TEST_BOT_WAIT_MS = "150";
  process.env.DATA_DIR = "memory";

  lobbyModule = await import("../server/lobby");
  roomModule = await import("../server/room");
  const lobby = new lobbyModule.Lobby();
  ws = new WebSocketServer({ port: 0 });
  ws.on("connection", (socket) => {
    socket.on("message", (raw) => lobby.handle(socket, JSON.parse(raw.toString()) as ClientMessage));
    socket.on("close", () => lobby.disconnect(socket));
  });
  await new Promise<void>((resolve) => ws.once("listening", () => resolve()));
  url = `ws://127.0.0.1:${(ws.address() as AddressInfo).port}`;
});

after(() => {
  for (const c of ws.clients) c.terminate();
  ws.close();
  vatar.close();
});

test("a lone player in a Vatar match is seated against the test bot, and the match starts", async () => {
  const socket = new WebSocket(url);
  const log: ServerMessage[] = [];
  socket.on("message", (raw) => log.push(JSON.parse(raw.toString()) as ServerMessage));
  await new Promise<void>((resolve) => socket.once("open", () => resolve()));
  const send = (m: ClientMessage): void => socket.send(JSON.stringify(m));
  const until = async (pred: () => boolean, ms = 3000): Promise<void> => {
    const t0 = Date.now();
    while (!pred()) {
      if (Date.now() - t0 > ms) throw new Error("timed out");
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  send({ t: "join", sessionToken: "sandbox-token", protocol: PROTOCOL_VERSION, vatarMatchId: "m1", name: "Tester" });
  await until(() => log.some((m) => m.t === "waiting"));
  assert.equal(log.some((m) => m.t === "peer"), false, "nobody else yet");

  await until(() => log.some((m) => m.t === "peer"));
  const peer = log.find((m) => m.t === "peer");
  assert.ok(peer && peer.t === "peer");
  assert.equal(peer.player.displayName, "Test Bot");
  assert.equal(peer.player.id, "t_testbot");

  await until(() => log.some((m) => m.t === "opponent" && m.ready));
  send({ t: "ready" });
  await until(() => log.some((m) => m.t === "start"));
  await until(() => log.filter((m) => m.t === "snapshot").length > 3);
  socket.close();
});

test("the result is looked up, signed with the results secret and posted for the human player", async () => {
  const { Room } = roomModule;
  const fake = (): never => ({ readyState: 1, OPEN: 1, send() {} }) as never;
  const room = new Room("TEST1", () => {});
  room.seat({ id: "dev-1", displayName: "Tester", team: "left" }, fake(), "m1");
  room.seatBot({ id: "t_testbot", displayName: "Test Bot", team: "right" }, "pro", "m1");

  await (room as unknown as { reportResult(winner: string): Promise<void> }).reportResult("left");
  room.stop();

  assert.equal(posted.length, 1);
  const p = posted[0];
  assert.equal(p.path, "/api/games/v1/matches/m1/result");
  assert.deepEqual(JSON.parse(p.body), { winner: "dev-1" });
  assert.equal(p.auth, "Bearer vtr_test_fake");

  // Recompute the documented signature: method, path, timestamp, nonce, sha256(body), joined by newlines.
  const canonical = ["POST", "/api/games/v1/matches/m1/result", p.timestamp, NONCE, createHash("sha256").update(p.body).digest("hex")].join("\n");
  const expected = "v1=" + createHmac("sha256", RESULTS_SECRET).update(canonical).digest("hex");
  assert.equal(p.signature, expected);
});
