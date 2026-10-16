import * as THREE from "three";
import { GOAL_HALF_WIDTH, MATCH_SCORE_TO_WIN, RODS, TABLE, type Team } from "@shared/constants";
import type { HitEvent, Vec3 } from "@shared/types";
import { buzz, sfx } from "../audio";
import { GOAL_POCKET_DEPTH, POCKET_FLOOR_Y, type TableView } from "../scene/table";
import { TEAM_HEX, TEAM_CSS, other } from "../theme";
import type { Hud } from "../ui/hud";
import type { Words } from "../ui/words";
import type { CameraRig } from "./camera";
import type { Particles } from "./particles";

/**
 * Game feel. Everything that makes an event *land*: sound, shake, sparks,
 * comic words, slow motion, hit-stop and the goal sequence.
 *
 * The game tells this class what happened (`hit`, `goal`, `serve`…); it decides
 * how loud to be about it. All visual time goes through `scale` so a slow-mo
 * moment slows particles, camera and ball together. In solo play the same
 * scale is also handed to the simulation, so the slow-mo is real; online it
 * only slows what we draw, which is all a client is allowed to do.
 */

const BIG_SHOT = ["WHAM!", "BOOM!", "SMASH!", "THWACK!", "KAPOW!", "ZING!"];
const SAVES = ["SAVED!", "DENIED!", "NOPE!", "STOPPED!", "BRICK WALL!"];
const BLOCKED = ["BLOCKED!", "SO CLOSE!", "ARGH!"];
const BONKS = ["BONK!", "BOING!", "TWANG!"];
const NICE = ["NICE ONE!", "WHAT A SHOT!", "SCORCHER!", "BEAUTY!", "SWEET!", "CLEAN!"];
const OOPS = ["THEY SCORED", "SHAKE IT OFF", "KEEP GOING", "NOT TO WORRY"];

const pick = <T>(list: T[]): T => list[Math.floor(Math.random() * list.length)];
const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

export interface JuiceDeps {
  table: TableView;
  rig: CameraRig;
  particles: Particles;
  words: Words;
  hud: Hud;
  camera: THREE.PerspectiveCamera;
  layer: HTMLElement;
}

interface Celebration {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  end: 1 | -1;
}

export class Juice {
  /** The local player's side; hits by this team feel "ours". */
  myTeam: Team | null = null;
  /** Whether the simulation clock may be slowed too (solo only). */
  canSlowGame = false;
  /** Current visual time scale (1 = normal). */
  scale = 1;

  private slowTarget = 1;
  private slowHoldMs = 0;
  private celebration: Celebration | null = null;
  /** Bought cosmetics for the local player: colours, or null when off. Set per match. */
  cosmetics: { trail: number | null; party: number | null } = { trail: null, party: null };
  private lastBall: Vec3 | null = null;
  private lastBallAt = 0;
  private readonly lastWordAt = new Map<string, number>();
  private readonly v = new THREE.Vector3();

  constructor(private readonly d: JuiceDeps) {}

  reset(): void {
    this.scale = 1;
    this.slowTarget = 1;
    this.slowHoldMs = 0;
    this.celebration = null;
    this.lastBall = null;
    this.d.rig.snap();
    this.d.hud.vignette(false);
  }

  /** What the simulation clock should be multiplied by right now. */
  gameScale(inPlay: boolean): number {
    return this.canSlowGame && inPlay ? this.scale : 1;
  }

  /** The ball to draw during the goal celebration, or null for the live one. */
  get celebrationBall(): Vec3 | null {
    return this.celebration ? { x: this.celebration.pos.x, y: this.celebration.pos.y, z: this.celebration.pos.z } : null;
  }

  /** Advance effects. Returns the cosmetic delta time in seconds, already time-scaled. */
  update(realDtMs: number): number {
    if (this.slowHoldMs > 0) this.slowHoldMs -= realDtMs;
    const target = this.slowHoldMs > 0 ? this.slowTarget : 1;
    const rate = target < this.scale ? 18 : 4;
    this.scale += (target - this.scale) * (1 - Math.exp(-rate * (realDtMs / 1000)));
    if (Math.abs(this.scale - target) < 0.004) this.scale = target;

    const dt = (realDtMs / 1000) * this.scale;
    if (this.celebration) this.stepCelebration(dt);
    return dt;
  }

