import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import test, { after, before } from "node:test";

/**
 * Purchase fulfilment, against a fake Vatar API. The server reads its config
 * from the environment at import time, so everything is set up before the
 * dynamic imports below.
 */
const WEBHOOK_SECRET = "vtr_whsec_test_fake";

const purchases: Record<string, { id: string; productId: string; playerId: string; status: string }> = {
  pur_alice: { id: "pur_alice", productId: "gold_kit", playerId: "t_alice", status: "paid" },
  pur_refunded: { id: "pur_refunded", productId: "gold_kit", playerId: "t_alice", status: "refunded" },
  pur_hook: { id: "pur_hook", productId: "gold_kit", playerId: "t_carol", status: "paid" },
};
const delivered: string[] = [];

let vatar: Server;
let game: Server;
let base = "";

before(async () => {
  vatar = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const send = (status: number, body: unknown): void => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      const url = req.url ?? "";
      if (url === "/session/verify") {
        const { session } = JSON.parse(Buffer.concat(chunks).toString()) as { session: string };
        const who = session.replace("sess-", "");
        if (!session.startsWith("sess-")) return send(401, { error: "bad_session" });
        return send(200, { playerId: `t_${who}`, name: who, gameId: "g", exp: 0, mode: "test" });
      }
      const deliver = url.match(/^\/purchases\/([^/]+)\/deliver$/);
      if (deliver && req.method === "POST") {
        delivered.push(deliver[1]);
        return send(200, { id: deliver[1], status: "delivered" });
      }
      const one = url.match(/^\/purchases\/([^/]+)$/);
      if (one && purchases[one[1]]) return send(200, purchases[one[1]]);
      send(404, { error: "not_found" });
    });
  });
  await new Promise<void>((resolve) => vatar.listen(0, "127.0.0.1", () => resolve()));
  const port = (vatar.address() as AddressInfo).port;

  process.env.VATAR_API_BASE = `http://127.0.0.1:${port}`;
  process.env.VATAR_SECRET = "vtr_test_fake";
  process.env.VATAR_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.DATA_DIR = "memory";

  const { createHttpServer } = await import("../server/http");
  game = createHttpServer();
  await new Promise<void>((resolve) => game.listen(0, "127.0.0.1", () => resolve()));
  base = `http://127.0.0.1:${(game.address() as AddressInfo).port}`;
});

after(() => {
  vatar.close();
  game.close();
});

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

test("a player claims their own purchase: it is granted, delivered and listed", async () => {
  const res = await post("/claim", { session: "sess-alice", purchaseId: "pur_alice" });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { productId: "gold_kit", items: ["gold_kit"] });
  assert.ok(delivered.includes("pur_alice"));

  const owned = await post("/entitlements", { session: "sess-alice" });
  assert.deepEqual(await owned.json(), { items: ["gold_kit"] });
});

test("claiming twice is safe and grants nothing extra", async () => {
  const res = await post("/claim", { session: "sess-alice", purchaseId: "pur_alice" });
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).items, ["gold_kit"]);
});

test("someone else's purchase, a refund, an unknown id and a bad session are refused", async () => {
  assert.equal((await post("/claim", { session: "sess-bob", purchaseId: "pur_alice" })).status, 403);
  assert.equal((await post("/claim", { session: "sess-alice", purchaseId: "pur_refunded" })).status, 409);
  assert.equal((await post("/claim", { session: "sess-alice", purchaseId: "nope" })).status, 404);
  assert.equal((await post("/claim", { session: "garbage", purchaseId: "pur_alice" })).status, 401);
  assert.equal((await post("/claim", { session: "sess-alice" })).status, 400);
  assert.deepEqual(await (await post("/entitlements", { session: "sess-bob" })).json(), { items: [] });
});

test("a signed purchase.paid webhook fulfils the purchase; an unsigned one is rejected", async () => {
  const body = JSON.stringify({ id: "evt_1", type: "purchase.paid", mode: "test", data: { purchaseId: "pur_hook" } });
  const signature = "sha256=" + createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex");

  assert.equal((await post("/vatar-webhook", body, { "x-vatar-signature": "sha256=deadbeef" })).status, 401);
  assert.equal((await post("/vatar-webhook", body)).status, 401);
  assert.equal((await post("/vatar-webhook", body, { "x-vatar-signature": signature })).status, 200);

  await new Promise((r) => setTimeout(r, 200));
  assert.ok(delivered.includes("pur_hook"));
  assert.deepEqual(await (await post("/entitlements", { session: "sess-carol" })).json(), { items: ["gold_kit"] });
});

test("CORS preflight is answered for the game page on another origin", async () => {
  const res = await fetch(base + "/claim", { method: "OPTIONS" });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
});
