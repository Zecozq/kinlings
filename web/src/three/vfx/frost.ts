// Frost Breath: a rolling bank of freezing air that settles into low fog,
// with glinting ice crystals and a frost bloom on the ground; on a racer it
// hits, real ice shards burst off them and tumble to the ground.

import * as THREE from "three";
import {
  Field,
  GLSL_SCENE,
  KIND,
  SHARED,
  blackbody,
  budget,
  observeFrame,
  rand,
  sceneUniforms,
  randomDir,
  range,
  turbulence,
  type Particle,
} from "./core.ts";
import type { Effect, ShieldEffect } from "./types.ts";

const TAG = { BILLOW: 1, FOG: 2, GLINT: 3, FROST: 4, FLASH: 5, RING: 6, PUFF: 7, STREAM: 8 } as const;
const MIST = new THREE.Color(0.7, 0.82, 0.96);
const ICE_LIGHT = blackbody(9000);
const dir = new THREE.Vector3();
const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// ----- Ice shards -------------------------------------------------------------------

/** A six-sided ice crystal along +Y, faceted: every face has its own normal. */
function crystalGeometry(): THREE.BufferGeometry {
  const sides = 6;
  const ring = (y: number, r: number, twist: number) =>
    Array.from({ length: sides }, (_, i) => {
      const a = (i / sides) * Math.PI * 2 + twist;
      const wobble = 1 + 0.18 * Math.sin(i * 2.7 + y * 5);
      return new THREE.Vector3(Math.cos(a) * r * wobble, y, Math.sin(a) * r * wobble);
    });
  const bottom = new THREE.Vector3(0, -0.5, 0);
  const top = new THREE.Vector3(0.02, 0.5, -0.01);
  const lower = ring(-0.28, 0.2, 0);
  const upper = ring(0.22, 0.17, 0.12);
  const tris: THREE.Vector3[] = [];
  for (let i = 0; i < sides; i++) {
    const j = (i + 1) % sides;
    tris.push(bottom, lower[j], lower[i]);
    tris.push(lower[i], lower[j], upper[j], lower[i], upper[j], upper[i]);
    tris.push(upper[i], upper[j], top);
  }
  const positions = new Float32Array(tris.length * 3);
  tris.forEach((v, i) => v.toArray(positions, i * 3));
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

let crystal: THREE.BufferGeometry | null = null;

const SHARD_VERTEX = /* glsl */ `
attribute vec4 iPos;
attribute vec4 iQuat;
attribute vec4 iShape;
varying vec3 vNormal;
varying vec3 vWorld;
varying float vFade;
varying float vSeed;
vec3 rotate(vec4 q, vec3 v){ return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v); }
void main(){
  vec3 local = position * vec3(iShape.x, iShape.y, iShape.x) * iPos.w;
  vec3 world = (modelMatrix * vec4(iPos.xyz, 1.0)).xyz + rotate(iQuat, local);
  vNormal = normalize(rotate(iQuat, normal / vec3(iShape.x, iShape.y, iShape.x)));
  vWorld = world;
  vFade = iShape.z;
  vSeed = iShape.w;
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
`;

const SHARD_FRAGMENT = /* glsl */ `
${GLSL_SCENE}
varying vec3 vNormal;
varying vec3 vWorld;
varying float vFade;
varying float vSeed;
void main(){
  vec3 n = normalize(vNormal);
  vec3 v = normalize(cameraPosition - vWorld);
  if (dot(n, v) < 0.0) n = -n;
  float nv = clamp(dot(n, v), 0.0, 1.0);
  // Ice, IOR 1.31: little reflection face-on, a lot at grazing angles.
  float fresnel = 0.018 + 0.982 * pow(1.0 - nv, 5.0);
  vec3 r = reflect(-v, n);
  vec3 sky = mix(uGroundCol, uSkyCol * 1.2, smoothstep(-0.2, 0.4, r.y));
  float sunSpec = pow(max(dot(r, uSunDir), 0.0), 220.0) * 40.0 + pow(max(dot(r, uSunDir), 0.0), 18.0) * 0.6;
  vec3 reflection = sky + uSunCol * sunSpec / PI;
  // Light passing through the crystal, scattered by its flaws and tinted blue.
  vec3 t = refract(-v, n, 1.0 / 1.31);
  float through = pow(max(dot(t, uSunDir), 0.0), 24.0) * 3.0;
  vec3 body = vec3(0.5, 0.74, 0.95) / PI * (uSunCol * (0.2 + 0.45 * max(dot(n, uSunDir), 0.0) + through) + ambientLight(n) * 1.3) + effectLights(vWorld, n, 0.3) * 0.2;
  float alpha = (0.3 + 0.42 * (1.0 - nv)) * vFade;
  vec3 rgb = body * alpha + reflection * fresnel * vFade;
  float fog = fogAmount(-(viewMatrix * vec4(vWorld, 1.0)).z);
  rgb = rgb * (1.0 - fog) + uFogCol * alpha * fog;
  gl_FragColor = vec4(rgb, alpha);
}
`;

let shardMaterial: THREE.ShaderMaterial | null = null;

function sharedShardMaterial(): THREE.ShaderMaterial {
  if (shardMaterial) return shardMaterial;
  shardMaterial = new THREE.ShaderMaterial({
    name: "kinlings-vfx-ice",
    uniforms: sceneUniforms(),
    vertexShader: SHARD_VERTEX,
    fragmentShader: SHARD_FRAGMENT,
    transparent: true,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
  });
  return shardMaterial;
}

interface Shard {
  p: THREE.Vector3;
  v: THREE.Vector3;
  q: THREE.Quaternion;
  axis: THREE.Vector3;
  spin: number;
  length: number;
  width: number;
  age: number;
  life: number;
  seed: number;
}

/** Tumbling ice shards, all in one instanced draw. */
class ShardBurst {
  readonly mesh: THREE.Mesh;
  private shards: Shard[] = [];
  private geometry: THREE.InstancedBufferGeometry;
  private pos: THREE.InstancedBufferAttribute;
  private quat: THREE.InstancedBufferAttribute;
  private shape: THREE.InstancedBufferAttribute;
  private spinQ = new THREE.Quaternion();

  constructor(capacity: number) {
    if (!crystal) crystal = crystalGeometry();
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute("position", crystal.getAttribute("position"));
    geometry.setAttribute("normal", crystal.getAttribute("normal"));
    const make = () => new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, capacity) * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.pos = make();
    this.quat = make();
    this.shape = make();
    geometry.setAttribute("iPos", this.pos);
    geometry.setAttribute("iQuat", this.quat);
    geometry.setAttribute("iShape", this.shape);
    geometry.instanceCount = 0;
    this.geometry = geometry;
    this.mesh = new THREE.Mesh(geometry, sharedShardMaterial());
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.matrixWorldAutoUpdate = false;
    this.mesh.onBeforeRender = (renderer, scene, camera) => observeFrame(renderer, scene, camera);
    this.mesh.visible = false;
  }

  burst(at: THREE.Vector3, count: number, power: number) {
    for (let i = 0; i < count; i++) {
      randomDir(dir);
      const speed = range(2.5, 6.5) * power;
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
      this.shards.push({
        p: at.clone().addScaledVector(dir, range(0.15, 0.45)),
        v: new THREE.Vector3(dir.x * speed, Math.abs(dir.y) * speed * 0.6 + range(1.5, 4), dir.z * speed),
        q,
        axis: randomDir(new THREE.Vector3()).clone(),
        spin: range(4, 14),
        length: range(0.14, 0.36),
        width: range(0.75, 1.15),
        age: 0,
        life: range(0.9, 1.5),
        seed: rand(),
      });
    }
  }

  get count() {
    return this.shards.length;
  }

  update(dt: number) {
    const ground = SHARED.uGround.value;
    this.shards = this.shards.filter((s) => (s.age += dt) < s.life);
    const pos = this.pos.array as Float32Array;
    const quat = this.quat.array as Float32Array;
    const shape = this.shape.array as Float32Array;
    this.shards.forEach((s, i) => {
      s.v.y -= 9.8 * dt;
      s.v.multiplyScalar(Math.exp(-0.4 * dt));
      s.p.addScaledVector(s.v, dt);
      const floor = ground + s.length * 0.12;
      if (s.p.y < floor) {
        s.p.y = floor;
        s.v.y = Math.abs(s.v.y) * 0.25;
        s.v.x *= 0.5;
        s.v.z *= 0.5;
        s.spin *= 0.45;
      }
      this.spinQ.setFromAxisAngle(s.axis, s.spin * dt);
      s.q.premultiply(this.spinQ);
      const x = s.age / s.life;
      const shrink = 1 - smoothstep(0.65, 1, x);
      pos[i * 4] = s.p.x;
      pos[i * 4 + 1] = s.p.y;
      pos[i * 4 + 2] = s.p.z;
      pos[i * 4 + 3] = s.length * (0.4 + 0.6 * shrink);
      quat[i * 4] = s.q.x;
      quat[i * 4 + 1] = s.q.y;
      quat[i * 4 + 2] = s.q.z;
      quat[i * 4 + 3] = s.q.w;
      shape[i * 4] = s.width;
      shape[i * 4 + 1] = 1;
      shape[i * 4 + 2] = shrink * Math.min(1, s.age / 0.03);
      shape[i * 4 + 3] = s.seed;
    });
    for (const attribute of [this.pos, this.quat, this.shape]) {
      attribute.clearUpdateRanges();
      attribute.addUpdateRange(0, Math.max(1, this.shards.length) * 4);
      attribute.needsUpdate = true;
    }
    this.geometry.instanceCount = this.shards.length;
    this.mesh.visible = this.shards.length > 0;
  }

  dispose() {
    // The crystal's position and normal belong to the shared geometry; drop
    // them from this one first so disposing it does not free them.
    this.geometry.deleteAttribute("position");
    this.geometry.deleteAttribute("normal");
    this.geometry.dispose();
  }
}

