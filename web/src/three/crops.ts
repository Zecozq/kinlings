// Food in 3D, all generated in code and cached:
//   - the six crops growing in the fields, each through four stages
//     (0 planted .. 3 ripe), as real plants with one shared material;
//   - studio models of all twelve foods for the item icons;
//   - eggs, shared by the nest and the portraits.

import * as THREE from "three";
import { TAU, lerp, rng, smooth } from "./gfx.ts";
import { windTime } from "./flora.ts";

// ----- Field crops -------------------------------------------------------------
//
// Every crop is a single mesh with vertex colours. aSurf carries, per vertex,
// what the part is (leaf, stem, fruit...), a random seed, a parameter and the
// ripe glow. The shader adds leaf veins, light shining through thin leaves and
// petals, waxy or glossy fruit, melon netting and a gentle wind.

/** Part kinds for the crop shader, in aSurf.x. */
const CROP = { soil: 0, leaf: 1, stem: 2, fruit: 3, grain: 4, petal: 5, berry: 6, melon: 7, root: 8, bark: 9 } as const;

const cropCache = new Map<string, THREE.BufferGeometry>();

/** Uniforms shared by crop materials; `uCropGlow` animates the ripe shine. */
const cropGlow = { value: 0 };

export function tickCrops(time: number) {
  cropGlow.value = 0.85 + Math.sin(time * 2.3) * 0.15;
}

let cropMaterial: THREE.MeshStandardMaterial | null = null;

export function getCropMaterial(): THREE.MeshStandardMaterial {
  if (cropMaterial) return cropMaterial;
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, side: THREE.DoubleSide, dithering: true });
  const textures = produceNoiseTextures();
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uWindTime = windTime;
    shader.uniforms.uCropGlow = cropGlow;
    shader.uniforms.uCropCells = { value: textures.cells };
    shader.uniforms.uCropNoise = { value: textures.noise };
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        /* glsl */ `#include <common>
        attribute vec4 aSurf;
        varying vec4 vCrop;
        varying vec2 vCropUv;
        varying vec3 vCropPos;
        varying vec3 vCropN;
        uniform float uWindTime;`,
      )
      .replace(
        "#include <begin_vertex>",
        /* glsl */ `#include <begin_vertex>
        vCrop = aSurf;
        vCropUv = uv;
        vCropPos = position;
        vCropN = normal;
        {
          float h = position.y;
          vec4 world = modelMatrix * vec4(0.0, 0.0, 0.0, 1.0);
          float phase = world.x * 0.7 + world.z * 0.5;
          float gust = 0.75 + 0.25 * sin(uWindTime * 0.6 + phase * 0.3);
          transformed.x += sin(uWindTime * 2.1 + phase + h * 1.4) * h * h * 0.045 * gust;
          transformed.z += cos(uWindTime * 1.7 + phase * 1.3 + h * 1.1) * h * h * 0.03 * gust;
          // Leaves and petals flutter a little more towards their tips.
          if (aSurf.x > 0.5 && aSurf.x < 1.5 || aSurf.x > 4.5 && aSurf.x < 5.5) {
            float tip = uv.y;
            transformed += normal * sin(uWindTime * 5.3 + phase * 2.0 + aSurf.y * 40.0) * tip * tip * 0.018 * gust;
          }
        }`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        /* glsl */ `#include <common>
        varying vec4 vCrop;
        varying vec2 vCropUv;
        varying vec3 vCropPos;
        varying vec3 vCropN;
        uniform float uCropGlow;
        uniform sampler2D uCropCells;
        uniform sampler2D uCropNoise;
        float cropTrans;
        vec3 cropAlb;`,
      )
      .replace(
        "#include <color_fragment>",
        /* glsl */ `
        int kind = int(vCrop.x + 0.5);
        vec3 c = vColor;
        float rough = 0.62;
        cropTrans = 0.0;
        vec2 uvC = vCropUv;
        if (kind == 1) {
          // Leaf: a pale midrib with side veins, or veins fanning from the base
          // for palmate leaves; darker towards the stalk.
          float ax = abs(uvC.x - 0.5) * 2.0;
          float veins;
          if (vCrop.z > 0.5) {
            float lobes = vCrop.z;
            veins = smoothstep(0.93, 1.0, cos(3.14159 * (uvC.x * 2.0 - 1.0) * lobes)) * smoothstep(1.0, 0.6, uvC.y);
            veins = max(veins, smoothstep(0.45, 0.5, abs(fract(uvC.y * 5.0 - abs(uvC.x - 0.5) * 3.0) - 0.5)) * 0.4);
          } else {
            float mid = smoothstep(0.08, 0.0, ax) * smoothstep(1.0, 0.8, uvC.y);
            float lat = smoothstep(0.42, 0.5, abs(fract((uvC.y - ax * 0.35) * 6.0 + vCrop.y) - 0.5)) * smoothstep(0.9, 0.3, ax);
            veins = max(mid, lat * 0.55);
          }
          float mottle = texture2D(uCropNoise, uvC * vec2(1.3, 2.1) + vCrop.y * 7.0).r;
          c *= mix(0.82, 1.08, mottle) * mix(0.86, 1.04, uvC.y);
          c = mix(c, c * vec3(1.18, 1.22, 0.95) + 0.015, veins * 0.6);
          rough = 0.5; cropTrans = 0.75;
        } else if (kind == 2) {
          rough = 0.68; cropTrans = 0.25;
        } else if (kind == 3) {
          float n = texture2D(uCropNoise, vCropPos.xz * 3.0 + vCropPos.y * 1.7).r;
          c *= mix(0.88, 1.08, n);
          rough = 0.34;
        } else if (kind == 4) {
          rough = 0.55; cropTrans = 0.35;
          c *= 0.9 + 0.12 * sin(uvC.y * 50.0);
        } else if (kind == 5) {
          rough = 0.45; cropTrans = 0.9;
        } else if (kind == 6) {
          // Blueberries: deep blue under a dusty bloom.
          float bloom = smoothstep(0.35, 0.7, texture2D(uCropNoise, vCropPos.xy * 4.0 + vCropPos.z * 2.0 + vCrop.y * 9.0).r);
          c = mix(c, vec3(0.16, 0.22, 0.38), bloom * 0.7);
          rough = mix(0.28, 0.6, bloom);
        } else if (kind == 7) {
          // Netted melon: a raised corky net over a pale silvery skin.
          vec3 n = abs(normalize(vCropN));
          vec3 w = pow(n, vec3(4.0)); w /= (w.x + w.y + w.z);
          vec3 q = vCropPos * 12.0;
          float border = texture2D(uCropCells, q.yz / 16.0).g * w.x + texture2D(uCropCells, q.zx / 16.0 + 0.3).g * w.y + texture2D(uCropCells, q.xy / 16.0 + 0.6).g * w.z;
          float net = smoothstep(0.2, 0.06, border);
          c = mix(c, vec3(0.46, 0.44, 0.36), net * 0.9);
          rough = mix(0.45, 0.9, net);
        } else if (kind == 8) {
          // The root's shoulder: crimson, with cracks that glow like embers.
          float rings = sin(vCropPos.y * 160.0 + texture2D(uCropNoise, vCropPos.xz * 2.0).r * 6.0);
          float crack = smoothstep(0.85, 1.0, rings);
          c *= 1.0 - crack * 0.5;
          rough = 0.45;
          cropAlb = c;
        } else if (kind == 9) {
          float fib = texture2D(uCropNoise, vec2(uvC.x * 3.0, uvC.y * 12.0) + vCrop.y * 5.0).r;
          c *= mix(0.72, 1.12, fib);
          rough = 0.85;
        } else {
          rough = 0.95;
        }
        cropAlb = c;
        diffuseColor.rgb = c;
        `,
      )
      .replace("#include <roughnessmap_fragment>", "float roughnessFactor = rough;")
      .replace(
        "#include <emissivemap_fragment>",
        /* glsl */ `#include <emissivemap_fragment>
        totalEmissiveRadiance += cropAlb * vCrop.w * uCropGlow * 1.4;
        if (kind == 8) {
          float rings = sin(vCropPos.y * 160.0 + texture2D(uCropNoise, vCropPos.xz * 2.0).r * 6.0);
          totalEmissiveRadiance += vec3(1.0, 0.32, 0.05) * smoothstep(0.88, 1.0, rings) * 0.8 * uCropGlow;
        }
        #if NUM_DIR_LIGHTS > 0
          // Sunlight shining through thin leaves and petals from behind.
          if (cropTrans > 0.0) {
            vec3 sunDir = directionalLights[0].direction;
            float back = saturate(-dot(normal, sunDir));
            float towards = pow(saturate(dot(normalize(-vViewPosition), sunDir)), 3.0);
            totalEmissiveRadiance += cropAlb * directionalLights[0].color * cropTrans * (back * 0.22 + towards * back * 0.35);
          }
        #endif`,
      );
  };
  material.customProgramCacheKey = () => "crop-v2";
  cropMaterial = material;
  return material;
}

/** Collects crop parts; aSurf = kind, seed, parameter, ripe glow. */
function cropPart(b: ProduceBuilder, geometry: THREE.BufferGeometry, matrix: THREE.Matrix4 | null, color: THREE.ColorRepresentation | ((x: number, y: number, z: number, u: number, v: number) => THREE.Color), kind: number, seed: number, param = 0, glow = 0) {
  b.add(geometry, matrix, color, [kind, seed, param, glow]);
}

/** The finished crop: only the attributes the crop shader reads. */
function cropFinish(b: ProduceBuilder): THREE.BufferGeometry {
  const geometry = b.build();
  geometry.deleteAttribute("aLocal");
  geometry.deleteAttribute("aLocalN");
  return geometry;
}

/** A lobed, palmate leaf (fig, melon): base at the origin, blade up +Y, face +Z. uv: across, out. */
function lobedLeaf(lobes: number, depth: number, rand: () => number, cup = 0.12, nu = 12, nv = 7): THREE.BufferGeometry {
  const span = 5.2;
  const twist = (rand() - 0.5) * 0.3;
  return surface((u, v, out) => {
    const t = u * 2 - 1;
    const theta = t * (span / 2);
    const lobe = 0.5 + 0.5 * Math.cos(Math.PI * t * lobes * 0.5);
    const radius = (1 - depth * (1 - Math.pow(lobe, 0.55))) * (1 - 0.32 * t * t);
    const r = radius * v;
    const x = Math.sin(theta) * r;
    const y = Math.cos(theta) * r + 0.12 * v;
    const z = -cup * r * r + twist * x * v;
    out.set(x, y, z);
  }, nu, nv);
}

const leafGreen = (mix: number, base = "#4f8a34", light = "#6ea544") => linear(base).lerp(linear(light), mix);

/** Stage 0: a seedling with two seed leaves in a little mound of soil. */
function sprout(): THREE.BufferGeometry {
  const b = new ProduceBuilder();
  const rand = rng(3);
  cropPart(b, blob(14, 6, (x, _y, z) => 1 + 0.08 * Math.sin(x * 9 + z * 7), 0.4), new THREE.Matrix4().makeScale(0.22, 0.22, 0.22), "#5a3c28", CROP.soil, 0);
  const stem = new THREE.CatmullRomCurve3([vec(0, 0.05, 0), vec(0.01, 0.12, 0), vec(0, 0.19, 0.01)]);
  cropPart(b, tube(stem, (t) => lerp(0.012, 0.009, t), 5, 6), null, "#87a95a", CROP.stem, 0.3);
  for (const s of [1, -1]) {
    const dir = vec(s * 0.9, 0.55, 0.1).normalize();
    cropPart(b, leafBlade(rand, { width: 0.7, fold: 0.15, droop: 0.05, round: 0.9, tip: 0.4, nu: 4, nv: 5 }), placeAlong(vec(0, 0.19, 0.01), dir, s > 0 ? 0 : Math.PI, 0.1, 0.1, 0.1), "#86b54e", CROP.leaf, rand());
  }
  cropPart(b, leafBlade(rand, { width: 0.5, fold: 0.2, droop: 0.02, nu: 4, nv: 5 }), placeAlong(vec(0, 0.2, 0.01), vec(0.05, 1, 0.2), 0.4, 0.07, 0.07, 0.07), "#5f9a3c", CROP.leaf, rand());
  return cropFinish(b);
}

// --- Sunwheat: a stand of wheat, green tillers to heavy golden ears. ---------

function wheatCrop(stage: number): THREE.BufferGeometry {
  const b = new ProduceBuilder();
  const rand = rng(11 + stage);
  const ripe = stage === 3;
  const stalks = stage === 1 ? 0 : ripe ? 12 : 10;
  const blades = stage === 1 ? 11 : 6;
  const greenLeaf = (r: number) => linear("#5b9a3a").lerp(linear("#79b04c"), r);
  const dryLeaf = (r: number) => linear("#b69a52").lerp(linear("#cdb36c"), r);
  // Young blades arching from the base.
  for (let i = 0; i < blades; i++) {
    const a = (i / blades) * TAU + rand() * 0.6;
    const lean = 0.35 + rand() * 0.35;
    const dir = vec(Math.cos(a) * lean, 1, Math.sin(a) * lean).normalize();
    const length = stage === 1 ? 0.4 + rand() * 0.18 : 0.5 + rand() * 0.2;
    cropPart(b, leafBlade(rand, { width: 0.07, fold: 0.3, droop: 0.35, round: 0.35, tip: 1.6, nu: 2, nv: 7 }), placeAlong(vec(Math.cos(a) * 0.03, 0.02, Math.sin(a) * 0.03), dir, a + Math.PI / 2, length, length, length), ripe ? dryLeaf(rand()) : greenLeaf(rand()), CROP.leaf, rand());
  }
  const ear = (spindle: number) => lathe((v) => {
    const r = Math.pow(Math.sin(Math.PI * Math.min(1, v * 1.05)), 0.6) * (1 - v * 0.35) * spindle;
    return [r, v];
  }, 8, 16, (angle, v) => 0.16 * Math.abs(Math.sin(v * 38 + (Math.cos(angle) > 0 ? 0 : 1.57))) * Math.pow(Math.abs(Math.cos(angle)), 0.6));
  for (let i = 0; i < stalks; i++) {
    const a = (i / stalks) * TAU + rand() * 0.5;
    const r = 0.05 + rand() * 0.16;
    const base = vec(Math.cos(a) * r, 0, Math.sin(a) * r);
    const height = (stage === 2 ? 0.82 : 1.08) * (0.86 + rand() * 0.24);
    const lean = vec((rand() - 0.5) * 0.22, 0, (rand() - 0.5) * 0.22).addScaledVector(base, 0.6);
    const nod = ripe ? 0.12 + rand() * 0.08 : 0.03;
    const top = base.clone().addScaledVector(lean, 1).setY(height);
    const stalk = new THREE.CatmullRomCurve3([base, base.clone().lerp(top, 0.5).add(vec(0, 0, 0)), top]);
    const stalkColor = ripe ? linear("#c8a24e") : linear("#6f9e44");
    cropPart(b, tube(stalk, (t) => lerp(0.011, 0.008, t), 4, 8), null, stalkColor, CROP.stem, rand());
    // A leaf from the lower node.
    const node = stalk.getPointAt(0.35);
    const leafDir = stalk.getTangentAt(0.35).add(vec(Math.cos(a + 1.2) * 0.9, 0, Math.sin(a + 1.2) * 0.9)).normalize();
    cropPart(b, leafBlade(rand, { width: 0.06, fold: 0.35, droop: 0.25, round: 0.35, tip: 1.6, nu: 2, nv: 6 }), placeAlong(node, leafDir, a, 0.4, 0.4, 0.4), ripe ? dryLeaf(rand()) : greenLeaf(rand()), CROP.leaf, rand());
    // The ear, nodding when heavy, with awns fanning upwards.
    const dir = stalk.getTangentAt(1).add(vec(lean.x * 2, 0, lean.z * 2).normalize().multiplyScalar(nod * 2.2)).normalize();
    const earLength = stage === 2 ? 0.17 : 0.21;
    const grainColor = ripe ? linear("#d4a446").lerp(linear("#e2b85c"), rand()) : linear("#8fb35a").lerp(linear("#a6c46a"), rand());
    cropPart(b, ear(0.2), placeAlong(top, dir, rand() * 6, earLength, earLength, earLength), grainColor, CROP.grain, rand(), 0, ripe ? 0.06 : 0);
    const awns = ripe ? 10 : 6;
    for (let k = 0; k < awns; k++) {
      const f = (k + 0.5) / awns;
      const at = top.clone().addScaledVector(dir, earLength * (0.25 + f * 0.75));
      const side = (k % 2 ? 1 : -1) * (0.35 + f * 0.2);
      const right = new THREE.Vector3().crossVectors(dir, UP).normalize();
      if (right.lengthSq() < 0.1) right.set(1, 0, 0);
      const awnDir = dir.clone().addScaledVector(right, side).normalize();
      const awnLength = (ripe ? 0.17 : 0.09) * (0.8 + rand() * 0.4);
      const awn = surface((u, v, out) => out.set((u - 0.5) * 0.05 * (1 - v), v, 0), 1, 3);
      cropPart(b, awn, placeAlong(at, awnDir, rand() * 6, awnLength, awnLength, awnLength), ripe ? linear("#dfc06e") : linear("#a8c46e"), CROP.grain, rand());
    }
  }
  return cropFinish(b);
}

// --- Dewbean: a pea plant climbing a cane, then hung with pods. --------------

