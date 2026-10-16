import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import {
  GOAL_HALF_WIDTH,
  MATCH_SCORE_TO_WIN,
  MAX_ROD_SLIDE,
  RODS,
  TABLE,
  type Team,
} from "@shared/constants";
import type { RodState, Vec3 } from "@shared/types";
import { TEAM_HEX } from "../theme";
import { createBall, type BallView } from "./ball";
import { createFigureMaterial } from "./figure";

/**
 * A proper arcade foosball table, built like the real thing:
 *
 *   green rim ─ a flat plate that overhangs the dark inner walls
 *   navy cabinet, tapering to dark legs
 *   rods that pass through the rim, with a grip on each team's side
 *   a bead scoreboard on the rim, and a goal pocket at each end
 *
 * Everything that never moves (rim, cabinet, legs, field) is merged into one
 * mesh with vertex colours. The 22 men are a single InstancedMesh. The whole
 * table is roughly a dozen draw calls.
 *
 * The rods rotate about their own long axis (z) and slide along it, which is
 * exactly what `shared/sim.ts` simulates; a man hangs `MAN_SWING` below its
 * rod so rotating by `a` puts its foot `MAN_SWING * sin(a)` along x.
 */

const COLOR = {
  field: 0x59c25c,
  rim: 0x35b52a,
  rimShade: 0x2a9622,
  wall: 0x12141c,
  cabinet: 0x1c2358,
  cabinetTrim: 0x2f3a86,
  leg: 0x12142a,
  foot: 0x0a0b14,
  pocket: 0x07080d,
  chrome: 0xd5dce6,
  beadOff: 0x252a33,
  slot: 0x0c0e14,
} as const;

/** Rim width, and the heights that make up the rim assembly. */
const RIM = 0.09;
const WALL = 0.012;
const WALL_TOP = 0.07;
const PLATE_TOP = 0.09;
const BODY_BOTTOM = -0.03;
const CABINET_BOTTOM = -0.3;
const FLOOR_Y = -0.62;

export const GOAL_POCKET_DEPTH = RIM - 0.016;
export const POCKET_FLOOR_Y = BODY_BOTTOM + 0.004;

export interface TableView {
  group: THREE.Group;
  ball: BallView;
  /** Drive the rods and ball. Pass `ball = null` to leave the ball alone. */
  apply(rods: RodState[], ball: Vec3 | null): void;
  /** Light the scoreboard beads. */
  setScore(score: Record<Team, number>): void;
  /** Highlight a rod (its men, lane and grip), or none. */
  setActive(rod: number | null): void;
  /** Mark which side the local player is on (tints their goal and grips), or null. */
  setOwnTeam(team: Team | null): void;
  /** Flash the goal pocket a team just scored in. */
  flashGoal(scorer: Team): void;
  /** World position of the middle of a goal mouth: the +x or -x end. */
  goalMouth(end: 1 | -1): THREE.Vector3;
  /** Advance eased animation (glow, flashes). */
  update(dtSec: number): void;
  /** Lights that follow the quality tier. */
  setShadows(on: boolean): void;
}

/* ─────────────────────────── geometry helpers ─────────────────────────── */

function paint(geometry: THREE.BufferGeometry, hex: number): THREE.BufferGeometry {
  const color = new THREE.Color(hex);
  const n = geometry.attributes.position.count;
  const colors = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    colors[i * 3] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return geometry;
}

/** A coloured box spanning [x0,x1] × [y0,y1] × [z0,z1]. */
function slab(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, hex: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0);
  g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  g.deleteAttribute("uv");
  return paint(g, hex);
}

/** A box whose bottom face is shrunk toward its axis, for a tapered look. */
function tapered(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, bottom: number, hex: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0);
  const pos = g.attributes.position;
  const h = (y1 - y0) / 2;
  for (let i = 0; i < pos.count; i++) {
    if (pos.getY(i) < 0) {
      pos.setX(i, pos.getX(i) * bottom);
      pos.setZ(i, pos.getZ(i) * bottom);
    }
  }
  void h;
  g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  g.deleteAttribute("uv");
  g.computeVertexNormals();
  return paint(g, hex);
}

