// The land the valley road runs through: terrain with hills and a rutted farm
// track, dense meadow grass and wildflowers, trees, a pond with reeds and lily
// pads, fences, and the far forests, snowy mountains and the smoking volcano.
// Lots are built once and placed along the road as the camera moves. The world
// materials here (rock, weathered wood, straw, packed dirt) are shared with the
// race course so both look like the same countryside.

import * as THREE from "three";
import { TAU, clamp, dataTexture, lerp, normalMapFromHeight, rng, smooth, tileFbm, perlinFbm, type Quality } from "./gfx.ts";
import { TreeField, createBushField, createFlowerPatch, createGrassPatch, type FlowerPlacement, type GrassPlacement, type TreePlacement, windTime } from "./flora.ts";
import { GLSL_SKY, patchSky, skyUniforms } from "./atmosphere.ts";
import { GeoBuilder, makeMatrix } from "./parts.ts";

export const WU = 0.02;
export const LOT_W = 1240 * WU;
export const ROAD_Z = 6.5;
export const POND = { x: 17.6, z: -6.4, rx: 4.4, rz: 2.5, level: -0.26 };

// ----- Height ----------------------------------------------------------------

/** Ground height at a world position; periodic along the road every lot. */
export function terrainHeight(x: number, z: number): number {
  const a = (((x % LOT_W) + LOT_W) % LOT_W) * (TAU / LOT_W);
  const backRise = smooth(-7, -34, z);
  const farRise = smooth(-30, -115, z);
  const hills = backRise * (1.15 + 0.62 * Math.sin(a + 1.1) + 0.3 * Math.sin(2 * a + 2.3) + 0.16 * Math.sin(3 * a + 0.4));
  const farHills = farRise * (1.6 + 1.1 * Math.sin(a + 2.2) + 0.55 * Math.sin(2 * a + 0.3));
  const front = -smooth(10, 28, z) * 2;
  const meadow = (0.05 * Math.sin(a * 2 + z * 0.5) + 0.04 * Math.sin(a * 5 + 1.7 + z * 0.9)) * smooth(9, 2, Math.abs(z - 0.5));
  // Keep the working part of the farm level.
  const flatten = 1 - smooth(4.5, 8.5, Math.abs(z - 1.5));
  let h = hills + farHills + front + meadow * (1 - flatten * 0.2);
  // The pond basin.
  const px = (x - POND.x) / POND.rx;
  const pz = (z - POND.z) / POND.rz;
  const d2 = pz * pz + wrapDist(px) * wrapDist(px);
  h -= (1 - smooth(0.55, 1.55, d2)) * 1.05;
  return h;
}

function wrapDist(v: number) {
  // Pond repeats every lot: wrap px around lot width in pond-radius units.
  const period = LOT_W / POND.rx;
  return ((v + period / 2) % period + period) % period - period / 2;
}

/** Normal from finite differences, so lots join up seamlessly. */
export function terrainNormal(x: number, z: number, out: THREE.Vector3) {
  const h = 0.25;
  const dx = terrainHeight(x + h, z) - terrainHeight(x - h, z);
  const dz = terrainHeight(x, z + h) - terrainHeight(x, z - h);
  return out.set(-dx, 2 * h, -dz).normalize();
}

// ----- Layout mask ------------------------------------------------------------

const MASK_W = 1024;
const MASK_H = 512;
const MASK_Z0 = -12;
const MASK_Z1 = 13;

function maskX(x: number) {
  return (x / LOT_W) * MASK_W;
}
function maskY(z: number) {
  return ((z - MASK_Z0) / (MASK_Z1 - MASK_Z0)) * MASK_H;
}

export interface MaskData {
  texture: THREE.CanvasTexture;
  data: Uint8ClampedArray;
}

let maskCache: MaskData | null = null;

/** Paints the farm layout: road (R), worked soil (G), occlusion and wear (B). Same for every lot. */
export function getMask(): MaskData {
  if (maskCache) return maskCache;
  const canvas = document.createElement("canvas");
  canvas.width = MASK_W;
  canvas.height = MASK_H;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, MASK_W, MASK_H);
  ctx.globalCompositeOperation = "lighter";
  const stroke = (points: [number, number][], width: number, color: string) => {
    ctx.strokeStyle = color;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.lineWidth = width * (MASK_H / (MASK_Z1 - MASK_Z0));
    ctx.beginPath();
    points.forEach(([x, z], i) => {
      const px = maskX(x);
      const pz = maskY(z);
      if (i === 0) ctx.moveTo(px, pz);
      else ctx.lineTo(px, pz);
    });
    ctx.stroke();
  };
  // The road runs off both edges so neighbouring lots join.
  const road: [number, number][] = [];
  for (let i = -2; i <= 42; i++) {
    const t = i / 40;
    road.push([t * LOT_W, ROAD_Z + Math.sin(t * TAU * 2) * 0.28]);
  }
  stroke(road, 3.5, "#f00");
  // Footpaths from the road to the cottage door and to the nest.
  stroke([[4.3, -1.2], [4.0, 1.6], [4.5, 4], [4.2, ROAD_Z - 1]], 1.1, "#f00");
  stroke([[22.4, 0.2], [22.2, 2.2], [22.8, 4.2], [22.5, ROAD_Z - 1]], 0.9, "#f00");
  // Worked soil around the plots, the nest, and the cottage yard.
  ctx.fillStyle = "#0a0";
  ctx.beginPath();
  ctx.roundRect(maskX(7.4), maskY(-3.1), maskX(21.8) - maskX(7.4), maskY(2.4) - maskY(-3.1), 60);
  ctx.fill();
  ctx.fillStyle = "#040";
  ctx.beginPath();
  ctx.roundRect(maskX(0.6), maskY(-6), maskX(8) - maskX(0.6), maskY(0.2) - maskY(-6), 40);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(maskX(22.4), maskY(-0.6), 90, 60, 0, 0, TAU);
  ctx.fill();
  // Occlusion: under the fence line, around the cottage walls and the nest.
  stroke(
    Array.from({ length: 21 }, (_, i) => [(i / 20) * LOT_W, ROAD_Z - 2.05] as [number, number]),
    0.55,
    "#000060",
  );
  ctx.fillStyle = "#000050";
  ctx.beginPath();
  ctx.roundRect(maskX(1.2), maskY(-5.6), maskX(7.6) - maskX(1.2), maskY(-0.6) - maskY(-5.6), 30);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(maskX(22.4), maskY(-0.6), 46, 30, 0, 0, TAU);
  ctx.fill();

  const image = ctx.getImageData(0, 0, MASK_W, MASK_H);
  // A cheap blur so edges feather naturally, plus noise to break them up.
  const blurred = boxBlur(image.data, MASK_W, MASK_H, 3);
  for (let y = 0; y < MASK_H; y++) {
    for (let x = 0; x < MASK_W; x++) {
      const i = (y * MASK_W + x) * 4;
      const n = tileFbm((x / MASK_W) * 8, (y / MASK_H) * 4, 8, 4, 4, 7) - 0.5;
      blurred[i] = clampByte(blurred[i] * (1 + n * 1.3) * 1.1 - 30 * (n + 0.2));
      blurred[i + 1] = clampByte(blurred[i + 1] * (1 + n * 1.2));
      blurred[i + 3] = 255;
    }
  }
  image.data.set(blurred);
  ctx.globalCompositeOperation = "source-over";
  ctx.putImageData(image, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.NoColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.flipY = false;
  texture.anisotropy = 8;
  maskCache = { texture, data: blurred };
  return maskCache;
}

function clampByte(v: number) {
  return Math.max(0, Math.min(255, v));
}

function boxBlur(src: Uint8ClampedArray, w: number, h: number, radius: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(src);
  const pass = (from: Uint8ClampedArray, horizontal: boolean) => {
    const to = new Uint8ClampedArray(from.length);
    const outer = horizontal ? h : w;
    const inner = horizontal ? w : h;
    for (let o = 0; o < outer; o++) {
      let sumR = 0;
      let sumG = 0;
      let sumB = 0;
      const read = (k: number) => {
        const x = horizontal ? ((k % inner) + inner) % inner : o;
        const y = horizontal ? o : Math.max(0, Math.min(h - 1, k));
        return (y * w + x) * 4;
      };
      for (let k = -radius; k <= radius; k++) {
        const j = read(k);
        sumR += from[j];
        sumG += from[j + 1];
        sumB += from[j + 2];
      }
      for (let k = 0; k < inner; k++) {
        const target = horizontal ? (o * w + k) * 4 : (k * w + o) * 4;
        to[target] = sumR / (2 * radius + 1);
        to[target + 1] = sumG / (2 * radius + 1);
        to[target + 2] = sumB / (2 * radius + 1);
        to[target + 3] = 255;
        const add = read(k + radius + 1);
        const sub = read(k - radius);
        sumR += from[add] - from[sub];
        sumG += from[add + 1] - from[sub + 1];
        sumB += from[add + 2] - from[sub + 2];
      }
    }
    return to;
  };
  let result = out;
  for (let i = 0; i < 3; i++) {
    result = pass(result, true) as Uint8ClampedArray<ArrayBuffer>;
    result = pass(result, false) as Uint8ClampedArray<ArrayBuffer>;
  }
  return result;
}

export function maskAt(data: Uint8ClampedArray, x: number, z: number, channel: 0 | 1): number {
  const u = ((x / LOT_W) % 1 + 1) % 1;
  const v = clamp((z - MASK_Z0) / (MASK_Z1 - MASK_Z0));
  const px = Math.floor(u * (MASK_W - 1));
  const py = Math.floor(v * (MASK_H - 1));
  return data[(py * MASK_W + px) * 4 + channel] / 255;
}

// ----- Ground textures ------------------------------------------------------------

export interface GroundTextures {
  grass: THREE.Texture;
  grassNormal: THREE.Texture;
  dirt: THREE.Texture;
  dirtNormal: THREE.Texture;
}

let groundCache: GroundTextures | null = null;

