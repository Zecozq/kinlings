// One shared offscreen renderer draws every 3D portrait and icon, so the panels
// get real 3D art without creating a WebGL context per picture.
//
//   kinPortrait(look, { size, level, generation })  -> a 2D canvas, cached
//   eggPortrait(colourA, colourB, seed, size)       -> a 2D canvas, cached
//   itemPortrait(item, size)                        -> a 2D canvas, cached
//   createKinViewer(canvas, look, opts)             -> { stop(), setJoy(n) }
//
// All of them return or draw through a shared GL canvas with drawImage, so
// they work on a plain 2D canvas. If WebGL is unavailable the portrait
// functions return null and dom.ts falls back to the original 2D drawings.

import * as THREE from "three";
import type { Look } from "../creature.ts";
import { IDLE_POSE, buildKin, kinSize, type Kin3D } from "./kin3d.ts";
import { eggGeometry, foodModel, makeEggMaterial, produceKeyView, type FoodModel } from "./crops.ts";
import { detectQuality } from "./gfx.ts";
import { windTime } from "./flora.ts";

class Studio {
  readonly renderer: THREE.WebGLRenderer;
  readonly canvas: HTMLCanvasElement;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(22, 1, 0.1, 50);
  private shadowDisc: THREE.Mesh;
  private width = 256;
  private height = 256;

  constructor() {
    this.canvas = document.createElement("canvas");
    const renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      alpha: true,
      antialias: true,
      premultipliedAlpha: true,
      powerPreference: "default",
    });
    renderer.setPixelRatio(1);
    renderer.setSize(this.width, this.height, false);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.92;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setClearColor(0x000000, 0);
    // Only the food stage has a shadow-casting light; creature portraits keep their disc.
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.VSMShadowMap;
    this.renderer = renderer;

    // A sky-gradient environment gives glossy eyes and horns something to catch.
    const envScene = new THREE.Scene();
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(10, 24, 16),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        vertexShader: "varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }",
        fragmentShader: `varying vec3 vP;
          void main(){ float h = normalize(vP).y*0.5+0.5;
            vec3 c = mix(vec3(0.38,0.34,0.28), vec3(0.6,0.78,1.0), smoothstep(0.3,0.75,h));
            c += vec3(4.0,3.5,2.8)*pow(max(dot(normalize(vP), normalize(vec3(0.4,0.8,0.5))),0.0), 80.0);
            gl_FragColor = vec4(c,1.0); }`,
      }),
    );
    envScene.add(sky);
    const pmrem = new THREE.PMREMGenerator(renderer);
    const env = pmrem.fromScene(envScene, 0.04);
    this.scene.environment = env.texture;
    this.scene.environmentIntensity = 0.55;
    pmrem.dispose();
    sky.geometry.dispose();
    (sky.material as THREE.Material).dispose();

    const key = new THREE.DirectionalLight("#ffe9cc", 2.4);
    key.position.set(-1.4, 2.6, 3.2);
    const rim = new THREE.DirectionalLight("#b9d4ff", 1.7);
    rim.position.set(2.2, 1.6, -3);
    const fill = new THREE.HemisphereLight("#d5e3f5", "#a07f57", 0.5);
    this.scene.add(key, rim, fill);

    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(1, 32),
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        vertexShader: "varying vec2 vP; void main(){ vP = position.xy; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }",
        fragmentShader: "varying vec2 vP; void main(){ float r = length(vP); float a = pow(max(0.0,1.0-r),1.6)*0.42; gl_FragColor = vec4(0.05,0.03,0.06,a); }",
      }),
    );
    disc.rotation.x = -Math.PI / 2;
    disc.position.y = 0.01;
    disc.scale.set(1.2, 0.95, 1);
    this.scene.add(disc);
    this.shadowDisc = disc;
  }

  /** Renders the current scene into the top-left corner of the GL canvas. */
  render(width: number, height: number, target: CanvasRenderingContext2D, clear = true) {
    this.draw(this.scene, this.camera, width, height);
    if (clear) target.clearRect(0, 0, target.canvas.width, target.canvas.height);
    target.drawImage(this.canvas, 0, 0, width, height, 0, 0, target.canvas.width, target.canvas.height);
  }

  /** Draws a scene into the top-left corner; read it back before returning to the event loop. */
  draw(scene: THREE.Scene, camera: THREE.PerspectiveCamera, width: number, height: number) {
    if (width > this.width || height > this.height) {
      this.width = Math.max(this.width, width);
      this.height = Math.max(this.height, height);
      this.renderer.setSize(this.width, this.height, false);
    }
    const viewportY = this.height - height;
    this.renderer.setViewport(0, viewportY, width, height);
    this.renderer.setScissor(0, viewportY, width, height);
    this.renderer.setScissorTest(true);
    this.renderer.clear();
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    this.renderer.render(scene, camera);
  }

  private foodStage: FoodStage | null = null;

  get food(): FoodStage {
    if (!this.foodStage) this.foodStage = new FoodStage(this.renderer);
    return this.foodStage;
  }

  showShadow(on: boolean, scale = 1) {
    this.shadowDisc.visible = on;
    this.shadowDisc.scale.set(1.25 * scale, 0.95 * scale, 1);
  }
}

