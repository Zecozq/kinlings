// Fire Spit: the flying fireball, its launch flash, the explosion it ends in,
// and the flames that keep licking a racer it burned.

import * as THREE from "three";
import {
  Field,
  KIND,
  VIEW,
  blackbody,
  borrowLight,
  budget,
  heat,
  motionBlur,
  rand,
  randomDir,
  range,
  returnLight,
  turbulence,
  type EffectLight,
  type Particle,
} from "./core.ts";
import type { Effect, ShieldEffect } from "./types.ts";

export interface FireballEffect extends Effect {
  explode(scene: THREE.Object3D): Effect;
}

const TAG = { FLAME: 1, SMOKE: 2, EMBER: 3, CORE: 4, HALO: 5, FLASH: 6, SPARK: 7, CHUNK: 8, DUST: 9, SHOCK: 10, SCORCH: 11, FLASH2: 12, CORE_FLAME: 13 } as const;

const color = new THREE.Color();
const dir = new THREE.Vector3();
const tmp = new THREE.Vector3();
const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

function setEmission(p: Particle, kelvin: number, gain: number) {
  heat(kelvin, gain, color);
  p.r = color.r;
  p.g = color.g;
  p.b = color.b;
}

/**
 * Styles a flame particle: u0 start temperature, u1/u2 start/end size, u3
 * brightness. opacity: how much the flame hides what is behind it; billow:
 * 0 for licking tongues, 1 for the cauliflower billows of an explosion.
 */
function styleFlame(p: Particle, x: number, cool: number, opacity: number, billow: number, sootFrom = 0.3) {
  p.t = x;
  p.size = p.u1 + (p.u2 - p.u1) * (1 - (1 - x) * (1 - x));
  p.r = p.u0 * (1 - cool * Math.pow(x, 0.8));
  p.g = p.u3 * Math.min(1, x / 0.06);
  p.b = smoothstep(sootFrom, 1, x) * 0.95;
  p.a = opacity * (1 - smoothstep(0.75, 1, x));
  p.param = billow;
}

/** Styles a smoke puff: u1/u2 size, u0 opacity, u3 how long it glows from the fire. */
function styleSmoke(p: Particle, x: number) {
  p.t = x;
  p.size = p.u1 + (p.u2 - p.u1) * (1 - Math.pow(1 - x, 1.7));
  p.a = p.u0 * smoothstep(0, 0.08, x) * (1 - smoothstep(0.4, 1, x));
  p.param = p.u3 > 0 ? Math.max(0, 1 - x / p.u3) : 0;
}

function styleEmber(p: Particle, x: number, shutter: number) {
  const flicker = 0.62 + 0.38 * Math.sin(p.age * (28 + p.seed * 30) + p.seed * 40);
  setEmission(p, p.u0 * (1 - 0.38 * x), p.u3 * flicker * (1 - x * x));
  motionBlur(p, shutter, 0.5);
}

const launchDir = new THREE.Vector3();

