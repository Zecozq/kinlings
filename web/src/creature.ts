// Draws a Kinling from its genes. Every part is drawn in code, so any of the
// 750 species and every colour mix looks like it belongs in the same world.
// Creatures face right, with their feet near y = 62.

export const HEADS = ["Snout", "Muzzle", "Long face", "Beak", "Bear face"];
export const HORNS = ["No horns", "Dragon horns", "Spiral horn", "Antlers", "Ram horns", "Crest"];
export const WINGS = ["No wings", "Bat wings", "Feather wings", "Flame wings", "Butterfly wings"];
export const TAILS = ["Spade tail", "Fluffy tail", "Tufted tail", "Fan tail", "Flame tail"];
export const PATTERNS = ["Plain", "Spots", "Stripes", "Scales", "Frost", "Stars"];

export const COLOURS = [
  ["Moss", "#7fb069"],
  ["Sky", "#5fa8d3"],
  ["Coral", "#e76f51"],
  ["Plum", "#9b6fc4"],
  ["Amber", "#e9a23b"],
  ["Mint", "#5bc0a6"],
  ["Rose", "#ee8fa4"],
  ["Teal", "#3e8e8a"],
  ["Slate", "#8893a8"],
  ["Ivory", "#f2e6c9"],
  ["Lilac", "#b9a3e3"],
  ["Rust", "#b4603a"],
  ["Indigo", "#4c5fb1"],
  ["Lime", "#b6d14b"],
  ["Bubblegum", "#f39ac7"],
  ["Midnight", "#39406b"],
] as const;

const DOMINANCE: number[][] = [
  [0, 1, 2, 3, 4],
  [0, 1, 3, 4, 2, 5],
  [0, 1, 2, 4, 3],
  [0, 1, 2, 3, 4],
  [0, 1, 2, 3, 4, 5],
  [0, 1, 2, 3],
  [...Array(16).keys()],
  [...Array(16).keys()],
];

export interface Look {
  head: number;
  horn: number;
  wing: number;
  tail: number;
  pattern: number;
  eyes: number;
  main: string;
  accent: string;
  shiny: boolean;
  seed: number;
  speed: number;
  stamina: number;
  luck: number;
}

function shows(genes: number[], locus: number): number {
  const a = genes[locus * 2];
  const b = genes[locus * 2 + 1];
  return DOMINANCE[locus].indexOf(a) <= DOMINANCE[locus].indexOf(b) ? a : b;
}

export function lookFromGenes(genes: number[]): Look {
  const seed = genes.reduce((sum, value, index) => (sum * 31 + value + index) >>> 0, 7);
  return {
    head: shows(genes, 0),
    horn: shows(genes, 1),
    wing: shows(genes, 2),
    tail: shows(genes, 3),
    pattern: shows(genes, 4),
    eyes: shows(genes, 5),
    main: COLOURS[shows(genes, 6)][1],
    accent: COLOURS[shows(genes, 7)][1],
    speed: genes[16] | (genes[17] << 8),
    stamina: genes[18] | (genes[19] << 8),
    luck: genes[20] | (genes[21] << 8),
    shiny: genes[22] !== 0,
    seed,
  };
}

export function speciesNumber(look: Look): number {
  return look.head * 150 + look.horn * 25 + look.wing * 5 + look.tail;
}

const NAMED: Record<number, string> = {
  30: "Dragon",
  0: "Drake",
  352: "Unicorn",
  312: "Pegasus",
  362: "Alicorn",
  377: "Kirin",
  462: "Griffin",
  594: "Phoenix",
  588: "Roc",
  151: "Kitsune",
  226: "Jackalope",
  155: "Manticore",
  255: "Chimera",
  601: "Yeti",
  700: "Golem",
};

export function classicName(species: number): string | undefined {
  return NAMED[species];
}

export function shade(hex: string, amount: number): string {
  const value = parseInt(hex.slice(1), 16);
  const mix = (channel: number) =>
    Math.round(amount >= 0 ? channel + (255 - channel) * amount : channel * (1 + amount));
  const r = mix((value >> 16) & 255);
  const g = mix((value >> 8) & 255);
  const b = mix(value & 255);
  return `rgb(${r},${g},${b})`;
}