/**
 * A small photo studio for food: softbox reflections, a warm key light with a
 * soft shadow on an invisible table, a cool rim light and a contact shadow.
 */
class FoodStage {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(20, 1, 0.05, 40);
  readonly key: THREE.DirectionalLight;
  private lights: [THREE.Light, number][] = [];
  private contact: THREE.Mesh;
  private halos: THREE.Mesh[] = [];
  private haloGeometry = new THREE.PlaneGeometry(1, 1);
  /** Where the key light sits relative to the model: high and to the left, like a big softbox. */
  private keyOffset = new THREE.Vector3(-1.9, 4.2, 1.9);

  constructor(renderer: THREE.WebGLRenderer) {
    this.scene.environment = studioEnvironment(renderer);
    this.scene.environmentIntensity = 0.85;
    const key = new THREE.DirectionalLight("#fff0dc", 2.25);
    key.castShadow = true;
    // A small, heavily blurred shadow map gives the wide penumbra of a softbox.
    key.shadow.mapSize.set(512, 512);
    key.shadow.radius = 12;
    key.shadow.blurSamples = 24;
    key.shadow.bias = -0.0006;
    key.shadow.normalBias = 0.015;
    const shadowCamera = key.shadow.camera;
    shadowCamera.near = 0.5;
    shadowCamera.far = 14;
    this.key = key;
    const rim = new THREE.DirectionalLight("#e4ecff", 1.8);
    rim.position.set(2.8, 2.4, -2.6);
    const kicker = new THREE.DirectionalLight("#ffe2c4", 0.4);
    kicker.position.set(2.4, 0.7, 2.8);
    const fill = new THREE.HemisphereLight("#f3efe9", "#6c5844", 0.45);
    this.scene.add(key, key.target, rim, kicker, fill);
    this.lights = [[key, key.intensity], [rim, rim.intensity], [kicker, kicker.intensity], [fill, fill.intensity]];

    const ground = new THREE.Mesh(new THREE.PlaneGeometry(12, 12), new THREE.ShadowMaterial({ color: "#2b1d12", opacity: 0.2 }));
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.scene.add(ground);
    this.contact = new THREE.Mesh(
      new THREE.CircleGeometry(1, 40),
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        vertexShader: "varying vec2 vP; void main(){ vP = position.xy; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }",
        fragmentShader: "varying vec2 vP; void main(){ float r = length(vP); float a = pow(max(0.0, 1.0 - r), 2.2) * 0.36; gl_FragColor = vec4(0.09, 0.06, 0.04, a); }",
      }),
    );
    this.contact.rotation.x = -Math.PI / 2;
    this.contact.position.y = 0.002;
    this.scene.add(this.contact);
  }

  private haloMaterials = new Map<string, THREE.ShaderMaterial>();

  /** Halo materials are kept, so their small program stays compiled. */
  private haloMaterial(color: THREE.ColorRepresentation, strength: number) {
    const key = `${String(color)}|${strength}`;
    const cached = this.haloMaterials.get(key);
    if (cached) return cached;
    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      premultipliedAlpha: true,
      uniforms: { uColor: { value: new THREE.Color(color) }, uStrength: { value: strength } },
      vertexShader: "varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }",
      fragmentShader: `varying vec2 vUv; uniform vec3 uColor; uniform float uStrength;
        void main(){ float r = length(vUv - 0.5) * 2.0; float a = pow(max(0.0, 1.0 - r), 2.4) * uStrength;
          gl_FragColor = vec4(uColor * a, a); }`,
    });
    this.haloMaterials.set(key, material);
    return material;
  }

  /** Frames the model and renders it into the studio's GL canvas at `size` pixels. */
  shoot(studio: Studio, model: FoodModel, size: number) {
    const group = model.group;
    group.position.set(0, 0, 0);
    group.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(group);
    group.position.set(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2);
    group.updateMatrixWorld(true);
    box.setFromObject(group);
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    this.scene.add(group);

    // Frame by the silhouette as the camera sees it, not a bounding sphere, so
    // long or flat foods still fill the picture.
    const camera = this.camera;
    const dir = new THREE.Vector3(Math.sin(model.azimuth) * Math.cos(model.elevation), Math.sin(model.elevation), Math.cos(model.azimuth) * Math.cos(model.elevation));
    const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), dir).normalize();
    const up = new THREE.Vector3().crossVectors(dir, right).normalize();
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    let nearest = -Infinity;
    const p = new THREE.Vector3();
    const shadowPoint = new THREE.Vector3();
    const toLight = this.keyOffset.clone().normalize();
    group.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      const position = mesh.geometry.attributes.position as THREE.BufferAttribute;
      const step = Math.max(1, Math.floor(position.count / 6000));
      for (let i = 0; i < position.count; i += step) {
        p.fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld);
        // Where this point's shadow falls; keep most of the shadow in frame.
        shadowPoint.copy(p).addScaledVector(toLight, -(p.y / toLight.y) * 0.75).setY(0).sub(sphere.center);
        p.sub(sphere.center);
        const x = p.dot(right);
        const y = p.dot(up);
        x0 = Math.min(x0, x, shadowPoint.dot(right));
        x1 = Math.max(x1, x, shadowPoint.dot(right));
        y0 = Math.min(y0, y, shadowPoint.dot(up));
        y1 = Math.max(y1, y);
        nearest = Math.max(nearest, p.dot(dir));
      }
    });
    // Leave a little room under the food for its shadow.
    y0 -= (y1 - y0) * 0.04;
    const fov = THREE.MathUtils.degToRad(camera.fov);
    const extent = Math.max(x1 - x0, y1 - y0) / 2;
    const target = sphere.center.clone().addScaledVector(right, (x0 + x1) / 2).addScaledVector(up, (y0 + y1) / 2);
    const distance = extent / Math.tan(fov / 2) / model.fill + nearest * 0.6;
    camera.position.copy(target).addScaledVector(dir, distance);
    camera.near = Math.max(0.05, distance - sphere.radius * 3);
    camera.far = distance + sphere.radius * 4;
    camera.lookAt(target);
    camera.updateMatrixWorld();

    for (const [light, intensity] of this.lights) light.intensity = intensity * (light === this.lights[3][0] ? Math.sqrt(model.light) : model.light);
    this.scene.environmentIntensity = 0.85 * model.light;

    // Keep the key light's direction, aimed at the model.
    this.key.target.position.copy(sphere.center);
    this.key.position.copy(sphere.center).add(this.keyOffset);
    this.key.target.updateMatrixWorld();
    this.key.updateMatrixWorld();
    const shadowCamera = this.key.shadow.camera;
    const reach = sphere.radius * 2.6;
    shadowCamera.left = shadowCamera.bottom = -reach;
    shadowCamera.right = shadowCamera.top = reach;
    shadowCamera.updateProjectionMatrix();
    this.key.shadow.needsUpdate = true;
    produceKeyView.value.copy(this.keyOffset).normalize().transformDirection(camera.matrixWorldInverse);

    const footprint = box.getSize(new THREE.Vector3());
    this.contact.position.set(sphere.center.x, 0.002, sphere.center.z);
    this.contact.scale.set(footprint.x * 0.5, footprint.z * 0.5, 1);

    for (const halo of model.halos) {
      const mesh = new THREE.Mesh(this.haloGeometry, this.haloMaterial(halo.color, halo.strength));
      const at = halo.position.clone().applyMatrix4(group.matrixWorld);
      mesh.position.copy(at).addScaledVector(dir, -sphere.radius * 0.6);
      mesh.quaternion.copy(camera.quaternion);
      mesh.scale.setScalar(halo.size * 2);
      mesh.renderOrder = -1;
      this.scene.add(mesh);
      this.halos.push(mesh);
    }

    const renderer = studio.renderer;
    const toneMapping = renderer.toneMapping;
    const exposure = renderer.toneMappingExposure;
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.toneMappingExposure = 1.0;
    studio.draw(this.scene, camera, size, size);
    renderer.toneMapping = toneMapping;
    renderer.toneMappingExposure = exposure;

    this.scene.remove(group);
    for (const halo of this.halos) {
      this.scene.remove(halo);
    }
    this.halos = [];
  }
}

