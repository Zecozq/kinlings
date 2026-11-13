// Plants shared by the valley and the race course: trees of several species
// grown from real trunks, limbs and roots with leaf clusters on the ends, wind
// animated meadow grass with gusts rolling through it, wildflowers and clover.
// Everything is instanced and generated here; nothing is downloaded.

import * as THREE from "three";
import { TAU, clamp, dataTexture, lerp, normalMapFromHeight, perlin2, perlinFbm, rng, smooth } from "./gfx.ts";
import { patchSky } from "./atmosphere.ts";

/** One value for every plant's wind shader. */
export const windTime = { value: 0 };
/** Scales the sway of grass and flowers. */
export const grassWindStrength = { value: 1 };

const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

// ----- Textures --------------------------------------------------------------

let atlasTex: THREE.DataTexture | null = null;

/** Leaf atlas, four 512² cells: broad leaves, small birch leaves, conifer sprigs, glossy shrub leaves. */
export function leafCardTexture(): THREE.DataTexture {
  if (atlasTex) return atlasTex;
  const size = 1024;
  const cell = 512;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const rand = rng(44);
  const hsl = (h: number, s: number, l: number, a = 1) => `hsla(${h},${clamp(s, 0, 100)}%,${clamp(l, 0, 100)}%,${a})`;

  const leaf = (x: number, y: number, angle: number, length: number, width: number, h: number, s: number, l: number, pointed = 1) => {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.bezierCurveTo(width, -length * 0.22, width * 0.95, -length * (0.75 - 0.1 * pointed), 0, -length);
    ctx.bezierCurveTo(-width * 0.95, -length * (0.75 - 0.1 * pointed), -width, -length * 0.22, 0, 0);
    const g = ctx.createLinearGradient(-width, 0, width, 0);
    g.addColorStop(0, hsl(h, s, l * 0.78));
    g.addColorStop(0.45, hsl(h + 2, s, l * 1.12));
    g.addColorStop(0.55, hsl(h + 2, s, l * 1.05));
    g.addColorStop(1, hsl(h - 3, s, l * 0.7));
    ctx.fillStyle = g;
    ctx.fill();
    ctx.strokeStyle = hsl(h + 8, s * 0.5, l * 1.6, 0.5);
    ctx.lineWidth = Math.max(1, width * 0.09);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, -length * 0.93);
    ctx.stroke();
    ctx.lineWidth = Math.max(0.6, width * 0.045);
    ctx.strokeStyle = hsl(h + 6, s * 0.55, l * 1.35, 0.35);
    for (let k = 1; k <= 4; k++) {
      const yk = -length * (0.18 + k * 0.17);
      for (const side of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(0, yk);
        ctx.quadraticCurveTo(side * width * 0.4, yk - length * 0.06, side * width * 0.72, yk - length * 0.13);
        ctx.stroke();
      }
    }
    ctx.restore();
  };
  const twig = (points: [number, number][], width: number, color: string) => {
    ctx.strokeStyle = color;
    ctx.lineCap = "round";
    ctx.lineWidth = width;
    ctx.beginPath();
    points.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    ctx.stroke();
  };

  // Cell 0: a twig of broad leaves (oak, lime, beech).
  {
    const ox = 0;
    const oy = 0;
    const tips: [number, number][] = [];
    for (let b = 0; b < 7; b++) {
      const a = -Math.PI / 2 + (b - 3) * 0.42 + (rand() - 0.5) * 0.2;
      const len = cell * (0.28 + rand() * 0.14);
      const sx = ox + cell / 2 + (rand() - 0.5) * 30;
      const sy = oy + cell * 0.92 - b * 16;
      const ex = sx + Math.cos(a) * len;
      const ey = sy + Math.sin(a) * len;
      twig([[sx, sy], [(sx + ex) / 2 + (rand() - 0.5) * 20, (sy + ey) / 2], [ex, ey]], 5, "#5b4630");
      tips.push([ex, ey]);
    }
    for (let i = 0; i < 150; i++) {
      const [tx, ty] = tips[i % tips.length];
      const r = Math.sqrt(rand()) * cell * 0.26;
      const a = rand() * TAU;
      const x = clamp(tx + Math.cos(a) * r, ox + 44, ox + cell - 44);
      const y = clamp(ty + Math.sin(a) * r, oy + 44, oy + cell - 36);
      leaf(x, y, a + Math.PI / 2 + (rand() - 0.5) * 0.8, 56 + rand() * 28, 18 + rand() * 8, 88 + rand() * 22, 42 + rand() * 18, 20 + rand() * 14);
    }
  }
  // Cell 1: small pointed birch leaves on drooping twigs.
  {
    const ox = cell;
    const oy = 0;
    for (let b = 0; b < 6; b++) {
      const sx = ox + 80 + b * 70 + rand() * 20;
      const sy = oy + 40 + rand() * 30;
      const pts: [number, number][] = [];
      for (let k = 0; k <= 6; k++) pts.push([sx + Math.sin(k * 0.6 + b) * 18, sy + k * 70]);
      twig(pts, 2.5, "#4a3a2a");
      for (let k = 0; k < 34; k++) {
        const t = rand();
        const px = sx + Math.sin(t * 6 * 0.6 + b) * 18;
        const py = sy + t * 420;
        const side = rand() > 0.5 ? 1 : -1;
        leaf(px + side * (6 + rand() * 18), py, side * (0.9 + rand() * 0.9) + Math.PI, 36 + rand() * 16, 14 + rand() * 5, 78 + rand() * 18, 48 + rand() * 18, 28 + rand() * 13, 1.6);
      }
    }
  }
  // Cell 2: conifer sprig, dense needles along a branching twig.
  {
    const ox = 0;
    const oy = cell;
    const needles = (x0: number, y0: number, x1: number, y1: number, length: number) => {
      const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 3.2);
      const a = Math.atan2(y1 - y0, x1 - x0);
      for (let s = 0; s < steps; s++) {
        const t = s / steps;
        const x = lerp(x0, x1, t);
        const y = lerp(y0, y1, t);
        const l = length * (0.55 + 0.45 * Math.sin(Math.PI * Math.min(1, t * 1.2 + 0.1)));
        for (const side of [-1, 1]) {
          for (const lean of [0.75, 1.25]) {
            const na = a + side * (lean + rand() * 0.25);
            const light = 13 + rand() * 12 + (t > 0.82 ? 10 : 0);
            ctx.strokeStyle = hsl(148 + rand() * 20, 28 + rand() * 18, light);
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.moveTo(x, y);
            ctx.lineTo(x + Math.cos(na) * l, y + Math.sin(na) * l);
            ctx.stroke();
          }
        }
      }
    };
    // A fan of twigs filling the cell, as a spruce branch seen from above.
    for (let main = 0; main < 3; main++) {
      const x0 = ox + 40 + main * 30;
      const y0 = oy + cell - 50 - main * 130;
      const x1 = ox + cell - 50;
      const y1 = oy + 60 + main * 120;
      twig([[x0, y0], [x1, y1]], 4, "#5a3e28");
      for (let b = 0; b < 7; b++) {
        const t = 0.1 + b * 0.12;
        const sx = lerp(x0, x1, t);
        const sy = lerp(y0, y1, t);
        const side = b % 2 ? 1 : -1;
        const ex = clamp(sx + side * (60 + rand() * 50) + 35, ox + 30, ox + cell - 30);
        const ey = clamp(sy + side * (55 + rand() * 40) - 35, oy + 30, oy + cell - 30);
        twig([[sx, sy], [ex, ey]], 2.5, "#5a3e28");
        needles(sx, sy, ex, ey, 26);
      }
      needles(x0, y0, x1, y1, 34);
    }
  }
  // Cell 3: glossy, darker shrub leaves (hawthorn, laurel, hedge).
  {
    const ox = cell;
    const oy = cell;
    for (let i = 0; i < 95; i++) {
      const a = rand() * TAU;
      const r = Math.sqrt(rand()) * cell * 0.38;
      leaf(ox + cell / 2 + Math.cos(a) * r, oy + cell / 2 + Math.sin(a) * r, a + Math.PI / 2 + (rand() - 0.5), 62 + rand() * 30, 22 + rand() * 9, 95 + rand() * 25, 35 + rand() * 18, 17 + rand() * 12, 0.6);
    }
  }

  // Give transparent texels the average leaf colour of their cell, so mipmaps
  // fade towards green instead of black at the edges.
  const image = ctx.getImageData(0, 0, size, size);
  const data = image.data;
  for (let cy = 0; cy < 2; cy++) {
    for (let cx = 0; cx < 2; cx++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let y = cy * cell; y < (cy + 1) * cell; y += 2) {
        for (let x = cx * cell; x < (cx + 1) * cell; x += 2) {
          const i = (y * size + x) * 4;
          if (data[i + 3] > 200) {
            r += data[i];
            g += data[i + 1];
            b += data[i + 2];
            n++;
          }
        }
      }
      if (n === 0) continue;
      for (let y = cy * cell; y < (cy + 1) * cell; y++) {
        for (let x = cx * cell; x < (cx + 1) * cell; x++) {
          const i = (y * size + x) * 4;
          if (data[i + 3] < 128) {
            data[i] = r / n;
            data[i + 1] = g / n;
            data[i + 2] = b / n;
          }
        }
      }
    }
  }
  atlasTex = coverageMipTexture(new Uint8Array(data.buffer.slice(0)), size, 2, ALPHA_TEST);
  return atlasTex;
}

