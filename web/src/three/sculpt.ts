// Signed-distance sculpting. Creatures are defined as smooth blends of round
// cones and ellipsoids, then polygonised with Surface Nets. Normals come from
// the distance field, so the shapes stay perfectly smooth at any mesh density,
// and ambient occlusion and skin weights are baked per vertex from the same
// field. Parts built with sweeps use the same output format.

import * as THREE from "three";

export type V3 = readonly [number, number, number];

const KIND_CONE = 0;
const KIND_ELL = 1;

interface PrimSpec {
  kind: number;
  a: V3;
  b: V3;
  r1: number;
  r2: number;
  radii: V3;
  rot: number[] | null;
  k: number;
  tag: number;
  bone: number;
  bone2: number;
  carve: boolean;
}

export interface PrimOpts {
  k?: number;
  tag?: number;
  bone?: number;
  bone2?: number;
  /** Euler XYZ rotation for ellipsoids. */
  rot?: V3;
}

/** The arrays a part is built from. Masks are arbitrary per-vertex data. */
export interface ShapeData {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  skinIndex: Uint16Array;
  skinWeight: Float32Array;
  masks: Float32Array;
  colors: Float32Array;
}

const S = 24; // Doubles per primitive in the flat array.

export type MaskFn = (
  x: number,
  y: number,
  z: number,
  nx: number,
  ny: number,
  nz: number,
  tags: Float32Array,
  ao: number,
  out: Float32Array,
  color: Float32Array,
) => void;

function eulerMatrix(rx: number, ry: number, rz: number): number[] {
  const m = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rx, ry, rz, "XYZ"));
  // The inverse of a rotation is its transpose, so read the elements as rows.
  const e = m.elements;
  return [e[0], e[1], e[2], e[4], e[5], e[6], e[8], e[9], e[10]];
}

export class Sculpt {
  private prims: PrimSpec[] = [];
  private D: Float64Array = new Float64Array(0);
  private n = 0;
  private carveFrom = 0;
  private boundR: number[] = [];

  private push(prim: Omit<PrimSpec, "tag" | "bone" | "bone2" | "k" | "rot" | "carve">, opts: PrimOpts, carve: boolean) {
    const rot = opts.rot ? eulerMatrix(opts.rot[0], opts.rot[1], opts.rot[2]) : null;
    this.prims.push({ ...prim, k: opts.k ?? 0.04, tag: opts.tag ?? 0, bone: opts.bone ?? 0, bone2: opts.bone2 ?? -1, rot, carve });
  }

  sphere(c: V3, r: number, opts: PrimOpts = {}) {
    this.push({ kind: KIND_CONE, a: c, b: c, r1: r, r2: r, radii: [r, r, r] }, opts, false);
    return this;
  }

  cone(a: V3, ra: number, b: V3, rb: number, opts: PrimOpts = {}) {
    this.push({ kind: KIND_CONE, a, b, r1: ra, r2: rb, radii: [0, 0, 0] }, opts, false);
    return this;
  }

  ell(c: V3, radii: V3, opts: PrimOpts = {}) {
    this.push({ kind: KIND_ELL, a: c, b: c, r1: 0, r2: 0, radii }, opts, false);
    return this;
  }

  /** Subtracts a sphere from everything added so far (smooth). */
  carveSphere(c: V3, r: number, opts: PrimOpts = {}) {
    this.push({ kind: KIND_CONE, a: c, b: c, r1: r, r2: r, radii: [r, r, r] }, opts, true);
    return this;
  }

  carveCone(a: V3, ra: number, b: V3, rb: number, opts: PrimOpts = {}) {
    this.push({ kind: KIND_CONE, a, b, r1: ra, r2: rb, radii: [0, 0, 0] }, opts, true);
    return this;
  }

  carveEll(c: V3, radii: V3, opts: PrimOpts = {}) {
    this.push({ kind: KIND_ELL, a: c, b: c, r1: 0, r2: 0, radii }, opts, true);
    return this;
  }

  /** Compiles the primitives added so far, so fieldAt can be queried. */
  prepare() {
    this.compile();
  }

  fieldAt(x: number, y: number, z: number): number {
    return this.field(x, y, z);
  }

