import { createHash, createHmac } from "node:crypto";
import {
  VATAR_API_BASE,
  VATAR_GAME_ID,
  VATAR_RESULTS_SECRET,
  VATAR_SANDBOX,
  VATAR_SECRET,
} from "../config";

/**
 * Server-side Vatar Games (Lagos Life) REST client.
 *
 * Every secret-bearing call lives here so the browser never sees VATAR_SECRET.
 * Shapes follow https://lagoslife.app/developers/docs (checked 2026-10).
 */

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${VATAR_API_BASE}${path}`, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(8000),
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${VATAR_SECRET}`,
      ...(init.headers ?? {}),
    },
  });

  if (!res.ok) {
    throw new Error(`Vatar API ${path} failed: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

/** A player identity returned by session verification. */
export interface VerifiedSession {
  playerId: string;
  name: string;
  gameId: string;
  /** Expiry, per the docs a token lives 15 minutes. */
  exp: number;
  mode: string;
}

/** POST /session/verify — validate a player's short-lived session token. */
export async function verifySession(session: string): Promise<VerifiedSession> {
  const verified = await api<VerifiedSession>("/session/verify", {
    method: "POST",
    body: JSON.stringify({ session }),
  });
  if (VATAR_GAME_ID && verified.gameId && verified.gameId !== VATAR_GAME_ID) {
    throw new Error("Session was issued for a different game");
  }
  return verified;
}

/** A purchase record, priced in naira. */
export interface Purchase {
  id: string;
  productId: string;
  playerId: string;
  amount: number;
  currency: string;
  status: "paid" | "delivered" | "refunded";
  createdAt: string;
  mode: string;
}

/** GET /purchases/{id} — look up a purchase before delivering it. */
export async function getPurchase(id: string): Promise<Purchase> {
  return api<Purchase>(`/purchases/${encodeURIComponent(id)}`);
}

/** POST /purchases/{id}/deliver — mark a verified purchase as delivered. */
export async function deliverPurchase(id: string): Promise<{ id: string; status: "delivered"; deliveredAt: string }> {
  return api(`/purchases/${encodeURIComponent(id)}/deliver`, { method: "POST" });
}

/** A platform match (created through `Vatar.match.*` in the browser). */
export interface VatarMatch {
  id: string;
  status: "open" | "playing" | "done" | "cancelled" | "void";
  stake: number;
  seats: number;
  players: { playerId: string; name: string }[];
  winner: string | null;
  nonce: string;
  mode: string;
}

/** GET /matches/{id} */
export async function getMatch(id: string): Promise<VatarMatch> {
  return api<VatarMatch>(`/matches/${encodeURIComponent(id)}`);
}

/**
 * The string that is HMAC-signed for a result, exactly as documented:
 * method, path, timestamp, the match nonce and the SHA-256 of the body,
 * one per line.
 */
export function resultSigningString(path: string, timestamp: number, nonce: string, body: string): string {
  const bodyHash = createHash("sha256").update(body).digest("hex");
  return ["POST", path, String(timestamp), nonce, bodyHash].join("\n");
}

/**
 * POST /matches/{id}/result — report who won a platform match.
 *
 * Needs VATAR_RESULTS_SECRET. The match must be `playing`, and a result only
 * settles once, so callers must never retry with a different winner.
 */
export async function submitMatchResult(matchId: string, winner: string | "draw"): Promise<VatarMatch> {
  if (!VATAR_RESULTS_SECRET) throw new Error("VATAR_RESULTS_SECRET is not set");

  const match = await getMatch(matchId);
  if (match.status !== "playing") throw new Error(`Match ${matchId} is ${match.status}, not playing`);

  const path = `${new URL(VATAR_API_BASE).pathname.replace(/\/$/, "")}/matches/${encodeURIComponent(matchId)}/result`;
  const body = JSON.stringify({ winner });
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac("sha256", VATAR_RESULTS_SECRET)
    .update(resultSigningString(path, timestamp, match.nonce, body))
    .digest("hex");

  const res = await fetch(`${new URL(VATAR_API_BASE).origin}${path}`, {
    method: "POST",
    body,
    signal: AbortSignal.timeout(8000),
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${VATAR_SECRET}`,
      "x-vatar-timestamp": String(timestamp),
      "x-vatar-signature": `v1=${signature}`,
    },
  });
  if (!res.ok) throw new Error(`Vatar result for ${matchId} failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as VatarMatch;
}

/** True when running against sandbox/test keys. */
export const sandbox = VATAR_SANDBOX;