type Ctx = CanvasRenderingContext2D;

function seeded(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

function paint(ctx: Ctx, fill: string | CanvasGradient, line: string, width = 3.6) {
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = line;
  ctx.lineWidth = width;
  ctx.stroke();
}

function oval(ctx: Ctx, x: number, y: number, rx: number, ry: number, rotation = 0) {
  ctx.beginPath();
  ctx.ellipse(x, y, rx, ry, rotation, 0, Math.PI * 2);
}

export interface Pose {
  /** Seconds, for idle motion. */
  t: number;
  /** Walking cycle position, or 0 when still. */
  walk?: number;
  blink?: boolean;
  /** 0 to 1. Opens the mouth and closes the eyes happily. */
  joy?: number;
  /** Size from 0.6 (hatchling) to 1.25 (fully grown). */
  size?: number;
}

export function sizeForLevel(level: number): number {
  return Math.min(1.2, 0.62 + (level - 1) * 0.085);
}

/** Draws at the origin, with the ground a little below it. */
export function drawKin(ctx: Ctx, look: Look, pose: Pose) {
  const size = pose.size ?? 1;
  const line = shade(look.main, -0.58);
  const breathe = Math.sin(pose.t * 2.4 + look.seed) * 1.4;
  const stride = pose.walk ?? 0;
  const step = Math.sin(stride);
  const bounce = stride ? Math.abs(Math.cos(stride)) * 2.8 : 0;

  ctx.save();
  ctx.scale(size, size);
  ctx.translate(0, breathe - bounce);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  drawTail(ctx, look, pose.t, line);
  drawWing(ctx, look, pose.t, stride, line, true);
  leg(ctx, 16, 28, step * -0.5, shade(look.main, -0.18), line);
  leg(ctx, -26, 28, step * 0.5, shade(look.main, -0.18), line);
  drawBody(ctx, look, line);
  leg(ctx, 30, 30, step * 0.5, look.main, line);
  leg(ctx, -38, 30, step * -0.5, look.main, line);
  drawHead(ctx, look, pose, line);
  drawWing(ctx, look, pose.t, stride, line, false);
  ctx.restore();

  if (look.shiny) drawSparkles(ctx, pose.t, size, look.seed);
}

function drawBody(ctx: Ctx, look: Look, line: string) {
  oval(ctx, -4, 10, 58, 40);
  ctx.fillStyle = look.main;
  ctx.fill();

  ctx.save();
  oval(ctx, -4, 10, 58, 40);
  ctx.clip();
  drawPattern(ctx, look);
  oval(ctx, 6, 34, 40, 24);
  ctx.fillStyle = shade(look.accent, 0.45);
  ctx.fill();
  ctx.restore();

  oval(ctx, -4, 10, 58, 40);
  ctx.strokeStyle = line;
  ctx.lineWidth = 3.6;
  ctx.stroke();
}

function drawPattern(ctx: Ctx, look: Look) {
  const random = seeded(look.seed);
  const ink = shade(look.accent, -0.12);
  ctx.fillStyle = ink;
  ctx.strokeStyle = ink;
  switch (look.pattern) {
    case 1:
      for (let i = 0; i < 12; i++) {
        oval(ctx, -58 + random() * 105, -24 + random() * 48, 4 + random() * 6, 4 + random() * 5);
        ctx.fill();
      }
      break;
    case 2:
      ctx.lineWidth = 8;
      for (let x = -46; x < 44; x += 20) {
        ctx.beginPath();
        ctx.moveTo(x, -34);
        ctx.quadraticCurveTo(x + 9, 2, x - 2, 26);
        ctx.stroke();
      }
      break;
    case 3:
      ctx.lineWidth = 2.4;
      for (let row = 0; row < 5; row++) {
        for (let x = -60; x < 52; x += 16) {
          ctx.beginPath();
          ctx.arc(x + (row % 2) * 8, -28 + row * 11, 8, 0.1, Math.PI - 0.1);
          ctx.stroke();
        }
      }
      break;
    case 4:
      ctx.fillStyle = "rgba(235,250,255,.9)";
      ctx.beginPath();
      ctx.moveTo(-66, -40);
      for (let x = -62; x < 58; x += 12) {
        ctx.lineTo(x + 6, -4 - random() * 18);
        ctx.lineTo(x + 12, -22);
      }
      ctx.lineTo(60, -44);
      ctx.closePath();
      ctx.fill();
      break;
    case 5:
      ctx.fillStyle = "rgba(255,246,190,.95)";
      for (let i = 0; i < 9; i++) {
        star(ctx, -54 + random() * 100, -24 + random() * 44, 3.6 + random() * 3.4);
        ctx.fill();
      }
      break;
  }
}

function star(ctx: Ctx, x: number, y: number, r: number) {
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const radius = i % 2 ? r * 0.36 : r;
    const angle = (i / 8) * Math.PI * 2 - Math.PI / 2;
    ctx.lineTo(x + Math.cos(angle) * radius, y + Math.sin(angle) * radius);
  }
  ctx.closePath();
}

