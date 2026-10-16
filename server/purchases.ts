import { createHmac, timingSafeEqual } from "node:crypto";
import { VATAR_WEBHOOK_SECRET } from "./config";
import { store } from "./store";
import { deliverPurchase, getPurchase, verifySession, type Purchase } from "./vatar/client";

/** A refusal with the HTTP status to answer with. */
export class PurchaseError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Verify a purchase with Vatar, give the item once, then mark it delivered.
 *
 * `expectedPlayerId` is set when a player claims their own purchase; a webhook
 * has no player to check against, only Vatar's own record of who paid.
 * Safe to call repeatedly: each purchase id is granted once and delivering
 * again returns the same answer.
 */
export async function fulfil(purchaseId: string, expectedPlayerId?: string): Promise<Purchase> {
  const purchase = await getPurchase(purchaseId).catch(() => {
    throw new PurchaseError(404, "Unknown purchase");
  });
  if (expectedPlayerId !== undefined && purchase.playerId !== expectedPlayerId) {
    throw new PurchaseError(403, "That purchase belongs to someone else");
  }
  if (purchase.status === "refunded") throw new PurchaseError(409, "That purchase was refunded");

  if (await store.grant(purchase.playerId, purchase.productId, purchase.id)) {
    console.log(`[purchase] granted ${purchase.productId} to ${purchase.playerId} (${purchase.id})`);
  }
  await deliverPurchase(purchase.id);
  return purchase;
}

/** A player claims one of their own purchases using a fresh session token. */
export async function claim(session: string, purchaseId: string): Promise<{ productId: string; items: string[] }> {
  const me = await verifySession(session).catch(() => {
    throw new PurchaseError(401, "Session not valid");
  });
  const purchase = await fulfil(purchaseId, me.playerId);
  return { productId: purchase.productId, items: await store.items(me.playerId) };
}

/** Everything a verified player owns. */
export async function entitlements(session: string): Promise<string[]> {
  const me = await verifySession(session).catch(() => {
    throw new PurchaseError(401, "Session not valid");
  });
  return store.items(me.playerId);
}

/** `X-Vatar-Signature: sha256=<hex HMAC-SHA256 of the raw body>`, keyed with the webhook signing secret. */
export function webhookSigned(raw: Buffer, header: string | undefined): boolean {
  if (!VATAR_WEBHOOK_SECRET) return false;
  const want = Buffer.from("sha256=" + createHmac("sha256", VATAR_WEBHOOK_SECRET).update(raw).digest("hex"));
  const got = Buffer.from(String(header ?? ""));
  return want.length === got.length && timingSafeEqual(want, got);
}
