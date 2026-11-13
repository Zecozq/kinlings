// A Kinling in real-time 3D, built entirely in code from its Look.
//
//   buildKin(look, { level, generation, detail? }) -> Kin3D
//     group   THREE.Group to add to a scene. Faces +Z with feet on y = 0.
//     update(dt, pose)  Run each frame with a KinPose.
//     dispose()         Frees the per-creature GPU resources.
//   kinSize(level)      World size for a level, the 3D sizeForLevel.
//
// The body is sculpted as signed-distance blends and baked into cached
// geometry (see sculpt.ts), one per head type and detail level, so a farm of
// creatures shares its meshes and each creature costs a handful of draw calls.

import * as THREE from "three";
import { sizeForLevel, type Look } from "../creature.ts";
import { GLSL_NOISE, TAU, clamp, lerp, rng, smooth } from "./gfx.ts";
import { PartBuilder, Sculpt, blade, sweep, type ShapeData, type V3 } from "./sculpt.ts";

export interface KinPose {
  /** 0 idle .. 1 full run. */
  speed: number;
  airborne: boolean;
  /** 0..1, smile, bounce and happy eyes. */
  joy: number;
  /** 0..1, stumble or burn. */
  hurt: number;
  /** 0..1, ice over the creature. */
  frozen: number;
  /** 0..1, mouth open, spitting. */
  attack: number;
}

export interface Kin3D {
  group: THREE.Group;
  update(dt: number, pose: KinPose): void;
  dispose(): void;
  /** Approximate top of the creature in world units (scaled). */
  height: number;
  /** Point the head and eyes towards this offset, in creature space. */
  look(offset: THREE.Vector3 | null): void;
  /** Tell the creature how bright the surrounding light is (0 night .. 1 day). */
  setDaylight(day: number): void;
}

export interface KinOptions {
  level: number;
  generation: number;
  /** "high" for portraits and the hero view, "low" (default) mid-distance, "far" for valley crowds. */
  detail?: "high" | "low" | "far";
}

export const IDLE_POSE: KinPose = { speed: 0, airborne: false, joy: 0, hurt: 0, frozen: 0, attack: 0 };

/** Size for a level, in the same range as the 2D art. */
export function kinSize(level: number): number {
  return sizeForLevel(level) * 1.05;
}

// ----- Skeleton --------------------------------------------------------------

const B = {
  root: 0, hips: 1, chest: 2, neck0: 3, neck1: 4, head: 5, jaw: 6, earL: 7, earR: 8,
  tail0: 9, tail1: 10, tail2: 11, tail3: 12, tail4: 13,
  flU: 14, flL: 15, flP: 16, frU: 17, frL: 18, frP: 19,
  hlU: 20, hlL: 21, hlP: 22, hrU: 23, hrL: 24, hrP: 25,
  wLa: 26, wLb: 27, wLc: 28, wRa: 29, wRb: 30, wRc: 31,
} as const;
const BONE_COUNT = 32;

const TAIL_POINTS: V3[] = [
  [0, 0.66, -0.68],
  [0, 0.66, -0.98],
  [0, 0.74, -1.26],
  [0, 0.94, -1.46],
  [0, 1.2, -1.56],
];

type SkinKind = "scale" | "fur" | "shag" | "hide" | "feather";

interface HeadSpec {
  skin: SkinKind;
  head: V3;
  eye: { x: number; y: number; z: number; r: number; yaw: number; pitch: number };
  neckA: V3;
  neckB: V3;
  neckRa: number;
  neckRb: number;
  bulk: number;
  legs: number;
  /** Local head offset of the jaw hinge. */
  jaw: V3;
  ear: V3;
}

const HEADS: HeadSpec[] = [
  {
    // Snout: dragons and drakes.
    skin: "scale",
    head: [0, 1.13, 0.62],
    eye: { x: 0.24, y: 0.1, z: 0.2, r: 0.2, yaw: 0.5, pitch: -0.05 },
    neckA: [0, 0.76, 0.32],
    neckB: [0, 1.02, 0.56],
    neckRa: 0.27,
    neckRb: 0.2,
    bulk: 1,
    legs: 1,
    jaw: [0, -0.13, 0.07],
    ear: [0.26, 0.2, -0.17],
  },
  {
    // Muzzle: foxes and kitsune.
    skin: "fur",
    head: [0, 1.12, 0.6],
    eye: { x: 0.21, y: 0.075, z: 0.24, r: 0.19, yaw: 0.38, pitch: -0.08 },
    neckA: [0, 0.76, 0.32],
    neckB: [0, 1.0, 0.54],
    neckRa: 0.26,
    neckRb: 0.19,
    bulk: 0.97,
    legs: 0.94,
    jaw: [0, -0.1, 0.1],
    ear: [0.22, 0.32, -0.02],
  },
  {
    // Long face: horses, unicorns, kirin.
    skin: "hide",
    head: [0, 1.24, 0.66],
    eye: { x: 0.24, y: 0.11, z: 0.1, r: 0.175, yaw: 0.72, pitch: -0.1 },
    neckA: [0, 0.78, 0.3],
    neckB: [0, 1.16, 0.58],
    neckRa: 0.26,
    neckRb: 0.18,
    bulk: 0.96,
    legs: 1.05,
    jaw: [0, -0.2, 0.2],
    ear: [0.18, 0.34, -0.1],
  },
  {
    // Beak: griffins, rocs, phoenixes.
    skin: "feather",
    head: [0, 1.14, 0.6],
    eye: { x: 0.24, y: 0.09, z: 0.21, r: 0.19, yaw: 0.45, pitch: -0.05 },
    neckA: [0, 0.76, 0.32],
    neckB: [0, 1.02, 0.54],
    neckRa: 0.27,
    neckRb: 0.21,
    bulk: 0.98,
    legs: 0.96,
    jaw: [0, -0.1, 0.18],
    ear: [0.28, 0.14, -0.16],
  },
  {
    // Bear face: yetis, golems.
    skin: "shag",
    head: [0, 1.08, 0.56],
    eye: { x: 0.23, y: 0.09, z: 0.25, r: 0.185, yaw: 0.34, pitch: -0.06 },
    neckA: [0, 0.76, 0.3],
    neckB: [0, 0.98, 0.5],
    neckRa: 0.32,
    neckRb: 0.28,
    bulk: 1.1,
    legs: 1.16,
    jaw: [0, -0.15, 0.2],
    ear: [0.29, 0.32, -0.04],
  },
];

function restPositions(head: number): V3[] {
  const spec = HEADS[head];
  const H = spec.head;
  const positions: V3[] = new Array(BONE_COUNT);
  const add = (index: number, p: V3) => {
    positions[index] = p;
  };
  add(B.root, [0, 0, 0]);
  add(B.hips, [0, 0.6, -0.38]);
  add(B.chest, [0, 0.62, 0.18]);
  add(B.neck0, spec.neckA);
  add(B.neck1, [(spec.neckA[0] + spec.neckB[0]) / 2, (spec.neckA[1] + spec.neckB[1]) / 2, (spec.neckA[2] + spec.neckB[2]) / 2]);
  add(B.head, H);
  add(B.jaw, [H[0] + spec.jaw[0], H[1] + spec.jaw[1], H[2] + spec.jaw[2]]);
  add(B.earL, [H[0] + spec.ear[0], H[1] + spec.ear[1], H[2] + spec.ear[2]]);
  add(B.earR, [H[0] - spec.ear[0], H[1] + spec.ear[1], H[2] + spec.ear[2]]);
  TAIL_POINTS.forEach((p, i) => add(B.tail0 + i, p));
  // Legs. Side: +1 for the creature's left (+x).
  const leg = (u: number, side: number, front: boolean) => {
    const z = front ? 0.3 : -0.42;
    const x = side * 0.25;
    add(u, [x, 0.54, z]);
    add(u + 1, [x + side * 0.02, 0.3, z + (front ? 0 : 0.08)]);
    add(u + 2, [x + side * 0.02, 0.13, z + (front ? 0.02 : -0.06)]);
  };
  leg(B.flU, 1, true);
  leg(B.frU, -1, true);
  leg(B.hlU, 1, false);
  leg(B.hrU, -1, false);
  // Wings, spread out in the bind pose.
  const wing = (a: number, side: number) => {
    add(a, [side * 0.22, 0.96, 0.13]);
    add(a + 1, [side * 0.66, 1.12, 0.08]);
    add(a + 2, [side * 1.02, 1.36, -0.02]);
  };
  wing(B.wLa, 1);
  wing(B.wRa, -1);
  return positions;
}

/** Bones are parented so local positions are the differences of rest positions. */
const BONE_PARENT: number[] = (() => {
  const parents = new Array(BONE_COUNT).fill(-1) as number[];
  const set = (bone: number, parent: number) => {
    parents[bone] = parent;
  };
  set(B.hips, B.root);
  set(B.chest, B.hips);
  set(B.neck0, B.chest);
  set(B.neck1, B.neck0);
  set(B.head, B.neck1);
  set(B.jaw, B.head);
  set(B.earL, B.head);
  set(B.earR, B.head);
  set(B.tail0, B.hips);
  for (let i = 1; i < 5; i++) set(B.tail0 + i, B.tail0 + i - 1);
  for (const u of [B.flU, B.frU]) {
    set(u, B.chest);
    set(u + 1, u);
    set(u + 2, u + 1);
  }
  for (const u of [B.hlU, B.hrU]) {
    set(u, B.hips);
    set(u + 1, u);
    set(u + 2, u + 1);
  }
  for (const a of [B.wLa, B.wRa]) {
    set(a, B.chest);
    set(a + 1, a);
    set(a + 2, a + 1);
  }
  return parents;
})();

// ----- Sculpting the body and head -------------------------------------------

const TAG = { skin: 0, accent: 1, nose: 2, claw: 3, mouth: 4, tooth: 5, hoof: 6, beak: 7, cream: 8, pure: 9 } as const;
const TAG_COLOURS: Record<number, THREE.Color> = {
  [TAG.nose]: new THREE.Color("#2a2028"),
  [TAG.claw]: new THREE.Color("#e8dcc1"),
  [TAG.mouth]: new THREE.Color("#a33a4f"),
  [TAG.tooth]: new THREE.Color("#fff7ea"),
  [TAG.hoof]: new THREE.Color("#3d3030"),
  [TAG.beak]: new THREE.Color("#f0a93a"),
  [TAG.cream]: new THREE.Color("#fff3df"),
};
const TAG_COUNT = 10;

const MOUTH_FOOTPRINT = [
  { zMin: 0.1, zMax: 0.72, x: 0.2, y: -0.1 },
  { zMin: 0.12, zMax: 0.62, x: 0.13, y: -0.12 },
  { zMin: 0.3, zMax: 0.76, x: 0.14, y: -0.32 },
  { zMin: 0.24, zMax: 0.68, x: 0.12, y: -0.02 },
  { zMin: 0.18, zMax: 0.52, x: 0.15, y: -0.2 },
];

function makeMaskFn(head: number) {
  const spec = HEADS[head];
  const H = spec.head;
  return (
    x: number,
    y: number,
    z: number,
    _nx: number,
    _ny: number,
    _nz: number,
    tags: Float32Array,
    _ao: number,
    out: Float32Array,
    color: Float32Array,
  ) => {
    // Belly: the soft pale patch, like the 2D art's accent oval.
    const bx = x / 0.36;
    const by = (y - 0.36) / 0.24;
    const bz = (z - 0.1) / 0.52;
    const bellyField = bx * bx + by * by + bz * bz;
    let belly = 1 - smooth(0.74, 1.05, bellyField);
    // Chest bib on the front of the neck for feathered and furry creatures.
    const cx = x / 0.2;
    const cy = (y - 0.72) / 0.32;
    const cz = (z - 0.5) / 0.22;
    const bib = 1 - smooth(0.7, 1.1, cx * cx + cy * cy + cz * cz);
    if (head === 1 || head === 3 || head === 4) belly = Math.max(belly, bib);

    let accent = belly * smooth(0.2, 0.6, tags[TAG.skin] + tags[TAG.accent]);
    accent = Math.max(accent, smooth(0.3, 0.7, tags[TAG.accent]));
    // Pure accent regions read as values 1..2.
    if (tags[TAG.pure] > 0.3) accent = Math.max(accent, 1 + smooth(0.3, 0.8, tags[TAG.pure]));
    out[1] = accent;

    // Special colours: exact albedo regardless of the look. Hard parts (nose,
    // claws, beak, hooves, mouth) read as 0..1; cream fur reads as 0..-1, so it
    // keeps its coat and fur shells.
    let hard = 0;
    let total = 0;
    let sr = 0;
    let sg = 0;
    let sb = 0;
    for (const key in TAG_COLOURS) {
      const t = Number(key);
      if (tags[t] <= 0) continue;
      const c = TAG_COLOURS[t];
      total += tags[t];
      if (t !== TAG.cream) hard += tags[t];
      sr += c.r * tags[t];
      sg += c.g * tags[t];
      sb += c.b * tags[t];
    }
    if (total > 0) {
      const cream = tags[TAG.cream];
      out[2] = hard >= cream ? smooth(0.3, 0.7, hard) : -smooth(0.3, 0.7, cream);
      color[0] = sr / total;
      color[1] = sg / total;
      color[2] = sb / total;
    } else {
      out[2] = 0;
    }

    // Patterns live on the body, thinning out over the head and lower legs.
    const dh = Math.hypot(x - H[0], y - H[1], z - H[2]);
    const onHead = 1 - smooth(0.34, 0.5, dh);
    const onLeg = 1 - smooth(0.16, 0.32, y);
    out[3] = (1 - onHead * 0.75) * (1 - onLeg * 0.7) * (1 - smooth(0.4, 0.75, accent));
  };
}

function addLeg(S: Sculpt, u: number, side: number, front: boolean, spec: HeadSpec, head: number) {
  const zHip = front ? 0.3 : -0.42;
  const x = side * 0.25;
  const t = spec.legs;
  const kneeZ = zHip + (front ? 0 : 0.08);
  const ankleZ = zHip + (front ? 0.02 : -0.06);
  const pawZ = ankleZ + (head === 2 ? 0.01 : 0.04);
  const pawY = head === 2 ? 0.075 : 0.065;
  // Thigh or shoulder bulge blending into the torso.
  S.ell([x * 0.98, 0.5, zHip], [0.15 * t, 0.22, 0.17 * t], { k: 0.14, bone: u });
  S.cone([x, 0.5, zHip], 0.135 * t, [x + side * 0.02, 0.3, kneeZ], 0.11 * t, { k: 0.08, bone: u, bone2: u + 1 });
  S.cone([x + side * 0.02, 0.3, kneeZ], 0.11 * t, [x + side * 0.02, 0.13, ankleZ], 0.088 * t, { k: 0.05, bone: u + 1, bone2: u + 2 });

  if (head === 2) {
    // Hoof: slim leg with a dark rounded hoof.
    S.cone([x + side * 0.02, 0.13, ankleZ], 0.09 * t, [x + side * 0.02, 0.06, ankleZ + 0.015], 0.11 * t, { k: 0.02, bone: u + 2 });
    S.ell([x + side * 0.02, 0.048, ankleZ + 0.015], [0.115 * t, 0.05, 0.125 * t], { k: 0.012, bone: u + 2, tag: TAG.hoof });
    S.ell([x + side * 0.02, 0.095, ankleZ + 0.015], [0.1 * t, 0.03, 0.11 * t], { k: 0.03, bone: u + 2, tag: TAG.cream });
    return;
  }

  S.ell([x + side * 0.02, pawY, pawZ], [0.115 * t, 0.075, 0.15 * t], { k: 0.05, bone: u + 2, tag: head === 3 && front ? TAG.beak : TAG.skin });
  // Toes with little claws.
  for (const toe of [-1, 0, 1]) {
    const tx = x + side * 0.02 + toe * 0.065 * t;
    const tz = pawZ + 0.13 * t - Math.abs(toe) * 0.02;
    const clawTag = head === 3 && front ? TAG.claw : TAG.claw;
    S.sphere([tx, 0.05, tz], 0.04 * t, { k: 0.025, bone: u + 2, tag: head === 3 && front ? TAG.beak : TAG.skin });
    if (head === 1 || head === 4) {
      S.cone([tx, 0.05, tz + 0.03 * t], 0.018, [tx, 0.03, tz + 0.075 * t], 0.006, { k: 0.008, bone: u + 2, tag: clawTag });
    } else {
      S.cone([tx, 0.06, tz + 0.03], 0.024, [tx, 0.022, tz + 0.1 * t], 0.006, { k: 0.008, bone: u + 2, tag: clawTag });
    }
  }
}

