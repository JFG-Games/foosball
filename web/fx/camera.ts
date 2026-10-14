import * as THREE from "three";
import type { Team } from "@shared/constants";
import type { Vec3 } from "@shared/types";

/**
 * The camera director.
 *
 * Normal play sits behind your own goal looking down the table, with the
 * distance solved so the whole table fits whatever the screen shape — a tall
 * phone, a wide laptop — and shifted up to leave room for the touch controls.
 *
 * On top of that pose it layers the juice: trauma-based shake, FOV punches,
 * a zoom, and a goal cam that swoops in on the pocket the ball just entered.
 * `attract` mode slowly orbits the table behind the menus.
 */
export type CameraMode = "play" | "attract";

/** Pixels the table must keep clear at the top (scoreboard) and bottom (controls). */
export interface Margins {
  top: number;
  bottom: number;
}

/** Camera pitch: steeper on tall (portrait) screens so the table fills them. */
const ELEVATION_WIDE = THREE.MathUtils.degToRad(50);
const ELEVATION_TALL = THREE.MathUtils.degToRad(66);
const BASE_FOV = 40;

/** How far the goal cam swings toward the pocket (0 = not at all, 1 = fully there). */
const GOAL_CAM_AMOUNT = 0.5;

/**
 * Points the table must keep on screen: the rim corners, the cabinet, and the
 * inner part of the grips. The outer ends of the rods are allowed to bleed off
 * the edge, which buys a much bigger table on a narrow phone screen.
 */
const FIT_POINTS: THREE.Vector3[] = [];
for (const sx of [-1, 1]) {
  for (const sz of [-1, 1]) {
    FIT_POINTS.push(new THREE.Vector3(sx * 0.7, 0.09, sz * 0.46));
    FIT_POINTS.push(new THREE.Vector3(sx * 0.36, 0.06, sz * 0.52));
    FIT_POINTS.push(new THREE.Vector3(sx * 0.7, -0.3, sz * 0.44));
  }
}

function damp(current: number, target: number, rate: number, dt: number): number {
  return current + (target - current) * (1 - Math.exp(-rate * dt));
}

export class CameraRig {
  private mode_: CameraMode = "attract";

  private team: Team = "left";
  private side = -1; // sign of the player's own goal along x
  private baseDistance = 2.2;
  private shiftPx = 0;
  private width = 1;
  private height = 1;
  private margins: Margins = { top: 80, bottom: 56 };
  private shiftX = 0;
  private pulseZoom = 0;
  private introLeft = 0;
  private introTotal = 1;
  private introK = 0;
  private elevation = ELEVATION_WIDE;

  private trauma = 0;
  private fovKick = 0;
  private zoom = 1;
  private zoomTarget = 1;
  private goalAmount = 0;
  private goalTarget = 0;
  private goalEnd: 1 | -1 = 1;
  private clock = 0;
  private roll = 0;

  private readonly look = new THREE.Vector3();
  private readonly eye = new THREE.Vector3();
  private readonly goalEye = new THREE.Vector3();
  private readonly goalLook = new THREE.Vector3();
  private readonly scratch = new THREE.Vector3();

  constructor(private readonly camera: THREE.PerspectiveCamera) {
    camera.fov = BASE_FOV;
  }

  /** Which end of the table we sit at. */
  setTeam(team: Team): void {
    this.team = team;
    this.side = team === "left" ? -1 : 1;
    this.fit(this.width, this.height);
  }

  get mode(): CameraMode {
    return this.mode_;
  }

  set mode(mode: CameraMode) {
    if (mode === this.mode_) return;
    this.mode_ = mode;
    this.applyView();
  }

  /**
   * Re-solve the framing so the table fits the screen, leaving `margins`
   * (pixels) clear for the scoreboard above and the controls below.
   */
  fit(width: number, height: number, margins: Margins = this.margins): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.margins = margins;
    const bottomSafe = -1 + (2 * margins.bottom) / this.height;
    const cam = this.camera;
    cam.fov = BASE_FOV;
    cam.aspect = this.width / this.height;
    cam.clearViewOffset();
    cam.updateProjectionMatrix();

