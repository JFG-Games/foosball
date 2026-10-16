import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";

// Lagos Life frames the game in an iframe, so the host must allow it (see docs/ARCHITECTURE.md).
const FRAMING_HEADERS = {
  "Content-Security-Policy": "frame-ancestors https://lagoslife.app https://www.lagoslife.app https://naijalife.app https://www.naijalife.app https://lagoslife.eliysites.com",
};

export default defineConfig({
  // The browser client lives in web/; server code is never bundled.
  root: "web",
  // Relative asset URLs, so the build works under any path (e.g. inside the Lagos Life shell).
  base: "./",
  publicDir: "public",
  // Read a single `.env` from the repo root. Only VITE_-prefixed vars reach
  // the browser, so server secrets in the same file stay server-side.
  envDir: "..",
  resolve: {
    alias: {
      "@shared": fileURLToPath(new URL("./shared", import.meta.url)),
    },
  },
  server: {
    port: 5173,
    headers: FRAMING_HEADERS,
    host: true, // expose on the LAN so you can test on a phone
    // Hostnames (not URLs) Vite will serve; needed to reach the dev server via ngrok.
    allowedHosts: ["headstone-deduce-resort.ngrok-free.dev"],
    // Forward the game WebSocket through Vite so one tunnel (ngrok → 5173) serves
    // both the page and the game server; the browser connects to `/ws` same-origin.
    proxy: {
      "/ws": { target: "ws://localhost:8080", ws: true, rewrite: () => "/" },
      // Purchase endpoints on the game server (`/api/claim` -> `/claim`).
      "/api": { target: "http://localhost:8080", rewrite: (path) => path.replace(/^\/api/, "") },
    },
  },
  // `vite preview` serves the production build; same framing rule.
  preview: { headers: FRAMING_HEADERS },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
  },
});