/** The fire gun's muzzle: a flash, a tongue of flame and sparks thrown forward. */
function emitLaunch(field: Field, at: THREE.Vector3, heading: THREE.Vector3, scale: number) {
  const s = scale;
  // Own copy: the scratch vectors below are reused for random directions.
  const forward = launchDir.copy(heading).normalize();
  const flash = field.spawn(KIND.GLOW);
  if (flash) {
    flash.x = at.x;
    flash.y = at.y;
    flash.z = at.z;
    flash.life = 0.12;
    flash.size = 1.9 * s;
    flash.tag = TAG.FLASH;
  }
  for (let i = 0; i < budget(9); i++) {
    const p = field.spawn(KIND.FIRE);
    if (!p) break;
    randomDir(dir).multiplyScalar(range(1, 3)).addScaledVector(forward, range(7, 16));
    p.x = at.x + (rand() - 0.5) * 0.3 * s;
    p.y = at.y + (rand() - 0.5) * 0.3 * s;
    p.z = at.z + (rand() - 0.5) * 0.3 * s;
    p.vx = dir.x;
    p.vy = dir.y;
    p.vz = dir.z;
    p.drag = 9;
    p.gravity = -2;
    p.life = range(0.16, 0.3);
    p.u0 = range(2400, 2800);
    p.u1 = 0.35 * s;
    p.u2 = range(0.9, 1.3) * s;
    p.u3 = 0.5;
    p.spin = range(-4, 4);
    p.tag = TAG.FLAME;
  }
  for (let i = 0; i < budget(14); i++) {
    const p = field.spawn(KIND.SPARK);
    if (!p) break;
    randomDir(dir).multiplyScalar(0.45).add(forward).normalize().multiplyScalar(range(9, 24));
    p.x = at.x;
    p.y = at.y;
    p.z = at.z;
    p.vx = dir.x;
    p.vy = dir.y + 1.5;
    p.vz = dir.z;
    p.gravity = 9.8;
    p.drag = 2.2;
    p.life = range(0.2, 0.5);
    p.size = range(0.022, 0.04) * Math.sqrt(s);
    p.u0 = range(2300, 2900);
    p.u3 = 1.2;
    p.tag = TAG.EMBER;
  }
  for (let i = 0; i < budget(4); i++) {
    const p = field.spawn(KIND.SMOKE);
    if (!p) break;
    p.x = at.x + (rand() - 0.5) * 0.4 * s;
    p.y = at.y + (rand() - 0.5) * 0.3 * s;
    p.z = at.z + (rand() - 0.5) * 0.4 * s;
    p.vx = forward.x * range(2, 5) + (rand() - 0.5);
    p.vy = forward.y * 2 + range(0.3, 1);
    p.vz = forward.z * range(2, 5) + (rand() - 0.5);
    p.drag = 3;
    p.gravity = -0.6;
    p.life = range(0.7, 1.1);
    p.u0 = 0.32;
    p.u1 = 0.4 * s;
    p.u2 = range(1.2, 1.6) * s;
    p.u3 = 0.2;
    p.r = p.g = p.b = range(0.07, 0.1);
    p.tag = TAG.SMOKE;
  }
}

function styleLaunchAndTrail(p: Particle, x: number) {
  switch (p.tag) {
    case TAG.FLAME:
      styleFlame(p, x, 0.46, 0.42, 0.25, 0.6);
      motionBlur(p, 1 / 75, 0.85);
      return true;
    case TAG.SMOKE:
      styleSmoke(p, x);
      return true;
    case TAG.EMBER:
      styleEmber(p, x, 1 / 40);
      return true;
    case TAG.FLASH:
      setEmission(p, 3200, 0.05 * Math.pow(1 - x, 2.5));
      return true;
  }
  return false;
}

/** A flash and spray at a mouth, for when the race wants it at the exact spot. */
export function createFireLaunch(position: THREE.Vector3, direction: THREE.Vector3, options: { scale?: number } = {}): Effect {
  const scale = options.scale ?? 1;
  const group = new THREE.Group();
  const field = new Field(budget(40));
  group.add(field.mesh);
  field.anchor.copy(position);
  const forward = direction.clone().normalize();
  let started = false;
  return {
    object: group,
    update(dt) {
      if (!started) {
        started = true;
        emitLaunch(field, position, forward, scale);
      }
      field.step(dt);
      for (const p of field.particles) styleLaunchAndTrail(p, p.age / p.life);
      field.write();
      return field.count > 0;
    },
    dispose() {
      field.dispose();
    },
  };
}

