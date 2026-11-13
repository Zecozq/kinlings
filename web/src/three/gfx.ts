// Shared helpers for every 3D piece of Kinlings: seeded randomness, noise,
// colour utilities, quality detection and the procedural detail textures.

import * as THREE from "three";

export const clamp = (x: number, a = 0, b = 1) => Math.max(a, Math.min(b, x));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const smooth = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
export const TAU = Math.PI * 2;

export function rng(seed: number) {
  let s = (seed >>> 0) ^ 0x9e3779b9;
  if (s === 0) s = 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

function hash2(x: number, y: number, seed = 0) {
  let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Tileable 2D value noise. `px`, `py` are the period in lattice cells. */
export function tileNoise(x: number, y: number, px: number, py: number, seed = 0) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const wrap = (v: number, p: number) => ((v % p) + p) % p;
  const a = hash2(wrap(ix, px), wrap(iy, py), seed);
  const b = hash2(wrap(ix + 1, px), wrap(iy, py), seed);
  const c = hash2(wrap(ix, px), wrap(iy + 1, py), seed);
  const d = hash2(wrap(ix + 1, px), wrap(iy + 1, py), seed);
  return lerp(lerp(a, b, sx), lerp(c, d, sx), sy);
}

export function tileFbm(x: number, y: number, px: number, py: number, octaves = 4, seed = 0) {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let fx = x;
  let fy = y;
  let qx = px;
  let qy = py;
  for (let i = 0; i < octaves; i++) {
    sum += tileNoise(fx, fy, qx, qy, seed + i) * amp;
    norm += amp;
    amp *= 0.5;
    fx *= 2;
    fy *= 2;
    qx *= 2;
    qy *= 2;
  }
  return sum / norm;
}

/** Non-tiling 2D value noise, useful for terrain. */
export function noise2(x: number, y: number, seed = 0) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy, seed);
  const b = hash2(ix + 1, iy, seed);
  const c = hash2(ix, iy + 1, seed);
  const d = hash2(ix + 1, iy + 1, seed);
  return lerp(lerp(a, b, sx), lerp(c, d, sx), sy);
}

export function fbm2(x: number, y: number, octaves = 4, seed = 0) {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let fx = x;
  let fy = y;
  for (let i = 0; i < octaves; i++) {
    sum += noise2(fx, fy, seed + i * 17) * amp;
    norm += amp;
    amp *= 0.5;
    fx *= 2;
    fy *= 2;
  }
  return sum / norm;
}

// ----- Tileable gradient and cellular noise -----------------------------------

const fade5 = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);

/** Tileable 2D gradient (Perlin) noise in about [-1, 1]. `px`, `py` are periods in cells. */
export function perlin2(x: number, y: number, px: number, py: number, seed = 0) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const x0 = ((ix % px) + px) % px;
  const y0 = ((iy % py) + py) % py;
  const x1 = (x0 + 1) % px;
  const y1 = (y0 + 1) % py;
  const a00 = hash2(x0, y0, seed) * TAU;
  const a10 = hash2(x1, y0, seed) * TAU;
  const a01 = hash2(x0, y1, seed) * TAU;
  const a11 = hash2(x1, y1, seed) * TAU;
  const n00 = Math.cos(a00) * fx + Math.sin(a00) * fy;
  const n10 = Math.cos(a10) * (fx - 1) + Math.sin(a10) * fy;
  const n01 = Math.cos(a01) * fx + Math.sin(a01) * (fy - 1);
  const n11 = Math.cos(a11) * (fx - 1) + Math.sin(a11) * (fy - 1);
  const ux = fade5(fx);
  const uy = fade5(fy);
  return lerp(lerp(n00, n10, ux), lerp(n01, n11, ux), uy) * 1.41;
}

/** Fractal Perlin noise remapped to roughly [0, 1], tileable over (px, py) base cells. */
export function perlinFbm(x: number, y: number, px: number, py: number, octaves = 4, seed = 0, gain = 0.5) {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    const f = 1 << i;
    sum += perlin2(x * f, y * f, px * f, py * f, seed + i * 31) * amp;
    norm += amp;
    amp *= gain;
  }
  return 0.5 + 0.5 * (sum / norm);
}

