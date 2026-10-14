import { RODS, TEAM_RODS, type Team } from "@shared/constants";
import type { RodState } from "@shared/types";

/**
 * Controls the player's four rods, one at a time — like holding a rod handle.
 *
 * Touch (built for thumbs)
 *   touch a row     grab the rod on that row of the table (nearest to your finger)
 *   drag sideways   slide it; it stays where you leave it
 *   flick up        KICK — wind back and swing through
 *   hold up / down  tilt the rod; let go and it springs back
 *   tap             KICK too
 *   AUTO            when on, the rod nearest the ball is picked for you whenever
 *                   you aren't holding one
 *
 * Mouse
 *   move            slide (left/right) and rotate (up/down) the active rod
 *   click / Space   KICK            1–4 / wheel   pick a rod        A  auto
 *
 * The mapping is mirrored per team so "up" always swings toward the opponent
 * and "right" always moves along the screen, whichever end you view from.
 *
 * Your own rods are driven locally the instant you move (eased slightly, so a
 * 60 Hz pointer never makes the men step), and the same values are simulated.
 */

/** Mouse travel maps to this half-range of rotation (radians). */
const ANGLE_RANGE = Math.PI / 2;

/** Scripted kick, in ms: wind back, strike, hold, return. */
const KICK_WIND_MS = 75;
const KICK_STRIKE_MS = 55;
const KICK_HOLD_MS = 35;
const KICK_RETURN_MS = 130;
const KICK_TOTAL_MS = KICK_WIND_MS + KICK_STRIKE_MS + KICK_HOLD_MS + KICK_RETURN_MS;
const KICK_WIND_ANGLE = 0.85;
const KICK_STRIKE_ANGLE = 1.35;

/** Touch tuning. */
const TOUCH_DEADZONE_PX = 14;
const TAP_MAX_MS = 220;
const TAP_MAX_MOVE_PX = 12;
/** A flick: this far, this fast, upward (px, px/ms, window ms). */
const FLICK_MIN_PX = 24;
const FLICK_MIN_SPEED = 0.6;
const FLICK_WINDOW_MS = 130;

/** How quickly displayed rods follow what you ask for (per second). */
const SLIDE_FOLLOW = 32;
const TILT_FOLLOW = 45;

/** Metres between two rods' distance to the ball before auto-select switches. */
const AUTO_HYSTERESIS = 0.04;
/** After picking a rod by hand, auto-select waits this long (ms). */
const MANUAL_HOLD_MS = 2500;

export interface InputHooks {
  /** The active rod changed (slot 0..3, goal → attack). */
  onSelect?: (slot: number, auto: boolean) => void;
  /** A kick started on this slot. */
  onKick?: (slot: number) => void;
  /** Screen y (px, relative to the control surface) of a rod's row, for grabbing by touch. */
  rodRowY?: (rodIndex: number) => number | null;
}

