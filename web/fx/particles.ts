import * as THREE from "three";

/**
 * Pooled particles, two draw calls total.
 *
 *   Sparks    — soft round points; additive for glints, normal for dust.
 *               One THREE.Points with a tiny shader.
 *   Confetti  — spinning flat quads in one InstancedMesh.
 *
 * Particles live in plain typed arrays and are recycled round-robin, so
 * there is no per-frame allocation however many fire.
 */
const MAX_SPARKS = 700;
const MAX_CONFETTI = 220;

export interface SparkOptions {
  gravity?: number;
  drag?: number;
  /** 1 = additive glow, 0 = ordinary alpha (dust). */
  glow?: number;
  /** Fraction of its size a spark keeps at the end of its life. */
  shrink?: number;
}

export class Particles {
  readonly group = new THREE.Group();

  /* sparks */
  private readonly sPos = new Float32Array(MAX_SPARKS * 3);
  private readonly sCol = new Float32Array(MAX_SPARKS * 3);
  private readonly sSize = new Float32Array(MAX_SPARKS);
  private readonly sAlpha = new Float32Array(MAX_SPARKS);
  private readonly sGlow = new Float32Array(MAX_SPARKS);
  private readonly sVel = new Float32Array(MAX_SPARKS * 3);
  private readonly sLife = new Float32Array(MAX_SPARKS);
  private readonly sMax = new Float32Array(MAX_SPARKS);
  private readonly sBase = new Float32Array(MAX_SPARKS);
  private readonly sGrav = new Float32Array(MAX_SPARKS);
  private readonly sDrag = new Float32Array(MAX_SPARKS);
  private readonly sShrink = new Float32Array(MAX_SPARKS);
  private sNext = 0;
  private readonly points: THREE.Points;
  private readonly uniforms = { uScale: { value: 500 } };

  /* confetti */
  private readonly confetti: THREE.InstancedMesh;
  private readonly cPos = new Float32Array(MAX_CONFETTI * 3);
  private readonly cVel = new Float32Array(MAX_CONFETTI * 3);
  private readonly cRot = new Float32Array(MAX_CONFETTI * 3);
  private readonly cSpin = new Float32Array(MAX_CONFETTI * 3);
  private readonly cLife = new Float32Array(MAX_CONFETTI);
  private cNext = 0;
  private readonly dummy = new THREE.Object3D();
  private readonly tmp = new THREE.Color();

