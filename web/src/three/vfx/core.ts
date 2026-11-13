// Shared machinery for the race effects.
//
//   * seeded randomness and a particle budget per quality level;
//   * the pool of point lights effects borrow (never add lights mid-race);
//   * a per-frame probe of the camera, sun, sky, fog and pooled lights, so
//     unlit effect shaders can still be lit like the scene around them;
//   * a generated, tiling four-channel noise texture (nothing is downloaded);
//   * blackbody colour, so fire, sparks and lightning glow at the colour and
//     relative brightness of their temperature;
//   * Field: a CPU-simulated, depth-sorted particle system drawn as ONE
//     instanced draw call with premultiplied alpha, so emissive fire (alpha 0)
//     and occluding smoke (alpha > 0) mix correctly in a single pass. Every
//     Field shares one material and one shader program.

import * as THREE from "three";
import { detectQuality, rng, type Quality } from "../gfx.ts";

// ----- Randomness and quality ------------------------------------------------

let random: () => number = Math.random;

/** Uniform random number in [0, 1). Seed it with seedEffects() for repeatable tests. */
export function rand(): number {
  return random();
}

export function range(a: number, b: number): number {
  return a + (b - a) * random();
}

/** A random unit vector, written into out. */
export function randomDir(out: THREE.Vector3): THREE.Vector3 {
  const z = random() * 2 - 1;
  const a = random() * Math.PI * 2;
  const r = Math.sqrt(1 - z * z);
  return out.set(Math.cos(a) * r, z, Math.sin(a) * r);
}

/** Makes every effect use a seeded random stream (null goes back to Math.random). */
export function seedEffects(seed: number | null) {
  random = seed === null ? Math.random : rng(seed);
}

let quality: Quality | null = null;
let qualityFromRace = false;

export function effectQuality(): Quality {
  if (!quality) quality = detectQuality();
  return quality;
}

/** Tells the effects which quality the race runs at. Call before warming up. */
export function setEffectQuality(value: Quality) {
  quality = value;
  qualityFromRace = true;
}

let qualityChecked = false;

/** Scales a particle count for the current quality. */
export function budget(count: number): number {
  const q = effectQuality();
  return Math.max(1, Math.round(count * (q === "high" ? 1 : q === "medium" ? 0.72 : 0.42)));
}

// ----- Blackbody ---------------------------------------------------------------

// Planck's law sampled at three wavelengths near the sRGB primaries (micrometres),
// white-balanced so 6500 K is neutral, then normalised to unit luminance.
const LAMBDA = [0.65, 0.55, 0.46];
const C2 = 14388; // second radiation constant, um*K
const planck = (lambda: number, kelvin: number) => 1 / (lambda ** 5 * (Math.exp(C2 / (lambda * kelvin)) - 1));
const WHITE = LAMBDA.map((lambda) => planck(lambda, 6500));

/** Linear RGB of a blackbody at `kelvin`, with luminance 1. */
export function blackbody(kelvin: number, out: THREE.Color = new THREE.Color()): THREE.Color {
  const t = Math.max(450, kelvin);
  const r = planck(LAMBDA[0], t) / WHITE[0];
  const g = planck(LAMBDA[1], t) / WHITE[1];
  const b = planck(LAMBDA[2], t) / WHITE[2];
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return out.setRGB(r / lum, g / lum, b / lum);
}

/**
 * Radiance of something glowing at `kelvin`, relative to 1500 K. Real
 * incandescence climbs far faster than this; a fifth power keeps the ratios
 * steep enough to read as heat while staying inside an HDR buffer.
 */
export function heatLevel(kelvin: number): number {
  return (Math.max(450, kelvin) / 1500) ** 5;
}

/** blackbody(kelvin) * heatLevel(kelvin) * gain, as an emission colour. */
export function heat(kelvin: number, gain: number, out: THREE.Color): THREE.Color {
  return blackbody(kelvin, out).multiplyScalar(heatLevel(kelvin) * gain);
}

const glslFloat = (value: number) => (Number.isInteger(value) ? value.toFixed(1) : String(value));

export const GLSL_BLACKBODY = /* glsl */ `
vec3 blackbody(float kelvin){
  float t = max(kelvin, 450.0);
  vec3 lambda = vec3(${LAMBDA.map(glslFloat).join(", ")});
  vec3 l5 = lambda*lambda*lambda*lambda*lambda;
  vec3 b = 1.0 / (l5 * (exp(${glslFloat(C2)} / (lambda * t)) - 1.0));
  b /= vec3(${WHITE.map((w) => w.toPrecision(7)).join(", ")});
  return b / dot(b, vec3(0.2126, 0.7152, 0.0722));
}
vec3 heat(float kelvin){ float t = max(kelvin, 450.0) * (1.0/1500.0); float t2 = t*t; return blackbody(kelvin) * (t2*t2*t); }
`;

// ----- Effect lights ---------------------------------------------------------

// Lights the effects borrow. Adding or removing a light makes every lit
// material recompile, which freezes the game for seconds, so a fixed number go
// into the scene once and are only ever moved and dimmed.
export interface EffectLight {
  light: THREE.PointLight;
  busy: boolean;
}

let effectLights: EffectLight[] = [];

/** Puts the lights in place, and returns how to take them away again. */
export function installEffectLights(scene: THREE.Object3D, count = 4): () => void {
  const lights = Array.from({ length: count }, () => {
    const light = new THREE.PointLight("#ffffff", 0, 30, 2);
    scene.add(light);
    return { light, busy: false };
  });
  effectLights = lights;
  return () => {
    for (const { light } of lights) {
      scene.remove(light);
      light.dispose();
    }
    if (effectLights === lights) effectLights = [];
  };
}