// ----- Frost cloud ------------------------------------------------------------------------

function styleMist(p: Particle, x: number) {
  p.t = x;
  p.size = p.u1 + (p.u2 - p.u1) * (1 - Math.pow(1 - x, 2));
  p.a = p.u0 * smoothstep(0, p.u3 || 0.12, x) * (1 - smoothstep(0.45, 1, x));
}

function styleGlint(p: Particle, x: number) {
  // A tumbling crystal flashes when a face turns to the sun.
  const flash = Math.pow(Math.max(0, Math.sin(p.age * p.u1 + p.seed * 40)), 10);
  const level = (0.25 + 4 * flash) * p.u0 * (1 - smoothstep(0.7, 1, x)) * Math.min(1, x * 8);
  p.r = ICE_LIGHT.r * level;
  p.g = ICE_LIGHT.g * level;
  p.b = ICE_LIGHT.b * level;
  p.size = p.u2 * (0.7 + 0.6 * flash);
  p.param = p.u3;
}

function spawnGlint(field: Field, at: THREE.Vector3, spread: THREE.Vector3, life: [number, number]): Particle | null {
  const p = field.spawn(KIND.STAR);
  if (!p) return null;
  p.x = at.x + (rand() - 0.5) * spread.x;
  p.y = at.y + (rand() - 0.5) * spread.y;
  p.z = at.z + (rand() - 0.5) * spread.z;
  p.vx = (rand() - 0.5) * 1.2;
  p.vy = (rand() - 0.5) * 0.6;
  p.vz = (rand() - 0.5) * 1.2;
  p.drag = 2.2;
  p.gravity = 0.35;
  p.life = range(life[0], life[1]);
  p.u0 = range(0.6, 1.4);
  p.u1 = range(5, 16);
  p.u2 = range(0.07, 0.2);
  p.u3 = rand() < 0.3 ? 1 : 0;
  p.spin = range(-1, 1);
  p.tag = TAG.GLINT;
  return p;
}