/** Tileable cellular noise: distance to the nearest feature point (F1), about 0..1. */
export function worley2(u: number, v: number, cells: number, seed = 0) {
  const x = u * cells;
  const y = v * cells;
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  let best = 9;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cx = ix + dx;
      const cy = iy + dy;
      const wx = ((cx % cells) + cells) % cells;
      const wy = ((cy % cells) + cells) % cells;
      const px = cx + hash2(wx, wy, seed);
      const py = cy + hash2(wx, wy, seed + 101);
      const d = (px - x) * (px - x) + (py - y) * (py - y);
      if (d < best) best = d;
    }
  }
  return Math.min(1, Math.sqrt(best));
}

/** A linear RGBA8 data texture that repeats, with mipmaps. */
export function dataTexture(data: Uint8Array, width: number, height: number, srgb = false, anisotropy = 4): THREE.DataTexture {
  const tex = new THREE.DataTexture(data as Uint8Array<ArrayBuffer>, width, height, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = anisotropy;
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** Packs four 0..1 fields into a texture, stretching each to the full byte range. */
function packChannels(size: number, fields: Float32Array[]): Uint8Array {
  const data = new Uint8Array(size * size * 4);
  fields.forEach((field, channel) => {
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < field.length; i++) {
      lo = Math.min(lo, field[i]);
      hi = Math.max(hi, field[i]);
    }
    const scale = hi > lo ? 255 / (hi - lo) : 0;
    for (let i = 0; i < field.length; i++) data[i * 4 + channel] = Math.round((field[i] - lo) * scale);
  });
  return data;
}

let cloudNoise: THREE.DataTexture | null = null;

/**
 * Shared 256² tileable noise. R: broad Perlin fbm, G: billowy inverted cells,
 * B: finer Perlin fbm, A: small inverted cells. Used by clouds, terrain
 * variation, water and smoke, so one texture serves the whole world.
 */
export function cloudNoiseTexture(): THREE.DataTexture {
  if (cloudNoise) return cloudNoise;
  const size = 256;
  const r = new Float32Array(size * size);
  const g = new Float32Array(size * size);
  const b = new Float32Array(size * size);
  const a = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      const i = y * size + x;
      r[i] = perlinFbm(u * 4, v * 4, 4, 4, 5, 3);
      g[i] = 1 - (worley2(u, v, 6, 5) * 0.62 + worley2(u, v, 13, 9) * 0.38);
      b[i] = perlinFbm(u * 8, v * 8, 8, 8, 4, 17);
      a[i] = 1 - worley2(u, v, 24, 23);
    }
  }
  cloudNoise = dataTexture(packChannels(size, [r, g, b, a]), size, size, false, 8);
  return cloudNoise;
}

/**
 * Height field to a tangent-space detail map: RG normal xy, B height (or the
 * normal's z when packZ, so three.js can use it as a normalMap), A extra mask.
 */
export function normalMapFromHeight(height: Float32Array, size: number, strength: number, mask?: Float32Array, anisotropy = 8, packZ = false): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  const at = (x: number, y: number) => height[((y + size) % size) * size + ((x + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      const nz = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      const i = (y * size + x) * 4;
      data[i] = Math.round((-dx * nz * 0.5 + 0.5) * 255);
      data[i + 1] = Math.round((-dy * nz * 0.5 + 0.5) * 255);
      data[i + 2] = Math.round((packZ ? nz * 0.5 + 0.5 : clamp(height[y * size + x])) * 255);
      data[i + 3] = Math.round(clamp(mask ? mask[y * size + x] : 1) * 255);
    }
  }
  return dataTexture(data, size, size, false, anisotropy);
}

/** Draws into a fresh canvas and wraps it as a repeating texture. */
export function canvasTex(width: number, height: number, draw: (ctx: CanvasRenderingContext2D, rand: () => number) => void, options: { srgb?: boolean; seed?: number; anisotropy?: number } = {}): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  draw(canvas.getContext("2d")!, rng(options.seed ?? 1));
  const texture = new THREE.CanvasTexture(canvas);
  if (options.srgb !== false) texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = options.anisotropy ?? 8;
  return texture;
}

