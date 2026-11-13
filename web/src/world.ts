// The valley as the contract reports it. `world` returns plain arrays to keep
// the contract small, and this file is where they get their names.

import { lookFromGenes, type Look } from "./creature.ts";
import { K } from "./core.ts";
import { statsFromGenes } from "./powers.ts";

export const ACORN = 0;
export const TONIC = 7;
export const WILD_EGG = 8;
/** The rare foods: found at harvests and races, never sold in shops. */
export const GLOWCAP = 9;
export const DRAGONFRUIT = 10;
export const HONEY = 11;
export const RARE_FOODS = [GLOWCAP, DRAGONFRUIT, HONEY];
export const NOBODY = 4294967295;

export const OP = {
  PLANT: 1,
  WATER: 2,
  HARVEST: 3,
  FEED: 4,
  WARM: 5,
  SELL: 6,
  BUY: 7,
  INVEST: 8,
  CLAIM: 9,
  COLLECT: 10,
  WAVE: 11,
  BUY_LAND: 12,
  TONIC_EGG: 14,
  WILD_EGG_OPEN: 15,
  BREED: 20,
  STUD: 21,
  HIRE_OUT: 22,
  LIST_ITEM: 30,
  LIST_EGG: 31,
  LIST_KIN: 32,
  BUY_LISTING: 33,
  CANCEL_LISTING: 34,
  LIST_ITEM_NEAR: 35,
  LIST_EGG_NEAR: 36,
  LIST_KIN_NEAR: 37,
} as const;

export interface Plot {
  crop: number;
  readyAt: number;
  waterings: number;
}

export interface Farm {
  index: number;
  name: string;
  xp: number;
  /** All the Kinlings this farm owns. `kins` may list only the newest. */
  kinCount: number;
  plots: Plot[];
  kins: number[];
  eggs: number[];
  seen: number;
  elder: boolean;
  mastery: number[];
  /** The NEAR Social account this farm says it is, or "". */
  social?: string;
  /** The farm's own NEAR account. */
  account?: string;
}

export interface Kin {
  id: number;
  name: string;
  account: string;
  owner: number;
  xp: number;
  mother: number;
  father: number;
  generation: number;
  restUntil: number;
  studFee: number;
  purse: number;
  wins: number;
  food: number;
  genes: number[];
  children: number[];
  look: Look;
  /** Price to hire, in thousandths of a NEAR. 0 if not for hire. */
  rentMilli: number;
  renterIndex: number;
  rentedUntil: number;
  childCount: number;
  raceReadyAt: number;
  powers: number;
}

export interface Egg {
  id: number;
  mother: number;
  father: number;
  food: number;
  readyAt: number;
  warms: number;
  hatching: boolean;
  wild: boolean;
}

export interface Shelf {
  stock: number;
  recentIn: number;
  recentOut: number;
}

export interface ShopState {
  held: number;
  pot: number;
  closed: boolean;
  shares: number;
  shelves: Shelf[];
  lastTick: number;
  raw: number[];
}

export interface TopRacer {
  kin: number;
  wins: number;
  owner: string;
}

export interface FeedEntry {
  n: number;
  at: number;
  kind: number;
  who: string;
  what: string;
}

export interface Listing {
  id: number;
  seller: number;
  kind: number;
  itemId: number;
  quantity: number;
  /** In acorns, or in thousandths of a NEAR when `inNear`. */
  unitPrice: number;
  inNear: boolean;
}

export interface Leader {
  index: number;
  name: string;
  xp: number;
  level: number;
  elder: boolean;
}

export interface World {
  now: number;
  players: number;
  online: number;
  oak: number;
  me: number;
  farms: Map<number, Farm>;
  kins: Map<number, Kin>;
  eggs: Map<number, Egg>;
  shops: ShopState[];
  raceBudget: number;
  nearPotMicro: number;
  topRacers: TopRacer[];
  feed: FeedEntry[];
  studs: number[];
  listings: Listing[];
  bag: Map<number, number>;
  top: Leader[];
  rentals: number[];
  wallet: string;
  nearEarnedMicro: number;
  hired: number[];
  races: number;
}

export function parseKin(row: any[]): Kin {
  return {
    id: row[0],
    name: row[1],
    account: row[2],
    owner: row[3],
    xp: row[4],
    mother: row[5],
    father: row[6],
    generation: row[7],
    restUntil: row[8],
    studFee: row[9],
    purse: row[10],
    wins: row[11],
    food: row[12],
    genes: row[13],
    children: row[14],
    look: lookFromGenes(row[13]),
    rentMilli: row[15],
    renterIndex: row[16],
    rentedUntil: row[17],
    childCount: row[18],
    raceReadyAt: row[19],
    powers: statsFromGenes(row[13]).powers,
  };
}

