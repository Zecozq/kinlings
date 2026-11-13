// The valley in real-time 3D: a long road of neighbouring farms under a real
// sky. A drop-in replacement for the 2D Scene in ../scene.ts, with the same
// public members and logical coordinates, so ui.ts and main.ts work unchanged.
//
// Logical x runs along the road (LOT = 1240 per farm) and logical y is depth,
// with the same layout numbers as the 2D scene. Everything public still speaks
// those coordinates; they are mapped to world units internally.

import * as THREE from "three";
import { COLOURS, lookFromGenes } from "../creature.ts";
import { cropInfo, farmerRank, kinLevel, type Egg, type Farm, type Kin } from "../world.ts";
import type { Game } from "../game.ts";
import { Scene as Scene2D } from "../scene.ts";
import { Atmosphere, PostFX, dayPhase, nightness, warmShadowCasters } from "./atmosphere.ts";
import { buildCottage, buildNest, buildSign, eggSlot, plotGeometry, plotMaterials, type CottageParts, type NestParts, type SignParts, EGG_LIMIT } from "./farm3d.ts";
import { Backdrop, LOT_W, LotStatic, SmokePlume, WU, createSharedLand, getMask, terrainHeight } from "./landscape.ts";
import { clamp, detectQuality, smooth, type Quality, filmMode } from "./gfx.ts";
import { buildKin, kinSize, kinWarmupSet, type Kin3D, type KinPose } from "./kin3d.ts";
import { cropGeometry, getCropMaterial, tickCrops } from "./crops.ts";
import { windTime } from "./flora.ts";

export const LOT = 1240;
const VIRTUAL_HEIGHT = 720;
const PLOT_ROWS = [478, 572];
const PLOT_FIRST_X = 430;
const PLOT_GAP = 116;
const NEST = { x: 1120, y: 520 };
const COTTAGE = { x: 215 };
const SIGN = { x: 66, y: 640 };
const WALK_AREA = { left: 90, right: 1180, top: 618, bottom: 690 };
const ROOFS = ["#c9573f", "#5f8f9e", "#8d6bb0", "#c98b3a", "#6f9a5a", "#b5536e"];
const MAX_KINS_PER_FARM = 8;
const VALLEY_KIN_SCALE = 0.72;
const LOT_SLOTS = 5;

const Z_MID = 540;
const Z_SCALE = 0.026;
const zOf = (y: number) => (y - Z_MID) * Z_SCALE;

export type Hit =
  | { kind: "plot"; farm: number; slot: number }
  | { kind: "egg"; farm: number; egg: number }
  | { kind: "kin"; farm: number; id: number }
  | { kind: "sign"; farm: number };

export function capitalise(text: string) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** An egg looks a little like its parents, so a pedigree shows on the shell. */
export function eggColours(egg: Egg, game: Game): [string, string] {
  const view = game.view;
  const mother = view?.kins.get(egg.mother);
  const father = view?.kins.get(egg.father);
  if (mother && father) return [mother.look.main, father.look.accent];
  if (mother) return [mother.look.main, mother.look.accent];
  return [COLOURS[(egg.id * 5 + 1) % 16][1], COLOURS[(egg.id * 3 + 4) % 16][1]];
}

interface Actor {
  id: number;
  farm: number;
  x: number;
  y: number;
  dir: number;
  targetX: number;
  targetY: number;
  pause: number;
  moving: boolean;
  joy: number;
  model: Kin3D | null;
  modelLevel: number;
  rotation: number;
  pose: KinPose;
  distance: number;
}

interface FloatText {
  world: THREE.Vector3;
  text: string;
  colour: string;
  life: number;
}

interface PlotView {
  soil: THREE.Mesh;
  crop: THREE.Mesh | null;
  item: number;
  stage: number;
  wet: boolean;
}

class FarmView {
  group = new THREE.Group();
  cottage: CottageParts | null = null;
  cottageKey = "";
  sign: SignParts;
  nest: NestParts;
  plots: PlotView[] = [];
  eggIds: number[] = [];
  smoke: SmokePlume;
  glow: THREE.Mesh;
  glowMaterial: THREE.ShaderMaterial;

  index: number;

  constructor(index: number) {
    this.index = index;
    this.group.position.x = index * LOT_W;

    this.sign = buildSign();
    this.sign.group.position.set((SIGN.x + 60) * WU, 0, zOf(SIGN.y));
    this.sign.group.rotation.y = 0.25;
    this.group.add(this.sign.group);

    this.nest = buildNest();
    this.nest.group.position.set(NEST.x * WU, terrainHeight(NEST.x * WU, zOf(NEST.y)), zOf(NEST.y));
    this.group.add(this.nest.group);

    // Chimney smoke: soft, sunlit wood smoke drifting off downwind.
    this.smoke = new SmokePlume({ puffs: 14, height: 4.2, width: 0.75, speed: 0.11, low: "#8a8784", high: "#c9c8c8", opacity: 0.4 });
    this.group.add(this.smoke.mesh);

    // Warm pool of light by the door at night.
    this.glowMaterial = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uNight: { value: 0 } },
      vertexShader: "varying vec2 vP; void main(){ vP = position.xz; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }",
      fragmentShader: "varying vec2 vP; uniform float uNight; void main(){ float r = length(vP); float a = pow(max(0.0,1.0-r),2.0); gl_FragColor = vec4(vec3(1.0,0.72,0.38)*a*1.1, a*uNight); }",
    });
    const glowGeo = new THREE.CircleGeometry(1, 28);
    glowGeo.rotateX(-Math.PI / 2);
    this.glow = new THREE.Mesh(glowGeo, this.glowMaterial);
    this.glow.scale.setScalar(6);
    this.glow.position.set(COTTAGE.x * WU, 0.06, -0.3);
    this.glow.renderOrder = 2;
    this.group.add(this.glow);
  }

  dispose() {
    this.cottage?.dispose();
    this.sign.dispose();
    this.nest.dispose();
    this.smoke.dispose();
    this.glow.geometry.dispose();
    this.glowMaterial.dispose();
    for (const plot of this.plots) {
      plot.soil.removeFromParent();
    }
    this.group.removeFromParent();
  }
}

function makeFireflies(scene: THREE.Scene, count: number) {
  const pos = new Float32Array(count * 3);
  const seeds = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    pos[i * 3] = Math.random() * LOT_W * 1.4 - LOT_W * 0.7;
    pos[i * 3 + 1] = 0.6 + Math.random() * 2.2;
    pos[i * 3 + 2] = -9 + Math.random() * 18;
    seeds[i * 2] = Math.random() * 100;
    seeds[i * 2 + 1] = 0.5 + Math.random() * 0.8;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geometry.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 2));
  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: { uT: { value: 0 }, uNight: { value: 0 }, uFocus: { value: new THREE.Vector3() } },
    vertexShader: /* glsl */ `
      attribute vec2 aSeed;
      uniform float uT, uNight;
      uniform vec3 uFocus;
      varying float vA;
      void main(){
        float t = uT*aSeed.y + aSeed.x;
        vec3 p = position;
        p.x += sin(t*0.5)*1.4 + cos(t*0.23)*0.9;
        p.y += sin(t*1.1)*0.45;
        p.z += sin(t*0.37)*1.1;
        p.x = mod(p.x - uFocus.x + 18.0, 36.0) - 18.0 + uFocus.x;
        float pulse = pow(0.5+0.5*sin(t*3.0), 3.0);
        vA = pulse*uNight;
        vec4 mv = modelViewMatrix*vec4(p,1.0);
        gl_PointSize = (2.6 + pulse*2.8) * (42.0/-mv.z);
        gl_Position = projectionMatrix*mv;
      }
    `,
    fragmentShader: /* glsl */ `
      varying float vA;
      void main(){
        vec2 q = gl_PointCoord*2.0-1.0;
        float d = dot(q,q);
        if(d>1.0) discard;
        float s = pow(1.0-d,2.5);
        gl_FragColor = vec4(vec3(1.4,1.6,0.5)*s*2.0, s*vA);
      }
    `,
  });
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  scene.add(points);
  return { points, material };
}