export function linearColor(hex: string | number): THREE.Color {
  return new THREE.Color(hex as THREE.ColorRepresentation);
}

export function mixColor(a: THREE.Color, b: THREE.Color, t: number) {
  return a.clone().lerp(b, t);
}

export function lighten(c: THREE.Color, t: number) {
  return c.clone().lerp(new THREE.Color(1, 1, 1), t);
}

export function darken(c: THREE.Color, t: number) {
  return c.clone().multiplyScalar(1 - t);
}

// ----- Quality -------------------------------------------------------------

export type Quality = "low" | "medium" | "high";

export function isPhone(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  return /Android|iPhone|iPad|iPod|Mobile/i.test(ua) || (navigator.maxTouchPoints > 1 && Math.min(screen.width, screen.height) < 820);
}

/** A starting guess. The valley also watches its frame rate and steps down. */
/**
 * `?film=1`: hold the chosen quality steady and never trade resolution for
 * frame rate. For recording, where frames are captured one at a time and a
 * slow frame costs nothing.
 */
export function filmMode(): boolean {
  return typeof location !== "undefined" && new URLSearchParams(location.search).has("film");
}

export function detectQuality(gl?: WebGL2RenderingContext | null): Quality {
  if (typeof window !== "undefined") {
    const forced = new URLSearchParams(location.search).get("quality");
    if (forced === "low" || forced === "medium" || forced === "high") return forced;
  }
  if (isPhone()) return "low";
  const memory = (navigator as unknown as { deviceMemory?: number }).deviceMemory ?? 8;
  if (memory <= 2) return "low";
  if (gl) {
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    const name = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : "";
    if (/swiftshader|llvmpipe|software/i.test(name)) return "low";
    if (/intel.*(hd|uhd) graphics(?! 6[3-9]\d| 7\d\d)/i.test(name)) return "medium";
    // Integrated graphics (AMD APUs report a generic "Radeon(TM) Graphics", or
    // Vega/7x0M names; Intel Iris): no MSAA and lighter shadows to start with.
    if (/radeon(\(tm\))? graphics|vega \d+ graphics|radeon \d{3}m|iris/i.test(name) && !/\brx\b|arc a\d/i.test(name)) return "medium";
  }
  return "high";
}

// ----- Procedural textures -------------------------------------------------

function makeTexture(data: Uint8Array, size: number, srgb = false, anisotropy = 4): THREE.DataTexture {
  const tex = new THREE.DataTexture(data as Uint8Array<ArrayBuffer>, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = anisotropy;
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** Height field -> normal map with height in B and an extra mask in A. */
function heightToDetail(height: Float32Array, size: number, strength: number, mask?: Float32Array): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  const at = (x: number, y: number) => height[((y + size) % size) * size + ((x + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      const nz = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      const i = (y * size + x) * 4;
      data[i] = Math.round((-dx * nz * 0.5 + 0.5) * 255);
      data[i + 1] = Math.round((-dy * nz * 0.5 + 0.5) * 255);
      data[i + 2] = Math.round(clamp(height[y * size + x]) * 255);
      data[i + 3] = Math.round(clamp(mask ? mask[y * size + x] : 1) * 255);
    }
  }
  return makeTexture(data, size);
}

function strokeFurLine(
  height: Float32Array,
  size: number,
  x0: number,
  y0: number,
  length: number,
  angle: number,
  width: number,
  value: number,
) {
  const steps = Math.ceil(length * 1.5);
  const dirX = Math.cos(angle);
  const dirY = Math.sin(angle);
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const px = x0 + dirX * length * t;
    const py = y0 + dirY * length * t + Math.sin(t * 3.1) * 0.5;
    const w = width * (1 - t * 0.85);
    const r = Math.ceil(w * 1.4);
    const cx = Math.floor(px);
    const cy = Math.floor(py);
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const d2 = (dx + cx + 0.5 - px) ** 2 + (dy + cy + 0.5 - py) ** 2;
        const f = Math.exp(-d2 / (w * w + 0.3));
        if (f < 0.02) continue;
        const ix = ((cx + dx) % size + size) % size;
        const iy = ((cy + dy) % size + size) % size;
        const v = value * (0.35 + t * 0.65) * f;
        const i = iy * size + ix;
        if (v > height[i]) height[i] = v;
      }
    }
  }
}

