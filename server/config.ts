/** Server configuration, sourced from environment variables. */

/** Parse an integer env var, tolerating unset, empty or non-numeric values. */
function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const PORT = intEnv("PORT", 8080);

/** Vatar Games (Lagos Life) REST API. Documented base; subject to change. */
export const VATAR_API_BASE =
  process.env.VATAR_API_BASE ?? "https://lagoslife.app/api/games/v1";

/** Your game's id, issued in the developer portal. */
export const VATAR_GAME_ID = process.env.VATAR_GAME_ID ?? "";

/** Server secret used to authorise API calls. NEVER send this to the browser. */
export const VATAR_SECRET = process.env.VATAR_SECRET ?? "";

/** Sandbox mode uses test keys and skips real settlement. */
export const VATAR_SANDBOX =
  (process.env.VATAR_SANDBOX ?? "true").toLowerCase() !== "false";

/**
 * Separate "results" secret used to sign match results (HMAC). Kept apart from
 * VATAR_SECRET so a leaked API key can't forge a result. Server-side only.
 */
export const VATAR_RESULTS_SECRET = process.env.VATAR_RESULTS_SECRET ?? "";

/** Signing secret for inbound Vatar webhooks. Server-side only. */
export const VATAR_WEBHOOK_SECRET = process.env.VATAR_WEBHOOK_SECRET ?? "";

/** True when real (or sandbox) Vatar credentials are configured. */
export const VATAR_LIVE = VATAR_SECRET.length > 0;