  private compile() {
    const adds = this.prims.filter((p) => !p.carve);
    const carves = this.prims.filter((p) => p.carve);
    const all = [...adds, ...carves];
    this.carveFrom = adds.length;
    this.n = all.length;
    const D = new Float64Array(this.n * S);
    this.boundR = new Array(this.n).fill(0);
    all.forEach((p, i) => {
      const o = i * S;
      D[o] = p.kind;
      D[o + 1] = p.a[0];
      D[o + 2] = p.a[1];
      D[o + 3] = p.a[2];
      D[o + 16] = p.k;
      D[o + 17] = p.tag;
      D[o + 18] = p.bone;
      D[o + 19] = p.bone2;
      // Bounding sphere (centre and radius) for quick rejection.
      const rBound = p.kind === KIND_CONE ? Math.max(p.r1, p.r2) : Math.max(p.radii[0], p.radii[1], p.radii[2]);
      const half = Math.sqrt((p.b[0] - p.a[0]) ** 2 + (p.b[1] - p.a[1]) ** 2 + (p.b[2] - p.a[2]) ** 2) / 2;
      D[o + 21] = (p.a[0] + p.b[0]) / 2;
      D[o + 22] = (p.a[1] + p.b[1]) / 2;
      D[o + 23] = (p.a[2] + p.b[2]) / 2;
      this.boundR[i] = rBound + half;
      if (p.kind === KIND_CONE) {
        const bax = p.b[0] - p.a[0];
        const bay = p.b[1] - p.a[1];
        const baz = p.b[2] - p.a[2];
        const l2 = bax * bax + bay * bay + baz * baz;
        const rr = p.r1 - p.r2;
        D[o + 4] = bax;
        D[o + 5] = bay;
        D[o + 6] = baz;
        D[o + 7] = l2;
        D[o + 8] = rr;
        D[o + 9] = l2 - rr * rr;
        D[o + 10] = l2 > 0 ? 1 / l2 : 0;
        D[o + 11] = p.r1;
        D[o + 12] = p.r2;
      } else {
        D[o + 4] = p.radii[0];
        D[o + 5] = p.radii[1];
        D[o + 6] = p.radii[2];
        D[o + 7] = p.rot ? 1 : 0;
        if (p.rot) {
          for (let j = 0; j < 8; j++) D[o + 8 + j] = p.rot[j];
          D[o + 20] = p.rot[8];
        }
      }
    });
    this.D = D;
  }

  private primDist(i: number, px: number, py: number, pz: number): number {
    const D = this.D;
    const o = i * S;
    let x = px - D[o + 1];
    let y = py - D[o + 2];
    let z = pz - D[o + 3];
    if (D[o] === KIND_CONE) {
      const l2 = D[o + 7];
      const r1 = D[o + 11];
      const r2 = D[o + 12];
      if (l2 === 0) return Math.sqrt(x * x + y * y + z * z) - r1;
      const bx = D[o + 4];
      const by = D[o + 5];
      const bz = D[o + 6];
      const rr = D[o + 8];
      const a2 = D[o + 9];
      const il2 = D[o + 10];
      const yy = x * bx + y * by + z * bz;
      const zz = yy - l2;
      const ex = x * l2 - bx * yy;
      const ey = y * l2 - by * yy;
      const ez = z * l2 - bz * yy;
      const x2 = ex * ex + ey * ey + ez * ez;
      const y2 = yy * yy * l2;
      const z2 = zz * zz * l2;
      const kv = Math.sign(rr) * rr * rr * x2;
      if (Math.sign(zz) * a2 * z2 > kv) return Math.sqrt(x2 + z2) * il2 - r2;
      if (Math.sign(yy) * a2 * y2 < kv) return Math.sqrt(x2 + y2) * il2 - r1;
      return (Math.sqrt(x2 * a2 * il2) + yy * rr) * il2 - r1;
    }
    if (D[o + 7] === 1) {
      const qx = D[o + 8] * x + D[o + 9] * y + D[o + 10] * z;
      const qy = D[o + 11] * x + D[o + 12] * y + D[o + 13] * z;
      const qz = D[o + 14] * x + D[o + 15] * y + D[o + 20] * z;
      x = qx;
      y = qy;
      z = qz;
    }
    const rx = D[o + 4];
    const ry = D[o + 5];
    const rz = D[o + 6];
    const k0 = Math.sqrt((x / rx) ** 2 + (y / ry) ** 2 + (z / rz) ** 2);
    if (k0 < 1e-6) return -Math.min(rx, ry, rz);
    const k1 = Math.sqrt((x / (rx * rx)) ** 2 + (y / (ry * ry)) ** 2 + (z / (rz * rz)) ** 2);
    return (k0 * (k0 - 1)) / k1;
  }