export function borrowLight(color: THREE.ColorRepresentation, distance: number): EffectLight | null {
  const slot = effectLights.find((candidate) => !candidate.busy) ?? null;
  if (slot) {
    slot.busy = true;
    slot.light.color.set(color);
    slot.light.distance = distance;
    slot.light.intensity = 0;
  }
  return slot;
}

export function returnLight(slot: EffectLight | null) {
  if (slot) {
    slot.light.intensity = 0;
    slot.busy = false;
  }
}

// ----- Shared uniforms and the per-frame probe ---------------------------------

const MAX_LIGHTS = 4;

/** Uniform objects shared by every effect material (same objects, so one update reaches all). */
export const SHARED = {
  uNoise: { value: null as THREE.Texture | null },
  uSunDir: { value: new THREE.Vector3(0.35, 0.8, 0.45).normalize() },
  uSunCol: { value: new THREE.Color(5.2, 4.9, 4.4) },
  uSkyCol: { value: new THREE.Color(0.62, 0.78, 0.98) },
  uGroundCol: { value: new THREE.Color(0.5, 0.46, 0.3) },
  uFogCol: { value: new THREE.Color(0.75, 0.86, 0.92) },
  uFogRange: { value: new THREE.Vector2(28, 520) },
  uViewport: { value: new THREE.Vector2(1920, 1080) },
  uLightPos: { value: Array.from({ length: MAX_LIGHTS }, () => new THREE.Vector3()) },
  uLightCol: { value: Array.from({ length: MAX_LIGHTS }, () => new THREE.Color(0, 0, 0)) },
  uLightRange: { value: Array.from({ length: MAX_LIGHTS }, () => 30) },
  /** 1 while any effect light is lit, so shaders can skip the light loop. */
  uLightsOn: { value: 0 },
  uGround: { value: 0 },
};

/** The shared scene uniforms every lit effect shader (GLSL_SCENE) needs. */
export function sceneUniforms(): Record<string, THREE.IUniform> {
  return {
    uSunDir: SHARED.uSunDir,
    uSunCol: SHARED.uSunCol,
    uSkyCol: SHARED.uSkyCol,
    uGroundCol: SHARED.uGroundCol,
    uFogCol: SHARED.uFogCol,
    uFogRange: SHARED.uFogRange,
    uLightPos: SHARED.uLightPos,
    uLightCol: SHARED.uLightCol,
    uLightRange: SHARED.uLightRange,
    uLightsOn: SHARED.uLightsOn,
  };
}

/** What the effects know about the frame being drawn. */
export const VIEW = {
  frame: -1,
  camera: new THREE.Vector3(0, 4, 8),
  forward: new THREE.Vector3(0, 0, -1),
  /** Smoothed camera velocity, m/s: particles are motion-blurred against it. */
  velocity: new THREE.Vector3(),
  known: false,
  lastTime: 0,
};

const sceneLights = new WeakMap<object, { sun: THREE.DirectionalLight | null; hemi: THREE.HemisphereLight | null }>();
const scratchA = new THREE.Vector3();
const scratchB = new THREE.Vector3();
const scratch2 = new THREE.Vector2();

/** Reads the camera, sun, sky, fog and effect lights once per rendered frame. */
export function observeFrame(renderer: THREE.WebGLRenderer, scene: THREE.Object3D, camera: THREE.Camera) {
  const frame = renderer.info.render.frame;
  if (frame === VIEW.frame) return;
  if (!qualityChecked) {
    // Unless told, judge quality the way the race does, from the real GPU.
    qualityChecked = true;
    if (!qualityFromRace) quality = detectQuality(renderer.getContext() as WebGL2RenderingContext);
  }
  VIEW.frame = frame;
  const now = performance.now() / 1000;
  const dt = now - VIEW.lastTime;
  VIEW.lastTime = now;

  const m = camera.matrixWorld.elements;
  const position = scratchA.set(m[12], m[13], m[14]);
  if (VIEW.known && dt > 0.001 && dt < 0.25) {
    const raw = scratchB.subVectors(position, VIEW.camera).divideScalar(dt);
    // A cut (blink, intro, finish swing) is not motion.
    if (raw.lengthSq() > 70 * 70) raw.set(0, 0, 0);
    VIEW.velocity.lerp(raw, 1 - Math.exp(-dt / 0.09));
  }
  VIEW.camera.copy(position);
  VIEW.forward.set(-m[8], -m[9], -m[10]).normalize();
  VIEW.known = true;

  let lights = sceneLights.get(scene);
  if (!lights) {
    let sun: THREE.DirectionalLight | null = null;
    let hemi: THREE.HemisphereLight | null = null;
    for (const child of scene.children) {
      if (!sun && (child as THREE.DirectionalLight).isDirectionalLight) sun = child as THREE.DirectionalLight;
      if (!hemi && (child as THREE.HemisphereLight).isHemisphereLight) hemi = child as THREE.HemisphereLight;
    }
    lights = { sun, hemi };
    sceneLights.set(scene, lights);
  }
  if (lights.sun) {
    SHARED.uSunDir.value.subVectors(lights.sun.position, lights.sun.target.position).normalize();
    SHARED.uSunCol.value.copy(lights.sun.color).multiplyScalar(lights.sun.intensity);
  }
  if (lights.hemi) {
    // The scene also has a sky reflection map; this boost stands in for it.
    const boost = lights.hemi.intensity * 1.45;
    SHARED.uSkyCol.value.copy(lights.hemi.color).multiplyScalar(boost);
    SHARED.uGroundCol.value.copy(lights.hemi.groundColor).multiplyScalar(boost);
  }
  const fog = (scene as THREE.Scene).fog;
  if (fog && (fog as THREE.Fog).isFog) {
    SHARED.uFogCol.value.copy(fog.color);
    SHARED.uFogRange.value.set((fog as THREE.Fog).near, (fog as THREE.Fog).far);
  } else {
    SHARED.uFogRange.value.set(1e6, 1e6 + 1);
  }
  const target = renderer.getRenderTarget();
  if (target) SHARED.uViewport.value.set(target.width, target.height);
  else SHARED.uViewport.value.copy(renderer.getDrawingBufferSize(scratch2));

  let lit = 0;
  for (let i = 0; i < MAX_LIGHTS; i++) {
    const slot = effectLights[i];
    const col = SHARED.uLightCol.value[i];
    if (slot && slot.light.intensity > 0) {
      lit = 1;
      slot.light.getWorldPosition(SHARED.uLightPos.value[i]);
      col.copy(slot.light.color).multiplyScalar(slot.light.intensity);
      SHARED.uLightRange.value[i] = slot.light.distance || 30;
    } else {
      col.setRGB(0, 0, 0);
    }
  }
  SHARED.uLightsOn.value = lit;
}

