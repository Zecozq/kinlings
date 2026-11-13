// The buildings and fixtures on each farm: cottages that grow with rank, name
// signposts, tilled plots and nests. All geometry is generated here and shared.
// Surfaces are real materials made in shaders: lime plaster with damp and
// wear, oak beams with grain, fieldstone and brick, weathered roof tiles.

import * as THREE from "three";
import { TAU, clamp, lerp, rng, smooth } from "./gfx.ts";
import { GeoBuilder, makeMatrix } from "./parts.ts";
import { eggGeometry, makeEggMaterial } from "./crops.ts";
import { patchSky } from "./atmosphere.ts";
import { grainBox, groundTextures, worldMaterial } from "./landscape.ts";

// ----- Textures --------------------------------------------------------------

function heightNormalMap(height: Float32Array, size: number, strength: number): THREE.DataTexture {
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
      data[i + 2] = Math.round((nz * 0.5 + 0.5) * 255);
      data[i + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 8;
  texture.needsUpdate = true;
  return texture;
}

interface RoofMaps {
  map: THREE.CanvasTexture;
  normal: THREE.DataTexture;
}

let roofMaps: RoofMaps | null = null;

/** Rows of rounded clay tiles: a pale albedo with per-tile variation, moss and lichen, and a normal map. */
function getRoofMaps(): RoofMaps {
  if (roofMaps) return roofMaps;
  const size = 512;
  const rows = 12;
  const columns = 12;
  const height = new Float32Array(size * size);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const rand = rng(42);
  const tileW = size / columns;
  const rowH = size / rows;
  const tone = Array.from({ length: rows * columns }, () => rand());
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const row = Math.floor(y / rowH);
      const v = y / rowH - row; // 0 at the top of a course, 1 at its lower edge.
      const offset = row % 2 ? 0.5 : 0;
      const col = x / tileW + offset;
      const u = col - Math.floor(col) - 0.5;
      // Rounded lower edge of each tile, overlapping the row beneath, and a curved profile.
      const edge = v - (0.66 + 0.34 * Math.cos(u * Math.PI));
      const lip = smooth(0.0, -0.1, edge);
      const curve = Math.cos(u * Math.PI) * 0.35 + 0.65;
      const t = tone[(row * columns + Math.floor(col)) % tone.length];
      height[y * size + x] = lip * curve * (0.75 + v * 0.25) + (t - 0.5) * 0.05;
    }
  }
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, size, size);
  for (let row = 0; row < rows; row++) {
    for (let col = -1; col <= columns; col++) {
      const offset = row % 2 ? 0.5 : 0;
      const x = (col - offset) * tileW;
      const y = row * rowH;
      const t = tone[(row * columns + ((col + columns) % columns)) % tone.length];
      const shade = 175 + t * 70;
      const warm = (rand() - 0.5) * 24;
      const g = ctx.createLinearGradient(x, 0, x + tileW, 0);
      g.addColorStop(0, `rgb(${shade * 0.86 + warm},${shade * 0.84},${shade * 0.82 - warm})`);
      g.addColorStop(0.5, `rgb(${shade + warm},${shade},${shade - warm})`);
      g.addColorStop(1, `rgb(${shade * 0.8 + warm},${shade * 0.78},${shade * 0.76 - warm})`);
      ctx.fillStyle = g;
      ctx.fillRect(x + 1, y, tileW - 2, rowH + 3);
    }
  }
  // Darker grooves where courses overlap.
  for (let row = 0; row <= rows; row++) {
    const g = ctx.createLinearGradient(0, row * rowH - 4, 0, row * rowH + 5);
    g.addColorStop(0, "rgba(0,0,0,0)");
    g.addColorStop(0.5, "rgba(0,0,0,0.4)");
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, row * rowH - 4, size, 9);
  }
  // Lichen rosettes and grime.
  for (let i = 0; i < 160; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const r = 2 + rand() * 6;
    ctx.fillStyle = rand() < 0.6 ? `rgba(200,196,150,${0.35 + rand() * 0.3})` : `rgba(210,150,60,${0.25 + rand() * 0.25})`;
    ctx.beginPath();
    ctx.ellipse(x, y, r, r * 0.8, rand() * 3, 0, TAU);
    ctx.fill();
  }
  for (let i = 0; i < 260; i++) {
    ctx.fillStyle = `rgba(60,50,40,${0.04 + rand() * 0.08})`;
    ctx.beginPath();
    ctx.ellipse(rand() * size, rand() * size, 4 + rand() * 18, 2 + rand() * 8, 0, 0, TAU);
    ctx.fill();
  }
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  map.anisotropy = 8;
  roofMaps = { map, normal: heightNormalMap(height, size, 3.2) };
  return roofMaps;
}

// ----- Materials ------------------------------------------------------------------

/** Masonry and render, made in the shared world-surface shader (one program for all of them). */
function masonryMaterial(kind: "plaster" | "stone" | "brick"): THREE.MeshStandardMaterial {
  return worldMaterial(kind);
}