/** Close-up meadow turf and packed dirt with pebbles: albedo and detail normals, 1024². */
export function groundTextures(): GroundTextures {
  if (groundCache) return groundCache;
  const size = 1024;
  const paint = (draw: (color: CanvasRenderingContext2D, height: CanvasRenderingContext2D, rand: () => number) => void, seed: number) => {
    const c1 = document.createElement("canvas");
    const c2 = document.createElement("canvas");
    c1.width = c1.height = c2.width = c2.height = size;
    const color = c1.getContext("2d")!;
    const height = c2.getContext("2d")!;
    draw(color, height, rng(seed));
    const albedo = color.getImageData(0, 0, size, size).data;
    const hdata = height.getImageData(0, 0, size, size).data;
    const field = new Float32Array(size * size);
    for (let i = 0; i < field.length; i++) field[i] = hdata[i * 4] / 255;
    const normal = normalMapFromHeight(field, size, 5, undefined, 8, true);
    return { albedo: dataTexture(new Uint8Array(albedo.buffer.slice(0)), size, size, true, 8), normal };
  };
  // Strokes that wrap around the tile edges, so the texture repeats seamlessly.
  const wrapped = (ctx: CanvasRenderingContext2D, x: number, y: number, draw: (ox: number, oy: number) => void) => {
    for (const ox of [0, -size, size]) {
      for (const oy of [0, -size, size]) {
        if (x + ox < -40 || x + ox > size + 40 || y + oy < -40 || y + oy > size + 40) continue;
        draw(ox, oy);
      }
    }
    void ctx;
  };

  const grass = paint((color, height, rand) => {
    color.fillStyle = "#2f3b1c";
    color.fillRect(0, 0, size, size);
    height.fillStyle = "#202020";
    height.fillRect(0, 0, size, size);
    // Soil and old litter between the blades.
    for (let i = 0; i < 2600; i++) {
      const x = rand() * size;
      const y = rand() * size;
      const r = 2 + rand() * 6;
      color.fillStyle = rand() > 0.5 ? `rgba(70,56,34,${0.3 + rand() * 0.3})` : `rgba(96,92,52,${0.25 + rand() * 0.3})`;
      wrapped(color, x, y, (ox, oy) => {
        color.beginPath();
        color.ellipse(x + ox, y + oy, r * 1.6, r, rand() * 3, 0, TAU);
        color.fill();
      });
    }
    // A dense mat of blades seen from above, layered dark to light.
    const palette = [
      [52, 84, 30], [62, 98, 34], [74, 112, 38], [88, 124, 44], [104, 136, 52], [120, 146, 60], [138, 150, 70], [150, 140, 78], [112, 96, 54],
    ];
    for (let layer = 0; layer < 3; layer++) {
      const count = layer === 0 ? 14000 : layer === 1 ? 12000 : 7000;
      for (let i = 0; i < count; i++) {
        const x = rand() * size;
        const y = rand() * size;
        const len = 7 + rand() * 15;
        const a = rand() * TAU;
        const pick = Math.min(palette.length - 1, Math.floor(Math.pow(rand(), 1.2) * (palette.length - 2) + layer * 1.4 + (rand() < 0.04 ? 3 : 0)));
        const [r, g, b] = palette[pick];
        const shade = 0.82 + rand() * 0.3;
        const h = 60 + layer * 60 + rand() * 60;
        const w = 1.2 + rand() * 1.6;
        const bend = (rand() - 0.5) * 6;
        wrapped(color, x, y, (ox, oy) => {
          const x0 = x + ox;
          const y0 = y + oy;
          const x1 = x0 + Math.cos(a) * len;
          const y1 = y0 + Math.sin(a) * len;
          color.strokeStyle = `rgb(${r * shade},${g * shade},${b * shade})`;
          color.lineWidth = w;
          color.beginPath();
          color.moveTo(x0, y0);
          color.quadraticCurveTo((x0 + x1) / 2 + bend, (y0 + y1) / 2 - bend, x1, y1);
          color.stroke();
          height.strokeStyle = `rgb(${h},${h},${h})`;
          height.lineWidth = w;
          height.beginPath();
          height.moveTo(x0, y0);
          height.quadraticCurveTo((x0 + x1) / 2 + bend, (y0 + y1) / 2 - bend, x1, y1);
          height.stroke();
        });
      }
    }
    // Clover leaves here and there.
    for (let i = 0; i < 260; i++) {
      const x = rand() * size;
      const y = rand() * size;
      const s = 3 + rand() * 3;
      wrapped(color, x, y, (ox, oy) => {
        for (let k = 0; k < 3; k++) {
          const a = (k / 3) * TAU + rand();
          color.fillStyle = `rgb(${50 + rand() * 20},${96 + rand() * 24},${40 + rand() * 14})`;
          color.beginPath();
          color.ellipse(x + ox + Math.cos(a) * s, y + oy + Math.sin(a) * s, s, s * 0.8, a, 0, TAU);
          color.fill();
          height.fillStyle = "rgb(210,210,210)";
          height.beginPath();
          height.ellipse(x + ox + Math.cos(a) * s, y + oy + Math.sin(a) * s, s, s * 0.8, a, 0, TAU);
          height.fill();
        }
      });
    }
  }, 33);

  const dirt = paint((color, height, rand) => {
    color.fillStyle = "#8c7152";
    color.fillRect(0, 0, size, size);
    height.fillStyle = "#6a6a6a";
    height.fillRect(0, 0, size, size);
    // Fine grain and dusty patches.
    for (let i = 0; i < 26000; i++) {
      const x = rand() * size;
      const y = rand() * size;
      const r = 0.6 + rand() * 2.2;
      const light = rand();
      color.fillStyle = light > 0.55 ? `rgba(${170 + rand() * 40},${148 + rand() * 30},${112 + rand() * 30},${0.25 + rand() * 0.35})` : `rgba(${70 + rand() * 30},${52 + rand() * 20},${34 + rand() * 16},${0.25 + rand() * 0.35})`;
      color.fillRect(x, y, r, r);
      const h = light > 0.55 ? 140 : 80;
      height.fillStyle = `rgba(${h},${h},${h},0.5)`;
      height.fillRect(x, y, r, r);
    }
    for (let i = 0; i < 900; i++) {
      const x = rand() * size;
      const y = rand() * size;
      const r = 8 + rand() * 30;
      color.fillStyle = rand() > 0.5 ? `rgba(190,164,124,${0.06 + rand() * 0.1})` : `rgba(80,60,40,${0.06 + rand() * 0.1})`;
      wrapped(color, x, y, (ox, oy) => {
        color.beginPath();
        color.ellipse(x + ox, y + oy, r * 1.5, r, rand() * 3, 0, TAU);
        color.fill();
      });
    }
    // Hairline cracks in the packed surface.
    for (let i = 0; i < 70; i++) {
      let x = rand() * size;
      let y = rand() * size;
      let a = rand() * TAU;
      color.strokeStyle = "rgba(52,38,26,0.55)";
      height.strokeStyle = "rgb(20,20,20)";
      color.lineWidth = height.lineWidth = 1 + rand();
      color.beginPath();
      height.beginPath();
      color.moveTo(x, y);
      height.moveTo(x, y);
      for (let k = 0; k < 8; k++) {
        a += (rand() - 0.5) * 1.2;
        x += Math.cos(a) * 9;
        y += Math.sin(a) * 9;
        color.lineTo(x, y);
        height.lineTo(x, y);
      }
      color.stroke();
      height.stroke();
    }
    // Pebbles and small stones, shaded as little domes.
    for (let i = 0; i < 1700; i++) {
      const x = rand() * size;
      const y = rand() * size;
      const big = rand() < 0.08;
      const r = big ? 6 + rand() * 9 : 1.6 + rand() * 3.6;
      const a = rand() * 3;
      const tone = rand();
      const base = tone < 0.4 ? [150, 140, 128] : tone < 0.75 ? [128, 104, 80] : [176, 150, 110];
      const k = 0.75 + rand() * 0.4;
      wrapped(color, x, y, (ox, oy) => {
        const g = color.createRadialGradient(x + ox - r * 0.3, y + oy - r * 0.3, r * 0.1, x + ox, y + oy, r * 1.2);
        g.addColorStop(0, `rgb(${base[0] * k * 1.15},${base[1] * k * 1.15},${base[2] * k * 1.15})`);
        g.addColorStop(1, `rgb(${base[0] * k * 0.6},${base[1] * k * 0.6},${base[2] * k * 0.6})`);
        color.fillStyle = "rgba(40,30,20,0.5)";
        color.beginPath();
        color.ellipse(x + ox + r * 0.25, y + oy + r * 0.3, r * 1.25, r * 0.95, a, 0, TAU);
        color.fill();
        color.fillStyle = g;
        color.beginPath();
        color.ellipse(x + ox, y + oy, r * 1.2, r * 0.9, a, 0, TAU);
        color.fill();
        const hg = height.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, r * 1.2);
        hg.addColorStop(0, "rgb(255,255,255)");
        hg.addColorStop(1, "rgb(120,120,120)");
        height.fillStyle = hg;
        height.beginPath();
        height.ellipse(x + ox, y + oy, r * 1.2, r * 0.9, a, 0, TAU);
        height.fill();
      });
    }
  }, 21);

  groundCache = { grass: grass.albedo, grassNormal: grass.normal, dirt: dirt.albedo, dirtNormal: dirt.normal };
  return groundCache;
}

// ----- Ground shading (shared by the valley and the race) ---------------------------

/** World-space ground layers: meadow, packed dirt with ruts and puddles, tilled soil, pond mud. */
const GROUND_FRAGMENT_PARS = /* glsl */ `
  varying vec3 vGroundW;
  uniform sampler2D uGrassMap, uGrassNor, uDirtMap, uDirtNor, uMask, uBendTex;
  uniform vec4 uGround;   // x: lot width (valley) / 0, y,z: mask z range, w: 1 valley, 0 race field
  uniform vec4 uTrack;    // x: z0, y: z length, z: track half width, w: 1 if a course is present
  vec2 rot(vec2 p, float a){ float c = cos(a), s = sin(a); return vec2(c * p.x - s * p.y, s * p.x + c * p.y); }
  vec3 groundNormalSample(sampler2D tex, vec2 uv){ vec2 n = texture2D(tex, uv).xy * 2.0 - 1.0; return vec3(n.x, 1.0, n.y); }
`;

const GROUND_FRAGMENT = /* glsl */ `
  vec2 wp = vGroundW.xz;
  vec4 macro = texture2D(uCloudTex, wp * 0.0113 + 0.21);
  vec4 meso = texture2D(uCloudTex, wp * 0.047 + 0.63);
  // Meadow turf: two rotated scales blended by noise hide the tiling.
  vec2 g1 = wp / 2.4;
  vec2 g2 = rot(wp, 0.9) / 3.3 + 0.37;
  float gmix = smoothstep(0.35, 0.65, meso.r);
  vec3 grass = mix(texture2D(uGrassMap, g1).rgb, texture2D(uGrassMap, g2).rgb, gmix);
  vec3 grassN = groundNormalSample(uGrassNor, g1);
  grass *= mix(vec3(0.6, 0.7, 0.58), vec3(1.0, 0.98, 0.84), macro.r) * mix(0.88, 1.06, meso.b);
  float dryness = smoothstep(0.56, 0.78, macro.b * 0.7 + meso.g * 0.45);
  grass = mix(grass, grass * vec3(1.45, 1.2, 0.68) + vec3(0.025, 0.018, 0.0), dryness * 0.75);
  float lush = smoothstep(0.62, 0.8, meso.a * 0.5 + macro.g * 0.6);
  grass = mix(grass, grass * vec3(0.78, 0.95, 0.72), lush * 0.5);

  vec2 d1 = wp / 2.1;
  float path = 0.0;
  float worked = 0.0;
  float occl = 0.0;
  float rutDepth = 0.0;
  float rutSlope = 0.0;
  float centreStrip = 0.0;
  float wetMud = 0.0;
  if (uGround.w > 0.5) {
    vec2 maskUv = vec2(fract(vGroundW.x / uGround.x), clamp((vGroundW.z - uGround.y) / (uGround.z - uGround.y), 0.0, 1.0));
    vec4 m = texture2D(uMask, maskUv);
    path = smoothstep(0.1, 0.62, m.r);
    worked = smoothstep(0.2, 0.75, m.g);
    occl = m.b;
    // Cart ruts along the road with a strip of grass down the middle.
    float roadZ = ${ROAD_Z.toFixed(2)} + sin(fract(vGroundW.x / uGround.x) * 12.566371) * 0.28;
    float dz = vGroundW.z - roadZ;
    float onRoad = 1.0 - smoothstep(1.4, 1.9, abs(dz));
    float r = (abs(dz) - 0.78) / 0.24;
    rutDepth = exp(-r * r) * onRoad;
    rutSlope = -2.0 * r / 0.24 * exp(-r * r) * sign(dz) * onRoad * 0.08;
    centreStrip = (1.0 - smoothstep(0.18, 0.42, abs(dz))) * onRoad * smoothstep(0.3, 0.6, meso.g + 0.2);
    // Pond mud.
    wetMud = smoothstep(0.25, -0.35, vGroundW.y) * (1.0 - smoothstep(-2.5, -1.0, vGroundW.z)) * smoothstep(-13.0, -9.0, vGroundW.z);
  } else if (uTrack.w > 0.5) {
    float bend = texture2D(uBendTex, vec2(clamp((vGroundW.z - uTrack.x) / uTrack.y, 0.0, 1.0), 0.5)).r;
    float side = abs(vGroundW.x - bend);
    // Trampled verge beside the course, then far fields in patchwork.
    float verge = 1.0 - smoothstep(uTrack.z + 0.4, uTrack.z + 3.0 + meso.r * 1.5, side);
    path = verge * 0.55 * smoothstep(0.3, 0.7, meso.b + 0.25);
    float far = smoothstep(55.0, 120.0, side);
    float cell = texture2D(uCloudTex, wp * 0.0021 + 0.13).g;
    vec3 crop = cell > 0.72 ? vec3(0.42, 0.33, 0.13) : cell > 0.58 ? vec3(0.16, 0.22, 0.06) : cell > 0.45 ? vec3(0.3, 0.22, 0.12) : vec3(0.1, 0.17, 0.05);
    grass = mix(grass, crop * mix(0.85, 1.1, meso.r), far * 0.75);
  }
  // Packed dirt, only fetched where there is road, soil or a trampled verge.
  vec3 dirt = vec3(0.3, 0.24, 0.17);
  vec3 dirtN = vec3(0.0, 1.0, 0.0);
  vec2 d1x = dFdx(d1);
  vec2 d1y = dFdy(d1);
  if (path + worked + wetMud > 0.002) {
    dirt = textureGrad(uDirtMap, d1, d1x, d1y).rgb * mix(vec3(0.9, 0.88, 0.86), vec3(1.08, 1.04, 0.98), meso.b);
    vec2 dn = textureGrad(uDirtNor, d1, d1x, d1y).xy * 2.0 - 1.0;
    dirtN = vec3(dn.x, 1.0, dn.y);
  }
  vec3 soil = dirt * vec3(0.5, 0.4, 0.31);
  vec3 surface = mix(grass, soil, worked);
  vec3 roadCol = mix(dirt, dirt * vec3(0.78, 0.74, 0.7), rutDepth * 0.8);
  roadCol = mix(roadCol, grass * 0.9, centreStrip * 0.75);
  surface = mix(surface, roadCol, path);
  // Puddles in the ruts after rain: dark, mirror-smooth water.
  float puddle = smoothstep(0.66, 0.72, meso.g * 0.6 + macro.a * 0.5) * rutDepth * path;
  surface = mix(surface, vec3(0.08, 0.07, 0.06), puddle * 0.8);
  surface = mix(surface, vec3(0.2, 0.15, 0.1), wetMud * 0.75);
  surface *= 1.0 - occl * 0.45;
  // Far slopes fade toward a paler, sun-bleached green.
  surface = mix(surface, surface * vec3(0.86, 0.9, 0.82) + vec3(0.02, 0.025, 0.01), smoothstep(-18.0, -80.0, vGroundW.z) * 0.6 * uGround.w);
  diffuseColor.rgb = surface;
  float groundRough = mix(mix(0.97, 0.92, path), 0.9, worked);
  groundRough = mix(groundRough, 0.38, wetMud * 0.8);
  groundRough = mix(groundRough, 0.06, puddle);
  vec3 groundDetail = mix(grassN, dirtN, max(path, worked));
  groundDetail.xz *= (1.0 - puddle);
  groundDetail.z += rutSlope * path;
`;

