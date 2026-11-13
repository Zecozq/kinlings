// Storm Bolt: a branching bolt out of the sky. A faint stepped leader feels
// its way down, the return stroke flashes white-hot up the channel, and it
// re-strikes three or four times in the same channel (later strokes without
// the branches, as real ones do) before the channel cools to a dim afterglow.
// The ground spits molten sparks, steams, and keeps a glowing scorch scar.

import * as THREE from "three";
import {
  Field,
  KIND,
  SHARED,
  VIEW,
  blackbody,
  borrowLight,
  budget,
  heat,
  motionBlur,
  observeFrame,
  rand,
  randomDir,
  range,
  returnLight,
  turbulence,
  type EffectLight,
  type Particle,
} from "./core.ts";
import type { Effect, ShieldEffect } from "./types.ts";

const BOLT_VERTEX = /* glsl */ `
attribute vec3 aPrev;
attribute vec3 aNext;
attribute vec4 aInfo;   // side, glow half-width (m), core fraction, brightness
attribute vec3 aTime;   // arrival time of the leader, level, distance along (m)
uniform vec2 uViewport;
varying float vAcross;
varying float vCore;
varying float vEnergy;
varying float vBright;
varying vec3 vTime;
varying float vDepth;
void main(){
  vec3 tangent = aNext - aPrev;
  tangent = length(tangent) > 1e-5 ? normalize(tangent) : vec3(0.0, 1.0, 0.0);
  vec3 toCam = normalize(cameraPosition - position);
  vec3 side = cross(tangent, toCam);
  side = length(side) > 1e-4 ? normalize(side) : vec3(1.0, 0.0, 0.0);
  vec3 camBack = vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]);
  float dist = max(0.1, dot(position - cameraPosition, -camBack));
  float pixel = 2.0 * dist / (projectionMatrix[1][1] * uViewport.y);
  float w = max(aInfo.y, pixel * 3.5);
  vCore = max(aInfo.z * aInfo.y, pixel * 0.75) / w;
  vEnergy = min(1.0, aInfo.y / w) * min(1.0, aInfo.z * aInfo.y / (pixel * 0.75));
  vAcross = aInfo.x;
  vBright = aInfo.w;
  vTime = aTime;
  vec4 mv = viewMatrix * vec4(position + side * aInfo.x * w, 1.0);
  vDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

const BOLT_FRAGMENT = /* glsl */ `
uniform float uTime;
uniform float uLeader;
uniform float uMain;
uniform float uBranch;
uniform float uAfter;
uniform vec3 uCoreCol;
uniform vec3 uGlowCol;
uniform vec3 uAfterCol;
varying float vAcross;
varying float vCore;
varying float vEnergy;
varying float vBright;
varying vec3 vTime;
varying float vDepth;
float hash(float n){ return fract(sin(n) * 43758.5453); }
void main(){
  float x = vAcross;
  float core = exp(-pow(x / vCore, 2.0) * 1.7);
  float glow = exp(-x * x * 3.2) * 0.65 + exp(-x * x * 14.0) * 0.35;
  float level = vTime.y;
  // The channel is only there once the leader has reached it.
  float since = uLeader - vTime.x;
  if (since < 0.0) discard;
  float leaderTip = exp(-since * 55.0);
  float stroke = level < 0.5 ? uMain : uBranch * vBright;
  // Brightness crackles along the channel.
  float seg = floor(vTime.z * 2.5);
  float crackle = 0.72 + 0.28 * hash(seg + floor(uTime * 60.0) * 7.13);
  float leader = (0.3 + leaderTip * 2.6) * (level < 0.5 ? 1.0 : 0.7) * step(uMain + uBranch, 0.001);
  vec3 hot = uCoreCol * core * (stroke * crackle) + uGlowCol * glow * (stroke * 0.42);
  vec3 dim = uGlowCol * (glow * 0.5 + core) * leader;
  vec3 after = uAfterCol * (core * 0.8 + glow * 0.3) * uAfter * (level < 0.5 ? 1.0 : 0.35);
  vec3 rgb = (hot + dim + after) * vEnergy;
  gl_FragColor = vec4(rgb, 0.0);
}
`;

const up = new THREE.Vector3(0, 1, 0);
const scratch = new THREE.Vector3();
const scratch2 = new THREE.Vector3();

/** Midpoint displacement: a jagged path from a to b, `levels` times subdivided. */
function jagged(a: THREE.Vector3, b: THREE.Vector3, levels: number, roughness: number): THREE.Vector3[] {
  let points = [a.clone(), b.clone()];
  const length = a.distanceTo(b);
  let amplitude = length * roughness;
  for (let level = 0; level < levels; level++) {
    const next: THREE.Vector3[] = [points[0]];
    for (let i = 0; i < points.length - 1; i++) {
      const p = points[i];
      const q = points[i + 1];
      const mid = p.clone().lerp(q, 0.5 + (rand() - 0.5) * 0.2);
      const along = scratch.subVectors(q, p).normalize();
      const perp = randomDir(scratch2).addScaledVector(along, -scratch2.dot(along)).normalize();
      // Gaussian-ish offset.
      const g = (rand() + rand() + rand() - 1.5) / 1.5;
      mid.addScaledVector(perp, g * amplitude);
      next.push(mid, q);
    }
    points = next;
    amplitude *= 0.58;
  }
  return points;
}

interface Strand {
  points: THREE.Vector3[];
  width: number;
  core: number;
  bright: number;
  level: number;
  /** Leader arrival time at the first point, and seconds per metre. */
  start: number;
  pace: number;
}

function buildGeometry(strands: Strand[], geometry?: THREE.BufferGeometry, capacity?: number): THREE.BufferGeometry {
  let total = 0;
  for (const s of strands) total += s.points.length;
  const size = capacity ?? total;
  const position = new Float32Array(size * 2 * 3);
  const prev = new Float32Array(size * 2 * 3);
  const next = new Float32Array(size * 2 * 3);
  const info = new Float32Array(size * 2 * 4);
  const time = new Float32Array(size * 2 * 3);
  const index: number[] = [];
  let v = 0;
  for (const s of strands) {
    let along = 0;
    const n = s.points.length;
    for (let i = 0; i < n; i++) {
      const p = s.points[i];
      const a = s.points[Math.max(0, i - 1)];
      const b = s.points[Math.min(n - 1, i + 1)];
      if (i > 0) along += p.distanceTo(a);
      const taper = s.level === 0 ? 1 - 0.35 * (i / (n - 1)) : 1 - 0.75 * (i / (n - 1));
      for (const sideSign of [-1, 1]) {
        p.toArray(position, v * 3);
        a.toArray(prev, v * 3);
        b.toArray(next, v * 3);
        info[v * 4] = sideSign;
        info[v * 4 + 1] = s.width * taper;
        info[v * 4 + 2] = s.core;
        info[v * 4 + 3] = s.bright;
        time[v * 3] = s.start + along * s.pace;
        time[v * 3 + 1] = s.level;
        time[v * 3 + 2] = along;
        v++;
      }
      if (i < n - 1) {
        const k = v - 2;
        index.push(k, k + 1, k + 3, k, k + 3, k + 2);
      }
    }
  }
  const g = geometry ?? new THREE.BufferGeometry();
  const set = (name: string, array: Float32Array, itemSize: number) => {
    const existing = g.getAttribute(name) as THREE.BufferAttribute | undefined;
    if (existing && existing.array.length === array.length) {
      (existing.array as Float32Array).set(array);
      existing.needsUpdate = true;
    } else {
      const attribute = new THREE.BufferAttribute(array, itemSize);
      if (capacity) attribute.setUsage(THREE.DynamicDrawUsage);
      g.setAttribute(name, attribute);
    }
  };
  set("position", position, 3);
  set("aPrev", prev, 3);
  set("aNext", next, 3);
  set("aInfo", info, 4);
  set("aTime", time, 3);
  if (g.index && g.index.count >= index.length && capacity) {
    (g.index.array as Uint16Array | Uint32Array).fill(0);
    (g.index.array as Uint16Array | Uint32Array).set(index);
    g.index.needsUpdate = true;
  } else {
    g.setIndex(capacity ? [...index, ...new Array(Math.max(0, capacity * 6 - index.length)).fill(0)] : index);
  }
  return g;
}

/** The whole tree: main channel, branches and twigs, with leader timing. */
function boltStrands(top: THREE.Vector3, bottom: THREE.Vector3, reach: number, lowQuality: boolean): Strand[] {
  const length = top.distanceTo(bottom);
  const pace = reach / length;
  const main = jagged(top, bottom, lowQuality ? 6 : 7, 0.09);
  const strands: Strand[] = [{ points: main, width: 0.42, core: 0.12, bright: 1, level: 0, start: 0, pace }];
  // Arrival time at each main point.
  const arrive: number[] = [0];
  for (let i = 1; i < main.length; i++) arrive.push(arrive[i - 1] + main[i].distanceTo(main[i - 1]) * pace);
  const branches = lowQuality ? 3 : 4 + Math.floor(rand() * 4);
  for (let b = 0; b < branches; b++) {
    const at = Math.floor(main.length * range(0.12, 0.72));
    const from = main[at];
    const down = scratch.subVectors(bottom, from).normalize();
    const outward = randomDir(new THREE.Vector3()).setY(0).normalize();
    const dir = down.clone().multiplyScalar(range(0.55, 0.9)).addScaledVector(outward, range(0.45, 0.95)).normalize();
    const remaining = from.distanceTo(bottom);
    const to = from.clone().addScaledVector(dir, remaining * range(0.22, 0.5));
    to.y = Math.max(to.y, bottom.y + 1.5);
    const points = jagged(from, to, lowQuality ? 4 : 5, 0.12);
    const bright = range(0.35, 0.7);
    strands.push({ points, width: 0.22, core: 0.12, bright, level: 1, start: arrive[at], pace: pace * 1.3 });
    if (lowQuality) continue;
    const twigs = Math.floor(rand() * 3);
    for (let t = 0; t < twigs; t++) {
      const k = Math.floor(points.length * range(0.2, 0.7));
      const base = points[k];
      const twigDir = dir.clone().addScaledVector(randomDir(scratch2), 0.8).normalize();
      if (twigDir.y > 0) twigDir.y = -twigDir.y;
      const end = base.clone().addScaledVector(twigDir, remaining * range(0.06, 0.16));
      strands.push({ points: jagged(base, end, 3, 0.14), width: 0.14, core: 0.12, bright: bright * 0.55, level: 2, start: arrive[at] + base.distanceTo(from) * pace * 1.3, pace: pace * 1.5 });
    }
  }
  return strands;
}

function boltMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: "kinlings-vfx-bolt",
    uniforms: {
      uViewport: SHARED.uViewport,
      uTime: { value: 0 },
      uLeader: { value: 0 },
      uMain: { value: 0 },
      uBranch: { value: 0 },
      uAfter: { value: 0 },
      uCoreCol: { value: new THREE.Color() },
      uGlowCol: { value: new THREE.Color() },
      uAfterCol: { value: new THREE.Color() },
    },
    vertexShader: BOLT_VERTEX,
    fragmentShader: BOLT_FRAGMENT,
    transparent: true,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
  });
}

const CORE = blackbody(16000);
const GLOW = new THREE.Color(0.55, 0.62, 1.0);
const AFTER = new THREE.Color(0.9, 0.45, 0.85);
const color = new THREE.Color();

/** Each stroke: when it lands, how bright. */
function strokes(): { at: number; level: number }[] {
  const list = [{ at: 0.075, level: 1 }];
  let t = 0.075;
  const extra = 2 + Math.floor(rand() * 3);
  for (let i = 0; i < extra; i++) {
    t += range(0.06, 0.12);
    list.push({ at: t, level: range(0.45, 0.9) });
  }
  return list;
}

const TAG = { FLASH: 1, SKY: 2, RING: 3, SPARK: 4, SCAR: 5, STEAM: 6, PLASMA: 7, ARC_SPARK: 8, BODY: 9 } as const;

export function createLightning(from: THREE.Vector3, to: THREE.Vector3, options: { extend?: number } = {}): Effect {
  const low = budget(10) < 6;
  const group = new THREE.Group();
  // Out of the sky: carry the channel on up beyond `from`, leaning a little.
  const extend = options.extend ?? 2.4;
  const top = to.clone().addScaledVector(scratch.subVectors(from, to), extend);
  top.x += (rand() - 0.5) * 9;
  top.z += (rand() - 0.5) * 6;
  const reach = 0.07;
  const geometry = buildGeometry(boltStrands(top, to, reach, low));
  const material = boltMaterial();
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.onBeforeRender = (renderer, scene, camera) => observeFrame(renderer, scene, camera);
  group.add(mesh);
  const u = material.uniforms;
  (u.uCoreCol.value as THREE.Color).copy(CORE).multiplyScalar(60);
  (u.uGlowCol.value as THREE.Color).copy(GLOW).multiplyScalar(9);
  (u.uAfterCol.value as THREE.Color).copy(AFTER).multiplyScalar(1.6);

  const field = new Field(budget(150));
  group.add(field.mesh);
  field.anchor.copy(to);
  const plan = strokes();
  const lastStroke = plan[plan.length - 1].at;
  let next = 0;
  let time = 0;
  let light: EffectLight | null = null;
  let lightTried = false;
  const ground = SHARED.uGround.value;
  const onGround = to.y < ground + 2;

  const at = (p: Particle, height = 0.05) => {
    p.x = to.x;
    p.y = to.y + height;
    p.z = to.z;
  };
  // The sky lights up: a huge glow far behind the strike, which the scene in
  // front hides, so only the sky and the distance brighten.
  const away = scratch.subVectors(to, VIEW.camera).setY(0);
  if (away.lengthSq() < 1) away.set(0, 0, -1);
  away.normalize();
  const sky = field.spawn(KIND.GLOW);
  if (sky) {
    sky.x = to.x + away.x * 130;
    sky.y = to.y + 28;
    sky.z = to.z + away.z * 130;
    sky.size = 260;
    sky.life = lastStroke + 0.3;
    sky.tag = TAG.SKY;
  }
  if (onGround) {
    const scar = field.spawn(KIND.DECAL);
    if (scar) {
      at(scar, 0.035);
      scar.sy = 1;
      scar.size = 6.5;
      scar.life = 4;
      scar.param = 2;
      scar.delay = reach;
      scar.tag = TAG.SCAR;
    }
  }

  const strike = (index: number, level: number) => {
    const flash = field.spawn(KIND.GLOW);
    if (flash) {
      at(flash, 0.5);
      flash.size = 3.6 * (0.6 + 0.4 * level);
      flash.life = 0.09;
      flash.u0 = level;
      flash.tag = TAG.FLASH;
    }
    if (index === 0) {
      const plasma = field.spawn(KIND.GLOW);
      if (plasma) {
        at(plasma, 0.3);
        plasma.size = 1.6;
        plasma.life = 0.55;
        plasma.tag = TAG.PLASMA;
      }
      if (onGround) {
        const ring = field.spawn(KIND.RING);
        if (ring) {
          at(ring, 0.06);
          ring.sy = 1;
          ring.life = 0.32;
          ring.param = 0.05;
          ring.tag = TAG.RING;
        }
        for (let i = 0; i < budget(9); i++) {
          const p = field.spawn(KIND.SMOKE);
          if (!p) break;
          at(p, range(0.2, 0.6));
          p.x += (rand() - 0.5) * 1.2;
          p.z += (rand() - 0.5) * 1.2;
          p.vx = (rand() - 0.5) * 1.5;
          p.vy = range(0.6, 1.6);
          p.vz = (rand() - 0.5) * 1.5;
          p.drag = 1.4;
          p.gravity = -0.5;
          p.life = range(1.4, 2.4);
          p.delay = range(0.05, 0.25);
          p.u0 = range(0.3, 0.42);
          p.u1 = 0.5;
          p.u2 = range(1.6, 2.3);
          p.spin = range(-0.4, 0.4);
          const grey = range(0.38, 0.5);
          p.r = grey;
          p.g = grey;
          p.b = grey * 1.04;
          p.tag = TAG.STEAM;
        }
      }
    }
    const sparks = budget(index === 0 ? 40 : 12);
    for (let i = 0; i < sparks; i++) {
      const p = field.spawn(KIND.SPARK);
      if (!p) break;
      at(p, 0.15);
      randomDir(scratch);
      scratch.y = Math.abs(scratch.y) * 0.9 + 0.2;
      scratch.normalize();
      const speed = range(4, 15) * (0.6 + 0.4 * level);
      p.vx = scratch.x * speed;
      p.vy = scratch.y * speed;
      p.vz = scratch.z * speed;
      p.gravity = 9.8;
      p.drag = 1.2;
      p.bounce = 0.35;
      p.life = range(0.35, 1.0);
      p.size = range(0.02, 0.045);
      p.u0 = range(2600, 3800);
      p.tag = TAG.SPARK;
    }
  };

  return {
    object: group,
    update(dt) {
      time += dt;
      if (!lightTried) {
        lightTried = true;
        light = borrowLight(blackbody(8000, color), 40);
        light?.light.position.set(to.x, to.y + 5, to.z);
      }
      while (next < plan.length && time >= plan[next].at) {
        strike(next, plan[next].level);
        next++;
      }
      // Brightness of the channel: a sharp peak per stroke plus a weak continuing current.
      let main = 0;
      let branch = 0;
      plan.forEach((s, i) => {
        if (time < s.at) return;
        const k = Math.exp(-(time - s.at) / 0.028);
        main += s.level * k;
        branch += s.level * k * (i === 0 ? 1 : 0.12);
      });
      if (time > plan[0].at && time < lastStroke + 0.05) main += 0.08;
      const after = time > plan[0].at ? Math.exp(-Math.max(0, time - lastStroke) / 0.09) * 0.16 : 0;
      u.uTime.value = time;
      u.uLeader.value = time;
      u.uMain.value = main;
      u.uBranch.value = branch;
      u.uAfter.value = after;
      mesh.visible = time < lastStroke + 0.4;

      field.step(dt);
      for (const p of field.particles) {
        if (p.delay > 0) continue;
        const x = p.age / p.life;
        switch (p.tag) {
          case TAG.SKY:
            color.copy(CORE).multiplyScalar(0.3 * main + 0.01 * (time < reach ? time / reach : 0));
            p.r = color.r;
            p.g = color.g;
            p.b = color.b;
            break;
          case TAG.FLASH: {
            const level = p.u0 * Math.pow(1 - x, 2) * 2.6;
            p.r = CORE.r * level;
            p.g = CORE.g * level;
            p.b = CORE.b * level;
            break;
          }
          case TAG.PLASMA: {
            const level = 3 * Math.pow(1 - x, 3) + main * 4;
            p.r = (CORE.r * 0.8 + 0.2) * level;
            p.g = (CORE.g * 0.7 + 0.1) * level;
            p.b = CORE.b * level;
            break;
          }
          case TAG.RING:
            p.size = 0.6 + 5.4 * (1 - Math.exp(-p.age / 0.07));
            color.copy(GLOW).multiplyScalar(2.2 * Math.pow(1 - x, 2));
            p.r = color.r;
            p.g = color.g;
            p.b = color.b;
            p.a = 0;
            break;
          case TAG.SPARK: {
            heat(p.u0 * (1 - 0.45 * x), 0.22 * (1 - x * x), color);
            p.r = color.r;
            p.g = color.g;
            p.b = color.b;
            motionBlur(p, 1 / 60, 0.5);
            break;
          }
          case TAG.STEAM:
            turbulence(p, time, 1.3, dt);
            p.t = x;
            p.size = p.u1 + (p.u2 - p.u1) * (1 - Math.pow(1 - x, 1.8));
            p.a = p.u0 * Math.min(1, x / 0.1) * (1 - x);
            break;
          case TAG.SCAR: {
            p.a = 0.9 * Math.min(1, p.age / 0.04) * (1 - Math.max(0, (x - 0.6) / 0.4));
            const cooling = Math.exp(-p.age / 0.5);
            heat(900 + 1800 * cooling, 2.2 * cooling + 0.08 * Math.exp(-p.age / 1.5), color);
            p.r = color.r;
            p.g = color.g;
            p.b = color.b;
            break;
          }
        }
      }
      field.write();
      if (light) {
        light.light.intensity = 650 * main + 25 * after;
        if (time > lastStroke + 0.3) {
          returnLight(light);
          light = null;
        }
      }
      return mesh.visible || field.count > 0;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
      field.dispose();
      returnLight(light);
      light = null;
    },
  };
}

/**
 * Electric arcs crawling over a stunned racer, with spitting sparks. Parent
 * the object to the racer's group; finish() when the stun ends.
 */
export function createShockAura(options: { height?: number } = {}): ShieldEffect {
  const height = options.height ?? 2.15;
  const holder = new THREE.Group();
  const arcsPerFrame = 3;
  const pointsPerArc = 14;
  const material = boltMaterial();
  const geometry = buildGeometry([], undefined, arcsPerFrame * pointsPerArc);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = false;
  mesh.matrixWorldAutoUpdate = false;
  mesh.onBeforeRender = (renderer, scene, camera) => observeFrame(renderer, scene, camera);
  holder.add(mesh);
  const u = material.uniforms;
  (u.uCoreCol.value as THREE.Color).copy(CORE).multiplyScalar(30);
  (u.uGlowCol.value as THREE.Color).copy(GLOW).multiplyScalar(4.5);
  (u.uAfterCol.value as THREE.Color).copy(AFTER);
  u.uLeader.value = 10;
  const field = new Field(budget(70));
  holder.add(field.mesh);
  const world = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  let time = 0;
  let rebuild = 0;
  let emitting = true;
  let level = 0;

  const bodyPoint = (out: THREE.Vector3) => {
    randomDir(out);
    out.set(out.x * 0.62, out.y * 0.56, out.z * 0.86).multiplyScalar(height / 2.15);
    out.y += height * 0.45;
    return out.applyQuaternion(quat).add(world);
  };

  return {
    object: holder,
    update(dt) {
      time += dt;
      holder.getWorldPosition(world);
      holder.getWorldQuaternion(quat);
      level = Math.max(0, Math.min(1, level + (emitting ? dt * 8 : -dt * 5)));
      rebuild -= dt;
      if (rebuild <= 0 && level > 0) {
        rebuild = range(0.045, 0.09);
        const strands: Strand[] = [];
        for (let i = 0; i < arcsPerFrame; i++) {
          if (rand() < 0.25) continue;
          const a = bodyPoint(new THREE.Vector3());
          const b = bodyPoint(new THREE.Vector3());
          if (a.distanceTo(b) < 0.4) b.addScaledVector(up, 0.5);
          const points = jagged(a, b, 3, 0.22).slice(0, pointsPerArc);
          strands.push({ points, width: 0.17, core: 0.12, bright: 1, level: 0, start: 0, pace: 0 });
        }
        buildGeometry(strands, geometry, arcsPerFrame * pointsPerArc);
        for (let i = 0; i < budget(5); i++) {
          const p = field.spawn(KIND.SPARK);
          if (!p) break;
          bodyPoint(scratch);
          p.x = scratch.x;
          p.y = scratch.y;
          p.z = scratch.z;
          randomDir(scratch);
          p.vx = scratch.x * range(2, 6);
          p.vy = scratch.y * range(2, 6) + 1;
          p.vz = scratch.z * range(2, 6);
          p.gravity = 9.8;
          p.drag = 1.5;
          p.life = range(0.2, 0.5);
          p.size = range(0.015, 0.03);
          p.u0 = range(5000, 9000);
          p.tag = TAG.ARC_SPARK;
        }
      }
      const flicker = rand() < 0.2 ? 0.25 : 1;
      u.uTime.value = time;
      u.uMain.value = level * flicker;
      mesh.visible = level > 0;
      field.step(dt);
      field.anchor.copy(world);
      for (const p of field.particles) {
        const x = p.age / p.life;
        heat(p.u0 * (1 - 0.5 * x), 0.14 * (1 - x), color);
        p.r = color.r;
        p.g = color.g;
        p.b = color.b;
        motionBlur(p, 1 / 60, 0.5);
      }
      field.write();
      return emitting || level > 0 || field.count > 0;
    },
    finish() {
      emitting = false;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
      field.dispose();
    },
  };
}
