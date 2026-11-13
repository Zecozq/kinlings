// The shared look of the valley: a physically based sky (Rayleigh, Mie and
// ozone scattering with the planet's shadow, so sunrise, sunset and twilight
// colours come out of the physics), a lit cloud layer, stars and moon, the sun
// and sky light that the same model predicts, aerial perspective for distant
// things, and the post-processing stack (HDR, restrained bloom, a filmic tone
// curve and gentle colour grading).
//
//   const atmosphere = new Atmosphere(scene, renderer, { quality });
//   atmosphere.setPhase(0.28);        // 0..1, same day logic as the 2D scene
//   atmosphere.update(dt, focusPoint, camera);
//
//   const post = new PostFX(renderer, { quality });
//   post.setSize(w, h);
//   post.render(scene, camera);       // instead of renderer.render
//
// Both the valley and the race course use these, so they look like one world.
// Materials elsewhere pick the sky up through `skyUniforms` and `patchSky`.

import * as THREE from "three";
import { GLSL_NOISE, clamp, cloudNoiseTexture, lerp, smooth, type Quality } from "./gfx.ts";

/** Same logic as the 2D scene: 0 at full day, 1 at deep night. */
export function nightness(phase: number): number {
  if (phase < 0.62) return 0;
  if (phase < 0.72) return (phase - 0.62) / 0.1;
  if (phase < 0.92) return 1;
  return 1 - (phase - 0.92) / 0.08;
}

export const DAY_LENGTH = 600;

export function dayPhase(override: number | null): number {
  if (override !== null) return override;
  return ((Date.now() / 1000) % DAY_LENGTH) / DAY_LENGTH;
}

/** The world's shared detail noise (see cloudNoiseTexture). */
export function sharedNoiseTexture() {
  return cloudNoiseTexture();
}

// ----- The physical atmosphere ---------------------------------------------------
//
// Earth-like constants in metres. The GPU passes and the CPU light colours use
// the same numbers, so the sky you see and the light on the ground agree.

const RG = 6360e3;
const RT = 6460e3;
const VIEW_H = 220;
const RAY = [5.802e-6, 13.558e-6, 33.1e-6];
const MIE_S = 3.996e-6;
const MIE_E = 4.44e-6;
const OZO = [0.65e-6, 1.881e-6, 0.085e-6];
/** Sun irradiance at the top of the atmosphere, in the game's light units. */
const SUN_E = 6.2;
/** Moonlight, tinted blue the way night looks to the eye. */
const MOON_E = 0.85;
const MOON_TINT = [0.62, 0.74, 1.0];

const GLSL_ATMOSPHERE = /* glsl */ `
  #define RG 6360e3
  #define RT 6460e3
  #define PI_A 3.14159265
  const vec3 RAY = vec3(5.802e-6, 13.558e-6, 33.1e-6);
  const float MIE_S = 3.996e-6;
  const float MIE_E = 4.44e-6;
  const vec3 OZO = vec3(0.65e-6, 1.881e-6, 0.085e-6);
  vec3 extinctionAt(float h){
    float r = exp(-h / 8000.0);
    float m = exp(-h / 1200.0);
    float o = max(0.0, 1.0 - abs(h - 25000.0) / 15000.0);
    return RAY * r + vec3(MIE_E * m) + OZO * o;
  }
  float distToTop(float r, float mu){ return -r * mu + sqrt(max(r * r * (mu * mu - 1.0) + RT * RT, 0.0)); }
  float rayleighPhase(float c){ return 3.0 / (16.0 * PI_A) * (1.0 + c * c); }
  float miePhase(float c){
    const float g = 0.8;
    float g2 = g * g;
    return 3.0 / (8.0 * PI_A) * ((1.0 - g2) * (1.0 + c * c)) / ((2.0 + g2) * pow(1.0 + g2 - 2.0 * g * c, 1.5));
  }
`;

const LUT_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

/** Transmittance to space from any height and zenith angle (Bruneton/Hillaire mapping). */
const TRANSMITTANCE_FRAGMENT = /* glsl */ `
  varying vec2 vUv;
  ${GLSL_ATMOSPHERE}
  void main(){
    float H = sqrt(RT * RT - RG * RG);
    float rho = H * vUv.y;
    float r = sqrt(rho * rho + RG * RG);
    float dMin = RT - r;
    float dMax = rho + H;
    float d = dMin + vUv.x * (dMax - dMin);
    float mu = d <= 0.0 ? 1.0 : (H * H - rho * rho - d * d) / (2.0 * r * d);
    mu = clamp(mu, -1.0, 1.0);
    float len = distToTop(r, mu);
    vec3 depth = vec3(0.0);
    const int N = 40;
    for (int i = 0; i < N; i++) {
      float t0 = len * pow(float(i) / float(N), 2.0);
      float t1 = len * pow(float(i + 1) / float(N), 2.0);
      float t = 0.5 * (t0 + t1);
      float h = sqrt(r * r + t * t + 2.0 * r * mu * t) - RG;
      depth += extinctionAt(max(h, 0.0)) * (t1 - t0);
    }
    gl_FragColor = vec4(exp(-depth), 1.0);
  }
`;

/**
 * The sky as seen from the valley floor in every direction, lit by the sun and
 * by the moon, with the planet's shadow and a cheap multiple-scattering term.
 */
const SKYVIEW_FRAGMENT = /* glsl */ `
  varying vec2 vUv;
  uniform sampler2D uTrans;
  uniform vec3 uSunDir, uMoonDir, uSunE, uMoonE;
  uniform float uViewH;
  ${GLSL_ATMOSPHERE}
  vec3 transmittance(float r, float mu){
    float H = sqrt(RT * RT - RG * RG);
    float rho = sqrt(max(r * r - RG * RG, 0.0));
    float d = distToTop(r, mu);
    float dMin = RT - r;
    float dMax = rho + H;
    vec2 uv = vec2((d - dMin) / max(dMax - dMin, 1.0), rho / H);
    // Soft edge at the planet's horizon, about the size of the sun's disc.
    float muH = -sqrt(max(0.0, 1.0 - (RG / r) * (RG / r)));
    return texture2D(uTrans, uv).rgb * smoothstep(muH - 0.006, muH + 0.004, mu);
  }
  void main(){
    float az = (vUv.x - 0.5) * 6.2831853;
    float l = vUv.y * 2.0 - 1.0;
    float el = sign(l) * l * l * 1.5707963;
    vec3 dir = vec3(cos(el) * cos(az), sin(el), cos(el) * sin(az));
    float r0 = RG + uViewH;
    float mu = dir.y;
    // Where the ray leaves the atmosphere or meets the ground.
    float tTop = distToTop(r0, mu);
    float disc = r0 * r0 * (mu * mu - 1.0) + RG * RG;
    bool ground = mu < 0.0 && disc > 0.0;
    float tMax = ground ? (-r0 * mu - sqrt(disc)) : tTop;
    tMax = min(tMax, 420e3);
    float cS = dot(dir, uSunDir);
    float cM = dot(dir, uMoonDir);
    float prS = rayleighPhase(cS), pmS = miePhase(cS);
    float prM = rayleighPhase(cM), pmM = miePhase(cM);
    vec3 L = vec3(0.0);
    vec3 T = vec3(1.0);
    const int N = 30;
    for (int i = 0; i < N; i++) {
      float t0 = tMax * pow(float(i) / float(N), 2.0);
      float t1 = tMax * pow(float(i + 1) / float(N), 2.0);
      float dt = t1 - t0;
      float t = 0.5 * (t0 + t1);
      vec3 p = vec3(0.0, r0, 0.0) + dir * t;
      float r = length(p);
      float h = max(r - RG, 0.0);
      vec3 up = p / r;
      float muS = dot(up, uSunDir);
      float muM = dot(up, uMoonDir);
      vec3 tS = transmittance(r, muS);
      vec3 tM = transmittance(r, muM);
      vec3 sR = RAY * exp(-h / 8000.0);
      float sM = MIE_S * exp(-h / 1200.0);
      vec3 ext = extinctionAt(h);
      // Multiple scattering, folded into an isotropic term that fades with the
      // sun's height at this point (it keeps twilight blue rather than black).
      vec3 ms = (sR + vec3(sM)) * 0.085 * (uSunE * smoothstep(-0.28, 0.32, muS) + uMoonE * smoothstep(-0.28, 0.32, muM)) * (0.35 + 0.65 * T);
      vec3 S = uSunE * tS * (sR * prS + sM * pmS) + uMoonE * tM * (sR * prM + sM * pmM) + ms;
      vec3 stepT = exp(-ext * dt);
      L += T * (S - S * stepT) / ext;
      T *= stepT;
    }
    if (ground) {
      // Light bounced off distant land: a soft, hazy green-brown.
      vec3 p = vec3(0.0, r0, 0.0) + dir * tMax;
      vec3 up = normalize(p);
      float muS = dot(up, uSunDir);
      float muM = dot(up, uMoonDir);
      vec3 albedo = vec3(0.08, 0.1, 0.06);
      L += T * albedo / PI_A * (uSunE * transmittance(RG + 1.0, muS) * max(muS, 0.0) + uMoonE * transmittance(RG + 1.0, muM) * max(muM, 0.0));
    }
    gl_FragColor = vec4(L, 1.0);
  }
`;

// The same model on the CPU, for the colour of the sunlight and the sky light.