  /** The whole field: a smooth union of the additions, then the carves. */
  field(x: number, y: number, z: number): number {
    const D = this.D;
    let d = 1e9;
    for (let i = 0; i < this.carveFrom; i++) {
      const o = i * S;
      const k = D[o + 16];
      const dx = x - D[o + 21];
      const dy = y - D[o + 22];
      const dz = z - D[o + 23];
      const reach = this.boundR[i] + d + k;
      if (reach > 0 && dx * dx + dy * dy + dz * dz > reach * reach && d < 1e8) continue;
      const di = this.primDist(i, x, y, z);
      if (k > 0) {
        const h = Math.max(k - Math.abs(d - di), 0) / k;
        d = Math.min(d, di) - h * h * k * 0.25;
      } else {
        d = Math.min(d, di);
      }
    }
    for (let i = this.carveFrom; i < this.n; i++) {
      const o = i * S;
      const k = D[o + 16];
      const dx = x - D[o + 21];
      const dy = y - D[o + 22];
      const dz = z - D[o + 23];
      const reach = this.boundR[i] + (k - d);
      if (reach > 0 && dx * dx + dy * dy + dz * dz > reach * reach) continue;
      const di = -this.primDist(i, x, y, z);
      if (k > 0) {
        const h = Math.max(k - Math.abs(d - di), 0) / k;
        d = Math.max(d, di) + h * h * k * 0.25;
      } else {
        d = Math.max(d, di);
      }
    }
    return d;
  }

  private bounds(margin: number): [number, number, number, number, number, number] {
    let x0 = 1e9;
    let y0 = 1e9;
    let z0 = 1e9;
    let x1 = -1e9;
    let y1 = -1e9;
    let z1 = -1e9;
    for (const p of this.prims) {
      if (p.carve) continue;
      const r = p.kind === KIND_CONE ? Math.max(p.r1, p.r2) : Math.max(p.radii[0], p.radii[1], p.radii[2]);
      for (const point of [p.a, p.b]) {
        x0 = Math.min(x0, point[0] - r);
        y0 = Math.min(y0, point[1] - r);
        z0 = Math.min(z0, point[2] - r);
        x1 = Math.max(x1, point[0] + r);
        y1 = Math.max(y1, point[1] + r);
        z1 = Math.max(z1, point[2] + r);
      }
    }
    return [x0 - margin, y0 - margin, z0 - margin, x1 + margin, y1 + margin, z1 + margin];
  }