/** A studio of softboxes for glossy reflections, baked once into a PMREM. */
function studioEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
  const scene = new THREE.Scene();
  const disposables: { dispose(): void }[] = [];
  const room = new THREE.Mesh(
    new THREE.SphereGeometry(10, 32, 16),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      vertexShader: "varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }",
      fragmentShader: `varying vec3 vP;
        void main(){ float h = normalize(vP).y;
          vec3 c = mix(vec3(0.11, 0.09, 0.075), vec3(0.32, 0.31, 0.3), smoothstep(-0.25, 0.25, h));
          c = mix(c, vec3(0.62, 0.62, 0.62), smoothstep(0.35, 1.0, h));
          gl_FragColor = vec4(c, 1.0); }`,
    }),
  );
  scene.add(room);
  disposables.push(room.geometry, room.material as THREE.Material);
  const box = (w: number, h: number, intensity: number, color: string, x: number, y: number, z: number) => {
    const geometry = new THREE.PlaneGeometry(w, h);
    const material = new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(intensity), side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    mesh.lookAt(0, 0, 0);
    scene.add(mesh);
    disposables.push(geometry, material);
  };
  box(5.5, 3.6, 6.5, "#fff2e4", -4.2, 6.2, 4);
  box(1.3, 6.5, 5, "#e6eeff", 5.6, 3.2, -4.2);
  box(7, 7, 1.6, "#ffffff", 0, 9.5, 0);
  box(4.2, 1.8, 1.4, "#ffe6cc", 3.5, 1.2, 6.5);
  // A wide softbox behind and above, for the wet sheen on cut fruit and honey.
  box(7, 2.6, 2.6, "#fff6ea", 0, 5.2, -7.5);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const target = pmrem.fromScene(scene, 0.015);
  pmrem.dispose();
  for (const item of disposables) item.dispose();
  return target.texture;
}