const extTmp = [0, 0, 0];
function extinctionJS(h: number) {
  const r = Math.exp(-h / 8000);
  const m = Math.exp(-h / 1200);
  const o = Math.max(0, 1 - Math.abs(h - 25000) / 15000);
  extTmp[0] = RAY[0] * r + MIE_E * m + OZO[0] * o;
  extTmp[1] = RAY[1] * r + MIE_E * m + OZO[1] * o;
  extTmp[2] = RAY[2] * r + MIE_E * m + OZO[2] * o;
  return extTmp;
}

function distToTopJS(r: number, mu: number) {
  return -r * mu + Math.sqrt(Math.max(0, r * r * (mu * mu - 1) + RT * RT));
}

/** Transmittance from height h along zenith cosine mu, softly cut by the horizon. */
function transmittanceJS(h: number, mu: number, out: number[], steps = 24) {
  const r = RG + h;
  const muH = -Math.sqrt(Math.max(0, 1 - (RG / r) * (RG / r)));
  const visible = smooth(muH - 0.006, muH + 0.004, mu);
  if (visible <= 0) {
    out[0] = out[1] = out[2] = 0;
    return out;
  }
  const length = distToTopJS(r, Math.max(mu, muH));
  let d0 = 0;
  let d1 = 0;
  let d2 = 0;
  for (let i = 0; i < steps; i++) {
    const t0 = length * (i / steps) ** 2;
    const t1 = length * ((i + 1) / steps) ** 2;
    const t = 0.5 * (t0 + t1);
    const hh = Math.max(0, Math.sqrt(r * r + t * t + 2 * r * Math.max(mu, muH) * t) - RG);
    const e = extinctionJS(hh);
    d0 += e[0] * (t1 - t0);
    d1 += e[1] * (t1 - t0);
    d2 += e[2] * (t1 - t0);
  }
  out[0] = Math.exp(-d0) * visible;
  out[1] = Math.exp(-d1) * visible;
  out[2] = Math.exp(-d2) * visible;
  return out;
}

function rayleighPhaseJS(c: number) {
  return (3 / (16 * Math.PI)) * (1 + c * c);
}
function miePhaseJS(c: number) {
  const g = 0.8;
  const g2 = g * g;
  return ((3 / (8 * Math.PI)) * ((1 - g2) * (1 + c * c))) / ((2 + g2) * Math.pow(1 + g2 - 2 * g * c, 1.5));
}

const tmpT = [0, 0, 0];
/** Sky radiance in direction d, lit by a light of colour E from direction s. */
function skyRadianceJS(d: THREE.Vector3, s: THREE.Vector3, E: number[], out: number[]) {
  const r0 = RG + VIEW_H;
  const mu = d.y;
  const tMax = Math.min(distToTopJS(r0, mu), 420e3);
  const c = d.dot(s);
  const pr = rayleighPhaseJS(c);
  const pm = miePhaseJS(c);
  let L0 = 0;
  let L1 = 0;
  let L2 = 0;
  let T0 = 1;
  let T1 = 1;
  let T2 = 1;
  const N = 14;
  for (let i = 0; i < N; i++) {
    const t0 = tMax * (i / N) ** 2;
    const t1 = tMax * ((i + 1) / N) ** 2;
    const dt = t1 - t0;
    const t = 0.5 * (t0 + t1);
    const px = d.x * t;
    const py = r0 + d.y * t;
    const pz = d.z * t;
    const r = Math.hypot(px, py, pz);
    const h = Math.max(0, r - RG);
    const muS = (px * s.x + py * s.y + pz * s.z) / r;
    transmittanceJS(h, muS, tmpT, 10);
    const dr = Math.exp(-h / 8000);
    const sm = MIE_S * Math.exp(-h / 1200);
    const ms = 0.085 * smooth(-0.28, 0.32, muS);
    const e = extinctionJS(h);
    const Ts = [T0, T1, T2];
    const Ls = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      const sr = RAY[k] * dr;
      const S = E[k] * (tmpT[k] * (sr * pr + sm * pm) + (sr + sm) * ms * (0.35 + 0.65 * Ts[k]));
      const st = Math.exp(-e[k] * dt);
      Ls[k] = (Ts[k] * (S - S * st)) / e[k];
      Ts[k] *= st;
    }
    L0 += Ls[0];
    L1 += Ls[1];
    L2 += Ls[2];
    T0 = Ts[0];
    T1 = Ts[1];
    T2 = Ts[2];
  }
  out[0] = L0;
  out[1] = L1;
  out[2] = L2;
  return out;
}

/** Where the sun and moon are. The sun rises on the left and sets on the right. */
function celestial(phase: number, sun: THREE.Vector3, moon: THREE.Vector3) {
  if (phase < 0.68) {
    // Day: the same arc as before, high over the camera at noon and from just
    // ahead in the low light of morning and evening, for long warm shadows.
    const arc = (phase / 0.68) * Math.PI;
    const sunX = -Math.cos(arc);
    const sunY = Math.sin(arc);
    const sunZ = lerp(-0.42, 0.62, sunY);
    sun.set(sunX * 0.92, sunY * 0.82 + 0.02, sunZ).normalize();
  } else {
    // Night: it keeps going below the far horizon, slowly at first so dusk
    // lingers, and comes back up on the left before dawn.
    const s = (phase - 0.68) / 0.32;
    const depression = Math.pow(Math.sin(Math.PI * s), 0.8) * 0.45;
    const swing = s * Math.PI;
    sun.set(Math.cos(swing) * 0.88, -Math.sin(depression) + 0.02 * (1 - Math.sin(Math.PI * s)), -0.42 - Math.sin(swing) * 0.5).normalize();
  }
  moon.set(0.45, 0.72, -0.55).normalize();
}

// ----- Shared sky uniforms and GLSL for every other material -------------------

/**
 * Values every outdoor material can read by reference. The active Atmosphere
 * fills them in just before its scene renders (see Atmosphere.bind), so the
 * valley and the race, which live in different WebGL contexts, never mix.
 */
export const skyUniforms = {
  uSkyLut: { value: null as THREE.Texture | null },
  uSunDirW: { value: new THREE.Vector3(0.3, 0.8, 0.5) },
  uSunColorW: { value: new THREE.Color(5, 4.8, 4.4) },
  uSkyAmb: { value: new THREE.Color(0.6, 0.75, 1.0) },
  uGroundAmb: { value: new THREE.Color(0.25, 0.25, 0.18) },
  /** x: haze density per metre, y: height falloff, z: clear distance, w: extra far haze. */
  uAerial: { value: new THREE.Vector4(0.0016, 0.045, 18, 0) },
  uNight: { value: 0 },
  uSkyTime: { value: 0 },
  uCloudTex: { value: null as THREE.Texture | null },
  uCloudWind: { value: new THREE.Vector4() },
  uCloudCover: { value: 0.5 },
  /** x: cloud shadow strength, y: distance where it starts, z: distance of full effect. */
  uCloudShadow: { value: new THREE.Vector3(0.55, 22, 70) },
};

/** Declarations and helpers: sky radiance by direction, aerial perspective, cloud shadow. */
export const GLSL_SKY = /* glsl */ `
  uniform sampler2D uSkyLut;
  uniform sampler2D uCloudTex;
  uniform vec4 uAerial;
  uniform vec4 uCloudWind;
  uniform float uCloudCover;
  uniform vec3 uCloudShadow;
  uniform vec3 uSunDirW;
  vec2 skyLutUv(vec3 d){
    float az = atan(d.z, d.x);
    float el = asin(clamp(d.y, -1.0, 1.0));
    float l = sign(el) * sqrt(abs(el) / 1.5707963);
    return vec2(az / 6.2831853 + 0.5, 0.5 + 0.5 * l);
  }
  vec3 skyRadiance(vec3 d){ return texture2D(uSkyLut, skyLutUv(d)).rgb; }
  /** Haze between the camera and a point, toFrag = point - camera, in world units. */
  vec3 applyAerial(vec3 col, vec3 toFrag){
    float dist = length(toFrag);
    vec3 dir = toFrag / max(dist, 1e-3);
    float k = uAerial.y;
    float dy = toFrag.y;
    float hf = exp(-k * max(cameraPosition.y, -5.0)) * (abs(dy) > 0.02 ? (1.0 - exp(-k * dy)) / (k * dy) : 1.0);
    float od = uAerial.x * max(dist - uAerial.z, 0.0) * hf + uAerial.w * max(dist - 160.0, 0.0);
    float t = exp(-od);
    vec3 ins = skyRadiance(normalize(vec3(dir.x, max(dir.y, 0.0) * 0.5 + 0.035, dir.z)));
    return col * t + ins * (1.0 - t);
  }
  /** The same cloud field as the sky, projected along the sunlight onto the ground. */
  float cloudCoverAt(vec2 p){
    vec4 a = texture2D(uCloudTex, p * 0.05 + uCloudWind.xy);
    float base = a.r * 0.8 + a.g * 0.2;
    return smoothstep(1.0 - uCloudCover, 1.0 - uCloudCover + 0.3, base);
  }
  float cloudShade(vec3 toFrag){
    float dist = length(toFrag);
    float far = smoothstep(uCloudShadow.y, uCloudShadow.z, dist);
    if (far <= 0.0 || uSunDirW.y <= 0.02) return 1.0;
    vec3 wp = cameraPosition + toFrag;
    vec2 p = (wp.xz + uSunDirW.xz / uSunDirW.y * 1500.0) / 1000.0;
    return 1.0 - cloudCoverAt(p) * uCloudShadow.x * far;
  }
`;

