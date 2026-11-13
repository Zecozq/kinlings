// Blink Step and Second Wind.
//
// Blink: light implodes where the racer leaves, streaks rushing into a
// point that collapses and pops; where they arrive, a lens-flare pop and
// motes of light that collapse onto their body as it re-forms. The default
// "pop" mode plays a short version of both, for blocks and dodges too.
//
// Second Wind: a breath of warm light, a double helix of motes rising round
// the racer, a ring on the ground and a glow that swells in the chest.

import * as THREE from "three";
import { Field, KIND, VIEW, budget, rand, randomDir, range, type Particle } from "./core.ts";
import type { Effect } from "./types.ts";

const TAG = { STREAK: 1, CORE: 2, FLASH: 3, STAR: 4, GHOST: 5, ANAMORPHIC: 6, RING: 7, SPARKLE: 8, MOTE: 9, COLUMN: 10, HELIX: 11, GROUND: 12, CHEST: 13 } as const;
const tmp = new THREE.Vector3();
const color = new THREE.Color();

function emit(p: Particle, c: THREE.Color, level: number) {
  p.r = c.r * level;
  p.g = c.g * level;
  p.b = c.b * level;
}

export interface BlinkOptions {
  color?: THREE.ColorRepresentation;
  /** "depart": implode and vanish; "arrive": pop and re-form; "pop" (default): a short version of both. */
  mode?: "pop" | "depart" | "arrive";
}

