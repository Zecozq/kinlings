// Vine Snare: thorny brambles. Gripping vines burst out of the ground with a
// spray of dirt, grow from their tips as real tendrils do, coil round the
// racer and tighten; a waiting snare lies coiled low on the track and stirs.
// When they end they brown, droop, drop their leaves and crumble away.
// All the vines, thorns and leaves of one snare are a single draw.

import * as THREE from "three";
import { rng } from "../gfx.ts";
import { Field, GLSL_SCENE, KIND, SHARED, budget, observeFrame, rand, range, sceneUniforms } from "./core.ts";
import type { ShieldEffect } from "./types.ts";

const VINE_VERTEX = /* glsl */ `
attribute vec3 aCenter;
attribute vec4 aGrow;   // arc position 0..1, vine seed, part (0 stem, 1 thorn, 2 leaf), offset from attachment
attribute vec2 aLeaf;   // across the leaf -1..1, along the leaf 0..1
uniform float uTime;
uniform float uGrow;
uniform float uWither;
uniform float uGrip;
uniform float uFlat;
varying vec3 vNormal;
varying vec3 vWorld;
varying vec4 vGrow;
varying vec2 vLeaf;
void main(){
  float s = aGrow.x;
  float seed = aGrow.y;
  float part = aGrow.z;
  // Each vine starts a little later than the last, and grows from its tip.
  float front = uGrow * 1.25 - seed * 0.25;
  float stem = smoothstep(front + 0.02, front - 0.1, s);
  float bud = smoothstep(s + 0.02, s + 0.16, front);
  float scale = part < 0.5 ? stem : bud;
  scale *= 1.0 - uWither * (part < 0.5 ? 0.35 : 0.2);
  vec3 c = aCenter;
  // Writhe, more towards the tip and while growing.
  float whip = (0.04 + 0.12 * (1.0 - smoothstep(0.6, 1.0, uGrow))) * s * (1.0 - uWither);
  vec3 sway = vec3(sin(uTime * 2.3 + s * 9.0 + seed * 31.0), sin(uTime * 1.7 + s * 7.0 + seed * 17.0) * 0.5, cos(uTime * 2.1 + s * 8.0 + seed * 23.0)) * whip;
  vec3 p = c + (position - c) * scale + sway;
  // Gripping: the coils pull in round the victim.
  p.xz *= mix(1.0, 0.86, uGrip * s * (1.0 - uFlat));
  // Withering: leaves droop, everything sags into the ground.
  if (part > 1.5) p.y -= uWither * aGrow.w * 0.6;
  p.y -= uWither * uWither * (0.25 + 0.3 * s);
  vec4 world = modelMatrix * vec4(p, 1.0);
  vWorld = world.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  vGrow = vec4(s, seed, part, scale);
  vLeaf = aLeaf;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const VINE_FRAGMENT = /* glsl */ `