export interface DetailMaps {
  fur: THREE.DataTexture;
  shag: THREE.DataTexture;
  hide: THREE.DataTexture;
  scale: THREE.DataTexture;
  feather: THREE.DataTexture;
}

let detailCache: DetailMaps | null = null;

/**
 * Tiling detail maps shared by every creature. RG = normal xy, B = height
 * (used to darken the crevices of the albedo), A = rim mask for scales and
 * feathers. All of them are generated here, nothing is downloaded.
 */
export function detailMaps(): DetailMaps {
  if (detailCache) return detailCache;

  const size = 256;
  const big = 512;
  const rand = rng(1234);

  // Fur: thousands of overlapping tapered hair strokes lying along +u.
  const fur = new Float32Array(size * size);
  for (let i = 0; i < 6000; i++) {
    const length = 10 + rand() * 20;
    strokeFurLine(fur, size, rand() * size, rand() * size, length, (rand() - 0.5) * 0.7, 0.55 + rand() * 0.7, 0.4 + rand() * 0.6);
  }

  // Shaggy fur: longer, thicker clumps.
  const shag = new Float32Array(size * size);
  for (let i = 0; i < 2600; i++) {
    const length = 24 + rand() * 42;
    strokeFurLine(shag, size, rand() * size, rand() * size, length, (rand() - 0.5) * 1.0, 0.9 + rand() * 1.3, 0.35 + rand() * 0.65);
  }

  // Hide: a fine, very short coat.
  const hide = new Float32Array(size * size);
  for (let i = 0; i < 9000; i++) {
    const length = 4 + rand() * 7;
    strokeFurLine(hide, size, rand() * size, rand() * size, length, (rand() - 0.5) * 0.5, 0.5 + rand() * 0.4, 0.35 + rand() * 0.6);
  }

  detailCache = {
    fur: heightToDetail(fur, size, 3.2),
    shag: heightToDetail(shag, size, 3.4),
    hide: heightToDetail(hide, size, 2.2),
    scale: scaleMap(big),
    feather: featherMap(big),
  };
  return detailCache;
}

/**
 * Overlapping shingles on a torus. The candidate centres nearest a pixel are
 * compared by how far along +u they sit (locally, so the tile wraps), and the
 * one further along lies on top. Free edges therefore point towards -u, which
 * becomes "towards the tail" once wrapped onto a creature facing +z.
 */
function shingleMap(
  size: number,
  columns: number,
  rows: number,
  radiusU: number,
  radiusV: number,
  heightAt: (dx: number, dy: number, d: number, tone: number) => number,
  rimAt: (dx: number, d: number) => number,
  strength: number,
): THREE.DataTexture {
  const height = new Float32Array(size * size);
  const rim = new Float32Array(size * size);
  const cw = size / columns;
  const rh = size / rows;
  const rand = rng(columns * 7 + rows);
  const tones = Array.from({ length: columns * rows }, () => rand());
  const wrap = (d: number) => ((d + size / 2) % size + size) % size - size / 2;
  const reachU = Math.ceil(radiusU / cw) + 1;
  const reachV = Math.ceil(radiusV / rh) + 1;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const rowHome = Math.floor(y / rh);
      const colHome = Math.floor(x / cw);
      let best = -1e9;
      let bestH = 0;
      let bestRim = 0;
      for (let r = rowHome - reachV; r <= rowHome + reachV; r++) {
        const offset = ((r % 2) + 2) % 2 ? 0.5 : 0;
        const cy = (r + 0.5) * rh;
        for (let c = colHome - reachU; c <= colHome + reachU; c++) {
          const cx = (c + offset + 0.5) * cw;
          const dx = wrap(x - cx);
          const dy = wrap(y - cy);
          const ex = dx / radiusU;
          const ey = dy / radiusV;
          const d = Math.sqrt(ex * ex + ey * ey);
          if (d > 1 || dx > radiusU * 0.25) continue;
          const priority = -dx;
          if (priority <= best) continue;
          best = priority;
          const wrappedColumn = ((c % columns) + columns) % columns;
          const wrappedRow = ((r % rows) + rows) % rows;
          const tone = tones[(wrappedRow * columns + wrappedColumn) % tones.length];
          bestH = heightAt(dx, dy, d, tone);
          bestRim = rimAt(dx, d);
        }
      }
      height[y * size + x] = best > -1e8 ? bestH : 0.08;
      rim[y * size + x] = best > -1e8 ? bestRim : 1;
    }
  }
  return heightToDetail(height, size, strength, rim);
}