let trimMat: THREE.MeshStandardMaterial | null = null;
/** Painted bits, flowers, ironmongery: plain vertex colour under the shared sky. */
function trimMaterial() {
  if (trimMat) return trimMat;
  trimMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6 });
  trimMat.onBeforeCompile = (shader) => patchSky(shader);
  // Same shader as the race's plain props, so they share one program.
  trimMat.customProgramCacheKey = () => "plain-v2";
  return trimMat;
}

/** Glass that reflects the sky by day and glows with lamplight at night. */
const windowMaterial = (night: boolean) => {
  const material = new THREE.MeshStandardMaterial({ color: night ? "#ffd67a" : "#1c262c", roughness: 0.06, metalness: 0.15, emissive: "#ffb648", emissiveIntensity: night ? 2.4 : 0, envMapIntensity: 1.6 });
  material.onBeforeCompile = (shader) => patchSky(shader, { cloudShadow: false });
  material.customProgramCacheKey = () => "glass-v2";
  return material;
};

let stoneMatShared: THREE.MeshStandardMaterial | null = null;

/** Fieldstone in mortar, computed in the shader from local position, no UVs needed. */
export function makeStoneMaterial(): THREE.MeshStandardMaterial {
  if (!stoneMatShared) stoneMatShared = masonryMaterial("stone");
  return stoneMatShared;
}

/** Maps the farm's bright roof colour to a believable clay, slate or glazed tile of the same family. */
function realRoofColour(hex: string): THREE.Color {
  const c = new THREE.Color(hex);
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  return new THREE.Color().setHSL(hsl.h, hsl.s * 0.6, hsl.l * 0.78);
}

// ----- Cottage ------------------------------------------------------------------

export interface CottageParts {
  group: THREE.Group;
  roofMaterial: THREE.MeshStandardMaterial;
  glassMaterial: THREE.MeshStandardMaterial;
  smokeAt: THREE.Vector3;
  dispose(): void;
}

const WALL = "#e9dfca";
const WOOD = "#6a4a30";
const WOOD_LIGHT = "#8f6440";
const STONE = "#a39a8c";
const FLOWERS = ["#d9667f", "#e8b52f", "#f4efe6", "#d0553a"];

