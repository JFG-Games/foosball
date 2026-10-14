import type { Team } from "@shared/constants";
import { MATCH_SCORE_TO_WIN } from "@shared/constants";
import { settings } from "../settings";

/**
 * Everything drawn over the 3D view during a match: scoreboard, buttons,
 * touch controls, and the full-screen effect layers (flash, speed lines,
 * vignette). Plain DOM, so the scene stays free of UI concerns.
 */
export interface HudHandlers {
  onPause(): void;
  onSound(): void;
  onSelectSlot(slot: number): void;
  onToggleAuto(): void;
  onKick(): void;
}

export interface Hud {
  /** Element the WebGL canvas should be mounted into. */
  canvasHost: HTMLElement;
  /** Layer that comic words are popped into. */
  wordsLayer: HTMLElement;
  /** Find an element inside the HUD (for the tutorial to point at). */
  query(selector: string): HTMLElement | null;
  /** The toast host, for brief messages. */
  toast(text: string, ms?: number): void;

  show(on: boolean): void;
  setTouch(on: boolean): void;
  setNames(names: Record<Team, string>, mine: Team | null): void;
  setScore(score: Record<Team, number>, bumped?: Team): void;
  setStatus(text: string): void;
  setRod(slot: number, auto: boolean, announce?: boolean): void;
  setSound(on: boolean): void;
  setTimer(ms: number): void;

  flash(color?: string): void;
  speedLines(): void;
  vignette(on: boolean): void;
}

const SLOT_NAMES = ["Goalie", "Defence", "Midfield", "Attack"];
const SLOT_SHORT = ["GK", "DEF", "MID", "ATT"];