function leg(ctx: Ctx, x: number, y: number, angle: number, fill: string, line: string) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.beginPath();
  ctx.roundRect(-10, -8, 20, 36, 10);
  paint(ctx, fill, line);
  ctx.strokeStyle = line;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(-3, 22);
  ctx.lineTo(-3, 27);
  ctx.moveTo(3.5, 22);
  ctx.lineTo(3.5, 27);
  ctx.stroke();
  ctx.restore();
}

// ----- Tails ---------------------------------------------------------------

function drawTail(ctx: Ctx, look: Look, t: number, line: string) {
  const wag = Math.sin(t * 3.1 + look.seed) * 0.12;
  ctx.save();
  ctx.translate(-54, 14);
  ctx.rotate(wag);
  switch (look.tail) {
    case 0:
      spadeTail(ctx, look, line);
      break;
    case 1:
      fluffyTail(ctx, look, line);
      break;
    case 2:
      tuftTail(ctx, look, line);
      break;
    case 3:
      fanTail(ctx, look, line);
      break;
    default:
      flameTail(ctx, t, line);
  }
  ctx.restore();
}

function tube(ctx: Ctx, points: number[], width: number, colour: string, line: string) {
  const [a, b, c, d, e, f] = points;
  ctx.beginPath();
  ctx.moveTo(4, 0);
  ctx.bezierCurveTo(a, b, c, d, e, f);
  ctx.strokeStyle = line;
  ctx.lineWidth = width + 7;
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(4, 0);
  ctx.bezierCurveTo(a, b, c, d, e, f);
  ctx.strokeStyle = colour;
  ctx.lineWidth = width;
  ctx.stroke();
}

function spadeTail(ctx: Ctx, look: Look, line: string) {
  tube(ctx, [-24, 10, -46, -2, -52, -30], 14, look.main, line);
  ctx.beginPath();
  ctx.moveTo(-52, -26);
  ctx.quadraticCurveTo(-74, -38, -56, -64);
  ctx.quadraticCurveTo(-38, -40, -52, -26);
  paint(ctx, look.accent, line);
}

function fluffyTail(ctx: Ctx, look: Look, line: string) {
  ctx.beginPath();
  ctx.moveTo(8, 6);
  ctx.bezierCurveTo(-40, 30, -86, 2, -70, -52);
  ctx.bezierCurveTo(-44, -60, -14, -30, 8, -14);
  ctx.closePath();
  paint(ctx, look.main, line);
  ctx.beginPath();
  ctx.moveTo(-70, -52);
  ctx.bezierCurveTo(-56, -58, -40, -48, -34, -38);
  ctx.bezierCurveTo(-48, -32, -66, -28, -76, -34);
  ctx.closePath();
  paint(ctx, "#fff7ea", line);
}

function tuftTail(ctx: Ctx, look: Look, line: string) {
  tube(ctx, [-20, -6, -36, 4, -44, 28], 7, look.main, line);
  ctx.beginPath();
  ctx.moveTo(-44, 22);
  ctx.bezierCurveTo(-64, 28, -66, 54, -48, 70);
  ctx.bezierCurveTo(-30, 54, -28, 32, -44, 22);
  paint(ctx, look.accent, line);
}