  /**
   * Polygonises the field. `cell` is the grid spacing, `masks` fills four
   * custom values per vertex. Output vertices are projected onto the surface.
   */
  build(cell: number, mask?: MaskFn, tagCount = 8, weightFalloff = 0.05): ShapeData {
    this.compile();
    const [x0, y0, z0, x1, y1, z1] = this.bounds(cell * 2.5);
    const nx = Math.ceil((x1 - x0) / cell) + 1;
    const ny = Math.ceil((y1 - y0) / cell) + 1;
    const nz = Math.ceil((z1 - z0) / cell) + 1;
    const grid = new Float32Array(nx * ny * nz).fill(NaN);
    const id = (i: number, j: number, k: number) => i + j * nx + k * nx * ny;

    // Coarse pass: skip blocks that are clearly nowhere near the surface.
    const step = 4;
    const sample = (i: number, j: number, k: number) => {
      const index = id(i, j, k);
      if (Number.isNaN(grid[index])) grid[index] = this.field(x0 + i * cell, y0 + j * cell, z0 + k * cell);
      return grid[index];
    };
    const blockDiag = cell * step * Math.sqrt(3) * 0.75;
    for (let k = 0; k < nz - 1; k += step) {
      const kEnd = Math.min(k + step, nz - 1);
      for (let j = 0; j < ny - 1; j += step) {
        const jEnd = Math.min(j + step, ny - 1);
        for (let i = 0; i < nx - 1; i += step) {
          const iEnd = Math.min(i + step, nx - 1);
          const mid = this.field(x0 + ((i + iEnd) / 2) * cell, y0 + ((j + jEnd) / 2) * cell, z0 + ((k + kEnd) / 2) * cell);
          if (Math.abs(mid) > blockDiag * 1.25) {
            // Far from the surface: the whole block shares a sign.
            for (let kk = k; kk <= kEnd; kk++) {
              for (let jj = j; jj <= jEnd; jj++) {
                for (let ii = i; ii <= iEnd; ii++) {
                  const index = id(ii, jj, kk);
                  if (Number.isNaN(grid[index])) grid[index] = Math.sign(mid) * blockDiag;
                }
              }
            }
          } else {
            for (let kk = k; kk <= kEnd; kk++) {
              for (let jj = j; jj <= jEnd; jj++) {
                for (let ii = i; ii <= iEnd; ii++) sample(ii, jj, kk);
              }
            }
          }
        }
      }
    }

    // Surface Nets.
    const cellVertex = new Int32Array(nx * ny * nz).fill(-1);
    const px: number[] = [];
    const py: number[] = [];
    const pz: number[] = [];
    const EDGES = [
      [0, 1], [1, 3], [3, 2], [2, 0],
      [4, 5], [5, 7], [7, 6], [6, 4],
      [0, 4], [1, 5], [3, 7], [2, 6],
    ];
    const values = new Float64Array(8);
    for (let k = 0; k < nz - 1; k++) {
      for (let j = 0; j < ny - 1; j++) {
        for (let i = 0; i < nx - 1; i++) {
          let inside = 0;
          for (let c = 0; c < 8; c++) {
            const value = grid[id(i + (c & 1), j + ((c >> 1) & 1), k + ((c >> 2) & 1))];
            values[c] = value;
            if (value < 0) inside |= 1 << c;
          }
          if (inside === 0 || inside === 255) continue;
          let sx = 0;
          let sy = 0;
          let sz = 0;
          let crossings = 0;
          for (const [a, b] of EDGES) {
            const va = values[a];
            const vb = values[b];
            if (va < 0 === vb < 0) continue;
            const t = va / (va - vb);
            const ax = a & 1;
            const ay = (a >> 1) & 1;
            const az = (a >> 2) & 1;
            sx += ax + ((b & 1) - ax) * t;
            sy += ay + (((b >> 1) & 1) - ay) * t;
            sz += az + (((b >> 2) & 1) - az) * t;
            crossings++;
          }
          cellVertex[id(i, j, k)] = px.length;
          px.push(x0 + (i + sx / crossings) * cell);
          py.push(y0 + (j + sy / crossings) * cell);
          pz.push(z0 + (k + sz / crossings) * cell);
        }
      }
    }

    const indices: number[] = [];
    const quad = (a: number, b: number, c: number, d: number, nxDir: number, nyDir: number, nzDir: number) => {
      if (a < 0 || b < 0 || c < 0 || d < 0) return;
      // Winding chosen from the outward direction of the crossed edge.
      const ux = px[b] - px[a];
      const uy = py[b] - py[a];
      const uz = pz[b] - pz[a];
      const vx = px[c] - px[a];
      const vy = py[c] - py[a];
      const vz = pz[c] - pz[a];
      const nx2 = uy * vz - uz * vy;
      const ny2 = uz * vx - ux * vz;
      const nz2 = ux * vy - uy * vx;
      if (nx2 * nxDir + ny2 * nyDir + nz2 * nzDir >= 0) indices.push(a, b, c, a, c, d);
      else indices.push(a, c, b, a, d, c);
    };
    for (let k = 0; k < nz - 1; k++) {
      for (let j = 0; j < ny - 1; j++) {
        for (let i = 0; i < nx - 1; i++) {
          const v0 = grid[id(i, j, k)];
          if (j > 0 && k > 0) {
            const v1 = grid[id(i + 1, j, k)];
            if (v0 < 0 !== v1 < 0) {
              const dir = v0 < 0 ? 1 : -1;
              quad(
                cellVertex[id(i, j - 1, k - 1)],
                cellVertex[id(i, j, k - 1)],
                cellVertex[id(i, j, k)],
                cellVertex[id(i, j - 1, k)],
                dir,
                0,
                0,
              );
            }
          }
          if (i > 0 && k > 0) {
            const v1 = grid[id(i, j + 1, k)];
            if (v0 < 0 !== v1 < 0) {
              const dir = v0 < 0 ? 1 : -1;
              quad(
                cellVertex[id(i - 1, j, k - 1)],
                cellVertex[id(i - 1, j, k)],
                cellVertex[id(i, j, k)],
                cellVertex[id(i, j, k - 1)],
                0,
                dir,
                0,
              );
            }
          }
          if (i > 0 && j > 0) {
            const v1 = grid[id(i, j, k + 1)];
            if (v0 < 0 !== v1 < 0) {
              const dir = v0 < 0 ? 1 : -1;
              quad(
                cellVertex[id(i - 1, j - 1, k)],
                cellVertex[id(i, j - 1, k)],
                cellVertex[id(i, j, k)],
                cellVertex[id(i - 1, j, k)],
                0,
                0,
                dir,
              );
            }
          }
        }
      }
    }

    // Project onto the true surface, take normals from the field, bake AO
    // and skin weights.
    const count = px.length;
    const positions = new Float32Array(count * 3);
    const normals = new Float32Array(count * 3);
    const skinIndex = new Uint16Array(count * 4);
    const skinWeight = new Float32Array(count * 4);
    const masks = new Float32Array(count * 4);
    const h = cell * 0.5;
    const each = new Float64Array(this.n);
    const weightsByBone = new Float64Array(64);
    const tags = new Float32Array(tagCount);
    const out = new Float32Array(4);
    const outColor = new Float32Array(3);
    const colors = new Float32Array(count * 3);
    const aoSteps = [0.04, 0.09, 0.16, 0.26];

    for (let v = 0; v < count; v++) {
      let x = px[v];
      let y = py[v];
      let z = pz[v];
      let gx = 0;
      let gy = 0;
      let gz = 0;
      for (let iter = 0; iter < 2; iter++) {
        const d = this.field(x, y, z);
        gx = this.field(x + h, y, z) - this.field(x - h, y, z);
        gy = this.field(x, y + h, z) - this.field(x, y - h, z);
        gz = this.field(x, y, z + h) - this.field(x, y, z - h);
        const len = Math.sqrt(gx * gx + gy * gy + gz * gz) || 1;
        const move = Math.max(-cell, Math.min(cell, d));
        x -= (gx / len) * move;
        y -= (gy / len) * move;
        z -= (gz / len) * move;
        if (iter === 1) {
          // One last measurement at the projected point, for the normal.
          gx = this.field(x + h, y, z) - this.field(x - h, y, z);
          gy = this.field(x, y + h, z) - this.field(x, y - h, z);
          gz = this.field(x, y, z + h) - this.field(x, y, z - h);
        }
      }
      const len = Math.sqrt(gx * gx + gy * gy + gz * gz) || 1;
      const nxv = gx / len;
      const nyv = gy / len;
      const nzv = gz / len;
      positions[v * 3] = x;
      positions[v * 3 + 1] = y;
      positions[v * 3 + 2] = z;
      normals[v * 3] = nxv;
      normals[v * 3 + 1] = nyv;
      normals[v * 3 + 2] = nzv;

      // Ambient occlusion from the distance field along the normal.
      let occlusion = 0;
      let falloff = 1;
      for (const s of aoSteps) {
        const f = this.field(x + nxv * s, y + nyv * s, z + nzv * s);
        occlusion += ((s - f) / s) * falloff;
        falloff *= 0.75;
      }
      // Extra soft occlusion from the ground plane for lower surfaces.
      const ao = Math.max(0.28, Math.min(1, 1 - occlusion * 0.34));

      // Skin weights and tags from which primitives are closest.
      let dmin = 1e9;
      for (let i = 0; i < this.carveFrom; i++) {
        each[i] = this.primDist(i, x, y, z);
        if (each[i] < dmin) dmin = each[i];
      }
      weightsByBone.fill(0);
      tags.fill(0);
      let totalTag = 0;
      for (let i = 0; i < this.carveFrom; i++) {
        const w = Math.exp(-(each[i] - dmin) / weightFalloff);
        if (w < 1e-3) continue;
        const o = i * S;
        const bone = this.D[o + 18];
        const bone2 = this.D[o + 19];
        if (bone2 >= 0 && this.D[o] === KIND_CONE && this.D[o + 7] > 0) {
          const t = Math.max(0, Math.min(1, ((x - this.D[o + 1]) * this.D[o + 4] + (y - this.D[o + 2]) * this.D[o + 5] + (z - this.D[o + 3]) * this.D[o + 6]) / this.D[o + 7]));
          const s = t * t * (3 - 2 * t);
          weightsByBone[bone] += w * (1 - s);
          weightsByBone[bone2] += w * s;
        } else {
          weightsByBone[bone] += w;
        }
        const tag = this.D[o + 17];
        if (tag >= 0 && tag < tagCount) {
          tags[tag] += w;
          totalTag += w;
        }
      }
      // Surfaces cut by a tagged carve take that tag, so hollows can be coloured.
      for (let i = this.carveFrom; i < this.n; i++) {
        const tag = this.D[i * S + 17];
        if (tag <= 0 || tag >= tagCount) continue;
        const distance = Math.abs(this.primDist(i, x, y, z));
        const w = 9 * Math.exp(-distance / 0.012);
        tags[tag] += w;
        totalTag += w;
      }
      if (totalTag > 0) for (let i = 0; i < tagCount; i++) tags[i] /= totalTag;

      // Take the four largest bones.
      const picks: [number, number][] = [];
      for (let b = 0; b < weightsByBone.length; b++) {
        const w = weightsByBone[b];
        if (w > 1e-3) picks.push([b, w]);
      }
      picks.sort((a, b) => b[1] - a[1]);
      let sum = 0;
      for (let s = 0; s < Math.min(4, picks.length); s++) sum += picks[s][1];
      for (let s = 0; s < 4; s++) {
        if (s < picks.length) {
          skinIndex[v * 4 + s] = picks[s][0];
          skinWeight[v * 4 + s] = picks[s][1] / sum;
        }
      }

      out.fill(0);
      out[0] = ao;
      outColor.fill(1);
      if (mask) mask(x, y, z, nxv, nyv, nzv, tags, ao, out, outColor);
      colors[v * 3] = outColor[0];
      colors[v * 3 + 1] = outColor[1];
      colors[v * 3 + 2] = outColor[2];
      masks[v * 4] = out[0];
      masks[v * 4 + 1] = out[1];
      masks[v * 4 + 2] = out[2];
      masks[v * 4 + 3] = out[3];
    }

    return {
      positions,
      normals,
      indices: new Uint32Array(indices),
      skinIndex,
      skinWeight,
      masks,
      colors,
    };
  }
}