/**
 * Adds the sky to a built-in lit material: fog becomes aerial perspective and
 * the sunlight passes under the same clouds as the sky. Use in onBeforeCompile.
 */
export function patchSky(shader: { uniforms: Record<string, THREE.IUniform>; fragmentShader: string }, options: { cloudShadow?: boolean } = {}) {
  const u = skyUniforms;
  Object.assign(shader.uniforms, {
    uSkyLut: u.uSkyLut,
    uCloudTex: u.uCloudTex,
    uAerial: u.uAerial,
    uCloudWind: u.uCloudWind,
    uCloudCover: u.uCloudCover,
    uCloudShadow: u.uCloudShadow,
    uSunDirW: u.uSunDirW,
  });
  let fragment = shader.fragmentShader
    .replace("#include <common>", `#include <common>\n${GLSL_SKY}`)
    .replace("#include <fog_fragment>", "gl_FragColor.rgb = applyAerial(gl_FragColor.rgb, (-vViewPosition) * mat3(viewMatrix));");
  if (options.cloudShadow !== false) {
    fragment = fragment.replace(
      "#include <lights_fragment_begin>",
      THREE.ShaderChunk.lights_fragment_begin.replace(
        "getDirectionalLightInfo( directionalLight, directLight );",
        "getDirectionalLightInfo( directionalLight, directLight );\n\t\tdirectLight.color *= skyCloudShade;",
      ),
    );
    fragment = fragment.replace("void main() {", "void main() {\n\tfloat skyCloudShade = cloudShade((-vViewPosition) * mat3(viewMatrix));");
  }
  shader.fragmentShader = fragment;
}

// ----- Sky LUT passes ------------------------------------------------------------

class SkyLuts {
  readonly transmittance: THREE.WebGLRenderTarget;
  readonly view: THREE.WebGLRenderTarget;
  private transMat: THREE.ShaderMaterial;
  private viewMat: THREE.ShaderMaterial;
  private quad: THREE.Mesh;
  private quadScene = new THREE.Scene();
  private quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private renderer: THREE.WebGLRenderer;
  private transReady = false;

  constructor(renderer: THREE.WebGLRenderer) {
    this.renderer = renderer;
    const options = { type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false, generateMipmaps: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter };
    this.transmittance = new THREE.WebGLRenderTarget(256, 64, options);
    this.view = new THREE.WebGLRenderTarget(192, 108, options);
    this.view.texture.wrapS = THREE.RepeatWrapping;
    this.view.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.transmittance.texture.wrapS = this.transmittance.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.transMat = new THREE.ShaderMaterial({ vertexShader: LUT_VERTEX, fragmentShader: TRANSMITTANCE_FRAGMENT, depthTest: false, depthWrite: false });
    this.viewMat = new THREE.ShaderMaterial({
      vertexShader: LUT_VERTEX,
      fragmentShader: SKYVIEW_FRAGMENT,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uTrans: { value: this.transmittance.texture },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uMoonDir: { value: new THREE.Vector3(0, 1, 0) },
        uSunE: { value: new THREE.Vector3(SUN_E, SUN_E, SUN_E) },
        uMoonE: { value: new THREE.Vector3() },
        uViewH: { value: VIEW_H },
      },
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.transMat);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);
  }

  private draw(material: THREE.Material, target: THREE.WebGLRenderTarget) {
    const renderer = this.renderer;
    const previous = renderer.getRenderTarget();
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    this.quad.material = material;
    renderer.setRenderTarget(target);
    renderer.render(this.quadScene, this.quadCamera);
    renderer.setRenderTarget(previous);
    renderer.autoClear = autoClear;
  }

  update(sunDir: THREE.Vector3, moonDir: THREE.Vector3, moonE: number[]) {
    if (!this.transReady) {
      this.draw(this.transMat, this.transmittance);
      this.transReady = true;
    }
    const u = this.viewMat.uniforms;
    (u.uSunDir.value as THREE.Vector3).copy(sunDir);
    (u.uMoonDir.value as THREE.Vector3).copy(moonDir);
    (u.uMoonE.value as THREE.Vector3).set(moonE[0], moonE[1], moonE[2]);
    this.draw(this.viewMat, this.view);
  }

  dispose() {
    this.transmittance.dispose();
    this.view.dispose();
    this.transMat.dispose();
    this.viewMat.dispose();
    this.quad.geometry.dispose();
  }
}

// ----- The sky dome ------------------------------------------------------------------

const SKY_VERTEX = /* glsl */ `
  varying vec3 vDir;
  void main(){
    vDir = position;
    vec4 pos = projectionMatrix * mat4(mat3(viewMatrix)) * vec4(position, 1.0);
    // On the far plane, drawn after the opaque world so hidden sky costs nothing.
    gl_Position = pos.xyww;
    gl_Position.z = gl_Position.w * 0.99999;
  }
`;

const SKY_FRAGMENT = /* glsl */ `
  varying vec3 vDir;
  uniform sampler2D uLut;
  uniform sampler2D uNoise;
  uniform vec3 uSunDir, uMoonDir, uLightDir;
  uniform vec3 uSunDisc, uMoonDisc;
  uniform vec3 uCloudLight, uCloudAmb;
  uniform vec4 uWind;
  uniform float uCover, uNight, uTime, uEnvPass;
  #define PI 3.14159265
  ${GLSL_NOISE}
  vec2 skyUv(vec3 d){
    float az = atan(d.z, d.x);
    float el = asin(clamp(d.y, -1.0, 1.0));
    float l = sign(el) * sqrt(abs(el) / 1.5707963);
    return vec2(az / 6.2831853 + 0.5, 0.5 + 0.5 * l);
  }
  float hg(float c, float g){ float g2 = g * g; return (1.0 - g2) / (4.0 * PI * pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5)); }
  float cloudMap(vec2 p){
    vec4 a = texture2D(uNoise, p * 0.05 + uWind.xy);
    float base = a.r * 0.8 + a.g * 0.2;
    float d = smoothstep(1.0 - uCover, 1.0 - uCover + 0.3, base);
    #ifndef SKY_LOW
      vec4 b = texture2D(uNoise, p * 0.21 + uWind.zw);
      float detail = b.g * 0.62 + b.a * 0.38;
      d = d - (1.0 - detail) * 0.5 * (1.0 - d * 0.55);
    #endif
    return clamp(d * 1.35, 0.0, 1.0);
  }
  vec3 stars(vec3 d, float res, float density, float bright){
    vec3 p = d * res;
    vec3 c = floor(p);
    vec3 f = fract(p) - 0.5;
    float h = hash31(c + 17.0);
    if (h < density) return vec3(0.0);
    vec3 o = (hash33(c) - 0.5) * 0.55;
    float r = length(f - o);
    float mag = pow(fract(h * 37.17), 5.0) * bright + 0.18;
    float twinkle = 0.7 + 0.3 * sin(uTime * (1.3 + h * 4.0) + h * 91.0);
    vec3 tint = mix(vec3(0.72, 0.82, 1.0), vec3(1.0, 0.86, 0.68), fract(h * 7.77));
    return tint * mag * twinkle * smoothstep(0.3, 0.0, r);
  }
  void main(){
    vec3 d = normalize(vDir);
    vec3 sky = texture2D(uLut, skyUv(d)).rgb;
    float up = d.y;

    // The sun: a limb-darkened disc that only shows above the horizon.
    float cs = dot(d, uSunDir);
    float x = sqrt(max(0.0, 2.0 * (1.0 - cs))) / 0.0105;
    if (x < 1.2 && uEnvPass < 0.5) {
      float limb = sqrt(max(0.0, 1.0 - min(x, 1.0) * min(x, 1.0)));
      sky += uSunDisc * smoothstep(1.05, 0.95, x) * (0.45 + 0.55 * limb) * smoothstep(-0.012, 0.004, up);
    }

    // Night: stars, the Milky Way and a moon with maria.
    float nightSky = uNight * smoothstep(-0.02, 0.22, up) * clamp(1.0 - dot(sky, vec3(0.3, 0.6, 0.1)) * 18.0, 0.0, 1.0);
    if (nightSky > 0.001 && uEnvPass < 0.5) {
      vec3 starLight = stars(d, 150.0, 0.982, 2.4) + stars(d, 58.0, 0.986, 5.0);
      vec3 mwAxis = normalize(vec3(-0.35, 0.55, 0.75));
      float band = exp(-pow(dot(d, mwAxis) * 3.4, 2.0));
      float dust = texture2D(uNoise, vec2(atan(d.z, d.x) * 0.9, d.y * 1.4)).r;
      float clumps = texture2D(uNoise, d.xz * 1.7 + 0.3).g;
      vec3 milky = vec3(0.45, 0.5, 0.72) * band * smoothstep(0.25, 0.75, dust) * (0.4 + clumps * 0.8) * 0.035;
      sky += (starLight * 0.06 + milky) * nightSky;
    }
    float cm = dot(d, uMoonDir);
    float mx = sqrt(max(0.0, 2.0 * (1.0 - cm))) / 0.016;
    if (mx < 1.0 && uNight > 0.01) {
      vec3 axisA = normalize(cross(uMoonDir, vec3(0.0, 1.0, 0.0)));
      vec3 axisB = cross(axisA, uMoonDir);
      vec2 q = vec2(dot(d - uMoonDir, axisA), dot(d - uMoonDir, axisB)) / 0.016;
      float maria = texture2D(uNoise, q * 0.35 + 0.61).r;
      float crater = texture2D(uNoise, q * 0.9 + 0.17).a;
      vec3 n = vec3(q, sqrt(max(0.0, 1.0 - dot(q, q))));
      float lit = smoothstep(-0.25, 0.2, dot(n, normalize(vec3(0.55, 0.35, 0.75))));
      float albedo = mix(1.0, 0.62, smoothstep(0.45, 0.7, maria)) * (0.85 + crater * 0.25);
      sky = mix(sky, uMoonDisc * albedo * lit + sky * 0.4, smoothstep(1.0, 0.94, mx) * uNight);
    }

    // Clouds: a lit layer on a curved sky, self-shadowed towards the light.
    if (up > 0.0) {
      float R = 6360.2;
      float b = R * up;
      float t = -b + sqrt(b * b + 2.0 * R * 1.6 + 2.56);
      vec2 p = d.xz * t;
      float dens = cloudMap(p);
      if (dens > 0.002) {
        vec2 ld = uLightDir.xz;
        float ll = length(ld);
        vec2 dirL = ll > 1e-3 ? ld / ll : vec2(0.0);
        float reach = 0.35 + 0.9 * (1.0 - clamp(uLightDir.y, 0.0, 1.0));
        float s1 = cloudMap(p + dirL * reach * 0.45);
        #ifndef SKY_LOW
          float s2 = cloudMap(p + dirL * reach * 1.25);
        #else
          float s2 = s1;
        #endif
        // Bases are lit by light that came through the cloud; near the horizon we
        // see flanks, lit from the sunward side. Multiple scattering keeps both bright.
        float through = exp(-dens * 2.6);
        float sunward = exp(-(s1 * 1.2 + s2 * 0.7));
        float flank = 1.0 - smoothstep(0.03, 0.4, up);
        float lightAmt = mix(mix(0.22, 1.0, through), mix(0.3, 1.0, sunward), max(flank, 0.35));
        float cosT = dot(d, uLightDir);
        float forward = hg(cosT, 0.6) * 4.0 * PI;
        float thin = 1.0 - smoothstep(0.0, 0.55, dens);
        vec3 lit = uCloudLight * (lightAmt * 1.15 + thin * max(forward - 1.0, 0.0) * 0.35);
        vec3 amb = uCloudAmb * mix(1.45, 0.95, dens);
        vec3 col = lit + amb;
        float far = smoothstep(18.0, 125.0, t);
        col = mix(col, sky, far * 0.8);
        float alpha = (1.0 - exp(-dens * 4.6)) * (1.0 - far * 0.55) * smoothstep(0.0, 0.035, up);
        sky = mix(sky, col, alpha);
      }
      #ifndef SKY_LOW
        // High cirrus streaks.
        float t2 = -b + sqrt(b * b + 2.0 * R * 8.5 + 72.25);
        vec2 q2 = d.xz * t2 * 0.012 + uWind.xy * 0.6;
        float ci = texture2D(uNoise, vec2(q2.x * 0.55, q2.y * 2.4)).b * texture2D(uNoise, q2 * 1.7).r;
        ci = smoothstep(0.32, 0.6, ci) * 0.4 * smoothstep(0.02, 0.2, up);
        vec3 cc = uCloudLight * 0.32 * (hg(dot(d, uLightDir), 0.7) * 4.0 * PI * 0.5 + 0.5) + uCloudAmb * 1.1;
        sky = mix(sky, cc, ci * (1.0 - smoothstep(60.0, 300.0, t2)));
      #endif
    }
    gl_FragColor = vec4(max(sky, vec3(0.0)), 1.0);
  }
`;