export function buildCottage(rank: number, roofColor: string): CottageParts {
  const group = new THREE.Group();
  const tier = rank >= 8 ? 3 : rank >= 5 ? 2 : rank >= 2 ? 1 : 0;
  const width = lerp(5.2, 7.0, tier / 3);
  const depth = lerp(4.0, 4.6, tier / 3);
  const wallH = lerp(2.5, 2.9, tier / 3);
  const roofH = lerp(2.0, 2.4, tier / 3);
  const walls = new GeoBuilder();
  const timber = new GeoBuilder();
  const stone = new GeoBuilder();
  const brick = new GeoBuilder();
  const trim = new GeoBuilder();
  const glass = new GeoBuilder();
  const rand = rng(rank * 7 + roofColor.length);

  // Stone foundation and plaster walls, very slightly out of true.
  stone.add(new THREE.BoxGeometry(width + 0.3, 0.45, depth + 0.3, 6, 1, 4), makeMatrix(0, 0.22, 0), STONE);
  const wall = new THREE.BoxGeometry(width, wallH, depth, 14, 7, 10);
  const wallPos = wall.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < wallPos.count; i++) {
    const x = wallPos.getX(i);
    const y = wallPos.getY(i);
    const z = wallPos.getZ(i);
    const bulge = Math.sin(x * 2.1 + y * 3.2) * 0.012 + Math.sin(z * 2.7 - y * 2.4) * 0.012;
    wallPos.setXYZ(i, x + bulge, y, z + bulge);
  }
  wall.computeVertexNormals();
  walls.add(wall, makeMatrix(0, 0.45 + wallH / 2, 0), WALL);

  // Half-timbering across the front and sides, each beam its own shade of oak.
  const beam = (b: GeoBuilder, x: number, y: number, z: number, w: number, h: number, d: number, rz = 0, color: string = WOOD) => {
    const geo = grainBox(w, h, d);
    b.add(geo, makeMatrix(x, y, z, 0, 0, rz), new THREE.Color(color).multiplyScalar(0.85 + rand() * 0.3));
    geo.dispose();
  };
  const frontZ = depth / 2 + 0.03;
  const top = 0.45 + wallH;
  for (const x of [-width / 2 + 0.05, -width / 4, width / 4, width / 2 - 0.05]) beam(timber, x, 0.45 + wallH / 2, frontZ, 0.14, wallH, 0.06);
  beam(timber, 0, 0.53, frontZ, width, 0.13, 0.07);
  beam(timber, 0, top - 0.05, frontZ, width + 0.1, 0.14, 0.07);
  beam(timber, 0, 0.45 + wallH * 0.56, frontZ, width, 0.1, 0.06);
  for (const x of [-width / 4 - 0.82, width / 4 + 0.82]) beam(timber, x, 0.45 + wallH * 0.78, frontZ, 0.1, wallH * 0.56, 0.05, x > 0 ? 0.62 : -0.62);
  for (const side of [-1, 1]) {
    beam(timber, side * (width / 2 + 0.03), 0.45 + wallH / 2, depth / 2 - 0.04, 0.06, wallH, 0.12);
    beam(timber, side * (width / 2 + 0.03), 0.45 + wallH / 2, -depth / 2 + 0.04, 0.06, wallH, 0.12);
    beam(timber, side * (width / 2 + 0.03), top - 0.05, 0, 0.06, 0.14, depth);
  }

  // Plank door with an arched top, iron hinges and a brass knob.
  const doorW = 1.05 + tier * 0.05;
  const doorH = 1.85 + tier * 0.1;
  const doorShape = new THREE.Shape();
  doorShape.moveTo(-doorW / 2, 0);
  doorShape.lineTo(-doorW / 2, doorH * 0.68);
  doorShape.quadraticCurveTo(-doorW / 2, doorH, 0, doorH);
  doorShape.quadraticCurveTo(doorW / 2, doorH, doorW / 2, doorH * 0.68);
  doorShape.lineTo(doorW / 2, 0);
  doorShape.closePath();
  const doorGeo = new THREE.ExtrudeGeometry(doorShape, { depth: 0.1, bevelEnabled: false, curveSegments: 12 });
  const doorUv = doorGeo.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < doorUv.count; i++) doorUv.setXY(i, doorUv.getY(i), doorUv.getX(i));
  timber.add(doorGeo, makeMatrix(0, 0.45, frontZ + 0.01), (x, y) => {
    const plank = Math.floor((x + doorW / 2) / 0.17);
    return new THREE.Color(WOOD_LIGHT).multiplyScalar(0.72 + ((plank * 37) % 7) * 0.05 + (y - 0.45) * 0.02);
  });
  for (const hy of [0.45 + doorH * 0.2, 0.45 + doorH * 0.55]) trim.add(new THREE.BoxGeometry(doorW * 0.7, 0.05, 0.02), makeMatrix(-doorW * 0.12, hy, frontZ + 0.12), "#2a2826");
  stone.add(new THREE.TorusGeometry(doorW * 0.56, 0.08, 6, 14, Math.PI), makeMatrix(0, 0.45 + doorH * 0.68, frontZ + 0.06), STONE);
  trim.add(new THREE.SphereGeometry(0.05, 10, 8), makeMatrix(doorW * 0.28, 0.45 + doorH * 0.46, frontZ + 0.16), "#c9a24a");
  // A worn doorstep.
  stone.add(new THREE.BoxGeometry(doorW + 0.4, 0.14, 0.6, 4, 1, 2), makeMatrix(0, 0.07, frontZ + 0.36), "#b2aa9a");

  // Windows.
  const windowSpots: [number, number, number][] = [
    [-width / 4 - 0.45, 0.45 + wallH * 0.55, frontZ],
    [width / 4 + 0.45, 0.45 + wallH * 0.55, frontZ],
  ];
  const paneW = 1;
  const paneH = 0.98;
  for (const [x, y, z] of windowSpots) {
    glass.add(new THREE.PlaneGeometry(paneW, paneH), makeMatrix(x, y, z + 0.011), "#ffffff");
    // Frame and glazing bars.
    beam(timber, x, y + paneH / 2 + 0.05, z + 0.02, paneW + 0.18, 0.08, 0.08);
    beam(timber, x, y - paneH / 2 - 0.05, z + 0.02, paneW + 0.26, 0.1, 0.12);
    for (const sx of [-1, 1]) beam(timber, x + sx * (paneW / 2 + 0.04), y, z + 0.02, 0.07, paneH + 0.14, 0.08);
    beam(timber, x, y, z + 0.03, 0.04, paneH, 0.03);
    beam(timber, x, y, z + 0.03, paneW, 0.04, 0.03);
    beam(timber, x, y + paneH * 0.25, z + 0.03, paneW, 0.03, 0.025);
    beam(timber, x, y - paneH * 0.25, z + 0.03, paneW, 0.03, 0.025);
    // Shutters of painted boards.
    for (const sx of [-1, 1]) beam(timber, x + sx * (paneW / 2 + 0.28), y, z + 0.02, 0.36, paneH + 0.08, 0.05, 0, "#5d4632");
    if (rank >= 2) {
      // Window box of flowers and leaves.
      beam(timber, x, y - paneH / 2 - 0.2, z + 0.16, paneW + 0.34, 0.16, 0.26, 0, WOOD_LIGHT);
      for (let f = 0; f < 9; f++) {
        const fx = x + (f / 8 - 0.5) * paneW * 0.95;
        trim.add(new THREE.SphereGeometry(0.075, 7, 5), makeMatrix(fx, y - paneH / 2 - 0.08, z + 0.17 + (f % 2) * 0.05, 0, 0, 0, 1, 0.7, 1), "#3f6a2a");
        trim.add(new THREE.SphereGeometry(0.06, 7, 5), makeMatrix(fx + 0.02, y - paneH / 2 - 0.02, z + 0.2), FLOWERS[f % FLOWERS.length], 0.04);
      }
    }
  }

  // Roof: gable along X, tiled, with thick overhanging eaves. Built as two
  // curved slabs so the ridge reads clean.
  const roofBuilder = new GeoBuilder();
  const overhang = 0.42;
  const roofBase = top + 0.02;
  const halfDepth = depth / 2 + overhang;
  const ridgeY = roofBase + roofH;
  const roofLen = width + overhang * 2 + 0.2;
  for (const side of [1, -1]) {
    const rows = 10;
    const cols = 14;
    const positions: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    for (let r = 0; r <= rows; r++) {
      const v = r / rows;
      // A soft sag in the slope, the way old roofs settle.
      const zs = side * halfDepth * (1 - v);
      const y = lerp(roofBase, ridgeY, v) - Math.sin(v * Math.PI) * 0.12;
      const slope = (roofH * (1 - v)) / halfDepth + 0.3;
      const nl = Math.hypot(slope, 1);
      for (let c = 0; c <= cols; c++) {
        const u = c / cols;
        positions.push((u - 0.5) * roofLen + Math.sin(u * 9 + v * 3) * 0.015, y + Math.sin(u * 13) * 0.012, zs);
        normals.push(0, 1 / nl, (side * slope) / nl);
        uvs.push(u * roofLen * 0.55, v * Math.hypot(halfDepth, roofH) * 0.55);
      }
    }
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const a = r * (cols + 1) + c;
        const b = a + cols + 1;
        if (side > 0) indices.push(a, a + 1, b, a + 1, b + 1, b);
        else indices.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
    const slab = new THREE.BufferGeometry();
    slab.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    slab.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
    slab.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    slab.setIndex(indices);
    // Moss and grime gather on the shaded north slope and along the eaves.
    roofBuilder.add(slab, null, (_x, y) => new THREE.Color(1, 1, 1).multiplyScalar(lerp(0.82, 1.0, clamp((y - roofBase) / roofH)) * (side < 0 ? 0.92 : 1)));
    slab.dispose();
    // Underside and fascia so the eave has real thickness.
    beam(timber, 0, roofBase - 0.03, side * (halfDepth - 0.02), roofLen, 0.08, 0.2);
  }
  // Ridge tiles.
  const ridge = new THREE.CylinderGeometry(0.11, 0.11, roofLen + 0.05, 10);
  roofBuilder.add(ridge, makeMatrix(0, ridgeY + 0.01, 0, 0, 0, Math.PI / 2), "#d4ccc0");
  // Gable triangles so the ends are closed.
  for (const side of [-1, 1]) {
    const shape = new THREE.Shape();
    shape.moveTo(-halfDepth + 0.1, 0);
    shape.lineTo(0, roofH * 0.97);
    shape.lineTo(halfDepth - 0.1, 0);
    shape.closePath();
    const gable = new THREE.ShapeGeometry(shape);
    walls.add(gable, makeMatrix(side * (width / 2 - 0.02), roofBase - 0.02, 0, 0, (side * Math.PI) / 2), WALL);
    // Bargeboards along the gable edges.
    const barge = grainBox(0.16, 0.14, Math.hypot(halfDepth, roofH) + 0.25);
    const angle = Math.atan2(roofH, halfDepth);
    for (const s of [1, -1]) {
      timber.add(barge, makeMatrix(side * (width / 2 + overhang + 0.08), roofBase + roofH * 0.5, s * halfDepth * 0.5, s * angle, 0, 0), new THREE.Color(WOOD).multiplyScalar(0.9 + rand() * 0.2));
    }
    barge.dispose();
  }

  // Dormer window on grander cottages.
  if (tier >= 2) {
    const dormerZ = depth * 0.27;
    const dormerY = lerp(roofBase, ridgeY, 0.42);
    walls.add(new THREE.BoxGeometry(1.5, 1.05, 0.9, 3, 2, 2), makeMatrix(0, dormerY + 0.35, dormerZ), WALL);
    glass.add(new THREE.PlaneGeometry(0.72, 0.62), makeMatrix(0, dormerY + 0.4, dormerZ + 0.46), "#ffffff");
    for (const sx of [-1, 1]) beam(timber, sx * 0.42, dormerY + 0.4, dormerZ + 0.46, 0.08, 0.75, 0.08);
    beam(timber, 0, dormerY + 0.74, dormerZ + 0.46, 0.92, 0.08, 0.08);
    beam(timber, 0, dormerY + 0.06, dormerZ + 0.46, 0.92, 0.08, 0.08);
    // Small peaked roof.
    const miniLen = 1.9;
    roofBuilder.add(new THREE.BoxGeometry(miniLen, 0.1, 1.2), makeMatrix(0, dormerY + 1.02, dormerZ - 0.05, -0.62, 0, 0), "#ffffff");
    roofBuilder.add(new THREE.BoxGeometry(miniLen, 0.1, 1.2), makeMatrix(0, dormerY + 1.02, dormerZ + 0.72, 0.62, 0, 0), "#ffffff");
  }

  // Brick chimney with a stone cap.
  const chimX = width * 0.26;
  const chimZ = -depth * 0.14;
  const chimH = roofH + 1.4;
  brick.add(new THREE.BoxGeometry(0.9, chimH, 0.9, 2, 8, 2), makeMatrix(chimX, roofBase + chimH / 2 - 0.1, chimZ), "#a5603f");
  stone.add(new THREE.BoxGeometry(1.15, 0.18, 1.15), makeMatrix(chimX, roofBase + chimH, chimZ), "#7c7468");
  for (const dx of [-0.2, 0.2]) brick.add(new THREE.CylinderGeometry(0.1, 0.12, 0.32, 10), makeMatrix(chimX + dx, roofBase + chimH + 0.25, chimZ), "#9a5a3c");

  // Rank trappings.
  if (tier >= 1) {
    // A hanging lantern.
    const lanternX = doorW * 0.95;
    beam(timber, lanternX, 0.45 + doorH + 0.15, frontZ + 0.2, 0.08, 0.08, 0.5);
    glass.add(new THREE.BoxGeometry(0.2, 0.3, 0.2), makeMatrix(lanternX, 0.45 + doorH - 0.08, frontZ + 0.38), "#ffffff");
    trim.add(new THREE.ConeGeometry(0.17, 0.12, 4), makeMatrix(lanternX, 0.45 + doorH + 0.12, frontZ + 0.38, 0, Math.PI / 4, 0), "#2c2a28");
  }
  if (tier >= 2) {
    // Porch awning over the door.
    roofBuilder.add(new THREE.BoxGeometry(doorW + 1.5, 0.1, 1.35), makeMatrix(0, 0.45 + doorH + 0.38, frontZ + 0.55, 0.36, 0, 0), "#ffffff");
    for (const sx of [-1, 1]) {
      const post = new THREE.CylinderGeometry(0.07, 0.07, doorH + 0.4, 10);
      const pu = post.attributes.uv as THREE.BufferAttribute;
      for (let i = 0; i < pu.count; i++) pu.setXY(i, pu.getY(i) * (doorH + 0.4), pu.getX(i) * 0.4);
      timber.add(post, makeMatrix(sx * (doorW / 2 + 0.55), 0.45 + (doorH + 0.4) / 2, frontZ + 1.05), WOOD);
      post.dispose();
    }
  }

  if (tier >= 3) {
    // A small stone tower rising behind the roof, for the valley's grandest farmers.
    const towerX = width * 0.24;
    const towerZ = -depth / 2 - 0.45;
    const towerR = 1.05;
    const towerH = wallH + roofH + 2.4;
    stone.add(new THREE.CylinderGeometry(towerR, towerR * 1.12, towerH, 22, 6), makeMatrix(towerX, towerH / 2, towerZ), STONE);
    roofBuilder.add(new THREE.ConeGeometry(towerR * 1.42, 2.1, 22, 1), makeMatrix(towerX, towerH + 1.05, towerZ), "#ffffff");
    stone.add(new THREE.TorusGeometry(towerR * 1.02, 0.08, 6, 24), makeMatrix(towerX, towerH, towerZ, Math.PI / 2, 0, 0), STONE);
    glass.add(new THREE.PlaneGeometry(0.46, 0.62), makeMatrix(towerX + 0.08, towerH * 0.78, towerZ + towerR + 0.02), "#ffffff");
    beam(timber, towerX + 0.08, towerH * 0.78, towerZ + towerR + 0.05, 0.04, 0.62, 0.04);
    beam(timber, towerX + 0.08, towerH * 0.78, towerZ + towerR + 0.05, 0.46, 0.04, 0.04);
    trim.add(new THREE.CylinderGeometry(0.03, 0.03, 1.2, 6), makeMatrix(towerX, towerH + 2.6, towerZ), "#3a3530");
    trim.add(new THREE.PlaneGeometry(0.8, 0.44), makeMatrix(towerX + 0.42, towerH + 2.92, towerZ), "#b84a34");
  }

  // Materials and meshes.
  const maps = getRoofMaps();
  const wallMat = masonryMaterial("plaster");
  const timberMat = worldMaterial("wood");
  const stoneMat = masonryMaterial("stone");
  const brickMat = masonryMaterial("brick");
  const roofMaterial = new THREE.MeshStandardMaterial({ map: maps.map, normalMap: maps.normal, normalScale: new THREE.Vector2(1.3, 1.3), color: realRoofColour(roofColor), roughness: 0.72, vertexColors: true });
  roofMaterial.onBeforeCompile = (shader) => {
    shader.uniforms.uEave = { value: new THREE.Vector2(top + 0.9, top + 0.05) };
    patchSky(shader);
    shader.vertexShader = shader.vertexShader.replace("#include <common>", "#include <common>\nvarying vec3 vRoofP;").replace("#include <begin_vertex>", "#include <begin_vertex>\nvRoofP = position;");
    shader.fragmentShader = shader.fragmentShader.replace("#include <common>", "#include <common>\nvarying vec3 vRoofP;\nuniform vec2 uEave;").replace(
      "#include <color_fragment>",
      /* glsl */ `#include <color_fragment>
      {
        // Moss in the courses and along the eaves, more on the shaded slope.
        vec4 n = texture2D(uCloudTex, vRoofP.xz * 0.35 + 0.17);
        vec4 f = texture2D(uCloudTex, vMapUv * 1.7);
        float eave = smoothstep(uEave.x, uEave.y, vRoofP.y);
        float shaded = smoothstep(0.1, -0.4, vRoofP.z);
        float moss = smoothstep(0.78, 0.92, n.g * 0.5 + f.r * 0.3 + eave * 0.3 + shaded * 0.12);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.07, 0.09, 0.035) * (0.8 + f.b * 0.4), moss * 0.6);
      }`,
    );
  };
  roofMaterial.customProgramCacheKey = () => "roof-v2";
  const glassMaterial = windowMaterial(false);
  const pushMesh = (builder: GeoBuilder, material: THREE.Material) => {
    if (builder.isEmpty()) return null;
    const mesh = new THREE.Mesh(builder.build(), material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    return mesh;
  };
  const wallsMesh = pushMesh(walls, wallMat);
  const timberMesh = pushMesh(timber, timberMat);
  const stoneMesh = pushMesh(stone, stoneMat);
  const brickMesh = pushMesh(brick, brickMat);
  const trimMesh = pushMesh(trim, trimMaterial());
  const roofMesh = pushMesh(roofBuilder, roofMaterial);
  const glassMesh = pushMesh(glass, glassMaterial);
  if (glassMesh) {
    glassMesh.castShadow = false;
    glassMesh.receiveShadow = false;
  }

  const smokeAt = new THREE.Vector3(chimX, roofBase + chimH + 0.3, chimZ);
  const meshes = [wallsMesh, timberMesh, stoneMesh, brickMesh, trimMesh, roofMesh, glassMesh];
  return {
    group,
    roofMaterial,
    glassMaterial,
    smokeAt,
    dispose() {
      for (const mesh of meshes) mesh?.geometry.dispose();
      roofMaterial.dispose();
      glassMaterial.dispose();
    },
  };
}

