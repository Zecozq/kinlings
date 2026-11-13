// Reusable 3D race course pieces. Another module assembles them into a race;
// the valley's sky, lights and post-processing are re-exported from here so a
// race looks like the same world.
//
// To avoid shader-compile stutter, call warmUpTrackShaders(renderer, scene, camera)
// after building the scene (bind post.sceneTarget first when using PostFX).
//
// Conventions: world units are metres. The race runs towards -Z along a course
// whose centre line is x = xBend(z) (pluggable, straight by default). Lanes are
// 3.5 m wide with centres at x = -3.5, 0, +3.5 before bending, y = 0 is the
// ground. Nothing here assumes a fixed course length or position: every
// builder takes a z range, or returns a piece you place yourself.
//
//   import { createDirtTrack, createTrackGround, createTrackScenery, createObstacle,
//            createPickup, createFireball, createFrostCloud, createLightning,
//            createWindDash, createShieldBubble, createVineTrap, createBlinkShimmer,
//            createDustPuffs, Atmosphere, PostFX, dayPhase, detectQuality } from "./track.ts";
//
// TRACK
//   createDirtTrack({ zStart, zEnd, width, xBend? }) -> { mesh, dispose() }
//     Packed dirt with worn lanes, scuffs, pebbles and ragged grassy edges. It is a
//     decal over the ground. Build it as one piece for the whole course or in chunks:
//     positions are absolute, so chunks with the same xBend line up.
//   createTrackGround({ zStart, zEnd, xBend?, halfWidth?, trackHalfWidth? }) -> { mesh, dispose() }
//     Meadow and far fields to lay the strip on, with grass and wildflowers that
//     follow the camera (they are children of the mesh).
//
// SCENERY
//   createTrackScenery({ zStart, zEnd, width, xBend?, seed?, quality? })
//     -> { group, update(dt, cameraZ?), dispose() }
//     Trees and forest edges, grandstands with a cheering crowd, banners, bunting
//     and hay bales on both sides, split into chunks, and the mountains on the
//     horizon. Pass cameraZ to update() so only nearby chunks draw.
//
// OBSTACLES   createObstacle("log"|"rock"|"thorn"|"mud"|"ramp", { lanes?: 1|2|3, laneWidth? })
// PICKUPS     createPickup("berry"|"orb")
//   Both return a Piece: { group, update(dt), dispose(), width, depth, height }.
//   The group's origin is on the ground at the piece's centre and it spans
//   lanes * laneWidth across x. Set group.position to place it (apply xBend
//   yourself: group.position.x = laneCentre + xBend(z)). Ramps rise towards -Z.
//
// EFFECTS  All return an Effect: { object: THREE.Object3D, update(dt): boolean, dispose() }
//   Add object to the scene, call update(dt) each frame, and remove and dispose
//   the effect when update returns false. Move an effect by setting object.position.
//   createFireball({ scale? })       fireball with a trail; effect.explode(parent) spawns
//                                    and returns an explosion Effect at its position.
//   createFrostCloud(position, { radius? })   freezing cloud that drifts and fades.
//   createLightning(from, to)        bolt with a ground flash, about 0.6 s long.
//   createWindDash(position, direction, { length? })   streaks of speed.
//   createShieldBubble({ radius?, color? })   lasts until effect.finish(), then fades;
//                                    parent its object to a Kinling's group.
//   createVineTrap(position, { radius? })    vines burst up and curl; effect.finish() to end.
//   createBlinkShimmer(position, { color? })  flash and particles at a teleport.
//   createDustPuffs(position, { count? })     kicks of dust from feet.

import * as THREE from "three";
import { TAU, clamp, detectQuality, lerp, rng, smooth, type Quality } from "./gfx.ts";
import { GLSL_NOISE } from "./gfx.ts";
import { TreeField, barkMaterial, createBushField, createGrassCarpet, tubeGeometry, type TreePlacement, windTime } from "./flora.ts";
import { kinWarmupSet } from "./kin3d.ts";
import { lookFromGenes, type Look } from "../creature.ts";
import { patchSky, skyUniforms, warmShadowCasters } from "./atmosphere.ts";
import { MountainRing, boulderGeometry, grainBox, groundTextures, makeGroundMaterial, worldMaterial } from "./landscape.ts";
import { GeoBuilder, makeMatrix } from "./parts.ts";

export { Atmosphere, PostFX, dayPhase, nightness, DAY_LENGTH } from "./atmosphere.ts";
export { detectQuality, filmMode, type Quality } from "./gfx.ts";
export { windTime } from "./flora.ts";
export * from "./vfx.ts";
import { createHaloSprite, type Effect } from "./vfx.ts";
import { createBlinkShimmer, createDustPuffs, createFireball, createFrostCloud, createLightning, createShieldBubble, createVineTrap, createWindDash } from "./vfx.ts";

export interface Piece {
  group: THREE.Group;
  update(dt: number): void;
  dispose(): void;
  /** Extent across the lanes (x), metres. */
  width: number;
  /** Extent along the course (z), metres. */
  depth: number;
  height: number;
  /** Half of width, for simple collision. */
  radius: number;
}

// ----- Warm-up ----------------------------------------------------------------

/**
 * Compiles the shaders of every obstacle, pickup, effect and creature variant
 * ahead of time, so they do not stall a frame during the race. The objects are
 * added to the given scene, compiled, then removed again and disposed.
 * Call this after you add your scene content and before the race starts.
 */
export async function warmUpTrackShaders(renderer: THREE.WebGLRenderer, scene: THREE.Object3D, camera: THREE.Camera): Promise<() => void> {
  const holder = new THREE.Group();
  scene.add(holder);
  const pieces: Piece[] = [
    ...(["log", "rock", "thorn", "mud", "ramp"] as const).map((kind) => createObstacle(kind)),
    createPickup("berry"),
    createPickup("orb"),
  ];
  for (const piece of pieces) {
    piece.group.traverse((child) => {
      child.visible = true;
    });
    holder.add(piece.group);
  }
  const origin = new THREE.Vector3(0, 1, 0);
  const effects: Effect[] = [
    createFireball(),
    createFrostCloud(origin),
    createLightning(origin, origin.clone().add(new THREE.Vector3(1, 3, 0))),
    createWindDash(origin, new THREE.Vector3(0, 0, -1)),
    createShieldBubble(),
    createVineTrap(origin),
    createBlinkShimmer(origin),
    createDustPuffs(origin),
  ];
  for (const effect of effects) {
    effect.object.traverse((child) => {
      child.visible = true;
    });
    holder.add(effect.object);
  }
  const kins = kinWarmupSet(warmupLook());
  for (const kin of kins) holder.add(kin.group);
  // Scenery chunks far from the start are hidden by update(); show them all while compiling.
  const hidden: THREE.Object3D[] = [];
  scene.traverse((child) => {
    if (!child.visible && child.userData.trackChunk) {
      hidden.push(child);
      child.visible = true;
    }
  });
  // Programs must match the target they will draw into. If your scene renders
  // through PostFX, bind post.sceneTarget before calling this function.
  await renderer.compileAsync(scene, camera);
  // Shadow-map depth programs are only built when a caster meets the sun's
  // shadow camera, so render the shadow map once around each kind of caster.
  const target = renderer.getRenderTarget();
  warmShadowCasters(renderer, scene, camera);
  renderer.setRenderTarget(target);
  for (const child of hidden) child.visible = false;
  scene.remove(holder);
  // These stay alive until the caller is finished: disposing a material throws
  // away its compiled shader, and the real effect would have to compile it again.
  return () => {
    for (const piece of pieces) piece.dispose();
    for (const effect of effects) effect.dispose();
    for (const kin of kins) kin.dispose();
  };
}

function warmupLook(): Look {
  return lookFromGenes([0, 0, 1, 1, 1, 1, 0, 0, 3, 3, 0, 0, 2, 2, 4, 4, 3, 0, 3, 0, 3, 0, 0]);
}

// ----- Shared helpers ------------------------------------------------------------

export type BendFn = (z: number) => number;

const STRAIGHT: BendFn = () => 0;

const plainMats = new Map<string, THREE.MeshStandardMaterial>();

/** A vertex-coloured standard material under the shared sky. One program for many props. */
function plainMaterial(roughness: number, metalness = 0, side: THREE.Side = THREE.FrontSide): THREE.MeshStandardMaterial {
  const key = `${roughness}:${metalness}:${side}`;
  let material = plainMats.get(key);
  if (material) return material;
  material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness, metalness, side });
  material.onBeforeCompile = (shader) => patchSky(shader);
  material.customProgramCacheKey = () => "plain-v2";
  plainMats.set(key, material);
  return material;
}