export interface AtmosphereOptions {
  quality: Quality;
  shadows?: boolean;
  /** Half-width of the area around the focus point that casts shadows. */
  shadowRange?: number;
  /** How far the camera can see, for matching the fog. */
  far?: number;
  /** Cloud cover 0..1 (about 0.45 is fair-weather cumulus). */
  clouds?: number;
}

const tmpA = [0, 0, 0];
const tmpB = [0, 0, 0];
const tmpDir = new THREE.Vector3();

export class Atmosphere {
  readonly scene: THREE.Scene;
  readonly renderer: THREE.WebGLRenderer;
  readonly quality: Quality;
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  readonly sky: THREE.Mesh;
  /** Where the sun is (it can be below the horizon at night). */
  readonly sunDir = new THREE.Vector3(0.4, 0.7, 0.5).normalize();
  readonly moonDir = new THREE.Vector3(0.45, 0.72, -0.55).normalize();
  /** The direction the key light (sun by day, moon by night) shines from. */
  readonly lightDir = new THREE.Vector3(0.4, 0.7, 0.5).normalize();
  /** Linear colours of the sky straight up and at the horizon, for simple shaders. */
  readonly zenithColor = new THREE.Color();
  readonly horizonColor = new THREE.Color();
  /** Suggested exposure and grade, read by PostFX. */
  exposure = 1;
  warmth = 0;
  night = 0;
  phase = 0.3;
  time = 0;
  private skyMaterial: THREE.ShaderMaterial;
  private luts: SkyLuts;
  private shadowRange: number;
  private pmrem: THREE.PMREMGenerator | null = null;
  private envScene: THREE.Scene | null = null;
  private envTarget: THREE.WebGLRenderTarget | null = null;
  private envSky: THREE.Mesh | null = null;
  private envPhase = -1;
  private fogFar: number;
  private sunIrr = new THREE.Color();
  private skyIrr = new THREE.Color();
  private groundIrr = new THREE.Color();
  private wind = new THREE.Vector2(0.013, 0.004);

  constructor(scene: THREE.Scene, renderer: THREE.WebGLRenderer, options: AtmosphereOptions) {
    this.scene = scene;
    this.renderer = renderer;
    this.quality = options.quality;
    this.shadowRange = options.shadowRange ?? 16;
    this.fogFar = options.far ?? 240;
    this.luts = new SkyLuts(renderer);
    scene.userData.atmosphere = this;

    this.skyMaterial = new THREE.ShaderMaterial({
      vertexShader: SKY_VERTEX,
      fragmentShader: SKY_FRAGMENT,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: true,
      defines: options.quality === "low" ? { SKY_LOW: 1 } : {},
      uniforms: {
        uLut: { value: this.luts.view.texture },
        uNoise: { value: cloudNoiseTexture() },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uMoonDir: { value: this.moonDir.clone() },
        uLightDir: { value: new THREE.Vector3(0, 1, 0) },
        uSunDisc: { value: new THREE.Color() },
        uMoonDisc: { value: new THREE.Color() },
        uCloudLight: { value: new THREE.Color() },
        uCloudAmb: { value: new THREE.Color() },
        uWind: { value: new THREE.Vector4() },
        uCover: { value: options.clouds ?? 0.47 },
        uNight: { value: 0 },
        uTime: { value: 0 },
        uEnvPass: { value: 0 },
        // Kept for older readers: representative sky colours.
        uTop: { value: this.zenithColor },
        uHorizon: { value: this.horizonColor },
      },
    });
    const dome = new THREE.SphereGeometry(10, 32, 16);
    this.sky = new THREE.Mesh(dome, this.skyMaterial);
    this.sky.frustumCulled = false;
    this.sky.renderOrder = 10000;
    scene.add(this.sky);

    this.sun = new THREE.DirectionalLight(0xffffff, 3);
    this.sun.position.set(10, 20, 8);
    this.sun.target.position.set(0, 0, 0);
    scene.add(this.sun, this.sun.target);
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x808080, 1);
    scene.add(this.hemi);

    const castShadows = options.shadows !== false && options.quality !== "low";
    this.sun.castShadow = castShadows;
    if (castShadows) {
      const size = options.quality === "high" ? 2048 : 1024;
      this.sun.shadow.mapSize.set(size, size);
      this.sun.shadow.bias = -0.00032;
      this.sun.shadow.normalBias = 0.03;
      this.sun.shadow.radius = options.quality === "high" ? 3.2 : 1.5;
      const cam = this.sun.shadow.camera;
      const r = this.shadowRange;
      cam.left = -r;
      cam.right = r;
      cam.top = r;
      cam.bottom = -r;
      cam.near = 1;
      cam.far = 120;
      cam.updateProjectionMatrix();
    }

    if (options.quality !== "low") {
      this.pmrem = new THREE.PMREMGenerator(renderer);
      this.envScene = new THREE.Scene();
      this.envSky = new THREE.Mesh(new THREE.SphereGeometry(5, 24, 12), this.skyMaterial);
      this.envSky.frustumCulled = false;
      this.envScene.add(this.envSky);
    }