/* ──────────────────────────────── field ───────────────────────────────── */

/** The pitch: mown stripes and white markings, drawn once into a canvas. */
function makeFieldTexture(): THREE.CanvasTexture {
  const w = 2048;
  const h = Math.round((w * TABLE.width) / TABLE.length);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  const px = w / TABLE.length; // pixels per metre
  const X = (m: number): number => (m + TABLE.length / 2) * px;
  const Z = (m: number): number => (m + TABLE.width / 2) * px;

  // Mown stripes along the length.
  const stripe = 0.1 * px;
  for (let i = 0; i * stripe < w; i++) {
    ctx.fillStyle = i % 2 === 0 ? "#5ec760" : "#53b856";
    ctx.fillRect(i * stripe, 0, stripe + 1, h);
  }

  // Subtle grain, so a big flat colour doesn't look like plastic.
  for (let i = 0; i < 5000; i++) {
    ctx.fillStyle = `rgba(0,40,0,${Math.random() * 0.035})`;
    ctx.fillRect(Math.random() * w, Math.random() * h, 2 + Math.random() * 3, 2 + Math.random() * 3);
  }

  ctx.strokeStyle = "rgba(255,255,255,0.92)";
  ctx.fillStyle = "rgba(255,255,255,0.92)";
  ctx.lineWidth = 0.0065 * px;
  ctx.lineCap = "round";

  // Outline, halfway line, centre circle and spot.
  const inset = 0.012;
  ctx.strokeRect(X(-TABLE.length / 2 + inset), Z(-TABLE.width / 2 + inset), (TABLE.length - inset * 2) * px, (TABLE.width - inset * 2) * px);
  ctx.beginPath();
  ctx.moveTo(X(0), Z(-TABLE.width / 2 + inset));
  ctx.lineTo(X(0), Z(TABLE.width / 2 - inset));
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(X(0), Z(0), 0.09 * px, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(X(0), Z(0), 0.011 * px, 0, Math.PI * 2);
  ctx.fill();

  // Each end: penalty box, small box and a D, like the reference table.
  for (const end of [-1, 1]) {
    const edge = end * (TABLE.length / 2 - inset);
    const bigDepth = 0.17;
    const bigHalf = 0.2;
    const smallDepth = 0.07;
    const smallHalf = GOAL_HALF_WIDTH + 0.02;

    ctx.beginPath();
    ctx.moveTo(X(edge), Z(-bigHalf));
    ctx.lineTo(X(edge - end * bigDepth), Z(-bigHalf));
    ctx.lineTo(X(edge - end * bigDepth), Z(bigHalf));
    ctx.lineTo(X(edge), Z(bigHalf));
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(X(edge), Z(-smallHalf));
    ctx.lineTo(X(edge - end * smallDepth), Z(-smallHalf));
    ctx.lineTo(X(edge - end * smallDepth), Z(smallHalf));
    ctx.lineTo(X(edge), Z(smallHalf));
    ctx.stroke();

    ctx.beginPath();
    // A half circle bulging toward the middle of the pitch.
    const arcStart = end === -1 ? -Math.PI / 2 : Math.PI / 2;
    ctx.arc(X(edge - end * bigDepth), Z(0), 0.075 * px, arcStart, arcStart + Math.PI, false);
    ctx.stroke();

    // Penalty spot.
    ctx.beginPath();
    ctx.arc(X(edge - end * 0.12), Z(0), 0.008 * px, 0, Math.PI * 2);
    ctx.fill();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

/** A soft round glow, used for the floor spotlight. */
function makeGlowTexture(): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(255,255,255,0.9)");
  g.addColorStop(0.55, "rgba(255,255,255,0.28)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/* ───────────────────────────── the cabinet ────────────────────────────── */

/** Everything static, merged into one vertex-coloured mesh. */
function buildCabinet(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const L2 = TABLE.length / 2;
  const W2 = TABLE.width / 2;
  const GH = GOAL_HALF_WIDTH;
  const outerX = L2 + RIM;
  const outerZ = W2 + RIM;

  // ── Rim: solid green body, plus the plate that overhangs the dark wall ──
  // Long sides (run the full length, including the corners).
  for (const s of [-1, 1]) {
    const z0 = s < 0 ? -outerZ : W2 + WALL;
    const z1 = s < 0 ? -W2 - WALL : outerZ;
    parts.push(slab(-outerX, outerX, BODY_BOTTOM, WALL_TOP, z0, z1, COLOR.rim));
    // Plate: reaches in to the wall's inner face so it overhangs the wall.
    const p0 = s < 0 ? -outerZ : W2;
    const p1 = s < 0 ? -W2 : outerZ;
    parts.push(slab(-outerX, outerX, WALL_TOP, PLATE_TOP, p0, p1, COLOR.rim));
    // Dark inner wall.
    parts.push(slab(-L2, L2, 0, WALL_TOP, s < 0 ? -W2 - WALL : W2, s < 0 ? -W2 : W2 + WALL, COLOR.wall));
  }

  // Ends: the same, but with the goal mouth left open and a pocket behind it.
  for (const s of [-1, 1]) {
    const x0 = s < 0 ? -outerX : L2 + WALL;
    const x1 = s < 0 ? -L2 - WALL : outerX;
    const p0 = s < 0 ? -outerX : L2;
    const p1 = s < 0 ? -L2 : outerX;

    for (const zs of [-1, 1]) {
      const z0 = zs < 0 ? -W2 : GH;
      const z1 = zs < 0 ? -GH : W2;
      parts.push(slab(x0, x1, BODY_BOTTOM, WALL_TOP, z0, z1, COLOR.rim));
      parts.push(slab(p0, p1, WALL_TOP, PLATE_TOP, z0, z1, COLOR.rim));
      parts.push(slab(s < 0 ? -L2 - WALL : L2, s < 0 ? -L2 : L2 + WALL, 0, WALL_TOP, z0, z1, COLOR.wall));
    }

    // Pocket: floor, side cheeks and a back wall, all dark.
    const back0 = s < 0 ? -outerX : outerX - 0.016;
    const back1 = s < 0 ? -outerX + 0.016 : outerX;
    parts.push(slab(back0, back1, BODY_BOTTOM, PLATE_TOP, -GH, GH, COLOR.rimShade));
    parts.push(slab(s < 0 ? -outerX : L2, s < 0 ? -L2 : outerX, BODY_BOTTOM, POCKET_FLOOR_Y, -GH, GH, COLOR.pocket));
    for (const zs of [-1, 1]) {
      parts.push(slab(s < 0 ? -outerX + 0.016 : L2, s < 0 ? -L2 : outerX - 0.016, POCKET_FLOOR_Y, WALL_TOP, zs < 0 ? -GH - 0.006 : GH, zs < 0 ? -GH : GH + 0.006, COLOR.pocket));
    }
    // Plate bridge over the pocket's outer part, so it reads as a tunnel under the rim.
    parts.push(slab(s < 0 ? -outerX : outerX - 0.03, s < 0 ? -outerX + 0.03 : outerX, WALL_TOP, PLATE_TOP, -GH, GH, COLOR.rim));
  }

  // ── Cabinet: navy, tapering, tucked just inside the rim ────────────────
  parts.push(tapered(-outerX + 0.012, outerX - 0.012, CABINET_BOTTOM, BODY_BOTTOM, -outerZ + 0.012, outerZ - 0.012, 0.92, COLOR.cabinet));
  // A lighter trim band under the rim.
  parts.push(slab(-outerX + 0.008, outerX - 0.008, BODY_BOTTOM - 0.016, BODY_BOTTOM, -outerZ + 0.008, outerZ - 0.008, COLOR.cabinetTrim));
  // The pale ball-return window, as on the reference table.
  for (const s of [-1, 1]) {
    parts.push(slab(outerX - 0.2, outerX - 0.14, -0.15, -0.095, s * (outerZ - 0.002) - 0.004, s * (outerZ - 0.002) + 0.004, 0xbfe9d2));
    parts.push(slab(outerX - 0.194, outerX - 0.146, -0.144, -0.101, s * (outerZ - 0.002) - 0.006, s * (outerZ - 0.002) + 0.006, COLOR.slot));
  }

  // ── Legs ───────────────────────────────────────────────────────────────
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const cx = sx * (outerX - 0.11);
      const cz = sz * (outerZ - 0.09);
      parts.push(tapered(cx - 0.035, cx + 0.035, FLOOR_Y + 0.02, CABINET_BOTTOM, cz - 0.035, cz + 0.035, 0.72, COLOR.leg));
      parts.push(slab(cx - 0.045, cx + 0.045, FLOOR_Y, FLOOR_Y + 0.02, cz - 0.045, cz + 0.045, COLOR.foot));
    }
  }

  const merged = mergeGeometries(parts.map((p) => (p.index ? p.toNonIndexed() : p)), false);
  parts.forEach((p) => p.dispose());
  return merged;
}

/* ─────────────────────────────── the view ─────────────────────────────── */

export interface TableAssets {
  figure: THREE.BufferGeometry;
  ball: THREE.Object3D | null;
}

export function createTable(assets: TableAssets): TableView {
  const group = new THREE.Group();
  group.name = "table";

  const L2 = TABLE.length / 2;
  const W2 = TABLE.width / 2;
  const outerX = L2 + RIM;
  const outerZ = W2 + RIM;

  // Static cabinet.
  const cabinet = new THREE.Mesh(buildCabinet(), new THREE.MeshLambertMaterial({ vertexColors: true }));
  cabinet.castShadow = true;
  cabinet.receiveShadow = true;
  group.add(cabinet);

  // Playing surface.
  const fieldTexture = makeFieldTexture();
  const field = new THREE.Mesh(
    new THREE.PlaneGeometry(TABLE.length, TABLE.width),
    new THREE.MeshLambertMaterial({ map: fieldTexture }),
  );
  field.rotation.x = -Math.PI / 2;
  field.receiveShadow = true;
  group.add(field);

  // Floor: a spotlight pool plus the shadow the table casts on it.
  const floorShadow = new THREE.Mesh(new THREE.PlaneGeometry(6, 6), new THREE.ShadowMaterial({ opacity: 0.4 }));
  floorShadow.rotation.x = -Math.PI / 2;
  floorShadow.position.y = FLOOR_Y + 0.001;
  floorShadow.receiveShadow = true;
  group.add(floorShadow);

  const pool = new THREE.Mesh(
    new THREE.PlaneGeometry(3.2, 2.4),
    new THREE.MeshBasicMaterial({
      map: makeGlowTexture(),
      color: 0x9aa8ff,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  pool.rotation.x = -Math.PI / 2;
  pool.position.y = FLOOR_Y;
  group.add(pool);

  // ── Goal pockets: a glowing plate that flashes when someone scores ─────
  const goalGlowMaterials: Record<number, THREE.MeshBasicMaterial> = {};
  for (const end of [-1, 1] as const) {
    const material = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.9 });
    goalGlowMaterials[end] = material;
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(GOAL_POCKET_DEPTH, GOAL_HALF_WIDTH * 2), material);
    plate.rotation.x = -Math.PI / 2;
    plate.position.set(end * (L2 + GOAL_POCKET_DEPTH / 2 + 0.001), POCKET_FLOOR_Y + 0.0015, 0);
    group.add(plate);
  }

  // ── Scoreboard beads, on the rim ───────────────────────────────────────
  const beadGeometry = new THREE.SphereGeometry(0.0105, 8, 6);
  const beadMaterial = new THREE.MeshLambertMaterial();
  const beads = new THREE.InstancedMesh(beadGeometry, beadMaterial, MATCH_SCORE_TO_WIN * 2);
  beads.frustumCulled = false;
  const beadPos: THREE.Vector3[] = [];
  const barGeometries: THREE.BufferGeometry[] = [];
  const scoreTeams: Team[] = ["left", "right"];
  scoreTeams.forEach((team, t) => {
    const z = (team === "left" ? -1 : 1) * (W2 + RIM * 0.55);
    const x0 = team === "left" ? 0.32 : -0.32;
    barGeometries.push(slab(x0 - 0.03 * MATCH_SCORE_TO_WIN * 0.5 - 0.01, x0 + 0.03 * MATCH_SCORE_TO_WIN * 0.5 + 0.01, PLATE_TOP, PLATE_TOP + 0.004, z - 0.016, z + 0.016, COLOR.slot));
    for (let i = 0; i < MATCH_SCORE_TO_WIN; i++) {
      const x = x0 + (i - (MATCH_SCORE_TO_WIN - 1) / 2) * 0.03;
      const v = new THREE.Vector3(x, PLATE_TOP + 0.011, z);
      beadPos.push(v);
      beads.setMatrixAt(t * MATCH_SCORE_TO_WIN + i, new THREE.Matrix4().setPosition(v));
      beads.setColorAt(t * MATCH_SCORE_TO_WIN + i, new THREE.Color(COLOR.beadOff));
    }
  });
  beads.castShadow = true;
  group.add(beads);
  group.add(new THREE.Mesh(mergeGeometries(barGeometries.map((g) => g.toNonIndexed()))!, new THREE.MeshLambertMaterial({ vertexColors: true })));

  // ── Rods: chrome shaft + team grip ─────────────────────────────────────
  const rodHalf = outerZ + 0.21;
  const shaftGeometry = new THREE.CylinderGeometry(0.0058, 0.0058, rodHalf * 2, 8).rotateX(Math.PI / 2);
  const shaftMaterial = new THREE.MeshPhongMaterial({ color: COLOR.chrome, shininess: 90, specular: 0x8899aa });

  const gripGeometry = new THREE.CylinderGeometry(0.0125, 0.0125, 0.1, 10).rotateX(Math.PI / 2);
  const capGeometry = new THREE.CylinderGeometry(0.0145, 0.0145, 0.012, 10).rotateX(Math.PI / 2);
  const stripeGeometry = new THREE.BoxGeometry(0.004, 0.003, 0.085);
  const ringGeometry = new THREE.CylinderGeometry(0.0135, 0.0135, 0.008, 10).rotateX(Math.PI / 2);
  const capMaterial = new THREE.MeshLambertMaterial({ color: 0x0d0f16 });
  const white = new THREE.MeshLambertMaterial({ color: 0xf5f7ff });

  const rodGroups: THREE.Group[] = [];
  const gripMaterials: THREE.MeshLambertMaterial[] = [];
  for (const spec of RODS) {
    const rodGroup = new THREE.Group();
    rodGroup.position.set(spec.x, TABLE.rodHeight, 0);
    rodGroup.name = `rod-${spec.index}`;

    const shaft = new THREE.Mesh(shaftGeometry, shaftMaterial);
    shaft.castShadow = true;
    rodGroup.add(shaft);

    // One grip per rod, on the controlling team's side of the table.
    const side = spec.team === "left" ? 1 : -1;
    const gripMaterial = new THREE.MeshLambertMaterial({ color: TEAM_HEX[spec.team], emissive: 0x000000 });
    gripMaterials.push(gripMaterial);
    const gripZ = side * (outerZ + 0.095);

    const grip = new THREE.Mesh(gripGeometry, gripMaterial);
    grip.position.z = gripZ;
    grip.castShadow = true;
    rodGroup.add(grip);

    const cap = new THREE.Mesh(capGeometry, capMaterial);
    cap.position.z = gripZ + side * 0.052;
    rodGroup.add(cap);

    const ring = new THREE.Mesh(ringGeometry, white);
    ring.position.z = gripZ - side * 0.042;
    rodGroup.add(ring);

    // An off-centre stripe, so you can SEE the grip turn with the rod.
    const stripe = new THREE.Mesh(stripeGeometry, white);
    stripe.position.set(0.0124, 0, gripZ);
    rodGroup.add(stripe);

    rodGroups.push(rodGroup);
    group.add(rodGroup);
  }

  // ── Men: one InstancedMesh for all of them ─────────────────────────────
  const manSlots: { rod: number; baseZ: number; facing: number }[] = [];
  for (const spec of RODS) {
    const spacing = (TABLE.width * 0.86) / spec.men;
    for (let i = 0; i < spec.men; i++) {
      manSlots.push({
        rod: spec.index,
        baseZ: (i - (spec.men - 1) / 2) * spacing,
        facing: spec.team === "left" ? 0 : Math.PI,
      });
    }
  }

  const glowAttribute = new THREE.InstancedBufferAttribute(new Float32Array(manSlots.length), 1);
  glowAttribute.setUsage(THREE.DynamicDrawUsage);
  assets.figure.setAttribute("aGlow", glowAttribute);

  const men = new THREE.InstancedMesh(assets.figure, createFigureMaterial(), manSlots.length);
  men.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  men.frustumCulled = false;
  men.castShadow = true;
  men.receiveShadow = false;
  const tint = new THREE.Color();
  manSlots.forEach((slot, i) => men.setColorAt(i, tint.setHex(TEAM_HEX[RODS[slot.rod].team])));
  group.add(men);

  // Lane highlight on the pitch for the active rod.
  const laneMaterial = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const lane = new THREE.Mesh(new THREE.PlaneGeometry(0.075, TABLE.width), laneMaterial);
  lane.rotation.x = -Math.PI / 2;
  lane.position.y = 0.0015;
  lane.visible = false;
  group.add(lane);

  // ── Ball ───────────────────────────────────────────────────────────────
  const ball = createBall(assets.ball);
  ball.setPosition(0, TABLE.ballRadius, 0, false);
  group.add(ball.root);

  /* ── per-frame state ── */
  const dummy = new THREE.Object3D();
  dummy.rotation.order = "ZYX";
  const glow = new Float32Array(RODS.length);
  let active: number | null = null;
  let ownTeam: Team | null = null;
  const goalFlash: Record<number, number> = { [-1]: 0, [1]: 0 };
  const lit = { left: -1, right: -1 };
  const litColor = new THREE.Color();

  const lastAngle = new Float32Array(RODS.length).fill(Number.NaN);
  const lastOffset = new Float32Array(RODS.length).fill(Number.NaN);

  function writeMen(rods: RodState[]): void {
    let moved = false;
    for (let r = 0; r < RODS.length; r++) {
      const st = rods[r];
      if (!st || (st.angle === lastAngle[r] && st.offset === lastOffset[r])) continue;
      lastAngle[r] = st.angle;
      lastOffset[r] = st.offset;
      moved = true;
    }
    if (!moved) return;
    for (let i = 0; i < manSlots.length; i++) {
      const slot = manSlots[i];
      const state = rods[slot.rod];
      if (!state) continue;
      dummy.position.set(RODS[slot.rod].x, TABLE.rodHeight, slot.baseZ + state.offset * MAX_ROD_SLIDE);
      dummy.rotation.set(0, slot.facing, state.angle);
      dummy.updateMatrix();
      men.setMatrixAt(i, dummy.matrix);
    }
    men.instanceMatrix.needsUpdate = true;
  }

  return {
    group,
    ball,

    apply(rods: RodState[], ballPos: Vec3 | null): void {
      for (let i = 0; i < rodGroups.length; i++) {
        const state = rods[i];
        if (!state) continue;
        rodGroups[i].rotation.z = state.angle;
        rodGroups[i].position.z = state.offset * MAX_ROD_SLIDE;
      }
      writeMen(rods);
      if (active !== null && rods[active]) lane.position.x = RODS[active].x;
      if (ballPos) ball.setPosition(ballPos.x, ballPos.y, ballPos.z);
    },

    setScore(score: Record<Team, number>): void {
      scoreTeams.forEach((team, t) => {
        if (lit[team] === score[team]) return;
        lit[team] = score[team];
        for (let i = 0; i < MATCH_SCORE_TO_WIN; i++) {
          beads.setColorAt(t * MATCH_SCORE_TO_WIN + i, litColor.setHex(i < score[team] ? TEAM_HEX[team] : COLOR.beadOff));
        }
      });
      if (beads.instanceColor) beads.instanceColor.needsUpdate = true;
    },

    setActive(rod: number | null): void {
      active = rod;
      lane.visible = rod !== null;
      if (rod !== null) {
        laneMaterial.color.setHex(TEAM_HEX[RODS[rod].team]);
        lane.position.x = RODS[rod].x;
      }
    },

    setOwnTeam(team: Team | null): void {
      ownTeam = team;
    },

    flashGoal(scorer: Team): void {
      // The ball went into the goal of the team that did NOT score.
      goalFlash[scorer === "left" ? 1 : -1] = 1;
    },

    goalMouth(end: 1 | -1): THREE.Vector3 {
      return new THREE.Vector3(end * (L2 + GOAL_POCKET_DEPTH * 0.45), POCKET_FLOOR_Y, 0);
    },

    update(dtSec: number): void {
      // Ease each rod's glow toward 1 (active) or 0, and write the instances.
      let changed = false;
      for (let r = 0; r < RODS.length; r++) {
        const target = r === active ? 1 : 0;
        const next = glow[r] + (target - glow[r]) * Math.min(1, dtSec * 14);
        if (Math.abs(next - glow[r]) > 0.001 || next !== glow[r]) {
          glow[r] = Math.abs(target - next) < 0.002 ? target : next;
          changed = true;
        }
        // Your own grips always glow a little, so it's clear which rods are yours.
        const mineBase = RODS[r].team === ownTeam ? 0.25 : 0;
        gripMaterials[r].emissive.setHex(TEAM_HEX[RODS[r].team]).multiplyScalar(Math.max(glow[r] * 0.55, mineBase));
      }
      if (changed) {
        let i = 0;
        for (const slot of manSlots) glowAttribute.setX(i++, glow[slot.rod]);
        glowAttribute.needsUpdate = true;
      }
      laneMaterial.opacity = active === null ? 0 : 0.06 + 0.03 * Math.sin(performance.now() / 180);

      for (const end of [-1, 1] as const) {
        goalFlash[end] = Math.max(0, goalFlash[end] - dtSec * 0.8);
        const f = goalFlash[end];
        const pulse = f > 0 ? 0.5 + 0.5 * Math.sin(performance.now() / 70) : 0;
        // The pocket you defend glows in your colour all match long.
        const ownEnd = ownTeam === null ? 0 : ownTeam === "left" ? -1 : 1;
        if (f <= 0 && ownEnd === end && ownTeam) {
          goalGlowMaterials[end].color.setHex(TEAM_HEX[ownTeam]).multiplyScalar(0.7 + 0.25 * Math.sin(performance.now() / 500));
        } else {
          goalGlowMaterials[end].color.setRGB(1.0 * f * (0.4 + pulse * 0.6), 0.78 * f * (0.4 + pulse * 0.6), 0.1 * f);
        }
      }
      ball.update(dtSec);
    },

    setShadows(on: boolean): void {
      floorShadow.visible = on;
    },
  };
}