function fanTail(ctx: Ctx, look: Look, line: string) {
  for (let i = -2; i <= 2; i++) {
    ctx.save();
    ctx.rotate(-1.9 + i * 0.3);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.bezierCurveTo(-18, 18, -14, 66, 0, 78);
    ctx.bezierCurveTo(14, 66, 18, 18, 0, 0);
    paint(ctx, i % 2 ? look.accent : look.main, line, 3);
    oval(ctx, 0, 62, 5.5, 7.5);
    ctx.fillStyle = shade(look.accent, 0.55);
    ctx.fill();
    ctx.restore();
  }
}

function flame(ctx: Ctx, x: number, y: number, height: number, width: number, lean: number) {
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.bezierCurveTo(x - width, y - height * 0.3, x - width * 0.3 + lean, y - height * 0.7, x + lean, y - height);
  ctx.bezierCurveTo(x + width * 0.3 + lean, y - height * 0.7, x + width, y - height * 0.3, x, y);
  ctx.closePath();
}

function flameTail(ctx: Ctx, t: number, line: string) {
  const flicker = Math.sin(t * 13) * 4;
  ctx.save();
  ctx.rotate(-1.15);
  flame(ctx, 6, 8, 80 + flicker, 26, flicker * 0.7);
  paint(ctx, "#f2762b", line);
  flame(ctx, 6, 6, 56 - flicker, 16, -flicker * 0.4);
  ctx.fillStyle = "#ffc24b";
  ctx.fill();
  flame(ctx, 6, 3, 32 + flicker / 2, 9, 0);
  ctx.fillStyle = "#fff0b3";
  ctx.fill();
  ctx.restore();
}

// ----- Wings ---------------------------------------------------------------

function drawWing(ctx: Ctx, look: Look, t: number, stride: number, line: string, far: boolean) {
  if (look.wing === 0) return;
  const speed = stride ? 8 : 2.6;
  const flap = Math.sin(t * speed + look.seed) * (stride ? 0.34 : 0.14);
  ctx.save();
  ctx.translate(far ? 2 : -10, -22);
  ctx.rotate((far ? -0.28 : -0.05) - flap);
  ctx.scale(far ? 0.9 : 1, far ? 0.9 : 1);
  const tone = far ? -0.2 : 0;
  switch (look.wing) {
    case 1:
      batWing(ctx, look, line, tone);
      break;
    case 2:
      featherWing(ctx, look, line, tone);
      break;
    case 3:
      flameWing(ctx, t, line);
      break;
    default:
      butterflyWing(ctx, look, line, tone);
  }
  ctx.restore();
}

function batWing(ctx: Ctx, look: Look, line: string, tone: number) {
  ctx.beginPath();
  ctx.moveTo(4, 2);
  ctx.bezierCurveTo(-8, -46, -40, -86, -92, -84);
  ctx.quadraticCurveTo(-82, -60, -92, -36);
  ctx.quadraticCurveTo(-70, -48, -62, -14);
  ctx.quadraticCurveTo(-44, -30, -30, 2);
  ctx.quadraticCurveTo(-14, -12, 4, 2);
  ctx.closePath();
  paint(ctx, shade(look.accent, tone), line);
  ctx.strokeStyle = line;
  ctx.lineWidth = 2.4;
  ctx.beginPath();
  ctx.moveTo(4, 2);
  ctx.lineTo(-62, -14);
  ctx.moveTo(4, 2);
  ctx.lineTo(-92, -36);
  ctx.stroke();
}

function featherWing(ctx: Ctx, look: Look, line: string, tone: number) {
  for (let i = 0; i < 4; i++) {
    ctx.save();
    ctx.rotate(1.42 + i * 0.36);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.bezierCurveTo(-18, 14, -18, 68, 0, 90 - i * 8);
    ctx.bezierCurveTo(18, 68, 18, 14, 0, 0);
    paint(ctx, shade(i % 2 ? look.accent : "#fff3df", tone), line, 3);
    ctx.restore();
  }
}

function flameWing(ctx: Ctx, t: number, line: string) {
  for (let i = 0; i < 3; i++) {
    const flicker = Math.sin(t * 11 + i * 2) * 5;
    ctx.save();
    ctx.rotate(-0.42 - i * 0.42);
    flame(ctx, 0, 0, 92 - i * 12 + flicker, 24, 0);
    paint(ctx, "#f2762b", line, 3);
    flame(ctx, 0, -4, 60 - i * 8 - flicker, 14, 0);
    ctx.fillStyle = "#ffcf5c";
    ctx.fill();
    ctx.restore();
  }
}