  constructor() {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(this.sPos, 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute("aColor", new THREE.BufferAttribute(this.sCol, 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute("aSize", new THREE.BufferAttribute(this.sSize, 1).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute("aAlpha", new THREE.BufferAttribute(this.sAlpha, 1).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute("aGlow", new THREE.BufferAttribute(this.sGlow, 1).setUsage(THREE.DynamicDrawUsage));

    const material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      vertexShader: /* glsl */ `
        attribute vec3 aColor;
        attribute float aSize;
        attribute float aAlpha;
        attribute float aGlow;
        uniform float uScale;
        varying vec3 vColor;
        varying float vAlpha;
        varying float vGlow;
        void main() {
          vec4 mv = modelViewMatrix * vec4( position, 1.0 );
          gl_Position = projectionMatrix * mv;
          gl_PointSize = max( 0.0, aSize * uScale / -mv.z );
          vColor = aColor;
          vAlpha = aAlpha;
          vGlow = aGlow;
        }`,
      fragmentShader: /* glsl */ `
        varying vec3 vColor;
        varying float vAlpha;
        varying float vGlow;
        void main() {
          float d = length( gl_PointCoord - 0.5 ) * 2.0;
          float a = smoothstep( 1.0, 0.15, d ) * vAlpha;
          // Premultiplied: glow sets alpha to 0, which makes the blend additive.
          gl_FragColor = vec4( vColor * a, a * ( 1.0 - vGlow ) );
        }`,
    });

    this.points = new THREE.Points(geometry, material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 10;
    this.group.add(this.points);

    const quad = new THREE.PlaneGeometry(0.016, 0.009);
    this.confetti = new THREE.InstancedMesh(quad, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }), MAX_CONFETTI);
    this.confetti.frustumCulled = false;
    this.confetti.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.dummy.scale.setScalar(0);
    this.dummy.updateMatrix();
    for (let i = 0; i < MAX_CONFETTI; i++) {
      this.confetti.setMatrixAt(i, this.dummy.matrix);
      this.confetti.setColorAt(i, this.tmp.setHex(0xffffff));
    }
    this.group.add(this.confetti);
  }

  /** Keep point sizes true to the camera. Call after the FOV or size changes. */
  setView(heightPx: number, fovDeg: number, pixelRatio: number): void {
    this.uniforms.uScale.value = (heightPx * pixelRatio) / (2 * Math.tan(THREE.MathUtils.degToRad(fovDeg) / 2));
  }

  /** Fire one spark. */
  spark(
    x: number, y: number, z: number,
    vx: number, vy: number, vz: number,
    color: number, size: number, life: number,
    opts: SparkOptions = {},
  ): void {
    const i = this.sNext;
    this.sNext = (this.sNext + 1) % MAX_SPARKS;
    this.tmp.setHex(color);
    this.sPos[i * 3] = x; this.sPos[i * 3 + 1] = y; this.sPos[i * 3 + 2] = z;
    this.sVel[i * 3] = vx; this.sVel[i * 3 + 1] = vy; this.sVel[i * 3 + 2] = vz;
    this.sCol[i * 3] = this.tmp.r; this.sCol[i * 3 + 1] = this.tmp.g; this.sCol[i * 3 + 2] = this.tmp.b;
    this.sBase[i] = size;
    this.sSize[i] = size;
    this.sLife[i] = life;
    this.sMax[i] = life;
    this.sGrav[i] = opts.gravity ?? 3;
    this.sDrag[i] = opts.drag ?? 2.5;
    this.sGlow[i] = opts.glow ?? 1;
    this.sShrink[i] = opts.shrink ?? 0.1;
    this.sAlpha[i] = 1;
  }

  /** A spray of sparks: `speed` m/s, spread in every direction around `dir`. */
  burst(
    x: number, y: number, z: number,
    count: number, speed: number, color: number,
    opts: SparkOptions & { size?: number; life?: number; dirX?: number; dirZ?: number; cone?: number } = {},
  ): void {
    const cone = opts.cone ?? 1;
    for (let n = 0; n < count; n++) {
      const a = Math.random() * Math.PI * 2;
      const e = Math.random();
      let vx = Math.cos(a) * speed * (0.3 + Math.random() * 0.7);
      let vz = Math.sin(a) * speed * (0.3 + Math.random() * 0.7);
      if (opts.dirX !== undefined || opts.dirZ !== undefined) {
        vx = vx * cone + (opts.dirX ?? 0) * speed;
        vz = vz * cone + (opts.dirZ ?? 0) * speed;
      }
      this.spark(
        x, y, z,
        vx, speed * (0.25 + e * 0.7), vz,
        color, (opts.size ?? 0.007) * (0.6 + Math.random() * 0.8), (opts.life ?? 0.5) * (0.6 + Math.random() * 0.7),
        opts,
      );
    }
  }

  /** Throw confetti up and out from a point. */
  confettiBurst(x: number, y: number, z: number, count: number, palette: number[], speed = 1.4): void {
    for (let n = 0; n < count; n++) {
      const i = this.cNext;
      this.cNext = (this.cNext + 1) % MAX_CONFETTI;
      const a = Math.random() * Math.PI * 2;
      const s = speed * (0.3 + Math.random() * 0.9);
      this.cPos[i * 3] = x; this.cPos[i * 3 + 1] = y; this.cPos[i * 3 + 2] = z;
      this.cVel[i * 3] = Math.cos(a) * s;
      this.cVel[i * 3 + 1] = speed * (0.8 + Math.random() * 1.2);
      this.cVel[i * 3 + 2] = Math.sin(a) * s;
      this.cRot[i * 3] = Math.random() * 6; this.cRot[i * 3 + 1] = Math.random() * 6; this.cRot[i * 3 + 2] = Math.random() * 6;
      this.cSpin[i * 3] = (Math.random() - 0.5) * 24; this.cSpin[i * 3 + 1] = (Math.random() - 0.5) * 24; this.cSpin[i * 3 + 2] = (Math.random() - 0.5) * 24;
      this.cLife[i] = 1.8 + Math.random() * 1.2;
      this.confetti.setColorAt(i, this.tmp.setHex(palette[Math.floor(Math.random() * palette.length)]));
    }
    if (this.confetti.instanceColor) this.confetti.instanceColor.needsUpdate = true;
  }

  update(dt: number): void {
    // Sparks.
    let live = false;
    for (let i = 0; i < MAX_SPARKS; i++) {
      if (this.sLife[i] <= 0) continue;
      live = true;
      this.sLife[i] -= dt;
      if (this.sLife[i] <= 0) {
        this.sAlpha[i] = 0;
        this.sSize[i] = 0;
        continue;
      }
      const k = this.sLife[i] / this.sMax[i];
      const drag = Math.exp(-this.sDrag[i] * dt);
      this.sVel[i * 3] *= drag;
      this.sVel[i * 3 + 1] = this.sVel[i * 3 + 1] * drag - this.sGrav[i] * dt;
      this.sVel[i * 3 + 2] *= drag;
      this.sPos[i * 3] += this.sVel[i * 3] * dt;
      this.sPos[i * 3 + 1] += this.sVel[i * 3 + 1] * dt;
      this.sPos[i * 3 + 2] += this.sVel[i * 3 + 2] * dt;
      // Keep them from sinking through the pitch.
      if (this.sPos[i * 3 + 1] < 0.002 && this.sVel[i * 3 + 1] < 0) {
        this.sPos[i * 3 + 1] = 0.002;
        this.sVel[i * 3 + 1] *= -0.3;
      }
      this.sAlpha[i] = Math.min(1, k * 2.2);
      this.sSize[i] = this.sBase[i] * (this.sShrink[i] + (1 - this.sShrink[i]) * k);
    }
    if (live) {
      const g = this.points.geometry;
      (g.attributes.position as THREE.BufferAttribute).needsUpdate = true;
      (g.attributes.aSize as THREE.BufferAttribute).needsUpdate = true;
      (g.attributes.aAlpha as THREE.BufferAttribute).needsUpdate = true;
      (g.attributes.aColor as THREE.BufferAttribute).needsUpdate = true;
      (g.attributes.aGlow as THREE.BufferAttribute).needsUpdate = true;
    }

    // Confetti.
    let any = false;
    for (let i = 0; i < MAX_CONFETTI; i++) {
      if (this.cLife[i] <= 0) continue;
      any = true;
      this.cLife[i] -= dt;
      if (this.cLife[i] <= 0) {
        this.dummy.scale.setScalar(0);
        this.dummy.updateMatrix();
        this.confetti.setMatrixAt(i, this.dummy.matrix);
        continue;
      }
      this.cVel[i * 3 + 1] -= 2.2 * dt;
      const air = Math.exp(-1.6 * dt);
      this.cVel[i * 3] *= air;
      this.cVel[i * 3 + 2] *= air;
      if (this.cVel[i * 3 + 1] < -0.5) this.cVel[i * 3 + 1] = -0.5; // flutter down
      this.cPos[i * 3] += this.cVel[i * 3] * dt;
      this.cPos[i * 3 + 1] += this.cVel[i * 3 + 1] * dt;
      this.cPos[i * 3 + 2] += this.cVel[i * 3 + 2] * dt;
      if (this.cPos[i * 3 + 1] < 0.003) {
        this.cPos[i * 3 + 1] = 0.003;
        this.cVel[i * 3] = this.cVel[i * 3 + 1] = this.cVel[i * 3 + 2] = 0;
        this.cSpin[i * 3] = this.cSpin[i * 3 + 1] = this.cSpin[i * 3 + 2] = 0;
      }
      this.cRot[i * 3] += this.cSpin[i * 3] * dt;
      this.cRot[i * 3 + 1] += this.cSpin[i * 3 + 1] * dt;
      this.cRot[i * 3 + 2] += this.cSpin[i * 3 + 2] * dt;
      this.dummy.position.set(this.cPos[i * 3], this.cPos[i * 3 + 1], this.cPos[i * 3 + 2]);
      this.dummy.rotation.set(this.cRot[i * 3], this.cRot[i * 3 + 1], this.cRot[i * 3 + 2]);
      this.dummy.scale.setScalar(Math.min(1, this.cLife[i] * 2));
      this.dummy.updateMatrix();
      this.confetti.setMatrixAt(i, this.dummy.matrix);
    }
    if (any) this.confetti.instanceMatrix.needsUpdate = true;
  }
}