/** Replaces the normal with the world-space detail normal of the ground layers. */
const GROUND_NORMAL = /* glsl */ `
  {
    vec3 nW = inverseTransformDirection( normal, viewMatrix );
    vec3 tX = normalize( cross( nW, vec3( 0.0, 0.0, 1.0 ) ) );
    vec3 tZ = cross( tX, nW );
    vec3 detail = normalize( groundDetail );
    vec3 perturbed = normalize( tX * detail.x * 0.8 + nW * detail.y + tZ * detail.z * 0.8 );
    normal = normalize( ( viewMatrix * vec4( perturbed, 0.0 ) ).xyz );
  }
`;

interface GroundOptions {
  mask?: THREE.Texture;
  /** For the race: the course's centre line baked into a texture, its z range and half width. */
  bend?: { texture: THREE.Texture; z0: number; length: number; halfWidth: number };
}

/** The ground of the valley (with its farm layout) or of the race fields. */
export function makeGroundMaterial(options: GroundOptions = {}): THREE.MeshStandardMaterial {
  const textures = groundTextures();
  const material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, metalness: 0 });
  const valley = Boolean(options.mask);
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uGrassMap = { value: textures.grass };
    shader.uniforms.uGrassNor = { value: textures.grassNormal };
    shader.uniforms.uDirtMap = { value: textures.dirt };
    shader.uniforms.uDirtNor = { value: textures.dirtNormal };
    shader.uniforms.uMask = { value: options.mask ?? textures.dirt };
    shader.uniforms.uBendTex = { value: options.bend?.texture ?? textures.dirt };
    shader.uniforms.uGround = { value: new THREE.Vector4(LOT_W, MASK_Z0, MASK_Z1, valley ? 1 : 0) };
    shader.uniforms.uTrack = { value: options.bend ? new THREE.Vector4(options.bend.z0, options.bend.length, options.bend.halfWidth, 1) : new THREE.Vector4() };
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vGroundW;")
      .replace("#include <worldpos_vertex>", "#include <worldpos_vertex>\nvGroundW = (modelMatrix * vec4(transformed, 1.0)).xyz;");
    patchSky(shader);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${GROUND_FRAGMENT_PARS}`)
      .replace("#include <map_fragment>", GROUND_FRAGMENT)
      .replace("#include <roughnessmap_fragment>", "float roughnessFactor = groundRough;")
      .replace("#include <normal_fragment_maps>", GROUND_NORMAL);
  };
  material.customProgramCacheKey = () => "ground-v2";
  return material;
}

function terrainGeometry(): THREE.BufferGeometry {
  const columns = 80;
  // Rows from far hills to the foreground, denser near the farm.
  const zRows: number[] = [];
  let z = -122;
  while (z < 30) {
    zRows.push(z);
    const distanceFromFarm = Math.abs(z - 1);
    z += lerp(0.45, 5, smooth(4, 40, distanceFromFarm));
  }
  zRows.push(30);
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const n = new THREE.Vector3();
  for (let row = 0; row < zRows.length; row++) {
    for (let col = 0; col <= columns; col++) {
      const x = (col / columns) * LOT_W;
      const zr = zRows[row];
      const h = terrainHeight(x, zr);
      terrainNormal(x, zr, n);
      positions.push(x, h, zr);
      normals.push(n.x, n.y, n.z);
      uvs.push(x / 3.2, zr / 3.2);
    }
  }
  for (let row = 0; row < zRows.length - 1; row++) {
    for (let col = 0; col < columns; col++) {
      const a = row * (columns + 1) + col;
      const b = a + columns + 1;
      indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  return geometry;
}

// ----- Shared world materials --------------------------------------------------------

/** Procedural bump: perturbs a view-space normal by a height computed in the shader. */
const GLSL_BUMP = /* glsl */ `
  vec3 bumpNormal(vec3 surfPos, vec3 surfNorm, float h, float scale){
    vec3 sx = dFdx(surfPos);
    vec3 sy = dFdy(surfPos);
    vec3 r1 = cross(sy, surfNorm);
    vec3 r2 = cross(surfNorm, sx);
    float det = dot(sx, r1);
    float bs = dFdx(h) * scale;
    float bt = dFdy(h) * scale;
    vec3 grad = sign(det) * (bs * r1 + bt * r2);
    return normalize(abs(det) * surfNorm - grad);
  }