function butterflyWing(ctx: Ctx, look: Look, line: string, tone: number) {
  ctx.beginPath();
  ctx.moveTo(2, 0);
  ctx.bezierCurveTo(-30, -90, -100, -88, -84, -36);
  ctx.bezierCurveTo(-78, -14, -30, -8, 2, 0);
  ctx.closePath();
  paint(ctx, shade(look.accent, tone), line);
  ctx.beginPath();
  ctx.moveTo(2, 0);
  ctx.bezierCurveTo(-40, 2, -74, 16, -58, 40);
  ctx.bezierCurveTo(-46, 54, -14, 30, 2, 0);
  ctx.closePath();
  paint(ctx, shade(look.main, tone + 0.15), line);
  ctx.fillStyle = "rgba(255,255,255,.75)";
  oval(ctx, -62, -52, 10, 13, -0.5);
  ctx.fill();
  oval(ctx, -42, 26, 7, 8);
  ctx.fill();
}

// ----- Heads ---------------------------------------------------------------

function drawHead(ctx: Ctx, look: Look, pose: Pose, line: string) {
  const nod = Math.sin(pose.t * 1.9 + look.seed * 2) * 0.035;
  ctx.save();
  ctx.translate(44, -30);
  ctx.rotate(nod);

  drawEars(ctx, look, line);
  if (look.horn === 4) ramHorn(ctx, line, true);

  switch (look.head) {
    case 0:
      dragonHead(ctx, look, line);
      break;
    case 1:
      foxHead(ctx, look, line);
      break;
    case 2:
      horseHead(ctx, look, line);
      break;
    case 3:
      birdHead(ctx, look, line);
      break;
    default:
      bearHead(ctx, look, line);
  }
  drawHorn(ctx, look, line);
  drawFace(ctx, look, pose, line);
  ctx.restore();
}

function baseHead(ctx: Ctx, look: Look, line: string) {
  oval(ctx, 0, 0, 39, 36);
  paint(ctx, look.main, line);
}

function dragonHead(ctx: Ctx, look: Look, line: string) {
  ctx.beginPath();
  ctx.moveTo(-34, -22);
  ctx.bezierCurveTo(-20, -44, 26, -44, 36, -18);
  ctx.bezierCurveTo(50, -18, 74, -12, 72, 8);
  ctx.bezierCurveTo(70, 28, 40, 32, 18, 32);
  ctx.bezierCurveTo(-12, 42, -48, 16, -34, -22);
  ctx.closePath();
  paint(ctx, look.main, line);
  oval(ctx, 58, -4, 3.4, 2.6, 0.4);
  ctx.fillStyle = line;
  ctx.fill();
}

function foxHead(ctx: Ctx, look: Look, line: string) {
  ctx.beginPath();
  ctx.moveTo(-36, -20);
  ctx.bezierCurveTo(-24, -44, 20, -46, 34, -18);
  ctx.bezierCurveTo(48, -6, 66, 2, 76, 10);
  ctx.bezierCurveTo(60, 26, 30, 36, 8, 34);
  ctx.bezierCurveTo(-24, 34, -46, 10, -36, -20);
  ctx.closePath();
  paint(ctx, look.main, line);
  ctx.beginPath();
  ctx.moveTo(14, 34);
  ctx.bezierCurveTo(34, 34, 62, 24, 76, 10);
  ctx.bezierCurveTo(54, 8, 30, 8, 14, 34);
  ctx.closePath();
  ctx.fillStyle = "#fff7ea";
  ctx.fill();
  oval(ctx, 76, 9, 6.4, 5.4);
  ctx.fillStyle = "#2c2230";
  ctx.fill();
}

