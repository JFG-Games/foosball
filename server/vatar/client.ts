import { VATAR_API_BASE, VATAR_GAME_ID, VATAR_SANDBOX, VATAR_SECRET } from "../config";

/**
 * Server-side Vatar Games (Lagos Life) REST client.
 *
 * Every secret-bearing call lives here so the browser never sees VATAR_SECRET.
 * Base URL and payload shapes follow the published docs and may still change;
 * confirm field names in the sandbox before going live.
 *
 * Docs: https://lagoslife.app/developers/docs
 */

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${VATAR_API_BASE}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${VATAR_SECRET}`,
      "x-vatar-game-id": VATAR_GAME_ID,
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
  displayName: string;
  gameId: string;
  expiresAt: number;
  mode: string;
}

/** POST /session/verify — validate a player's short-lived session token. */
export async function verifySession(sessionToken: string): Promise<VerifiedSession> {
  return api<VerifiedSession>("/session/verify", {
    method: "POST",
    body: JSON.stringify({ sessionToken }),
  });
}

/** A purchase record, priced in naira. */
export interface Purchase {
  id: string;
  playerId: string;
  productId: string;
  amount: number;
  currency: string;
  status: string;
}

/** GET /purchases/{id} — look up a purchase before delivering it. */
export async function getPurchase(id: string): Promise<Purchase> {
  return api<Purchase>(`/purchases/${id}`);
}

/** POST /purchases/{id}/deliver — mark a verified purchase as delivered. */
export async function deliverPurchase(id: string): Promise<{ ok: boolean }> {
  return api<{ ok: boolean }>(`/purchases/${id}/deliver`, { method: "POST" });
}

/** POST /matches/{id}/result — report a finished match. Requires an HMAC signature. */
export async function submitMatchResult(
  matchId: string,
  result: { left: number; right: number },
): Promise<{ ok: boolean }> {
  // TODO: sign the body with HMAC-SHA256 using VATAR_SECRET and send the
  // signature header the docs require. Never send the secret itself.
  return api<{ ok: boolean }>(`/matches/${matchId}/result`, {
    method: "POST",
    body: JSON.stringify(result),
  });
}

/** True when running against sandbox/test keys. */
export const sandbox = VATAR_SANDBOX;
