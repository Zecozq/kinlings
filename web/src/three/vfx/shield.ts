// Bubble Shield: a soap-film energy bubble. Its colours are real thin-film
// interference (the film's thickness swirls and drains towards the bottom,
// as on a soap bubble), it reflects the sky and the sun with a Fresnel rim,
// it ripples into being, and when it breaks it shatters into curved shards
// and a spray of droplets.

import * as THREE from "three";
import { Field, GLSL_SCENE, KIND, SHARED, budget, observeFrame, rand, randomDir, range, sceneUniforms } from "./core.ts";
import type { ShieldEffect } from "./types.ts";

const BUBBLE_VERTEX = /* glsl */ `
attribute vec4 aFrag;   // fragment centre direction, random
uniform float uTime;
uniform float uAppear;
uniform float uBreak;
uniform float uRadius;
varying vec3 vWorld;
varying vec3 vNormal;
varying vec3 vLocal;
varying float vEdge;
vec3 rotateAxis(vec3 v, vec3 axis, float angle){
  float c = cos(angle), s = sin(angle);
  return v * c + cross(axis, v) * s + axis * dot(axis, v) * (1.0 - c);
}
void main(){
  vec3 n = normalize(position);
  // Settles in with a springy overshoot, then wobbles gently.
  float appear = uAppear;
  float spring = 1.0 - exp(-appear * 5.0) * cos(appear * 11.0);
  float wobble = sin(dot(n, vec3(3.1, 4.7, 2.3)) + uTime * 2.6) * 0.012 + sin(dot(n, vec3(-5.3, 2.9, 4.1)) + uTime * 3.7) * 0.008;
  vec3 p = n * uRadius * (spring + wobble);
  // Breaking: each shard flies out along its centre, spins and drops.
  if (uBreak > 0.0) {
    vec3 c = normalize(aFrag.xyz) * uRadius;
    vec3 axis = normalize(cross(aFrag.xyz, vec3(0.3, 1.0, 0.2)));
    float b = uBreak;
    vec3 rel = rotateAxis(p - c, axis, b * (2.0 + aFrag.w * 4.0));
    p = c * (1.0 + b * (1.1 + aFrag.w * 0.9)) + rel * (1.0 - b * 0.6) - vec3(0.0, 1.6 * b * b * uRadius, 0.0);
  }
  vLocal = position / uRadius;
  vEdge = aFrag.w;
  vec4 world = modelMatrix * vec4(p, 1.0);
  vWorld = world.xyz;
  vNormal = normalize(mat3(modelMatrix) * n);
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const BUBBLE_FRAGMENT = /* glsl */ `
${GLSL_SCENE}
uniform sampler2D uNoise;
uniform float uTime;
uniform float uAppear;
uniform float uBreak;
uniform float uInner;
uniform vec3 uColor;
varying vec3 vWorld;
varying vec3 vNormal;
varying vec3 vLocal;
varying float vEdge;
// Reflectance of a soap film (n = 1.33) of thickness d nm, per RGB wavelength.
vec3 thinFilm(float d, float cosI){
  float n = 1.33;
  float sin2 = 1.0 - cosI * cosI;
  float cosT = sqrt(max(0.0, 1.0 - sin2 / (n * n)));
  vec3 lambda = vec3(650.0, 532.0, 450.0);
  vec3 phase = 6.2831853 * 2.0 * n * d * cosT / lambda;
  float r0 = 0.02 + 0.98 * pow(1.0 - cosI, 5.0);
  vec3 s = sin(phase * 0.5);
  return 4.0 * r0 * s * s / (1.0 + 2.0 * r0);
}
void main(){
  vec3 n = normalize(vNormal);
  vec3 v = normalize(cameraPosition - vWorld);
  float facing = dot(n, v);
  if (uInner > 0.5) n = -n;
  float cosI = clamp(abs(facing), 0.0, 1.0);
  // Film thickness: swirling bands that drain down, thinner at the top.
  // (Noise mapped round the sphere: two repeats about the axis, so no seam.)
  vec2 sp = vec2(atan(vLocal.z, vLocal.x) * (2.0 / 6.2831853), vLocal.y * 0.62);
  vec4 w = texture2D(uNoise, sp * vec2(1.0, 1.0) + vec2(uTime * 0.012, -uTime * 0.035));
  vec4 f = texture2D(uNoise, sp * vec2(2.0, 1.9) + (w.ra - 0.5) * 0.4 + vec2(-uTime * 0.02, -uTime * 0.06));
  float swirl = f.r * 0.62 + w.g * 0.38;
  float thickness = mix(160.0, 760.0, clamp(swirl * 1.25 - 0.12 + (-vLocal.y) * 0.22, 0.0, 1.0));
  vec3 film = thinFilm(thickness, cosI);
  // What the film reflects: sky above, ground below, and the sun.
  vec3 r = reflect(-v, n);
  vec3 env = mix(uGroundCol * 0.8, uSkyCol * 1.35, smoothstep(-0.25, 0.35, r.y)) + uSunCol * (pow(max(dot(r, uSunDir), 0.0), 380.0) * 55.0) / PI;
  vec3 reflected = env * film;
  // The energy: a faint charge in the film that gathers at the rim.
  float rim = pow(1.0 - cosI, 3.0);
  float vein = smoothstep(0.72, 0.97, f.b);
  vec3 energy = uColor * (rim * 0.45 + vein * 0.05 + 0.015);
  // The ring of light that sweeps up as the bubble forms.
  float sweep = exp(-pow((vLocal.y - (uAppear * 2.6 - 1.3)) / 0.09, 2.0)) * (1.0 - smoothstep(0.7, 1.0, uAppear));
  energy += uColor * sweep * 2.5;
  float cracking = uBreak > 0.0 ? (1.0 - smoothstep(0.0, 0.18, uBreak)) * 3.0 : 0.0;
  vec3 rgb = reflected + energy * (1.0 + cracking);
  float a = clamp(dot(film, vec3(0.33)) * 0.9 + rim * 0.08, 0.0, 0.85);
  float fade = (uInner > 0.5 ? 0.55 : 1.0) * (1.0 - smoothstep(0.55, 1.0, uBreak)) * smoothstep(0.0, 0.08, uAppear);
  float fog = fogAmount(-(viewMatrix * vec4(vWorld, 1.0)).z);
  rgb *= 1.0 - fog;
  gl_FragColor = vec4(rgb * fade, a * fade);
}
`;

let bubbleGeometryCache: THREE.BufferGeometry | null = null;

/** A sphere of radius 1 cut into curved Voronoi shards for the break. */
function bubbleGeometry(): THREE.BufferGeometry {
  if (bubbleGeometryCache) return bubbleGeometryCache;
  const sphere = new THREE.IcosahedronGeometry(1, 6);
  const position = sphere.getAttribute("position") as THREE.BufferAttribute;
  const seeds = Array.from({ length: 44 }, () => randomDir(new THREE.Vector3()).clone());
  const shardRandom = seeds.map(() => rand());
  const frag = new Float32Array(position.count * 4);
  const centre = new THREE.Vector3();
  const a = new THREE.Vector3();
  for (let tri = 0; tri < position.count / 3; tri++) {
    centre.set(0, 0, 0);
    for (let k = 0; k < 3; k++) centre.add(a.fromBufferAttribute(position, tri * 3 + k));
    centre.normalize();
    let best = 0;
    let bestDot = -2;
    seeds.forEach((s, i) => {
      const d = s.dot(centre);
      if (d > bestDot) {
        bestDot = d;
        best = i;
      }
    });
    for (let k = 0; k < 3; k++) {
      const o = (tri * 3 + k) * 4;
      frag[o] = seeds[best].x;
      frag[o + 1] = seeds[best].y;
      frag[o + 2] = seeds[best].z;
      frag[o + 3] = shardRandom[best];
    }
  }
  sphere.setAttribute("aFrag", new THREE.BufferAttribute(frag, 4));
  sphere.deleteAttribute("uv");
  bubbleGeometryCache = sphere;
  return sphere;
}

function bubbleMaterial(side: THREE.Side, uniforms: Record<string, THREE.IUniform>, inner: boolean): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: inner ? "kinlings-vfx-bubble-back" : "kinlings-vfx-bubble",
    uniforms: {
      ...uniforms,
      uInner: { value: inner ? 1 : 0 },
      uNoise: SHARED.uNoise,
      ...sceneUniforms(),
    },
    vertexShader: BUBBLE_VERTEX,
    fragmentShader: BUBBLE_FRAGMENT,
    side,
    transparent: true,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
  });
}

export function createShieldBubble(options: { radius?: number; color?: THREE.ColorRepresentation } = {}): ShieldEffect {
  const radius = options.radius ?? 1.4;
  const color = new THREE.Color(options.color ?? "#8fd8ff");
  const holder = new THREE.Group();
  holder.position.y = 0.85;
  const shared = {
    uTime: { value: 0 },
    uAppear: { value: 0 },
    uBreak: { value: 0 },
    uRadius: { value: radius },
    uColor: { value: color.clone().multiplyScalar(1.2) },
  };
  const geometry = bubbleGeometry();
  const back = new THREE.Mesh(geometry, bubbleMaterial(THREE.BackSide, shared, true));
  const front = new THREE.Mesh(geometry, bubbleMaterial(THREE.FrontSide, shared, false));
  back.renderOrder = 4;
  front.renderOrder = 5;
  back.frustumCulled = front.frustumCulled = false;
  holder.add(back, front);
  const field = new Field(budget(90));
  field.mesh.renderOrder = 6;
  holder.add(field.mesh);
  const world = new THREE.Vector3();
  const scale = new THREE.Vector3();
  let time = 0;
  let appear = 0;
  let breaking = -1;
  let updatedSinceRender = false;
  let lastRender = 0;
  let burst = false;

  const shatter = () => {
    holder.getWorldPosition(world);
    holder.getWorldScale(scale);
    const r = radius * scale.x;
    field.anchor.copy(world);
    const flash = field.spawn(KIND.GLOW);
    if (flash) {
      flash.x = world.x;
      flash.y = world.y;
      flash.z = world.z;
      flash.size = r * 3.2;
      flash.life = 0.2;
      flash.tag = 1;
    }
    for (let i = 0; i < budget(60); i++) {
      const p = field.spawn(i % 3 === 0 ? KIND.SPARK : KIND.STAR);
      if (!p) break;
      const d = randomDir(new THREE.Vector3());
      p.x = world.x + d.x * r;
      p.y = world.y + d.y * r;
      p.z = world.z + d.z * r;
      const speed = range(2, 6);
      p.vx = d.x * speed;
      p.vy = d.y * speed + 1;
      p.vz = d.z * speed;
      p.gravity = 6;
      p.drag = 2.5;
      p.life = range(0.25, 0.5);
      p.size = p.kind === KIND.STAR ? range(0.05, 0.14) : range(0.012, 0.025);
      p.u0 = rand();
      p.tag = 2;
    }
  };

  const tick = (dt: number) => {
    time += dt;
    if (breaking >= 0) {
      breaking += dt / 0.42;
      if (!burst) {
        burst = true;
        shatter();
      }
    } else {
      appear = Math.min(1, appear + dt / 0.55);
    }
    shared.uTime.value = time;
    shared.uAppear.value = appear;
    shared.uBreak.value = Math.max(0, Math.min(1, breaking));
    field.step(dt);
    for (const p of field.particles) {
      const x = p.age / p.life;
      if (p.tag === 1) {
        const level = 2.2 * Math.pow(1 - x, 2);
        p.r = color.r * level;
        p.g = color.g * level;
        p.b = color.b * level;
      } else {
        // Droplets: thin film glints in the colours of the bubble.
        const hue = 0.5 + 0.5 * Math.sin(p.u0 * 12 + time * 8);
        const level = 2.4 * (1 - x) * (p.kind === KIND.STAR ? 1 : 3);
        p.r = (0.6 + 0.4 * hue) * level;
        p.g = (0.75 + 0.25 * (1 - hue)) * level;
        p.b = level;
        p.param = 0.5;
        if (p.kind === KIND.SPARK) {
          p.sx = p.vx / 40;
          p.sy = p.vy / 40;
          p.sz = p.vz / 40;
        }
      }
    }
    field.write();
  };

  // The race stops calling update() once it has called finish(), so the
  // bubble also keeps its own clock while it is being drawn.
  front.onBeforeRender = (renderer, scene, camera) => {
    observeFrame(renderer, scene, camera);
    const now = performance.now() / 1000;
    if (!updatedSinceRender && lastRender > 0) tick(Math.min(0.05, now - lastRender));
    updatedSinceRender = false;
    lastRender = now;
  };

  return {
    object: holder,
    update(dt) {
      updatedSinceRender = true;
      tick(dt);
      return breaking < 1 || field.count > 0;
    },
    finish() {
      if (breaking < 0) breaking = 0;
    },
    dispose() {
      (back.material as THREE.Material).dispose();
      (front.material as THREE.Material).dispose();
      field.dispose();
    },
  };
}
