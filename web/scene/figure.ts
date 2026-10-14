import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { MAN_SWING } from "@shared/constants";

/**
 * The foosball-player model, prepared for cheap rendering.
 *
 * The GLB is 13 meshes in 12 materials, all drawn in blue. Rather than clone
 * it 22 times we:
 *   1. bake every mesh into ONE geometry, posed so the rod axis is the origin,
 *      the man faces +x and "down" is -y (so rotating the rod swings the foot
 *      exactly like the physics assumes);
 *   2. record, per vertex, which parts are the team kit (`aMask`) — shirt and
 *      shorts are the primary colour, socks and base the secondary;
 *   3. draw all 22 men as a single InstancedMesh whose shader swaps the blue
 *      kit for each instance's team colour (`instanceColor`), and can add a
 *      glow for the rod you are holding (`aGlow`).
 *
 * One draw call, one 12k-triangle mesh in memory, any number of team colours.
 */

/** World metres per model unit. 0.0125 makes a man ~9 cm tall — a real man's size. */
const SCALE = 0.0125;
/** The model is slim; the physics circle is generous. Stretch to close the gap. */
const DEPTH_STRETCH = 1.5;
const WIDTH_STRETCH = 1.1;

const MASK_NONE = 0;
const MASK_PRIMARY = 1;
const MASK_SECONDARY = 2;

/** Colour of a material, in the GLB, that marks it as team kit. */
function kitMask(material: THREE.Material): number {
  const c = (material as THREE.MeshStandardMaterial).color;
  if (!c) return MASK_NONE;
  const bluish = c.b > 0.15 && c.b > 4 * c.r && c.b > 4 * c.g;
  if (!bluish) return MASK_NONE;
  // The shirt is the brightest of the blues; socks and the base are a touch darker.
  return c.b > 0.25 ? MASK_PRIMARY : MASK_SECONDARY;
}

/** Bake the loaded scene into one geometry in the foosball frame. */
function bake(scene: THREE.Object3D): THREE.BufferGeometry {
  scene.updateMatrixWorld(true);
  const parts: THREE.BufferGeometry[] = [];

  scene.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;

    const geometry = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
    geometry.deleteAttribute("uv");
    const count = geometry.attributes.position.count;

    const color = (material as THREE.MeshStandardMaterial).color ?? new THREE.Color(1, 1, 1);
    const colors = new Float32Array(count * 3);
    const masks = new Float32Array(count);
    const mask = kitMask(material);
    for (let i = 0; i < count; i++) {
      colors[i * 3] = color.r;
      colors[i * 3 + 1] = color.g;
      colors[i * 3 + 2] = color.b;
      masks[i] = mask;
    }
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute("aMask", new THREE.BufferAttribute(masks, 1));
    parts.push(geometry);
  });

  const merged = mergeGeometries(parts, false);
  if (!merged) throw new Error("foosball_player.glb contained no meshes");
  parts.forEach((p) => p.dispose());

  // Viewer frame (+y up, +z facing, x across the shoulders)  ->  foosball
  // frame (+y up, +x facing, z along the rod, i.e. across the shoulders).
  merged.applyMatrix4(
    new THREE.Matrix4().set(
      0, 0, DEPTH_STRETCH, 0,
      0, 1, 0, 0,
      -WIDTH_STRETCH, 0, 0, 0,
      0, 0, 0, 1,
    ),
  );
  merged.scale(SCALE, SCALE, SCALE);

  // Put the rod axis at the origin: MAN_SWING above the foot's centre, and
  // centred (x, z) on the feet so the foot lines up with the physics circle.
  merged.computeBoundingBox();
  const box = merged.boundingBox!;
  const pos = merged.attributes.position;
  let fx = 0;
  let fz = 0;
  let n = 0;
  const footTop = box.min.y + 0.012;
  for (let i = 0; i < pos.count; i++) {
    if (pos.getY(i) <= footTop) {
      fx += pos.getX(i);
      fz += pos.getZ(i);
      n++;
    }
  }
  const footCentreY = box.min.y + 0.0055;
  merged.translate(-fx / n, -(footCentreY + MAN_SWING), -fz / n);
  merged.computeBoundingSphere();
  return merged;
}

/** Stand-in used when the GLB cannot be loaded: a simple blocky man. */
export function buildFallbackFigure(): THREE.BufferGeometry {
  const part = (w: number, h: number, d: number, y: number, mask: number, color: number): THREE.BufferGeometry => {
    const g = new THREE.BoxGeometry(d, h, w).toNonIndexed();
    g.translate(0, y, 0);
    const n = g.attributes.position.count;
    const c = new THREE.Color(color);
    const colors = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }
    g.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    g.setAttribute("aMask", new THREE.BufferAttribute(new Float32Array(n).fill(mask), 1));
    g.deleteAttribute("uv");
    return g;
  };
  const merged = mergeGeometries(
    [
      part(0.026, 0.022, 0.022, -MAN_SWING + 0.011, MASK_SECONDARY, 0x0000ff),
      part(0.03, 0.04, 0.026, -MAN_SWING + 0.04, MASK_PRIMARY, 0x0000ff),
      part(0.02, 0.02, 0.02, -MAN_SWING + 0.07, MASK_NONE, 0xc9a07a),
    ],
    false,
  )!;
  merged.computeBoundingSphere();
  return merged;
}

/** Load and bake the player model. Falls back to a blocky man on failure. */
export async function loadFigureGeometry(url: string, onProgress?: (fraction: number) => void): Promise<THREE.BufferGeometry> {
  try {
    const gltf = await new GLTFLoader().loadAsync(url, (e) => {
      if (e.lengthComputable) onProgress?.(e.loaded / e.total);
    });
    return bake(gltf.scene);
  } catch (error) {
    console.warn("[figure] could not load the player model, using a placeholder", error);
    return buildFallbackFigure();
  }
}

/**
 * Lambert material that swaps the model's blue kit for the instance colour
 * and adds a per-instance glow. Everything else keeps its baked colour.
 */
export function createFigureMaterial(): THREE.MeshLambertMaterial {
  const material = new THREE.MeshLambertMaterial({ vertexColors: true });

  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
         attribute float aMask;
         attribute float aGlow;
         varying float vGlow;`,
      )
      .replace(
        "#include <color_vertex>",
        `#include <color_vertex>
         #ifdef USE_INSTANCING_COLOR
           // Undo the plain multiply above; kit parts take the team colour outright.
           vec3 teamColour = instanceColor.rgb;
         #else
           vec3 teamColour = vec3( 0.05, 0.2, 1.0 );
         #endif
         float primary = step( 0.5, aMask ) * ( 1.0 - step( 1.5, aMask ) );
         float secondary = step( 1.5, aMask );
         vColor.rgb = color.rgb;
         vColor.rgb = mix( vColor.rgb, teamColour, primary );
         vColor.rgb = mix( vColor.rgb, teamColour * 0.5, secondary );
         vGlow = aGlow;`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n varying float vGlow;`)
      .replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>
         totalEmissiveRadiance += vColor.rgb * vGlow * 0.22 + vec3( vGlow * 0.03 );`,
      );
  };

  return material;
}
