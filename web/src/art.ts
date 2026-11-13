// Crops, buildings, the acorn and other small pictures, all drawn in code.

import { shade } from "./creature.ts";

type Ctx = CanvasRenderingContext2D;
const OUTLINE = "#4a3322";

function paint(ctx: Ctx, fill: string, width = 3, line = OUTLINE) {
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

function stem(ctx: Ctx, x: number, height: number, lean: number, colour = "#5a9a45", width = 5) {
  ctx.strokeStyle = shade(colour, -0.5);
  ctx.lineWidth = width + 2.6;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(x, 0);
  ctx.quadraticCurveTo(x, -height * 0.6, x + lean, -height);
  ctx.stroke();
  ctx.strokeStyle = colour;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(x, 0);
  ctx.quadraticCurveTo(x, -height * 0.6, x + lean, -height);
  ctx.stroke();
}

function leaf(ctx: Ctx, x: number, y: number, length: number, angle: number, colour = "#6bb04f") {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.quadraticCurveTo(length * 0.5, -length * 0.42, length, 0);
  ctx.quadraticCurveTo(length * 0.5, length * 0.42, 0, 0);
  paint(ctx, colour, 2.4, shade(colour, -0.5));
  ctx.restore();
}

/** Stage runs 0 (just planted) to 3 (ripe). Drawn with the soil line at y = 0. */
export function drawCrop(ctx: Ctx, item: number, stage: number, t: number, seed = 0) {
  const sway = Math.sin(t * 2 + seed) * 2.5;
  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  if (stage === 0) {
    oval(ctx, 0, -3, 7, 4.5);
    paint(ctx, "#8a5a3c", 2.4);
    leaf(ctx, -1, -6, 12, -2.5, "#8ccf62");
    leaf(ctx, 1, -6, 12, -0.64, "#8ccf62");
    ctx.restore();
    return;
  }
  switch (item) {
    case 1:
      sunwheat(ctx, stage, sway);
      break;
    case 2:
      dewbean(ctx, stage, sway);
      break;
    case 3:
      emberroot(ctx, stage, sway, t);
      break;
    case 4:
      frostberry(ctx, stage, sway, t);
      break;
    case 5:
      moonmelon(ctx, stage, sway, t);
      break;
    default:
      starfig(ctx, stage, sway, t);
  }
  ctx.restore();
}

function sunwheat(ctx: Ctx, stage: number, sway: number) {
  const ripe = stage === 3;
  const height = stage === 1 ? 24 : stage === 2 ? 40 : 52;
  for (const [x, shift] of [[-13, -2], [0, 2], [13, -1]] as const) {
    stem(ctx, x, height, sway + shift, ripe ? "#c9a93f" : "#7fb655", 4.2);
    if (stage < 2) continue;
    const headX = x + sway + shift;
    const colour = ripe ? "#efc14b" : "#a9c55a";
    for (let i = 0; i < 5; i++) {
      oval(ctx, headX - 4, -height - 2 + i * 6, 4.6, 3.4, 0.5);
      paint(ctx, colour, 1.8, shade(colour, -0.5));
      oval(ctx, headX + 4, -height + i * 6, 4.6, 3.4, -0.5);
      paint(ctx, colour, 1.8, shade(colour, -0.5));
    }
    oval(ctx, headX, -height - 7, 3.8, 5.4);
    paint(ctx, colour, 1.8, shade(colour, -0.5));
  }
}

function dewbean(ctx: Ctx, stage: number, sway: number) {
  const height = stage === 1 ? 28 : stage === 2 ? 46 : 58;
  stem(ctx, 0, height, sway, "#5a9a45", 5);
  leaf(ctx, sway * 0.4, -height * 0.5, 22, -0.4);
  leaf(ctx, sway * 0.4, -height * 0.6, 22, -2.7);
  if (stage >= 2) leaf(ctx, sway * 0.8, -height * 0.9, 20, -1.2);
  if (stage === 3) {
    for (const [x, y, tilt] of [[-16, -28, 0.3], [15, -34, -0.3], [2, -16, 0]] as const) {
      ctx.save();
      ctx.translate(x + sway * 0.6, y);
      ctx.rotate(tilt);
      ctx.beginPath();
      ctx.roundRect(-6, -14, 12, 30, 6);
      paint(ctx, "#5cc4b8", 2.6, "#25605e");
      oval(ctx, -1.5, -7, 2.4, 3.6);
      ctx.fillStyle = "rgba(255,255,255,.85)";
      ctx.fill();
      ctx.restore();
    }
  }
}

function emberroot(ctx: Ctx, stage: number, sway: number, t: number) {
  for (const angle of [-2.3, -1.57, -0.85]) leaf(ctx, sway * 0.3, -8, stage === 1 ? 20 : 36, angle, "#7a9a3d");
  if (stage >= 2) {
    const radius = stage === 3 ? 21 : 13;
    ctx.beginPath();
    ctx.moveTo(-radius, -2);
    ctx.bezierCurveTo(-radius, -radius * 1.7, radius, -radius * 1.7, radius, -2);
    ctx.lineTo(-radius, -2);
    paint(ctx, stage === 3 ? "#ef7b30" : "#c98b52", 3);
    if (stage === 3) {
      const glow = 0.5 + Math.sin(t * 5) * 0.25;
      ctx.fillStyle = `rgba(255,214,110,${glow})`;
      ctx.beginPath();
      ctx.moveTo(-8, -6);
      ctx.quadraticCurveTo(0, -30 + Math.sin(t * 9) * 3, 8, -6);
      ctx.fill();
    }
  }
}

function frostberry(ctx: Ctx, stage: number, sway: number, t: number) {
  const colour = "#6fb0a8";
  const size = stage === 1 ? 15 : stage === 2 ? 24 : 30;
  oval(ctx, sway * 0.5, -size * 0.9, size, size * 0.86);
  paint(ctx, colour, 3, "#2c5f5a");
  oval(ctx, -size * 0.45 + sway * 0.5, -size * 0.62, size * 0.6, size * 0.55);
  paint(ctx, shade(colour, 0.14), 2.6, "#2c5f5a");
  oval(ctx, size * 0.45 + sway * 0.5, -size * 0.62, size * 0.6, size * 0.55);
  paint(ctx, shade(colour, 0.1), 2.6, "#2c5f5a");
  if (stage === 3) {
    const berries = [[-16, -26], [-4, -38], [12, -30], [0, -18], [17, -14], [-18, -12]];
    for (const [x, y] of berries) {
      oval(ctx, x + sway * 0.5, y, 5.6, 5.6);
      paint(ctx, "#bfe9ff", 2.2, "#3d7a9c");
    }
    ctx.fillStyle = "#fff";
    for (let i = 0; i < 3; i++) {
      const phase = (t * 1.4 + i * 1.7) % 3;
      if (phase < 0.6) {
        oval(ctx, -14 + i * 15, -44 + i * 8, 2.2, 2.2);
        ctx.fill();
      }
    }
  }
}

function moonmelon(ctx: Ctx, stage: number, sway: number, t: number) {
  ctx.strokeStyle = "#4e8a3e";
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.moveTo(-34, 0);
  ctx.quadraticCurveTo(-12, -14 + sway, 6, -6);
  ctx.quadraticCurveTo(22, 0, 32, -8);
  ctx.stroke();
  leaf(ctx, -18, -10, 20, -1.1);
  leaf(ctx, 20, -6, 20, -1.9);
  if (stage === 1) return;
  const radius = stage === 2 ? 15 : 26;
  if (stage === 3) {
    const glow = ctx.createRadialGradient(0, -radius, 2, 0, -radius, radius * 2.1);
    glow.addColorStop(0, `rgba(230,220,255,${0.42 + Math.sin(t * 2) * 0.12})`);
    glow.addColorStop(1, "rgba(230,220,255,0)");
    ctx.fillStyle = glow;
    oval(ctx, 0, -radius, radius * 2.1, radius * 2.1);
    ctx.fill();
  }
  oval(ctx, 0, -radius + 1, radius, radius * 0.92);
  paint(ctx, "#d8cdf2", 3.2, "#5a4a86");
  ctx.strokeStyle = "rgba(120,100,180,.55)";
  ctx.lineWidth = 3;
  for (const curve of [-9, 0, 9]) {
    ctx.beginPath();
    ctx.moveTo(curve * 0.4, -radius * 1.86);
    ctx.quadraticCurveTo(curve * 1.9, -radius, curve * 0.4, -3);
    ctx.stroke();
  }
}

function fourPointStar(ctx: Ctx, x: number, y: number, radius: number) {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 ? radius * 0.46 : radius;
    const angle = (i / 10) * Math.PI * 2 - Math.PI / 2;
    ctx.lineTo(x + Math.cos(angle) * r, y + Math.sin(angle) * r);
  }
  ctx.closePath();
}