// ----- Sign -------------------------------------------------------------------

export interface SignParts {
  group: THREE.Group;
  setText(name: string, elder: boolean, online: boolean, mine: boolean): void;
  dispose(): void;
}

export function buildSign(): SignParts {
  const group = new THREE.Group();
  const postGeo = new THREE.CylinderGeometry(0.075, 0.11, 2.1, 10);
  const postUv = postGeo.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < postUv.count; i++) postUv.setXY(i, postUv.getY(i) * 2.1, postUv.getX(i) * 0.5);
  const postColor = new Float32Array(postGeo.attributes.position.count * 3).fill(0.55);
  postGeo.setAttribute("color", new THREE.BufferAttribute(postColor, 3));
  const post = new THREE.Mesh(postGeo, worldMaterial("weathered"));
  post.position.y = 1.05;
  post.castShadow = true;
  group.add(post);

  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 256;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  const boardMat = new THREE.MeshStandardMaterial({ map: texture, roughness: 0.72 });
  boardMat.onBeforeCompile = (shader) => patchSky(shader);
  boardMat.customProgramCacheKey = () => "signboard-v2";
  // Plain box UVs: the faces carry the painted name, so they must span 0..1.
  const edgeGeo = new THREE.BoxGeometry(2.45, 1.05, 0.14);
  const edgeColor = new Float32Array(edgeGeo.attributes.position.count * 3);
  for (let i = 0; i < edgeColor.length; i += 3) edgeColor.set([0.62, 0.45, 0.3], i);
  edgeGeo.setAttribute("color", new THREE.BufferAttribute(edgeColor, 3));
  const board = new THREE.Mesh(edgeGeo, [worldMaterial("wood"), worldMaterial("wood"), worldMaterial("wood"), worldMaterial("wood"), boardMat, boardMat]);
  board.position.set(0, 2.05, 0);
  board.castShadow = true;
  group.add(board);

  const onlineDot = new THREE.Mesh(new THREE.SphereGeometry(0.11, 12, 10), new THREE.MeshStandardMaterial({ color: "#62c26a", emissive: "#2ee05a", emissiveIntensity: 1.1, roughness: 0.3 }));
  onlineDot.position.set(1.0, 2.42, 0.1);
  onlineDot.visible = false;
  group.add(onlineDot);

  let cacheKey = "";
  return {
    group,
    setText(name, elder, online, mine) {
      const key = `${name}|${elder}|${mine}`;
      onlineDot.visible = online && !elder;
      if (key === cacheKey) return;
      cacheKey = key;
      const ctx = canvas.getContext("2d")!;
      ctx.clearRect(0, 0, 512, 256);
      // Painted boards: grain, plank joints and a little wear at the edges.
      ctx.fillStyle = mine ? "#d9ad4e" : "#b98d5c";
      ctx.fillRect(0, 0, 512, 256);
      const rand = rng(name.length * 31 + 7);
      for (let i = 0; i < 220; i++) {
        const y = rand() * 256;
        ctx.strokeStyle = `rgba(${70 + rand() * 30},${45 + rand() * 20},${25},${0.08 + rand() * 0.12})`;
        ctx.lineWidth = 1 + rand() * 2;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.bezierCurveTo(170, y + (rand() - 0.5) * 10, 340, y + (rand() - 0.5) * 10, 512, y + (rand() - 0.5) * 6);
        ctx.stroke();
      }
      ctx.fillStyle = "rgba(60,38,20,.55)";
      for (let i = 1; i < 4; i++) ctx.fillRect(0, i * 64 - 1, 512, 3);
      ctx.strokeStyle = "#4a3220";
      ctx.lineWidth = 10;
      ctx.strokeRect(6, 6, 500, 244);
      let size = 72;
      ctx.font = `600 ${size}px Fredoka, sans-serif`;
      while (ctx.measureText(name).width > 460 && size > 26) {
        size -= 3;
        ctx.font = `600 ${size}px Fredoka, sans-serif`;
      }
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "#2e2016";
      ctx.fillText(name, 256, elder ? 160 : 132);
      if (elder) {
        ctx.fillStyle = "#56678c";
        ctx.beginPath();
        ctx.roundRect(166, 34, 180, 66, 14);
        ctx.fill();
        ctx.strokeStyle = "#2f3850";
        ctx.lineWidth = 5;
        ctx.stroke();
        ctx.fillStyle = "#f4ead6";
        ctx.font = "600 40px Fredoka, sans-serif";
        ctx.fillText("ELDER", 256, 68);
      }
      texture.needsUpdate = true;
    },
    dispose() {
      post.geometry.dispose();
      board.geometry.dispose();
      boardMat.dispose();
      texture.dispose();
      onlineDot.geometry.dispose();
      (onlineDot.material as THREE.Material).dispose();
    },
  };
}