// ----- Parts made from swept tubes and hand-built grids -----------------------

/** Mutable collector so several shapes can be merged into one geometry. */
export class PartBuilder {
  private pos: number[] = [];
  private nor: number[] = [];
  private idx: number[] = [];
  private bi: number[] = [];
  private bw: number[] = [];
  private mask: number[] = [];
  private col: number[] = [];
  private uv: number[] = [];

  /** Adds raw sculpt output, optionally recoloured. */
  addShape(shape: ShapeData) {
    const base = this.pos.length / 3;
    const n = shape.positions.length / 3;
    for (let v = 0; v < n; v++) {
      this.pos.push(shape.positions[v * 3], shape.positions[v * 3 + 1], shape.positions[v * 3 + 2]);
      this.nor.push(shape.normals[v * 3], shape.normals[v * 3 + 1], shape.normals[v * 3 + 2]);
      this.bi.push(shape.skinIndex[v * 4], shape.skinIndex[v * 4 + 1], shape.skinIndex[v * 4 + 2], shape.skinIndex[v * 4 + 3]);
      this.bw.push(shape.skinWeight[v * 4], shape.skinWeight[v * 4 + 1], shape.skinWeight[v * 4 + 2], shape.skinWeight[v * 4 + 3]);
      this.mask.push(shape.masks[v * 4], shape.masks[v * 4 + 1], shape.masks[v * 4 + 2], shape.masks[v * 4 + 3]);
      this.col.push(shape.colors[v * 3], shape.colors[v * 3 + 1], shape.colors[v * 3 + 2]);
      this.uv.push(0, 0);
    }
    for (let i = 0; i < shape.indices.length; i++) this.idx.push(shape.indices[i] + base);
  }

