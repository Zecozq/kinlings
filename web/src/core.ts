// The Rust rules, loaded in the browser. Prices, reasoning and the fast-forward
// come from here, so the screen can never disagree with the contract.

export interface CropInfo {
  item: number;
  name: string;
  grow: number;
  harvest: number;
  rank: number;
}

/** Something a Kinling can eat, and how far it can raise one. */
export interface FoodInfo {
  item: number;
  name: string;
  xp: number;
  /** The highest level this food can bring a Kinling to. */
  cap: number;
  rare: boolean;
  /** Crops whose harvests can turn this up: [crop, chance in 1,000]. */
  finds: [number, number][];
  /** Chance in 1,000 a rested Kinling's race win brings one home. */
  raceFind: number;
}

export interface ShopInfo {
  keeper: string;
  label: string;
  margin: number;
  comfortable: number;
  items: { item: number; base: number; target: number }[];
}

export interface Constants {
  crops: CropInfo[];
  foods: FoodInfo[];
  shops: ShopInfo[];
  tokens: string[];
  ranks: number[];
  kinLevels: number[];
  adult: number;
  /** Racing grows a Kinling up to this level; past it only food will do. */
  raceLevelCap: number;
  rest: number;
  incubate: number;
  warm: number;
  maxWarms: number;
  tonicSecs: number;
  waterPct: number;
  welcome: number;
  pairing: number;
  raceBonus: number;
  /** Crops a rested Kinling brings home for 1st, 2nd and 3rd. */
  raceCrops: number[];
  raceRest: number;
  stallTax: number;
  land: number[];
  plotsPerLand: number;
  startPlots: number;
  mastery: number[];
  total: number;
}

export interface SlotQuote {
  pays: number;
  charges: number;
  fair: number;
  scarcity: number;
  demand: number;
  tillPct: number;
  stock: number;
  why: string[];
}

export interface ShopQuote {
  till: number;
  closed: boolean;
  slots: SlotQuote[];
}

interface Exports {
  memory: WebAssembly.Memory;
  output_ptr(): number;
  constants(): number;
  quotes(...args: number[]): number;
  sim_shop(...args: number[]): void;
  sim_start(seed: number, farmers: number, oak: number): void;
  sim_step(): number;
  dash_constants(): number;
  dash_setup_ptr(): number;
  dash_start(ease: number): number;
  dash_course(): number;
  dash_step(a: number, b: number, c: number, d: number): void;
  dash_view(): number;
  dash_outcome(): number;
}

export interface DashConstants {
  ticks: number;
  racers: number;
  lanes: number;
  laneWidth: number;
  track: number;
  maxMoves: number;
  runnerFields: number;
  powers: number;
  /** A race stops at this tick whether or not everyone is home. */
  maxTicks: number;
}

export let core: Exports;
export let K: Constants;
export let D: DashConstants;

function read(length: number): string {
  return new TextDecoder().decode(new Uint8Array(core.memory.buffer, core.output_ptr(), length));
}

export async function loadCore(): Promise<void> {
  const response = await fetch(`${import.meta.env.BASE_URL}core.wasm`);
  const { instance } = await WebAssembly.instantiate(await response.arrayBuffer(), {});
  core = instance.exports as unknown as Exports;
  K = JSON.parse(read(core.constants()));
  D = JSON.parse(read(core.dash_constants()));
}

export function fromCoreJson<T>(length: number): T {
  return JSON.parse(read(length)) as T;
}

export function quoteShop(id: number, state: number[], oak: number, population: number, now: number): ShopQuote {
  return JSON.parse(read(core.quotes(id, ...state, oak, population, now)));
}

export function stageSimShop(id: number, state: number[]): void {
  core.sim_shop(id, ...state);
}

export function startSim(seed: number, farmers: number, oak: number): void {
  core.sim_start(seed, farmers, oak);
}

export interface SimFrame {
  step: number;
  prices: number[];
  tills: number[];
  closed: number[];
  oak: number;
  events: [string, number, number][];
}

export function stepSim(): SimFrame {
  return JSON.parse(read(core.sim_step()));
}