let studio: Studio | null | undefined;

export function getStudio(): Studio | null {
  if (studio === undefined) {
    try {
      studio = new Studio();
    } catch (error) {
      console.warn("3D portraits are unavailable", error);
      studio = null;
    }
  }
  return studio;
}

function deviceRatio() {
  return Math.min(devicePixelRatio || 1, 2);
}

function makeCanvas(size: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; pixels: number } {
  const pixels = Math.round(size * deviceRatio());
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = pixels;
  canvas.style.width = `${size}px`;
  canvas.style.height = `${size}px`;
  return { canvas, ctx: canvas.getContext("2d")!, pixels };
}

/** Cached rendered images, copied onto a fresh canvas for each caller. */
const imageCache = new Map<string, HTMLCanvasElement>();
const CACHE_LIMIT = 220;

function cacheSet(key: string, image: HTMLCanvasElement) {
  imageCache.set(key, image);
  if (imageCache.size > CACHE_LIMIT) {
    const oldest = imageCache.keys().next().value;
    if (oldest !== undefined) imageCache.delete(oldest);
  }
}

function fromCache(key: string, size: number): HTMLCanvasElement | null {
  const image = imageCache.get(key);
  if (!image) return null;
  // Refresh recency.
  imageCache.delete(key);
  imageCache.set(key, image);
  const { canvas, ctx } = makeCanvas(size);
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas;
}

