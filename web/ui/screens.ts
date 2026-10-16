import type { Team } from "@shared/constants";
import type { Difficulty } from "@shared/bot";
import type { MatchStats } from "@shared/types";
import { sfx } from "../audio";
import { saveSettings, settings } from "../settings";
import type { Identity, Leaderboard } from "../vatar/client";

/**
 * Menus and overlays. Each screen is a full-viewport layer built on demand;
 * only one is open at a time. Callbacks are passed in at the call site, so
 * the game owns all behaviour and this file owns only markup and wiring.
 */

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export interface ResultView {
  /** Outcome for the local player. */
  outcome: "win" | "lose" | "draw";
  mine: Team;
  names: Record<Team, string>;
  score: Record<Team, number>;
  stats: MatchStats;
  forfeit: boolean;
  /** Leaderboard points earned, and how that compares. */
  points: number;
  best: number;
  isBest: boolean;
  /** "solo" can always restart; online needs the opponent. */
  mode: "solo" | "online";
}

const DIFFS: { id: Difficulty; name: string; blurb: string; stars: string }[] = [
  { id: "rookie", name: "ROOKIE", blurb: "Slow reactions. Perfect for warming up.", stars: "★☆☆" },
  { id: "pro", name: "PRO", blurb: "Quick feet and a decent shot.", stars: "★★☆" },
  { id: "legend", name: "LEGEND", blurb: "Reads the ball early. Good luck.", stars: "★★★" },
];

export class Screens {
  private current: HTMLElement | null = null;

  constructor(private readonly root: HTMLElement) {}

  /** Close whatever is open. */
  close(): void {
    this.current?.remove();
    this.current = null;
  }

  isOpen(): boolean {
    return this.current !== null;
  }

  private open(className: string, html: string, dim = false): HTMLElement {
    this.close();
    const el = document.createElement("div");
    el.className = `screen on ${dim ? "dim" : ""} ${className}`;
    el.innerHTML = html;
    this.root.appendChild(el);
    this.current = el;
    return el;
  }

  /** Delegate clicks on `[data-go]` elements to a handler map. Uses pointerup-ish click. */
  private bind(el: HTMLElement, actions: Record<string, (target: HTMLElement) => void>): void {
    el.addEventListener("click", (event) => {
      const target = (event.target as HTMLElement).closest<HTMLElement>("[data-go]");
      if (!target || target.hasAttribute("disabled")) return;
      sfx.unlock();
      sfx.click();
      actions[target.dataset.go!]?.(target);
    });
  }

  private toggles(el: HTMLElement, extra: { auto: boolean } = { auto: true }): void {
    const holder = el.querySelector<HTMLElement>("[data-toggles]");
    if (!holder) return;
    const draw = (): void => {
      holder.innerHTML = `
        <button class="toggle ${settings.sound ? "on" : ""}" data-t="sound">SOUND ${settings.sound ? "ON" : "OFF"}</button>
        <button class="toggle ${settings.haptics ? "on" : ""}" data-t="haptics">BUZZ ${settings.haptics ? "ON" : "OFF"}</button>
        ${extra.auto ? `<button class="toggle ${settings.autoRod ? "on" : ""}" data-t="autoRod">AUTO ROD ${settings.autoRod ? "ON" : "OFF"}</button>` : ""}`;
    };
    draw();
    holder.addEventListener("click", (event) => {
      const key = (event.target as HTMLElement).dataset.t as "sound" | "haptics" | "autoRod" | undefined;
      if (!key) return;
      sfx.unlock();
      saveSettings({ [key]: !settings[key] });
      if (key === "sound") sfx.click();
      draw();
    });
  }

  /* ─────────────────────────────── home ─────────────────────────────── */