function sculptBase(head: number): Sculpt {
  const spec = HEADS[head];
  const S = new Sculpt();
  const H = spec.head;
  const at = (x: number, y: number, z: number): V3 => [H[0] + x, H[1] + y, H[2] + z];
  const b = spec.bulk;

  // Torso.
  S.cone([0, 0.6, -0.42], 0.3 * b, [0, 0.6, -0.12], 0.315 * b, { k: 0, bone: B.hips, bone2: B.chest });
  S.cone([0, 0.6, -0.12], 0.315 * b, [0, 0.62, 0.18], 0.335 * b, { k: 0.02, bone: B.chest });
  S.sphere([0, 0.635, 0.26], 0.325 * b, { k: 0.1, bone: B.chest });
  S.ell([0, 0.64, -0.48], [0.31 * b, 0.32 * b, 0.26], { k: 0.12, bone: B.hips });

  // Neck, blended well into the shoulders.
  S.cone(spec.neckA, spec.neckRa, spec.neckB, spec.neckRb, { k: 0.16, bone: B.neck0, bone2: B.neck1 });

  addLeg(S, B.flU, 1, true, spec, head);
  addLeg(S, B.frU, -1, true, spec, head);
  addLeg(S, B.hlU, 1, false, spec, head);
  addLeg(S, B.hrU, -1, false, spec, head);

  // A short stub where the tail joins; the tail itself is a separate piece.
  S.cone([0, 0.64, -0.62], 0.14, [0, 0.66, -0.76], 0.1, { k: 0.08, bone: B.hips });

  // Head.
  switch (head) {
    case 0: {
      // Skull, broad across the brow.
      S.ell(at(0, 0.03, -0.03), [0.385, 0.355, 0.385], { k: 0.14, bone: B.head });
      // Long upper snout with a bump over the eyes and flared nostrils.
      S.cone(at(0, 0.0, 0.2), 0.235, at(0, -0.04, 0.62), 0.14, { k: 0.12, bone: B.head });
      S.cone(at(0, 0.11, 0.2), 0.13, at(0, 0.04, 0.58), 0.085, { k: 0.1, bone: B.head });
      for (const s of [1, -1]) {
        S.sphere(at(s * 0.082, 0.0, 0.7), 0.06, { k: 0.055, bone: B.head });
        // Heavy brow ridges give the face its look.
        S.cone(at(s * 0.12, 0.26, 0.2), 0.07, at(s * 0.31, 0.23, 0.1), 0.055, { k: 0.08, bone: B.head });
        S.sphere(at(s * 0.26, -0.13, 0.12), 0.15, { k: 0.1, bone: B.head });
        // Two small upper teeth peeking out.
        S.cone(at(s * 0.09, -0.15, 0.5), 0.025, at(s * 0.095, -0.21, 0.51), 0.006, { k: 0.004, bone: B.head, tag: TAG.tooth });
        // Fin-like ear at the back of the jaw.
        const ear = spec.ear;
        S.cone(at(s * ear[0], ear[1], ear[2]), 0.1, at(s * (ear[0] + 0.3), ear[1] + 0.12, ear[2] - 0.36), 0.012, {
          k: 0.06,
          bone: s > 0 ? B.earL : B.earR,
          tag: TAG.pure,
        });
        S.cone(at(s * ear[0], ear[1] - 0.1, ear[2]), 0.075, at(s * (ear[0] + 0.26), ear[1] - 0.18, ear[2] - 0.32), 0.01, {
          k: 0.05,
          bone: s > 0 ? B.earL : B.earR,
          tag: TAG.pure,
        });
      }
      // Nostrils.
      for (const s of [1, -1]) S.carveSphere(at(s * 0.085, 0.02, 0.765), 0.024, { k: 0.02, tag: TAG.nose });
      break;
    }
    case 1: {
      S.ell(at(0, 0.03, -0.02), [0.39, 0.355, 0.375], { k: 0.14, bone: B.head });
      // Tapered fox muzzle ending in a neat nose.
      S.cone(at(0, -0.05, 0.22), 0.19, at(0, -0.09, 0.58), 0.085, { k: 0.12, bone: B.head });
      S.cone(at(0, -0.15, 0.24), 0.135, at(0, -0.13, 0.52), 0.056, { k: 0.08, bone: B.head, tag: TAG.cream });
      S.sphere(at(0, -0.05, 0.66), 0.055, { k: 0.018, bone: B.head, tag: TAG.nose });
      for (const s of [1, -1]) {
        S.sphere(at(s * 0.26, -0.13, 0.11), 0.125, { k: 0.1, bone: B.head, tag: TAG.cream });
        // A small soft ruff at the cheek.
        S.sphere(at(s * 0.33, -0.18, 0.05), 0.075, { k: 0.07, bone: B.head, tag: TAG.cream });
        // Big triangular ears, hollowed in front.
        const ear = spec.ear;
        S.cone(at(s * ear[0], ear[1], ear[2]), 0.15, at(s * (ear[0] + 0.1), ear[1] + 0.44, ear[2] - 0.04), 0.018, {
          k: 0.06,
          bone: s > 0 ? B.earL : B.earR,
        });
      }
      for (const s of [1, -1]) {
        const ear = spec.ear;
        S.carveCone(at(s * ear[0], ear[1] + 0.05, ear[2] + 0.13), 0.1, at(s * (ear[0] + 0.09), ear[1] + 0.34, ear[2] + 0.05), 0.012, { k: 0.02, tag: TAG.accent });
      }
      break;
    }
    case 2: {
      S.ell(at(0, 0.08, -0.06), [0.335, 0.34, 0.36], { k: 0.14, bone: B.head });
      // Long tapered face angled down.
      S.cone(at(0, 0.02, 0.16), 0.235, at(0, -0.22, 0.56), 0.165, { k: 0.12, bone: B.head });
      // Muzzle in the accent colour.
      S.ell(at(0, -0.3, 0.62), [0.165, 0.135, 0.165], { k: 0.08, bone: B.head, tag: TAG.accent });
      for (const s of [1, -1]) {
        S.sphere(at(s * 0.26, -0.03, 0.03), 0.11, { k: 0.1, bone: B.head });
        // Upright ears.
        const ear = spec.ear;
        S.cone(at(s * ear[0], ear[1], ear[2]), 0.095, at(s * (ear[0] + 0.05), ear[1] + 0.36, ear[2] - 0.07), 0.018, {
          k: 0.05,
          bone: s > 0 ? B.earL : B.earR,
        });
      }
      for (const s of [1, -1]) {
        const ear = spec.ear;
        S.carveCone(at(s * ear[0], ear[1] + 0.04, ear[2] + 0.085), 0.065, at(s * (ear[0] + 0.05), ear[1] + 0.3, ear[2] + 0.03), 0.012, { k: 0.015, tag: TAG.accent });
        // Nostrils.
        S.carveEll(at(s * 0.085, -0.3, 0.775), [0.03, 0.035, 0.03], { k: 0.02, tag: TAG.nose });
      }
      break;
    }
    case 3: {
      S.ell(at(0, 0.03, -0.02), [0.39, 0.37, 0.385], { k: 0.14, bone: B.head });
      for (const s of [1, -1]) {
        // Feather tufts at the back of the head.
        const ear = spec.ear;
        S.cone(at(s * ear[0], ear[1], ear[2]), 0.11, at(s * (ear[0] + 0.14), ear[1] + 0.28, ear[2] - 0.2), 0.012, {
          k: 0.05,
          bone: s > 0 ? B.earL : B.earR,
          tag: TAG.pure,
        });
        S.cone(at(s * (ear[0] - 0.02), ear[1] - 0.08, ear[2] - 0.05), 0.09, at(s * (ear[0] + 0.2), ear[1] - 0.02, ear[2] - 0.28), 0.012, {
          k: 0.05,
          bone: s > 0 ? B.earL : B.earR,
        });
        S.sphere(at(s * 0.25, -0.12, 0.12), 0.14, { k: 0.1, bone: B.head });
        S.cone(at(s * 0.3, -0.11, 0.05), 0.09, at(s * 0.5, -0.27, -0.1), 0.012, { k: 0.05, bone: B.head });
      }
      // Upper beak, gently hooked.
      S.cone(at(0, 0.06, 0.28), 0.175, at(0, 0.0, 0.6), 0.1, { k: 0.04, bone: B.head, tag: TAG.beak });
      S.cone(at(0, 0.0, 0.58), 0.1, at(0, -0.12, 0.72), 0.03, { k: 0.05, bone: B.head, tag: TAG.beak });
      S.cone(at(0, -0.03, 0.7), 0.05, at(0, -0.19, 0.75), 0.01, { k: 0.02, bone: B.head, tag: TAG.beak });
      for (const s of [1, -1]) S.carveEll(at(s * 0.07, 0.04, 0.6), [0.018, 0.022, 0.028], { k: 0.012, tag: TAG.nose });
      break;
    }
    default: {
      S.ell(at(0, 0.02, -0.02), [0.425, 0.395, 0.4], { k: 0.14, bone: B.head });
      // Rounded muzzle patch.
      S.ell(at(0, -0.1, 0.33), [0.235, 0.17, 0.2], { k: 0.09, bone: B.head, tag: TAG.accent });
      S.sphere(at(0, -0.015, 0.5), 0.075, { k: 0.025, bone: B.head, tag: TAG.nose });
      for (const s of [1, -1]) {
        S.sphere(at(s * 0.29, -0.1, 0.14), 0.15, { k: 0.1, bone: B.head });
        // Round ears.
        const ear = spec.ear;
        S.ell(at(s * ear[0], ear[1], ear[2]), [0.145, 0.145, 0.07], { k: 0.06, bone: s > 0 ? B.earL : B.earR });
      }
      for (const s of [1, -1]) {
        const ear = spec.ear;
        S.carveEll(at(s * ear[0], ear[1], ear[2] + 0.07), [0.095, 0.095, 0.07], { k: 0.02, tag: TAG.accent });
      }
      break;
    }
  }

  return S;
}

interface EyePlace {
  /** Head-local centre of the +x eye. */
  center: THREE.Vector3;
  /** Outward direction of the +x eye. */
  dir: THREE.Vector3;
  surface: THREE.Vector3;
  r: number;
}

const placements = new Map<number, EyePlace>();

/** Finds where the eye sits so the head's surface folds around it. */
function eyePlace(head: number): EyePlace {
  const cached = placements.get(head);
  if (cached) return cached;
  const spec = HEADS[head];
  const E = spec.eye;
  const base = sculptBase(head);
  base.prepare();
  const H = spec.head;
  const dir = new THREE.Vector3(E.x, E.y, E.z).normalize();
  let t = 0.1;
  for (; t < 1.3; t += 0.01) {
    if (base.fieldAt(H[0] + dir.x * t, H[1] + dir.y * t, H[2] + dir.z * t) > 0) break;
  }
  const r = E.r;
  const protrude = 0.05;
  const center = dir.clone().multiplyScalar(t - r + protrude);
  const place = { center, dir, surface: dir.clone().multiplyScalar(t), r };
  placements.set(head, place);
  return place;
}

function sculptMain(head: number, cell: number): ShapeData {
  const spec = HEADS[head];
  const S = sculptBase(head);
  const H = spec.head;

  // Eye sockets: an almond opening cut into the face, the eye sits behind it.
  const place = eyePlace(head);
  for (const s of [1, -1]) {
    const dx = s * place.dir.x;
    const dy = place.dir.y;
    const dz = place.dir.z;
    const beta = Math.asin(Math.max(-1, Math.min(1, dx)));
    const alpha = -Math.asin(Math.max(-1, Math.min(1, dy / Math.max(0.2, Math.cos(beta)))));
    const c: V3 = [H[0] + s * place.surface.x, H[1] + place.surface.y, H[2] + place.surface.z];
    void dz;
    S.carveEll(c, [place.r * 0.92, place.r * 0.74, 0.11], { k: 0.035, rot: [alpha, beta, 0] });
  }

  const baseMask = makeMaskFn(head);
  return S.build(cell, (x, y, z, nx, ny, nz, tags, ao, out, color) => {
    baseMask(x, y, z, nx, ny, nz, tags, ao, out, color);
    // The underside of the upper jaw is painted as the roof of the mouth. It
    // only shows when the lower jaw swings down.
    const relX = x - H[0];
    const relY = y - H[1];
    const relZ = z - H[2];
    const m = MOUTH_FOOTPRINT[head];
    // Soft edges so the boundary never shows the triangles of the mesh.
    const mouth = smooth(-0.35, -0.72, ny) * smooth(m.y + 0.02, m.y - 0.05, relY) * smooth(m.zMin, m.zMin + 0.06, relZ) * smooth(m.zMax, m.zMax - 0.06, relZ) * smooth(m.x, m.x * 0.75, Math.abs(relX));
    if (mouth > 0) {
      out[2] = Math.max(out[2], mouth);
      if (mouth > 0.02) {
        out[1] = out[1] * (1 - mouth);
        color[0] = TAG_COLOURS[TAG.mouth].r;
        color[1] = TAG_COLOURS[TAG.mouth].g;
        color[2] = TAG_COLOURS[TAG.mouth].b;
      }
    }
  }, TAG_COUNT, 0.04);
}

/** The lower jaw is a separate shell, so opening it never stretches the face. */
function sculptJaw(head: number, cell: number): ShapeData {
  const spec = HEADS[head];
  const H = spec.head;
  const at = (x: number, y: number, z: number): V3 => [H[0] + x, H[1] + y, H[2] + z];
  const S = new Sculpt();
  const tongueTag = { k: 0.012, bone: B.jaw, tag: TAG.mouth };
  switch (head) {
    case 0:
      S.cone(at(0, -0.21, 0.1), 0.135, at(0, -0.19, 0.56), 0.085, { k: 0, bone: B.jaw });
      S.sphere(at(0, -0.2, 0.6), 0.082, { k: 0.04, bone: B.jaw });
      S.cone(at(0, -0.115, 0.12), 0.08, at(0, -0.125, 0.56), 0.05, { k: 0.02, bone: B.jaw, tag: TAG.mouth });
      for (const s of [1, -1]) S.cone(at(s * 0.08, -0.15, 0.46), 0.02, at(s * 0.09, -0.09, 0.47), 0.005, { k: 0.004, bone: B.jaw, tag: TAG.tooth });
      break;
    case 1:
      S.cone(at(0, -0.195, 0.18), 0.1, at(0, -0.165, 0.55), 0.052, { k: 0, bone: B.jaw, tag: TAG.cream });
      S.cone(at(0, -0.12, 0.2), 0.058, at(0, -0.115, 0.52), 0.028, { k: 0.02, bone: B.jaw, tag: TAG.mouth });
      break;
    case 2:
      S.cone(at(0, -0.33, 0.3), 0.105, at(0, -0.41, 0.6), 0.08, { k: 0, bone: B.jaw });
      S.ell(at(0, -0.44, 0.62), [0.1, 0.06, 0.12], { k: 0.05, bone: B.jaw, tag: TAG.accent });
      S.cone(at(0, -0.31, 0.36), 0.055, at(0, -0.34, 0.6), 0.038, tongueTag);
      break;
    case 3:
      S.cone(at(0, -0.12, 0.26), 0.12, at(0, -0.16, 0.56), 0.05, { k: 0, bone: B.jaw, tag: TAG.beak });
      S.cone(at(0, -0.06, 0.26), 0.05, at(0, -0.1, 0.5), 0.02, tongueTag);
      break;
    default:
      S.ell(at(0, -0.21, 0.35), [0.145, 0.08, 0.16], { k: 0, bone: B.jaw, tag: TAG.accent });
      S.ell(at(0, -0.14, 0.35), [0.1, 0.045, 0.12], tongueTag);
      break;
  }
  return S.build(cell, makeMaskFn(head), TAG_COUNT, 0.04);
}

const mainCache = new Map<string, THREE.BufferGeometry>();

const CELL: Record<string, [number, number]> = { high: [0.02, 0.016], low: [0.05, 0.04], far: [0.082, 0.07] };

function mainGeometry(head: number, detail: "high" | "low" | "far"): THREE.BufferGeometry {
  const key = `${head}:${detail}`;
  let geometry = mainCache.get(key);
  if (!geometry) {
    const builder = new PartBuilder();
    const cells = CELL[detail];
    builder.addShape(sculptMain(head, cells[0]));
    builder.addShape(sculptJaw(head, cells[1]));
    addHeadDressing(builder, head);
    geometry = builder.toGeometry();
    mainCache.set(key, geometry);
  }
  return geometry;
}

/** Hair and feather locks. These share the main material and skeleton. */
function addHeadDressing(builder: PartBuilder, head: number) {
  const spec = HEADS[head];
  const H = spec.head;
  if (head === 2) {
    // Flowing mane down the neck, with a forelock.
    const rand = rng(42);
    const nA = spec.neckA;
    const nB = spec.neckB;
    for (let i = 0; i < 18; i++) {
      const t = i / 17;
      const side = i % 2 ? 1 : -1;
      const along = t * 0.95;
      const root = new THREE.Vector3(
        side * 0.03,
        lerp(H[1] + 0.3, nA[1] + 0.25, along),
        lerp(H[2] - 0.08, nA[2] - 0.16, along),
      );
      const length = 0.36 + rand() * 0.16;
      const axis = new THREE.Vector3(side * (0.35 + rand() * 0.2), -0.9, -0.28).normalize();
      const sideV = new THREE.Vector3(0, 0.3, 1).normalize();
      const bone = along < 0.35 ? B.neck1 : B.neck0;
      blade(builder, root, axis, sideV, length, 0.17, 0.08, {
        segments: 6,
        color: () => new THREE.Color(1, 1, 1),
        mask: (s) => [0.75 + s * 0.25, 2, 0, 0],
        bones: () => ({ bones: [bone, B.chest, 0, 0], weights: [1, 0, 0, 0] }),
        bend: new THREE.Vector3(side, 0, 0),
      });
    }
    // Forelock.
    for (const s of [1, 0, -1]) {
      const root = new THREE.Vector3(s * 0.05, H[1] + 0.4, H[2] + 0.02);
      const axis = new THREE.Vector3(s * 0.3, -0.5, 0.82).normalize();
      blade(builder, root, axis, new THREE.Vector3(1, 0, 0), 0.32, 0.14, -0.04, {
        segments: 6,
        color: () => new THREE.Color(1, 1, 1),
        mask: (t) => [0.85 + t * 0.15, 2, 0, 0],
        bones: () => ({ bones: [B.head, 0, 0, 0], weights: [1, 0, 0, 0] }),
      });
    }
    void nB;
  }
}

// ----- Eyes -----------------------------------------------------------------

const eyeCache = new Map<string, THREE.BufferGeometry>();

function eyeGeometry(head: number, style: number, detail: "high" | "low" | "far"): THREE.BufferGeometry {
  const key = `${head}:${style}:${detail}`;
  let geometry = eyeCache.get(key);
  if (geometry) return geometry;
  const place = eyePlace(head);
  const sphere = new THREE.SphereGeometry(1, detail === "high" ? 40 : detail === "low" ? 18 : 12, detail === "high" ? 28 : detail === "low" ? 12 : 9);
  const scale = style === 2 ? 1.12 : 1;
  const count = sphere.attributes.position.count;
  const positions = new Float32Array(count * 2 * 3);
  const normals = new Float32Array(count * 2 * 3);
  const eyes = new Float32Array(count * 2 * 3);
  // Each eye's frame, so the shader can see the view from the eye's side.
  const rights = new Float32Array(count * 2 * 3);
  const ups = new Float32Array(count * 2 * 3);
  const indices: number[] = [];
  const srcIndex = sphere.index!;
  const lookDir = new THREE.Vector3();
  const right = new THREE.Vector3();
  const up = new THREE.Vector3();
  const dir = new THREE.Vector3();
  [1, -1].forEach((side, eye) => {
    // The pupil looks mostly along the eye's own axis, biased a little forward.
    lookDir.set(side * place.dir.x, place.dir.y, place.dir.z).lerp(new THREE.Vector3(0, -0.08, 1), 0.3).normalize();
    // Local +x points towards the nose for both eyes.
    right.set(-side, 0, 0);
    right.addScaledVector(lookDir, -right.dot(lookDir)).normalize();
    up.crossVectors(lookDir, right).normalize();
    if (up.y < 0) up.negate();
    for (let v = 0; v < count; v++) {
      dir.fromBufferAttribute(sphere.attributes.normal as THREE.BufferAttribute, v);
      const o = (eye * count + v) * 3;
      positions[o] = side * place.center.x + dir.x * place.r * scale;
      positions[o + 1] = place.center.y + dir.y * place.r * scale;
      positions[o + 2] = place.center.z + dir.z * place.r * scale;
      normals[o] = dir.x;
      normals[o + 1] = dir.y;
      normals[o + 2] = dir.z;
      eyes[o] = dir.dot(right);
      eyes[o + 1] = dir.dot(up);
      eyes[o + 2] = dir.dot(lookDir);
      rights[o] = right.x;
      rights[o + 1] = right.y;
      rights[o + 2] = right.z;
      ups[o] = up.x;
      ups[o + 1] = up.y;
      ups[o + 2] = up.z;
    }
    for (let i = 0; i < srcIndex.count; i++) indices.push(srcIndex.getX(i) + eye * count);
  });
  sphere.dispose();
  geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute("aEye", new THREE.BufferAttribute(eyes, 3));
  geometry.setAttribute("aEyeRight", new THREE.BufferAttribute(rights, 3));
  geometry.setAttribute("aEyeUp", new THREE.BufferAttribute(ups, 3));
  geometry.setIndex(indices);
  eyeCache.set(key, geometry);
  return geometry;
}