export function createFireball(options: { scale?: number } = {}): FireballEffect {
  const scale = options.scale ?? 1;
  const radius = 0.42 * scale;
  const root = new THREE.Group();
  const field = new Field(budget(300));
  root.add(field.mesh);

  const world = new THREE.Vector3();
  const prev = new THREE.Vector3();
  const velocity = new THREE.Vector3();
  const launchAt = new THREE.Vector3();
  let frames = 0;
  let time = 0;
  let flameDue = 0;
  let smokeDue = 0;
  let emberDue = 0;
  let coreDue = 0;
  let light: EffectLight | null = null;
  let lightTried = false;

  const coreRate = budget(60);
  const flameRate = budget(170);
  const smokeRate = budget(46);
  const emberRate = budget(44);

  const core = field.spawn(KIND.GLOW)!;
  core.local = true;
  core.life = Infinity;
  core.tag = TAG.CORE;
  core.size = radius * 2.3;
  const halo = field.spawn(KIND.GLOW)!;
  halo.local = true;
  halo.life = Infinity;
  halo.tag = TAG.HALO;
  halo.size = radius * 7.5;

  const emitAlong = (count: number, dt: number, make: (p: Particle, f: number) => void, kind: number) => {
    for (let i = 0; i < count; i++) {
      const p = field.spawn(kind);
      if (!p) return;
      const f = rand();
      p.x = prev.x + (world.x - prev.x) * f;
      p.y = prev.y + (world.y - prev.y) * f;
      p.z = prev.z + (world.z - prev.z) * f;
      make(p, f);
      // Born part-way through the frame: it has already lived a little.
      const head = (1 - f) * dt;
      p.age = head;
      p.x += p.vx * head;
      p.y += p.vy * head;
      p.z += p.vz * head;
    }
  };

  const effect: FireballEffect = {
    object: root,
    update(dt: number) {
      time += dt;
      root.getWorldPosition(world);
      if (frames === 0) {
        prev.copy(world);
        launchAt.copy(world);
      }
      frames += 1;
      if (dt > 0) {
        tmp.subVectors(world, prev).divideScalar(dt);
        // A fresh ball takes its speed at once; after that, smooth out jitter.
        if (frames <= 2) velocity.copy(tmp);
        else velocity.lerp(tmp, 1 - Math.exp(-dt * 20));
      }
      if (frames === 2 && velocity.lengthSq() > 1) emitLaunch(field, launchAt, dir.copy(velocity).normalize(), scale);
      if (!lightTried) {
        lightTried = true;
        light = borrowLight(blackbody(1900, color), 14);
      }

      if (frames > 1 && dt > 0) {
        // The ball itself: hot flames that churn in place round the centre.
        coreDue += dt * coreRate;
        while (coreDue >= 1) {
          coreDue -= 1;
          const p = field.spawn(KIND.FIRE);
          if (!p) break;
          p.local = true;
          randomDir(dir);
          const r = radius * 0.35 * Math.cbrt(rand());
          p.x = dir.x * r;
          p.y = dir.y * r;
          p.z = dir.z * r;
          randomDir(dir);
          p.vx = dir.x * 1.2;
          p.vy = dir.y * 1.2 + 0.4;
          p.vz = dir.z * 1.2;
          p.life = range(0.12, 0.2);
          p.u0 = range(2500, 2950);
          p.u1 = radius * range(1.5, 1.9);
          p.u2 = radius * range(2.0, 2.5);
          p.u3 = 0.5;
          p.spin = range(-9, 9);
          p.tag = TAG.CORE_FLAME;
        }
        flameDue += dt * flameRate;
        smokeDue += dt * smokeRate;
        emberDue += dt * emberRate;
        const flames = Math.floor(flameDue);
        const smokes = Math.floor(smokeDue);
        const embers = Math.floor(emberDue);
        flameDue -= flames;
        smokeDue -= smokes;
        emberDue -= embers;
        emitAlong(flames, dt, (p) => {
          randomDir(dir);
          const r = radius * Math.cbrt(rand()) * 0.55;
          p.x += dir.x * r;
          p.y += dir.y * r;
          p.z += dir.z * r;
          const keep = range(0.62, 0.93);
          randomDir(dir).multiplyScalar(range(1.2, 3.2) * Math.sqrt(scale));
          p.vx = velocity.x * keep + dir.x;
          p.vy = velocity.y * keep + dir.y + 0.6;
          p.vz = velocity.z * keep + dir.z;
          p.drag = 4.6;
          p.gravity = -2.6;
          p.life = range(0.15, 0.3);
          p.u0 = range(2150, 2650);
          p.u1 = radius * range(1.15, 1.6);
          p.u2 = radius * range(2.0, 2.7);
          p.u3 = 0.5;
          p.spin = range(-5, 5);
          p.tag = TAG.FLAME;
        }, KIND.FIRE);
        emitAlong(smokes, dt, (p) => {
          randomDir(dir);
          p.x += dir.x * radius * 0.6 - velocity.x * 0.012;
          p.y += dir.y * radius * 0.6;
          p.z += dir.z * radius * 0.6 - velocity.z * 0.012;
          const keep = range(0.12, 0.4);
          p.vx = velocity.x * keep + dir.x * 0.8;
          p.vy = velocity.y * keep + dir.y * 0.8 + 0.4;
          p.vz = velocity.z * keep + dir.z * 0.8;
          p.drag = 2.4;
          p.gravity = -0.7;
          p.life = range(0.6, 1.0);
          p.u0 = range(0.16, 0.24);
          p.u1 = radius * range(0.9, 1.2);
          p.u2 = radius * range(1.8, 2.5);
          p.u3 = 0.1;
          p.spin = range(-1, 1);
          const grey = range(0.1, 0.16);
          p.r = grey * 1.08;
          p.g = grey;
          p.b = grey * 0.92;
          p.tag = TAG.SMOKE;
        }, KIND.SMOKE);
        emitAlong(embers, dt, (p) => {
          randomDir(dir);
          p.x += dir.x * radius * 0.5;
          p.y += dir.y * radius * 0.5;
          p.z += dir.z * radius * 0.5;
          const keep = range(0.3, 0.8);
          randomDir(dir).multiplyScalar(range(2, 6));
          p.vx = velocity.x * keep + dir.x;
          p.vy = velocity.y * keep + dir.y + 1;
          p.vz = velocity.z * keep + dir.z;
          p.drag = 1.3;
          p.gravity = range(-1, 4);
          p.life = range(0.35, 0.85);
          p.size = range(0.022, 0.045) * Math.sqrt(scale);
          p.u0 = range(1900, 2700);
          p.u3 = 1;
          p.tag = TAG.EMBER;
        }, KIND.SPARK);
      }

      field.step(dt);
      field.anchor.copy(world);
      const flicker = 0.86 + 0.08 * Math.sin(time * 37) + 0.06 * Math.sin(time * 61 + 1.3);
      for (const p of field.particles) {
        if (p.delay > 0) continue;
        if (p.tag === TAG.CORE) {
          setEmission(p, 2950, 0.1 * flicker);
          p.sx = (velocity.x - VIEW.velocity.x * 0.9) / 70;
          p.sy = (velocity.y - VIEW.velocity.y * 0.9) / 70;
          p.sz = (velocity.z - VIEW.velocity.z * 0.9) / 70;
          continue;
        }
        if (p.tag === TAG.HALO) {
          setEmission(p, 1800, 0.035 * flicker);
          continue;
        }
        if (p.tag === TAG.CORE_FLAME) {
          const x = p.age / p.life;
          styleFlame(p, x, 0.3, 0.7, 0.55, 0.9);
          p.g *= 1 - smoothstep(0.6, 1, x);
          p.sx = (velocity.x - VIEW.velocity.x * 0.9) / 150;
          p.sy = (velocity.y - VIEW.velocity.y * 0.9) / 150;
          p.sz = (velocity.z - VIEW.velocity.z * 0.9) / 150;
          continue;
        }
        const x = p.age / p.life;
        styleLaunchAndTrail(p, x);
        if (p.tag === TAG.SMOKE) turbulence(p, time, 2, dt);
      }
      field.write();
      if (light) {
        light.light.position.copy(world);
        light.light.intensity = 3.2 * scale * scale * flicker;
      }
      prev.copy(world);
      return true;
    },
    explode(parent: THREE.Object3D) {
      const at = root.getWorldPosition(new THREE.Vector3());
      const explosion = createExplosion(at, scale, velocity.clone().multiplyScalar(0.06));
      parent.add(explosion.object);
      return explosion;
    },
    dispose() {
      field.dispose();
      returnLight(light);
      light = null;
    },
  };
  return effect;
}

