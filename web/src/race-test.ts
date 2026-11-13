// A development page for the race's 3D view: no chain, no screens, just the
// real race engine driven by a simple computer driver. Used to check how it looks.

import { D, loadCore } from "./core.ts";
import { lookFromGenes } from "./creature.ts";
import { DashSim, HAZARD, MOVE, ghostTrack, type Frame } from "./dash.ts";
import { RaceStage } from "./race-stage.ts";

function genes(head: number, horn: number, wing: number, tail: number, main: number, accent: number, pattern: number): number[] {
  const out = new Array(25).fill(0);
  [head, horn, wing, tail, pattern, 1, main, accent].forEach((value, locus) => {
    out[locus * 2] = value;
    out[locus * 2 + 1] = value;
  });
  return out;
}

function hex(values: number[]): string {
  return values.map((b) => b.toString(16).padStart(2, "0")).join("");
}

function entrant(speed: number, stamina: number, luck: number, level: number, generation: number, powers: number, wings: boolean): number[] {
  return [speed & 255, speed >> 8, stamina & 255, stamina >> 8, luck & 255, luck >> 8, level, generation & 255, (generation >> 8) & 255, 0, 0, powers & 255, powers >> 8, wings ? 1 : 0, 0];
}

async function main() {
  await loadCore();
  const query = new URLSearchParams(location.search);
  const seed = hex(Array.from({ length: 32 }, (_, i) => (i * 7 + Number(query.get("seed") ?? 3)) & 255));
  const entrants = [
    entrant(60, 60, 40, 5, 4, 0b11111111, true),
    entrant(40, 42, 30, 4, 0, 1, false),
    entrant(44, 38, 34, 4, 1, 0b101, true),
    entrant(38, 46, 28, 4, 0, 1 << 4, false),
    entrant(46, 40, 30, 5, 2, 1 << 2 | 1 << 3, true),
    entrant(42, 44, 36, 4, 0, 1 << 1, false),
  ];
  // ?ghost=1 races the ghost of an earlier, simpler run of the same course.
  let ghostRun: number[] | null = null;
  if (query.has("ghost")) {
    const earlier = new DashSim(seed, hex(entrants.flat()), 10);
    let frame: Frame = earlier.frame();
    let sprint = false;
    while (!frame.over) {
      const me = frame.runners[0];
      const codes: number[] = [];
      const wants: boolean = sprint ? me.stamina > 2500 : me.stamina > 7000;
      if (wants !== sprint) {
        codes.push(wants ? MOVE.SPRINT_ON : MOVE.SPRINT_OFF);
        sprint = wants;
      }
      const lane = Math.max(0, Math.min(2, Math.floor((me.x + 5250) / 3500)));
      for (const row of earlier.course) {
        const gap = row.pos - me.pos;
        if (gap < 0 || gap > me.v * 14 || row.kind > HAZARD.MUD || !((row.lanes >> lane) & 1)) continue;
        if (row.kind === HAZARD.LOG || row.kind === HAZARD.HEDGE) {
          if (gap <= me.v * 10 && me.y === 0) codes.push(MOVE.JUMP);
        } else if (me.lane === lane) codes.push(lane < 2 ? MOVE.RIGHT : MOVE.LEFT);
        break;
      }
      earlier.step(codes);
      frame = earlier.frame();
    }
    ghostRun = [...earlier.moves()];
  }
  const ghostTrackPoints = ghostRun ? ghostTrack(seed, hex(entrants[0]), hex(entrants.slice(1).flat()), 10, ghostRun) : null;
  const sim = new DashSim(seed, hex(entrants.flat()), 10);
  const looks = [
    genes(0, 1, 1, 0, 3, 6, 0),
    genes(2, 2, 0, 2, 9, 2, 1),
    genes(3, 5, 3, 4, 5, 1, 3),
    genes(1, 0, 0, 1, 6, 3, 2),
    genes(4, 0, 0, 1, 12, 10, 4),
    genes(3, 0, 2, 2, 1, 7, 5),
  ].map(lookFromGenes);
  const stage = new RaceStage(document.getElementById("stage") as HTMLCanvasElement, sim.course, looks.map((look, index) => ({
    look,
    level: 4,
    generation: entrants[index][7],
    name: index === 0 ? "" : ["", "Bracken (Elder)", "Pearl (Elder)", "Sorrel (Elder)", "Fern (Elder)", "Yarrow (Elder)"][index],
    you: index === 0,
    powers: index === 0 ? 255 : 1,
  })));

  if (ghostTrackPoints) {
    const end = ghostTrackPoints.length;
    stage.addGhosts([{ look: looks[2], level: 6, generation: 3, name: `Theo's ghost · ${(end / D.ticks).toFixed(1)} s`, track: ghostTrackPoints }]);
  }
  const kit = { sim, stage, frame: null as Frame | null, phase: "intro", ticks: 0, fps: 0 };
  Object.assign(window, { raceTest: kit });
  await stage.warmUp(sim.frame());

  let previous = sim.frame();
  let current = previous;
  let last = performance.now();
  let accumulator = 0;
  let started = last;
  let sprinting = false;
  let frames = 0;
  let fpsAt = last;

  const driver = (): number[] => {
    const me = current.runners[0];
    const codes: number[] = [];
    const wants = sprinting ? me.stamina > 1500 : me.stamina > 6000;
    if (wants !== sprinting) {
      codes.push(wants ? MOVE.SPRINT_ON : MOVE.SPRINT_OFF);
      sprinting = wants;
    }
    const lane = Math.max(0, Math.min(2, Math.floor((me.x + 5250) / 3500)));
    for (const row of sim.course) {
      const gap = row.pos - me.pos;
      if (gap < 0 || gap > me.v * 18) continue;
      if (row.kind > HAZARD.MUD || !((row.lanes >> lane) & 1)) continue;
      if (row.kind === HAZARD.LOG || row.kind === HAZARD.HEDGE) {
        if (gap <= me.v * 10 && me.y === 0) codes.push(MOVE.JUMP);
      } else if (me.lane === lane) {
        const open = [0, 1, 2].filter((l) => !((row.lanes >> l) & 1));
        if (open.length) {
          const target = open.reduce((a, b) => (Math.abs(b - lane) < Math.abs(a - lane) ? b : a));
          codes.push(target < lane ? MOVE.LEFT : MOVE.RIGHT);
        }
      }
      break;
    }
    if (current.tick % 45 === 20) codes.push(MOVE.POWER + (Math.floor(current.tick / 45) % D.powers));
    return codes.slice(0, 4);
  };

  const loop = (time: number) => {
    requestAnimationFrame(loop);
    const dt = Math.max(0, Math.min(0.1, (time - last) / 1000));
    last = time;
    frames += 1;
    if (time - fpsAt > 1000) {
      kit.fps = (frames * 1000) / (time - fpsAt);
      frames = 0;
      fpsAt = time;
    }
    if (kit.phase === "intro" && time - started > stage.introMs) {
      kit.phase = "count";
      started = time;
    }
    if (kit.phase === "count" && time - started > 2550) {
      kit.phase = "racing";
      started = time;
    }
    if (kit.phase === "racing") {
      accumulator += dt * 1000;
      while (accumulator >= 1000 / 30) {
        accumulator -= 1000 / 30;
        sim.step(driver());
        previous = current;
        current = sim.frame();
        kit.frame = current;
        kit.ticks += 1;
        for (const event of current.events) stage.onEvent(event, current);
        if (current.over) {
          kit.phase = "done";
          break;
        }
      }
    }
    stage.render(dt, previous, current, kit.phase === "racing" ? accumulator / (1000 / 30) : 1, kit.phase);
  };
  requestAnimationFrame(loop);
}

void main();