function horseHead(ctx: Ctx, look: Look, line: string) {
  ctx.beginPath();
  ctx.moveTo(-32, -26);
  ctx.bezierCurveTo(-14, -46, 24, -42, 34, -16);
  ctx.bezierCurveTo(44, 8, 62, 22, 58, 42);
  ctx.bezierCurveTo(52, 60, 26, 58, 14, 46);
  ctx.bezierCurveTo(-8, 34, -46, 14, -32, -26);
  ctx.closePath();
  paint(ctx, look.main, line);
  ctx.beginPath();
  ctx.moveTo(22, 52);
  ctx.bezierCurveTo(34, 60, 52, 58, 58, 40);
  ctx.bezierCurveTo(54, 30, 34, 30, 22, 52);
  ctx.closePath();
  ctx.fillStyle = shade(look.accent, 0.42);
  ctx.fill();
  oval(ctx, 48, 42, 3, 4.4);
  ctx.fillStyle = line;
  ctx.fill();
}

function birdHead(ctx: Ctx, look: Look, line: string) {
  baseHead(ctx, look, line);
  ctx.beginPath();
  ctx.moveTo(30, -12);
  ctx.quadraticCurveTo(62, -8, 72, 14);
  ctx.quadraticCurveTo(52, 26, 28, 18);
  ctx.closePath();
  paint(ctx, "#f2b13b", line);
  ctx.strokeStyle = line;
  ctx.lineWidth = 2.2;
  ctx.beginPath();
  ctx.moveTo(32, 6);
  ctx.quadraticCurveTo(50, 8, 66, 12);
  ctx.stroke();
}

function bearHead(ctx: Ctx, look: Look, line: string) {
  oval(ctx, 0, 2, 43, 39);
  paint(ctx, look.main, line);
  oval(ctx, 26, 15, 22, 17);
  ctx.fillStyle = shade(look.accent, 0.5);
  ctx.fill();
  oval(ctx, 36, 8, 7, 5.5);
  ctx.fillStyle = "#2c2230";
  ctx.fill();
}

function drawEars(ctx: Ctx, look: Look, line: string) {
  switch (look.head) {
    case 0:
      ctx.beginPath();
      ctx.moveTo(-28, -22);
      ctx.quadraticCurveTo(-54, -34, -66, -18);
      ctx.quadraticCurveTo(-50, -8, -32, 0);
      ctx.closePath();
      paint(ctx, look.accent, line);
      break;
    case 1:
      for (const [x, tilt] of [[-20, -0.16], [14, 0.12]]) {
        ctx.save();
        ctx.translate(x, -28);
        ctx.rotate(tilt);
        ctx.beginPath();
        ctx.moveTo(-16, 8);
        ctx.quadraticCurveTo(-14, -30, 0, -44);
        ctx.quadraticCurveTo(14, -30, 16, 8);
        ctx.closePath();
        paint(ctx, look.main, line);
        ctx.beginPath();
        ctx.moveTo(-8, 4);
        ctx.quadraticCurveTo(-6, -18, 0, -30);
        ctx.quadraticCurveTo(6, -18, 8, 4);
        ctx.closePath();
        ctx.fillStyle = shade(look.accent, 0.3);
        ctx.fill();
        ctx.restore();
      }
      break;
    case 2:
      ctx.save();
      ctx.translate(-12, -30);
      ctx.rotate(-0.28);
      ctx.beginPath();
      ctx.moveTo(-11, 8);
      ctx.quadraticCurveTo(-10, -22, 0, -36);
      ctx.quadraticCurveTo(10, -22, 11, 8);
      ctx.closePath();
      paint(ctx, look.main, line);
      ctx.restore();
      break;
    case 4:
      for (const x of [-30, 22]) {
        oval(ctx, x, -32, 15, 15);
        paint(ctx, look.main, line);
        oval(ctx, x, -31, 7.5, 7.5);
        ctx.fillStyle = shade(look.accent, 0.3);
        ctx.fill();
      }
      break;
  }
}