export function createBlinkShimmer(position: THREE.Vector3, options: BlinkOptions = {}): Effect {
  const tint = new THREE.Color(options.color ?? "#d8c8ff");
  // Light from a magic source is still light: keep it bright near the middle, tinted at the edges.
  const white = tint.clone().lerp(new THREE.Color(1, 1, 1), 0.35);
  const mode = options.mode ?? "pop";
  const implode = mode !== "arrive";
  const popAt = mode === "arrive" ? 0 : mode === "depart" ? 0.2 : 0.13;
  const popSize = mode === "depart" ? 0.65 : 1;
  const group = new THREE.Group();
  const field = new Field(budget(120));
  group.add(field.mesh);
  field.anchor.copy(position);
  let time = 0;
  let popped = false;

  if (implode) {
    // Streaks of light rushing in from all round to one point.
    const count = budget(mode === "depart" ? 34 : 26);
    for (let i = 0; i < count; i++) {
      const p = field.spawn(KIND.SPARK);
      if (!p) break;
      const d = randomDir(new THREE.Vector3());
      d.y *= 0.8;
      const r = range(1.4, 2.6);
      p.u0 = d.x * r;
      p.u1 = d.y * r + 0.1;
      p.u2 = d.z * r;
      p.u3 = range(0.6, 1);
      p.x = position.x + p.u0;
      p.y = position.y + p.u1;
      p.z = position.z + p.u2;
      p.life = popAt + 0.02;
      p.delay = range(0, popAt * 0.35);
      p.size = range(0.018, 0.04);
      p.tag = TAG.STREAK;
    }
    const core = field.spawn(KIND.GLOW);
    if (core) {
      core.x = position.x;
      core.y = position.y + 0.1;
      core.z = position.z;
      core.life = popAt + 0.04;
      core.tag = TAG.CORE;
    }
  }

  const pop = () => {
    popped = true;
    const at = (p: Particle) => {
      p.x = position.x;
      p.y = position.y + 0.1;
      p.z = position.z;
    };
    const flash = field.spawn(KIND.GLOW);
    if (flash) {
      at(flash);
      flash.size = 3.4 * popSize;
      flash.life = 0.28;
      flash.tag = TAG.FLASH;
    }
    const star = field.spawn(KIND.STAR);
    if (star) {
      at(star);
      star.size = 5.5 * popSize;
      star.life = 0.34;
      star.param = 1;
      star.rot = rand() * 0.5;
      star.tag = TAG.STAR;
    }
    // Lens flare: an anamorphic streak and ghosts along the line through the screen centre.
    const streak = field.spawn(KIND.FLARE);
    if (streak) {
      at(streak);
      streak.size = 0.018 * popSize;
      streak.sx = 1;
      streak.sy = 22;
      streak.param = 1;
      streak.life = 0.36;
      streak.tag = TAG.ANAMORPHIC;
    }
    const ghosts = [
      [0.55, 0.05, 2],
      [0.2, 0.025, 0],
      [-0.25, 0.04, 0],
      [-0.6, 0.075, 2],
      [-1.05, 0.03, 0],
    ];
    for (const [k, size, shape] of ghosts) {
      const p = field.spawn(KIND.FLARE);
      if (!p) break;
      at(p);
      p.size = size * popSize;
      p.sx = k;
      p.sy = 1;
      p.param = shape;
      p.life = 0.38;
      p.u0 = 0.4 + rand() * 0.6;
      p.tag = TAG.GHOST;
    }
    const ring = field.spawn(KIND.RING);
    if (ring) {
      at(ring);
      ring.life = 0.4;
      ring.param = 0.035;
      ring.tag = TAG.RING;
    }
    const sparkles = budget(mode === "depart" ? 14 : 30);
    for (let i = 0; i < sparkles; i++) {
      const p = field.spawn(KIND.STAR);
      if (!p) break;
      at(p);
      const d = randomDir(new THREE.Vector3());
      const speed = range(1, 4.5) * popSize;
      p.vx = d.x * speed;
      p.vy = d.y * speed + 0.4;
      p.vz = d.z * speed;
      p.drag = 3;
      p.gravity = -0.2;
      p.life = range(0.45, 0.95);
      p.size = range(0.06, 0.16);
      p.param = rand() < 0.3 ? 1 : 0;
      p.u0 = range(5, 14);
      p.tag = TAG.SPARKLE;
    }
    if (mode !== "depart") {
      // Motes of light that collapse onto the body as it re-forms.
      for (let i = 0; i < budget(40); i++) {
        const p = field.spawn(KIND.SPARK);
        if (!p) break;
        const d = randomDir(new THREE.Vector3());
        const r = range(1.6, 2.8);
        // Where it lands: somewhere on the racer's body.
        const land = randomDir(new THREE.Vector3()).multiply(tmp.set(0.45, 0.55, 0.6));
        p.u0 = land.x;
        p.u1 = land.y + 0.05;
        p.u2 = land.z;
        p.ox = d.x * r;
        p.oy = d.y * r * 0.8;
        p.oz = d.z * r;
        p.x = position.x + p.ox;
        p.y = position.y + p.oy;
        p.z = position.z + p.oz;
        p.life = range(0.32, 0.5);
        p.delay = range(0.02, 0.1);
        p.size = range(0.035, 0.07);
        p.u3 = range(0.6, 1);
        p.tag = TAG.MOTE;
      }
      const column = field.spawn(KIND.GLOW);
      if (column) {
        column.x = position.x;
        column.y = position.y + 1.4;
        column.z = position.z;
        column.sy = 2.6;
        column.size = 0.7;
        column.life = 0.4;
        column.tag = TAG.COLUMN;
      }
    }
  };

  return {
    object: group,
    update(dt) {
      time += dt;
      if (!popped && time >= popAt) pop();
      field.step(dt);
      const toCam = tmp.copy(VIEW.camera).sub(position);
      for (const p of field.particles) {
        if (p.delay > 0) continue;
        const x = p.age / p.life;
        switch (p.tag) {
          case TAG.STREAK: {
            // Accelerating inwards; stretched along the path it has come.
            const k = Math.min(1, p.age / Math.max(0.01, p.life - 0.02));
            const pull = 1 - k * k * k;
            p.x = position.x + p.u0 * pull;
            p.y = position.y + p.u1 * pull;
            p.z = position.z + p.u2 * pull;
            const trail = 0.25 + 0.75 * k;
            p.sx = -p.u0 * 0.35 * trail;
            p.sy = -p.u1 * 0.35 * trail;
            p.sz = -p.u2 * 0.35 * trail;
            emit(p, white, (0.5 + 3.5 * k) * p.u3);
            break;
          }
          case TAG.CORE: {
            // The point everything falls into: shrinking and heating up.
            const k = Math.min(1, p.age / popAt);
            p.size = 2.2 * (1 - k) + 0.25;
            emit(p, white, 0.4 + 5 * k * k);
            break;
          }
          case TAG.FLASH:
            emit(p, white, 7 * Math.pow(1 - x, 2.5));
            break;
          case TAG.STAR:
            p.size = 5.5 * popSize * (0.6 + 0.4 * x);
            emit(p, white, 5 * Math.pow(1 - x, 2));
            break;
          case TAG.ANAMORPHIC:
            emit(p, tint, 2.4 * Math.pow(1 - x, 1.6));
            break;
          case TAG.GHOST:
            color.copy(tint).lerp(new THREE.Color(0.5, 0.85, 1), p.u0 * 0.5);
            emit(p, color, 0.45 * p.u0 * Math.pow(1 - x, 1.4));
            break;
          case TAG.RING:
            p.size = (0.5 + 3.4 * (1 - Math.exp(-p.age / 0.1))) * popSize;
            p.sx = toCam.x;
            p.sy = toCam.y;
            p.sz = toCam.z;
            emit(p, white, 1.6 * Math.pow(1 - x, 2));
            p.a = 0;
            break;
          case TAG.SPARKLE: {
            const flicker = 0.5 + 0.5 * Math.sin(p.age * p.u0 * 3 + p.seed * 20);
            emit(p, white, (0.6 + 2.4 * flicker) * (1 - x));
            break;
          }
          case TAG.MOTE: {
            // Rushing in to the body, then fading into it; blurred along the way it moves.
            const k = Math.min(1, p.age / p.life);
            const ease = 1 - Math.pow(1 - k, 3);
            const nx = position.x + p.ox * (1 - ease) + p.u0 * ease;
            const ny = position.y + p.oy * (1 - ease) + p.u1 * ease;
            const nz = position.z + p.oz * (1 - ease) + p.u2 * ease;
            const blur = 1 / (110 * Math.max(dt, 1e-3));
            p.sx = (nx - p.x) * blur;
            p.sy = (ny - p.y) * blur;
            p.sz = (nz - p.z) * blur;
            p.x = nx;
            p.y = ny;
            p.z = nz;
            emit(p, white, (1.2 + 2 * (1 - k)) * p.u3 * Math.min(1, k * 5));
            break;
          }
          case TAG.COLUMN:
            emit(p, tint, 1.3 * Math.pow(1 - x, 2) * Math.min(1, x * 8));
            break;
        }
      }
      field.write();
      return field.count > 0 || !popped;
    },
    dispose() {
      field.dispose();
    },
  };
}