const ALPHA_TEST = 0.42;

/**
 * Mipmaps that keep the same share of texels above the alpha-test threshold at
 * every level, per atlas cell, so distant trees stay as leafy as near ones.
 */
function coverageMipTexture(base: Uint8Array, size: number, cells: number, threshold: number): THREE.DataTexture {
  const levels: { data: Uint8Array; width: number; height: number }[] = [{ data: base, width: size, height: size }];
  const cut = threshold * 255;
  const coverage = (data: Uint8Array, w: number, cx: number, cy: number, scale: number) => {
    const cw = w / cells;
    let n = 0;
    for (let y = cy * cw; y < (cy + 1) * cw; y++) for (let x = cx * cw; x < (cx + 1) * cw; x++) if (data[(y * w + x) * 4 + 3] * scale > cut) n++;
    return n / (cw * cw);
  };
  const targets: number[] = [];
  for (let cy = 0; cy < cells; cy++) for (let cx = 0; cx < cells; cx++) targets.push(coverage(base, size, cx, cy, 1));
  let prev = base;
  let w = size;
  while (w > 1) {
    const nw = w >> 1;
    const next = new Uint8Array(nw * nw * 4);
    for (let y = 0; y < nw; y++) {
      for (let x = 0; x < nw; x++) {
        for (let c = 0; c < 4; c++) {
          const a = prev[((y * 2) * w + x * 2) * 4 + c];
          const b = prev[((y * 2) * w + x * 2 + 1) * 4 + c];
          const d = prev[((y * 2 + 1) * w + x * 2) * 4 + c];
          const e = prev[((y * 2 + 1) * w + x * 2 + 1) * 4 + c];
          next[(y * nw + x) * 4 + c] = (a + b + d + e) >> 2;
        }
      }
    }
    if (nw / cells >= 2) {
      for (let cy = 0; cy < cells; cy++) {
        for (let cx = 0; cx < cells; cx++) {
          const target = targets[cy * cells + cx];
          let lo = 1;
          let hi = 6;
          for (let it = 0; it < 12; it++) {
            const mid = (lo + hi) / 2;
            if (coverage(next, nw, cx, cy, mid) < target) lo = mid;
            else hi = mid;
          }
          const scale = (lo + hi) / 2;
          const cw = nw / cells;
          for (let y = cy * cw; y < (cy + 1) * cw; y++) for (let x = cx * cw; x < (cx + 1) * cw; x++) {
            const i = (y * nw + x) * 4 + 3;
            next[i] = Math.min(255, Math.round(next[i] * scale));
          }
        }
      }
    }
    levels.push({ data: next, width: nw, height: nw });
    prev = next;
    w = nw;
  }
  const texture = new THREE.DataTexture(base as Uint8Array<ArrayBuffer>, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.mipmaps = levels as unknown as THREE.DataTexture["mipmaps"];
  texture.generateMipmaps = false;
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.anisotropy = 8;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/** UV origin of an atlas cell (no flip: v follows the canvas downwards). */
const CELL_UV: [number, number][] = [
  [0, 0],
  [0.5, 0],
  [0, 0.5],
  [0.5, 0.5],
];

interface BarkMaps {
  map: THREE.DataTexture;
  normal: THREE.DataTexture;
}
const barkCache = new Map<string, BarkMaps>();

/** Furrowed bark (oak, lime, spruce) or white birch bark with dark lenticels. */
function barkMaps(kind: "rough" | "birch"): BarkMaps {
  const cached = barkCache.get(kind);
  if (cached) return cached;
  const size = 256;
  const height = new Float32Array(size * size);
  const color = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      const i = y * size + x;
      let h: number;
      let r: number;
      let g: number;
      let b: number;
      if (kind === "rough") {
        // Long vertical ridges broken into plates, with deep fissures between.
        const warp = perlin2(u * 4, v * 2, 4, 2, 5) * 0.08;
        const ridge = 1 - Math.abs(perlin2((u + warp) * 10, v * 1.5, 10, 2, 9));
        const plates = perlinFbm(u * 8, v * 4, 8, 4, 3, 21);
        const cross = 1 - Math.pow(Math.abs(perlin2(u * 6, v * 14, 6, 14, 33)), 0.6) * 0.35;
        h = clamp(Math.pow(ridge, 2.2) * 0.75 + plates * 0.3) * cross;
        const lichen = smooth(0.62, 0.78, perlinFbm(u * 5, v * 5, 5, 5, 3, 41)) * smooth(0.35, 0.6, h);
        const base = 0.32 + h * 0.5;
        r = base * 108;
        g = base * 92;
        b = base * 76;
        r = lerp(r, 150, lichen * 0.55);
        g = lerp(g, 160, lichen * 0.55);
        b = lerp(b, 120, lichen * 0.55);
      } else {
        // Smooth white bark, papery bands, dark lenticels and black fissures low down.
        const band = perlinFbm(u * 2, v * 16, 2, 16, 3, 7);
        const lent = smooth(0.72, 0.86, 1 - Math.abs(perlin2(u * 3, v * 40, 3, 40, 13))) * smooth(0.45, 0.65, perlinFbm(u * 6, v * 10, 6, 10, 2, 19));
        const scar = smooth(0.68, 0.82, perlinFbm(u * 4, v * 5, 4, 5, 3, 29));
        h = 0.6 + band * 0.25 - lent * 0.35 - scar * 0.3;
        const white = 0.78 + band * 0.2;
        const dark = Math.max(lent, scar);
        r = lerp(white * 236, 40, dark);
        g = lerp(white * 232, 36, dark);
        b = lerp(white * 222, 34, dark);
      }
      height[i] = h;
      color[i * 4] = clamp(r, 0, 255);
      color[i * 4 + 1] = clamp(g, 0, 255);
      color[i * 4 + 2] = clamp(b, 0, 255);
      color[i * 4 + 3] = 255;
    }
  }
  const maps = { map: dataTexture(color, size, size, true, 8), normal: normalMapFromHeight(height, size, kind === "rough" ? 6 : 2.5, undefined, 8, true) };
  barkCache.set(kind, maps);
  return maps;
}

// ----- Geometry building ---------------------------------------------------------