function beanCrop(stage: number): THREE.BufferGeometry {
  const b = new ProduceBuilder();
  const rand = rng(23 + stage);
  const height = stage === 1 ? 0.42 : stage === 2 ? 0.95 : 1.2;
  if (stage >= 2) {
    // A bamboo cane to climb.
    const cane = new THREE.CatmullRomCurve3([vec(0.02, -0.05, 0), vec(0.03, 0.7, 0.01), vec(0.025, height + 0.15, 0)]);
    cropPart(b, tube(cane, () => 0.014, 6, 6), null, "#b8a070", CROP.bark, 0.2);
  }
  const vines = stage === 1 ? 1 : stage === 2 ? 2 : 3;
  for (let vIndex = 0; vIndex < vines; vIndex++) {
    // The vine twines up around the cane.
    const points: THREE.Vector3[] = [];
    const turns = stage === 1 ? 0.4 : 1.6;
    for (let i = 0; i <= 10; i++) {
      const t = i / 10;
      const a = t * TAU * turns + (vIndex * TAU) / vines;
      const r = stage === 1 ? 0.02 + t * 0.05 : 0.045;
      points.push(vec(0.025 + Math.cos(a) * r, t * height, Math.sin(a) * r));
    }
    const vine = new THREE.CatmullRomCurve3(points);
    cropPart(b, tube(vine, (t) => lerp(0.011, 0.006, t), 5, 24), null, "#6f9e4a", CROP.stem, rand());
    // Compound leaves: a short stalk with paired oval leaflets.
    const leaves = stage === 1 ? 3 : stage === 2 ? 6 : 8;
    for (let l = 0; l < leaves; l++) {
      const t = 0.15 + (l / leaves) * 0.8;
      const at = vine.getPointAt(t);
      const a = l * 2.3 + vIndex * 1.3;
      const out = vec(Math.cos(a), 0.35, Math.sin(a)).normalize();
      const stalkEnd = at.clone().addScaledVector(out, 0.1);
      cropPart(b, tube(new THREE.CatmullRomCurve3([at, at.clone().lerp(stalkEnd, 0.5).add(vec(0, 0.02, 0)), stalkEnd]), () => 0.004, 3, 4), null, "#6f9e4a", CROP.stem, rand());
      for (const s of [1, -1]) {
        const side = new THREE.Vector3().crossVectors(out, UP).normalize().multiplyScalar(s);
        const dir = out.clone().addScaledVector(side, 0.9).add(vec(0, 0.15, 0)).normalize();
        const size = (stage === 1 ? 0.11 : 0.15) * (0.85 + rand() * 0.3);
        cropPart(b, leafBlade(rand, { width: 0.62, fold: 0.1, droop: 0.06, round: 0.8, tip: 0.6, nu: 4, nv: 5 }), placeAlong(stalkEnd.clone().addScaledVector(out, -0.03), dir, a + (s > 0 ? 0.3 : -0.3), size, size, size), leafGreen(rand(), "#4f8c37", "#6aa648"), CROP.leaf, rand());
      }
      // A curling tendril.
      if (stage >= 2 && l % 2 === 0) {
        const curl = new THREE.CatmullRomCurve3(Array.from({ length: 8 }, (_, k) => {
          const tt = k / 7;
          const ca = tt * TAU * 1.3;
          return stalkEnd.clone().addScaledVector(out, 0.03 + tt * 0.06).add(vec(Math.cos(ca) * 0.025 * tt, 0.02 + Math.sin(ca) * 0.025 * tt, 0));
        }));
        cropPart(b, tube(curl, () => 0.0025, 3, 10), null, "#7fae55", CROP.stem, rand());
      }
    }
    // White pea flowers on the growing plant.
    if (stage === 2) {
      for (let f = 0; f < 3; f++) {
        const at = vine.getPointAt(0.55 + f * 0.13).add(vec(Math.cos(f * 2.2) * 0.07, 0, Math.sin(f * 2.2) * 0.07));
        for (let p = 0; p < 3; p++) {
          cropPart(b, leafBlade(rand, { width: 1.0, fold: 0.25, droop: -0.1, round: 1.2, tip: 0.2, nu: 3, nv: 3 }), placeAlong(at, vec(Math.cos(p * 2.1), 0.6, Math.sin(p * 2.1)).normalize(), p * 2.1, 0.05, 0.05, 0.05), "#f4f1ea", CROP.petal, rand());
        }
      }
    }
    // Plump pods hanging among the leaves.
    if (stage === 3) {
      for (let p = 0; p < 4; p++) {
        const t = 0.3 + p * 0.16;
        const at = vine.getPointAt(t);
        const a = p * 2.5 + vIndex * 1.7;
        const start = at.clone().add(vec(Math.cos(a) * 0.08, 0, Math.sin(a) * 0.08));
        const dir = vec(Math.cos(a) * 0.3, -1, Math.sin(a) * 0.3).normalize();
        const side = new THREE.Vector3().crossVectors(dir, UP).normalize();
        const podLength = 0.2 + rand() * 0.05;
        const pod = surface((u, v, out) => {
          const ang = u * TAU;
          const prof = Math.pow(Math.sin(Math.PI * Math.min(1, v * 1.02)), 0.45) * (1 + 0.15 * Math.abs(Math.sin(v * Math.PI * 4)));
          out.copy(start).addScaledVector(dir, v * podLength).addScaledVector(side, Math.cos(ang) * 0.028 * prof).addScaledVector(new THREE.Vector3().crossVectors(side, dir), Math.sin(ang) * 0.018 * prof);
          out.addScaledVector(side, Math.sin(v * Math.PI) * 0.02);
        }, 8, 10);
        cropPart(b, pod, null, linear("#5f9e3a").lerp(linear("#77b14a"), rand()), CROP.fruit, rand(), 0, 0.12);
      }
    }
  }
  return cropFinish(b);
}

// --- Emberroot: a rosette of beet leaves on red stalks over a glowing root. ----

function rootCrop(stage: number): THREE.BufferGeometry {
  const b = new ProduceBuilder();
  const rand = rng(31 + stage);
  const leaves = stage === 1 ? 4 : stage === 2 ? 7 : 9;
  const scale = stage === 1 ? 0.65 : stage === 2 ? 1.05 : 1.3;
  if (stage >= 2) {
    // The shoulder of the root shows above the soil.
    const r = stage === 2 ? 0.1 : 0.16;
    const shoulder = lathe((v) => [Math.sin(Math.min(1, v * 1.1) * Math.PI * 0.5) * r * (1 - v * v * 0.6), v * r * 0.9 - r * 0.15], 16, 8);
    cropPart(b, shoulder, null, (_x, y) => linear("#7a0c09").lerp(linear("#a8180f"), smooth(-0.02, r * 0.7, y)), CROP.root, rand(), 0, stage === 3 ? 0.1 : 0);
  }
  for (let l = 0; l < leaves; l++) {
    const a = l * 2.39996 + rand() * 0.3;
    const lean = 0.45 + rand() * 0.3 + (l / leaves) * 0.2;
    const dir = vec(Math.cos(a) * lean, 1, Math.sin(a) * lean).normalize();
    const stalkLength = (0.2 + rand() * 0.12) * scale;
    const p0 = vec(Math.cos(a) * 0.02, 0.06, Math.sin(a) * 0.02);
    const p1 = p0.clone().addScaledVector(dir, stalkLength);
    const stalk = new THREE.CatmullRomCurve3([p0, p0.clone().lerp(p1, 0.5).add(vec(0, 0.02, 0)), p1]);
    cropPart(b, tube(stalk, (t) => lerp(0.014, 0.009, t) * scale, 5, 6), null, (_x, _y, _z, _u, v) => linear("#7e1210").lerp(linear("#a4261a"), v), CROP.stem, rand());
    const leafDir = dir.clone().add(vec(Math.cos(a) * 0.3, 0.1, Math.sin(a) * 0.3)).normalize();
    const size = (0.38 + rand() * 0.14) * scale;
    cropPart(b, leafBlade(rand, { width: 0.6, fold: 0.1, droop: 0.2, wave: 0.12, round: 0.55, nu: 6, nv: 9 }), placeAlong(p1, leafDir, a + Math.PI / 2 + (rand() - 0.5) * 0.5, size, size, size), leafGreen(rand(), "#2e5a24", "#45762e"), CROP.leaf, rand());
  }
  return cropFinish(b);
}

// --- Frostberry: a blueberry bush, then flowers, then frosted berries. -------

function berryCrop(stage: number): THREE.BufferGeometry {
  const b = new ProduceBuilder();
  const rand = rng(41 + stage);
  const size = stage === 1 ? 0.55 : stage === 2 ? 0.95 : 1.12;
  const stems = stage === 1 ? 4 : 8;
  const leafColor = (r: number) => linear("#3d6b3a").lerp(linear("#5b8a4c"), r);
  const twigs: THREE.CatmullRomCurve3[] = [];
  for (let s = 0; s < stems; s++) {
    const a = (s / stems) * TAU + rand() * 0.5;
    const lean = 0.35 + rand() * 0.3;
    const top = vec(Math.cos(a) * size * lean, size * (0.85 + rand() * 0.3), Math.sin(a) * size * lean);
    const twig = new THREE.CatmullRomCurve3([vec(0, 0, 0), vec(top.x * 0.4, top.y * 0.45, top.z * 0.4), top]);
    twigs.push(twig);
    cropPart(b, tube(twig, (t) => lerp(0.018, 0.006, t) * (size / 0.8), 5, 8), null, "#6e4a34", CROP.bark, rand());
  }
  // Small elliptic leaves along the twigs.
  const leafCount = stage === 1 ? 26 : stage === 2 ? 80 : 100;
  const leaf = (r: () => number) => leafBlade(r, { width: 0.5, fold: 0.12, droop: 0.06, round: 0.7, tip: 0.9, nu: 3, nv: 4 });
  for (let i = 0; i < leafCount; i++) {
    const twig = twigs[i % twigs.length];
    const t = 0.22 + Math.sqrt(rand()) * 0.78;
    const at = twig.getPointAt(t);
    const a = rand() * TAU;
    const dir = vec(Math.cos(a), 0.5 + rand() * 0.6, Math.sin(a)).normalize();
    const s = (0.15 + rand() * 0.07) * (stage === 1 ? 0.8 : 1);
    cropPart(b, leaf(rand), placeAlong(at, dir, rand() * 6, s, s, s), leafColor(rand()), CROP.leaf, rand());
  }
  // White bell flowers in spring.
  if (stage === 2) {
    const bell = lathe((v) => [Math.sin(Math.min(1, v * 1.1) * Math.PI * 0.6) * 0.5 * (1 - v * 0.2), -v], 6, 4);
    for (let i = 0; i < 10; i++) {
      const twig = twigs[i % twigs.length];
      const at = twig.getPointAt(0.6 + rand() * 0.4).add(vec((rand() - 0.5) * 0.08, -0.02, (rand() - 0.5) * 0.08));
      cropPart(b, bell.clone(), placeAlong(at, vec(rand() - 0.5, 1.5, rand() - 0.5).normalize(), 0, 0.03, 0.035, 0.03), "#f2ece4", CROP.petal, rand());
    }
    bell.dispose();
  }
  // Clusters of frosted blueberries.
  if (stage === 3) {
    const berry = blob(10, 8, (_x, y) => 1 - smooth(0.85, 1, y) * 0.15, 0.88);
    for (let i = 0; i < 30; i++) {
      const twig = twigs[i % twigs.length];
      const at = twig.getPointAt(0.45 + rand() * 0.55).add(vec((rand() - 0.5) * 0.12, -0.03 - rand() * 0.04, (rand() - 0.5) * 0.12));
      const r = 0.032 + rand() * 0.012;
      const color = linear("#1c2450").lerp(linear("#2c3a6e"), rand());
      cropPart(b, berry.clone(), placeAlong(at, vec(rand() - 0.5, 1, rand() - 0.5).normalize(), rand() * 6, r, r, r), color, CROP.berry, rand(), 0, 0.05);
    }
    berry.dispose();
  }
  return cropFinish(b);
}

// --- Moonmelon: a sprawling vine with lobed leaves and a pale netted melon. ----

function melonCrop(stage: number): THREE.BufferGeometry {
  const b = new ProduceBuilder();
  const rand = rng(53 + stage);
  const reach = stage === 1 ? 0.3 : 0.75;
  const vinePoints = [vec(-0.05, 0.03, 0), vec(-reach * 0.5, 0.08, -0.12), vec(-reach, 0.05, 0.08)];
  const vine2 = [vec(0.03, 0.03, 0.02), vec(reach * 0.45, 0.07, 0.15), vec(reach, 0.04, -0.06)];
  const vines = stage === 1 ? [vinePoints] : [vinePoints, vine2];
  for (const points of vines) {
    const vine = new THREE.CatmullRomCurve3(points);
    cropPart(b, tube(vine, (t) => lerp(0.016, 0.009, t), 5, 16), null, "#5c8a3c", CROP.stem, rand());
    const leaves = stage === 1 ? 2 : 4;
    for (let l = 0; l < leaves; l++) {
      const t = 0.12 + (l / leaves) * 0.85;
      const at = vine.getPointAt(t);
      const a = rand() * TAU;
      // Leaves stand up on their stalks above the vine.
      const stalkTop = at.clone().add(vec(Math.cos(a) * 0.05, 0.14 + rand() * 0.1, Math.sin(a) * 0.05));
      cropPart(b, tube(new THREE.CatmullRomCurve3([at, at.clone().lerp(stalkTop, 0.5).add(vec(0, 0.02, 0)), stalkTop]), () => 0.006, 4, 6), null, "#6a9844", CROP.stem, rand());
      const size = (stage === 1 ? 0.18 : 0.3) * (0.85 + rand() * 0.3);
      const dir = vec(Math.cos(a) * 0.8, 0.5, Math.sin(a) * 0.8).normalize();
      cropPart(b, lobedLeaf(5, 0.28, rand, 0.18, 12, 6), placeAlong(stalkTop, dir, a + Math.PI, size, size, size), leafGreen(rand(), "#3f7530", "#5b8f3e"), CROP.leaf, rand(), 5);
    }
    if (stage >= 2) {
      const curl = new THREE.CatmullRomCurve3(Array.from({ length: 9 }, (_, k) => {
        const tt = k / 8;
        const ca = tt * TAU * 1.5;
        return points[2].clone().add(vec(Math.cos(ca) * 0.04 * tt, 0.04 + Math.sin(ca) * 0.04 * tt, tt * 0.06));
      }));
      cropPart(b, tube(curl, () => 0.003, 3, 12), null, "#7aa452", CROP.stem, rand());
    }
  }
  if (stage === 2) {
    // A yellow flower and a young melon.
    for (let p = 0; p < 5; p++) {
      const a = (p / 5) * TAU;
      cropPart(b, leafBlade(rand, { width: 0.9, round: 1.1, tip: 0.4, droop: -0.1, nu: 3, nv: 3 }), placeAlong(vec(0.28, 0.18, 0.2), vec(Math.cos(a), 0.7, Math.sin(a)).normalize(), a, 0.07, 0.07, 0.07), "#f2c93a", CROP.petal, rand());
    }
  }
  if (stage >= 2) {
    const radius = stage === 2 ? 0.17 : 0.4;
    const melon = blob(28, 18, (x, _y, z) => 1 - 0.025 * smooth(0.9, 1, Math.cos(Math.atan2(z, x) * 5)), 0.9);
    cropPart(b, melon, new THREE.Matrix4().makeScale(radius, radius, radius).setPosition(0.05, radius * 0.88, 0.12), stage === 3 ? linear("#55654f") : linear("#5f7a4c"), CROP.melon, rand(), 0, stage === 3 ? 0.08 : 0);
  }
  return cropFinish(b);
}

// --- Starfig: a young fig tree, broad lobed leaves, ripe purple figs. ----------

function figCrop(stage: number): THREE.BufferGeometry {
  const b = new ProduceBuilder();
  const rand = rng(61 + stage);
  const height = stage === 1 ? 0.5 : stage === 2 ? 0.95 : 1.15;
  const trunk = new THREE.CatmullRomCurve3([vec(0, 0, 0), vec(0.03, height * 0.5, 0.01), vec(-0.02, height, 0.02)]);
  cropPart(b, tube(trunk, (t) => lerp(0.045 + stage * 0.012, 0.025, t), 7, 10), null, "#7d6e5c", CROP.bark, rand());
  const branches: THREE.CatmullRomCurve3[] = [];
  const branchCount = stage === 1 ? 0 : stage === 2 ? 3 : 4;
  for (let i = 0; i < branchCount; i++) {
    const a = (i / branchCount) * TAU + 0.5;
    const start = trunk.getPointAt(0.55 + i * 0.1);
    const end = start.clone().add(vec(Math.cos(a) * 0.38, 0.22 + rand() * 0.15, Math.sin(a) * 0.38));
    const branch = new THREE.CatmullRomCurve3([start, start.clone().lerp(end, 0.5).add(vec(0, 0.06, 0)), end]);
    branches.push(branch);
    cropPart(b, tube(branch, (t) => lerp(0.024, 0.012, t), 6, 8), null, "#7d6e5c", CROP.bark, rand());
  }
  const tips = [trunk, ...branches];
  const leaves = stage === 1 ? 4 : stage === 2 ? 12 : 18;
  for (let l = 0; l < leaves; l++) {
    const branch = tips[l % tips.length];
    const at = branch.getPointAt(0.6 + rand() * 0.4);
    const a = rand() * TAU;
    const dir = vec(Math.cos(a) * 0.9, 0.55 + rand() * 0.4, Math.sin(a) * 0.9).normalize();
    const size = (stage === 1 ? 0.22 : 0.3) * (0.85 + rand() * 0.3);
    const stalkEnd = at.clone().addScaledVector(dir, 0.06);
    cropPart(b, lobedLeaf(3, 0.55, rand, 0.1, 12, 6), placeAlong(stalkEnd, dir, a + Math.PI / 2, size, size, size), leafGreen(rand(), "#3a6a2e", "#55893c"), CROP.leaf, rand(), 3);
  }
  if (stage === 3) {
    const fig = lathe(spline(FIG_PROFILE), 10, 8);
    for (let f = 0; f < 8; f++) {
      const branch = tips[f % tips.length];
      const at = branch.getPointAt(0.5 + rand() * 0.45).add(vec((rand() - 0.5) * 0.08, -0.03, (rand() - 0.5) * 0.08));
      const s = 0.14 + rand() * 0.04;
      cropPart(b, fig.clone(), placeAlong(at, vec(rand() - 0.5, -1, rand() - 0.5).normalize(), rand() * 6, s, s, s), linear("#3e1630").lerp(linear("#5a2440"), rand()), CROP.fruit, rand(), 0, 0.08);
    }
    fig.dispose();
  }
  return cropFinish(b);
}

/** The growing crop for a plot. Stage 0 is a fresh seedling, 3 is ripe. */
export function cropGeometry(item: number, stage: number): THREE.BufferGeometry {
  const s = Math.max(0, Math.min(3, stage));
  const key = `${s === 0 ? 0 : item}:${s}`;
  let geometry = cropCache.get(key);
  if (geometry) return geometry;
  if (s === 0) geometry = sprout();
  else if (item === 1) geometry = wheatCrop(s);
  else if (item === 2) geometry = beanCrop(s);
  else if (item === 3) geometry = rootCrop(s);
  else if (item === 4) geometry = berryCrop(s);
  else if (item === 5) geometry = melonCrop(s);
  else geometry = figCrop(s);
  cropCache.set(key, geometry);
  return geometry;
}

// ----- Eggs -----------------------------------------------------------------

let eggBaseGeometry: THREE.BufferGeometry | null = null;

/** A smooth egg, unit-ish: base near y = 0, height about 1.5. */
export function eggGeometry(): THREE.BufferGeometry {
  if (eggBaseGeometry) return eggBaseGeometry;
  const points: THREE.Vector2[] = [];
  const count = 28;
  for (let i = 0; i <= count; i++) {
    const t = i / count;
    const y = (1 - Math.cos(t * Math.PI)) / 2;
    const r = Math.sqrt(Math.max(0, 1 - Math.pow((y - 0.47) / 0.53, 2)));
    const taper = lerp(1, 0.76, Math.pow(y, 1.6));
    points.push(new THREE.Vector2(r * taper * 0.54, y * 1.42));
  }
  const geometry = new THREE.LatheGeometry(points, 32);
  geometry.computeVertexNormals();
  eggBaseGeometry = geometry;
  return geometry;
}