`;

export type DetailKind = "rock" | "wood" | "weathered" | "straw" | "planks" | "endgrain" | "plaster" | "stone" | "brick";

const worldMats = new Map<DetailKind, THREE.MeshStandardMaterial>();
const KIND_ORDER: DetailKind[] = ["rock", "wood", "weathered", "planks", "straw", "endgrain", "plaster", "stone", "brick"];

/**
 * Real-looking surfaces made in the shader, so any shape can use them: granite
 * with moss and lichen, oak, silvered fence wood, planks, straw, sawn end
 * grain, lime plaster, fieldstone and brick. Every kind shares one program
 * (picked by a uniform), which keeps start-up compiles down. Vertex colours
 * give each piece its own tone.
 */
export function worldMaterial(kind: DetailKind): THREE.MeshStandardMaterial {
  const cached = worldMats.get(kind);
  if (cached) return cached;
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: kind === "rock" ? 0.82 : 0.9, metalness: 0 });
  const code: Record<DetailKind, string> = {
    rock: /* glsl */ `
      // Granite: grey grains with dark mica and pale feldspar, crusts of lichen, moss on top.
      vec4 nA = triTex(vDetailW * 0.55);
      vec4 nB = triTex(vDetailW * 3.1 + 7.0);
      vec4 nC = triTex(vDetailW * 11.0 + 3.0);
      float grain = nC.a;
      vec3 stone = diffuseColor.rgb * (0.78 + nA.r * 0.45);
      stone = mix(stone, stone * 0.35, smoothstep(0.78, 0.92, grain));
      stone = mix(stone, stone * 1.35 + vec3(0.05, 0.035, 0.03), smoothstep(0.35, 0.18, nC.g) * 0.6);
      stone *= 0.9 + 0.2 * nB.b;
      float up = detailN.y;
      float mossAmount = smoothstep(0.25, 0.75, up + (nA.g - 0.5) * 0.9 + (nB.r - 0.5) * 0.35);
      vec3 moss = mix(vec3(0.06, 0.1, 0.02), vec3(0.16, 0.22, 0.05), nC.r) * (0.75 + nB.g * 0.5);
      float lichen = smoothstep(0.7, 0.74, nB.a) * (1.0 - mossAmount);
      vec3 lichenCol = mix(vec3(0.42, 0.45, 0.3), vec3(0.6, 0.42, 0.14), step(0.5, nA.b));
      diffuseColor.rgb = mix(mix(stone, lichenCol, lichen * 0.8), moss, mossAmount);
      detailRough = mix(mix(0.78, 0.92, lichen), 1.0, mossAmount);
      detailHeight = nB.r * 0.6 + nC.r * 0.25 + mossAmount * nC.g * 0.5 - smoothstep(0.86, 0.95, grain) * 0.2;
      detailBump = 0.05;
    `,
    wood: /* glsl */ `
      // Oak: dark grain along the piece, growth rings, a few knots and splits.
      vec2 gUv = vec2(vDetailUv.x * 0.18, vDetailUv.y * 2.4);
      float grain = texture2D(uCloudTex, gUv).b;
      float fine = texture2D(uCloudTex, gUv * vec2(1.0, 4.0) + 0.3).r;
      float split = smoothstep(0.03, 0.0, abs(texture2D(uCloudTex, vec2(vDetailUv.x * 0.07, vDetailUv.y * 0.9) + 0.5).r - 0.5));
      float knot = smoothstep(0.86, 0.95, texture2D(uCloudTex, vDetailUv * 0.31 + 0.7).a);
      vec3 wood = diffuseColor.rgb * (0.72 + grain * 0.45) * (0.92 + fine * 0.16);
      wood = mix(wood, wood * 0.45, knot);
      wood = mix(wood, wood * 0.35, split * 0.85);
      diffuseColor.rgb = wood;
      detailRough = 0.78 + grain * 0.12;
      detailHeight = grain * 0.4 + fine * 0.3 - split * 0.6 - knot * 0.2;
      detailBump = 0.025;
    `,
    weathered: /* glsl */ `
      // Old fence wood: silvered by sun and rain, raised grain, lichen and damp near the ground.
      vec2 gUv = vec2(vDetailUv.x * 0.2, vDetailUv.y * 2.8);
      float grain = texture2D(uCloudTex, gUv).b;
      float fine = texture2D(uCloudTex, gUv * vec2(1.3, 5.0) + 0.2).r;
      float split = smoothstep(0.035, 0.0, abs(texture2D(uCloudTex, vec2(vDetailUv.x * 0.06, vDetailUv.y * 1.1) + 0.4).r - 0.5));
      vec3 silver = mix(vec3(0.34, 0.31, 0.27), vec3(0.5, 0.48, 0.44), grain);
      vec3 wood = mix(diffuseColor.rgb * (0.75 + grain * 0.4), silver, 0.55) * (0.9 + fine * 0.2);
      float damp = smoothstep(0.55, 0.0, vDetailW.y - groundAt);
      wood = mix(wood, wood * vec3(0.55, 0.6, 0.45), damp * 0.7);
      float lichen = smoothstep(0.72, 0.78, texture2D(uCloudTex, vDetailUv * 0.45 + 0.1).a) * smoothstep(0.1, 0.6, detailN.y + 0.5);
      wood = mix(wood, vec3(0.45, 0.48, 0.32), lichen * 0.7);
      wood = mix(wood, wood * 0.3, split);
      diffuseColor.rgb = wood;
      detailRough = 0.92;
      detailHeight = grain * 0.5 + fine * 0.4 - split * 0.8;
      detailBump = 0.03;
    `,
    planks: /* glsl */ `
      // Sawn planks: boards across the piece with dark gaps, grain and nail heads.
      float board = floor(vDetailUv.y * 4.0);
      float within = fract(vDetailUv.y * 4.0);
      float gap = smoothstep(0.05, 0.0, within) + smoothstep(0.95, 1.0, within);
      vec2 gUv = vec2(vDetailUv.x * 0.22 + board * 0.37, vDetailUv.y * 2.0);
      float grain = texture2D(uCloudTex, gUv).b;
      float fine = texture2D(uCloudTex, gUv * vec2(1.0, 5.0)).r;
      float tone = fract(sin(board * 91.7) * 4375.85);
      vec3 wood = diffuseColor.rgb * (0.7 + grain * 0.45) * (0.85 + tone * 0.3);
      float nail = smoothstep(0.035, 0.02, length(vec2(fract(vDetailUv.x * 0.8) - 0.5, (within - 0.5) * 0.25)));
      wood = mix(wood, vec3(0.12, 0.11, 0.1), nail);
      wood *= 1.0 - gap * 0.75;
      diffuseColor.rgb = wood;
      detailRough = mix(0.8, 0.45, nail);
      detailHeight = grain * 0.3 + fine * 0.3 - gap * 0.9;
      detailBump = 0.03;
    `,
    straw: /* glsl */ `
      // Straw: bundles of golden stalks wrapped around the bale.
      vec2 sUv = vec2(vDetailUv.x * 3.5, vDetailUv.y * 0.22);
      float stalks = texture2D(uCloudTex, sUv).b;
      float fibres = texture2D(uCloudTex, sUv * vec2(3.0, 1.5) + 0.4).r;
      vec3 straw = diffuseColor.rgb * (0.7 + stalks * 0.5) * (0.85 + fibres * 0.3);
      straw = mix(straw, straw * vec3(0.7, 0.68, 0.5), smoothstep(0.6, 0.85, texture2D(uCloudTex, vDetailW.xz * 0.2).g) * 0.5);
      diffuseColor.rgb = straw;
      detailRough = 0.88;
      detailHeight = stalks * 0.6 + fibres * 0.4;
      detailBump = 0.04;
    `,
    endgrain: /* glsl */ `
      // Sawn log ends: growth rings, darker heartwood, radial checks and saw marks.
      vec2 ringUv = vDetailUv - 0.5;
      float r = length(ringUv) * 2.0;
      float a = atan(ringUv.y, ringUv.x);
      float wobble = texture2D(uCloudTex, vec2(a * 0.3, r * 0.4)).r * 0.12;
      float rings = smoothstep(0.55, 0.95, abs(sin((r + wobble) * 44.0)));
      float heart = smoothstep(0.62, 0.3, r);
      float check = smoothstep(0.015, 0.0, abs(fract(a * 1.11 + 0.13) - 0.5) - 0.48) * smoothstep(0.15, 0.6, r);
      float saw = 0.94 + 0.06 * sin(ringUv.x * 260.0 + texture2D(uCloudTex, ringUv * 2.0).g * 4.0);
      vec3 wood = diffuseColor.rgb * mix(1.0, 0.72, rings * 0.5);
      wood = mix(wood, wood * vec3(0.72, 0.56, 0.42), heart * 0.6) * saw;
      wood = mix(wood, wood * 0.3, check);
      wood = mix(wood, vec3(0.16, 0.11, 0.07), smoothstep(0.9, 0.96, r));
      diffuseColor.rgb = wood;
      detailRough = 0.86;
      detailHeight = rings * 0.3 - check * 0.6;
      detailBump = 0.01;
    `,
    plaster: /* glsl */ `
      // Lime render: trowel marks, damp at the foot, rain streaks, and patches
      // fallen away low on the wall to show the stone beneath.
      vec4 big = texture2D(uCloudTex, uvF * 0.11 + 0.3);
      vec4 mid = texture2D(uCloudTex, uvF * 0.47 + 0.1);
      vec4 fine = texture2D(uCloudTex, uvF * 2.3);
      vec3 render = diffuseColor.rgb * (0.9 + big.r * 0.14) * (0.96 + fine.b * 0.06);
      float damp = smoothstep(1.25, 0.45, vDetailP.y + (mid.g - 0.5) * 0.4);
      render = mix(render, render * vec3(0.72, 0.74, 0.64), damp * 0.6);
      float streak = smoothstep(0.62, 0.8, texture2D(uCloudTex, vec2(uvF.x * 1.6, uvF.y * 0.08)).b) * smoothstep(0.6, 2.4, vDetailP.y);
      render = mix(render, render * vec3(0.8, 0.78, 0.74), streak * 0.4);
      float lowWall = smoothstep(1.6, 0.6, vDetailP.y);
      float lossField = big.g * 0.7 + big.b * 0.3 + lowWall * 0.18;
      float loss = smoothstep(0.83, 0.86, lossField);
      float lossEdge = smoothstep(0.79, 0.83, lossField) - loss;
      vec3 stone = vec3(0.42, 0.38, 0.33) * (0.7 + fine.a * 0.5);
      stone = mix(stone, vec3(0.2, 0.18, 0.16), smoothstep(0.42, 0.25, fine.a));
      diffuseColor.rgb = mix(render * (1.0 - lossEdge * 0.25), stone, loss);
      detailRough = mix(0.95, 0.88, loss);
      detailHeight = mid.r * 0.25 + fine.r * 0.25 - loss * 0.6 + lossEdge * 0.2;
      detailBump = 0.022;
    `,
    stone: /* glsl */ `
      // Rubble fieldstone in mortar, a little moss low down.
      vec4 cells = texture2D(uCloudTex, uvF * 0.16);
      vec4 detail = texture2D(uCloudTex, uvF * 1.9 + 0.5);
      float stoneShape = smoothstep(0.18, 0.36, cells.a);
      float id = texture2D(uCloudTex, floor(uvF * 3.2) * 0.031 + 0.7).g;
      vec3 stone = diffuseColor.rgb * (0.72 + id * 0.5) * (0.88 + detail.r * 0.24);
      stone = mix(stone, stone * vec3(1.08, 0.98, 0.86), smoothstep(0.55, 0.8, id) * 0.6);
      vec3 mortar = vec3(0.5, 0.48, 0.44) * (0.85 + detail.b * 0.2);
      float moss = smoothstep(0.65, 0.9, detail.g) * smoothstep(0.7, 0.2, vDetailP.y) * (1.0 - stoneShape * 0.6);
      diffuseColor.rgb = mix(mix(mortar, stone, stoneShape), vec3(0.16, 0.2, 0.08), moss * 0.6);
      detailRough = mix(0.98, 0.86, stoneShape);
      detailHeight = stoneShape * (0.6 + cells.a * 0.4) + detail.r * 0.15;
      detailBump = 0.03;
    `,
    brick: /* glsl */ `
      // Old soft bricks in lime mortar, sooty towards the top of the stack.
      float courseH = 0.075;
      float row = floor(uvF.y / courseH);
      float bw = 0.22;
      float xp = uvF.x + mod(row, 2.0) * bw * 0.5;
      vec2 f = vec2(fract(xp / bw), fract(uvF.y / courseH));
      float brick = smoothstep(0.0, 0.05, f.x) * smoothstep(1.0, 0.95, f.x) * smoothstep(0.0, 0.12, f.y) * smoothstep(1.0, 0.88, f.y);
      float id = texture2D(uCloudTex, vec2(floor(xp / bw), row) * 0.071).g;
      vec4 detail = texture2D(uCloudTex, uvF * 2.2);
      vec3 b = diffuseColor.rgb * (0.7 + id * 0.55) * (0.9 + detail.r * 0.2);
      b = mix(b, b * vec3(0.55, 0.5, 0.48), smoothstep(0.75, 0.95, id) * 0.6);
      float soot = smoothstep(uSootFrom, uSootFrom + 1.2, vDetailP.y) * 0.65;
      vec3 mortar = vec3(0.62, 0.58, 0.52) * (0.8 + detail.b * 0.25);
      diffuseColor.rgb = mix(mortar, b, brick) * (1.0 - soot * (0.7 + detail.g * 0.3));
      detailRough = mix(0.97, 0.88, brick);
      detailHeight = brick * 0.6 + detail.r * 0.2;
      detailBump = 0.012;
    `,
  };
  // Every kind in one shader, chosen per material by a uniform.
  const branches = KIND_ORDER.map((k, i) => `${i === 0 ? "if" : "else if"} (uKind < ${i}.5) {\n${code[k]}\n}`).join("\n");
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uGroundAt = { value: 0 };
    shader.uniforms.uKind = { value: KIND_ORDER.indexOf(kind) };
    shader.uniforms.uSootFrom = { value: 4.4 };
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vDetailW;\nvarying vec3 vDetailNW;\nvarying vec2 vDetailUv;\nvarying vec3 vDetailP;\nvarying vec3 vDetailN;")
      .replace(
        "#include <worldpos_vertex>",
        `#include <worldpos_vertex>
        {
          #ifdef USE_INSTANCING
            mat4 detailModel = modelMatrix * instanceMatrix;
          #else
            mat4 detailModel = modelMatrix;
          #endif
          vDetailW = (detailModel * vec4(transformed, 1.0)).xyz;
          vDetailNW = normalize(mat3(detailModel) * objectNormal);
          vDetailUv = uv;
          vDetailP = position;
          vDetailN = normal;
        }`,
      );
    patchSky(shader);
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
        varying vec3 vDetailW;
        varying vec3 vDetailNW;
        varying vec2 vDetailUv;
        varying vec3 vDetailP;
        varying vec3 vDetailN;
        uniform float uGroundAt;
        uniform float uKind;
        uniform float uSootFrom;
        ${GLSL_BUMP}
        vec2 faceUv(vec3 p, vec3 n){
          vec3 a = abs(n);
          return a.x > a.z && a.x > a.y ? vec2(p.z, p.y) : (a.z > a.y ? vec2(p.x, p.y) : vec2(p.x, p.z));
        }`,
      )
      .replace("void main() {", "vec4 triTexW(vec3 p, vec3 w);\nvoid main() {")
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
        vec3 detailN = normalize(vDetailNW);
        vec3 triW = pow(abs(detailN), vec3(4.0));
        triW /= triW.x + triW.y + triW.z;
        #define triTex(p) triTexW(p, triW)
        vec2 uvF = faceUv(vDetailP, normalize(vDetailN));
        float groundAt = uGroundAt;
        float detailRough = roughness;
        float detailHeight = 0.0;
        float detailBump = 0.0;
        ${branches}`,
      )
      .replace("#include <roughnessmap_fragment>", "float roughnessFactor = detailRough;")
      .replace("#include <normal_fragment_maps>", "#include <normal_fragment_maps>\nnormal = bumpNormal(-vViewPosition, normal, detailHeight, detailBump);");
    shader.fragmentShader += `
      vec4 triTexW(vec3 p, vec3 w){
        return texture2D(uCloudTex, p.yz) * w.x + texture2D(uCloudTex, p.xz) * w.y + texture2D(uCloudTex, p.xy) * w.z;
      }
    `;
  };
  material.customProgramCacheKey = () => "world-v3";
  worldMats.set(kind, material);
  return material;
}

/** Remaps a box's UVs to metres, with u running along its longest side (for grain). */
export function grainBox(w: number, h: number, d: number, segments = 1): THREE.BufferGeometry {
  const geo = new THREE.BoxGeometry(w, h, d, segments, segments, segments);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const nor = geo.attributes.normal as THREE.BufferAttribute;
  const uv = geo.attributes.uv as THREE.BufferAttribute;
  const dims = [w, h, d];
  const long = dims.indexOf(Math.max(w, h, d));
  for (let i = 0; i < pos.count; i++) {
    const p = [pos.getX(i), pos.getY(i), pos.getZ(i)];
    const n = [Math.abs(nor.getX(i)), Math.abs(nor.getY(i)), Math.abs(nor.getZ(i))];
    const faceAxis = n.indexOf(Math.max(...n));
    const across = [0, 1, 2].find((axis) => axis !== long && axis !== faceAxis) ?? (long + 1) % 3;
    uv.setXY(i, p[long] + 3.7 * long, p[across] + p[faceAxis] * 0.37);
  }
  return geo;
}

// ----- Water -----------------------------------------------------------------

export function createWaterMaterial(sky: { top: THREE.Color; horizon: THREE.Color; sunDir: THREE.Vector3; sunColor: THREE.Color; time: { value: number } }) {
  const u = skyUniforms;
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: {
      uSkyLut: u.uSkyLut,
      uCloudTex: u.uCloudTex,
      uAerial: u.uAerial,
      uCloudWind: u.uCloudWind,
      uCloudCover: u.uCloudCover,
      uCloudShadow: u.uCloudShadow,
      uSunDirW: u.uSunDirW,
      uSunColorW: u.uSunColorW,
      uSkyAmb: u.uSkyAmb,
      uTime: sky.time,
      uPond: { value: new THREE.Vector4(POND.x, POND.z, POND.rx, POND.rz) },
      uLot: { value: LOT_W },
      uNight: { value: 0 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vWorld = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vWorld;
      uniform vec3 uSunColorW, uSkyAmb;
      uniform float uTime, uLot, uNight;
      uniform vec4 uPond;
      ${GLSL_SKY}
      vec2 rippleGrad(vec2 p, float t){
        vec2 a = texture2D(uCloudTex, p * 0.31 + vec2(t * 0.013, t * 0.008)).rb;
        vec2 b = texture2D(uCloudTex, p * 0.73 - vec2(t * 0.019, -t * 0.011)).rb;
        vec2 c = texture2D(uCloudTex, p * 1.9 + vec2(-t * 0.031, t * 0.024)).ba;
        return (a - 0.5) * 0.5 + (b - 0.5) * 0.35 + (c - 0.5) * 0.18;
      }
      void main(){
        vec3 toFrag = vWorld - cameraPosition;
        vec3 V = normalize(-toFrag);
        float localX = mod(vWorld.x, uLot);
        vec2 q = (vec2(localX, vWorld.z) - uPond.xy) / uPond.zw;
        float d = length(q);
        // Wind ripples plus rings from fish and insects.
        vec2 g = rippleGrad(vWorld.xz, uTime) * 0.32;
        for (int k = 0; k < 3; k++) {
          float fk = float(k);
          float cycle = uTime * 0.23 + fk * 0.37;
          float id = floor(cycle);
          vec2 centre = uPond.xy + (vec2(fract(sin(id * 12.9 + fk) * 437.5), fract(sin(id * 78.2 + fk) * 951.3)) - 0.5) * uPond.zw * 1.2;
          vec2 rel = vec2(localX, vWorld.z) - centre;
          float r = length(rel);
          float age = fract(cycle);
          float wave = sin((r - age * 1.6) * 26.0) * exp(-abs(r - age * 1.6) * 7.0) * (1.0 - age);
          g += rel / max(r, 1e-3) * wave * 0.06;
        }
        vec3 N = normalize(vec3(g.x, 1.0, g.y));
        float cosT = clamp(dot(N, V), 0.0, 1.0);
        float fres = 0.02 + 0.98 * pow(1.0 - cosT, 5.0);
        vec3 R = reflect(-V, N);
        // Reflection: the far bank's slope and trees, with sky above their tops.
        float treeline = 0.22 + 0.16 * texture2D(uCloudTex, vec2(vWorld.x * 0.05 + R.x * 0.6, 0.31)).r + 0.07 * texture2D(uCloudTex, vec2(vWorld.x * 0.19 + R.x * 2.0, 0.71)).g;
        vec3 skyR = skyRadiance(normalize(vec3(R.x, max(R.y, 0.02), R.z)));
        vec3 bankLit = vec3(0.035, 0.07, 0.025) * (uSkyAmb * 0.6 + uSunColorW * max(uSunDirW.y, 0.0) * 0.35);
        float bankMix = smoothstep(treeline + 0.03, treeline - 0.03, R.y);
        vec3 refl = mix(skyR, bankLit, bankMix);
        // The water itself: peaty and dark in the middle, clearer over the shallows.
        vec3 deep = vec3(0.012, 0.03, 0.03);
        vec3 shallow = vec3(0.06, 0.075, 0.04);
        vec3 body = mix(deep, shallow, smoothstep(0.45, 1.0, d)) * (uSkyAmb * 0.55 + uSunColorW * max(uSunDirW.y, 0.0) * 0.2);
        vec3 col = mix(body, refl, fres);
        // Sun glitter on the ripples.
        vec3 H = normalize(uSunDirW + V);
        float nh = max(dot(N, H), 0.0);
        col += uSunColorW * (pow(nh, 900.0) * 6.0 + pow(nh, 120.0) * 0.18) * fres * 4.0;
        // Lapping edge and a thin wet line.
        float edge = smoothstep(0.84, 0.99, d);
        float lap = smoothstep(0.55, 0.95, sin(d * 46.0 - uTime * 1.6 + q.x * 3.0)) * edge;
        col = mix(col, uSkyAmb * 0.25 + uSunColorW * 0.05, lap * 0.18);
        col = applyAerial(col, toFrag);
        float alpha = smoothstep(1.03, 0.9, d) * mix(1.0, 0.55, edge) * mix(0.9, 1.0, fres);
        gl_FragColor = vec4(col, alpha);
      }
    `,
  });
}

