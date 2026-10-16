import * as THREE from "three";

/**
 * Renderer, lights and the adaptive-quality governor.
 *
 * The canvas is transparent so the page's painted backdrop shows through; the
 * 3D scene only has to draw the table and the floor shadow.
 *
 * Quality drops automatically when frames run long: first the pixel ratio,
 * then shadow resolution, then shadows entirely, so a weak phone stays smooth
 * instead of crawling. It never climbs back up, to avoid flip-flopping.
 */
export type Quality = 0 | 1 | 2 | 3;

const TIERS: { pixelRatio: number; shadowSize: number; label: string }[] = [
  { pixelRatio: 1.5, shadowSize: 1024, label: "high" },
  { pixelRatio: 1.25, shadowSize: 1024, label: "medium" },
  { pixelRatio: 1, shadowSize: 512, label: "low" },
  { pixelRatio: 1, shadowSize: 0, label: "minimal" },
];

export interface Stage {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  /** Match the drawing buffer to the container. Returns true if it changed. */
  resize(): boolean;
  render(): void;
  /** Feed the frame time; may lower the quality tier. */
  govern(frameMs: number): void;
  readonly quality: Quality;
  readonly width: number;
  readonly height: number;
  onQualityChange?: (quality: Quality) => void;
}

export function createStage(container: HTMLElement): Stage {
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true,
    powerPreference: "high-performance",
  });
  renderer.setClearColor(0x000000, 0);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap; // soft-filtered in current three
  // The shadow pass redraws every man; refresh it every other frame instead of every frame.
  renderer.shadowMap.autoUpdate = false;
  let frameNo = 0;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(42, 1, 0.05, 60);

  // Soft sky/ground light, a shadow-casting key and a cool fill.
  scene.add(new THREE.HemisphereLight(0xffffff, 0x4a5390, 1.35));

  const key = new THREE.DirectionalLight(0xfff4e0, 2.1);
  key.position.set(0.35, 1.9, 0.55);
  key.castShadow = true;
  // Tight around the table: the sharper the frustum, the crisper the men's shadows.
  key.shadow.camera.left = -0.95;
  key.shadow.camera.right = 0.95;
  key.shadow.camera.top = 0.72;
  key.shadow.camera.bottom = -0.72;
  key.shadow.camera.near = 0.5;
  key.shadow.camera.far = 4.5;
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.004;
  scene.add(key);

  const fill = new THREE.DirectionalLight(0x9fb4ff, 0.55);
  fill.position.set(-0.8, 0.9, -1.1);
  scene.add(fill);

  // Phones start one tier down; desktops start on top.
  const coarse = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
  let quality: Quality = coarse ? 1 : 0;
  let width = 0;
  let height = 0;

  function applyTier(): void {
    const tier = TIERS[quality];
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, tier.pixelRatio));
    key.castShadow = tier.shadowSize > 0;
    renderer.shadowMap.enabled = tier.shadowSize > 0;
    if (tier.shadowSize > 0 && key.shadow.mapSize.x !== tier.shadowSize) {
      key.shadow.mapSize.set(tier.shadowSize, tier.shadowSize);
      key.shadow.map?.dispose();
      key.shadow.map = null;
    }
    // Shadow-receiving materials need recompiling when shadows toggle.
    scene.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | undefined;
      if (m) m.needsUpdate = true;
    });
    width = 0; // force the next resize() to resize the buffer
  }
  applyTier();

  // Governor: average over a window of frames; step down when it's slow.
  let frames = 0;
  let sum = 0;
  let count = 0;
  let grace = 90; // ignore load-time hitches

  const stage: Stage = {
    renderer,
    scene,
    camera,
    get quality() {
      return quality;
    },
    get width() {
      return width;
    },
    get height() {
      return height;
    },

    resize(): boolean {
      const w = container.clientWidth;
      const h = container.clientHeight;
      if (w === 0 || h === 0) return false;
      if (w === width && h === height) return false;
      width = w;
      height = h;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      return true;
    },

    render(): void {
      renderer.shadowMap.needsUpdate = (frameNo++ & 1) === 0;
      renderer.render(scene, camera);
    },

    govern(frameMs: number): void {
      if (grace > 0) {
        grace--;
        return;
      }
      // Ignore tab-switch gaps and one-off spikes.
      if (frameMs > 250) return;
      sum += frameMs;
      count++;
      frames++;
      if (frames < 120) return;
      const avg = sum / count;
      frames = 0;
      sum = 0;
      count = 0;
      if (avg > 24 && quality < 3) {
        quality = (quality + 1) as Quality;
        applyTier();
        grace = 60;
        stage.onQualityChange?.(quality);
      }
    },
  };

  return stage;
}
