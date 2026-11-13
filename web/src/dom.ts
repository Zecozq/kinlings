// Small helpers for building the panels.

import { drawAcorn, drawCrop, drawTonic } from "./art.ts";
import { COLOURS, drawEgg, drawKin, sizeForLevel } from "./creature.ts";
import { ACORN, TONIC, WILD_EGG, kinLevel, type Kin } from "./world.ts";
import { eggPortrait, itemPortrait, kinPortrait } from "./three/portrait.ts";

type Child = Node | string | number | null | undefined | false;

export function el(tag: string, attrs: Record<string, unknown> = {}, ...children: Child[]): HTMLElement {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (key === "class") {
      node.className = String(value);
    } else if (key === "html") {
      node.innerHTML = String(value);
    } else if (key === "disabled") {
      if (value) node.setAttribute("disabled", "");
    } else if (value !== undefined && value !== null && value !== false) {
      node.setAttribute(key, String(value));
    }
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === "number" ? String(child) : child);
  }
  return node;
}

export function $(id: string): HTMLElement {
  return document.getElementById(id)!;
}

function sized(width: number, height: number, draw: (ctx: CanvasRenderingContext2D) => void): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  const ratio = Math.min(devicePixelRatio || 1, 2);
  canvas.width = width * ratio;
  canvas.height = height * ratio;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const ctx = canvas.getContext("2d")!;
  ctx.scale(ratio, ratio);
  draw(ctx);
  return canvas;
}

export function itemIcon(item: number, size = 34): HTMLCanvasElement {
  const canvas3d = itemPortrait(item, size);
  if (canvas3d) return canvas3d;
  return sized(size, size, (ctx) => {
    ctx.translate(size / 2, size * 0.56);
    if (item === ACORN) {
      drawAcorn(ctx, size * 0.92);
    } else if (item === TONIC) {
      drawTonic(ctx, size * 0.92);
    } else if (item === WILD_EGG) {
      ctx.scale(size / 104, size / 104);
      drawEgg(ctx, COLOURS[5][1], COLOURS[4][1], 21, 0, 0, 0);
    } else {
      ctx.translate(0, size * 0.34);
      const scale = size / 88;
      ctx.scale(scale, scale);
      drawCrop(ctx, item, 3, 0, 0);
    }
  });
}

export function portrait(kin: Kin, size = 110, levelOverride?: number): HTMLCanvasElement {
  const canvas3d = kinPortrait(kin.look, { size, level: levelOverride ?? kinLevel(kin.xp), generation: kin.generation });
  if (canvas3d) return canvas3d;
  return sized(size, size, (ctx) => {
    ctx.translate(size * 0.53, size * 0.57);
    const scale = size / 270;
    ctx.scale(scale, scale);
    drawKin(ctx, kin.look, { t: 0, size: sizeForLevel(levelOverride ?? kinLevel(kin.xp)) });
  });
}

export function eggIcon(a: string, b: string, seed: number, size = 60): HTMLCanvasElement {
  const canvas3d = eggPortrait(a, b, seed, size);
  if (canvas3d) return canvas3d;
  return sized(size, size, (ctx) => {
    ctx.translate(size / 2, size / 2);
    ctx.scale(size / 104, size / 104);
    drawEgg(ctx, a, b, seed, 0, 0, 0);
  });
}

const svg = (body: string) =>
  `<svg viewBox="0 0 40 40" fill="none" stroke="#4a3322" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

export const ICONS = {
  kin: svg(
    `<ellipse cx="19" cy="25" rx="13" ry="9" fill="#7fb069"/><circle cx="27" cy="15" r="8" fill="#7fb069"/><circle cx="29" cy="14" r="1.7" fill="#4a3322"/><path d="M23 8l-2-5M31 8l2-5"/>`,
  ),
  heart: svg(`<path d="M20 34S5 25 5 14a8 8 0 0 1 15-3 8 8 0 0 1 15 3c0 11-15 20-15 20Z" fill="#ee8fa4"/>`),
  basket: svg(
    `<path d="M6 17h28l-4 17H10L6 17Z" fill="#d7a86a"/><path d="M12 17a8 11 0 0 1 16 0"/><path d="M15 23v6M20 23v6M25 23v6"/>`,
  ),
  flag: svg(`<path d="M10 36V5" /><path d="M10 6h20l-5 7 5 7H10" fill="#e76f51"/>`),
  book: svg(
    `<path d="M20 9c-5-4-10-4-15-2v25c5-2 10-2 15 2 5-4 10-4 15-2V7c-5-2-10-2-15 2Z" fill="#a6d6ee"/><path d="M20 9v25"/>`,
  ),
  barn: svg(`<path d="M5 18 20 6l15 12v16H5V18Z" fill="#c9573f"/><path d="M15 34V22h10v12"/>`),
  plus: svg(`<path d="M20 8v24M8 20h24"/>`),
};
