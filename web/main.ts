import "./style.css";

import type { PlayerInput } from "@shared/types";
import type { ClientMessage } from "@shared/protocol";
import { SERVER_URL } from "./config";
import { createInput, type InputController } from "./game/input";
import { SnapshotBuffer, type RenderState } from "./game/interpolate";
import { createHud } from "./hud";
import { createConnection } from "./net/socket";
import { createStage, type Stage } from "./scene/stage";
import { createTable, type TableView } from "./scene/table";
import { initVatar } from "./vatar/client";

/** How often we push our rod state to the server (Hz). */
const SEND_INTERVAL_MS = 1000 / 30;

/**
 * Boot sequence:
 *   1. Init the Vatar SDK -> pseudonymous identity + session token.
 *   2. Join the authoritative server; it tells us which side we are.
 *   3. Build the scene for our side and start the render loop.
 *
 * Our own rods are applied locally the instant the mouse moves; the ball and
 * the opponent's rods come from interpolated snapshots.
 */
async function boot(): Promise<void> {
  const root = document.getElementById("app");
  if (!root) throw new Error("#app is missing from index.html");

  const hud = createHud(root);
  const buffer = new SnapshotBuffer();

  const session = await initVatar();
  hud.status("connecting…");

  let stage: Stage | null = null;
  let table: TableView | null = null;
  let input: InputController | null = null;
  let lastSend = 0;
  let lastView: RenderState | null = null;

  if (import.meta.env.DEV) {
    // Debug hook: lets you (or a test) read exactly what is being drawn.
    (window as unknown as { __foosball?: unknown }).__foosball = {
      render: () => lastView,
      snapshot: () => buffer.last,
      own: () => input?.ownRods() ?? null,
      slot: () => input?.activeSlot() ?? null,
    };
  }

  const connection = createConnection(SERVER_URL, session.sessionToken);

  connection.onMessage((message) => {
    switch (message.t) {
      case "waiting":
        hud.status(message.message);
        break;

      case "welcome": {
        // We now know which side we are, so build the scene for that end.
        const host = hud.canvasHost();
        stage = createStage(host, message.player.team);
        table = createTable();
        stage.scene.add(table.group);
        input = createInput(host, message.player.team, (slot) => hud.select(slot));
        hud.status(`You are ${message.player.team.toUpperCase()} · room ${message.roomCode}`);
        break;
      }

      case "peer":
        hud.status(
          message.event === "join"
            ? `${message.player.displayName} joined`
            : `${message.player.displayName} left`,
        );
        break;

      case "start":
        buffer.push(message.snapshot);
        hud.score(message.snapshot.score);
        hud.status("Kick off!");
        break;

      case "snapshot":
        buffer.push(message.snapshot);
        break;

      case "goal":
        hud.score(message.score);
        hud.goal(message.team);
        break;

      case "end":
        hud.end(message.winner);
        break;

      case "error":
        hud.status(message.message);
        break;
    }
  });

  connection.onClose(() => hud.status("disconnected"));

  function frame(): void {
    requestAnimationFrame(frame);
    if (!stage || !table || !input) return;

    const now = performance.now();

    // Draw: interpolate the world, then overwrite our own rods with whatever
    // we are holding right now, so our side feels instant.
    const view = buffer.sample(now);
    if (view) {
      const own = input.ownRods();
      for (const key of Object.keys(own)) {
        const index = Number(key);
        if (view.rods[index]) view.rods[index] = own[index];
      }
      lastView = view;
      table.apply(view.rods, view.ball);
    }

    // Send: our four rods, at a steady rate.
    if (now - lastSend >= SEND_INTERVAL_MS && buffer.last) {
      lastSend = now;
      const tick = buffer.last.tick + 1;
      const payload: PlayerInput = { seq: tick, tick, rods: input.ownRods() };
      const message: ClientMessage = { t: "input", input: payload };
      connection.send(message);
    }

    stage.resize();
    stage.render();
  }

  requestAnimationFrame(frame);
}

void boot();