function drawHorn(ctx: Ctx, look: Look, line: string) {
  switch (look.horn) {
    case 1:
      for (const [x, y, tilt] of [[-22, -28, -0.75], [6, -33, -0.42]] as const) {
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(tilt);
        ctx.beginPath();
        ctx.moveTo(-9, 6);
        ctx.quadraticCurveTo(-12, -30, 4, -50);
        ctx.quadraticCurveTo(10, -22, 9, 6);
        ctx.closePath();
        paint(ctx, "#f4e3bd", line);
        ctx.restore();
      }
      break;
    case 2: {
      ctx.save();
      ctx.translate(14, -32);
      ctx.rotate(0.28);
      ctx.beginPath();
      ctx.moveTo(-10, 6);
      ctx.lineTo(0, -66);
      ctx.lineTo(10, 6);
      ctx.closePath();
      const gold = ctx.createLinearGradient(0, -66, 0, 6);
      gold.addColorStop(0, "#fff4b8");
      gold.addColorStop(1, "#f2b13b");
      paint(ctx, gold, line);
      ctx.strokeStyle = "rgba(160,90,20,.55)";
      ctx.lineWidth = 2.2;
      for (let y = -48; y < 2; y += 12) {
        const half = ((y + 66) / 72) * 10;
        ctx.beginPath();
        ctx.moveTo(-half, y + 4);
        ctx.lineTo(half, y - 3);
        ctx.stroke();
      }
      ctx.restore();
      break;
    }
    case 3:
      antler(ctx, -18, -30, -0.55, line);
      antler(ctx, 8, -34, -0.12, line);
      break;
    case 4:
      ramHorn(ctx, line, false);
      break;
    case 5:
      for (let i = 0; i < 4; i++) {
        ctx.save();
        ctx.translate(-8, -32);
        ctx.rotate(-0.72 + i * 0.32);
        ctx.beginPath();
        ctx.moveTo(0, 6);
        ctx.bezierCurveTo(-13, -16, -9, -46, 0, -58 + i * 3);
        ctx.bezierCurveTo(9, -46, 13, -16, 0, 6);
        paint(ctx, i % 2 ? look.accent : "#f2762b", line, 3);
        ctx.restore();
      }
      break;
  }
}

function antler(ctx: Ctx, x: number, y: number, tilt: number, line: string) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(tilt);
  const branch = (width: number, colour: string) => {
    ctx.strokeStyle = colour;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(0, 4);
    ctx.quadraticCurveTo(-3, -24, 7, -54);
    ctx.moveTo(-1, -14);
    ctx.quadraticCurveTo(-16, -22, -20, -36);
    ctx.moveTo(3, -32);
    ctx.quadraticCurveTo(16, -36, 22, -50);
    ctx.stroke();
  };
  branch(11, line);
  branch(5.6, "#c79a64");
  ctx.restore();
}

function ramHorn(ctx: Ctx, line: string, far: boolean) {
  ctx.save();
  ctx.translate(far ? -28 : -18, -18);
  ctx.scale(far ? 0.86 : 1, far ? 0.86 : 1);
  const curl = (width: number, colour: string) => {
    ctx.strokeStyle = colour;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(10, -6);
    ctx.bezierCurveTo(-8, -38, -54, -24, -48, 12);
    ctx.bezierCurveTo(-44, 36, -12, 30, -14, 10);
    ctx.stroke();
  };
  curl(18, line);
  curl(11, "#e2c79a");
  ctx.restore();
}

function drawFace(ctx: Ctx, look: Look, pose: Pose, line: string) {
  const joy = pose.joy ?? 0;
  const eyeX = look.head === 2 ? 10 : 12;
  const eyeY = -8;
  const ink = "#2c2230";

  if (joy > 0.5 || pose.blink) {
    ctx.strokeStyle = ink;
    ctx.lineWidth = 4;
    ctx.beginPath();
    if (joy > 0.5) ctx.arc(eyeX, eyeY + 4, 10, Math.PI * 1.15, Math.PI * 1.85);
    else {
      ctx.moveTo(eyeX - 9, eyeY + 1);
      ctx.lineTo(eyeX + 9, eyeY + 1);
    }
    ctx.stroke();
  } else {
    const radius = look.eyes === 2 ? 13 : 11;
    oval(ctx, eyeX, eyeY, radius, radius + 1.5);
    ctx.fillStyle = ink;
    ctx.fill();
    oval(ctx, eyeX + 3.5, eyeY - 5, radius * 0.38, radius * 0.38);
    ctx.fillStyle = "#fff";
    ctx.fill();
    oval(ctx, eyeX - 4, eyeY + 4.5, radius * 0.18, radius * 0.18);
    ctx.fill();
    if (look.eyes === 1) {
      ctx.beginPath();
      ctx.rect(eyeX - radius - 2, eyeY - radius - 4, radius * 2 + 4, radius + 2);
      ctx.fillStyle = look.main;
      ctx.fill();
      ctx.strokeStyle = line;
      ctx.lineWidth = 2.6;
      ctx.beginPath();
      ctx.moveTo(eyeX - radius, eyeY - 2);
      ctx.lineTo(eyeX + radius, eyeY - 2);
      ctx.stroke();
    }
    if (look.eyes === 3) {
      ctx.strokeStyle = line;
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(eyeX - radius, eyeY - radius - 3);
      ctx.lineTo(eyeX + radius, eyeY - radius + 5);
      ctx.stroke();
    }
  }

  // Blushing cheek.
  oval(ctx, eyeX - 15, eyeY + 19, 8, 5);
  ctx.fillStyle = "rgba(240,100,110,.32)";
  ctx.fill();

  const mouth = mouthSpot(look.head);
  ctx.strokeStyle = line;
  ctx.lineWidth = 2.8;
  ctx.beginPath();
  if (joy > 0.2) {
    ctx.arc(mouth[0], mouth[1], 7 + joy * 3, 0.1, Math.PI - 0.1);
    ctx.closePath();
    ctx.fillStyle = "#8d3048";
    ctx.fill();
  } else {
    ctx.arc(mouth[0], mouth[1] - 3, 7, 0.45, Math.PI - 0.45);
  }
  ctx.stroke();
}

