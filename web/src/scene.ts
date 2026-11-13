// The valley itself: one long road of farms, drawn on a canvas.

import { drawCottage, drawCrop, drawNest, drawSign, plotSoil } from "./art.ts";
import { COLOURS, drawEgg, drawKin, shade, sizeForLevel } from "./creature.ts";
import { cropInfo, kinLevel, farmerRank, type Egg, type Farm, type Kin } from "./world.ts";
import type { Game } from "./game.ts";

export const LOT = 1240;
const VIRTUAL_HEIGHT = 720;
const GROUND_Y = 360;
const PLOT_ROWS = [478, 572];
const PLOT_FIRST_X = 430;
const PLOT_GAP = 116;
const NEST = { x: 1120, y: 520 };
const COTTAGE = { x: 215, y: 470 };
const SIGN = { x: 66, y: 640 };
const WALK_AREA = { left: 90, right: 1180, top: 618, bottom: 672 };
const ROOFS = ["#c9573f", "#5f8f9e", "#8d6bb0", "#c98b3a", "#6f9a5a", "#b5536e"];
const DAY_LENGTH = 600;

export type Hit =
  | { kind: "plot"; farm: number; slot: number }
  | { kind: "egg"; farm: number; egg: number }
  | { kind: "kin"; farm: number; id: number }
  | { kind: "sign"; farm: number };

interface Actor {
  id: number;
  x: number;
  y: number;
  dir: number;
  targetX: number;
  targetY: number;
  pause: number;
  stride: number;
  joy: number;
  blinkAt: number;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  size: number;
  colour: string;
  gravity: number;
}

interface FloatText {
  x: number;
  y: number;
  text: string;
  colour: string;
  life: number;
}

interface Drawable {
  y: number;
  draw: () => void;
}

function layer(width: number, height: number, paint: (ctx: CanvasRenderingContext2D) => void): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  paint(canvas.getContext("2d")!);
  return canvas;
}

function ridge(width: number, base: number, swells: [number, number, number][]) {
  return (x: number) => {
    let y = base;
    for (const [amplitude, waves, phase] of swells) y += Math.sin((x / width) * Math.PI * 2 * waves + phase) * amplitude;
    return y;
  };
}

function fillRidge(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  curve: (x: number) => number,
  top: string,
  bottom: string,
) {
  const gradient = ctx.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, top);
  gradient.addColorStop(1, bottom);
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.moveTo(0, height);
  for (let x = 0; x <= width; x += 8) ctx.lineTo(x, curve(x));
  ctx.lineTo(width, height);
  ctx.closePath();
  ctx.fill();
}

function tree(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, colour: string) {
  ctx.fillStyle = shade(colour, -0.35);
  ctx.fillRect(x - size * 0.12, y - size * 0.8, size * 0.24, size * 0.8);
  ctx.fillStyle = colour;
  for (const [ox, oy, r] of [[0, -1.3, 0.7], [-0.45, -0.95, 0.52], [0.45, -0.95, 0.52]]) {
    ctx.beginPath();
    ctx.arc(x + ox * size, y + oy * size, r * size, 0, Math.PI * 2);
    ctx.fill();
  }
}

function mix(a: number[], b: number[], amount: number): string {
  return `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * amount)).join(",")})`;
}

// Sky colours through the day: [top, horizon].
const SKY = {
  day: [[132, 203, 232], [253, 240, 205]],
  dusk: [[108, 100, 170], [250, 170, 120]],
  night: [[24, 32, 74], [58, 64, 120]],
};

export class Scene {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
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
  /** Used when filming: how close the camera is and what height it looks at. */
  private zoom = 1;
  private zoomTarget = 1;
  private focusY = VIRTUAL_HEIGHT / 2;
  private last = 0;
  private actors = new Map<number, Actor>();
  private particles: Particle[] = [];
  private floats: FloatText[] = [];
  private bubbles = new Map<number, { text: string; life: number }>();
  private wobbles = new Map<number, number>();
  private cracks = new Map<number, number>();
  private hover: Hit | null = null;
  private dragFrom: { x: number; camera: number; moved: boolean } | null = null;
  private mountains: HTMLCanvasElement;
  private farHills: HTMLCanvasElement;
  private nearHills: HTMLCanvasElement;
  private ground: HTMLCanvasElement;
  private clouds: { x: number; y: number; size: number; speed: number }[] = [];
  private stars: { x: number; y: number; size: number }[] = [];