export interface FrostOptions {
  radius?: number;
  /** A burst on a racer it hit (with ice shards); default when radius < 3. */
  burst?: boolean;
  /** Which way the breath rolls, for the big cloud; default -Z, the race direction. */
  direction?: THREE.Vector3;
  /** Where the breath leaves the caster's mouth; default 8 m behind the cloud, 1.4 m up. */
  source?: THREE.Vector3;
}

function mistPuff(field: Field, kind: number, tag: number): Particle | null {
  const p = field.spawn(kind);
  if (!p) return null;
  p.r = MIST.r;
  p.g = MIST.g;
  p.b = MIST.b;
  p.spin = range(-0.5, 0.5);
  p.tag = tag;
  return p;
}

export function createFrostCloud(position: THREE.Vector3, options: FrostOptions = {}): Effect {
  const radius = options.radius ?? 2.2;
  const burst = options.burst ?? radius < 3;
  const forward = (options.direction ?? new THREE.Vector3(0, 0, -1)).clone().setY(0).normalize();
  const side = new THREE.Vector3(-forward.z, 0, forward.x);
  const ground = SHARED.uGround.value;
  const source = options.source?.clone() ?? position.clone().addScaledVector(forward, -8).setY(ground + 1.4);
  const group = new THREE.Group();
  const field = new Field(budget(burst ? 120 : 230));
  group.add(field.mesh);
  field.anchor.copy(position);
  // Always made, so its shader is compiled with the others at warm-up.
  const shards = new ShardBurst(burst ? budget(18) : 1);
  group.add(shards.mesh);
  let time = 0;
  const billowTotal = burst ? 0 : budget(30);
  const streamTotal = burst ? 0 : budget(26);
  let billows = 0;
  let streamed = 0;

  const frost = field.spawn(KIND.DECAL);
  if (frost) {
    frost.x = position.x;
    frost.y = ground + 0.03;
    frost.z = position.z;
    frost.sy = 1;
    frost.size = radius * (burst ? 2.1 : 2.0);
    frost.life = burst ? 3.2 : 4.4;
    frost.param = 1;
    frost.delay = burst ? 0 : 0.25;
    frost.tag = TAG.FROST;
  }

  if (burst) {
    shards.burst(position, budget(16), 1);
    const flash = field.spawn(KIND.GLOW);
    if (flash) {
      flash.x = position.x;
      flash.y = position.y;
      flash.z = position.z;
      flash.size = 3.2;
      flash.life = 0.18;
      flash.tag = TAG.FLASH;
    }
    const ring = field.spawn(KIND.RING);
    if (ring) {
      ring.x = position.x;
      ring.y = ground + 0.06;
      ring.z = position.z;
      ring.sy = 1;
      ring.life = 0.35;
      ring.param = 0.06;
      ring.tag = TAG.RING;
    }
    for (let i = 0; i < budget(11); i++) {
      const p = mistPuff(field, KIND.MIST, TAG.PUFF);
      if (!p) break;
      randomDir(dir);
      p.x = position.x + dir.x * 0.4;
      p.y = position.y + dir.y * 0.5;
      p.z = position.z + dir.z * 0.4;
      const speed = range(1.2, 3.4);
      p.vx = dir.x * speed;
      p.vy = dir.y * speed * 0.5;
      p.vz = dir.z * speed;
      p.drag = 2.4;
      p.gravity = 0.6;
      p.life = range(1.1, 1.8);
      p.u0 = range(0.32, 0.45);
      p.u1 = range(0.5, 0.8);
      p.u2 = range(1.8, 2.5);
      p.u3 = 0.06;
    }
    for (let i = 0; i < budget(34); i++) spawnGlint(field, position, new THREE.Vector3(2.2, 2, 2.2), [0.5, 1.4]);
  } else {
    // Low fog that the bank leaves on the ground as it settles.
    for (let i = 0; i < budget(15); i++) {
      const p = mistPuff(field, KIND.MIST, TAG.FOG);
      if (!p) break;
      const a = rand() * Math.PI * 2;
      const r = Math.sqrt(rand()) * radius;
      p.x = position.x + Math.cos(a) * r * 1.1 + forward.x * radius * 0.25;
      p.y = ground + range(0.15, 0.45);
      p.z = position.z + Math.sin(a) * r * 0.8 + forward.z * radius * 0.25;
      p.vx = Math.cos(a) * range(0.3, 1.2) + forward.x * 0.8;
      p.vz = Math.sin(a) * range(0.3, 1.2) + forward.z * 0.8;
      p.drag = 0.7;
      p.life = range(3.0, 4.2);
      p.delay = range(0.3, 0.8);
      p.u0 = range(0.14, 0.22);
      p.u1 = range(2.2, 3.2);
      p.u2 = range(4.5, 6.0);
      p.u3 = 0.25;
      p.spin = range(-0.15, 0.15);
    }
    for (let i = 0; i < budget(64); i++) {
      const p = spawnGlint(field, position, new THREE.Vector3(radius * 1.8, 1.8, radius * 1.4), [1.2, 3.0]);
      if (!p) break;
      p.y = Math.max(ground + 0.2, p.y - 0.4);
      p.delay = range(0.15, 0.6);
    }
  }

  return {
    object: group,
    update(dt) {
      time += dt;
      if (!burst) {
        // The breath: a jet of freezing vapour from the mouth...
        const wantStream = Math.min(streamTotal, Math.ceil((time / 0.32) * streamTotal));
        while (streamed < wantStream) {
          streamed++;
          const p = mistPuff(field, KIND.MIST, TAG.STREAM);
          if (!p) break;
          p.x = source.x + (rand() - 0.5) * 0.2;
          p.y = source.y + (rand() - 0.5) * 0.2;
          p.z = source.z + (rand() - 0.5) * 0.2;
          randomDir(dir).multiplyScalar(0.16).add(forward).normalize();
          const speed = range(13, 19);
          p.vx = dir.x * speed;
          p.vy = dir.y * speed - 1;
          p.vz = dir.z * speed;
          p.drag = 1.3;
          p.gravity = 0.5;
          p.life = range(0.55, 0.85);
          p.u0 = range(0.24, 0.34);
          p.u1 = 0.25;
          p.u2 = range(1.3, 1.9);
          p.u3 = 0.1;
          p.spin = range(-2, 2);
        }
        // ...that piles up into a rolling bank and spills across the track.
        const wantBillows = time < 0.12 ? 0 : Math.min(billowTotal, Math.ceil(((time - 0.12) / 0.4) * billowTotal));
        while (billows < wantBillows) {
          billows++;
          const p = mistPuff(field, KIND.MIST, TAG.BILLOW);
          if (!p) break;
          const across = (rand() - 0.5) * radius * 1.3;
          p.x = position.x - forward.x * radius * 0.45 + side.x * across;
          p.y = ground + range(0.35, 1.5);
          p.z = position.z - forward.z * radius * 0.45 + side.z * across;
          const push = range(3, 7.5);
          const spread = (rand() - 0.5) * 7;
          p.vx = forward.x * push + side.x * spread;
          p.vy = range(-0.3, 0.5);
          p.vz = forward.z * push + side.z * spread;
          p.drag = 1.4;
          p.gravity = 0.45;
          p.life = range(1.8, 2.8);
          p.u0 = range(0.22, 0.32);
          p.u1 = range(1.2, 1.8);
          p.u2 = range(3.4, 4.6);
          p.u3 = 0.12;
          p.spin = range(-0.6, 0.6);
        }
      }
      shards.update(dt);
      field.step(dt);
      for (const p of field.particles) {
        if (p.delay > 0) continue;
        const x = p.age / p.life;
        switch (p.tag) {
          case TAG.BILLOW:
          case TAG.PUFF:
          case TAG.STREAM:
            turbulence(p, time, p.tag === TAG.STREAM ? 3 : 1.4, dt);
            if (p.y < ground + p.size * 0.22) p.vy = Math.max(p.vy, 0);
            styleMist(p, x);
            break;
          case TAG.FOG:
            styleMist(p, x);
            break;
          case TAG.GLINT:
            styleGlint(p, x);
            break;
          case TAG.FROST:
            p.a = 0.46 * smoothstep(0, 0.12, x) * (1 - smoothstep(0.6, 1, x));
            p.r = ICE_LIGHT.r * 0.8;
            p.g = ICE_LIGHT.g * 0.8;
            p.b = ICE_LIGHT.b * 0.8;
            break;
          case TAG.FLASH: {
            const level = 0.9 * Math.pow(1 - x, 2);
            p.r = ICE_LIGHT.r * level;
            p.g = ICE_LIGHT.g * level;
            p.b = ICE_LIGHT.b * level;
            break;
          }
          case TAG.RING: {
            p.size = (0.4 + 3.6 * (1 - Math.exp(-p.age / 0.09))) * (radius / 1.8);
            const level = 0.6 * Math.pow(1 - x, 2);
            p.r = ICE_LIGHT.r * level;
            p.g = ICE_LIGHT.g * level;
            p.b = ICE_LIGHT.b * level;
            p.a = 0.25 * (1 - x);
            break;
          }
        }
      }
      field.write();
      return field.count > 0 || shards.count > 0 || billows < billowTotal || streamed < streamTotal;
    },
    dispose() {
      field.dispose();
      shards.dispose();
    },
  };
}

