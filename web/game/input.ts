import { TEAM_RODS, type Team } from "@shared/constants";
import type { RodState } from "@shared/types";

/**
 * Controls the player's four rods, one at a time — like holding a rod handle.
 *
 *   keys 1..4            select a rod, goal → attack
 *   mouse left / right   slide the rod across the table
 *   mouse up / down      rotate the rod (up swings the men away from you)
 *
 * The mapping is mirrored per team so "up" always swings toward the opponent
 * and "right" always moves along the screen, whichever end you view from.
 *
 * These values are applied locally *immediately* so the rod responds without
 * waiting for the network; the same absolute values are sent to the server.
 */

/** Mouse travel maps to this half-range of rotation (radians). */
const ANGLE_RANGE = Math.PI / 2;

export interface InputController {
  /** Live state of the player's own rods, keyed by rod index. */
  ownRods(): Record<number, RodState>;
  /** Selected rod, 0 = goal … 3 = attack. */
  activeSlot(): number;
  dispose(): void;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export function createInput(
  container: HTMLElement,
  team: Team,
  onSelect?: (slot: number) => void,
): InputController {
  const mine = TEAM_RODS[team];
  const rods: Record<number, RodState> = {};
  for (const index of mine) rods[index] = { angle: 0, offset: 0 };

  // Camera sits behind our own goal, so screen-right maps to +z for `left`
  // and to -z for `right`; likewise for which rotation swings "away".
  const screenRightToZ = team === "left" ? 1 : -1;
  const towardOpponent = team === "left" ? 1 : -1;

  let slot = 2; // start on midfield; the most useful rod to hold

  const onPointerMove = (event: PointerEvent): void => {
    const rect = container.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;

    const nx = clamp(((event.clientX - rect.left) / rect.width) * 2 - 1, -1, 1);
    const ny = clamp(((event.clientY - rect.top) / rect.height) * 2 - 1, -1, 1);

    const index = mine[slot];
    rods[index] = {
      angle: towardOpponent * -ny * ANGLE_RANGE,
      offset: screenRightToZ * nx,
    };
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    const pressed = Number(event.key);
    if (!Number.isInteger(pressed) || pressed < 1 || pressed > mine.length) return;
    slot = pressed - 1;
    onSelect?.(slot);
  };

  container.addEventListener("pointermove", onPointerMove);
  window.addEventListener("keydown", onKeyDown);

  return {
    ownRods: () => rods,
    activeSlot: () => slot,
    dispose(): void {
      container.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("keydown", onKeyDown);
    },
  };
}