${GLSL_SCENE}
uniform sampler2D uNoise;
uniform float uWither;
varying vec3 vNormal;
varying vec3 vWorld;
varying vec4 vGrow;
varying vec2 vLeaf;
void main(){
  if (vGrow.w < 0.02) discard;
  float s = vGrow.x;
  float part = vGrow.z;
  vec4 noise = texture2D(uNoise, vec2(s * 6.0 + vGrow.y * 3.7, vWorld.y * 1.3 + vWorld.x * 0.7));
  // Crumbling away: a dithered dissolve as it withers.
  float crumble = noise.r * 0.7 + noise.a * 0.3;
  if (uWither > 0.0 && crumble < uWither * 1.35 - 0.3) discard;
  vec3 n = normalize(vNormal);
  vec3 v = normalize(cameraPosition - vWorld);
  if (dot(n, v) < 0.0) n = -n;
  vec3 albedo;
  float rough = 0.7;
  float translucent = 0.0;
  if (part < 0.5) {
    // Stem: dark woody green, browner and barkier towards the root.
    vec3 young = vec3(0.1, 0.22, 0.055);
    vec3 old = vec3(0.16, 0.11, 0.06);
    albedo = mix(old, young, smoothstep(0.0, 0.55, s)) * (0.75 + 0.5 * noise.g);
  } else if (part < 1.5) {
    // Thorn: red-brown, pale at the tip.
    albedo = mix(vec3(0.24, 0.07, 0.04), vec3(0.55, 0.45, 0.3), smoothstep(0.3, 1.0, vLeaf.y));
    rough = 0.45;
  } else {
    // Leaf: two greens, a pale midrib and veins, light through it from behind.
    float rib = exp(-vLeaf.x * vLeaf.x * 90.0);
    float veins = smoothstep(0.82, 1.0, sin((vLeaf.y * 7.0 - abs(vLeaf.x) * 3.0) * 3.14159) * 0.5 + 0.5) * 0.4;
    albedo = mix(vec3(0.07, 0.2, 0.04), vec3(0.16, 0.34, 0.07), noise.b) * (1.0 + rib * 0.8 + veins);
    translucent = 1.0;
    rough = 0.55;
  }
  vec3 dead = vec3(0.22, 0.15, 0.08) * (0.7 + 0.5 * noise.g);
  albedo = mix(albedo, dead, smoothstep(0.0, 0.7, uWither));
  float ndl = dot(n, uSunDir);
  vec3 light = uSunCol * max(ndl, 0.0) + ambientLight(n) + effectLights(vWorld, n, 0.0);
  // Leaves glow yellow-green where the sun shines through them.
  light += uSunCol * max(-ndl, 0.0) * translucent * vec3(0.7, 0.9, 0.35) * 0.55;
  // Near the ground the vines sit in each other's shade.
  float ao = mix(0.55, 1.0, smoothstep(0.0, 0.5, vWorld.y - 0.0));
  vec3 h = normalize(uSunDir + v);
  float spec = pow(max(dot(n, h), 0.0), mix(60.0, 12.0, rough)) * (1.0 - rough) * 0.5;
  vec3 rgb = albedo / PI * light * ao + uSunCol * spec * 0.08;
  float fog = fogAmount(-(viewMatrix * vec4(vWorld, 1.0)).z);
  rgb = mix(rgb, uFogCol, fog);
  gl_FragColor = vec4(rgb, 1.0);
}
`;

interface Builder {
  position: number[];
  normal: number[];
  center: number[];
  grow: number[];
  leaf: number[];
  index: number[];
}

function addVertex(b: Builder, p: THREE.Vector3, n: THREE.Vector3, c: THREE.Vector3, s: number, seed: number, part: number, off: number, la: number, lb: number) {
  b.position.push(p.x, p.y, p.z);
  b.normal.push(n.x, n.y, n.z);
  b.center.push(c.x, c.y, c.z);
  b.grow.push(s, seed, part, off);
  b.leaf.push(la, lb);
  return b.position.length / 3 - 1;
}

/** One bramble: a tapered tube along `points`, with thorns and leaves. */
function addVine(b: Builder, points: THREE.Vector3[], thickness: number, seed: number, random: () => number, leafiness: number) {
  const curve = new THREE.CatmullRomCurve3(points);
  const steps = 40;
  const radial = 7;
  const frames = curve.computeFrenetFrames(steps, false);
  const base = b.position.length / 3;
  const p = new THREE.Vector3();
  const n = new THREE.Vector3();
  for (let i = 0; i <= steps; i++) {
    const s = i / steps;
    curve.getPointAt(s, p);
    const r = thickness * (1 - 0.82 * s) * (1 + 0.15 * Math.sin(s * 40 + seed * 9));
    for (let j = 0; j <= radial; j++) {
      const a = (j / radial) * Math.PI * 2;
      n.copy(frames.normals[i]).multiplyScalar(Math.cos(a)).addScaledVector(frames.binormals[i], Math.sin(a));
      addVertex(b, p.clone().addScaledVector(n, r), n, p, s, seed, 0, 0, 0, 0);
    }
  }
  for (let i = 0; i < steps; i++) {
    for (let j = 0; j < radial; j++) {
      const a = base + i * (radial + 1) + j;
      const c = a + radial + 1;
      b.index.push(a, c, a + 1, a + 1, c, c + 1);
    }
  }
  // Thorns: little hooked cones, leaning back towards the root.
  const tangent = new THREE.Vector3();
  const out = new THREE.Vector3();
  const side = new THREE.Vector3();
  const tip = new THREE.Vector3();
  const thorns = Math.floor(curve.getLength() / 0.075);
  for (let k = 0; k < thorns; k++) {
    const s = (k + 0.5 + (random() - 0.5) * 0.4) / thorns;
    if (s > 0.93) continue;
    const i = Math.min(steps, Math.round(s * steps));
    curve.getPointAt(s, p);
    curve.getTangentAt(s, tangent);
    const a = random() * Math.PI * 2;
    out.copy(frames.normals[i]).multiplyScalar(Math.cos(a)).addScaledVector(frames.binormals[i], Math.sin(a)).normalize();
    const r = thickness * (1 - 0.82 * s);
    const length = thickness * (1.3 + random() * 0.9) * (1 - 0.5 * s);
    const root = p.clone().addScaledVector(out, r * 0.8);
    tip.copy(root).addScaledVector(out, length).addScaledVector(tangent, -length * 0.45);
    side.crossVectors(out, tangent).normalize();
    const w = r * 0.55;
    const corners = [0, 1, 2].map((m) => {
      const ang = (m / 3) * Math.PI * 2;
      return root.clone().addScaledVector(side, Math.cos(ang) * w).addScaledVector(tangent, Math.sin(ang) * w);
    });
    const tipIndex = addVertex(b, tip, out, p, s, seed, 1, length, 0, 1);
    const ring = corners.map((corner) => addVertex(b, corner, corner.clone().sub(root).normalize().addScaledVector(out, 0.6).normalize(), p, s, seed, 1, 0, 0, 0));
    for (let m = 0; m < 3; m++) b.index.push(ring[m], ring[(m + 1) % 3], tipIndex);
  }
  // Leaves: pointed ovals on short stalks, folded a little along the midrib.
  const leaves = Math.floor(curve.getLength() * leafiness);
  for (let k = 0; k < leaves; k++) {
    const s = range01(random, 0.15, 0.9);
    const i = Math.min(steps, Math.round(s * steps));
    curve.getPointAt(s, p);
    curve.getTangentAt(s, tangent);
    const a = random() * Math.PI * 2;
    out.copy(frames.normals[i]).multiplyScalar(Math.cos(a)).addScaledVector(frames.binormals[i], Math.sin(a)).normalize();
    out.y += 0.35;
    out.normalize();
    const length = 0.09 + random() * 0.08;
    const width = length * (0.42 + random() * 0.12);
    side.crossVectors(out, tangent).normalize();
    const face = new THREE.Vector3().crossVectors(side, out).normalize();
    if (face.y < 0) face.negate();
    const root = p.clone().addScaledVector(out, thickness * (1 - 0.82 * s));
    const rows = 5;
    const start = b.position.length / 3;
    for (let row = 0; row <= rows; row++) {
      const t = row / rows;
      const halfWidth = width * Math.sin(Math.PI * Math.pow(t, 0.85)) * 0.5;
      for (const across of [-1, 0, 1]) {
        const fold = Math.abs(across) * halfWidth * 0.35;
        const droop = t * t * length * 0.25;
        const point = root
          .clone()
          .addScaledVector(out, t * length)
          .addScaledVector(side, across * halfWidth)
          .addScaledVector(face, fold - droop);
        const normal = face.clone().addScaledVector(side, -across * 0.35).normalize();
        addVertex(b, point, normal, root, s, seed, 2, t * length, across, t);
      }
    }
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < 2; col++) {
        const a0 = start + row * 3 + col;
        const a1 = a0 + 3;
        b.index.push(a0, a1, a0 + 1, a0 + 1, a1, a1 + 1);
      }
    }
  }
}

const range01 = (random: () => number, a: number, b: number) => a + (b - a) * random();

function buildVines(lurk: boolean, seed: number): THREE.BufferGeometry {
  const random = rng(seed);
  const b: Builder = { position: [], normal: [], center: [], grow: [], leaf: [], index: [] };
  const vines = lurk ? 7 : 8;
  for (let v = 0; v < vines; v++) {
    const angle = (v / vines) * Math.PI * 2 + random() * 0.6;
    const points: THREE.Vector3[] = [];
    if (lurk) {
      // Coiled low on the ground in a loose net.
      const turns = 0.7 + random() * 0.8;
      const r0 = 0.15 + random() * 0.3;
      const r1 = 0.7 + random() * 0.55;
      for (let i = 0; i <= 10; i++) {
        const t = i / 10;
        const a = angle + t * turns * Math.PI * 2 * (v % 2 ? 1 : -1);
        const r = r0 + (r1 - r0) * t;
        points.push(new THREE.Vector3(Math.cos(a) * r, 0.04 + Math.sin(t * Math.PI) * (0.1 + random() * 0.14) + random() * 0.03, Math.sin(a) * r));
      }
      addVine(b, points, 0.03 + random() * 0.012, v / vines, random, 6);
    } else {
      // Bursting up out of the ground and spiralling round the victim.
      const turns = 0.9 + random() * 0.7;
      const out = 0.95 + random() * 0.35;
      const height = 1.25 + random() * 0.6;
      for (let i = 0; i <= 12; i++) {
        const t = i / 12;
        const a = angle + t * turns * Math.PI * 2 * (v % 2 ? 1 : -1);
        const r = out * (0.75 + 0.35 * Math.sin(t * Math.PI * 0.9 + 0.3)) * (1 - 0.35 * t) + 0.08;
        points.push(new THREE.Vector3(Math.cos(a) * r, t * height + Math.sin(t * 9 + v) * 0.05, Math.sin(a) * r));
      }
      points[0].multiplyScalar(1.15).setY(-0.05);
      addVine(b, points, 0.045 + random() * 0.02, v / vines, random, 9);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(b.position, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(b.normal, 3));
  geometry.setAttribute("aCenter", new THREE.Float32BufferAttribute(b.center, 3));
  geometry.setAttribute("aGrow", new THREE.Float32BufferAttribute(b.grow, 4));
  geometry.setAttribute("aLeaf", new THREE.Float32BufferAttribute(b.leaf, 2));
  geometry.setIndex(b.index);
  geometry.computeBoundingSphere();
  return geometry;
}

const variants = new Map<string, THREE.BufferGeometry[]>();

/**
 * A few shapes of each kind, built once and shared by every snare. Both kinds
 * are built on the first call (the warm-up), so none is built mid-race.
 */
function vineGeometry(lurk: boolean): THREE.BufferGeometry {
  if (variants.size === 0) {
    for (const kind of [false, true]) {
      variants.set(kind ? "lurk" : "grip", [0, 1, 2].map((i) => buildVines(kind, 101 + i * 37 + (kind ? 500 : 0))));
    }
  }
  const list = variants.get(lurk ? "lurk" : "grip")!;
  return list[Math.floor(rand() * list.length)];
}

export interface VineOptions {
  radius?: number;
  /** A snare lying in wait on the track, coiled low, rather than one gripping a racer. */
  lurk?: boolean;
}

export function createVineTrap(position: THREE.Vector3, options: VineOptions = {}): ShieldEffect {
  const radius = options.radius ?? 1.2;
  const lurk = options.lurk ?? false;
  const group = new THREE.Group();
  group.position.copy(position);
  const uniforms = {
    uTime: { value: rand() * 10 },
    uGrow: { value: 0 },
    uWither: { value: 0 },
    uGrip: { value: 0 },
    uFlat: { value: lurk ? 1 : 0 },
    uNoise: SHARED.uNoise,
    ...sceneUniforms(),
  };
  const material = new THREE.ShaderMaterial({
    name: "kinlings-vfx-vines",
    uniforms,
    vertexShader: VINE_VERTEX,
    fragmentShader: VINE_FRAGMENT,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(vineGeometry(lurk), material);
  mesh.scale.setScalar(radius / (lurk ? 1.4 : 1.25));
  mesh.rotation.y = rand() * Math.PI * 2;
  mesh.frustumCulled = false;
  mesh.onBeforeRender = (renderer, scene, camera) => observeFrame(renderer, scene, camera);
  group.add(mesh);

  // Dirt thrown up where they break through, and a contact shadow.
  const field = new Field(budget(lurk ? 4 : 44));
  group.add(field.mesh);
  const ground = SHARED.uGround.value;
  let started = false;
  const begin = () => {
    group.updateWorldMatrix(true, false);
    const centre = new THREE.Vector3().setFromMatrixPosition(group.matrixWorld);
    field.anchor.copy(centre);
    const shadow = field.spawn(KIND.DECAL);
    if (shadow) {
      shadow.x = centre.x;
      shadow.y = ground + 0.03;
      shadow.z = centre.z;
      shadow.sy = 1;
      shadow.size = radius * 2.4;
      shadow.life = Infinity;
      shadow.param = 3;
      shadow.tag = 1;
    }
    if (lurk) return;
    for (let i = 0; i < budget(14); i++) {
      const p = field.spawn(KIND.SMOKE);
      if (!p) break;
      const a = rand() * Math.PI * 2;
      const r = radius * range(0.5, 0.9);
      p.x = centre.x + Math.cos(a) * r;
      p.y = ground + 0.15;
      p.z = centre.z + Math.sin(a) * r;
      p.vx = Math.cos(a) * range(0.5, 2);
      p.vy = range(0.6, 1.8);
      p.vz = Math.sin(a) * range(0.5, 2);
      p.drag = 2.5;
      p.gravity = -0.2;
      p.life = range(0.8, 1.4);
      p.u0 = range(0.35, 0.5);
      p.u1 = 0.3;
      p.u2 = range(0.9, 1.4);
      p.r = 0.4;
      p.g = 0.31;
      p.b = 0.2;
      p.tag = 2;
    }
    for (let i = 0; i < budget(22); i++) {
      const p = field.spawn(KIND.CLOD);
      if (!p) break;
      const a = rand() * Math.PI * 2;
      const r = radius * range(0.4, 0.9);
      p.x = centre.x + Math.cos(a) * r;
      p.y = ground + 0.05;
      p.z = centre.z + Math.sin(a) * r;
      p.vx = Math.cos(a) * range(0.5, 2.5);
      p.vy = range(2.5, 5);
      p.vz = Math.sin(a) * range(0.5, 2.5);
      p.gravity = 9.8;
      p.bounce = 0.3;
      p.life = range(0.6, 1.0);
      p.size = range(0.03, 0.075);
      p.spin = range(-10, 10);
      p.r = 0.26;
      p.g = 0.19;
      p.b = 0.12;
      p.a = 1;
      p.tag = 3;
    }
  };

  let closing = false;
  let amount = 0;
  let wither = 0;
  let time = 0;
  return {
    object: group,
    update(dt) {
      if (!started) {
        started = true;
        begin();
      }
      time += dt;
      uniforms.uTime.value += dt;
      if (!closing) {
        amount = Math.min(1, amount + dt / (lurk ? 0.7 : 0.62));
      } else {
        wither = Math.min(1, wither + dt / 0.6);
      }
      uniforms.uGrow.value = 1 - Math.pow(1 - amount, 2.2);
      uniforms.uGrip.value = Math.max(0, Math.min(1, (time - 0.35) / 0.4));
      uniforms.uWither.value = wither;
      field.step(dt);
      for (const p of field.particles) {
        const x = p.age / p.life;
        if (p.tag === 1) p.a = 0.5 * Math.min(1, amount * 2) * (1 - wither);
        else if (p.tag === 2) {
          p.t = x;
          p.size = p.u1 + (p.u2 - p.u1) * (1 - Math.pow(1 - x, 2));
          p.a = p.u0 * Math.min(1, x / 0.08) * (1 - x);
        }
      }
      field.write();
      return !(closing && wither >= 1);
    },
    finish() {
      closing = true;
    },
    dispose() {
      material.dispose();
      field.dispose();
    },
  };
}