export function parseWorld(raw: any[]): World {
  const farms = new Map<number, Farm>();
  for (const row of raw[5]) {
    farms.set(row[0], {
      index: row[0],
      name: row[1],
      xp: row[2],
      kinCount: row[3],
      plots: row[4].map((p: number[]) => ({ crop: p[0], readyAt: p[1], waterings: p[2] })),
      kins: row[5],
      eggs: row[6],
      seen: row[7],
      elder: row[8] === 1,
      mastery: row[9],
      social: row[10] ?? "",
      account: row[11] ?? "",
    });
  }
  const kins = new Map<number, Kin>();
  for (const row of raw[6]) kins.set(row[0], parseKin(row));
  const mine: any[] = raw[17];
  const eggs = new Map<number, Egg>();
  for (const row of raw[7]) {
    eggs.set(row[0], {
      id: row[0],
      mother: row[1],
      father: row[2],
      food: row[3],
      readyAt: row[4],
      warms: row[5],
      hatching: row[6] === 1,
      wild: row[7] === 1,
    });
  }
  return {
    now: raw[0],
    players: raw[1],
    online: raw[2],
    oak: raw[3],
    me: raw[4],
    farms,
    kins,
    eggs,
    shops: raw[8].map((s: number[]) => ({
      held: s[0],
      pot: s[1],
      closed: s[2] === 1,
      shares: s[3],
      shelves: [
        { stock: s[4], recentIn: s[5], recentOut: s[6] },
        { stock: s[7], recentIn: s[8], recentOut: s[9] },
      ],
      lastTick: s[10],
      raw: s,
    })),
    raceBudget: raw[9][0],
    nearPotMicro: raw[9][1],
    topRacers: raw[10].map((t: any[]) => ({ kin: t[0], wins: t[1], owner: t[2] })),
    feed: raw[11].map((f: any[]) => ({ n: f[0], at: f[1], kind: f[2], who: f[3], what: f[4] })),
    studs: raw[12],
    listings: raw[13].map((l: number[]) => ({
      id: l[0],
      seller: l[1],
      kind: l[2],
      itemId: l[3],
      quantity: l[4],
      unitPrice: l[5],
      inNear: l[6] === 1,
    })),
    bag: new Map(raw[14].map((pair: number[]) => [pair[0], pair[1]])),
    top: raw[15].map((t: any[]) => ({ index: t[0], name: t[1], xp: t[2], level: t[3], elder: t[4] === 1 })),
    rentals: raw[16],
    wallet: mine[0],
    nearEarnedMicro: mine[1],
    hired: mine[2],
    races: mine[3],
  };
}

export function levelFor(xp: number, table: number[]): number {
  let level = 1;
  table.forEach((needed, index) => {
    if (xp >= needed) level = index + 1;
  });
  return level;
}

export const farmerRank = (xp: number) => levelFor(xp, K.ranks);
export const kinLevel = (xp: number) => levelFor(xp, K.kinLevels);

const RANK_TITLES = [
  "Seed Sorter",
  "Sprout Tender",
  "Row Hoer",
  "Patch Keeper",
  "Field Hand",
  "Good Neighbour",
  "Harvest Lead",
  "Master Grower",
  "Valley Elder",
  "Legend of the Valley",
];

export const rankTitle = (rank: number) => RANK_TITLES[Math.min(rank, 10) - 1];

export function cropInfo(item: number) {
  return K.crops.find((c) => c.item === item);
}

export function itemName(item: number): string {
  if (item === ACORN) return "Acorns";
  if (item === TONIC) return "Warmth Tonic";
  if (item === WILD_EGG) return "Wild Egg";
  return foodInfo(item)?.name ?? "?";
}

export function foodInfo(item: number) {
  return K.foods.find((f) => f.item === item);
}

/** Growth after gaining `gain` from a source that stops at `cap`. Never shrinks. */
export function growXp(xp: number, gain: number, cap: number): number {
  const ceiling = K.kinLevels[Math.max(1, Math.min(cap, K.kinLevels.length)) - 1];
  return xp >= ceiling ? xp : Math.min(xp + gain, ceiling);
}

/** True if this food would still help a Kinling with this much growth. */
export function foodHelps(item: number, xp: number): boolean {
  const food = foodInfo(item);
  return Boolean(food) && kinLevel(xp) < food!.cap;
}

/** "0.05" for 50 thousandths of a NEAR. */
export function nearText(milli: number): string {
  return (milli / 1000).toFixed(3).replace(/\.?0+$/, "");
}

// ----- Challenge races ------------------------------------------------------

export interface ChallengeEntry {
  playerIndex: number;
  name: string;
  kinId: number;
  kinName: string;
  /** When they began their run, or 0. */
  started: number;
  /** Their finishing tick, DID_NOT_FINISH, or 0 if not handed in. */
  ticks: number;
  prizeMicro: number;
}

export interface Challenge {
  id: number;
  hostIndex: number;
  hostName: string;
  feeMilli: number;
  seats: number;
  opened: number;
  closes: number;
  settled: boolean;
  entries: ChallengeEntry[];
}

export const DID_NOT_FINISH = 4294967295;

export function parseChallenges(raw: any[]): { now: number; list: Challenge[] } {
  return {
    now: raw[0],
    list: raw[1].map((row: any[]) => ({
      id: row[0],
      hostIndex: row[1],
      hostName: row[2],
      feeMilli: row[3],
      seats: row[4],
      opened: row[5],
      closes: row[6],
      settled: row[7] === 1,
      entries: row[8].map((e: any[]) => ({
        playerIndex: e[0],
        name: e[1],
        kinId: e[2],
        kinName: e[3],
        started: e[4],
        ticks: e[5],
        prizeMicro: e[6],
      })),
    })),
  };
}

/** Runners fastest first; unfinished last; ties to whoever ran first. */
export function standings(challenge: Challenge): ChallengeEntry[] {
  const time = (e: ChallengeEntry) => (e.ticks === 0 ? DID_NOT_FINISH : e.ticks);
  return [...challenge.entries].sort((a, b) => time(a) - time(b) || a.started - b.started);
}

/** How the fees are shared, by how many joined: percent to 1st, 2nd and 3rd. */
export function prizeShares(runners: number): number[] {
  if (runners <= 2) return [100, 0, 0];
  if (runners === 3) return [70, 30, 0];
  if (runners === 4) return [60, 30, 10];
  return [50, 30, 20];
}
