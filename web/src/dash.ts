// A race, run by the same Rust the contract replays it with. This file only
// feeds it moves and reads the numbers back. There are no rules in here.

import { core, D, fromCoreJson } from "./core.ts";
import { fromHex } from "./chain.ts";

export const MOVE = { SPRINT_ON: 0, SPRINT_OFF: 1, BRAKE_ON: 2, BRAKE_OFF: 3, LEFT: 4, RIGHT: 5, JUMP: 6, POWER: 7 } as const;

export const HAZARD = { LOG: 0, ROCK: 1, HEDGE: 2, MUD: 3, RAMP: 4, BERRY: 5, ORB: 6 } as const;

export const EVENT = {
  JUMP: 1,
  LAND: 2,
  TRIP: 3,
  CAST: 4,
  BURNED: 5,
  CHILLED: 6,
  ZAPPED: 7,
  SNARED: 8,
  BLOCKED: 9,
  DODGED: 10,
  BERRY: 11,
  ORB: 12,
  RAMP: 13,
  HAZARD_BURNT: 14,
  FINISH: 15,
  CLEARED: 16,
} as const;

const HEADER = 5;
const SHOT_FIELDS = 5;
const TRAP_FIELDS = 3;
const EVENT_FIELDS = 4;

export interface Row {
  pos: number;
  kind: number;
  lanes: number;
}

export interface RunnerState {
  pos: number;
  x: number;
  y: number;
  v: number;
  stamina: number;
  winded: boolean;
  sprint: boolean;
  brake: boolean;
  mud: boolean;
  stumble: number;
  burn: number;
  chill: number;
  stun: number;
  snare: number;
  dash: number;
  shield: number;
  finished: number;
  lane: number;
  cooldown: number[];
}

export interface RaceEvent {
  kind: number;
  a: number;
  b: number;
  value: number;
}

export interface Shot {
  owner: number;
  target: number;
  pos: number;
  x: number;
  life: number;
}

export interface Trap {
  owner: number;
  pos: number;
  lane: number;
}

export interface Frame {
  tick: number;
  over: boolean;
  runners: RunnerState[];
  events: RaceEvent[];
  shots: Shot[];
  traps: Trap[];
}

export interface RaceOutcome {
  order: number[];
  ticks: number;
  finished: boolean;
  trips: number;
  cleared: number;
  landed: number;
}

export class DashSim {
  readonly course: Row[] = [];
  private log: number[] = [];
  private lastMoveTick = 0;
  private tick = 0;

  constructor(seedHex: string, entrantsHex: string, ease: number) {
    const bytes = fromHex(seedHex + entrantsHex);
    new Uint8Array(core.memory.buffer, core.dash_setup_ptr(), bytes.length).set(bytes);
    const rows = core.dash_start(ease);
    const course = new Int32Array(core.memory.buffer, core.dash_course(), rows * 3);
    for (let row = 0; row < rows; row++) {
      this.course.push({ pos: course[row * 3], kind: course[row * 3 + 1], lanes: course[row * 3 + 2] });
    }
  }

  /** Plays one tick. Up to four moves fit in a tick. */
  step(moves: number[]) {
    this.tick += 1;
    const now = moves.slice(0, 4);
    for (const code of now) {
      if (this.log.length >= D.maxMoves) break;
      this.log.push(((this.tick - this.lastMoveTick) << 4) | code);
      this.lastMoveTick = this.tick;
    }
    core.dash_step(now[0] ?? -1, now[1] ?? -1, now[2] ?? -1, now[3] ?? -1);
  }

  frame(): Frame {
    const pointer = core.dash_view();
    const head = new Int32Array(core.memory.buffer, pointer, HEADER);
    const [tick, over, events, shots, traps] = head;
    const length = HEADER + D.racers * D.runnerFields + events * EVENT_FIELDS + shots * SHOT_FIELDS + traps * TRAP_FIELDS;
    const v = new Int32Array(core.memory.buffer, pointer, length);
    const runners: RunnerState[] = [];
    let at = HEADER;
    for (let i = 0; i < D.racers; i++) {
      runners.push({
        pos: v[at],
        x: v[at + 1],
        y: v[at + 2],
        v: v[at + 3],
        stamina: v[at + 4],
        winded: v[at + 5] === 1,
        sprint: v[at + 6] === 1,
        brake: v[at + 7] === 1,
        mud: v[at + 8] === 1,
        stumble: v[at + 9],
        burn: v[at + 10],
        chill: v[at + 11],
        stun: v[at + 12],
        snare: v[at + 13],
        dash: v[at + 14],
        shield: v[at + 15],
        finished: v[at + 16],
        lane: v[at + 17],
        cooldown: Array.from(v.subarray(at + 18, at + 18 + D.powers)),
      });
      at += D.runnerFields;
    }
    const eventList: RaceEvent[] = [];
    for (let i = 0; i < events; i++) {
      eventList.push({ kind: v[at], a: v[at + 1], b: v[at + 2], value: v[at + 3] });
      at += EVENT_FIELDS;
    }
    const shotList: Shot[] = [];
    for (let i = 0; i < shots; i++) {
      shotList.push({ owner: v[at], target: v[at + 1], pos: v[at + 2], x: v[at + 3], life: v[at + 4] });
      at += SHOT_FIELDS;
    }
    const trapList: Trap[] = [];
    for (let i = 0; i < traps; i++) {
      trapList.push({ owner: v[at], pos: v[at + 1], lane: v[at + 2] });
      at += TRAP_FIELDS;
    }
    return { tick, over: over === 1, runners, events: eventList, shots: shotList, traps: trapList };
  }

  outcome(): RaceOutcome {
    return fromCoreJson<RaceOutcome>(core.dash_outcome());
  }

  /** The recorded moves, for the contract to play back. */
  moves(): number[] {
    return this.log;
  }
}

/** Where a ghost was, tick by tick. */
export interface GhostPoint {
  pos: number;
  x: number;
  y: number;
  v: number;
  finished: number;
}

/**
 * Plays someone's recorded run again, exactly as the contract did, and keeps
 * where their Kinling was at every tick. This uses the one race the rules
 * module holds, so call it before the live race is set up.
 */
export function ghostTrack(seedHex: string, entrantHex: string, fieldHex: string, ease: number, log: number[]): GhostPoint[] {
  const sim = new DashSim(seedHex, entrantHex + fieldHex, ease);
  const points: GhostPoint[] = [];
  let position = 0;
  let nextTick = log.length > 0 ? log[0] >> 4 : Infinity;
  let tick = 0;
  for (let guard = 0; guard < D.maxTicks + 5; guard++) {
    tick += 1;
    const codes: number[] = [];
    while (position < log.length && nextTick <= tick) {
      codes.push(log[position] & 15);
      position += 1;
      nextTick = position < log.length ? nextTick + (log[position] >> 4) : Infinity;
    }
    sim.step(codes);
    const frame = sim.frame();
    const r = frame.runners[0];
    points.push({ pos: r.pos, x: r.x, y: r.y, v: r.v, finished: r.finished });
    if (frame.over) break;
  }
  return points;
}
