/** Browser-side configuration. Only `VITE_*` vars are exposed by Vite. */

/** Authoritative game server WebSocket URL. */
export const SERVER_URL: string = import.meta.env.VITE_SERVER_URL ?? "ws://localhost:8080";

/** Lagos Life / Vatar Games browser SDK. */
export const VATAR_SDK_URL = "https://lagoslife.app/sdk/vatar-games-v1.js";