// ----- Generated noise ------------------------------------------------------------

const GRADS = (() => {
  const table = new Float32Array(512);
  const r = rng(7331);
  for (let i = 0; i < 256; i++) {
    const a = (i / 256) * Math.PI * 2 + r() * 0.02;
    table[i * 2] = Math.cos(a);
    table[i * 2 + 1] = Math.sin(a);
  }
  return table;
})();

function hashCell(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 982451653) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h & 255) * 2;
}

/** Tiling gradient noise in about [-0.7, 0.7], periodic in px, py cells. */
function perlin(x: number, y: number, px: number, py: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const x0 = ((ix % px) + px) % px;
  const y0 = ((iy % py) + py) % py;
  const x1 = (x0 + 1) % px;
  const y1 = (y0 + 1) % py;
  const g00 = hashCell(x0, y0, seed);
  const g10 = hashCell(x1, y0, seed);
  const g01 = hashCell(x0, y1, seed);
  const g11 = hashCell(x1, y1, seed);
  const n00 = GRADS[g00] * fx + GRADS[g00 + 1] * fy;
  const n10 = GRADS[g10] * (fx - 1) + GRADS[g10 + 1] * fy;
  const n01 = GRADS[g01] * fx + GRADS[g01 + 1] * (fy - 1);
  const n11 = GRADS[g11] * (fx - 1) + GRADS[g11 + 1] * (fy - 1);
  const sx = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const sy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const a = n00 + (n10 - n00) * sx;
  const b = n01 + (n11 - n01) * sx;
  return a + (b - a) * sy;
}

type NoiseMode = "plain" | "billow" | "ridge";

function fbm(u: number, v: number, period: number, octaves: number, seed: number, mode: NoiseMode): number {
  let sum = 0;
  let amp = 0.5;
  let p = period;
  for (let i = 0; i < octaves; i++) {
    let n = perlin(u * p, v * p, p, p, seed + i * 31);
    if (mode === "billow") n = Math.abs(n);
    else if (mode === "ridge") n = (1 - Math.abs(n) * 1.4) ** 2;
    sum += n * amp;
    amp *= 0.5;
    p *= 2;
  }
  return sum;
}

let noiseTexture: THREE.DataTexture | null = null;

/**
 * 256x256 tiling noise, made here. R: soft fbm, G: billowy (cauliflower)
 * fbm for smoke, B: ridged fbm for flame tongues and veins, A: detail fbm.
 */
export function effectNoise(): THREE.DataTexture {
  if (noiseTexture) return noiseTexture;
  const size = 256;
  const channels: [number, number, number, NoiseMode][] = [
    [4, 5, 11, "plain"],
    [5, 5, 23, "billow"],
    [4, 5, 37, "ridge"],
    [8, 4, 53, "plain"],
  ];
  const values = channels.map(() => new Float32Array(size * size));
  channels.forEach(([period, octaves, seed, mode], c) => {
    const out = values[c];
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) out[y * size + x] = fbm(x / size, y / size, period, octaves, seed, mode);
    }
  });
  const data = new Uint8Array(size * size * 4);
  values.forEach((out, c) => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of out) {
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    const scale = 255 / Math.max(1e-6, hi - lo);
    for (let i = 0; i < out.length; i++) data[i * 4 + c] = Math.round((out[i] - lo) * scale);
  });
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  noiseTexture = texture;
  SHARED.uNoise.value = texture;
  return texture;
}

// ----- GLSL shared by the effect shaders ---------------------------------------------

