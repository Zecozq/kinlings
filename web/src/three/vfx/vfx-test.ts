// Effects test page: each race effect alone, at race scale, under the race's
// own sky, light, bloom and tone mapping. Open vfx-test.html?fx=explosion&t=0.3
//
//   fx     which effect (see SCENES below)          t      seconds to show
//   cam    race | side | close | wide | orbit | top  seed   random seed
//   quality low | medium | high                      run    1 = racers run
//
// window.vfxTest.run(name, t, opts) re-simulates with a fixed 1/60 s step, so
// a screenshot is repeatable; vfxTest.bench(name, t, frames) times frames.

import * as THREE from "three";
import { lookFromGenes } from "../../creature.ts";
import { Atmosphere, PostFX, createDirtTrack, createTrackGround, createTrackScenery, detectQuality, type Quality } from "../track.ts";
import { buildKin, type Kin3D } from "../kin3d.ts";
import * as VFX from "../vfx.ts";
import type { Effect, ShieldEffect } from "../vfx.ts";

type Opts = Record<string, string | number | undefined>;

interface Running {
  effects: Effect[];
  /** Per-step hook for moving things, finishing, chaining. */
  step?: (time: number, dt: number) => void;
  /** Where the camera looks, by default. */
  focus: () => THREE.Vector3;
  /** Effects parented to racers: removed on reset. */
  attached?: { parent: THREE.Object3D; effect: Effect }[];
}

const params = new URLSearchParams(location.search);
const canvas = document.getElementById("stage") as HTMLCanvasElement;
const hud = document.getElementById("hud")!;
if (params.get("hud") === "0") hud.classList.add("hidden");

const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: "high-performance" });
const quality: Quality = detectQuality(renderer.getContext() as WebGL2RenderingContext);
VFX.setEffectQuality(quality);
const pixelRatio = Math.min(devicePixelRatio || 1, quality === "high" ? 2 : 1.5);
renderer.setPixelRatio(pixelRatio);
renderer.shadowMap.enabled = quality !== "low";
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, 1, 0.3, 900);
const atmosphere = new Atmosphere(scene, renderer, { quality, shadows: quality !== "low", shadowRange: 34, far: 520 });
atmosphere.setPhase(Number(params.get("phase") ?? 0.31));
const post = new PostFX(renderer, { quality, bloomStrength: 0.42 });
VFX.installEffectLights(scene);

const ground = createTrackGround({ zStart: 120, zEnd: -400 });
scene.add(ground.mesh);
const track = createDirtTrack({ zStart: 120, zEnd: -400, width: 13.4 });
scene.add(track.mesh);
const scenery = params.get("scenery") === "0" ? null : createTrackScenery({ zStart: 100, zEnd: -380, width: 13.4, seed: 11, quality });
if (scenery) scene.add(scenery.group);

function genes(head: number, horn: number, wing: number, tail: number, main: number, accent: number, pattern: number): number[] {
  const out = new Array(25).fill(0);
  [head, horn, wing, tail, pattern, 1, main, accent].forEach((value, locus) => {
    out[locus * 2] = value;
    out[locus * 2 + 1] = value;
  });
  return out;
}

const HEIGHT = 2.15;
function racer(look: number[], x: number, z: number): Kin3D {
  const kin = buildKin(lookFromGenes(look), { level: 4, generation: 2, detail: "high" });
  kin.group.scale.multiplyScalar(HEIGHT / Math.max(0.5, kin.height));
  kin.group.traverse((object) => {
    if ((object as THREE.Mesh).isMesh) object.castShadow = quality !== "low";
  });
  kin.group.position.set(x, 0, z);
  kin.group.rotation.y = Math.PI;
  scene.add(kin.group);
  return kin;
}
const caster = racer(genes(0, 1, 1, 0, 3, 6, 0), 0, 0);
const target = racer(genes(2, 2, 0, 2, 9, 2, 1), 0, -12);
const bystander = racer(genes(3, 5, 3, 4, 5, 1, 3), 3.5, -15);