// ----- Plot -------------------------------------------------------------------

let plotGeo: THREE.BufferGeometry | null = null;

/** A raised bed of soil with neat furrows and clods. Base at y = 0. */
export function plotGeometry(): THREE.BufferGeometry {
  if (plotGeo) return plotGeo;
  const geometry = new THREE.PlaneGeometry(1, 1, 30, 24);
  geometry.rotateX(-Math.PI / 2);
  const position = geometry.attributes.position as THREE.BufferAttribute;
  const uv = geometry.attributes.uv as THREE.BufferAttribute;
  const halfW = 1.04;
  const halfD = 0.92;
  for (let i = 0; i < position.count; i++) {
    const u = position.getX(i) + 0.5;
    const v = position.getZ(i) + 0.5;
    const x = (u - 0.5) * 2 * halfW;
    const z = (v - 0.5) * 2 * halfD;
    // Rounded-rectangle mound.
    const rx = Math.max(0, Math.abs(x) - (halfW - 0.3));
    const rz = Math.max(0, Math.abs(z) - (halfD - 0.3));
    const edge = Math.hypot(rx, rz) / 0.3;
    const body = smooth(1, 0.15, edge);
    const furrows = Math.sin((z / halfD) * 4.5 * Math.PI) * 0.035 * smooth(0.8, 0.2, edge);
    const clods = (Math.sin(x * 11 + z * 7) * Math.sin(x * 5 - z * 13) + Math.sin(x * 23 - z * 17) * 0.4) * 0.007;
    position.setXYZ(i, x, Math.max(-0.02, body * (0.17 + furrows) + clods * body - 0.015), z);
    uv.setXY(i, x * 0.8 + 0.37, z * 0.8 + 0.11);
  }
  geometry.computeVertexNormals();
  plotGeo = geometry;
  return geometry;
}

