// Test page: the 3D valley with faked farm data, so nothing touches the chain.
// Open three-valley-test.html?phase=0.28&lot=1&eggs=3
// (phase: time of day, lot: farm to look at, eggs: eggs in my nest, kins: per farm)

import { lookFromGenes } from "../creature.ts";
import { loadCore } from "../core.ts";
import type { Game } from "../game.ts";
import type { Farm, Kin, Egg, World, Plot } from "../world.ts";
import { Scene } from "./valley3d.ts";

await loadCore();

const params = new URLSearchParams(location.search);
const phase = params.has("phase") ? Number(params.get("phase")) : 0.28;
const lot = Number(params.get("lot") ?? 1);
const eggsInNest = Number(params.get("eggs") ?? 3);
const kinsPerFarm = Number(params.get("kins") ?? 6);
const rankTest = params.get("rank");

function genesFor(seed: number): number[] {
  const out: number[] = [];
  const pick = (n: number, salt: number) => (seed * 17 + salt * 31) % n;
  const head = pick(5, 1);
  const horn = pick(6, 2);
  const wing = pick(5, 3);
  const tail = pick(5, 4);
  const pattern = pick(6, 5);
  const eyes = pick(4, 6);
  const main = pick(16, 7);
  const accent = pick(16, 8);
  out.push(head, head, horn, horn, wing, wing, tail, tail, pattern, pattern, eyes, eyes, main, main, accent, accent, 3, 0, 3, 0, 3, 0, seed % 11 === 0 ? 1 : 0);
  return out;
}

const NOW = 1_700_000_000;
const CROPS = [1, 2, 3, 4, 5, 6];
const GROW = 120;

function makeKin(id: number, owner: number, generation: number, level: number): Kin {
  const genes = genesFor(id + 1);
  return {
    id,
    name: `kin${id}`,
    account: "x",
    owner,
    xp: 100 * level * level,
    mother: 0,
    father: 0,
    generation,
    restUntil: 0,
    studFee: 0,
    purse: 0,
    wins: 0,
    food: 1,
    genes,
    children: [],
    look: lookFromGenes(genes),
    rentMilli: 0,
    renterIndex: 0,
    rentedUntil: 0,
    childCount: 0,
    raceReadyAt: 0,
    powers: 0,
  };
}

const farms = new Map<number, Farm>();
const kins = new Map<number, Kin>();
const eggs = new Map<number, Egg>();
let nextKin = 1;
let nextEgg = 1;
for (let index = 0; index < 8; index++) {
  const plots: Plot[] = [];
  const plotCount = index === lot ? 12 : 6 + (index % 3) * 2;
  for (let p = 0; p < plotCount; p++) {
    if (p % 7 === 6) {
      plots.push({ crop: 0, readyAt: 0, waterings: 0 });
    } else {
      const crop = CROPS[p % CROPS.length];
      const stageBias = p % 4; // Spread of growth stages for testing.
      plots.push({ crop, readyAt: stageBias === 3 ? NOW - 1 : NOW + GROW * (0.25 + stageBias * 0.26), waterings: p % 3 === 0 ? 1 : 0 });
    }
  }
  const myKins: number[] = [];
  for (let k = 0; k < kinsPerFarm; k++) {
    const id = nextKin++;
    kins.set(id, makeKin(id, index, k % 7, 1 + (k % 8)));
    myKins.push(id);
  }
  const myEggs: number[] = [];
  const eggCount = index === lot ? eggsInNest : index % 3;
  for (let e = 0; e < eggCount; e++) {
    const id = nextEgg++;
    eggs.set(id, { id, mother: myKins[0], father: myKins[1] ?? myKins[0], food: 1, readyAt: e % 2 ? NOW - 1 : NOW + 90 + e * 30, warms: 0, hatching: false, wild: false });
    myEggs.push(id);
  }
  const rank = rankTest ? Number(rankTest) : 1 + ((index * 3) % 9);
  farms.set(index, {
    index,
    name: `Farmer ${index}`,
    xp: rank * rank * 60,
    kinCount: myKins.length,
    plots,
    kins: myKins,
    eggs: myEggs,
    seen: NOW - (index === 1 ? 10 : 400),
    elder: index === 3,
    mastery: [],
  });
}

const world = {
  now: NOW,
  players: 8,
  online: 2,
  oak: 1,
  me: lot,
  farms,
  kins,
  eggs,
  shops: [],
  feed: [],
  studs: [],
  listings: [],
  bag: new Map(),
  top: [],
} as unknown as World;

const fakeGame = {
  view: world,
  chain: world,
  around: lot,
  chainNow: () => NOW + performance.now() / 8000,
  refresh: async () => undefined,
} as unknown as Game;

const canvas = document.getElementById("valley") as HTMLCanvasElement;
const scene = new Scene(canvas, fakeGame);
scene.timeOverride = phase;
scene.jumpToLot(lot);
Object.assign(window, { scene, world });
