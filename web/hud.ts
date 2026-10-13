import type { Team } from "@shared/constants";

/**
 * Screen overlay: canvas host, scoreboard, status line and controls hint.
 * Kept as plain DOM so the 3D scene stays free of UI concerns.
 */
export interface Hud {
  /** Element the WebGL canvas should be mounted into. */
  canvasHost(): HTMLElement;
  status(text: string): void;
  score(score: Record<Team, number>): void;
  /** Flash a message when a goal goes in. */
  goal(team: Team): void;
  end(winner: Team | "draw"): void;
  /** Highlight which rod is selected (0..3). */
  select(slot: number): void;
}

const SLOT_NAMES = ["goalie", "defence", "midfield", "attack"];

export function createHud(host: HTMLElement): Hud {
  host.innerHTML = "";

  const canvasHost = document.createElement("div");
  canvasHost.className = "canvas-host";

  const overlay = document.createElement("div");
  overlay.className = "overlay";

  const scoreboard = document.createElement("div");
  scoreboard.className = "scoreboard";
  scoreboard.innerHTML = `<span class="score score-left">0</span><span class="score-sep">–</span><span class="score score-right">0</span>`;

  const flash = document.createElement("div");
  flash.className = "flash";

  const statusLine = document.createElement("div");
  statusLine.className = "status";

  const help = document.createElement("div");
  help.className = "help";
  help.innerHTML =
    `<b>1–4</b> pick rod &nbsp;·&nbsp; <b>move mouse</b> slide / rotate &nbsp;·&nbsp; <span class="rod-name"></span>`;

  const hint = document.createElement("div");
  hint.className = "rod-hint";

  overlay.append(scoreboard, flash, statusLine, help, hint);
  host.append(canvasHost, overlay);

  const leftScore = scoreboard.querySelector<HTMLElement>(".score-left");
  const rightScore = scoreboard.querySelector<HTMLElement>(".score-right");
  const rodName = help.querySelector<HTMLElement>(".rod-name");

  let flashTimer: ReturnType<typeof setTimeout> | null = null;

  const showFlash = (text: string, tone: "goal" | "end"): void => {
    flash.textContent = text;
    flash.className = `flash flash-${tone} flash-on`;
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      flash.className = "flash";
    }, 1600);
  };

  const showSlot = (slot: number): void => {
    const name = SLOT_NAMES[slot] ?? "";
    if (rodName) rodName.textContent = name;
    hint.textContent = `${slot + 1} · ${name}`;
    hint.className = "rod-hint rod-hint-on";
    setTimeout(() => {
      hint.className = "rod-hint";
    }, 900);
  };

  showSlot(2);

  return {
    canvasHost: () => canvasHost,
    status(text: string): void {
      statusLine.textContent = text;
    },
    score(score: Record<Team, number>): void {
      if (leftScore) leftScore.textContent = String(score.left);
      if (rightScore) rightScore.textContent = String(score.right);
    },
    goal(team: Team): void {
      showFlash("GOAL!", "goal");
      void team;
    },
    end(winner: Team | "draw"): void {
      showFlash(winner === "draw" ? "DRAW" : `${winner.toUpperCase()} WINS`, "end");
    },
    select(slot: number): void {
      showSlot(slot);
    },
  };
}
