// A simple test page: many creature combinations under the game's lighting.
// Open three-test.html, add ?mode=species|heads|horns|wings|tails|patterns|eyes|generations|poses|run.

import * as THREE from "three";
import { lookFromGenes, type Look } from "../creature.ts";
import { buildKin, type KinPose, type Kin3D, IDLE_POSE } from "./kin3d.ts";
import { Atmosphere, PostFX } from "./atmosphere.ts";
import { cropGeometry, getCropMaterial, tickCrops } from "./crops.ts";
import { windTime } from "./flora.ts";
import type { Quality } from "./gfx.ts";

const params = new URLSearchParams(location.search);
const mode = params.get("mode") ?? "species";

function makeLook(head: number, horn: number, wing: number, tail: number, pattern: number, eyes: number, main: number, accent: number, shiny = 0, seed = 1): Look {
  const genes = [head, head, horn, horn, wing, wing, tail, tail, pattern, pattern, eyes, eyes, main, main, accent, accent, 3, 0, 3, 0, 3, 0, shiny];
  const look = lookFromGenes(genes);
  look.seed = (look.seed + seed * 97) >>> 0;
  return look;
}

interface Item {
  look: Look;
  generation: number;
  level: number;
  pose?: Partial<KinPose>;
  label: string;
}

const items: Item[] = [];

const CLASSIC: [number, number, number, number, number, number, number, number, string][] = [
  [0, 1, 1, 0, 3, 0, 2, 4, "Dragon"],
  [2, 2, 0, 2, 0, 2, 9, 3, "Unicorn"],
  [3, 0, 2, 2, 0, 3, 4, 11, "Griffin"],
  [3, 5, 3, 4, 0, 0, 2, 4, "Phoenix"],
  [1, 0, 0, 1, 0, 2, 4, 9, "Kitsune"],
  [4, 0, 0, 1, 4, 0, 9, 1, "Yeti"],
  [2, 0, 2, 2, 5, 2, 10, 12, "Pegasus"],
  [0, 3, 4, 3, 1, 1, 5, 14, "Hybrid"],
  [1, 3, 0, 1, 2, 0, 6, 15, "Jackalope"],
  [1, 4, 1, 0, 2, 3, 11, 2, "Chimera"],
  [4, 4, 0, 0, 3, 3, 8, 15, "Golem"],
  [3, 5, 2, 3, 2, 2, 7, 13, "Roc"],
];