  /** Called each frame with the live ball, for trails. */
  frame(ball: Vec3 | null, dtSec: number): void {
    if (ball && this.lastBall && dtSec > 0) {
      const speed = Math.hypot(ball.x - this.lastBall.x, ball.z - this.lastBall.z) / dtSec;
      if (speed > 1.6 && speed < 12) {
        const p = this.d.particles;
        p.spark(ball.x, ball.y, ball.z, 0, 0.02, 0, 0xfff2b0, 0.009 + Math.min(speed, 6) * 0.0015, 0.3, { gravity: 0, drag: 1, shrink: 0 });
      }
      // A bought trail: flames that rise off the ball.
      const trail = this.cosmetics.trail;
      if (trail !== null && speed > 1 && speed < 12) {
        const p = this.d.particles;
        for (let n = 0; n < 2; n++) {
          p.spark(
            ball.x + (Math.random() - 0.5) * 0.012, ball.y, ball.z + (Math.random() - 0.5) * 0.012,
            (Math.random() - 0.5) * 0.14, 0.12 + Math.random() * 0.2, (Math.random() - 0.5) * 0.14,
            n === 0 ? trail : 0xffe08a, 0.016 + Math.random() * 0.012, 0.45 + Math.random() * 0.25,
            { gravity: -0.5, drag: 2.5, glow: 1, shrink: 0 },
          );
        }
      }
    }
    this.lastBall = ball ? { ...ball } : null;
  }

  /** Slow time to `factor` for `ms` of real time. */
  slowmo(factor: number, ms: number): void {
    this.slowTarget = factor;
    this.slowHoldMs = ms;
    this.d.hud.vignette(true);
    window.setTimeout(() => this.d.hud.vignette(false), ms);
  }

  /** A few frames of near-freeze, for a heavy hit. */
  hitStop(ms: number): void {
    if (this.slowHoldMs > 0) return;
    this.slowTarget = 0.2;
    this.slowHoldMs = ms;
  }

  /* ─────────────────────────────── helpers ─────────────────────────────── */

  private toScreen(x: number, y: number, z: number): { x: number; y: number } {
    const p = this.v.set(x, y, z).project(this.d.camera);
    const rect = this.d.layer.getBoundingClientRect();
    return { x: (p.x * 0.5 + 0.5) * rect.width, y: (-p.y * 0.5 + 0.5) * rect.height };
  }

  /** Allow a word at most once per `gapMs` for this key. */
  private canWord(key: string, gapMs: number): boolean {
    const now = performance.now();
    if (now - (this.lastWordAt.get(key) ?? -1e9) < gapMs) return false;
    this.lastWordAt.set(key, now);
    return true;
  }

  private colourOf(team: Team): number {
    return TEAM_HEX[team];
  }

  /* ──────────────────────────────── events ──────────────────────────────── */

  hit(h: HitEvent): void {
    const { particles: p, rig } = this.d;
    const y = TABLE.ballRadius;
    const power = clamp(h.vout / 4.5, 0, 1);

    if (h.k === "wall") {
      sfx.wall(power);
      p.burst(h.x, y, h.z, 3 + Math.round(power * 5), 0.25 + power * 0.3, 0xd9d4ff, { size: 0.0075, life: 0.4, glow: 0, gravity: 0.5 });
      if (power > 0.45) rig.shake(0.07 * power);
      if (h.vout > 2.6 && this.canWord("wall", 1100)) {
        const s = this.toScreen(h.x, y + 0.05, h.z);
        void this.d.words.popAt(s.x, s.y - 30, pick(BONKS), { color: "#bde0ff", size: 0.4 });
      }
      return;
    }

    const spec = RODS[h.rod];
    if (!spec) return;
    const team = spec.team;
    const mine = team === this.myTeam;

    if (h.vout > 1.4) sfx.kick(power);
    else sfx.clack(power);

    // Sparks in the striker's colour, plus a white pop.
    p.burst(h.x, y, h.z, 4 + Math.round(power * 14), 0.35 + power * 1.0, this.colourOf(team), { size: 0.0065, life: 0.45, gravity: 2 });
    p.burst(h.x, y, h.z, 2 + Math.round(power * 4), 0.2 + power * 0.5, 0xffffff, { size: 0.01, life: 0.22, gravity: 0 });

    rig.shake((mine ? 0.06 : 0.04) + power * 0.28);
    rig.punch(-2.2 * power);
    // Every proper contact nudges the camera in a little; harder = closer.
    if (h.vout > 0.7) rig.pulse(0.025 + power * 0.07);
    if (mine) buzz(8 + Math.round(power * 24));

    // Saves: a quick ball heading for this team's goal, stopped.
    const towardOwnGoal = team === "left" ? h.vx < 0 : h.vx > 0;
    const isSave = towardOwnGoal && h.vin >= 2.2 && Math.abs(h.vx) > 1.3;
    const s = this.toScreen(h.x, y + 0.04, h.z);

    if (isSave && this.canWord("save", 900)) {
      sfx.save();
      void this.d.words.popAt(s.x, s.y - 40, pick(mine ? SAVES : BLOCKED), {
        size: 0.62,
        color: mine ? "#3ddc84" : "#ff8a8a",
        burst: mine ? "#fff" : undefined,
        hold: 420,
        shock: true,
      });
      if (mine) buzz([12, 30, 16]);
    } else if (h.vout >= 3.0) {
      // A real shot. Only the very hardest ones get a freeze-frame.
      if (h.vout >= 4.2) this.hitStop(45);
      if (this.canWord("big", 1000)) {
        void this.d.words.popAt(s.x, s.y - 40, pick(BIG_SHOT), {
          size: 0.7,
          color: mine ? "#ffd23f" : "#ff9d5c",
          hold: 380,
          shock: true,
        });
      }
    }
  }