  home(identity: Identity, best: number, actions: {
    online(): void;
    solo(): void;
    friend(): void;
    leaderboard(): void;
    howTo(): void;
    /** The shop button; absent outside Lagos Life, where nothing can be bought. */
    shop?: { owned: boolean; buy(): void };
  }): { ready(): void; progress(fraction: number): void } {
    const initial = esc((identity.name || "P").slice(0, 1).toUpperCase());
    const avatar = identity.avatar
      ? `<span class="avatar" style="background-image:url('${esc(identity.avatar)}')"></span>`
      : `<span class="avatar">${initial}</span>`;

    const letters = (word: string, offset: number): string =>
      [...word].map((c, i) => `<span class="ch" style="--i:${i + offset}">${c}</span>`).join("");

    const el = this.open(
      "home",
      `
      <h1 class="title">
        <div class="row top">${letters("LAGOS", 0)}</div>
        <div class="row bottom">${letters("FOOSBALL", 5)}</div>
      </h1>
      <div class="tagline">TABLE FOOTBALL · TURNED UP TO ELEVEN</div>
      <div class="player-chip">${avatar}<div>${esc(identity.name)}<small>${best > 0 ? `BEST ${best.toLocaleString()}` : identity.connected ? "LAGOS LIFE" : "PLAYING LOCALLY"}</small></div></div>
      <div class="loading" data-loading><i></i></div>
      <div class="menu" data-menu hidden>
        <button class="btn blue" data-go="online">PLAY ONLINE<small>quick match vs a real player</small></button>
        <button class="btn red" data-go="solo">VS BOT<small>solo · three difficulty levels</small></button>
        <button class="btn green" data-go="friend">PLAY A FRIEND<small>private room code</small></button>
        <div class="row-btns">
          <button class="btn ghost" data-go="board">🏆 SCORES</button>
          <button class="btn ghost" data-go="howto">❓ HOW TO PLAY</button>
        </div>
        ${actions.shop ? `<button class="btn ghost" data-go="shop" ${actions.shop.owned ? "disabled" : ""}>✨ ${actions.shop.owned ? "GOLD KIT · OWNED" : "GOLD KIT"}</button>` : ""}
      </div>
      <div class="toggles" data-toggles></div>`,
    );
    this.toggles(el);
    this.bind(el, {
      online: actions.online,
      solo: actions.solo,
      friend: actions.friend,
      board: actions.leaderboard,
      howto: actions.howTo,
      shop: () => actions.shop?.buy(),
    });

    const loading = el.querySelector<HTMLElement>("[data-loading]")!;
    const menu = el.querySelector<HTMLElement>("[data-menu]")!;
    return {
      progress: (fraction) => loading.style.setProperty("--p", `${Math.round(fraction * 100)}%`),
      ready: () => {
        loading.hidden = true;
        menu.hidden = false;
        menu.animate(
          [
            { transform: "translateY(40px) scale(0.9)", opacity: 0 },
            { transform: "none", opacity: 1 },
          ],
          { duration: 450, easing: "cubic-bezier(.2,1.4,.4,1)" },
        );
      },
    };
  }

  /* ───────────────────────────── solo picker ───────────────────────────── */

  difficulty(current: Difficulty, pick: (d: Difficulty) => void, back: () => void): void {
    const el = this.open(
      "pick",
      `<div class="panel">
        <h2>PICK YOUR RIVAL</h2>
        <div class="diffs">
          ${DIFFS.map(
            (d) => `<button class="diff ${d.id === current ? "on" : ""}" data-go="${d.id}">
              <div>${d.name}<small>${d.blurb}</small></div><span class="stars">${d.stars}</span></button>`,
          ).join("")}
        </div>
        <p>You play BLUE. First to 5 wins.</p>
        <button class="btn ghost tiny" data-go="back">← BACK</button>
      </div>`,
      true,
    );
    const actions: Record<string, () => void> = { back };
    for (const d of DIFFS) actions[d.id] = () => pick(d.id);
    this.bind(el, actions);
  }

  /* ─────────────────────────────── friends ─────────────────────────────── */

