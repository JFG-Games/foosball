import * as THREE from "three";
import { GOAL_HALF_WIDTH, MAN_SWING, MAX_ROD_SLIDE, RODS, TABLE } from "@shared/constants";
import type { RodState, Vec3 } from "@shared/types";

/**
 * Stylised, flat-shaded foosball table — the Lagos Life look: bold solid
 * colours, low-poly geometry, minimal shading.
 *
 * Rods rotate about their own long axis (local z) and slide along it, which
 * is exactly the model `shared/sim.ts` simulates. A man's mesh hangs
 * `MAN_SWING` below its rod, so a rotation of `a` puts the foot at
 * `MAN_SWING * sin(a)` along x — matching the physics.
 */

/** Vibrant, high-contrast flat colours. */
const COLOR = {
  surface: 0x1f8a4c,
  surfaceDark: 0x15703c,
  line: 0xe8f5ee,
  rail: 0x0e3f25,
  rod: 0xc2cbd6,
  handle: 0x2a2f36,
  ball: 0xfdfdfd,
  goalLeft: 0xff8a3d,
  goalRight: 0x3d9bff,
} as const;

export interface TableView {
  group: THREE.Group;
  /** Drive the rods and ball from a snapshot (or a predicted state). */
  apply(rods: RodState[], ball: Vec3): void;
}

function flat(color: number): THREE.MeshLambertMaterial {
  return new THREE.MeshLambertMaterial({ color });
}

/** One end rail per side of the goal mouth, so the mouth is left open. */
function addEndRail(parent: THREE.Group, x: number, railW: number, railH: number): void {
  const segment = (TABLE.width / 2 - GOAL_HALF_WIDTH) / 1;
  if (segment <= 0) return;
  for (const sign of [-1, 1]) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(railW, railH, segment), flat(COLOR.rail));
    mesh.position.set(x, railH / 2, sign * (GOAL_HALF_WIDTH + segment / 2));
    parent.add(mesh);
  }
}

export function createTable(): TableView {
  const group = new THREE.Group();
  group.name = "table";

  const railH = 0.05;
  const railW = 0.03;

  // ── Playing surface (top face at y = 0) ────────────────────────────────
  const surface = new THREE.Mesh(
    new THREE.BoxGeometry(TABLE.length, TABLE.surfaceThickness, TABLE.width),
    flat(COLOR.surface),
  );
  surface.position.y = -TABLE.surfaceThickness / 2;
  surface.name = "playfield";
  group.add(surface);

  // Centre line and centre circle, drawn just above the surface.
  const halfLine = new THREE.Mesh(
    new THREE.BoxGeometry(0.004, 0.001, TABLE.width),
    flat(COLOR.line),
  );
  halfLine.position.y = 0.0008;
  group.add(halfLine);

  const circle = new THREE.Mesh(
    new THREE.RingGeometry(0.075, 0.08, 48),
    new THREE.MeshBasicMaterial({ color: COLOR.line, side: THREE.DoubleSide }),
  );
  circle.rotation.x = -Math.PI / 2;
  circle.position.y = 0.0008;
  group.add(circle);

  // ── Rails ──────────────────────────────────────────────────────────────
  for (const sign of [-1, 1]) {
    const side = new THREE.Mesh(
      new THREE.BoxGeometry(TABLE.length + railW * 2, railH, railW),
      flat(COLOR.rail),
    );
    side.position.set(0, railH / 2, sign * (TABLE.width / 2 + railW / 2));
    group.add(side);

    // Goal recess, so a scored ball reads as entering the goal.
    const recess = new THREE.Mesh(
      new THREE.BoxGeometry(0.02, railH, GOAL_HALF_WIDTH * 2),
      flat(COLOR.surfaceDark),
    );
    recess.position.set(sign * (TABLE.length / 2 + 0.01), railH / 2, 0);
    group.add(recess);

    addEndRail(group, sign * (TABLE.length / 2 + railW / 2), railW, railH);
  }

  // ── Legs ───────────────────────────────────────────────────────────────
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.5, 0.03), flat(COLOR.rail));
      leg.position.set(
        sx * (TABLE.length / 2 - 0.06),
        -0.25 - TABLE.surfaceThickness,
        sz * (TABLE.width / 2 - 0.06),
      );
      group.add(leg);
    }
  }

  // ── Rods + men ─────────────────────────────────────────────────────────
  const rodLength = TABLE.width + 0.18;
  const rodGroups: THREE.Group[] = [];

  for (const spec of RODS) {
    const rodGroup = new THREE.Group();
    rodGroup.position.set(spec.x, TABLE.rodHeight, 0);
    rodGroup.name = `rod-${spec.index}`;

    const rod = new THREE.Mesh(
      new THREE.CylinderGeometry(0.006, 0.006, rodLength, 14),
      flat(COLOR.rod),
    );
    rod.rotation.x = Math.PI / 2; // lie along z
    rodGroup.add(rod);

    for (const sign of [-1, 1]) {
      const handle = new THREE.Mesh(
        new THREE.CylinderGeometry(0.011, 0.011, 0.075, 12),
        flat(COLOR.handle),
      );
      handle.rotation.x = Math.PI / 2;
      handle.position.z = sign * (rodLength / 2 - 0.0375);
      rodGroup.add(handle);
    }

    const spacing = (TABLE.width * 0.86) / spec.men;
    for (let i = 0; i < spec.men; i++) {
      const man = new THREE.Mesh(
        new THREE.BoxGeometry(0.026, 0.05, 0.038),
        flat(spec.team === "left" ? COLOR.goalLeft : COLOR.goalRight),
      );
      man.position.set(0, -MAN_SWING, (i - (spec.men - 1) / 2) * spacing);
      rodGroup.add(man);
    }

    rodGroups.push(rodGroup);
    group.add(rodGroup);
  }

  // ── Ball ───────────────────────────────────────────────────────────────
  const ball = new THREE.Mesh(
    new THREE.SphereGeometry(TABLE.ballRadius, 20, 14),
    flat(COLOR.ball),
  );
  ball.name = "ball";
  ball.position.set(0, TABLE.ballRadius, 0);
  group.add(ball);

  return {
    group,
    apply(rods: RodState[], ballPos: Vec3): void {
      for (let i = 0; i < rodGroups.length; i++) {
        const state = rods[i];
        if (!state) continue;
        const rodGroup = rodGroups[i];
        rodGroup.rotation.z = state.angle;
        rodGroup.position.z = state.offset * MAX_ROD_SLIDE;
      }
      ball.position.set(ballPos.x, ballPos.y, ballPos.z);
    },
  };
}
