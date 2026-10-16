import { API_URL, VATAR_SDK_URL } from "../config";
import { readStat, settings, writeStat } from "../settings";

/**
 * Wrapper around the Lagos Life / Vatar Games browser SDK.
 *
 * What the game uses from the platform:
 *   identity     name + avatar shown on the menu and scoreboard
 *   session      a fresh token on every join (they expire after 15 minutes)
 *   leaderboard  top scores + your rank, and a score submitted after each match
 *   pause/resume the shell asks us to stop (a call, a tab switch…) and we do
 *   match        if the player came from a platform match, results go to it
 *
 * Every secret-bearing call is server-side (server/vatar/client.ts). Opened
 * outside the Lagos Life shell the SDK doesn't exist, so everything here has a
 * local fallback and the game stays fully playable.
 */

export interface Identity {
  id: string;
  name: string;
  avatar?: string;
  /** Session token for the game server. */
  session: string;
  /** "sandbox" / "live" from the platform, or "local" outside it. */
  mode: string;
  /** True when talking to the real platform. */
  connected: boolean;
}

export interface Leaderboard {
  top: { rank: number; name: string; score: number }[];
  me: { rank: number; label: string; score: number } | null;
  /** True when the numbers are only this device's own. */
  local: boolean;
}

/** Add the SDK <script> and wait for `window.Vatar`. Resolves false on timeout or error. */
function loadSdk(timeoutMs = 3000): Promise<boolean> {
  if (typeof window === "undefined") return Promise.resolve(false);
  if (window.Vatar) return Promise.resolve(true);
  return new Promise((resolve) => {
    const script = document.createElement("script");
    script.src = VATAR_SDK_URL;
    script.async = true;
    const timer = window.setTimeout(() => resolve(false), timeoutMs);
    script.onload = () => {
      window.clearTimeout(timer);
      resolve(Boolean(window.Vatar));
    };
    script.onerror = () => {
      window.clearTimeout(timer);
      resolve(false);
    };
    document.head.appendChild(script);
  });
}

let identity: Identity | null = null;
let sdkReady = false;

export async function initVatar(): Promise<Identity> {
  sdkReady = await loadSdk();
  if (sdkReady && window.Vatar) {
    try {
      const res = await window.Vatar.init();
      identity = {
        id: res.player.id,
        name: res.player.name,
        avatar: res.player.avatar,
        session: res.session,
        mode: res.mode,
        connected: true,
      };
      return identity;
    } catch (error) {
      console.warn("[vatar] init failed, playing locally", error);
      sdkReady = false;
    }
  }

  // Local development fallback.
  console.info("[vatar] SDK not available (%s) — using a local session", VATAR_SDK_URL);
  identity = {
    id: "local-dev",
    name: settings.name || "Player",
    session: "sandbox-token",
    mode: "local",
    connected: false,
  };
  return identity;
}

/** A session token that has not expired. */
export async function freshSession(): Promise<string> {
  if (sdkReady && window.Vatar) {
    try {
      return (await window.Vatar.session()).session;
    } catch {
      /* fall back to the one we have */
    }
  }
  return identity?.session ?? "sandbox-token";
}

/** Ask the platform to tell us when to stop and start. */
export function onPlatformPause(pause: () => void, resume: () => void): void {
  if (!sdkReady || !window.Vatar) return;
  window.Vatar.onPause(pause);
  window.Vatar.onResume(resume);
}

/** The platform match the player is currently in, if they came from one. */
export async function currentMatchId(): Promise<string | undefined> {
  if (!sdkReady || !window.Vatar?.match) return undefined;
  try {
    const match = await window.Vatar.match.current();
    return match && match.status === "playing" ? match.id : undefined;
  } catch {
    return undefined;
  }
}

/* ─────────────────────────────── scores ─────────────────────────────── */

/** The platform accepts one score per player every 20 s, so hold the best one back until then. */
const SUBMIT_GAP_MS = 20_500;
let lastSubmit = -Infinity;
let pending: number | null = null;
let pendingTimer: number | null = null;

export interface SubmitResult {
  /** Your best score on the platform (or on this device). */
  best: number;
  /** Was this a new personal best? */
  isBest: boolean;
  /** Sent now, or queued behind the rate limit. */
  sent: boolean;
}

export async function submitScore(score: number): Promise<SubmitResult> {
  const previousBest = readStat<number>("bestScore", 0);
  const isBest = score > previousBest;
  if (isBest) writeStat("bestScore", score);
  const best = Math.max(previousBest, score);

  // A zero can never beat a best, so don't spend a rate-limited request on it.
  if (!sdkReady || !window.Vatar || score <= 0) return { best, isBest, sent: false };

  const wait = SUBMIT_GAP_MS - (performance.now() - lastSubmit);
  if (wait > 0) {
    pending = Math.max(pending ?? 0, score);
    if (pendingTimer === null) {
      pendingTimer = window.setTimeout(() => {
        pendingTimer = null;
        const queued = pending;
        pending = null;
        if (queued !== null) void submitScore(queued);
      }, wait);
    }
    return { best, isBest, sent: false };
  }

  lastSubmit = performance.now();
  try {
    const res = await window.Vatar.submitScore(score);
    return { best: Math.max(best, res.best), isBest: isBest || res.best === score, sent: res.accepted };
  } catch (error) {
    console.warn("[vatar] submitScore failed", error);
    return { best, isBest, sent: false };
  }
}