// ----- Horns ----------------------------------------------------------------

const hornCache = new Map<string, THREE.BufferGeometry>();
const IVORY = new THREE.Color("#f2e0ba");
const GOLD_LIGHT = new THREE.Color("#fff0b0");
const GOLD = new THREE.Color("#f2b13b");
const ANTLER = new THREE.Color("#c79a64");
const ANTLER_TIP = new THREE.Color("#e8d0a4");
const RAM = new THREE.Color("#e2c79a");
const FLAME_ORANGE = new THREE.Color("#f2762b");

function hornGeometry(horn: number, head: number): THREE.BufferGeometry | null {
  if (horn === 0) return null;
  const key = `${horn}:${head}`;
  let geometry = hornCache.get(key);
  if (geometry) return geometry;
  const builder = new PartBuilder();
  const spec = HEADS[head];
  // Horns are placed in head-local space: origin at the skull centre.
  const bones = () => ({ bones: [B.head, 0, 0, 0], weights: [1, 0, 0, 0] });
  const top = head === 4 ? 0.36 : head === 2 ? 0.36 : 0.33;
  const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

  switch (horn) {
    case 1:
      for (const s of [1, -1]) {
        const path = [v(s * 0.16, top, -0.02), v(s * 0.24, top + 0.2, -0.16), v(s * 0.3, top + 0.34, -0.38), v(s * 0.33, top + 0.42, -0.62)];
        sweep(builder, path, {
          sides: 12,
          steps: 22,
          radius: (t) => lerp(0.11, 0.012, Math.pow(t, 0.8)),
          ripple: (t, angle) => (t < 0.55 ? Math.abs(Math.sin(t * 34)) * 0.008 * (1 - t) : 0) + Math.cos(angle) * 0.002,
          color: (t) => IVORY.clone().lerp(new THREE.Color("#fff7e4"), smooth(0.2, 1, t)),
          mask: (t) => [lerp(0.65, 1, smooth(0, 0.25, t)), 0, 1, 0],
          bones,
          cap: true,
        });
      }
      break;
    case 2: {
      // One long twisted spiral.
      const path = [v(0, top - 0.02, 0.2), v(0.012, top + 0.25, 0.27), v(-0.01, top + 0.5, 0.33), v(0.006, top + 0.78, 0.4)];
      sweep(builder, path, {
        sides: 18,
        steps: 42,
        radius: (t) => lerp(0.088, 0.008, Math.pow(t, 0.92)),
        ripple: (t, angle) => {
          const groove = Math.sin(angle * 2 + t * 26);
          return groove * lerp(0.02, 0.004, t);
        },
        color: (t) => GOLD.clone().lerp(GOLD_LIGHT, t * 0.9 + 0.1),
        mask: (t) => [lerp(0.7, 1, smooth(0, 0.2, t)), 0, 1, 0],
        bones,
        cap: true,
      });
      break;
    }
    case 3:
      for (const s of [1, -1]) {
        const main = [v(s * 0.15, top, 0.0), v(s * 0.2, top + 0.2, -0.05), v(s * 0.27, top + 0.46, -0.16), v(s * 0.34, top + 0.74, -0.22)];
        sweep(builder, main, {
          sides: 10,
          steps: 22,
          radius: (t) => lerp(0.052, 0.014, t),
          color: (t) => ANTLER.clone().lerp(ANTLER_TIP, smooth(0.5, 1, t)),
          mask: (t) => [lerp(0.7, 1, smooth(0, 0.2, t)), 0, 1, 0],
          bones,
          cap: true,
        });
        const tines: [THREE.Vector3[], number][] = [
          [[v(s * 0.2, top + 0.2, -0.05), v(s * 0.3, top + 0.3, 0.05), v(s * 0.36, top + 0.42, 0.11)], 0.034],
          [[v(s * 0.26, top + 0.42, -0.14), v(s * 0.4, top + 0.5, -0.13), v(s * 0.5, top + 0.64, -0.12)], 0.028],
          [[v(s * 0.23, top + 0.3, -0.1), v(s * 0.2, top + 0.42, -0.22), v(s * 0.2, top + 0.56, -0.3)], 0.024],
        ];
        for (const [path, r0] of tines) {
          sweep(builder, path, {
            sides: 8,
            steps: 10,
            radius: (t) => lerp(r0, 0.01, t),
            color: (t) => ANTLER.clone().lerp(ANTLER_TIP, t),
            bones,
            cap: true,
            mask: () => [0.9, 0, 1, 0],
          });
        }
      }
      break;
    case 4:
      for (const s of [1, -1]) {
        // A big curled ram horn, tracing out and back on itself.
        const turns = 1.25;
        const points: THREE.Vector3[] = [];
        for (let i = 0; i <= 14; i++) {
          const t = i / 14;
          const angle = t * turns * Math.PI * 2 + 0.6;
          const radius = lerp(0.3, 0.08, t);
          const sideOut = s * (0.22 + 0.2 * t);
          points.push(v(sideOut, top - 0.1 + Math.sin(angle) * radius, -0.1 + Math.cos(angle) * radius - 0.16 * t));
        }
        sweep(builder, points, {
          sides: 12,
          steps: 44,
          radius: (t) => lerp(0.1, 0.02, Math.pow(t, 0.85)),
          ripple: (t) => Math.abs(Math.sin(t * 60)) * 0.009,
          color: (t) => RAM.clone().lerp(new THREE.Color("#f4e6c8"), t * 0.9),
          mask: () => [0.95, 0, 1, 0],
          bones,
          cap: true,
        });
      }
      break;
    case 5: {
      // Crest: a fan of plumes on the crown.
      const count = 5;
      for (let i = 0; i < count; i++) {
        const u = i / (count - 1);
        const angle = lerp(-0.5, 0.75, u);
        const alt = i % 2 === 0;
        const root = v(0, top - 0.1, 0.02 - u * 0.05);
        const axis = v(0, Math.cos(angle), -Math.sin(angle)).normalize();
        const plumeLength = 0.62 - Math.abs(u - 0.5) * 0.22;
        const colorTip = alt ? FLAME_ORANGE.clone() : new THREE.Color(1, 1, 1);
        blade(builder, root, axis, v(1, 0, 0), plumeLength, 0.18, -0.08, {
          segments: 10,
          color: () => colorTip,
          mask: (t) => [lerp(0.7, 1, smooth(0, 0.3, t)), alt ? 0 : 2, alt ? 1 : 0, 1],
          bones,
          profile: (t) => Math.pow(Math.sin(Math.PI * Math.min(1, t * 1.02)), 0.6),
          bend: v(0, 0, 1),
        });
      }
      break;
    }
  }
  void spec;
  geometry = builder.toGeometry();
  hornCache.set(key, geometry);
  return geometry;
}

// ----- Tails ----------------------------------------------------------------

const tailCache = new Map<string, THREE.BufferGeometry>();
const TAIL_BONES = [B.tail0, B.tail1, B.tail2, B.tail3, B.tail4];

function sculptTailChain(S: Sculpt, radii: number[], opts: { tag?: number; k?: number } = {}) {
  for (let i = 0; i < TAIL_POINTS.length - 1; i++) {
    S.cone(TAIL_POINTS[i], radii[i], TAIL_POINTS[i + 1], radii[i + 1], {
      k: opts.k ?? 0.03,
      bone: TAIL_BONES[i],
      bone2: TAIL_BONES[i + 1],
      tag: opts.tag ?? 0,
    });
  }
}

function tailGeometry(tail: number, detail: "high" | "low" | "far"): THREE.BufferGeometry | null {
  if (tail === 4) return null; // Flame tails are built separately.
  const key = `${tail}:${detail}`;
  let geometry = tailCache.get(key);
  if (geometry) return geometry;
  const cell = detail === "high" ? 0.018 : detail === "low" ? 0.042 : 0.07;
  const builder = new PartBuilder();
  const last = TAIL_POINTS[TAIL_POINTS.length - 1];
  const before = TAIL_POINTS[TAIL_POINTS.length - 2];
  const dir = new THREE.Vector3(last[0] - before[0], last[1] - before[1], last[2] - before[2]).normalize();
  const tailMask = makeMaskFn(0);

  if (tail === 0) {
    // Spade tail: a whippy tube ending in a flat arrowhead.
    const S = new Sculpt();
    sculptTailChain(S, [0.11, 0.09, 0.075, 0.06, 0.05]);
    const c: V3 = [last[0], last[1], last[2]];
    const p = (t: number): V3 => [c[0] + dir.x * t, c[1] + dir.y * t, c[2] + dir.z * t];
    S.ell(p(0.08), [0.13, 0.17, 0.035], { k: 0.04, bone: B.tail4, tag: TAG.pure });
    S.cone(p(0.1), 0.1, p(0.32), 0.012, { k: 0.04, bone: B.tail4, tag: TAG.pure });
    builder.addShape(S.build(cell, tailMask, TAG_COUNT, 0.05));
  } else if (tail === 1) {
    // Fluffy tail: one big plush brush with a pale tip.
    const S = new Sculpt();
    S.cone(TAIL_POINTS[0], 0.13, TAIL_POINTS[1], 0.26, { k: 0.04, bone: B.tail0, bone2: B.tail1 });
    S.cone(TAIL_POINTS[1], 0.26, TAIL_POINTS[2], 0.31, { k: 0.04, bone: B.tail1, bone2: B.tail2 });
    S.cone(TAIL_POINTS[2], 0.31, TAIL_POINTS[3], 0.28, { k: 0.05, bone: B.tail2, bone2: B.tail3 });
    S.cone(TAIL_POINTS[3], 0.28, TAIL_POINTS[4], 0.2, { k: 0.05, bone: B.tail3, bone2: B.tail4, tag: 0 });
    const c: V3 = [last[0], last[1], last[2]];
    S.cone(c, 0.2, [c[0] + dir.x * 0.22, c[1] + dir.y * 0.22, c[2] + dir.z * 0.22], 0.02, { k: 0.06, bone: B.tail4 });
    // Soft tufts along the tail for a lumpy, furry outline.
    const rand = rng(5);
    for (let i = 0; i < 26; i++) {
      const segment = Math.floor(rand() * 4);
      const f = rand();
      const a = TAIL_POINTS[segment];
      const b = TAIL_POINTS[segment + 1];
      const px = lerp(a[0], b[0], f);
      const py = lerp(a[1], b[1], f);
      const pz = lerp(a[2], b[2], f);
      const angle = rand() * Math.PI * 2;
      const radius = 0.16 + segment * 0.03;
      const tuft: V3 = [px + Math.cos(angle) * radius, py + Math.sin(angle) * radius, pz];
      S.sphere(tuft, 0.085 + rand() * 0.05, { k: 0.06, bone: TAIL_BONES[Math.min(4, segment + 1)] });
    }
    builder.addShape(
      S.build(cell * 1.15, (x, y, z, nx, ny, nz, tags, ao, out, color) => {
        tailMask(x, y, z, nx, ny, nz, tags, ao, out, color);
        // Pale tip towards the end of the tail.
        const tip = smooth(1.16, 1.46, y) * smooth(-1.28, -1.5, z);
        // Cream fur (negative), so the tip stays fluffy.
        if (tip > Math.abs(out[2])) out[2] = -tip;
        if (tip > 0) {
          color[0] = TAG_COLOURS[TAG.cream].r;
          color[1] = TAG_COLOURS[TAG.cream].g;
          color[2] = TAG_COLOURS[TAG.cream].b;
        }
      }, TAG_COUNT, 0.05),
    );
  } else if (tail === 2) {
    // Tufted tail: slim stem with a long flowing tuft.
    const S = new Sculpt();
    sculptTailChain(S, [0.085, 0.07, 0.056, 0.048, 0.044]);
    const c: V3 = [last[0], last[1], last[2]];
    const p = (t: number): V3 => [c[0] + dir.x * t, c[1] + dir.y * t, c[2] + dir.z * t];
    S.ell(p(0.14), [0.11, 0.2, 0.11], { k: 0.05, bone: B.tail4, tag: TAG.pure });
    S.cone(p(0.14), 0.12, p(0.4), 0.02, { k: 0.05, bone: B.tail4, tag: TAG.pure });
    // Strands fanning at the end of the tuft.
    for (const a of [-0.34, -0.12, 0.12, 0.34]) {
      S.cone(p(0.1), 0.075, [p(0.32)[0] + a * 0.12, p(0.32)[1], p(0.32)[2]], 0.01, { k: 0.05, bone: B.tail4, tag: TAG.pure });
    }
    builder.addShape(S.build(cell, tailMask, TAG_COUNT, 0.05));
  } else if (tail === 3) {
    // Fan tail: a raised semicircle of long plumes with eye spots at the tips.
    const S = new Sculpt();
    sculptTailChain(S, [0.14, 0.12, 0.08, 0.05, 0.05], { k: 0.05 });
    builder.addShape(S.build(cell * 1.3, tailMask, TAG_COUNT, 0.05));
    const root = new THREE.Vector3(TAIL_POINTS[1][0], TAIL_POINTS[1][1] + 0.02, TAIL_POINTS[1][2]);
    const count = 9;
    const eyeColor = new THREE.Color("#fff3df");
    for (let i = 0; i < count; i++) {
      const u = i / (count - 1);
      const spread = lerp(-1.25, 1.25, u);
      const axis = new THREE.Vector3(Math.sin(spread), Math.cos(spread) * 0.9, -0.42).normalize();
      const sideV = new THREE.Vector3(Math.cos(spread), -Math.sin(spread) * 0.9, 0).normalize();
      const length = 1.02 + (1 - Math.abs(u - 0.5) * 2) * 0.26;
      const alt = i % 2 === 0;
      blade(builder, root, axis, sideV, length, 0.29, -0.1, {
        segments: 14,
        color: () => new THREE.Color("#fff3df"),
        mask: (t, across) => {
          const edge = 1 - Math.abs(across);
          const ao = lerp(0.72, 1, smooth(0, 0.3, t)) * lerp(0.82, 1, edge);
          // Main near the body, accent towards the tip.
          return [ao, 1 + smooth(0.28, 0.7, t), 0, 0] as const;
        },
        bones: (t) => ({ bones: [B.tail1, B.tail2, 0, 0], weights: [1 - t * 0.5, t * 0.5, 0, 0] }),
        profile: (t) => {
          // Slim quill flaring into a rounded tip.
          const flare = smooth(0.5, 0.92, t);
          return lerp(0.22, 1, flare) * Math.sqrt(1 - Math.pow(clamp(t), 8));
        },
        bend: new THREE.Vector3(0, 0.15, -1),
      });
      // Eye spot painted as a tiny overlapping blade near the tip.
      const eyeRoot = root.clone().add(axis.clone().multiplyScalar(length * 0.72)).add(new THREE.Vector3(0, 0, 0.012));
      blade(builder, eyeRoot, axis, sideV, length * 0.22, 0.18, -0.01, {
        segments: 12,
        color: () => eyeColor,
        mask: (t) => [1, alt ? 0 : 1, 0.92, 0, t] as unknown as readonly [number, number, number, number],
        bones: () => ({ bones: [B.tail2, 0, 0, 0], weights: [1, 0, 0, 0] }),
        profile: (t) => Math.sqrt(Math.max(0, 1 - Math.pow(2 * t - 1, 2))),
      });
    }
  }
  geometry = builder.toGeometry();
  tailCache.set(key, geometry);
  return geometry;
}

// ----- Wings -----------------------------------------------------------------

const wingCache = new Map<string, THREE.BufferGeometry>();

/** Three-bone skin weights from how far along the arm a point sits. */
function armSkin(side: number, span: number) {
  const a = side > 0 ? B.wLa : B.wRa;
  const b = a + 1;
  const c = a + 2;
  const elbow = 0.46;
  const wrist = 0.86;
  if (span < elbow) {
    const t = smooth(0.1, elbow, span);
    return { bones: [a, b, c, 0], weights: [1 - t, t, 0, 0] };
  }
  if (span < wrist) {
    const t = smooth(elbow, wrist, span);
    return { bones: [a, b, c, 0], weights: [0, 1 - t, t, 0] };
  }
  return { bones: [a, b, c, 0], weights: [0, 0, 1, 0] };
}

function wingGeometry(wing: number): THREE.BufferGeometry | null {
  if (wing === 0 || wing === 3) return null;
  const key = `${wing}`;
  let geometry = wingCache.get(key);
  if (geometry) return geometry;
  const builder = new PartBuilder();
  if (wing === 1) batWing(builder);
  if (wing === 2) featherWing(builder);
  if (wing === 4) butterflyWing(builder);
  geometry = builder.toGeometry();
  wingCache.set(key, geometry);
  return geometry;
}

const WHITE = new THREE.Color(1, 1, 1);