  /** Make it unmistakable which side the player is on. */
  teamBanner(team: Team): void {
    const colour = team === "left" ? "#2a6bff" : "#ff3b3b";
    void this.d.words.pop(`YOU ARE ${team === "left" ? "BLUE" : "RED"}`, {
      mode: "stagger",
      size: 0.62,
      y: 0.2,
      hold: 1500,
      color: "#fff",
      burst: colour,
      gap: 220,
      shock: true,
    });
  }

  /** A rod kick started (local feedback, before any contact). */
  kickStarted(): void {
    sfx.whoosh(0.7);
    buzz(6);
  }

  countdown(n: number): void {
    sfx.tick();
    void this.d.words.pop(String(n), { shock: true, size: 0.8, hold: 480, sound: false, color: "#fff", burst: n === 1 ? "#ff8a3d" : "#6a3df0", y: 0.4 });
    this.d.rig.pulse(0.05);
  }

  /** Open play begins (or resumes after a goal). */
  serve(first: boolean, score: Record<Team, number>): void {
    this.celebration = null;
    this.d.table.ball.pop();
    this.d.rig.releaseGoalCam();
    this.d.rig.zoomTo(1);

    if (first) {
      sfx.go();
      void this.d.words.pop("GO!", { shock: true, size: 0.95, hold: 450, sound: false, color: "#3ddc84", burst: "#fff", y: 0.4 });
      this.d.hud.flash("#ffffff");
      return;
    }
    sfx.serve();
    const leader = score.left >= MATCH_SCORE_TO_WIN - 1 || score.right >= MATCH_SCORE_TO_WIN - 1;
    if (leader) {
      void this.d.words.pop("MATCH POINT!", { size: 0.8, hold: 900, color: "#ff8a3d", burst: "#ffd23f", y: 0.3, shock: true });
    }
  }

  /** A goal was scored by `team`. `ball` is where the ball crossed the line. */
  goal(team: Team, ball: Vec3, vel: Vec3, current: Vec3 | null, pauseMs: number, score: Record<Team, number>): void {
    const { table, rig, particles: p, words, hud } = this.d;
    const mine = team === this.myTeam;
    const end: 1 | -1 = team === "left" ? 1 : -1; // the left team scores into the +x goal

    // The ball should visibly go *into* the net: start from what's on screen.
    const start = current ?? ball;
    const target = this.v.set(end * (TABLE.length / 2 + 0.035), POCKET_FLOOR_Y + TABLE.ballRadius, clamp(ball.z, -GOAL_HALF_WIDTH + 0.02, GOAL_HALF_WIDTH - 0.02));
    const toGoal = new THREE.Vector3(target.x - start.x, 0, target.z - start.z);
    const dist = toGoal.length();
    const speed = Math.max(Math.hypot(vel.x, vel.z), 1.5);
    toGoal.normalize().multiplyScalar(speed);
    this.celebration = {
      pos: new THREE.Vector3(start.x, start.y, start.z),
      vel: dist < 0.002 ? new THREE.Vector3(end * speed, 0, 0) : toGoal,
      end,
    };

    // Sound, flash and the big moment.
    table.flashGoal(team);
    if (mine) sfx.goal();
    else sfx.concede();
    buzz(mine ? [30, 40, 70] : [60]);
    hud.flash(mine ? TEAM_CSS[team] : "#ffffff");
    hud.speedLines();
    hud.setScore(score, team);
    rig.shake(0.55);
    rig.punch(-5);

    // Camera swoops to the goal while time crawls.
    rig.goalCam(end, ball);
    this.slowmo(0.35, Math.max(700, pauseMs * 0.36));
    sfx.slowmo();

    // Confetti out of the pocket.
    const gx = end * (TABLE.length / 2 + GOAL_POCKET_DEPTH / 2);
    const palette = mine ? [TEAM_HEX[team], 0xffd23f, 0xffffff, 0x3ddc84] : [TEAM_HEX[team], 0xffffff, 0x8888aa];
    p.confettiBurst(gx, 0.02, 0, mine ? 150 : 50, palette, 1.9);
    p.burst(gx, 0.02, 0, 40, 1.5, 0xffd23f, { size: 0.01, life: 0.8, gravity: 3 });
    // A bought goal party, for your own goals only.
    const party = this.cosmetics.party;
    if (mine && party !== null) {
      p.confettiBurst(gx, 0.02, 0, 130, [party, 0xffffff, 0xfff2b0], 2.3);
      p.burst(gx, 0.02, 0, 60, 2.2, party, { size: 0.012, life: 1.1, gravity: 2 });
      window.setTimeout(() => p.confettiBurst(gx, 0.05, 0, 90, [party, 0xffffff], 2.5), 350);
    }

    // Comic words.
    const lead = score[team] - score[other(team)];
    if (mine) {
      void words.pop("GOAL!", { shock: true, size: 1.35, hold: Math.max(900, pauseMs * 0.5), color: "#fff", burst: "#ffd23f", y: 0.34 });
      window.setTimeout(() => {
        void words.pop(lead >= 3 ? "DOMINATING!" : pick(NICE), {
          mode: "stagger",
          size: 0.6,
          hold: Math.max(600, pauseMs * 0.4),
          color: "#ffd23f",
          y: 0.56,
          gap: 170,
        });
      }, 520);
    } else {
      void words.pop("OUCH!", { shock: true, size: 1.25, hold: Math.max(700, pauseMs * 0.4), color: "#fff", burst: "#ff3b3b", y: 0.36 });
      window.setTimeout(() => {
        void words.pop(pick(OOPS), { mode: "stagger", size: 0.5, hold: 700, color: "#cfc8ff", y: 0.56, gap: 150 });
      }, 520);
    }

    // Pull the camera back out as the serve nears.
    window.setTimeout(() => rig.releaseGoalCam(), Math.max(800, pauseMs * 0.42));
  }

