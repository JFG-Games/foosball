import { Vector3 } from "three";
import type { Difficulty } from "@shared/bot";
import { MATCH_TIME_LIMIT_MS, RODS, TABLE, type Team } from "@shared/constants";
import type { RodState, Vec3 } from "@shared/types";
import { sfx } from "../audio";
import { SERVER_URL } from "../config";
import { CameraRig } from "../fx/camera";
import { Juice } from "../fx/juice";
import { Particles } from "../fx/particles";
import { createStage, type Stage } from "../scene/stage";
import { loadBallModel } from "../scene/ball";
import { loadFigureGeometry } from "../scene/figure";
import { createTable, type TableView } from "../scene/table";
import { readStat, saveSettings, settings, writeStat } from "../settings";
import { equip, equippedFor, SHOP, unequip } from "../shop";
import { other } from "../theme";
import { createHud, type Hud } from "../ui/hud";
import { Screens } from "../ui/screens";
import { Tutorial, type Rect, type TutorialStep } from "../ui/tutorial";
import { Words } from "../ui/words";
import {
  bestScore,
  buyProduct,
  currentMatchId,
  fetchLeaderboard,
  freshSession,
  initVatar,
  onPlatformPause,
  owns,
  quickPlatformMatch,
  submitScore,
  syncPurchases,
  type Identity,
  type PlatformWait,
} from "../vatar/client";
import { createInput, type InputController } from "./input";
import { matchPoints, outcomeFor } from "./scoring";
import { LocalSession, OnlineSession, type Session, type SessionEvent } from "./session";

type Phase = "idle" | "countdown" | "play" | "goal" | "over";

/** After this long in the quick-match queue, offer to play the bot instead. */
const OFFER_BOT_AFTER_MS = 7000;

const isTouchDevice = (): boolean =>
  typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;

/**
 * The whole client. It owns the renderer, the menus and the current match,
 * and wires the pieces together:
 *
 *   Session (solo bot or online) ──events──▶ Game ──▶ Juice (sound, shake, words…)
 *                                              ├────▶ Hud / Screens
 *   Input ──rods──▶ Session                    └────▶ Table (what you see)
 */
export class Game {
  private readonly hud: Hud;
  private readonly screens: Screens;
  private readonly words: Words;
  private stage!: Stage;
  private rig!: CameraRig;
  private particles!: Particles;
  private table: TableView | null = null;
  private juice!: Juice;

  private identity!: Identity;
  private session: Session | null = null;
  private input: InputController | null = null;
  private myTeam: Team = "left";
  private phase: Phase = "idle";
  private score: Record<Team, number> = { left: 0, right: 0 };
  private firstServe = true;
  private ending = false;
  private playMs = 0;
  private lastFrame = performance.now();
  private lastLiveBall: Vec3 | null = null;
  private lastDrawnBall: Vec3 | null = null;
  private timers: number[] = [];
  private wakeLock: { release(): Promise<void> } | null = null;
  private resultView: ReturnType<Screens["results"]> | null = null;
  private waitUi: ReturnType<Screens["waiting"]> | null = null;
  private readonly touch = isTouchDevice();
  private readonly rowProbe = new Vector3();
  private readonly tutorial: Tutorial;
  private forceTutorial = false;
  private iAmReady = false;
  private opponentReady = true;
  private holdOpen = false;

  constructor(private readonly root: HTMLElement) {
    this.hud = createHud(root, {
      onPause: () => this.togglePause(),
      onSound: () => {
        sfx.unlock();
        saveSettings({ sound: !settings.sound });
        this.hud.setSound(settings.sound);
        sfx.click();
      },
      onSelectSlot: (slot) => {
        sfx.unlock();
        this.input?.selectSlot(slot);
      },
      onToggleAuto: () => {
        sfx.unlock();
        if (!this.input) return;
        this.input.setAuto(!this.input.isAuto());
        saveSettings({ autoRod: this.input.isAuto() });
      },
      onKick: () => {
        sfx.unlock();
        this.input?.kick();
      },
    });
    this.screens = new Screens(root);
    this.words = new Words(this.hud.wordsLayer);
    this.tutorial = new Tutorial(root);
    this.hud.setTouch(this.touch);
  }

  /* ───────────────────────────────── boot ───────────────────────────────── */