class Mesher {
  pos: number[] = [];
  nor: number[] = [];
  uv: number[] = [];
  col: number[] = [];
  aux: number[] = [];
  idx: number[] = [];
  get count() {
    return this.pos.length / 3;
  }
  v(p: THREE.Vector3, n: THREE.Vector3, u: number, w: number, c: THREE.Color, aux = 0) {
    this.pos.push(p.x, p.y, p.z);
    this.nor.push(n.x, n.y, n.z);
    this.uv.push(u, w);
    this.col.push(c.r, c.g, c.b);
    this.aux.push(aux);
    return this.count - 1;
  }
  build(auxName = "aWind") {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute("color", new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute(auxName, new THREE.Float32BufferAttribute(this.aux, 1));
    g.setIndex(this.count > 65000 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    return g;
  }
}

/** A tapered tube along a smooth path, with bark UVs in metres. */
function tube(m: Mesher, points: THREE.Vector3[], radius: (t: number) => number, sides: number, steps: number, color: (t: number, p: THREE.Vector3) => THREE.Color, uTiles = 2) {
  const curve = new THREE.CatmullRomCurve3(points, false, "centripetal");
  const pts = curve.getSpacedPoints(steps);
  let normal = new THREE.Vector3();
  const tangent = new THREE.Vector3();
  const binormal = new THREE.Vector3();
  let length = 0;
  const start = m.count;
  for (let i = 0; i <= steps; i++) {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(steps, i + 1)];
    tangent.copy(b).sub(a).normalize();
    if (i === 0) {
      const up = Math.abs(tangent.y) < 0.9 ? v3(0, 1, 0) : v3(1, 0, 0);
      normal = up.sub(tangent.clone().multiplyScalar(up.dot(tangent))).normalize();
    } else {
      normal.sub(tangent.clone().multiplyScalar(normal.dot(tangent))).normalize();
      length += pts[i].distanceTo(pts[i - 1]);
    }
    binormal.crossVectors(tangent, normal);
    const t = i / steps;
    const r = radius(t);
    const c = color(t, pts[i]);
    for (let s = 0; s <= sides; s++) {
      const ang = (s / sides) * TAU;
      const dir = normal.clone().multiplyScalar(Math.cos(ang)).addScaledVector(binormal, Math.sin(ang));
      m.v(pts[i].clone().addScaledVector(dir, r), dir, (s / sides) * uTiles, length / 1.1, c);
    }
  }
  for (let i = 0; i < steps; i++) {
    for (let s = 0; s < sides; s++) {
      const a = start + i * (sides + 1) + s;
      const b = a + sides + 1;
      m.idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
}

interface Limb {
  pts: THREE.Vector3[];
  r0: number;
  r1: number;
  flare?: boolean;
}
interface Cluster {
  c: THREE.Vector3;
  r: number;
}
interface Plan {
  limbs: Limb[];
  clusters: Cluster[];
  /** Conifer branches carry needle sprigs directly. */
  sprigs: { from: THREE.Vector3; to: THREE.Vector3; size: number }[];
  cell: number;
  cards: number;
  cardSize: number;
  tint: THREE.Color;
  bark: "rough" | "birch";
  barkTint: THREE.Color;
}

/** Spreading oak (0), tall round lime (1), spruce (2), birch (3) and a shrub (4). */
function planTree(species: number, seed: number): Plan {
  const rand = rng(seed * 7919 + species * 131);
  const limbs: Limb[] = [];
  const clusters: Cluster[] = [];
  const sprigs: Plan["sprigs"] = [];
  const dirAt = (az: number, el: number) => v3(Math.cos(az) * Math.cos(el), Math.sin(el), Math.sin(az) * Math.cos(el));
  const roots = (count: number, r0: number, reach: number) => {
    for (let i = 0; i < count; i++) {
      const az = (i / count) * TAU + rand() * 0.5;
      const d = dirAt(az, 0);
      const len = reach * (0.7 + rand() * 0.5);
      limbs.push({ pts: [v3(d.x * 0.05, 0.42, d.z * 0.05), v3(d.x * len * 0.35, 0.12, d.z * len * 0.35), v3(d.x * len, -0.14, d.z * len)], r0, r1: 0.025 });
    }
  };

  if (species === 0 || species === 1) {
    const oak = species === 0;
    const H = oak ? 2.5 + rand() * 0.5 : 3.3 + rand() * 0.5;
    const lean = v3((rand() - 0.5) * 0.3, 0, (rand() - 0.5) * 0.3);
    const top = v3(lean.x, H, lean.z);
    limbs.push({ pts: [v3(0, -0.25, 0), v3(lean.x * 0.3, H * 0.5, lean.z * 0.3), top], r0: oak ? 0.36 : 0.3, r1: 0.19, flare: true });
    roots(5, oak ? 0.17 : 0.14, oak ? 1.3 : 1.0);
    const count = oak ? 6 : 5;
    for (let i = 0; i < count; i++) {
      const az = (i / count) * TAU + rand() * 0.6;
      const el = oak ? 0.35 + rand() * 0.45 : 0.75 + rand() * 0.4;
      const len = oak ? 2.3 + rand() * 1.0 : 1.9 + rand() * 0.8;
      const start = top.clone().lerp(v3(0, H * 0.82, 0), rand() * 0.5);
      const d = dirAt(az, el);
      const end = start.clone().addScaledVector(d, len).add(v3(0, len * 0.25, 0));
      const mid = start.clone().lerp(end, 0.5).add(v3(0, 0.18, 0));
      limbs.push({ pts: [start, mid, end], r0: oak ? 0.15 : 0.12, r1: 0.04 });
      clusters.push({ c: end.clone().add(v3(0, 0.35, 0)), r: (oak ? 1.35 : 1.2) + rand() * 0.35 });
      clusters.push({ c: mid.clone().addScaledVector(d, 0.2).add(v3(0, 0.75, 0)), r: 1.0 + rand() * 0.3 });
      for (let k = 0; k < 2; k++) {
        const az2 = az + (k ? 0.7 : -0.7) + (rand() - 0.5) * 0.4;
        const d2 = dirAt(az2, el + 0.35);
        const s2 = mid.clone().lerp(end, 0.3 + rand() * 0.4);
        const e2 = s2.clone().addScaledVector(d2, 1.0 + rand() * 0.7);
        limbs.push({ pts: [s2, s2.clone().lerp(e2, 0.5).add(v3(0, 0.12, 0)), e2], r0: 0.06, r1: 0.02 });
        clusters.push({ c: e2.clone().add(v3(0, 0.25, 0)), r: 0.85 + rand() * 0.3 });
      }
    }
    clusters.push({ c: v3(lean.x, H + (oak ? 2.9 : 3.8), lean.z), r: oak ? 1.5 : 1.55 });
    if (!oak) clusters.push({ c: v3(lean.x * 0.5, H + 5.2, lean.z * 0.5), r: 1.15 });
    return {
      limbs,
      clusters,
      sprigs,
      cell: 0,
      cards: oak ? 380 : 360,
      cardSize: oak ? 0.68 : 0.64,
      tint: oak ? new THREE.Color("#c9d7a8") : new THREE.Color("#d6e2a6"),
      bark: "rough",
      barkTint: oak ? new THREE.Color("#b9aa98") : new THREE.Color("#a9a29a"),
    };
  }

  if (species === 2) {
    // Spruce: a straight stem and whorls of drooping branches, smaller upwards.
    const H = 9.5 + rand() * 2;
    limbs.push({ pts: [v3(0, -0.25, 0), v3(0, H * 0.5, 0), v3(0, H, 0)], r0: 0.27, r1: 0.03, flare: true });
    roots(4, 0.12, 0.8);
    let az = rand() * TAU;
    for (let y = 1.0; y < H - 0.35; y += 0.55 + rand() * 0.1) {
      const k = y / H;
      const reach = 2.5 * Math.pow(1 - k, 0.95) + 0.3;
      const per = k > 0.8 ? 4 : 5;
      for (let b = 0; b < per; b++) {
        az += 2.39996;
        const d = dirAt(az, -0.12 + k * 0.25);
        const from = v3(0, y, 0);
        const to = from.clone().addScaledVector(d, reach).add(v3(0, -reach * 0.18, 0));
        if (k < 0.75 && b % 2 === 0) limbs.push({ pts: [from, from.clone().lerp(to, 0.55).add(v3(0, -0.05, 0)), to.clone().add(v3(0, 0.12, 0))], r0: 0.045 * (1 - k) + 0.015, r1: 0.01 });
        sprigs.push({ from, to, size: 0.55 + reach * 0.22 });
      }
    }
    return { limbs, clusters, sprigs, cell: 2, cards: 0, cardSize: 0.5, tint: new THREE.Color("#b8c9b2"), bark: "rough", barkTint: new THREE.Color("#9c7d6b") };
  }

  if (species === 3) {
    // Birch: a slender, slightly crooked white stem with light hanging crowns.
    const H = 6.8 + rand() * 1.4;
    const bendX = (rand() - 0.5) * 0.6;
    limbs.push({ pts: [v3(0, -0.2, 0), v3(bendX * 0.4, H * 0.4, 0.1), v3(bendX, H * 0.75, -0.05), v3(bendX * 0.8, H, 0)], r0: 0.17, r1: 0.04, flare: true });
    roots(4, 0.08, 0.6);
    for (let i = 0; i < 9; i++) {
      const y = H * (0.4 + i * 0.065);
      const az = i * 2.4 + rand() * 0.5;
      const len = 1.3 + rand() * 1.1 * (1 - i / 12);
      const start = v3(bendX * (y / H), y, 0);
      const d = dirAt(az, 0.6 + rand() * 0.35);
      const end = start.clone().addScaledVector(d, len);
      const droop = end.clone().add(v3(d.x * 0.4, -0.35, d.z * 0.4));
      limbs.push({ pts: [start, end, droop], r0: 0.045, r1: 0.012 });
      clusters.push({ c: end.clone().add(v3(0, -0.1, 0)), r: 0.75 + rand() * 0.3 });
      clusters.push({ c: droop.clone().add(v3(0, -0.15, 0)), r: 0.6 + rand() * 0.2 });
    }
    clusters.push({ c: v3(bendX * 0.8, H + 0.7, 0), r: 0.85 });
    return { limbs, clusters, sprigs, cell: 1, cards: 320, cardSize: 0.52, tint: new THREE.Color("#e4ecb0"), bark: "birch", barkTint: new THREE.Color("#ffffff") };
  }

  // Shrub: clusters sitting on the ground around a few stems.
  for (let i = 0; i < 5; i++) {
    const az = (i / 5) * TAU + rand();
    const r = i === 0 ? 0 : 0.45 + rand() * 0.15;
    clusters.push({ c: v3(Math.cos(az) * r, 0.5 + rand() * 0.25 + (i === 0 ? 0.2 : 0), Math.sin(az) * r), r: i === 0 ? 0.72 : 0.5 + rand() * 0.15 });
  }
  return { limbs, clusters, sprigs, cell: 3, cards: 120, cardSize: 0.36, tint: new THREE.Color("#c4d2a0"), bark: "rough", barkTint: new THREE.Color("#a09080") };
}

const geometryCache = new Map<string, { canopy: THREE.BufferGeometry; trunk: THREE.BufferGeometry | null; plan: Plan }>();

/** Builds (once) the trunk and canopy of one species at a detail level. */
function treeGeometry(species: number, lowDetail: boolean) {
  const key = `${species}:${lowDetail ? 1 : 0}`;
  const cached = geometryCache.get(key);
  if (cached) return cached;
  const plan = planTree(species, 1 + species);
  const detail = lowDetail ? 0.5 : 1;

  // Wood: trunk, limbs and roots, darker and mossier near the ground.
  let trunk: THREE.BufferGeometry | null = null;
  if (plan.limbs.length > 0) {
    const m = new Mesher();
    const color = new THREE.Color();
    plan.limbs.forEach((limb, index) => {
      // Far trees keep the trunk and main limbs; roots and twigs are only for near ones.
      if (lowDetail && index > 0 && (limb.r0 < 0.07 || limb.pts[limb.pts.length - 1].y < 0.2)) return;
      const length = limb.pts.reduce((sum, p, i) => (i ? sum + p.distanceTo(limb.pts[i - 1]) : 0), 0);
      const sides = index === 0 ? (lowDetail ? 7 : 10) : limb.r0 > 0.1 ? 6 : 4;
      const steps = Math.max(2, Math.round(length * (index === 0 ? 1.6 : 1.1) * detail));
      tube(
        m,
        limb.pts,
        (t) => {
          const base = lerp(limb.r0, limb.r1, Math.pow(t, 0.8));
          return limb.flare ? base * (1 + 0.55 * Math.exp(-t * 14)) : base;
        },
        sides,
        steps,
        (_t, p) => {
          const ground = smooth(1.2, 0.0, p.y);
          return color.copy(plan.barkTint).multiplyScalar(lerp(1, 0.55, ground)).lerp(new THREE.Color("#5f6b3a"), ground * 0.35 * (plan.bark === "birch" ? 0.3 : 1));
        },
        Math.max(1, Math.round((limb.r0 * TAU) / 0.5)),
      );
    });
    trunk = m.build("aWind");
  }

  // Leaves: cards in each cluster, normals bent outwards for soft volume.
  const m = new Mesher();
  const rand = rng(species * 97 + (lowDetail ? 5 : 0));
  const [cu, cv] = CELL_UV[plan.cell];
  const tint = new THREE.Color();
  const centre = new THREE.Vector3();
  let minY = Infinity;
  let maxY = -Infinity;
  for (const c of plan.clusters) {
    centre.add(c.c);
    minY = Math.min(minY, c.c.y - c.r);
    maxY = Math.max(maxY, c.c.y + c.r);
  }
  if (plan.clusters.length) centre.multiplyScalar(1 / plan.clusters.length);
  const card = (p: THREE.Vector3, facing: THREE.Vector3, shade: THREE.Vector3, size: number, ao: number, wind: number, stretch = 1) => {
    const up = Math.abs(facing.y) > 0.95 ? v3(1, 0, 0) : v3(0, 1, 0);
    const t1 = new THREE.Vector3().crossVectors(up, facing).normalize();
    const t2 = new THREE.Vector3().crossVectors(facing, t1);
    const roll = rand() * TAU;
    const a = t1.clone().multiplyScalar(Math.cos(roll)).addScaledVector(t2, Math.sin(roll)).multiplyScalar(size * stretch);
    const b = new THREE.Vector3().crossVectors(facing, a).normalize().multiplyScalar(size);
    const hue = 0.92 + rand() * 0.16;
    tint.copy(plan.tint).multiplyScalar(ao).multiply(new THREE.Color(hue, 1, 2 - hue));
    const n = shade.clone().normalize();
    const base = m.count;
    m.v(p.clone().sub(a).sub(b), n, cu, cv + 0.5, tint, wind);
    m.v(p.clone().add(a).sub(b), n, cu + 0.5, cv + 0.5, tint, wind);
    m.v(p.clone().add(a).add(b), n, cu + 0.5, cv, tint, wind);
    m.v(p.clone().sub(a).add(b), n, cu, cv, tint, wind);
    m.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };

  if (plan.sprigs.length) {
    // Each branch carries a flat spray of needles and a crossed upright one, so
    // the tree reads as dense from the side as from above.
    for (const s of plan.sprigs) {
      const p = s.from.clone().lerp(s.to, 0.58).add(v3((rand() - 0.5) * 0.15, 0.05, (rand() - 0.5) * 0.15));
      const out = v3(p.x, 0, p.z).normalize();
      const side = new THREE.Vector3(-out.z, 0, out.x);
      const shade = out.clone().multiplyScalar(0.9).add(v3(0, 0.55 + p.y / 30, 0));
      const height = clamp(p.y / 11);
      const ao = lerp(0.6, 1.0, Math.min(1, s.from.distanceTo(p) / 1.4)) * lerp(0.72, 1.05, height);
      const flat = out.clone().multiplyScalar(0.3).add(v3(0, 1, 0)).add(v3(rand() - 0.5, 0, rand() - 0.5).multiplyScalar(0.4)).normalize();
      card(p, flat, shade, s.size * (0.9 + rand() * 0.25), ao, 0.25 + height * 0.6, 1.2);
      if (!lowDetail || rand() < 0.5) {
        const upright = side.clone().add(v3(0, 0.35, 0)).add(out.clone().multiplyScalar((rand() - 0.5) * 0.6)).normalize();
        card(p.clone().add(v3(0, -0.08, 0)), upright, shade, s.size * (0.75 + rand() * 0.2), ao * 0.92, 0.25 + height * 0.6, 1.25);
      }
    }
  } else {
    const total = Math.round(plan.cards * detail);
    const weight = plan.clusters.reduce((sum, c) => sum + c.r * c.r, 0);
    for (const cl of plan.clusters) {
      const n = Math.max(4, Math.round((total * cl.r * cl.r) / weight));
      for (let i = 0; i < n; i++) {
        // Fibonacci directions, jittered, with most cards near the cluster's skin.
        const y = 1 - (2 * (i + 0.5)) / n;
        const phi = i * 2.399963 + rand() * 0.5;
        const ring = Math.sqrt(Math.max(0, 1 - y * y));
        const dir = v3(Math.cos(phi) * ring, y, Math.sin(phi) * ring);
        const depth = 0.45 + Math.sqrt(rand()) * 0.62;
        const p = cl.c.clone().addScaledVector(dir, cl.r * depth);
        const fromCentre = p.clone().sub(centre).normalize();
        const shade = dir.clone().multiplyScalar(0.75).addScaledVector(fromCentre, 0.45).add(v3(0, 0.12, 0));
        const facing = dir.clone().multiplyScalar(0.7).add(v3(rand() - 0.5, rand() - 0.5, rand() - 0.5).multiplyScalar(0.8)).normalize();
        const height = clamp((p.y - minY) / Math.max(0.1, maxY - minY));
        const ao = lerp(0.42, 1.0, smooth(0.45, 1.05, depth)) * lerp(0.62, 1.04, height) * (dir.y < -0.3 ? 0.82 : 1);
        const reach = Math.hypot(p.x, p.z);
        card(p, facing, shade, plan.cardSize * (0.8 + rand() * 0.45) * (species === 4 ? 1 : 1 + (cl.r - 1) * 0.15), ao, clamp(0.15 + height * 0.5 + reach * 0.08, 0, 1.2));
      }
    }
  }
  const entry = { canopy: m.build("aWind"), trunk, plan };
  geometryCache.set(key, entry);
  return entry;
}

// ----- Materials -------------------------------------------------------------------

const FOLIAGE_VERT = /* glsl */ `
  attribute float aWind;
  uniform float uWindTime;
`;

/** Lambert lighting for leaves and blades: wrapped diffuse, light through the leaf, a waxy glint. */
function foliageLights(wrap: number, translucency: number, sheen: number) {
  return /* glsl */ `
    varying vec3 vViewPosition;
    struct LambertMaterial { vec3 diffuseColor; float specularStrength; };
    void RE_Direct_Lambert( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in LambertMaterial material, inout ReflectedLight reflectedLight ) {
      float nl = dot( geometryNormal, directLight.direction );
      float diffuse = saturate( ( nl + ${wrap.toFixed(3)} ) / ${(1 + wrap).toFixed(3)} );
      float back = saturate( dot( -geometryViewDir, directLight.direction ) );
      float through = pow( back, 3.0 ) * ${translucency.toFixed(3)} * ( 0.55 + 0.45 * saturate( -nl + 0.4 ) );
      vec3 transColor = material.diffuseColor * vec3( 1.15, 1.3, 0.55 ) * 1.6;
      reflectedLight.directDiffuse += directLight.color * ( diffuse * BRDF_Lambert( material.diffuseColor ) + through * transColor * RECIPROCAL_PI );
      vec3 h = normalize( directLight.direction + geometryViewDir );
      float glint = pow( saturate( dot( geometryNormal, h ) ), 24.0 ) * ${sheen.toFixed(3)} * saturate( nl * 3.0 );
      reflectedLight.directSpecular += directLight.color * glint;
    }
    void RE_IndirectDiffuse_Lambert( const in vec3 irradiance, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in LambertMaterial material, inout ReflectedLight reflectedLight ) {
      reflectedLight.indirectDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );
    }
    #define RE_Direct RE_Direct_Lambert
    #define RE_IndirectDiffuse RE_IndirectDiffuse_Lambert
  `;
}

/** Keeps the bent foliage normal on both sides of a card instead of flipping it. */
const NORMAL_UNFLIPPED = /* glsl */ `
  float faceDirection = gl_FrontFacing ? 1.0 : - 1.0;
  vec3 normal = normalize( vNormal );
  vec3 nonPerturbedNormal = normal;
`;

let canopyMaterial: THREE.MeshLambertMaterial | null = null;
let canopyDepth: THREE.MeshDepthMaterial | null = null;
const trunkMaterials = new Map<string, THREE.MeshStandardMaterial>();

function getCanopyMaterial() {
  if (canopyMaterial) return canopyMaterial;
  const material = new THREE.MeshLambertMaterial({ map: leafCardTexture(), alphaTest: 0.42, side: THREE.DoubleSide, vertexColors: true });
  material.alphaToCoverage = true;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uWindTime = windTime;
    shader.vertexShader = shader.vertexShader.replace("#include <common>", `#include <common>\n${FOLIAGE_VERT}`).replace(
      "#include <begin_vertex>",
      /* glsl */ `#include <begin_vertex>
      {
        #ifdef USE_INSTANCING
          vec3 iPos = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
        #else
          vec3 iPos = vec3(0.0);
        #endif
        float phase = iPos.x * 0.7 + iPos.z * 0.5;
        float gust = 0.65 + 0.35 * sin(uWindTime * 0.33 + iPos.x * 0.045 + iPos.z * 0.03);
        float sway = sin(uWindTime * 1.05 + phase + position.y * 0.18) * 0.65 + sin(uWindTime * 2.2 + phase * 1.7) * 0.25;
        transformed.x += sway * aWind * 0.13 * gust;
        transformed.z += cos(uWindTime * 0.85 + phase * 0.8 + position.y * 0.12) * aWind * 0.08 * gust;
        transformed.y += sin(uWindTime * 6.5 + dot(position, vec3(3.1, 2.3, 1.7))) * 0.022 * aWind;
      }
      `,
    );
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <lights_lambert_pars_fragment>", foliageLights(0.45, 1.0, 0.16))
      .replace("#include <normal_fragment_begin>", NORMAL_UNFLIPPED);
    // Leaves are drawn many layers deep: skip the cloud-shadow lookups here.
    patchSky(shader, { cloudShadow: false });
  };
  material.customProgramCacheKey = () => "canopy-v2";
  canopyMaterial = material;
  return material;
}

function getCanopyDepthMaterial() {
  if (!canopyDepth) {
    canopyDepth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: leafCardTexture(), alphaTest: 0.42 });
  }
  return canopyDepth;
}

