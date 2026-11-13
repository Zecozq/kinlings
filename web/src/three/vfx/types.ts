import type * as THREE from "three";

/** Add object to the scene, call update(dt) each frame, and dispose when update returns false. */
export interface Effect {
  object: THREE.Object3D;
  update(dt: number): boolean;
  dispose(): void;
}

/** An effect that lasts until finish() is called, then winds down by itself. */
export interface ShieldEffect extends Effect {
  finish(): void;
}
