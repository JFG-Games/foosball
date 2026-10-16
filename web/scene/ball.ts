import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { TABLE } from "@shared/constants";

/**
 * The ball: the soccer-ball GLB scaled to the physics radius, with rolling
 * driven by how far it actually travelled.
 */
export interface BallView {
  root: THREE.Group;
  /** Place the ball; rolls it by the distance moved since the last call. */
  setPosition(x: number, y: number, z: number, roll?: boolean): void;
  /** Squash-and-pop, e.g. when the ball is served. */
  pop(): void;
  update(dtSec: number): void;
}

/** Load the model and normalise it to unit radius. Resolves null on failure. */
export async function loadBallModel(url: string): Promise<THREE.Object3D | null> {
  try {
    const gltf = await new GLTFLoader().loadAsync(url);
    const model = gltf.scene;
    model.updateMatrixWorld(true);

    // The GLB ships unlit materials; light them so the ball sits in the scene.
    model.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (!mesh.isMesh) return;
      const old = mesh.material as THREE.MeshBasicMaterial;
      if (old.map) {
        mesh.material = new THREE.MeshLambertMaterial({ map: old.map, emissive: 0x2a2a2a });
        mesh.castShadow = true;
      } else {
        // The outline shell: a slightly larger dark hull. The export has its
        // faces inverted already, so the default (front) side shows only the far
        // half behind the ball, which reads as an outline.
        mesh.material = new THREE.MeshBasicMaterial({ color: 0x07090d });
      }
    });

    // Normalise: find the radius of the textured mesh (the outline is bigger).
    let radius = 0;
    model.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (!mesh.isMesh || !(mesh.material as THREE.MeshLambertMaterial).map) return;
      const box = new THREE.Box3().setFromObject(mesh);
      radius = Math.max(radius, (box.max.x - box.min.x) / 2);
    });
    if (radius <= 0) return null;
    const centre = new THREE.Box3().setFromObject(model).getCenter(new THREE.Vector3());
    const wrapper = new THREE.Group();
    model.position.sub(centre);
    wrapper.add(model);
    wrapper.scale.setScalar(TABLE.ballRadius / radius);
    return wrapper;
  } catch (error) {
    console.warn("[ball] could not load the soccer ball model, using a plain sphere", error);
    return null;
  }
}

export function createBall(model: THREE.Object3D | null): BallView {
  const root = new THREE.Group();
  root.name = "ball";

  const spinner = new THREE.Group();
  root.add(spinner);

  if (model) {
    spinner.add(model.clone(true));
  } else {
    const sphere = new THREE.Mesh(
      new THREE.SphereGeometry(TABLE.ballRadius, 16, 12),
      new THREE.MeshLambertMaterial({ color: 0xffffff }),
    );
    sphere.castShadow = true;
    spinner.add(sphere);
  }

  const last = new THREE.Vector3(Number.NaN, 0, 0);
  const axis = new THREE.Vector3();
  const delta = new THREE.Quaternion();
  let popT = 0;

  return {
    root,
    setPosition(x, y, z, roll = true): void {
      if (roll && !Number.isNaN(last.x)) {
        const dx = x - last.x;
        const dz = z - last.z;
        const dist = Math.hypot(dx, dz);
        // A jump (re-serve, goal) is not a roll.
        if (dist > 1e-6 && dist < 0.15) {
          axis.set(dz, 0, -dx).normalize();
          delta.setFromAxisAngle(axis, dist / TABLE.ballRadius);
          spinner.quaternion.premultiply(delta);
        }
      }
      last.set(x, y, z);
      root.position.set(x, y, z);
    },
    pop(): void {
      popT = 1;
    },
    update(dtSec: number): void {
      if (popT > 0) {
        popT = Math.max(0, popT - dtSec * 2.4);
        // Overshoot spring: 1 -> big -> settle.
        const s = 1 + Math.sin(popT * Math.PI * 2.5) * popT * 0.7;
        root.scale.setScalar(Math.max(0.2, s));
      } else if (root.scale.x !== 1) {
        root.scale.setScalar(1);
      }
    },
  };
}