function getTrunkMaterial(bark: "rough" | "birch") {
  let material = trunkMaterials.get(bark);
  if (material) return material;
  const maps = barkMaps(bark);
  material = new THREE.MeshStandardMaterial({ map: maps.map, normalMap: maps.normal, normalScale: new THREE.Vector2(1.4, 1.4), roughness: bark === "birch" ? 0.72 : 0.93, vertexColors: true });
  material.onBeforeCompile = (shader) => patchSky(shader);
  material.customProgramCacheKey = () => "bark-v2";
  trunkMaterials.set(bark, material);
  return material;
}

/** The shared bark material (uses vertex colours: give geometry a colour attribute). */
export function barkMaterial(kind: "rough" | "birch" = "rough") {
  return getTrunkMaterial(kind);
}

/** A tapered tube along a smooth path, with bark UVs in metres and a colour per ring. */
export function tubeGeometry(points: THREE.Vector3[], radius: (t: number) => number, sides: number, steps: number, color: (t: number, p: THREE.Vector3) => THREE.Color): THREE.BufferGeometry {
  const m = new Mesher();
  tube(m, points, radius, sides, steps, color, Math.max(1, Math.round((radius(0) * TAU) / 0.5)));
  return m.build("aWind");
}

// ----- Ground contact shading ---------------------------------------------------