// ----- Lot of land -------------------------------------------------------------

export class LotStatic {
  group = new THREE.Group();
  private disposables: { dispose(): void }[] = [];
  /** Grass in strips across the lot, so strips off screen are culled. */
  private grass: { mesh: THREE.InstancedMesh; full: number }[] = [];

  constructor(slot: number, quality: Quality, shared: SharedLand, mask: MaskData) {
    const rand = rng(slot * 1000 + 19);

    const ground = new THREE.Mesh(shared.terrain, shared.terrainMaterial);
    ground.receiveShadow = true;
    ground.frustumCulled = false;
    ground.renderOrder = 1;
    this.group.add(ground);

    // Grass: a dense meadow in the foreground, between things on the farm, and
    // thinning out over the slopes behind. Shuffled, so lowering the count thins evenly.
    const scaleCount = quality === "low" ? 0.35 : quality === "medium" ? 0.7 : 1;
    const bands: { z0: number; z1: number; count: number }[] = [
      { z0: 8.1, z1: 14.5, count: 2500 },
      { z0: -8, z1: 4.6, count: 1350 },
      { z0: 4.6, z1: 8.1, count: 360 },
      { z0: -15, z1: -8, count: 340 },
    ];
    const placements: GrassPlacement[] = [];
    const tufted = new THREE.Vector3();
    for (const band of bands) {
      const target = Math.round(band.count * scaleCount);
      let made = 0;
      let tries = 0;
      while (made < target && tries < target * 10) {
        tries++;
        const x = rand() * LOT_W;
        const z = lerp(band.z0, band.z1, rand());
        if (!placeGrass(x, z, mask.data)) continue;
        const nearPond = Math.hypot((x - POND.x) / POND.rx, (z - POND.z) / POND.rz);
        const shortNearPond = smooth(1.05, 1.7, nearPond);
        const meadow = 1 - smooth(5, 11, Math.abs(z - 4));
        const patch = perlinFbm((x / LOT_W) * 5, (z + 20) / 9, 5, 64, 3, 11);
        const dry = smooth(0.6, 0.76, patch);
        terrainNormal(x, z, tufted);
        placements.push({
          x,
          y: terrainHeight(x, z) - 0.03,
          z,
          height: (0.3 + rand() * 0.34) * lerp(0.6, 1, shortNearPond) * lerp(0.85, 1.2, meadow) * lerp(1.05, 0.7, dry),
          width: 0.3 + rand() * 0.16,
          tone: clamp(rand() * 0.6 + dry * 0.5 + (tufted.y < 0.97 ? 0.1 : 0)),
        });
        made++;
      }
    }
    for (let i = placements.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [placements[i], placements[j]] = [placements[j], placements[i]];
    }
    const strips = 5;
    for (let s = 0; s < strips; s++) {
      const part = placements.filter((p) => Math.min(strips - 1, Math.floor((p.x / LOT_W) * strips)) === s);
      if (part.length === 0) continue;
      const mesh = createGrassPatch(part);
      mesh.renderOrder = 0;
      mesh.computeBoundingSphere();
      if (mesh.boundingSphere) mesh.boundingSphere.radius += 0.6;
      mesh.frustumCulled = true;
      this.group.add(mesh);
      this.disposables.push(mesh);
      this.grass.push({ mesh, full: part.length });
    }

    // Wildflowers in drifts of one kind, clover low in the meadow.
    const flowerCount = quality === "low" ? 90 : 300;
    const flowers: FlowerPlacement[] = [];
    let tries = 0;
    while (flowers.length < flowerCount && tries < flowerCount * 8) {
      tries++;
      const x = rand() * LOT_W;
      const z = rand() < 0.55 ? lerp(8.3, 13.5, rand()) : lerp(-11, 4.5, rand());
      if (!placeGrass(x, z, mask.data)) continue;
      const colour = Math.floor(rand() * 6);
      const clusterCount = 2 + Math.floor(rand() * 7);
      for (let c = 0; c < clusterCount && flowers.length < flowerCount; c++) {
        const fx = x + (rand() - 0.5) * 1.4;
        const fz = z + (rand() - 0.5) * 1.0;
        if (!placeGrass(fx, fz, mask.data)) continue;
        flowers.push({ x: fx, y: terrainHeight(fx, fz) - 0.02, z: fz, scale: 0.75 + rand() * 0.6, colour });
      }
    }
    const flowerPatch = createFlowerPatch(flowers);
    this.group.add(flowerPatch);
    this.disposables.push(flowerPatch);

    // Trees: woods on the slopes behind, mixed species, and a few framing the farm.
    const trees: TreePlacement[] = [];
    const treeTints = ["#6ea84a", "#7fae4b", "#a8b94a", "#c48a42"].map((c) => new THREE.Color(c));
    const normal = new THREE.Vector3();
    const addTree = (x: number, z: number, scale: number, variant?: number) => {
      terrainNormal(x, z, normal);
      trees.push({
        x,
        y: terrainHeight(x, z) - 0.05,
        z,
        scale,
        rotation: rand() * TAU,
        variant: variant ?? (z < -38 ? (rand() < 0.55 ? 2 : Math.floor(rand() * 4)) : Math.floor(rand() * 4)),
        tint: rand() > 0.86 ? treeTints[Math.floor(rand() * treeTints.length)] : undefined,
        normal: normal.clone(),
      });
    };
    const backTrees = quality === "low" ? 10 : 20;
    for (let i = 0; i < backTrees; i++) {
      const z = lerp(-22, -66, Math.pow(rand(), 0.75));
      addTree(rand() * LOT_W, z, lerp(0.8, 1.2, rand()));
    }
    for (const [x, z, s, v] of [[0.1, -15, 0.72, 0], [LOT_W - 0.8, -16, 0.76, 1], [8 + rand() * 3, -20, 0.68, 3], [15 + rand() * 3, -19, 0.7, 2], [12.5, -11.5, 0.55, 3]] as const) addTree(x, z, s, v);
    const lowDetail = quality === "low";
    const treeField = new TreeField(trees, { lowDetail, castShadow: quality !== "low" });
    this.group.add(treeField.group);
    this.disposables.push(treeField);

    // Pond water.
    const water = new THREE.Mesh(shared.pondGeometry, shared.water);
    water.position.set(POND.x, POND.level, POND.z);
    water.scale.set(POND.rx, 1, POND.rz);
    water.renderOrder = 3;
    this.group.add(water);

    // Reeds and cattails round the far side of the pond, rushes on the near side.
    const reedCount = quality === "low" ? 36 : 70;
    const reeds = new THREE.InstancedMesh(shared.reed, shared.reedMaterial, reedCount);
    const matrix = new THREE.Matrix4();
    const quat = new THREE.Quaternion();
    for (let i = 0; i < reedCount; i++) {
      const far = i < reedCount * 0.86;
      const a = far ? lerp(Math.PI * 1.02, Math.PI * 1.98, rand()) : lerp(0.2, Math.PI - 0.2, rand());
      const r = (far ? 0.9 : 0.98) + rand() * 0.16;
      const px = POND.x + Math.cos(a) * POND.rx * r;
      const pz = POND.z + Math.sin(a) * POND.rz * r;
      quat.setFromEuler(new THREE.Euler((rand() - 0.5) * 0.2, rand() * TAU, (rand() - 0.5) * 0.2));
      const s = far ? 0.7 + rand() * 0.55 : 0.28 + rand() * 0.18;
      matrix.compose(new THREE.Vector3(px, Math.max(POND.level - 0.05, terrainHeight(px, pz) - 0.05), pz), quat, new THREE.Vector3(1, s, 1));
      reeds.setMatrixAt(i, matrix);
    }
    reeds.frustumCulled = false;
    reeds.castShadow = true;
    this.group.add(reeds);
    this.disposables.push(reeds);

    // Lily pads, some in flower.
    const lilyCount = 20;
    const lilies = new THREE.InstancedMesh(shared.lily, shared.lilyMaterial, lilyCount);
    for (let i = 0; i < lilyCount; i++) {
      const a = rand() * TAU;
      const r = 0.25 + Math.sqrt(rand()) * 0.6;
      const s = 0.45 + rand() * 0.55;
      quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rand() * TAU);
      matrix.compose(new THREE.Vector3(POND.x + Math.cos(a) * r * POND.rx, POND.level + 0.012, POND.z + Math.sin(a) * r * POND.rz), quat, new THREE.Vector3(s, s, s));
      lilies.setMatrixAt(i, matrix);
    }
    lilies.frustumCulled = false;
    lilies.receiveShadow = true;
    this.group.add(lilies);
    this.disposables.push(lilies);

