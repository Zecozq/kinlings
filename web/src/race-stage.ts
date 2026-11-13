// The 3D view of a race. It only ever draws what the race engine says happened.
//
// The engine's track is a straight line of millimetres. Here one metre is one
// world unit, the race runs towards -Z, and the course bends for the eye only.

import * as THREE from "three";
import { D } from "./core.ts";
import type { Look } from "./creature.ts";
import { EVENT, HAZARD, type Frame, type GhostPoint, type RaceEvent, type Row, type RunnerState, type Shot } from "./dash.ts";
import { buildKin, type Kin3D } from "./three/kin3d.ts";
import {
  Atmosphere,
  PostFX,
  createBlinkShimmer,
  createBurnAura,
  createDirtTrack,
  createDustPuffs,
  createFireball,
  createFrostAura,
  createFrostCloud,
  createImpactSparks,
  createLightning,
  createObstacle,
  createPickup,
  createSecondWind,
  createShieldBubble,
  createShockAura,
  createTrackGround,
  createTrackScenery,
  createVineTrap,
  createWindDash,
  detectQuality,
  filmMode,
  installEffectLights,
  setEffectQuality,
  warmUpTrackShaders,
  type Effect,
  type FireballEffect,
  type ObstacleKind,
  type Piece,
  type PickupKind,
  type Quality,
  type ShieldEffect,
} from "./three/track.ts";

export interface StageRacer {
  look: Look;
  level: number;
  generation: number;
  name: string;
  you: boolean;
  /** Which powers this racer has, one bit each. */
  powers: number;
}

/** Someone's earlier run of the same course, replayed as a see-through runner. */
export interface StageGhost {
  look: Look;
  level: number;
  generation: number;
  name: string;
  track: GhostPoint[];
}

interface GhostView {
  kin: Kin3D;
  label: THREE.Sprite;
  track: GhostPoint[];
  lastX: number;
}

const TRACK_WIDTH = 13.4;
const RACE_DAY = 0.31;
/** How tall a racer stands, in metres. */
const HEIGHT_TARGET = 2.15;
const BEHIND = 40;
const AHEAD = 170;
/** How far a fireball moves each tick, in millimetres. */
const SHOT_STEP = 2_200;

const metres = (mm: number) => mm / 1000;
const mix = (a: number, b: number, t: number) => a + (b - a) * t;

/** The gentle curve of the course. It starts straight at the line. */
function xBend(z: number): number {
  const fade = Math.min(1, -z / 90);
  return fade > 0 ? fade * (11 * Math.sin(z / 92) + 4.5 * Math.sin(z / 37)) : 0;
}

/** Sideways drift of the course per metre run forward. */
function slope(z: number): number {
  return xBend(z - 0.5) - xBend(z + 0.5);
}

interface RacerView {
  kin: Kin3D;
  label: THREE.Sprite | null;
  shield: ShieldEffect | null;
  /** Flames, frost or crackling arcs while the engine says the racer is burned, chilled or stunned. */
  burn: ShieldEffect | null;
  chill: ShieldEffect | null;
  stun: ShieldEffect | null;
  attack: number;
  lastX: number;
}

function nameLabel(text: string): THREE.Sprite {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 96;
  const ctx = canvas.getContext("2d")!;
  ctx.font = "600 52px Fredoka, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineWidth = 12;
  ctx.strokeStyle = "rgba(40,28,18,.9)";
  ctx.lineJoin = "round";
  ctx.strokeText(text, 256, 50);
  ctx.fillStyle = "#fff6e3";
  ctx.fillText(text, 256, 50);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({ map: texture, depthWrite: false, transparent: true });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(3, 0.5625, 1);
  return sprite;
}