let contactTex: THREE.CanvasTexture | null = null;
let contactMaterial: THREE.MeshBasicMaterial | null = null;

/** Soft occlusion under trees, multiplied onto the ground (cheap baked AO). */
function getContactMaterial() {
  if (contactMaterial) return contactMaterial;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 128;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createRadialGradient(64, 64, 4, 64, 64, 63);
  g.addColorStop(0, "rgb(120,122,118)");
  g.addColorStop(0.35, "rgb(160,162,156)");
  g.addColorStop(0.7, "rgb(215,216,212)");
  g.addColorStop(1, "rgb(255,255,255)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  contactTex = new THREE.CanvasTexture(canvas);
  contactMaterial = new THREE.MeshBasicMaterial({
    map: contactTex,
    transparent: true,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendSrc: THREE.ZeroFactor,
    blendDst: THREE.SrcColorFactor,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
    toneMapped: false,
    fog: false,
  });
  return contactMaterial;
}

let contactGeo: THREE.BufferGeometry | null = null;
function getContactGeometry() {
  if (!contactGeo) {
    contactGeo = new THREE.PlaneGeometry(1, 1);
    contactGeo.rotateX(-Math.PI / 2);
  }
  return contactGeo;
}

// ----- Trees ---------------------------------------------------------------------

export interface TreePlacement {
  x: number;
  y: number;
  z: number;
  scale: number;
  rotation: number;
  /** 0 oak, 1 lime, 2 spruce, 3 birch; chosen from the position if omitted. */
  variant?: number;
  /** Overrides the canopy colour for variety. */
  tint?: THREE.Color;
  /** Ground normal under the tree, to lay the contact shadow on slopes. */
  normal?: THREE.Vector3;
}

export const TREE_SPECIES = 4;

/** Instanced trees: one canopy and one trunk draw per species in the field. */
export class TreeField {
  group = new THREE.Group();
  private meshes: THREE.InstancedMesh[] = [];

  constructor(placements: TreePlacement[], options: { lowDetail?: boolean; castShadow?: boolean; contact?: boolean } = {}) {
    const bySpecies: TreePlacement[][] = Array.from({ length: TREE_SPECIES }, () => []);
    const speciesOf = placements.map((p, i) => (p.variant ?? Math.abs(Math.round(p.x * 3) + i * 2)) % TREE_SPECIES);
    placements.forEach((p, i) => bySpecies[speciesOf[i]].push(p));
    // Average linear albedo of an untinted canopy, so a tint asks for a real colour.
    const canopyAverage = new THREE.Color(0.035, 0.1, 0.012);
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const color = new THREE.Color();
    const yAxis = new THREE.Vector3(0, 1, 0);
    bySpecies.forEach((list, species) => {
      if (list.length === 0) return;
      const geo = treeGeometry(species, options.lowDetail === true);
      const canopy = new THREE.InstancedMesh(geo.canopy, getCanopyMaterial(), list.length);
      canopy.frustumCulled = false;
      canopy.castShadow = options.castShadow !== false;
      canopy.receiveShadow = false;
      canopy.customDepthMaterial = getCanopyDepthMaterial();
      const trunk = geo.trunk ? new THREE.InstancedMesh(geo.trunk, getTrunkMaterial(geo.plan.bark), list.length) : null;
      if (trunk) {
        trunk.frustumCulled = false;
        trunk.castShadow = options.castShadow !== false;
        trunk.receiveShadow = true;
      }
      list.forEach((p, i) => {
        position.set(p.x, p.y, p.z);
        quaternion.setFromAxisAngle(yAxis, p.rotation);
        scale.setScalar(p.scale);
        matrix.compose(position, quaternion, scale);
        canopy.setMatrixAt(i, matrix);
        trunk?.setMatrixAt(i, matrix);
        if (p.tint) color.setRGB((p.tint.r * 0.3) / canopyAverage.r, (p.tint.g * 0.3) / canopyAverage.g, (p.tint.b * 0.3) / canopyAverage.b);
        else color.setRGB(1, 1, 1).multiplyScalar(0.92 + ((i * 37) % 11) / 70);
        canopy.setColorAt(i, color);
      });
      if (canopy.instanceColor) canopy.instanceColor.needsUpdate = true;
      canopy.instanceMatrix.needsUpdate = true;
      this.group.add(canopy);
      this.meshes.push(canopy);
      if (trunk) {
        trunk.instanceMatrix.needsUpdate = true;
        this.group.add(trunk);
        this.meshes.push(trunk);
      }
    });
    if (options.contact !== false && placements.length > 0) {
      const contact = new THREE.InstancedMesh(getContactGeometry(), getContactMaterial(), placements.length);
      const up = new THREE.Vector3(0, 1, 0);
      placements.forEach((p, i) => {
        const species = speciesOf[i];
        const width = (species === 2 ? 5.2 : species === 3 ? 3.6 : 6.6) * p.scale;
        position.set(p.x, p.y + 0.06, p.z);
        quaternion.setFromUnitVectors(up, p.normal ?? up);
        scale.set(width, 1, width);
        matrix.compose(position, quaternion, scale);
        contact.setMatrixAt(i, matrix);
      });
      contact.instanceMatrix.needsUpdate = true;
      contact.frustumCulled = false;
      contact.renderOrder = -5;
      this.group.add(contact);
      this.meshes.push(contact);
    }
  }

  dispose() {
    for (const mesh of this.meshes) mesh.dispose();
  }
}

/** Leafy shrubs: the same cluster foliage as the trees, sitting on the ground. */
export function createBushField(placements: TreePlacement[]): { group: THREE.Group; dispose(): void } {
  const group = new THREE.Group();
  const geo = treeGeometry(4, false);
  const mesh = new THREE.InstancedMesh(geo.canopy, getCanopyMaterial(), Math.max(1, placements.length));
  mesh.customDepthMaterial = getCanopyDepthMaterial();
  mesh.castShadow = true;
  mesh.frustumCulled = false;
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const color = new THREE.Color();
  placements.forEach((p, i) => {
    position.set(p.x, p.y - 0.05, p.z);
    quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), p.rotation);
    scale.set(p.scale * 1.1, p.scale * 0.95, p.scale * 1.1);
    matrix.compose(position, quaternion, scale);
    mesh.setMatrixAt(i, matrix);
    color.setRGB(0.9 + (i % 3) * 0.05, 1, 0.95);
    mesh.setColorAt(i, color);
  });
  mesh.count = placements.length;
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  group.add(mesh);
  return {
    group,
    dispose() {
      mesh.dispose();
    },
  };
}