    skyUniforms.uCloudTex.value = cloudNoiseTexture();
    this.setPhase(0.3);
  }

  /** Points the shared sky uniforms at this atmosphere. PostFX calls it before each frame. */
  bind() {
    const u = skyUniforms;
    u.uSkyLut.value = this.luts.view.texture;
    u.uCloudTex.value = cloudNoiseTexture();
    u.uSunDirW.value.copy(this.lightDir);
    u.uSunColorW.value.copy(this.sun.color).multiplyScalar(this.sun.intensity);
    u.uSkyAmb.value.copy(this.skyIrr);
    u.uGroundAmb.value.copy(this.groundIrr);
    u.uNight.value = this.night;
    u.uSkyTime.value = this.time;
    u.uCloudCover.value = this.skyMaterial.uniforms.uCover.value as number;
    u.uCloudWind.value.copy(this.skyMaterial.uniforms.uWind.value as THREE.Vector4);
    u.uAerial.value.set(0.0017, 0.045, 18, 0);
  }

  setPhase(phase: number) {
    this.phase = phase;
    const night = nightness(phase);
    this.night = night;
    celestial(phase, this.sunDir, this.moonDir);
    const sun = this.sunDir;
    const moon = this.moonDir;

    // Moonlight rises with the night; the sky's own glow comes from the same model.
    const moonUp = smooth(0.15, 0.85, night);
    const moonE = [MOON_E * MOON_TINT[0] * moonUp, MOON_E * MOON_TINT[1] * moonUp, MOON_E * MOON_TINT[2] * moonUp];
    this.luts.update(sun, moon, moonE);

    // Sunlight at the ground and at cloud height.
    transmittanceJS(VIEW_H, sun.y, tmpA);
    this.sunIrr.setRGB(tmpA[0] * SUN_E, tmpA[1] * SUN_E, tmpA[2] * SUN_E);
    const sunAtClouds = transmittanceJS(1600, sun.y, [0, 0, 0]);
    const moonT = transmittanceJS(VIEW_H, moon.y, [0, 0, 0]);
    const moonIrr = new THREE.Color(moonE[0] * moonT[0], moonE[1] * moonT[1], moonE[2] * moonT[2]);

    // Sky light on an upward-facing surface, integrated over three bands.
    const sunE = [SUN_E, SUN_E, SUN_E];
    const sky = [0, 0, 0];
    const bands: [number, number, number][] = [
      [Math.PI / 2, 1, 0.38],
      [0.96, 6, 1.53],
      [0.26, 8, 1.05],
    ];
    const zenith = [0, 0, 0];
    const horizon = [0, 0, 0];
    for (const [elevation, count, weight] of bands) {
      for (let i = 0; i < count; i++) {
        const az = (i / count) * Math.PI * 2 + 0.3;
        tmpDir.set(Math.cos(elevation) * Math.cos(az), Math.sin(elevation), Math.cos(elevation) * Math.sin(az));
        skyRadianceJS(tmpDir, sun, sunE, tmpA);
        skyRadianceJS(tmpDir, moon, moonE, tmpB);
        for (let k = 0; k < 3; k++) {
          const L = tmpA[k] + tmpB[k];
          sky[k] += (L * weight) / count;
          if (count === 1) zenith[k] = L;
          if (elevation < 0.3) horizon[k] += L / count;
        }
      }
    }
    // A floor of starlight and airglow so night is dark blue, never black.
    const floor = [0.012, 0.018, 0.034];
    this.skyIrr.setRGB(sky[0] + floor[0], sky[1] + floor[1], sky[2] + floor[2]);
    this.zenithColor.setRGB(zenith[0], zenith[1], zenith[2]);
    this.horizonColor.setRGB(horizon[0], horizon[1], horizon[2]);
    const sunUp = Math.max(0, sun.y);
    const moonUpY = Math.max(0, moon.y);
    const albedo = [0.16, 0.19, 0.11];
    this.groundIrr.setRGB(
      albedo[0] * (this.sunIrr.r * sunUp + moonIrr.r * moonUpY + this.skyIrr.r),
      albedo[1] * (this.sunIrr.g * sunUp + moonIrr.g * moonUpY + this.skyIrr.g),
      albedo[2] * (this.sunIrr.b * sunUp + moonIrr.b * moonUpY + this.skyIrr.b),
    );

    // One light is the sun by day and the moon by night, weighted between.
    const sunPower = Math.max(this.sunIrr.r, this.sunIrr.g, this.sunIrr.b);
    const moonPower = Math.max(moonIrr.r, moonIrr.g, moonIrr.b);
    this.lightDir.copy(sun).multiplyScalar(sunPower + 1e-4).addScaledVector(moon, moonPower).normalize();
    if (this.lightDir.y < 0.06) this.lightDir.y = 0.06;
    this.lightDir.normalize();
    const total = new THREE.Color().copy(this.sunIrr).add(moonIrr);
    const peak = Math.max(total.r, total.g, total.b, 1e-4);
    this.sun.color.setRGB(total.r / peak, total.g / peak, total.b / peak);
    this.sun.intensity = peak;
    this.sun.position.copy(this.sun.target.position).addScaledVector(this.lightDir, 60);

    // Ambient: the sky light, shared between the hemisphere light (for every
    // material) and the reflection environment (for the physically based ones).
    const hemiScale = this.pmrem ? 0.62 : 0.95;
    const skyPeak = Math.max(this.skyIrr.r, this.skyIrr.g, this.skyIrr.b, 1e-4);
    this.hemi.color.setRGB(this.skyIrr.r / skyPeak, this.skyIrr.g / skyPeak, this.skyIrr.b / skyPeak);
    this.hemi.intensity = skyPeak * hemiScale;
    const groundPeak = Math.max(this.groundIrr.r, this.groundIrr.g, this.groundIrr.b, 1e-4);
    this.hemi.groundColor.setRGB(this.groundIrr.r / skyPeak, this.groundIrr.g / skyPeak, this.groundIrr.b / skyPeak);
    void groundPeak;

    // Sky dome uniforms.
    const u = this.skyMaterial.uniforms;
    (u.uSunDir.value as THREE.Vector3).copy(sun);
    (u.uMoonDir.value as THREE.Vector3).copy(moon);
    (u.uLightDir.value as THREE.Vector3).copy(sunPower > moonPower * 0.5 ? sun : moon);
    if ((u.uLightDir.value as THREE.Vector3).y < 0.02) (u.uLightDir.value as THREE.Vector3).y = 0.02;
    (u.uLightDir.value as THREE.Vector3).normalize();
    transmittanceJS(VIEW_H, sun.y, tmpA);
    (u.uSunDisc.value as THREE.Color).setRGB(tmpA[0], tmpA[1], tmpA[2]).multiplyScalar(85);
    (u.uMoonDisc.value as THREE.Color).setRGB(0.9, 0.95, 1.05).multiplyScalar(0.9 * smooth(0.1, 0.7, night));
    const cloudSun = new THREE.Color(sunAtClouds[0] * SUN_E, sunAtClouds[1] * SUN_E, sunAtClouds[2] * SUN_E);
    if (sunPower < moonPower * 0.5) cloudSun.setRGB(moonE[0], moonE[1], moonE[2]).multiplyScalar(0.7);
    (u.uCloudLight.value as THREE.Color).copy(cloudSun).multiplyScalar(1 / Math.PI);
    (u.uCloudAmb.value as THREE.Color).copy(this.skyIrr).multiplyScalar(1 / Math.PI).add(new THREE.Color(this.groundIrr).multiplyScalar(0.35 / Math.PI));
    u.uNight.value = night;

    // Exposure: partial adaptation, so dusk and night stay dark but readable.
    const key = (this.sunIrr.r * 0.3 + this.sunIrr.g * 0.6 + this.sunIrr.b * 0.1) * (0.35 + 0.65 * sunUp) + (moonIrr.r * 0.3 + moonIrr.g * 0.6 + moonIrr.b * 0.1) * 0.6 + (this.skyIrr.r * 0.3 + this.skyIrr.g * 0.6 + this.skyIrr.b * 0.1) * 1.4;
    this.exposure = clamp(Math.pow(5.6 / Math.max(key, 1e-3), 0.42), 0.9, 2.3);
    this.warmth = smooth(0.35, 0.0, sun.y) * (1 - night);

    if (this.scene.fog instanceof THREE.Fog) {
      this.scene.fog.color.copy(this.horizonColor);
    } else {
      this.scene.fog = new THREE.Fog(this.horizonColor.clone(), 60, this.fogFar * 1.6);
    }
    if (this.scene.userData.atmosphere !== this) this.scene.userData.atmosphere = this;
    this.bind();
    // The reflection environment must exist before anything compiles: materials
    // compiled without it would all be compiled again on the first frame.
    this.refreshEnvironment();
  }

  /**
   * Cheaper shadows (a smaller map) without switching them off: changing
   * castShadow would make every lit material recompile and freeze the game.
   */
  setShadowDetail(low: boolean) {
    if (!this.sun.castShadow) return;
    const size = low ? 512 : this.quality === "high" ? 2048 : 1024;
    if (this.sun.shadow.mapSize.x === size) return;
    this.sun.shadow.mapSize.set(size, size);
    this.sun.shadow.map?.dispose();
    this.sun.shadow.map = null;
  }

  /** Re-renders the reflection environment when the light has shifted. */
  private refreshEnvironment() {
    if (!this.pmrem || !this.envScene) return;
    if (Math.abs(this.phase - this.envPhase) < 0.009 && this.envTarget) return;
    this.envPhase = this.phase;
    this.skyMaterial.uniforms.uEnvPass.value = 1;
    const target = this.pmrem.fromScene(this.envScene, 0.02, 0.5, 20);
    this.skyMaterial.uniforms.uEnvPass.value = 0;
    this.scene.environment = target.texture;
    this.scene.environmentIntensity = lerp(0.55, 0.42, this.night);
    this.envTarget?.dispose();
    this.envTarget = target;
  }

  update(dt: number, focus: THREE.Vector3, camera: THREE.Camera) {
    this.time += dt;
    const u = this.skyMaterial.uniforms;
    u.uTime.value = this.time;
    (u.uWind.value as THREE.Vector4).set(this.time * this.wind.x * 0.05, this.time * this.wind.y * 0.05, this.time * this.wind.x * 0.11, this.time * this.wind.y * 0.17);
    // Keep the shadow volume around the focus, snapped to texels so edges do not shimmer.
    if (this.sun.castShadow) {
      const r = this.shadowRange;
      const texel = (2 * r) / this.sun.shadow.mapSize.x;
      const snapX = Math.round(focus.x / texel) * texel;
      const snapZ = Math.round(focus.z / texel) * texel;
      this.sun.target.position.set(snapX, 0, snapZ);
      this.sun.position.copy(this.sun.target.position).addScaledVector(this.lightDir, 60);
    }
    this.refreshEnvironment();
    this.bind();
    void camera;
  }

  dispose() {
    this.envTarget?.dispose();
    this.pmrem?.dispose();
    this.luts.dispose();
    this.skyMaterial.dispose();
    this.sky.geometry.dispose();
    this.envSky?.geometry.dispose();
    this.scene.remove(this.sky, this.sun, this.sun.target, this.hemi);
    if (this.scene.userData.atmosphere === this) delete this.scene.userData.atmosphere;
  }
}