/** A burst of fire: flash, shock, fireball, sparks, debris, smoke and a scorch mark. */
export function createExplosion(position: THREE.Vector3, scale = 1, carry: THREE.Vector3 = new THREE.Vector3()): Effect {
  const s = scale;
  const rs = Math.sqrt(s);
  const group = new THREE.Group();
  const field = new Field(budget(230));
  group.add(field.mesh);
  field.anchor.copy(position);
  const ground = position.y < 3.2;
  let time = 0;
  let light: EffectLight | null = null;
  let lightTried = false;

  const place = (p: Particle, spread: number) => {
    randomDir(dir);
    const r = spread * Math.cbrt(rand());
    p.x = position.x + dir.x * r;
    p.y = position.y + dir.y * r;
    p.z = position.z + dir.z * r;
    return dir;
  };

  let flash = field.spawn(KIND.GLOW);
  if (flash) {
    flash.x = position.x;
    flash.y = position.y;
    flash.z = position.z;
    flash.size = 3.2 * s;
    flash.life = 0.11;
    flash.tag = TAG.FLASH;
  }
  flash = field.spawn(KIND.GLOW);
  if (flash) {
    flash.x = position.x;
    flash.y = position.y;
    flash.z = position.z;
    flash.size = 5 * s;
    flash.life = 0.32;
    flash.tag = TAG.FLASH2;
  }
  const shock = field.spawn(KIND.RING);
  if (shock) {
    shock.x = position.x;
    shock.y = position.y;
    shock.z = position.z;
    shock.life = 0.3;
    shock.tag = TAG.SHOCK;
  }

  for (let i = 0; i < budget(24); i++) {
    const p = field.spawn(KIND.FIRE);
    if (!p) break;
    const d = place(p, 0.45 * s);
    const speed = range(3, 7.5) * rs;
    p.vx = d.x * speed + carry.x;
    p.vy = Math.abs(d.y) * speed * 0.8 + 1.4 + carry.y;
    p.vz = d.z * speed + carry.z;
    p.drag = 5.2;
    p.gravity = -3.2;
    p.life = range(0.55, 1.0);
    p.u0 = range(2400, 2850);
    p.u1 = range(0.6, 0.9) * s;
    p.u2 = range(1.4, 2.0) * s;
    p.u3 = 0.5;
    p.spin = range(-3, 3);
    p.tag = TAG.FLAME;
  }
  for (let i = 0; i < budget(58); i++) {
    const p = field.spawn(KIND.SPARK);
    if (!p) break;
    const d = place(p, 0.3 * s);
    d.y = Math.abs(d.y) * 0.85 + 0.15;
    d.normalize();
    const speed = range(7, 21) * rs;
    p.vx = d.x * speed + carry.x;
    p.vy = d.y * speed + carry.y;
    p.vz = d.z * speed + carry.z;
    p.gravity = 9.8;
    p.drag = 1.1;
    p.bounce = 0.32;
    p.life = range(0.45, 1.3);
    p.size = range(0.024, 0.05) * rs;
    p.u0 = range(2300, 3000);
    p.u3 = 1.3;
    p.tag = TAG.SPARK;
  }
  for (let i = 0; i < budget(11); i++) {
    const p = field.spawn(KIND.CLOD);
    if (!p) break;
    const d = place(p, 0.3 * s);
    d.y = Math.abs(d.y) * 0.7 + 0.3;
    const speed = range(4, 10) * rs;
    p.vx = d.x * speed + carry.x;
    p.vy = d.y * speed;
    p.vz = d.z * speed + carry.z;
    p.gravity = 9.8;
    p.drag = 0.6;
    p.bounce = 0.3;
    p.life = range(0.9, 1.6);
    p.size = range(0.06, 0.15) * s;
    p.spin = range(-12, 12);
    const tone = range(0.035, 0.07);
    p.r = tone * 1.15;
    p.g = tone;
    p.b = tone * 0.85;
    p.a = 1;
    p.tag = TAG.CHUNK;
  }
  // The smoke climbs away and thins within a couple of seconds, so a racer
  // behind it can still see the track; it grows less than linearly with size.
  const smokeScale = Math.pow(s, 0.8);
  for (let i = 0; i < budget(17); i++) {
    const p = field.spawn(KIND.SMOKE);
    if (!p) break;
    const d = place(p, 0.85 * s);
    const speed = range(0.8, 3.2) * rs;
    p.vx = d.x * speed + carry.x * 0.5;
    p.vy = Math.abs(d.y) * speed + range(1.4, 2.6);
    p.vz = d.z * speed + carry.z * 0.5;
    p.drag = 1.6;
    p.gravity = -1.6;
    p.life = range(1.8, 3.0);
    p.delay = range(0.12, 0.3);
    p.u0 = range(0.62, 0.8);
    p.u1 = range(0.8, 1.15) * smokeScale;
    p.u2 = range(2.0, 2.8) * smokeScale;
    p.u3 = range(0.05, 0.1);
    p.spin = range(-0.5, 0.5);
    const grey = range(0.045, 0.09);
    p.r = grey * 1.1;
    p.g = grey;
    p.b = grey * 0.9;
    p.tag = TAG.SMOKE;
  }
  for (let i = 0; i < budget(30); i++) {
    const p = field.spawn(KIND.SPARK);
    if (!p) break;
    const d = place(p, 0.7 * s);
    const speed = range(1, 5) * rs;
    p.vx = d.x * speed;
    p.vy = d.y * speed + range(1, 3);
    p.vz = d.z * speed;
    p.drag = 1.6;
    p.gravity = range(-1.2, 0.6);
    p.life = range(1.0, 2.6);
    p.size = range(0.016, 0.032) * rs;
    p.u0 = range(1750, 2350);
    p.u3 = 1;
    p.tag = TAG.EMBER;
  }
  if (ground) {
    for (let i = 0; i < budget(13); i++) {
      const p = field.spawn(KIND.SMOKE);
      if (!p) break;
      const a = rand() * Math.PI * 2;
      const r0 = range(0.2, 0.6) * s;
      p.x = position.x + Math.cos(a) * r0;
      p.y = 0.2 + rand() * 0.25;
      p.z = position.z + Math.sin(a) * r0;
      const speed = range(6, 12) * rs;
      p.vx = Math.cos(a) * speed;
      p.vy = range(0.2, 1.2);
      p.vz = Math.sin(a) * speed;
      p.drag = 3.6;
      p.gravity = -0.35;
      p.life = range(1.2, 2.1);
      p.delay = range(0.02, 0.06);
      p.u0 = range(0.4, 0.55);
      p.u1 = 0.5 * s;
      p.u2 = range(1.6, 2.2) * s;
      p.r = 0.44;
      p.g = 0.34;
      p.b = 0.23;
      p.tag = TAG.DUST;
    }
    const scorch = field.spawn(KIND.DECAL);
    if (scorch) {
      scorch.x = position.x;
      scorch.y = 0.035;
      scorch.z = position.z;
      scorch.sy = 1;
      scorch.size = 3.4 * s;
      scorch.life = 5;
      scorch.param = 0;
      scorch.tag = TAG.SCORCH;
    }
  }

  return {
    object: group,
    update(dt) {
      time += dt;
      if (!lightTried) {
        lightTried = true;
        light = borrowLight(blackbody(2600, color), 22);
        light?.light.position.copy(position);
      }
      field.step(dt);
      for (const p of field.particles) {
        if (p.delay > 0) continue;
        const x = p.age / p.life;
        switch (p.tag) {
          case TAG.FLASH:
            setEmission(p, 3600, 0.045 * Math.pow(1 - x, 3));
            break;
          case TAG.FLASH2:
            setEmission(p, 2500, 0.008 * Math.pow(1 - x, 2));
            break;
          case TAG.SHOCK: {
            const grow = 1 - Math.exp(-p.age / 0.07);
            p.size = (0.6 + 7.5 * grow) * s;
            p.param = 0.05;
            tmp.copy(VIEW.camera).sub(position);
            p.sx = tmp.x;
            p.sy = tmp.y;
            p.sz = tmp.z;
            setEmission(p, 2400, 0.02 * Math.pow(1 - x, 2));
            p.a = 0.12 * (1 - x);
            break;
          }
          case TAG.FLAME:
            styleFlame(p, x, 0.52, 0.86, 1, 0.22);
            motionBlur(p, 1 / 60, 0.7);
            break;
          case TAG.SPARK:
            styleEmber(p, x, 1 / 60);
            break;
          case TAG.EMBER:
            turbulence(p, time, 5, dt);
            styleEmber(p, x, 1 / 60);
            break;
          case TAG.CHUNK:
            break;
          case TAG.SMOKE:
            turbulence(p, time, 1.4, dt);
            styleSmoke(p, x);
            break;
          case TAG.DUST:
            styleSmoke(p, x);
            break;
          case TAG.SCORCH: {
            p.a = 0.88 * Math.min(1, p.age / 0.05) * (1 - smoothstep(0.62, 1, x));
            const glow = Math.max(0, 1 - p.age / 1.8);
            setEmission(p, 1150 + 700 * glow, 0.9 * glow * glow);
            break;
          }
        }
      }
      field.write();
      if (light) {
        const flicker = 0.85 + 0.15 * Math.sin(time * 53) * Math.sin(time * 31);
        const level = (0.75 * Math.exp(-time / 0.05) + 0.25 * Math.exp(-time / 0.22)) * flicker;
        light.light.color.copy(blackbody(1700 + 1300 * Math.exp(-time / 0.25), color));
        light.light.intensity = 55 * s * s * level;
        if (time > 1.1) {
          returnLight(light);
          light = null;
        }
      }
      return field.count > 0;
    },
    dispose() {
      field.dispose();
      returnLight(light);
      light = null;
    },
  };
}