export const GLSL_SCENE = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uSunCol;
uniform vec3 uSkyCol;
uniform vec3 uGroundCol;
uniform vec3 uFogCol;
uniform vec2 uFogRange;
uniform vec3 uLightPos[${MAX_LIGHTS}];
uniform vec3 uLightCol[${MAX_LIGHTS}];
uniform float uLightRange[${MAX_LIGHTS}];
uniform float uLightsOn;
const float PI = 3.14159265;
vec3 ambientLight(vec3 n){ return mix(uGroundCol, uSkyCol, clamp(n.y*0.5+0.5, 0.0, 1.0)); }
// Irradiance from the pooled effect lights (explosions, lightning) at p with normal n.
// wrap > 0 lets light reach round the back, for smoke and mist.
// (No early continue in this loop: ANGLE's D3D11 translation of it hangs some GPUs.)
vec3 effectLights(vec3 p, vec3 n, float wrap){
  vec3 sum = vec3(0.0);
  if (uLightsOn < 0.5) return sum;
  for (int i = 0; i < ${MAX_LIGHTS}; i++) {
    vec3 d = uLightPos[i] - p;
    float d2 = max(dot(d, d), 0.04);
    float range2 = uLightRange[i] * uLightRange[i];
    float x = d2 / range2;
    float cut = clamp(1.0 - x * x, 0.0, 1.0);
    float ndl = clamp((dot(n, d * inversesqrt(d2)) + wrap) / (1.0 + wrap), 0.0, 1.0);
    sum += uLightCol[i] * (ndl * cut * cut / d2);
  }
  return sum;
}
float fogAmount(float depth){ return clamp((depth - uFogRange.x) / (uFogRange.y - uFogRange.x), 0.0, 1.0); }
`;

// ----- Field: sorted single-draw particles -----------------------------------------------

/** What a particle looks like; each kind has its own branch of the field shader. */
export const KIND = {
  /** Soft emissive glow: rgb emission. */
  GLOW: 0,
  /** Flame: r temperature K, g brightness, b soot 0..1, a opacity; t age 0..1; param 0 tongues .. 1 billows. */
  FIRE: 1,
  /** Lit smoke, dust or mist: rgb albedo, a opacity; t age; param inner fire glow 0..1. */
  SMOKE: 2,
  /** Motion-blurred spark or ember: rgb emission; stretch vector = blur. */
  SPARK: 3,
  /** Glint with rays: rgb emission; param 0..1 extra diagonal rays. */
  STAR: 4,
  /** Flat ring on the plane given by the normal: rgb emission, a occlusion; param thickness. */
  RING: 5,
  /** Flat ground mark: param 0 scorch, 1 frost, 2 lightning scar, 3 contact shadow; rgb glow. */
  DECAL: 6,
  /** Screen-space lens flare part: param 0 ghost, 1 anamorphic streak, 2 ring ghost. */
  FLARE: 7,
  /** Small lit solid chunk (dirt clod, charred debris): rgb albedo. */
  CLOD: 8,
  /** Stretched lit vapour wisp: rgb albedo, a opacity; t age. */
  WISP: 9,
  /** Cold vapour: like SMOKE but soft, translucent and sky-tinted. rgb albedo, a opacity. */
  MIST: 10,
} as const;

export class Particle {
  x = 0;
  y = 0;
  z = 0;
  vx = 0;
  vy = 0;
  vz = 0;
  age = 0;
  life = 1;
  /** Diameter in metres (width, for stretched kinds). */
  size = 1;
  rot = 0;
  spin = 0;
  /** Velocity loss per second (exponential). */
  drag = 0;
  /** Downward acceleration, m/s2; negative rises. */
  gravity = 0;
  /** Bounce off the ground with this restitution; negative ignores the ground. */
  bounce = -1;
  kind: number = KIND.GLOW;
  seed = 0;
  r = 1;
  g = 1;
  b = 1;
  a = 0;
  t = 0;
  param = 0;
  /** Stretch vector in metres, or a flat kind's plane normal. */
  sx = 0;
  sy = 0;
  sz = 0;
  /** Position is relative to the field anchor, and moves with it. */
  local = false;
  /** Free slots for the owning effect. */
  u0 = 0;
  u1 = 0;
  u2 = 0;
  u3 = 0;
  /** Free slots for a start point or offset. */
  ox = 0;
  oy = 0;
  oz = 0;
  tag = 0;
  delay = 0;
}

const FIELD_VERTEX = /* glsl */ `
attribute vec2 corner;
attribute vec4 iPos;
attribute vec4 iVec;
attribute vec4 iCol;
attribute vec4 iMisc;
uniform vec2 uViewport;
varying vec2 vUv;
varying vec2 vQuad;
varying vec4 vCol;
varying vec4 vMisc;
varying vec3 vWorld;
varying float vAspect;
varying float vDepth;
varying float vSize;
void main(){
  vCol = iCol;
  vMisc = iMisc;
  vAspect = 1.0;
  float kind = iMisc.x;
  vec3 center = (modelMatrix * vec4(iPos.xyz, 1.0)).xyz;
  float size = iPos.w;
  vSize = size;
  vec3 camRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 camUp = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec3 camBack = vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]);
  vec3 world;
  if (kind > 6.5 && kind < 7.5) {
    // Lens flare part, placed in screen space on the line through the source and the centre.
    vec4 clip = projectionMatrix * viewMatrix * vec4(center, 1.0);
    if (clip.w <= 0.05) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
    vec2 ndc = clip.xy / clip.w;
    float aspect = uViewport.x / uViewport.y;
    vec2 at = ndc * iVec.x;
    vec2 extent = vec2(size * iVec.y / aspect, size);
    vCol.rgb *= 1.0 - smoothstep(0.9, 1.25, max(abs(ndc.x), abs(ndc.y)));
    vUv = corner;
    vQuad = corner;
    vWorld = center;
    vDepth = clip.w;
    gl_Position = vec4(at + corner * extent, -0.999, 1.0);
    return;
  }
  if (kind > 4.5 && kind < 6.5) {
    // Flat on the plane with normal iVec.xyz.
    vec3 n = normalize(iVec.xyz);
    vec3 t = normalize(cross(n, abs(n.y) < 0.95 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
    vec3 b = cross(n, t);
    float c = cos(iVec.w), s = sin(iVec.w);
    vec2 q = vec2(c*corner.x - s*corner.y, s*corner.x + c*corner.y);
    world = center + (t*q.x + b*q.y) * (size*0.5);
    vUv = corner;
    vQuad = corner;
  } else {
    // Billboards keep at least ~1.6 px of width; light is spread, not added.
    float dist = max(0.05, dot(center - cameraPosition, -camBack));
    float pixel = 2.0 * dist / (projectionMatrix[1][1] * uViewport.y);
    float width = size;
    float minW = pixel * 1.6;
    vec3 axis = iVec.xyz;
    float len = length(axis);
    bool stretched = len > width * 0.04 && len > pixel * 0.5;
    if (width < minW) {
      float k = width / minW;
      vCol.rgb *= stretched ? k : k*k;
      if (kind > 1.5 && kind < 2.5 || kind > 7.5) vCol.a *= stretched ? k : k*k;
      // (SMOKE, CLOD, WISP and MIST also fade their cover when shrunk to a pixel.)
      width = minW;
    }
    vSize = width;
    if (stretched) {
      vec3 dir = axis / len;
      vec3 toCam = normalize(cameraPosition - center);
      vec3 side = cross(dir, toCam);
      float sl = length(side);
      side = sl > 1e-3 ? side / sl : camRight;
      vec3 mid = center - axis * 0.5;
      float halfL = len * 0.5 + width * 0.5;
      world = mid + dir * (corner.y * halfL) + side * (corner.x * width * 0.5);
      vAspect = (len + width) / width;
      vUv = corner;
      vec3 o = side * corner.x + dir * corner.y;
      vQuad = vec2(dot(o, camRight), dot(o, camUp));
    } else {
      float c = cos(iVec.w), s = sin(iVec.w);
      vUv = vec2(c*corner.x - s*corner.y, s*corner.x + c*corner.y);
      vQuad = corner;
      world = center + (camRight * corner.x + camUp * corner.y) * (width * 0.5);
    }
  }
  vWorld = world;
  vec4 mv = viewMatrix * vec4(world, 1.0);
  vDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

const FIELD_FRAGMENT = /* glsl */ `
uniform sampler2D uNoise;
uniform float uGround;
${GLSL_SCENE}
${GLSL_BLACKBODY}
varying vec2 vUv;
varying vec2 vQuad;
varying vec4 vCol;
varying vec4 vMisc;
varying vec3 vWorld;
varying float vAspect;
varying float vDepth;
varying float vSize;

vec3 toWorld(vec3 v){ return transpose(mat3(viewMatrix)) * v; }

void main(){
  int kind = int(vMisc.x + 0.5);
  float t = vMisc.y;
  float seed = vMisc.z;
  float param = vMisc.w;
  // Distance from the axis of a stretched quad, in half-widths (a capsule), or radius.
  vec2 q = vec2(vUv.x, vUv.y * vAspect);
  float along = max(abs(q.y) - (vAspect - 1.0), 0.0);
  float r = vAspect > 1.001 ? length(vec2(q.x, along)) : length(vUv);
  vec3 rgb = vec3(0.0);
  float a = 0.0;
  float soft = 1.0;
  vec2 o = vec2(seed * 17.31, seed * 9.73);

  if (kind == 0) {
    // GLOW
    if (r > 1.0) discard;
    float g = exp(-r*r*7.0) * 0.8 + exp(-r*r*2.2) * 0.2;
    rgb = vCol.rgb * g * (1.0 - r*r);
    a = vCol.a * g;
    soft = smoothstep(0.0, 0.25 * vSize, vWorld.y - uGround) * 0.85 + 0.15;
  } else if (kind == 1) {
    // FIRE: noise-eroded flame, coloured per pixel by its temperature. It is
    // optically thick (a = coverage * opacity), so overlapping flames show
    // their billows instead of summing to a white blob, and it turns to soot
    // from the outside in as it cools. param: 0 licking tongues, 1 billows.
    if (r > 1.0) discard;
    vec2 p = vAspect > 1.001 ? vec2(q.x, q.y * 0.42) : vUv;
    float taper = vAspect > 1.001 ? mix(0.5, 1.0, smoothstep(-1.0, 0.7, vUv.y)) : 1.0;
    vec4 n0 = texture2D(uNoise, p * 0.21 + o + vec2(0.0, t * 0.32));
    vec2 w = n0.ra - 0.5;
    vec4 n1 = texture2D(uNoise, p * mix(0.47, 0.36, param) + w * 0.5 + o * 1.7 - vec2(t * 0.15, t * 0.8));
    float rr = vAspect > 1.001 ? length(vec2(q.x / taper, along)) : r;
    float detail = mix(n1.b, n1.g, param);
    float body = 1.0 - rr - (w.x + w.y) * mix(0.45, 0.3, param);
    float d = body * 1.45 + (detail - 0.5) * mix(1.05, 0.95, param) + (n1.r - 0.5) * 0.45;
    float erosion = t * 0.78;
    float f = smoothstep(erosion, erosion + mix(0.3, 0.22, param), d);
    if (f <= 0.002) discard;
    float core = smoothstep(erosion + 0.2, erosion + 0.95, d);
    float kelvin = vCol.r * mix(0.56, 1.0, core);
    vec3 e = heat(kelvin) * vCol.g;
    float soot = clamp(vCol.b * 1.5 * (1.0 - core), 0.0, 1.0);
    vec3 n = toWorld(normalize(vec3(vQuad * 0.9 + w * 0.8, 0.55)));
    vec3 sootLit = vec3(0.05, 0.043, 0.036) / PI * (uSunCol * clamp(dot(n, uSunDir) * 0.6 + 0.4, 0.0, 1.0) + ambientLight(n) + effectLights(vWorld, n, 0.5));
    a = f * clamp(vCol.a + soot * 0.6, 0.0, 1.0);
    rgb = (e * (1.0 - soot) + sootLit * soot) * f;
    soft = smoothstep(0.0, 0.3 * vSize, vWorld.y - uGround);
  } else if (kind == 2 || kind == 10) {
    // SMOKE: a billowy lit puff with a sphere-like normal. MIST (10) is the
    // same idea for cold vapour: softer, translucent, sky-tinted in shadow,
    // strongly forward-scattering, and happy to lie on the ground.
    if (r > 1.0) discard;
    bool mist = kind == 10;
    vec4 n0 = texture2D(uNoise, vUv * 0.27 + o + vec2(t * 0.06, -t * 0.09));
    vec4 n1 = texture2D(uNoise, vUv * 0.61 + (n0.ra - 0.5) * 0.42 + o * 2.3 + vec2(0.0, t * 0.12));
    float billow = n0.g * 0.55 + n1.g * 0.45;
    float d = (1.0 - r*r) * 1.3 + (billow - 0.5) * (mist ? 1.15 : 1.25) - t * 0.32;
    float dens = mist ? smoothstep(0.02, 1.05, d) : smoothstep(0.16, 0.66, d);
    if (dens <= 0.002) discard;
    vec3 nv = normalize(vec3(vQuad * 1.05 + (n1.rg - 0.5) * 1.5 + (n0.rg - 0.5) * 0.8, sqrt(max(0.04, 1.0 - r*r))));
    vec3 nw = toWorld(nv);
    float ndl = dot(nw, uSunDir);
    float sun = mist ? clamp(ndl * 0.55 + 0.45, 0.0, 1.0) * mix(1.0, 0.42, dens * dens) : clamp(ndl * 0.78 + 0.28, 0.0, 1.0) * mix(1.0, 0.55, dens);
    vec3 view = normalize(vWorld - cameraPosition);
    float forward = mist ? pow(max(dot(view, uSunDir), 0.0), 4.0) * (1.0 - dens) * 2.2 : pow(max(dot(view, uSunDir), 0.0), 8.0) * (1.0 - dens) * 1.4;
    vec3 sky = ambientLight(nw);
    if (mist) sky = mix(sky, uSkyCol * 1.3, 0.65) * mix(1.0, 0.8, dens);
    vec3 light = uSunCol * (sun + forward) + sky + effectLights(vWorld, nw, 0.6);
    vec3 col = vCol.rgb / PI * light;
    vec3 glow = heat(1250.0 + 350.0 * param) * (param * 0.55) * smoothstep(0.25, 1.0, dens);
    a = dens * vCol.a;
    rgb = (col + (mist ? vec3(0.0) : glow)) * a;
    soft = smoothstep(0.0, (mist ? 0.1 : 0.32) * vSize, vWorld.y - uGround);
  } else if (kind == 3) {
    // SPARK
    if (r > 1.0) discard;
    float g = exp(-r*r*3.2) * (1.0 - r) + exp(-r*r*16.0) * 0.8;
    rgb = vCol.rgb * g;
    a = vCol.a * smoothstep(1.0, 0.3, r);
  } else if (kind == 4) {
    // STAR glint
    if (r > 1.0) discard;
    vec2 p = vUv;
    float core = exp(-r*r*36.0);
    float rays = exp(-abs(p.x)*34.0) * exp(-p.y*p.y*2.4) + exp(-abs(p.y)*34.0) * exp(-p.x*p.x*2.4);
    vec2 p2 = vec2(p.x + p.y, p.x - p.y) * 0.7071;
    float rays2 = (exp(-abs(p2.x)*44.0) * exp(-p2.y*p2.y*7.0) + exp(-abs(p2.y)*44.0) * exp(-p2.x*p2.x*7.0)) * param;
    float halo = exp(-r*r*6.0) * 0.1;
    rgb = vCol.rgb * (core + rays * 0.5 + rays2 * 0.32 + halo) * (1.0 - smoothstep(0.8, 1.0, r));
  } else if (kind == 5) {
    // RING
    float rr = length(vUv);
    if (rr > 1.0) discard;
    float th = max(param, 0.015);
    float ring = exp(-pow((rr - (1.0 - th * 1.6)) / th, 2.0));
    vec4 n = texture2D(uNoise, vUv * 0.5 + o);
    float breakup = smoothstep(0.15, 0.7, n.g + 0.15) * (0.6 + 0.4 * n.b);
    rgb = vCol.rgb * ring * breakup;
    a = vCol.a * ring * breakup;
  } else if (kind == 6) {
    // DECAL on the ground
    float rr = length(vUv);
    if (rr > 1.0) discard;
    vec4 n0 = texture2D(uNoise, vUv * 0.42 + o);
    vec4 n1 = texture2D(uNoise, vUv * 1.25 + o * 1.9);
    int variant = int(param + 0.5);
    vec3 up = vec3(0.0, 1.0, 0.0);
    vec3 groundLight = uSunCol * max(uSunDir.y, 0.0) + ambientLight(up) + effectLights(vWorld, up, 0.0);
    if (variant == 3) {
      float d = 1.0 - rr;
      a = d * d * vCol.a;
    } else if (variant == 1) {
      float d = (1.0 - rr) * 1.5 + (n0.g - 0.5) * 1.1;
      float cover = smoothstep(0.12, 0.62, d);
      float crystal = smoothstep(0.5, 0.85, n1.b);
      vec3 albedo = mix(vec3(0.62, 0.74, 0.84), vec3(0.93, 0.96, 1.0), crystal);
      float glint = pow(n1.a, 14.0) * 16.0 * cover;
      a = cover * vCol.a;
      rgb = (albedo / PI * groundLight + vCol.rgb * glint) * a;
    } else {
      float d = (1.0 - rr) * 1.55 + (n0.r - 0.5) * 1.2;
      float blot = smoothstep(0.08, 0.75, d);
      float glowMask;
      if (variant == 2) {
        float ang = atan(vUv.y, vUv.x) * (3.0 / 6.2831853);
        vec2 polar = vec2(ang + n0.a * 0.25, log(rr + 0.03) * 0.55 + seed);
        float vein = texture2D(uNoise, polar).b;
        float vein2 = texture2D(uNoise, polar * vec2(2.0, 1.6) + 0.37).b;
        glowMask = (pow(vein, 7.0) * 1.6 + pow(vein2, 9.0)) * smoothstep(1.0, 0.25, rr);
        blot = max(blot * 0.85, glowMask * 0.6);
      } else {
        glowMask = smoothstep(0.62, 0.92, n1.b) * smoothstep(0.35, 0.95, d);
      }
      vec3 albedo = vec3(0.03, 0.024, 0.02);
      a = blot * vCol.a;
      rgb = albedo / PI * groundLight * a + vCol.rgb * glowMask;
    }
  } else if (kind == 7) {
    // FLARE (screen space)
    int shape = int(param + 0.5);
    float g;
    if (shape == 1) {
      g = exp(-vUv.y * vUv.y * 40.0) * pow(max(1.0 - abs(vUv.x), 0.0), 2.2);
    } else {
      float rr = length(vUv);
      if (rr > 1.0) discard;
      g = smoothstep(1.0, 0.82, rr) * (shape == 2 ? smoothstep(0.62, 0.92, rr) : 0.45 + 0.55 * smoothstep(0.3, 0.95, rr));
    }
    rgb = vCol.rgb * g;
    a = 0.0;
  } else if (kind == 8) {
    // CLOD: a small solid chunk.
    vec4 n = texture2D(uNoise, vUv * 0.33 + o);
    float edge = 0.8 + (n.r - 0.5) * 0.5;
    float aa = fwidth(r) * 1.2 + 0.01;
    float m = 1.0 - smoothstep(edge - aa, edge + aa, r);
    if (m <= 0.0) discard;
    vec3 nv = normalize(vec3(vQuad * 1.2 + (n.ga - 0.5) * 0.9, sqrt(max(0.05, 1.0 - r*r))));
    vec3 nw = toWorld(nv);
    vec3 light = uSunCol * max(dot(nw, uSunDir), 0.0) + ambientLight(nw) + effectLights(vWorld, nw, 0.0);
    a = m * vCol.a;
    rgb = vCol.rgb * (0.7 + 0.6 * n.b) / PI * light * a;
  } else {
    // WISP: a stretched streak of vapour or dust carried by the air.
    if (r > 1.0) discard;
    vec4 n = texture2D(uNoise, vec2(vUv.x * 0.12, q.y * 0.07) + o - vec2(0.0, t * 0.35));
    float across = exp(-vUv.x * vUv.x * 2.6);
    float m = across * smoothstep(0.25, 0.75, n.g * 0.7 + n.r * 0.5) * (1.0 - smoothstep(0.55, 1.0, abs(vUv.y)));
    vec3 light = uSunCol * 0.75 + ambientLight(vec3(0.0, 1.0, 0.0)) + effectLights(vWorld, vec3(0.0, 1.0, 0.0), 1.0);
    a = m * vCol.a;
    // Thin vapour scatters light more than it hides what is behind it.
    rgb = vCol.rgb / PI * light * a * 1.3;
    a *= 0.45;
    soft = smoothstep(0.0, 0.2, vWorld.y - uGround);
  }

  // Fade out what comes close to the lens, sooner for big puffs: the camera
  // can run through smoke or fog without the screen turning to a wall.
  float nearFade = kind == 7 ? 0.0 : clamp(vSize * 0.85, 1.1, 4.5);
  soft *= kind == 7 ? 1.0 : smoothstep(nearFade * 0.3, nearFade, vDepth);
  float fog = kind == 7 ? 0.0 : fogAmount(vDepth);
  rgb = rgb * (1.0 - fog) + uFogCol * (a * fog);
  gl_FragColor = vec4(rgb * soft, a * soft);
}
`;

let fieldMaterial: THREE.ShaderMaterial | null = null;

/** The one material every Field draws with. It lives as long as the page. */
export function sharedFieldMaterial(): THREE.ShaderMaterial {
  if (fieldMaterial) return fieldMaterial;
  effectNoise();
  fieldMaterial = new THREE.ShaderMaterial({
    name: "kinlings-vfx-field",
    uniforms: {
      ...sceneUniforms(),
      uNoise: SHARED.uNoise,
      uViewport: SHARED.uViewport,
      uGround: SHARED.uGround,
    },
    vertexShader: FIELD_VERTEX,
    fragmentShader: FIELD_FRAGMENT,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
  });
  return fieldMaterial;
}

const keyScratch = new THREE.Vector3();

/**
 * A pool of particles drawn in one instanced call. The owner spawns and
 * styles particles; step() moves them and write() sorts and uploads them.
 * The mesh draws in world space at `anchor`, whatever it is parented to.
 */
export class Field {
  readonly mesh: THREE.Mesh;
  readonly particles: Particle[] = [];
  readonly anchor = new THREE.Vector3();
  readonly capacity: number;
  private pool: Particle[] = [];
  private geometry: THREE.InstancedBufferGeometry;
  private attributes: THREE.InstancedBufferAttribute[];
  private keys: Float32Array;
  private order: number[] = [];

  constructor(capacity: number) {
    this.capacity = capacity;
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute("corner", new THREE.Float32BufferAttribute([-1, -1, 1, -1, 1, 1, -1, 1], 2));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    this.attributes = ["iPos", "iVec", "iCol", "iMisc"].map((name) => {
      const attribute = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
      attribute.setUsage(THREE.DynamicDrawUsage);
      geometry.setAttribute(name, attribute);
      return attribute;
    });
    geometry.instanceCount = 0;
    this.geometry = geometry;
    this.keys = new Float32Array(capacity);
    const mesh = new THREE.Mesh(geometry, sharedFieldMaterial());
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.matrixWorldAutoUpdate = false;
    mesh.onBeforeRender = (renderer, scene, camera) => observeFrame(renderer, scene, camera);
    this.mesh = mesh;
  }

  get count() {
    return this.particles.length;
  }

  /** A fresh particle, or null when the field is full. */
  spawn(kind: number): Particle | null {
    if (this.particles.length >= this.capacity) return null;
    const p = this.pool.pop() ?? new Particle();
    p.x = p.y = p.z = 0;
    p.vx = p.vy = p.vz = 0;
    p.age = 0;
    p.life = 1;
    p.size = 1;
    p.rot = rand() * Math.PI * 2;
    p.spin = 0;
    p.drag = 0;
    p.gravity = 0;
    p.bounce = -1;
    p.kind = kind;
    p.seed = rand();
    p.r = p.g = p.b = 1;
    p.a = 0;
    p.t = 0;
    p.param = 0;
    p.sx = p.sy = p.sz = 0;
    p.local = false;
    p.u0 = p.u1 = p.u2 = p.u3 = 0;
    p.ox = p.oy = p.oz = 0;
    p.tag = 0;
    p.delay = 0;
    this.particles.push(p);
    return p;
  }

  /** Moves every particle and drops the dead ones. */
  step(dt: number) {
    const ground = SHARED.uGround.value;
    const list = this.particles;
    let write = 0;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (p.delay > 0) {
        p.delay -= dt;
        list[write++] = p;
        continue;
      }
      p.age += dt;
      if (p.age >= p.life) {
        this.pool.push(p);
        continue;
      }
      if (p.drag > 0) {
        const k = Math.exp(-p.drag * dt);
        p.vx *= k;
        p.vy *= k;
        p.vz *= k;
      }
      p.vy -= p.gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      p.rot += p.spin * dt;
      if (p.bounce >= 0) {
        const floor = (p.local ? ground - this.anchor.y : ground) + p.size * 0.35;
        if (p.y < floor) {
          p.y = floor;
          if (p.vy < 0) p.vy = -p.vy * p.bounce;
          p.vx *= 0.55;
          p.vz *= 0.55;
          p.spin *= 0.5;
        }
      }
      list[write++] = p;
    }
    list.length = write;
  }

  /** Sorts far to near and uploads; call once per frame after styling. */
  write() {
    const list = this.particles;
    const n = list.length;
    const cam = VIEW.camera;
    const fwd = VIEW.forward;
    const ax = this.anchor.x;
    const ay = this.anchor.y;
    const az = this.anchor.z;
    const order = this.order;
    order.length = 0;
    for (let i = 0; i < n; i++) {
      const p = list[i];
      if (p.delay > 0) continue;
      const wx = p.local ? p.x + ax : p.x;
      const wy = p.local ? p.y + ay : p.y;
      const wz = p.local ? p.z + az : p.z;
      this.keys[i] = (wx - cam.x) * fwd.x + (wy - cam.y) * fwd.y + (wz - cam.z) * fwd.z;
      order.push(i);
    }
    const keys = this.keys;
    // Insertion sort: the order barely changes from one frame to the next.
    for (let i = 1; i < order.length; i++) {
      const v = order[i];
      const key = keys[v];
      let j = i - 1;
      while (j >= 0 && keys[order[j]] < key) {
        order[j + 1] = order[j];
        j--;
      }
      order[j + 1] = v;
    }
    const [pos, vec, col, misc] = this.attributes.map((attribute) => attribute.array as Float32Array);
    for (let k = 0; k < order.length; k++) {
      const p = list[order[k]];
      const o = k * 4;
      if (p.local) {
        pos[o] = p.x;
        pos[o + 1] = p.y;
        pos[o + 2] = p.z;
      } else {
        pos[o] = p.x - ax;
        pos[o + 1] = p.y - ay;
        pos[o + 2] = p.z - az;
      }
      pos[o + 3] = p.size;
      vec[o] = p.sx;
      vec[o + 1] = p.sy;
      vec[o + 2] = p.sz;
      vec[o + 3] = p.rot;
      col[o] = p.r;
      col[o + 1] = p.g;
      col[o + 2] = p.b;
      col[o + 3] = p.a;
      misc[o] = p.kind;
      misc[o + 1] = p.t;
      misc[o + 2] = p.seed;
      misc[o + 3] = p.param;
    }
    for (const attribute of this.attributes) {
      attribute.clearUpdateRanges();
      attribute.addUpdateRange(0, Math.max(1, order.length) * 4);
      attribute.needsUpdate = true;
    }
    this.geometry.instanceCount = order.length;
    this.mesh.visible = order.length > 0;
    this.mesh.matrixWorld.makeTranslation(ax, ay, az);
  }

  /** Points the anchor at an object's world position. */
  follow(object: THREE.Object3D) {
    object.getWorldPosition(this.anchor);
  }

  dispose() {
    this.geometry.dispose();
    this.particles.length = 0;
    this.pool.length = 0;
  }
}

/** Sets a particle's stretch to its velocity against the camera, as a camera shutter would. */
export function motionBlur(p: Particle, shutter: number, cameraWeight = 1) {
  const cv = VIEW.velocity;
  p.sx = (p.vx - cv.x * cameraWeight) * shutter;
  p.sy = (p.vy - cv.y * cameraWeight) * shutter;
  p.sz = (p.vz - cv.z * cameraWeight) * shutter;
}

/** World position of a particle (local ones are offset by the field anchor). */
export function worldOf(field: Field, p: Particle, out: THREE.Vector3 = keyScratch): THREE.Vector3 {
  return p.local ? out.set(p.x + field.anchor.x, p.y + field.anchor.y, p.z + field.anchor.z) : out.set(p.x, p.y, p.z);
}

/** Smooth 0..1..0 envelope: fades in over `rise` and out over the rest. */
export function envelope(x: number, rise: number, fall = 1 - rise): number {
  if (x < rise) return x / Math.max(1e-4, rise);
  const out = (1 - x) / Math.max(1e-4, fall);
  return Math.max(0, Math.min(1, out));
}

/** Cheap divergence-free-looking swirl, for smoke and embers. */
export function turbulence(p: Particle, time: number, strength: number, dt: number) {
  const s = p.seed * 40;
  p.vx += Math.sin(p.y * 1.7 + time * 1.3 + s) * strength * dt;
  p.vz += Math.cos(p.x * 1.9 - time * 1.1 + s * 1.3) * strength * dt;
  p.vy += Math.sin(p.z * 1.5 + time * 0.9 + s * 0.7) * strength * 0.5 * dt;
}