let plotMats: { dry: THREE.MeshStandardMaterial; wet: THREE.MeshStandardMaterial } | null = null;

export function plotMaterials() {
  if (plotMats) return plotMats;
  const textures = groundTextures();
  const make = (color: string, roughness: number) => {
    const material = new THREE.MeshStandardMaterial({ map: textures.dirt, normalMap: textures.dirtNormal, normalScale: new THREE.Vector2(1.6, 1.6), color, roughness });
    material.onBeforeCompile = (shader) => patchSky(shader);
    material.customProgramCacheKey = () => "soil-v2";
    return material;
  };
  const dry = make("#8a6248", 0.97);
  const wet = make("#4e3424", 0.42);
  plotMats = { dry, wet };
  return plotMats;
}

// ----- Nest and eggs ------------------------------------------------------------

let nestGeo: THREE.BufferGeometry | null = null;

function nestGeometry(): THREE.BufferGeometry {
  if (nestGeo) return nestGeo;
  const builder = new GeoBuilder();
  const rand = rng(99);
  // The bowl, lined with soft dry grass.
  const points: THREE.Vector2[] = [];
  for (let i = 0; i <= 16; i++) {
    const t = i / 16;
    points.push(new THREE.Vector2(Math.sin(t * Math.PI * 0.55) * 1.46, 0.08 + (1 - Math.cos(t * Math.PI * 0.55)) * 0.24));
  }
  const bowl = new THREE.LatheGeometry(points, 28);
  builder.add(bowl, null, (x, _y, z) => {
    const r = Math.hypot(x, z) / 1.46;
    return new THREE.Color("#8a6a40").multiplyScalar(0.7 + r * 0.45);
  });
  // Woven sticks wrapped around the rim, several rings, with straw in between.
  const stick = new THREE.CapsuleGeometry(0.03, 0.8, 1, 4);
  const stickUv = stick.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < stickUv.count; i++) stickUv.setXY(i, stickUv.getY(i) * 0.9, stickUv.getX(i) * 0.2);
  for (let ring = 0; ring < 4; ring++) {
    const count = 22 + ring * 3;
    for (let i = 0; i < count; i++) {
      const a = (i / count) * TAU + ring * 0.3 + rand() * 0.15;
      const radius = 1.42 + ring * 0.12 + rand() * 0.06;
      const y = 0.18 + ring * 0.12 + rand() * 0.04;
      const m = new THREE.Matrix4().compose(
        new THREE.Vector3(Math.cos(a) * radius, y, Math.sin(a) * radius),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2 + (rand() - 0.5) * 0.5, 0, -a + Math.PI / 2 + (rand() - 0.5) * 0.7)),
        new THREE.Vector3(0.9 + rand() * 0.6, 1, 0.9 + rand() * 0.6),
      );
      const tone = rand();
      const color = new THREE.Color("#7a5a36").lerp(new THREE.Color("#b8925c"), tone);
      builder.add(stick, m, color);
    }
  }
  nestGeo = builder.build();
  return nestGeo;
}

