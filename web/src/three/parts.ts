// A small geometry merger: assemble models from three.js primitives with vertex
// colours and a per-vertex glow amount, then bake them into one BufferGeometry.

import * as THREE from "three";

export type ColorSource = THREE.ColorRepresentation | ((x: number, y: number, z: number, nx: number, ny: number, nz: number) => THREE.Color);

export class GeoBuilder {
  private pos: number[] = [];
  private nor: number[] = [];
  private col: number[] = [];
  private uv: number[] = [];
  private glow: number[] = [];
  private idx: number[] = [];

  add(
    geometry: THREE.BufferGeometry,
    matrix: THREE.Matrix4 | null,
    color: ColorSource,
    glow: number | ((y: number) => number) = 0,
  ): this {
    const positionAttr = geometry.attributes.position as THREE.BufferAttribute;
    const normalAttr = geometry.attributes.normal as THREE.BufferAttribute | undefined;
    const uvAttr = geometry.attributes.uv as THREE.BufferAttribute | undefined;
    const base = this.pos.length / 3;
    const v = new THREE.Vector3();
    const n = new THREE.Vector3();
    const normalMatrix = matrix ? new THREE.Matrix3().getNormalMatrix(matrix) : null;
    const constant = typeof color !== "function" ? new THREE.Color(color) : null;
    for (let i = 0; i < positionAttr.count; i++) {
      v.fromBufferAttribute(positionAttr, i);
      if (matrix) v.applyMatrix4(matrix);
      if (normalAttr) n.fromBufferAttribute(normalAttr, i);
      else n.set(0, 1, 0);
      if (normalMatrix) n.applyMatrix3(normalMatrix).normalize();
      this.pos.push(v.x, v.y, v.z);
      this.nor.push(n.x, n.y, n.z);
      const c = constant ?? (color as Exclude<ColorSource, THREE.ColorRepresentation>)(v.x, v.y, v.z, n.x, n.y, n.z);
      this.col.push(c.r, c.g, c.b);
      this.uv.push(uvAttr ? uvAttr.getX(i) : 0, uvAttr ? uvAttr.getY(i) : 0);
      this.glow.push(typeof glow === "function" ? glow(v.y) : glow);
    }
    if (geometry.index) {
      for (let i = 0; i < geometry.index.count; i++) this.idx.push(geometry.index.getX(i) + base);
    } else {
      for (let i = 0; i < positionAttr.count; i++) this.idx.push(base + i);
    }
    return this;
  }

  /** Ensures a flat shaded, double sided curved leaf exists at the matrix. */
  leaf(matrix: THREE.Matrix4, color: THREE.Color, glow = 0): this {
    return this.add(leafGeometry(), matrix, color, glow);
  }

  isEmpty() {
    return this.pos.length === 0;
  }

  build(): THREE.BufferGeometry {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(this.pos, 3));
    geometry.setAttribute("normal", new THREE.Float32BufferAttribute(this.nor, 3));
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(this.col, 3));
    geometry.setAttribute("uv", new THREE.Float32BufferAttribute(this.uv, 2));
    geometry.setAttribute("aGlow", new THREE.Float32BufferAttribute(this.glow, 1));
    geometry.setIndex(this.pos.length / 3 > 65000 ? new THREE.BufferAttribute(new Uint32Array(this.idx), 1) : new THREE.BufferAttribute(new Uint16Array(this.idx), 1));
    return geometry;
  }
}

let leafGeo: THREE.BufferGeometry | null = null;

/** A unit leaf: base at origin, tip at +Y, arched along +Z, 0.5 wide. */
export function leafGeometry(): THREE.BufferGeometry {
  if (leafGeo) return leafGeo;
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const steps = 10;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const width = Math.sin(Math.PI * Math.min(1, t * 1.02)) ** 0.65 * 0.25;
    const y = t;
    const z = -t * t * 0.32 + Math.sin(t * Math.PI) * 0.1;
    const nz = 1;
    const ny = t * 0.6;
    const l = Math.hypot(ny, nz);
    positions.push(-width, y, z, 0, y, z + 0.015, width, y, z);
    normals.push(0.18, ny / l, nz / l, 0, ny / l, nz / l, -0.18, ny / l, nz / l);
  }
  for (let i = 0; i < steps; i++) {
    const a = i * 3;
    indices.push(a, a + 3, a + 1, a + 1, a + 3, a + 4, a + 1, a + 4, a + 2, a + 2, a + 4, a + 5);
  }
  leafGeo = new THREE.BufferGeometry();
  leafGeo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  leafGeo.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  leafGeo.setIndex(indices);
  return leafGeo;
}

export function makeMatrix(x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, sx = 1, sy = sx, sz = sx): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)),
    new THREE.Vector3(sx, sy, sz),
  );
}