function starfig(ctx: Ctx, stage: number, sway: number, t: number) {
  const height = stage === 1 ? 26 : stage === 2 ? 42 : 52;
  stem(ctx, 0, height, sway * 0.5, "#7a5a3a", 8);
  const crown = stage === 1 ? 16 : stage === 2 ? 26 : 34;
  oval(ctx, sway * 0.5, -height - crown * 0.3, crown, crown * 0.82);
  paint(ctx, "#3f7d5c", 3, "#214334");
  if (stage === 3) {
    const spots = [[-18, -60], [12, -74], [20, -52], [-4, -46]];
    spots.forEach(([x, y], index) => {
      const twinkle = 1 + Math.sin(t * 3 + index) * 0.14;
      fourPointStar(ctx, x + sway * 0.5, y, 9 * twinkle);
      paint(ctx, "#ffd95c", 2.2, "#a87a18");
    });
  }
}

export function drawAcorn(ctx: Ctx, size: number) {
  ctx.save();
  ctx.scale(size / 40, size / 40);
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(-13, -2);
  ctx.bezierCurveTo(-14, 12, -6, 20, 0, 23);
  ctx.bezierCurveTo(6, 20, 14, 12, 13, -2);
  ctx.closePath();
  paint(ctx, "#d58c3f", 3);
  ctx.beginPath();
  ctx.moveTo(-16, -2);
  ctx.bezierCurveTo(-16, -14, 16, -14, 16, -2);
  ctx.bezierCurveTo(10, 3, -10, 3, -16, -2);
  ctx.closePath();
  paint(ctx, "#8a5a3c", 3);
  ctx.beginPath();
  ctx.moveTo(0, -12);
  ctx.quadraticCurveTo(2, -19, 6, -20);
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = 3.4;
  ctx.lineCap = "round";
  ctx.stroke();
  oval(ctx, -5, 8, 2.4, 6, 0.2);
  ctx.fillStyle = "rgba(255,240,200,.65)";
  ctx.fill();
  ctx.restore();
}