function makePollen(scene: THREE.Scene, count: number) {
  const pos = new Float32Array(count * 3);
  const seeds = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    pos[i * 3] = Math.random() * LOT_W * 1.6 - LOT_W * 0.8;
    pos[i * 3 + 1] = 0.5 + Math.random() * 6.5;
    pos[i * 3 + 2] = -12 + Math.random() * 26;
    seeds[i * 2] = Math.random() * 100;
    seeds[i * 2 + 1] = 0.3 + Math.random() * 0.7;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geometry.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 2));
  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: { uT: { value: 0 }, uDay: { value: 1 }, uFocus: { value: new THREE.Vector3() } },
    vertexShader: /* glsl */ `
      attribute vec2 aSeed;
      uniform float uT, uDay;
      uniform vec3 uFocus;
      varying float vA;
      void main(){
        float t = uT*aSeed.y + aSeed.x;
        vec3 p = position;
        p.x += sin(t*0.2)*3.2 + uT*0.25;
        p.y += sin(t*0.13)*0.7;
        p.z += cos(t*0.17)*2.0;
        p.x = mod(p.x - uFocus.x + 22.0, 44.0) - 22.0 + uFocus.x;
        vA = uDay*(0.45+0.55*abs(sin(t*0.6)));
        vec4 mv = modelViewMatrix*vec4(p,1.0);
        gl_PointSize = 26.0/-mv.z*(0.6+aSeed.y);
        gl_Position = projectionMatrix*mv;
      }
    `,
    fragmentShader: /* glsl */ `
      varying float vA;
      void main(){
        vec2 q = gl_PointCoord*2.0-1.0;
        float d = dot(q,q);
        if(d>1.0) discard;
        gl_FragColor = vec4(vec3(1.3,1.2,0.9), pow(1.0-d,1.5)*vA*0.75);
      }
    `,
  });
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  scene.add(points);
  return { points, material };
}

interface Particle {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  max: number;
  size: number;
  gravity: number;
  color: THREE.Color;
}

const PARTICLE_CAP = 700;

/** Farm pieces built for shader warm-up, kept so their compiled programs stay cached. */
const warmKeep: { dispose(): void }[] = [];

/** Text labels drawn as camera-facing sprites of constant on-screen size. */
class LabelPool {
  private scene: THREE.Scene;
  private items: { sprite: THREE.Sprite; canvas: HTMLCanvasElement; texture: THREE.CanvasTexture; text: string }[] = [];
  private used = 0;
  private screenScale = 0.04;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  begin(viewportHeight: number, fov: number) {
    this.used = 0;
    this.screenScale = (1 / viewportHeight) * 2 * Math.tan((fov * Math.PI) / 360);
  }

  add(text: string, world: THREE.Vector3, colour: string, sizeFactor = 1) {
    let item = this.items[this.used];
    if (!item) {
      const canvas = document.createElement("canvas");
      canvas.width = 320;
      canvas.height = 72;
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      const material = new THREE.SpriteMaterial({ map: texture, depthTest: false, depthWrite: false, transparent: true, sizeAttenuation: false, toneMapped: false });
      const sprite = new THREE.Sprite(material);
      sprite.renderOrder = 1000;
      this.scene.add(sprite);
      item = { sprite, canvas, texture, text: "" };
      this.items.push(item);
    }
    this.used++;
    const key = text + colour;
    if (item.text !== key) {
      item.text = key;
      const ctx = item.canvas.getContext("2d")!;
      ctx.clearRect(0, 0, 320, 72);
      ctx.font = "600 44px Fredoka, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.lineJoin = "round";
      ctx.lineWidth = 11;
      ctx.strokeStyle = "rgba(59,42,30,.92)";
      ctx.strokeText(text, 160, 38);
      ctx.fillStyle = colour;
      ctx.fillText(text, 160, 38);
      item.texture.needsUpdate = true;
    }
    item.sprite.visible = true;
    item.sprite.position.copy(world);
    // 320x72 canvas: pixels on screen.
    const px = 78 * sizeFactor;
    const h = (px * this.screenScale * 44) / 72;
    item.sprite.scale.set((h * 320) / 72, h, 1);
  }

  end() {
    for (let i = this.used; i < this.items.length; i++) this.items[i].sprite.visible = false;
  }
}

export class Scene {
  canvas: HTMLCanvasElement;
  game: Game;
  onTap: ((hit: Hit | null, screenX: number, screenY: number) => void) | null = null;
  width = 0;
  height = 0;
  scale = 1;
  dpr = 1;
  yOffset = 0;
  camera = 0;
  cameraTarget = 0;
  t = 0;
  /** Set to freeze the time of day, used when filming. */
  timeOverride: number | null = null;
  /** When true the scene skips simulation and rendering, so a race has the GPU. */
  paused = false;

  private renderer!: THREE.WebGLRenderer;
  private scene3d = new THREE.Scene();
  private camera3d!: THREE.PerspectiveCamera;
  private atmosphere!: Atmosphere;
  private post!: PostFX;
  private quality!: Quality;
  private backdrop!: Backdrop;
  private sharedLand!: ReturnType<typeof createSharedLand>;
  private lots: LotStatic[] = [];
  private farms = new Map<number, FarmView>();
  private actors = new Map<number, Actor>();
  private cropMaterial = getCropMaterial();
  private floats: FloatText[] = [];
  private bubbles = new Map<number, { text: string; life: number }>();
  private wobbles = new Map<number, number>();
  private cracks = new Map<number, number>();
  private hover: Hit | null = null;
  private dragFrom: { x: number; camera: number; moved: boolean } | null = null;
  private zoom = 1;
  private zoomTarget = 1;
  private focusY: number | null = null;
  private last = 0;
  private lastPhase = -1;
  private overlay!: HTMLCanvasElement;
  private overlayCtx!: CanvasRenderingContext2D;
  private raycaster = new THREE.Raycaster();
  private ndc = new THREE.Vector2();
  private particles: Particle[] = [];
  private particlePoints!: THREE.Points;
  private particlePos!: Float32Array;
  private particleCol!: Float32Array;
  private particleSize!: Float32Array;
  private hoverOutline!: THREE.Mesh;
  private fireflies!: ReturnType<typeof makeFireflies>;
  private pollen!: ReturnType<typeof makePollen>;
  private tmpV = new THREE.Vector3();
  private tmpV2 = new THREE.Vector3();
  private focus = new THREE.Vector3();
  private kinBuildsThisFrame = 0;
  private selectTimer = 0;
  private missingModels = 0;
  private waterSky!: { top: THREE.Color; horizon: THREE.Color; sunDir: THREE.Vector3; sunColor: THREE.Color; time: { value: number } };
  private perf = { frames: 0, time: 0, level: 0, wait: 3, upgrades: 0 };
  private frameCount = 0;
  private labels!: LabelPool;
  private overlayShown = false;