export function makeEggMaterial(): THREE.MeshPhysicalMaterial {
  // Colours and state come per instance so a whole nest is one draw call.
  const material = new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.42, clearcoat: 0.55, clearcoatRoughness: 0.3 });
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        /* glsl */ `#include <common>
        attribute vec3 aColorA;
        attribute vec3 aColorB;
        attribute vec4 aEggState; // seed, crack, shine, unused
        varying vec3 vColorA;
        varying vec3 vColorB;
        varying vec4 vEggState;
        varying vec3 vEggPos;`,
      )
      .replace(
        "#include <begin_vertex>",
        /* glsl */ `#include <begin_vertex>
        vColorA = aColorA;
        vColorB = aColorB;
        vEggState = aEggState;
        vEggPos = position;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        /* glsl */ `#include <common>
        varying vec3 vColorA;
        varying vec3 vColorB;
        varying vec4 vEggState;
        varying vec3 vEggPos;
        float eggHash(vec3 p){ p = fract(p*vec3(0.1031,0.1030,0.0973)); p += dot(p, p.yxz+33.33); return fract((p.x+p.y)*p.z); }`,
      )
      .replace(
        "#include <color_fragment>",
        /* glsl */ `
        vec3 eggA = vColorA;
        vec3 eggB = vColorB;
        float height = clamp(vEggPos.y/1.42, 0.0, 1.0);
        vec3 base = mix(eggA*1.25, eggA*0.92, smoothstep(0.1, 1.0, height));
        // Speckles from the seed.
        vec3 q = vEggPos*7.0 + vEggState.x*13.7;
        vec3 g = floor(q);
        float speck = 0.0;
        for (int x=-1;x<=1;x++) for (int y=-1;y<=1;y++) for (int z=-1;z<=1;z++) {
          vec3 c = g + vec3(float(x),float(y),float(z));
          float r = eggHash(c + 3.1);
          if (r < 0.45) continue;
          vec3 h = vec3(eggHash(c), eggHash(c+1.7), eggHash(c+2.3));
          float d = length(q - (c + 0.5 + (h-0.5)*0.7));
          speck = max(speck, smoothstep(0.42*r, 0.34*r, d));
        }
        base = mix(base, eggB*1.05, speck*0.9);
        diffuseColor.rgb = base;
        `,
      )
      .replace(
        "#include <emissivemap_fragment>",
        /* glsl */ `#include <emissivemap_fragment>
        {
          float crack = vEggState.y;
          if (crack > 0.001) {
            float angle = atan(vEggPos.z, vEggPos.x);
            float h2 = vEggPos.y;
            float seed = vEggState.x*6.283;
            // A jagged band around the egg's waist, growing with the crack.
            float y0 = 0.72 + sin(angle*5.0 + seed)*0.07 + sin(angle*13.0 + seed*2.0)*0.05;
            float d0 = abs(h2 - y0);
            float along = fract(angle/6.283 + seed*0.2);
            float crackActive = smoothstep(crack*1.1, crack*1.1 - 0.08, along);
            float line = smoothstep(0.022, 0.0, d0) * crackActive;
            // Fork lines reaching up towards the tip.
            float forks = smoothstep(0.025, 0.0, abs(fract(angle/6.283*7.0 + seed) - 0.5)*0.6 + max(0.0, h2 - y0 - 0.4*crack)) * step(y0, h2) * crackActive;
            float glow = max(line, forks * smoothstep(0.3, 0.8, crack));
            totalEmissiveRadiance += vec3(1.4, 1.1, 0.5) * glow * (0.6 + crack*2.4);
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.05,0.03,0.02), glow);
          }
          totalEmissiveRadiance += vColorA * vEggState.z * 0.4;
        }
        `,
      );
  };
  material.customProgramCacheKey = () => "egg";
  return material;
}


// ----- Food: studio models for the item icons ----------------------------------
//
// Every food icon is a small product shot. The models are parametric surfaces
// with organic irregularity, and one physical "produce" shader paints them:
// each vertex names its surface (nut shell, berry bloom, melon netting, honey)
// and the shader adds the fine detail procedurally. Each item compiles only
// the surfaces it uses, so programs stay small.

/** Surface kinds, read by the produce shader from aSurf.x. */
export const SURF = {
  plain: 0, nut: 1, cupScale: 2, bark: 3, grain: 4, awn: 5, pod: 6, water: 7, root: 8, leaf: 9,
  berry: 10, rind: 12, flesh: 13, seed: 14, figSkin: 15, figFlesh: 16, glass: 17, cork: 18,
  twine: 19, shell: 20, mushCap: 21, gills: 22, moss: 23, pitaya: 24, bract: 25, pitayaFlesh: 26,
  wax: 27, honey: 28, straw: 29, bean: 30, podInner: 31, paper: 32,
} as const;

type Surf = readonly [number, number, number, number];
type Param = (u: number, v: number, out: THREE.Vector3) => void;

/**
 * A parametric surface. Normals come from central differences of the function,
 * so closed or seamless surfaces never show a crease at the seam.
 */
export function surface(fn: Param, nu: number, nv: number, flip = false): THREE.BufferGeometry {
  const cols = nu + 1;
  const rows = nv + 1;
  const pos = new Float32Array(cols * rows * 3);
  const nor = new Float32Array(cols * rows * 3);
  const uvs = new Float32Array(cols * rows * 2);
  const p = new THREE.Vector3();
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const d = new THREE.Vector3();
  const n = new THREE.Vector3();
  const e = 1e-3;
  for (let j = 0; j < rows; j++) {
    const v = j / nv;
    for (let i = 0; i < cols; i++) {
      const u = i / nu;
      fn(u, v, p);
      const k = j * cols + i;
      pos[k * 3] = p.x;
      pos[k * 3 + 1] = p.y;
      pos[k * 3 + 2] = p.z;
      uvs[k * 2] = u;
      uvs[k * 2 + 1] = v;
    }
  }
  // Normals from neighbouring grid points; closed rows wrap round their seam.
  const at = (i: number, j: number, out: THREE.Vector3) => out.fromArray(pos, (j * cols + i) * 3);
  const closed: boolean[] = [];
  for (let j = 0; j < rows; j++) closed.push(at(0, j, a).distanceToSquared(at(nu, j, b)) < 1e-14);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const k = j * cols + i;
      const i0 = i > 0 ? i - 1 : closed[j] ? nu - 1 : 0;
      const i1 = i < nu ? i + 1 : closed[j] ? 1 : nu;
      at(i1, j, a).sub(at(i0, j, b));
      at(i, Math.min(nv, j + 1), c).sub(at(i, Math.max(0, j - 1), d));
      const la = a.length();
      const lc = c.length();
      n.set(0, 0, 0);
      if (la > 1e-12 && lc > 1e-12) n.crossVectors(a.divideScalar(la), c.divideScalar(lc));
      if (n.lengthSq() < 1e-6) {
        // Where the surface pinches to a point, step inside the domain and
        // differentiate the function itself.
        const u = i / nu;
        const v = j / nv;
        let vn = Math.min(1 - 3 * e, Math.max(3 * e, v));
        for (let attempt = 0; attempt < 4; attempt++) {
          fn(u + e, vn, a);
          fn(u - e, vn, b);
          fn(u, vn + e, c);
          fn(u, vn - e, d);
          a.sub(b);
          c.sub(d);
          // Compare directions, not sizes: small parts have tiny derivatives.
          const ma = a.length();
          const mc = c.length();
          if (ma > 1e-12 && mc > 1e-12) {
            n.crossVectors(a.divideScalar(ma), c.divideScalar(mc));
            if (n.lengthSq() > 1e-8) break;
          }
          vn = v < 0.5 ? vn + 0.01 : vn - 0.01;
        }
      }
      if (n.lengthSq() < 1e-8) n.set(0, 1, 0);
      n.normalize();
      if (flip) n.negate();
      nor[k * 3] = n.x;
      nor[k * 3 + 1] = n.y;
      nor[k * 3 + 2] = n.z;
    }
  }
  const index: number[] = [];
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const i0 = j * cols + i;
      const i1 = i0 + 1;
      const i2 = i0 + cols;
      const i3 = i2 + 1;
      if (flip) index.push(i0, i3, i1, i0, i2, i3);
      else index.push(i0, i1, i3, i0, i3, i2);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(index);
  return geometry;
}

/** Revolves a profile r(v), y(v) around +Y; `ripple` adds radial relief. */
export function lathe(profile: (v: number) => [number, number], nu: number, nv: number, ripple?: (angle: number, v: number) => number, arc = TAU, start = 0): THREE.BufferGeometry {
  // A whole row shares one profile point, so remember the last one.
  let lastV = NaN;
  let r0 = 0;
  let y = 0;
  return surface((u, v, out) => {
    if (v !== lastV) {
      [r0, y] = profile(v);
      lastV = v;
    }
    const angle = start + u * arc;
    const r = r0 * (1 + (ripple ? ripple(angle, v) : 0));
    out.set(Math.cos(angle) * r, y, -Math.sin(angle) * r);
  }, nu, nv);
}

/** A smooth profile through (r, y) points, sampled evenly along its length. */
export function spline(points: [number, number][]): (v: number) => [number, number] {
  const curve = new THREE.SplineCurve(points.map(([r, y]) => new THREE.Vector2(r, y)));
  const lengths = curve.getLengths(200);
  const total = lengths[lengths.length - 1];
  const point = new THREE.Vector2();
  return (v: number) => {
    const t = curve.getUtoTmapping(Math.min(1, Math.max(0, v)), Math.min(1, Math.max(0, v)) * total);
    curve.getPoint(t, point);
    return [Math.max(0, point.x), point.y];
  };
}

/** A tube along a curve with radius r(t); its uv is (t along, angle around). */
export function tube(curve: THREE.Curve<THREE.Vector3>, radius: (t: number) => number, nu: number, nv: number, flatten = 1): THREE.BufferGeometry {
  const segments = Math.max(16, nv * 2);
  const frames = curve.computeFrenetFrames(segments, false);
  const centre = new THREE.Vector3();
  let lastT = NaN;
  let n = frames.normals[0];
  let b = frames.binormals[0];
  return surface((u, v, out) => {
    const t = Math.min(1, Math.max(0, v));
    if (t !== lastT) {
      curve.getPointAt(t, centre);
      const f = Math.min(segments, Math.max(0, Math.round(t * segments)));
      n = frames.normals[f];
      b = frames.binormals[f];
      lastT = t;
    }
    const angle = u * TAU;
    const r = radius(v);
    out.copy(centre).addScaledVector(n, Math.cos(angle) * r * flatten).addScaledVector(b, Math.sin(angle) * r);
  }, nu, nv);
}

type ColorFn = (x: number, y: number, z: number, u: number, v: number) => THREE.Color;
type SurfFn = (x: number, y: number, z: number, u: number, v: number) => Surf;

/** Collects parts with their surfaces into one geometry for a food model. */
export class ProduceBuilder {
  private pos: number[] = [];
  private nor: number[] = [];
  private col: number[] = [];
  private uv: number[] = [];
  private surf: number[] = [];
  private loc: number[] = [];
  private locN: number[] = [];
  private idx: number[] = [];
  readonly kinds = new Set<number>();

  /**
   * Adds a part. `local` is what the shader sees as the part's own coordinates:
   * by default the vertex position before the matrix is applied.
   */
  add(geometry: THREE.BufferGeometry, matrix: THREE.Matrix4 | null, color: THREE.ColorRepresentation | ColorFn, surf: Surf | SurfFn, local?: (x: number, y: number, z: number, u: number, v: number) => [number, number, number]): this {
    const position = geometry.attributes.position as THREE.BufferAttribute;
    const normal = geometry.attributes.normal as THREE.BufferAttribute | undefined;
    const uv = geometry.attributes.uv as THREE.BufferAttribute | undefined;
    const base = this.pos.length / 3;
    const v = new THREE.Vector3();
    const n = new THREE.Vector3();
    const normalMatrix = matrix ? new THREE.Matrix3().getNormalMatrix(matrix) : null;
    const constant = typeof color === "function" ? null : new THREE.Color(color);
    const fixed = typeof surf === "function" ? null : surf;
    if (fixed) this.kinds.add(fixed[0]);
    for (let i = 0; i < position.count; i++) {
      const lx = position.getX(i);
      const ly = position.getY(i);
      const lz = position.getZ(i);
      const u0 = uv ? uv.getX(i) : 0;
      const v0 = uv ? uv.getY(i) : 0;
      v.set(lx, ly, lz);
      if (matrix) v.applyMatrix4(matrix);
      if (normal) n.fromBufferAttribute(normal, i);
      else n.set(0, 1, 0);
      this.locN.push(n.x, n.y, n.z);
      if (normalMatrix) n.applyMatrix3(normalMatrix).normalize();
      this.pos.push(v.x, v.y, v.z);
      this.nor.push(n.x, n.y, n.z);
      const c = constant ?? (color as ColorFn)(lx, ly, lz, u0, v0);
      this.col.push(c.r, c.g, c.b);
      this.uv.push(u0, v0);
      const s = fixed ?? (surf as SurfFn)(lx, ly, lz, u0, v0);
      if (!fixed) this.kinds.add(s[0]);
      this.surf.push(s[0], s[1], s[2], s[3]);
      if (local) {
        const l = local(lx, ly, lz, u0, v0);
        this.loc.push(l[0], l[1], l[2]);
      } else {
        this.loc.push(lx, ly, lz);
      }
    }
    if (geometry.index) {
      for (let i = 0; i < geometry.index.count; i++) this.idx.push(geometry.index.getX(i) + base);
    } else {
      for (let i = 0; i < position.count; i++) this.idx.push(base + i);
    }
    geometry.dispose();
    return this;
  }

  build(): THREE.BufferGeometry {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(this.pos, 3));
    geometry.setAttribute("normal", new THREE.Float32BufferAttribute(this.nor, 3));
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(this.col, 3));
    geometry.setAttribute("uv", new THREE.Float32BufferAttribute(this.uv, 2));
    geometry.setAttribute("aSurf", new THREE.Float32BufferAttribute(this.surf, 4));
    geometry.setAttribute("aLocal", new THREE.Float32BufferAttribute(this.loc, 3));
    geometry.setAttribute("aLocalN", new THREE.Float32BufferAttribute(this.locN, 3));
    const count = this.pos.length / 3;
    geometry.setIndex(count > 65535 ? new THREE.BufferAttribute(new Uint32Array(this.idx), 1) : new THREE.BufferAttribute(new Uint16Array(this.idx), 1));
    geometry.computeBoundingSphere();
    return geometry;
  }
}

/** Places a part: position, a rotation that takes +Y to `up`, a spin around it and a scale. */
export function placeAlong(position: THREE.Vector3, up: THREE.Vector3, spin = 0, sx = 1, sy = sx, sz = sx): THREE.Matrix4 {
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), up.clone().normalize());
  q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), spin));
  return new THREE.Matrix4().compose(position, q, new THREE.Vector3(sx, sy, sz));
}

const linear = (hex: string) => new THREE.Color(hex);

// ----- The produce shader -----------------------------------------------------
//
// All foods share one program. Fine detail comes from two small tiling noise
// textures made here at start-up (value noise and cellular noise), so the shader
// compiles quickly instead of unrolling procedural noise loops.

let produceTextures: { noise: THREE.DataTexture; cells: THREE.DataTexture } | null = null;

function hashCell(x: number, y: number, seed: number) {
  let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function tiledValue(x: number, y: number, period: number, seed: number) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const w = (v: number) => ((v % period) + period) % period;
  const a = hashCell(w(ix), w(iy), seed);
  const b = hashCell(w(ix + 1), w(iy), seed);
  const c = hashCell(w(ix), w(iy + 1), seed);
  const d = hashCell(w(ix + 1), w(iy + 1), seed);
  return lerp(lerp(a, b, sx), lerp(c, d, sx), sy);
}

function dataTexture(data: Uint8Array, size: number): THREE.DataTexture {
  const texture = new THREE.DataTexture(data as Uint8Array<ArrayBuffer>, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

/** R: fbm (8 cells across), G: value noise (32), B: value noise (64), A: fbm (4). Cells: R F1, G F2-F1, B id, A finer F1. */
export function produceNoiseTextures() {
  if (produceTextures) return produceTextures;
  const size = 256;
  const noise = new Uint8Array(size * size * 4);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const u = i / size;
      const v = j / size;
      let fbm = 0;
      let fbm2 = 0;
      let amp = 0.5;
      let norm = 0;
      for (let o = 0; o < 5; o++) {
        const f = 8 << o;
        fbm += tiledValue(u * f, v * f, f, 3 + o) * amp;
        fbm2 += tiledValue(u * (f / 2), v * (f / 2), f / 2, 31 + o) * amp;
        norm += amp;
        amp *= 0.5;
      }
      const k = (j * size + i) * 4;
      noise[k] = Math.round((fbm / norm) * 255);
      noise[k + 1] = Math.round(tiledValue(u * 32, v * 32, 32, 7) * 255);
      noise[k + 2] = Math.round(tiledValue(u * 64, v * 64, 64, 11) * 255);
      noise[k + 3] = Math.round((fbm2 / norm) * 255);
    }
  }
  const cells = new Uint8Array(size * size * 4);
  const layer = (count: number, seed: number) => {
    const points: number[] = [];
    for (let y = 0; y < count; y++) for (let x = 0; x < count; x++) points.push(x + 0.15 + hashCell(x, y, seed) * 0.7, y + 0.15 + hashCell(x, y, seed + 9) * 0.7, hashCell(x, y, seed + 17));
    return (u: number, v: number) => {
      const x = u * count;
      const y = v * count;
      const cx = Math.floor(x);
      const cy = Math.floor(y);
      let d1 = 9;
      let d2 = 9;
      let id = 0;
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const gx = cx + ox;
          const gy = cy + oy;
          const wx = ((gx % count) + count) % count;
          const wy = ((gy % count) + count) % count;
          const p = (wy * count + wx) * 3;
          const px = points[p] + (gx - wx);
          const py = points[p + 1] + (gy - wy);
          const d = Math.hypot(px - x, py - y);
          if (d < d1) {
            d2 = d1;
            d1 = d;
            id = points[p + 2];
          } else if (d < d2) d2 = d;
        }
      }
      return [d1, d2 - d1, id];
    };
  };
  const coarse = layer(16, 5);
  const fine = layer(32, 77);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const u = (i + 0.5) / size;
      const v = (j + 0.5) / size;
      const [f1, border, id] = coarse(u, v);
      const [g1] = fine(u, v);
      const k = (j * size + i) * 4;
      cells[k] = Math.round(Math.min(1, f1) * 255);
      cells[k + 1] = Math.round(Math.min(1, border) * 255);
      cells[k + 2] = Math.round(id * 255);
      cells[k + 3] = Math.round(Math.min(1, g1) * 255);
    }
  }
  produceTextures = { noise: dataTexture(noise, size), cells: dataTexture(cells, size) };
  return produceTextures;
}

const PRODUCE_COMMON = /* glsl */ `
  varying vec4 vSurf;
  varying vec3 vLocal;
  varying vec3 vLocalN;
  varying vec2 vPUv;
  uniform vec3 uKeyView;
  uniform vec3 uTint;
  uniform vec3 uTint2;
  uniform float uGlow;
  uniform sampler2D uPNoise;
  uniform sampler2D uPCells;
  float pWrap;
  vec3 pTrans;

  vec3 pH3(vec3 p) {
    p = vec3(dot(p, vec3(127.1, 311.7, 74.7)), dot(p, vec3(269.5, 183.3, 246.1)), dot(p, vec3(113.5, 271.9, 124.6)));
    return fract(sin(p) * 43758.5453);
  }
  // Value noise with a lattice spacing of 1, in 3D from two slices of a tiled texture.
  float pN(vec3 p) {
    float z = floor(p.z);
    float f = fract(p.z);
    f = f * f * (3.0 - 2.0 * f);
    float a = textureLod(uPNoise, (p.xy + vec2(5.37, 9.71) * z) / 32.0, 0.0).g;
    float b = textureLod(uPNoise, (p.xy + vec2(5.37, 9.71) * (z + 1.0)) / 32.0, 0.0).g;
    return mix(a, b, f);
  }
  // Five-octave fractal noise, base lattice spacing 1.
  float pF(vec3 p) {
    float z = floor(p.z);
    float f = fract(p.z);
    f = f * f * (3.0 - 2.0 * f);
    float a = textureLod(uPNoise, (p.xy + vec2(3.17, 7.29) * z) / 8.0, 0.0).r;
    float b = textureLod(uPNoise, (p.xy + vec2(3.17, 7.29) * (z + 1.0)) / 8.0, 0.0).r;
    return mix(a, b, f);
  }
  // Cellular noise, one cell per unit: x nearest distance, y distance to the border, z cell id.
  vec3 pC(vec2 q) { return textureLod(uPCells, q / 16.0, 0.0).rgb; }
  // The same on a curved surface, projected three ways and blended by the normal.
  vec3 pCT(vec3 p, vec3 n) {
    vec3 w = pow(abs(n), vec3(4.0));
    w /= (w.x + w.y + w.z);
    return pC(p.yz) * w.x + pC(p.zx + 7.3) * w.y + pC(p.xy + 3.1) * w.z;
  }
  // Bump mapping from screen-space derivatives of a procedural height.
  vec3 pBump(vec3 pos, vec3 n, float h) {
    vec3 dpx = dFdx(pos);
    vec3 dpy = dFdy(pos);
    float dhx = dFdx(h);
    float dhy = dFdy(h);
    vec3 r1 = cross(dpy, n);
    vec3 r2 = cross(n, dpx);
    float det = dot(dpx, r1);
    vec3 grad = sign(det) * (dhx * r1 + dhy * r2);
    return normalize(abs(det) * n - grad);
  }