export interface InputController {
  /** Live state of the player's own rods, keyed by rod index. */
  ownRods(): Record<number, RodState>;
  /** Selected rod, 0 = goal … 3 = attack. */
  activeSlot(): number;
  activeRod(): number;
  isAuto(): boolean;
  setAuto(on: boolean): void;
  /** Pick a rod by hand. With auto on, auto resumes after a few seconds of no input. */
  selectSlot(slot: number): void;
  kick(): void;
  /** Advance easing, spring-backs and kicks; call every frame. */
  update(dtMs: number, ballX: number | null): void;
  dispose(): void;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export function createInput(
  container: HTMLElement,
  team: Team,
  initialAuto: boolean,
  hooks: InputHooks = {},
): InputController {
  const mine = TEAM_RODS[team];
  const rods: Record<number, RodState> = {};
  const wantOffset: Record<number, number> = {};
  for (const index of mine) {
    rods[index] = { angle: 0, offset: 0 };
    wantOffset[index] = 0;
  }

  // The camera sits behind our own goal, so screen-right maps to +z for
  // `left` and to -z for `right`; likewise for which rotation swings "away".
  const screenRightToZ = team === "left" ? 1 : -1;
  const toward = team === "left" ? 1 : -1;

  let slot = 2; // start on midfield; the most useful rod to hold
  let auto = initialAuto;
  let manualHoldMs = 0;

  /** Angle the mouse / touch currently asks for on the active rod. */
  let aimAngle = 0;
  /** True while a finger or mouse is steering the angle. */
  let steering = false;

  let kickMs = -1; // < 0 = not kicking
  let kickCooldown = 0;

  type Touch = {
    id: number;
    downAt: number;
    startX: number;
    startY: number;
    lastX: number;
    moved: number;
    trail: { t: number; y: number }[];
  };
  let touch: Touch | null = null;

  const select = (next: number, mode: "auto" | "hand" | "grab"): void => {
    if (mode !== "auto" && auto) manualHoldMs = MANUAL_HOLD_MS;
    if (next === slot) return;
    // Switching rods: the one we leave stands up straight again.
    slot = next;
    aimAngle = 0;
    steering = false;
    hooks.onSelect?.(slot, auto);
  };

  const startKick = (): void => {
    if (kickMs >= 0 || kickCooldown > 0) return;
    kickMs = 0;
    manualHoldMs = Math.max(manualHoldMs, 900);
    hooks.onKick?.(slot);
  };

  /** Angle during a scripted kick, from the time since it began. */
  const kickAngle = (t: number): number => {
    const wind = -toward * KICK_WIND_ANGLE;
    const strike = toward * KICK_STRIKE_ANGLE;
    if (t < KICK_WIND_MS) {
      const k = t / KICK_WIND_MS;
      return wind * (1 - (1 - k) * (1 - k)); // ease out
    }
    t -= KICK_WIND_MS;
    if (t < KICK_STRIKE_MS) return wind + (strike - wind) * (t / KICK_STRIKE_MS);
    t -= KICK_STRIKE_MS;
    if (t < KICK_HOLD_MS) return strike;
    t -= KICK_HOLD_MS;
    const k = clamp(t / KICK_RETURN_MS, 0, 1);
    return strike * (1 - k * k);
  };

  /** The slot whose row is closest to a touch at `y`. */
  const slotAt = (y: number): number => {
    let best = slot;
    let bestDist = Infinity;
    for (let s = 0; s < mine.length; s++) {
      const row = hooks.rodRowY?.(mine[s]);
      if (row === null || row === undefined) continue;
      const d = Math.abs(row - y);
      if (d < bestDist) {
        bestDist = d;
        best = s;
      }
    }
    return best;
  };

  /* ───────────────────────────── pointer ───────────────────────────── */

  const onPointerMove = (event: PointerEvent): void => {
    const rect = container.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const index = mine[slot];

    if (event.pointerType === "mouse") {
      const nx = clamp(((event.clientX - rect.left) / rect.width) * 2 - 1, -1, 1);
      const ny = clamp(((event.clientY - rect.top) / rect.height) * 2 - 1, -1, 1);
      wantOffset[index] = screenRightToZ * nx;
      aimAngle = toward * -ny * ANGLE_RANGE;
      steering = true;
      return;
    }

    if (!touch || touch.id !== event.pointerId) return;
    // Use the time the touch actually happened, not when a busy page got around to it.
    const now = event.timeStamp;
    const span = Math.min(rect.width, 720) * 0.85;
    const dx = event.clientX - touch.lastX;
    touch.lastX = event.clientX;
    touch.moved = Math.max(touch.moved, Math.hypot(event.clientX - touch.startX, event.clientY - touch.startY));
    wantOffset[index] = clamp(wantOffset[index] + (screenRightToZ * dx * 2) / span, -1, 1);

    // Flick detection over the last ~130 ms of finger travel.
    touch.trail.push({ t: now, y: event.clientY });
    while (touch.trail.length > 1 && now - touch.trail[0].t > FLICK_WINDOW_MS) touch.trail.shift();
    const first = touch.trail[0];
    const rise = first.y - event.clientY; // positive = finger moved up the screen
    const elapsed = Math.max(1, now - first.t);
    if (kickMs < 0 && rise >= FLICK_MIN_PX && rise / elapsed >= FLICK_MIN_SPEED) {
      startKick();
      // Re-anchor so the tilt reads as "level" again after the flick.
      touch.startY = event.clientY;
      touch.trail.length = 0;
      steering = false;
      aimAngle = 0;
      return;
    }

    const dy = event.clientY - touch.startY;
    const live = Math.max(0, Math.abs(dy) - TOUCH_DEADZONE_PX) * Math.sign(dy);
    const tilt = clamp(live / (rect.height * 0.16), -1, 1);
    aimAngle = toward * -tilt * ANGLE_RANGE;
    steering = Math.abs(tilt) > 0.001;
  };

  const onPointerDown = (event: PointerEvent): void => {
    if (event.pointerType === "mouse") {
      if (event.button === 0) startKick();
      return;
    }
    if (touch) {
      startKick(); // a second finger is a kick
      return;
    }
    const rect = container.getBoundingClientRect();
    touch = {
      id: event.pointerId,
      downAt: event.timeStamp,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      moved: 0,
      trail: [{ t: event.timeStamp, y: event.clientY }],
    };
    try {
      container.setPointerCapture?.(event.pointerId);
    } catch {
      /* the pointer may already be gone; dragging still works without capture */
    }
    // Grab the rod on the row that was touched.
    select(slotAt(event.clientY - rect.top), "grab");
  };

  const onPointerEnd = (event: PointerEvent): void => {
    if (!touch || touch.id !== event.pointerId) return;
    const quick = event.timeStamp - touch.downAt <= TAP_MAX_MS && touch.moved <= TAP_MAX_MOVE_PX;
    touch = null;
    steering = false;
    aimAngle = 0;
    manualHoldMs = Math.max(manualHoldMs, 1200);
    if (quick && event.type === "pointerup") startKick();
  };

  const onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    const step = event.deltaY > 0 ? 1 : -1;
    select(clamp(slot + step, 0, mine.length - 1), "hand");
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.repeat) return;
    if (event.code === "Space") {
      event.preventDefault();
      startKick();
      return;
    }
    if (event.key === "a" || event.key === "A") {
      auto = !auto;
      hooks.onSelect?.(slot, auto);
      return;
    }
    const pressed = Number(event.key);
    if (Number.isInteger(pressed) && pressed >= 1 && pressed <= mine.length) select(pressed - 1, "hand");
  };

  container.addEventListener("pointermove", onPointerMove);
  container.addEventListener("pointerdown", onPointerDown);
  container.addEventListener("pointerup", onPointerEnd);
  container.addEventListener("pointercancel", onPointerEnd);
  container.addEventListener("wheel", onWheel, { passive: false });
  window.addEventListener("keydown", onKeyDown);

  return {
    ownRods: () => rods,
    activeSlot: () => slot,
    activeRod: () => mine[slot],
    isAuto: () => auto,
    setAuto(on: boolean): void {
      auto = on;
      manualHoldMs = 0;
      hooks.onSelect?.(slot, auto);
    },
    selectSlot: (next: number) => select(clamp(next, 0, mine.length - 1), "hand"),
    kick: startKick,

    update(dtMs: number, ballX: number | null): void {
      kickCooldown = Math.max(0, kickCooldown - dtMs);
      if (touch === null) manualHoldMs = Math.max(0, manualHoldMs - dtMs);

      // Auto-select: hand the ball to the rod that is nearest to it, unless
      // you are holding one or just picked one yourself.
      if (auto && ballX !== null && kickMs < 0 && touch === null && manualHoldMs <= 0) {
        let best = slot;
        let bestDist = Math.abs(RODS[mine[slot]].x - ballX) - AUTO_HYSTERESIS;
        for (let s = 0; s < mine.length; s++) {
          const d = Math.abs(RODS[mine[s]].x - ballX);
          if (d < bestDist) {
            best = s;
            bestDist = d;
          }
        }
        if (best !== slot) select(best, "auto");
      }

      const dt = dtMs / 1000;
      const slide = 1 - Math.exp(-SLIDE_FOLLOW * dt);
      const tilt = 1 - Math.exp(-TILT_FOLLOW * dt);

      for (let s = 0; s < mine.length; s++) {
        const rod = rods[mine[s]];
        rod.offset += (wantOffset[mine[s]] - rod.offset) * slide;

        if (s === slot) {
          if (kickMs >= 0) {
            kickMs += dtMs;
            rod.angle = kickAngle(kickMs);
            if (kickMs >= KICK_TOTAL_MS) {
              kickMs = -1;
              kickCooldown = 60;
              rod.angle = 0;
            }
          } else if (steering) {
            rod.angle += (aimAngle - rod.angle) * tilt;
          } else {
            // Let go: spring back to upright. Fast enough to flick the ball.
            rod.angle += clamp(-rod.angle, -16 * dt, 16 * dt);
          }
        } else {
          rod.angle += clamp(-rod.angle, -10 * dt, 10 * dt);
        }
      }
    },

    dispose(): void {
      container.removeEventListener("pointermove", onPointerMove);
      container.removeEventListener("pointerdown", onPointerDown);
      container.removeEventListener("pointerup", onPointerEnd);
      container.removeEventListener("pointercancel", onPointerEnd);
      container.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKeyDown);
    },
  };
}