    const topSafe = 1 - (2 * margins.top) / this.height;
    const xSafe = 0.97;
    // Blend the pitch by screen shape: aspect <= 0.6 is tall, >= 1.3 is wide.
    const tall = THREE.MathUtils.clamp((1.3 - cam.aspect) / 0.7, 0, 1);
    this.elevation = ELEVATION_WIDE + (ELEVATION_TALL - ELEVATION_WIDE) * tall;
    const dir = new THREE.Vector3(this.side * Math.cos(this.elevation), Math.sin(this.elevation), 0);
    const target = new THREE.Vector3(0, 0, 0);
    const p = new THREE.Vector3();

    const measure = (distance: number): { minX: number; maxX: number; minY: number; maxY: number } => {
      cam.position.copy(target).addScaledVector(dir, distance);
      cam.lookAt(target);
      cam.updateMatrixWorld(true);
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      for (const point of FIT_POINTS) {
        p.copy(point).project(cam);
        minX = Math.min(minX, p.x);
        maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y);
        maxY = Math.max(maxY, p.y);
      }
      return { minX, maxX, minY, maxY };
    };
    const fits = (distance: number): boolean => {
      const m = measure(distance);
      return m.maxX - m.minX <= xSafe * 2 && m.maxY - m.minY <= topSafe - bottomSafe;
    };

    let lo = 0.6;
    let hi = 9;
    for (let i = 0; i < 18; i++) {
      const mid = (lo + hi) / 2;
      if (fits(mid)) hi = mid;
      else lo = mid;
    }
    this.baseDistance = hi;

    // Centre the table's footprint in the safe rectangle.
    const m = measure(this.baseDistance);
    const wantMid = (topSafe + bottomSafe) / 2;
    const haveMid = (m.minY + m.maxY) / 2;
    this.shiftPx = ((wantMid - haveMid) / 2) * this.height;
    this.shiftX = ((0 - (m.minX + m.maxX) / 2) / 2) * this.width;
    this.applyView();
  }

  /** Apply the framing shift. In the menu, a wide screen parks the table on the right. */
  private applyView(): void {
    const cam = this.camera;
    const wide = this.width / this.height > 1.25;
    const menuShift = this.mode_ === "attract" && wide ? -this.width * 0.2 : 0;
    const menuDrop = this.mode_ === "attract" && !wide ? this.height * 0.06 : 0;
    cam.setViewOffset(this.width, this.height, -this.shiftX + menuShift, this.shiftPx - menuDrop, this.width, this.height);
  }

  /** Add shake. 0..1; shake grows with its square, so small hits stay subtle. */
  shake(amount: number): void {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  /** Momentary field-of-view kick (degrees; positive widens, negative punches in). */
  punch(degrees: number): void {
    this.fovKick += degrees;
  }

  /**
   * Cinematic opener: start low behind the rival's goal, sweep down the pitch
   * and rise into the normal view, arriving as the countdown ends.
   */
  intro(ms: number): void {
    this.introTotal = Math.max(400, ms);
    this.introLeft = this.introTotal;
  }

  get introducing(): boolean {
    return this.introLeft > 0;
  }

  /** A quick, small zoom-in that eases back on its own (e.g. 0.06 = 6% closer). */
  pulse(amount: number): void {
    this.pulseZoom = Math.min(0.14, Math.max(this.pulseZoom, amount));
  }

  /** Smooth zoom toward `factor` (1 = normal, 1.4 = closer). */
  zoomTo(factor: number): void {
    this.zoomTarget = factor;
  }

  /** Swoop in on the pocket at `end` (+1 / -1 along x). */
  goalCam(end: 1 | -1, ball: Vec3): void {
    this.goalEnd = end;
    this.goalTarget = GOAL_CAM_AMOUNT;
    const sideOfBall = ball.z >= 0 ? 1 : -1;
    this.goalLook.set(end * 0.55, 0.0, ball.z * 0.25);
    this.goalEye.set(end * -0.1, 0.85, sideOfBall * 0.6 + ball.z * 0.3);
  }

  releaseGoalCam(): void {
    this.goalTarget = 0;
  }

  /** Current vertical FOV, for effects that need to match it. */
  get fov(): number {
    return this.camera.fov;
  }

  update(dt: number, ball: Vec3 | null): void {
    this.clock += dt;
    const cam = this.camera;

    this.zoom = damp(this.zoom, this.zoomTarget, 5, dt);
    this.pulseZoom = damp(this.pulseZoom, 0, 9, dt);
    this.goalAmount = damp(this.goalAmount, this.goalTarget, this.goalTarget > this.goalAmount ? 4.5 : 3, dt);
    if (Math.abs(this.goalAmount - this.goalTarget) < 0.002) this.goalAmount = this.goalTarget;
    this.fovKick = damp(this.fovKick, 0, 7, dt);
    this.trauma = Math.max(0, this.trauma - dt * 1.4);

    if (this.mode === "attract") {
      this.updateAttract();
    } else {
      this.updatePlay(ball);
    }

    // Intro fly-through, layered over the normal pose.
    this.introK = 0;
    if (this.introLeft > 0 && this.mode_ === "play") {
      this.introLeft = Math.max(0, this.introLeft - dt * 1000);
      const p = 1 - this.introLeft / this.introTotal;
      const e = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2; // ease in-out
      const k = 1 - e;
      const s = this.side;
      this.eye.x += (-s * 0.58 - this.eye.x) * k;
      this.eye.y += (0.09 - this.eye.y) * k + Math.sin(Math.PI * e) * 0.2;
      this.eye.z += (0.26 - this.eye.z) * k;
      this.look.x += (s * 0.15 - this.look.x) * k;
      this.look.y += (0.03 - this.look.y) * k;
      this.look.z += (0 - this.look.z) * k;
      this.introK = k;
    }

    // Goal cam: blend toward the pocket pose.
    if (this.goalAmount > 0) {
      const a = Math.min(1, this.goalAmount);
      const g = a * a * (3 - 2 * a);
      this.eye.lerp(this.goalEye, g);
      this.look.lerp(this.goalLook, g);
    }

    // Shake: a few detuned sines read as noise, scaled by trauma².
    const t = this.trauma * this.trauma;
    if (t > 0.0001) {
      const c = this.clock * 38;
      this.eye.x += (Math.sin(c * 1.13) + Math.sin(c * 2.31)) * 0.5 * t * 0.02;
      this.eye.y += (Math.sin(c * 1.71 + 1) + Math.sin(c * 2.9)) * 0.5 * t * 0.02;
      this.eye.z += (Math.sin(c * 1.37 + 2) + Math.sin(c * 2.63)) * 0.5 * t * 0.02;
      this.roll = Math.sin(c * 1.9 + 4) * t * 0.035;
    } else {
      this.roll = 0;
    }

    cam.position.copy(this.eye);
    cam.lookAt(this.look);
    if (this.roll !== 0) cam.rotateZ(this.roll);

    const fov = BASE_FOV + this.fovKick - this.goalAmount * 5 - this.introK * 9;
    if (Math.abs(cam.fov - fov) > 0.01) {
      cam.fov = fov;
      cam.updateProjectionMatrix();
    }
  }

  private updatePlay(ball: Vec3 | null): void {
    // The table's centre, nudged a little toward the ball so play feels alive.
    const bx = ball ? ball.x : 0;
    const bz = ball ? ball.z : 0;
    this.look.set(bx * 0.04, 0, bz * 0.07);

    const distance = this.baseDistance / (this.zoom * (1 + this.pulseZoom));
    this.eye.set(
      this.side * Math.cos(this.elevation) * distance + bx * 0.06,
      Math.sin(this.elevation) * distance,
      bz * 0.1,
    );
    // A zoom pushes the look point toward the ball, so we zoom on the action.
    if (this.zoom > 1.001) {
      const k = (this.zoom - 1) * 0.55;
      this.look.x += (bx - this.look.x) * k;
      this.look.z += (bz - this.look.z) * k;
    }
  }

  private updateAttract(): void {
    // Slow orbit around the table, bobbing a little.
    const a = this.clock * 0.18 + (this.team === "left" ? Math.PI : 0);
    const r = this.baseDistance * 0.92;
    const elev = THREE.MathUtils.degToRad(34 + Math.sin(this.clock * 0.3) * 6);
    this.eye.set(Math.cos(a) * Math.cos(elev) * r, Math.sin(elev) * r * 0.9 + 0.1, Math.sin(a) * Math.cos(elev) * r);
    this.look.set(0, -0.02, 0);
    void this.scratch;
  }

  /** Snap straight to the play pose (e.g. when a match starts). */
  snap(): void {
    this.goalAmount = this.goalTarget = 0;
    this.introLeft = 0;
    this.pulseZoom = 0;
    this.zoom = this.zoomTarget = 1;
    this.fovKick = 0;
    this.trauma = 0;
  }
}