  friend(actions: { create(): void; join(code: string): void; back(): void }, prefill = ""): void {
    const el = this.open(
      "friend",
      `<div class="panel">
        <h2>PLAY A FRIEND</h2>
        <button class="btn green" data-go="create">CREATE A ROOM<small>you get a code to share</small></button>
        <div class="divider">OR JOIN ONE</div>
        <input class="text-input" data-code maxlength="5" placeholder="CODE" autocomplete="off" autocapitalize="characters" spellcheck="false" value="${esc(prefill)}" />
        <button class="btn blue" data-go="join">JOIN</button>
        <button class="btn ghost tiny" data-go="back">← BACK</button>
      </div>`,
      true,
    );
    const input = el.querySelector<HTMLInputElement>("[data-code]")!;
    const join = (): void => {
      const code = input.value.trim().toUpperCase();
      if (code.length >= 4) actions.join(code);
      else input.animate([{ transform: "translateX(-8px)" }, { transform: "translateX(8px)" }, { transform: "none" }], { duration: 220 });
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") join();
    });
    this.bind(el, { create: actions.create, join, back: actions.back });
  }

  /* ─────────────────────────────── waiting ─────────────────────────────── */

  waiting(
    message: string,
    roomCode: string | undefined,
    actions: { cancel(): void; bot?: () => void; share?: () => void },
  ): { update(message: string, roomCode?: string): void; offerBot(): void } {
    const html = (msg: string, code?: string): string => `
      <div class="spinner"></div>
      <div class="result-title" style="font-size:clamp(28px,7vmin,52px);--fill:#fff">${esc(msg)}</div>
      ${code ? `<div class="panel" style="width:min(88vw,380px)"><p>Send your friend this code</p><div class="code">${esc(code)}</div><button class="btn ghost tiny" data-go="share">COPY INVITE LINK</button></div>` : ""}
      <div class="row-btns">
        <button class="btn ghost tiny" data-go="bot" hidden>PLAY THE BOT INSTEAD</button>
        <button class="btn ghost tiny" data-go="cancel">CANCEL</button>
      </div>`;
    const el = this.open("waiting", html(message, roomCode), true);
    const wire = (): void => {
      this.bind(el, {
        cancel: actions.cancel,
        bot: () => actions.bot?.(),
        share: () => actions.share?.(),
      });
    };
    // `bind` adds a listener each call, so wire once and re-render only the inside.
    wire();
    let showBot = false;
    return {
      update: (msg, code) => {
        el.innerHTML = html(msg, code);
        const botBtn = el.querySelector<HTMLElement>('[data-go="bot"]');
        if (botBtn) botBtn.hidden = !showBot || !actions.bot;
      },
      offerBot: () => {
        showBot = true;
        const botBtn = el.querySelector<HTMLElement>('[data-go="bot"]');
        if (botBtn && actions.bot) botBtn.hidden = false;
      },
    };
  }

  /**
   * The match is made but the other player isn't ready (maybe they're in the
   * tutorial). There is no cancel button at first: they've accepted, so we
   * give them a proper chance. It comes back after `cancelAfterMs`.
   */
  hold(actions: { cancel(): void }, cancelAfterMs = 45_000): void {
    const el = this.open(
      "hold",
      `<div class="spinner"></div>
       <div class="result-title" style="font-size:clamp(26px,6.5vmin,46px);--fill:#fff">OPPONENT FOUND!</div>
       <div class="hint" style="font-size:16px">They're getting ready — learning the ropes.<br/>Hang tight, kick-off is coming!</div>
       <div class="row-btns"><button class="btn ghost tiny" data-go="cancel" hidden>LEAVE</button></div>`,
      true,
    );
    this.bind(el, { cancel: actions.cancel });
    const timer = window.setTimeout(() => {
      const btn = el.querySelector<HTMLElement>('[data-go="cancel"]');
      if (btn) btn.hidden = false;
    }, cancelAfterMs);
    const remove = el.remove.bind(el);
    el.remove = () => {
      window.clearTimeout(timer);
      remove();
    };
  }

  /* ────────────────────────────── leaderboard ────────────────────────────── */

  leaderboard(board: Leaderboard | null, back: () => void): void {
    let body: string;
    if (!board) {
      body = `<p>Loading…</p>`;
    } else if (board.top.length === 0 && !board.me) {
      body = `<p>No scores yet. Win a match and you'll be the first!</p>`;
    } else {
      const rows = board.top
        .map(
          (r) => `<div class="row ${board.me && board.me.rank === r.rank ? "me" : ""}"><span class="rank">${r.rank}</span><span class="nm">${esc(r.name)}</span><span class="pts">${r.score.toLocaleString()}</span></div>`,
        )
        .join("");
      const me =
        board.me && !board.top.some((r) => r.rank === board.me!.rank)
          ? `<div class="divider">YOU</div><div class="row me"><span class="rank">${board.me.rank}</span><span class="nm">${esc(board.me.label)}</span><span class="pts">${board.me.score.toLocaleString()}</span></div>`
          : "";
      body = `<div class="board">${rows}${me}</div>${board.local ? "<p>Offline — this is just your best score on this device.</p>" : ""}`;
    }
    const html = `<div class="panel"><h2>🏆 TOP PLAYERS</h2>${body}<button class="btn ghost tiny" data-go="back">← BACK</button></div>`;
    if (this.current?.classList.contains("lb")) {
      this.current.innerHTML = html;
      return;
    }
    const el = this.open("lb", html, true);
    this.bind(el, { back });
  }

  /* ─────────────────────────────── pause ─────────────────────────────── */

  pause(solo: boolean, actions: { resume(): void; restart(): void; quit(): void }): void {
    const el = this.open(
      "pause",
      `<div class="panel">
        <h2>${solo ? "PAUSED" : "MENU"}</h2>
        <button class="btn green" data-go="resume">${solo ? "RESUME" : "KEEP PLAYING"}</button>
        ${solo ? `<button class="btn" data-go="restart">RESTART</button>` : ""}
        <button class="btn red" data-go="quit">${solo ? "QUIT TO MENU" : "LEAVE MATCH"}<small>${solo ? "" : "you will forfeit"}</small></button>
        <div class="toggles" data-toggles></div>
      </div>`,
      true,
    );
    this.toggles(el);
    this.bind(el, actions);
  }

  /* ─────────────────────────────── results ─────────────────────────────── */

  results(r: ResultView, actions: { again(): void; menu(): void }): { rematchOffered(): void; waiting(): void } {
    const title = r.outcome === "win" ? "YOU WIN!" : r.outcome === "lose" ? "YOU LOSE" : "DRAW";
    const fill = r.outcome === "win" ? "#ffd23f" : r.outcome === "lose" ? "#ff8a8a" : "#fff";
    const mine = r.stats.fastest[r.mine];
    const kmh = Math.round(mine * 14);
    const el = this.open(
      "results",
      `
      <div class="result-title" style="--fill:${fill}">${title}</div>
      ${r.forfeit ? `<div class="hint">Your opponent left the match</div>` : ""}
      <div class="final"><span class="l">${r.score.left}</span><span class="dash">–</span><span class="r">${r.score.right}</span></div>
      <div class="hint">${esc(r.names.left)} vs ${esc(r.names.right)}</div>
      <div class="stats">
        <div class="stat"><b>${kmh}</b><span>TOP SHOT KM/H</span></div>
        <div class="stat"><b>${r.stats.saves[r.mine]}</b><span>SAVES</span></div>
        <div class="stat"><b>+${r.points.toLocaleString()}</b><span>POINTS</span></div>
      </div>
      ${r.isBest ? `<div class="badge">NEW PERSONAL BEST!</div>` : `<div class="hint">BEST ${r.best.toLocaleString()}</div>`}
      <div class="row-btns">
        <button class="btn green" data-go="again" ${r.forfeit ? "disabled" : ""}>${r.mode === "solo" ? "PLAY AGAIN" : "REMATCH"}</button>
        <button class="btn" data-go="menu">MENU</button>
      </div>`,
      true,
    );
    this.bind(el, { again: actions.again, menu: actions.menu });
    const again = el.querySelector<HTMLButtonElement>('[data-go="again"]')!;
    return {
      rematchOffered: () => {
        again.innerHTML = "REMATCH<small>they want another!</small>";
      },
      waiting: () => {
        again.innerHTML = "WAITING…<small>for your opponent</small>";
        again.setAttribute("disabled", "");
      },
    };
  }

  /* ─────────────────────────────── error ─────────────────────────────── */

  error(message: string, actions: { menu(): void; solo?: () => void }): void {
    const el = this.open(
      "error",
      `<div class="panel">
        <h2>OOPS!</h2>
        <p>${esc(message)}</p>
        ${actions.solo ? `<button class="btn red" data-go="solo">PLAY VS BOT</button>` : ""}
        <button class="btn ghost" data-go="menu">BACK TO MENU</button>
      </div>`,
      true,
    );
    this.bind(el, { menu: actions.menu, solo: () => actions.solo?.() });
  }
}