const nestMaterial = () => worldMaterial("weathered");

const EGG_CAP = 40;

/** Where each egg sits: rings in layers so even a full nest stays tidy. */
export function eggSlot(index: number, count: number): { x: number; y: number; z: number; tilt: number; layer: number } {
  // Layer 0: 1 + 7 + 13 eggs. Layer 1: 1 + 7 + 11 eggs. Layout scales with the nest.
  const layers = [
    [1, 7, 13],
    [1, 7, 11],
  ];
  let i = index;
  for (let layer = 0; layer < layers.length; layer++) {
    for (let ring = 0; ring < layers[layer].length; ring++) {
      const ringCount = layers[layer][ring];
      if (i < ringCount) {
        const radius = ring === 0 ? 0 : ring === 1 ? 0.5 : 1.0;
        const a = (i / ringCount) * TAU + ring * 0.5 + layer * 0.4;
        const lift = 0.06 + layer * 0.34 + ring * 0.05;
        return { x: Math.cos(a) * radius, y: lift, z: Math.sin(a) * radius, tilt: 0.1 + ring * 0.08, layer };
      }
      i -= ringCount;
    }
  }
  void count;
  return { x: 0, y: 0.8, z: 0, tilt: 0, layer: 1 };
}

export interface NestParts {
  group: THREE.Group;
  eggs: THREE.InstancedMesh;
  eggColorA: THREE.InstancedBufferAttribute;
  eggColorB: THREE.InstancedBufferAttribute;
  eggState: THREE.InstancedBufferAttribute;
  count: number;
  /** Shows up to EGG_CAP eggs. Returns the count drawn. */
  setCount(n: number): void;
  dispose(): void;
}