  vertex(
    x: number,
    y: number,
    z: number,
    nx: number,
    ny: number,
    nz: number,
    color: THREE.Color,
    mask: V3 | readonly [number, number, number, number],
    u = 0,
    v = 0,
    bones: readonly number[] = [0, 0, 0, 0],
    weights: readonly number[] = [1, 0, 0, 0],
  ): number {
    const index = this.pos.length / 3;
    this.pos.push(x, y, z);
    this.nor.push(nx, ny, nz);
    this.col.push(color.r, color.g, color.b);
    this.uv.push(u, v);
    this.mask.push(mask[0], mask[1], mask[2], mask.length > 3 ? (mask as readonly number[])[3] : 0);
    this.bi.push(bones[0] ?? 0, bones[1] ?? 0, bones[2] ?? 0, bones[3] ?? 0);
    this.bw.push(weights[0] ?? 1, weights[1] ?? 0, weights[2] ?? 0, weights[3] ?? 0);
    return index;
  }

  tri(a: number, b: number, c: number) {
    this.idx.push(a, b, c);
  }

  quad(a: number, b: number, c: number, d: number) {
    this.idx.push(a, b, c, a, c, d);
  }

  get vertexCount() {
    return this.pos.length / 3;
  }

  toGeometry(): THREE.BufferGeometry {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(this.pos), 3));
    geometry.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(this.nor), 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(this.col), 3));
    geometry.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(this.uv), 2));
    geometry.setAttribute("aMask", new THREE.BufferAttribute(new Float32Array(this.mask), 4));
    geometry.setAttribute("skinIndex", new THREE.BufferAttribute(new Uint16Array(this.bi), 4));
    geometry.setAttribute("skinWeight", new THREE.BufferAttribute(new Float32Array(this.bw), 4));
    const needs32 = this.pos.length / 3 > 65535;
    geometry.setIndex(new THREE.BufferAttribute(needs32 ? new Uint32Array(this.idx) : new Uint16Array(this.idx), 1));
    return geometry;
  }
}