    // Bushes, rocks and hay bales for the corners of the farm.
    const propMatrix = new THREE.Matrix4();
    const propQuat = new THREE.Quaternion();
    const bushes = createBushField(
      [[0.7, -1.6, 0.95], [7.9, -5.2, 1.2], [11.2, -7.4, 1.05], [23.8, -3.2, 1.25], [24.3, 2.2, 0.9], [4.2, 3.8, 0.55], [13.6, -8.6, 0.8], [20.6, -9.8, 0.9]].map(([x, z, s], i) => ({
        x,
        y: terrainHeight(x, z) + 0.05,
        z,
        scale: s,
        rotation: i * 1.7,
      })),
    );
    this.group.add(bushes.group);
    this.disposables.push(bushes);
    const rockSpots = [[12.8, -5.0, 0.4], [14.1, -9.4, 0.65], [21.4, -5.5, 0.5], [22.4, -8.2, 0.3], [6.4, 1.9, 0.35], [13.5, -9.0, 0.25], [21.9, -6.3, 0.22]];
    const rocks = new THREE.InstancedMesh(shared.rock, shared.rockMaterial, rockSpots.length);
    rockSpots.forEach(([x, z, s], i) => {
      propQuat.setFromEuler(new THREE.Euler((rand() - 0.5) * 0.3, i * 2.3, (rand() - 0.5) * 0.3));
      propMatrix.compose(new THREE.Vector3(x, terrainHeight(x, z) + 0.12 * s, z), propQuat, new THREE.Vector3(s * 1.2, s * 0.75, s));
      rocks.setMatrixAt(i, propMatrix);
    });
    rocks.frustumCulled = false;
    rocks.castShadow = true;
    rocks.receiveShadow = true;
    this.group.add(rocks);
    this.disposables.push(rocks);
    const hay = new THREE.InstancedMesh(shared.hay, shared.hayMaterial, 3);
    [[19.2, 2.5], [20.6, 2.9], [24.2, 1.8]].forEach(([x, z], i) => {
      propQuat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), i * 1.1);
      propMatrix.compose(new THREE.Vector3(x, terrainHeight(x, z) + 0.4, z), propQuat, new THREE.Vector3(1, 1, 1));
      hay.setMatrixAt(i, propMatrix);
    });
    hay.frustumCulled = false;
    hay.castShadow = true;
    hay.receiveShadow = true;
    this.group.add(hay);
    this.disposables.push(hay);

    // Split rails along the road, with gaps for the footpaths.
    const fence = new THREE.InstancedMesh(shared.fence, shared.wood, 30);
    let f = 0;
    for (let x = 0.2; x < LOT_W - 1; x += 2.5) {
      if (Math.abs(x + 1.25 - 4.3) < 2 || Math.abs(x + 1.25 - 22.4) < 2) continue;
      const fz = ROAD_Z - 2.05;
      const tiltEuler = new THREE.Euler((rand() - 0.5) * 0.03, (rand() - 0.5) * 0.05, (rand() - 0.5) * 0.04);
      quat.setFromEuler(tiltEuler);
      matrix.compose(new THREE.Vector3(x, terrainHeight(x, fz), fz), quat, new THREE.Vector3(1, 0.92 + rand() * 0.1, 1));
      fence.setMatrixAt(f++, matrix);
    }
    fence.count = f;
    fence.frustumCulled = false;
    fence.castShadow = true;
    fence.receiveShadow = true;
    this.group.add(fence);
    this.disposables.push(fence);
  }

  setGrassDensity(fraction: number) {
    for (const strip of this.grass) strip.mesh.count = Math.max(1, Math.floor(strip.full * fraction));
  }

  dispose() {
    for (const item of this.disposables) item.dispose();
  }
}

function placeGrass(x: number, z: number, mask: Uint8ClampedArray) {
  if (maskAt(mask, x, z, 0) > 0.3) return false;
  if (maskAt(mask, x, z, 1) > 0.5) return false;
  // Clear space for the cottage.
  if (x > 0.8 && x < 7.8 && z > -6 && z < 0) return false;
  // The sign and the nest.
  if (Math.hypot(x - 22.4, z + 0.6) < 2.3) return false;
  if (Math.hypot(x - 1.3, z - 2.6) < 0.8) return false;
  // Out of the water.
  const px = (x - POND.x) / POND.rx;
  const pz = (z - POND.z) / POND.rz;
  if (px * px + pz * pz < 1.1) return false;
  return true;
}

export interface SharedLand {
  terrain: THREE.BufferGeometry;
  terrainMaterial: THREE.MeshStandardMaterial;
  pondGeometry: THREE.BufferGeometry;
  water: THREE.ShaderMaterial;
  reed: THREE.BufferGeometry;
  reedMaterial: THREE.MeshStandardMaterial;
  lily: THREE.BufferGeometry;
  lilyMaterial: THREE.MeshStandardMaterial;
  fence: THREE.BufferGeometry;
  wood: THREE.MeshStandardMaterial;
  rock: THREE.BufferGeometry;
  rockMaterial: THREE.MeshStandardMaterial;
  hay: THREE.BufferGeometry;
  hayMaterial: THREE.MeshStandardMaterial;
}

/** A lumpy boulder with welded noise, vertex colours for tone. Shared by the valley and race. */
export function boulderGeometry(seed: number, detail = 4): THREE.BufferGeometry {
  const geo = new THREE.IcosahedronGeometry(1, detail);
  const merged = mergeVerticesSimple(geo);
  geo.dispose();
  const p = merged.attributes.position as THREE.BufferAttribute;
  const c = new Float32Array(p.count * 3);
  const v = new THREE.Vector3();
  const base = new THREE.Color("#8c8780");
  const warm = new THREE.Color("#9a8c7c");
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const n1 = perlinFbm(v.x * 1.3 + seed, v.y * 1.3 + v.z * 0.7, 64, 64, 3, 11 + seed);
    const n2 = perlinFbm(v.z * 3.1 + seed * 2, v.x * 3.1 + v.y, 64, 64, 2, 7);
    // Facets: a few flat-ish planes like split granite.
    const facet = Math.max(0, Math.abs(v.x * 0.7 + v.y * 0.3) - 0.6) * 0.25 + Math.max(0, Math.abs(v.z * 0.6 - v.y * 0.4) - 0.6) * 0.25;
    const r = 0.78 + (n1 - 0.5) * 0.55 + (n2 - 0.5) * 0.12 - facet;
    const flat = v.y < -0.35 ? lerp(1, 0.7, (-0.35 - v.y) / 0.65) : 1;
    p.setXYZ(i, v.x * r, v.y * r * flat, v.z * r);
    const tone = base.clone().lerp(warm, n2).multiplyScalar(0.85 + n1 * 0.3);
    c[i * 3] = tone.r;
    c[i * 3 + 1] = tone.g;
    c[i * 3 + 2] = tone.b;
  }
  merged.setAttribute("color", new THREE.BufferAttribute(c, 3));
  merged.computeVertexNormals();
  return merged;
}