/** The ring that shows who your fire would hit. */
function reticleSprite(): THREE.Sprite {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 128;
  const ctx = canvas.getContext("2d")!;
  ctx.strokeStyle = "#ffb13b";
  ctx.shadowColor = "#ff6a1a";
  ctx.shadowBlur = 10;
  ctx.lineWidth = 7;
  for (let quarter = 0; quarter < 4; quarter++) {
    const start = (quarter * Math.PI) / 2 + 0.28;
    ctx.beginPath();
    ctx.arc(64, 64, 46, start, start + Math.PI / 2 - 0.56);
    ctx.stroke();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({ map: texture, depthTest: false, depthWrite: false, transparent: true });
  const sprite = new THREE.Sprite(material);
  sprite.scale.setScalar(3.6);
  sprite.visible = false;
  sprite.renderOrder = 10;
  return sprite;
}

function checkerTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext("2d")!;
  for (let x = 0; x < 16; x++) {
    for (let y = 0; y < 4; y++) {
      ctx.fillStyle = (x + y) % 2 ? "#20180f" : "#fff6e3";
      ctx.fillRect(x * 16, y * 16, 16, 16);
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function bannerTexture(text: string, colour: string): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 1024;
  canvas.height = 128;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = colour;
  ctx.fillRect(0, 0, 1024, 128);
  ctx.font = "700 88px Fredoka, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#fff6e3";
  ctx.fillText(text, 512, 68);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** Splits a row's lanes into runs of neighbours, so one log can span them. */
function laneRuns(mask: number, lanes: number): { first: number; count: number }[] {
  const runs: { first: number; count: number }[] = [];
  for (let lane = 0; lane < lanes; lane++) {
    if (!((mask >> lane) & 1)) continue;
    const last = runs[runs.length - 1];
    if (last && last.first + last.count === lane) last.count += 1;
    else runs.push({ first: lane, count: 1 });
  }
  return runs;
}

export class RaceStage {
  /** How long the opening fly-past lasts. */
  readonly introMs = 2_000;

  private canvas: HTMLCanvasElement;
  private course: Row[];
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private atmosphere: Atmosphere;
  private post: PostFX;
  private quality: Quality;
  private scenery: ReturnType<typeof createTrackScenery>;
  private track: ReturnType<typeof createDirtTrack>;
  private ground: ReturnType<typeof createTrackGround>;
  private racers: RacerView[] = [];
  private pieces: { row: number; piece: Piece }[] = [];
  private effects: Effect[] = [];
  private fireballs: { effect: FireballEffect; pos: number }[] = [];
  private traps = new Map<string, ShieldEffect>();
  private extras: { dispose(): void }[] = [];
  private shake = 0;
  private phaseTime = 0;
  private lastPhase = "";
  private camX = 0;
  private fov = 60;
  private windTimer = 0;
  private slowFrames = 0;
  private frames = 0;
  private pixelRatio: number;
  private resizer: ResizeObserver;
  private reticle = reticleSprite();
  private releaseShaders: (() => void) | null = null;
  private releaseLights: () => void;
  private myPowers = 0;
  private ghosts: GhostView[] = [];
  private ghostMaterial: THREE.MeshStandardMaterial | null = null;

  constructor(canvas: HTMLCanvasElement, course: Row[], racers: StageRacer[]) {
    this.canvas = canvas;
    this.course = course;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: "high-performance" });
    this.quality = detectQuality(this.renderer.getContext() as WebGL2RenderingContext);
    this.pixelRatio = Math.min(devicePixelRatio || 1, this.quality === "high" ? 2 : 1.5);
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.shadowMap.enabled = this.quality !== "low";
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.camera = new THREE.PerspectiveCamera(this.fov, 1, 0.3, 900);

    this.atmosphere = new Atmosphere(this.scene, this.renderer, { quality: this.quality, shadows: this.quality !== "low", shadowRange: 34, far: 520 });
    this.atmosphere.setPhase(RACE_DAY);
    this.post = new PostFX(this.renderer, { quality: this.quality, bloomStrength: 0.42, autoScale: !filmMode() });
    this.releaseLights = installEffectLights(this.scene);
    setEffectQuality(this.quality);

    const zEnd = -metres(D.track) - 90;
    const zStart = 70;
    this.ground = createTrackGround({ zStart, zEnd, xBend });
    this.scene.add(this.ground.mesh);
    this.track = createDirtTrack({ zStart, zEnd, width: TRACK_WIDTH, xBend });
    this.scene.add(this.track.mesh);
    this.scenery = createTrackScenery({ zStart: zStart - 20, zEnd: zEnd + 20, width: TRACK_WIDTH, xBend, seed: 11, quality: this.quality });
    this.scene.add(this.scenery.group);

    this.buildLaneMarks();
    this.buildGates();
    this.placeCourse();
    this.buildRacers(racers);
    this.myPowers = racers.find((racer) => racer.you)?.powers ?? 0;
    this.scene.add(this.reticle);

    this.resizer = new ResizeObserver(() => this.resize());
    this.resizer.observe(canvas);
    this.resize();
  }

  /** Compiles every shader the race can need, so nothing stutters mid-race. */
  async warmUp(frame: Frame) {
    for (const { piece } of this.pieces) piece.group.visible = true;
    this.camera.position.set(0, 4, 8);
    this.camera.lookAt(0, 1, -10);
    this.drawRacers(0.016, frame, frame, 1, "intro");
    this.renderer.setRenderTarget(this.post.sceneTarget);
    // Effects newer than the track's own warm-up list, held near the camera
    // while the shaders compile and kept until the race ends.
    const origin = new THREE.Vector3(0, 1, -6);
    const extras = [createBurnAura(), createFrostAura(), createShockAura(), createSecondWind(), createImpactSparks(origin.clone()), createBlinkShimmer(origin.clone(), { mode: "arrive" })];
    for (const effect of extras) {
      if (!effect.object.parent) this.scene.add(effect.object);
      effect.object.position.copy(origin);
      effect.update(0.016);
    }
    const releaseTrack = await warmUpTrackShaders(this.renderer, this.scene, this.camera);
    for (const effect of extras) effect.object.visible = false;
    this.releaseShaders = () => {
      releaseTrack();
      for (const effect of extras) {
        effect.object.removeFromParent();
        effect.dispose();
      }
    };
    this.renderer.setRenderTarget(null);
    this.post.render(this.scene, this.camera, 0.016);
    for (const { piece } of this.pieces) piece.group.visible = false;
    // Two real frames, so the sky, shadows and first scenery are ready as well.
    this.render(0.016, frame, frame, 1, "intro");
    this.render(0.016, frame, frame, 1, "intro");
  }

  // ----- Building -------------------------------------------------------

  /** Adds see-through runners that replay earlier runs. Call before `warmUp`,
   * so their look is compiled with everything else. */
  addGhosts(ghosts: StageGhost[]) {
    if (ghosts.length === 0) return;
    const material = (this.ghostMaterial ??= new THREE.MeshStandardMaterial({
      color: 0x8fd0ff,
      emissive: 0x2f86f0,
      emissiveIntensity: 0.85,
      roughness: 0.3,
      metalness: 0,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
    }));
    for (const ghost of ghosts) {
      const kin = buildKin(ghost.look, { level: ghost.level, generation: ghost.generation, detail: "low" });
      kin.group.scale.multiplyScalar(HEIGHT_TARGET / Math.max(0.5, kin.height));
      kin.group.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (!mesh.isMesh) return;
        const own = mesh.material as THREE.Material;
        // Glows and auras run on their own shaders: a ghost goes without.
        if (Array.isArray(own) || (own as THREE.ShaderMaterial).isShaderMaterial) {
          mesh.visible = false;
          return;
        }
        mesh.material = material;
        mesh.castShadow = false;
        mesh.receiveShadow = false;
      });
      kin.group.renderOrder = 2;
      this.scene.add(kin.group);
      const label = nameLabel(ghost.name);
      this.scene.add(label);
      this.ghosts.push({ kin, label, track: ghost.track, lastX: 0 });
    }
  }

  private buildLaneMarks() {
    const material = new THREE.MeshBasicMaterial({ color: "#f4e6c8", transparent: true, opacity: 0.4 });
    const geometry = new THREE.PlaneGeometry(0.16, 3.4);
    const length = metres(D.track);
    const dashes = Math.ceil(length / 7) * 2;
    const mesh = new THREE.InstancedMesh(geometry, material, dashes);
    const dummy = new THREE.Object3D();
    let index = 0;
    for (const side of [-0.5, 0.5]) {
      for (let run = 4; run < length && index < dashes; run += 7) {
        const z = -run;
        dummy.position.set(side * metres(D.laneWidth) + xBend(z), 0.04, z);
        dummy.rotation.set(-Math.PI / 2, 0, Math.atan(slope(z)));
        dummy.updateMatrix();
        mesh.setMatrixAt(index++, dummy.matrix);
      }
    }
    mesh.count = index;
    mesh.frustumCulled = false;
    this.scene.add(mesh);
    this.extras.push(geometry, material);
  }

  private buildGates() {
    const checker = checkerTexture();
    this.extras.push(checker);
    const strip = (z: number) => {
      const geometry = new THREE.PlaneGeometry(TRACK_WIDTH, 2.4);
      const material = new THREE.MeshStandardMaterial({ map: checker, roughness: 0.8 });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.rotation.set(-Math.PI / 2, 0, Math.atan(slope(z)));
      mesh.position.set(xBend(z), 0.05, z);
      mesh.receiveShadow = true;
      this.scene.add(mesh);
      this.extras.push(geometry, material);
    };
    const gate = (z: number, text: string, colour: string) => {
      const holder = new THREE.Group();
      holder.position.set(xBend(z), 0, z);
      holder.rotation.y = -Math.atan(slope(z));
      const postGeometry = new THREE.CylinderGeometry(0.28, 0.34, 8.5, 12);
      const postMaterial = new THREE.MeshStandardMaterial({ color: "#7c5a3c", roughness: 0.75 });
      for (const side of [-1, 1]) {
        const post = new THREE.Mesh(postGeometry, postMaterial);
        post.position.set(side * (TRACK_WIDTH / 2 + 0.7), 4.25, 0);
        post.castShadow = true;
        holder.add(post);
      }
      const texture = bannerTexture(text, colour);
      const bannerGeometry = new THREE.BoxGeometry(TRACK_WIDTH + 1.4, 1.7, 0.2);
      const bannerMaterial = new THREE.MeshStandardMaterial({ map: texture, roughness: 0.7 });
      const banner = new THREE.Mesh(bannerGeometry, bannerMaterial);
      banner.position.set(0, 7.7, 0);
      banner.castShadow = true;
      holder.add(banner);
      this.scene.add(holder);
      this.extras.push(postGeometry, postMaterial, bannerGeometry, bannerMaterial, texture);
    };
    strip(0);
    strip(-metres(D.track));
    gate(0, "THE VALLEY DASH", "#c9573f");
    gate(-metres(D.track), "FINISH", "#4b8a3a");
  }

  private placeCourse() {
    const OBSTACLE: Record<number, ObstacleKind> = {
      [HAZARD.LOG]: "log",
      [HAZARD.ROCK]: "rock",
      [HAZARD.HEDGE]: "thorn",
      [HAZARD.MUD]: "mud",
      [HAZARD.RAMP]: "ramp",
    };
    const PICKUP: Record<number, PickupKind> = { [HAZARD.BERRY]: "berry", [HAZARD.ORB]: "orb" };
    const laneMetres = metres(D.laneWidth);
    this.course.forEach((row, rowIndex) => {
      for (const { first, count } of laneRuns(row.lanes, D.lanes)) {
        const obstacle = OBSTACLE[row.kind];
        const piece = obstacle
          ? createObstacle(obstacle, { lanes: count as 1 | 2 | 3, laneWidth: laneMetres })
          : createPickup(PICKUP[row.kind]);
        const centre = (first + (count - 1) / 2 - (D.lanes - 1) / 2) * laneMetres;
        const z = -metres(row.pos) - (row.kind === HAZARD.MUD ? 7 : 0);
        piece.group.position.set(centre + xBend(z), 0, z);
        piece.group.rotation.y = -Math.atan(slope(z));
        piece.group.visible = false;
        this.scene.add(piece.group);
        this.pieces.push({ row: rowIndex, piece });
      }
    });
  }

  private buildRacers(racers: StageRacer[]) {
    for (const racer of racers) {
      const kin = buildKin(racer.look, {
        level: racer.level,
        generation: racer.generation,
        detail: racer.you || this.quality === "high" ? "high" : "low",
      });
      kin.group.scale.multiplyScalar(HEIGHT_TARGET / Math.max(0.5, kin.height));
      kin.group.traverse((object) => {
        if ((object as THREE.Mesh).isMesh) object.castShadow = this.quality !== "low";
      });
      this.scene.add(kin.group);
      let label: THREE.Sprite | null = null;
      if (racer.name) {
        label = nameLabel(racer.name);
        this.scene.add(label);
      }
      this.racers.push({ kin, label, shield: null, burn: null, chill: null, stun: null, attack: 0, lastX: 0 });
    }
  }

  private resize() {
    const width = this.canvas.clientWidth || window.innerWidth;
    const height = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(width, height, false);
    this.post.setSize(width * this.pixelRatio, height * this.pixelRatio);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  // ----- Effects ---------------------------------------------------------

  private add(effect: Effect) {
    this.scene.add(effect.object);
    this.effects.push(effect);
  }

  private at(runner: RunnerState, height = 1.1): THREE.Vector3 {
    const z = -metres(runner.pos);
    return new THREE.Vector3(metres(runner.x) + xBend(z), metres(runner.y) + height, z);
  }

  onEvent(event: RaceEvent, frame: Frame) {
    const runner = frame.runners[event.a];
    const near = Math.abs(runner.pos - frame.runners[0].pos) < BEHIND * 1000;
    switch (event.kind) {
      case EVENT.JUMP:
      case EVENT.LAND:
        if (near) this.add(createDustPuffs(this.at(runner, 0.1), { count: 7 }));
        break;
      case EVENT.TRIP:
        this.add(createDustPuffs(this.at(runner, 0.4), { count: 18 }));
        if (event.a === 0) this.shake = 1;
        break;
      case EVENT.CAST:
        this.onCast(event, runner, frame);
        break;
      case EVENT.BURNED:
        if (event.a === 0) this.shake = 0.9;
        break;
      case EVENT.CHILLED:
        this.add(createFrostCloud(this.at(runner), { radius: 1.8 }));
        if (event.a === 0) this.shake = 0.5;
        break;
      case EVENT.ZAPPED:
        this.add(createLightning(this.at(runner, 14), this.at(runner, 0)));
        if (event.a === 0) this.shake = 1;
        break;
      case EVENT.SNARED: {
        const vines = createVineTrap(this.at(runner, 0), { radius: 1.5 });
        this.add(vines);
        window.setTimeout(() => vines.finish(), 1_200);
        if (event.a === 0) this.shake = 0.7;
        break;
      }
      case EVENT.BLOCKED:
        this.add(createImpactSparks(this.at(runner, 1.1), { count: 30, kelvin: 7000 }));
        break;
      case EVENT.DODGED:
        this.add(createBlinkShimmer(this.at(runner), { color: "#ffe58a" }));
        break;
      case EVENT.BERRY:
      case EVENT.ORB:
        if (event.a === 0) this.removeRow(event.value);
        break;
      case EVENT.HAZARD_BURNT:
        this.burnRow(event.value);
        break;
    }
  }

  private removeRow(row: number) {
    const gone = this.pieces.filter((entry) => entry.row === row);
    this.pieces = this.pieces.filter((entry) => entry.row !== row);
    for (const { piece } of gone) {
      this.scene.remove(piece.group);
      piece.dispose();
    }
  }

  private burnRow(row: number) {
    for (const { piece } of this.pieces.filter((entry) => entry.row === row)) {
      const fire = createFireball({ scale: 2.2 });
      fire.object.position.copy(piece.group.position).setY(1);
      this.add(fire.explode(this.scene));
      fire.dispose();
    }
    this.removeRow(row);
  }

  private onCast(event: RaceEvent, runner: RunnerState, frame: Frame) {
    this.racers[event.a].attack = 0.45;
    const target = event.value >= 0 ? frame.runners[event.value] : null;
    switch (event.b) {
      case 1: {
        const ahead = this.at(runner);
        ahead.z -= 8;
        ahead.x = metres(runner.x) + xBend(ahead.z);
        this.add(createFrostCloud(ahead, { radius: 6 }));
        break;
      }
      case 2:
        if (target) this.add(createLightning(this.at(target, 16), this.at(target, 0)));
        break;
      case 3:
        this.add(createWindDash(this.at(runner, 1.2), new THREE.Vector3(0, 0, 1), { length: 12 }));
        break;
      case 6: {
        // The engine has already moved the racer: draw where it left and landed.
        const landed = this.at(runner);
        this.add(createBlinkShimmer(landed, { color: "#c9a7ff", mode: "arrive" }));
        const left = landed.clone();
        left.z += 22;
        left.x = metres(runner.x) + xBend(left.z);
        this.add(createBlinkShimmer(left, { color: "#c9a7ff", mode: "depart" }));
        break;
      }
      case 7: {
        // Second Wind rides along with the racer.
        const wind = createSecondWind();
        this.racers[event.a].kin.group.add(wind.object);
        this.effects.push(wind);
        break;
      }
    }
  }

  private matchFireballs(shots: Shot[], alpha: number) {
    const unmatched = new Set(this.fireballs);
    for (const shot of shots) {
      const pos = shot.pos + SHOT_STEP * alpha;
      let best: (typeof this.fireballs)[number] | null = null;
      let bestGap = 30_000;
      for (const ball of unmatched) {
        const gap = Math.abs(ball.pos - pos);
        if (gap < bestGap) {
          best = ball;
          bestGap = gap;
        }
      }
      if (!best) {
        const effect = createFireball({ scale: 1.7 });
        this.scene.add(effect.object);
        best = { effect, pos };
        this.fireballs.push(best);
      } else {
        unmatched.delete(best);
      }
      best.pos = pos;
      const z = -metres(pos);
      best.effect.object.position.set(metres(shot.x) + xBend(z), 1.35, z);
    }
    for (const ball of unmatched) {
      this.add(ball.effect.explode(this.scene));
      this.scene.remove(ball.effect.object);
      ball.effect.dispose();
      this.fireballs.splice(this.fireballs.indexOf(ball), 1);
    }
  }

  private syncTraps(frame: Frame) {
    const seen = new Set<string>();
    for (const trap of frame.traps) {
      const key = `${trap.owner}:${trap.pos}`;
      seen.add(key);
      if (!this.traps.has(key)) {
        const z = -metres(trap.pos);
        const vines = createVineTrap(new THREE.Vector3((trap.lane - 1) * metres(D.laneWidth) + xBend(z), 0.03, z), { radius: 1.7, lurk: true });
        this.add(vines);
        this.traps.set(key, vines);
      }
    }
    for (const [key, vines] of this.traps) {
      if (!seen.has(key)) {
        vines.finish();
        this.traps.delete(key);
      }
    }
  }

  // ----- Drawing ---------------------------------------------------------

  render(dt: number, previous: Frame, current: Frame, alpha: number, phase: string) {
    if (phase !== this.lastPhase) {
      this.lastPhase = phase;
      this.phaseTime = 0;
    }
    this.phaseTime += dt;

    const me = this.drawRacers(dt, previous, current, alpha, phase);
    this.drawGhosts(dt, current, alpha, phase);
    this.scenery.update(dt, me.z);
    this.matchFireballs(current.shots, phase === "racing" ? alpha : 0);
    this.syncTraps(current);

    for (const { piece } of this.pieces) {
      const z = piece.group.position.z;
      const near = z < me.z + BEHIND && z > me.z - AHEAD;
      piece.group.visible = near;
      if (near) piece.update(dt);
    }

    let index = 0;
    while (index < this.effects.length) {
      const effect = this.effects[index];
      if (effect.update(dt)) {
        index += 1;
      } else {
        // Some effects ride on a racer's group rather than the scene.
        effect.object.removeFromParent();
        effect.dispose();
        this.effects.splice(index, 1);
      }
    }
    for (const ball of this.fireballs) ball.effect.update(dt);

    this.drawReticle(current, phase);
    this.drawWind(dt, current, me, phase);
    this.moveCamera(dt, me, current, phase);
    this.atmosphere.update(dt, me, this.camera);
    this.post.render(this.scene, this.camera, dt);
    this.watchFrameRate(dt);
  }

  private drawRacers(dt: number, previous: Frame, current: Frame, alpha: number, phase: string): THREE.Vector3 {
    const me = new THREE.Vector3();
    const runOn = phase === "done" ? (1 - Math.exp(-this.phaseTime * 0.9)) / 0.9 : 0;
    current.runners.forEach((b, index) => {
      const a = previous.runners[index];
      const view = this.racers[index];
      const blink = Math.abs(b.pos - a.pos) > 5_000;
      const pos = (blink ? b.pos : mix(a.pos, b.pos, alpha)) + b.v * 30 * runOn;
      const x = mix(a.x, b.x, alpha);
      const y = mix(a.y, b.y, alpha);
      const group = view.kin.group;
      const z = -metres(pos);
      const bent = metres(x) + xBend(z);
      group.position.set(bent, metres(y), z);

      // Face along the course, and into a lane change.
      const forward = Math.max(1.5, metres(b.v) * 30);
      const sideways = (metres(x) - view.lastX) / Math.max(dt, 0.001);
      view.lastX = metres(x);
      group.rotation.y = Math.atan2(slope(z) + (sideways / forward) * 0.7, -1);

      view.attack = Math.max(0, view.attack - dt);
      const hurt = Math.max(b.stumble > 0 ? 0.9 : 0, b.burn > 0 ? 0.55 : 0, b.stun > 0 ? 1 : 0, b.snare > 0 ? 0.6 : 0);
      const speed = Math.min(1, b.v / 820) * (phase === "done" && runOn > 0.9 ? 0.5 : 1);
      view.kin.update(dt, {
        speed: phase === "racing" || phase === "done" ? speed : 0,
        airborne: b.y > 0,
        joy: b.finished ? 1 : b.dash > 0 ? 0.6 : 0,
        hurt,
        frozen: b.chill > 0 ? Math.min(1, b.chill / 14) : 0,
        attack: view.attack > 0 ? Math.min(1, view.attack * 4) : 0,
      });

      if (b.shield > 0 && !view.shield) {
        view.shield = createShieldBubble({ radius: 1.7 / group.scale.x, color: "#8fd6ff" });
        view.shield.object.position.y = 1.05 / group.scale.x;
        group.add(view.shield.object);
      } else if (b.shield === 0 && view.shield) {
        view.shield.finish();
        const finished = view.shield;
        view.shield = null;
        window.setTimeout(() => {
          group.remove(finished.object);
          finished.dispose();
        }, 500);
      }
      view.shield?.update(dt);

      // Auras follow the engine's own states, so they start and stop exactly with them.
      const sync = (on: boolean, fx: ShieldEffect | null, make: () => ShieldEffect): ShieldEffect | null => {
        if (on && !fx) {
          const made = make();
          group.add(made.object);
          this.effects.push(made);
          return made;
        }
        if (!on && fx) {
          fx.finish();
          return null;
        }
        return fx;
      };
      view.burn = sync(b.burn > 0, view.burn, createBurnAura);
      view.chill = sync(b.chill > 0, view.chill, createFrostAura);
      view.stun = sync(b.stun > 0, view.stun, createShockAura);

      if (view.label) {
        const distance = Math.abs(z + metres(current.runners[0].pos));
        const ahead = group.position.z < this.camera.position.z - 9;
        view.label.visible = distance < 70 && ahead;
        view.label.position.set(group.position.x, group.position.y + 2.9, group.position.z);
        (view.label.material as THREE.SpriteMaterial).opacity = Math.min(1, (70 - distance) / 14);
      }
      if (index === 0) me.copy(group.position);
    });
    return me;
  }

  private drawGhosts(dt: number, current: Frame, alpha: number, phase: string) {
    if (this.ghosts.length === 0) return;
    // Ghosts keep running on their own clock once the live race is over.
    // In step with the live racers, which are drawn between the last tick and this one.
    const base = phase === "racing" ? current.tick - 1 + alpha : current.tick;
    const clock = Math.max(0, base) + (phase === "done" ? this.phaseTime * D.ticks : 0);
    const myPos = current.runners[0].pos;
    for (const ghost of this.ghosts) {
      const last = ghost.track.length - 1;
      if (last < 0) continue;
      const state = (tick: number) => ghost.track[Math.max(0, Math.min(last, tick - 1))];
      const whole = Math.floor(clock);
      const a = state(whole);
      const b = state(whole + 1);
      const t = clock - whole;
      const after = Math.max(0, clock - (last + 1));
      const final = ghost.track[last];
      const pos = whole + 1 > last + 1 ? final.pos + final.v * after : mix(a.pos, b.pos, t);
      const x = mix(a.x, b.x, t);
      const y = whole + 1 > last + 1 ? 0 : mix(a.y, b.y, t);
      const group = ghost.kin.group;
      const z = -metres(pos);
      group.position.set(metres(x) + xBend(z), metres(y), z);
      const forward = Math.max(1.5, metres(b.v) * 30);
      const sideways = (metres(x) - ghost.lastX) / Math.max(dt, 0.001);
      ghost.lastX = metres(x);
      group.rotation.y = Math.atan2(slope(z) + (sideways / forward) * 0.7, -1);
      const fade = Math.max(0, 1 - after / (D.ticks * 2));
      group.visible = fade > 0.02;
      ghost.kin.update(dt, {
        speed: phase === "intro" || phase === "count" ? 0 : Math.min(1, b.v / 820),
        airborne: y > 0,
        joy: final.finished && after > 0 ? 1 : 0,
        hurt: 0,
        frozen: 0,
        attack: 0,
      });
      const distance = Math.abs(metres(pos - myPos));
      const ahead = group.position.z < this.camera.position.z - 6;
      ghost.label.visible = group.visible && distance < 80 && ahead;
      ghost.label.position.set(group.position.x, group.position.y + 2.9, group.position.z);
      (ghost.label.material as THREE.SpriteMaterial).opacity = Math.min(0.85, (80 - distance) / 16) * fade;
    }
  }

  /** Marks the racer your Fire Spit would go for, whenever it's ready. */
  private drawReticle(current: Frame, phase: string) {
    const FIRE = 0;
    const me = current.runners[0];
    let target = -1;
    let nearest = 60_000;
    if (phase === "racing" && (this.myPowers >> FIRE) & 1 && me.cooldown[FIRE] === 0) {
      current.runners.forEach((runner, index) => {
        const gap = runner.pos - me.pos;
        if (index !== 0 && !runner.finished && gap > 0 && gap < nearest && Math.abs(runner.x - me.x) <= 5_250) {
          nearest = gap;
          target = index;
        }
      });
    }
    this.reticle.visible = target >= 0;
    if (target >= 0) {
      const group = this.racers[target].kin.group;
      this.reticle.position.set(group.position.x, group.position.y + 1.2, group.position.z);
      this.reticle.material.rotation += 0.05;
    }
  }

  private drawWind(dt: number, current: Frame, me: THREE.Vector3, phase: string) {
    if (phase !== "racing") return;
    const runner = current.runners[0];
    const pace = runner.dash > 0 ? 0.16 : runner.sprint && !runner.winded ? 0.55 : 0;
    if (pace === 0) return;
    this.windTimer -= dt;
    if (this.windTimer > 0) return;
    this.windTimer = pace;
    const at = new THREE.Vector3(me.x + (Math.random() < 0.5 ? -1 : 1) * (2.5 + Math.random() * 4), 1 + Math.random() * 2.4, me.z - 2);
    this.add(createWindDash(at, new THREE.Vector3(0, 0, 1), { length: runner.dash > 0 ? 7 : 3.5 }));
  }

  private moveCamera(dt: number, me: THREE.Vector3, current: Frame, phase: string) {
    const portrait = this.camera.aspect < 1;
    const runner = current.runners[0];
    const speed = metres(runner.v) * 30;
    const sideOfCourse = me.x - xBend(me.z);
    this.camX += (sideOfCourse * 0.72 - this.camX) * Math.min(1, dt * 9);

    const back = (portrait ? 10 : 7.4) + speed * 0.09;
    const up = (portrait ? 5.8 : 3.9) + me.y * 0.5;
    const z = me.z + back;
    const position = new THREE.Vector3(this.camX + xBend(z), up, z);
    const lookZ = me.z - 14;
    const lookAt = new THREE.Vector3(this.camX * 0.85 + xBend(lookZ), 1.7 + me.y * 0.25, lookZ);

    if (phase === "intro") {
      const t = Math.min(1, this.phaseTime / (this.introMs / 1000));
      const ease = t * t * (3 - 2 * t);
      position.set(mix(9, position.x, ease), mix(2.6, position.y, ease), mix(me.z - 13, position.z, ease));
      lookAt.set(mix(0, lookAt.x, ease), mix(1.2, lookAt.y, ease), mix(me.z + 2, lookAt.z, ease));
    } else if (phase === "done") {
      // Swing round in a wide arc to look the winner in the face.
      const t = Math.min(1, this.phaseTime / 1.8);
      const ease = t * t * (3 - 2 * t);
      const angle = 2.55 * ease;
      const radius = mix(back, 8.2, ease);
      position.set(me.x + Math.sin(angle) * radius, mix(up, 2.5, ease), me.z + Math.cos(angle) * radius);
      lookAt.lerp(new THREE.Vector3(me.x, 1.5, me.z), ease);
    }

    this.shake = Math.max(0, this.shake - dt * 2.8);
    if (this.shake > 0) {
      const amount = this.shake * this.shake * 0.42;
      position.x += (Math.random() - 0.5) * amount;
      position.y += (Math.random() - 0.5) * amount;
      position.z += (Math.random() - 0.5) * amount;
    }

    this.camera.position.copy(position);
    this.camera.lookAt(lookAt);
    const wanted = (portrait ? 74 : 58) + Math.min(14, speed * 0.62) + (runner.dash > 0 ? 8 : 0);
    this.fov += (wanted - this.fov) * Math.min(1, dt * 5);
    if (Math.abs(this.camera.fov - this.fov) > 0.05) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
  }

  /** If this device can't keep up, draw fewer pixels rather than stutter. */
  private watchFrameRate(dt: number) {
    if (filmMode()) return;
    this.frames += 1;
    if (dt > 1 / 28) this.slowFrames += 1;
    if (this.frames < 90) return;
    if (this.slowFrames > 45 && this.pixelRatio > 0.75) {
      this.pixelRatio = Math.max(0.75, this.pixelRatio * 0.75);
      this.renderer.setPixelRatio(this.pixelRatio);
      this.resize();
    }
    this.frames = 0;
    this.slowFrames = 0;
  }

  dispose() {
    this.resizer.disconnect();
    this.releaseShaders?.();
    this.releaseLights();
    for (const { piece } of this.pieces) piece.dispose();
    for (const effect of this.effects) effect.dispose();
    for (const ball of this.fireballs) ball.effect.dispose();
    for (const racer of this.racers) {
      racer.kin.dispose();
      racer.shield?.dispose();
      if (racer.label) {
        (racer.label.material as THREE.SpriteMaterial).map?.dispose();
        racer.label.material.dispose();
      }
    }
    for (const ghost of this.ghosts) {
      this.scene.remove(ghost.kin.group, ghost.label);
      ghost.kin.dispose();
      (ghost.label.material as THREE.SpriteMaterial).map?.dispose();
      ghost.label.material.dispose();
    }
    this.ghostMaterial?.dispose();
    this.reticle.material.map?.dispose();
    this.reticle.material.dispose();
    this.scenery.dispose();
    this.track.dispose();
    this.ground.dispose();
    for (const extra of this.extras) extra.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }
}