export function drawTonic(ctx: Ctx, size: number) {
  ctx.save();
  ctx.scale(size / 44, size / 44);
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(-8, -18);
  ctx.lineTo(-8, -6);
  ctx.quadraticCurveTo(-20, 2, -18, 12);
  ctx.quadraticCurveTo(-16, 22, 0, 22);
  ctx.quadraticCurveTo(16, 22, 18, 12);
  ctx.quadraticCurveTo(20, 2, 8, -6);
  ctx.lineTo(8, -18);
  ctx.closePath();
  paint(ctx, "#f28a55", 3.2);
  ctx.beginPath();
  ctx.roundRect(-10, -25, 20, 9, 3);
  paint(ctx, "#c9915a", 3);
  oval(ctx, -7, 8, 3, 6, 0.4);
  ctx.fillStyle = "rgba(255,255,255,.6)";
  ctx.fill();
  ctx.restore();
}

export function plotSoil(ctx: Ctx, wet: boolean, hover: boolean) {
  ctx.save();
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.ellipse(0, 0, 54, 25, 0, 0, Math.PI * 2);
  ctx.fillStyle = wet ? "#6d4630" : "#8a5a3c";
  ctx.fill();
  ctx.strokeStyle = hover ? "#fff4d6" : "#54351f";
  ctx.lineWidth = hover ? 5 : 3.4;
  ctx.stroke();
  ctx.strokeStyle = wet ? "rgba(40,24,14,.5)" : "rgba(60,36,20,.42)";
  ctx.lineWidth = 3;
  for (const y of [-11, -2, 7]) {
    ctx.beginPath();
    ctx.moveTo(-36, y);
    ctx.quadraticCurveTo(0, y + 5, 36, y);
    ctx.stroke();
  }
  ctx.restore();
}