function batWing(builder: PartBuilder) {
  for (const s of [1, -1]) {
    const A = new THREE.Vector3(s * 0.2, 0.97, 0.13);
    const M = new THREE.Vector3(s * 0.66, 1.12, 0.08);
    const W = new THREE.Vector3(s * 1.02, 1.36, -0.02);
    const hip = new THREE.Vector3(s * 0.28, 0.82, -0.42);
    const tips = [
      new THREE.Vector3(s * 1.74, 1.28, -0.58),
      new THREE.Vector3(s * 1.5, 0.86, -0.92),
      new THREE.Vector3(s * 1.02, 0.66, -1.0),
      new THREE.Vector3(s * 0.62, 0.72, -0.84),
    ];

    const skinAt = (v: THREE.Vector3) => armSkin(s, Math.min(1, Math.abs(v.x) / 1.02));
    // Spokes run from the arm out to the wing's edge.
    const spokes: { from: THREE.Vector3; to: THREE.Vector3; finger: boolean }[] = [
      { from: W, to: tips[0], finger: true },
      { from: W, to: tips[1], finger: true },
      { from: W, to: tips[2], finger: true },
      { from: M, to: tips[3], finger: false },
      { from: A, to: hip, finger: false },
    ];
    const N = 12; // Steps across between two spokes.
    const M2 = 7; // Steps along a spoke.
    for (let i = 0; i < spokes.length - 1; i++) {
      const a = spokes[i];
      const b = spokes[i + 1];
      const grid: number[][] = [];
      for (let across = 0; across <= N; across++) {
        const f = across / N;
        const row: number[] = [];
        // A scallop in the trailing edge between fingers.
        const scallop = 1 - Math.sin(f * Math.PI) * 0.2;
        const from = a.from.clone().lerp(b.from, f);
        const to = a.to.clone().lerp(b.to, f);
        for (let along = 0; along <= M2; along++) {
          const t = (along / M2) * scallop;
          const p = from.clone().lerp(to, t);
          // Billow gently so the membrane is not flat.
          const billow = Math.sin(f * Math.PI) * Math.sin(t * Math.PI) * 0.1;
          p.y -= billow;
          const skin = skinAt(p);
          const edge = (along / M2) * 0.08 + 0.92;
          row.push(builder.vertex(p.x, p.y, p.z, 0, 1, 0, WHITE, [edge, 2, 0, 0], f, t, skin.bones, skin.weights));
        }
        grid.push(row);
      }
      for (let across = 0; across < N; across++) {
        for (let along = 0; along < M2; along++) {
          const v0 = grid[across][along];
          const v1 = grid[across + 1][along];
          const v2 = grid[across + 1][along + 1];
          const v3 = grid[across][along + 1];
          if (s > 0) builder.quad(v0, v1, v2, v3);
          else builder.quad(v0, v3, v2, v1);
        }
      }
    }

    // Arm and finger bones, drawn in the main colour.
    const tube = (points: THREE.Vector3[], r0: number, r1: number) => {
      sweep(builder, points, {
        sides: 8,
        steps: 10,
        radius: (t) => lerp(r0, r1, t),
        color: () => WHITE,
        mask: () => [0.95, 0, 0, 0],
        bones: (t) => skinAt(points[0].clone().lerp(points[points.length - 1], t)),
        cap: true,
      });
    };
    tube([A, M.clone().lerp(A, 0.5), M], 0.06, 0.05);
    tube([M, W], 0.05, 0.04);
    for (let i = 0; i < 3; i++) tube([W, W.clone().lerp(tips[i], 0.5).add(new THREE.Vector3(0, -0.02, 0)), tips[i]], 0.03, 0.008);
    // Thumb claw at the wrist.
    tube([W, W.clone().add(new THREE.Vector3(s * 0.05, 0.1, 0.1)).add(new THREE.Vector3(0, 0.04, 0.02))], 0.028, 0.004);
  }
}

function featherWing(builder: PartBuilder) {
  const rand = rng(17);
  for (const s of [1, -1]) {
    const A = new THREE.Vector3(s * 0.2, 0.97, 0.12);
    const M = new THREE.Vector3(s * 0.66, 1.12, 0.08);
    const W = new THREE.Vector3(s * 1.02, 1.36, -0.02);

    const addFeather = (root: THREE.Vector3, axis: THREE.Vector3, length: number, width: number, alt: boolean, ao: number, spanAt: number, rowLift: number) => {
      const skin = armSkin(s, spanAt);
      const sideV = new THREE.Vector3(-axis.z, 0, axis.x).normalize();
      blade(builder, root.clone().setY(root.y + rowLift), axis, sideV, length, width, -0.16, {
        segments: 8,
        color: () => new THREE.Color("#fff3df"),
        mask: (t) => {
          // Each feather darkens from base to tip, neighbours differing a little.
          const colorMix = alt ? smooth(0.15, 0.7, t) * 1.45 : smooth(0.2, 0.8, t) * 1.2;
          const special = alt ? 0 : smooth(0.8, 0.98, t) * 0.4;
          return [ao * lerp(0.82, 1, smooth(0, 0.3, t)), colorMix, special, 0] as const;
        },
        bones: () => skin,
        profile: (t) => {
          const body = Math.pow(Math.min(1, t * 2.4), 0.4);
          return body * Math.sqrt(Math.max(0.0001, 1 - Math.pow(t, 3.6)));
        },
      });
    };

    // Primaries fan from the wrist.
    for (let i = 0; i < 9; i++) {
      const u = i / 8;
      const angle = lerp(1.0, 0.0, u); // 0 = straight back.
      const axis = new THREE.Vector3(s * Math.sin(angle), -0.22 + u * 0.1, -Math.cos(angle)).normalize();
      const along = u;
      const root = M.clone().lerp(W, 0.55 + along * 0.45).add(new THREE.Vector3(0, -0.01, 0));
      const length = lerp(1.05, 0.72, u) + rand() * 0.05;
      addFeather(root, axis, length, 0.22, i % 2 === 0, 0.96, 0.75 + u * 0.24, 0.001);
    }
    // Secondaries along the forearm.
    for (let i = 0; i < 8; i++) {
      const u = i / 7;
      const root = A.clone().lerp(M, 0.25 + u * 0.75);
      root.y -= 0.02;
      const axis = new THREE.Vector3(s * (0.1 + u * 0.2), -0.3, -1).normalize();
      addFeather(root, axis, lerp(0.62, 0.74, u), 0.21, i % 2 === 1, 0.92, 0.22 + u * 0.62, -0.002);
    }
    // Coverts, a short layer over the base.
    for (let i = 0; i < 11; i++) {
      const u = i / 10;
      const root = A.clone().lerp(W, u * 0.9 + 0.08);
      root.y += 0.02;
      const axis = new THREE.Vector3(s * (u * 0.5), -0.16, -1).normalize();
      const skin = armSkin(s, u * 0.9 + 0.08);
      blade(builder, root, axis, new THREE.Vector3(1, 0, 0), 0.32, 0.19, -0.06, {
        segments: 5,
        color: () => new THREE.Color("#ffffff"),
        mask: (t) => [lerp(0.8, 1, t), 0, 0, 0] as const,
        bones: () => skin,
      });
    }
    // The arm itself, tucked under the coverts.
    sweep(builder, [A, A.clone().lerp(M, 0.5).add(new THREE.Vector3(0, 0.02, 0)), M, W], {
      sides: 9,
      steps: 12,
      radius: (t) => lerp(0.075, 0.03, t),
      color: () => WHITE,
      mask: () => [0.9, 0, 0, 0],
      bones: (t) => armSkin(s, Math.min(1, t * 1.02)),
      cap: true,
    });
  }
}

function butterflyWing(builder: PartBuilder) {
  for (const s of [1, -1]) {
    const root = new THREE.Vector3(s * 0.16, 1.02, 0.02);
    // Two lobes: fore and hind, each a fan of rings around the root.
    const lobes: { start: number; end: number; reach: (t: number) => number; index: number }[] = [
      { start: 0.05, end: 1.25, index: 0, reach: (t) => lerp(0.62, 1.12, Math.sin(t * Math.PI) ** 0.8) },
      { start: 1.2, end: 2.5, index: 1, reach: (t) => lerp(0.42, 0.74, Math.sin(t * Math.PI) ** 0.65) },
    ];
    for (const lobe of lobes) {
      const rings = 12;
      const spokes = 16;
      const grid: number[][] = [];
      for (let i = 0; i <= spokes; i++) {
        const t = i / spokes;
        const angle = lerp(lobe.start, lobe.end, t);
        const reach = lobe.reach(t);
        const row: number[] = [];
        for (let j = 0; j <= rings; j++) {
          const r = (j / rings) * reach;
          const dx = Math.cos(angle) * r;
          const dz = -Math.sin(angle) * r;
          const span = Math.min(1, r / 0.9);
          const skin = armSkin(s, span * 0.7);
          // Sculpted cross-section; the wing dips towards the far edge.
          const px = root.x + s * dx;
          const pz = root.z + dz;
          const py = root.y + Math.sin(angle) * r * -0.12 + r * 0.1 - 0.04 * r * r;
          const v = builder.vertex(px, py, pz, 0, 1, 0, WHITE, [0.95, 2, 0, lobe.index], j / rings, t, skin.bones, skin.weights);
          row.push(v);
        }
        grid.push(row);
      }
      for (let i = 0; i < spokes; i++) {
        for (let j = 0; j < rings; j++) {
          const v0 = grid[i][j];
          const v1 = grid[i + 1][j];
          const v2 = grid[i + 1][j + 1];
          const v3 = grid[i][j + 1];
          if (s > 0) builder.quad(v0, v3, v2, v1);
          else builder.quad(v0, v1, v2, v3);
        }
      }
    }
  }
}

// ----- Flames ---------------------------------------------------------------

function flameTongue(positions: number[], tips: number[], heights: number[], seeds: number[], index: number[], base: THREE.Vector3, axis: THREE.Vector3, length: number, radius: number, seed: number) {
  const sides = 8;
  const rings = 8;
  const start = positions.length / 3;
  const ref = Math.abs(axis.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const u = axis.clone().cross(ref).normalize();
  const v = axis.clone().cross(u).normalize();
  for (let r = 0; r <= rings; r++) {
    const h = r / rings;
    const w = radius * Math.pow(Math.sin(Math.min(1, h * 1.02) * Math.PI * 0.82 + 0.3), 1.5) * (1 - h * h * 0.8);
    for (let s = 0; s < sides; s++) {
      const a = (s / sides) * Math.PI * 2;
      const px = base.x + axis.x * h * length + (u.x * Math.cos(a) + v.x * Math.sin(a)) * w;
      const py = base.y + axis.y * h * length + (u.y * Math.cos(a) + v.y * Math.sin(a)) * w;
      const pz = base.z + axis.z * h * length + (u.z * Math.cos(a) + v.z * Math.sin(a)) * w;
      positions.push(px, py, pz);
      tips.push(axis.x, axis.y, axis.z);
      heights.push(h);
      seeds.push(seed);
    }
  }
  for (let r = 0; r < rings; r++) {
    for (let s = 0; s < sides; s++) {
      const a = start + r * sides + s;
      const b = start + r * sides + ((s + 1) % sides);
      const c = start + (r + 1) * sides + ((s + 1) % sides);
      const d = start + (r + 1) * sides + s;
      index.push(a, b, c, a, c, d);
    }
  }
}

function flameGeometry(kind: "tail" | "wingL" | "wingR"): THREE.BufferGeometry {
  const positions: number[] = [];
  const axes: number[] = [];
  const heights: number[] = [];
  const seeds: number[] = [];
  const index: number[] = [];
  const rand = rng(kind === "tail" ? 3 : 8);
  if (kind === "tail") {
    const base = new THREE.Vector3(0, 0.0, 0);
    flameTongue(positions, axes, heights, seeds, index, base, new THREE.Vector3(0, 0.25, -1).normalize(), 1.3, 0.3, 0.1);
    flameTongue(positions, axes, heights, seeds, index, base.clone().add(new THREE.Vector3(0, 0.08, 0)), new THREE.Vector3(0.18, 0.55, -1).normalize(), 0.95, 0.2, 0.7);
    flameTongue(positions, axes, heights, seeds, index, base.clone().add(new THREE.Vector3(0, -0.04, 0)), new THREE.Vector3(-0.2, 0.05, -1).normalize(), 1.0, 0.2, 1.4);
    flameTongue(positions, axes, heights, seeds, index, base, new THREE.Vector3(0, 0.85, -0.65).normalize(), 0.7, 0.16, 2.3);
  } else {
    const s = kind === "wingL" ? 1 : -1;
    for (let i = 0; i < 5; i++) {
      const u = i / 4;
      const base = new THREE.Vector3(s * lerp(0.04, 0.5, u), lerp(0.0, 0.18, u), -0.02);
      const axis = new THREE.Vector3(s * lerp(0.2, 1.05, u), lerp(1, 0.7, u), -0.5).normalize();
      flameTongue(positions, axes, heights, seeds, index, base, axis, lerp(1.25, 0.95, Math.abs(u - 0.4)), lerp(0.28, 0.2, u), rand() * 6);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("aAxis", new THREE.Float32BufferAttribute(axes, 3));
  geometry.setAttribute("aHeight", new THREE.Float32BufferAttribute(heights, 1));
  geometry.setAttribute("aSeed", new THREE.Float32BufferAttribute(seeds, 1));
  geometry.setIndex(index);
  geometry.computeVertexNormals();
  return geometry;
}

const flameGeoCache = new Map<string, THREE.BufferGeometry>();
function cachedFlame(kind: "tail" | "wingL" | "wingR") {
  let g = flameGeoCache.get(kind);
  if (!g) {
    g = flameGeometry(kind);
    flameGeoCache.set(kind, g);
  }
  return g;
}

export function createFlameMaterial(timeUniform: { value: number }): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    uniforms: { uTime: timeUniform, uBoost: { value: 1 } },
    vertexShader: /* glsl */ `
      uniform float uTime;
      attribute vec3 aAxis;
      attribute float aHeight;
      attribute float aSeed;
      varying float vH;
      varying vec3 vN;
      varying vec3 vV;
      varying float vS;
      ${GLSL_NOISE}
      void main(){
        vH = aHeight; vS = aSeed;
        float h = aHeight;
        vec3 p = position;
        // Lick upwards and sideways, more at the tips.
        vec3 axisN = normalize(aAxis);
        float t = uTime*2.2 + aSeed;
        vec3 sideA = normalize(cross(axisN, vec3(0.3,0.9,0.2)));
        vec3 sideB = normalize(cross(axisN, sideA));
        float n1 = vnoise(vec3(p.xy*4.0 + aSeed, t)) - 0.5;
        float n2 = vnoise(vec3(p.yz*4.0 + aSeed, t*1.3)) - 0.5;
        p += sideA * n1 * h * 0.5 + sideB * n2 * h * 0.5;
        p += axisN * sin(t*1.7 + aSeed*3.0) * h * 0.09;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        vN = normalize(normalMatrix * normal);
        vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform float uBoost;
      varying float vH;
      varying vec3 vN;
      varying vec3 vV;
      varying float vS;
      ${GLSL_NOISE}
      void main(){
        float facing = pow(clamp(abs(dot(normalize(vN), normalize(vV))), 0.0, 1.0), 1.2);
        float n = vnoise(vec3(gl_FragCoord.xy*0.02 + vS, uTime*2.6));
        float core = facing * (1.0 - vH*0.75);
        core = smoothstep(0.08, 1.0, core + n*0.18 - 0.09);
        vec3 deep = vec3(1.0, 0.16, 0.02);
        vec3 mid = vec3(1.0, 0.5, 0.06);
        vec3 hot = vec3(1.0, 0.84, 0.42);
        vec3 col = mix(deep, mid, smoothstep(0.1, 0.45, core));
        col = mix(col, hot, smoothstep(0.42, 0.9, core));
        float alpha = (facing*0.9+0.1) * smoothstep(1.0, 0.45, vH) * smoothstep(0.0, 0.08, vH + 0.03);
        gl_FragColor = vec4(col * (0.42 + core*0.55) * uBoost, alpha*0.78);
      }
    `,
  });
}

// ----- Detail maps -------------------------------------------------------------
//
// Fur, shag and hide are fields of tapered hair strokes. Scales and feathers are drawn
// here as real overlapping shingles, with each scale's own shade in alpha, and
// a strand map gives the fur shells individual tapering hairs.

interface KinMaps {
  fur: THREE.DataTexture;
  shag: THREE.DataTexture;
  hide: THREE.DataTexture;
  scale: THREE.DataTexture;
  feather: THREE.DataTexture;
  strands: THREE.DataTexture;
}

/** One tapered hair stroke into a height field, lying roughly along +u. */
function furStroke(height: Float32Array, size: number, x0: number, y0: number, length: number, angle: number, width: number, value: number) {
  const steps = Math.ceil(length * 1.5);
  const dirX = Math.cos(angle);
  const dirY = Math.sin(angle);
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const px = x0 + dirX * length * t;
    const py = y0 + dirY * length * t + Math.sin(t * 3.1) * 0.5;
    const w = width * (1 - t * 0.85);
    const r = Math.ceil(w * 1.4);
    const cx = Math.floor(px);
    const cy = Math.floor(py);
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const d2 = (dx + cx + 0.5 - px) ** 2 + (dy + cy + 0.5 - py) ** 2;
        const f = Math.exp(-d2 / (w * w + 0.3));
        if (f < 0.02) continue;
        const i = (((cy + dy) % size + size) % size) * size + (((cx + dx) % size + size) % size);
        const v = value * (0.35 + t * 0.65) * f;
        if (v > height[i]) height[i] = v;
      }
    }
  }
}

function furMap(size: number, strokes: number, length: [number, number], spread: number, width: [number, number], strength: number, seed: number): THREE.DataTexture {
  const rand = rng(seed);
  const height = new Float32Array(size * size);
  for (let i = 0; i < strokes; i++) {
    furStroke(height, size, rand() * size, rand() * size, length[0] + rand() * length[1], (rand() - 0.5) * spread, width[0] + rand() * width[1], 0.4 + rand() * 0.6);
  }
  return heightTexture(height, new Float32Array(size * size).fill(1), size, strength);
}

let kinMapCache: KinMaps | null = null;

function kinTexture(data: Uint8Array, size: number): THREE.DataTexture {
  const texture = new THREE.DataTexture(data as Uint8Array<ArrayBuffer>, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return texture;
}

/** Height (and a per-pixel extra) to RG normal, B height, A extra. */
function heightTexture(height: Float32Array, extra: Float32Array, size: number, strength: number): THREE.DataTexture {
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
      data[i + 2] = Math.round(clamp(height[y * size + x]) * 255);
      data[i + 3] = Math.round(clamp(extra[y * size + x]) * 255);
    }
  }
  return kinTexture(data, size);
}

/**
 * Overlapping shingles on a torus, free edges towards -u (the tail once wrapped
 * onto a creature facing +z). The scale lying on top at each pixel wins.
 */
function shingles(size: number, columns: number, rows: number, radiusU: number, radiusV: number, shape: (dx: number, dy: number, d: number, tone: number) => number, seed: number): { height: Float32Array; tone: Float32Array } {
  const height = new Float32Array(size * size);
  const toneOut = new Float32Array(size * size);
  const cw = size / columns;
  const rh = size / rows;
  const rand = rng(seed);
  const tones = Array.from({ length: columns * rows }, () => rand());
  const jitter = Array.from({ length: columns * rows }, () => [(rand() - 0.5) * 0.18, (rand() - 0.5) * 0.18]);
  const wrap = (d: number) => ((d + size / 2) % size + size) % size - size / 2;
  const reachU = Math.ceil(radiusU / cw) + 1;
  const reachV = Math.ceil(radiusV / rh) + 1;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const rowHome = Math.floor(y / rh);
      const colHome = Math.floor(x / cw);
      let best = -1e9;
      let bestH = 0;
      let bestTone = 0.5;
      for (let r = rowHome - reachV; r <= rowHome + reachV; r++) {
        const offset = ((r % 2) + 2) % 2 ? 0.5 : 0;
        const wr = ((r % rows) + rows) % rows;
        for (let c = colHome - reachU; c <= colHome + reachU; c++) {
          const wc = ((c % columns) + columns) % columns;
          const k = wr * columns + wc;
          const cx = (c + offset + 0.5 + jitter[k][0]) * cw;
          const cy = (r + 0.5 + jitter[k][1]) * rh;
          const dx = wrap(x - cx);
          const dy = wrap(y - cy);
          const ex = dx / radiusU;
          const ey = dy / radiusV;
          const d = Math.sqrt(ex * ex + ey * ey);
          if (d > 1 || dx > radiusU * 0.3) continue;
          const priority = -dx;
          if (priority <= best) continue;
          best = priority;
          bestTone = tones[k];
          bestH = shape(ex, ey, d, tones[k]);
        }
      }
      height[y * size + x] = best > -1e8 ? bestH : 0.02;
      toneOut[y * size + x] = bestTone;
    }
  }
  return { height, tone: toneOut };
}