// ----- Shadow warm-up -------------------------------------------------------------

/**
 * Compiles the shadow-map depth programs of every kind of caster in the scene.
 * renderer.compile only builds the colour programs; depth variants (instanced,
 * skinned, alpha-tested with a map, custom depth materials, each side setting)
 * are otherwise built the first time such an object enters the sun's shadow
 * camera, which stalls a frame. This puts one stand-in of each kind (same
 * geometry, material, skeleton and depth material) inside the shadow camera of
 * a throwaway scene lit like the real one, and renders it from a camera looking
 * away, so only the shadow pass draws them.
 */
export function warmShadowCasters(renderer: THREE.WebGLRenderer, scene: THREE.Object3D, camera: THREE.Camera) {
  void camera;
  if (!renderer.shadowMap.enabled) return;
  // Posed bones are needed to place the creatures' stand-ins.
  scene.updateMatrixWorld();
  // Everything a depth program depends on, per caster. Depth materials take
  // their side from shadowSide, or else the opposite of the caster's side.
  const depthSide = [THREE.BackSide, THREE.FrontSide, THREE.DoubleSide];
  const cost = (g: THREE.BufferGeometry) => (g.index ?? g.getAttribute("position"))?.count ?? 0;
  const reps = new Map<string, THREE.Mesh>();
  scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.castShadow) return;
    const instanced = mesh as THREE.InstancedMesh;
    const skinned = (mesh as unknown as THREE.SkinnedMesh).isSkinnedMesh === true;
    if (skinned && !(mesh as unknown as THREE.SkinnedMesh).skeleton) return;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of materials) {
      const mat = m as THREE.MeshStandardMaterial;
      const key = [
        instanced.isInstancedMesh ? "i" : "",
        instanced.isInstancedMesh && instanced.instanceColor ? "c" : "",
        skinned ? "s" : "",
        mesh.geometry.morphAttributes.position ? "m" + mesh.geometry.morphAttributes.position.length : "",
        mat.shadowSide ?? depthSide[mat.side],
        mat.map ? "map" + mat.map.channel : "",
        mat.alphaMap ? "amap" + mat.alphaMap.channel : "",
        mat.alphaTest > 0 ? "at" : "",
        mat.displacementMap ? "d" : "",
        mesh.customDepthMaterial ? mesh.customDepthMaterial.uuid : "",
      ].join("|");
      const best = reps.get(key);
      if (!best || cost(mesh.geometry) < cost(best.geometry)) reps.set(key, mesh);
    }
  });
  if (reps.size === 0) return;
  // Program keys include the scene's light counts, even for depth materials,
  // so the stage gets copies of every visible light in the real scene.
  const stage = new THREE.Scene();
  const casters: THREE.DirectionalLight[] = [];
  const visible = (o: THREE.Object3D) => {
    for (let p: THREE.Object3D | null = o; p; p = p.parent) if (!p.visible) return false;
    return true;
  };
  scene.traverse((o) => {
    const l = o as THREE.Light;
    if (!l.isLight || !visible(l)) return;
    const copy = l.clone(false) as THREE.Light;
    const dir = copy as THREE.DirectionalLight;
    if (dir.isDirectionalLight) {
      dir.position.set(8, 20, 6);
      dir.target.position.set(0, 0, 0);
      stage.add(dir.target);
      if (dir.castShadow) {
        dir.shadow.mapSize.set(256, 256);
        const cam = dir.shadow.camera;
        cam.left = cam.bottom = -30;
        cam.right = cam.top = 30;
        cam.near = 0.5;
        cam.far = 120;
        cam.updateProjectionMatrix();
        casters.push(dir);
      }
    }
    stage.add(copy);
  });
  if (casters.length === 0) return;
  // three.js only looks for a new depth program when the depth material's
  // version or the kind of caster (instanced, skinned...) changes from one
  // caster to the next, not for side or map alone, so each stand-in bumps the
  // version of the depth material it is about to be drawn with.
  const freshProgram = (...args: Parameters<THREE.Object3D["onBeforeShadow"]>) => {
    args[5].needsUpdate = true;
  };
  const proxies: THREE.Mesh[] = [];
  for (const mesh of new Set(reps.values())) {
    let proxy: THREE.Mesh;
    if ((mesh as THREE.InstancedMesh).isInstancedMesh) {
      const source = mesh as THREE.InstancedMesh;
      const instanced = new THREE.InstancedMesh(source.geometry, source.material, 1);
      instanced.setMatrixAt(0, new THREE.Matrix4());
      // Instance colours change the depth program too.
      if (source.instanceColor) instanced.setColorAt(0, new THREE.Color(1, 1, 1));
      proxy = instanced;
    } else if ((mesh as unknown as THREE.SkinnedMesh).isSkinnedMesh) {
      // Shares the creature's skeleton. Detached binding makes the posed
      // creature follow the stand-in's own transform, so it can be moved.
      const source = mesh as unknown as THREE.SkinnedMesh;
      const skinned = new THREE.SkinnedMesh(source.geometry, source.material);
      skinned.bindMode = THREE.DetachedBindMode;
      skinned.bind(source.skeleton, source.bindMatrix);
      skinned.computeBoundingSphere();
      proxy = skinned as unknown as THREE.Mesh;
    } else {
      proxy = new THREE.Mesh(mesh.geometry, mesh.material);
    }
    // Centred on the shadow camera and shrunk to fit inside it, wherever the
    // geometry itself lies. The main pass culls it against the camera below.
    const geometry = mesh.geometry;
    if (!geometry.boundingSphere) geometry.computeBoundingSphere();
    const sphere = (proxy as unknown as THREE.SkinnedMesh).isSkinnedMesh ? (proxy as unknown as THREE.SkinnedMesh).boundingSphere : geometry.boundingSphere;
    if (sphere && sphere.radius > 0 && Number.isFinite(sphere.radius + sphere.center.x + sphere.center.y + sphere.center.z)) {
      const s = Math.min(1, 18 / sphere.radius);
      proxy.scale.setScalar(s);
      proxy.position.copy(sphere.center).multiplyScalar(-s);
    }
    proxy.customDepthMaterial = mesh.customDepthMaterial;
    proxy.castShadow = true;
    proxy.frustumCulled = true;
    proxy.onBeforeShadow = freshProgram;
    stage.add(proxy);
    proxies.push(proxy);
  }
  // A camera far below, looking down: the stand-ins are culled from the main
  // pass, so no colour programs are built for this stage's lighting.
  const away = new THREE.PerspectiveCamera(30, 1, 1, 10);
  away.position.set(0, -5000, 0);
  away.lookAt(0, -6000, 0);
  away.updateMatrixWorld();
  const autoUpdate = renderer.shadowMap.autoUpdate;
  // three.js draws shadows before it sets up a scene's lights, so the stage's
  // first shadow pass would see no lights: render once without shadows first.
  renderer.shadowMap.enabled = false;
  renderer.render(stage, away);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.needsUpdate = true;
  renderer.render(stage, away);
  renderer.shadowMap.autoUpdate = autoUpdate;
  renderer.shadowMap.needsUpdate = true;
  for (const proxy of proxies) if ((proxy as THREE.InstancedMesh).isInstancedMesh) (proxy as THREE.InstancedMesh).dispose();
  for (const light of casters) light.shadow.map?.dispose();
  stage.traverse((o) => (o as THREE.Light).isLight && (o as THREE.Light).dispose());
}

// ----- Post-processing --------------------------------------------------------

const FULLSCREEN_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

function fullscreenMaterial(fragmentShader: string, uniforms: Record<string, THREE.IUniform>): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({ vertexShader: FULLSCREEN_VERTEX, fragmentShader, uniforms, depthTest: false, depthWrite: false, toneMapped: false });
}