/** Fills a geometry's colour attribute with one colour, or a function of position. */
function paint(geometry: THREE.BufferGeometry, color: THREE.ColorRepresentation | ((x: number, y: number, z: number) => THREE.Color)): THREE.BufferGeometry {
  const pos = geometry.attributes.position as THREE.BufferAttribute;
  const colors = new Float32Array(pos.count * 3);
  const constant = typeof color === "function" ? null : new THREE.Color(color);
  for (let i = 0; i < pos.count; i++) {
    const c = constant ?? (color as (x: number, y: number, z: number) => THREE.Color)(pos.getX(i), pos.getY(i), pos.getZ(i));
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return geometry;
}

/** Merges indexed geometries that share position, normal, uv and colour, then frees the parts. */
function mergeParts(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let count = 0;
  let indexCount = 0;
  for (const g of parts) {
    count += g.attributes.position.count;
    indexCount += g.index ? g.index.count : g.attributes.position.count;
  }
  const names = ["position", "normal", "uv", "color"] as const;
  const sizes = { position: 3, normal: 3, uv: 2, color: 3 };
  const arrays = Object.fromEntries(names.map((n) => [n, new Float32Array(count * sizes[n])])) as Record<(typeof names)[number], Float32Array>;
  const indices = new Uint32Array(indexCount);
  let v = 0;
  let k = 0;
  for (const g of parts) {
    const n = g.attributes.position.count;
    for (const name of names) {
      const attr = g.getAttribute(name) as THREE.BufferAttribute | undefined;
      if (attr) arrays[name].set(attr.array as Float32Array, v * sizes[name]);
      else if (name === "color") arrays.color.fill(1, v * 3, (v + n) * 3);
    }
    if (g.index) for (let i = 0; i < g.index.count; i++) indices[k++] = g.index.getX(i) + v;
    else for (let i = 0; i < n; i++) indices[k++] = v + i;
    v += n;
    g.dispose();
  }
  const merged = new THREE.BufferGeometry();
  for (const name of names) merged.setAttribute(name, new THREE.BufferAttribute(arrays[name], sizes[name]));
  merged.setIndex(new THREE.BufferAttribute(indices, 1));
  return merged;
}

/** The course's centre line as a texture, so shaders can tell track from field. */
function bakeBend(bend: BendFn, z0: number, z1: number): THREE.DataTexture {
  const samples = 1024;
  const data = new Float32Array(samples * 4);
  for (let i = 0; i < samples; i++) data[i * 4] = bend(lerp(z0, z1, i / (samples - 1)));
  const texture = new THREE.DataTexture(data, samples, 1, THREE.RGBAFormat, THREE.FloatType);
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

// ----- Track ------------------------------------------------------------------

export interface TrackOptions {
  /** World z of the two ends. The order does not matter. */
  zStart: number;
  zEnd: number;
  /** Total width, for example 3 lanes of 3.5 m = 10.5. */
  width: number;
  /** Centre line x at a given z. Straight along x = 0 if omitted. */
  xBend?: BendFn;
}

const TRACK_FRAGMENT = /* glsl */ `
  vec2 wp = vTrackW.xz;
  float across = vTrackA;
  vec4 macro = texture2D(uCloudTex, wp * 0.0113 + 0.21);
  vec4 meso = texture2D(uCloudTex, wp * 0.047 + 0.63);
  vec4 small = texture2D(uCloudTex, wp * 0.21 + 0.17);
  vec2 dUv = wp / 2.1;
  vec3 dirt = texture2D(uDirtMap, dUv).rgb;
  // Worn running lines: darker, compacted, smoother.
  float lane = 0.0;
  for (int k = -1; k <= 1; k++) {
    float d = across - float(k) * 3.5;
    lane = max(lane, exp(-d * d / 0.9));
  }
  float scuff = smoothstep(0.58, 0.8, texture2D(uCloudTex, vec2(wp.x * 0.9, wp.y * 0.33) + 0.4).a) * lane;
  vec3 col = dirt * mix(vec3(1.04, 1.0, 0.95), vec3(0.8, 0.75, 0.7), lane * 0.65) * mix(0.9, 1.08, macro.r);
  col *= 1.0 - scuff * 0.22;
  // Loose, paler dust kicked to the sides of each lane.
  float loose = (1.0 - lane) * smoothstep(0.42, 0.72, meso.b);
  col = mix(col, col * vec3(1.14, 1.1, 1.04) + vec3(0.015, 0.012, 0.008), loose * 0.55);
  // Ragged grassy edges: the decal thins out into the field below.
  float edgeDist = uTrackHalf - abs(across);
  float ragged = (meso.r - 0.5) * 1.1 + (small.g - 0.5) * 0.5;
  float alpha = smoothstep(-0.1, 0.5, edgeDist + ragged + (small.a - 0.5) * 0.35);
  col *= mix(0.82, 1.0, smoothstep(0.0, 1.2, edgeDist));
  // Damp patches where water stood: darker and a little glossy.
  float puddle = smoothstep(0.66, 0.78, macro.a * 0.55 + meso.g * 0.55) * (1.0 - lane * 0.7);
  col = mix(col, col * vec3(0.62, 0.58, 0.55), puddle * 0.7);
  diffuseColor.rgb = col;
  diffuseColor.a = alpha;
  float trackRough = mix(mix(0.93, 0.8, lane), 0.5, puddle * 0.7);
  puddle *= 0.15;
  vec2 dn = texture2D(uDirtNor, dUv).xy * 2.0 - 1.0;
  vec3 trackDetail = vec3(dn.x * (1.0 - lane * 0.5), 1.0, dn.y * (1.0 - lane * 0.5)) * vec3(1.0 - puddle, 1.0, 1.0 - puddle);
`;

const TRACK_NORMAL = /* glsl */ `
  {
    vec3 nW = inverseTransformDirection( normal, viewMatrix );
    vec3 tX = normalize( cross( nW, vec3( 0.0, 0.0, 1.0 ) ) );
    vec3 tZ = cross( tX, nW );
    vec3 d = normalize( trackDetail );
    normal = normalize( ( viewMatrix * vec4( normalize( tX * d.x * 0.8 + nW * d.y + tZ * d.z * 0.8 ), 0.0 ) ).xyz );
  }
`;

/** Packed dirt following the course, a decal over the ground with soft ragged edges. */
export function createDirtTrack(options: TrackOptions) {
  const z0 = Math.min(options.zStart, options.zEnd);
  const z1 = Math.max(options.zStart, options.zEnd);
  const length = z1 - z0;
  const width = options.width + 1.2;
  const bend = options.xBend ?? STRAIGHT;
  const segments = Math.max(1, Math.ceil(length / 1.5));
  const across = 14;
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i <= segments; i++) {
    const z = z0 + (i / segments) * length;
    const centre = bend(z);
    // Keep the strip square to the bend so it doesn't shear on curves.
    const slope = bend(z - 0.5) - bend(z + 0.5);
    const nx = 1 / Math.hypot(1, slope);
    const nz = slope * nx;
    for (let j = 0; j <= across; j++) {
      const v = j / across;
      const offset = (v - 0.5) * width;
      const crown = 0.012 * (1 - Math.pow(Math.abs(v * 2 - 1), 2));
      positions.push(centre + offset * nx, 0.012 + crown, z - offset * nz);
      uvs.push(z, offset);
    }
  }
  for (let i = 0; i < segments; i++) {
    for (let j = 0; j < across; j++) {
      const a = i * (across + 1) + j;
      const b = a + across + 1;
      indices.push(a, b + 1, a + 1, a, b, b + 1);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const textures = groundTextures();
  // Opaque with ragged alpha-to-coverage edges, drawn before the field so the
  // ground under the track is skipped by the depth test instead of shaded twice.
  const material = new THREE.MeshStandardMaterial({ roughness: 0.9, alphaTest: 0.5 });
  material.alphaToCoverage = true;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uDirtMap = { value: textures.dirt };
    shader.uniforms.uDirtNor = { value: textures.dirtNormal };
    shader.uniforms.uTrackHalf = { value: options.width / 2 + 0.2 };
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vTrackW;\nvarying float vTrackA;")
      .replace("#include <worldpos_vertex>", "#include <worldpos_vertex>\nvTrackW = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvTrackA = uv.y;");
    patchSky(shader);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vTrackW;\nvarying float vTrackA;\nuniform sampler2D uDirtMap, uDirtNor;\nuniform float uTrackHalf;")
      .replace("#include <map_fragment>", TRACK_FRAGMENT)
      .replace("#include <roughnessmap_fragment>", "float roughnessFactor = trackRough;")
      .replace("#include <normal_fragment_maps>", TRACK_NORMAL);
  };
  material.customProgramCacheKey = () => "dirt-track-v2";
  const mesh = new THREE.Mesh(geometry, material);
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  mesh.renderOrder = -10;
  return {
    mesh,
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}

/**
 * A wide field to lay the strip on: trampled verges, meadow with dry patches,
 * patchwork farmland far away, and grass and flowers that follow the camera.
 */
export function createTrackGround(options: { zStart: number; zEnd: number; xBend?: BendFn; halfWidth?: number; trackHalfWidth?: number; quality?: Quality }) {
  const z0 = Math.min(options.zStart, options.zEnd) - 40;
  const z1 = Math.max(options.zStart, options.zEnd) + 40;
  const halfWidth = options.halfWidth ?? 240;
  const trackHalf = options.trackHalfWidth ?? 6.7;
  const bend = options.xBend ?? STRAIGHT;
  const quality = options.quality ?? detectQuality();
  const length = z1 - z0;
  const segments = Math.max(2, Math.ceil(length / 8));
  const columns = 24;
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i <= segments; i++) {
    const z = z0 + (i / segments) * length;
    const centre = bend(z);
    for (let j = 0; j <= columns; j++) {
      // Columns bunch up near the course and spread out far away.
      const s = (j / columns) * 2 - 1;
      const x = centre + Math.sign(s) * Math.pow(Math.abs(s), 2.2) * halfWidth;
      // Gentle swells far from the course, flat where the racers run.
      const far = smooth(30, 120, Math.abs(x - centre));
      const y = far * (Math.sin(x * 0.021 + z * 0.013) * 1.6 + Math.sin(z * 0.031 - x * 0.007) * 1.1) - far * 0.8;
      positions.push(x, y, z);
      uvs.push(x / 7, z / 7);
    }
  }
  for (let i = 0; i < segments; i++) {
    for (let j = 0; j < columns; j++) {
      const a = i * (columns + 1) + j;
      const b = a + columns + 1;
      indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const bendTex = bakeBend(bend, z0, z1);
  const material = makeGroundMaterial({ bend: { texture: bendTex, z0, length, halfWidth: trackHalf } });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  mesh.renderOrder = 1;

  const carpets: THREE.Mesh[] = [];
  const low = quality === "low";
  const carpetOptions = { bend, z0, z1, clearHalfWidth: trackHalf - 0.2 };
  // Strips of grass beside the course: dense near the camera, sparser further out.
  carpets.push(createGrassCarpet({ ...carpetOptions, width: 12, depth: 30, ahead: 9, density: low ? 2.4 : quality === "medium" ? 4 : 5.5 }));
  carpets.push(createGrassCarpet({ ...carpetOptions, width: 30, depth: 72, ahead: 26, blades: 4, density: low ? 0.4 : quality === "medium" ? 0.65 : 0.85 }));
  if (!low) {
    carpets.push(createGrassCarpet({ ...carpetOptions, width: 24, depth: 60, ahead: 20, density: 0.06, flowerKind: 0 }));
    carpets.push(createGrassCarpet({ ...carpetOptions, width: 24, depth: 60, ahead: 20, density: 0.045, flowerKind: 2 }));
    carpets.push(createGrassCarpet({ ...carpetOptions, width: 24, depth: 60, ahead: 20, density: 0.03, flowerKind: 4 }));
  }
  for (const carpet of carpets) {
    carpet.renderOrder = 0;
    mesh.add(carpet);
  }
  return {
    mesh,
    dispose() {
      geometry.dispose();
      material.dispose();
      bendTex.dispose();
      for (const carpet of carpets) carpet.geometry.dispose();
    },
  };
}

// ----- Scenery ----------------------------------------------------------------

export interface SceneryOptions {
  zStart: number;
  zEnd: number;
  width: number;
  xBend?: BendFn;
  seed?: number;
  quality?: Quality;
}

/** Cloth that moves in the wind, with woven texture and light glowing through it. */
function makeClothMaterial(timeUniform: { value: number }, flutter: number, pattern: "banner" | "stripes" | "pennant") {
  // One program for every pattern (picked by a uniform), to keep start-up compiles down.
  const material = new THREE.MeshStandardMaterial({ roughness: 0.82, side: THREE.DoubleSide, vertexColors: true });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uT = timeUniform;
    shader.uniforms.uFlutter = { value: flutter };
    shader.uniforms.uPattern = { value: pattern === "banner" ? 0 : pattern === "stripes" ? 1 : 2 };
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\nuniform float uT;\nuniform float uFlutter;\nvarying vec2 vClothUv;\nvarying float vClothWave;\nvarying float vClothKind;`)
      .replace(
        "#include <begin_vertex>",
        /* glsl */ `#include <begin_vertex>
        {
          float free = 1.0 - uv.y;
          #ifdef USE_INSTANCING
            float phase = instanceMatrix[3][0] * 0.37 + instanceMatrix[3][2] * 0.23;
            vClothKind = float(gl_InstanceID);
          #else
            float phase = 0.0;
            vClothKind = 0.0;
          #endif
          float wave = sin(uT * 4.2 + free * 5.5 + uv.x * 2.2 + phase) + 0.45 * sin(uT * 7.1 + free * 11.0 + phase * 1.7);
          vClothWave = wave;
          transformed.z += wave * free * uFlutter;
          transformed.x += sin(uT * 3.0 + free * 3.0 + phase) * free * uFlutter * 0.3;
          vClothUv = uv;
        }
        `,
      );
    patchSky(shader);
    const patternCode = /* glsl */ `
      if (uPattern < 0.5) {
        // Heraldic banners: a border, and a chevron, a roundel or bands by instance.
        vec3 trim = vec3(0.92, 0.86, 0.72);
        float border = step(vClothUv.x, 0.07) + step(0.93, vClothUv.x) + step(0.965, vClothUv.y);
        float kind = mod(floor(vClothKind + 0.5), 3.0);
        float motif = 0.0;
        if (kind < 0.5) motif = step(abs(vClothUv.y - 0.55 - abs(vClothUv.x - 0.5) * 0.8), 0.06);
        else if (kind < 1.5) motif = step(length((vClothUv - vec2(0.5, 0.62)) * vec2(1.0, 3.5)), 0.32) - step(length((vClothUv - vec2(0.5, 0.62)) * vec2(1.0, 3.5)), 0.22);
        else motif = step(0.5, fract(vClothUv.y * 5.0));
        diffuseColor.rgb = mix(diffuseColor.rgb, trim * 0.85, clamp(border + motif, 0.0, 1.0));
        // Swallowtail.
        if (vClothUv.y < 0.08 && abs(vClothUv.x - 0.5) < (0.08 - vClothUv.y) * 4.0) discard;
      } else if (uPattern < 1.5) {
        float stripe = step(0.5, fract(vClothUv.x * 9.0));
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.9, 0.86, 0.78), stripe);
      }`;
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\nvarying vec2 vClothUv;\nvarying float vClothWave;\nvarying float vClothKind;\nuniform float uPattern;`)
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
        ${patternCode}
        {
          // Weave and the folds the wind makes.
          float weave = 0.94 + 0.06 * sin(vClothUv.x * 900.0) * sin(vClothUv.y * 1200.0);
          diffuseColor.rgb *= weave * (0.86 + 0.14 * vClothWave * 0.5 + 0.07);
        }`,
      )
      .replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>
        {
          vec3 vd = normalize(vViewPosition);
          vec3 l = normalize((viewMatrix * vec4(uSunDirW, 0.0)).xyz);
          float through = pow(clamp(dot(vd, l), 0.0, 1.0), 2.0);
          totalEmissiveRadiance += diffuseColor.rgb * through * 0.35;
        }`,
      );
  };
  material.customProgramCacheKey = () => "cloth-v3";
  return material;
}

