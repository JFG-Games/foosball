import type { WebSocket } from "ws";
import type { ClientMessage, ServerMessage } from "@shared/protocol";
import type { Player } from "@shared/types";
import { ROOM_CODE_LENGTH } from "@shared/constants";
import { VATAR_GAME_ID, VATAR_SECRET } from "./config";
import { Room } from "./room";
import { verifySession } from "./vatar/client";

/** A player waiting for an opponent. */
interface Waiting {
  player: Player;
  socket: WebSocket;
}

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no look-alikes

/**
 * Matchmaking. Verified players are queued and paired, first-come-first-served.
 *
 * TODO (gameplay): room-code create/join, skill matching, reconnect grace.
 */
export class Lobby {
  private readonly waiting: Waiting[] = [];
  private readonly rooms = new Map<string, Room>();
  private readonly membership = new Map<WebSocket, Room>();
  private devCounter = 0;

  handle(socket: WebSocket, msg: ClientMessage): void {
    switch (msg.t) {
      case "join":
        void this.join(socket, msg.sessionToken);
        break;
      case "input": {
        const room = this.membership.get(socket);
        const team = room?.teamOf(socket) ?? null;
        if (room && team) room.queueInput(team, msg.input);
        break;
      }
      case "ready":
        // TODO: explicit ready-up before kickoff.
        break;
      case "leave":
        this.disconnect(socket);
        break;
    }
  }

  disconnect(socket: WebSocket): void {
    const queued = this.waiting.findIndex((w) => w.socket === socket);
    if (queued !== -1) {
      this.waiting.splice(queued, 1);
      return;
    }
    this.membership.get(socket)?.abandon(socket);
    this.membership.delete(socket);
  }

  /**
   * Verify the session, then queue the player. Without Vatar credentials the
   * server falls back to a local identity so the game can be played offline.
   */
  private async join(socket: WebSocket, sessionToken: string): Promise<void> {
    let player: Player;
    try {
      player = await this.identify(sessionToken);
    } catch (error) {
      this.send(socket, {
        t: "error",
        code: "session_invalid",
        message: error instanceof Error ? error.message : "Session verification failed",
      });
      return;
    }

    // Pair with anyone already waiting, otherwise wait for the next player.
    const opponent = this.waiting.shift();
    if (!opponent) {
      this.waiting.push({ player, socket });
      this.send(socket, { t: "waiting", message: "Waiting for an opponent…" });
      return;
    }

    const room = new Room(this.makeCode(), (finished) => this.release(finished));
    this.rooms.set(room.code, room);
    room.seat(opponent.player, opponent.socket);
    room.seat(player, socket);
    this.membership.set(opponent.socket, room);
    this.membership.set(socket, room);
  }

  private release(room: Room): void {
    this.rooms.delete(room.code);
    for (const [socket, joined] of this.membership) {
      if (joined === room) this.membership.delete(socket);
    }
    room.stop();
  }

  private async identify(sessionToken: string): Promise<Player> {
    const live = VATAR_SECRET.length > 0 && VATAR_GAME_ID.length > 0;

    if (live && sessionToken !== "sandbox-token") {
      const verified = await verifySession(sessionToken);
      return {
        id: verified.playerId,
        displayName: verified.displayName,
        team: "left", // replaced when seated
      };
    }

    // Local development: no Vatar keys configured (or the dev placeholder).
    this.devCounter += 1;
    return {
      id: `dev-${this.devCounter}`,
      displayName: `Player ${this.devCounter}`,
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