function kinMaps(): KinMaps {
  if (kinMapCache) return kinMapCache;
  const size = 512;
  // Scales: domed with a faint keel, rising towards their overlapping free edge.
  const scale = shingles(size, 14, 22, (size / 14) * 0.98, (size / 22) * 1.25, (ex, ey, d, tone) => {
    const dome = 1 - d * d;
    const keel = Math.exp(-(ey * ey) / 0.02) * (1 - d) * 0.12;
    const rise = clamp(0.5 - ex * 0.5);
    return 0.12 + dome * 0.52 + rise * 0.22 + keel + (tone - 0.5) * 0.06;
  }, 71);
  // Feathers: long rounded tips with a shaft and soft barbs.
  const featherSize = 384;
  const feather = shingles(featherSize, 6, 9, (featherSize / 6) * 1.7, (featherSize / 9) * 1.55, (ex, ey, d, tone) => {
    const shaft = Math.exp(-(ey * ey) / 0.003) * 0.12 * (1 - d);
    const barbs = (0.5 + 0.5 * Math.sin(ex * 34 + Math.abs(ey) * 48 + tone * 6)) * 0.08 * (1 - d * d);
    const edge = smooth(1.0, 0.15, d);
    return 0.2 + edge * 0.38 + barbs + shaft + (tone - 0.5) * 0.04;
  }, 73);
  // Strands for the fur shells: many thin cones, some clumped longer.
  const strandSize = 256;
  const strands = new Uint8Array(strandSize * strandSize * 4);
  const value = new Float32Array(strandSize * strandSize);
  const rand = rng(97);
  for (let i = 0; i < 5200; i++) {
    const cx = rand() * strandSize;
    const cy = rand() * strandSize;
    const clump = tileNoiseLike(cx / strandSize, cy / strandSize);
    const length = 0.55 + rand() * 0.3 + clump * 0.25;
    const radius = 1.3 + rand() * 1.1;
    const r = Math.ceil(radius + 1);
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const px = Math.floor(cx) + dx;
        const py = Math.floor(cy) + dy;
        const d = Math.hypot(px + 0.5 - cx, py + 0.5 - cy) / radius;
        if (d >= 1) continue;
        const k = ((py + strandSize) % strandSize) * strandSize + ((px + strandSize) % strandSize);
        value[k] = Math.max(value[k], (1 - d) * length);
      }
    }
  }
  for (let i = 0; i < strandSize * strandSize; i++) {
    strands[i * 4] = 128;
    strands[i * 4 + 1] = 128;
    strands[i * 4 + 2] = Math.round(clamp(value[i]) * 255);
    strands[i * 4 + 3] = 255;
  }
  kinMapCache = {
    scale: heightTexture(scale.height, scale.tone, size, 2.6),
    feather: heightTexture(feather.height, feather.tone, featherSize, 1.3),
    fur: furMap(256, 6000, [10, 20], 0.7, [0.55, 0.7], 3.2, 1234),
    shag: furMap(256, 2600, [24, 42], 1.0, [0.9, 1.3], 3.4, 4321),
    hide: furMap(256, 9000, [4, 7], 0.5, [0.5, 0.4], 2.2, 2468),
    strands: kinTexture(strands, strandSize),
  };
  return kinMapCache;
}

/** Smooth tiling noise in 0..1 for clumping, without importing more helpers. */
function tileNoiseLike(u: number, v: number): number {
  return 0.5 + 0.25 * Math.sin(u * TAU * 3 + Math.sin(v * TAU * 2) * 1.3) + 0.25 * Math.sin(v * TAU * 4 + Math.cos(u * TAU * 3) * 1.1);
}

// ----- Materials --------------------------------------------------------------

/** One clock shared by every creature's shaders. */
const sharedTime = { value: 0 };

/** Skins, in uSkin. Scales and feathers have their own detail and shading. */
const SKIN_ID: Record<SkinKind, number> = { scale: 0, fur: 1, shag: 2, hide: 3, feather: 4 };
/** Wing surfaces, in uWingType: membrane, feather, butterfly scales. */
const WING_MEMBRANE = 0;
const WING_FEATHER = 1;
const WING_BUTTERFLY = 2;

const BODY_GLSL = /* glsl */ `
  varying vec4 vKMask;
  varying vec3 vKBind;
  varying vec3 vKBindN;
  varying mat3 vKRot;
  varying float vKThin;
  varying vec2 vKUv;
  uniform sampler2D uDetail;
  uniform sampler2D uStrands;
  uniform vec3 uMain;
  uniform vec3 uAccent;
  uniform vec3 uAccentLight;
  uniform vec3 uInk;
  uniform vec3 uRimColor;
  uniform float uRimStrength;
  uniform vec3 uGlowColor;
  uniform float uTile;
  uniform float uDetailStrength;
  uniform float uBaseRough;
  uniform float uSeed;
  uniform float uShimmer;
  uniform float uFrozen;
  uniform float uHurt;
  uniform float uGlow;
  uniform float uKinTime;
  uniform int uPattern;
  uniform int uSkin;
  uniform float uIrid;
  uniform vec3 uScatter;
  uniform int uWingType;
  #ifdef KIN_SHELL
    uniform float uShellT;
  #endif
  // Set per fragment, read by the light loop.
  vec3 kTrans;
  float kWrap;
  ${GLSL_NOISE}

  float kStar(vec2 q, float r){
    q = abs(q);
    float d = pow(pow(q.x, 0.55) + pow(q.y, 0.55), 1.0/0.55);
    return 1.0 - smoothstep(r*0.86, r, d);
  }

  vec4 kPattern(vec3 p, vec3 n, float height, inout float emis){
    vec4 result = vec4(0.0);
    if(uPattern == 1){
      vec3 q = p*6.5 + uSeed*17.0;
      vec3 g = floor(q - 0.5);
      float m = 0.0;
      for(int x=0;x<2;x++) for(int y=0;y<2;y++) for(int z=0;z<2;z++){
        vec3 c = g + vec3(float(x),float(y),float(z));
        vec3 h = hash33(c);
        if(h.x < 0.25) continue;
        vec3 center = c + 0.5 + (h-0.5)*0.5;
        float rr = 0.22 + h.y*0.22;
        float wobble = 0.85 + 0.3*vnoise(q*2.0);
        float d = length(q-center)/(rr*wobble);
        m = max(m, smoothstep(1.0, 0.82, d));
      }
      result = vec4(uInk, m);
    }
    else if(uPattern == 2){
      float w = (vnoise(p*2.5 + uSeed*9.0)-0.5)*1.5;
      float s = sin(p.z*23.0 + p.y*2.0 + w*3.4 + uSeed*7.0);
      float band = smoothstep(0.32, 0.5, s);
      float keep = smoothstep(0.36, 0.56, p.y) ;
      result = vec4(uInk, band*keep);
    }
    else if(uPattern == 3){
      // Scaled: the gaps between scales take a darker shade, like a snake's.
      result = vec4(mix(uMain, uInk, 0.7), smoothstep(0.34, 0.08, height) * 0.75);
    }
    else if(uPattern == 4){
      float jag = fbm3(p*8.0 + uSeed*5.0);
      float f = smoothstep(0.42, 0.52, n.y*0.62 + jag*0.72 + 0.04);
      emis += f*0.04;
      result = vec4(vec3(0.82,0.95,1.08), f);
    }
    else if(uPattern == 5){
      vec3 q = p*5.0 + uSeed*13.0;
      vec3 absN = abs(n);
      vec2 uv = absN.x > absN.z && absN.x > absN.y ? q.zy : (absN.y > absN.z ? q.zx : q.xy);
      vec2 cell = floor(uv);
      float m = 0.0;
      for(int y=0;y<2;y++) for(int x=0;x<2;x++){
        vec2 c = cell + vec2(float(x),float(y)) - 0.5;
        vec2 h = fract(sin(vec2(dot(c, vec2(127.1,311.7)), dot(c, vec2(269.5,183.3))))*43758.5453);
        if(h.x < 0.35) continue;
        vec2 center = c + 0.5 + (h-0.5)*0.6;
        vec2 d = uv - center;
        float tw = 0.75 + 0.25*sin(uKinTime*2.2 + h.y*40.0);
        float size = (0.16 + h.y*0.12)*tw;
        float angle = h.x*1.5;
        float ca = cos(angle), sa = sin(angle);
        d = vec2(d.x*ca - d.y*sa, d.x*sa + d.y*ca);
        m = max(m, kStar(d, size));
      }
      emis += m*0.6;
      result = vec4(vec3(1.0,0.86,0.4), m);
    }
    return result;
  }
`;

const LIGHTS_WRAP_FIND = `reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );`;
const LIGHTS_WRAP_REPLACE = /* glsl */ `
  {
    // Soft wrapped light with a warm scatter where it fades, as in skin.
    float wrapNL = saturate((dot(geometryNormal, directLight.direction) + kWrap) / (1.0 + kWrap));
    float soft = smoothstep(0.0, 1.0, wrapNL);
    vec3 wrapped = mix(directLight.color * vec3(soft * soft), directLight.color * vec3(soft), 0.65);
    reflectedLight.directDiffuse += mix(wrapped * mix(uScatter, vec3(1.0), soft), directLight.color * mix(uScatter, vec3(1.0), dotNL), max(0.0, dotNL - 0.05)) * BRDF_Lambert(material.diffuseColor);
    // Thin parts (ears, membranes, petals of a crest) glow when lit from behind.
    float behind = saturate(-dot(geometryNormal, directLight.direction));
    float through = behind * 0.55 + pow(saturate(dot(geometryViewDir, -directLight.direction)), 4.0) * 0.9;
    reflectedLight.directDiffuse += directLight.color * kTrans * through * RECIPROCAL_PI;
  }
`;

function applyWrapLighting(fragmentShader: string): string {
  const expanded = THREE.ShaderChunk.lights_physical_pars_fragment.replace(LIGHTS_WRAP_FIND, LIGHTS_WRAP_REPLACE);
  return fragmentShader.replace("#include <lights_physical_pars_fragment>", expanded);
}

interface BodyUniforms {
  uDetail: { value: THREE.Texture };
  uStrands: { value: THREE.Texture };
  uMain: { value: THREE.Color };
  uAccent: { value: THREE.Color };
  uAccentLight: { value: THREE.Color };
  uInk: { value: THREE.Color };
  uRimColor: { value: THREE.Color };
  uRimStrength: { value: number };
  uGlowColor: { value: THREE.Color };
  uTile: { value: number };
  uDetailStrength: { value: number };
  uBaseRough: { value: number };
  uSeed: { value: number };
  uShimmer: { value: number };
  uFrozen: { value: number };
  uHurt: { value: number };
  uGlow: { value: number };
  uKinTime: { value: number };
  uPattern: { value: number };
  uSkin: { value: number };
  uIrid: { value: number };
  uScatter: { value: THREE.Color };
}

interface ShellOptions {
  t: number;
  length: number;
}

/**
 * The creature's skin. Every skin and part compiles one of three programs
 * (body, wing, fur shell): sheen and clearcoat are always present and set per
 * pixel, so the renderer builds and links each program once.
 */