/** 13-tap downsample (as in Call of Duty's bloom) with a Karis average on the first level. */
const DOWNSAMPLE = /* glsl */ `
  varying vec2 vUv;
  uniform sampler2D tSrc;
  uniform vec2 uTexel;
  uniform float uThreshold;
  vec3 tap(vec2 o){ return texture2D(tSrc, vUv + uTexel * o).rgb; }
  float karis(vec3 c){ return 1.0 / (1.0 + max(c.r, max(c.g, c.b))); }
  void main(){
    vec3 a = tap(vec2(-2.0, -2.0)), b = tap(vec2(0.0, -2.0)), c = tap(vec2(2.0, -2.0));
    vec3 d = tap(vec2(-1.0, -1.0)), e = tap(vec2(1.0, -1.0));
    vec3 f = tap(vec2(-2.0, 0.0)), g = tap(vec2(0.0, 0.0)), h = tap(vec2(2.0, 0.0));
    vec3 i = tap(vec2(-1.0, 1.0)), j = tap(vec2(1.0, 1.0));
    vec3 k = tap(vec2(-2.0, 2.0)), l = tap(vec2(0.0, 2.0)), m = tap(vec2(2.0, 2.0));
    vec3 col;
    if (uThreshold > 0.0) {
      vec3 g0 = (d + e + i + j) * 0.25;
      vec3 g1 = (a + b + f + g) * 0.25;
      vec3 g2 = (b + c + g + h) * 0.25;
      vec3 g3 = (f + g + k + l) * 0.25;
      vec3 g4 = (g + h + l + m) * 0.25;
      float w0 = karis(g0) * 0.5, w1 = karis(g1) * 0.125, w2 = karis(g2) * 0.125, w3 = karis(g3) * 0.125, w4 = karis(g4) * 0.125;
      col = (g0 * w0 + g1 * w1 + g2 * w2 + g3 * w3 + g4 * w4) / (w0 + w1 + w2 + w3 + w4);
      float br = max(col.r, max(col.g, col.b));
      float knee = uThreshold * 0.6;
      float soft = clamp(br - uThreshold + knee, 0.0, 2.0 * knee);
      soft = soft * soft / (4.0 * knee + 1e-4);
      col *= max(soft, br - uThreshold) / max(br, 1e-4);
    } else {
      col = (d + e + i + j) * 0.125 + (a + c + k + m) * 0.03125 + (b + f + h + l) * 0.0625 + g * 0.125;
    }
    gl_FragColor = vec4(min(col, vec3(64.0)), 1.0);
  }
`;

/** 9-tap tent upsample, added onto the next finer level. */
const UPSAMPLE = /* glsl */ `
  varying vec2 vUv;
  uniform sampler2D tSrc;
  uniform sampler2D tPrev;
  uniform vec2 uTexel;
  void main(){
    vec3 s = texture2D(tPrev, vUv + uTexel * vec2(-1.0, -1.0)).rgb;
    s += texture2D(tPrev, vUv + uTexel * vec2(0.0, -1.0)).rgb * 2.0;
    s += texture2D(tPrev, vUv + uTexel * vec2(1.0, -1.0)).rgb;
    s += texture2D(tPrev, vUv + uTexel * vec2(-1.0, 0.0)).rgb * 2.0;
    s += texture2D(tPrev, vUv).rgb * 4.0;
    s += texture2D(tPrev, vUv + uTexel * vec2(1.0, 0.0)).rgb * 2.0;
    s += texture2D(tPrev, vUv + uTexel * vec2(-1.0, 1.0)).rgb;
    s += texture2D(tPrev, vUv + uTexel * vec2(0.0, 1.0)).rgb * 2.0;
    s += texture2D(tPrev, vUv + uTexel * vec2(1.0, 1.0)).rgb;
    gl_FragColor = vec4(texture2D(tSrc, vUv).rgb + s * (1.0 / 16.0) * 0.85, 1.0);
  }
`;

const COMPOSITE = /* glsl */ `
  varying vec2 vUv;
  uniform sampler2D tScene;
  uniform sampler2D tBloom;
  uniform vec2 uTexel;
  uniform float uBloom;
  uniform float uExposure;
  uniform float uVignette;
  uniform float uFxaa;
  uniform vec3 uTint;
  uniform float uTime;
  uniform float uNight;
  uniform float uWarmth;

  vec3 sampleScene(vec2 uv){ return texture2D(tScene, uv).rgb; }
  float luma(vec3 c){ return dot(c, vec3(0.299, 0.587, 0.114)); }

  // ACES filmic: Stephen Hill's fit of the RRT and ODT, with its gentle toe,
  // soft shoulder and the way bright colours run towards white.
  vec3 rrtOdt(vec3 v){
    vec3 a = v * (v + 0.0245786) - 0.000090537;
    vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
    return a / b;
  }
  vec3 acesFilm(vec3 c){
    const mat3 inM = mat3(0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777);
    const mat3 outM = mat3(1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602);
    return clamp(outM * rrtOdt(inM * c), 0.0, 1.0);
  }
  vec3 toSrgb(vec3 c){
    c = clamp(c, 0.0, 1.0);
    return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
  }

  void main(){
    vec3 hdr;
    if (uFxaa > 0.5) {
      // A small FXAA on HDR luma, enough to tame shimmer on grass and leaves.
      vec3 cM = sampleScene(vUv);
      float lM = luma(cM);
      float lNW = luma(sampleScene(vUv + uTexel * vec2(-1.0, -1.0)));
      float lNE = luma(sampleScene(vUv + uTexel * vec2(1.0, -1.0)));
      float lSW = luma(sampleScene(vUv + uTexel * vec2(-1.0, 1.0)));
      float lSE = luma(sampleScene(vUv + uTexel * vec2(1.0, 1.0)));
      float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
      float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));
      vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), (lNW + lSW) - (lNE + lSE));
      float reduce = max((lNW + lNE + lSW + lSE) * 0.03, 0.002);
      float scale = 1.0 / (min(abs(dir.x), abs(dir.y)) + reduce);
      dir = clamp(dir * scale, vec2(-8.0), vec2(8.0)) * uTexel;
      vec3 a = 0.5 * (sampleScene(vUv + dir * (1.0 / 3.0 - 0.5)) + sampleScene(vUv + dir * (2.0 / 3.0 - 0.5)));
      vec3 b = a * 0.5 + 0.25 * (sampleScene(vUv + dir * -0.5) + sampleScene(vUv + dir * 0.5));
      float lB = luma(b);
      hdr = (lB < lMin || lB > lMax) ? a : b;
    } else {
      hdr = sampleScene(vUv);
    }
    vec3 bloom = uBloom > 0.0 ? texture2D(tBloom, vUv).rgb : vec3(0.0);
    vec3 color = hdr + bloom * uBloom;
    color *= uExposure * uTint;

    // At night the eye loses colour in the dark: shift dim tones to blue grey.
    float lum = dot(color, vec3(0.2126, 0.7152, 0.0722));
    float scotopic = uNight * (1.0 - smoothstep(0.02, 0.5, lum)) * 0.55;
    color = mix(color, vec3(lum) * vec3(0.78, 0.9, 1.18), scotopic);

    // Filmic curve; 1.9 places mid grey where the old curve had it.
    color = acesFilm(color * 1.9);

    // Gentle grade in display space: cool shadows, warm highlights, a little
    // more warmth in the golden hours and a touch of vibrance.
    vec3 g = toSrgb(color);
    float l = luma(g);
    vec3 shadows = vec3(0.975, 0.99, 1.035);
    vec3 highs = mix(vec3(1.018, 1.0, 0.975), vec3(1.05, 1.0, 0.92), uWarmth);
    g *= mix(shadows, highs, smoothstep(0.15, 0.8, l));
    float sat = max(g.r, max(g.g, g.b)) - min(g.r, min(g.g, g.b));
    g = mix(vec3(l), g, 1.0 + 0.12 * (1.0 - sat));
    g = mix(g, g * g * (3.0 - 2.0 * g), 0.12);

    // Vignette, like a real lens.
    vec2 d = (vUv - 0.5) * vec2(1.0, 0.82);
    g *= mix(1.0, smoothstep(0.95, 0.2, length(d) * 1.25), uVignette);

    // Fine grain, which also hides banding in the sky.
    float n = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233)) + fract(uTime) * 61.0) * 43758.5453);
    g += (n - 0.5) * (1.6 / 255.0);
    gl_FragColor = vec4(clamp(g, 0.0, 1.0), 1.0);
  }
`;

export interface PostOptions {
  quality: Quality;
  bloomStrength?: number;
  /** MSAA samples for the scene buffer (0 uses FXAA instead). */
  samples?: number;
  /**
   * Lower the internal resolution by itself when frames run long, and raise it
   * again when there is headroom (default on). Turn off if you manage
   * setRenderScale yourself.
   */
  autoScale?: boolean;
}

const HDR_INTERNAL = "R11F_G11F_B10F";

function makeHdrTarget(width: number, height: number, samples: number, depth: boolean): THREE.WebGLRenderTarget {
  const target = new THREE.WebGLRenderTarget(width, height, {
    type: THREE.HalfFloatType,
    format: THREE.RGBFormat,
    samples,
    depthBuffer: depth,
    stencilBuffer: false,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    generateMipmaps: false,
  });
  // 32 bits per pixel instead of 64: half the bandwidth, which matters most on
  // integrated GPUs. Requires EXT_color_buffer_float, which WebGL2 HDR needs anyway.
  target.texture.internalFormat = HDR_INTERNAL as THREE.PixelFormatGPU;
  return target;
}