export function drawCottage(ctx: Ctx, roof: string, lit: boolean, rank: number) {
  ctx.save();
  ctx.lineJoin = "round";
  // Walls.
  ctx.beginPath();
  ctx.roundRect(-112, -118, 224, 120, 8);
  paint(ctx, "#f6e7c8", 4);
  ctx.fillStyle = "rgba(150,110,70,.16)";
  ctx.fillRect(-108, -24, 216, 24);
  // Chimney.
  ctx.beginPath();
  ctx.roundRect(52, -216, 36, 74, 4);
  paint(ctx, "#b3674a", 4);
  // Roof.
  ctx.beginPath();
  ctx.moveTo(-140, -108);
  ctx.quadraticCurveTo(-60, -196, 0, -204);
  ctx.quadraticCurveTo(60, -196, 140, -108);
  ctx.quadraticCurveTo(0, -88, -140, -108);
  ctx.closePath();
  paint(ctx, roof, 4);
  ctx.strokeStyle = shade(roof, -0.28);
  ctx.lineWidth = 3;
  for (let row = 0; row < 4; row++) {
    const y = -120 - row * 20;
    const halfWidth = 118 - row * 28;
    for (let x = -halfWidth; x < halfWidth; x += 24) {
      ctx.beginPath();
      ctx.arc(x + (row % 2) * 12, y, 12, 0.2, Math.PI - 0.2);
      ctx.stroke();
    }
  }
  // Door.
  ctx.beginPath();
  ctx.moveTo(-28, 2);
  ctx.lineTo(-28, -56);
  ctx.quadraticCurveTo(0, -92, 28, -56);
  ctx.lineTo(28, 2);
  ctx.closePath();
  paint(ctx, "#a56a3f", 4);
  oval(ctx, 15, -30, 4, 4);
  ctx.fillStyle = "#f2c14b";
  ctx.fill();
  // Windows.
  for (const x of [-72, 72]) {
    ctx.beginPath();
    ctx.roundRect(x - 22, -86, 44, 44, 8);
    paint(ctx, lit ? "#ffd67a" : "#a9d6e5", 4);
    ctx.strokeStyle = OUTLINE;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(x, -86);
    ctx.lineTo(x, -42);
    ctx.moveTo(x - 22, -64);
    ctx.lineTo(x + 22, -64);
    ctx.stroke();
    if (rank >= 2) {
      ctx.beginPath();
      ctx.roundRect(x - 27, -42, 54, 13, 4);
      paint(ctx, "#a56a3f", 3);
      for (let i = -2; i <= 2; i++) {
        oval(ctx, x + i * 9, -46, 5.4, 5.4);
        paint(ctx, i % 2 ? "#ee8fa4" : "#f2c14b", 2);
      }
    }
  }
  ctx.restore();
}

export function drawNest(ctx: Ctx) {
  ctx.save();
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.ellipse(0, 0, 92, 34, 0, 0, Math.PI * 2);
  paint(ctx, "#b98a55", 4);
  ctx.beginPath();
  ctx.ellipse(0, -6, 72, 20, 0, 0, Math.PI * 2);
  ctx.fillStyle = "#7f5a35";
  ctx.fill();
  ctx.strokeStyle = "#8a6238";
  ctx.lineWidth = 4;
  for (let i = 0; i < 24; i++) {
    const angle = (i / 24) * Math.PI * 2;
    const x = Math.cos(angle) * 84;
    const y = Math.sin(angle) * 28;
    ctx.beginPath();
    ctx.moveTo(x - 12, y - 3);
    ctx.lineTo(x + 14, y + 4);
    ctx.stroke();
  }
  ctx.restore();
}

export function drawSign(ctx: Ctx, text: string, elder: boolean, online: boolean, mine: boolean) {
  ctx.save();
  ctx.font = "600 20px Fredoka, sans-serif";
  const width = Math.max(120, ctx.measureText(text).width + 44);
  ctx.strokeStyle = "#4a3322";
  ctx.lineWidth = 7;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(0, -46);
  ctx.stroke();
  ctx.beginPath();
  ctx.roundRect(-width / 2, -88, width, 46, 10);
  paint(ctx, mine ? "#f2c14b" : "#d7a86a", 4);
  ctx.fillStyle = "#3b2a1e";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, 0, -64);
  if (elder) {
    ctx.font = "600 12.5px Fredoka, sans-serif";
    ctx.fillStyle = "#fff6e3";
    ctx.beginPath();
    ctx.roundRect(-26, -106, 52, 20, 6);
    paint(ctx, "#6d7fa6", 2.6);
    ctx.fillStyle = "#fff6e3";
    ctx.fillText("ELDER", 0, -95.5);
  } else if (online) {
    oval(ctx, width / 2 - 12, -76, 6, 6);
    paint(ctx, "#62c26a", 2.4, "#23642d");
  }
  ctx.restore();
}