  constructor(canvas: HTMLCanvasElement, game: Game) {
    this.canvas = canvas;
    this.game = game;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: "high-performance", stencil: false });
    } catch (error) {
      console.warn("WebGL is not available, using the 2D valley.", error);
      return new Scene2D(canvas, game) as unknown as Scene;
    }
    this.renderer = renderer;
    this.quality = detectQuality(renderer.getContext() as WebGL2RenderingContext);
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.debug.checkShaderErrors = Boolean(import.meta.env.DEV);
    renderer.shadowMap.enabled = this.quality !== "low";
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.shadowMap.autoUpdate = false;
    renderer.info.autoReset = true;

    this.camera3d = new THREE.PerspectiveCamera(30, 16 / 9, 1, 1400);
    this.atmosphere = new Atmosphere(this.scene3d, renderer, { quality: this.quality, shadowRange: 20, far: 470 });
    // The valley's own ladder (watchPerformance) manages the render scale.
    this.post = new PostFX(renderer, { quality: this.quality, autoScale: false });

    this.waterSky = {
      top: new THREE.Color("#2f7fd6"),
      horizon: new THREE.Color("#d6eeff"),
      sunDir: new THREE.Vector3(0.3, 0.7, 0.5),
      sunColor: new THREE.Color("#fff2d9"),
      time: { value: 0 },
    };
    const mask = getMask();
    this.sharedLand = createSharedLand(mask, this.waterSky);
    this.backdrop = new Backdrop({ sunDir: this.waterSky.sunDir, sunColor: this.waterSky.sunColor, horizon: this.waterSky.horizon });
    this.scene3d.add(this.backdrop.group);

    for (let slot = 0; slot < LOT_SLOTS; slot++) {
      const lot = new LotStatic(slot, this.quality, this.sharedLand, mask);
      this.scene3d.add(lot.group);
      this.lots.push(lot);
    }

    // Particles.
    this.particlePos = new Float32Array(PARTICLE_CAP * 3);
    this.particleCol = new Float32Array(PARTICLE_CAP * 3);
    this.particleSize = new Float32Array(PARTICLE_CAP);
    const particleGeo = new THREE.BufferGeometry();
    particleGeo.setAttribute("position", new THREE.BufferAttribute(this.particlePos, 3));
    particleGeo.setAttribute("aColor", new THREE.BufferAttribute(this.particleCol, 3));
    particleGeo.setAttribute("aSize", new THREE.BufferAttribute(this.particleSize, 1));
    const particleMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
      uniforms: {},
      vertexShader: /* glsl */ `
        attribute vec3 aColor;
        attribute float aSize;
        varying vec3 vC;
        void main(){ vC = aColor; vec4 mv = modelViewMatrix*vec4(position,1.0); gl_PointSize = aSize*(280.0/-mv.z); gl_Position = projectionMatrix*mv; }
      `,
      fragmentShader: /* glsl */ `
        varying vec3 vC;
        void main(){ vec2 q = gl_PointCoord*2.0-1.0; float d = dot(q,q); if(d>1.0) discard; float s = pow(1.0-d,0.9); gl_FragColor = vec4(vC*1.1, s); }
      `,
    });
    this.particlePoints = new THREE.Points(particleGeo, particleMat);
    this.particlePoints.frustumCulled = false;
    this.scene3d.add(this.particlePoints);

    // Hover outline around a plot.
    const outlineGeo = new THREE.RingGeometry(1.06, 1.14, 40);
    outlineGeo.rotateX(-Math.PI / 2);
    this.hoverOutline = new THREE.Mesh(outlineGeo, new THREE.MeshBasicMaterial({ color: new THREE.Color(3, 2.6, 1.6), transparent: true, opacity: 0.9, depthWrite: false }));
    this.hoverOutline.visible = false;
    this.scene3d.add(this.hoverOutline);

    this.fireflies = makeFireflies(this.scene3d, this.quality === "low" ? 25 : 60);
    this.pollen = makePollen(this.scene3d, this.quality === "low" ? 30 : 90);

    // Text overlay: floats, labels and speech bubbles stay sharp as 2D.
    this.overlay = document.createElement("canvas");
    this.overlay.style.cssText = "position:fixed;inset:0;width:100vw;height:100vh;height:100dvh;pointer-events:none;";
    canvas.insertAdjacentElement("afterend", this.overlay);
    this.overlayCtx = this.overlay.getContext("2d")!;
    this.overlay.style.display = "none";
    this.labels = new LabelPool(this.scene3d);

    this.resize();
    addEventListener("resize", () => this.resize());
    this.bindInput();
    void this.prepareShaders();
    if (typeof document !== "undefined" && document.fonts?.ready) {
      void document.fonts.ready.then(() => {
        for (const view of this.farms.values()) view.sign.setText("", false, false, false);
      });
    }
  }

  /**
   * Compiles most programs in parallel before the first frame so the world
   * appears complete instead of stuttering through shader compiles.
   */
  private async prepareShaders() {
    const holder = new THREE.Group();
    this.scene3d.add(holder);
    const genes = [0, 0, 1, 1, 1, 1, 0, 0, 3, 3, 0, 0, 2, 2, 4, 4, 3, 0, 3, 0, 3, 0, 0];
    const kins = kinWarmupSet(lookFromGenes(genes));
    for (const kin of kins) holder.add(kin.group);
    const samples: THREE.Object3D[] = [];
    const egg = new THREE.Mesh(cropGeometry(4, 3), this.cropMaterial);
    holder.add(egg);
    samples.push(egg);
    const nest = buildNest();
    nest.setCount(1);
    holder.add(nest.group);
    const sign = buildSign();
    holder.add(sign.group);
    const cottage = buildCottage(9, ROOFS[0]);
    holder.add(cottage.group);
    // A whole farm's fixtures (smoke, door glow) and a plot of soil, so the first
    // farms that arrive from the chain don't stall a frame compiling them.
    const farmPreview = new FarmView(0);
    holder.add(farmPreview.group);
    const soil = new THREE.Mesh(plotGeometry(), plotMaterials().dry);
    holder.add(soil);
    try {
      this.camera3d.position.set(0, 20, 40);
      this.camera3d.lookAt(0, 0, 0);
      this.camera3d.updateMatrixWorld();
      this.renderer.toneMapping = THREE.NoToneMapping;
      this.renderer.setRenderTarget(this.post.sceneTarget);
      await this.renderer.compileAsync(this.scene3d, this.camera3d);
      // And the shadow-map depth programs of every kind of caster.
      warmShadowCasters(this.renderer, this.scene3d, this.camera3d);
      this.renderer.setRenderTarget(null);
    } catch (error) {
      console.warn("Could not pre-compile shaders", error);
    }
    this.scene3d.remove(holder);
    for (const kin of kins) kin.dispose();
    // The farm pieces stay alive: disposing their materials would free the
    // compiled programs, and the first real farm would have to compile them again.
    warmKeep.push(nest, sign, cottage, farmPreview);
    requestAnimationFrame((time) => this.frame(time));
  }

  resize() {
    this.dpr = Math.min(devicePixelRatio || 1, 2);
    this.width = innerWidth;
    this.height = innerHeight;
    // A phone held upright gets a closer view, and you swipe along the farm.
    const upright = this.width / this.height < 0.8;
    this.scale = Math.min(this.height / VIRTUAL_HEIGHT, this.width / (upright ? 460 : 760));
    this.yOffset = this.height / this.scale - VIRTUAL_HEIGHT;

    let ratio = this.dpr;
    // Keep the buffer to a sensible pixel count; phones and huge screens are the outliers.
    const budget = this.quality === "low" ? 1.1e6 : this.quality === "medium" ? 2.1e6 : 3.7e6;
    const pixels = this.width * this.height;
    ratio = Math.min(ratio, Math.sqrt(budget / Math.max(1, pixels)));
    ratio = Math.max(0.5, ratio);
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(this.width, this.height, false);
    this.post.setSize(Math.round(this.width * ratio), Math.round(this.height * ratio));
    this.camera3d.aspect = this.width / this.height;
    this.camera3d.updateProjectionMatrix();

    this.overlay.width = this.width * this.dpr;
    this.overlay.height = this.height * this.dpr;
  }

  private bindInput() {
    const canvas = this.canvas;
    canvas.addEventListener("pointerdown", (e) => {
      this.dragFrom = { x: e.clientX, camera: this.cameraTarget, moved: false };
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener("pointermove", (e) => {
      if (this.dragFrom) {
        const distance = e.clientX - this.dragFrom.x;
        if (Math.abs(distance) > 8) this.dragFrom.moved = true;
        if (this.dragFrom.moved) this.cameraTarget = this.clampCamera(this.dragFrom.camera - distance / this.scale);
      } else {
        this.hover = this.hitAt(e.clientX, e.clientY);
        canvas.style.cursor = this.hover ? "pointer" : "grab";
      }
    });
    canvas.addEventListener("pointerup", (e) => {
      const drag = this.dragFrom;
      this.dragFrom = null;
      if (drag?.moved) {
        if (this.viewWidth() >= 700) this.snapToLot();
        else this.noteLot();
        return;
      }
      this.onTap?.(this.hitAt(e.clientX, e.clientY), e.clientX, e.clientY);
    });
    addEventListener("keydown", (e) => {
      if ((e.target as HTMLElement).tagName === "INPUT") return;
      if (e.key === "ArrowLeft") this.goToLot(this.lotIndex() - 1);
      if (e.key === "ArrowRight") this.goToLot(this.lotIndex() + 1);
    });
  }

  private clampCamera(x: number) {
    const lastLot = Math.max(0, (this.game.chain?.players ?? 1) - 1);
    const halfView = this.viewWidth() / 2;
    return Math.max(halfView - 160, Math.min(lastLot * LOT + LOT - halfView + 160, x));
  }

  viewWidth() {
    return this.width / (this.scale * this.zoom);
  }

  /** Moves the camera for a shot in the demo film. Normal play never calls this. */
  setFilmCamera(zoom: number, x: number, y: number) {
    this.zoomTarget = zoom;
    this.focusY = y;
    this.cameraTarget = x;
  }

  lotIndex() {
    return Math.floor((this.cameraTarget + LOT * 0.0) / LOT);
  }

  goToLot(index: number) {
    const lastLot = Math.max(0, (this.game.chain?.players ?? 1) - 1);
    const lot = Math.max(0, Math.min(lastLot, index));
    this.cameraTarget = this.clampCamera(lot * LOT + LOT * 0.52);
    if (this.game.around !== lot) {
      this.game.around = lot;
      void this.game.refresh();
    }
  }

  jumpToLot(index: number) {
    this.goToLot(index);
    this.camera = this.cameraTarget;
  }

  private snapToLot() {
    this.goToLot(Math.floor(this.cameraTarget / LOT));
  }

  private noteLot() {
    const lot = Math.floor(this.cameraTarget / LOT);
    if (this.game.around !== lot) {
      this.game.around = lot;
      void this.game.refresh();
    }
  }

  /** On a narrow screen the nest is off to one side, so bring it into view. */
  showNest(lot: number) {
    if (this.viewWidth() >= 900) return;
    this.cameraTarget = this.clampCamera(lot * LOT + NEST.x - 40);
    this.camera = this.cameraTarget;
  }

  // ----- Coordinates ---------------------------------------------------------

  /**
   * Turns logical numbers into a world position. ui.ts offsets y a little to
   * put effects above a plot, so near a plot row those offsets become height.
   */
  private logicalToWorld(x: number, y: number, out: THREE.Vector3) {
    const lot = Math.floor(x / LOT);
    const local = x - lot * LOT;
    const wx = x * WU;
    let wz: number;
    let height: number;
    if (local > PLOT_FIRST_X - 70 && local < PLOT_FIRST_X + 6 * PLOT_GAP + 60) {
      const row = PLOT_ROWS.find((r) => y <= r + 14) ?? PLOT_ROWS[1];
      wz = zOf(row);
      height = Math.max(0, (row - y) * WU * 1.15) + 0.22;
    } else if (Math.abs(local - NEST.x) < 120 && Math.abs(y - NEST.y) < 140) {
      wz = zOf(NEST.y);
      height = Math.max(0, (NEST.y - y) * WU * 1.15) + 0.5;
    } else {
      wz = zOf(y);
      height = 0.5;
    }
    const ground = terrainHeight(wx, wz);
    return out.set(wx, Math.max(ground, ground + height), wz);
  }

  /** Where a thing is on the screen, for placing popups. */
  plotCentre(farm: number, slot: number) {
    const { x, y } = this.plotPosition(farm, slot);
    return { x, y };
  }

  toScreen(x: number, y: number) {
    this.logicalToWorld(x, y, this.tmpV).project(this.camera3d);
    return { x: (this.tmpV.x * 0.5 + 0.5) * this.width, y: (-this.tmpV.y * 0.5 + 0.5) * this.height };
  }

  private plotPosition(farm: number, slot: number) {
    const row = slot < 6 ? 0 : 1;
    const column = slot % 6;
    return { x: farm * LOT + PLOT_FIRST_X + column * PLOT_GAP + row * 14, y: PLOT_ROWS[row] };
  }

  private plotWorld(farm: number, slot: number, out: THREE.Vector3) {
    const { x, y } = this.plotPosition(farm, slot);
    const wz = zOf(y);
    const wx = x * WU;
    return out.set(wx, terrainHeight(wx, wz), wz);
  }

  // ----- Effects -------------------------------------------------------------

  private emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, size: number, color: THREE.Color, gravity: number) {
    if (this.particles.length >= PARTICLE_CAP) return;
    this.particles.push({ x, y, z, vx, vy, vz, life, max: life, size, gravity, color });
  }

  burst(x: number, y: number, colour: string, count = 12) {
    this.logicalToWorld(x, y, this.tmpV);
    const color = new THREE.Color(colour);
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 1.4 + Math.random() * 3;
      this.emit(
        this.tmpV.x,
        this.tmpV.y,
        this.tmpV.z,
        Math.cos(angle) * speed,
        1.8 + Math.random() * 2.4,
        Math.sin(angle) * speed * 0.7,
        0.55 + Math.random() * 0.4,
        0.14 + Math.random() * 0.14,
        color,
        9,
      );
    }
  }

  splash(x: number, y: number) {
    this.logicalToWorld(x, y, this.tmpV);
    const color = new THREE.Color("#8fd3f4");
    for (let i = 0; i < 16; i++) {
      this.emit(
        this.tmpV.x + (Math.random() - 0.5) * 1.5,
        this.tmpV.y + 1.4 + Math.random() * 0.6,
        this.tmpV.z + (Math.random() - 0.5) * 1.2,
        0,
        -3.2 - Math.random() * 1.6,
        0,
        0.45,
        0.1,
        color,
        6,
      );
    }
  }

  float(x: number, y: number, text: string, colour = "#fff6d0") {
    const world = new THREE.Vector3();
    this.logicalToWorld(x, y, world);
    this.floats.push({ world, text, colour, life: 1.25 });
  }

  bubble(farm: number, text: string) {
    this.bubbles.set(farm, { text, life: 3.6 });
  }

  wobbleEgg(egg: number, amount = 1) {
    this.wobbles.set(egg, amount);
  }

  setCrack(egg: number, amount: number) {
    this.cracks.set(egg, amount);
  }

  cheerKin(id: number) {
    const actor = this.actors.get(id);
    if (actor) actor.joy = 1;
  }

  // ----- Hit testing -----------------------------------------------------------

  private rayHitsSphere(ray: THREE.Ray, center: THREE.Vector3, radius: number): number | null {
    const hit = ray.intersectSphere(new THREE.Sphere(center, radius), this.tmpV2);
    return hit ? hit.distanceTo(ray.origin) : null;
  }

  private hitAt(screenX: number, screenY: number): Hit | null {
    const view = this.game.view;
    if (!view) return null;
    this.ndc.set((screenX / this.width) * 2 - 1, -(screenY / this.height) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.camera3d);
    const ray = this.raycaster.ray;

    // Kinlings first, nearest to the camera wins.
    let bestKin: { id: number; farm: number } | null = null;
    let bestDistance = Infinity;
    for (const actor of this.actors.values()) {
      if (!actor.model) continue;
      const wx = actor.x * WU;
      const wz = zOf(actor.y);
      const size = kinSize(actor.modelLevel) * VALLEY_KIN_SCALE;
      const center = this.tmpV.set(wx, terrainHeight(wx, wz) + 0.72 * size, wz);
      const distance = this.rayHitsSphere(ray, center, 0.95 * size);
      if (distance !== null && distance < bestDistance) {
        bestDistance = distance;
        bestKin = { id: actor.id, farm: actor.farm };
      }
    }
    if (bestKin) return { kind: "kin", farm: bestKin.farm, id: bestKin.id };

    for (const view3d of this.farms.values()) {
      const farmData = view.farms.get(view3d.index);
      if (!farmData) continue;
      // Eggs.
      let bestEgg: number | null = null;
      let bestEggDistance = Infinity;
      const baseX = view3d.index * LOT_W + NEST.x * WU;
      const baseZ = zOf(NEST.y);
      const baseY = terrainHeight(NEST.x * WU, baseZ);
      const count = view3d.eggIds.length;
      for (let i = 0; i < count; i++) {
        const slot = eggSlot(i, count);
        const scale = this.eggScale(count);
        const center = this.tmpV.set(baseX + slot.x * scale, baseY + slot.y + 0.42, baseZ + slot.z * scale);
        const distance = this.rayHitsSphere(ray, center, 0.42 * scale + 0.12);
        if (distance !== null && distance < bestEggDistance) {
          bestEggDistance = distance;
          bestEgg = view3d.eggIds[i];
        }
      }
      if (bestEgg !== null) return { kind: "egg", farm: view3d.index, egg: bestEgg };

      // Plots: where the ray meets the ground plane of the plots.
      const planeY = 0.16;
      const t = (planeY - ray.origin.y) / ray.direction.y;
      if (t > 0) {
        const px = ray.origin.x + ray.direction.x * t;
        const pz = ray.origin.z + ray.direction.z * t;
        for (let slot = 0; slot < farmData.plots.length; slot++) {
          this.plotWorld(view3d.index, slot, this.tmpV);
          const hx = this.tmpV.x;
          const hy = this.tmpV.y;
          const hz = this.tmpV.z;
          // The soil itself, or the plant standing on it.
          if (Math.abs(px - hx) < 1.16 && Math.abs(pz - hz) < 1.08) return { kind: "plot", farm: view3d.index, slot };
          if (farmData.plots[slot].crop !== 0) {
            const distance = this.rayHitsSphere(ray, this.tmpV.set(hx, hy + 0.7, hz), 1.02);
            if (distance !== null && distance < bestEggDistance + 1e9) return { kind: "plot", farm: view3d.index, slot };
          }
        }
      }

      // The camera sees the plots at a shallow angle, so they are thin on
      // screen. A tap just above or below one still means that plot.
      let nearestSlot = -1;
      let nearestGap = Infinity;
      const reachX = Math.max(42, this.width * 0.04);
      const reachY = Math.max(40, this.height * 0.06);
      for (let slot = 0; slot < farmData.plots.length; slot++) {
        this.plotWorld(view3d.index, slot, this.tmpV);
        this.tmpV.y += 0.3;
        this.tmpV.project(this.camera3d);
        const dx = Math.abs((this.tmpV.x * 0.5 + 0.5) * this.width - screenX);
        const dy = Math.abs((-this.tmpV.y * 0.5 + 0.5) * this.height - screenY);
        const gap = dx * dx + dy * dy;
        if (dx < reachX && dy < reachY && gap < nearestGap) {
          nearestGap = gap;
          nearestSlot = slot;
        }
      }
      if (nearestSlot >= 0) return { kind: "plot", farm: view3d.index, slot: nearestSlot };

      // The signpost.
      const signCenter = this.tmpV.set(view3d.index * LOT_W + (SIGN.x + 60) * WU, 1.9, zOf(SIGN.y));
      if (this.rayHitsSphere(ray, signCenter, 1.35) !== null) return { kind: "sign", farm: view3d.index };
    }
    return null;
  }

  // ----- Frame -----------------------------------------------------------------

  private frame(time: number) {
    requestAnimationFrame((next) => this.frame(next));
    if (this.paused) {
      this.last = time;
      return;
    }
    const dt = Math.max(0, Math.min(0.05, (time - this.last) / 1000 || 0.016));
    this.last = time;
    this.step(dt);
    this.render(dt);
  }

  private step(dt: number) {
    this.t += dt;
    this.camera += (this.cameraTarget - this.camera) * Math.min(1, dt * 7);
    this.zoom += (this.zoomTarget - this.zoom) * Math.min(1, dt * 2.2);
    windTime.value += dt;
    tickCrops(this.t);
    this.kinBuildsThisFrame = 0;

    for (const [egg, wobble] of this.wobbles) {
      const next = wobble - dt * 1.4;
      if (next <= 0) this.wobbles.delete(egg);
      else this.wobbles.set(egg, next);
    }
    for (const [farm, bubble] of this.bubbles) {
      bubble.life -= dt;
      if (bubble.life <= 0) this.bubbles.delete(farm);
    }
    this.floats = this.floats.filter((f) => {
      f.life -= dt;
      f.world.y += 1.1 * dt;
      return f.life > 0;
    });

    this.particles = this.particles.filter((p) => {
      p.life -= dt;
      p.vy -= p.gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      return p.life > 0;
    });

    this.updateFarms(dt);
    this.stepActors(dt);
  }

  private updateFarms(dt: number) {
    const view = this.game.view;
    const centre = Math.floor(this.camera / LOT);

    // Place the static land so the farms around the camera are covered, and
    // draw only what can be seen.
    const reach = this.viewWidth() * 0.72;
    const leftLot = Math.floor((this.camera - reach) / LOT);
    const rightLot = Math.min(leftLot + LOT_SLOTS - 1, Math.floor((this.camera + reach) / LOT));
    for (const lot of this.lots) lot.group.visible = false;
    for (let lot = leftLot; lot <= rightLot; lot++) {
      const slot = ((lot % LOT_SLOTS) + LOT_SLOTS) % LOT_SLOTS;
      this.lots[slot].group.position.x = lot * LOT_W;
      this.lots[slot].group.visible = true;
    }
    if (!view) return;

    const seen = new Set<number>();
    const now = this.game.chainNow();
    for (const farm of view.farms.values()) {
      if (Math.abs(farm.index - centre) > 3) continue;
      seen.add(farm.index);
      let farmView = this.farms.get(farm.index);
      if (!farmView) {
        farmView = new FarmView(farm.index);
        this.farms.set(farm.index, farmView);
        this.scene3d.add(farmView.group);
      }
      farmView.group.visible = farm.index >= leftLot - 1 && farm.index <= rightLot + 1;
      this.syncFarm(farmView, farm, now, dt);
    }
    for (const [index, farmView] of this.farms) {
      if (!seen.has(index)) {
        farmView.dispose();
        this.farms.delete(index);
      }
    }
  }

  private cottageKey(rank: number, index: number) {
    return `${rank >= 8 ? 3 : rank >= 5 ? 2 : rank >= 2 ? 1 : 0}:${ROOFS[index % ROOFS.length]}`;
  }

  private syncFarm(view3d: FarmView, farm: Farm, now: number, _dt: number) {
    const view = this.game.view!;
    const rank = farmerRank(farm.xp);
    const key = this.cottageKey(rank, farm.index);
    if (key !== view3d.cottageKey) {
      view3d.cottageKey = key;
      view3d.cottage?.dispose();
      if (view3d.cottage) view3d.group.remove(view3d.cottage.group);
      view3d.cottage = buildCottage(rank, ROOFS[farm.index % ROOFS.length]);
      const scale = 0.72 + rank * 0.05;
      view3d.cottage.group.scale.setScalar(scale);
      view3d.cottage.group.position.set(COTTAGE.x * WU, 0, -3.3);
      view3d.cottage.group.rotation.y = 0.12;
      view3d.group.add(view3d.cottage.group);
      const at = view3d.cottage.smokeAt.clone().multiplyScalar(scale).applyEuler(view3d.cottage.group.rotation).add(view3d.cottage.group.position);
      view3d.smoke.mesh.position.copy(at);
    }

    const night = this.atmosphere.night;
    if (view3d.cottage) view3d.cottage.glassMaterial.emissiveIntensity = night * 2.6 + (night > 0.2 ? 0.3 : 0);
    view3d.glowMaterial.uniforms.uNight.value = smooth(0.25, 0.8, night);
    view3d.smoke.update(this.t + view3d.index * 7.3, 0);

    // Sign.
    const mine = farm.index === view.me;
    view3d.sign.setText(mine ? `${farm.name} (you)` : farm.name, farm.elder, now - farm.seen < 180 && !farm.elder, mine);

    // Plots.
    const materials = plotMaterials();
    for (let slot = 0; slot < farm.plots.length; slot++) {
      let plotView = view3d.plots[slot];
      const position = this.plotWorld(0, slot, this.tmpV);
      if (!plotView) {
        const soil = new THREE.Mesh(plotGeometry(), materials.dry);
        soil.position.copy(position);
        soil.position.y += 0.02;
        soil.receiveShadow = true;
        soil.castShadow = true;
        view3d.group.add(soil);
        plotView = { soil, crop: null, item: -1, stage: -1, wet: false };
        view3d.plots[slot] = plotView;
      }
      const plot = farm.plots[slot];
      const wet = plot.waterings > 0 && plot.crop !== 0;
      if (wet !== plotView.wet) {
        plotView.wet = wet;
        plotView.soil.material = wet ? materials.wet : materials.dry;
      }
      let stage = -1;
      if (plot.crop !== 0) {
        const info = cropInfo(plot.crop);
        const left = plot.readyAt - now;
        const progress = info ? 1 - Math.max(0, left) / info.grow : 1;
        stage = left <= 0 ? 3 : progress < 0.34 ? 0 : progress < 0.7 ? 1 : 2;
      }
      if (stage !== plotView.stage || plot.crop !== plotView.item) {
        plotView.stage = stage;
        plotView.item = plot.crop;
        if (plotView.crop) {
          plotView.crop.removeFromParent();
          plotView.crop = null;
        }
        if (stage >= 0) {
          const crop = new THREE.Mesh(cropGeometry(plot.crop, stage), this.cropMaterial);
          crop.position.copy(position);
          crop.position.y += 0.12;
          crop.rotation.y = (slot * 2.4 + farm.index) % 6.283;
          crop.castShadow = true;
          crop.receiveShadow = true;
          crop.frustumCulled = false;
          view3d.group.add(crop);
          plotView.crop = crop;
        }
      }
      // Sparkle over ripe crops now and then.
      if (stage === 3 && Math.random() < _dt * 2.2) {
        const px = view3d.index * LOT_W + position.x + (Math.random() - 0.5) * 1.5;
        const py = position.y + 0.6 + Math.random() * 1.1;
        const pz = position.z + (Math.random() - 0.5) * 1.3;
        this.emit(px, py, pz, 0, 0.5, 0, 0.8, 0.1, new THREE.Color("#fff7be"), -0.4);
      }
    }
    // Hide spare plot views if the farm shrank (it shouldn't, but be safe).
    for (let slot = farm.plots.length; slot < view3d.plots.length; slot++) view3d.plots[slot].soil.visible = false;

    // Eggs.
    this.syncNest(view3d, farm, now);
  }

  private eggScale(count: number) {
    return clamp(1 - Math.max(0, count - 7) * 0.012, 0.74, 1);
  }

  private syncNest(view3d: FarmView, farm: Farm, now: number) {
    const view = this.game.view!;
    const nest = view3d.nest;
    const eggs = farm.eggs.slice(0, EGG_LIMIT);
    nest.setCount(eggs.length);
    view3d.eggIds = eggs;
    const count = eggs.length;
    const baseScale = this.eggScale(count);
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const euler = new THREE.Euler();
    const scale = new THREE.Vector3();
    const nestScale = clamp(1 + Math.max(0, count - 7) * 0.02, 1, 1.55);
    eggs.forEach((id, index) => {
      const egg = view.eggs.get(id);
      const slot = eggSlot(index, count);
      const ready = egg ? egg.readyAt <= now : false;
      const hatching = egg?.hatching ?? false;
      const idle = ready ? ((Math.sin(this.t * 1.5 + index) + 1) / 2 > 0.62 ? 0.34 : 0) : 0;
      const shake = this.wobbles.get(id) ?? (hatching ? 0.8 : idle);
      const tilt = Math.sin(this.t * 22 + index) * shake * 0.26;
      const hatchPop = hatching ? 1.08 : 1;
      position.set(slot.x * nestScale, slot.y, slot.z * nestScale);
      euler.set(slot.tilt * Math.sin(index * 2.1) * 0.6 + tilt * 0.6, index * 2.4, slot.tilt * Math.cos(index * 2.1) * 0.6 + tilt);
      quaternion.setFromEuler(euler);
      const s = baseScale * 0.58 * hatchPop;
      scale.set(s, s, s);
      matrix.compose(position, quaternion, scale);
      nest.eggs.setMatrixAt(index, matrix);
      const [a, b] = egg ? eggColours(egg, this.game) : ["#cccccc", "#999999"];
      const ca = this.tmpColorA.set(a);
      const cb = this.tmpColorB.set(b);
      nest.eggColorA.setXYZ(index, ca.r, ca.g, ca.b);
      nest.eggColorB.setXYZ(index, cb.r, cb.g, cb.b);
      const crack = this.cracks.get(id) ?? (hatching ? 0.7 : 0);
      nest.eggState.setXYZW(index, ((id * 37) % 100) / 100, crack, ready ? 0.35 + Math.sin(this.t * 2 + index) * 0.2 : 0, 0);
    });
    nest.eggs.instanceMatrix.needsUpdate = true;
    nest.eggColorA.needsUpdate = true;
    nest.eggColorB.needsUpdate = true;
    nest.eggState.needsUpdate = true;
  }
  private tmpColorA = new THREE.Color();
  private tmpColorB = new THREE.Color();

  private stepActors(dt: number) {
    const view = this.game.view;
    if (!view) return;
    const present = new Set<number>();
    const centre = Math.floor(this.camera / LOT);
    for (const farm of view.farms.values()) {
      for (const id of farm.kins) {
        const kin = view.kins.get(id);
        if (!kin) continue;
        present.add(id);
        let actor = this.actors.get(id);
        if (!actor) {
          const x = farm.index * LOT + WALK_AREA.left + Math.random() * (WALK_AREA.right - WALK_AREA.left);
          const y = WALK_AREA.top + Math.random() * (WALK_AREA.bottom - WALK_AREA.top);
          actor = {
            id,
            farm: farm.index,
            x,
            y,
            dir: Math.random() > 0.5 ? 1 : -1,
            targetX: x,
            targetY: y,
            pause: Math.random() * 3,
            moving: false,
            joy: 0,
            model: null,
            modelLevel: 1,
            rotation: Math.random() * 6.28,
            pose: { speed: 0, airborne: false, joy: 0, hurt: 0, frozen: 0, attack: 0 },
            distance: Infinity,
          };
          this.actors.set(id, actor);
        }
        actor.farm = farm.index;
        this.moveActor(actor, farm, dt);
        actor.distance = Math.abs(actor.x - this.camera);
      }
    }
    // Forget departed creatures.
    for (const [id, actor] of this.actors) {
      if (!present.has(id)) {
        if (actor.model) {
          this.scene3d.remove(actor.model.group);
          actor.model.dispose();
        }
        this.actors.delete(id);
      }
    }

    // Reassign models a couple of times a second; meanwhile keep building any
    // that are missing at a rate of one per frame.
    this.selectTimer -= dt;
    if (this.selectTimer <= 0 || this.missingModels > 0) {
      this.selectTimer = 0.5;
      this.chooseModels(view.kins, centre);
    }

    // Move the models.
    for (const actor of this.actors.values()) {
      if (!actor.model) continue;
      const kin = view.kins.get(actor.id)!;
      const level = kinLevel(kin.xp);
      if (level !== actor.modelLevel) {
        actor.modelLevel = level;
      }
      actor.model.group.scale.setScalar(kinSize(actor.modelLevel) * VALLEY_KIN_SCALE);
      const wx = actor.x * WU;
      const wz = zOf(actor.y);
      actor.model.group.position.set(wx, terrainHeight(wx, wz), wz);
      // Only creatures on or near the screen are drawn.
      const farmDistance = Math.abs(actor.x - this.camera);
      actor.model.group.visible = farmDistance < this.viewWidth() * 0.62;
      if (!actor.model.group.visible) continue;
      const targetRotation = actor.moving ? Math.atan2(actor.targetX - actor.x, (actor.targetY - actor.y) * (Z_SCALE / WU)) : actor.rotation;
      let delta = targetRotation - actor.rotation;
      delta = Math.atan2(Math.sin(delta), Math.cos(delta));
      actor.rotation += delta * Math.min(1, dt * 7);
      actor.model.group.rotation.y = actor.rotation;
      actor.pose.speed = actor.moving ? 0.32 : 0;
      actor.pose.joy = actor.joy;
      actor.model.setDaylight(1 - this.atmosphere.night);
      actor.model.update(dt, actor.pose);
    }
  }

  private chooseModels(kins: Map<number, Kin>, centre: number) {
    const budget = this.kinBudget();
    const byFarm = new Map<number, Actor[]>();
    for (const actor of this.actors.values()) {
      const list = byFarm.get(actor.farm) ?? [];
      list.push(actor);
      byFarm.set(actor.farm, list);
    }
    // Nearest farms first, so the farm on screen gets its creatures soonest.
    const ordered = [...byFarm.entries()].sort((a, b) => Math.abs(a[0] - centre) - Math.abs(b[0] - centre));
    let missing = 0;
    for (const [farm, list] of ordered) {
      const nearby = Math.abs(farm - centre) <= 1;
      list.sort((a, b) => a.distance - b.distance);
      const limit = nearby ? MAX_KINS_PER_FARM : Math.max(2, Math.round(MAX_KINS_PER_FARM * 0.4));
      list.forEach((actor, index) => {
        const want = index < Math.min(limit, budget);
        if (want && !actor.model) {
          missing++;
          if (this.kinBuildsThisFrame < 1) {
            const kin = kins.get(actor.id);
            if (!kin) return;
            const level = kinLevel(kin.xp);
            actor.modelLevel = level;
            actor.model = buildKin(kin.look, { level, generation: kin.generation, detail: "far" });
            this.scene3d.add(actor.model.group);
            this.kinBuildsThisFrame += 1;
            missing--;
          }
        } else if (!want && actor.model) {
          this.scene3d.remove(actor.model.group);
          actor.model.dispose();
          actor.model = null;
        }
      });
    }
    this.missingModels = missing;
  }

  private kinBudget() {
    return this.quality === "low" ? 4 : MAX_KINS_PER_FARM;
  }

  private moveActor(actor: Actor, farm: Farm, dt: number) {
    actor.joy = Math.max(0, actor.joy - dt * 0.7);
    if (actor.pause > 0) {
      actor.pause -= dt;
      actor.moving = false;
      if (actor.pause <= 0) {
        actor.targetX = farm.index * LOT + WALK_AREA.left + Math.random() * (WALK_AREA.right - WALK_AREA.left);
        actor.targetY = WALK_AREA.top + Math.random() * (WALK_AREA.bottom - WALK_AREA.top);
      }
      return;
    }
    const dx = actor.targetX - actor.x;
    const dy = actor.targetY - actor.y;
    const distance = Math.hypot(dx, dy);
    if (distance < 4) {
      actor.pause = 2 + Math.random() * 6;
      actor.moving = false;
      return;
    }
    const speed = 46;
    actor.x += (dx / distance) * speed * dt;
    actor.y += (dy / distance) * speed * dt;
    actor.dir = dx >= 0 ? 1 : -1;
    actor.moving = true;
  }

  private render(dt: number) {
    const phase = dayPhase(this.timeOverride);
    if (Math.abs(phase - this.lastPhase) > 0.0008 || this.timeOverride !== null) {
      this.lastPhase = phase;
      this.atmosphere.setPhase(phase);
    }
    const night = nightness(phase);
    const a = this.atmosphere;

    // Camera: a pleasing elevated three-quarter view that glides along the road.
    const aspect = this.width / this.height;
    const upright = aspect < 0.8;
    const vFov = upright ? 40 : 30;
    const cam = this.camera3d;
    if (cam.fov !== vFov) {
      cam.fov = vFov;
      cam.updateProjectionMatrix();
    }
    const viewWorld = this.viewWidth() * WU * (upright ? 1.05 : 1);
    const hTan = Math.tan((vFov * Math.PI) / 360) * aspect;
    const distance = (viewWorld / 2) / hTan;
    const pitch = upright ? 0.26 : 0.15;
    const focusZ = this.focusY !== null ? zOf(this.focusY) : 0.5;
    const focusHeight = this.focusY !== null ? 1.2 : 2.3;
    const fx = this.camera * WU;
    this.focus.set(fx, 0.8, focusZ);
    cam.position.set(fx, focusHeight + Math.sin(pitch) * distance, focusZ + Math.cos(pitch) * distance);
    cam.lookAt(fx, focusHeight, focusZ);
    cam.updateMatrixWorld();

    // World animation uniforms.
    this.waterSky.time.value = this.t;
    this.waterSky.top.copy((a.sky.material as THREE.ShaderMaterial).uniforms.uTop.value as THREE.Color);
    this.waterSky.horizon.copy((a.sky.material as THREE.ShaderMaterial).uniforms.uHorizon.value as THREE.Color);
    this.waterSky.sunDir.copy(a.sunDir);
    this.waterSky.sunColor.copy(a.sun.color).multiplyScalar(a.sun.intensity * 0.25);
    this.sharedLand.water.uniforms.uNight.value = night;

    const uniformsF = this.fireflies.material.uniforms;
    uniformsF.uT.value = this.t;
    uniformsF.uNight.value = smooth(0.2, 0.8, night);
    (uniformsF.uFocus.value as THREE.Vector3).copy(this.focus);
    const uniformsP = this.pollen.material.uniforms;
    uniformsP.uT.value = this.t;
    uniformsP.uDay.value = 1 - smooth(0.05, 0.5, night);
    (uniformsP.uFocus.value as THREE.Vector3).copy(this.focus);

    // Hover outline.
    if (this.hover?.kind === "plot") {
      this.plotWorld(this.hover.farm, this.hover.slot, this.tmpV);
      this.hoverOutline.position.set(this.tmpV.x, this.tmpV.y + 0.2, this.tmpV.z);
      this.hoverOutline.visible = true;
      (this.hoverOutline.material as THREE.MeshBasicMaterial).opacity = 0.75 + Math.sin(this.t * 6) * 0.2;
    } else {
      this.hoverOutline.visible = false;
    }

    this.uploadParticles();
    this.atmosphere.update(dt, this.focus, cam);
    this.backdrop.update(fx, night, this.t, this.waterSky.horizon);

    this.frameCount++;
    this.renderer.shadowMap.needsUpdate = this.frameCount % (this.lowShadows ? 4 : 2) === 0;
    this.drawLabels();
    this.post.render(this.scene3d, cam, dt);
    this.drawOverlay();
    this.watchPerformance(dt);
  }

  private uploadParticles() {
    const n = Math.min(this.particles.length, PARTICLE_CAP);
    for (let i = 0; i < n; i++) {
      const p = this.particles[i];
      this.particlePos[i * 3] = p.x;
      this.particlePos[i * 3 + 1] = p.y;
      this.particlePos[i * 3 + 2] = p.z;
      const fade = Math.min(1, p.life / (p.max * 0.5));
      this.particleCol[i * 3] = p.color.r;
      this.particleCol[i * 3 + 1] = p.color.g;
      this.particleCol[i * 3 + 2] = p.color.b;
      this.particleSize[i] = p.size * fade;
    }
    const geometry = this.particlePoints.geometry;
    geometry.setDrawRange(0, n);
    geometry.attributes.position.needsUpdate = true;
    geometry.attributes.aColor.needsUpdate = true;
    geometry.attributes.aSize.needsUpdate = true;
  }

  private ladder = [
    { scale: 1, samples: 2, bloom: true, grass: 1, shadows: true },
    { scale: 0.85, samples: 2, bloom: true, grass: 1, shadows: true },
    { scale: 0.85, samples: 0, bloom: true, grass: 1, shadows: true },
    { scale: 0.75, samples: 0, bloom: true, grass: 0.75, shadows: true },
    { scale: 0.65, samples: 0, bloom: false, grass: 0.5, shadows: true },
    { scale: 0.55, samples: 0, bloom: false, grass: 0.3, shadows: false },
  ];

  private applyRung(level: number) {
    const rung = this.ladder[level];
    this.post.setRenderScale(rung.scale);
    this.post.setSamples(rung.samples);
    this.post.bloom = rung.bloom;
    for (const lot of this.lots) lot.setGrassDensity(rung.grass);
    // Smaller, less frequent shadows rather than none: switching shadows off
    // would recompile every lit material and freeze the valley for seconds.
    this.atmosphere.setShadowDetail(!rung.shadows);
    this.lowShadows = !rung.shadows;
  }
  private lowShadows = false;

  private watchPerformance(dt: number) {
    const perf = this.perf;
    if (location.search.includes("noadapt") || filmMode()) return;
    if (perf.wait > 0) {
      perf.wait -= dt;
      return;
    }
    perf.frames++;
    perf.time += dt;
    if (perf.time < 1.5) return;
    const fps = perf.frames / perf.time;
    perf.frames = 0;
    perf.time = 0;
    const top = this.ladder.length - 1;
    if (fps < 52 && perf.level < top) {
      perf.level++;
      perf.wait = 1.5;
      this.applyRung(perf.level);
    } else if (fps > 58 && perf.level > 0) {
      perf.upgrades++;
      if (perf.upgrades >= 6) {
        perf.upgrades = 0;
        perf.level--;
        perf.wait = 6;
        this.applyRung(perf.level);
      }
    } else {
      perf.upgrades = 0;
    }
  }

  // ----- Text overlay ------------------------------------------------------------

  private project(world: THREE.Vector3): { x: number; y: number } | null {
    this.tmpV.copy(world).project(this.camera3d);
    if (this.tmpV.z > 1) return null;
    return { x: (this.tmpV.x * 0.5 + 0.5) * this.width, y: (-this.tmpV.y * 0.5 + 0.5) * this.height };
  }

  /** Egg timers and my Kinlings' names, drawn as sprites inside the scene. */
  private drawLabels() {
    const view = this.game.view;
    this.labels.begin(this.height, this.camera3d.fov);
    if (view) {
      const now = this.game.chainNow();
      for (const farmView of this.farms.values()) {
        if (!farmView.group.visible) continue;
        const count = farmView.eggIds.length;
        // Timers for the soonest few eggs, spread so they never overlap.
        const timers: { left: number; index: number }[] = [];
        for (let i = 0; i < count; i++) {
          const egg = view.eggs.get(farmView.eggIds[i]);
          if (!egg || egg.readyAt <= now || egg.hatching) continue;
          timers.push({ left: Math.ceil(egg.readyAt - now), index: i });
        }
        timers.sort((a, b) => a.left - b.left);
        const nestX = farmView.index * LOT_W + NEST.x * WU;
        const nestZ = zOf(NEST.y);
        const baseY = terrainHeight(NEST.x * WU, nestZ);
        const shown = timers.slice(0, 3);
        const toCam = this.tmpV.set(nestX, baseY, nestZ).distanceTo(this.camera3d.position);
        const pixelsPerUnit = this.height / (2 * Math.tan((this.camera3d.fov * Math.PI) / 360) * toCam);
        const spacing = 118 / pixelsPerUnit;
        shown.forEach((timer, i) => {
          const label = timer.left >= 60 ? Math.floor(timer.left / 60) + "m " + (timer.left % 60) + "s" : timer.left + "s";
          const offset = (i - (shown.length - 1) / 2) * spacing;
          this.labels.add(label, this.tmpV2.set(nestX + offset, baseY + 1.65, nestZ), "#fff6e3");
        });
        if (count > 3) {
          this.labels.add(count + " eggs", this.tmpV2.set(nestX, baseY + 2.45, nestZ), "#fff6e3", 0.82);
        }
      }
      // Names under my own Kinlings.
      for (const actor of this.actors.values()) {
        if (!actor.model || actor.farm !== view.me) continue;
        const kin = view.kins.get(actor.id);
        if (!kin) continue;
        const wx = actor.x * WU;
        const wz = zOf(actor.y);
        this.labels.add(capitalise(kin.name), this.tmpV2.set(wx, terrainHeight(wx, wz) + 0.03, wz + 0.75), "#fff6e3", 0.9);
      }
    }
    this.labels.end();
  }

  /** The 2D overlay only exists while floating numbers or speech bubbles do. */
  private drawOverlay() {
    const hasFloats = this.floats.length > 0;
    const bubbles = this.bubbles.size > 0;
    if (!hasFloats && !bubbles) {
      if (this.overlayShown) {
        this.overlayShown = false;
        this.overlay.style.display = "none";
        this.overlayCtx.clearRect(0, 0, this.overlay.width, this.overlay.height);
      }
      return;
    }
    if (!this.overlayShown) {
      this.overlayShown = true;
      this.overlay.style.display = "block";
    }
    const ctx = this.overlayCtx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    const s = this.scale;

    // Speech bubbles over signs.
    for (const [farm, bubble] of this.bubbles) {
      const screen = this.project(this.tmpV2.set(farm * LOT_W + SIGN.x * WU + 0.3, 3.4, zOf(SIGN.y)));
      if (screen) this.drawBubble(ctx, screen.x, screen.y, bubble.text, s);
    }

    // Floats on top.
    ctx.font = "700 " + Math.round(25 * s) + "px Fredoka, sans-serif";
    ctx.textAlign = "center";
    ctx.lineJoin = "round";
    for (const float of this.floats) {
      const screen = this.project(float.world);
      if (!screen) continue;
      ctx.globalAlpha = Math.min(1, float.life * 1.6);
      ctx.lineWidth = 6 * s;
      ctx.strokeStyle = "#4a3322";
      ctx.strokeText(float.text, screen.x, screen.y);
      ctx.fillStyle = float.colour;
      ctx.fillText(float.text, screen.x, screen.y);
    }
    ctx.globalAlpha = 1;
  }

  private drawBubble(ctx: CanvasRenderingContext2D, x: number, y: number, text: string, s: number) {
    ctx.save();
    ctx.font = `600 ${Math.round(17 * s)}px Fredoka, sans-serif`;
    const width = ctx.measureText(text).width + 26 * s;
    const h = 36 * s;
    ctx.fillStyle = "#fff6e3";
    ctx.strokeStyle = "#4a3322";
    ctx.lineWidth = 3 * s;
    ctx.beginPath();
    ctx.roundRect(x - width / 2, y - h / 2, width, h, 14 * s);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x - 12 * s, y + h / 2 - s);
    ctx.lineTo(x - 20 * s, y + h / 2 + 14 * s);
    ctx.lineTo(x + 2 * s, y + h / 2 - s);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#3b2a1e";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, x, y);
    ctx.restore();
  }
}