const GRID: Record<string, () => void> = {
  headshot() {
    [[0, 0, 2, 4], [1, 0, 4, 9], [2, 0, 10, 12], [3, 0, 6, 11], [4, 0, 8, 1]].forEach(([h, ho, m, a]) => {
      items.push({ look: makeLook(h, ho, 0, 2, 0, 0, m, a, 0, h + 3), generation: 0, level: 6, label: "head " + h });
    });
  },
  headhorn() {
    [[0, 1, 2, 4], [1, 3, 4, 9], [2, 2, 10, 12], [3, 5, 6, 11], [4, 4, 8, 1]].forEach(([h, ho, m, a]) => {
      items.push({ look: makeLook(h, ho, 2, 2, 0, 1 + (h % 3), m, a, 0, h + 3), generation: 0, level: 6, label: "head " + h });
    });
  },
  faces() {
    CLASSIC.slice(0, 6).forEach(([h, ho, w, t, p, e, m, a, name], i) => {
      items.push({ look: makeLook(h, ho, w, t, p, e, m, a, 0, i), generation: 0, level: 6, label: name });
    });
  },
  species() {
    CLASSIC.forEach(([h, ho, w, t, p, e, m, a, name], i) => {
      items.push({ look: makeLook(h, ho, w, t, p, e, m, a, 0, i), generation: 0, level: 6, label: name });
    });
  },
  heads() {
    for (let h = 0; h < 5; h++) items.push({ look: makeLook(h, 0, 0, 2, 0, 0, 0, 2), generation: 0, level: 6, label: `head ${h}` });
  },
  horns() {
    for (let i = 0; i < 6; i++) items.push({ look: makeLook(i % 5, i, 0, 0, 0, 0, 1 + i, 4), generation: 0, level: 6, label: `horn ${i}` });
  },
  wings() {
    for (let i = 0; i < 5; i++) items.push({ look: makeLook(3 - (i % 2), 0, i, 2, 0, 0, 4 + i, 2), generation: 0, level: 6, label: `wing ${i}` });
  },
  tails() {
    for (let i = 0; i < 5; i++) items.push({ look: makeLook(1, 0, 0, i, 0, 0, 2, 4 + i), generation: 0, level: 6, label: `tail ${i}` });
  },
  patterns() {
    for (let i = 0; i < 6; i++) items.push({ look: makeLook(1, 0, 0, 1, i, 0, 1, 2), generation: 0, level: 6, label: `pattern ${i}` });
  },
  eyes() {
    for (let i = 0; i < 4; i++) items.push({ look: makeLook(1, 0, 0, 1, 0, i, 12, 4), generation: 0, level: 6, label: `eyes ${i}` });
  },
  generations() {
    [0, 1, 3, 6, 9, 12].forEach((g) => items.push({ look: makeLook(1, 3, 2, 1, 1, 0, 3, 4, g === 9 ? 1 : 0), generation: g, level: 6, label: `gen ${g}` }));
  },
  poses() {
    const poses: [string, Partial<KinPose>][] = [
      ["idle", {}],
      ["joy", { joy: 1 }],
      ["hurt", { hurt: 1 }],
      ["frozen", { frozen: 1 }],
      ["attack", { attack: 1 }],
      ["air", { airborne: true, speed: 1 }],
    ];
    poses.forEach(([name, pose], i) => items.push({ look: makeLook((i * 2) % 5, 1, i % 2 ? 2 : 1, 1, 0, 0, 2 + i, 4), generation: 0, level: 6, pose, label: name }));
  },
  run() {
    for (let i = 0; i < 6; i++) {
      items.push({ look: makeLook(i % 5, i % 6, (i * 2) % 5, i % 5, i % 6, i % 4, 3 + i, 4 + i), generation: i, level: 6, pose: { speed: 0.2 + i * 0.16 }, label: `run ${i}` });
    }
  },
  close() {
    // One creature up close: ?mode=close&i=0..11&pose=joy|hurt|frozen|attack|air|run&gen=0&shiny=1
    const index = Number(params.get("i") ?? 0) % CLASSIC.length;
    const [h, ho, w, t, p, e, m, a, name] = CLASSIC[index];
    const poses: Record<string, Partial<KinPose>> = { joy: { joy: 1 }, hurt: { hurt: 1 }, frozen: { frozen: 1 }, attack: { attack: 1 }, air: { airborne: true, speed: 1 }, run: { speed: 0.8 } };
    const pattern = params.has("pattern") ? Number(params.get("pattern")) : p;
    items.push({ look: makeLook(h, ho, w, t, pattern, e, m, a, Number(params.get("shiny") ?? 0), index), generation: Number(params.get("gen") ?? 0), level: 6, pose: poses[params.get("pose") ?? ""] ?? {}, label: name });
  },
  crops() {
    // Built below; no creatures.
  },
  lineup() {
    // Six racers side by side at roughly race distance.
    CLASSIC.slice(Number(params.get("from") ?? 0), Number(params.get("from") ?? 0) + 6).forEach(([h, ho, w, t, p, e, m, a, name], i) => {
      items.push({ look: makeLook(h, ho, w, t, p, e, m, a, 0, i), generation: Number(params.get("gen") ?? 0), level: 6, pose: params.get("pose") === "run" ? { speed: 0.85 } : {}, label: name });
    });
  },
};
(GRID[mode] ?? GRID.species)();

const canvas = document.getElementById("c") as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
const ratio = Math.min(devicePixelRatio, 2);
renderer.setPixelRatio(ratio);
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
const quality = (params.get("quality") as Quality | null) ?? "high";
const atmosphere = new Atmosphere(scene, renderer, { quality, shadowRange: 22, far: 300 });
atmosphere.setPhase(Number(params.get("phase") ?? 0.28));
const post = new PostFX(renderer, { quality });
post.setSize(Math.round(innerWidth * ratio), Math.round(innerHeight * ratio));

