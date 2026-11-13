// Test page for the food icons: open food-test.html, or food-test.html?one=10&size=420
// to look at one icon large. Reports how long each icon took to render.

import * as THREE from "three";
import { getStudio, itemPortrait, kinPortrait } from "./portrait.ts";
import { lookFromGenes } from "../creature.ts";
import { foodModel, makeProduceMaterial } from "./crops.ts";

// ?kins=1 shows creature portraits as the panels draw them (size with &size=).
if (new URLSearchParams(location.search).get("kins") === "1") {
  const size = Number(new URLSearchParams(location.search).get("size") ?? 220);
  const mk = (h: number, ho: number, w: number, t: number, pa: number, e: number, m: number, a: number, shiny = 0) => lookFromGenes([h, h, ho, ho, w, w, t, t, pa, pa, e, e, m, m, a, a, 3, 0, 3, 0, 3, 0, shiny]);
  const looks = [mk(0, 1, 1, 0, 3, 0, 2, 4), mk(2, 2, 0, 2, 0, 2, 9, 3), mk(3, 0, 2, 2, 0, 3, 4, 11), mk(1, 0, 0, 1, 0, 2, 4, 9), mk(4, 0, 0, 1, 4, 0, 9, 1), mk(3, 5, 3, 4, 0, 0, 2, 4, 1), mk(1, 3, 4, 1, 1, 1, 5, 14), mk(4, 4, 0, 0, 3, 3, 8, 15)];
  const host = document.getElementById("grid")!;
  host.style.gridTemplateColumns = "repeat(4, 1fr)";
  const t0 = performance.now();
  looks.forEach((look, i) => {
    const c = kinPortrait(look, { size, level: 6, generation: i === 5 ? 8 : i === 1 ? 3 : 0 });
    if (c) host.append(c);
  });
  console.info("portrait ms", Math.round(performance.now() - t0));
}

// ?scenario=1 behaves like the game: one small icon at start-up, then after the
// background warm-up every food at bag size. Times both steps.
if (new URLSearchParams(location.search).get("scenario") === "1") {
  const t0 = performance.now();
  const first = itemPortrait(0, 28);
  const firstMs = Math.round(performance.now() - t0);
  if (first) document.getElementById("grid")!.append(first);
  const frames: number[] = [];
  let last = performance.now();
  const watch = () => {
    const now = performance.now();
    frames.push(now - last);
    last = now;
    if (frames.length < 900) requestAnimationFrame(watch);
  };
  requestAnimationFrame(watch);
  setTimeout(() => {
    const t1 = performance.now();
    for (let item = 0; item < 12; item++) {
      const c = itemPortrait(item, 40);
      if (c) document.getElementById("grid")!.append(c);
    }
    const allMs = Math.round(performance.now() - t1);
    const long = frames.filter((f) => f > 50).map((f) => Math.round(f));
    console.info("scenario ms", JSON.stringify({ firstMs, allMs, longFrames: long.slice(0, 20), frames: frames.length }));
  }, 14000);
}

// ?compile=1 times the first draw of several material variants (compile cost).
if (new URLSearchParams(location.search).get("compile") === "1") {
  const s = getStudio();
  if (s) {
    const gl = s.renderer.getContext();
    const sphere = new THREE.SphereGeometry(1, 16, 12);
    const variants: [string, () => THREE.Material][] = [
      ["standard", () => new THREE.MeshStandardMaterial()],
      ["physical cc+sheen", () => new THREE.MeshPhysicalMaterial({ clearcoat: 1, sheen: 1 })],
      ["produce plain", () => makeProduceMaterial()],
      ["produce plain again", () => makeProduceMaterial(undefined, { tint: "#ff0000" })],
    ];
    const out: Record<string, number> = {};
    for (const [name, make] of variants) {
      const mesh = new THREE.Mesh(sphere, make());
      s.food.scene.add(mesh);
      const t0 = performance.now();
      s.draw(s.food.scene, s.food.camera, 64, 64);
      gl.finish();
      out[name] = Math.round(performance.now() - t0);
      s.food.scene.remove(mesh);
    }
    console.info("compile ms", JSON.stringify(out));
  }
}

// ?timing=1 splits each icon's first render into model build and shader compile.
if (new URLSearchParams(location.search).get("timing") === "1") {
  const s = getStudio();
  const split: Record<number, [number, number]> = {};
  if (s) {
    for (let item = 0; item < 12; item++) {
      const t0 = performance.now();
      const model = foodModel(item);
      const t1 = performance.now();
      if (!model) continue;
      s.food.scene.add(model.group);
      s.renderer.compile(s.food.scene, s.food.camera);
      const t2 = performance.now();
      s.food.scene.remove(model.group);
      model.dispose();
      split[item] = [Math.round(t1 - t0), Math.round(t2 - t1)];
    }
  }
  console.info("build/compile ms", JSON.stringify(split));
}

const NAMES = ["Acorn", "Sunwheat", "Dewbean", "Emberroot", "Frostberry", "Moonmelon", "Starfig", "Warmth Tonic", "Wild Egg", "Glowcap", "Dragonfruit", "Stardust Honey"];
const params = new URLSearchParams(location.search);
const grid = document.getElementById("grid")!;
const small = document.getElementById("small")!;
const info = document.getElementById("info")!;
const timings: Record<string, number> = {};

function cell(item: number, size: number): HTMLElement {
  const box = document.createElement("div");
  box.className = "cell";
  const t0 = performance.now();
  const canvas = itemPortrait(item, size);
  timings[`${item}@${size}`] = Math.round(performance.now() - t0);
  if (canvas) box.append(canvas);
  const label = document.createElement("span");
  label.textContent = NAMES[item] ?? String(item);
  box.append(label);
  return box;
}

const one = params.get("one");
if (one !== null) {
  const size = Number(params.get("size") ?? 420);
  grid.style.gridTemplateColumns = "1fr";
  const items = one.split(",").map(Number);
  grid.style.gridTemplateColumns = `repeat(${Math.min(items.length, 4)}, 1fr)`;
  for (const item of items) grid.append(cell(item, size));
} else if (!params.has("scenario") && !params.has("kins")) {
  const big = Number(params.get("size") ?? 180);
  for (let item = 0; item < 12; item++) grid.append(cell(item, big));
  for (const [size, cls] of [[28, ""], [34, "chip"], [40, ""], [40, "dark"]] as const) {
    const row = document.createElement("div");
    row.className = `row ${cls === "dark" ? "dark" : ""}`;
    for (let item = 0; item < 12; item++) {
      const wrap = document.createElement("span");
      wrap.className = cls === "chip" ? "chip" : "";
      const t0 = performance.now();
      const canvas = itemPortrait(item, size);
      timings[`${item}@${size}`] = Math.round(performance.now() - t0);
      if (canvas) wrap.append(canvas);
      if (cls === "chip") wrap.append(document.createTextNode("12"));
      row.append(wrap);
    }
    small.append(row);
  }
}
const total = Object.values(timings).reduce((a, b) => a + b, 0);
info.textContent = `render ${total} ms`;
console.info("icon ms", JSON.stringify(timings), "total", total);
Object.assign(window, { foodTimings: timings });