export async function fetchLeaderboard(): Promise<Leaderboard> {
  if (sdkReady && window.Vatar) {
    try {
      const board = await window.Vatar.leaderboard();
      return { ...board, local: false };
    } catch (error) {
      console.warn("[vatar] leaderboard failed", error);
    }
  }
  const best = readStat<number>("bestScore", 0);
  return {
    top: [],
    me: best > 0 ? { rank: 1, label: identity?.name ?? "You", score: best } : null,
    local: true,
  };
}

export const bestScore = (): number => readStat<number>("bestScore", 0);

/* ─────────────────────────────── matches ─────────────────────────────── */

export interface PlatformWait {
  /** The platform match id once two players are paired, or undefined if there is none to use. */
  match: Promise<string | undefined>;
  /** Stop waiting and leave the platform queue. */
  cancel(): void;
}

/**
 * Pair with another player through the platform (`Vatar.match.quick`, no
 * stake), so the match exists on Lagos Life and our server can post its result.
 * Resolves undefined outside the shell or if the platform refuses, in which
 * case the game falls back to its own matchmaking.
 */
export function quickPlatformMatch(): PlatformWait {
  const sdk = window.Vatar;
  if (!sdkReady || !sdk?.match?.quick) return { match: Promise.resolve(undefined), cancel: () => {} };

  let cancelled = false;
  let matchId: string | undefined;
  let unsubscribe: () => void = () => {};
  let settle: (id?: string) => void = () => {};

  const match = new Promise<string | undefined>((resolve) => {
    settle = (id) => {
      unsubscribe();
      resolve(id);
    };
    sdk.match
      .quick({ stake: 0 })
      .then((m) => {
        matchId = m.id;
        if (cancelled) {
          void sdk.match.leave().catch(() => {});
          return settle(undefined);
        }
        if (m.status === "playing") return settle(m.id);
        unsubscribe = sdk.match.onUpdate((update) => {
          if (update.id !== m.id) return;
          if (update.status === "playing") settle(update.id);
          else if (update.status !== "open") settle(undefined);
        });
      })
      .catch((error) => {
        console.warn("[vatar] match.quick failed, using our own matchmaking", error);
        settle(undefined);
      });
  });

  return {
    match,
    cancel() {
      cancelled = true;
      if (matchId) void sdk.match.leave().catch(() => {});
      settle(undefined);
    },
  };
}

/* ─────────────────────────────── shop ─────────────────────────────── */

const owned = new Set<string>();
export const owns = (productId: string): boolean => owned.has(productId);

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} answered ${res.status}`);
  return (await res.json()) as T;
}

/** Our server checks the purchase with Vatar, gives the item once and marks it delivered. */
async function claim(purchaseId: string): Promise<void> {
  const { items } = await postJson<{ productId: string; items: string[] }>("/claim", {
    session: await freshSession(),
    purchaseId,
  });
  for (const item of items) owned.add(item);
}

/**
 * After sign-in: load what the server says we own, and finish any purchase
 * that was paid but not delivered (a crash, or a trip to the payment page).
 */
export async function syncPurchases(): Promise<void> {
  if (!sdkReady || !window.Vatar) return;
  const finish = (p: { purchaseId: string }): Promise<void> =>
    claim(p.purchaseId).catch((error) => console.warn("[vatar] could not claim purchase", error));
  window.Vatar.onPurchase((p) => void finish(p));
  try {
    const { items } = await postJson<{ items: string[] }>("/entitlements", { session: await freshSession() });
    for (const item of items) owned.add(item);
  } catch (error) {
    console.warn("[vatar] could not load purchases", error);
  }
  try {
    for (const p of await window.Vatar.purchases()) await finish(p);
  } catch (error) {
    console.warn("[vatar] could not list purchases", error);
  }
}

/** Open Lagos Life's pay sheet. "ok" once paid and unlocked; "cancelled" if the player backed out. */
export async function buyProduct(productId: string): Promise<"ok" | "cancelled" | "unlock_failed"> {
  if (!sdkReady || !window.Vatar) return "cancelled";
  let purchaseId: string;
  try {
    purchaseId = (await window.Vatar.purchase(productId)).purchaseId;
  } catch (error) {
    console.info("[vatar] purchase did not complete", (error as { code?: string }).code ?? error);
    return "cancelled";
  }
  try {
    await claim(purchaseId);
    return "ok";
  } catch (error) {
    // Paid but not delivered: Vatar lists it in purchases() next time, and we retry then.
    console.warn("[vatar] paid, but the unlock failed", error);
    return "unlock_failed";
  }
}
