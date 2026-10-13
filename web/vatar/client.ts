import { VATAR_SDK_URL } from "../config";

/** A player identity handed to us by the Lagos Life shell. */
export interface Session {
  playerId: string;
  displayName: string;
  avatarUrl?: string;
  sessionToken: string;
}

/**
 * Wrapper around the Lagos Life / Vatar Games browser SDK.
 *
 * TODO (integration): inject `VATAR_SDK_URL` as a <script>, wait for
 * `window.Vatar`, then map `Vatar.init()` onto `Session`. Keep every
 * secret-bearing call on the server (see server/vatar/client.ts).
 */
export async function initVatar(): Promise<Session> {
  if (typeof window !== "undefined" && window.Vatar) {
    return window.Vatar.init();
  }

  // Local development fallback: the SDK only exists inside the Lagos Life
  // shell, so run with a stand-in session when opened directly.
  console.info("[vatar] SDK not present (%s) — using local dev session", VATAR_SDK_URL);
  return {
    playerId: "local-dev",
    displayName: "Dev Player",
    sessionToken: "sandbox-token",
  };
}
