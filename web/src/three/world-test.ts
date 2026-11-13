// Test page for the world graphics alone: the race course, its scenery,
// obstacles and pickups under the real sky, with a camera set from the URL.
// Open world-test.html?phase=0.31&cam=0,4,8&look=0,1.7,-14&fov=60&mode=race|pieces

import * as THREE from "three";
import {
  Atmosphere,
  PostFX,
  createDirtTrack,
  createObstacle,
  createPickup,
  createTrackGround,
  createTrackScenery,
  detectQuality,
  installEffectLights,
  warmUpTrackShaders,
  type Piece,
} from "./track.ts";
import { warmShadowCasters } from "./atmosphere.ts";

const params = new URLSearchParams(location.search);
const phase = Number(params.get("phase") ?? 0.31);
const mode = params.get("mode") ?? "race";
const vec = (text: string | null, fallback: [number, number, number]) => {
  const parts = (text ?? "").split(",").map(Number);
  return parts.length === 3 && parts.every((v) => Number.isFinite(v)) ? new THREE.Vector3(...parts) : new THREE.Vector3(...fallback);
};

function xBend(z: number): number {
  const fade = Math.min(1, -z / 90);
  return fade > 0 ? fade * (11 * Math.sin(z / 92) + 4.5 * Math.sin(z / 37)) : 0;
}

const canvas = document.getElementById("stage") as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: "high-performance" });
const quality = detectQuality(renderer.getContext() as WebGL2RenderingContext);
const ratio = Math.min(devicePixelRatio || 1, quality === "high" ? 2 : 1.5);
renderer.setPixelRatio(ratio);
renderer.shadowMap.enabled = quality !== "low";
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(Number(params.get("fov") ?? 60), 1, 0.3, 900);
const atmosphere = new Atmosphere(scene, renderer, { quality, shadows: quality !== "low", shadowRange: 34, far: 520 });
atmosphere.setPhase(phase);
const post = new PostFX(renderer, { quality, bloomStrength: 0.42 });
const releaseLights = installEffectLights(scene);

const zStart = 70;
const zEnd = -890;
const ground = createTrackGround({ zStart, zEnd, xBend });
scene.add(ground.mesh);
const track = createDirtTrack({ zStart, zEnd, width: 13.4, xBend });
scene.add(track.mesh);
const scenery = createTrackScenery({ zStart: zStart - 20, zEnd: zEnd + 20, width: 13.4, xBend, seed: 11, quality });
scene.add(scenery.group);

const pieces: Piece[] = [];
const place = (piece: Piece, lane: number, z: number) => {
  piece.group.position.set(lane * 3.5 + xBend(z), 0, z);
  piece.group.rotation.y = -Math.atan(xBend(z - 0.5) - xBend(z + 0.5));
  scene.add(piece.group);
  pieces.push(piece);
};
if (mode === "pieces") {
  place(createObstacle("log", { lanes: 2, laneWidth: 3.5 }), -0.5, -6);
  place(createObstacle("rock", { lanes: 1, laneWidth: 3.5 }), 1, -6);
  place(createObstacle("thorn", { lanes: 2, laneWidth: 3.5 }), 0.5, -14);
  place(createPickup("berry"), -1, -14);
  place(createObstacle("mud", { lanes: 3, laneWidth: 3.5 }), 0, -24);
  place(createObstacle("ramp", { lanes: 1, laneWidth: 3.5 }), -1, -34);
  place(createPickup("orb"), 1, -33);
  place(createObstacle("rock", { lanes: 3, laneWidth: 3.5 }), 0, -44);
} else {
  place(createObstacle("log", { lanes: 2, laneWidth: 3.5 }), -0.5, -40);
  place(createObstacle("rock", { lanes: 1, laneWidth: 3.5 }), 1, -40);
  place(createPickup("berry"), 0, -25);
  place(createObstacle("thorn", { lanes: 3, laneWidth: 3.5 }), 0, -70);
  place(createObstacle("mud", { lanes: 2, laneWidth: 3.5 }), 0.5, -100);
  place(createPickup("orb"), -1, -90);
}

const cam = vec(params.get("cam"), [0, 4, 8]);
const look = vec(params.get("look"), [0, 1.7, -14]);
const fly = params.get("fly");

function resize() {
  const width = innerWidth;
  const height = innerHeight;
  renderer.setSize(width, height, false);
  post.setSize(width * ratio, height * ratio);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}
addEventListener("resize", resize);
resize();

const kit = {
  ready: false,
  fps: 0,
  warmMs: 0,
  scene,
  camera,
  renderer,
  atmosphere,
  post,
  setPhase: (p: number) => atmosphere.setPhase(p),
  warmShadows: () => warmShadowCasters(renderer, scene, camera),
  programKeys: () => (renderer.info.programs ?? []).map((p) => (p as unknown as { cacheKey: string }).cacheKey),
};
Object.assign(window, { worldTest: kit });

async function main() {
  const t0 = performance.now();
  camera.position.copy(cam);
  camera.lookAt(look);
  camera.updateMatrixWorld();
  renderer.setRenderTarget(post.sceneTarget);
  const release = await warmUpTrackShaders(renderer, scene, camera);
  renderer.setRenderTarget(null);
  kit.warmMs = Math.round(performance.now() - t0);
  let last = performance.now();
  let frames = 0;
  let fpsAt = last;
  let travelled = 0;
  const loop = (time: number) => {
    requestAnimationFrame(loop);
    const dt = Math.min(0.1, (time - last) / 1000);
    last = time;
    frames++;
    if (time - fpsAt > 1000) {
      kit.fps = (frames * 1000) / (time - fpsAt);
      frames = 0;
      fpsAt = time;
    }
    if (fly) {
      travelled += dt * Number(fly);
      const z = cam.z - travelled;
      camera.position.set(cam.x + xBend(z), cam.y, z);
      camera.lookAt(look.x + xBend(z + look.z - cam.z), look.y, z + look.z - cam.z);
    }
    for (const piece of pieces) piece.update(dt);
    scenery.update(dt, camera.position.z - 8);
    atmosphere.update(dt, new THREE.Vector3(camera.position.x, 0, camera.position.z - 10), camera);
    post.render(scene, camera, dt);
    kit.ready = true;
  };
  requestAnimationFrame(loop);
  void release;
  void releaseLights;
}
void main();