const ground = new THREE.Mesh(new THREE.CircleGeometry(160, 48), new THREE.MeshStandardMaterial({ color: "#6e8a50", roughness: 0.95 }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

const camera = new THREE.PerspectiveCamera(30, innerWidth / innerHeight, 0.1, 800);

const count = items.length;
const columns = Math.max(1, Math.min(count, mode === "species" ? 4 : mode === "faces" ? 3 : mode === "headshot" || mode === "headhorn" ? 5 : 6));
const rows = Math.max(1, Math.ceil(count / columns));
const spacingX = Number(params.get("sx") ?? (mode === "faces" ? 3.6 : mode === "headshot" || mode === "headhorn" ? 3.1 : mode === "lineup" ? 2.6 : 5.2));
const spacingZ = Number(params.get("sz") ?? (mode === "faces" ? 3.4 : 4.6));
const kins: { kin: Kin3D; pose: KinPose }[] = [];
const buildStart = performance.now();

items.forEach((item, i) => {
  const c = i % columns;
  const r = Math.floor(i / columns);
  const kin = buildKin(item.look, { level: item.level, generation: item.generation, detail: params.get("detail") === "low" ? "low" : "high" });
  kin.group.position.set((c - (columns - 1) / 2) * spacingX, 0, (r - (rows - 1) / 2) * spacingZ);
  kin.group.rotation.y = Number(params.get("ry") ?? 0.5);
  scene.add(kin.group);
  kins.push({ kin, pose: { ...IDLE_POSE, ...item.pose } });
});

// Field crops: every crop at every stage, ?mode=crops (rows are crops, columns stages).
const crops: THREE.Mesh[] = [];
if (mode === "crops") {
  const soil = new THREE.MeshStandardMaterial({ color: "#6b4a33", roughness: 1 });
  const plot = new THREE.BoxGeometry(1.7, 0.12, 1.7);
  for (let item = 1; item <= 6; item++) {
    for (let stage = 0; stage < 4; stage++) {
      const x = (stage - 1.5) * 2.3;
      const z = (item - 3.5) * 2.3;
      const bed = new THREE.Mesh(plot, soil);
      bed.position.set(x, 0.06, z);
      bed.receiveShadow = true;
      scene.add(bed);
      const crop = new THREE.Mesh(cropGeometry(item, stage), getCropMaterial());
      crop.position.set(x, 0.12, z);
      crop.rotation.y = item * 1.3 + stage;
      crop.castShadow = true;
      crop.receiveShadow = true;
      scene.add(crop);
      crops.push(crop);
    }
  }
}

console.info("build ms", Math.round(performance.now() - buildStart));
const width = columns * spacingX;
const depth = rows * spacingZ;
const zoomFactor = Number(params.get("zoom") ?? 1);
const centerY = mode === "faces" ? 0.95 : 0.8;
const eyeHeight = mode === "faces" ? 2.0 + rows * 1.4 : 6 + rows * 2.2;
const eyeDistance = (mode === "faces" ? 7.5 + width * 1.05 : 15 + Math.max(width, depth * 1.6) * 1.05) * zoomFactor;
camera.position.set(0, eyeHeight, eyeDistance);
camera.lookAt(0, centerY, -rows * 0.2);
if (mode === "headshot" || mode === "headhorn") {
  camera.fov = 14;
  camera.updateProjectionMatrix();
  camera.position.set(0, 1.6, 25);
  camera.lookAt(0, 1.18, 0);
}
if (mode === "close") {
  // Framed like a hero shot: ?focus=head|body, ?yaw=radians around the creature.
  const kin = kins[0].kin;
  const size = kin.height / 1.6;
  const body = params.get("focus") === "body";
  const yaw = Number(params.get("yaw") ?? 0.35);
  const distance = (body ? 5.2 : 2.6) * size * zoomFactor;
  const target = new THREE.Vector3(0, (body ? 0.8 : 1.12) * size, body ? 0 : 0.55 * size);
  kin.group.rotation.y = 0;
  camera.fov = 28;
  camera.updateProjectionMatrix();
  camera.position.set(target.x + Math.sin(yaw) * distance, target.y + distance * 0.2, target.z + Math.cos(yaw) * distance);
  camera.lookAt(target);
}
if (mode === "lineup") {
  camera.fov = 30;
  camera.updateProjectionMatrix();
  camera.position.set(0, 4.2 * zoomFactor, 15 * zoomFactor);
  camera.lookAt(0, 0.9, 0);
}
if (mode === "crops") {
  camera.fov = 30;
  camera.updateProjectionMatrix();
  const view = params.get("view");
  if (view === "row") {
    // One crop's stages, close: &item=1..6
    const item = Number(params.get("item") ?? 1);
    const z = (item - 3.5) * 2.3;
    camera.position.set(0, 2.6 * zoomFactor, z + 6.5 * zoomFactor);
    camera.lookAt(0, 0.6, z);
  } else {
    camera.position.set(0, 13 * zoomFactor, 15 * zoomFactor);
    camera.lookAt(0, 0.4, 0.6);
  }
}
camera.updateMatrixWorld();

addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  post.setSize(Math.round(innerWidth * ratio), Math.round(innerHeight * ratio));
});

const focus = new THREE.Vector3(0, 0, 0);
const clock = new THREE.Clock();
// ?still=1 freezes animation time so screenshots are repeatable.
const still = params.get("still") === "1";
if (still) for (let i = 0; i < 60; i++) for (const k of kins) k.kin.update(0.033, k.pose);
let elapsed = 0;
const fps = { frames: 0, since: performance.now(), value: 0 };
function frame() {
  const dt = still ? 0.016 : Math.min(0.05, clock.getDelta());
  elapsed += dt;
  for (const k of kins) k.kin.update(still ? 0 : dt, k.pose);
  windTime.value = elapsed;
  tickCrops(elapsed);
  atmosphere.update(dt, focus, camera);
  post.render(scene, camera, dt);
  fps.frames++;
  const now = performance.now();
  if (now - fps.since > 1000) {
    fps.value = (fps.frames * 1000) / (now - fps.since);
    fps.frames = 0;
    fps.since = now;
  }
  requestAnimationFrame(frame);
}
frame();
Object.assign(window, { THREE, scene, camera, renderer, kins, atmosphere, post, crops, galleryFps: fps });
document.getElementById("hint")!.textContent = mode + " (" + items.length + ")";