`;

/** Per-surface GLSL. Inputs: lp, ln, uv, sf, col, wN; outputs alb, rough, coat... */
const PRODUCE_SURFACES: Record<number, string> = {
  [SURF.plain]: `alb = col; rough = sf.z; coat = sf.w;`,
  [SURF.nut]: `
    // Fine dark streaks run from the tip to the cup over a satin shell.
    vec2 around = normalize(lp.xz + 1e-5);
    float streak = pN(vec3(around * 9.0, lp.y * 1.6 + seed * 7.0)) * 0.5 + pN(vec3(around * 26.0, lp.y * 3.0 + seed)) * 0.5;
    float lines = smoothstep(0.55, 0.85, streak);
    float fine = pN(lp * 70.0);
    float tipMark = smoothstep(0.08, 0.0, lp.y);
    alb = col * mix(1.05, 0.62, lines) * mix(0.94, 1.03, fine);
    alb = mix(alb, vec3(0.05, 0.03, 0.02), tipMark * 0.75);
    rough = mix(0.34, 0.44, lines); coat = 0.35; coatRough = 0.2;
    sheen = col * 0.25; sheenRough = 0.45;
    h = streak * 0.5 + fine * 0.12; bump = 0.003;
    pWrap = 0.18; pTrans = col * 0.08;`,
  [SURF.cupScale]: `
    float across = abs(uv.x * 2.0 - 1.0);
    float edge = smoothstep(0.55, 1.0, across) * 0.45 + smoothstep(0.62, 1.0, uv.y) * 0.4;
    float fib = pN(vec3(uv.x * 18.0, uv.y * 30.0, seed * 9.0));
    float fuzz = pN(lp * 260.0 + seed);
    float grey = pN(lp * 30.0 + seed * 4.0);
    alb = col * mix(1.08, 0.66, edge) * mix(0.84, 1.1, fib) * mix(0.9, 1.06, fuzz);
    alb = mix(alb, vec3(0.32, 0.3, 0.27), smoothstep(0.55, 0.85, grey) * 0.35);
    rough = 0.9; sheen = vec3(0.3, 0.28, 0.24); sheenRough = 0.6;
    h = fib * 0.35 + fuzz * 0.3 - edge * 0.35; bump = 0.0028;
    pWrap = 0.2;`,
  [SURF.bark]: `
    float fib = pN(vec3(uv.y * 34.0, uv.x * 5.0, seed * 3.0)) * 0.7 + pN(vec3(uv.y * 90.0, uv.x * 9.0, seed)) * 0.3;
    alb = col * mix(0.68, 1.12, fib); rough = 0.82; sheen = col * 0.3; sheenRough = 0.6;
    h = fib; bump = 0.003;
    alb = mix(alb, col * vec3(1.6, 1.45, 1.2), sf.z * smoothstep(0.97, 1.0, uv.y));`,
  [SURF.grain]: `
    float vein = 0.5 + 0.5 * cos(uv.x * 6.2831 * 9.0);
    float base = smoothstep(0.0, 0.3, uv.y);
    float fine = pN(lp * 300.0 + seed);
    alb = col * mix(0.8, 1.05, vein) * mix(0.62, 1.0, base) * mix(0.92, 1.05, fine);
    rough = 0.5; sheen = col * 0.45; sheenRough = 0.38; coat = 0.12; coatRough = 0.3;
    h = vein * 0.6 + fine * 0.2; bump = 0.0012;
    pWrap = 0.45; pTrans = col * 0.45;`,
  [SURF.awn]: `
    alb = col * mix(0.85, 1.1, uv.y); rough = 0.4; sheen = col * 0.5; sheenRough = 0.3;
    pWrap = 0.6; pTrans = col * 0.8;`,
  [SURF.pod]: `
    // A waxy green pod: fine veins, a pale seam, a dusty bloom in patches.
    float n1 = pN(lp * 22.0 + seed);
    float n2 = pN(lp * 95.0 + seed * 2.0);
    float vein = smoothstep(0.86, 1.0, 0.5 + 0.5 * sin(uv.y * 90.0 + n1 * 3.0 + uv.x * 18.0)) * 0.35;
    float suture = smoothstep(0.035, 0.0, abs(fract(uv.x + 0.25) - 0.5) - 0.465);
    float waxy = smoothstep(0.45, 0.75, pF(lp * 5.0 + seed * 3.0));
    alb = col * mix(0.84, 1.06, n1) * (1.0 - vein * 0.12);
    alb = mix(alb, col * vec3(0.85, 1.05, 0.7), suture * 0.7);
    alb = mix(alb, vec3(0.42, 0.52, 0.36), waxy * 0.22);
    rough = mix(0.36, 0.55, waxy) - n2 * 0.08; coat = 0.3 * (1.0 - waxy); coatRough = 0.22;
    sheen = vec3(0.1, 0.13, 0.09) + waxy * 0.12; sheenRough = 0.45;
    h = n1 * 0.5 + n2 * 0.25 + vein - suture * 0.5; bump = 0.0022;
    pWrap = 0.45; pTrans = col * vec3(0.6, 0.85, 0.35) * 0.6;`,
  [SURF.water]: `
    alb = vec3(0.0); rough = 0.03; coat = 1.0; coatRough = 0.02; special = 1;`,
  [SURF.root]: `
    // A deep crimson root with fine growth rings. In the deepest cracks the
    // flesh glows like embers under ash.
    float ang = atan(lp.z, lp.x);
    vec2 around = normalize(lp.xz + 1e-5);
    float ringN = pN(vec3(around * 1.6, lp.y * 5.0 + seed));
    float rings = sin(lp.y * 95.0 + ringN * 7.0 + sin(ang * 3.0) * 0.9);
    float broken = smoothstep(0.45, 0.75, pN(vec3(around * 3.2, lp.y * 11.0 + 3.1 + seed)));
    float crease = smoothstep(0.8, 0.99, rings) * broken;
    float fine = smoothstep(0.9, 1.0, sin(lp.y * 260.0 + ringN * 9.0)) * 0.5;
    float pits = smoothstep(0.78, 0.92, pN(lp * 46.0 + seed));
    float mott = pF(lp * 7.0 + seed);
    alb = col * (1.0 - crease * 0.75) * (1.0 - fine * 0.3) * mix(0.78, 1.1, mott) * (1.0 - pits * 0.3);
    rough = 0.48 - mott * 0.12; sheen = col * 0.4 + 0.02; sheenRough = 0.45; coat = 0.2; coatRough = 0.28;
    h = -crease * 1.0 - fine * 0.3 + ringN * 0.25 - pits * 0.3; bump = 0.0035;
    pWrap = 0.5; pTrans = vec3(0.7, 0.08, 0.02) * 0.45;
    float flicker = 0.7 + 0.3 * pN(lp * 9.0 + seed * 4.0);
    float core = smoothstep(0.93, 1.0, rings) * broken;
    emis = (vec3(1.0, 0.28, 0.03) * crease + vec3(1.0, 0.62, 0.18) * core) * flicker * 1.25 * uGlow + vec3(0.5, 0.05, 0.01) * 0.05 * uGlow;`,
  [SURF.leaf]: `
    float x = uv.x - 0.5;
    float ax = abs(x) * 2.0;
    float mid = smoothstep(0.06, 0.0, ax) * smoothstep(1.0, 0.85, uv.y);
    float lat = abs(fract((uv.y - ax * 0.32) * 7.0 + seed) - 0.5);
    float lateral = smoothstep(0.43, 0.5, lat) * smoothstep(0.95, 0.4, ax) * smoothstep(0.0, 0.1, uv.y);
    float net = smoothstep(0.08, 0.0, pC(uv * vec2(14.0, 22.0) + seed * 7.0).y);
    float veins = max(mid, lateral * 0.75);
    float cellN = pN(vec3(uv * vec2(50.0, 80.0), seed));
    vec3 veinCol = mix(col * vec3(1.25, 1.3, 1.0), vec3(0.42, 0.02, 0.04), sf.z);
    alb = col * mix(0.88, 1.06, cellN) * (1.0 - net * 0.08);
    alb = mix(alb, veinCol, veins * mix(0.65, 0.95, sf.z));
    alb = mix(alb, uTint2, smoothstep(0.82, 1.0, ax) * sf.w);
    rough = 0.46 + net * 0.05; coat = 0.22; coatRough = 0.28;
    sheen = col * 0.25; sheenRough = 0.5;
    h = -veins * 0.8 - net * 0.15 + cellN * 0.15; bump = 0.002;
    pWrap = 0.35; pTrans = col * vec3(0.95, 1.15, 0.45) * 0.55;`,
  [SURF.berry]: `
    // Deep indigo skin under a dusty waxy bloom, rubbed glossy in places,
    // with a little hoarfrost on the tops.
    float bloomN = pF(lp * 2.2 + seed * 11.0);
    float bloom = smoothstep(0.3, 0.66, bloomN);
    float speck = pN(lp * 42.0 + seed);
    float crown = sf.z;
    // Hoarfrost: fine crystals gathered on the upward faces.
    float frostN = pN(lp * 6.0 + seed * 3.0);
    float crystals = smoothstep(0.3, 0.08, pCT(lp * 26.0 + seed, ln).x);
    float frostZone = smoothstep(0.55, 0.9, wN.y * 0.7 + frostN * 0.45) * (1.0 - crown);
    float frost = frostZone * (0.35 + 0.65 * crystals);
    vec3 bloomCol = vec3(0.12, 0.16, 0.31) * mix(0.85, 1.12, speck);
    vec3 frostCol = vec3(0.78, 0.87, 0.96);
    alb = mix(col, bloomCol, bloom * 0.75);
    alb = mix(alb, col * vec3(0.75, 0.66, 0.6), crown);
    alb = mix(alb, frostCol, frost * 0.8);
    rough = mix(0.2, 0.6, bloom); rough = mix(rough, 0.38, frost); rough = mix(rough, 0.8, crown);
    coat = (1.0 - bloom) * 0.75 * (1.0 - frost); coatRough = 0.08;
    sheen = vec3(0.14, 0.18, 0.32) * bloom + vec3(0.4, 0.5, 0.6) * frost; sheenRough = 0.42;
    h = speck * 0.3 + frost * 0.9; bump = 0.0016;
    pWrap = 0.25; pTrans = vec3(0.1, 0.03, 0.2) * 0.5;
    glitter = frostZone * 1.5; glitterFreq = 70.0; glitterDensity = 0.3;`,
  [SURF.rind]: `
    // Corky netting of varying width over a pale silvery skin, faint lunar
    // patches and the sutures that run from pole to pole.
    vec3 cell = pCT(lp * 6.2 + seed, ln);
    vec3 cell2 = pCT(lp * 21.0 + seed * 2.0, ln);
    float netN = pN(lp * 30.0 + seed);
    float width = mix(0.12, 0.27, pN(lp * 9.0 + seed * 5.0));
    float net = smoothstep(width, width * 0.3, cell.y) * smoothstep(0.1, 0.5, netN + 0.25);
    net = max(net, smoothstep(0.07, 0.02, cell2.y) * 0.55 * smoothstep(0.35, 0.7, netN));
    float ang = atan(lp.z, lp.x);
    float suture = smoothstep(0.93, 1.0, cos(ang * 5.0 + 0.4));
    float mott = pF(lp * 4.0 + seed * 3.0);
    float crater = smoothstep(0.32, 0.1, pCT(lp * 2.2 + seed * 5.0, ln).x);
    vec3 base = col * mix(0.82, 1.08, mott) * (1.0 - crater * 0.1);
    alb = mix(base, uTint * mix(0.86, 1.05, netN), net * 0.95);
    alb *= 1.0 - suture * 0.18;
    rough = mix(0.46, 0.9, net); sheen = vec3(0.1, 0.11, 0.12); sheenRough = 0.6; coat = (1.0 - net) * 0.15; coatRough = 0.4;
    h = net * 1.0 - suture * 0.8 + netN * 0.25 - crater * 0.25; bump = 0.005;
    pWrap = 0.25; pTrans = col * 0.08;`,
  [SURF.flesh]: `
    // Juicy pale flesh: radial fibres, greener under the rind, sweeter and
    // more golden towards the seed cavity.
    float rr = lp.z;
    float fib = pN(vec3(lp.xy * vec2(9.0, 70.0), seed)) * 0.6 + pN(vec3(lp.xy * 110.0, seed + 1.0)) * 0.4;
    vec3 fleshCol = col * mix(0.9, 1.04, fib);
    alb = mix(fleshCol, fleshCol * vec3(1.05, 1.0, 0.8), smoothstep(0.62, 0.48, rr));
    alb = mix(alb, uTint2, smoothstep(0.82, 0.95, rr));
    alb = mix(alb, uTint * 0.6, smoothstep(0.965, 0.985, rr));
    rough = 0.24; coat = 0.7; coatRough = 0.07;
    h = fib * 0.35; bump = 0.0014;
    pWrap = 0.7; pTrans = fleshCol * 0.6;
    emis = fleshCol * 0.05 * uGlow;
    glitter = 0.8; glitterFreq = 70.0; glitterDensity = 0.14;`,
  [SURF.seed]: `
    alb = col * mix(0.85, 1.05, pN(lp * 30.0 + seed)); rough = 0.32; coat = 0.6; coatRough = 0.12; pWrap = 0.3; pTrans = col * 0.3;`,
  [SURF.figSkin]: `
    float ang = atan(lp.z, lp.x);
    float rib = 0.5 + 0.5 * cos(ang * 9.0 + sin(lp.y * 5.0) * 0.5);
    vec3 cell = pCT(lp * 26.0 + seed, ln);
    float dots = smoothstep(0.13, 0.05, cell.x) * step(0.55, cell.z);
    float mott = pF(lp * 5.0 + seed);
    alb = col * mix(0.78, 1.12, mott) * mix(0.9, 1.05, rib);
    alb = mix(alb, uTint, dots * 0.55);
    rough = 0.52; sheen = vec3(0.36, 0.3, 0.4); sheenRough = 0.38; coat = 0.12; coatRough = 0.3;
    h = rib * 0.6 + mott * 0.25 + dots * 0.2; bump = 0.003;
    pWrap = 0.3; pTrans = vec3(0.3, 0.04, 0.12) * 0.35;`,
  [SURF.figFlesh]: `
    float edgeD = 1.0 - lp.z;
    vec2 q = vec2(lp.x, lp.y - sf.z);
    float r = length(q) / sf.w;
    float a = atan(q.y, q.x);
    // From the skin inwards: a cream pith, pale pink threads of flesh turning
    // deep red, golden seeds, and at the centre a star-shaped hollow.
    float starR = 0.3 + 0.26 * pow(abs(cos(a * 2.5 + 0.3)), 4.0);
    float heart = smoothstep(starR + 0.04, starR - 0.015, r);
    float strandN = pN(vec3(q * 18.0, seed));
    float strands = 0.5 + 0.5 * sin(a * 52.0 + strandN * 6.0 + r * 9.0);
    vec3 cell = pC(q * 52.0 + seed * 5.0);
    float inner = smoothstep(0.16, 0.42, edgeD);
    float seeds = smoothstep(0.26, 0.13, cell.x) * step(0.25, cell.z) * inner;
    vec3 skin = uTint;
    vec3 pith = vec3(0.8, 0.7, 0.5);
    vec3 outerFlesh = vec3(0.74, 0.42, 0.34);
    vec3 innerFlesh = vec3(0.4, 0.03, 0.06);
    vec3 flesh = mix(outerFlesh, innerFlesh, smoothstep(0.2, 0.55, edgeD + (1.0 - r) * 0.08));
    flesh *= mix(0.72, 1.12, strands);
    alb = mix(flesh, pith * mix(0.9, 1.03, strandN), smoothstep(0.2, 0.11, edgeD));
    alb = mix(alb, skin, smoothstep(0.035, 0.015, edgeD));
    alb = mix(alb, vec3(0.78, 0.55, 0.22) * mix(0.8, 1.15, cell.z), seeds * 0.9);
    alb = mix(alb, mix(vec3(0.95, 0.64, 0.24), vec3(0.7, 0.2, 0.1), smoothstep(0.0, starR, r)), heart);
    rough = mix(0.3, 0.14, heart); coat = 0.55 + heart * 0.4; coatRough = 0.08;
    h = strands * 0.25 + seeds * 0.6 - heart * 0.6; bump = 0.0016;
    pWrap = 0.6; pTrans = alb * 0.4;
    emis = vec3(1.0, 0.7, 0.25) * heart * 0.12 * uGlow;
    glitter = 0.5 + heart; glitterFreq = 80.0; glitterDensity = 0.18;`,
  [SURF.glass]: `
    alb = vec3(0.0); rough = 0.04; coat = 1.0; coatRough = 0.02;
    special = lp.y > sf.z ? 3 : 2;`,
  [SURF.cork]: `
    vec3 cell = pCT(lp * 55.0 + seed, ln);
    float pore = smoothstep(0.24, 0.06, cell.x) * step(0.5, cell.z);
    float n = pF(lp * 22.0 + seed);
    alb = col * mix(0.78, 1.12, n) * (1.0 - pore * 0.6);
    rough = 0.9; sheen = col * 0.3; sheenRough = 0.7;
    h = n * 0.4 - pore * 0.8; bump = 0.0022;`,
  [SURF.twine]: `
    float tw = 0.5 + 0.5 * sin(uv.y * 260.0 + uv.x * 12.566);
    float fuzz = pN(lp * 180.0);
    alb = col * mix(0.7, 1.08, tw) * mix(0.88, 1.06, fuzz);
    rough = 0.9; sheen = col * 0.7; sheenRough = 0.45;
    h = tw * 0.8 + fuzz * 0.2; bump = 0.0012;`,
  [SURF.shell]: `
    // Speckles cluster in patches and towards the broad end, in two sizes,
    // with a few washed-out blotches, as on a thrush's egg.
    float s1 = pF(lp * 4.0 + seed * 7.0);
    float clump = pF(lp * 1.6 + seed * 3.0 + 11.0);
    float density = clamp(0.25 + clump * 0.7 - lp.y * 0.18, 0.0, 1.0);
    vec3 c1 = pCT(lp * 7.0 + seed * 3.0, ln);
    float speck = smoothstep(0.26 + (s1 - 0.5) * 0.18, 0.1, c1.x) * step(1.0 - density * 0.8, c1.z);
    vec3 c2 = pCT(lp * 22.0 + seed * 5.0, ln);
    float fineSpeck = smoothstep(0.22, 0.08, c2.x) * step(1.0 - density, c2.z);
    float blotch = smoothstep(0.62, 0.78, pF(lp * 2.4 + seed * 2.0 + 5.0)) * (0.4 + 0.6 * clump);
    float pores = pN(lp * 150.0);
    alb = col * mix(0.9, 1.05, s1);
    alb = mix(alb, mix(uTint, col * 0.75, 0.55), blotch * 0.45);
    alb = mix(alb, uTint * mix(0.75, 1.2, s1), max(speck * 0.9, fineSpeck * 0.7));
    rough = 0.48 + pores * 0.12; sheen = vec3(0.14); sheenRough = 0.4; coat = 0.15; coatRough = 0.35;
    h = pores * 0.5 + speck * 0.2; bump = 0.001;
    pWrap = 0.25; pTrans = col * 0.12;`,
  [SURF.mushCap]: `
    float ang = atan(lp.z, lp.x);
    float rr = clamp(length(lp.xz), 0.0, 1.0);
    float stri = 0.5 + 0.5 * cos(ang * 30.0 + pN(lp * 6.0 + seed) * 2.5);
    float n = pF(lp * 6.0 + seed);
    float striation = stri * smoothstep(0.25, 0.95, rr);
    alb = col * mix(0.86, 1.05, n) * mix(1.0, 0.82, striation);
    alb = mix(alb, uTint2, smoothstep(0.45, 0.0, rr) * 0.75);
    rough = 0.4; coat = 0.35; coatRough = 0.2; sheen = vec3(0.08); sheenRough = 0.4;
    h = striation * 0.7 + n * 0.2; bump = 0.002;
    pWrap = 0.65; pTrans = col * 0.95;
    emis = uTint * (0.06 + 0.5 * smoothstep(0.55, 1.0, rr) * (0.6 + 0.4 * stri)) * uGlow;`,
  [SURF.gills]: `
    if (sf.z > 0.5) {
      float fib = pN(vec3(uv.y * 46.0, uv.x * 7.0, seed));
      alb = col * mix(0.84, 1.05, fib); rough = 0.5; sheen = col * 0.3; sheenRough = 0.5;
      pWrap = 0.6; pTrans = col * 0.7; h = fib; bump = 0.0012;
      emis = uTint * (0.05 + 0.2 * smoothstep(0.35, 1.0, uv.y)) * uGlow;
    } else {
      float lam = abs(fract(uv.x * 44.0) - 0.5) * 2.0;
      float ridge = smoothstep(0.75, 0.15, lam);
      alb = col * mix(0.5, 1.0, ridge); rough = 0.62; h = ridge; bump = 0.0018;
      pWrap = 0.5; pTrans = col * 0.6;
      emis = uTint * (0.35 + 0.9 * ridge) * smoothstep(0.0, 0.35, uv.y) * uGlow;
    }`,
  [SURF.moss]: `
    if (sf.z > 0.5) {
      float fib = pN(vec3(uv.y * 8.0, uv.x * 60.0, seed)) * 0.6 + pN(lp * 40.0) * 0.4;
      float crack = smoothstep(0.62, 0.7, pN(vec3(uv.y * 3.0, uv.x * 26.0, seed + 2.0)));
      alb = col * mix(0.6, 1.15, fib) * (1.0 - crack * 0.6);
      rough = 0.86; sheen = col * 0.2; sheenRough = 0.6; h = fib - crack; bump = 0.004;
    } else {
      float n = pF(lp * 26.0 + seed);
      float n2 = pN(lp * 160.0);
      alb = col * mix(0.55, 1.2, n) * mix(0.8, 1.08, n2);
      alb = mix(alb, uTint2, smoothstep(0.62, 0.8, n) * 0.35);
      rough = 0.92; sheen = vec3(0.22, 0.32, 0.1); sheenRough = 0.8; h = n + n2 * 0.6; bump = 0.005;
      pWrap = 0.4; pTrans = col * 0.3;
    }`,
  [SURF.pitaya]: `
    float n = pF(lp * 5.0 + seed);
    float n2 = pN(lp * 70.0 + seed);
    alb = col * mix(0.84, 1.1, n);
    rough = 0.36 + n2 * 0.1; coat = 0.35; coatRough = 0.18; sheen = col * 0.25; sheenRough = 0.4;
    h = n * 0.6 + n2 * 0.25; bump = 0.0022;
    pWrap = 0.35; pTrans = col * 0.35;`,
  [SURF.bract]: `
    float vein = smoothstep(0.1, 0.0, abs(uv.x - 0.5)) * 0.6;
    float n = pN(vec3(uv * vec2(9.0, 34.0), seed));
    alb = col * mix(0.88, 1.06, n) * (1.0 - vein * 0.12);
    rough = 0.38; coat = 0.35; coatRough = 0.18; sheen = col * 0.2; sheenRough = 0.4;
    h = n * 0.3 - vein; bump = 0.0016;
    pWrap = 0.45; pTrans = col * 0.6;`,
  [SURF.pitayaFlesh]: `
    // White pulp packed with small black seeds, each in a clear jelly, and a
    // thin magenta rind with a pink blush just inside it.
    float edgeD = 1.0 - lp.z;
    vec3 cell = pC(lp.xy * 36.0 + seed * 3.0);
    float keep = step(0.12, cell.z) * smoothstep(0.03, 0.1, edgeD);
    float seedM = smoothstep(0.17, 0.1, cell.x) * keep;
    float jelly = smoothstep(0.3, 0.16, cell.x) * keep;
    float pulp = pN(vec3(lp.xy * 60.0, seed + 3.0));
    vec3 flesh = col * mix(0.92, 1.02, pulp);
    alb = mix(flesh, flesh * vec3(0.86, 0.85, 0.88), jelly * 0.6);
    alb = mix(alb, uTint, smoothstep(0.05, 0.02, edgeD));
    alb = mix(alb, flesh * vec3(1.0, 0.8, 0.86), smoothstep(0.12, 0.05, edgeD) * (1.0 - smoothstep(0.05, 0.02, edgeD)) * 0.7);
    alb = mix(alb, vec3(0.012, 0.01, 0.01), seedM);
    rough = mix(0.3, 0.16, seedM); coat = 0.5; coatRough = 0.1;
    h = seedM * 0.8 + pulp * 0.25; bump = 0.0013;
    pWrap = 0.6; pTrans = flesh * 0.45;
    glitter = 0.7; glitterFreq = 90.0; glitterDensity = 0.12;`,
  [SURF.wax]: `
    // Beeswax: soft, waxy and translucent, glowing where light passes through
    // the thin walls, with a little honey smeared on it.
    float n = pF(lp * 26.0 + seed);
    float n2 = pN(lp * 130.0);
    float smear = smoothstep(0.55, 0.8, pF(lp * 9.0 + seed * 3.0));
    alb = col * mix(0.86, 1.05, n);
    alb = mix(alb, vec3(0.8, 0.42, 0.04), smear * 0.35);
    rough = mix(0.5 - n2 * 0.1, 0.12, smear); coat = 0.25 + smear * 0.6; coatRough = 0.18; sheen = col * 0.3; sheenRough = 0.5;
    h = n * 0.3 + n2 * 0.2; bump = 0.0012;
    pWrap = 0.8; pTrans = col * vec3(1.0, 0.7, 0.25) * 1.1;
    emis = col * vec3(1.0, 0.7, 0.3) * 0.08;`,
  [SURF.honey]: `
    alb = col * 0.05; rough = 0.035; coat = 1.0; coatRough = 0.025; special = 4;
    glitter = 1.2; glitterFreq = 52.0; glitterDensity = 0.12;`,
  [SURF.straw]: `
    float st = 0.5 + 0.5 * sin(uv.x * 6.2831 * 7.0 + pN(lp * 20.0) * 2.0);
    float along = pN(vec3(uv.y * 26.0, uv.x * 3.0, seed));
    alb = col * mix(0.78, 1.08, st) * mix(0.82, 1.06, along);
    rough = 0.55; sheen = col * 0.45; sheenRough = 0.35; coat = 0.1; coatRough = 0.3;
    h = st; bump = 0.0009; pWrap = 0.4; pTrans = col * 0.35;`,
  [SURF.bean]: `
    float n = pN(lp * 18.0 + seed);
    alb = col * mix(0.88, 1.06, n); rough = 0.3; coat = 0.55; coatRough = 0.14;
    h = n * 0.3; bump = 0.0012; pWrap = 0.5; pTrans = col * 0.45;`,
  [SURF.podInner]: `
    float n = pN(lp * 40.0 + seed);
    alb = col * mix(0.88, 1.06, n); rough = 0.72; sheen = col * 0.3; sheenRough = 0.6;
    h = n * 0.4; bump = 0.0015; pWrap = 0.55; pTrans = col * 0.45;`,
  [SURF.paper]: `
    float n = pN(lp * 60.0 + seed);
    float fibre = pN(vec3(lp.x * 400.0, lp.y * 40.0, seed));
    alb = col * mix(0.9, 1.04, n) * mix(0.96, 1.02, fibre);
    rough = 0.85; sheen = col * 0.2; sheenRough = 0.6; h = n * 0.3 + fibre * 0.2; bump = 0.0006;
    pWrap = 0.3; pTrans = col * 0.3;`,
};

export interface ProduceOptions {
  tint?: THREE.ColorRepresentation;
  tint2?: THREE.ColorRepresentation;
  glow?: number;
}

/** The key light's direction in view space, shared by every produce material. */
export const produceKeyView = { value: new THREE.Vector3(0.3, 0.7, 0.6) };

function produceBranches(kinds: number[]) {
  return kinds.map((kind, i) => `${i === 0 ? "" : "else "}if (kind == ${kind}) {\n${PRODUCE_SURFACES[kind] ?? PRODUCE_SURFACES[SURF.plain]}\n}`).join("\n");
}

/**
 * A material for one food. Only the surfaces that food uses are compiled in,
 * which keeps each program small: one big shader with every surface takes
 * seconds to compile on integrated graphics.
 */
export function makeProduceMaterial(kindSet: Set<number> = new Set([SURF.plain]), options: ProduceOptions = {}): THREE.MeshPhysicalMaterial {
  const kinds = [...kindSet].sort((a, b) => a - b);
  const material = new THREE.MeshPhysicalMaterial({
    vertexColors: true,
    roughness: 0.5,
    metalness: 0,
    sheen: 1,
    sheenColor: new THREE.Color(0, 0, 0),
    sheenRoughness: 0.5,
    clearcoat: 1,
    clearcoatRoughness: 0.2,
    side: THREE.DoubleSide,
  });
  const textures = produceNoiseTextures();
  const uniforms = {
    uKeyView: produceKeyView,
    uTint: { value: new THREE.Color(options.tint ?? "#ffffff") },
    uTint2: { value: new THREE.Color(options.tint2 ?? "#ffffff") },
    uGlow: { value: options.glow ?? 1 },
    uPNoise: { value: textures.noise },
    uPCells: { value: textures.cells },
  };
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        /* glsl */ `#include <common>
        attribute vec4 aSurf;
        attribute vec3 aLocal;
        attribute vec3 aLocalN;
        varying vec4 vSurf;
        varying vec3 vLocal;
        varying vec3 vLocalN;
        varying vec2 vPUv;`,
      )
      .replace(
        "#include <begin_vertex>",
        /* glsl */ `#include <begin_vertex>
        vSurf = aSurf;
        vLocal = aLocal;
        vLocalN = aLocalN;
        vPUv = uv;`,
      );
    const lights = THREE.ShaderChunk.lights_physical_pars_fragment.replace(
      "reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );",
      /* glsl */ `{
        float nl = dot( geometryNormal, directLight.direction );
        float wrapped = saturate( ( nl + pWrap ) / ( 1.0 + pWrap ) );
        reflectedLight.directDiffuse += directLight.color * wrapped * BRDF_Lambert( material.diffuseColor );
        float through = saturate( -nl ) * 0.55 + pow( saturate( dot( geometryViewDir, -directLight.direction ) ), 3.0 ) * 0.7;
        reflectedLight.directDiffuse += directLight.color * pTrans * through * RECIPROCAL_PI;
      }`,
    );
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${PRODUCE_COMMON}`)
      .replace("#include <lights_physical_pars_fragment>", lights)
      .replace(
        "#include <color_fragment>",
        /* glsl */ `
        vec3 col = vColor;
        vec3 alb = col;
        float rough = 0.5;
        float metal = 0.0;
        float coat = 0.0;
        float coatRough = 0.3;
        vec3 sheen = vec3(0.0);
        float sheenRough = 0.5;
        float h = 0.0;
        float bump = 0.0;
        vec3 emis = vec3(0.0);
        float glitter = 0.0;
        float glitterFreq = 50.0;
        float glitterDensity = 0.1;
        int special = 0;
        pWrap = 0.0;
        pTrans = vec3(0.0);
        vec4 sf = vSurf;
        int kind = int(sf.x + 0.5);
        float seed = sf.y;
        vec3 lp = vLocal;
        vec3 ln = normalize(vLocalN);
        vec2 uv = vPUv;
        vec3 wN = normalize((vec4(vNormal, 0.0) * viewMatrix).xyz);
        ${produceBranches(kinds)}
        diffuseColor.rgb = alb;
        `,
      )
      .replace("#include <roughnessmap_fragment>", "float roughnessFactor = rough;")
      .replace("#include <metalnessmap_fragment>", "float metalnessFactor = metal;")
      .replace(
        "#include <normal_fragment_maps>",
        /* glsl */ `#include <normal_fragment_maps>
        if (bump > 0.0) normal = pBump(-vViewPosition, normal, h * bump);`,
      )
      .replace(
        "#include <clearcoat_normal_fragment_begin>",
        /* glsl */ `#include <clearcoat_normal_fragment_begin>
        clearcoatNormal = normalize(mix(clearcoatNormal, normal, 0.35));`,
      )
      .replace(
        "#include <emissivemap_fragment>",
        /* glsl */ `#include <emissivemap_fragment>
        {
          vec3 V = normalize(vViewPosition);
          float nv = saturate(dot(normal, V));
          vec3 Lk = normalize(uKeyView);
          if (special == 1) {
            // A water drop is a lens: the surface below shows through, a dark rim
            // where light reflects away, and the key light focused opposite it.
            float core = smoothstep(0.05, 0.85, nv);
            vec2 away = -Lk.xy;
            float side = dot(normalize(normal.xy + 1e-4), normalize(away + 1e-4));
            float caustic = pow(saturate(side), 3.0) * smoothstep(0.15, 0.55, nv) * smoothstep(0.98, 0.6, nv);
            emis += col * (0.06 + core * 0.7) + mix(col, vec3(1.0), 0.45) * caustic * 1.3;
          } else if (special == 2) {
            // Warm liquid seen through glass: deep at the edges where the light
            // has crossed the most liquid, brighter through the middle, and the
            // round body focusing the key light on its far side.
            float thick = pow(nv, 0.8);
            vec2 away = -Lk.xy;
            float side = dot(normalize(normal.xy + 1e-4), normalize(away + 1e-4));
            float focus = pow(saturate(side * 0.5 + 0.5), 3.0) * smoothstep(0.1, 0.6, nv);
            vec3 deep = uTint * vec3(0.5, 0.16, 0.05);
            vec3 bright = mix(uTint, vec3(1.0, 0.85, 0.42), 0.5);
            vec3 liquid = mix(deep, uTint, smoothstep(0.05, 0.7, thick));
            liquid = mix(liquid, bright, focus * 0.75);
            emis += liquid * (0.5 + 0.45 * uGlow * thick);
            emis += vec3(1.0, 0.95, 0.88) * smoothstep(0.2, 0.03, nv) * 0.22;
          } else if (special == 3) {
            // Clear glass: the table and the light behind show through.
            emis += mix(uTint2 * 0.72, vec3(0.5, 0.56, 0.52), smoothstep(0.5, 0.05, nv));
          } else if (special == 4) {
            float thick = pow(nv, 0.6);
            vec3 deep = col * vec3(0.55, 0.3, 0.06);
            vec3 glow = mix(col, vec3(1.0, 0.82, 0.36), 0.28);
            vec2 away = -Lk.xy;
            float focus = pow(saturate(dot(normalize(normal.xy + 1e-4), normalize(away + 1e-4)) * 0.5 + 0.5), 2.0);
            emis += mix(deep, glow, thick) * (0.42 + 0.6 * thick + focus * 0.3);
          }
          if (glitter > 0.0) {
            vec3 gq = lp * glitterFreq + seed * 13.0;
            vec3 gi = floor(gq);
            vec3 gh = pH3(gi);
            float gd = length(fract(gq) - 0.5 - (gh - 0.5) * 0.5);
            vec3 gn = normalize(normal + (gh * 2.0 - 1.0) * 0.7);
            float gs = pow(saturate(dot(reflect(-V, gn), Lk)), 36.0);
            float g = step(1.0 - glitterDensity, gh.z) * smoothstep(0.24, 0.04, gd) * gs;
            emis += vec3(1.0, 0.96, 0.9) * g * glitter * 7.0;
          }
          totalEmissiveRadiance += emis;
        }`,
      )
      .replace(
        "#include <lights_physical_fragment>",
        /* glsl */ `#include <lights_physical_fragment>
        material.clearcoat = saturate(coat);
        material.clearcoatRoughness = min(max(coatRough, 0.0525) + geometryRoughness, 1.0);
        material.sheenColor = sheen;
        material.sheenRoughness = clamp(sheenRough, 0.07, 1.0);`,
      );
  };
  material.customProgramCacheKey = () => `produce-${kinds.join(".")}`;
  return material;
}

