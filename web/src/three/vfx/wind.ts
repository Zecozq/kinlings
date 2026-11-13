// Wind Dash: what moving air really shows. Dust and clods kicked off the
// ground, a ring of condensed vapour where the racer punches through the air,
// thin streams of vapour peeling back along the path, and dust motes that
// streak with real motion blur against the moving camera.

import * as THREE from "three";
import { Field, KIND, SHARED, VIEW, budget, rand, range, turbulence } from "./core.ts";
import type { Effect } from "./types.ts";

const TAG = { DUST: 1, CLOD: 2, RING: 3, WISP: 4, MOTE: 5 } as const;
const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export interface WindOptions {
  length?: number;
  /** The kick of a cast: dust off the ground and a vapour ring. Default: length >= 10. */
  burst?: boolean;
}

export function createWindDash(position: THREE.Vector3, direction: THREE.Vector3, options: WindOptions = {}): Effect {
  const length = options.length ?? 7;
  const burst = options.burst ?? length >= 10;
  const dir = direction.clone().normalize();
  const side = new THREE.Vector3(0, 1, 0).cross(dir).normalize();
  if (side.lengthSq() < 0.5) side.set(1, 0, 0);
  const upAxis = new THREE.Vector3().crossVectors(dir, side).normalize();
  const group = new THREE.Group();
  const field = new Field(budget(burst ? 170 : 60));
  group.add(field.mesh);
  field.anchor.copy(position);
  const ground = SHARED.uGround.value;
  let time = 0;

  // Vapour streams: chains of stretched wisps along gently curving paths.
  const streams = burst ? budget(10) : Math.max(1, budget(3));
  const segments = 7;
  for (let s = 0; s < streams; s++) {
    const angle = rand() * Math.PI * 2;
    const radius = burst ? range(0.45, 1.5) : range(0, 0.6);
    const offset = side.clone().multiplyScalar(Math.cos(angle) * radius).addScaledVector(upAxis, Math.sin(angle) * radius * 0.7);
    const reach = length * range(0.55, 1);
    const curl = range(-0.6, 0.6);
    const lift = range(-0.1, 0.4);
    const rush = burst ? range(9, 16) : range(4, 8);
    const width = burst ? range(0.05, 0.12) : range(0.04, 0.09);
    const opacity = burst ? range(0.16, 0.28) : range(0.1, 0.2);
    const point = (t: number, out: THREE.Vector3) =>
      out
        .copy(position)
        .add(offset)
        .addScaledVector(dir, -0.15 * reach + t * reach * 1.15)
        .addScaledVector(side, Math.sin(t * 2.4 + angle) * curl * t)
        .addScaledVector(upAxis, lift * t * t);
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    for (let k = 0; k < segments; k++) {
      const p = field.spawn(KIND.WISP);
      if (!p) break;
      point(k / segments, a);
      point((k + 1) / segments, b);
      p.x = b.x;
      p.y = b.y;
      p.z = b.z;
      p.sx = b.x - a.x;
      p.sy = b.y - a.y;
      p.sz = b.z - a.z;
      const drift = range(0.3, 0.9);
      p.vx = offset.x * drift + dir.x * rush;
      p.vy = offset.y * drift * 0.5 + 0.1;
      p.vz = offset.z * drift + dir.z * rush;
      p.y = Math.max(p.y, ground + 0.55);
      p.drag = 2.2;
      p.life = range(0.3, 0.46);
      p.delay = k * 0.018 + s * 0.006;
      p.u0 = opacity;
      p.u1 = width;
      p.r = p.g = p.b = 0.92;
      p.tag = TAG.WISP;
    }
  }

  // Dust motes the air carries, which smear against the camera's motion.
  const motes = burst ? budget(36) : budget(9);
  for (let i = 0; i < motes; i++) {
    const p = field.spawn(KIND.SPARK);
    if (!p) break;
    const along = range(-0.2, 1) * length;
    const angle = rand() * Math.PI * 2;
    const radius = range(0.3, burst ? 2.6 : 1.2);
    p.x = position.x + dir.x * along + side.x * Math.cos(angle) * radius;
    p.y = Math.max(ground + 0.15, position.y + Math.sin(angle) * radius * 0.6);
    p.z = position.z + dir.z * along + side.z * Math.cos(angle) * radius;
    const speed = range(5, 13);
    p.vx = dir.x * speed;
    p.vy = (rand() - 0.5) * 0.6;
    p.vz = dir.z * speed;
    p.drag = 0.8;
    p.life = range(0.35, 0.7);
    p.delay = range(0, 0.15);
    p.size = range(0.012, 0.022);
    p.u0 = range(0.5, 1.1);
    p.tag = TAG.MOTE;
  }

  if (burst) {
    const feet = new THREE.Vector3(position.x, ground, position.z);
    for (let i = 0; i < budget(15); i++) {
      const p = field.spawn(KIND.SMOKE);
      if (!p) break;
      const across = (rand() - 0.5) * 1.2;
      p.x = feet.x + side.x * across;
      p.y = ground + range(0.1, 0.35);
      p.z = feet.z + side.z * across;
      const speed = range(3, 9);
      const out = (rand() - 0.5) * 4;
      p.vx = dir.x * speed + side.x * out;
      p.vy = range(0.4, 1.6);
      p.vz = dir.z * speed + side.z * out;
      p.drag = 2.6;
      p.gravity = -0.25;
      p.life = range(1.0, 1.7);
      p.delay = range(0, 0.08);
      p.u0 = range(0.4, 0.55);
      p.u1 = range(0.35, 0.6);
      p.u2 = range(1.6, 2.3);
      p.spin = range(-1, 1);
      p.r = 0.5;
      p.g = 0.4;
      p.b = 0.28;
      p.tag = TAG.DUST;
    }
    for (let i = 0; i < budget(7); i++) {
      const p = field.spawn(KIND.CLOD);
      if (!p) break;
      p.x = feet.x + (rand() - 0.5) * 0.6;
      p.y = ground + 0.1;
      p.z = feet.z + (rand() - 0.5) * 0.6;
      const speed = range(3, 7);
      p.vx = dir.x * speed + (rand() - 0.5) * 2;
      p.vy = range(2, 4.5);
      p.vz = dir.z * speed + (rand() - 0.5) * 2;
      p.gravity = 9.8;
      p.bounce = 0.3;
      p.life = range(0.7, 1.1);
      p.size = range(0.035, 0.08);
      p.spin = range(-10, 10);
      p.r = 0.3;
      p.g = 0.22;
      p.b = 0.14;
      p.a = 1;
      p.tag = TAG.CLOD;
    }
    const ring = field.spawn(KIND.RING);
    if (ring) {
      ring.x = position.x - dir.x * 0.3;
      ring.y = position.y;
      ring.z = position.z - dir.z * 0.3;
      ring.sx = dir.x;
      ring.sy = dir.y;
      ring.sz = dir.z;
      ring.life = 0.38;
      ring.param = 0.12;
      ring.tag = TAG.RING;
    }
  }

  return {
    object: group,
    update(dt) {
      time += dt;
      field.step(dt);
      const cam = VIEW.velocity;
      for (const p of field.particles) {
        if (p.delay > 0) continue;
        const x = p.age / p.life;
        switch (p.tag) {
          case TAG.WISP:
            p.t = x;
            p.size = p.u1 * (1 + x * 2.2);
            p.a = p.u0 * smoothstep(0, 0.15, x) * (1 - smoothstep(0.35, 1, x));
            break;
          case TAG.MOTE: {
            const level = p.u0 * Math.min(1, x * 6) * (1 - x);
            p.r = 1.0 * level;
            p.g = 0.95 * level;
            p.b = 0.86 * level;
            p.sx = (p.vx - cam.x) / 35;
            p.sy = (p.vy - cam.y) / 35;
            p.sz = (p.vz - cam.z) / 35;
            break;
          }
          case TAG.DUST:
            turbulence(p, time, 1.2, dt);
            p.t = x;
            p.size = p.u1 + (p.u2 - p.u1) * (1 - Math.pow(1 - x, 2));
            p.a = p.u0 * smoothstep(0, 0.08, x) * (1 - smoothstep(0.35, 1, x));
            break;
          case TAG.RING: {
            p.size = 1.2 + 3.6 * (1 - Math.exp(-p.age / 0.12));
            const level = 0.55 * Math.pow(1 - x, 1.5);
            p.r = level;
            p.g = level;
            p.b = level * 1.05;
            p.a = 0.06 * (1 - x);
            break;
          }
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