// ----- Grass -----------------------------------------------------------------

/**
 * One instance is a tuft of thin curved blades, each with its own lean, width,
 * height and shade, normals rounded across the blade for soft light.
 */
function grassTuftGeometry(segments: number, blades: number): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const heights: number[] = [];
  const bladeIds: number[] = [];
  const indices: number[] = [];
  const rand = rng(7 + segments * 13 + blades);
  for (let b = 0; b < blades; b++) {
    const angle = (b / blades) * TAU + rand() * 0.9;
    const r = b === 0 ? 0.05 : 0.25 + rand() * 0.65;
    const cx = Math.cos(angle) * r;
    const cz = Math.sin(angle) * r;
    const facing = angle + (rand() - 0.5) * 1.6;
    const nx = Math.cos(facing);
    const nz = Math.sin(facing);
    const lean = 0.18 + rand() * 0.55;
    const width = 0.075 + rand() * 0.06;
    const height = 0.62 + rand() * 0.42;
    const id = rand();
    const shade = 0.86 + rand() * 0.22;
    const start = positions.length / 3;
    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      const y = t * height * (1 - lean * 0.18 * t);
      const bend = t * t * lean;
      const w = (width * (1 - Math.pow(t, 1.4) * 0.92)) / 2;
      const px = cx + nx * bend;
      const pz = cz + nz * bend;
      // Normal: the blade's face, leaning back as it bends, rounded at the edges.
      const fx = nx * 0.55;
      const fz = nz * 0.55;
      const fy = 0.75 - t * 0.25;
      if (i < segments) {
        positions.push(px - nz * w, y, pz + nx * w, px + nz * w, y, pz - nx * w);
        normals.push(fx - nz * 0.5, fy, fz + nx * 0.5, fx + nz * 0.5, fy, fz - nx * 0.5);
        for (let k = 0; k < 2; k++) {
          colors.push(shade, shade, shade);
          heights.push(t);
          bladeIds.push(id);
        }
      } else {
        positions.push(px + nx * 0.02, y, pz + nz * 0.02);
        normals.push(fx, fy, fz);
        colors.push(shade, shade, shade);
        heights.push(1);
        bladeIds.push(id);
      }
    }
    for (let i = 0; i < segments - 1; i++) {
      const a = start + i * 2;
      indices.push(a, a + 1, a + 3, a, a + 3, a + 2);
    }
    const lastBase = start + (segments - 1) * 2;
    indices.push(lastBase, lastBase + 1, start + segments * 2);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.setAttribute("aHeight", new THREE.Float32BufferAttribute(heights, 1));
  geometry.setAttribute("aBlade", new THREE.Float32BufferAttribute(bladeIds, 1));
  geometry.setIndex(indices);
  return geometry;
}

const GRASS_VERT = /* glsl */ `
  attribute float aHeight;
  attribute float aBlade;
  uniform float uWindTime;
  uniform float uWindStrength;
  varying float vH;
  varying float vGust;
  varying float vBlade;
`;

/** Wind applied in world space after the instance transform, so gusts roll across the field. */
const GRASS_PROJECT = /* glsl */ `
  vec4 mvPosition = vec4( transformed, 1.0 );
  #ifdef USE_INSTANCING
    mvPosition = instanceMatrix * mvPosition;
    vec3 tuft = vec3( instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2] );
    float tall = length( instanceMatrix[1].xyz );
  #else
    vec3 tuft = vec3( 0.0 );
    float tall = 1.0;
  #endif
  #ifdef GRASS_CARPET
    tuft = carpetTuft;
    tall = carpetTall;
  #endif
  {
    vec3 wt = ( modelMatrix * vec4( tuft, 1.0 ) ).xyz;
    vec2 windDir = vec2( 0.94, 0.34 );
    float along = dot( wt.xz, windDir );
    float gust = 0.5 + 0.5 * sin( along * 0.23 - uWindTime * 2.0 );
    gust *= 0.55 + 0.45 * sin( dot( wt.xz, vec2( -0.11, 0.29 ) ) * 0.4 - uWindTime * 0.63 );
    gust = gust * gust;
    vGust = gust;
    float flutter = sin( uWindTime * ( 3.2 + aBlade * 3.5 ) + aBlade * 41.0 + wt.x * 1.7 + wt.z * 1.3 );
    float h2 = aHeight * aHeight;
    vec2 sway = ( windDir * ( 0.06 + gust * 0.46 ) + vec2( -windDir.y, windDir.x ) * flutter * 0.07 ) * uWindStrength;
    mvPosition.xz += sway * h2 * tall;
    mvPosition.y -= dot( sway, sway ) * 0.35 * h2 * tall;
  }
  mvPosition = modelViewMatrix * mvPosition;
  gl_Position = projectionMatrix * mvPosition;
`;

const GRASS_COLOR = /* glsl */ `
  #include <color_fragment>
  {
    float ao = mix( 0.3, 1.0, smoothstep( 0.0, 0.7, vH ) );
    diffuseColor.rgb *= ao * mix( vec3( 1.0 ), vec3( 1.1, 1.08, 0.78 ), vH * vH );
    diffuseColor.rgb *= mix( vec3( 0.9, 1.0, 1.0 ), vec3( 1.12, 1.03, 0.8 ), vBlade );
    // Blades bent by a gust turn their paler side up: the waves you see in a meadow.
    diffuseColor.rgb = mix( diffuseColor.rgb, diffuseColor.rgb * vec3( 1.22, 1.2, 1.05 ) + vec3( 0.01, 0.012, 0.004 ), vGust * vH * 0.6 );
  }
`;

export interface GrassOptions {
  /** Colour at the base of the blades. */
  base?: THREE.Color;
  /** Colour at the tips. */
  tip?: THREE.Color;
}

const grassGeo = new Map<string, THREE.BufferGeometry>();
const grassMats = new Map<string, THREE.MeshLambertMaterial>();