export interface SweepOptions {
  /** Ring vertex count. */
  sides?: number;
  /** Rings per path point; the path is resampled along a Catmull-Rom spline. */
  steps?: number;
  /** Maps t -> radius. */
  radius: (t: number) => number;
  /** Optional radial displacement per ring angle, for ridges and twists. */
  ripple?: (t: number, angle: number) => number;
  /** Maps t -> vertex colour. */
  color: (t: number, angle: number) => THREE.Color;
  /** Maps t -> aMask (ao, a, b, c). */
  mask?: (t: number, angle: number) => readonly [number, number, number, number];
  /** Maps t -> [bones, weights]. */
  bones?: (t: number) => { bones: readonly number[]; weights: readonly number[] };
  /** Flattens the ring: multiplies the local x by this. */
  flatten?: (t: number) => number;
  /** Close the far end with a point. */
  cap?: boolean;
  /** Optional up vector used to seed the frame. */
  up?: THREE.Vector3;
}

/** Sweeps a circular profile along a spline, with a pointed tip if requested. */
export function sweep(builder: PartBuilder, points: THREE.Vector3[], o: SweepOptions) {
  const curve = new THREE.CatmullRomCurve3(points, false, "centripetal", 0.5);
  const steps = o.steps ?? 24;
  const sides = o.sides ?? 10;
  const pts = curve.getPoints(steps);
  const frames: { t: THREE.Vector3; n: THREE.Vector3; b: THREE.Vector3 }[] = [];
  const tangent = new THREE.Vector3();
  for (let i = 0; i <= steps; i++) {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(steps, i + 1)];
    tangent.copy(b).sub(a).normalize();
    if (i === 0) {
      const up = o.up ?? new THREE.Vector3(0, 1, 0);
      const n = up.clone().sub(tangent.clone().multiplyScalar(up.dot(tangent))).normalize();
      if (n.lengthSq() < 1e-6) n.set(1, 0, 0);
      frames.push({ t: tangent.clone(), n, b: tangent.clone().cross(n).normalize() });
    } else {
      const prev = frames[i - 1];
      const n = prev.n.clone().sub(tangent.clone().multiplyScalar(prev.n.dot(tangent))).normalize();
      frames.push({ t: tangent.clone(), n, b: tangent.clone().cross(n).normalize() });
    }
  }

  const start = builder.vertexCount;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const f = frames[i];
    const p = pts[i];
    const radius = o.radius(t);
    const flat = o.flatten ? o.flatten(t) : 1;
    const skin = o.bones ? o.bones(t) : { bones: [0, 0, 0, 0], weights: [1, 0, 0, 0] };
    for (let s = 0; s < sides; s++) {
      const angle = (s / sides) * Math.PI * 2;
      const ripple = o.ripple ? o.ripple(t, angle) : 0;
      const r = radius + ripple;
      const cos = Math.cos(angle) * flat;
      const sin = Math.sin(angle);
      const x = p.x + (f.n.x * cos + f.b.x * sin) * r;
      const y = p.y + (f.n.y * cos + f.b.y * sin) * r;
      const z = p.z + (f.n.z * cos + f.b.z * sin) * r;
      const nx = f.n.x * cos + f.b.x * sin;
      const ny = f.n.y * cos + f.b.y * sin;
      const nz = f.n.z * cos + f.b.z * sin;
      const nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      const m = o.mask ? o.mask(t, angle) : ([1, 0, 0, 0] as const);
      builder.vertex(x, y, z, nx / nl, ny / nl, nz / nl, o.color(t, angle), m, t, s / sides, skin.bones, skin.weights);
    }
  }
  for (let i = 0; i < steps; i++) {
    for (let s = 0; s < sides; s++) {
      const a = start + i * sides + s;
      const b = start + i * sides + ((s + 1) % sides);
      const c = start + (i + 1) * sides + ((s + 1) % sides);
      const d = start + (i + 1) * sides + s;
      builder.quad(a, b, c, d);
    }
  }
  if (o.cap) {
    const last = frames[steps];
    const tip = pts[steps];
    const end = 1;
    const skin = o.bones ? o.bones(end) : { bones: [0, 0, 0, 0], weights: [1, 0, 0, 0] };
    const center = builder.vertex(
      tip.x + last.t.x * 0.001,
      tip.y + last.t.y * 0.001,
      tip.z + last.t.z * 0.001,
      last.t.x,
      last.t.y,
      last.t.z,
      o.color(1, 0),
      o.mask ? o.mask(1, 0) : [1, 0, 0, 0],
      1,
      0.5,
      skin.bones,
      skin.weights,
    );
    for (let s = 0; s < sides; s++) {
      builder.tri(start + steps * sides + s, start + steps * sides + ((s + 1) % sides), center);
    }
  }
}