  async boot(): Promise<void> {
    this.root.addEventListener("contextmenu", (e) => e.preventDefault());
    // The first gesture unlocks audio (browsers require it).
    window.addEventListener("pointerdown", () => sfx.unlock(), { once: true });
    window.addEventListener("keydown", () => sfx.unlock(), { once: true });
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.togglePause();
    });
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) this.autoPause();
      else {
        sfx.resume();
        void this.acquireWakeLock();
      }
    });

    this.stage = createStage(this.hud.canvasHost);
    this.rig = new CameraRig(this.stage.camera);
    this.particles = new Particles();
    this.stage.scene.add(this.particles.group);
    this.stage.resize();
    this.rig.fit(this.stage.width, this.stage.height, this.margins());
    requestAnimationFrame((t) => this.frame(t));

    // Identity and assets load side by side.
    let figureProgress = 0;
    let home: ReturnType<Screens["home"]> | null = null;
    const report = (): void => home?.progress(figureProgress * 0.9 + 0.1);

    const assets = Promise.all([
      loadFigureGeometry(`${import.meta.env.BASE_URL}foosball_player.glb`, (p) => {
        figureProgress = p;
        report();
      }),
      loadBallModel(`${import.meta.env.BASE_URL}soccer_ball.glb`),
    ]);

    this.identity = await initVatar();
    // Restore purchases, but never hold the menu up for a slow server.
    await Promise.race([syncPurchases(), new Promise((resolve) => window.setTimeout(resolve, 2500))]);
    onPlatformPause(
      () => this.autoPause(),
      () => sfx.resume(),
    );

    home = this.showHome();
    report();

    const [figure, ball] = await assets;
    this.table = createTable({ figure, ball });
    this.stage.scene.add(this.table.group);
    this.juice = new Juice({
      table: this.table,
      rig: this.rig,
      particles: this.particles,
      words: this.words,
      hud: this.hud,
      camera: this.stage.camera,
      layer: this.hud.wordsLayer,
    });
    this.table.apply(Array.from({ length: 8 }, () => ({ angle: 0, offset: 0 })), { x: 0, y: TABLE.ballRadius, z: 0 });
    this.stage.renderer.compile(this.stage.scene, this.stage.camera); // avoid a first-frame hitch
    this.rig.mode = "attract";
    this.stage.onQualityChange = (q) => console.info("[stage] quality lowered to tier", q);
    home.ready();

    if (import.meta.env.DEV || new URLSearchParams(location.search).has("debug")) {
      (window as unknown as { __game: Game }).__game = this;
    }

    // Deep links: ?room=CODE opens the join screen, ?solo=pro jumps into a bot match.
    const params = new URLSearchParams(location.search);
    if (params.has("tutorial")) this.forceTutorial = true; // ?tutorial replays the walkthrough
    const solo = params.get("solo") as Difficulty | null;
    if (solo && ["rookie", "pro", "legend"].includes(solo)) this.startSolo(solo);
    else if (params.get("room")) this.openFriend(params.get("room")!.toUpperCase().slice(0, 5));
  }

  /* ───────────────────────────────── menus ───────────────────────────────── */

  private showHome(): ReturnType<Screens["home"]> {
    this.rig.mode = "attract";
    this.hud.show(false);
    return this.screens.home(this.identity, bestScore(), {
      online: () => this.startOnline({}),
      solo: () => this.pickDifficulty(),
      friend: () => this.openFriend(),
      leaderboard: () => this.openLeaderboard(),
      howTo: () => {
        this.forceTutorial = true;
        this.startSolo("rookie");
      },
      shop: this.identity.connected ? () => this.openShop() : undefined,
    });
  }

  private openShop(): void {
    const items = SHOP.map((item) => ({
      ...item,
      state: !owns(item.id) ? ("buy" as const) : equippedFor(item.kind)?.id === item.id ? ("on" as const) : ("equip" as const),
    }));
    this.screens.shop(items, { act: (id) => void this.shopAct(id), back: () => this.backToMenu() });
  }

  /** Buy an item, or switch one you own on or off. */
  private async shopAct(id: string): Promise<void> {
    const item = SHOP.find((candidate) => candidate.id === id);
    if (!item) return;
    if (!owns(id)) {
      const result = await buyProduct(id);
      if (result === "cancelled") return; // backed out of the pay sheet: stay in the shop
      if (result === "unlock_failed") {
        this.screens.error("Your payment went through, but we could not unlock it yet. It will unlock the next time you open the game.", {
          menu: () => this.backToMenu(),
        });
        return;
      }
      equip(item); // use what you just bought
    } else if (equippedFor(item.kind)?.id === id) {
      unequip(item.kind);
    } else {
      equip(item);
    }
    this.openShop();
  }

  private backToMenu(): void {
    this.teardownMatch();
    const home = this.showHome();
    home.ready();
  }

  private pickDifficulty(): void {
    this.screens.difficulty(
      settings.difficulty,
      (d) => {
        saveSettings({ difficulty: d });
        this.startSolo(d);
      },
      () => this.backToMenu(),
    );
  }

  private openFriend(prefill = ""): void {
    this.screens.friend(
      {
        create: () => this.startOnline({ create: true }),
        join: (code) => this.startOnline({ roomCode: code }),
        back: () => this.backToMenu(),
      },
      prefill,
    );
  }

  private openLeaderboard(): void {
    this.screens.leaderboard(null, () => this.backToMenu());
    void fetchLeaderboard().then((board) => {
      if (this.screens.isOpen()) this.screens.leaderboard(board, () => this.backToMenu());
    });
  }

  /* ──────────────────────────── starting matches ──────────────────────────── */

  startSolo(difficulty: Difficulty): void {
    this.teardownMatch();
    const session = new LocalSession(this.identity.name, difficulty);
    this.attach(session);
    session.begin();
  }

  private async startOnline(opts: { roomCode?: string; create?: boolean }): Promise<void> {
    this.teardownMatch();
    this.screens.close();
    const gen = this.startGen;
    const quick = !opts.create && !opts.roomCode;

    this.waitUi = this.screens.waiting("Connecting…", undefined, {
      cancel: () => this.backToMenu(),
      bot: quick ? () => this.startSolo(settings.difficulty) : undefined,
      share: () => void this.shareInvite(),
    });
    if (quick) this.timers.push(window.setTimeout(() => this.waitUi?.offerBot(), OFFER_BOT_AFTER_MS));

    // A quick match is paired by Lagos Life, so it exists on the platform and its result can be posted.
    let vatarMatchId = await currentMatchId();
    if (gen !== this.startGen) return;
    if (quick && !vatarMatchId) {
      const wait = quickPlatformMatch();
      this.platformWait = wait;
      this.waitUi?.update("Finding an opponent…");
      vatarMatchId = await wait.match;
      if (gen !== this.startGen) return; // cancelled while waiting
      this.platformWait = null;
      this.waitUi?.update("Connecting…");
    }

    const token = await freshSession();
    if (gen !== this.startGen) return;
    const session = new OnlineSession({
      url: SERVER_URL,
      sessionToken: token,
      name: this.identity.name,
      roomCode: opts.roomCode,
      create: opts.create,
      vatarMatchId,
      refreshToken: freshSession,
    });
    this.attach(session);
  }

  private inviteCode: string | undefined;
  /** Bumped whenever a match is torn down, so a half-started online join can notice and stop. */
  private startGen = 0;
  private platformWait: PlatformWait | null = null;

  private async shareInvite(): Promise<void> {
    if (!this.inviteCode) return;
    const url = `${location.origin}${location.pathname}?room=${this.inviteCode}`;
    try {
      if (navigator.share) await navigator.share({ title: "Lagos Foosball", text: `Join my foosball room: ${this.inviteCode}`, url });
      else {
        await navigator.clipboard.writeText(url);
        this.hud.toast("Invite link copied!");
      }
    } catch {
      this.hud.toast(`Code: ${this.inviteCode}`);
    }
  }

  private attach(session: Session): void {
    this.session = session;
    session.onEvent = (event) => this.onEvent(event);
  }

  /* ──────────────────────────────── events ──────────────────────────────── */

  private onEvent(e: SessionEvent): void {
    const session = this.session;
    if (!session) return;

    switch (e.t) {
      case "waiting":
        this.inviteCode = e.roomCode ?? this.inviteCode;
        this.waitUi?.update(e.message, e.roomCode);
        break;

      case "matched":
        this.enterMatch(session, e.names);
        this.beginReadyFlow(session);
        break;

      case "opponent":
        this.opponentReady = e.ready;
        this.updateHold();
        break;

      case "start":
        this.onStart(e.countdownMs);
        break;

      case "hits":
        for (const hit of e.hits) this.juice.hit(hit);
        break;

      case "goal":
        this.phase = "goal";
        this.score = e.score;
        this.juice.goal(e.team, e.ball, e.vel, this.lastDrawnBall, e.pauseMs, e.score);
        this.table?.setScore(e.score);
        break;

      case "serve":
        this.phase = "play";
        this.juice.serve(this.firstServe, this.score);
        this.firstServe = false;
        break;

      case "end":
        this.onEnd(e);
        break;

      case "rematch":
        this.resultView?.rematchOffered();
        break;

      case "error":
        this.teardownMatch();
        this.screens.error(e.message, {
          menu: () => this.backToMenu(),
          solo: () => this.startSolo(settings.difficulty),
        });
        break;

      case "link":
        this.onLink(e.state);
        break;

      case "closed":
        if (this.phase !== "over" && !this.ending) {
          this.teardownMatch();
          this.screens.error("Couldn't reach the game server. Check your connection, or play the bot instead.", {
            menu: () => this.backToMenu(),
            solo: () => this.startSolo(settings.difficulty),
          });
        }
        break;
    }
  }

  private matchStatus(session: Session): string {
    const side = this.myTeam === "left" ? "BLUE" : "RED";
    return `YOU ARE ${side} · VS ${session.names[other(this.myTeam)].toUpperCase()}`;
  }

  /** Connection trouble, ours or theirs. The server pauses play while someone reconnects. */
  private onLink(state: "reconnecting" | "restored" | "opponent_away" | "opponent_back"): void {
    const session = this.session;
    if (!session) return;
    switch (state) {
      case "reconnecting":
        this.hud.setStatus("CONNECTION LOST · RECONNECTING…");
        break;
      case "opponent_away":
        this.hud.setStatus("OPPONENT RECONNECTING… PLAY IS PAUSED");
        break;
      case "restored":
        this.hud.setStatus(this.matchStatus(session));
        this.hud.toast("Back in the game!");
        break;
      case "opponent_back":
        this.hud.setStatus(this.matchStatus(session));
        this.hud.toast("Opponent is back");
        break;
    }
  }

  /** Both sides are in: set up the stage, controls and HUD for this match. */
  private enterMatch(session: Session, names: Record<Team, string>): void {
    this.screens.close();
    this.waitUi = null;
    this.myTeam = session.team;

    this.rig.setTeam(this.myTeam);
    this.rig.mode = "play";
    this.rig.snap();
    this.rig.fit(this.stage.width, this.stage.height, this.margins());
    this.juice.reset();
    this.juice.myTeam = this.myTeam;
    this.juice.canSlowGame = session.mode === "solo";

    this.input?.dispose();
    this.input = createInput(this.hud.canvasHost, this.myTeam, settings.autoRod, {
      onSelect: (slot, auto) => {
        this.hud.setRod(slot, auto);
        this.table?.setActive(this.input?.activeRod() ?? null);
        sfx.click();
      },
      onKick: () => this.juice.kickStarted(),
      rodRowY: (rod) => this.rodRowY(rod),
    });
    this.hud.setRod(this.input.activeSlot(), this.input.isAuto(), false);
    this.table?.setActive(this.input.activeRod());

    this.hud.setNames(names, this.myTeam);
    this.hud.show(true);
    this.hud.setStatus(this.matchStatus(session));
    this.table?.setOwnTeam(this.myTeam);
    this.table?.setOwnKit(equippedFor("kit")?.color ?? null);
    this.juice.cosmetics = { trail: equippedFor("trail")?.color ?? null, party: equippedFor("party")?.color ?? null };
    void this.acquireWakeLock();
  }

  /**
   * Before kick-off: first-timers get the walkthrough, then we tell the session
   * we're ready. Online, the match starts when BOTH sides are ready, so the
   * other player simply waits (without a cancel button) while this one learns.
   */
  private beginReadyFlow(session: Session): void {
    this.iAmReady = false;
    this.opponentReady = session.mode === "solo";
    const needTutorial = this.forceTutorial || !readStat<boolean>("tutorialDone", false);
    this.forceTutorial = false;

    const go = (): void => {
      this.iAmReady = true;
      session.ready();
      this.updateHold();
    };
    if (!needTutorial) return go();

    this.rig.fit(this.stage.width, this.stage.height, this.margins());
    this.tutorial.run(this.tutorialSteps(), () => {
      writeStat("tutorialDone", true);
      go();
    });
  }

  /** Show the "opponent is getting ready" screen while we wait for them. */
  private updateHold(): void {
    const online = this.session?.mode === "online";
    const waiting = online && this.iAmReady && !this.opponentReady && this.phase === "idle";
    if (waiting && !this.holdOpen) {
      this.holdOpen = true;
      this.screens.hold({ cancel: () => this.backToMenu() });
    } else if (!waiting && this.holdOpen) {
      this.holdOpen = false;
      this.screens.close();
    }
  }

  /** Project world points to a viewport rectangle (for the tutorial to point at). */
  private screenRect(points: Vector3[], pad = 0): Rect {
    const host = this.hud.canvasHost.getBoundingClientRect();
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of points) {
      const v = p.clone().project(this.stage.camera);
      const x = host.left + (v.x * 0.5 + 0.5) * host.width;
      const y = host.top + (-v.y * 0.5 + 0.5) * host.height;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
    return { left: minX - pad, top: minY - pad, width: maxX - minX + pad * 2, height: maxY - minY + pad * 2 };
  }

  private tutorialSteps(): TutorialStep[] {
    const touch = this.touch;
    const colour = this.myTeam === "left" ? "BLUE" : "RED";
    const ownEnd = this.myTeam === "left" ? -1 : 1;
    const el = (sel: string): Rect | null => this.hud.query(sel)?.getBoundingClientRect() ?? null;
    const mineRods = RODS.filter((r) => r.team === this.myTeam);

    return [
      {
        title: "THIS IS YOU",
        body: `You play ${colour}. Score 3 goals before your rival does, or lead when the 3 minutes are up!`,
        target: () => el(".plate.mine") ?? el(".scoreboard"),
      },
      {
        title: "YOUR GOAL",
        body: "Guard it! The glowing goal is yours. If the ball rolls in, THEY score.",
        target: () =>
          this.screenRect(
            [new Vector3(ownEnd * 0.6, 0, -0.11), new Vector3(ownEnd * 0.6, 0, 0.11), new Vector3(ownEnd * 0.69, 0.07, -0.11), new Vector3(ownEnd * 0.69, 0.07, 0.11)],
            6,
          ),
      },
      {
        title: "THE BALL",
        body: "Get it into THEIR goal at the far end of the table to score.",
        target: () => this.screenRect([new Vector3(0, TABLE.ballRadius, 0)], 30),
      },
      {
        title: "YOUR PLAYERS",
        body: touch
          ? "Touch a row to grab that rod, then drag sideways to slide your players into the ball's path."
          : "Move the mouse to slide your players and tilt the rod. Press 1–4 (or scroll) to pick a rod.",
        target: () =>
          this.screenRect(
            mineRods.flatMap((r) => [new Vector3(r.x, TABLE.rodHeight, -0.5), new Vector3(r.x, TABLE.rodHeight, 0.5)]),
            8,
          ),
      },
      {
        title: "KICK!",
        body: touch
          ? "Flick up on a rod to swing and shoot. Tapping the KICK button does it too."
          : "Click, or press SPACE, to swing your players and shoot!",
        target: () => (touch ? el(".kick-btn") : el(".keys")),
      },
      {
        title: "AUTO ROD",
        body: touch
          ? "AUTO picks the rod nearest the ball for you. Tap a chip any time to take over."
          : "AUTO picks the rod nearest the ball for you. Press A to switch it on or off.",
        target: () => (touch ? el(".chips") : el(".keys")),
      },
      {
        title: "READY?",
        body: "First to 3 goals wins, or whoever leads after 3 minutes. Good luck — show them what you've got!",
        target: () => null,
      },
    ];
  }

  private onStart(countdownMs: number): void {
    this.resultView = null;
    this.screens.close();
    this.clearTimers();
    this.words.clear();
    this.juice.reset();
    this.phase = "countdown";
    this.ending = false;
    this.firstServe = true;
    this.score = { left: 0, right: 0 };
    this.playMs = 0;
    this.hud.setScore(this.score);
    this.hud.setTimer(MATCH_TIME_LIMIT_MS);
    this.table?.setScore(this.score);
    this.rig.zoomTo(1);
    this.holdOpen = false;
    this.rig.intro(Math.min(2700, countdownMs - 250)); // cinematic fly-down the pitch
    this.timers.push(window.setTimeout(() => this.juice.teamBanner(this.myTeam), 150));

    // Count down 3-2-1 on the second marks.
    const steps = Math.round(countdownMs / 1000);
    for (let i = 0; i < steps; i++) {
      this.timers.push(window.setTimeout(() => this.phase === "countdown" && this.juice.countdown(steps - i), i * 1000));
    }
    sfx.unlock();
  }

  private onEnd(e: Extract<SessionEvent, { t: "end" }>): void {
    if (!this.session) return;
    this.phase = "over";
    this.ending = true;
    this.score = e.score;
    const mine = this.myTeam;
    const outcome = outcomeFor(e.winner, mine);
    const mode = this.session.mode;
    const difficulty = (this.session as LocalSession).difficulty;

    this.juice.end(outcome);
    this.hud.setScore(e.score);
    this.table?.setScore(e.score);

    const points = matchPoints({
      outcome,
      goalsFor: e.score[mine],
      goalsAgainst: e.score[other(mine)],
      mode,
      difficulty,
    });

    // Show the results once the celebration has had a moment.
    this.timers.push(
      window.setTimeout(async () => {
        const sent = await submitScore(points);
        if (!this.ending || !this.session) return;
        this.hud.show(false);
        const names = this.session.names;
        this.resultView = this.screens.results(
          {
            outcome,
            mine,
            names,
            score: e.score,
            stats: e.stats,
            forfeit: Boolean(e.forfeit),
            byTime: Boolean(e.byTime),
            points,
            best: sent.best,
            isBest: sent.isBest,
            mode,
          },
          {
            again: () => this.playAgain(),
            menu: () => this.backToMenu(),
          },
        );
      }, 1100),
    );
  }

  private playAgain(): void {
    const session = this.session;
    if (!session) return;
    if (session.mode === "solo") {
      this.startSolo((session as LocalSession).difficulty);
    } else {
      session.rematch();
      this.resultView?.waiting();
    }
  }

  /* ────────────────────────────── pause & lifecycle ────────────────────────────── */

  private togglePause(): void {
    const session = this.session;
    if (!session || this.phase === "idle" || this.phase === "over") return;
    if (this.screens.isOpen()) {
      this.resume();
      return;
    }
    const solo = session.mode === "solo";
    session.paused = solo;
    this.screens.pause(solo, {
      resume: () => this.resume(),
      restart: () => this.startSolo((session as LocalSession).difficulty),
      quit: () => this.backToMenu(),
    });
  }

  private resume(): void {
    if (this.session) this.session.paused = false;
    this.screens.close();
  }

  /** The page was hidden or the platform asked us to stop. */
  private autoPause(): void {
    sfx.suspend();
    if (this.session?.mode === "solo" && (this.phase === "play" || this.phase === "countdown") && !this.screens.isOpen()) {
      this.togglePause();
    }
  }

  private async acquireWakeLock(): Promise<void> {
    if (!this.session || this.wakeLock) return;
    try {
      const nav = navigator as unknown as { wakeLock?: { request(type: "screen"): Promise<{ release(): Promise<void>; addEventListener(t: string, f: () => void): void }> } };
      const lock = await nav.wakeLock?.request("screen");
      if (lock) {
        this.wakeLock = lock;
        lock.addEventListener("release", () => (this.wakeLock = null));
      }
    } catch {
      /* not allowed, or unsupported: fine */
    }
  }

  private clearTimers(): void {
    for (const id of this.timers) window.clearTimeout(id);
    this.timers = [];
  }

  /** Drop everything belonging to the current match. */
  private teardownMatch(): void {
    this.startGen++; // abandons any startOnline() still waiting on the network
    this.platformWait?.cancel();
    this.platformWait = null;
    this.clearTimers();
    this.ending = true; // suppress the "connection lost" error for a deliberate close
    this.session?.dispose();
    this.session = null;
    this.input?.dispose();
    this.input = null;
    this.waitUi = null;
    this.resultView = null;
    this.phase = "idle";
    this.words.clear();
    this.tutorial.close();
    this.holdOpen = false;
    this.table?.setActive(null);
    this.table?.setOwnTeam(null);
    this.table?.setScore({ left: 0, right: 0 });
    this.hud.show(false);
    this.hud.setScore({ left: 0, right: 0 });
    void this.wakeLock?.release();
    this.wakeLock = null;
    if (this.juice) this.juice.reset();
    this.rig.mode = "attract";
    this.screens.close();
    this.ending = false;
  }

  /* ───────────────────────────────── frame loop ───────────────────────────────── */

  /** Pixels to keep clear of the table: scoreboard above, controls below. */
  private margins(): { top: number; bottom: number } {
    const short = this.stage.height < 520;
    return {
      top: short ? 64 : 84,
      bottom: this.touch ? (short ? 88 : 150) : 52,
    };
  }

  /** Screen y (px) of a rod's row, so a touch can grab the rod nearest to it. */
  private rodRowY(rodIndex: number): number {
    const v = this.rowProbe.set(RODS[rodIndex].x, TABLE.rodHeight, 0).project(this.stage.camera);
    return (-v.y * 0.5 + 0.5) * this.stage.height;
  }

  private frame(now: number): void {
    requestAnimationFrame((t) => this.frame(t));
    const raw = now - this.lastFrame;
    const realDt = Math.min(raw, 100);
    this.lastFrame = now;
    this.stage.govern(raw);

    if (this.stage.resize()) this.rig.fit(this.stage.width, this.stage.height, this.margins());

    const table = this.table;
    if (!table || !this.juice) {
      this.rig.update(realDt / 1000, null);
      this.stage.render();
      return;
    }

    const session = this.session;
    const playing = session !== null && this.phase !== "idle";

    // Time: visual scale always; the sim scale only in solo play.
    if (session) session.timeScale = this.juice.gameScale(this.phase === "play");
    const dt = this.juice.update(realDt);
    if (session) session.update(realDt);

    let view = session?.view() ?? null;
    // Matched but not started yet (tutorial / waiting for the other player):
    // draw the table at rest, so your own rods still respond.
    if (!view && session) {
      view = {
        rods: Array.from({ length: 8 }, () => ({ angle: 0, offset: 0 })),
        ball: { x: 0, y: TABLE.ballRadius, z: 0 },
        score: { left: 0, right: 0 },
      };
    }
    let live: Vec3 | null = null;
    if (view && this.input) {
      // Controls: our own rods are drawn exactly where we hold them.
      const own = this.input.ownRods();
      for (const key of Object.keys(own)) {
        const i = Number(key);
        if (view.rods[i]) view.rods[i] = own[i] as RodState;
      }
      live = view.ball;
      this.input.update(realDt, this.phase === "play" || this.phase === "countdown" ? live.x : null);
      session?.setRods(own);
      table.setActive(this.input.activeRod());
    }

    // The ball: a goal celebration overrides the live one.
    const celebration = this.juice.celebrationBall;
    const drawn = celebration ?? live;
    if (view) {
      table.apply(view.rods, drawn);
    } else if (!playing) {
      this.attractMotion(table, now);
    }
    table.update(dt);
    this.lastDrawnBall = drawn ? { ...drawn } : this.lastDrawnBall;
    if (this.phase === "play" && live) this.juice.frame(live, dt);
    else this.juice.frame(null, dt);

    if (this.phase === "play" && !(session?.paused ?? false)) {
      this.playMs += realDt;
      // Solo follows the sim's own clock (it slows in slow-motion); online counts real time.
      this.hud.setTimer(session instanceof LocalSession ? session.timeLeftMs : Math.max(0, MATCH_TIME_LIMIT_MS - this.playMs));
    }
    if (view && view.score.left !== this.score.left) this.hud.setScore(view.score);

    this.lastLiveBall = live;
    this.rig.update(dt, drawn);
    this.particles.update(dt);
    this.particles.setView(this.stage.height, this.stage.camera.fov, this.stage.renderer.getPixelRatio());
    this.stage.render();
  }

  /** Something lively behind the menu: rods wiggle and the ball bobs. */
  private attractMotion(table: TableView, now: number): void {
    const t = now / 1000;
    const rods: RodState[] = Array.from({ length: 8 }, (_, i) => ({
      angle: Math.sin(t * 1.3 + i * 0.9) * 0.8 * (Math.sin(t * 0.4 + i) > 0.3 ? 1 : 0.15),
      offset: Math.sin(t * 0.7 + i * 1.7) * 0.8,
    }));
    table.apply(rods, { x: Math.sin(t * 0.5) * 0.25, y: TABLE.ballRadius, z: Math.cos(t * 0.7) * 0.18 });
  }

  /** For tests and debugging (DEV only). */
  debug(): Record<string, unknown> {
    return {
      phase: this.phase,
      score: this.score,
      quality: this.stage.quality,
      ball: this.lastLiveBall,
      team: this.myTeam,
      mode: this.session?.mode ?? null,
    };
  }
}