// ----- The twelve food models ----------------------------------------------------

export interface FoodModel {
  group: THREE.Group;
  /** Camera direction around the model, radians: azimuth from +Z towards +X, then elevation. */
  azimuth: number;
  elevation: number;
  /** How much of the frame the model fills. */
  fill: number;
  /** Scales the studio lights, for foods that should glow against a dimmer set. */
  light: number;
  /** Soft halos drawn behind the model for things that glow. */
  halos: { color: THREE.ColorRepresentation; size: number; position: THREE.Vector3; strength: number }[];
  dispose(): void;
}

interface Piece {
  b: ProduceBuilder;
  /** Rotation applied before the piece is set down on the table. */
  rotation?: THREE.Euler;
  x?: number;
  z?: number;
  /** Height of its lowest point above the table. */
  lift?: number;
}

interface View {
  azimuth: number;
  elevation: number;
  fill?: number;
  light?: number;
}

/**
 * Food materials live for the whole session: they are tiny, and keeping them
 * keeps their compiled programs, which are the slow part of an icon.
 */
const produceMaterials = new Map<string, THREE.MeshPhysicalMaterial>();

function produceMaterialFor(kinds: Set<number>, options: ProduceOptions): THREE.MeshPhysicalMaterial {
  const key = `${[...kinds].sort((a, b) => a - b).join(".")}|${String(options.tint ?? "")}|${String(options.tint2 ?? "")}|${options.glow ?? 1}`;
  let material = produceMaterials.get(key);
  if (!material) {
    material = makeProduceMaterial(kinds, options);
    produceMaterials.set(key, material);
  }
  return material;
}

/** Builds each piece as a mesh, sets it down on the table and shares one material. */
function assemble(pieces: Piece[], options: ProduceOptions, view: View, halos: FoodModel["halos"] = []): FoodModel {
  const kinds = new Set<number>();
  for (const piece of pieces) for (const kind of piece.b.kinds) kinds.add(kind);
  const material = produceMaterialFor(kinds, options);
  const group = new THREE.Group();
  const geometries: THREE.BufferGeometry[] = [];
  const v = new THREE.Vector3();
  for (const piece of pieces) {
    const geometry = piece.b.build();
    geometries.push(geometry);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    if (piece.rotation) mesh.rotation.copy(piece.rotation);
    mesh.updateMatrix();
    const position = geometry.attributes.position as THREE.BufferAttribute;
    let minY = Infinity;
    for (let i = 0; i < position.count; i++) {
      v.fromBufferAttribute(position, i).applyMatrix4(mesh.matrix);
      if (v.y < minY) minY = v.y;
    }
    mesh.position.set(piece.x ?? 0, -minY + (piece.lift ?? 0), piece.z ?? 0);
    group.add(mesh);
  }
  return {
    group,
    azimuth: view.azimuth,
    elevation: view.elevation,
    fill: view.fill ?? 0.86,
    light: view.light ?? 1,
    halos,
    dispose() {
      for (const geometry of geometries) geometry.dispose();
    },
  };
}