export interface PortraitOptions {
  size: number;
  level: number;
  generation: number;
}

function setKinCamera(camera: THREE.PerspectiveCamera, scale: number, angle: number, closeness: number) {
  const distance = (6.9 / closeness) * Math.max(0.74, scale);
  camera.position.set(Math.sin(angle) * distance, 1.5 + distance * 0.11, Math.cos(angle) * distance);
  camera.lookAt(0, 0.95 * scale, 0);
}

export function kinPortrait(look: Look, options: PortraitOptions): HTMLCanvasElement | null {
  const s = getStudio();
  if (!s) return null;
  const pixels = Math.round(options.size * deviceRatio());
  const key = `kin:${look.head}:${look.horn}:${look.wing}:${look.tail}:${look.pattern}:${look.eyes}:${look.main}:${look.accent}:${look.shiny ? 1 : 0}:${look.seed}:${Math.min(16, options.generation)}:${Math.round(kinSize(options.level) * 100)}:${pixels}`;
  const hit = fromCache(key, options.size);
  if (hit) return hit;

  const detail = options.size >= 140 ? "high" : "low";
  const kin = buildKin(look, { level: options.level, generation: options.generation, detail });
  // Settle into a calm pose looking at the camera.
  const angle = 0.68;
  kin.look(new THREE.Vector3(Math.sin(angle), 0.08, Math.cos(angle)));
  for (let i = 0; i < 25; i++) kin.update(0.05, IDLE_POSE);
  const size = kinSize(options.level);
  s.scene.add(kin.group);
  s.showShadow(true, size);
  setKinCamera(s.camera, size, angle, 1.05);

  const image = document.createElement("canvas");
  image.width = image.height = pixels;
  const imageCtx = image.getContext("2d")!;
  s.render(pixels, pixels, imageCtx);
  s.scene.remove(kin.group);
  kin.dispose();
  cacheSet(key, image);
  const { canvas, ctx } = makeCanvas(options.size);
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas;
}