/**
 * Spectators: sitting villagers with ears, some in hats. Vertex colours are part
 * masks (R clothes, G skin, B hat), aPart says which limb moves.
 */
function crowdGeometry(): THREE.BufferGeometry {
  const parts: { geo: THREE.BufferGeometry; mask: [number, number, number]; part: number }[] = [];
  const add = (geo: THREE.BufferGeometry, m: THREE.Matrix4, mask: [number, number, number], part: number) => {
    geo.applyMatrix4(m);
    parts.push({ geo: geo.index ? geo.toNonIndexed() : geo, mask, part });
  };
  add(new THREE.CapsuleGeometry(0.17, 0.3, 1, 6), makeMatrix(0, 0.62, 0, -0.08, 0, 0, 1, 1, 0.8), [1, 0, 0], 0);
  add(new THREE.BoxGeometry(0.3, 0.13, 0.42), makeMatrix(0, 0.36, -0.16), [1, 0, 0], 0);
  add(new THREE.BoxGeometry(0.26, 0.36, 0.1), makeMatrix(0, 0.18, -0.36), [0.6, 0, 0], 0);
  add(new THREE.SphereGeometry(0.13, 7, 5), makeMatrix(0, 1.0, -0.02), [0, 1, 0], 1);
  add(new THREE.ConeGeometry(0.045, 0.12, 3, 1, true), makeMatrix(0.08, 1.12, 0, 0, 0, -0.35), [0, 1, 0], 1);
  add(new THREE.ConeGeometry(0.045, 0.12, 3, 1, true), makeMatrix(-0.08, 1.12, 0, 0, 0, 0.35), [0, 1, 0], 1);
  add(new THREE.CylinderGeometry(0.12, 0.16, 0.08, 6), makeMatrix(0, 1.12, -0.02), [0, 0, 1], 1);
  add(new THREE.CylinderGeometry(0.2, 0.2, 0.015, 8, 1, true), makeMatrix(0, 1.08, -0.02), [0, 0, 1], 1);
  for (const side of [-1, 1]) {
    add(new THREE.CapsuleGeometry(0.05, 0.32, 1, 4), makeMatrix(side * 0.22, 0.67, -0.05, 0.2, 0, side * 0.12), [0.85, 0.15, 0], side < 0 ? 2 : 3);
  }
  let count = 0;
  for (const p of parts) count += p.geo.attributes.position.count;
  const position = new Float32Array(count * 3);
  const normal = new Float32Array(count * 3);
  const color = new Float32Array(count * 3);
  const part = new Float32Array(count);
  let o = 0;
  for (const p of parts) {
    const n = p.geo.attributes.position.count;
    position.set(p.geo.attributes.position.array as Float32Array, o * 3);
    normal.set(p.geo.attributes.normal.array as Float32Array, o * 3);
    for (let i = 0; i < n; i++) {
      color.set(p.mask, (o + i) * 3);
      part[o + i] = p.part;
    }
    o += n;
    p.geo.dispose();
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(position, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(normal, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(color, 3));
  geometry.setAttribute("aPart", new THREE.BufferAttribute(part, 1));
  return geometry;
}

function makeCrowdMaterial(timeUniform: { value: number }, excite: { value: number }) {
  const material = new THREE.MeshStandardMaterial({ roughness: 0.8, vertexColors: true });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uT = timeUniform;
    shader.uniforms.uExcite = excite;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\nuniform float uT;\nuniform float uExcite;\nattribute float aPart;\nvarying vec3 vMask;\nvarying vec3 vSkin;\nvarying vec3 vHat;\n${GLSL_NOISE}`)
      .replace(
        "#include <begin_vertex>",
        /* glsl */ `#include <begin_vertex>
        {
          vec3 iPos = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
          float id = hash21(iPos.xz * 1.7 + iPos.y);
          float t = uT;
          float keen = fract(id * 7.31);
          float excite = clamp(uExcite * (0.55 + keen * 0.7), 0.0, 1.0);
          // Arms: most rest on knees, the keen ones wave, everyone waves when racers pass.
          if (aPart > 1.5) {
            float side = aPart < 2.5 ? -1.0 : 1.0;
            vec3 pivot = vec3(side * 0.22, 0.84, -0.03);
            float raise = clamp(max(excite, step(0.82, keen) * 0.6) * (0.75 + 0.25 * sin(t * 2.0 + id * 11.0 + side)), 0.0, 1.0);
            float a = -mix(0.0, 2.7, raise);
            vec3 q = transformed - pivot;
            q = vec3(q.x, q.y * cos(a) - q.z * sin(a), q.y * sin(a) + q.z * cos(a));
            float wave = sin(t * 8.0 + id * 30.0 + side * 1.3) * 0.45 * raise;
            q = vec3(q.x * cos(wave) - q.y * sin(wave) * side, q.x * sin(wave) * side + q.y * cos(wave), q.z);
            transformed = q + pivot;
          }
          // Heads look about, hats only on some.
          if (aPart > 0.5 && aPart < 1.5) {
            float turn = sin(t * 0.6 + id * 17.0) * 0.5 * (1.0 - excite * 0.6);
            vec3 q = transformed - vec3(0.0, 0.9, 0.0);
            transformed = vec3(q.x * cos(turn) + q.z * sin(turn), q.y, -q.x * sin(turn) + q.z * cos(turn)) + vec3(0.0, 0.9, 0.0);
            if (color.b > 0.5 && fract(id * 3.7) > 0.35) transformed = vec3(0.0, 1.0, 0.0);
          }
          float hop = abs(sin(t * (5.0 + id * 3.0) + id * 20.0));
          transformed.y += hop * (0.015 + excite * 0.22 * step(0.3, keen));
          vMask = color;
          float s = fract(id * 13.3);
          vSkin = s < 0.25 ? vec3(0.78, 0.55, 0.42) : s < 0.5 ? vec3(0.56, 0.37, 0.25) : s < 0.75 ? vec3(0.36, 0.22, 0.15) : vec3(0.85, 0.66, 0.52);
          float h = fract(id * 5.9);
          vHat = h < 0.3 ? vec3(0.75, 0.62, 0.38) : h < 0.6 ? vec3(0.18, 0.2, 0.28) : vec3(0.55, 0.15, 0.12);
        }
        `,
      )
      .replace("#include <color_vertex>", "#include <color_vertex>\n#ifdef USE_INSTANCING_COLOR\nvColor = instanceColor;\n#endif");
    patchSky(shader);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vMask;\nvarying vec3 vSkin;\nvarying vec3 vHat;")
      .replace(
        "#include <color_fragment>",
        "#include <color_fragment>\ndiffuseColor.rgb = diffuseColor.rgb * vMask.r + vSkin * vMask.g + vHat * vMask.b;\ndiffuseColor.rgb *= 0.75 + 0.25 * vMask.r;",
      );
  };
  material.customProgramCacheKey = () => "crowd-v2";
  return material;
}

const CLOTHES = ["#33507a", "#7a2f2a", "#d8cfbd", "#c19a3c", "#3e5b39", "#5a5a5e", "#8a5a3a", "#2c2f3a", "#a8462f", "#6b7fa3", "#e0b45a", "#4b6b6a"];

/** Trees, forest edges, grandstands with a cheering crowd, banners, bunting and hay along the course. */
export function createTrackScenery(options: SceneryOptions) {
  const width = options.width;
  const z0 = Math.min(options.zStart, options.zEnd);
  const z1 = Math.max(options.zStart, options.zEnd);
  const quality = options.quality ?? detectQuality();
  const bend = options.xBend ?? STRAIGHT;
  const low = quality === "low";
  const group = new THREE.Group();
  const disposables: { dispose(): void }[] = [];
  const time = { value: 0 };

  const ring = new MountainRing();
  group.add(ring.group);
  disposables.push(ring);

  const planks = worldMaterial("planks");
  const oak = worldMaterial("wood");
  const straw = worldMaterial("straw");
  const rope = plainMaterial(0.9);
  const crowdGeo = crowdGeometry();
  const bannerMaterial = makeClothMaterial(time, 0.16, "banner");
  const roofMaterial = makeClothMaterial(time, 0.035, "stripes");
  const pennantMaterial = makeClothMaterial(time, 0.07, "pennant");
  const bannerGeo = paint(new THREE.PlaneGeometry(1.2, 4.2, 6, 14), "#ffffff");
  bannerGeo.translate(0, -2.1, 0);
  const pennantGeo = new THREE.BufferGeometry();
  pennantGeo.setAttribute("position", new THREE.Float32BufferAttribute([-0.24, 0, 0, 0.24, 0, 0, 0, -0.5, 0, -0.12, -0.25, 0, 0.12, -0.25, 0], 3));
  pennantGeo.setAttribute("normal", new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
  pennantGeo.setAttribute("uv", new THREE.Float32BufferAttribute([0, 1, 1, 1, 0.5, 0, 0.25, 0.5, 0.75, 0.5], 2));
  pennantGeo.setIndex([0, 3, 1, 3, 4, 1, 3, 2, 4]);
  paint(pennantGeo, "#ffffff");
  const poleGeo = paint(new THREE.CylinderGeometry(0.07, 0.1, 8.6, 8), "#d9c8a4");
  {
    // Grain along the pole: u in metres along it, v around.
    const uv = poleGeo.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getY(i) * 8.6, uv.getX(i) * 0.5);
  }
  const baleGeo = paint(grainBox(1.1, 0.5, 0.55, 2), (x, y, z) => new THREE.Color("#d8b56a").multiplyScalar(0.86 + Math.sin(x * 5 + y * 9 + z * 7) * 0.05));
  disposables.push(crowdGeo, bannerMaterial, roofMaterial, pennantMaterial, bannerGeo, pennantGeo, poleGeo, baleGeo);
  const bannerColours = ["#a8352b", "#2f5f8a", "#c79a2e", "#5a3f7a", "#2f6b52", "#b5536e"].map((c) => new THREE.Color(c));
  const pennantColours = ["#b8432f", "#2f6a9a", "#d9a631", "#6a4a8c", "#3f8a64", "#e6dccb"].map((c) => new THREE.Color(c));
  const treeSpacing = low ? 13 : 8;
  const bannerSpacing = low ? 26 : 16;
  const chunks: { group: THREE.Group; centre: number; excite?: { value: number }; standZ?: number }[] = [];

  const CHUNK = 80;
  let chunkIndex = 0;
  const yAxis = new THREE.Vector3(0, 1, 0);
  for (let cz = z0; cz < z1; cz += CHUNK, chunkIndex++) {
    const chunkEnd = Math.min(z1, cz + CHUNK);
    const rand = rng((options.seed ?? 7) * 1000 + chunkIndex);
    const chunk = new THREE.Group();
    chunk.userData.trackChunk = true;
    const side = chunkIndex % 2 ? 1 : -1;
    const standZ = (cz + chunkEnd) / 2;
    const clearOfStand = (x: number, z: number) => !(Math.sign(x - bend(z)) === side && Math.abs(z - standZ) < 13 && Math.abs(x - bend(z)) < width / 2 + 16);

    // Trees set back from the shoulders, and a denser forest edge further out.
    const placements: TreePlacement[] = [];
    for (let z = cz; z < chunkEnd; z += treeSpacing + rand() * 6) {
      for (const s of [1, -1]) {
        const x = bend(z) + s * (width / 2 + 8 + rand() * 18);
        if (!clearOfStand(x, z)) continue;
        const pick = rand();
        placements.push({ x, y: 0, z: z + rand() * 3, scale: 0.8 + rand() * 0.6, rotation: rand() * TAU, variant: pick < 0.4 ? 0 : pick < 0.65 ? 1 : pick < 0.85 ? 3 : 2 });
      }
    }
    if (placements.length > 0) {
      const trees = new TreeField(placements, { lowDetail: low });
      chunk.add(trees.group);
      disposables.push(trees);
    }
    if (!low) {
      const edge: TreePlacement[] = [];
      for (let z = cz; z < chunkEnd; z += 5 + rand() * 4) {
        for (const s of [1, -1]) {
          const x = bend(z) + s * (width / 2 + 46 + rand() * 40);
          edge.push({ x, y: 0, z: z + rand() * 4, scale: 0.9 + rand() * 0.6, rotation: rand() * TAU, variant: rand() < 0.55 ? 2 : rand() < 0.5 ? 0 : 1 });
        }
      }
      const forest = new TreeField(edge, { lowDetail: true, castShadow: false, contact: false });
      chunk.add(forest.group);
      disposables.push(forest);
    }

    // A grandstand per chunk, alternating sides.
    const stand = new THREE.Group();
    const steps = 5;
    const depth = 1.6;
    const standWidth = 18;
    const woodB = new GeoBuilder();
    const plankB = new GeoBuilder();
    for (let s = 0; s < steps; s++) {
      const top = 0.45 + s * 0.85;
      // Bench seat, its riser and the walkway behind.
      plankB.add(grainBox(standWidth, 0.07, 0.42), makeMatrix(0, top, s * depth + 0.05), new THREE.Color("#b08a5e").multiplyScalar(0.9 + rand() * 0.15));
      plankB.add(grainBox(standWidth, 0.06, depth - 0.45), makeMatrix(0, top - 0.42, s * depth + 0.75), new THREE.Color("#9c7a52").multiplyScalar(0.85 + rand() * 0.15));
      plankB.add(grainBox(standWidth, 0.85, 0.05), makeMatrix(0, top - 0.42, s * depth + depth - 0.02), new THREE.Color("#8a6a48").multiplyScalar(0.85 + rand() * 0.1));
    }
    // Back boards; the ends stay open so the crowd can be seen along the course.
    plankB.add(grainBox(standWidth, 4.6, 0.06), makeMatrix(0, 2.3, steps * depth + 0.1), "#8c6b4a");
    for (const sx of [-1, 1]) plankB.add(grainBox(0.06, 0.9, steps * depth), makeMatrix((sx * standWidth) / 2, 0.45, (steps * depth) / 2), "#86664a");
    // Frame: posts, rafters and braces.
    for (let i = 0; i <= 6; i++) {
      const px = -standWidth / 2 + (i / 6) * standWidth;
      woodB.add(grainBox(0.18, 7.8, 0.18), makeMatrix(px, 3.9, -1.0), "#6e5236");
      woodB.add(grainBox(0.18, 7.2, 0.18), makeMatrix(px, 3.6, steps * depth + 0.2), "#6e5236");
      woodB.add(grainBox(0.12, 0.16, steps * depth + 1.6), makeMatrix(px, 7.45, (steps * depth) / 2 - 0.4, -0.07, 0, 0), "#6e5236");
    }
    woodB.add(grainBox(standWidth + 0.4, 0.2, 0.16), makeMatrix(0, 7.65, -1.0), "#6e5236");
    const standWood = new THREE.Mesh(woodB.build(), oak);
    const standPlanks = new THREE.Mesh(plankB.build(), planks);
    for (const m of [standWood, standPlanks]) {
      m.castShadow = true;
      m.receiveShadow = true;
      stand.add(m);
      disposables.push(m.geometry);
    }
    // Striped canvas roof with a scalloped valance.
    const roofGeo = new THREE.PlaneGeometry(standWidth + 1.6, steps * depth + 2.2, 18, 6);
    roofGeo.rotateX(-Math.PI / 2 - 0.12);
    const rp = roofGeo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < rp.count; i++) {
      const x = rp.getX(i);
      rp.setY(i, rp.getY(i) - Math.pow(Math.sin(((x / (standWidth + 1.6)) * 6 + 0.5) * Math.PI), 2) * 0.12);
    }
    roofGeo.computeVertexNormals();
    paint(roofGeo, side > 0 ? "#2f5f8a" : "#a8352b");
    const roof = new THREE.Mesh(roofGeo, roofMaterial);
    roof.position.set(0, 7.75, (steps * depth) / 2 - 0.3);
    roof.castShadow = true;
    roof.receiveShadow = true;
    stand.add(roof);
    disposables.push(roofGeo);
    const valance = new THREE.InstancedMesh(pennantGeo, pennantMaterial, 30);
    const vm = new THREE.Matrix4();
    const vq = new THREE.Quaternion();
    for (let i = 0; i < 30; i++) {
      vm.compose(new THREE.Vector3(-standWidth / 2 - 0.5 + (i + 0.5) * ((standWidth + 1.0) / 30), 7.62, -1.12), vq.identity(), new THREE.Vector3(1.25, 0.6, 1));
      valance.setMatrixAt(i, vm);
      valance.setColorAt(i, i % 2 ? new THREE.Color("#e6dccb") : side > 0 ? new THREE.Color("#2f5f8a") : new THREE.Color("#a8352b"));
    }
    valance.instanceMatrix.needsUpdate = true;
    if (valance.instanceColor) valance.instanceColor.needsUpdate = true;
    valance.frustumCulled = false;
    stand.add(valance);
    disposables.push(valance);

    // The crowd.
    const perRow = low ? 12 : 22;
    const people = perRow * steps;
    const excite = { value: 0 };
    const crowdMaterial = makeCrowdMaterial(time, excite);
    disposables.push(crowdMaterial);
    const crowd = new THREE.InstancedMesh(crowdGeo, crowdMaterial, people);
    const matrix = new THREE.Matrix4();
    const color = new THREE.Color();
    const quat = new THREE.Quaternion();
    for (let p = 0; p < people; p++) {
      const row = p % steps;
      const px = -standWidth / 2 + 0.6 + ((Math.floor(p / steps) + rand() * 0.6) / perRow) * (standWidth - 1.2);
      const py = 0.45 + row * 0.85 - 0.33;
      const pz = row * depth + 0.15 + rand() * 0.1;
      const s = 0.85 + rand() * 0.3;
      quat.setFromAxisAngle(yAxis, Math.PI + (rand() - 0.5) * 0.5);
      matrix.compose(new THREE.Vector3(px, py, pz), quat, new THREE.Vector3(s, s, s));
      crowd.setMatrixAt(p, matrix);
      color.set(CLOTHES[Math.floor(rand() * CLOTHES.length)]).multiplyScalar(0.8 + rand() * 0.35);
      crowd.setColorAt(p, color);
    }
    crowd.instanceMatrix.needsUpdate = true;
    if (crowd.instanceColor) crowd.instanceColor.needsUpdate = true;
    crowd.castShadow = true;
    crowd.receiveShadow = true;
    crowd.frustumCulled = false;
    stand.add(crowd);
    disposables.push(crowd);
    stand.position.set(bend(standZ) + side * (width / 2 + 3.4), 0, standZ);
    stand.rotation.y = (side * Math.PI) / 2;
    chunk.add(stand);

    // Hay bales stacked along the verge in front of the stand and here and there.
    const bales: THREE.Matrix4[] = [];
    const bm = new THREE.Matrix4();
    const bq = new THREE.Quaternion();
    const addBale = (x: number, y: number, z: number, angle: number) => {
      bq.setFromAxisAngle(yAxis, angle);
      bm.compose(new THREE.Vector3(x, y, z), bq, new THREE.Vector3(1, 1, 1));
      bales.push(bm.clone());
    };
    for (let k = -7; k <= 7; k++) {
      const z = standZ + k * 1.15;
      const x = bend(z) + side * (width / 2 + 0.9);
      const angle = Math.atan(bend(z - 0.5) - bend(z + 0.5)) + Math.PI / 2;
      addBale(x, 0.25, z, angle + (rand() - 0.5) * 0.06);
      if (k % 3 === 0) addBale(x, 0.75, z + 0.3, angle + (rand() - 0.5) * 0.1);
    }
    for (let z = cz + 10; z < chunkEnd; z += 26 + rand() * 18) {
      const s = rand() < 0.5 ? 1 : -1;
      const x = bend(z) + s * (width / 2 + 1.1 + rand() * 0.6);
      if (!clearOfStand(x, z)) continue;
      const angle = Math.atan(bend(z - 0.5) - bend(z + 0.5)) + Math.PI / 2;
      for (let k = 0; k < 3; k++) addBale(x, 0.25, z + k * 1.15, angle);
      addBale(x, 0.75, z + 0.6, angle + 0.05);
    }
    const baleMesh = new THREE.InstancedMesh(baleGeo, straw, bales.length);
    bales.forEach((m, i) => baleMesh.setMatrixAt(i, m));
    baleMesh.instanceMatrix.needsUpdate = true;
    baleMesh.castShadow = true;
    baleMesh.receiveShadow = true;
    baleMesh.frustumCulled = false;
    chunk.add(baleMesh);
    disposables.push(baleMesh);

    // Banners on tall poles, bunting strung between them.
    const lines: THREE.Vector3[][] = [[], []];
    const bannerSpots: { x: number; z: number; s: number }[] = [];
    for (let z = cz; z < chunkEnd; z += bannerSpacing) {
      [1, -1].forEach((bside, sideIndex) => {
        const x = bend(z) + bside * (width / 2 + 2);
        bannerSpots.push({ x, z, s: bside });
        lines[sideIndex].push(new THREE.Vector3(x, 8.35, z));
      });
    }
    const poles = new THREE.InstancedMesh(poleGeo, oak, Math.max(1, bannerSpots.length));
    const banners = new THREE.InstancedMesh(bannerGeo, bannerMaterial, Math.max(1, bannerSpots.length));
    bannerSpots.forEach((spot, i) => {
      matrix.compose(new THREE.Vector3(spot.x, 4.3, spot.z), quat.identity(), new THREE.Vector3(1, 1, 1));
      poles.setMatrixAt(i, matrix);
      quat.setFromAxisAngle(yAxis, Math.PI / 2);
      matrix.compose(new THREE.Vector3(spot.x, 8.25, spot.z + 0.72), quat, new THREE.Vector3(1, 1, 1));
      banners.setMatrixAt(i, matrix);
      banners.setColorAt(i, bannerColours[Math.floor(rand() * bannerColours.length)]);
    });
    poles.count = banners.count = bannerSpots.length;
    for (const m of [poles, banners]) {
      m.instanceMatrix.needsUpdate = true;
      m.castShadow = true;
      m.frustumCulled = false;
      chunk.add(m);
      disposables.push(m);
    }
    if (banners.instanceColor) banners.instanceColor.needsUpdate = true;
    for (const line of lines) {
      if (line.length < 2) continue;
      const flagsPerSpan = 11;
      const flags = new THREE.InstancedMesh(pennantGeo, pennantMaterial, (line.length - 1) * flagsPerSpan);
      const flagMatrix = new THREE.Matrix4();
      const flagQuat = new THREE.Quaternion().setFromAxisAngle(yAxis, Math.PI / 2);
      let index = 0;
      const ropePoints: THREE.Vector3[] = [];
      for (let i = 0; i < line.length - 1; i++) {
        for (let k = 0; k <= 10; k++) {
          const t = k / 10;
          const p = line[i].clone().lerp(line[i + 1], t);
          p.y += -Math.sin(t * Math.PI) * 1.6 + 0.1;
          if (k < 10 || i === line.length - 2) ropePoints.push(p);
        }
        for (let f = 0; f < flagsPerSpan; f++) {
          const t2 = (f + 0.5) / flagsPerSpan;
          const p = line[i].clone().lerp(line[i + 1], t2);
          p.y += -Math.sin(t2 * Math.PI) * 1.6 + 0.1;
          flagMatrix.compose(p, flagQuat, new THREE.Vector3(1, 1, 1));
          flags.setMatrixAt(index, flagMatrix);
          flags.setColorAt(index, pennantColours[f % pennantColours.length]);
          index++;
        }
      }
      flags.instanceMatrix.needsUpdate = true;
      if (flags.instanceColor) flags.instanceColor.needsUpdate = true;
      flags.frustumCulled = false;
      chunk.add(flags);
      disposables.push(flags);
      const cord = new THREE.Mesh(paint(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(ropePoints), ropePoints.length * 2, 0.012, 3, false), "#d8cdb6"), rope);
      cord.frustumCulled = false;
      chunk.add(cord);
      disposables.push(cord.geometry);
    }

    group.add(chunk);
    chunks.push({ group: chunk, centre: (cz + chunkEnd) / 2, excite, standZ });
  }

  return {
    group,
    update(dt: number, cameraZ?: number) {
      time.value += dt;
      windTime.value += dt;
      if (cameraZ !== undefined) {
        for (const c of chunks) {
          c.group.visible = Math.abs(c.centre - cameraZ) < 150;
          if (c.excite && c.standZ !== undefined) {
            // The crowd rises to cheer as the racers come past.
            const near = smooth(55, 8, Math.abs(c.standZ - cameraZ + 6));
            c.excite.value += (near - c.excite.value) * Math.min(1, dt * (near > c.excite.value ? 3 : 0.6));
          }
        }
        ring.update(bend(cameraZ), cameraZ, time.value, skyUniforms.uNight.value);
      }
    },
    dispose() {
      for (const item of disposables) item.dispose();
    },
  };
}

// ----- Obstacles ---------------------------------------------------------------

interface Span {
  width: number;
}

function piece(group: THREE.Group, width: number, depth: number, height: number, update: (dt: number) => void, disposables: { dispose(): void }[]): Piece {
  return {
    group,
    width,
    depth,
    height,
    radius: width / 2,
    update,
    dispose() {
      for (const item of disposables) item.dispose();
    },
  };
}

/** A fallen trunk across the lanes: furrowed bark, burls, sawn ends, moss on the top. */
function createLog(span: Span): Piece {
  const group = new THREE.Group();
  const length = span.width * 0.96;
  const radius = 0.6;
  const geometry = new THREE.CylinderGeometry(radius, radius * 1.06, length, 30, Math.max(6, Math.round(length * 3)), true);
  const pos = geometry.attributes.position as THREE.BufferAttribute;
  const uv = geometry.attributes.uv as THREE.BufferAttribute;
  const noiseTex = (a: number, y: number) => Math.sin(a * 3 + y * 1.3) * 0.5 + Math.sin(a * 7.1 - y * 2.7) * 0.3 + Math.sin(a * 13.3 + y * 5.1) * 0.2;
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const a = Math.atan2(z, x);
    const burl = Math.exp(-Math.pow((y - length * 0.18) / 0.4, 2)) * Math.exp(-Math.pow(Math.sin((a - 0.8) / 2) / 0.35, 2)) * 0.12;
    const r = 1 + noiseTex(a, y) * 0.035 + burl;
    pos.setXYZ(i, x * r, y, z * r);
    uv.setXY(i, (a / TAU + 0.5) * Math.max(3, Math.round((radius * TAU) / 0.5)), y / 1.1);
    // Moss and damp on top (local +x becomes up once the log is laid down), darker beneath.
    const up = x / radius;
    const moss = smooth(0.55, 0.95, up + noiseTex(a * 2, y * 2) * 0.25);
    const c = new THREE.Color(1, 1, 1).multiplyScalar(lerp(0.72, 1.0, smooth(-0.8, 0.2, up))).lerp(new THREE.Color("#7f9a4a"), moss * 0.75);
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  const bark = barkMaterial("rough");
  // One instance, so it shares the instanced bark program with the trees.
  const log = new THREE.InstancedMesh(geometry, bark, 1);
  log.setMatrixAt(0, new THREE.Matrix4());
  log.rotation.z = Math.PI / 2;
  log.position.y = radius * 0.92;
  log.castShadow = true;
  log.receiveShadow = true;
  group.add(log);
  // Sawn ends.
  const endGeo = paint(new THREE.CircleGeometry(radius * 1.03, 30), "#c9a77a");
  const ends = worldMaterial("endgrain");
  for (const s of [-1, 1]) {
    const end = new THREE.Mesh(endGeo, ends);
    end.position.set((s * length) / 2 * 1.0, radius * 0.92, 0);
    end.rotation.y = (s * Math.PI) / 2;
    end.scale.setScalar(s > 0 ? 1.06 : 1);
    end.castShadow = true;
    group.add(end);
  }
  // Broken branch stubs.
  const stubs: THREE.BufferGeometry[] = [];
  const rand = rng(Math.round(length * 10));
  const stubCount = Math.max(1, Math.round(length / 2.5));
  for (let i = 0; i < stubCount; i++) {
    const x = (rand() - 0.5) * length * 0.75;
    const a = rand() * Math.PI - Math.PI / 2;
    const base = new THREE.Vector3(x, radius * 0.92 + Math.sin(a) * radius * 0.9, Math.cos(a) * radius * 0.9);
    const dir = new THREE.Vector3(rand() - 0.5, Math.sin(a) + 0.4, Math.cos(a)).normalize();
    const stub = tubeGeometry([base.clone().addScaledVector(dir, -0.15), base.clone().addScaledVector(dir, 0.25), base.clone().addScaledVector(dir, 0.5).add(new THREE.Vector3(0, 0.05, 0))], (t) => lerp(0.09, 0.03, t), 7, 3, () => new THREE.Color(0.85, 0.85, 0.85));
    stubs.push(stub);
  }
  const stubGeo = mergeParts(stubs);
  const stubMesh = new THREE.InstancedMesh(stubGeo, bark, 1);
  stubMesh.setMatrixAt(0, new THREE.Matrix4());
  stubMesh.castShadow = true;
  group.add(stubMesh);
  // Bracket fungi on the shaded side.
  const fungusGeo = paint(new THREE.SphereGeometry(0.12, 10, 5, 0, Math.PI), (x, y) => new THREE.Color("#c8a06a").multiplyScalar(0.7 + y * 2 + x));
  fungusGeo.scale(1.2, 0.35, 1);
  const fungi = new THREE.InstancedMesh(fungusGeo, plainMaterial(0.7), 4);
  const fm = new THREE.Matrix4();
  for (let i = 0; i < 4; i++) {
    const x = (rand() - 0.5) * length * 0.6;
    fm.compose(new THREE.Vector3(x, radius * (0.55 + i * 0.12), radius * 1.0), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI / 2 + (rand() - 0.5) * 0.5, 0)), new THREE.Vector3(1 - i * 0.15, 1, 1 - i * 0.15));
    fungi.setMatrixAt(i, fm);
  }
  fungi.castShadow = true;
  fungi.frustumCulled = false;
  group.add(fungi);
  return piece(group, length, 1.3, 1.25, () => undefined, [geometry, endGeo, fungusGeo, fungi, stubGeo, log, stubMesh]);
}

const boulderGeos = new Map<number, THREE.BufferGeometry>();
function boulder(seed: number) {
  let geo = boulderGeos.get(seed);
  if (!geo) {
    geo = boulderGeometry(seed, 5);
    boulderGeos.set(seed, geo);
  }
  return geo;
}

/** Granite boulders across the lanes, mossy and crusted with lichen, with stones around. */
function createRocks(span: Span): Piece {
  const group = new THREE.Group();
  const count = Math.max(1, Math.round(span.width / 3.3));
  const rand = rng(3);
  const material = worldMaterial("rock");
  for (let i = 0; i < count; i++) {
    const rock = new THREE.Mesh(boulder(i % 3), material);
    const scale = 0.85 + rand() * 0.35;
    rock.scale.set(1.5 * scale, 1.1 * scale, 1.25 * scale);
    rock.rotation.set((rand() - 0.5) * 0.25, rand() * TAU, (rand() - 0.5) * 0.25);
    rock.position.set(count === 1 ? 0 : (i / (count - 1) - 0.5) * (span.width - 2.6), 0.62 * scale, (rand() - 0.5) * 0.6);
    rock.castShadow = true;
    rock.receiveShadow = true;
    group.add(rock);
  }
  const pebbles = new THREE.InstancedMesh(boulder(3), material, count * 5);
  const m = new THREE.Matrix4();
  for (let i = 0; i < count * 5; i++) {
    const s = 0.12 + rand() * 0.22;
    const x = (rand() - 0.5) * (span.width - 0.8);
    const z = (rand() < 0.5 ? -1 : 1) * (1.0 + rand() * 0.6);
    m.compose(new THREE.Vector3(x, s * 0.45, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rand(), rand() * TAU, rand())), new THREE.Vector3(s * 1.3, s, s * 1.1));
    pebbles.setMatrixAt(i, m);
  }
  pebbles.castShadow = true;
  pebbles.receiveShadow = true;
  pebbles.frustumCulled = false;
  group.add(pebbles);
  return piece(group, span.width * 0.92, 2.6, 1.5, () => undefined, [pebbles]);
}

let berryMat: THREE.MeshPhysicalMaterial | null = null;
/** Glossy fruit flesh: deep colour, a wet clearcoat and a little inner glow. */
function berryMaterial() {
  if (berryMat) return berryMat;
  berryMat = new THREE.MeshPhysicalMaterial({ color: "#ffffff", roughness: 0.28, clearcoat: 1, clearcoatRoughness: 0.06, sheen: 0.3, sheenColor: new THREE.Color("#ff8a9a"), sheenRoughness: 0.4 });
  berryMat.onBeforeCompile = (shader) => {
    patchSky(shader, { cloudShadow: false });
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <emissivemap_fragment>",
      "#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * diffuseColor.rgb * 0.9;",
    );
  };
  berryMat.customProgramCacheKey = () => "berry-v2";
  return berryMat;
}

/** Bramble hedge: arching thorny canes, leaves, blackberries and white flowers. */
function createThornHedge(span: Span): Piece {
  const group = new THREE.Group();
  const length = span.width * 0.96;
  const rand = rng(17);
  const canes: THREE.BufferGeometry[] = [];
  const thornPoints: { p: THREE.Vector3; d: THREE.Vector3 }[] = [];
  const caneCount = Math.max(8, Math.round(length * 5));
  for (let i = 0; i < caneCount; i++) {
    const x0 = (rand() - 0.5) * length;
    const reach = 1.0 + rand() * 1.4;
    const x1 = clamp(x0 + (rand() < 0.5 ? -1 : 1) * reach, -length / 2, length / 2);
    const z0 = (rand() - 0.5) * 0.9;
    const z1 = (rand() - 0.5) * 1.1;
    const h = 0.9 + rand() * 0.75;
    const pts = [new THREE.Vector3(x0, -0.05, z0), new THREE.Vector3(lerp(x0, x1, 0.3), h, lerp(z0, z1, 0.3) + (rand() - 0.5) * 0.3), new THREE.Vector3(lerp(x0, x1, 0.7), h * 0.85, lerp(z0, z1, 0.7)), new THREE.Vector3(x1, 0.1 + rand() * 0.4, z1)];
    const tint = new THREE.Color().setHSL(0.02 + rand() * 0.08, 0.45, 0.22 + rand() * 0.08);
    canes.push(tubeGeometry(pts, (t) => lerp(0.032, 0.012, t), 5, 8, () => tint));
    const curve = new THREE.CatmullRomCurve3(pts);
    for (let k = 0; k < 16; k++) {
      const t = (k + rand()) / 16;
      const p = curve.getPoint(t);
      const tangent = curve.getTangent(t);
      const out = new THREE.Vector3(rand() - 0.5, rand() - 0.2, rand() - 0.5).normalize().addScaledVector(tangent, -0.6).normalize();
      thornPoints.push({ p, d: out });
    }
  }
  const caneGeo = mergeParts(canes);
  const caneMesh = new THREE.Mesh(caneGeo, plainMaterial(0.55));
  caneMesh.castShadow = true;
  group.add(caneMesh);
  const thornGeo = paint(new THREE.ConeGeometry(0.014, 0.07, 4).translate(0, 0.035, 0), (_x, y) => new THREE.Color("#7a3a2a").lerp(new THREE.Color("#e4caa0"), clamp(y / 0.07)));
  const thorns = new THREE.InstancedMesh(thornGeo, plainMaterial(0.5), thornPoints.length);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  thornPoints.forEach(({ p, d }, i) => {
    q.setFromUnitVectors(up, d);
    m.compose(p, q, new THREE.Vector3(1, 1, 1));
    thorns.setMatrixAt(i, m);
  });
  thorns.frustumCulled = false;
  group.add(thorns);
  // Leaves: the shrub foliage, low and dense.
  const bushCount = Math.max(3, Math.round(length / 0.75));
  const bushes = createBushField(
    Array.from({ length: bushCount }, (_, i) => ({
      x: (i / Math.max(1, bushCount - 1) - 0.5) * (length - 0.6) + (rand() - 0.5) * 0.3,
      y: 0,
      z: (rand() - 0.5) * 0.4,
      scale: 0.85 + rand() * 0.35,
      rotation: rand() * TAU,
    })),
  );
  group.add(bushes.group);
  // Blackberries, ripe and not.
  const berryGeo = new THREE.SphereGeometry(0.035, 8, 6);
  const berryCount = Math.round(length * 9);
  const berries = new THREE.InstancedMesh(berryGeo, berryMaterial(), berryCount);
  const color = new THREE.Color();
  for (let i = 0; i < berryCount; i++) {
    const t = thornPoints[Math.floor(rand() * thornPoints.length)];
    m.compose(t.p.clone().add(new THREE.Vector3(0, 0.04, 0)), q.identity(), new THREE.Vector3(1, 1.15, 1));
    berries.setMatrixAt(i, m);
    const ripe = rand();
    berries.setColorAt(i, ripe < 0.6 ? color.set("#1a0c18") : ripe < 0.85 ? color.set("#6a1020") : color.set("#b52a2a"));
  }
  if (berries.instanceColor) berries.instanceColor.needsUpdate = true;
  berries.frustumCulled = false;
  group.add(berries);
  return piece(group, length, 1.9, 1.7, () => undefined, [thornGeo, thorns, bushes, berryGeo, berries, caneGeo]);
}

let mudMat: THREE.MeshStandardMaterial | null = null;

/** Wet mud: dark and glossy, with standing water in the hollows and drying crust at the rim. */
function mudMaterial(time: { value: number }) {
  if (mudMat) return mudMat;
  const material = new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 0.3, metalness: 0 });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uT = time;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vMudP;\nvarying float vMudH;\nattribute float aMud;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvMudP = position;\nvMudH = aMud;");
    patchSky(shader);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform float uT;\nvarying vec3 vMudP;\nvarying float vMudH;")
      .replace(
        "#include <color_fragment>",
        /* glsl */ `#include <color_fragment>
        float r = length(vMudP.xz);
        vec4 n1 = texture2D(uCloudTex, vMudP.xz * 0.35 + 0.2);
        vec4 n2 = texture2D(uCloudTex, vMudP.xz * 1.3 + 0.6);
        // Splatter beyond the rim breaks up into spots.
        if (r > 1.0 && r - 1.0 > (n2.g - 0.35) * 0.55) discard;
        float rim = smoothstep(0.78, 1.0, r);
        float water = smoothstep(0.012, -0.01, vMudH + (n1.r - 0.5) * 0.03) * (1.0 - rim);
        vec3 wet = mix(vec3(0.075, 0.05, 0.032), vec3(0.11, 0.075, 0.048), n2.r);
        vec3 crust = mix(vec3(0.24, 0.18, 0.12), vec3(0.32, 0.25, 0.17), n2.b);
        float crack = smoothstep(0.04, 0.0, abs(n2.a - 0.5)) * rim;
        vec3 mud = mix(wet, crust, rim * smoothstep(0.3, 0.7, n1.g));
        mud = mix(mud, mud * 0.4, crack);
        mud = mix(mud, vec3(0.035, 0.03, 0.025), water);
        diffuseColor.rgb = mud;
        float mudRough = mix(mix(0.22, 0.75, rim), 0.03, water);
        float mudHeight = n2.r * 0.6 + n1.b * 0.4 + sin(r * 30.0 - uT * 1.5) * 0.02 * water;`,
      )
      .replace("#include <roughnessmap_fragment>", "float roughnessFactor = mudRough;")
      .replace(
        "#include <normal_fragment_maps>",
        /* glsl */ `#include <normal_fragment_maps>
        {
          vec3 sx = dFdx(-vViewPosition);
          vec3 sy = dFdy(-vViewPosition);
          vec3 r1 = cross(sy, normal);
          vec3 r2 = cross(normal, sx);
          float det = dot(sx, r1);
          vec3 grad = sign(det) * (dFdx(mudHeight) * r1 + dFdy(mudHeight) * r2) * mix(0.03, 0.004, water);
          normal = normalize(abs(det) * normal - grad);
        }`,
      );
  };
  material.customProgramCacheKey = () => "mud-v2";
  mudMat = material;
  return material;
}

/** A sticky mud patch spanning the lanes, an ellipse wider than it is deep. */
function createMudPit(span: Span): Piece {
  const group = new THREE.Group();
  const time = { value: 0 };
  const rx = span.width * 0.48;
  const rz = 2.1;
  // A polar grid so the surface can sag and heave.
  const rings = 14;
  const segments = 56;
  const positions: number[] = [];
  const muds: number[] = [];
  const indices: number[] = [];
  const rand = rng(11);
  const bumps = Array.from({ length: 9 }, () => ({ a: rand() * TAU, r: 0.3 + rand() * 0.6, s: 0.12 + rand() * 0.15, h: (rand() - 0.3) * 0.05 }));
  for (let i = 0; i <= rings; i++) {
    const r = (i / rings) * 1.32;
    for (let j = 0; j < segments; j++) {
      const a = (j / segments) * TAU;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      let h = -0.035 * (1 - smooth(0.6, 1.0, r)) + 0.04 * Math.exp(-Math.pow((r - 1.0) / 0.12, 2));
      for (const b of bumps) {
        const dx = x - Math.cos(b.a) * b.r;
        const dz = z - Math.sin(b.a) * b.r;
        h += b.h * Math.exp(-(dx * dx + dz * dz) / (b.s * b.s));
      }
      // Kept above the track decal (about 2.5 cm) so the dirt never shows through.
      positions.push(x, Math.max(-0.03, h) + 0.065, z);
      muds.push(h);
    }
  }
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < segments; j++) {
      const a = i * segments + j;
      const b = i * segments + ((j + 1) % segments);
      const c = a + segments;
      const d = b + segments;
      indices.push(a, b, c, b, d, c);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("aMud", new THREE.Float32BufferAttribute(muds, 1));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const material = mudMaterial(time);
  // One instance, so the pit and its bubbles share one program.
  const pit = new THREE.InstancedMesh(geometry, material, 1);
  pit.setMatrixAt(0, new THREE.Matrix4());
  pit.scale.set(rx, 1, rz);
  pit.receiveShadow = true;
  group.add(pit);
  // Bubbles that swell and pop.
  const bubbleGeo = new THREE.SphereGeometry(1, 10, 6, 0, TAU, 0, Math.PI / 2);
  const bubbleCount = Math.round(span.width * 1.4);
  const bubbleMesh = new THREE.InstancedMesh(bubbleGeo, material, bubbleCount);
  bubbleMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  const bubbles: { x: number; z: number; phase: number; speed: number }[] = [];
  for (let i = 0; i < bubbleCount; i++) {
    const r = Math.sqrt(rand()) * 0.75;
    const a = rand() * TAU;
    bubbles.push({ x: Math.cos(a) * r * rx, z: Math.sin(a) * r * rz, phase: rand(), speed: 0.35 + rand() * 0.5 });
  }
  bubbleMesh.frustumCulled = false;
  group.add(bubbleMesh);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const p = new THREE.Vector3();
  return piece(
    group,
    rx * 2,
    rz * 2,
    0.2,
    (dt) => {
      time.value += dt;
      bubbles.forEach((b, i) => {
        const t = (time.value * b.speed + b.phase) % 1;
        const swell = Math.sin(t * Math.PI) * (t < 0.96 ? 1 : 0);
        s.set(0.04 + swell * 0.13, 0.03 + swell * 0.1, 0.04 + swell * 0.13);
        p.set(b.x, 0.045, b.z);
        m.compose(p, q, s);
        bubbleMesh.setMatrixAt(i, m);
      });
      bubbleMesh.instanceMatrix.needsUpdate = true;
    },
    [geometry, bubbleGeo, bubbleMesh, pit],
  );
}

/** A plank ramp across the lanes, rising towards -Z, on a braced timber frame. */
function createRamp(span: Span): Piece {
  const group = new THREE.Group();
  const length = 3.4;
  const halfWidth = (span.width * 0.92) / 2;
  const height = 1.1;
  const slope = Math.atan2(height, length);
  const deckLen = Math.hypot(length, height);
  const deck = new GeoBuilder();
  const frame = new GeoBuilder();
  const metal = new GeoBuilder();
  // Deck boards laid across, each slightly different.
  const boards = Math.round(deckLen / 0.26);
  const rand = rng(31);
  for (let i = 0; i < boards; i++) {
    const t = (i + 0.5) / boards;
    const y = t * height;
    const z = length / 2 - t * length;
    const board = grainBox(halfWidth * 2, 0.06, 0.24);
    deck.add(board, makeMatrix((rand() - 0.5) * 0.04, y + 0.03, z, slope + (rand() - 0.5) * 0.015, (rand() - 0.5) * 0.01, 0), new THREE.Color("#b58c5c").multiplyScalar(0.8 + rand() * 0.3));
    board.dispose();
  }
  // Stringers, posts and braces.
  const beam = (x: number, y: number, z: number, w: number, h: number, d: number, rx = 0) => {
    const g = grainBox(w, h, d);
    frame.add(g, makeMatrix(x, y, z, rx, 0, 0), new THREE.Color("#7a5a3a").multiplyScalar(0.85 + rand() * 0.2));
    g.dispose();
  };
  const stringers = Math.max(2, Math.round((halfWidth * 2) / 1.6) + 1);
  for (let i = 0; i < stringers; i++) {
    const x = -halfWidth + 0.12 + (i / (stringers - 1)) * (halfWidth * 2 - 0.24);
    beam(x, height / 2 - 0.08, 0, 0.12, 0.2, deckLen, slope);
    beam(x, (height - 0.1) / 2, -length / 2 + 0.1, 0.14, height - 0.1, 0.14);
    beam(x, (height * 0.5 - 0.1) / 2, 0, 0.12, height * 0.5 - 0.1, 0.12);
  }
  beam(0, height - 0.15, -length / 2 + 0.1, halfWidth * 2, 0.14, 0.12);
  beam(0, 0.12, -length / 2 + 0.1, halfWidth * 2, 0.12, 0.1);
  // A steel lip where the boards meet the ground, and a nosing at the top.
  const lip = new THREE.BoxGeometry(halfWidth * 2 + 0.04, 0.03, 0.18);
  metal.add(lip, makeMatrix(0, 0.015, length / 2 - 0.05), "#5f6266");
  metal.add(lip, makeMatrix(0, height + 0.04, -length / 2 + 0.05, slope, 0, 0), "#6a6c70");
  lip.dispose();
  const meshes = [new THREE.Mesh(deck.build(), worldMaterial("planks")), new THREE.Mesh(frame.build(), worldMaterial("wood")), new THREE.Mesh(metal.build(), plainMaterial(0.42, 0.85))];
  for (const mesh of meshes) {
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  return piece(group, halfWidth * 2, length, height, () => undefined, meshes.map((m) => m.geometry));
}

export type ObstacleKind = "log" | "rock" | "thorn" | "mud" | "ramp";

export interface ObstacleOptions {
  /** How many lanes the obstacle spans. */
  lanes?: 1 | 2 | 3;
  laneWidth?: number;
}

export function createObstacle(kind: ObstacleKind, options: ObstacleOptions = {}): Piece {
  const span: Span = { width: (options.lanes ?? 1) * (options.laneWidth ?? 3.5) };
  switch (kind) {
    case "log":
      return createLog(span);
    case "rock":
      return createRocks(span);
    case "thorn":
      return createThornHedge(span);
    case "mud":
      return createMudPit(span);
    case "ramp":
      return createRamp(span);
  }
}

// ----- Pickups ------------------------------------------------------------------

/** An energy berry: a fat, glossy, juice-red berry of drupelets with a green calyx. */
function createEnergyBerry(): Piece {
  const group = new THREE.Group();
  const holder = new THREE.Group();
  group.add(holder);
  const drupe = new THREE.SphereGeometry(0.075, 9, 6);
  const count = 64;
  const drupelets = new THREE.InstancedMesh(drupe, berryMaterial(), count + 1);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const color = new THREE.Color();
  for (let i = 0; i < count; i++) {
    const y = 1 - (2 * (i + 0.5)) / count;
    const phi = i * 2.399963;
    const ring = Math.sqrt(1 - y * y);
    const p = new THREE.Vector3(Math.cos(phi) * ring * 0.27, y * 0.33, Math.sin(phi) * ring * 0.27);
    const taper = 1 - Math.max(0, -y) * 0.25;
    p.x *= taper;
    p.z *= taper;
    m.compose(p, q.identity(), new THREE.Vector3(1, 1.08, 1).multiplyScalar(0.9 + (i % 5) * 0.04));
    drupelets.setMatrixAt(i, m);
    drupelets.setColorAt(i, color.set("#b0102c").multiplyScalar(0.85 + ((i * 7) % 6) * 0.05));
  }
  // The core fills the gaps between drupelets.
  m.compose(new THREE.Vector3(0, -0.01, 0), q.identity(), new THREE.Vector3(3.3, 3.9, 3.3));
  drupelets.setMatrixAt(count, m);
  drupelets.setColorAt(count, color.set("#6a0718"));
  if (drupelets.instanceColor) drupelets.instanceColor.needsUpdate = true;
  drupelets.castShadow = true;
  drupelets.frustumCulled = false;
  holder.add(drupelets);
  // Calyx and stem.
  const calyx = new GeoBuilder();
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * TAU;
    const sepal = new THREE.ConeGeometry(0.05, 0.22, 4);
    sepal.scale(1, 1, 0.3);
    calyx.add(sepal, makeMatrix(Math.cos(a) * 0.09, 0.36, Math.sin(a) * 0.09, Math.sin(a) * 1.25, 0, -Math.cos(a) * 1.25), "#4a8a32");
    sepal.dispose();
  }
  calyx.add(new THREE.CylinderGeometry(0.018, 0.026, 0.2, 6), makeMatrix(0.02, 0.45, 0, 0, 0, -0.2), "#5a7a30");
  const calyxMesh = new THREE.Mesh(calyx.build(), plainMaterial(0.55));
  calyxMesh.castShadow = true;
  holder.add(calyxMesh);
  const sprite = createHaloSprite(new THREE.Color("#ff9a9a"), 1.9);
  holder.add(sprite);
  let t = Math.random() * 6;
  return piece(
    group,
    1.4,
    1.4,
    1.0,
    (dt) => {
      t += dt;
      holder.position.y = 0.8 + Math.sin(t * 2.4) * 0.12;
      holder.rotation.y += dt * 1.5;
      holder.rotation.z = Math.sin(t * 1.7) * 0.12;
    },
    [drupe, drupelets, calyxMesh.geometry, sprite.material as THREE.SpriteMaterial],
  );
}

/** A magical glass orb: a clear shell over a swirling nebula and a bright heart, with sparks. */
function createMysteryOrb(): Piece {
  const group = new THREE.Group();
  const holder = new THREE.Group();
  group.add(holder);
  const time = { value: 0 };
  // The nebula inside, additive, rendered before the glass.
  const nebulaGeo = new THREE.SphereGeometry(0.4, 32, 24);
  const nebulaMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: { uT: time },
    vertexShader: /* glsl */ `
      varying vec3 vP;
      varying vec3 vN;
      varying vec3 vV;
      void main(){
        vP = position;
        vN = normalize(normalMatrix * normal);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vP;
      varying vec3 vN;
      varying vec3 vV;
      uniform float uT;
      ${GLSL_NOISE}
      void main(){
        float facing = clamp(dot(normalize(vN), normalize(vV)), 0.0, 1.0);
        vec3 p = normalize(vP) * 2.2;
        float swirl = fbm3(p + vec3(uT * 0.25, -uT * 0.18, uT * 0.12) + vec3(fbm3(p * 1.7 - uT * 0.1)) * 1.6);
        float wisps = smoothstep(0.45, 0.78, swirl);
        vec3 a = vec3(0.45, 0.2, 1.2);
        vec3 b = vec3(0.1, 0.75, 1.3);
        vec3 c = vec3(1.4, 0.4, 0.9);
        vec3 col = mix(mix(a, b, smoothstep(0.3, 0.7, fbm3(p * 0.8 + uT * 0.05))), c, wisps * 0.6);
        float depth = pow(facing, 1.2);
        gl_FragColor = vec4(col * (wisps * 2.4 + 0.25) * depth, 1.0);
      }
    `,
  });
  const nebula = new THREE.Mesh(nebulaGeo, nebulaMat);
  nebula.renderOrder = 1;
  holder.add(nebula);
  const heart = new THREE.Mesh(new THREE.SphereGeometry(0.08, 16, 12), new THREE.MeshBasicMaterial({ color: new THREE.Color(3.2, 2.6, 4.2), toneMapped: false }));
  holder.add(heart);
  // The glass: physically based with the sky in its reflections, brighter at grazing angles.
  const glassGeo = new THREE.SphereGeometry(0.47, 48, 32);
  const glass = new THREE.MeshPhysicalMaterial({ color: "#c9bcff", roughness: 0.02, metalness: 0, transparent: true, opacity: 0.06, clearcoat: 1, clearcoatRoughness: 0.02, ior: 1.5, envMapIntensity: 1.2, specularIntensity: 1 });
  glass.onBeforeCompile = (shader) => {
    patchSky(shader, { cloudShadow: false });
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <opaque_fragment>",
      /* glsl */ `
      {
        // Glass: clear face-on, mirror-bright and tinted towards the rim.
        float facing = clamp(dot(normalize(normal), normalize(vViewPosition)), 0.0, 1.0);
        float rim = pow(1.0 - facing, 2.5);
        outgoingLight = outgoingLight * (0.35 + rim * 0.9) + vec3(0.45, 0.32, 1.0) * rim * 0.7;
        diffuseColor.a = clamp(diffuseColor.a + rim * 0.75 + max(dot(outgoingLight, vec3(0.3)) - 0.8, 0.0) * 0.4, 0.0, 1.0);
      }
      #include <opaque_fragment>`,
    );
  };
  glass.customProgramCacheKey = () => "orb-glass-v2";
  const shell = new THREE.Mesh(glassGeo, glass);
  shell.renderOrder = 2;
  shell.castShadow = false;
  holder.add(shell);
  // Sparks orbiting the orb.
  const sparkCount = 26;
  const sparkPos = new Float32Array(sparkCount * 3);
  const sparkSeed = new Float32Array(sparkCount);
  for (let i = 0; i < sparkCount; i++) sparkSeed[i] = i / sparkCount;
  const sparkGeo = new THREE.BufferGeometry();
  sparkGeo.setAttribute("position", new THREE.BufferAttribute(sparkPos, 3));
  sparkGeo.setAttribute("aSeed", new THREE.BufferAttribute(sparkSeed, 1));
  const sparkMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: { uT: time },
    vertexShader: /* glsl */ `
      attribute float aSeed;
      uniform float uT;
      varying float vA;
      void main(){
        float a = aSeed * 6.2831 * 3.0 + uT * (0.8 + aSeed);
        float tilt = aSeed * 9.0;
        vec3 p = vec3(cos(a), sin(a * 0.5 + tilt) * 0.6, sin(a)) * (0.62 + 0.12 * sin(uT * 2.0 + aSeed * 30.0));
        vA = 0.5 + 0.5 * sin(uT * 6.0 + aSeed * 50.0);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_PointSize = (2.0 + vA * 3.0) * (14.0 / -mv.z);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      varying float vA;
      void main(){
        vec2 q = gl_PointCoord * 2.0 - 1.0;
        float d = dot(q, q);
        if (d > 1.0) discard;
        gl_FragColor = vec4(vec3(1.4, 1.1, 2.2) * pow(1.0 - d, 2.0) * vA, 1.0);
      }
    `,
  });
  const sparks = new THREE.Points(sparkGeo, sparkMat);
  sparks.frustumCulled = false;
  holder.add(sparks);
  const sprite = createHaloSprite(new THREE.Color("#a98cff"), 2.0);
  holder.add(sprite);
  let t = Math.random() * 6;
  return piece(
    group,
    1.6,
    1.6,
    1.2,
    (dt) => {
      t += dt;
      time.value = t;
      holder.position.y = 1.0 + Math.sin(t * 1.9) * 0.14;
      holder.rotation.y += dt * 0.9;
      (sprite.material as THREE.SpriteMaterial).opacity = 0.42 + Math.sin(t * 4) * 0.12;
    },
    [nebulaGeo, nebulaMat, heart.geometry, heart.material as THREE.Material, glassGeo, glass, sparkGeo, sparkMat, sprite.material as THREE.SpriteMaterial],
  );
}

export type PickupKind = "berry" | "orb";

export function createPickup(kind: PickupKind): Piece {
  return kind === "berry" ? createEnergyBerry() : createMysteryOrb();
}
