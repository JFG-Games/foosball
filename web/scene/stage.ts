import * as THREE from "three";
import type { Team } from "@shared/constants";

/**
 * Renderer, camera and lighting.
 *
 * The camera sits behind the player's own goal and looks down the table, so
 * each side sees the pitch from their own end: their goal at the bottom of
 * the screen, their rods nearest them.
 */
export interface Stage {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  /** Match the drawing buffer to the container. Returns true if it changed. */
  resize(): boolean;
  render(): void;
}

export function createStage(container: HTMLElement, team: Team): Stage {
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b0f14);
  scene.fog = new THREE.Fog(0x0b0f14, 2.2, 4.5);

  const camera = new THREE.PerspectiveCamera(50, 1, 0.05, 50);

  // `dir` points from the table centre toward this player's own goal.
  const dir = team === "left" ? -1 : 1;
  camera.position.set(dir * 0.86, 0.92, 0);
  camera.lookAt(dir * -0.06, 0.0, 0);

  // Key light comes from the player's own side, so the rods are readable.
  scene.add(new THREE.HemisphereLight(0xffffff, 0x2a3441, 1.15));

  const key = new THREE.DirectionalLight(0xffffff, 1.5);
  key.position.set(dir * -0.9, 1.7, 0.8);
  scene.add(key);

  const fill = new THREE.DirectionalLight(0x9fc4ff, 0.5);
  fill.position.set(dir * 0.9, 0.9, -1.1);
  scene.add(fill);

  function resize(): boolean {
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (w === 0 || h === 0) return false;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    return true;
  }

  resize();

  return {
    renderer,
    scene,
    camera,
    resize,
    render(): void {
      renderer.render(scene, camera);
    },
  };
}