/**
 * Flames licking a racer who was hit by fire. Parent the object to the
 * racer's group; it keeps itself in metres whatever the group's scale. The
 * flames, smoke and embers live in the world, so they stream behind a runner.
 * finish() stops the flames; the effect ends once the last smoke is gone.
 */
export function createBurnAura(options: { height?: number } = {}): ShieldEffect {
  const height = options.height ?? 2.15;
  const holder = new THREE.Group();
  const field = new Field(budget(150));
  holder.add(field.mesh);
  const world = new THREE.Vector3();
  const prev = new THREE.Vector3();
  const velocity = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const offset = new THREE.Vector3();
  let frames = 0;
  let time = 0;
  let emitting = true;
  let strength = 0;
  let flameDue = 0;
  let smokeDue = 0;
  let emberDue = 0;
  let light: EffectLight | null = null;
  let lightTried = false;
  const flameRate = budget(80);
  const smokeRate = budget(16);
  const emberRate = budget(22);

  const onBody = (p: Particle) => {
    // A point on the upper half of an ellipsoid round the body.
    randomDir(offset);
    offset.y = Math.abs(offset.y) * 0.9 + 0.1;
    offset.set(offset.x * 0.42, offset.y * 0.36, offset.z * 0.62).multiplyScalar(height / 2.15);
    offset.y += height * 0.42;
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
      frames += 1;
      if (dt > 0) {
        tmp.subVectors(world, prev).divideScalar(dt);
        if (tmp.lengthSq() > 60 * 60) tmp.set(0, 0, 0);
        velocity.lerp(tmp, 1 - Math.exp(-dt * 10));
      }
      prev.copy(world);
      strength = Math.max(0, Math.min(1, strength + (emitting ? dt * 5 : -dt * 3)));
      if (!lightTried) {
        lightTried = true;
        light = borrowLight(blackbody(1850, color), 9);
      }
      if (strength > 0) {
        flameDue += dt * flameRate * strength;
        smokeDue += dt * smokeRate * strength;
        emberDue += dt * emberRate * strength;
      }
      while (flameDue >= 1) {
        flameDue -= 1;
        const p = field.spawn(KIND.FIRE);
        if (!p) break;
        onBody(p);
        const keep = range(0.8, 0.96);
        p.vx = velocity.x * keep + (rand() - 0.5) * 0.8;
        p.vy = velocity.y * keep + range(1.5, 3);
        p.vz = velocity.z * keep + (rand() - 0.5) * 0.8;
        p.drag = 1.2;
        p.gravity = -4.5;
        p.life = range(0.2, 0.4);
        p.u0 = range(1950, 2450);
        p.u1 = range(0.3, 0.5);
        p.u2 = range(0.65, 1.0);
        p.u3 = 0.5;
        p.spin = range(-3, 3);
        p.tag = TAG.FLAME;
      }
      while (smokeDue >= 1) {
        smokeDue -= 1;
        const p = field.spawn(KIND.SMOKE);
        if (!p) break;
        onBody(p);
        p.y += 0.35;
        const keep = range(0.15, 0.4);
        p.vx = velocity.x * keep;
        p.vy = range(1.2, 2.2);
        p.vz = velocity.z * keep;
        p.drag = 2;
        p.gravity = -0.8;
        p.life = range(0.8, 1.4);
        p.u0 = range(0.26, 0.36);
        p.u1 = 0.35;
        p.u2 = range(1.3, 1.8);
        p.u3 = 0.3;
        const grey = range(0.05, 0.08);
        p.r = grey * 1.08;
        p.g = grey;
        p.b = grey * 0.92;
        p.tag = TAG.SMOKE;
      }
      while (emberDue >= 1) {
        emberDue -= 1;
        const p = field.spawn(KIND.SPARK);
        if (!p) break;
        onBody(p);
        randomDir(dir).multiplyScalar(range(1, 3));
        const keep = range(0.4, 0.8);
        p.vx = velocity.x * keep + dir.x;
        p.vy = velocity.y * keep + Math.abs(dir.y) + 1.5;
        p.vz = velocity.z * keep + dir.z;
        p.drag = 1.4;
        p.gravity = range(-1.5, 1);
        p.life = range(0.5, 1.1);
        p.size = range(0.018, 0.032);
        p.u0 = range(1900, 2500);
        p.u3 = 1;
        p.tag = TAG.EMBER;
      }
      field.step(dt);
      field.anchor.copy(world);
      for (const p of field.particles) {
        const x = p.age / p.life;
        if (p.tag === TAG.SMOKE) turbulence(p, time, 1.5, dt);
        if (p.tag === TAG.EMBER) turbulence(p, time, 4, dt);
        styleLaunchAndTrail(p, x);
      }
      field.write();
      if (light) {
        const flicker = 0.8 + 0.12 * Math.sin(time * 29) + 0.08 * Math.sin(time * 47 + 2);
        light.light.position.set(world.x, world.y + height * 0.6, world.z);
        light.light.intensity = 6 * strength * flicker;
        if (!emitting && strength <= 0) {
          returnLight(light);
          light = null;
        }
      }
      return emitting || field.count > 0;
    },
    finish() {
      emitting = false;
    },
    dispose() {
      field.dispose();
      returnLight(light);
      light = null;
    },
  };
}
