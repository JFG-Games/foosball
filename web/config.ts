/** Browser-side configuration. Only `VITE_*` vars are exposed by Vite. */

/**
 * Authoritative game server WebSocket URL. In dev builds only, `?server=ws://…`
 * overrides it (handy for testing against a second local server); production
 * builds ignore the parameter so a crafted link can't redirect players.
 */
export const SERVER_URL: string = (() => {
  const fallback: string = import.meta.env.VITE_SERVER_URL ?? "ws://localhost:8080";
  if (!import.meta.env.DEV) return fallback;
  const override = new URLSearchParams(location.search).get("server");
  return override && /^wss?:\/\//.test(override) ? override : fallback;
})();

/** Lagos Life / Vatar Games browser SDK. */
export const VATAR_SDK_URL = "https://lagoslife.app/sdk/vatar-games-v1.js";