/** A rotation taking local +Y to `y` and local +Z as close as possible to `z`. */
function orient(y: THREE.Vector3, z: THREE.Vector3): THREE.Euler {
  const Y = y.clone().normalize();
  const Z = z.clone().addScaledVector(Y, -z.dot(Y)).normalize();
  const X = new THREE.Vector3().crossVectors(Y, Z);
  return new THREE.Euler().setFromRotationMatrix(new THREE.Matrix4().makeBasis(X, Y, Z));
}

/** A frame whose columns are the given axes, at a position. */
function frameMatrix(position: THREE.Vector3, x: THREE.Vector3, y: THREE.Vector3, z: THREE.Vector3): THREE.Matrix4 {
  return new THREE.Matrix4().makeBasis(x, y, z).setPosition(position);
}

/** A leaf blade: base at the origin, tip at +Y, face towards +Z. uv: across, along. */
function leafBlade(rand: () => number, o: { width?: number; fold?: number; droop?: number; wave?: number; tip?: number; round?: number; serrate?: number; nu?: number; nv?: number } = {}): THREE.BufferGeometry {
  const width = o.width ?? 0.45;
  const fold = o.fold ?? 0.12;
  const droop = o.droop ?? 0.15;
  const wave = o.wave ?? 0;
  const tip = o.tip ?? 1.4;
  const round = o.round ?? 0.6;
  const serrate = o.serrate ?? 0;
  const phase = rand() * 10;
  return surface((u, v, out) => {
    const across = u * 2 - 1;
    let outline = Math.pow(Math.sin(Math.PI * Math.min(1, Math.pow(v, 0.9))), round) * Math.pow(Math.max(0, 1 - v), 0.12 * tip);
    if (serrate > 0) outline *= 1 - serrate * Math.pow(Math.abs(Math.sin(v * 40 + phase)), 6);
    const half = (width / 2) * outline;
    const x = across * half;
    const ripple = wave * Math.sin(v * 22 + phase + across * 2) * Math.abs(across) * half;
    const z = -Math.abs(across) * half * fold * 2 - droop * v * v + ripple;
    out.set(x, v, z);
  }, o.nu ?? 12, o.nv ?? 26);
}

/** A unit sphere with the parameter running from the bottom pole to the top. */
function blob(nu: number, nv: number, radius: (x: number, y: number, z: number) => number, squash = 1): THREE.BufferGeometry {
  return surface((u, v, out) => {
    const theta = u * TAU;
    const phi = (1 - v) * Math.PI;
    const x = Math.sin(phi) * Math.cos(theta);
    const y = Math.cos(phi);
    const z = -Math.sin(phi) * Math.sin(theta);
    const r = radius(x, y, z);
    out.set(x * r, y * r * squash, z * r);
  }, nu, nv);
}

/** Finds the parameter of a profile at a height, for cut faces. */
function profileRadiusAt(profile: (v: number) => [number, number], y: number): number {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 20; i++) {
    const m = (lo + hi) / 2;
    if (profile(m)[1] < y) lo = m;
    else hi = m;
  }
  return Math.max(1e-4, profile((lo + hi) / 2)[0]);
}

const UP = new THREE.Vector3(0, 1, 0);
const vec = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

// --- 0: Acorn ------------------------------------------------------------------

function acornModel(): FoodModel {
  const b = new ProduceBuilder();
  const rand = rng(17);
  const nutProfile = spline([[0, 0], [0.02, 0.01], [0.045, 0.035], [0.12, 0.11], [0.215, 0.25], [0.282, 0.4], [0.312, 0.54], [0.31, 0.64], [0.28, 0.72], [0.17, 0.79], [0, 0.81]]);
  const tipColor = linear("#3d2412");
  const body = linear("#70411b");
  const band = linear("#b89458");
  b.add(lathe(nutProfile, 60, 44, (angle, v) => 0.01 * Math.sin(angle * 3 + 1.3) * Math.sin(v * Math.PI)), null, (_x, y) => tipColor.clone().lerp(body, smooth(0.0, 0.16, y)).lerp(band, smooth(0.44, 0.58, y)), [SURF.nut, 0.3, 0, 0]);

  // The cup, dark where the scales part, then rows of overlapping scales.
  const capProfile = spline([[0.29, 0.6], [0.322, 0.565], [0.348, 0.568], [0.366, 0.605], [0.36, 0.69], [0.31, 0.775], [0.205, 0.845], [0.085, 0.88], [0, 0.886]]);
  b.add(lathe(capProfile, 48, 24), null, linear("#5b4630"), [SURF.cupScale, 0.7, 0, 0]);
  const tile = surface((u, v, out) => {
    const across = u * 2 - 1;
    const w = 0.5 * Math.pow(Math.sin(Math.PI * (0.1 + 0.9 * v)), 0.45) * (1 - Math.pow(v, 3) * 0.55);
    out.set(across * w, v, 0.22 * (1 - across * across) * Math.pow(1 - v, 0.35));
  }, 6, 8);
  const rows = 12;
  const p = new THREE.Vector3();
  const q = new THREE.Vector3();
  for (let row = 0; row < rows; row++) {
    const f = row / (rows - 1);
    const vRow = lerp(0.12, 0.86, f);
    const [r] = capProfile(vRow);
    const count = Math.max(6, Math.round((TAU * r) / 0.038));
    for (let i = 0; i < count; i++) {
      const angle = ((i + (row % 2) * 0.5) / count) * TAU + (rand() - 0.5) * 0.12;
      const [rr, y] = capProfile(vRow);
      const [r2, y2] = capProfile(vRow - 0.03);
      p.set(Math.cos(angle) * rr, y, -Math.sin(angle) * rr);
      q.set(Math.cos(angle) * r2, y2, -Math.sin(angle) * r2);
      const down = q.clone().sub(p).normalize();
      const around = vec(-Math.sin(angle), 0, -Math.cos(angle));
      const out = new THREE.Vector3().crossVectors(around, down).normalize();
      if (out.dot(vec(p.x, 0, p.z)) < 0) out.negate();
      const tilted = down.clone().addScaledVector(out, 0.32 + rand() * 0.12).normalize();
      const normal = new THREE.Vector3().crossVectors(around, tilted).normalize();
      if (normal.dot(out) < 0) normal.negate();
      const length = lerp(0.085, 0.055, f) * (0.85 + rand() * 0.3);
      const width = ((TAU * rr) / count) * 1.6;
      const base = p.clone().addScaledVector(down, -length * 0.4).addScaledVector(out, 0.003);
      const color = linear("#6a5538").lerp(linear("#a8916c"), rand() * 0.85).multiplyScalar(lerp(0.82, 1.06, f));
      b.add(tile.clone(), frameMatrix(base, around.clone().multiplyScalar(width), tilted.clone().multiplyScalar(length), normal.clone().multiplyScalar(length * 0.55)), color, [SURF.cupScale, rand(), 0, 0]);
    }
  }
  tile.dispose();
  // A short woody stalk with a fresh broken end.
  const stalk = new THREE.CatmullRomCurve3([vec(0, 0.86, 0), vec(0.015, 0.93, 0.004), vec(0.045, 0.99, 0.01), vec(0.07, 1.025, 0.014)]);
  b.add(tube(stalk, (t) => lerp(0.034, 0.026, t), 10, 10), null, linear("#4f3a24"), [SURF.bark, 0.2, 1, 0]);
  b.add(surface((u, v, out) => {
    const a = u * TAU;
    out.set(Math.cos(a) * 0.024 * v, 0, -Math.sin(a) * 0.024 * v);
  }, 10, 2), placeAlong(stalk.getPointAt(1), stalk.getTangentAt(1)), linear("#c4a674"), [SURF.plain, 0, 0.8, 0]);
  // Standing, leaning a little: the classic silhouette reads at the smallest sizes.
  return assemble([{ b, rotation: orient(vec(-0.34, 0.93, 0.12), vec(0.1, 0, 1)) }], {}, { azimuth: 0.45, elevation: 0.3, fill: 0.86 });
}

// --- 1: Sunwheat ------------------------------------------------------------------

function wheatModel(): FoodModel {
  const b = new ProduceBuilder();
  const rand = rng(5);
  const grain = lathe(spline([[0, 0], [0.2, 0.1], [0.4, 0.34], [0.44, 0.58], [0.33, 0.82], [0.12, 0.96], [0, 1]]), 10, 10);
  const awn = lathe((v) => [lerp(1, 0.12, v), v], 4, 6);
  const golds = [linear("#c98f34"), linear("#d8a547"), linear("#bb8128"), linear("#d29a3c")];
  const tie = vec(0, 0.32, 0);
  const ears = [
    { lean: vec(-0.55, 1, 0.06), spin: 0.4, len: 0.5 },
    { lean: vec(-0.25, 1, -0.12), spin: 1.4, len: 0.56 },
    { lean: vec(0.02, 1, 0.1), spin: 2.3, len: 0.6 },
    { lean: vec(0.28, 1, -0.08), spin: 3.1, len: 0.55 },
    { lean: vec(0.56, 1, 0.08), spin: 4.0, len: 0.5 },
  ];
  ears.forEach((ear, index) => {
    const dir = ear.lean.clone().normalize();
    const stalkTop = tie.clone().addScaledVector(dir, 0.44 + (index % 2) * 0.05);
    const below = tie.clone().addScaledVector(dir, -0.34);
    below.y = 0.005;
    const stalk = new THREE.CatmullRomCurve3([below, tie.clone().addScaledVector(dir, -0.1), tie.clone().addScaledVector(dir, 0.2), stalkTop]);
    b.add(tube(stalk, (t) => 0.013 + 0.003 * Math.exp(-Math.pow((t - 0.62) / 0.03, 2)), 7, 30), null, linear("#c29a4c"), [SURF.straw, rand(), 0, 0]);
    // The ear: a gently nodding rachis with spikelets in two rows.
    const bend = vec(dir.x * 0.3, 0, dir.z * 0.3 + 0.06);
    const rachis = new THREE.CatmullRomCurve3([stalkTop, stalkTop.clone().addScaledVector(dir, ear.len * 0.5).addScaledVector(bend, 0.1), stalkTop.clone().addScaledVector(dir, ear.len).addScaledVector(bend, 0.3)]);
    b.add(tube(rachis, () => 0.009, 5, 12), null, linear("#b1873a"), [SURF.straw, rand(), 0, 0]);
    const count = 17;
    for (let i = 0; i < count; i++) {
      const t = 0.03 + (i / (count - 1)) * 0.93;
      const at = rachis.getPointAt(t);
      const up = rachis.getTangentAt(t);
      const sideBase = vec(Math.cos(ear.spin), 0, Math.sin(ear.spin));
      const side = sideBase.clone().addScaledVector(up, -sideBase.dot(up)).normalize();
      const face = new THREE.Vector3().crossVectors(up, side).normalize();
      const s = i % 2 ? 1 : -1;
      const size = lerp(1.05, 0.66, Math.pow(t, 1.5)) * (0.92 + rand() * 0.14);
      for (const floret of [-1, 0, 1]) {
        if (floret === 0 && t > 0.75) continue;
        const out = up.clone().multiplyScalar(0.84).addScaledVector(side, s * (floret === 0 ? 0.3 : 0.48)).addScaledVector(face, floret * 0.26).normalize();
        const length = 0.105 * size * (floret === 0 ? 0.9 : 1);
        const width = 0.07 * size;
        const base = at.clone().addScaledVector(side, s * 0.012).addScaledVector(face, floret * 0.014);
        const right = new THREE.Vector3().crossVectors(out, face).normalize();
        const facing = new THREE.Vector3().crossVectors(right, out).normalize();
        const color = golds[Math.floor(rand() * golds.length)].clone().multiplyScalar(0.9 + rand() * 0.2);
        b.add(grain.clone(), frameMatrix(base, right.clone().multiplyScalar(width), out.clone().multiplyScalar(length), facing.clone().multiplyScalar(width * 0.82)), color, [SURF.grain, rand(), 0, 0]);
        // The awn carries on from the grain's tip, spreading slightly.
        const tip = base.clone().addScaledVector(out, length * 0.92);
        const awnDir = out.clone().addScaledVector(up, 1.1).addScaledVector(side, s * 0.16).addScaledVector(face, floret * 0.1).normalize();
        const awnLength = lerp(0.36, 0.18, t) * (0.8 + rand() * 0.4);
        const awnR = 0.003;
        const ax = new THREE.Vector3().crossVectors(awnDir, face).normalize();
        const az = new THREE.Vector3().crossVectors(ax, awnDir).normalize();
        b.add(awn.clone(), frameMatrix(tip, ax.multiplyScalar(awnR), awnDir.clone().multiplyScalar(awnLength), az.multiplyScalar(awnR)), linear("#e6c272").multiplyScalar(0.88 + rand() * 0.18), [SURF.awn, rand(), 0, 0]);
      }
    }
    if (index % 2 === 0) {
      const leafBase = tie.clone().addScaledVector(dir, 0.06 + index * 0.03);
      const leafDir = dir.clone().addScaledVector(vec(Math.cos(ear.spin + 1.4), 0.25, Math.sin(ear.spin + 1.4)), 0.9).normalize();
      b.add(leafBlade(rand, { width: 0.07, fold: 0.35, droop: 0.12, round: 0.3, tip: 2 }), placeAlong(leafBase, leafDir, ear.spin, 0.45, 0.45, 0.45), linear("#c49d56"), [SURF.leaf, rand(), 0, 0]);
    }
  });
  grain.dispose();
  awn.dispose();
  const twine = new THREE.CatmullRomCurve3(Array.from({ length: 19 }, (_, i) => {
    const a = (i / 18) * TAU * 2.9;
    return vec(Math.cos(a) * 0.046, 0.29 + i * 0.0032, Math.sin(a) * 0.046);
  }));
  b.add(tube(twine, () => 0.008, 6, 90), null, linear("#946c42"), [SURF.twine, 0.4, 0, 0]);
  return assemble([{ b }], {}, { azimuth: 0.2, elevation: 0.24, fill: 0.9 });
}

// --- 2: Dewbean ---------------------------------------------------------------

function podShape(length: number, bow: number) {
  const centre = (t: number, out: THREE.Vector3) => out.set((t - 0.5) * length, 0, -bow * Math.sin(Math.PI * t) + bow * 0.2 * Math.sin(TAU * t));
  const peas = 5;
  const profile = (t: number) => Math.pow(Math.sin(Math.PI * Math.min(1, Math.max(0, t * 1.01))), 0.42);
  const lumps = (t: number) => 1 + 0.2 * Math.pow(Math.abs(Math.sin(Math.PI * peas * (t * 1.08 - 0.04))), 1.4) * smooth(0.04, 0.14, t) * smooth(0.96, 0.86, t);
  const a = new THREE.Vector3();
  const c = new THREE.Vector3();
  const frame = (t: number) => {
    centre(Math.max(0, t - 0.002), a);
    centre(Math.min(1, t + 0.002), c);
    const tangent = c.sub(a).normalize();
    return { tangent: tangent.clone(), side: vec(-tangent.z, 0, tangent.x) };
  };
  return { centre, profile, lumps, frame, peas };
}

function beanModel(): FoodModel {
  const rand = rng(9);
  const green = linear("#4f8f31");
  const light = linear("#76aa45");
  const drop = blob(16, 12, () => 1, 0.6);
  const addDew = (b: ProduceBuilder, at: THREE.Vector3, normal: THREE.Vector3, radius: number, under: THREE.Color) => {
    b.add(drop.clone(), placeAlong(at.clone().addScaledVector(normal, radius * 0.1), normal, rand() * 6, radius, radius, radius), under.clone().multiplyScalar(1.25), [SURF.water, rand(), 0, 0]);
  };

  // A closed pod, lying on its flat side.
  const closed = new ProduceBuilder();
  const shape = podShape(1.08, 0.13);
  const point = new THREE.Vector3();
  const podAt = (u: number, v: number, out: THREE.Vector3, w = 0.12, th = 0.075) => {
    const t = Math.min(1, Math.max(0, v));
    shape.centre(t, out);
    const { side } = shape.frame(t);
    const a = u * TAU;
    const prof = shape.profile(t);
    const lump = shape.lumps(t);
    out.addScaledVector(side, Math.cos(a) * w * prof * (1 + (lump - 1) * 0.35)).addScaledVector(UP, Math.sin(a) * th * prof * lump);
    // A little hooked beak at the far end.
    out.z -= Math.pow(smooth(0.9, 1, t), 2) * 0.03;
    return out;
  };
  closed.add(surface((u, v, out) => { podAt(u, v, out); }, 30, 72), null, (_x, _y, _z, u, v) => green.clone().lerp(light, 0.35 + 0.35 * Math.sin(v * Math.PI) - 0.15 * Math.cos(u * TAU)), [SURF.pod, 0.2, 0, 0]);
  for (let i = 0; i < 13; i++) {
    const v = 0.1 + rand() * 0.8;
    const u = 0.16 + rand() * 0.18;
    podAt(u, v, point);
    const n = point.clone();
    shape.centre(v, n);
    const normal = point.clone().sub(n).normalize();
    addDew(closed, point, normal, 0.012 + Math.pow(rand(), 2) * 0.03, green);
  }
  addStemEnd(closed, rand, (t, out) => podAt(0.25, t, out), shape.centre(0, new THREE.Vector3()), shape.frame(0.0).tangent.clone().negate());

  // An open valve with its peas, lying in front.
  const open = new ProduceBuilder();
  const shape2 = podShape(1.0, 0.1);
  const valveAt = (u: number, v: number, out: THREE.Vector3, inset: number) => {
    const t = Math.min(1, Math.max(0, v));
    shape2.centre(t, out);
    const { side } = shape2.frame(t);
    const a = Math.PI + u * Math.PI;
    const prof = shape2.profile(t);
    out.addScaledVector(side, Math.cos(a) * (0.14 - inset) * prof).addScaledVector(UP, Math.sin(a) * (0.08 - inset) * prof + 0.03 * prof * Math.pow(Math.sin(u * Math.PI), 0.5));
    return out;
  };
  open.add(surface((u, v, out) => { valveAt(u, v, out, 0); }, 22, 64), null, (_x, _y, _z, _u, v) => green.clone().lerp(light, 0.3 + 0.4 * Math.sin(v * Math.PI)), [SURF.pod, 0.6, 0, 0]);
  open.add(surface((u, v, out) => { valveAt(u, v, out, 0.008); }, 22, 64), null, linear("#c2dc96"), [SURF.podInner, 0.3, 0, 0]);
  const pea = blob(22, 16, (x, _y, z) => 1 + 0.03 * Math.sin(x * 5 + z * 4), 0.86);
  for (let i = 0; i < shape2.peas; i++) {
    const t = ((i + 0.5) / shape2.peas) * 0.86 + 0.07;
    const at = shape2.centre(t, new THREE.Vector3());
    const r = 0.074 * shape2.profile(t) * (0.92 + rand() * 0.12);
    at.y += r * 0.05 - 0.01;
    const color = linear("#7fbd47").multiplyScalar(0.92 + rand() * 0.12);
    open.add(pea.clone(), placeAlong(at, vec(0.1, 1, 0.05), rand() * 6, r, r, r), color, [SURF.bean, rand(), 0, 0]);
    if (i % 2 === 0) addDew(open, at.clone().add(vec((rand() - 0.5) * r * 0.6, r * 0.82, (rand() - 0.5) * r * 0.5)), UP, 0.012 + rand() * 0.008, color);
  }
  pea.dispose();
  for (let i = 0; i < 6; i++) {
    const v = 0.12 + rand() * 0.76;
    const u = rand() < 0.5 ? 0.04 + rand() * 0.08 : 0.88 + rand() * 0.08;
    valveAt(u, v, point, 0);
    const n = shape2.centre(v, new THREE.Vector3());
    const normal = point.clone().sub(n).normalize();
    addDew(open, point, normal, 0.012 + rand() * 0.016, green);
  }
  addStemEnd(open, rand, (t, out) => valveAt(0.5, t, out, 0), shape2.centre(0, new THREE.Vector3()), shape2.frame(0.0).tangent.clone().negate());
  drop.dispose();
  return assemble([
    { b: closed, rotation: new THREE.Euler(0, 0.42, 0.04), x: -0.1, z: -0.2 },
    { b: open, rotation: new THREE.Euler(0, -0.28, 0), x: 0.08, z: 0.2 },
  ], {}, { azimuth: 0.1, elevation: 0.62, fill: 0.9 });
}