export function buildNest(): NestParts {
  const group = new THREE.Group();
  const nest = new THREE.Mesh(nestGeometry(), nestMaterial());
  nest.castShadow = true;
  nest.receiveShadow = true;
  group.add(nest);

  const base = eggGeometry();
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute("position", base.attributes.position);
  geometry.setAttribute("normal", base.attributes.normal);
  geometry.setAttribute("uv", base.attributes.uv);
  geometry.setIndex(base.index);
  const colorA = new THREE.InstancedBufferAttribute(new Float32Array(EGG_CAP * 3), 3);
  const colorB = new THREE.InstancedBufferAttribute(new Float32Array(EGG_CAP * 3), 3);
  const state = new THREE.InstancedBufferAttribute(new Float32Array(EGG_CAP * 4), 4);
  colorA.setUsage(THREE.DynamicDrawUsage);
  colorB.setUsage(THREE.DynamicDrawUsage);
  state.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute("aColorA", colorA);
  geometry.setAttribute("aColorB", colorB);
  geometry.setAttribute("aEggState", state);
  const material = makeEggMaterial();
  const eggs = new THREE.InstancedMesh(geometry, material, EGG_CAP);
  eggs.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  eggs.count = 0;
  eggs.castShadow = true;
  eggs.receiveShadow = true;
  eggs.frustumCulled = false;
  group.add(eggs);

  const parts: NestParts = {
    group,
    eggs,
    eggColorA: colorA,
    eggColorB: colorB,
    eggState: state,
    count: 0,
    setCount(n: number) {
      parts.count = Math.min(EGG_CAP, n);
      eggs.count = parts.count;
      // A crowded nest grows so the eggs still fit.
      const scale = clamp(1 + Math.max(0, parts.count - 7) * 0.02, 1, 1.55);
      nest.scale.set(scale, 1, scale);
    },
    dispose() {
      eggs.dispose();
      geometry.dispose();
      material.dispose();
    },
  };
  return parts;
}

export const EGG_LIMIT = EGG_CAP;