export function createHud(root: HTMLElement, handlers: HudHandlers): Hud {
  root.innerHTML = "";

  const canvasHost = document.createElement("div");
  canvasHost.className = "canvas-host";

  const vignette = document.createElement("div");
  vignette.className = "fx fx-vignette";
  const speed = document.createElement("div");
  speed.className = "fx fx-speed";
  const flash = document.createElement("div");
  flash.className = "fx fx-flash";

  const wordsLayer = document.createElement("div");
  wordsLayer.className = "words-layer";

  const hud = document.createElement("div");
  hud.className = "hud";
  hud.innerHTML = `
    <div class="scoreboard">
      <div class="plate left"><span class="score" data-s="left">0</span><div class="who"><span class="you" hidden>YOU</span><span class="name" data-n="left">BLUE</span></div></div>
      <div class="vs"><small>FIRST TO ${MATCH_SCORE_TO_WIN}</small><b data-timer>0:00</b></div>
      <div class="plate right"><span class="score" data-s="right">0</span><div class="who"><span class="you" hidden>YOU</span><span class="name" data-n="right">RED</span></div></div>
    </div>
    <div class="hud-corner left"><button class="icon-btn" data-act="pause" aria-label="Pause">II</button></div>
    <div class="hud-corner right"><button class="icon-btn" data-act="sound" aria-label="Sound">♪</button></div>
    <div class="status"></div>
    <div class="rod-tag"></div>
    <div class="keys"><b>1–4</b> rod &nbsp; <b>MOUSE</b> slide + tilt &nbsp; <b>CLICK</b> kick &nbsp; <b>A</b> auto</div>
    <div class="controls">
      <div class="chips">
        <button class="chip auto" data-auto>AUTO</button>
        ${SLOT_SHORT.map((s, i) => `<button class="chip" data-slot="${i}">${s}</button>`).join("")}
      </div>
      <button class="kick-btn" data-act="kick">KICK</button>
    </div>`;

  const toast = document.createElement("div");
  toast.className = "toast";

  root.append(canvasHost, vignette, speed, flash, wordsLayer, hud, toast);

  const q = <T extends HTMLElement>(sel: string): T => hud.querySelector<T>(sel)!;
  const scoreEls: Record<Team, HTMLElement> = { left: q('[data-s="left"]'), right: q('[data-s="right"]') };
  const nameEls: Record<Team, HTMLElement> = { left: q('[data-n="left"]'), right: q('[data-n="right"]') };
  const youEls = hud.querySelectorAll<HTMLElement>(".you");
  const plates: Record<Team, HTMLElement> = { left: q(".plate.left"), right: q(".plate.right") };
  const status = q(".status");
  const timer = q("[data-timer]");
  const tag = q(".rod-tag");
  const soundBtn = q<HTMLButtonElement>('[data-act="sound"]');
  const chips = hud.querySelectorAll<HTMLButtonElement>("[data-slot]");
  const autoChip = q<HTMLButtonElement>("[data-auto]");

  // Wire the buttons. Pointer-down feels snappier than click on touch.
  hud.addEventListener("pointerdown", (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>("button");
    if (!target) return;
    event.stopPropagation(); // keep taps on buttons away from the game's own pointer handling
    const act = target.dataset.act;
    if (act === "pause") handlers.onPause();
    else if (act === "sound") handlers.onSound();
    else if (act === "kick") handlers.onKick();
    else if (target.dataset.slot !== undefined) handlers.onSelectSlot(Number(target.dataset.slot));
    else if (target.hasAttribute("data-auto")) handlers.onToggleAuto();
  });

  let toastTimer: number | null = null;
  let tagTimer: number | null = null;
  let lastTimerText = "";

  const setSound = (on: boolean): void => {
    soundBtn.classList.toggle("off", !on);
    soundBtn.textContent = on ? "♪" : "×";
  };
  setSound(settings.sound);

  return {
    canvasHost,
    wordsLayer,

    query: (selector: string) => hud.querySelector<HTMLElement>(selector),

    toast(text: string, ms = 1800): void {
      toast.textContent = text;
      toast.classList.add("on");
      if (toastTimer) window.clearTimeout(toastTimer);
      toastTimer = window.setTimeout(() => toast.classList.remove("on"), ms);
    },

    show(on: boolean): void {
      hud.classList.toggle("on", on);
    },

    setTouch(on: boolean): void {
      hud.classList.toggle("touch", on);
    },

    setNames(names: Record<Team, string>, mine: Team | null): void {
      nameEls.left.textContent = names.left;
      nameEls.right.textContent = names.right;
      youEls[0].hidden = mine !== "left";
      youEls[1].hidden = mine !== "right";
      plates.left.classList.toggle("mine", mine === "left");
      plates.right.classList.toggle("mine", mine === "right");
    },

    setScore(score: Record<Team, number>, bumped?: Team): void {
      for (const team of ["left", "right"] as const) {
        const el = scoreEls[team];
        const text = String(score[team]);
        if (el.textContent !== text) {
          el.textContent = text;
          if (team === bumped) {
            el.classList.remove("bump");
            void el.offsetWidth; // restart the animation
            el.classList.add("bump");
          }
        }
      }
    },

    setStatus(text: string): void {
      status.textContent = text;
    },

    setRod(slot: number, auto: boolean, announce = true): void {
      chips.forEach((chip, i) => chip.classList.toggle("on", i === slot));
      autoChip.classList.toggle("on", auto);
      if (!announce) return;
      tag.textContent = `${slot + 1} · ${SLOT_NAMES[slot]}${auto ? " · auto" : ""}`;
      tag.classList.add("on");
      if (tagTimer) window.clearTimeout(tagTimer);
      tagTimer = window.setTimeout(() => tag.classList.remove("on"), 900);
    },

    setSound,

    setTimer(ms: number): void {
      const s = Math.floor(ms / 1000);
      const text = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
      if (text !== lastTimerText) {
        lastTimerText = text;
        timer.textContent = text;
      }
    },

    flash(color = "#ffd23f"): void {
      flash.style.setProperty("--flash", color);
      flash.classList.remove("go");
      void flash.offsetWidth;
      flash.classList.add("go");
    },

    speedLines(): void {
      speed.classList.remove("go");
      void speed.offsetWidth;
      speed.classList.add("go");
    },

    vignette(on: boolean): void {
      vignette.classList.toggle("on", on);
    },
  };
}