/** A calyx of small sepals and a short stalk where a pod joins its plant. */
function addStemEnd(b: ProduceBuilder, rand: () => number, _surfaceAt: (t: number, out: THREE.Vector3) => void, start: THREE.Vector3, back: THREE.Vector3) {
  const stalk = new THREE.CatmullRomCurve3([start.clone().addScaledVector(back, -0.03), start.clone().addScaledVector(back, 0.05), start.clone().addScaledVector(back, 0.11).add(vec(0, 0.02, 0.02))]);
  b.add(tube(stalk, (t) => lerp(0.02, 0.012, t), 8, 10), null, linear("#4a8430"), [SURF.pod, rand(), 0, 0]);
  for (let s = 0; s < 5; s++) {
    const a = (s / 5) * TAU + rand() * 0.3;
    const around = vec(0, Math.cos(a), Math.sin(a));
    const dir = back.clone().multiplyScalar(-0.65).addScaledVector(around, 0.75).normalize();
    b.add(leafBlade(rand, { width: 0.5, fold: 0.1, droop: -0.12 }), placeAlong(start.clone().addScaledVector(back, 0.012), dir, rand() * 6, 0.075, 0.075, 0.075), linear("#457f2a"), [SURF.leaf, rand(), 0, 0]);
  }
}

// --- 3: Emberroot -------------------------------------------------------------

function rootModel(): FoodModel {
  const b = new ProduceBuilder();
  const rand = rng(23);
  const profile = spline([[0.006, 0], [0.03, 0.08], [0.07, 0.28], [0.12, 0.5], [0.165, 0.7], [0.19, 0.84], [0.186, 0.92], [0.15, 0.98], [0.08, 1.012], [0, 1.022]]);
  const tipRed = linear("#4a0606");
  const red = linear("#8a0f0b");
  const orange = linear("#b52a12");
  // Lay the root down: tip to the lower right, crown to the upper left.
  const axis = vec(-0.86, 0.16, -0.48).normalize();
  const lay = new THREE.Matrix4().makeRotationFromEuler(orient(axis, vec(0, 1, 0.2)));
  const root = surface((u, v, out) => {
    const [r0, y] = profile(v);
    const a = u * TAU;
    const ring = Math.pow(Math.max(0, Math.sin(y * 70 + Math.sin(a * 2) * 0.6)), 8) * 0.035;
    const r = r0 * (1 - ring + 0.025 * Math.sin(a * 3 + y * 7));
    const bend = 0.06 * Math.pow(Math.max(0, 1 - y), 2.2);
    out.set(Math.cos(a) * r + bend, y, -Math.sin(a) * r);
  }, 44, 70);
  b.add(root, lay, (_x, y) => tipRed.clone().lerp(red, smooth(0, 0.45, y)).lerp(orange, smooth(0.62, 0.95, y) * 0.5), [SURF.root, 0.4, 0, 0]);
  for (let i = 0; i < 10; i++) {
    const v = 0.06 + rand() * 0.55;
    const [r, y] = profile(v);
    const a = rand() * TAU;
    const start = vec(Math.cos(a) * r * 0.96 + 0.06 * Math.pow(Math.max(0, 1 - y), 2.2), y, -Math.sin(a) * r * 0.96);
    const outward = vec(Math.cos(a), -0.7, -Math.sin(a)).normalize();
    const length = 0.035 + rand() * 0.05;
    const hair = new THREE.CatmullRomCurve3([start, start.clone().addScaledVector(outward, length * 0.5).add(vec(0, -0.008, 0)), start.clone().addScaledVector(outward, length).add(vec(0, -0.02, 0))]);
    b.add(tube(hair, (t) => lerp(0.0028, 0.0008, t), 4, 6), lay, linear("#6d1610"), [SURF.root, rand(), 0, 0]);
  }
  // Leaf stalks arch up from the crown, with glossy red-veined leaves.
  const crown = vec(0, 1.0, 0).applyMatrix4(lay);
  const across = new THREE.Vector3().crossVectors(axis, UP).normalize();
  const stalks = 6;
  for (let i = 0; i < stalks; i++) {
    const f = i / (stalks - 1) - 0.5;
    const dir = axis.clone().multiplyScalar(0.55).addScaledVector(UP, 0.75).addScaledVector(across, f * 1.4).normalize();
    const length = 0.36 + rand() * 0.16 - Math.abs(f) * 0.1;
    const p0 = crown.clone().addScaledVector(across, f * 0.06);
    const p1 = p0.clone().addScaledVector(dir, length * 0.55);
    const p2 = p0.clone().addScaledVector(dir, length).addScaledVector(axis, 0.06).add(vec(0, -0.03, 0));
    const stalk = new THREE.CatmullRomCurve3([p0, p1, p2]);
    b.add(tube(stalk, (t) => lerp(0.022, 0.012, t), 8, 14), null, (_x, _y, _z, _u, v) => linear("#6e0f0c").lerp(linear("#9c2618"), v), [SURF.bark, rand(), 0, 0]);
    if (i !== 2) {
      const leafDir = stalk.getTangentAt(1).clone().addScaledVector(axis, 0.3).normalize();
      const size = 0.36 + rand() * 0.12;
      b.add(leafBlade(rand, { width: 0.6, fold: 0.1, droop: 0.14, wave: 0.14, round: 0.55 }), placeAlong(p2, leafDir, Math.atan2(across.x, across.z) + (rand() - 0.5) * 0.8, size, size, size), linear("#2d5520").lerp(linear("#3f6e28"), rand()), [SURF.leaf, rand(), 1, 0]);
    }
  }
  return assemble([{ b }], { glow: 1 }, { azimuth: 0.3, elevation: 0.42, fill: 0.82 }, [{ color: "#ff4a12", size: 0.62, position: vec(0.0, 0.12, 0.0), strength: 0.14 }]);
}

// --- 4: Frostberry ------------------------------------------------------------

function frostberryModel(): FoodModel {
  const b = new ProduceBuilder();
  const rand = rng(31);
  const skin = linear("#1a2048");
  const placements: [number, number, number, number][] = [
    [-0.27, 0, 0.12, 0.2],
    [0.03, 0, 0.28, 0.215],
    [0.31, 0, 0.08, 0.2],
    [0.14, 0, -0.23, 0.205],
    [-0.21, 0, -0.21, 0.19],
    [-0.04, 0.27, 0.02, 0.215],
    [0.2, 0.25, 0.08, 0.19],
    [-0.16, 0.26, 0.14, 0.18],
  ];
  const sepal = surface((u, v, out) => {
    const across = u * 2 - 1;
    const w = 0.5 * Math.pow(1 - v, 1.2) * Math.pow(Math.sin(Math.min(1, v * 3 + 0.25) * Math.PI * 0.5), 0.5);
    out.set(across * w, v, -v * v * 0.3 + (1 - across * across) * 0.06);
  }, 4, 6);
  for (const [x, y, z, r] of placements) {
    const wobble = rand() * 10;
    const g = blob(48, 34, (bx, by, bz) => 1 - smooth(0.86, 0.985, by) * 0.2 + 0.016 * Math.sin(bx * 3 + wobble) * Math.sin(bz * 2.6 + wobble), 0.86);
    const up = vec(rand() - 0.5, 1.2, rand() - 0.5).normalize();
    if (y === 0) up.add(vec(x, 0, z).normalize().multiplyScalar(0.8)).normalize();
    const m = placeAlong(vec(x, y + r * 0.86, z), up, rand() * 6, r, r, r);
    const tone = skin.clone().multiplyScalar(0.85 + rand() * 0.3);
    b.add(g, m, tone, [SURF.berry, rand(), 0, 0]);
    for (let s = 0; s < 5; s++) {
      const a = (s / 5) * TAU + rand() * 0.3;
      const local = vec(Math.cos(a) * 0.12, 0.79, -Math.sin(a) * 0.12);
      const dir = vec(Math.cos(a) * 0.55, 1, -Math.sin(a) * 0.55).normalize();
      b.add(sepal.clone(), m.clone().multiply(placeAlong(local, dir, -a + Math.PI / 2, 0.15, 0.13, 0.15)), skin.clone().multiplyScalar(0.9), [SURF.berry, rand(), 1, 0]);
    }
  }
  sepal.dispose();
  for (const [a, x, z, s] of [[2.5, -0.15, -0.05, 0.62], [-0.4, 0.18, -0.12, 0.55]] as const) {
    const dir = vec(Math.cos(a), 0.12, -Math.sin(a)).normalize();
    b.add(leafBlade(rand, { width: 0.46, fold: 0.08, droop: 0.04, round: 0.7 }), placeAlong(vec(x, 0.0, z), dir, Math.PI / 2 + 0.05, s, s, s), linear("#3a6636"), [SURF.leaf, rand(), 0, 0.7]);
  }
  return assemble([{ b }], { tint2: "#d4e4f2" }, { azimuth: 0.3, elevation: 0.5, fill: 0.88 });
}

// --- 5: Moonmelon ---------------------------------------------------------------

function moonmelonModel(): FoodModel {
  const rand = rng(41);
  const R = 0.5;
  const rindColor = linear("#84928c");
  const melonRadius = (a: number) => 1 - 0.02 * smooth(0.9, 1, Math.cos(a * 5 + 0.4)) + 0.012 * Math.sin(a * 3);
  // The whole melon.
  const whole = new ProduceBuilder();
  whole.add(blob(72, 52, (x, _y, z) => melonRadius(Math.atan2(z, x)), 0.9), new THREE.Matrix4().makeScale(R, R, R), rindColor, [SURF.rind, 0.3, 0, 0]);
  const top = vec(0, R * 0.9 - 0.012, 0);
  const stub = new THREE.CatmullRomCurve3([top.clone().add(vec(0, -0.03, 0)), top.clone().add(vec(0.02, 0.04, 0)), top.clone().add(vec(0.06, 0.075, 0.01))]);
  whole.add(tube(stub, (t) => lerp(0.035, 0.025, t), 8, 8), null, linear("#66633f"), [SURF.bark, 0.3, 1, 0]);
  const curl = new THREE.CatmullRomCurve3(Array.from({ length: 14 }, (_, i) => {
    const t = i / 13;
    const a = t * TAU * 1.6;
    return top.clone().add(vec(0.06 + t * 0.12 + Math.cos(a) * 0.04, 0.075 + Math.sin(a) * 0.04 - t * 0.05, 0.01 + Math.sin(a) * 0.02));
  }));
  whole.add(tube(curl, (t) => lerp(0.007, 0.003, t), 5, 30), null, linear("#77783f"), [SURF.bark, 0.6, 0, 0]);

  // A crescent slice lying on one cut face, the other face turned up to the camera.
  const slice = new ProduceBuilder();
  const span = 0.85;
  const cavity = (phi: number) => 1 / Math.sqrt(Math.pow(Math.sin(phi) / 0.44, 2) + Math.pow(Math.cos(phi) / 0.7, 2));
  const sphere = (r: number, theta: number, phi: number, out: THREE.Vector3) => out.set(Math.sin(phi) * Math.cos(theta) * r, Math.cos(phi) * r * 0.9, -Math.sin(phi) * Math.sin(theta) * r);
  const scale = new THREE.Matrix4().makeScale(R * 0.97, R * 0.97, R * 0.97);
  slice.add(surface((u, v, out) => {
    const theta = u * span;
    const phi = (1 - v) * Math.PI;
    sphere(melonRadius(theta), theta, phi, out);
  }, 18, 52), scale, rindColor, [SURF.rind, 0.3, 0, 0]);
  slice.add(surface((u, v, out) => {
    const theta = u * span;
    const phi = (1 - v) * Math.PI;
    sphere(cavity(phi), theta, phi, out);
  }, 14, 44), scale, linear("#d9d3a4"), [SURF.flesh, 0.5, 0, 0], (x, y) => [x * 3, y * 3, 0.5]);
  for (const theta of [0, span]) {
    slice.add(surface((u, v, out) => {
      const phi = (1 - v) * Math.PI;
      sphere(lerp(cavity(phi), melonRadius(theta), u), theta, phi, out);
    }, 20, 52), scale, linear("#e2e9cc"), [SURF.flesh, 0.4 + theta, 0, 0], (x, y, z) => {
      const len = Math.max(1e-4, Math.hypot(x, y / 0.9, z));
      return [x * 3, y * 3, len / melonRadius(theta)];
    });
  }
  const seed = blob(10, 8, () => 1, 0.35);
  for (let i = 0; i < 10; i++) {
    const phi = 0.45 + rand() * 2.2;
    const theta = 0.08 + rand() * (span - 0.16);
    const p = sphere(cavity(phi) * 0.985, theta, phi, new THREE.Vector3());
    slice.add(seed.clone(), scale.clone().multiply(placeAlong(p, p.clone().negate(), rand() * 6, 0.05, 0.032, 0.024)), linear("#ece2b8"), [SURF.seed, rand(), 0, 0]);
  }
  seed.dispose();
  // Local +Z is the outward normal of the theta = 0 face: put that face on the table.
  const along = vec(0.92, 0, 0.38).normalize();
  const sliceRotation = new THREE.Euler().setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3().crossVectors(along, vec(0, -1, 0)), along, vec(0, -1, 0)));
  return assemble([
    { b: whole, x: -0.3, z: -0.24 },
    { b: slice, rotation: sliceRotation, x: 0.22, z: 0.34 },
  ], { tint: "#d9d1bb", tint2: "#a9cc80" }, { azimuth: 0.32, elevation: 0.5, fill: 0.84 });
}

// --- 6: Starfig ---------------------------------------------------------------

const FIG_PROFILE: [number, number][] = [[0, 0], [0.1, 0.012], [0.22, 0.055], [0.31, 0.13], [0.35, 0.24], [0.335, 0.36], [0.28, 0.5], [0.19, 0.64], [0.115, 0.76], [0.07, 0.85], [0.045, 0.9], [0, 0.92]];

function figModel(): FoodModel {
  const profile = spline(FIG_PROFILE);
  const purple = linear("#35122b");
  const plum = linear("#55203c");
  const neck = linear("#5b5630");
  const figColor = (_x: number, y: number) => purple.clone().lerp(plum, smooth(0.1, 0.42, y)).lerp(neck, smooth(0.56, 0.86, y));
  const ripple = (a: number, v: number) => 0.012 * Math.cos(a * 9) * Math.sin(v * Math.PI) + 0.02 * Math.sin(a * 2 + 1) * Math.sin(v * Math.PI);
  const stem = new THREE.CatmullRomCurve3([vec(0, 0.88, 0), vec(0.01, 0.96, 0), vec(0.04, 1.02, 0.01)]);
  const whole = new ProduceBuilder();
  whole.add(lathe(profile, 52, 52, ripple), null, figColor, [SURF.figSkin, 0.2, 0, 0]);
  whole.add(tube(stem, (t) => lerp(0.03, 0.022, t), 8, 8), null, linear("#5a5f30"), [SURF.bark, 0.3, 1, 0]);

  // Half a fig, cut through the middle, its face turned up to the camera.
  const half = new ProduceBuilder();
  half.add(lathe(profile, 30, 52, ripple, Math.PI, 0), null, figColor, [SURF.figSkin, 0.6, 0, 0]);
  half.add(surface((u, v, out) => {
    const [r, y] = profile(v);
    out.set((u * 2 - 1) * r * (1 + ripple(u < 0.5 ? Math.PI : 0, v)), y, 0);
  }, 48, 64), null, linear("#c86a5a"), [SURF.figFlesh, 0.4, 0.3, 0.2], (x, y) => [x, y, Math.min(1, Math.abs(x) / profileRadiusAt(profile, y))]);
  half.add(tube(stem, (t) => lerp(0.03, 0.022, t), 8, 8), null, linear("#5a5f30"), [SURF.bark, 0.7, 1, 0]);
  return assemble([
    { b: whole, rotation: new THREE.Euler(0.05, 0.4, 0.1), x: -0.27, z: -0.2 },
    { b: half, rotation: orient(vec(0.85, 0.1, -0.5), vec(0.12, 0.75, 0.62)), x: 0.22, z: 0.18 },
  ], { tint: "#35122b", glow: 1 }, { azimuth: 0.4, elevation: 0.5, fill: 0.88 });
}

// --- 7: Warmth Tonic --------------------------------------------------------------

function tonicModel(): FoodModel {
  const b = new ProduceBuilder();
  const rand = rng(61);
  const bottle = spline([[0, 0.0], [0.17, 0.0], [0.27, 0.025], [0.355, 0.1], [0.395, 0.24], [0.38, 0.39], [0.31, 0.52], [0.2, 0.61], [0.13, 0.67], [0.112, 0.74], [0.11, 0.88], [0.122, 0.91], [0.14, 0.93], [0.136, 0.958], [0.11, 0.966]]);
  b.add(lathe(bottle, 64, 72), null, linear("#ffffff"), [SURF.glass, 0, 0.88, 0]);
  b.add(lathe(spline([[0, 0.84], [0.096, 0.84], [0.1, 0.95], [0.11, 1.06], [0.106, 1.078], [0, 1.083]]), 32, 14), null, linear("#b08a5c"), [SURF.cork, 0.5, 0, 0]);
  const wrap = new THREE.CatmullRomCurve3(Array.from({ length: 24 }, (_, i) => {
    const a = (i / 23) * TAU * 2.0;
    return vec(Math.cos(a) * 0.123, 0.76 + i * 0.0018, -Math.sin(a) * 0.123);
  }));
  b.add(tube(wrap, () => 0.0085, 6, 100), null, linear("#9f774a"), [SURF.twine, 0.5, 0, 0]);
  const hang = new THREE.CatmullRomCurve3([vec(0.1, 0.78, 0.07), vec(0.2, 0.66, 0.17), vec(0.28, 0.53, 0.25)]);
  b.add(tube(hang, () => 0.0045, 5, 20), null, linear("#9f774a"), [SURF.twine, 0.2, 0, 0]);
  const tag = surface((u, v, out) => {
    const x = (u - 0.5) * 0.15;
    const y = -v * 0.2;
    out.set(x, y, 0.01 * Math.sin(v * 3) - 0.008 * Math.sin(u * Math.PI));
  }, 6, 8);
  b.add(tag, placeAlong(vec(0.29, 0.54, 0.28), vec(0.05, 1, 0.1), 0.65), linear("#e5d3ab"), [SURF.paper, rand(), 0, 0]);
  return assemble([{ b }], { tint: "#ff6a12", tint2: "#8a6a48", glow: 1 }, { azimuth: 0.15, elevation: 0.2, fill: 0.88 }, [{ color: "#ff8a30", size: 0.8, position: vec(0, 0.32, 0), strength: 0.2 }]);
}

