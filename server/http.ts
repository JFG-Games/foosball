import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { claim, entitlements, fulfil, PurchaseError, webhookSigned } from "./purchases";

/**
 * The HTTP side of the server, next to the game WebSocket:
 *
 *   POST /claim          { session, purchaseId }  verify + deliver a purchase
 *   POST /entitlements   { session }              what this player owns
 *   POST /vatar-webhook                           Vatar's `purchase.paid` nudge
 *   GET  /health
 *
 * The game page lives on another origin, so these answer CORS. They carry no
 * cookies: a Vatar session token is the only credential.
 */
const MAX_BODY = 16 * 1024;

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, GET, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400",
};

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new PurchaseError(413, "Body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", ...CORS });
  res.end(JSON.stringify(body));
}

function fields(raw: Buffer): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw.toString("utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const text = (value: unknown, max: number): string => (typeof value === "string" ? value.slice(0, max) : "");

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = (req.url ?? "/").split("?")[0];

  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS).end();
    return;
  }
  if (req.method === "GET" && (path === "/" || path === "/health")) {
    json(res, 200, { ok: true });
    return;
  }
  if (req.method !== "POST") {
    json(res, 404, { error: "not_found" });
    return;
  }

  const raw = await readBody(req);

  if (path === "/claim") {
    const body = fields(raw);
    const session = text(body.session, 2000);
    const purchaseId = text(body.purchaseId, 100);
    if (!session || !purchaseId) throw new PurchaseError(400, "session and purchaseId are required");
    json(res, 200, await claim(session, purchaseId));
    return;
  }

  if (path === "/entitlements") {
    const session = text(fields(raw).session, 2000);
    if (!session) throw new PurchaseError(400, "session is required");
    json(res, 200, { items: await entitlements(session) });
    return;
  }

  if (path === "/vatar-webhook") {
    if (!webhookSigned(raw, req.headers["x-vatar-signature"] as string | undefined)) {
      json(res, 401, { error: "bad_signature" });
      return;
    }
    const event = fields(raw);
    const data = (event.data ?? {}) as Record<string, unknown>;
    // Answer inside Vatar's 5 s window; the purchase is checked with the API before anything is given.
    json(res, 200, { ok: true });
    if (event.type === "purchase.paid" && typeof data.purchaseId === "string") {
      fulfil(data.purchaseId).catch((error) =>
        console.warn("[webhook] could not fulfil", data.purchaseId, error instanceof Error ? error.message : error),
      );
    }
    return;
  }

  json(res, 404, { error: "not_found" });
}

export function createHttpServer(): Server {
  return createServer((req, res) => {
    route(req, res).catch((error) => {
      if (res.headersSent) return void res.end();
      const status = error instanceof PurchaseError ? error.status : 502;
      if (!(error instanceof PurchaseError)) console.warn("[http]", error instanceof Error ? error.message : error);
      json(res, status, { error: error instanceof Error ? error.message : "failed" });
    });
  });
}