function makeBodyMaterial(uniforms: BodyUniforms, skin: SkinKind, wing: boolean, shell?: ShellOptions, wingType = WING_MEMBRANE): THREE.MeshPhysicalMaterial {
  const params: THREE.MeshPhysicalMaterialParameters = {
    roughness: uniforms.uBaseRough.value,
    metalness: 0,
    color: 0xffffff,
    vertexColors: true,
    side: wing ? THREE.DoubleSide : THREE.FrontSide,
    sheen: 1,
    sheenRoughness: 0.5,
    sheenColor: new THREE.Color(0xffffff),
    clearcoat: 1,
    clearcoatRoughness: 0.35,
  };
  void skin;
  const material = new THREE.MeshPhysicalMaterial(params);
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.uniforms.uWingType = { value: wingType };
    if (shell) {
      shader.uniforms.uShellT = { value: shell.t };
      shader.uniforms.uFurLength = { value: shell.length };
    }
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        /* glsl */ `#include <common>
        attribute vec4 aMask;
        varying vec4 vKMask;
        varying vec3 vKBind;
        varying vec3 vKBindN;
        varying mat3 vKRot;
        varying float vKThin;
        varying vec2 vKUv;
        #ifdef KIN_SHELL
          uniform float uShellT;
          uniform float uFurLength;
        #endif`,
      )
      .replace(
        "#include <begin_vertex>",
        /* glsl */ `#include <begin_vertex>
        #ifdef KIN_SHELL
          // Each shell sits further out and combs back and down a little more,
          // so hairs lie along the body instead of standing straight out.
          float furAmount = (1.0 - clamp(aMask.z, 0.0, 1.0));
          vec3 combDir = vec3(0.0, -0.55, -0.85);
          vec3 comb = normalize(combDir - normal * dot(normal, combDir) + vec3(0.0, 0.0, 1e-4));
          transformed += (normal * uShellT + comb * uShellT * uShellT * 0.7) * uFurLength * furAmount;
        #endif`,
      )
      .replace(
        "#include <normal_vertex>",
        /* glsl */ `#include <normal_vertex>
        vKMask = aMask;
        vKBind = position;
        vKBindN = normal;
        vKUv = uv;
        vKThin = 0.0;
        #ifdef USE_SKINNING
          vKRot = normalMatrix * mat3(skinMatrix);
          // Ears are thin: anything skinned to the ear bones lets light through.
          vec4 earW = vec4(lessThan(abs(skinIndex - 7.5), vec4(0.6)));
          vKThin = dot(earW, skinWeight);
        #else
          vKRot = normalMatrix;
        #endif`,
      );
    shader.fragmentShader = applyWrapLighting(shader.fragmentShader)
      .replace("#include <common>", `#include <common>\n${BODY_GLSL}`)
      .replace(
        "#include <color_fragment>",
        /* glsl */ `
        vec3 kN = normalize(vKBindN);
        vec3 kBlend = pow(abs(kN), vec3(5.0));
        kBlend /= (kBlend.x + kBlend.y + kBlend.z);
        vec2 uvX = vKBind.zy * uTile;
        vec2 uvY = vKBind.zx * uTile;
        vec2 uvZ = vKBind.yx * uTile;
        vec4 dX = texture2D(uDetail, uvX);
        vec4 dY = texture2D(uDetail, uvY);
        vec4 dZ = texture2D(uDetail, uvZ);
        vec4 dSum = dX*kBlend.x + dY*kBlend.y + dZ*kBlend.z;
        float heightTerm = dSum.b;
        float tone = dSum.a;
        #ifdef KIN_SHELL
          // Only the hairs reach the outer shells, thinner the further out.
          float strand = texture2D(uStrands, uvX * 3.1).b * kBlend.x + texture2D(uStrands, uvY * 3.1 + 0.37).b * kBlend.y + texture2D(uStrands, uvZ * 3.1 + 0.71).b * kBlend.z;
          if (strand < mix(0.16, 0.86, uShellT)) discard;
        #endif
        float kAO = vKMask.x;
        float kEmis = 0.0;
        float specialAmt = clamp(vKMask.z, 0.0, 1.0);
        float creamAmt = clamp(-vKMask.z, 0.0, 1.0);
        float skinAmt = 1.0 - specialAmt;
        float kIridAmt = 0.0;
        float kRough = uBaseRough;
        float kCoat = 0.0;
        float kSheen = 0.0;
        float kH = 0.0;
        kWrap = 0.42;
        kTrans = vec3(0.0);

        vec3 kCol = uMain;
        #ifndef KIN_WING
        vec4 pat = kPattern(vKBind, kN, heightTerm, kEmis);
        float frostOverride = uPattern == 4 ? 1.0 : clamp(vKMask.w, 0.0, 1.0);
        kCol = mix(kCol, pat.rgb, pat.a * frostOverride);
        #endif
        float accentAmt = clamp(vKMask.y, 0.0, 1.0);
        float pureAmt = clamp(vKMask.y - 1.0, 0.0, 1.0);
        kCol = mix(kCol, uAccentLight, accentAmt);
        kCol = mix(kCol, uAccent, pureAmt);
        kCol = mix(kCol, vColor.rgb, max(specialAmt, creamAmt));

        if (uSkin == 0) {
          // Scales: lighter domed centres, dark crevices, each scale its own shade.
          float crevice = smoothstep(0.3, 0.06, heightTerm);
          float dome = smoothstep(0.5, 0.85, heightTerm);
          kCol *= mix(1.0, mix(0.86, 1.1, tone) * (1.0 - crevice * 0.45) * (1.0 + dome * 0.07), skinAmt);
          kRough = mix(uBaseRough * 0.8, 0.72, crevice);
          kCoat = 0.55 * (1.0 - crevice) * skinAmt;
          kIridAmt = uIrid * (1.0 - crevice) * skinAmt;
          kWrap = 0.28;
        } else if (uSkin == 4) {
          // Feathers: every feather its own shade, darker where they overlap.
          kCol *= mix(1.0, mix(0.9, 1.06, tone) * mix(0.86, 1.04, smoothstep(0.15, 0.6, heightTerm)), skinAmt);
          kRough = uBaseRough;
          kSheen = 0.55 * skinAmt;
          kIridAmt = uIrid * skinAmt;
        } else {
          // Fur and hair: strands catch the light over a darker undercoat.
          kCol *= mix(1.0, mix(0.7, 1.12, smoothstep(0.1, 0.9, heightTerm)), skinAmt * uDetailStrength);
          kRough = uBaseRough * mix(1.08, 0.9, heightTerm);
          kSheen = (uSkin == 3 ? 0.95 : 0.85) * skinAmt;
        }
        kRough = mix(kRough, 0.36, specialAmt);
        kCoat = max(kCoat, specialAmt * 0.35);

        #ifdef KIN_WING
          vec2 wuv = vKUv;
          if (uWingType == ${WING_MEMBRANE}) {
            if (pureAmt > 0.5) {
              // Leathery membrane: veins fanning from the arm, fine wrinkles near
              // the body, a darker trailing edge, and light shining through.
              float veinA = smoothstep(0.05, 0.0, abs(fract(wuv.x * 3.0 + 0.5) - 0.5) - 0.46);
              float branch = smoothstep(0.035, 0.0, abs(fract(wuv.x * 6.0 + wuv.y * 1.6) - 0.5) - 0.47) * smoothstep(0.25, 0.7, wuv.y);
              float vein = max(veinA, branch * 0.7);
              float wrinkle = (0.5 + 0.5 * sin(wuv.x * 70.0 + vnoise(vec3(wuv * 9.0, 1.0)) * 3.0)) * smoothstep(0.5, 0.0, wuv.y) * 0.5;
              float edge = smoothstep(0.82, 1.0, wuv.y);
              float mottle = vnoise(vec3(wuv * vec2(14.0, 9.0), uSeed * 5.0));
              kCol *= mix(0.86, 1.06, mottle) * (1.0 - edge * 0.3) * (1.0 - vein * 0.25);
              kH = vein * 0.8 - wrinkle * 0.3;
              kRough = 0.55; kSheen = 0.3; kCoat = 0.12;
              kTrans = kCol * uScatter * (1.0 - vein * 0.7) * 1.8;
              kWrap = 0.6;
            } else {
              kSheen = 0.5;
            }
          } else if (uWingType == ${WING_FEATHER}) {
            // A real feather: pale shaft, angled barbs, split vanes at the edge.
            float across = abs(wuv.y - 0.5) * 2.0;
            float shaft = smoothstep(0.08, 0.0, across) * smoothstep(1.0, 0.85, wuv.x);
            float barbs = 0.5 + 0.5 * sin(wuv.x * 160.0 - across * 26.0);
            float split = smoothstep(0.75, 0.95, vnoise(vec3(wuv.x * 26.0, across * 2.0, uSeed * 9.0))) * smoothstep(0.55, 0.95, across);
            kCol *= mix(0.84, 1.06, barbs) * (1.0 - split * 0.35);
            kCol = mix(kCol, mix(kCol, vec3(0.95, 0.92, 0.86), 0.55), shaft);
            kH = barbs * 0.3 + shaft * 0.6 - split * 0.4;
            kRough = mix(0.62, 0.4, shaft); kSheen = 0.6; kIridAmt = uIrid * 0.6;
            kTrans = kCol * 0.35 * (1.0 - shaft);
            kWrap = 0.5;
          } else {
            // Butterfly wings: dark veins, a dark border with pale spots, an eye
            // spot on the hind wing, a dusting of scales and a shimmering sheen.
            float t = wuv.y;
            float vein = smoothstep(0.035, 0.0, abs(fract(t * 7.0) - 0.5) - 0.465) * smoothstep(0.06, 0.25, wuv.x);
            float border = smoothstep(0.8, 0.9, wuv.x);
            float dots = smoothstep(0.35, 0.15, length(vec2((fract(t * 7.0) - 0.5) * 2.2, (wuv.x - 0.91) * 9.0)));
            float dust = vnoise(vec3(wuv * 120.0, uSeed));
            float base = smoothstep(0.35, 0.0, wuv.x);
            kCol *= mix(0.88, 1.06, dust);
            kCol = mix(kCol, kCol * 0.55, base * 0.6);
            kCol = mix(kCol, vec3(0.03, 0.025, 0.035), max(border * 0.88, vein * 0.8));
            kCol = mix(kCol, vec3(0.92, 0.9, 0.84), dots * border * 0.85);
            if (vKMask.w > 0.5) {
              float r = length(vec2(wuv.x - 0.62, (t - 0.5) * 0.9)) / 0.13;
              kCol = mix(kCol, vec3(0.02, 0.02, 0.03), smoothstep(1.0, 0.85, r));
              kCol = mix(kCol, uAccentLight, smoothstep(0.75, 0.6, r));
              kCol = mix(kCol, vec3(0.05, 0.08, 0.2), smoothstep(0.5, 0.35, r));
              kCol = mix(kCol, vec3(0.95), smoothstep(0.16, 0.06, length(vec2(wuv.x - 0.6, (t - 0.47) * 0.9)) / 0.13));
            }
            kH = vein * 0.5 + dust * 0.1;
            kRough = 0.5; kSheen = 0.4; kIridAmt = 0.55 * (1.0 - border);
            kTrans = kCol * 1.3 * (1.0 - vein);
            kWrap = 0.55;
          }
        #else
          // Light shines red-warm through the ears.
          kTrans = kCol * uScatter * vKThin * 0.8 * skinAmt;
        #endif

        #ifdef KIN_SHELL
          // Roots in shadow, tips catching the light.
          kCol *= mix(0.62, 1.14, uShellT);
        #endif
        kCol = mix(kCol, vec3(0.74, 0.9, 1.04), uFrozen*0.7);
        kCol = mix(kCol, vec3(0.5, 0.08, 0.06), uHurt*0.55);
        // A shiny Kinling's coat is pearlescent.
        kIridAmt = max(kIridAmt, uShimmer * 0.45 * skinAmt);

        diffuseColor.rgb = kCol;
        `,
      )
      .replace(
        "#include <roughnessmap_fragment>",
        /* glsl */ `
        float roughnessFactor = kRough;
        roughnessFactor = mix(roughnessFactor, 0.18, uFrozen*0.75);
        `,
      )
      .replace(
        "#include <normal_fragment_maps>",
        /* glsl */ `
        float kStrength = uDetailStrength * (1.0 - specialAmt*0.9);
        #ifdef KIN_WING
          kStrength *= 0.25;
        #endif
        vec3 tX = vec3((dX.xy*2.0-1.0)*kStrength, 1.0);
        vec3 tY = vec3((dY.xy*2.0-1.0)*kStrength, 1.0);
        vec3 tZ = vec3((dZ.xy*2.0-1.0)*kStrength, 1.0);
        tX = vec3(tX.xy + kN.zy, tX.z*abs(kN.x)*sign(kN.x));
        tY = vec3(tY.xy + kN.zx, tY.z*abs(kN.y)*sign(kN.y));
        tZ = vec3(tZ.xy + kN.yx, tZ.z*abs(kN.z)*sign(kN.z));
        vec3 kDetail = normalize(tX.zyx*kBlend.x + tY.yzx*kBlend.y + tZ.yxz*kBlend.z);
        normal = normalize(vKRot * kDetail);
        #ifdef DOUBLE_SIDED
          normal *= faceDirection;
        #endif
        #ifdef KIN_WING
          {
            // Raised veins and shafts, from screen-space derivatives.
            vec3 pos = -vViewPosition;
            vec3 dpx = dFdx(pos);
            vec3 dpy = dFdy(pos);
            float dhx = dFdx(kH * 0.004);
            float dhy = dFdy(kH * 0.004);
            vec3 r1 = cross(dpy, normal);
            vec3 r2 = cross(normal, dpx);
            float det = dot(dpx, r1);
            normal = normalize(abs(det) * normal - sign(det) * (dhx * r1 + dhy * r2));
          }
        #endif
        `,
      )
      .replace(
        "#include <lights_physical_fragment>",
        /* glsl */ `#include <lights_physical_fragment>
        {
          float kNV = saturate(dot(normal, normalize(vViewPosition)));
          // Thin-film colour: scales and feathers that shift hue with the angle.
          vec3 film = 0.5 + 0.5 * cos(6.2831 * (vec3(0.0, 0.33, 0.67) + kNV * 1.7 + uSeed * 3.0));
          material.specularColor = mix(material.specularColor, film * 0.32, kIridAmt);
          material.clearcoat = saturate(kCoat + uFrozen * 0.6);
          material.clearcoatRoughness = min(max(mix(0.3, 0.06, uFrozen), 0.0525) + geometryRoughness, 1.0);
          material.sheenColor = mix(vec3(1.0), kCol, 0.55) * kSheen * 0.7;
          material.sheenRoughness = 0.5;
        }`,
      )
      .replace(
        "#include <emissivemap_fragment>",
        /* glsl */ `
        vec3 kView = normalize(vViewPosition);
        float kFres = pow(1.0 - saturate(dot(normal, kView)), 3.0);
        // Fur and feathers scatter light at their silhouette; scales mostly reflect it.
        float fuzz = uSkin == 0 ? 0.35 : 1.0;
        totalEmissiveRadiance += uRimColor * kCol * kFres * uRimStrength * kAO * fuzz;
        totalEmissiveRadiance += uGlowColor * kFres * 1.2 * uGlow * (0.8 + 0.2*sin(uKinTime*2.0 + vKBind.y*3.0));
        totalEmissiveRadiance += vec3(1.0, 0.86, 0.42) * kEmis * 1.2;
        if (uShimmer > 0.0) {
          // Now and then a tiny glint, like light on mica.
          float sparkle = pow(max(0.0, sin(vKBind.x*61.0 + uKinTime*1.3)*sin(vKBind.y*57.0 - uKinTime*0.9)*sin(vKBind.z*53.0 + uKinTime*1.1)), 40.0);
          totalEmissiveRadiance += vec3(1.2, 1.15, 1.0) * sparkle * 1.6 * uShimmer * skinAmt;
        }
        totalEmissiveRadiance += uFrozen * vec3(0.28, 0.5, 0.75) * kFres;
        totalEmissiveRadiance += uHurt * vec3(0.8, 0.2, 0.05) * kFres * 1.5;
        `,
      )
      .replace(
        "#include <aomap_fragment>",
        /* glsl */ `#include <aomap_fragment>
        reflectedLight.directDiffuse *= mix(1.0, kAO, 0.45);
        reflectedLight.directSpecular *= kAO;
        reflectedLight.indirectDiffuse *= kAO;
        reflectedLight.indirectSpecular *= kAO*kAO;
        #ifdef USE_SHEEN
          sheenSpecularDirect *= kAO;
          sheenSpecularIndirect *= kAO;
        #endif
        `,
      );
  };
  material.customProgramCacheKey = () => `kin-body-v2-${wing ? 1 : 0}-${shell ? 1 : 0}`;
  if (wing) material.defines = { ...(material.defines ?? {}), KIN_WING: 1 };
  if (shell) material.defines = { ...(material.defines ?? {}), KIN_SHELL: 1 };
  return material;
}

/**
 * A wet, living eye on one sphere: an iris of radial fibres, crypts and a
 * collarette that sits under the cornea (it shifts with the view), a dark
 * limbal ring, a sclera with soft pink corners, lids with a lash line and a
 * moist lower rim, and a clear coat that reflects the sky and the sun.
 */
function makeEyeMaterial(uniforms: Record<string, { value: unknown }>): THREE.MeshPhysicalMaterial {
  const material = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    roughness: 0.1,
    metalness: 0,
    clearcoat: 1,
    clearcoatRoughness: 0.02,
  });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        /* glsl */ `#include <common>
        attribute vec3 aEye;
        attribute vec3 aEyeRight;
        attribute vec3 aEyeUp;
        varying vec3 vEye;
        varying vec3 vEyeView;`,
      )
      .replace(
        "#include <begin_vertex>",
        /* glsl */ `#include <begin_vertex>
        vEye = aEye;
        {
          // The view direction in the eye's own frame, for the cornea's parallax.
          vec3 worldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
          vec3 toCam = normalize(transpose(mat3(modelMatrix)) * (cameraPosition - worldPos));
          vec3 look = cross(aEyeRight, aEyeUp);
          vEyeView = vec3(dot(toCam, aEyeRight), dot(toCam, aEyeUp), dot(toCam, look));
        }`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        /* glsl */ `#include <common>
        varying vec3 vEye;
        varying vec3 vEyeView;
        uniform vec3 uIris;
        uniform vec3 uIrisInner;
        uniform vec3 uLid;
        uniform vec2 uGaze;
        uniform float uIrisR;
        uniform float uPupilR;
        uniform float uPupilAspect;
        uniform float uUpper;
        uniform float uLower;
        uniform float uLidTilt;
        uniform float uFrozen;
        uniform float uHappy;
        uniform float uEyeSeed;
        ${GLSL_NOISE}
        `,
      )
      .replace(
        "#include <color_fragment>",
        /* glsl */ `
        vec3 e = normalize(vEye);
        // The iris lies a little below the clear cornea, so it slides against
        // the eye's surface as the view changes.
        vec3 view = normalize(vEyeView);
        vec2 parallax = -view.xy / max(0.4, view.z) * 0.07 * saturate(1.0 - dot(e.xy - uGaze, e.xy - uGaze) * 1.4);
        vec2 eGaze = e.xy - uGaze + parallax;
        float er = length(eGaze) / uIrisR;
        vec2 dirE = eGaze / max(1e-4, length(eGaze));

        // Iris: fibres at three scales, darker crypts, a collarette ring and a
        // warmer inner zone around the pupil.
        float fib = vnoise(vec3(dirE * 9.0, er * 2.0 + uEyeSeed)) * 0.5 + vnoise(vec3(dirE * 23.0, er * 5.0 + uEyeSeed)) * 0.33 + vnoise(vec3(dirE * 51.0, er * 9.0)) * 0.17;
        float crypt = smoothstep(0.62, 0.86, vnoise(vec3(dirE * 13.0, er * 6.0 + 3.0 + uEyeSeed))) * smoothstep(0.32, 0.5, er) * smoothstep(0.9, 0.68, er);
        float collarR = uPupilR + 0.15 + (vnoise(vec3(dirE * 7.0, uEyeSeed)) - 0.5) * 0.08;
        float collar = smoothstep(0.05, 0.0, abs(er - collarR));
        vec3 iris = mix(uIrisInner, uIris, smoothstep(collarR - 0.06, collarR + 0.12, er));
        iris *= mix(0.6, 1.18, fib);
        iris = mix(iris, iris * 0.42, crypt * 0.7);
        iris += uIrisInner * collar * 0.22;
        // The limbal ring darkens the outer edge.
        iris *= mix(1.0, 0.22, smoothstep(0.76, 1.0, er));

        // Sclera: soft white, pinker in the corners, a few fine veins.
        float corner = smoothstep(0.35, 0.95, abs(e.x));
        float veins = smoothstep(0.9, 1.0, vnoise(vec3(e * 22.0 + uEyeSeed))) * corner * 0.6;
        vec3 sclera = mix(vec3(0.84, 0.81, 0.76), vec3(0.85, 0.62, 0.6), corner * 0.45);
        sclera = mix(sclera, vec3(0.7, 0.25, 0.24), veins * 0.35);

        vec3 eyeCol = mix(iris, sclera, smoothstep(1.0, 1.06, er));
        float pr = length(vec2(eGaze.x / uPupilAspect, eGaze.y)) / uIrisR;
        float pupil = 1.0 - smoothstep(uPupilR - 0.04, uPupilR + 0.025, pr);
        eyeCol = mix(eyeCol, vec3(0.008, 0.007, 0.012), pupil);

        // Lids are painted on the eyeball itself: one sphere, one draw call.
        float lidY = uUpper + uLidTilt*e.x - 0.35*e.x*e.x;
        float lowY = uLower + 0.28*e.x*e.x;
        float openMask = smoothstep(lidY+0.012, lidY-0.012, e.y) * smoothstep(lowY-0.012, lowY+0.012, e.y);
        // The upper lid shades the eye beneath it.
        float shade = smoothstep(lidY - 0.45, lidY - 0.02, e.y);
        eyeCol *= 1.0 - shade*0.62;
        float lashLine = smoothstep(0.06, 0.0, abs(e.y - lidY));
        float lidRound = smoothstep(lidY - 0.02, lidY + 0.5, e.y);
        // Lid skin: a little coat texture, darker towards the lash line.
        float lidFur = vnoise(vec3(e * 60.0 + uEyeSeed));
        vec3 lidCol = uLid * (0.55 + 0.45 * lidRound) * mix(0.86, 1.06, lidFur) * mix(0.7, 1.0, smoothstep(lidY, lidY + 0.12, e.y));
        eyeCol = mix(lidCol, eyeCol, openMask);
        eyeCol = mix(eyeCol, vec3(0.025,0.02,0.03), lashLine * 0.92 * openMask);
        eyeCol = mix(eyeCol, vec3(0.72,0.9,1.0), uFrozen*0.55);
        float lidAmt = 1.0 - openMask;
        float tear = smoothstep(0.03, 0.0, abs(e.y - lowY - 0.03)) * openMask;
        if (uHappy > 0.001) {
          float arc = smoothstep(0.1, 0.03, abs(e.y - (0.22 - 0.95*e.x*e.x))) * smoothstep(-0.05, 0.25, e.z);
          lidAmt = mix(lidAmt, 1.0, uHappy);
          eyeCol = mix(eyeCol, lidCol, uHappy);
          eyeCol = mix(eyeCol, vec3(0.05,0.035,0.05), arc*uHappy);
          tear *= 1.0 - uHappy;
        }
        float eyeOpen = 1.0 - lidAmt;
        diffuseColor.rgb = eyeCol;
        `,
      )
      .replace(
        "#include <roughnessmap_fragment>",
        /* glsl */ `float roughnessFactor = mix(0.62, 0.22, eyeOpen);`,
      )
      .replace(
        "#include <lights_physical_fragment>",
        /* glsl */ `#include <lights_physical_fragment>
        material.clearcoat = eyeOpen * 0.85;`,
      )
      .replace(
        "#include <emissivemap_fragment>",
        /* glsl */ `
        vec3 eN = normalize(vNormal);
        vec3 eV = normalize(vViewPosition);
        // A soft window of light on the cornea, placed where the key light would
        // reflect: a small, soft catchlight that keeps the eye alive.
        vec3 keyDir = normalize(vec3(0.34, 0.52, 0.78));
        #if NUM_DIR_LIGHTS > 0
          keyDir = normalize(mix(keyDir, directionalLights[0].direction, 0.5));
        #endif
        vec3 eR = reflect(-eV, eN);
        float key = smoothstep(0.978, 0.99, dot(eR, keyDir));
        float glint = key * eyeOpen;
        totalEmissiveRadiance += vec3(1.0, 0.98, 0.94) * glint * 0.9;
        // Light gathered in the iris below the pupil, and the wet lower lid.
        float lowGlow = smoothstep(0.4, -0.9, eGaze.y / uIrisR) * smoothstep(1.0, 0.5, er) * (1.0 - pupil);
        totalEmissiveRadiance += uIris * eyeOpen * lowGlow * 0.12;
        totalEmissiveRadiance += vec3(0.9, 0.92, 0.95) * tear * 0.18;
        `,
      );
  };
  material.customProgramCacheKey = () => "kin-eye-v2";
  return material;
}

/**
 * Horns of keratin: growth rings, fine fibres along their length, a darker
 * root and a paler, translucent tip. Gold horns are polished metal. A crest
 * of plumes (aMask.w = 1) gets feather shading instead.
 */