  constructor(canvas: HTMLCanvasElement, game: Game) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
    this.game = game;
    this.mountains = this.paintMountains();
    this.farHills = this.paintFarHills();
    this.nearHills = this.paintNearHills();
    this.ground = this.paintGround();
    for (let i = 0; i < 9; i++) {
      this.clouds.push({ x: Math.random() * 2600, y: 40 + Math.random() * 150, size: 34 + Math.random() * 46, speed: 4 + Math.random() * 7 });
    }
    for (let i = 0; i < 90; i++) this.stars.push({ x: Math.random() * 2400, y: Math.random() * 300, size: 0.6 + Math.random() * 1.6 });
    this.resize();
    addEventListener("resize", () => this.resize());
    this.bindInput();
    requestAnimationFrame((time) => this.frame(time));
  }

  resize() {
    this.dpr = Math.min(devicePixelRatio || 1, 2);
    this.width = innerWidth;
    this.height = innerHeight;
    this.canvas.width = this.width * this.dpr;
    this.canvas.height = this.height * this.dpr;
    // A phone held upright gets a closer view, and you swipe along the farm.
    const upright = this.width / this.height < 0.8;
    this.scale = Math.min(this.height / VIRTUAL_HEIGHT, this.width / (upright ? 460 : 760));
    this.yOffset = this.height / this.scale - VIRTUAL_HEIGHT;
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

  // ----- Effects ---------------------------------------------------------

  burst(x: number, y: number, colour: string, count = 12) {
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 60 + Math.random() * 170;
      this.particles.push({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 70,
        life: 0.55 + Math.random() * 0.4,
        max: 0.9,
        size: 3 + Math.random() * 5,
        colour,
        gravity: 460,
      });
    }
  }

  splash(x: number, y: number) {
    for (let i = 0; i < 12; i++) {
      this.particles.push({
        x: x - 40 + Math.random() * 80,
        y: y - 60 - Math.random() * 30,
        vx: 0,
        vy: 150 + Math.random() * 80,
        life: 0.45,
        max: 0.45,
        size: 3.4,
        colour: "#8fd3f4",
        gravity: 300,
      });
    }
  }

  float(x: number, y: number, text: string, colour = "#fff6d0") {
    this.floats.push({ x, y, text, colour, life: 1.25 });
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

  /** Where a thing is on the screen, for placing popups. */
  plotCentre(farm: number, slot: number) {
    const { x, y } = this.plotPosition(farm, slot);
    return { x, y };
  }

  toScreen(x: number, y: number) {
    return { x: (x - this.camera) * this.scale + this.width / 2, y: (y + this.yOffset) * this.scale };
  }

  // ----- Layout ----------------------------------------------------------

  private plotPosition(farm: number, slot: number) {
    const row = slot < 6 ? 0 : 1;
    const column = slot % 6;
    return { x: farm * LOT + PLOT_FIRST_X + column * PLOT_GAP + row * 14, y: PLOT_ROWS[row] };
  }

  private eggPosition(farm: number, index: number) {
    return { x: farm * LOT + NEST.x - 42 + index * 42, y: NEST.y - 26 - (index === 1 ? 6 : 0) };
  }

  private screenToWorld(screenX: number, screenY: number) {
    return { x: (screenX - this.width / 2) / this.scale + this.camera, y: screenY / this.scale - this.yOffset };
  }

  private hitAt(screenX: number, screenY: number): Hit | null {
    const view = this.game.view;
    if (!view) return null;
    const { x, y } = this.screenToWorld(screenX, screenY);
    const lotIndex = Math.floor(x / LOT);
    const farm = view.farms.get(lotIndex);
    if (!farm) return null;

    for (const id of farm.kins) {
      const actor = this.actors.get(id);
      const kin = view.kins.get(id);
      if (!actor || !kin) continue;
      const reach = 72 * sizeForLevel(kinLevel(kin.xp));
      if (Math.abs(x - actor.x) < reach && y > actor.y - reach * 1.5 && y < actor.y + 34) {
        return { kind: "kin", farm: lotIndex, id };
      }
    }
    for (let index = 0; index < farm.eggs.length; index++) {
      const position = this.eggPosition(lotIndex, index);
      if (Math.hypot(x - position.x, y - position.y) < 56) return { kind: "egg", farm: lotIndex, egg: farm.eggs[index] };
    }
    for (let slot = 0; slot < farm.plots.length; slot++) {
      const position = this.plotPosition(lotIndex, slot);
      if (Math.abs(x - position.x) < 58 && y > position.y - 78 && y < position.y + 30) {
        return { kind: "plot", farm: lotIndex, slot };
      }
    }
    if (Math.abs(x - (lotIndex * LOT + SIGN.x)) < 90 && y > SIGN.y - 110 && y < SIGN.y) {
      return { kind: "sign", farm: lotIndex };
    }
    return null;
  }

  // ----- Painting the world once ------------------------------------------

  private paintMountains() {
    const width = 2600;
    return layer(width, 420, (ctx) => {
      const curve = ridge(width, 300, [
        [58, 3, 0.4],
        [36, 7, 1.1],
        [16, 15, 2.1],
      ]);
      fillRidge(ctx, width, 420, curve, "#a8b7dc", "#d6dff2");
      // The old volcano the dragons came from.
      const x = 900;
      ctx.fillStyle = "#8d94c2";
      ctx.beginPath();
      ctx.moveTo(x - 280, 340);
      ctx.quadraticCurveTo(x - 120, 200, x - 50, 96);
      ctx.lineTo(x + 50, 96);
      ctx.quadraticCurveTo(x + 120, 200, x + 280, 340);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = "#f2a062";
      ctx.beginPath();
      ctx.moveTo(x - 50, 96);
      ctx.quadraticCurveTo(x, 118, x + 50, 96);
      ctx.quadraticCurveTo(x, 86, x - 50, 96);
      ctx.fill();
    });
  }

  private paintFarHills() {
    const width = 2400;
    return layer(width, 420, (ctx) => {
      const curve = ridge(width, 330, [
        [34, 4, 0.8],
        [18, 9, 2.3],
      ]);
      fillRidge(ctx, width, 420, curve, "#9fcf9a", "#bedfaa");
      for (let x = 30; x < width; x += 58 + (x % 47)) tree(ctx, x, curve(x) + 8, 15 + (x % 13), "#74ad78");
    });
  }

  private paintNearHills() {
    const width = 2600;
    return layer(width, 420, (ctx) => {
      const curve = ridge(width, 352, [
        [26, 5, 2.2],
        [12, 13, 0.3],
      ]);
      fillRidge(ctx, width, 420, curve, "#83bf6c", "#a7d67f");
      for (let x = 60; x < width; x += 170 + (x % 91)) tree(ctx, x, curve(x) + 8, 24 + (x % 17), "#5e9c55");

      // A windmill on the ridge.
      const mx = 1380;
      const my = curve(mx) + 6;
      ctx.fillStyle = "#e9d7b1";
      ctx.beginPath();
      ctx.moveTo(mx - 24, my);
      ctx.lineTo(mx - 15, my - 84);
      ctx.lineTo(mx + 15, my - 84);
      ctx.lineTo(mx + 24, my);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = "#a07a50";
      ctx.lineWidth = 6;
      for (let i = 0; i < 4; i++) {
        const angle = (i * Math.PI) / 2 + 0.3;
        ctx.beginPath();
        ctx.moveTo(mx, my - 88);
        ctx.lineTo(mx + Math.cos(angle) * 54, my - 88 + Math.sin(angle) * 54);
        ctx.stroke();
      }
    });
  }

  private paintGround() {
    return layer(LOT, VIRTUAL_HEIGHT - GROUND_Y, (ctx) => {
      const height = VIRTUAL_HEIGHT - GROUND_Y;
      const gradient = ctx.createLinearGradient(0, 0, 0, height);
      gradient.addColorStop(0, "#9ccf73");
      gradient.addColorStop(0.5, "#86c063");
      gradient.addColorStop(1, "#6fae55");
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, LOT, height);

      let seed = 7;
      const random = () => {
        seed = (seed * 16807) % 2147483647;
        return seed / 2147483647;
      };
      for (let i = 0; i < 60; i++) {
        ctx.fillStyle = `rgba(${random() > 0.5 ? "255,255,200" : "60,110,50"},${0.05 + random() * 0.07})`;
        const x = random() * LOT;
        const y = random() * height;
        const radiusX = 30 + random() * 90;
        const radiusY = 8 + random() * 18;
        // Painted three times over so the tile joins up with its neighbours.
        for (const wrap of [-LOT, 0, LOT]) {
          ctx.beginPath();
          ctx.ellipse(x + wrap, y, radiusX, radiusY, 0, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // The road.
      ctx.fillStyle = "#e0c28d";
      ctx.beginPath();
      ctx.moveTo(0, height - 42);
      for (let x = 0; x <= LOT; x += 20) ctx.lineTo(x, height - 42 + Math.sin((x / LOT) * Math.PI * 4) * 4);
      ctx.lineTo(LOT, height);
      ctx.lineTo(0, height);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = "rgba(160,120,70,.25)";
      for (let i = 0; i < 40; i++) {
        ctx.beginPath();
        ctx.ellipse(random() * LOT, height - 30 + random() * 28, 4 + random() * 9, 1.6 + random() * 2, 0, 0, Math.PI * 2);
        ctx.fill();
      }

      // Tufts and small flowers.
      for (let i = 0; i < 90; i++) {
        const x = random() * LOT;
        const y = 30 + random() * (height - 80);
        ctx.strokeStyle = "rgba(70,120,50,.55)";
        ctx.lineWidth = 2.2;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x - 4, y - 9);
        ctx.moveTo(x, y);
        ctx.lineTo(x + 4, y - 9);
        ctx.stroke();
        if (random() > 0.72) {
          ctx.fillStyle = ["#fff6d0", "#f6b6c8", "#f7d774"][Math.floor(random() * 3)];
          ctx.beginPath();
          ctx.arc(x + 2, y - 12, 3, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    });
  }

  // ----- Each frame ------------------------------------------------------

  private dayPhase() {
    if (this.timeOverride !== null) return this.timeOverride;
    return ((Date.now() / 1000) % DAY_LENGTH) / DAY_LENGTH;
  }

  /** 0 at full day, 1 at deep night. */
  private nightness(phase: number) {
    if (phase < 0.62) return 0;
    if (phase < 0.72) return (phase - 0.62) / 0.1;
    if (phase < 0.92) return 1;
    return 1 - (phase - 0.92) / 0.08;
  }

  private frame(time: number) {
    const dt = Math.min(0.05, (time - this.last) / 1000 || 0.016);
    this.last = time;
    this.step(dt);
    this.render();
    requestAnimationFrame((next) => this.frame(next));
  }

  private step(dt: number) {
    this.t += dt;
    this.camera += (this.cameraTarget - this.camera) * Math.min(1, dt * 7);
    this.zoom += (this.zoomTarget - this.zoom) * Math.min(1, dt * 2.2);
    for (const cloud of this.clouds) {
      cloud.x += cloud.speed * dt;
      if (cloud.x > 2700) cloud.x = -160;
    }
    for (const [egg, wobble] of this.wobbles) {
      const next = wobble - dt * 1.4;
      if (next <= 0) this.wobbles.delete(egg);
      else this.wobbles.set(egg, next);
    }
    for (const [farm, bubble] of this.bubbles) {
      bubble.life -= dt;
      if (bubble.life <= 0) this.bubbles.delete(farm);
    }
    this.particles = this.particles.filter((p) => {
      p.life -= dt;
      p.vy += p.gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      return p.life > 0;
    });
    this.floats = this.floats.filter((f) => {
      f.life -= dt;
      f.y -= 54 * dt;
      return f.life > 0;
    });
    this.stepActors(dt);
  }

  private stepActors(dt: number) {
    const view = this.game.view;
    if (!view) return;
    const present = new Set<number>();
    for (const farm of view.farms.values()) {
      for (const id of farm.kins) {
        present.add(id);
        let actor = this.actors.get(id);
        if (!actor) {
          const x = farm.index * LOT + WALK_AREA.left + Math.random() * (WALK_AREA.right - WALK_AREA.left);
          const y = WALK_AREA.top + Math.random() * (WALK_AREA.bottom - WALK_AREA.top);
          actor = { id, x, y, dir: Math.random() > 0.5 ? 1 : -1, targetX: x, targetY: y, pause: Math.random() * 3, stride: 0, joy: 0, blinkAt: 2 };
          this.actors.set(id, actor);
        }
        this.moveActor(actor, farm, dt);
      }
    }
    for (const id of this.actors.keys()) if (!present.has(id)) this.actors.delete(id);
  }

  private moveActor(actor: Actor, farm: Farm, dt: number) {
    actor.joy = Math.max(0, actor.joy - dt * 0.7);
    if (actor.blinkAt < this.t - 0.16) actor.blinkAt = this.t + 1.5 + Math.random() * 4;
    if (actor.pause > 0) {
      actor.pause -= dt;
      actor.stride = 0;
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
      return;
    }
    const speed = 46;
    actor.x += (dx / distance) * speed * dt;
    actor.y += (dy / distance) * speed * dt;
    actor.dir = dx >= 0 ? 1 : -1;
    actor.stride += dt * 9;
  }

  private render() {
    const { ctx, dpr } = this;
    const phase = this.dayPhase();
    const night = this.nightness(phase);
    this.drawSky(phase, night);

    const s = this.scale * this.zoom * dpr;
    const left = this.camera - this.viewWidth() / 2;
    const offsetY =
      this.zoom <= 1.001
        ? this.yOffset
        : this.height / (2 * this.scale * this.zoom) - (this.focusY + (this.yOffset - this.yOffset));
    ctx.setTransform(s, 0, 0, s, 0, offsetY * s);
    this.drawBackdrop(left, night);

    ctx.setTransform(s, 0, 0, s, -left * s, offsetY * s);
    this.drawGround(left);

    const view = this.game.view;
    if (view) {
      const drawables: Drawable[] = [];
      const first = Math.floor(left / LOT) - 1;
      const last = Math.floor((left + this.viewWidth()) / LOT) + 1;
      for (let index = first; index <= last; index++) {
        const farm = view.farms.get(index);
        if (farm) this.queueFarm(farm, drawables, night);
      }
      drawables.sort((a, b) => a.y - b.y);
      for (const item of drawables) item.draw();
    }

    this.drawParticles();
    this.drawFloats();
    if (night > 0) this.drawNightWash(night, left);
  }

  private drawSky(phase: number, night: number) {
    const { ctx, canvas } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    let top: string;
    let bottom: string;
    const evening = phase >= 0.55 && phase < 0.72 ? 1 - Math.abs(phase - 0.65) / 0.1 : 0;
    const morning = phase >= 0.9 || phase < 0.03 ? 1 - Math.min(Math.abs(phase - 0.97), Math.abs(phase + 0.03)) / 0.07 : 0;
    const warm = Math.max(0, Math.max(evening, morning));
    if (night >= 1) {
      top = mix(SKY.night[0], SKY.night[0], 1);
      bottom = mix(SKY.night[1], SKY.night[1], 1);
    } else {
      const dayTop = mix(SKY.day[0], SKY.dusk[0], warm);
      const dayBottom = mix(SKY.day[1], SKY.dusk[1], warm);
      if (night > 0) {
        const channel = (css: string) => css.match(/\d+/g)!.map(Number);
        top = mix(channel(dayTop), SKY.night[0], night);
        bottom = mix(channel(dayBottom), SKY.night[1], night);
      } else {
        top = dayTop;
        bottom = dayBottom;
      }
    }
    const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height * 0.72);
    gradient.addColorStop(0, top);
    gradient.addColorStop(1, bottom);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const s = this.scale * this.dpr;
    if (night > 0.05) {
      ctx.fillStyle = `rgba(255,255,235,${night * 0.9})`;
      for (const star of this.stars) {
        const x = ((star.x - this.camera * 0.04) % canvas.width + canvas.width) % canvas.width;
        ctx.beginPath();
        ctx.arc(x, star.y * s * 0.9, star.size * s * (0.75 + Math.sin(this.t * 2 + star.x) * 0.25), 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // The sun rises and sets. The moon takes its place at night.
    const daylight = Math.max(0, Math.min(1, phase / 0.68));
    if (night < 1) {
      const sunX = canvas.width * (0.1 + daylight * 0.82);
      const sunY = canvas.height * (0.48 - Math.sin(daylight * Math.PI) * 0.4);
      const glow = ctx.createRadialGradient(sunX, sunY, 8, sunX, sunY, 150 * s);
      glow.addColorStop(0, `rgba(255,247,200,${0.95 * (1 - night)})`);
      glow.addColorStop(1, "rgba(255,247,200,0)");
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = `rgba(255,236,170,${1 - night})`;
      ctx.beginPath();
      ctx.arc(sunX, sunY, 40 * s, 0, Math.PI * 2);
      ctx.fill();
    }
    if (night > 0) {
      const moonX = canvas.width * 0.72;
      const moonY = canvas.height * 0.2;
      ctx.fillStyle = `rgba(245,240,210,${night})`;
      ctx.beginPath();
      ctx.arc(moonX, moonY, 34 * s, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = mix([24, 32, 74], [24, 32, 74], 1);
      ctx.globalAlpha = night;
      ctx.beginPath();
      ctx.arc(moonX + 14 * s, moonY - 6 * s, 30 * s, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }

  private tile(image: HTMLCanvasElement, parallax: number, y: number, left: number) {
    const width = image.width;
    let x = -(((left * parallax) % width) + width) % width;
    const view = this.viewWidth();
    while (x < view) {
      this.ctx.drawImage(image, x, y);
      x += width;
    }
  }

  private drawBackdrop(left: number, night: number) {
    const { ctx } = this;
    ctx.fillStyle = mix([255, 255, 255], [84, 92, 146], night);
    for (const cloud of this.clouds) {
      const x = (((cloud.x - left * 0.12) % 2700) + 2700) % 2700 - 200;
      for (const [ox, oy, r] of [[0, 0, 1], [-0.9, 0.2, 0.68], [0.9, 0.24, 0.62], [0.4, -0.3, 0.7]]) {
        ctx.beginPath();
        ctx.arc(x + ox * cloud.size, cloud.y + oy * cloud.size, r * cloud.size, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    this.tile(this.mountains, 0.2, GROUND_Y - 330, left);
    this.drawVolcanoSmoke(left);
    this.tile(this.farHills, 0.42, GROUND_Y - 330, left);
    this.tile(this.nearHills, 0.68, GROUND_Y - 322, left);
  }

  private drawVolcanoSmoke(left: number) {
    const { ctx } = this;
    const width = this.mountains.width;
    const base = (((900 - left * 0.2) % width) + width) % width;
    ctx.fillStyle = "rgba(235,235,245,.55)";
    for (let i = 0; i < 6; i++) {
      const progress = ((this.t * 0.14 + i / 6) % 1);
      ctx.beginPath();
      ctx.arc(base + Math.sin(progress * 8 + i) * 16 + progress * 40, GROUND_Y - 240 - progress * 130, 10 + progress * 26, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private drawGround(left: number) {
    const start = Math.floor(left / LOT);
    const end = Math.floor((left + this.viewWidth()) / LOT);
    for (let index = start; index <= end; index++) this.ctx.drawImage(this.ground, index * LOT, GROUND_Y);
    this.ctx.fillStyle = "#8fc66a";
    this.ctx.fillRect(left - 10, VIRTUAL_HEIGHT - 1, this.viewWidth() + 20, 2);
  }

  private queueFarm(farm: Farm, drawables: Drawable[], night: number) {
    const view = this.game.view!;
    const originX = farm.index * LOT;
    const { ctx } = this;
    const now = this.game.chainNow();
    const mine = farm.index === view.me;
    const rank = farmerRank(farm.xp);

    drawables.push({
      y: COTTAGE.y,
      draw: () => {
        ctx.save();
        ctx.translate(originX + COTTAGE.x, COTTAGE.y);
        const scale = 0.72 + rank * 0.05;
        ctx.scale(scale, scale);
        drawCottage(ctx, ROOFS[farm.index % ROOFS.length], night > 0.4, rank);
        ctx.restore();
        this.drawChimney(originX + COTTAGE.x + 52 * (0.72 + rank * 0.05), COTTAGE.y - 150 * (0.72 + rank * 0.05), farm.index);
      },
    });

    drawables.push({
      y: SIGN.y,
      draw: () => {
        ctx.save();
        ctx.translate(originX + SIGN.x, SIGN.y);
        drawSign(ctx, mine ? `${farm.name} (you)` : farm.name, farm.elder, now - farm.seen < 180 && !farm.elder, mine);
        ctx.restore();
        const bubble = this.bubbles.get(farm.index);
        if (bubble) this.drawBubble(originX + SIGN.x + 20, SIGN.y - 132, bubble.text);
      },
    });

    farm.plots.forEach((plot, slot) => {
      const { x, y } = this.plotPosition(farm.index, slot);
      const hovering = this.hover?.kind === "plot" && this.hover.farm === farm.index && this.hover.slot === slot;
      drawables.push({
        y: y,
        draw: () => {
          ctx.save();
          ctx.translate(x, y);
          plotSoil(ctx, plot.waterings > 0 && plot.crop !== 0, hovering);
          if (plot.crop !== 0) {
            const info = cropInfo(plot.crop)!;
            const left = plot.readyAt - now;
            const progress = 1 - Math.max(0, left) / info.grow;
            const stage = left <= 0 ? 3 : progress < 0.34 ? 0 : progress < 0.7 ? 1 : 2;
            ctx.translate(0, -7);
            drawCrop(ctx, plot.crop, stage, this.t, slot + farm.index);
            if (stage === 3) this.drawRipeHint(slot);
          }
          ctx.restore();
        },
      });
    });

    drawables.push({
      y: NEST.y,
      draw: () => {
        ctx.save();
        ctx.translate(originX + NEST.x, NEST.y);
        drawNest(ctx);
        ctx.restore();
        farm.eggs.forEach((eggId, index) => {
          const egg = view.eggs.get(eggId);
          if (egg) this.drawNestEgg(egg, farm.index, index, now);
        });
      },
    });

    for (const id of farm.kins) {
      const kin = view.kins.get(id);
      const actor = this.actors.get(id);
      if (kin && actor) {
        drawables.push({ y: actor.y, draw: () => this.drawActor(kin, actor, mine) });
      }
    }
  }

  private drawRipeHint(slot: number) {
    const { ctx } = this;
    const bob = Math.sin(this.t * 4 + slot) * 3;
    ctx.fillStyle = "rgba(255,247,190,.9)";
    ctx.beginPath();
    ctx.arc(30, -66 + bob, 4.4, 0, Math.PI * 2);
    ctx.arc(-28, -54 - bob, 3, 0, Math.PI * 2);
    ctx.fill();
  }

  private drawChimney(x: number, y: number, seed: number) {
    const { ctx } = this;
    ctx.fillStyle = "rgba(245,245,250,.6)";
    for (let i = 0; i < 4; i++) {
      const progress = (this.t * 0.22 + i / 4 + seed * 0.13) % 1;
      ctx.beginPath();
      ctx.arc(x + Math.sin(progress * 7 + i) * 7 + progress * 22, y - progress * 62, 5 + progress * 11, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private drawNestEgg(egg: Egg, farm: number, index: number, now: number) {
    const { ctx } = this;
    const position = this.eggPosition(farm, index);
    const ready = egg.readyAt <= now;
    const shake = this.wobbles.get(egg.id) ?? (ready ? 0.34 * ((Math.sin(this.t * 1.5 + index) + 1) / 2 > 0.62 ? 1 : 0) : 0);
    const [a, b] = eggColours(egg, this.game);
    ctx.save();
    ctx.translate(position.x, position.y);
    ctx.scale(0.72, 0.72);
    if (egg.hatching) ctx.scale(1.08, 1.08);
    drawEgg(ctx, a, b, egg.id, this.t, egg.hatching ? 1 : shake, this.cracks.get(egg.id) ?? (egg.hatching ? 0.7 : 0));
    ctx.restore();
    if (!ready && !egg.hatching) {
      const left = Math.ceil(egg.readyAt - now);
      ctx.font = "600 17px Fredoka, sans-serif";
      ctx.textAlign = "center";
      ctx.lineWidth = 4;
      ctx.strokeStyle = "#3b2a1e";
      ctx.fillStyle = "#fff6e3";
      const label = left >= 60 ? `${Math.floor(left / 60)}m ${left % 60}s` : `${left}s`;
      ctx.strokeText(label, position.x, position.y - 42);
      ctx.fillText(label, position.x, position.y - 42);
    }
  }

  private drawActor(kin: Kin, actor: Actor, mine: boolean) {
    const { ctx } = this;
    const level = kinLevel(kin.xp);
    const size = sizeForLevel(level) * 0.7;
    ctx.save();
    ctx.translate(actor.x, actor.y);
    ctx.fillStyle = "rgba(40,50,20,.2)";
    ctx.beginPath();
    ctx.ellipse(0, 26 * size + 22, 60 * size, 13 * size, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.scale(actor.dir, 1);
    ctx.translate(0, -24 * size);
    drawKin(ctx, kin.look, {
      t: this.t,
      walk: actor.stride,
      blink: this.t > actor.blinkAt && this.t < actor.blinkAt + 0.16,
      joy: actor.joy,
      size,
    });
    ctx.restore();

    if (mine) {
      ctx.save();
      ctx.font = "600 15px Fredoka, sans-serif";
      ctx.textAlign = "center";
      ctx.lineWidth = 4;
      ctx.strokeStyle = "rgba(59,42,30,.85)";
      ctx.fillStyle = "#fff6e3";
      const label = capitalise(kin.name);
      ctx.strokeText(label, actor.x, actor.y + 47);
      ctx.fillText(label, actor.x, actor.y + 47);
      ctx.restore();
    }
  }

  private drawBubble(x: number, y: number, text: string) {
    const { ctx } = this;
    ctx.save();
    ctx.font = "600 17px Fredoka, sans-serif";
    const width = ctx.measureText(text).width + 26;
    ctx.fillStyle = "#fff6e3";
    ctx.strokeStyle = "#4a3322";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.roundRect(x - width / 2, y - 18, width, 36, 14);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x - 12, y + 17);
    ctx.lineTo(x - 20, y + 32);
    ctx.lineTo(x + 2, y + 17);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#3b2a1e";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, x, y);
    ctx.restore();
  }

  private drawParticles() {
    const { ctx } = this;
    for (const p of this.particles) {
      ctx.globalAlpha = Math.min(1, p.life / (p.max * 0.5));
      ctx.fillStyle = p.colour;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  private drawFloats() {
    const { ctx } = this;
    ctx.save();
    ctx.font = "700 25px Fredoka, sans-serif";
    ctx.textAlign = "center";
    ctx.lineJoin = "round";
    for (const float of this.floats) {
      ctx.globalAlpha = Math.min(1, float.life * 1.6);
      ctx.lineWidth = 6;
      ctx.strokeStyle = "#4a3322";
      ctx.strokeText(float.text, float.x, float.y);
      ctx.fillStyle = float.colour;
      ctx.fillText(float.text, float.x, float.y);
    }
    ctx.restore();
  }

  private drawNightWash(night: number, left: number) {
    const { ctx } = this;
    ctx.save();
    ctx.globalCompositeOperation = "multiply";
    ctx.fillStyle = mix([255, 255, 255], [138, 150, 205], night);
    ctx.fillRect(left - 10, -this.yOffset - 10, this.viewWidth() + 20, VIRTUAL_HEIGHT + this.yOffset + 20);
    ctx.restore();

    if (night > 0.3) {
      ctx.save();
      ctx.fillStyle = `rgba(214,250,140,${night * 0.85})`;
      for (let i = 0; i < 22; i++) {
        const x = left + ((i * 197.3 + Math.sin(this.t * 0.4 + i) * 90) % this.viewWidth());
        const y = 430 + ((i * 61.7) % 240) + Math.sin(this.t * 1.1 + i * 2) * 16;
        const pulse = (Math.sin(this.t * 2.6 + i) + 1) / 2;
        ctx.globalAlpha = pulse * night;
        ctx.beginPath();
        ctx.arc(x, y, 2.6, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
  }
}

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