export class PostFX {
  readonly renderer: THREE.WebGLRenderer;
  bloom = true;
  exposure = 1;
  /** Draw calls and triangles of the last scene pass, for profiling. */
  lastCalls = 0;
  lastTriangles = 0;
  private sceneRT: THREE.WebGLRenderTarget;
  private bloomDown: THREE.WebGLRenderTarget[] = [];
  private bloomUp: THREE.WebGLRenderTarget[] = [];
  private composite: THREE.ShaderMaterial;
  private downsample: THREE.ShaderMaterial;
  private upsample: THREE.ShaderMaterial;
  private quad: THREE.Mesh;
  private quadScene: THREE.Scene;
  private quadCamera: THREE.OrthographicCamera;
  private width = 0;
  private height = 0;
  private renderScale = 1;
  private bloomLevels: number;
  private bloomStrength: number;
  private samples: number;
  private fxaa: boolean;
  private smoothExposure = -1;
  private autoScale: boolean;
  private frameAvg = 1 / 60;
  private adaptTimer = 0;
  private headroom = 0;

  constructor(renderer: THREE.WebGLRenderer, options: PostOptions) {
    this.renderer = renderer;
    this.autoScale = options.autoScale !== false;
    this.samples = options.samples ?? (options.quality === "high" ? 2 : 0);
    this.fxaa = this.samples === 0;
    this.sceneRT = makeHdrTarget(1, 1, this.samples, true);
    this.bloomLevels = options.quality === "low" ? 0 : 5;
    this.bloomStrength = (options.bloomStrength ?? 0.34) * 0.62;
    this.downsample = fullscreenMaterial(DOWNSAMPLE, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uThreshold: { value: 1.0 } });
    this.upsample = fullscreenMaterial(UPSAMPLE, { tSrc: { value: null }, tPrev: { value: null }, uTexel: { value: new THREE.Vector2() } });
    this.composite = fullscreenMaterial(COMPOSITE, {
      tScene: { value: this.sceneRT.texture },
      tBloom: { value: null },
      uTexel: { value: new THREE.Vector2(1, 1) },
      uBloom: { value: this.bloomStrength },
      uExposure: { value: 1 },
      uVignette: { value: 0.55 },
      uFxaa: { value: this.fxaa ? 1 : 0 },
      uTint: { value: new THREE.Color(1, 1, 1) },
      uTime: { value: 0 },
      uNight: { value: 0 },
      uWarmth: { value: 0 },
    });
    const geometry = new THREE.PlaneGeometry(2, 2);
    this.quad = new THREE.Mesh(geometry, this.composite);
    this.quad.frustumCulled = false;
    this.quadScene = new THREE.Scene();
    this.quadScene.add(this.quad);
    this.quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }

  /** Output size in physical pixels. The scene buffer may be smaller. */
  setSize(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.applySize();
  }

  /** Internal resolution as a fraction of the output (0.5 .. 1). */
  setRenderScale(scale: number) {
    if (scale === this.renderScale) return;
    this.renderScale = scale;
    this.applySize();
  }

  getRenderScale() {
    return this.renderScale;
  }

  /** The scene buffer. Bind it before renderer.compile so programs match. */
  get sceneTarget() {
    return this.sceneRT;
  }

  /** Change MSAA at runtime. */
  setSamples(samples: number) {
    if (samples === this.samples) return;
    this.samples = samples;
    this.fxaa = samples === 0;
    this.sceneRT.dispose();
    this.sceneRT = makeHdrTarget(1, 1, samples, true);
    this.composite.uniforms.tScene.value = this.sceneRT.texture;
    this.composite.uniforms.uFxaa.value = this.fxaa ? 1 : 0;
    this.applySize();
  }

  private applySize() {
    const width = Math.max(2, Math.round(this.width * this.renderScale));
    const height = Math.max(2, Math.round(this.height * this.renderScale));
    this.sceneRT.setSize(width, height);
    (this.composite.uniforms.uTexel.value as THREE.Vector2).set(1 / width, 1 / height);
    for (const rt of [...this.bloomDown, ...this.bloomUp]) rt.dispose();
    this.bloomDown = [];
    this.bloomUp = [];
    // Bloom starts at a quarter of the buffer; that is plenty for a soft halo.
    let w = Math.max(2, Math.floor(width / 4));
    let h = Math.max(2, Math.floor(height / 4));
    for (let i = 0; i < this.bloomLevels; i++) {
      this.bloomDown.push(makeHdrTarget(w, h, 0, false));
      w = Math.max(2, Math.floor(w / 2));
      h = Math.max(2, Math.floor(h / 2));
    }
    for (let i = this.bloomLevels - 2; i >= 0; i--) {
      const down = this.bloomDown[i];
      this.bloomUp.push(makeHdrTarget(down.width, down.height, 0, false));
    }
  }

  private blit(material: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget | null) {
    this.quad.material = material;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.quadScene, this.quadCamera);
  }

  /** Dynamic resolution: aim for about 50 fps or better, never below 0.6 scale. */
  private adapt(dt: number) {
    if (!this.autoScale || dt <= 0 || dt > 0.25) return;
    this.frameAvg += (dt - this.frameAvg) * 0.06;
    this.adaptTimer += dt;
    if (this.adaptTimer < 1.2) return;
    this.adaptTimer = 0;
    if (this.frameAvg > 1 / 47 && this.renderScale > 0.6) {
      this.headroom = 0;
      this.setRenderScale(Math.max(0.6, Math.round((this.renderScale - 0.1) * 20) / 20));
    } else if (this.frameAvg < 1 / 57 && this.renderScale < 1) {
      this.headroom += 1;
      if (this.headroom >= 4) {
        this.headroom = 0;
        this.setRenderScale(Math.min(1, Math.round((this.renderScale + 0.05) * 20) / 20));
      }
    } else {
      this.headroom = 0;
    }
  }

  render(scene: THREE.Scene, camera: THREE.Camera, dt = 0.016) {
    const renderer = this.renderer;
    const previousToneMapping = renderer.toneMapping;
    const previousAutoClear = renderer.autoClear;
    const atmosphere = scene.userData.atmosphere as Atmosphere | undefined;
    atmosphere?.bind();
    this.adapt(dt);

    renderer.setRenderTarget(this.sceneRT);
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.autoClear = true;
    renderer.clear();
    renderer.render(scene, camera);
    this.lastCalls = renderer.info.render.calls;
    this.lastTriangles = renderer.info.render.triangles;
    const useBloom = this.bloom && this.bloomLevels > 0;

    renderer.autoClear = false;
    const uniforms = this.composite.uniforms;
    if (useBloom) {
      let source: THREE.Texture = this.sceneRT.texture;
      let sourceW = this.sceneRT.width;
      let sourceH = this.sceneRT.height;
      this.bloomDown.forEach((target, i) => {
        const down = this.downsample.uniforms;
        down.tSrc.value = source;
        const step = i === 0 ? 2 : 1;
        (down.uTexel.value as THREE.Vector2).set(step / sourceW, step / sourceH);
        down.uThreshold.value = i === 0 ? 1.0 : 0;
        this.blit(this.downsample, target);
        source = target.texture;
        sourceW = target.width;
        sourceH = target.height;
      });
      let previous = this.bloomDown[this.bloomLevels - 1].texture;
      let previousW = this.bloomDown[this.bloomLevels - 1].width;
      let previousH = this.bloomDown[this.bloomLevels - 1].height;
      this.bloomUp.forEach((target, i) => {
        const up = this.upsample.uniforms;
        const downIndex = this.bloomLevels - 2 - i;
        up.tSrc.value = this.bloomDown[downIndex].texture;
        up.tPrev.value = previous;
        (up.uTexel.value as THREE.Vector2).set(1 / previousW, 1 / previousH);
        this.blit(this.upsample, target);
        previous = target.texture;
        previousW = target.width;
        previousH = target.height;
      });
      uniforms.tBloom.value = previous;
    } else {
      uniforms.tBloom.value = null;
    }

    // Eyes adjust over a second or two, not in a frame.
    const wanted = atmosphere ? atmosphere.exposure : 1;
    if (this.smoothExposure < 0) this.smoothExposure = wanted;
    this.smoothExposure += (wanted - this.smoothExposure) * Math.min(1, dt * 1.5);

    uniforms.tScene.value = this.sceneRT.texture;
    uniforms.uExposure.value = this.exposure * this.smoothExposure;
    uniforms.uTime.value = (uniforms.uTime.value as number) + dt;
    uniforms.uBloom.value = useBloom ? this.bloomStrength : 0;
    uniforms.uNight.value = atmosphere ? atmosphere.night : 0;
    uniforms.uWarmth.value = atmosphere ? atmosphere.warmth : 0;
    this.quad.material = this.composite;
    renderer.setRenderTarget(null);
    renderer.render(this.quadScene, this.quadCamera);

    renderer.toneMapping = previousToneMapping;
    renderer.autoClear = previousAutoClear;
  }

  dispose() {
    this.sceneRT.dispose();
    for (const rt of [...this.bloomDown, ...this.bloomUp]) rt.dispose();
    this.composite.dispose();
    this.downsample.dispose();
    this.upsample.dispose();
    this.quad.geometry.dispose();
  }
}
