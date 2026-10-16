// Loads `.env` from the repo root. Must stay the first import so that
// server/config.ts reads the populated process.env.
import "dotenv/config";
import { WebSocketServer, type WebSocket } from "ws";
import type { ClientMessage, ServerMessage } from "@shared/protocol";
import { PORT, VATAR_LIVE, VATAR_RESULTS_SECRET, VATAR_SANDBOX } from "./config";
import { Lobby } from "./lobby";

/**
 * Entry point for the authoritative game server.
 *
 * Responsibilities:
 *   - terminate the WebSocket connection used for realtime play
 *   - verify each player's Vatar session before accepting any input
 *   - own matchmaking (Lobby) and per-match simulation (Room)
 *
 * It deliberately serves NO static assets: the client is hosted separately
 * over HTTPS so the Lagos Life shell can frame it.
 */
const wss = new WebSocketServer({ port: PORT, maxPayload: 16 * 1024 });
const lobby = new Lobby();

wss.on("connection", (socket: WebSocket) => {
  socket.on("message", (raw) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw.toString()) as ClientMessage;
    } catch {
      send(socket, { t: "error", code: "bad_json", message: "Malformed message" });
      return;
    }
    lobby.handle(socket, msg);
  });

  socket.on("close", () => lobby.disconnect(socket));
});

function send(socket: WebSocket, msg: ServerMessage): void {
  socket.send(JSON.stringify(msg));
}

console.log(`[server] Vatar: secret ${VATAR_LIVE ? "set" : "MISSING"}, results secret ${VATAR_RESULTS_SECRET ? "set" : "MISSING"}, sandbox ${VATAR_SANDBOX}`);
console.log(`[server] authoritative WebSocket listening on ws://localhost:${PORT}`);