function makeHornMaterial(metal: number, rough: number): THREE.MeshPhysicalMaterial {
  const material = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: rough,
    metalness: metal,
    clearcoat: 0.35,
    clearcoatRoughness: 0.25,
    sheen: 1,
    sheenColor: new THREE.Color(0, 0, 0),
  });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uHornMetal = { value: metal };
    shader.uniforms.uHornRough = { value: rough };
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\nattribute vec4 aMask;\nvarying vec4 vHMask;\nvarying vec2 vHUv;`)
      .replace("#include <begin_vertex>", `#include <begin_vertex>\nvHMask = aMask;\nvHUv = uv;`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\nvarying vec4 vHMask;\nvarying vec2 vHUv;\nuniform float uHornMetal;\nuniform float uHornRough;\n${GLSL_NOISE}`)
      .replace(
        "#include <color_fragment>",
        /* glsl */ `#include <color_fragment>
        float hT = vHUv.x;
        float hA = vHUv.y;
        float hRough = uHornRough;
        float hSheen = 0.0;
        if (vHMask.w > 0.5) {
          // Plume: shaft and barbs, soft and a little glossy.
          float across = abs(hA - 0.5) * 2.0;
          float barbs = 0.5 + 0.5 * sin(hT * 140.0 - across * 22.0);
          float shaft = smoothstep(0.08, 0.0, across);
          diffuseColor.rgb *= mix(0.85, 1.05, barbs);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.95, 0.92, 0.86), shaft * 0.5);
          hRough = 0.55;
          hSheen = 0.6;
        } else {
          vec2 around = vec2(cos(hA * 6.2831), sin(hA * 6.2831));
          float rings = smoothstep(0.2, 0.8, 0.5 + 0.5 * sin(hT * 70.0 + vnoise(vec3(around * 3.0, hT * 5.0)) * 2.5));
          float fibres = vnoise(vec3(around * 14.0, hT * 3.0)) * 0.6 + vnoise(vec3(around * 40.0, hT * 7.0)) * 0.4;
          float metalHorn = step(0.5, uHornMetal);
          diffuseColor.rgb *= mix(mix(0.72, 1.1, fibres) * mix(0.82, 1.06, rings), mix(0.9, 1.05, fibres), metalHorn);
          diffuseColor.rgb *= mix(0.7, 1.0, smoothstep(0.0, 0.3, hT));
          hRough = mix(uHornRough * mix(1.1, 0.85, fibres), uHornRough * 0.7, metalHorn);
        }
        `,
      )
      .replace("#include <roughnessmap_fragment>", "float roughnessFactor = hRough;")
      .replace(
        "#include <normal_fragment_maps>",
        /* glsl */ `#include <normal_fragment_maps>
        {
          // Raised growth rings and fibres, from screen-space derivatives.
          float hh = (vHMask.w > 0.5 ? 0.0 : sin(hT * 70.0) * 0.5 + vnoise(vec3(cos(hA * 6.2831) * 30.0, sin(hA * 6.2831) * 30.0, hT * 6.0)) * 0.5) * 0.0025 * (1.0 - uHornMetal * 0.6);
          vec3 pos = -vViewPosition;
          vec3 dpx = dFdx(pos);
          vec3 dpy = dFdy(pos);
          vec3 r1 = cross(dpy, normal);
          vec3 r2 = cross(normal, dpx);
          float det = dot(dpx, r1);
          normal = normalize(abs(det) * normal - sign(det) * (dFdx(hh) * r1 + dFdy(hh) * r2));
        }`,
      )
      .replace(
        "#include <lights_physical_fragment>",
        /* glsl */ `#include <lights_physical_fragment>
        material.sheenColor = diffuseColor.rgb * hSheen * 0.5;
        material.sheenRoughness = 0.5;`,
      )
      .replace(
        "#include <emissivemap_fragment>",
        /* glsl */ `#include <emissivemap_fragment>
        {
          // The thin tip lets a little light through.
          vec3 hV = normalize(vViewPosition);
          float rimT = pow(1.0 - saturate(dot(normal, hV)), 2.0);
          totalEmissiveRadiance += diffuseColor.rgb * smoothstep(0.55, 1.0, hT) * rimT * 0.25 * (1.0 - uHornMetal);
        }`,
      )
      .replace(
        "#include <aomap_fragment>",
        `#include <aomap_fragment>\nreflectedLight.directDiffuse *= vHMask.x; reflectedLight.indirectDiffuse *= vHMask.x; reflectedLight.indirectSpecular *= vHMask.x;`,
      );
  };


  material.customProgramCacheKey = () => "kin-horn-v2";
  return material;
}

// ----- Aura ------------------------------------------------------------------

function auraColours(look: Look, generation: number): THREE.Color {
  const accent = new THREE.Color(look.accent);
  const gold = new THREE.Color("#ffd98a");
  const violet = new THREE.Color("#b7a2ff");
  const base = accent.clone().lerp(gold, 0.55);
  return base.lerp(violet, smooth(5, 11, generation) * 0.75);
}

/** Soft motes drifting up around the creature, more with each generation. */
function makeOrbitPoints(count: number, radius: number, height: number, size: number, color: THREE.Color, timeU: { value: number }, seed: number): THREE.Points {
  const rand = rng(seed);
  const pos = new Float32Array(count * 3);
  const data = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    data[i * 4] = rand() * Math.PI * 2;
    data[i * 4 + 1] = 0.25 + rand() * 0.75;
    data[i * 4 + 2] = rand();
    data[i * 4 + 3] = 0.5 + rand() * 1.6;
    pos[i * 3] = rand();
    pos[i * 3 + 1] = rand();
    pos[i * 3 + 2] = rand();
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geometry.setAttribute("aData", new THREE.BufferAttribute(data, 4));
  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: { uTime: timeU, uColor: { value: color }, uRadius: { value: radius }, uHeight: { value: height }, uSize: { value: size } },
    vertexShader: /* glsl */ `
      attribute vec4 aData;
      uniform float uTime, uRadius, uHeight, uSize;
      varying float vF;
      void main(){
        float t = fract(uTime*0.06*aData.w + aData.z);
        float a = aData.x + uTime*0.3*aData.w;
        float r = uRadius * (0.55 + 0.45*aData.y) * (1.0 + sin(t*6.28)*0.07);
        vec3 p = vec3(cos(a)*r, t*uHeight, sin(a)*r);
        // Fade in near the ground, out at the top, and twinkle gently.
        vF = sin(t*3.14159) * (0.65 + 0.35 * sin(uTime * 3.0 * aData.w + aData.x * 7.0));
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_PointSize = uSize * (0.6 + aData.y) * (220.0 / -mv.z);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      varying float vF;
      void main(){
        vec2 q = gl_PointCoord*2.0-1.0;
        float d = dot(q,q);
        if(d>1.0) discard;
        float f = pow(1.0-d, 2.5) * vF;
        gl_FragColor = vec4(uColor*(0.7+f*0.9), f*0.7);
      }
    `,
  });
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  return points;
}

/**
 * A soft pool of light on the ground under elder Kinlings: a glow with one
 * fine ring, a second ring for older lines, and a slow shimmer for the oldest.
 * The radius is a uniform so every halo shares one program.
 */
function makeHalo(radius: number, color: THREE.Color, level: number, timeU: { value: number }): THREE.Mesh {
  const geometry = new THREE.CircleGeometry(1, 48);
  geometry.rotateX(-Math.PI / 2);
  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: { uTime: timeU, uColor: { value: color }, uLevel: { value: level } },
    vertexShader: /* glsl */ `
      varying vec2 vP;
      void main(){ vP = position.xz; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime, uLevel;
      uniform vec3 uColor;
      varying vec2 vP;
      void main(){
        float r = length(vP);
        float ang = atan(vP.y, vP.x);
        float glow = pow(max(0.0, 1.0-r), 2.2)*0.4;
        float ring1 = smoothstep(0.03,0.0,abs(r-0.72)) * 0.32;
        float ring2 = smoothstep(0.02,0.0,abs(r-0.88)) * step(1.5, uLevel) * 0.22;
        float shimmer = (0.5 + 0.5*sin(ang*7.0 + uTime*0.6)) * smoothstep(0.6,0.8,r) * smoothstep(1.0,0.85,r) * step(2.5, uLevel) * 0.3;
        float pulse = 0.82 + 0.18*sin(uTime*1.4);
        float a = (glow + ring1 + ring2 + shimmer) * pulse;
        a *= smoothstep(1.0, 0.9, r);
        gl_FragColor = vec4(uColor*(0.7+a*1.2), a);
      }
    `,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.scale.setScalar(radius);
  mesh.frustumCulled = false;
  mesh.renderOrder = 2;
  return mesh;
}

// ----- Build ------------------------------------------------------------------

function clampGeneration(generation: number) {
  return Math.max(0, Math.min(16, generation));
}

// Natural eye colours: amber, sky blue, hazel, violet, green, gold. The accent tints them a little.
const IRIS_COLOURS = ["#c98a2e", "#4f92c4", "#8c6a34", "#7d62c2", "#4f9a5a", "#d6a63a"];