// --- 8: Wild Egg ------------------------------------------------------------------

function wildEggModel(): FoodModel {
  const b = new ProduceBuilder();
  const rand = rng(71);
  const egg = eggGeometry().clone();
  const eggMatrix = new THREE.Matrix4().compose(vec(0.02, 0.05, 0), new THREE.Quaternion().setFromEuler(new THREE.Euler(0.12, 0, -0.18)), new THREE.Vector3(0.5, 0.5, 0.5));
  b.add(egg, eggMatrix, linear("#a6d2c6"), [SURF.shell, 0.4, 0, 0]);
  // A woven bowl of dry grass: strands wander round the rim, rise and dip,
  // and a few stray ends poke out.
  const straws = [linear("#b38a4d"), linear("#977240"), linear("#c8a467"), linear("#7c5e37"), linear("#a89870"), linear("#8d7a55")];
  const bowl = (r: number) => 0.015 + Math.pow(Math.max(0, r - 0.2), 1.25) * 0.62;
  for (let i = 0; i < 150; i++) {
    const a0 = rand() * TAU;
    const sweepA = (0.7 + rand() * 1.6) * (rand() < 0.5 ? 1 : -1);
    const r0 = 0.2 + Math.pow(rand(), 0.6) * 0.3;
    const r1 = Math.min(0.52, Math.max(0.18, r0 + (rand() - 0.5) * 0.18));
    const wobble = rand() * 6;
    const points = Array.from({ length: 8 }, (_, k) => {
      const t = k / 7;
      const a = a0 + t * sweepA;
      const r = lerp(r0, r1, t) + Math.sin(t * 9 + wobble) * 0.012;
      return vec(Math.cos(a) * r, bowl(r) + Math.sin(t * 7 + wobble) * 0.018 + rand() * 0.006, Math.sin(a) * r);
    });
    b.add(tube(new THREE.CatmullRomCurve3(points), () => 0.006 + rand() * 0.0045, 5, 20, 0.55), null, straws[i % straws.length].clone().multiplyScalar(0.8 + rand() * 0.36), [SURF.straw, rand(), 0, 0]);
  }
  for (let i = 0; i < 14; i++) {
    const a = rand() * TAU;
    const r = 0.42 + rand() * 0.08;
    const start = vec(Math.cos(a) * r, bowl(r), Math.sin(a) * r);
    const out = vec(Math.cos(a + (rand() - 0.5) * 1.2), 0.3 + rand() * 0.5, Math.sin(a + (rand() - 0.5) * 1.2)).normalize();
    const length = 0.08 + rand() * 0.12;
    const stray = new THREE.CatmullRomCurve3([start, start.clone().addScaledVector(out, length * 0.5).add(vec(0, 0.01, 0)), start.clone().addScaledVector(out, length).add(vec(0, -0.01, 0))]);
    b.add(tube(stray, (t) => lerp(0.0065, 0.004, t), 5, 10, 0.55), null, straws[i % straws.length].clone().multiplyScalar(0.9 + rand() * 0.25), [SURF.straw, rand(), 0, 0]);
  }
  return assemble([{ b }], { tint: "#5c3a1c" }, { azimuth: 0.3, elevation: 0.46, fill: 0.84 });
}

// --- 9: Glowcap -------------------------------------------------------------------

function glowcapModel(): FoodModel {
  const b = new ProduceBuilder();
  const rand = rng(83);
  // Bell caps on slender stems, like the glowing Mycena of old woods.
  const capProfile = spline([[0, 0.42], [0.08, 0.41], [0.17, 0.365], [0.26, 0.27], [0.33, 0.15], [0.375, 0.055], [0.37, 0.025]]);
  const capColor = linear("#cfc69c");
  // A mossy log for them to grow from.
  const log = new THREE.CatmullRomCurve3([vec(-0.62, 0.12, -0.02), vec(-0.1, 0.13, -0.06), vec(0.6, 0.11, 0.02)]);
  b.add(tube(log, (t) => 0.12 * (1 - 0.1 * Math.sin(t * 7)), 22, 28, 0.85), null, linear("#4b3a28"), [SURF.moss, 0.6, 1, 0]);
  for (const end of [0, 1]) {
    const at = log.getPointAt(end);
    const dir = log.getTangentAt(end).multiplyScalar(end ? 1 : -1);
    b.add(surface((u, v, out) => {
      const a = u * TAU;
      out.set(Math.cos(a) * 0.118 * v, 0, -Math.sin(a) * 0.118 * v * 0.85);
    }, 20, 4), placeAlong(at, dir), linear("#8a6a45"), [SURF.cork, rand(), 0, 0]);
  }
  for (const [mx, mz, sx, sz] of [[-0.06, 0.0, 0.4, 0.17], [0.38, 0.02, 0.18, 0.12], [-0.45, -0.02, 0.14, 0.11]] as const) {
    b.add(blob(40, 18, (bx, by, bz) => 1 + 0.14 * Math.sin(bx * 9 + bz * 7 + mx * 20) * Math.max(0, by), 0.32), new THREE.Matrix4().makeScale(sx, 0.4, sz).setPosition(mx, 0.205, mz), linear("#4a6b2a"), [SURF.moss, rand(), 0, 0]);
  }
  const mushrooms: [number, number, number, number, number, number][] = [
    // x, z, cap radius, stem height, lean x, lean z
    [0.02, 0.0, 0.22, 0.62, -0.04, 0.03],
    [0.2, 0.04, 0.17, 0.46, 0.2, 0.08],
    [-0.18, 0.05, 0.15, 0.38, -0.24, 0.1],
    [0.1, 0.09, 0.09, 0.2, 0.1, 0.24],
    [-0.08, -0.05, 0.13, 0.52, -0.08, -0.14],
    [-0.32, 0.02, 0.08, 0.2, -0.3, 0.1],
  ];
  for (const [x, z, capR, stemH, lx, lz] of mushrooms) {
    const base = vec(x, 0.22, z);
    const top = vec(x + lx * stemH, 0.22 + stemH, z + lz * stemH);
    const stem = new THREE.CatmullRomCurve3([base, base.clone().lerp(top, 0.5).add(vec(lx * 0.1, 0, lz * 0.1)), top]);
    const k = capR / 0.22;
    b.add(tube(stem, (t) => lerp(0.022, 0.015, Math.pow(t, 0.6)) * k * (1 + 0.5 * Math.pow(1 - t, 6)), 10, 18), null, linear("#d6d6ba"), [SURF.gills, rand(), 1, 0]);
    const up = stem.getTangentAt(1);
    const s = capR / 0.37;
    const m = placeAlong(top.clone().addScaledVector(up, -0.03 * s), up, rand() * 6, s, s, s);
    b.add(lathe(capProfile, 44, 22, (a) => 0.025 * Math.sin(a * 5 + x * 10)), m, capColor.clone().multiplyScalar(0.9 + rand() * 0.12), [SURF.mushCap, rand(), 0, 0], (lx2, ly2, lz2) => [lx2 / 0.37, ly2 / 0.37, lz2 / 0.37]);
    b.add(surface((u, v, out) => {
      const a = u * TAU;
      const r = lerp(0.36, 0.04, v);
      const y = lerp(0.028, 0.2, Math.pow(v, 0.8));
      out.set(Math.cos(a) * r, y, -Math.sin(a) * r);
    }, 72, 8), m, linear("#cbd8a8"), [SURF.gills, rand(), 0, 0]);
  }
  return assemble([{ b }], { tint: "#57f0a6", tint2: "#6a5a3a", glow: 1.4 }, { azimuth: 0.2, elevation: 0.26, fill: 0.86, light: 0.55 }, [{ color: "#4dffa6", size: 0.7, position: vec(0, 0.6, 0), strength: 0.24 }]);
}

// --- 10: Dragonfruit ----------------------------------------------------------------

function dragonfruitModel(): FoodModel {
  const rand = rng(97);
  const pink = linear("#cf176a");
  const shape = spline([[0, 0], [0.16, 0.025], [0.3, 0.12], [0.38, 0.3], [0.395, 0.48], [0.36, 0.66], [0.27, 0.82], [0.13, 0.93], [0, 0.96]]);
  const bract = surface((u, v, out) => {
    const across = u * 2 - 1;
    // Broad, fleshy scales that hug the fruit and curl away at green tips.
    const w = 0.5 * Math.pow(Math.sin(Math.PI * Math.min(1, 0.08 + v * 0.92)), 0.4) * Math.pow(Math.max(0, 1 - v), 0.42);
    out.set(across * w, v, Math.pow(v, 2.6) * 0.26 - across * across * w * 0.22);
  }, 8, 12);
  const bractColor = (_x: number, _y: number, _z: number, _u: number, v: number) => linear("#cf176a").lerp(linear("#e2416f"), smooth(0.25, 0.55, v)).lerp(linear("#a3c33a"), smooth(0.58, 0.96, v));
  const fruit = (b: ProduceBuilder, halfOnly: boolean) => {
    b.add(lathe(shape, halfOnly ? 28 : 56, 44, (a, v) => 0.025 * Math.sin(a * 4 + v * 9) * Math.sin(v * Math.PI), halfOnly ? Math.PI : TAU, 0), null, pink, [SURF.pitaya, 0.3, 0, 0]);
    const count = 24;
    for (let i = 0; i < count; i++) {
      const v = lerp(0.1, 0.9, (i + 0.5) / count);
      const a = i * 2.39996 + 0.4;
      if (halfOnly && Math.sin(a) < 0.12) continue;
      const [r, y] = shape(v);
      const [r2, y2] = shape(Math.min(1, v + 0.02));
      const p = vec(Math.cos(a) * r, y, -Math.sin(a) * r);
      const up = vec(Math.cos(a) * r2, y2, -Math.sin(a) * r2).sub(p).normalize();
      const outward = vec(Math.cos(a), 0, -Math.sin(a));
      const normal = outward.clone().addScaledVector(up, -outward.dot(up)).normalize();
      const across = new THREE.Vector3().crossVectors(up, normal).normalize();
      const size = lerp(0.22, 0.31, Math.sin(v * Math.PI)) * (0.9 + rand() * 0.2);
      b.add(bract.clone(), frameMatrix(p.clone().addScaledVector(normal, -0.012), across.multiplyScalar(size * 1.15), up.clone().multiplyScalar(size), normal.clone().multiplyScalar(size)), bractColor, [SURF.bract, rand(), 0, 0]);
    }
    // A crown of bracts gathered at the tip.
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * TAU + 0.3;
      if (halfOnly && Math.sin(a) < 0) continue;
      const p = vec(Math.cos(a) * 0.05, 0.94, -Math.sin(a) * 0.05);
      const dir = vec(Math.cos(a) * 0.5, 1, -Math.sin(a) * 0.5).normalize();
      b.add(bract.clone(), placeAlong(p, dir, -a, 0.22, 0.26, 0.22), bractColor, [SURF.bract, rand(), 0, 0]);
    }
  };
  const whole = new ProduceBuilder();
  fruit(whole, false);
  const half = new ProduceBuilder();
  fruit(half, true);
  half.add(surface((u, v, out) => {
    const [r, y] = shape(v);
    out.set((u * 2 - 1) * r * 0.995, y, 0);
  }, 48, 64), null, linear("#f1ede4"), [SURF.pitayaFlesh, 0.4, 0, 0], (x, y) => [x, y, Math.min(1, Math.abs(x) / profileRadiusAt(shape, y))]);
  bract.dispose();
  return assemble([
    { b: whole, rotation: orient(vec(-0.9, 0.12, -0.35), vec(0.2, 0.9, 0.3)), x: -0.12, z: -0.26 },
    { b: half, rotation: orient(vec(0.92, 0.12, -0.25), vec(0.08, 0.72, 0.68)), x: 0.16, z: 0.2 },
  ], { tint: "#c4105e" }, { azimuth: 0.25, elevation: 0.55, fill: 0.9 });
}

// --- 11: Stardust Honey ---------------------------------------------------------------

function honeyModel(): FoodModel {
  const b = new ProduceBuilder();
  const rand = rng(113);
  const R = 0.074;
  const wall = 0.009;
  const height = 0.22;
  const waxColor = linear("#efd78f");
  const honeyColor = linear("#dc860a");
  const cells = new Map<string, { x: number; z: number; capped: boolean; top: number }>();
  const centre = (q: number, r: number) => ({ x: R * Math.sqrt(3) * (q + r / 2), z: R * 1.5 * r });
  for (let q = -7; q <= 7; q++) {
    for (let r = -7; r <= 7; r++) {
      const c = centre(q, r);
      const angle = Math.atan2(c.z, c.x);
      const reach = 0.4 + 0.06 * Math.sin(angle * 3 + 1) + 0.045 * Math.sin(angle * 5 + 2);
      const d = Math.hypot(c.x / 1.2, c.z);
      if (d > reach) continue;
      const edge = d / reach;
      cells.set(`${q},${r}`, { x: c.x, z: c.z, capped: rand() < 0.24 && edge < 0.75, top: height * (edge > 0.8 ? 0.6 + rand() * 0.35 : 0.96 + rand() * 0.04) });
    }
  }
  const wallBox = new THREE.BoxGeometry(1, 1, 1, 1, 2, 1);
  const done = new Set<string>();
  const corners = (x: number, z: number) => Array.from({ length: 6 }, (_, k) => {
    const a = Math.PI / 6 + (k * Math.PI) / 3;
    return vec(x + Math.cos(a) * R, 0, z + Math.sin(a) * R);
  });
  for (const cell of cells.values()) {
    const ring = corners(cell.x, cell.z);
    for (let k = 0; k < 6; k++) {
      const a = ring[k];
      const c = ring[(k + 1) % 6];
      const mid = a.clone().add(c).multiplyScalar(0.5);
      const key = `${Math.round(mid.x * 2000)},${Math.round(mid.z * 2000)}`;
      if (done.has(key)) continue;
      done.add(key);
      const across = vec(2 * mid.x - cell.x, 0, 2 * mid.z - cell.z);
      let other: { top: number } | undefined;
      for (const n of cells.values()) if (Math.abs(n.x - across.x) < R * 0.2 && Math.abs(n.z - across.z) < R * 0.2) other = n;
      const top = other ? Math.max(cell.top, other.top) : cell.top * (0.75 + rand() * 0.25);
      const m = new THREE.Matrix4().compose(vec(mid.x, top / 2, mid.z), new THREE.Quaternion().setFromAxisAngle(UP, -Math.atan2(c.z - a.z, c.x - a.x)), new THREE.Vector3(a.distanceTo(c) + wall * 0.7, top, wall));
      b.add(wallBox.clone(), m, waxColor.clone().multiplyScalar(0.9 + rand() * 0.14), [SURF.wax, rand(), 0, 0]);
    }
    const inner = R - wall * 0.55;
    const fill = surface((u, v, out) => {
      const a = u * TAU;
      const hex = Math.cos(Math.PI / 6) / Math.cos(((a + TAU) % (Math.PI / 3)) - Math.PI / 6);
      const rr = v * inner * hex;
      const level = cell.capped ? cell.top - 0.008 + 0.014 * (1 - v * v) : cell.top * 0.86 - 0.012 * (1 - v * v);
      out.set(cell.x + Math.cos(a) * rr, level, cell.z - Math.sin(a) * rr);
    }, 18, 5);
    if (cell.capped) b.add(fill, null, linear("#f0d58e").multiplyScalar(0.92 + rand() * 0.1), [SURF.wax, rand(), 0, 0]);
    else b.add(fill, null, honeyColor.clone().multiplyScalar(0.88 + rand() * 0.16), [SURF.honey, rand(), 0, 0]);
  }
  wallBox.dispose();
  // Honey welling over the front edge and running into a pool.
  // The frontmost open cells, one per column, so the runs of honey don't overlap.
  const columns = new Map<number, { x: number; z: number; top: number }>();
  for (const c of cells.values()) {
    if (c.capped) continue;
    const key = Math.round(c.x / (R * 0.9));
    const best = columns.get(key);
    if (!best || c.z > best.z) columns.set(key, c);
  }
  const front = [...columns.values()].sort((a, c) => Math.abs(a.x) - Math.abs(c.x)).slice(0, 3);
  let poolZ = 0;
  front.slice(0, 2).forEach((c, i) => {
    // Honey wells over the rim and runs down the face of the comb as a
    // glossy sheet that narrows, then swells into a drop or a pool.
    const hangs = i === 1;
    const face = c.z + R * 1.0;
    const bottom = hangs ? c.top * 0.28 : 0.01;
    const sway = (rand() - 0.5) * 0.02;
    const run = new THREE.CatmullRomCurve3([
      vec(c.x, c.top * 0.88, c.z + R * 0.35),
      vec(c.x, c.top + 0.01, face - 0.01),
      vec(c.x + sway, c.top * 0.7, face + 0.012),
      vec(c.x + sway * 1.5, lerp(c.top * 0.7, bottom, 0.6), face + 0.016),
      vec(c.x + sway * 1.8, bottom, face + (hangs ? 0.02 : 0.05)),
    ]);
    poolZ = Math.max(poolZ, face + 0.06);
    const centre = new THREE.Vector3();
    b.add(surface((u, v, out) => {
      const across = u * 2 - 1;
      run.getPointAt(Math.min(1, Math.max(0, v)), centre);
      const bulb = hangs ? smooth(0.72, 0.92, v) * Math.sqrt(Math.max(0, 1 - Math.pow(smooth(0.88, 1, v), 2))) : smooth(0.8, 1, v) * 0.6;
      const width = lerp(0.075, 0.03, smooth(0.1, 0.6, v)) + bulb * 0.035;
      const thick = (0.006 + bulb * 0.03) * (1 - across * across);
      out.set(centre.x + across * width, centre.y - (hangs ? bulb * 0.01 * (1 - across * across) : 0), centre.z + thick);
    }, 10, 30), null, honeyColor, [SURF.honey, rand(), 0, 0]);
  });
  // A pool on the table: a flat sheet with a soft rounded edge.
  const pool = surface((u, v, out) => {
    const a = u * TAU;
    const edge = 1 + 0.14 * Math.sin(a * 3 + 1) + 0.07 * Math.sin(a * 7 + 2) + 0.04 * Math.sin(a * 13);
    const r = v * edge;
    out.set(Math.cos(a) * r * 0.3, 0.013 * Math.sqrt(Math.max(0, 1 - Math.pow(v, 6))), -Math.sin(a) * r * 0.13);
  }, 56, 10);
  b.add(pool, new THREE.Matrix4().makeTranslation(0.0, 0.0, poolZ - 0.04), honeyColor, [SURF.honey, 0.5, 0, 0]);
  return assemble([{ b }], {}, { azimuth: 0.0, elevation: 0.66, fill: 0.86 });
}

const FOOD_BUILDERS: Record<number, () => FoodModel> = {
  0: acornModel,
  1: wheatModel,
  2: beanModel,
  3: rootModel,
  4: frostberryModel,
  5: moonmelonModel,
  6: figModel,
  7: tonicModel,
  8: wildEggModel,
  9: glowcapModel,
  10: dragonfruitModel,
  11: honeyModel,
};

/** Builds the studio model for a food item, or null for an unknown item. */
export function foodModel(item: number): FoodModel | null {
  const build = FOOD_BUILDERS[item];
  return build ? build() : null;
}