  /** The match is over. */
  end(outcome: "win" | "lose" | "draw"): void {
    const { particles: p, words, rig, hud } = this.d;
    this.celebration = null;
    rig.releaseGoalCam();
    rig.zoomTo(1.05);
    hud.vignette(false);
    if (outcome === "win") {
      sfx.win();
      buzz([40, 50, 40, 50, 120]);
      for (let i = 0; i < 4; i++) {
        window.setTimeout(() => p.confettiBurst((Math.random() - 0.5) * 0.9, 0.05, (Math.random() - 0.5) * 0.5, 70, [0xffd23f, 0xffffff, 0x2a6bff, 0xff3b3b, 0x3ddc84], 2.2), i * 260);
      }
      void words.pop("VICTORY!", { shock: true, size: 1.3, hold: 1100, color: "#ffd23f", burst: "#fff", y: 0.3 });
    } else if (outcome === "lose") {
      sfx.lose();
      void words.pop("GAME OVER", { shock: true, size: 1.0, hold: 1000, color: "#ff8a8a", y: 0.3 });
    } else {
      sfx.lose();
    }
  }

  /* ───────────────────────── goal celebration physics ───────────────────────── */

  /** Roll the ball into the net, drop it into the pocket and let it settle. */
  private stepCelebration(dt: number): void {
    const c = this.celebration!;
    const r = TABLE.ballRadius;
    const half = TABLE.length / 2;

    c.pos.x += c.vel.x * dt;
    c.pos.z += c.vel.z * dt;
    const inside = c.pos.x * c.end > half;

    if (inside) {
      // Falling into the pocket, then bouncing and rolling to a stop.
      c.vel.y -= 6.5 * dt;
      c.pos.y += c.vel.y * dt;
      const floor = POCKET_FLOOR_Y + r;
      if (c.pos.y < floor) {
        c.pos.y = floor;
        c.vel.y = Math.abs(c.vel.y) > 0.25 ? -c.vel.y * 0.38 : 0;
      }
      const drag = Math.exp(-2.2 * dt);
      c.vel.x *= drag;
      c.vel.z *= drag;

      const back = c.end * (half + GOAL_POCKET_DEPTH - r);
      if (c.pos.x * c.end > back * c.end) {
        c.pos.x = back;
        c.vel.x *= -0.4;
      }
      const side = GOAL_HALF_WIDTH - r;
      if (Math.abs(c.pos.z) > side) {
        c.pos.z = Math.sign(c.pos.z) * side;
        c.vel.z *= -0.4;
      }
    } else {
      // Still rolling toward the goal; never stall short of it.
      const along = c.vel.x * c.end;
      if (along < 0.9) c.vel.x = c.end * 0.9;
    }
  }
}
