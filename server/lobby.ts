import type { WebSocket } from "ws";
import { PROTOCOL_VERSION, type ClientMessage, type ServerMessage } from "@shared/protocol";
import type { Player } from "@shared/types";
import { ROOM_CODE_LENGTH } from "@shared/constants";
import { VATAR_LIVE } from "./config";
import { Room } from "./room";
import { verifySession } from "./vatar/client";

/** A player waiting for an opponent in the quick-match queue. */
interface Waiting {
  player: Player;
  socket: WebSocket;
  vatarMatchId?: string;
}

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no look-alikes

/** Local-dev display names are user supplied, so keep them short and plain. */
function cleanName(raw: unknown, fallback: string): string {
  if (typeof raw !== "string") return fallback;
  const name = raw.replace(/[^\p{L}\p{N} _.-]/gu, "").trim().slice(0, 16);
  return name || fallback;
}

/**
 * Matchmaking.
 *
 *   - quick match: verified players are queued and paired first-come-first-served,
 *     except that players who name the same Vatar platform match are paired
 *     with each other.
 *   - private rooms: one player opens a room and shares its code; a friend
 *     joins with it.
 */
export class Lobby {
  private readonly waiting: Waiting[] = [];
  private readonly rooms = new Map<string, Room>();
  private readonly membership = new Map<WebSocket, Room>();
  private readonly joining = new Set<WebSocket>();
  private devCounter = 0;

  handle(socket: WebSocket, msg: ClientMessage): void {
    switch (msg?.t) {
      case "join":
        void this.join(socket, msg);
        break;
      case "input": {
        const room = this.membership.get(socket);
        const team = room?.teamOf(socket) ?? null;
        if (room && team && msg.input && typeof msg.input === "object") room.queueInput(team, msg.input);
        break;
      }
      case "rematch":
        this.membership.get(socket)?.rematch(socket);
        break;
      case "ready":
        this.membership.get(socket)?.markReady(socket);
        break;
      case "leave":
        this.disconnect(socket);
        break;
    }
  }

  disconnect(socket: WebSocket): void {
    this.joining.delete(socket);
    const queued = this.waiting.findIndex((w) => w.socket === socket);
    if (queued !== -1) {
      this.waiting.splice(queued, 1);
      return;
    }
    this.membership.get(socket)?.abandon(socket);
    this.membership.delete(socket);
  }

  /**
   * Verify the session, then queue, create or join. Without Vatar credentials
   * the server falls back to a local identity so the game can be played offline.
   */
  private async join(socket: WebSocket, msg: Extract<ClientMessage, { t: "join" }>): Promise<void> {
    if (this.joining.has(socket) || this.membership.has(socket) || this.waiting.some((w) => w.socket === socket)) {
      return; // already on its way in
    }
    if (msg.protocol !== undefined && msg.protocol !== PROTOCOL_VERSION) {
      this.send(socket, { t: "error", code: "outdated", message: "The game was updated — please reload the page." });
      return;
    }

    this.joining.add(socket);
    let player: Player;
    try {
      player = await this.identify(msg);
    } catch (error) {
      this.joining.delete(socket);
      this.send(socket, {
        t: "error",
        code: "session_invalid",
        message: error instanceof Error ? error.message : "Session verification failed",
      });
      return;
    }
    // The socket may have dropped while Vatar was answering.
    if (!this.joining.delete(socket) || socket.readyState !== socket.OPEN) return;

    const vatarMatchId = typeof msg.vatarMatchId === "string" ? msg.vatarMatchId.slice(0, 64) : undefined;

    if (msg.create) {
      this.openPrivateRoom(socket, player, vatarMatchId);
    } else if (typeof msg.roomCode === "string" && msg.roomCode.trim()) {
      this.joinPrivateRoom(socket, player, msg.roomCode.trim().toUpperCase(), vatarMatchId);
    } else {
      this.quickMatch(socket, player, vatarMatchId);
    }
  }

  private openPrivateRoom(socket: WebSocket, player: Player, vatarMatchId?: string): void {
    const room = this.newRoom();
    room.seat(player, socket, vatarMatchId);
    this.membership.set(socket, room);
    this.send(socket, {
      t: "waiting",
      message: `Share code ${room.code} with a friend`,
      roomCode: room.code,
    });
  }

  private joinPrivateRoom(socket: WebSocket, player: Player, code: string, vatarMatchId?: string): void {
    const room = this.rooms.get(code);
    if (!room) {
      this.send(socket, { t: "error", code: "room_not_found", message: `No room with code ${code}` });
      return;
    }
    if (room.isFull) {
      this.send(socket, { t: "error", code: "room_full", message: "That room is already full" });
      return;
    }
    this.membership.set(socket, room);
    room.seat(player, socket, vatarMatchId);
  }

  private quickMatch(socket: WebSocket, player: Player, vatarMatchId?: string): void {
    // Pair with someone already waiting (same platform match if one is named).
    const at = this.waiting.findIndex((w) => w.vatarMatchId === vatarMatchId);
    if (at === -1) {
      this.waiting.push({ player, socket, vatarMatchId });
      this.send(socket, { t: "waiting", message: "Waiting for an opponent…" });
      return;
    }
    const [opponent] = this.waiting.splice(at, 1);

    const room = this.newRoom();
    this.membership.set(opponent.socket, room);
    this.membership.set(socket, room);
    room.seat(opponent.player, opponent.socket, opponent.vatarMatchId);
    room.seat(player, socket, vatarMatchId);
  }

  private newRoom(): Room {
    const room = new Room(this.makeCode(), (closed) => this.release(closed));
    this.rooms.set(room.code, room);
    return room;
  }

  private release(room: Room): void {
    this.rooms.delete(room.code);
    for (const [socket, joined] of this.membership) {
      if (joined === room) this.membership.delete(socket);
    }
    room.stop();
  }

  private async identify(msg: Extract<ClientMessage, { t: "join" }>): Promise<Player> {
    if (VATAR_LIVE && msg.sessionToken !== "sandbox-token") {
      const verified = await verifySession(msg.sessionToken);
      console.log(`[lobby] Vatar verified player ${verified.playerId}`);
      return {
        id: verified.playerId,
        displayName: verified.name,
        team: "left", // replaced when seated
      };
    }

    // Local development: no Vatar keys configured (or the dev placeholder).
    this.devCounter += 1;
    return {
      id: `dev-${this.devCounter}`,
      displayName: cleanName(msg.name, `Player ${this.devCounter}`),
      team: "left",
    };
  }

  private makeCode(): string {
    let code = "";
    for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
      code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    }
    return this.rooms.has(code) ? this.makeCode() : code;
  }

  private send(socket: WebSocket, message: ServerMessage): void {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
  }
}