/**
 * Second Wind: parent the object to the racer's group (it keeps itself in
 * metres whatever the group's scale). It plays for about 1.6 s and ends by
 * itself; its light rises with the racer as they run.
 */
export function createSecondWind(options: { height?: number; color?: THREE.ColorRepresentation } = {}): Effect {
  const height = options.height ?? 2.15;
  const accent = new THREE.Color(options.color ?? "#ffb7d5");
  // Warm sunlight gold, with the accent in the halo.
  const gold = new THREE.Color(1, 0.78, 0.45);
  const holder = new THREE.Group();
  const field = new Field(budget(130));
  holder.add(field.mesh);
  const world = new THREE.Vector3();
  let time = 0;
  let started = false;

  const begin = () => {
    // Two strands of motes winding up round the body.
    const per = budget(22);
    for (let strand = 0; strand < 2; strand++) {
      for (let i = 0; i < per; i++) {
        const p = field.spawn(KIND.GLOW);
        if (!p) break;
        p.local = true;
        p.u0 = strand * Math.PI + i * 0.18;
        p.u1 = range(0.85, 1.1);
        p.u2 = range(0.9, 1.2);
        p.u3 = rand();
        p.life = range(1.0, 1.35);
        p.delay = i * 0.022;
        p.size = range(0.1, 0.16);
        p.tag = TAG.HELIX;
      }
    }
    const ground = field.spawn(KIND.RING);
    if (ground) {
      ground.local = true;
      ground.y = 0.06;
      ground.sy = 1;
      ground.life = 0.9;
      ground.param = 0.05;
      ground.tag = TAG.GROUND;
    }
    const chest = field.spawn(KIND.GLOW);
    if (chest) {
      chest.local = true;
      chest.y = height * 0.5;
      chest.life = 1.2;
      chest.tag = TAG.CHEST;
    }
    const column = field.spawn(KIND.GLOW);
    if (column) {
      column.local = true;
      column.y = height * 1.1;
      column.sy = height * 1.1;
      column.size = 1.1;
      column.life = 1.1;
      column.tag = TAG.COLUMN;
    }
    for (let i = 0; i < budget(26); i++) {
      const p = field.spawn(KIND.STAR);
      if (!p) break;
      p.local = true;
      const a = rand() * Math.PI * 2;
      const r = range(0.2, 0.8);
      p.x = Math.cos(a) * r;
      p.y = range(0.1, height);
      p.z = Math.sin(a) * r;
      p.vy = range(0.6, 1.6);
      p.drag = 0.8;
      p.life = range(0.7, 1.3);
      p.delay = range(0.1, 0.7);
      p.size = range(0.05, 0.13);
      p.u0 = range(6, 14);
      p.param = rand() < 0.3 ? 1 : 0;
      p.tag = TAG.SPARKLE;
    }
  };

  return {
    object: holder,
    update(dt) {
      time += dt;
      holder.getWorldPosition(world);
      if (!started) {
        started = true;
        begin();
      }
      field.step(dt);
      field.anchor.copy(world);
      for (const p of field.particles) {
        if (p.delay > 0) continue;
        const x = p.age / p.life;
        switch (p.tag) {
          case TAG.HELIX: {
            // Up the helix, the coil tightening as it climbs.
            const climb = 1 - Math.pow(1 - x, 1.6);
            const angle = p.u0 + climb * 7.5;
            const r = p.u1 * (1 - 0.3 * climb);
            const y = 0.05 + climb * height * p.u2;
            const nx = Math.cos(angle) * r;
            const nz = Math.sin(angle) * r;
            const tangentX = -Math.sin(angle) * r * 7.5;
            const tangentZ = Math.cos(angle) * r * 7.5;
            p.x = nx;
            p.y = y;
            p.z = nz;
            const speed = 1 / p.life;
            p.sx = tangentX * speed * 0.03;
            p.sy = height * p.u2 * speed * 0.03;
            p.sz = tangentZ * speed * 0.03;
            color.copy(gold).lerp(accent, p.u3 * 0.5);
            emit(p, color, 7 * Math.min(1, x * 6) * (1 - x));
            break;
          }
          case TAG.GROUND:
            p.size = 0.6 + 2.6 * (1 - Math.exp(-p.age / 0.22));
            color.copy(gold).lerp(accent, 0.3);
            emit(p, color, 2.6 * Math.pow(1 - x, 1.5));
            p.a = 0;
            break;
          case TAG.CHEST: {
            // Breathe in, then out.
            const swell = Math.sin(Math.PI * Math.min(1, x * 1.15));
            p.size = 1.2 + 1.4 * swell;
            color.copy(gold).lerp(accent, 0.45);
            emit(p, color, 2.2 * swell * swell);
            break;
          }
          case TAG.COLUMN:
            color.copy(gold).lerp(accent, 0.5);
            emit(p, color, 0.55 * Math.sin(Math.PI * x));
            break;
          case TAG.SPARKLE: {
            const flicker = 0.5 + 0.5 * Math.sin(p.age * p.u0 * 2.5 + p.seed * 20);
            color.copy(gold).lerp(accent, p.seed * 0.6);
            emit(p, color, (0.8 + 3.2 * flicker) * Math.min(1, x * 5) * (1 - x));
            break;
          }
        }
      }
      field.write();
      return field.count > 0 || !started;
    },
    dispose() {
      field.dispose();
    },
  };
}