/**
 * Cold coming off a chilled racer: freezing mist that pours down and trails
 * behind them, and glints of ice in the air round them. Parent the object to
 * the racer's group; finish() when the chill wears off.
 */
export function createFrostAura(options: { height?: number } = {}): ShieldEffect {
  const height = options.height ?? 2.15;
  const holder = new THREE.Group();
  const field = new Field(budget(110));
  holder.add(field.mesh);
  const world = new THREE.Vector3();
  const prev = new THREE.Vector3();
  const velocity = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const offset = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  let frames = 0;
  let time = 0;
  let emitting = true;
  let mistDue = 0;
  let glintDue = 0;
  const mistRate = budget(26);
  const glintRate = budget(26);

  const onBody = (p: Particle) => {
    randomDir(offset);
    offset.set(offset.x * 0.6, offset.y * 0.5, offset.z * 0.82).multiplyScalar(height / 2.15);
    offset.y += height * 0.45;
    offset.applyQuaternion(quat);
    p.x = world.x + offset.x;
    p.y = world.y + offset.y;
    p.z = world.z + offset.z;
  };

  return {
    object: holder,
    update(dt) {
      time += dt;
      holder.getWorldPosition(world);
      holder.getWorldQuaternion(quat);
      if (frames === 0) prev.copy(world);
      frames++;
      if (dt > 0) {
        tmp.subVectors(world, prev).divideScalar(dt);
        if (tmp.lengthSq() > 60 * 60) tmp.set(0, 0, 0);
        velocity.lerp(tmp, 1 - Math.exp(-dt * 10));
      }
      prev.copy(world);
      if (emitting) {
        mistDue += dt * mistRate;
        glintDue += dt * glintRate;
      }
      while (mistDue >= 1) {
        mistDue--;
        const p = field.spawn(KIND.MIST);
        if (!p) break;
        onBody(p);
        const keep = range(0.3, 0.7);
        p.vx = velocity.x * keep + (rand() - 0.5) * 0.4;
        p.vy = range(-0.6, 0);
        p.vz = velocity.z * keep + (rand() - 0.5) * 0.4;
        p.drag = 1.6;
        p.gravity = 0.7;
        p.life = range(0.9, 1.5);
        p.u0 = range(0.3, 0.42);
        p.u1 = range(0.4, 0.6);
        p.u2 = range(1.2, 1.8);
        p.u3 = 0.2;
        p.spin = range(-0.5, 0.5);
        p.r = MIST.r;
        p.g = MIST.g;
        p.b = MIST.b;
        p.tag = TAG.PUFF;
      }
      while (glintDue >= 1) {
        glintDue--;
        const p = spawnGlint(field, world, new THREE.Vector3(0, 0, 0), [0.5, 1.1]);
        if (!p) break;
        onBody(p);
        p.vx += velocity.x * 0.8;
        p.vz += velocity.z * 0.8;
        p.u2 *= 0.8;
      }
      field.step(dt);
      field.anchor.copy(world);
      for (const p of field.particles) {
        const x = p.age / p.life;
        if (p.tag === TAG.PUFF) {
          turbulence(p, time, 1, dt);
          if (p.y < SHARED.uGround.value + p.size * 0.3) p.vy = Math.max(p.vy, 0);
          styleMist(p, x);
        } else styleGlint(p, x);
      }
      field.write();
      return emitting || field.count > 0;
    },
    finish() {
      emitting = false;
    },
    dispose() {
      field.dispose();
    },
  };
}