export function buildKin(look: Look, opts: KinOptions): Kin3D {
  const detail = opts.detail ?? "low";
  const generation = clampGeneration(opts.generation);
  const spec = HEADS[look.head] ?? HEADS[0];
  const rand = rng(look.seed + 11);

  // Bones.
  const rest = restPositions(look.head);
  const bones: THREE.Bone[] = [];
  for (let i = 0; i < BONE_COUNT; i++) {
    const bone = new THREE.Bone();
    bones.push(bone);
  }
  const boneInverses: THREE.Matrix4[] = [];
  for (let i = 0; i < BONE_COUNT; i++) {
    const p = rest[i];
    const parent = BONE_PARENT[i];
    if (parent >= 0) {
      const q = rest[parent];
      bones[i].position.set(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
      bones[parent].add(bones[i]);
    } else {
      bones[i].position.set(p[0], p[1], p[2]);
    }
    boneInverses.push(new THREE.Matrix4().makeTranslation(-p[0], -p[1], -p[2]));
  }
  const skeleton = new THREE.Skeleton(bones, boneInverses);

  // Big-headed proportions, like the 2D art.
  bones[B.head].scale.setScalar(1.14);

  const group = new THREE.Group();
  group.add(bones[B.root]);

  // Materials.

  const ownMaps = kinMaps();
  const skinKind: SkinKind = spec.skin;
  // The skin drives the shading; the Scales pattern gives any coat real scales.
  let shading: SkinKind = skinKind;
  let detailTexture: THREE.Texture = ownMaps[skinKind];
  let tile = skinKind === "scale" ? 2.1 : skinKind === "shag" ? 1.5 : skinKind === "feather" ? 1.9 : 2.6;
  let strength = skinKind === "hide" ? 0.5 : skinKind === "scale" ? 1.1 : 1;
  let rough = skinKind === "scale" ? 0.4 : skinKind === "hide" ? 0.46 : skinKind === "feather" ? 0.6 : 0.8;
  if (look.pattern === 3 && skinKind !== "scale") {
    detailTexture = ownMaps.scale;
    shading = "scale";
    tile = 2.1;
    strength = 1;
    rough = 0.46;
  }
  const main = new THREE.Color(look.main);
  const accent = new THREE.Color(look.accent);
  const accentLight = accent.clone().lerp(new THREE.Color(1, 1, 1), 0.48);
  const ink = accent.clone().multiplyScalar(0.82);
  // Blood under thin skin warms the light that passes through.
  const scatter = shading === "scale" ? new THREE.Color(1.0, 0.86, 0.76) : new THREE.Color(1.0, 0.72, 0.6);

  const uniforms: BodyUniforms = {
    uDetail: { value: detailTexture },
    uStrands: { value: ownMaps.strands },
    uMain: { value: main },
    uAccent: { value: accent },
    uAccentLight: { value: accentLight },
    uInk: { value: ink },
    uRimColor: { value: new THREE.Color("#fff1dc") },
    uRimStrength: { value: 0.42 },
    uGlowColor: { value: auraColours(look, generation) },
    uTile: { value: tile },
    uDetailStrength: { value: strength },
    uBaseRough: { value: rough },
    uSeed: { value: (look.seed % 977) / 977 },
    uShimmer: { value: look.shiny ? 1 : 0 },
    uFrozen: { value: 0 },
    uHurt: { value: 0 },
    uGlow: { value: generation === 0 ? 0 : 0.05 + generation * 0.03 },
    uKinTime: sharedTime,
    uPattern: { value: look.pattern },
    uSkin: { value: SKIN_ID[shading] },
    uIrid: { value: shading === "scale" ? 0.55 : shading === "feather" ? 0.22 : 0 },
    uScatter: { value: scatter },
  };

  const bodyMaterial = makeBodyMaterial(uniforms, skinKind, false);
  const ownedMaterials: THREE.Material[] = [bodyMaterial];
  const disposables: { dispose(): void }[] = [];

  const skinned = (geometry: THREE.BufferGeometry, material: THREE.Material) => {
    const mesh = new THREE.SkinnedMesh(geometry, material);
    mesh.bind(skeleton, new THREE.Matrix4());
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    group.add(mesh);
    return mesh;
  };

  const mainGeo = mainGeometry(look.head, detail);
  skinned(mainGeo, bodyMaterial);

  // Layered fur shells for portraits and the hero view: individual combed
  // hairs at the silhouette. The shells use the lighter "low" mesh, which is
  // within a hair's width of the detailed one, so they cost a fraction of it.
  const addShells = (geometry: THREE.BufferGeometry, material: BodyUniforms, count: number, length: number) => {
    for (let i = 0; i < count; i++) {
      const shellMaterial = makeBodyMaterial(material, skinKind, false, { t: (i + 1) / count, length });
      ownedMaterials.push(shellMaterial);
      const mesh = new THREE.SkinnedMesh(geometry, shellMaterial);
      mesh.bind(skeleton, new THREE.Matrix4());
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      group.add(mesh);
    }
  };
  // Fur only: shells over the scale map would read as spikes.
  if (detail === "high" && (skinKind === "fur" || skinKind === "shag") && look.pattern !== 3) {
    addShells(mainGeometry(look.head, "low"), uniforms, skinKind === "shag" ? 10 : 8, skinKind === "shag" ? 0.09 : 0.055);
  }

  // Eyes.
  const irisIndex = look.seed % IRIS_COLOURS.length;
  const iris = new THREE.Color(IRIS_COLOURS[irisIndex]).lerp(accent, 0.14);
  // Around the pupil the iris is warmer and lighter, as in most animals' eyes.
  const irisInner = iris.clone().lerp(new THREE.Color("#e8a83a"), 0.2).multiplyScalar(1.12);
  const eyeUniforms: Record<string, { value: unknown }> = {
    uIris: { value: iris },
    uIrisInner: { value: irisInner },
    uLid: { value: main.clone().multiplyScalar(0.92) },
    uGaze: { value: new THREE.Vector2(0, 0) },
    uIrisR: { value: look.eyes === 2 ? 0.92 : 0.86 },
    uPupilR: { value: look.eyes === 3 ? 0.42 : 0.56 },
    // Reptiles and foxes have a slightly upright pupil.
    uPupilAspect: { value: look.head === 0 ? 0.62 : look.head === 1 ? 0.8 : 1 },
    uUpper: { value: 0.6 },
    uLower: { value: -0.72 },
    uLidTilt: { value: look.eyes === 3 ? 0.38 : 0 },
    uFrozen: uniforms.uFrozen,
    uHappy: { value: 0 },
    uEyeSeed: { value: (look.seed % 131) / 13.1 },
  };
  const eyeMaterial = makeEyeMaterial(eyeUniforms);
  ownedMaterials.push(eyeMaterial);
  const eyes = new THREE.Mesh(eyeGeometry(look.head, look.eyes, detail), eyeMaterial);
  eyes.castShadow = true;
  bones[B.head].add(eyes);
  eyes.position.set(0, 0, 0);

  // Horns.
  const hornGeo = hornGeometry(look.horn, look.head);
  if (hornGeo) {
    const isGold = look.horn === 2;
    const hornMat = makeHornMaterial(isGold ? 0.75 : 0, isGold ? 0.3 : look.horn === 3 ? 0.62 : 0.46);
    ownedMaterials.push(hornMat);
    const horn = new THREE.Mesh(hornGeo, hornMat);
    horn.castShadow = true;
    bones[B.head].add(horn);
    if (isGold) {
      hornMat.emissive = new THREE.Color("#f2b13b");
      hornMat.emissiveIntensity = 0.2;
    }
  }

  // Tail.
  let flameTailMesh: THREE.Mesh | null = null;
  const tailGeo = tailGeometry(look.tail, detail);
  if (tailGeo) {
    const tail = skinned(tailGeo, look.tail === 3 ? makeTailFanMaterial(uniforms, skinKind) : bodyMaterial);
    if (tail.material !== bodyMaterial) ownedMaterials.push(tail.material as THREE.Material);
    if (detail === "high" && look.tail === 1 && look.pattern !== 3) addShells(tailGeometry(1, "low") ?? tailGeo, uniforms, 8, 0.065);
  }

  const flameMaterial = look.tail === 4 || look.wing === 3 ? createFlameMaterial(sharedTime) : null;
  if (flameMaterial) ownedMaterials.push(flameMaterial);
  if (look.tail === 4 && flameMaterial) {
    flameTailMesh = new THREE.Mesh(cachedFlame("tail"), flameMaterial);
    flameTailMesh.frustumCulled = false;
    bones[B.tail1].add(flameTailMesh);
    flameTailMesh.position.set(0, 0, 0.28);
    flameTailMesh.renderOrder = 3;
  }

  // Wings.
  const wingGeo = wingGeometry(look.wing);
  if (wingGeo) {
    const wingMat = makeBodyMaterial(uniforms, look.wing === 2 ? "feather" : "hide", true, undefined, look.wing === 2 ? WING_FEATHER : look.wing === 4 ? WING_BUTTERFLY : WING_MEMBRANE);
    ownedMaterials.push(wingMat);
    const wingMesh = skinned(wingGeo, wingMat);
    wingMesh.castShadow = true;
  }
  if (look.wing === 3 && flameMaterial) {
    for (const [kind, shoulder] of [["wingL", B.wLa], ["wingR", B.wRa]] as const) {
      const mesh = new THREE.Mesh(cachedFlame(kind), flameMaterial);
      mesh.frustumCulled = false;
      mesh.renderOrder = 3;
      bones[shoulder].add(mesh);
    }
  }

  // Bone-driven extras: generation aura and shimmer sparkles.
  const auraColor = auraColours(look, generation);
  let halo: THREE.Mesh | null = null;
  let crown: THREE.Mesh | null = null;
  if (generation >= 1) {
    const motes = makeOrbitPoints(8 + generation * 6, 0.9 + generation * 0.03, 1.8, 0.04 + generation * 0.003, auraColor, sharedTime, look.seed + 7);
    group.add(motes);
    const motesMat = motes.material as THREE.Material;
    ownedMaterials.push(motesMat);
    disposables.push(motes.geometry);
    if (generation >= 3) {
      const haloLevel = generation >= 9 ? 3 : generation >= 6 ? 2 : 1;
      halo = makeHalo(1 + generation * 0.05, auraColor, haloLevel, sharedTime);
      halo.position.y = 0.02;
      group.add(halo);
      ownedMaterials.push(halo.material as THREE.Material);
      disposables.push(halo.geometry);
    }
    if (generation >= 7) {
      const embers = makeOrbitPoints(24, 0.55, 2.4, 0.035, new THREE.Color("#ffb98a"), sharedTime, look.seed + 21);
      group.add(embers);
      ownedMaterials.push(embers.material as THREE.Material);
      disposables.push(embers.geometry);
    }
    if (generation >= 9) {
      // A crown of light floating above the head.
      const crownGeo = new THREE.TorusGeometry(0.34, 0.008, 6, 48);
      crownGeo.rotateX(Math.PI / 2);
      const crownMat = new THREE.MeshBasicMaterial({ color: auraColor.clone().multiplyScalar(1.4), transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false });
      crown = new THREE.Mesh(crownGeo, crownMat);
      crown.position.set(0, 0.72, 0);
      bones[B.head].add(crown);
      ownedMaterials.push(crownMat);
      disposables.push(crownGeo);
    }
  }
  if (look.shiny) {
    const sparkle = makeOrbitPoints(14, 0.8, 1.6, 0.04, new THREE.Color("#fff1b8"), sharedTime, look.seed + 33);
    group.add(sparkle);
    ownedMaterials.push(sparkle.material as THREE.Material);
    disposables.push(sparkle.geometry);
  }

  // Ice that grows over a frozen creature: clear hexagonal crystals with
  // pointed tips, clustered round the legs and body.
  const iceMat = new THREE.MeshPhysicalMaterial({
    color: "#e2f4ff",
    roughness: 0.06,
    metalness: 0,
    transparent: true,
    opacity: 0.42,
    clearcoat: 1,
    clearcoatRoughness: 0.03,
    emissive: "#7cc8ff",
    emissiveIntensity: 0.14,
    flatShading: true,
  });
  const ice = new THREE.Group();
  ice.visible = false;
  const crystal = iceCrystalGeometry();
  for (let i = 0; i < 16; i++) {
    const shard = new THREE.Mesh(crystal, iceMat);
    const angle = rand() * Math.PI * 2;
    const radius = 0.3 + rand() * 0.42;
    const x = Math.cos(angle) * radius;
    const z = Math.sin(angle) * radius * 1.3;
    shard.position.set(x, rand() * 0.35, z);
    const s = 0.05 + rand() * 0.05;
    shard.scale.set(s, 0.16 + rand() * 0.2, s);
    // Lean outwards, as crystals do when they grow from a surface.
    shard.rotation.set(z * 0.7 + (rand() - 0.5) * 0.4, rand() * 6.2, -x * 0.7 + (rand() - 0.5) * 0.4);
    ice.add(shard);
  }
  group.add(ice);
  ownedMaterials.push(iceMat);

  const size = kinSize(opts.level);
  group.scale.setScalar(size);

  // ----- Animation state ----------------------------------------------------

  const seedPhase = (look.seed % 1000) / 159;
  let time = rand() * 100;
  let phase = rand() * 6.28;
  let blinkAt = 1 + rand() * 3;
  let blinkT = 0;
  let joyS = 0;
  let hurtS = 0;
  let frozenS = 0;
  let attackS = 0;
  let speedS = 0;
  let airS = 0;
  let hop = 0;
  let hopV = 0;
  let wasJoy = 0;
  const lookTarget = new THREE.Vector3(0, 0, 1);
  let lookEnabled = false;
  let headYaw = 0;
  let headPitch = 0;
  let gazeX = 0;
  let gazeY = 0;
  let idleYaw = 0;
  let idlePitch = 0;
  let idleChange = 0;
  let idleYawTarget = 0;
  let idlePitchTarget = 0;

  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const setRot = (bone: number, x: number, y: number, z: number) => {
    e.set(x, y, z, "XYZ");
    q.setFromEuler(e);
    bones[bone].quaternion.copy(q);
  };

  const handleUpdate = (dt: number, pose: KinPose) => {
    const speedTarget = clamp(pose.speed);
    const k = (rate: number) => 1 - Math.exp(-dt * rate);
    speedS += (speedTarget - speedS) * k(9);
    joyS += (clamp(pose.joy) - joyS) * k(10);
    hurtS += (clamp(pose.hurt) - hurtS) * k(14);
    frozenS += (clamp(pose.frozen) - frozenS) * k(8);
    attackS += (clamp(pose.attack) - attackS) * k(16);
    airS += ((pose.airborne ? 1 : 0) - airS) * k(12);

    // Freezing slows every motion, down to nothing.
    const life = 1 - frozenS;
    const dtLife = dt * life;
    time += dtLife;
    sharedTime.value = performance.now() / 1000;
    uniforms.uFrozen.value = frozenS;
    uniforms.uHurt.value = hurtS;
    ice.visible = frozenS > 0.03;
    if (ice.visible) ice.scale.setScalar(smooth(0, 1, frozenS));

    // Joy hop.
    if (pose.joy > 0.5 && wasJoy <= 0.5 && airS < 0.5) hopV = 5.2;
    wasJoy = pose.joy;
    if (hopV !== 0 || hop > 0) {
      hop += hopV * dtLife;
      hopV -= 16 * dtLife;
      if (hop <= 0) {
        hop = 0;
        hopV = pose.joy > 0.25 ? 4.4 : 0;
      }
    }

    // Stride.
    const stride = 8 + speedS * 11;
    phase += dtLife * stride * clamp(speedS * 2.2);
    const s = Math.sin(phase);
    const c = Math.cos(phase);
    const gallop = smooth(0.35, 0.9, speedS);
    const stepping = clamp(speedS * 3);

    // Blink.
    blinkAt -= dtLife;
    if (blinkAt <= 0) {
      blinkT = 1;
      blinkAt = 1.8 + rand() * 4.2;
    }
    if (blinkT > 0) blinkT = Math.max(0, blinkT - dtLife * 7);
    const blink = blinkT > 0 ? Math.sin(blinkT * Math.PI) : 0;

    // Body bob and squash and stretch.
    const idleBreath = Math.sin(time * 2.1 + seedPhase);
    const gallopBounce = gallop * Math.abs(Math.sin(phase)) * 0.2;
    const walkBounce = stepping * (1 - gallop) * Math.abs(Math.sin(phase)) * 0.05;
    let lift = gallopBounce + walkBounce + hop * 0.7 + airS * 0.05 + idleBreath * 0.006;
    let hurtShake = Math.sin(time * 42) * hurtS * 0.09;
    let stretch = 1 + gallop * Math.sin(phase * 2) * 0.1 + clamp(hopV * 0.04) * 0.3;
    if (hop > 0) stretch += 0.06;
    // Landing squash.
    if (hop === 0 && hopV === 0 && joyS > 0.1) stretch -= 0.03;

    bones[B.root].position.y = lift + hurtShake * 0.2;
    bones[B.root].position.x = hurtShake * 0.8;
    bones[B.root].rotation.set(
      lerp(Math.sin(phase * 2 + 0.6) * gallop * 0.22, -0.42, airS * 0.0) + hurtS * 0.24 * Math.sin(time * 18),
      0,
      hurtS * 0.16 * Math.sin(time * 26),
    );
    const sq = 1 / Math.sqrt(Math.max(0.3, stretch));
    bones[B.root].scale.set(sq, stretch, sq);

    // Spine rocks with the gallop.
    const rock = gallop * Math.sin(phase) * 0.14;
    setRot(B.hips, rock + idleBreath * 0.01, 0, Math.sin(phase * 0.5) * 0.03 * stepping);
    setRot(B.chest, -rock * 1.4 - idleBreath * 0.012, 0, -Math.sin(phase * 0.5) * 0.03 * stepping);
    const breathing = 1 + idleBreath * 0.012 * (1 - stepping * 0.6);
    bones[B.chest].scale.set(breathing, breathing, 1);

    // Legs. Gallop bounds, walk alternates.
    const legsFront = [0, Math.PI * 0.14].map((offset) => phase + offset);
    const legsHind = [Math.PI * 0.9, Math.PI * 1.06].map((offset) => phase + offset);
    const walkFront = [phase, phase + Math.PI];
    const walkHind = [phase + Math.PI, phase];
    const legPose = (u: number, phaseGallop: number, phaseWalk: number, front: boolean) => {
      const ph = lerp(phaseWalk, phaseGallop, gallop);
      const sn = Math.sin(ph);
      const cs = Math.cos(ph);
      const reach = lerp(0.42, 0.82, gallop) * stepping;
      const swing = sn * reach;
      const lift2 = Math.max(0, cs) * lerp(0.75, 1.2, gallop) * stepping;
      const air = airS * (front ? -0.9 : 0.7);
      setRot(u, -swing + air + (front ? hurtS * 0.3 : 0), 0, 0);
      setRot(u + 1, lift2 * (front ? 0.9 : 1.05) + airS * 0.7, 0, 0);
      setRot(u + 2, -lift2 * 0.45 + swing * 0.2 - airS * 0.25, 0, 0);
    };
    legPose(B.flU, legsFront[0], walkFront[0], true);
    legPose(B.frU, legsFront[1], walkFront[1], true);
    legPose(B.hlU, legsHind[0], walkHind[0], false);
    legPose(B.hrU, legsHind[1], walkHind[1], false);

    // Head and neck.
    idleChange -= dtLife;
    if (idleChange <= 0) {
      idleChange = 1.5 + rand() * 3.5;
      idleYawTarget = (rand() - 0.5) * 0.9;
      idlePitchTarget = (rand() - 0.5) * 0.3;
    }
    idleYaw += (idleYawTarget - idleYaw) * k(2);
    idlePitch += (idlePitchTarget - idlePitch) * k(2);

    let yawTarget = idleYaw * (1 - stepping * 0.75);
    let pitchTarget = idlePitch * (1 - stepping * 0.75);
    if (lookEnabled) {
      yawTarget = clamp(Math.atan2(lookTarget.x, lookTarget.z), -1, 1);
      pitchTarget = clamp(-Math.atan2(lookTarget.y, Math.hypot(lookTarget.x, lookTarget.z)), -0.6, 0.5);
    }
    headYaw += (yawTarget - headYaw) * k(6);
    headPitch += (pitchTarget - headPitch) * k(6);

    const counterRock = gallop * Math.sin(phase * 2) * 0.09;
    const nod = idleBreath * 0.012 + stepping * Math.sin(phase * 2) * 0.05;
    const attackThrust = attackS * 0.5;
    const joyUp = joyS * 0.28;
    const hurtDown = hurtS * 0.35;
    const neckRoll = hurtS * Math.sin(time * 22) * 0.06;
    setRot(B.neck0, nod * 0.8 + counterRock - joyUp * 0.4 + hurtDown * 0.5 + attackThrust * 0.3, headYaw * 0.3, neckRoll);
    setRot(B.neck1, -attackThrust * 0.15 + nod * 0.6 - joyUp * 0.2, headYaw * 0.3, 0);
    setRot(B.head, headPitch + nod * 0.5 - joyUp * 0.5 - attackThrust * 0.35 + hurtDown * 0.2, headYaw * 0.45, Math.sin(time * 1.2 + seedPhase) * 0.02 + joyS * 0.12 * Math.sin(time * 4));

    // Mouth.
    const speak = joyS * (0.42 + Math.sin(time * 7) * 0.08);
    const open = Math.max(speak, attackS * (0.85 + Math.sin(time * 30) * 0.04), hurtS * 0.28);
    setRot(B.jaw, open * (look.head === 3 ? 0.8 : 0.72), 0, 0);

    // Ears: flick now and then, flatten when hurt.
    const earFlick = Math.sin(time * 1.1 + seedPhase) > 0.95 ? Math.sin(time * 22) * 0.2 : 0;
    const earSpeed = gallop * 0.3;
    const earBase = hurtS * 0.3 + earSpeed;
    setRot(B.earL, earBase + earFlick, 0, -joyS * 0.12);
    setRot(B.earR, earBase - earFlick * 0.6, 0, joyS * 0.12);

    // Tail: sway, stream behind when running, wag with joy.
    const wag = Math.sin(time * 3.1 + seedPhase) * 0.2;
    const joyWag = Math.sin(time * 15) * joyS * 0.42;
    const runDroop = speedS * 0.22;
    setRot(B.tail0, -0.06 + runDroop * 0.4 + Math.sin(phase) * gallop * 0.1, wag * 0.6 + joyWag * 0.6, 0);
    setRot(B.tail1, runDroop * 0.3, wag * 0.75 + joyWag * 0.5, Math.sin(time * 2.1 + 1.2 + seedPhase) * 0.04);
    setRot(B.tail2, runDroop * 0.3, wag * 0.9 + joyWag * 0.3, 0);
    setRot(B.tail3, runDroop * 0.2, wag, 0);
    setRot(B.tail4, -hurtS * 0.3, wag * 1.2, 0);

    // Wings: held half open at rest, beat when moving or happy.
    if (look.wing !== 0) {
      const rate = airS > 0.5 ? 16 : stepping > 0.4 ? 9 : joyS > 0.3 ? 14 : 2.1;
      const amp = airS > 0.5 ? 0.85 : stepping > 0.4 ? 0.45 : joyS > 0.3 ? 0.55 : 0.07;
      const beat = Math.sin(time * rate + seedPhase);
      const open = clamp(airS + stepping * 0.35 + joyS * 0.7);
      const butterfly = look.wing === 4;
      const flame = look.wing === 3;
      for (const [a, side] of [[B.wLa, 1], [B.wRa, -1]] as const) {
        if (butterfly) {
          // Butterfly wings stand up in a V and clap together.
          const clap = 0.95 + beat * (0.16 + amp * 0.5);
          setRot(a, 0, side * 0.14, side * clap);
          setRot(a + 1, 0, 0, side * (beat * amp * 0.25));
          setRot(a + 2, 0, 0, 0);
        } else if (flame) {
          setRot(a, 0, side * 0.42, side * (0.55 + beat * amp));
          setRot(a + 1, 0, 0, side * beat * amp * 0.4);
          setRot(a + 2, 0, 0, side * beat * amp * 0.2);
        } else {
          // Feathered and bat wings sweep back and up, elbows gently bent.
          const sweep = lerp(1.05, 0.2, open);
          const elbow = lerp(0.52, 0.08, open);
          const raise = lerp(0.72, 0.28, open) + beat * amp;
          setRot(a, 0, side * sweep, side * raise);
          setRot(a + 1, 0, side * elbow, side * (beat * amp * 0.5 - elbow * 0.35));
          setRot(a + 2, 0, side * elbow * 0.75, side * (-elbow * 0.6 + beat * amp * 0.3));
        }
      }
    }

    // Eyes: gaze, blink and expression.
    const uU = eyeUniforms.uUpper as { value: number };
    const uL = eyeUniforms.uLower as { value: number };
    const gaze = eyeUniforms.uGaze as { value: THREE.Vector2 };
    const happy = smooth(0.35, 0.8, joyS);
    const hurtEye = smooth(0.25, 0.8, hurtS);
    const baseUpper = look.eyes === 1 ? 0.14 : look.eyes === 3 ? 0.4 : 0.6;
    const closeUpper = lerp(baseUpper, -0.25, blink);
    let upper = lerp(closeUpper, -0.25, hurtEye);
    upper = lerp(upper, baseUpper * 0.45, attackS * 0.5);
    uU.value = upper;
    uL.value = lerp(lerp(-0.72, -0.26, blink), -0.3, hurtEye);
    (eyeUniforms.uHappy as { value: number }).value = happy;
    const saccade = idleYawTarget * 0.28;
    const gx = lookEnabled ? clamp(lookTarget.x * 0.4, -0.3, 0.3) : saccade;
    const gy = lookEnabled ? clamp(lookTarget.y * 0.2, -0.2, 0.2) : idlePitchTarget * 0.18;
    gazeX += (gx - gazeX) * k(14);
    gazeY += (gy - gazeY) * k(14);
    gaze.value.set(gazeX, gazeY);

    if (halo) halo.rotation.y += dt * 0.25;
    if (crown) crown.rotation.y += dt * 0.6;
    void lift;
    hurtShake = 0;
    void hurtShake;
    void c;
    void s;
  };

  const kin: Kin3D = {
    group,
    height: 1.6 * size,
    update: handleUpdate,
    look(offset) {
      if (offset) {
        lookEnabled = true;
        lookTarget.copy(offset);
      } else {
        lookEnabled = false;
      }
    },
    setDaylight(day) {
      uniforms.uRimStrength.value = 0.18 + day * 0.44;
    },
    dispose() {
      for (const material of ownedMaterials) material.dispose();
      for (const item of disposables) item.dispose();
      skeleton.dispose();
    },
  };

  handleUpdate(0.016, IDLE_POSE);
  return kin;
}

/**
 * Builds the shared geometry for every head and tail during idle time, so the
 * first creature of each kind does not cost a hitch while the game is running.
 */
export function prewarmKinGeometry(detail: "high" | "low" | "far" = "far", onDone?: () => void) {
  const jobs: (() => void)[] = [];
  for (let head = 0; head < 5; head++) {
    jobs.push(() => mainGeometry(head, detail));
    jobs.push(() => eyeGeometry(head, 0, detail));
  }
  for (let tail = 0; tail < 5; tail++) jobs.push(() => tailGeometry(tail, detail));
  const idle = (work: () => void) => {
    const ric = (window as unknown as { requestIdleCallback?: (fn: () => void) => void }).requestIdleCallback;
    if (ric) ric(work);
    else setTimeout(work, 30);
  };
  const next = () => {
    const job = jobs.shift();
    if (!job) {
      onDone?.();
      return;
    }
    job();
    idle(next);
  };
  idle(next);
}

/**
 * Creatures with every program variant, for pre-compiling shaders before a
 * scene starts drawing. Add the groups, call renderer.compileAsync, then
 * remove and dispose them.
 */
export function kinWarmupSet(look: Look): Kin3D[] {
  const variants: Partial<Look>[] = [
    { head: 0, horn: 1, wing: 1, tail: 0 },
    { head: 3, horn: 5, wing: 3, tail: 4, shiny: true },
    { head: 2, horn: 2, wing: 2, tail: 3 },
    { head: 1, horn: 3, wing: 4, tail: 1, pattern: 5 },
    { head: 4, horn: 4, wing: 0, tail: 2, pattern: 2 },
  ];
  return variants.map((v, i) => {
    const kin = buildKin({ ...look, ...v }, { level: 6, generation: i === 0 ? 10 : i === 1 ? 7 : 3, detail: "far" });
    // Show parts that normally start hidden, so their programs compile too.
    kin.group.traverse((child) => {
      child.visible = true;
    });
    return kin;
  });
}

let crystalGeo: THREE.BufferGeometry | null = null;

/** A six-sided ice crystal with a pointed tip, shared by every frozen creature. */
function iceCrystalGeometry(): THREE.BufferGeometry {
  if (!crystalGeo) {
    crystalGeo = new THREE.LatheGeometry([new THREE.Vector2(0.0, -0.05), new THREE.Vector2(0.8, -0.05), new THREE.Vector2(1, 0.12), new THREE.Vector2(1, 1.2), new THREE.Vector2(0.0, 1.85)], 6);
  }
  return crystalGeo;
}

function makeTailFanMaterial(uniforms: BodyUniforms, skin: SkinKind): THREE.MeshPhysicalMaterial {
  return makeBodyMaterial(uniforms, skin, true, undefined, WING_FEATHER);
}
