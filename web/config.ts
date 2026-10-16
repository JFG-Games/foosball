/** Browser-side configuration. Only `VITE_*` vars are exposed by Vite. */

/**
 * Authoritative game server WebSocket URL. In dev builds only, `?server=ws://…`
 * overrides it (handy for testing against a second local server); production
 * builds ignore the parameter so a crafted link can't redirect players.
 */
export const SERVER_URL: string = (() => {
  // Dev with no VITE_SERVER_URL: use Vite's same-origin `/ws` proxy, which works
  // over ngrok/LAN (wss on https pages) without exposing port 8080.
  const sameOrigin = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
  const fallback: string =
    import.meta.env.VITE_SERVER_URL ??
    (import.meta.env.DEV ? sameOrigin : "ws://localhost:8080");
  if (!import.meta.env.DEV) return fallback;
  const override = new URLSearchParams(location.search).get("server");
  return override && /^wss?:\/\//.test(override) ? override : fallback;
})();

/** Lagos Life / Vatar Games browser SDK. */
export const VATAR_SDK_URL = "https://lagoslife.app/sdk/vatar-games-v1.js";

/**
 * Base URL of the game server's HTTP endpoints (purchases). Derived from the
 * WebSocket URL, or set VITE_API_URL. In dev, Vite proxies `/api` to the server.
 */
export const API_URL: string = (() => {
  const explicit = import.meta.env.VITE_API_URL as string | undefined;
  if (explicit) return explicit.replace(/\/+$/, "");
  const ws = import.meta.env.VITE_SERVER_URL as string | undefined;
  if (ws) return ws.replace(/^ws/, "http").replace(/\/+$/, "");
  return import.meta.env.DEV ? `${location.origin}/api` : "http://localhost:8080";
})();