function resize() {
  const width = canvas.clientWidth || innerWidth;
  const height = canvas.clientHeight || innerHeight;
  renderer.setSize(width, height, false);
  post.setSize(width * pixelRatio, height * pixelRatio);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(canvas);
resize();

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const num = (opts: Opts, key: string, fallback: number) => (opts[key] === undefined ? fallback : Number(opts[key]));

// ----- Scenes ---------------------------------------------------------------------

const SCENES: Record<string, (opts: Opts) => Running> = {
  fireball(opts) {
    const speed = num(opts, "speed", 66);
    const ball = VFX.createFireball({ scale: 1.7 });
    const start = v(0, 1.35, -1.6);
    ball.object.position.copy(start);
    let effects: Effect[] = [ball];
    let flying = true;
    const hitZ = target.group.position.z;
    return {
      effects,
      step(time) {
        if (!flying) return;
        const z = start.z - speed * time;
        if (z <= hitZ + 0.6 && num(opts, "hit", 1)) {
          flying = false;
          const boom = ball.explode(scene);
          run.effects = run.effects.filter((e) => e !== ball);
          scene.remove(ball.object);
          ball.dispose();
          run.effects.push(boom);
          return;
        }
        ball.object.position.set(0, 1.35, z);
      },
      focus: () => (flying ? ball.object.position.clone() : v(0, 1.35, hitZ)),
    };
  },
  explosion(opts) {
    const scale = num(opts, "scale", 1.7);
    const fire = VFX.createFireball({ scale });
    fire.object.position.set(0, num(opts, "y", 1.35), target.group.position.z + 0.6);
    const boom = fire.explode(scene);
    fire.dispose();
    return { effects: [boom], focus: () => v(0, 1.6, target.group.position.z) };
  },
  burnrow(opts) {
    return SCENES.explosion({ ...opts, scale: 2.2, y: 1 });
  },
  launch() {
    const fx = VFX.createFireLaunch(v(0, 1.4, -1.4), v(0, 0, -1), { scale: 1.7 });
    return { effects: [fx], focus: () => v(0, 1.4, -2) };
  },
  frostcast() {
    const at = v(0, 1.1, -8);
    return { effects: [VFX.createFrostCloud(at, { radius: 6 })], focus: () => v(0, 1, -9) };
  },
  frosthit() {
    const at = target.group.position.clone().setY(1.1);
    return { effects: [VFX.createFrostCloud(at, { radius: 1.8 })], focus: () => at.clone() };
  },
  lightning() {
    const p = target.group.position;
    return { effects: [VFX.createLightning(v(p.x, 16, p.z), v(p.x, 0, p.z))], focus: () => v(p.x, 2.5, p.z) };
  },
  wind(opts) {
    const effects: Effect[] = [VFX.createWindDash(v(0, 1.2, 0), v(0, 0, 1), { length: 12 })];
    let timer = 0;
    const ambient = num(opts, "ambient", 1);
    return {
      effects,
      step(_time, dt) {
        if (!ambient) return;
        timer -= dt;
        if (timer > 0) return;
        timer = 0.16;
        const me = caster.group.position;
        const at = v(me.x + (Math.random() < 0.5 ? -1 : 1) * (2.5 + Math.random() * 4), 1 + Math.random() * 2.4, me.z - 2);
        const fx = VFX.createWindDash(at, v(0, 0, 1), { length: 7 });
        scene.add(fx.object);
        run.effects.push(fx);
      },
      focus: () => v(0, 1.2, -3),
    };
  },
  shield(opts) {
    const group = target.group;
    const shield = VFX.createShieldBubble({ radius: 1.7 / group.scale.x, color: "#8fd6ff" });
    shield.object.position.y = 1.05 / group.scale.x;
    group.add(shield.object);
    const finishAt = num(opts, "finish", 99);
    let live = true;
    return {
      effects: [],
      attached: [{ parent: group, effect: shield }],
      step(time, dt) {
        if (live && time >= finishAt) {
          live = false;
          shield.finish();
        }
        // The race stops calling update once it has called finish().
        if (live) shield.update(dt);
      },
      focus: () => v(group.position.x, 1.2, group.position.z),
    };
  },
  vines(opts) {
    const p = target.group.position;
    const vines = VFX.createVineTrap(v(p.x, 0, p.z), { radius: 1.5 });
    const finishAt = num(opts, "finish", 1.2);
    let done = false;
    return {
      effects: [vines],
      step(time) {
        if (!done && time >= finishAt) {
          done = true;
          vines.finish();
        }
      },
      focus: () => v(p.x, 1, p.z),
    };
  },
  trap(opts) {
    const at = v(0, 0.03, -10);
    const vines = VFX.createVineTrap(at, { radius: 1.7, ...(opts.lurk === undefined ? {} : { lurk: Number(opts.lurk) === 1 }) } as { radius: number });
    const finishAt = num(opts, "finish", 99);
    let done = false;
    return {
      effects: [vines],
      step(time) {
        if (!done && time >= finishAt) {
          done = true;
          vines.finish();
        }
      },
      focus: () => at.clone().setY(0.6),
    };
  },
  blink(opts) {
    const p = target.group.position;
    const mode = opts.mode as string | undefined;
    const fx = VFX.createBlinkShimmer(v(p.x, 1.1, p.z), { color: (opts.color as string) ?? "#c9a7ff", ...(mode ? { mode } : {}) } as { color: string });
    return { effects: [fx], focus: () => v(p.x, 1.2, p.z) };
  },
  blinkpair() {
    const p = target.group.position;
    const landed = v(p.x, 1.1, p.z);
    const left = landed.clone();
    left.z += 22;
    return { effects: [VFX.createBlinkShimmer(landed, { color: "#c9a7ff" }), VFX.createBlinkShimmer(left, { color: "#c9a7ff" })], focus: () => landed.clone() };
  },
  dust(opts) {
    const p = target.group.position;
    const count = num(opts, "count", 7);
    return { effects: [VFX.createDustPuffs(v(p.x, count > 10 ? 0.4 : 0.1, p.z), { count })], focus: () => v(p.x, 0.6, p.z) };
  },
  burnaura() {
    return aura(() => VFX.createBurnAura());
  },
  frostaura() {
    return aura(() => VFX.createFrostAura());
  },
  shockaura() {
    return aura(() => VFX.createShockAura());
  },
  heal() {
    const group = target.group;
    const fx = VFX.createSecondWind();
    group.add(fx.object);
    return { effects: [], attached: [{ parent: group, effect: fx }], step(_t, dt) { fx.update(dt); }, focus: () => v(group.position.x, 1.2, group.position.z) };
  },
  impact() {
    const p = target.group.position;
    return { effects: [VFX.createImpactSparks(v(p.x, 1.2, p.z + 0.8))], focus: () => v(p.x, 1.2, p.z) };
  },
};

/** An aura on the target racer, who can run (opts.run). */
function aura(make: () => ShieldEffect): Running {
  const group = target.group;
  const fx = make();
  group.add(fx.object);
  return {
    effects: [],
    attached: [{ parent: group, effect: fx }],
    step(_time, dt) {
      fx.update(dt);
    },
    focus: () => v(group.position.x, 1.2, group.position.z),
  };
}

// ----- Running ----------------------------------------------------------------------

let run: Running = { effects: [], focus: () => v(0, 1, -10) };
let runOpts: Opts = {};
let simTime = 0;
let orbit = 0;

function clearRun() {
  for (const effect of run.effects) {
    scene.remove(effect.object);
    effect.dispose();
  }
  for (const { parent, effect } of run.attached ?? []) {
    parent.remove(effect.object);
    effect.dispose();
  }
  run = { effects: [], focus: () => v(0, 1, -10) };
}

function placeRacers(time: number) {
  const running = Number(runOpts.run ?? 0) === 1;
  const speed = running ? 20 : 0;
  target.group.position.set(0, 0, -12 - speed * time);
  caster.group.position.set(0, 0, -speed * time);
  bystander.group.position.set(3.5, 0, -15 - speed * time);
  const pose = { speed: running ? 1 : 0, airborne: false, joy: 0, hurt: 0, frozen: 0, attack: 0 };
  return pose;
}

function placeCamera(dt: number) {
  const mode = String(runOpts.cam ?? "race");
  const f = run.focus();
  const running = Number(runOpts.run ?? 0) === 1;
  const casterZ = caster.group.position.z;
  let fov = 60;
  if (mode === "race") {
    const z = casterZ + 7.4 + (running ? 1.8 : 0);
    camera.position.set(0, 3.9, z);
    camera.lookAt(0, 1.7, casterZ - 14);
    fov = running ? 70 : 60;
  } else if (mode === "side") {
    camera.position.set(f.x + 7.5, f.y + 1.2, f.z + 3.5);
    camera.lookAt(f);
    fov = 45;
  } else if (mode === "close") {
    camera.position.set(f.x + 3.2, f.y + 0.6, f.z + 3.4);
    camera.lookAt(f);
    fov = 50;
  } else if (mode === "front") {
    camera.position.set(f.x + 1.5, f.y + 0.8, f.z - 7);
    camera.lookAt(f);
    fov = 50;
  } else if (mode === "wide") {
    camera.position.set(f.x + 13, f.y + 6, f.z + 14);
    camera.lookAt(f.x, f.y + 2, f.z);
    fov = 50;
  } else if (mode === "top") {
    camera.position.set(f.x + 0.01, f.y + 14, f.z + 4);
    camera.lookAt(f.x, 0, f.z);
    fov = 55;
  } else if (mode === "orbit") {
    orbit += dt * 0.35;
    const r = Number(runOpts.r ?? 8);
    camera.position.set(f.x + Math.sin(orbit) * r, f.y + 1.5, f.z + Math.cos(orbit) * r);
    camera.lookAt(f);
    fov = 50;
  }
  if (runOpts.campos) {
    const [x, y, z] = String(runOpts.campos).split(",").map(Number);
    camera.position.set(x, y, z);
    const [lx, ly, lz] = String(runOpts.look ?? `${f.x},${f.y},${f.z}`).split(",").map(Number);
    camera.lookAt(lx, ly, lz);
  }
  if (runOpts.fov) fov = Number(runOpts.fov);
  if (camera.fov !== fov) {
    camera.fov = fov;
    camera.updateProjectionMatrix();
  }
}

function frame(dt: number, simulate = true) {
  if (simulate) {
    simTime += dt;
    const pose = placeRacers(simTime);
    for (const kin of [caster, target, bystander]) kin.update(dt, pose);
    run.step?.(simTime, dt);
    let index = 0;
    while (index < run.effects.length) {
      const effect = run.effects[index];
      if (effect.update(dt)) {
        index += 1;
      } else {
        scene.remove(effect.object);
        effect.dispose();
        run.effects.splice(index, 1);
      }
    }
  }
  placeCamera(dt);
  scenery?.update(dt, camera.position.z - 7);
  atmosphere.update(dt, caster.group.position, camera);
  post.render(scene, camera, dt);
}

function start(name: string, opts: Opts) {
  clearRun();
  runOpts = opts;
  simTime = 0;
  orbit = Number(opts.orbit ?? 0.6);
  VFX.seedEffects(Number(opts.seed ?? 7));
  placeRacers(0);
  const make = SCENES[name];
  if (!make) throw new Error(`no scene ${name}`);
  run = make(opts);
  for (const effect of run.effects) scene.add(effect.object);
}

async function runTo(name: string, t: number, opts: Opts = {}) {
  start(name, opts);
  const dt = 1 / 60;
  const steps = Math.round(t / dt);
  for (let i = 0; i < steps; i++) frame(dt);
  frame(0, false);
  hud.textContent = `${name}  t=${t.toFixed(2)}s  quality=${quality}  calls=${post.lastCalls}`;
}

/** Average milliseconds per frame (CPU and GPU, with a finish) for `frames` frames. */
async function bench(name: string, t: number, frames = 60, opts: Opts = {}) {
  const gl = renderer.getContext();
  const measure = (simulate: boolean) => {
    const times: number[] = [];
    for (let i = 0; i < frames; i++) {
      const t0 = performance.now();
      frame(1 / 60, simulate);
      gl.finish();
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    return times[Math.floor(times.length / 2)];
  };
  clearRun();
  runOpts = opts;
  placeRacers(0);
  for (let i = 0; i < 10; i++) frame(1 / 60, false);
  const base = measure(false);
  // Hold the effect at time t: re-run to t before each sample batch.
  const samples: number[] = [];
  for (let k = 0; k < 3; k++) {
    await runTo(name, t, opts);
    samples.push(measure(false));
  }
  samples.sort((a, b) => a - b);
  return { base: +base.toFixed(2), withEffect: +samples[1].toFixed(2), cost: +(samples[1] - base).toFixed(2), calls: post.lastCalls };
}

/**
 * GPU time of the frame with the effect shown and hidden on alternate frames
 * (EXT_disjoint_timer_query_webgl2), so slow drifts from other GPU users
 * cancel out. Also the CPU time of one update() of the effect's state.
 */
async function gpuBench(name: string, t: number, frames = 80, opts: Opts = {}) {
  const gl = renderer.getContext() as WebGL2RenderingContext;
  const ext = gl.getExtension("EXT_disjoint_timer_query_webgl2") as { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null;
  if (!ext) return { error: "no timer queries" };
  await runTo(name, t, opts);
  const objects = [...run.effects.map((e) => e.object), ...(run.attached ?? []).map((a) => a.effect.object)];
  const pending: { query: WebGLQuery; shown: boolean }[] = [];
  const shown: number[] = [];
  const hidden: number[] = [];
  const collect = () => {
    while (pending.length && gl.getQueryParameter(pending[0].query, gl.QUERY_RESULT_AVAILABLE)) {
      const { query, shown: visible } = pending.shift()!;
      const ns = gl.getQueryParameter(query, gl.QUERY_RESULT) as number;
      gl.deleteQuery(query);
      if (!gl.getParameter(ext.GPU_DISJOINT_EXT)) (visible ? shown : hidden).push(ns / 1e6);
    }
  };
  for (let i = 0; i < frames; i++) {
    const visible = i % 2 === 0;
    for (const object of objects) object.visible = visible;
    const query = gl.createQuery()!;
    gl.beginQuery(ext.TIME_ELAPSED_EXT, query);
    frame(0, false);
    gl.endQuery(ext.TIME_ELAPSED_EXT);
    pending.push({ query, shown: visible });
    await new Promise((resolve) => requestAnimationFrame(resolve));
    collect();
  }
  for (let wait = 0; wait < 30 && pending.length; wait++) {
    await new Promise((resolve) => setTimeout(resolve, 30));
    collect();
  }
  for (const object of objects) object.visible = true;
  const median = (list: number[]) => {
    const sorted = [...list].sort((a, b) => a - b);
    return sorted.length ? sorted[Math.floor(sorted.length / 2)] : NaN;
  };
  // CPU cost of the simulation: re-run and time update() alone.
  await runTo(name, Math.max(0, t - 0.1), opts);
  let cpu = 0;
  const steps = 6;
  for (let i = 0; i < steps; i++) {
    const t0 = performance.now();
    for (const effect of run.effects) effect.update(1 / 60);
    for (const { effect } of run.attached ?? []) effect.update(1 / 60);
    cpu += performance.now() - t0;
  }
  const withMs = median(shown);
  const withoutMs = median(hidden);
  return { gpuWith: +withMs.toFixed(2), gpuWithout: +withoutMs.toFixed(2), gpuCost: +(withMs - withoutMs).toFixed(2), cpuUpdate: +(cpu / steps).toFixed(3), samples: shown.length + hidden.length, calls: post.lastCalls };
}

const api = {
  ready: false,
  quality,
  run: runTo,
  bench,
  gpuBench,
  /** Compiled programs: names, so a test can see if an effect compiled one mid-race. */
  programs: () => (renderer.info.programs ?? []).map((p) => `${p.name}#${p.id}`),
  scenes: Object.keys(SCENES),
  live(name: string, opts: Opts = {}) {
    start(name, opts);
    let last = performance.now();
    let frames = 0;
    let fpsAt = last;
    const loop = (now: number) => {
      requestAnimationFrame(loop);
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      frame(dt);
      frames++;
      if (now - fpsAt > 1000) {
        hud.textContent = `${name} live  ${((frames * 1000) / (now - fpsAt)).toFixed(1)} fps  calls=${post.lastCalls}`;
        frames = 0;
        fpsAt = now;
      }
      if (run.effects.length === 0 && !(run.attached?.length)) start(name, opts);
    };
    requestAnimationFrame(loop);
  },
};
Object.assign(window, { vfxTest: api });

// Warm up like the race does: compile everything first.
renderer.setRenderTarget(post.sceneTarget);
const warm = [
  VFX.createFireball(),
  VFX.createFrostCloud(v(0, 1, 0)),
  VFX.createLightning(v(0, 1, 0), v(1, 4, 0)),
  VFX.createWindDash(v(0, 1, 0), v(0, 0, -1)),
  VFX.createShieldBubble(),
  VFX.createVineTrap(v(0, 1, 0)),
  VFX.createBlinkShimmer(v(0, 1, 0)),
  VFX.createDustPuffs(v(0, 1, 0)),
];
const holder = new THREE.Group();
for (const effect of warm) holder.add(effect.object);
scene.add(holder);
await renderer.compileAsync(scene, camera);
scene.remove(holder);
renderer.setRenderTarget(null);
for (let i = 0; i < 3; i++) frame(1 / 60, false);

const fx = params.get("fx");
if (fx) {
  const opts: Opts = {};
  params.forEach((value, key) => {
    opts[key] = value;
  });
  if (params.get("live") === "1") api.live(fx, opts);
  else await runTo(fx, Number(params.get("t") ?? 0.5), opts);
}
api.ready = true;