function getGrassMaterial(carpet: boolean, uniforms?: Record<string, THREE.IUniform>) {
  const key = carpet ? "carpet" : "patch";
  const cached = grassMats.get(key);
  if (cached && !carpet) return cached;
  const material = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uWindTime = windTime;
    shader.uniforms.uWindStrength = grassWindStrength;
    if (uniforms) Object.assign(shader.uniforms, uniforms);
    let vertex = shader.vertexShader.replace("#include <common>", `#include <common>\n${GRASS_VERT}${carpet ? CARPET_VERT : ""}`);
    vertex = vertex.replace("#include <begin_vertex>", `#include <begin_vertex>\nvH = aHeight;\nvBlade = aBlade;${carpet ? CARPET_PLACE : ""}`);
    vertex = vertex.replace("#include <beginnormal_vertex>", carpet ? CARPET_NORMAL : "#include <beginnormal_vertex>");
    vertex = vertex.replace("#include <project_vertex>", (carpet ? "#define GRASS_CARPET\n" : "") + GRASS_PROJECT);
    shader.vertexShader = vertex;
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\nvarying float vH;\nvarying float vGust;\nvarying float vBlade;${carpet ? "\nvarying vec3 vTint;" : ""}`)
      .replace("#include <color_fragment>", (carpet ? "diffuseColor.rgb *= vTint;\n" : "") + GRASS_COLOR)
      .replace("#include <lights_lambert_pars_fragment>", foliageLights(0.55, 0.85, 0.22))
      .replace("#include <normal_fragment_begin>", NORMAL_UNFLIPPED);
    patchSky(shader, { cloudShadow: false });
  };
  material.customProgramCacheKey = () => (carpet ? "grass-carpet-v2" : "grass-v2");
  if (!carpet) grassMats.set(key, material);
  return material;
}

export interface GrassPlacement {
  x: number;
  y: number;
  z: number;
  height: number;
  width: number;
  /** 0..1 colour position from lush to dry. */
  tone: number;
}

const LUSH = new THREE.Color("#3f6f2a");
const MID = new THREE.Color("#5b8a35");
const DRY = new THREE.Color("#a3a15a");

function grassTone(tone: number, out: THREE.Color) {
  return tone < 0.7 ? out.copy(LUSH).lerp(MID, tone / 0.7) : out.copy(MID).lerp(DRY, (tone - 0.7) / 0.3);
}

/** One instanced draw call for a patch of grass. */
export function createGrassPatch(placements: GrassPlacement[], segments = 3): THREE.InstancedMesh {
  const key = `${segments}:7`;
  let geometry = grassGeo.get(key);
  if (!geometry) {
    geometry = grassTuftGeometry(segments, 7);
    grassGeo.set(key, geometry);
  }
  const mesh = new THREE.InstancedMesh(geometry, getGrassMaterial(false), Math.max(1, placements.length));
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const rotation = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const color = new THREE.Color();
  const yAxis = new THREE.Vector3(0, 1, 0);
  placements.forEach((p, i) => {
    position.set(p.x, p.y, p.z);
    rotation.setFromAxisAngle(yAxis, (p.tone * 1000 + i * 0.7) % TAU);
    scale.set(p.width, p.height, p.width);
    matrix.compose(position, rotation, scale);
    mesh.setMatrixAt(i, matrix);
    mesh.setColorAt(i, grassTone(p.tone, color));
  });
  mesh.count = placements.length;
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.frustumCulled = false;
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  return mesh;
}

// The race's grass: a fixed set of tufts that wraps around the camera, so a
// field of any length costs the same. Tufts on the dirt track are hidden by
// sampling the course's bend from a small texture.

const CARPET_VERT = /* glsl */ `
  attribute vec4 aTuft;
  attribute vec4 aTuft2;
  uniform vec3 uCarpetOrigin;
  uniform vec2 uCarpetSize;
  uniform vec2 uCarpetCam;
  uniform sampler2D uBendTex;
  uniform vec4 uBend;
  varying vec3 vTint;
`;

const CARPET_PLACE = /* glsl */ `
  vec3 carpetTuft;
  float carpetTall = aTuft2.x;
  {
    // Track space: x is the offset from the course's centre line, z wraps round the camera.
    float relZ = mod( aTuft.y - uCarpetOrigin.z + uCarpetSize.y * 0.5, uCarpetSize.y ) - uCarpetSize.y * 0.5;
    float worldZ = uCarpetOrigin.z + relZ;
    float bend = texture2D( uBendTex, vec2( clamp( ( worldZ - uBend.x ) / uBend.y, 0.0, 1.0 ), 0.5 ) ).r;
    vec2 world = vec2( bend + aTuft.x, worldZ );
    float side = abs( aTuft.x );
    float edge = smoothstep( uBend.z - 0.5, uBend.z + 1.2, side );
    // Thin out towards the tile's ends and with distance from the camera.
    float tileFade = 1.0 - smoothstep( 0.6, 1.0, abs( relZ ) / ( uCarpetSize.y * 0.5 ) );
    tileFade *= 1.0 - smoothstep( 0.55, 1.0, ( side - uBend.z ) / max( uBend.w, 1.0 ) );
    float dist = length( world - uCarpetCam );
    float keep = step( aTuft2.w, tileFade * mix( 1.0, 0.4, smoothstep( 14.0, 42.0, dist ) ) ) * ( 1.0 - smoothstep( 46.0, 54.0, dist ) );
    float s = edge * keep * mix( 0.45, 1.0, smoothstep( uBend.z, uBend.z + 3.0, side ) );
    float ca = cos( aTuft.z );
    float sa = sin( aTuft.z );
    vec3 p = vec3( transformed.x * aTuft.w, transformed.y * aTuft2.x, transformed.z * aTuft.w ) * s;
    transformed = vec3( p.x * ca - p.z * sa, p.y, p.x * sa + p.z * ca ) + vec3( world.x, 0.0, world.y );
    carpetTuft = vec3( world.x, 0.0, world.y );
    float tone = aTuft2.y;
    vTint = tone < 0.7 ? mix( vec3( 0.051, 0.159, 0.024 ), vec3( 0.105, 0.254, 0.036 ), tone / 0.7 ) : mix( vec3( 0.105, 0.254, 0.036 ), vec3( 0.366, 0.356, 0.102 ), ( tone - 0.7 ) / 0.3 );
    // Flowers keep their own colours.
    if ( aTuft2.z > 0.5 ) vTint = vec3( 1.0 );
  }
`;

const CARPET_NORMAL = /* glsl */ `
  vec3 objectNormal = vec3( normal );
  {
    float ca = cos( aTuft.z );
    float sa = sin( aTuft.z );
    objectNormal = vec3( objectNormal.x * ca - objectNormal.z * sa, objectNormal.y, objectNormal.x * sa + objectNormal.z * ca );
  }
  #ifdef USE_TANGENT
    vec3 objectTangent = vec3( tangent.xyz );
  #endif
`;

export interface GrassCarpetOptions {
  /** Width of the strip on each side of the course (x) and depth of the tile round the camera (z), metres. */
  width?: number;
  depth?: number;
  /** Blades per tuft (fewer for far strips). */
  blades?: number;
  /** Tufts per square metre. */
  density?: number;
  /** The course: centre line x at z, sampled over [z0, z1], and the half-width kept clear. */
  bend: (z: number) => number;
  z0: number;
  z1: number;
  clearHalfWidth: number;
  /** How far ahead of the camera (towards -z) the tile is centred. */
  ahead?: number;
  /** Scatter one kind of wildflower (0..5) instead of grass. */
  flowerKind?: number;
}

/** Grass that follows the camera along the race course. Add it to the scene once. */
export function createGrassCarpet(options: GrassCarpetOptions): THREE.Mesh {
  const width = options.width ?? 20;
  const depth = options.depth ?? 64;
  const density = options.density ?? 2.4;
  const count = Math.round(width * 2 * depth * density);
  const flower = options.flowerKind !== undefined;
  const blades = options.blades ?? 5;
  const key = `3:${blades}`;
  let base = flower ? flowerGeometry(options.flowerKind ?? 0) : grassGeo.get(key);
  if (!base) {
    base = grassTuftGeometry(3, blades);
    grassGeo.set(key, base);
  }
  const geometry = new THREE.InstancedBufferGeometry();
  for (const name of ["position", "normal", "color", "aHeight", "aBlade"]) geometry.setAttribute(name, base.getAttribute(name));
  geometry.setIndex(base.getIndex());
  const tuft = new Float32Array(count * 4);
  const tuft2 = new Float32Array(count * 4);
  const rand = rng(91);
  const inner = options.clearHalfWidth - 0.4;
  for (let i = 0; i < count; i++) {
    // Strips either side of the course, starting just inside its edge.
    const x = (rand() < 0.5 ? -1 : 1) * (inner + rand() * width);
    const z = rand() * depth;
    // Patches of drier, shorter grass and lusher, taller grass, tileable along the carpet.
    const patch = perlinFbm(((x + 100) / 40) * 2, (z / depth) * 6, 64, 6, 3, 5);
    const dry = smooth(0.58, 0.74, patch);
    tuft[i * 4] = x;
    tuft[i * 4 + 1] = z;
    tuft[i * 4 + 2] = rand() * TAU;
    tuft[i * 4 + 3] = flower ? 0.8 + rand() * 0.5 : 0.3 + rand() * 0.16;
    tuft2[i * 4] = flower ? 0.8 + rand() * 0.5 : (0.3 + rand() * 0.32) * lerp(1.15, 0.72, dry);
    tuft2[i * 4 + 1] = clamp(rand() * 0.62 + dry * 0.5);
    tuft2[i * 4 + 2] = flower ? 1 : 0;
    tuft2[i * 4 + 3] = rand();
  }
  geometry.setAttribute("aTuft", new THREE.InstancedBufferAttribute(tuft, 4));
  geometry.setAttribute("aTuft2", new THREE.InstancedBufferAttribute(tuft2, 4));
  geometry.instanceCount = count;

  // The course's centre line, baked so the shader can keep the track clear.
  const samples = 1024;
  const bendData = new Float32Array(samples * 4);
  for (let i = 0; i < samples; i++) {
    const z = lerp(options.z0, options.z1, i / (samples - 1));
    bendData[i * 4] = options.bend(z);
  }
  const bendTex = new THREE.DataTexture(bendData, samples, 1, THREE.RGBAFormat, THREE.FloatType);
  bendTex.magFilter = THREE.LinearFilter;
  bendTex.minFilter = THREE.LinearFilter;
  bendTex.needsUpdate = true;
  const origin = { value: new THREE.Vector3() };
  const toCamera = { value: new THREE.Vector2() };
  const uniforms = {
    uCarpetOrigin: origin,
    uCarpetCam: toCamera,
    uCarpetSize: { value: new THREE.Vector2(width, depth) },
    uBendTex: { value: bendTex },
    uBend: { value: new THREE.Vector4(options.z0, options.z1 - options.z0, options.clearHalfWidth, width) },
  };
  const material = getGrassMaterial(true, uniforms);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  const ahead = options.ahead ?? 24;
  mesh.onBeforeRender = (_renderer, _scene, camera) => {
    const forward = new THREE.Vector3();
    camera.getWorldDirection(forward);
    forward.y = 0;
    if (forward.lengthSq() < 1e-4) forward.set(0, 0, -1);
    forward.normalize();
    origin.value.copy(camera.position).addScaledVector(forward, ahead);
    toCamera.value.set(camera.position.x, camera.position.z);
  };
  const dispose = mesh.geometry.dispose.bind(mesh.geometry);
  mesh.geometry.dispose = () => {
    dispose();
    bendTex.dispose();
    material.dispose();
  };
  return mesh;
}

// ----- Flowers ---------------------------------------------------------------

/** Daisy, pink clover, buttercup, poppy, cornflower, white clover. */
const FLOWER_KINDS = 6;

const flowerGeos: THREE.BufferGeometry[] = [];

function flowerGeometry(kind: number): THREE.BufferGeometry {
  if (flowerGeos[kind]) return flowerGeos[kind];
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const heights: number[] = [];
  const blades: number[] = [];
  const indices: number[] = [];
  const rand = rng(300 + kind);
  const push = (x: number, y: number, z: number, nx: number, ny: number, nz: number, c: THREE.Color, h: number) => {
    positions.push(x, y, z);
    normals.push(nx, ny, nz);
    colors.push(c.r, c.g, c.b);
    heights.push(h);
    blades.push(0.5);
    return positions.length / 3 - 1;
  };
  const stemH = kind === 1 || kind === 5 ? 0.22 : kind === 4 ? 0.5 : 0.42;
  const stem = new THREE.Color("#4c7a2e");
  // Stem: a thin crossed pair of quads with a slight curve.
  for (let side = 0; side < 2; side++) {
    const ax = side === 0 ? 1 : 0;
    const az = side === 0 ? 0 : 1;
    const w = 0.012;
    const v0 = push(-w * ax, 0, -w * az, 0, 0.3, 1, stem, 0);
    const v1 = push(w * ax, 0, w * az, 0, 0.3, 1, stem, 0);
    const v2 = push(w * ax + 0.02, stemH, w * az, 0, 0.3, 1, stem, 1);
    const v3i = push(-w * ax + 0.02, stemH, -w * az, 0, 0.3, 1, stem, 1);
    indices.push(v0, v1, v2, v0, v2, v3i);
  }
  // A pair of leaves low on the stem.
  for (const s of [-1, 1]) {
    const y = stemH * 0.25;
    const a = push(0.01, y, 0, 0, 1, 0, stem, 0.2);
    const b = push(s * 0.09, y + 0.05, 0.03, 0, 1, 0.2, stem, 0.4);
    const c = push(s * 0.12, y + 0.09, -0.02, 0, 1, 0.2, stem, 0.5);
    indices.push(a, b, c);
  }
  const top = stemH;
  const head = (petalColor: THREE.Color, centre: THREE.Color, count: number, length: number, cup: number, width: number) => {
    const c0 = push(0.02, top + 0.012, 0, 0, 1, 0, centre, 1);
    for (let p = 0; p < count; p++) {
      const a = (p / count) * TAU + rand() * 0.2;
      const da = (TAU / count) * width;
      const l = length * (0.85 + rand() * 0.3);
      const tint = petalColor.clone().multiplyScalar(0.92 + rand() * 0.14);
      const i0 = push(0.02 + Math.cos(a - da) * l * 0.2, top + 0.008, Math.sin(a - da) * l * 0.2, 0, 1, 0, tint, 1);
      const i1 = push(0.02 + Math.cos(a + da) * l * 0.2, top + 0.008, Math.sin(a + da) * l * 0.2, 0, 1, 0, tint, 1);
      const o0 = push(0.02 + Math.cos(a - da * 0.8) * l, top + cup * l, Math.sin(a - da * 0.8) * l, Math.cos(a) * 0.3, 0.9, Math.sin(a) * 0.3, tint, 1);
      const o1 = push(0.02 + Math.cos(a + da * 0.8) * l, top + cup * l, Math.sin(a + da * 0.8) * l, Math.cos(a) * 0.3, 0.9, Math.sin(a) * 0.3, tint, 1);
      indices.push(c0, i1, i0, i0, i1, o1, i0, o1, o0);
    }
    // A raised centre.
    const ring = 6;
    const base = positions.length / 3;
    for (let k = 0; k < ring; k++) {
      const a = (k / ring) * TAU;
      push(0.02 + Math.cos(a) * length * 0.2, top + 0.02, Math.sin(a) * length * 0.2, Math.cos(a) * 0.5, 0.8, Math.sin(a) * 0.5, centre, 1);
    }
    const apex = push(0.02, top + 0.035, 0, 0, 1, 0, centre.clone().multiplyScalar(1.15), 1);
    for (let k = 0; k < ring; k++) indices.push(base + k, apex, base + ((k + 1) % ring));
  };
  const ball = (color: THREE.Color, radius: number) => {
    // Clover heads: a small cluster of florets as a faceted ball.
    const geo = new THREE.IcosahedronGeometry(radius, 1);
    const p = geo.attributes.position as THREE.BufferAttribute;
    const n = geo.attributes.normal as THREE.BufferAttribute;
    const base = positions.length / 3;
    for (let i = 0; i < p.count; i++) {
      const tint = color.clone().multiplyScalar(0.85 + rand() * 0.25);
      push(p.getX(i) + 0.02, p.getY(i) * 0.85 + top + radius * 0.6, p.getZ(i), n.getX(i), n.getY(i), n.getZ(i), tint, 1);
    }
    for (let i = 0; i < p.count; i++) indices.push(base + i);
    geo.dispose();
  };
  switch (kind) {
    case 0:
      head(new THREE.Color("#f4f1ea"), new THREE.Color("#e8b923"), 16, 0.075, 0.05, 0.42);
      break;
    case 1:
      ball(new THREE.Color("#c86a9a"), 0.035);
      break;
    case 2:
      head(new THREE.Color("#f2c418"), new THREE.Color("#d79a10"), 5, 0.05, 0.6, 0.95);
      break;
    case 3:
      head(new THREE.Color("#c8231b"), new THREE.Color("#1d1812"), 4, 0.08, 0.55, 1.1);
      break;
    case 4:
      head(new THREE.Color("#4f6fd8"), new THREE.Color("#2b2a6b"), 8, 0.055, 0.25, 0.5);
      break;
    default:
      ball(new THREE.Color("#ece8dc"), 0.032);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.setAttribute("aHeight", new THREE.Float32BufferAttribute(heights, 1));
  geometry.setAttribute("aBlade", new THREE.Float32BufferAttribute(blades, 1));
  geometry.setIndex(indices);
  flowerGeos[kind] = geometry;
  return geometry;
}

export interface FlowerPlacement {
  x: number;
  y: number;
  z: number;
  scale: number;
  colour: number;
}

/**
 * Wildflowers, one instanced draw per kind. The returned mesh holds the first
 * kind and carries the others as children; dispose() frees them all.
 */
export function createFlowerPatch(placements: FlowerPlacement[]): THREE.InstancedMesh {
  const byKind: FlowerPlacement[][] = Array.from({ length: FLOWER_KINDS }, () => []);
  for (const p of placements) byKind[((p.colour % FLOWER_KINDS) + FLOWER_KINDS) % FLOWER_KINDS].push(p);
  const material = getGrassMaterial(false);
  const make = (kind: number, list: FlowerPlacement[]) => {
    const mesh = new THREE.InstancedMesh(flowerGeometry(kind), material, Math.max(1, list.length));
    const matrix = new THREE.Matrix4();
    const rotation = new THREE.Quaternion();
    const color = new THREE.Color();
    const yAxis = new THREE.Vector3(0, 1, 0);
    list.forEach((p, i) => {
      rotation.setFromAxisAngle(yAxis, (p.x * 13.1 + p.z * 7.7) % TAU);
      const s = p.scale * (kind === 1 || kind === 5 ? 1.1 : 1);
      matrix.compose(new THREE.Vector3(p.x, p.y, p.z), rotation, new THREE.Vector3(s, s * (0.85 + ((i * 7) % 5) * 0.08), s));
      mesh.setMatrixAt(i, matrix);
      color.setScalar(0.9 + ((i * 13) % 7) * 0.03);
      mesh.setColorAt(i, color);
    });
    mesh.count = list.length;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.frustumCulled = false;
    mesh.receiveShadow = true;
    return mesh;
  };
  const root = make(0, byKind[0]);
  const children: THREE.InstancedMesh[] = [];
  for (let kind = 1; kind < FLOWER_KINDS; kind++) {
    if (byKind[kind].length === 0) continue;
    const child = make(kind, byKind[kind]);
    root.add(child);
    children.push(child);
  }
  const disposeRoot = root.dispose.bind(root);
  root.dispose = () => {
    for (const child of children) child.dispose();
    return disposeRoot();
  };
  return root;
}

/** Programs this module can create, for shader warm-up: a tiny instance of each. */
export function floraWarmupSet(): THREE.Object3D[] {
  const trees = new TreeField(
    Array.from({ length: TREE_SPECIES }, (_, i) => ({ x: i * 6, y: 0, z: 0, scale: 0.3, rotation: 0, variant: i })),
    { castShadow: true },
  );
  const grass = createGrassPatch([{ x: 0, y: 0, z: 0, height: 0.4, width: 0.3, tone: 0.5 }]);
  const flowers = createFlowerPatch(Array.from({ length: FLOWER_KINDS }, (_, i) => ({ x: i * 0.3, y: 0, z: 0, scale: 0.5, colour: i })));
  return [trees.group, grass, flowers];
}
