import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";

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
    host: true, // expose on the LAN so you can test on a phone
  },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
  },
});