function scaleMap(size: number): THREE.DataTexture {
  const columns = 12;
  const cw = size / columns;
  const rows = 20;
  return shingleMap(
    size,
    columns,
    rows,
    cw * 0.96,
    (size / rows) * 1.24,
    (dx, _dy, d, tone) => {
      const dome = 1 - d * d;
      const rise = clamp(0.5 + (-dx / (cw * 0.96)) * 0.5);
      return 0.15 + dome * 0.5 + rise * 0.28 + (tone - 0.5) * 0.08;
    },
    (dx, d) => (dx < 0 ? smooth(0.62, 0.97, d) : 0),
    2.2,
  );
}

function featherMap(size: number): THREE.DataTexture {
  const columns = 7;
  const cw = size / columns;
  const rows = 12;
  const radiusU = cw * 1.5;
  const radiusV = (size / rows) * 1.5;
  return shingleMap(
    size,
    columns,
    rows,
    radiusU,
    radiusV,
    (dx, dy, d, tone) => {
      const quill = Math.exp(-(dy * dy) / 2.8);
      const barbs = 0.5 + 0.5 * Math.sin(dx * 0.95 + Math.abs(dy) * 1.6 + tone * 6);
      const edge = 1 - d;
      return 0.18 + edge * 0.34 + barbs * 0.14 * smooth(0, 0.3, edge) + quill * 0.22 + (tone - 0.5) * 0.08;
    },
    (dx, d) => (dx < 0 ? smooth(0.42, 1, d) : 0.1),
    2.4,
  );
}

/** A soft round particle dot used all over the VFX. */
let dotCache: THREE.CanvasTexture | null = null;
export function softDot(): THREE.CanvasTexture {
  if (dotCache) return dotCache;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext("2d")!;
  const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  gradient.addColorStop(0, "rgba(255,255,255,1)");
  gradient.addColorStop(0.25, "rgba(255,255,255,.75)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 64, 64);
  dotCache = new THREE.CanvasTexture(canvas);
  return dotCache;
}

// ----- Small GLSL snippets --------------------------------------------------

export const GLSL_NOISE = /* glsl */ `
float hash21(vec2 p){ p = fract(p*vec2(123.34, 456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }
float hash31(vec3 p){ p = fract(p*vec3(0.1031,0.1030,0.0973)); p += dot(p, p.yxz+33.33); return fract((p.x+p.y)*p.z); }
vec3 hash33(vec3 p){ p = fract(p*vec3(0.1031,0.1030,0.0973)); p += dot(p, p.yxz+33.33); return fract((p.xxy+p.yxx)*p.zyx); }
float vnoise(vec3 p){
  vec3 i = floor(p), f = fract(p);
  f = f*f*(3.0-2.0*f);
  return mix(mix(mix(hash31(i), hash31(i+vec3(1,0,0)), f.x),
                 mix(hash31(i+vec3(0,1,0)), hash31(i+vec3(1,1,0)), f.x), f.y),
             mix(mix(hash31(i+vec3(0,0,1)), hash31(i+vec3(1,0,1)), f.x),
                 mix(hash31(i+vec3(0,1,1)), hash31(i+vec3(1,1,1)), f.x), f.y), f.z);
}
float vnoise2(vec2 p){
  vec2 i = floor(p), f = fract(p);
  f = f*f*(3.0-2.0*f);
  return mix(mix(hash21(i), hash21(i+vec2(1,0)), f.x), mix(hash21(i+vec2(0,1)), hash21(i+vec2(1,1)), f.x), f.y);
}
float fbm3(vec3 p){ float a=0.5, s=0.0; for(int i=0;i<3;i++){ s+=a*vnoise(p); p=p*2.03+vec3(1.7,3.1,2.3); a*=0.5; } return s; }
`;