function mouthSpot(head: number): [number, number] {
  return ([[42, 15], [46, 18], [36, 34], [44, 26], [26, 22]] as const)[head] as [number, number];
}

function drawSparkles(ctx: Ctx, t: number, size: number, seed: number) {
  const random = seeded(seed + 9);
  ctx.save();
  ctx.fillStyle = "#fff6b8";
  for (let i = 0; i < 7; i++) {
    const phase = random() * 6.28;
    const x = (-74 + random() * 150) * size;
    const y = (-82 + random() * 130) * size;
    const twinkle = (Math.sin(t * 3 + phase) + 1) / 2;
    star(ctx, x, y, (2 + twinkle * 7) * size);
    ctx.fill();
  }
  ctx.restore();
}

// ----- Eggs ----------------------------------------------------------------

export function drawEgg(
  ctx: Ctx,
  colourA: string,
  colourB: string,
  seed: number,
  t: number,
  wobble: number,
  crack: number,
) {
  const line = shade(colourA, -0.55);
  const random = seeded(seed + 3);
  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.rotate(Math.sin(t * 22) * wobble * 0.24);

  const eggPath = () => {
    ctx.beginPath();
    ctx.moveTo(0, -46);
    ctx.bezierCurveTo(26, -46, 38, -2, 38, 14);
    ctx.bezierCurveTo(38, 38, 18, 46, 0, 46);
    ctx.bezierCurveTo(-18, 46, -38, 38, -38, 14);
    ctx.bezierCurveTo(-38, -2, -26, -46, 0, -46);
    ctx.closePath();
  };
  eggPath();
  const fill = ctx.createLinearGradient(-30, -44, 28, 46);
  fill.addColorStop(0, shade(colourA, 0.55));
  fill.addColorStop(1, colourA);
  ctx.fillStyle = fill;
  ctx.fill();

  ctx.save();
  eggPath();
  ctx.clip();
  ctx.fillStyle = colourB;
  for (let i = 0; i < 9; i++) {
    oval(ctx, -32 + random() * 64, -32 + random() * 74, 3.5 + random() * 8, 3.5 + random() * 6);
    ctx.fill();
  }
  ctx.fillStyle = "rgba(255,255,255,.4)";
  oval(ctx, -14, -18, 8, 14, 0.4);
  ctx.fill();
  ctx.restore();

  eggPath();
  ctx.strokeStyle = line;
  ctx.lineWidth = 3.6;
  ctx.stroke();

  if (crack > 0) {
    ctx.strokeStyle = line;
    ctx.lineWidth = 2.6;
    ctx.beginPath();
    const pieces = Math.ceil(crack * 7);
    let x = -30;
    let y = -6;
    ctx.moveTo(x, y);
    for (let i = 0; i < pieces; i++) {
      x += 9;
      y += i % 2 ? -12 : 13;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  ctx.restore();
}