/** Welds the duplicate vertices of a polyhedron so noise displacement keeps it closed. */
function mergeVerticesSimple(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  const pos = geometry.attributes.position as THREE.BufferAttribute;
  const map = new Map<string, number>();
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const uvAttr = geometry.attributes.uv as THREE.BufferAttribute | undefined;
  for (let i = 0; i < pos.count; i++) {
    const key = `${pos.getX(i).toFixed(4)},${pos.getY(i).toFixed(4)},${pos.getZ(i).toFixed(4)}`;
    let index = map.get(key);
    if (index === undefined) {
      index = positions.length / 3;
      map.set(key, index);
      positions.push(pos.getX(i), pos.getY(i), pos.getZ(i));
      uvs.push(uvAttr ? uvAttr.getX(i) : 0, uvAttr ? uvAttr.getY(i) : 0);
    }
    indices.push(index);
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  out.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  out.setIndex(indices);
  return out;
}

export function createSharedLand(mask: MaskData, sky: Parameters<typeof createWaterMaterial>[0]): SharedLand {
  const terrain = terrainGeometry();
  const terrainMaterial = makeGroundMaterial({ mask: mask.texture });

  const pondGeometry = new THREE.CircleGeometry(1, 64);
  pondGeometry.rotateX(-Math.PI / 2);

  // Reeds: cattails with brown heads and long blade leaves.
  const reedBuilder = new GeoBuilder();
  for (let b = 0; b < 4; b++) {
    const lean = (b - 1.5) * 0.07;
    const height = 1.1 + (b % 2) * 0.45;
    reedBuilder.add(new THREE.CylinderGeometry(0.007, 0.018, height, 4, 1, true), makeMatrix(lean, height / 2, b * 0.05 - 0.07, 0, 0, lean), "#6e8a44");
    if (b % 2 === 0) reedBuilder.add(new THREE.CapsuleGeometry(0.034, 0.17, 1, 6), makeMatrix(lean * 2 + 0.002, height - 0.05, b * 0.05 - 0.07, 0, 0, lean), "#5a3a22");
  }
  for (let k = 0; k < 5; k++) {
    const a = (k / 5) * TAU;
    const leaf = new THREE.PlaneGeometry(0.035, 1.25, 1, 3);
    const lp = leaf.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < lp.count; i++) {
      const y = lp.getY(i) + 0.625;
      lp.setXYZ(i, lp.getX(i) * (1 - y / 1.4), y, y * y * 0.12);
    }
    leaf.computeVertexNormals();
    reedBuilder.add(leaf, makeMatrix(Math.cos(a) * 0.04, 0, Math.sin(a) * 0.04, 0, a, 0), (_x, y) => new THREE.Color("#7a9a4a").multiplyScalar(0.7 + y * 0.25));
    leaf.dispose();
  }
  const reed = reedBuilder.build();
  const reedMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, side: THREE.DoubleSide });
  reedMaterial.onBeforeCompile = (shader) => {
    shader.uniforms.uWindTime = windTime;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\nuniform float uWindTime;`)
      .replace(
        "#include <begin_vertex>",
        /* glsl */ `#include <begin_vertex>
        { float h = position.y; float p = instanceMatrix[3][0] * 0.9 + instanceMatrix[3][2] * 0.6; transformed.x += sin(uWindTime * 1.6 + p) * h * h * 0.05; transformed.z += cos(uWindTime * 1.3 + p) * h * h * 0.035; }`,
      );
    patchSky(shader);
  };
  reedMaterial.customProgramCacheKey = () => "reed-v2";

  // Lily pads: notched discs with radial veins, and white or pink flowers.
  const lilyBuilder = new GeoBuilder();
  const pad = new THREE.CircleGeometry(0.42, 22, 0.25, TAU - 0.5);
  pad.rotateX(-Math.PI / 2);
  const padPos = pad.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < padPos.count; i++) {
    const x = padPos.getX(i);
    const z = padPos.getZ(i);
    const r = Math.hypot(x, z) / 0.42;
    padPos.setY(i, r * r * 0.025);
  }
  pad.computeVertexNormals();
  lilyBuilder.add(pad, null, (x, _y, z) => {
    const a = Math.atan2(z, x);
    const vein = Math.pow(Math.abs(Math.sin(a * 9)), 8) * 0.12;
    const r = Math.hypot(x, z) / 0.42;
    return new THREE.Color("#3f6b2a").multiplyScalar(0.8 + r * 0.25 + vein).lerp(new THREE.Color("#6b4a3a"), smooth(0.85, 1, r) * 0.4);
  });
  const lilyFlower = (x: number, z: number, color: string, scale: number) => {
    for (let ring = 0; ring < 2; ring++) {
      const count = ring === 0 ? 8 : 6;
      for (let i = 0; i < count; i++) {
        const a = (i / count) * TAU + ring * 0.4;
        const petal = new THREE.SphereGeometry(0.05 * scale, 4, 3);
        petal.scale(0.55, 0.25, 1.4);
        lilyBuilder.add(petal, makeMatrix(x + Math.cos(a) * 0.05 * scale, 0.05 + ring * 0.03, z + Math.sin(a) * 0.05 * scale, ring === 0 ? -0.5 : -0.95, -a + Math.PI / 2, 0), new THREE.Color(color).multiplyScalar(ring ? 1.05 : 0.95), 0.02);
        petal.dispose();
      }
    }
    lilyBuilder.add(new THREE.SphereGeometry(0.028 * scale, 8, 6), makeMatrix(x, 0.08, z), "#f2c43c", 0.08);
  };
  lilyFlower(0.1, 0.06, "#f7f2ea", 1.2);
  const lily = lilyBuilder.build();
  const lilyMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.35, side: THREE.DoubleSide });
  lilyMaterial.onBeforeCompile = (shader) => patchSky(shader);
  lilyMaterial.customProgramCacheKey = () => "lily-v2";

  // Split-rail fence: rough posts and two rails of silvered wood.
  const fenceBuilder = new GeoBuilder();
  fenceBuilder.add(grainBox(0.16, 1.1, 0.16, 2), makeMatrix(0, 0.5, 0, 0, 0.2, 0), "#8d7a62");
  fenceBuilder.add(new THREE.CylinderGeometry(0.0, 0.11, 0.08, 4), makeMatrix(0, 1.09, 0, 0, Math.PI / 4 + 0.2, 0), "#7d6a52");
  fenceBuilder.add(grainBox(2.55, 0.13, 0.075, 3), makeMatrix(1.25, 0.86, 0.06, 0.06, 0, 0.012), "#9b8768");
  fenceBuilder.add(grainBox(2.55, 0.12, 0.07, 3), makeMatrix(1.25, 0.47, 0.06, -0.05, 0, -0.015), "#8f7c60");
  const fence = fenceBuilder.build();
  const wood = worldMaterial("weathered");

  const rockGeo = boulderGeometry(3, 4);
  const rockMaterial = worldMaterial("rock");

  // Round hay bales, with a little twine.
  const hayBuilder = new GeoBuilder();
  const hayCore = new THREE.CylinderGeometry(0.42, 0.42, 0.95, 28, 3);
  const hp = hayCore.attributes.position as THREE.BufferAttribute;
  const huv = hayCore.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < hp.count; i++) {
    const a = Math.atan2(hp.getZ(i), hp.getX(i));
    const r = Math.hypot(hp.getX(i), hp.getZ(i));
    const bulge = r > 0.3 ? 1 + 0.04 * Math.cos((hp.getY(i) / 0.95) * Math.PI) : 1;
    hp.setX(i, hp.getX(i) * bulge);
    hp.setZ(i, hp.getZ(i) * bulge);
    huv.setXY(i, (a / TAU) * 2.6 + (r < 0.3 ? r * 4 : 0), hp.getY(i) * 3 + r * 6);
  }
  hayCore.computeVertexNormals();
  hayBuilder.add(hayCore, makeMatrix(0, 0, 0, 0, 0, Math.PI / 2), (x, y) => new THREE.Color("#d9b870").multiplyScalar(0.85 + Math.sin(x * 9 + y * 3) * 0.06));
  for (const x of [-0.25, 0.25]) hayBuilder.add(new THREE.TorusGeometry(0.435, 0.008, 4, 40), makeMatrix(x, 0, 0, 0, Math.PI / 2, 0), "#c9b48a");
  const hay = hayBuilder.build();
  const hayMaterial = worldMaterial("straw");

  const water = createWaterMaterial(sky);
  return { terrain, terrainMaterial, pondGeometry, water, reed, reedMaterial, lily, lilyMaterial, fence, wood, rock: rockGeo, rockMaterial, hay, hayMaterial };
}

// ----- Mountains, far hills, forests and the volcano ------------------------------------

const backdropVertex = /* glsl */ `
  varying vec3 vWorld;
  varying vec3 vNormal;
  varying float vH;
  attribute float aH;
  void main(){
    vec4 w = modelMatrix * vec4(position, 1.0);
    vWorld = w.xyz;
    vH = aH;
    vNormal = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`;

/**
 * Far land, lit by the same sun and sky: forested foothills, rock with strata,
 * snow above a ragged snow line, alpine meadow between, and deep aerial
 * perspective so it sits kilometres away.
 */
const backdropFragment = /* glsl */ `
  varying vec3 vWorld;
  varying vec3 vNormal;
  varying float vH;
  uniform vec3 uSunColorW, uSkyAmb, uRock, uSnow, uForest;
  uniform float uSnowLine, uForestLine, uHaze, uLava, uScale;
  ${GLSL_SKY}
  void main(){
    vec3 Ng = normalize(vNormal);
    vec4 big = texture2D(uCloudTex, vWorld.xz * 0.0031 * uScale + vec2(0.13, 0.7));
    vec4 mid = texture2D(uCloudTex, vWorld.xz * 0.013 * uScale + vec2(0.41, 0.2));
    vec4 fine = texture2D(uCloudTex, vWorld.xz * 0.06 * uScale + vec2(0.7, 0.4));
    // Crags: tilt the normal with the noise so ridges and gullies catch the light.
    vec3 N = normalize(Ng + vec3(mid.r - 0.5, 0.0, mid.b - 0.5) * 0.9 + vec3(fine.r - 0.5, 0.0, fine.g - 0.5) * 0.35);
    float slope = 1.0 - clamp(N.y, 0.0, 1.0);
    float y = vWorld.y;
    // Rock with strata and weathering.
    float strata = 0.5 + 0.5 * sin(y * 0.55 + big.r * 6.0);
    vec3 rock = uRock * (0.7 + mid.r * 0.5) * (0.88 + strata * 0.18);
    rock = mix(rock, rock * vec3(1.15, 1.02, 0.85), smoothstep(0.55, 0.8, big.g) * 0.5);
    // Snow above a ragged line, and only where it is not too steep.
    float snowLine = uSnowLine + (big.b - 0.5) * 22.0 + (fine.a - 0.5) * 5.0;
    float snow = smoothstep(snowLine - 2.0, snowLine + 3.0, y) * smoothstep(0.78, 0.45, slope + (fine.r - 0.5) * 0.25);
    // Forest on the lower, gentler slopes; meadow and scree between.
    float forestLine = uForestLine + (big.r - 0.5) * 18.0;
    float forest = smoothstep(forestLine + 4.0, forestLine - 4.0, y) * smoothstep(0.7, 0.35, slope) * smoothstep(0.32, 0.5, mid.g + big.a * 0.3);
    vec3 meadow = mix(vec3(0.16, 0.2, 0.07), vec3(0.24, 0.22, 0.1), big.a);
    float meadowAmt = smoothstep(forestLine + 16.0, forestLine, y) * smoothstep(0.6, 0.3, slope);
    vec3 base = mix(rock, meadow, meadowAmt * 0.8);
    float crowns = smoothstep(0.35, 0.75, fine.g);
    vec3 trees = uForest * mix(0.55, 1.15, crowns);
    base = mix(base, trees, forest);
    base = mix(base, uSnow * (0.92 + fine.b * 0.1), snow);
    // Light: direct sun, and sky light that is bluer in shadow.
    vec3 L = normalize(uSunDirW);
    float nd = dot(N, L);
    float sunAmt = clamp(nd, 0.0, 1.0);
    float cavity = mix(0.6, 1.0, smoothstep(0.2, 0.7, mid.r));
    vec3 lit = uSunColorW * sunAmt * (1.0 - forest * 0.25) + uSkyAmb * (0.55 + 0.45 * N.y) * cavity * 0.8;
    lit += uSunColorW * snow * pow(max(nd, 0.0), 2.0) * 0.12;
    vec3 col = base * lit / 3.14159;
    // Aerial perspective, scaled so this reads as kilometres of air.
    vec3 toFrag = vWorld - cameraPosition;
    float dist = length(toFrag);
    vec3 dir = toFrag / dist;
    float t = exp(-dist * uHaze * (0.6 + 0.4 * exp(-max(y, 0.0) * 0.012)));
    vec3 ins = skyRadiance(normalize(vec3(dir.x, max(dir.y, 0.0) * 0.4 + 0.02, dir.z)));
    col = col * t + ins * (1.0 - t);
    // The volcano's throat glows, more at night.
    float throat = smoothstep(0.9, 1.0, vH) * uLava;
    col += vec3(2.4, 0.75, 0.15) * throat * (0.6 + 0.4 * sin(vWorld.x * 0.4 + vWorld.z * 0.3));
    gl_FragColor = vec4(col, 1.0);
  }
`;

interface BackdropUniforms {
  uRock: { value: THREE.Color };
  uSnow: { value: THREE.Color };
  uForest: { value: THREE.Color };
  uSnowLine: { value: number };
  uForestLine: { value: number };
  uHaze: { value: number };
  uLava: { value: number };
  uScale: { value: number };
}

function makeBackdropMaterial(uniforms: BackdropUniforms) {
  const u = skyUniforms;
  return new THREE.ShaderMaterial({
    vertexShader: backdropVertex,
    fragmentShader: backdropFragment,
    uniforms: {
      ...(uniforms as unknown as Record<string, THREE.IUniform>),
      uSkyLut: u.uSkyLut,
      uCloudTex: u.uCloudTex,
      uAerial: u.uAerial,
      uCloudWind: u.uCloudWind,
      uCloudCover: u.uCloudCover,
      uCloudShadow: u.uCloudShadow,
      uSunDirW: u.uSunDirW,
      uSunColorW: u.uSunColorW,
      uSkyAmb: u.uSkyAmb,
    },
  });
}

function ridgeGeometry(width: number, depth: number, columns: number, rows: number, heightAt: (u: number, v: number) => number) {
  const positions: number[] = [];
  const hs: number[] = [];
  const indices: number[] = [];
  let maxH = 0;
  for (let r = 0; r <= rows; r++) {
    for (let c = 0; c <= columns; c++) {
      const u = c / columns;
      const v = r / rows;
      const h = heightAt(u, v);
      maxH = Math.max(maxH, h);
      positions.push((u - 0.5) * width, h, -v * depth);
      hs.push(h);
    }
  }
  for (let i = 0; i < hs.length; i++) hs[i] /= maxH;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < columns; c++) {
      const a = r * (columns + 1) + c;
      const b = a + columns + 1;
      indices.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("aH", new THREE.Float32BufferAttribute(hs, 1));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/** Mountain heights: ridged fractal noise, periodic in u so ranges wrap. */
function mountainHeight(offsets: [number, number][], u: number, v: number, scale: number) {
  const ridge = (x: number, y: number, seedA: number, seedB: number, freq: number) => {
    const val = tileFbm((x * freq + seedA) % 256, (y * freq * 0.5 + seedB) % 256, freq * 2, Math.max(2, freq), 3, 13);
    return 1 - Math.abs(val * 2 - 1);
  };
  const uu = u * 8;
  const base = ridge(uu, v * 3, offsets[0][0], offsets[0][1], 2);
  const detail = ridge(uu * 3, v * 6, offsets[1][0], offsets[1][1], 3);
  const fine = ridge(uu * 9, v * 12, offsets[2][0], offsets[2][1], 2);
  const shape = Math.pow(base, 1.6) * 0.8 + detail * 0.17 + fine * 0.06;
  const envelope = Math.sin(v * Math.PI) ** 0.7;
  return shape * envelope * scale;
}

function volcanoGeometry(height: number, radius: number) {
  const profile: THREE.Vector2[] = [];
  for (let i = 0; i <= 36; i++) {
    const t = i / 36;
    const y = Math.pow(t, 1.1) * height;
    const r = lerp(radius, radius * 0.1, Math.pow(t, 0.6)) + Math.sin(t * 30) * radius * 0.015 * (1 - t);
    profile.push(new THREE.Vector2(r, y));
  }
  // The crater: a lip, then down into the throat.
  profile.push(new THREE.Vector2(radius * 0.085, height * 0.985));
  profile.push(new THREE.Vector2(radius * 0.05, height * 0.93));
  const geo = new THREE.LatheGeometry(profile, 72);
  const count = geo.attributes.position.count;
  const hs = new Float32Array(count);
  const vp = geo.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    v.fromBufferAttribute(vp, i);
    const a = Math.atan2(v.z, v.x);
    const k = v.y / height;
    // Gullies cut by old lava flows, deeper low down.
    const gully = 1 + Math.sin(a * 9 + k * 4) * 0.045 * (1 - k) + Math.sin(a * 23 + k * 9) * 0.02 * (1 - k) + Math.sin(a * 3.0) * 0.03;
    vp.setXYZ(i, v.x * gully, v.y, v.z * gully);
    hs[i] = k;
  }
  geo.computeVertexNormals();
  geo.setAttribute("aH", new THREE.BufferAttribute(hs, 1));
  return geo;
}

/**
 * Volcanic smoke: a column of soft, self-shadowed billboards that rises,
 * spreads and drifts downwind, grey-brown ash low down and lit by the sun.
 */
export class SmokePlume {
  readonly mesh: THREE.Mesh;
  private material: THREE.ShaderMaterial;
  private geometry: THREE.InstancedBufferGeometry;

  constructor(options: { puffs?: number; height: number; width: number; speed?: number; low?: THREE.ColorRepresentation; high?: THREE.ColorRepresentation; opacity?: number }) {
    const puffs = options.puffs ?? 26;
    const base = new THREE.PlaneGeometry(1, 1);
    this.geometry = new THREE.InstancedBufferGeometry();
    this.geometry.setAttribute("position", base.getAttribute("position"));
    this.geometry.setAttribute("uv", base.getAttribute("uv"));
    this.geometry.setIndex(base.getIndex());
    const seeds = new Float32Array(puffs * 2);
    for (let i = 0; i < puffs; i++) {
      seeds[i * 2] = i / puffs;
      seeds[i * 2 + 1] = Math.random();
    }
    this.geometry.setAttribute("aSeed", new THREE.InstancedBufferAttribute(seeds, 2));
    this.geometry.instanceCount = puffs;
    const u = skyUniforms;
    this.material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: {
        uT: { value: 0 },
        uHeight: { value: options.height },
        uWidth: { value: options.width },
        uSpeed: { value: options.speed ?? 0.012 },
        uLow: { value: new THREE.Color(options.low ?? "#38332f") },
        uHigh: { value: new THREE.Color(options.high ?? "#9e9a9a") },
        uOpacity: { value: options.opacity ?? 0.55 },
        uLava: { value: 0 },
        uSkyLut: u.uSkyLut,
        uCloudTex: u.uCloudTex,
        uAerial: u.uAerial,
        uCloudWind: u.uCloudWind,
        uCloudCover: u.uCloudCover,
        uCloudShadow: u.uCloudShadow,
        uSunDirW: u.uSunDirW,
        uSunColorW: u.uSunColorW,
        uSkyAmb: u.uSkyAmb,
      },
      vertexShader: /* glsl */ `
        attribute vec2 aSeed;
        uniform float uT, uHeight, uWidth, uSpeed;
        varying vec2 vUv;
        varying float vAge;
        varying float vSeed;
        varying vec3 vCentre;
        varying vec3 vWorld;
        void main(){
          float age = fract(aSeed.x + uT * uSpeed);
          vAge = age;
          vSeed = aSeed.y;
          // Rises fast then slows and bends with the wind.
          float rise = (1.0 - exp(-age * 2.6)) / (1.0 - exp(-2.6));
          vec3 centre = vec3(age * age * uHeight * 0.9 + sin(age * 6.0 + aSeed.y * 9.0) * uWidth * 0.12 * age, rise * uHeight, sin(age * 4.0 + aSeed.y * 13.0) * uWidth * 0.18 * age);
          float size = uWidth * (0.35 + age * 1.5) * (0.8 + aSeed.y * 0.4);
          vec4 wc = modelMatrix * vec4(centre, 1.0);
          vCentre = wc.xyz;
          vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
          vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
          float spin = aSeed.y * 6.28 + uT * 0.02 * (aSeed.y - 0.5);
          vec2 p = position.xy;
          p = vec2(p.x * cos(spin) - p.y * sin(spin), p.x * sin(spin) + p.y * cos(spin));
          vec3 world = wc.xyz + (right * p.x + up * p.y) * size;
          vWorld = world;
          vUv = uv;
          gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec2 vUv;
        varying float vAge;
        varying float vSeed;
        varying vec3 vCentre;
        varying vec3 vWorld;
        uniform float uT, uLava, uOpacity;
        uniform vec3 uSunColorW, uSkyAmb, uLow, uHigh;
        ${GLSL_SKY}
        void main(){
          vec2 q = vUv * 2.0 - 1.0;
          float r = length(q);
          if (r > 1.0) discard;
          vec4 n = texture2D(uCloudTex, vUv * 0.55 + vec2(vSeed * 3.1, vSeed * 1.7) + uT * 0.003);
          vec4 n2 = texture2D(uCloudTex, vUv * 1.4 + vec2(vSeed * 7.3, uT * 0.006));
          float dens = smoothstep(1.0, 0.25, r + (n.r - 0.5) * 0.7 + (n2.g - 0.5) * 0.3);
          dens *= smoothstep(0.0, 0.06, vAge) * (1.0 - smoothstep(0.55, 1.0, vAge));
          if (dens < 0.01) discard;
          // A rounded puff: light from the sun side, dark ash underneath.
          vec3 normal = normalize(vec3(q, sqrt(max(0.0, 1.0 - r * r))));
          vec3 toCam = normalize(cameraPosition - vCentre);
          vec3 side = normalize(cross(vec3(0.0, 1.0, 0.0), toCam));
          vec3 up = cross(toCam, side);
          vec3 nW = normalize(side * normal.x + up * normal.y + toCam * normal.z);
          float lit = clamp(dot(nW, normalize(uSunDirW)) * 0.6 + 0.4, 0.0, 1.0) * (0.55 + n.b * 0.45);
          vec3 ash = mix(uLow, uHigh, smoothstep(0.05, 0.6, vAge));
          vec3 col = ash * (uSunColorW * lit * 0.32 + uSkyAmb * 0.32);
          col += vec3(1.6, 0.5, 0.12) * uLava * smoothstep(0.25, 0.0, vAge) * (1.0 - r) * 0.6;
          col = applyAerial(col, vWorld - cameraPosition);
          gl_FragColor = vec4(col, dens * uOpacity);
        }
      `,
    });
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
    base.dispose();
  }

  update(time: number, lava: number) {
    this.material.uniforms.uT.value = time;
    this.material.uniforms.uLava.value = lava;
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}

const PERIOD = 1400;

/** Everything far beyond the road. It parallaxes slowly and wraps endlessly. */
export class Backdrop {
  group = new THREE.Group();
  private mountainUniforms: BackdropUniforms;
  private hillUniforms: BackdropUniforms;
  private volcanoUniforms: BackdropUniforms;
  private mountains: THREE.Mesh[] = [];
  private hills: THREE.Mesh[] = [];
  private volcano: THREE.Mesh;
  private disposables: { dispose(): void }[] = [];
  private smoke: SmokePlume;

  constructor(sky: { sunDir: THREE.Vector3; sunColor: THREE.Color; horizon: THREE.Color }) {
    void sky;
    const rand = rng(77);
    const offsets = Array.from({ length: 6 }, () => [rand() * 7, rand() * 7] as [number, number]);
    const shared = (rock: string, snow: string, snowLine: number, forestLine: number, haze: number): BackdropUniforms => ({
      uRock: { value: new THREE.Color(rock) },
      uSnow: { value: new THREE.Color(snow) },
      uForest: { value: new THREE.Color("#1d3317") },
      uSnowLine: { value: snowLine },
      uForestLine: { value: forestLine },
      uHaze: { value: haze },
      uLava: { value: 0 },
      uScale: { value: 1 },
    });
    this.mountainUniforms = shared("#6e6a66", "#f4f7fb", 20, 6, 0.0021);
    this.hillUniforms = shared("#55603f", "#55603f", 1e5, 30, 0.0016);
    this.volcanoUniforms = shared("#4a4440", "#d7d9df", 1e5, -10, 0.0021);

    const mountainGeo = ridgeGeometry(PERIOD, 240, 360, 40, (u, v) => mountainHeight(offsets, u, v, 38) + 2);
    const mountainMaterial = makeBackdropMaterial(this.mountainUniforms);
    const hillGeo = ridgeGeometry(PERIOD, 150, 260, 22, (u, v) => {
      const uu = u * 12;
      const value = tileFbm(uu % 256, v * 3, 24, 8, 3, 3);
      return Math.pow(value, 1.5) * 16 * Math.sin(v * Math.PI) ** 0.8;
    });
    const hillMaterial = makeBackdropMaterial(this.hillUniforms);
    this.disposables.push(mountainGeo, mountainMaterial, hillGeo, hillMaterial);
    // Three copies wrap the range; frustum culling skips the ones off to the sides.
    mountainGeo.computeBoundingSphere();
    hillGeo.computeBoundingSphere();
    for (let i = -1; i <= 1; i++) {
      const mountain = new THREE.Mesh(mountainGeo, mountainMaterial);
      mountain.position.set(i * PERIOD, -4, -330);
      mountain.frustumCulled = true;
      this.group.add(mountain);
      this.mountains.push(mountain);
      const hill = new THREE.Mesh(hillGeo, hillMaterial);
      hill.position.set(i * PERIOD, -4, -165);
      hill.frustumCulled = true;
      this.group.add(hill);
      this.hills.push(hill);
    }

    // The volcano: a broad cone with a flat, glowing mouth and a plume of smoke.
    const volcanoMaterial = makeBackdropMaterial(this.volcanoUniforms);
    const volcanoGeo = volcanoGeometry(48, 125);
    this.volcano = new THREE.Mesh(volcanoGeo, volcanoMaterial);
    this.volcano.position.set(160, -4, -300);
    this.volcano.frustumCulled = false;
    this.group.add(this.volcano);
    this.disposables.push(volcanoGeo, volcanoMaterial);
    this.smoke = new SmokePlume({ height: 95, width: 26 });
    this.smoke.mesh.position.set(0, 45, 0);
    this.volcano.add(this.smoke.mesh);
    this.disposables.push(this.smoke);
  }

  update(cameraX: number, night: number, time: number, horizon: THREE.Color) {
    void horizon;
    const parallax = 0.08;
    const offset = cameraX * parallax;
    const wrapped = ((offset % PERIOD) + PERIOD) % PERIOD;
    const anchor = cameraX - wrapped;
    this.mountains.forEach((m, i) => m.position.setX(anchor + (i - 1) * PERIOD));
    const hillOffset = cameraX * 0.22;
    const hillWrap = ((hillOffset % PERIOD) + PERIOD) % PERIOD;
    this.hills.forEach((m, i) => m.position.setX(cameraX - hillWrap + (i - 1) * PERIOD));
    const volcanoX = anchor + 160 + (wrapped > PERIOD / 2 ? PERIOD : 0);
    this.volcano.position.x = volcanoX;
    this.volcanoUniforms.uLava.value = 0.25 + night * 1.1;
    this.smoke.update(time, 0.15 + night * 0.85);
  }

  dispose() {
    for (const item of this.disposables) item.dispose();
  }
}

/**
 * The race's horizon: a ring of snowy ranges and forested hills around the
 * runners, the volcano ahead with its smoke. It follows the camera, as land
 * that far away would hardly move during a race.
 */
export class MountainRing {
  readonly group = new THREE.Group();
  private hills: THREE.Mesh;
  private smoke: SmokePlume;
  private volcanoUniforms: BackdropUniforms;
  private disposables: { dispose(): void }[] = [];

  constructor() {
    const rand = rng(5);
    const offsets = Array.from({ length: 6 }, () => [rand() * 7, rand() * 7] as [number, number]);
    const ring = (radius: number, depth: number, segments: number, rows: number, heightAt: (u: number, v: number) => number) => {
      const positions: number[] = [];
      const hs: number[] = [];
      const indices: number[] = [];
      let maxH = 0;
      for (let r = 0; r <= rows; r++) {
        for (let c = 0; c <= segments; c++) {
          const u = c / segments;
          const v = r / rows;
          const a = u * TAU;
          const h = heightAt(u, v);
          maxH = Math.max(maxH, h);
          const rr = radius + v * depth;
          positions.push(Math.cos(a) * rr, h, Math.sin(a) * rr);
          hs.push(h);
        }
      }
      for (let i = 0; i < hs.length; i++) hs[i] /= Math.max(1e-3, maxH);
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < segments; c++) {
          const a = r * (segments + 1) + c;
          const b = a + segments + 1;
          indices.push(a, b, a + 1, a + 1, b, b + 1);
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
      g.setAttribute("aH", new THREE.Float32BufferAttribute(hs, 1));
      g.setIndex(indices);
      g.computeVertexNormals();
      return g;
    };
    const mountainU: BackdropUniforms = {
      uRock: { value: new THREE.Color("#6e6a66") },
      uSnow: { value: new THREE.Color("#f4f7fb") },
      uForest: { value: new THREE.Color("#1d3317") },
      uSnowLine: { value: 46 },
      uForestLine: { value: 18 },
      uHaze: { value: 0.0016 },
      uLava: { value: 0 },
      uScale: { value: 0.6 },
    };
    const hillU: BackdropUniforms = { ...mountainU, uRock: { value: new THREE.Color("#55603f") }, uSnowLine: { value: 1e5 }, uForestLine: { value: 40 }, uHaze: { value: 0.0013 }, uScale: { value: 1 } };
    this.volcanoUniforms = { ...mountainU, uRock: { value: new THREE.Color("#4a4440") }, uSnowLine: { value: 1e5 }, uForestLine: { value: -10 }, uLava: { value: 0.2 } };
    const mountainGeo = ring(760, 110, 360, 14, (u, v) => {
      const h = mountainHeight(offsets, u, 0.2 + v * 0.6, 120);
      // Lower behind the start line so the valley opens up there.
      const ahead = 0.55 + 0.45 * Math.max(0, -Math.sin(u * TAU));
      return h * ahead * smooth(0, 0.3, v) - 12;
    });
    const hillGeo = ring(430, 90, 240, 8, (u, v) => {
      const value = tileFbm((u * 24) % 256, v * 3, 24, 8, 3, 3);
      return Math.pow(value, 1.4) * 34 * Math.sin(v * Math.PI) ** 0.7 - 3;
    });
    const mountainMat = makeBackdropMaterial(mountainU);
    const hillMat = makeBackdropMaterial(hillU);
    const mountains = new THREE.Mesh(mountainGeo, mountainMat);
    this.hills = new THREE.Mesh(hillGeo, hillMat);
    mountains.frustumCulled = false;
    this.hills.frustumCulled = false;
    this.group.add(mountains, this.hills);
    const volcanoGeo = volcanoGeometry(150, 300);
    const volcanoMat = makeBackdropMaterial(this.volcanoUniforms);
    const volcano = new THREE.Mesh(volcanoGeo, volcanoMat);
    volcano.position.set(330, -8, -720);
    volcano.frustumCulled = false;
    this.group.add(volcano);
    this.smoke = new SmokePlume({ height: 300, width: 70, puffs: 30 });
    this.smoke.mesh.position.set(0, 142, 0);
    volcano.add(this.smoke.mesh);
    this.disposables.push(mountainGeo, hillGeo, mountainMat, hillMat, volcanoGeo, volcanoMat, this.smoke);
  }

  update(centreX: number, centreZ: number, time: number, night: number) {
    this.group.position.set(centreX, 0, centreZ);
    this.smoke.update(time, 0.15 + night * 0.85);
    this.volcanoUniforms.uLava.value = 0.2 + night;
  }

  dispose() {
    for (const item of this.disposables) item.dispose();
  }
}