export function eggPortrait(a: string, b: string, seed: number, size: number): HTMLCanvasElement | null {
  const s = getStudio();
  if (!s) return null;
  const pixels = Math.round(size * deviceRatio());
  const key = `egg:${a}:${b}:${seed}:${pixels}`;
  const hit = fromCache(key, size);
  if (hit) return hit;
  const geometry = new THREE.InstancedBufferGeometry();
  const base = eggGeometry();
  geometry.setAttribute("position", base.attributes.position);
  geometry.setAttribute("normal", base.attributes.normal);
  geometry.setAttribute("uv", base.attributes.uv);
  geometry.setIndex(base.index);
  const colorA = new THREE.Color(a);
  const colorB = new THREE.Color(b);
  geometry.setAttribute("aColorA", new THREE.InstancedBufferAttribute(new Float32Array([colorA.r, colorA.g, colorA.b]), 3));
  geometry.setAttribute("aColorB", new THREE.InstancedBufferAttribute(new Float32Array([colorB.r, colorB.g, colorB.b]), 3));
  geometry.setAttribute("aEggState", new THREE.InstancedBufferAttribute(new Float32Array([(seed % 97) / 97, 0, 0, 0]), 4));
  geometry.instanceCount = 1;
  const material = makeEggMaterial();
  const mesh = new THREE.InstancedMesh(geometry, material, 1);
  mesh.setMatrixAt(0, new THREE.Matrix4());
  mesh.frustumCulled = false;
  s.scene.add(mesh);
  s.showShadow(true, 0.75);
  s.camera.position.set(1.4, 1.45, 3.8);
  s.camera.lookAt(0, 0.72, 0);
  const image = document.createElement("canvas");
  image.width = image.height = pixels;
  s.render(pixels, pixels, image.getContext("2d")!);
  s.scene.remove(mesh);
  mesh.dispose();
  material.dispose();
  cacheSet(key, image);
  const { canvas, ctx } = makeCanvas(size);
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/** Food models stay built for a little while, so the same icon at another size is quick. */
const foodModels = new Map<number, FoodModel>();
let foodModelsTimer = 0;

function foodModelFor(item: number): FoodModel | null {
  let model = foodModels.get(item);
  if (!model) {
    const built = foodModel(item);
    if (!built) return null;
    model = built;
    foodModels.set(item, model);
  }
  clearTimeout(foodModelsTimer);
  foodModelsTimer = window.setTimeout(() => {
    for (const m of foodModels.values()) m.dispose();
    foodModels.clear();
  }, 9000);
  return model;
}

/** Shrinks a supersampled render in halving steps, which keeps fine detail clean. */
function downsample(source: HTMLCanvasElement, sourceSize: number, target: HTMLCanvasElement) {
  let from: CanvasImageSource = source;
  let size = sourceSize;
  while (size / 2 >= target.width * 1.01) {
    const half = Math.round(size / 2);
    const step = document.createElement("canvas");
    step.width = step.height = half;
    const ctx = step.getContext("2d")!;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(from, 0, 0, size, size, 0, 0, half, half);
    from = step;
    size = half;
  }
  const ctx = target.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  ctx.clearRect(0, 0, target.width, target.height);
  ctx.drawImage(from, 0, 0, size, size, 0, 0, target.width, target.height);
}

/** Icons up to this many pixels are cut down from one render per food. */
const FOOD_CANON = 128;
/** One supersampled render per food, kept for the session (12 x 64 KB). */
const foodCanon = new Map<number, HTMLCanvasElement>();
const FOOD_ITEMS = 12;

/** Renders a food at `pixels`, supersampled, into a new canvas. */
function shootFood(s: Studio, item: number, pixels: number): HTMLCanvasElement | null {
  const model = foodModelFor(item);
  if (!model) return null;
  // Supersample, more for the small icons where fine detail would shimmer.
  const factor = pixels <= 72 ? 4 : pixels <= 180 ? 3 : 2;
  const render = Math.min(1400, pixels * factor);
  s.food.shoot(s, model, render);
  // Copy out of the GL canvas straight away, before the frame is presented.
  const grab = document.createElement("canvas");
  grab.width = grab.height = render;
  grab.getContext("2d")!.drawImage(s.canvas, 0, 0, render, render, 0, 0, render, render);
  const image = document.createElement("canvas");
  image.width = image.height = pixels;
  downsample(grab, render, image);
  return image;
}

function canonFor(s: Studio, item: number): HTMLCanvasElement | null {
  let canon = foodCanon.get(item);
  if (!canon) {
    const shot = shootFood(s, item, FOOD_CANON);
    if (!shot) return null;
    canon = shot;
    foodCanon.set(item, canon);
  }
  return canon;
}

let foodWarmup: "idle" | "scheduled" | "done" = "idle";

/**
 * After the first food icon, the rest are prepared in the background: their
 * shader programs compile in parallel (off the main thread where the browser
 * allows it) and each food is shot once, so opening the market or the bag
 * later costs only a copy.
 */
function scheduleFoodWarmup(s: Studio) {
  if (foodWarmup !== "idle") return;
  foodWarmup = "scheduled";
  const idle = (work: () => void) => {
    const ric = (window as unknown as { requestIdleCallback?: (fn: () => void, o?: { timeout: number }) => void }).requestIdleCallback;
    if (ric) ric(work, { timeout: 2000 });
    else setTimeout(work, 50);
  };
  const queue = Array.from({ length: FOOD_ITEMS }, (_, i) => i).filter((item) => !foodCanon.has(item));
  const next = () => {
    const item = queue.shift();
    if (item === undefined) {
      foodWarmup = "done";
      return;
    }
    if (foodCanon.has(item)) {
      idle(next);
      return;
    }
    const model = foodModelFor(item);
    if (!model) {
      idle(next);
      return;
    }
    s.food.scene.add(model.group);
    // Programs depend on the tone mapping, so compile with the one the shot uses.
    const toneMapping = s.renderer.toneMapping;
    s.renderer.toneMapping = THREE.NeutralToneMapping;
    const ready = s.renderer.compileAsync(s.food.scene, s.food.camera);
    s.renderer.toneMapping = toneMapping;
    ready
      .catch(() => undefined)
      .then(() => {
        s.food.scene.remove(model.group);
        idle(() => {
          canonFor(s, item);
          idle(next);
        });
      });
  };
  setTimeout(() => idle(next), 2500);
}

/** Every food in the game as a studio product shot: items 0 to 11. */
export function itemPortrait(item: number, size: number): HTMLCanvasElement | null {
  const s = getStudio();
  if (!s) return null;
  const pixels = Math.round(size * deviceRatio());
  const key = `item:${item}:${pixels}`;
  const hit = fromCache(key, size);
  if (hit) return hit;
  let image: HTMLCanvasElement | null;
  if (pixels <= FOOD_CANON) {
    const canon = canonFor(s, item);
    if (!canon) return null;
    image = document.createElement("canvas");
    image.width = image.height = pixels;
    downsample(canon, FOOD_CANON, image);
  } else {
    image = shootFood(s, item, pixels);
    if (!image) return null;
  }
  scheduleFoodWarmup(s);
  cacheSet(key, image);
  const { canvas, ctx } = makeCanvas(size);
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas;
}

export interface KinViewerOptions {
  level?: number;
  generation?: number;
  /** Whether to paint a soft glow behind the creature (default true). */
  backdrop?: boolean;
}

export interface KinViewer {
  stop(): void;
  setJoy(n: number): void;
}

/**
 * An animated turntable view of a Kinling, drawn into the given canvas with
 * the shared renderer. Use it on the hatch-reveal screen.
 */
export function createKinViewer(canvas: HTMLCanvasElement, look: Look, opts: KinViewerOptions = {}): KinViewer {
  const s = getStudio();
  const ctx = canvas.getContext("2d");
  if (!s || !ctx) {
    return { stop() {}, setJoy() {} };
  }
  const kin: Kin3D = buildKin(look, { level: opts.level ?? 6, generation: opts.generation ?? 0, detail: detectQuality() === "low" ? "low" : "high" });
  kin.group.rotation.y = 0;
  const pose = { ...IDLE_POSE };
  let running = true;
  let last = performance.now();
  let t = 0;
  let joy = 0;
  let joyTarget = 0;
  let raf = 0;
  const glow = opts.backdrop === false ? null : new THREE.Mesh(
    new THREE.PlaneGeometry(9, 9),
    new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: { uT: { value: 0 } },
      vertexShader: "varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }",
      fragmentShader: `varying vec2 vUv; uniform float uT;
        void main(){
          float r = length(vUv-0.5)*2.0;
          float a = smoothstep(1.0,0.1,r)*0.9;
          float rays = 0.55+0.45*sin(atan(vUv.y-0.5,vUv.x-0.5)*9.0+uT*0.7);
          vec3 c = mix(vec3(1.0,0.9,0.62), vec3(1.0,0.75,0.45), rays);
          gl_FragColor = vec4(c, a*(0.7+rays*0.3));
        }`,
    }),
  );

  const frame = () => {
    if (!running) return;
    const now = performance.now();
    const dt = Math.max(0, Math.min(0.05, (now - last) / 1000));
    last = now;
    t += dt;
    joy += (joyTarget - joy) * Math.min(1, dt * 6);
    pose.joy = joy;
    kin.update(dt, pose);
    kin.group.rotation.y = 0.55 + Math.sin(t * 0.55) * 0.48;
    windTime.value += dt;
    const pixelsW = canvas.width;
    const pixelsH = canvas.height;
    s.scene.add(kin.group);
    s.showShadow(true, kinSize(opts.level ?? 6));
    if (glow) {
      s.scene.add(glow);
      glow.position.set(0, 1.1, -2.2);
      (glow.material as THREE.ShaderMaterial).uniforms.uT.value = t;
    }
    const closeness = 0.86 * Math.min(1, pixelsW / pixelsH) ** 0.25;
    setKinCamera(s.camera, kinSize(opts.level ?? 6), 0, closeness);
    s.render(pixelsW, pixelsH, ctx);
    s.scene.remove(kin.group);
    if (glow) s.scene.remove(glow);
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);

  return {
    stop() {
      if (!running) return;
      running = false;
      cancelAnimationFrame(raf);
      kin.dispose();
      if (glow) {
        glow.geometry.dispose();
        (glow.material as THREE.Material).dispose();
      }
    },
    setJoy(n: number) {
      joyTarget = n;
    },
  };
}
