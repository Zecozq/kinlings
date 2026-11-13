// Dust and dirt from feet, and a generic impact burst.

import * as THREE from "three";
import { Field, KIND, SHARED, budget, heat, motionBlur, rand, randomDir, range, turbulence } from "./core.ts";
import type { Effect } from "./types.ts";

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** The track's dirt, lit by the sun: a dusty tan with a little variation. */
const DIRT = new THREE.Color(0.52, 0.4, 0.27);

export function createDustPuffs(position: THREE.Vector3, options: { count?: number } = {}): Effect {
  const count = options.count ?? 18;
  const big = count > 10;
  const group = new THREE.Group();
  const field = new Field(Math.max(4, budget(Math.ceil(count * 2.1) + 4)));
  group.add(field.mesh);
  field.anchor.copy(position);
  const ground = SHARED.uGround.value;
  const spread = big ? 0.7 : 0.45;
  let time = 0;
  for (let i = 0; i < budget(count); i++) {
    const p = field.spawn(KIND.SMOKE);
    if (!p) break;
    const a = rand() * Math.PI * 2;
    const r = Math.sqrt(rand()) * spread;
    p.x = position.x + Math.cos(a) * r;
    p.y = Math.max(ground + 0.08, position.y - 0.05 + rand() * 0.2);
    p.z = position.z + Math.sin(a) * r;
    const speed = range(0.6, big ? 3 : 2);
    p.vx = Math.cos(a) * speed;
    p.vy = range(0.3, big ? 1.8 : 1.1);
    p.vz = Math.sin(a) * speed;
    p.drag = 3.2;
    p.gravity = -0.15;
    p.life = range(0.7, big ? 1.6 : 1.2);
    p.u0 = range(0.32, 0.5);
    p.u1 = range(0.2, 0.35) * (big ? 1.5 : 1);
    p.u2 = range(0.8, 1.2) * (big ? 1.6 : 1);
    p.spin = range(-1.2, 1.2);
    const tone = range(0.85, 1.12);
    p.r = DIRT.r * tone;
    p.g = DIRT.g * tone;
    p.b = DIRT.b * tone;
    p.tag = 1;
  }
  // Dirt clods: small dark lumps that arc out and bounce.
  for (let i = 0; i < budget(Math.ceil(count * 0.7)); i++) {
    const p = field.spawn(KIND.CLOD);
    if (!p) break;
    const a = rand() * Math.PI * 2;
    p.x = position.x + Math.cos(a) * spread * 0.5;
    p.y = Math.max(ground + 0.05, position.y);
    p.z = position.z + Math.sin(a) * spread * 0.5;
    const speed = range(1, big ? 3.6 : 2.4);
    p.vx = Math.cos(a) * speed;
    p.vy = range(1.6, big ? 4.2 : 3.2);
    p.vz = Math.sin(a) * speed;
    p.gravity = 9.8;
    p.drag = 0.4;
    p.bounce = 0.32;
    p.life = range(0.55, 0.95);
    p.size = range(0.025, big ? 0.07 : 0.05);
    p.spin = range(-12, 12);
    const tone = range(0.45, 0.7);
    p.r = DIRT.r * tone;
    p.g = DIRT.g * tone;
    p.b = DIRT.b * tone;
    p.a = 1;
    p.tag = 2;
  }
  return {
    object: group,
    update(dt) {
      time += dt;
      field.step(dt);
      for (const p of field.particles) {
        if (p.tag !== 1) continue;
        const x = p.age / p.life;
        turbulence(p, time, 0.8, dt);
        p.t = x;
        p.size = p.u1 + (p.u2 - p.u1) * (1 - Math.pow(1 - x, 2.2));
        p.a = p.u0 * smoothstep(0, 0.07, x) * (1 - smoothstep(0.3, 1, x));
      }
      field.write();
      return field.count > 0;
    },
    dispose() {
      field.dispose();
    },
  };
}

/**
 * A hit: a flash, hot sparks thrown out and bouncing, a puff of dust. For a
 * shield taking a blow, a racer crashing, or anything that needs a bang.
 */
export function createImpactSparks(position: THREE.Vector3, options: { count?: number; kelvin?: number; scale?: number } = {}): Effect {
  const count = options.count ?? 36;
  const kelvin = options.kelvin ?? 2900;
  const scale = options.scale ?? 1;
  const group = new THREE.Group();
  const field = new Field(budget(count + 12));
  group.add(field.mesh);
  field.anchor.copy(position);
  const color = new THREE.Color();
  const flash = field.spawn(KIND.GLOW);
  if (flash) {
    flash.x = position.x;
    flash.y = position.y;
    flash.z = position.z;
    flash.size = 1.8 * scale;
    flash.life = 0.12;
    flash.tag = 1;
  }
  for (let i = 0; i < budget(count); i++) {
    const p = field.spawn(KIND.SPARK);
    if (!p) break;
    const d = randomDir(new THREE.Vector3());
    d.y = Math.abs(d.y) * 0.8 + 0.2;
    d.normalize();
    const speed = range(3, 11) * Math.sqrt(scale);
    p.x = position.x;
    p.y = position.y;
    p.z = position.z;
    p.vx = d.x * speed;
    p.vy = d.y * speed;
    p.vz = d.z * speed;
    p.gravity = 9.8;
    p.drag = 1.2;
    p.bounce = 0.35;
    p.life = range(0.3, 0.8);
    p.size = range(0.015, 0.035) * Math.sqrt(scale);
    p.u0 = kelvin * range(0.85, 1.12);
    p.tag = 2;
  }
  for (let i = 0; i < budget(6); i++) {
    const p = field.spawn(KIND.SMOKE);
    if (!p) break;
    p.x = position.x + (rand() - 0.5) * 0.3;
    p.y = position.y + (rand() - 0.5) * 0.3;
    p.z = position.z + (rand() - 0.5) * 0.3;
    const d = randomDir(new THREE.Vector3()).multiplyScalar(range(0.5, 1.5));
    p.vx = d.x;
    p.vy = d.y + 0.5;
    p.vz = d.z;
    p.drag = 2.5;
    p.gravity = -0.3;
    p.life = range(0.6, 1.0);
    p.u0 = 0.3;
    p.u1 = 0.25 * scale;
    p.u2 = 0.9 * scale;
    p.r = 0.4;
    p.g = 0.36;
    p.b = 0.32;
    p.tag = 3;
  }
  return {
    object: group,
    update(dt) {
      field.step(dt);
      for (const p of field.particles) {
        const x = p.age / p.life;
        if (p.tag === 1) {
          heat(kelvin + 600, 0.08 * Math.pow(1 - x, 2), color);
          p.r = color.r;
          p.g = color.g;
          p.b = color.b;
        } else if (p.tag === 2) {
          heat(p.u0 * (1 - 0.4 * x), 0.5 * (1 - x * x), color);
          p.r = color.r;
          p.g = color.g;
          p.b = color.b;
          motionBlur(p, 1 / 60, 0.5);
        } else {
          p.t = x;
          p.size = p.u1 + (p.u2 - p.u1) * (1 - Math.pow(1 - x, 2));
          p.a = p.u0 * Math.min(1, x / 0.08) * (1 - x);
        }
      }
      field.write();
      return field.count > 0;
    },
    dispose() {
      field.dispose();
    },
  };
}
