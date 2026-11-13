// Race effects: the eight powers, hits, pickups' glow, dust and speed.
// track.ts re-exports everything here, so imports from it keep working.
// The effects themselves live in ./vfx/ (one file per power, and core.ts).
//
// LOOK  Everything is generated in code. Fire, sparks and lightning glow at
//   the colour and relative brightness of their temperature (blackbody), so
//   bloom reads as heat; smoke, dust and mist are lit by the scene's own sun,
//   sky and borrowed effect lights; small sparks keep at least a pixel and
//   are motion-blurred against the camera's real movement.
//
// EFFECTS  All return an Effect: { object: THREE.Object3D, update(dt): boolean, dispose() }
//   Add object to the scene, call update(dt) each frame, and remove and dispose
//   the effect when update returns false. Move an effect by setting object.position.
//   createFireball({ scale? })       a roiling fireball with smoke, embers and a
//                                    launch flash where it first appears;
//                                    effect.explode(parent) spawns and returns
//                                    the explosion Effect at its position.
//   createFrostCloud(position, { radius?, burst?, direction?, source? })
//                                    radius >= 3 (or burst: false): frost breath rolling
//                                    from `source` (default 8 m back along -direction)
//                                    into a bank that settles as low fog; radius < 3
//                                    (or burst: true): ice shards burst off a hit racer.
//   createLightning(from, to, { extend? })   a branching bolt about 0.5 s long, carried
//                                    on up past `from` (x extend, default 2.4) so it
//                                    comes out of the sky; leaves a scorch for ~3 s.
//   createWindDash(position, direction, { length?, burst? })   moving air: vapour
//                                    streams and motion-blurred motes; burst (default
//                                    length >= 10) adds the ground kick and vapour ring.
//   createShieldBubble({ radius?, color? })   lasts until effect.finish(), then
//                                    shatters in 0.42 s (it keeps animating even if
//                                    update() is no longer called); parent its object
//                                    to a Kinling's group.
//   createVineTrap(position, { radius?, lurk? })   vines burst up, coil and grip;
//                                    lurk: true lies coiled low as a waiting snare.
//                                    effect.finish() withers them away (0.6 s).
//   createBlinkShimmer(position, { color?, mode? })   mode "depart" implodes, "arrive"
//                                    pops with a lens flare and motes collapse onto
//                                    the body, "pop" (default) is a short version of both.
//   createDustPuffs(position, { count? })     dust and dirt clods from feet.
//
//   New, for the race to wire in (see each file for details):
//   createExplosion(position, scale?, carry?)  the fireball's explosion on its own.
//   createFireLaunch(position, direction, { scale? })  a muzzle flash at a mouth.
//   createBurnAura({ height? })      flames, smoke and embers on a burned racer.
//   createFrostAura({ height? })     freezing mist and ice glints on a chilled racer.
//   createShockAura({ height? })     arcs crawling over a stunned racer.
//     The three auras are ShieldEffects: parent the object to the racer's group,
//     update each frame, finish() when the state ends, dispose when update is false.
//   createSecondWind({ height?, color? })  Second Wind: parent to the racer's group,
//                                    update each frame; ends by itself (~1.6 s).
//   createImpactSparks(position, { count?, kelvin?, scale? })  a generic hit burst.
//   setEffectQuality(quality)        tell the effects the race's quality (low halves
//                                    particle counts); call before warming up.
//   seedEffects(seed | null)         repeatable randomness, for tests.
//
// LIGHTS   installEffectLights(scene, count?) puts a fixed pool of point lights in the
//   scene once. Effects borrow from it (only once they start updating, so warm-up
//   copies never hold one). Never add or remove lights while a race runs: a change
//   in the number of lights recompiles every lit material and freezes the game.
//
// SHADERS  All particles of all effects share one material and program; the bolt,
//   ice, bubble and vine shaders are one program each. Every create* above builds
//   its materials when called, so warm-up (track.ts) compiles them all. None of them
//   depends on the scene's light count, fog or environment map.

import * as THREE from "three";

export type { Effect, ShieldEffect } from "./vfx/types.ts";
export { installEffectLights, seedEffects, setEffectQuality } from "./vfx/core.ts";
export { createBurnAura, createExplosion, createFireLaunch, createFireball, type FireballEffect } from "./vfx/fire.ts";
export { createFrostAura, createFrostCloud, type FrostOptions } from "./vfx/frost.ts";
export { createLightning, createShockAura } from "./vfx/storm.ts";
export { createWindDash, type WindOptions } from "./vfx/wind.ts";
export { createShieldBubble } from "./vfx/shield.ts";
export { createVineTrap, type VineOptions } from "./vfx/vines.ts";
export { createBlinkShimmer, createSecondWind, type BlinkOptions } from "./vfx/blink.ts";
export { createDustPuffs, createImpactSparks } from "./vfx/dust.ts";

function canvasTexture(width: number, height: number, draw: (ctx: CanvasRenderingContext2D) => void) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  draw(canvas.getContext("2d")!);
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 4;
  return texture;
}

/** A soft additive glow sprite (used by the pickups). */
export function createHaloSprite(color: THREE.Color, size: number) {
  const material = new THREE.SpriteMaterial({
    map: glowTexture(),
    color,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    transparent: true,
  });
  const sprite = new THREE.Sprite(material);
  sprite.scale.setScalar(size);
  return sprite;
}

let glowMap: THREE.CanvasTexture | null = null;
export function glowTexture() {
  if (glowMap) return glowMap;
  glowMap = canvasTexture(128, 128, (ctx) => {
    const gradient = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    gradient.addColorStop(0, "rgba(255,255,255,1)");
    gradient.addColorStop(0.3, "rgba(255,255,255,.45)");
    gradient.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 128, 128);
  });
  return glowMap;
}