/** A curved tapered plane, used for feathers and hair locks. */
export function blade(
  builder: PartBuilder,
  root: THREE.Vector3,
  axis: THREE.Vector3,
  side: THREE.Vector3,
  length: number,
  width: number,
  curve: number,
  o: {
    segments?: number;
    color: (t: number, across: number) => THREE.Color;
    mask?: (t: number, across: number) => readonly [number, number, number, number];
    bones?: (t: number) => { bones: readonly number[]; weights: readonly number[] };
    profile?: (t: number) => number;
    v?: number;
    bend?: THREE.Vector3;
  },
) {
  const segments = o.segments ?? 8;
  const normal = axis.clone().cross(side).normalize();
  const bendAxis = o.bend ?? normal;
  const start = builder.vertexCount;
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const center = root
      .clone()
      .add(axis.clone().multiplyScalar(t * length))
      .add(bendAxis.clone().multiplyScalar(t * t * curve));
    const profile = o.profile ? o.profile(t) : Math.sin(Math.PI * Math.min(1, t * 1.05)) ** 0.7;
    const halfW = (width * profile) / 2;
    const skin = o.bones ? o.bones(t) : { bones: [0, 0, 0, 0], weights: [1, 0, 0, 0] };
    for (const a of [-1, 0, 1]) {
      const px = center.x + side.x * a * halfW;
      const py = center.y + side.y * a * halfW + (a === 0 ? 0.004 : 0);
      const pz = center.z + side.z * a * halfW;
      // Tilt the side normals a little so each blade reads as rounded.
      const nx = normal.x + side.x * a * 0.45;
      const ny = normal.y + side.y * a * 0.45;
      const nz = normal.z + side.z * a * 0.45;
      const nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      builder.vertex(
        px,
        py,
        pz,
        nx / nl,
        ny / nl,
        nz / nl,
        o.color(t, a),
        o.mask ? o.mask(t, a) : [1, 0, 0, 0],
        t,
        (a + 1) / 2 + (o.v ?? 0),
        skin.bones,
        skin.weights,
      );
    }
  }
  for (let i = 0; i < segments; i++) {
    for (let j = 0; j < 2; j++) {
      const a = start + i * 3 + j;
      const b = a + 1;
      const c = a + 4;
      const d = a + 3;
      builder.quad(a, b, c, d);
    }
  }
}

export function shapeToGeometry(shape: ShapeData): THREE.BufferGeometry {
  const builder = new PartBuilder();
  builder.addShape(shape);
  return builder.toGeometry();
}
