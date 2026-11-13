// The player's connection to the valley. Taps change the screen at once and
// are sent in small batches. When the contract answers, its numbers win.

import { Signer, VALLEY, FRONT_DOOR_KEY, accountBalance, view, type Outcome } from "./chain.ts";
import { K } from "./core.ts";
import { NOBODY, OP, cropInfo, foodHelps, foodInfo, growXp, kinLevel, parseChallenges, parseKin, parseWorld, type Challenge, type Kin, type World } from "./world.ts";

const STORAGE = "kinlings.player.v1";
const POLL_MS = 5_000;
const FLUSH_MS = 2_200;
const MAX_BATCH = 24;
const ACT_TGAS = 15;
const HATCH_TGAS = 40;
const RACE_START_TGAS = 40;
const RACE_FINISH_TGAS = 50;
const HIRE_TGAS = 45;
const SALE_TGAS = 50;
const CHALLENGE_ENTRY_TGAS = 60;
const CHALLENGE_RUN_TGAS = 40;
const CHALLENGE_FINISH_TGAS = 80;
/** Below this, a race might not have enough gas reserved for it to be handed in. */
const LOW_GAS = 55_000_000_000_000_000_000_000n;
/** Kept in the farm account for gas when it spends NEAR. */
export const NEAR_RESERVE = 60_000_000_000_000_000_000_000n;
const YOCTO_PER_MILLI = 1_000_000_000_000_000_000_000n;

interface Saved {
  account: string;
  seed: string;
  name: string;
}

function save(saved: Saved) {
  localStorage.setItem(STORAGE, JSON.stringify(saved));
}

export function loadSaved(): Saved | null {
  try {
    const text = localStorage.getItem(STORAGE);
    return text ? (JSON.parse(text) as Saved) : null;
  } catch {
    return null;
  }
}

type Listener = () => void;

export class Game {
  signer: Signer;
  name: string;
  chain: World | null = null;
  view: World | null = null;
  fetchedAt = 0;
  around = 0;
  pending: number[][] = [];
  inFlight: number[][] = [];
  lastFeed = 0;
  listeners = new Set<Listener>();
  feedListeners = new Set<(entries: World["feed"]) => void>();
  private flushTimer = 0;
  private toppingUp = false;
  private lastBalanceCheck = -Infinity;
  /** This farm account's NEAR, as last seen. */
  nearBalance: bigint | null = null;
  earningListeners = new Set<(microNear: number) => void>();
  private lastEarned: number | null = null;

  constructor(signer: Signer, name: string) {
    this.signer = signer;
    this.name = name;
  }

  static fromSaved(saved: Saved): Game {
    const bytes = Uint8Array.from(saved.seed.match(/../g)!.map((pair) => parseInt(pair, 16)));
    return new Game(new Signer(saved.account, bytes), saved.name);
  }

  /** Opens a new farm through the public front door. */
  static async join(name: string, identity?: string): Promise<Game> {
    const session = await Signer.random("pending");
    const door = Signer.fromNearSecret(VALLEY, FRONT_DOOR_KEY);
    const opened = await door.call(
      VALLEY,
      "open_account",
      { session_key: await session.publicKeyText(), name, identity: identity ?? null },
      40,
    );
    if (!opened.ok) throw new Error(opened.error ?? "The valley could not open a farm");
    const account = opened.value as string;
    const seed = session.seedHex();
    save({ account, seed, name });
    return Game.fromSaved({ account, seed, name });
  }

  get me() {
    return this.view?.farms.get(this.view.me) ?? null;
  }

  chainNow(): number {
    if (!this.chain) return Date.now() / 1000;
    return this.chain.now + (performance.now() - this.fetchedAt) / 1000;
  }

  bag(item: number): number {
    return this.view?.bag.get(item) ?? 0;
  }

  kin(id: number): Kin | undefined {
    return this.view?.kins.get(id);
  }

  myKins(): Kin[] {
    const farm = this.me;
    if (!farm || !this.view) return [];
    return farm.kins.map((id) => this.view!.kins.get(id)).filter((k): k is Kin => Boolean(k));
  }

  /** Kinlings this player has hired from someone else, for as long as that lasts. */
  hiredKins(): Kin[] {
    if (!this.view) return [];
    return this.view.hired.map((id) => this.view!.kins.get(id)).filter((k): k is Kin => Boolean(k));
  }

  /** Everything this player can race or pair right now. */
  usableKins(): Kin[] {
    const now = this.chainNow();
    return [...this.myKins().filter((kin) => kin.rentedUntil <= now || kin.renterIndex === NOBODY), ...this.hiredKins()];
  }

  start() {
    void this.refresh();
    setInterval(() => {
      if (!document.hidden) void this.refresh();
    }, POLL_MS);
  }

  async refresh(): Promise<void> {
    try {
      const raw = await view<any[]>("world", {
        viewer: this.signer.accountId,
        from: Math.max(0, this.around - 2),
        limit: 6,
        since: this.lastFeed,
      });
      this.chain = parseWorld(raw);
      this.fetchedAt = performance.now();
      this.rebuild();
      const fresh = this.chain.feed.filter((f) => f.n >= this.lastFeed);
      if (fresh.length > 0) {
        this.lastFeed = fresh[fresh.length - 1].n + 1;
        for (const listener of this.feedListeners) listener(fresh);
      }
      this.noteEarnings();
      void this.watchBalance();
    } catch (error) {
      console.warn("Could not reach the valley", error);
    }
  }

  private rebuild() {
    if (!this.chain) return;
    const copy = structuredClone(this.chain);
    for (const op of [...this.inFlight, ...this.pending]) applyLocally(copy, op, this.chainNow());
    this.view = copy;
    for (const listener of this.listeners) listener();
  }

  /** Queues a tap: the screen changes now and the batch follows shortly. */
  tap(op: number[]) {
    if (this.pending.length + this.inFlight.length >= MAX_BATCH * 2) return;
    this.pending.push(op);
    this.rebuild();
    this.scheduleFlush();
  }

  private scheduleFlush(delay = FLUSH_MS) {
    if (this.flushTimer) return;
    this.flushTimer = window.setTimeout(() => {
      this.flushTimer = 0;
      void this.flush();
    }, delay);
  }

  /** Sends whatever is waiting. Safe to call at any time. */
  async flush(): Promise<void> {
    if (this.inFlight.length > 0 || this.pending.length === 0) return;
    this.inFlight = this.pending.splice(0, MAX_BATCH);
    try {
      // Anything after the fourth number is only the screen's own estimate.
      const ops = this.inFlight.map((op) => op.slice(0, 4));
      const outcome = await this.signer.call(VALLEY, "act", { ops }, ACT_TGAS);
      if (!outcome.ok) console.warn("Moves rejected", outcome.error);
    } catch (error) {
      console.warn("Moves were not delivered", error);
    }
    this.inFlight = [];
    await this.refresh();
    if (this.pending.length > 0) this.scheduleFlush(300);
  }

  /** Sends a one-off call that can't be batched, such as a hatch. */
  async call(method: string, args: unknown, tgas = 40): Promise<Outcome> {
    await this.flush();
    const outcome = await this.signer.call(VALLEY, method, args, tgas);
    await this.refresh();
    return outcome;
  }

  hatch(egg: number, name: string): Promise<Outcome> {
    return this.call("hatch", { egg_id: egg, name }, HATCH_TGAS);
  }

  /** Lines up a practice race. The rivals and the course come back from the
   * chain. `friends` are farms whose Kinlings should be asked first. */
  async raceStart(kinId: number, friends: number[] = []): Promise<RaceTicket> {
    await this.flush();
    const outcome = await this.signer.call(VALLEY, "race_start", { kin_id: kinId, friends: friends.length ? friends : null }, RACE_START_TGAS);
    if (!outcome.ok || typeof outcome.value !== "string") throw new Error(outcome.error ?? "The race could not start");
    void this.refresh();
    return parseTicket(outcome.value, null);
  }

  /** Hands the race in. The contract plays the moves again and pays out. */
  async raceFinish(moves: number[]): Promise<RaceResult> {
    const outcome = await this.signer.call(VALLEY, "race_finish", { moves }, RACE_FINISH_TGAS);
    if (!outcome.ok || typeof outcome.value !== "string") throw new Error(outcome.error ?? "The race could not be handed in");
    const [order, acorns, ticks, trips, cleared, landed, bonus, found, crop, cropUnits] = JSON.parse(outcome.value) as number[] & [number[]];
    void this.refresh();
    return { order: order as unknown as number[], acorns, ticks, trips, cleared, landed, bonus, found, crop, cropUnits, hash: outcome.hash };
  }

  // ----- Challenge races, for NEAR -----------------------------------------

  async challenges(): Promise<{ now: number; list: Challenge[] }> {
    return parseChallenges(await view<any[]>("challenges", {}));
  }

  async challengeGhosts(id: number): Promise<ChallengeGhosts | null> {
    const raw = await view<any[] | null>("challenge_ghosts", { challenge: id });
    if (!raw) return null;
    return {
      seed: raw[0],
      field: raw[1],
      ease: raw[2],
      ghosts: raw[3].map((g: any[]) => ({ playerIndex: g[0], name: g[1], entrant: g[2], ticks: g[3], moves: g[4] })),
    };
  }

  /** Opens a challenge, paying the fee from this farm's own account. */
  async openChallengeFromFarm(kinId: number, feeMilli: number, seats: number): Promise<number | null> {
    await this.flush();
    const outcome = await this.signer.call(VALLEY, "open_challenge_with_purse", { kin_id: kinId, fee_milli: feeMilli, seats }, CHALLENGE_ENTRY_TGAS);
    this.afterSpend();
    await this.refresh();
    return outcome.ok && typeof outcome.value === "number" ? outcome.value : null;
  }

  /** Joins a challenge, paying the fee from this farm's own account. */
  async joinChallengeFromFarm(id: number, kinId: number): Promise<boolean> {
    await this.flush();
    const outcome = await this.signer.call(VALLEY, "join_challenge_with_purse", { challenge: id, kin_id: kinId }, CHALLENGE_ENTRY_TGAS);
    this.afterSpend();
    await this.refresh();
    return outcome.ok && outcome.value === id;
  }

  /** Begins this player's one run at a challenge. */
  async challengeRun(id: number): Promise<RaceTicket> {
    await this.flush();
    const outcome = await this.signer.call(VALLEY, "challenge_run", { challenge: id }, CHALLENGE_RUN_TGAS);
    if (!outcome.ok || typeof outcome.value !== "string") throw new Error(outcome.error ?? "The challenge could not start");
    return parseTicket(outcome.value, id);
  }

  async challengeFinish(id: number, moves: number[]): Promise<ChallengeResult> {
    const outcome = await this.signer.call(VALLEY, "challenge_finish", { challenge: id, moves }, CHALLENGE_FINISH_TGAS);
    if (!outcome.ok || typeof outcome.value !== "string") throw new Error(outcome.error ?? "The run could not be handed in");
    const [ticks, place, handedIn, joined, prizeMicro] = JSON.parse(outcome.value) as number[];
    void this.refresh();
    return { ticks, place, handedIn, joined, prizeMicro, hash: outcome.hash };
  }

  async settleChallenge(id: number): Promise<boolean> {
    return (await this.call("settle_challenge", { challenge: id }, 60)).ok;
  }

  async cancelChallenge(id: number): Promise<boolean> {
    const done = (await this.call("cancel_challenge", { challenge: id }, 20)).ok;
    this.afterSpend();
    return done;
  }

  /** Kinlings by id, straight from the chain, for ones this screen hasn't seen. */
  async kinsById(ids: number[]): Promise<Map<number, Kin>> {
    const found = new Map<number, Kin>();
    const missing: number[] = [];
    for (const id of ids) {
      const known = this.kin(id);
      if (known) found.set(id, known);
      else missing.push(id);
    }
    if (missing.length > 0) {
      const rows = await view<any[]>("kins_by_id", { ids: missing.slice(0, 64) });
      for (const row of rows) {
        const kin = parseKin(row);
        found.set(kin.id, kin);
      }
    }
    return found;
  }

  // ----- Stalls priced in NEAR -----------------------------------------------

  /** Buys from a NEAR stall with NEAR from this farm's own account. */
  async buyListingFromFarm(listing: number, quantity: number): Promise<boolean> {
    await this.flush();
    const outcome = await this.signer.call(VALLEY, "buy_listing_with_purse", { listing, quantity }, SALE_TGAS);
    this.afterSpend();
    await this.refresh();
    return outcome.ok && outcome.value === true;
  }

  /** Links (or unlinks) this farm's NEAR Social account. */
  async setSocial(account: string | null): Promise<boolean> {
    return (await this.call("set_social", { account }, 12)).ok;
  }

  /** Which of these NEAR Social accounts play here: their farm index and account. */
  async farmsOfSocials(accounts: string[]): Promise<([number, string] | null)[]> {
    if (accounts.length === 0) return [];
    return view<([number, string] | null)[]>("farms_of_socials", { accounts: accounts.slice(0, 300) });
  }

  private afterSpend() {
    this.lastBalanceCheck = 0;
    void this.watchBalance();
  }

  /** Hires a Kinling with NEAR from this farm's own account. */
  async hireFromFarm(kinId: number): Promise<boolean> {
    await this.flush();
    const outcome = await this.signer.call(VALLEY, "rent_with_purse", { kin_id: kinId }, HIRE_TGAS);
    await this.refresh();
    this.lastBalanceCheck = 0;
    void this.watchBalance();
    return outcome.ok && outcome.value === true;
  }

  /** How much of this account's NEAR can be spent, leaving enough for gas. */
  spendableMilli(): number {
    if (this.nearBalance === null || this.nearBalance <= NEAR_RESERVE) return 0;
    return Number((this.nearBalance - NEAR_RESERVE) / YOCTO_PER_MILLI);
  }

  async setWallet(wallet: string | null): Promise<boolean> {
    return (await this.call("set_wallet", { wallet }, 12)).ok;
  }

  async cashOut(milli: number, to: string | null): Promise<boolean> {
    const outcome = await this.call("cash_out", { milli, to }, 20);
    this.lastBalanceCheck = 0;
    void this.watchBalance();
    return outcome.ok;
  }

  /** Spots NEAR that has come in since last time, so the screen can say so. */
  private noteEarnings() {
    const earned = this.chain?.nearEarnedMicro ?? 0;
    if (this.chain?.me === undefined || this.chain.me > 1_000_000) return;
    if (this.lastEarned !== null && earned > this.lastEarned) {
      const fresh = earned - this.lastEarned;
      for (const listener of this.earningListeners) listener(fresh);
      this.lastBalanceCheck = 0;
    }
    this.lastEarned = earned;
  }

  /** Reads this account's balance, and keeps it able to pay for its own moves. */
  private async watchBalance() {
    if (this.toppingUp || performance.now() - this.lastBalanceCheck < 15_000) return;
    this.lastBalanceCheck = performance.now();
    try {
      const balance = await accountBalance(this.signer.accountId);
      this.nearBalance = balance;
      for (const listener of this.listeners) listener();
      if (balance < LOW_GAS) {
        this.toppingUp = true;
        await this.signer.call(VALLEY, "top_up", {}, 12);
      }
    } catch {
      // The next check will try again.
    } finally {
      this.toppingUp = false;
    }
  }
}

/** The screen's best guess at what a tap does, until the contract confirms it. */
function applyLocally(world: World, op: number[], now: number) {
  const me = world.farms.get(world.me);
  if (!me) return;
  const [code, a, b] = op;
  const giveItem = (item: number, delta: number) => world.bag.set(item, Math.max(0, (world.bag.get(item) ?? 0) + delta));

  switch (code) {
    case OP.PLANT: {
      const info = cropInfo(b);
      if (info && me.plots[a]?.crop === 0) {
        me.plots[a] = { crop: b, readyAt: Math.floor(now) + info.grow, waterings: 0 };
        giveItem(b, -1);
      }
      break;
    }
    case OP.WATER: {
      const plot = world.farms.get(a)?.plots[b];
      if (plot && plot.crop !== 0 && plot.readyAt > now && plot.waterings < 3) {
        plot.readyAt -= Math.floor(((plot.readyAt - now) * K.waterPct) / 100);
        plot.waterings += 1;
      }
      break;
    }
    case OP.HARVEST: {
      const plot = me.plots[a];
      const info = cropInfo(plot?.crop ?? 0);
      if (plot && info && plot.readyAt <= now) {
        const practice = me.mastery[info.item - 1];
        const bonus = K.mastery.filter((needed) => practice >= needed).length;
        giveItem(info.item, info.harvest + bonus);
        me.mastery[info.item - 1] += 1;
        me.xp += info.rank;
        me.plots[a] = { crop: 0, readyAt: 0, waterings: 0 };
      }
      break;
    }
    case OP.FEED: {
      const kin = world.kins.get(a);
      const info = foodInfo(b);
      if (kin && info && foodHelps(b, kin.xp) && (world.bag.get(b) ?? 0) > 0) {
        kin.xp = growXp(kin.xp, info.xp, info.cap);
        kin.food = b;
        giveItem(b, -1);
      }
      break;
    }
    case OP.WARM: {
      const egg = world.eggs.get(a);
      if (egg && egg.warms < K.maxWarms) {
        egg.warms += 1;
        egg.readyAt = Math.max(Math.floor(now), egg.readyAt - K.warm);
      }
      break;
    }
    case OP.TONIC_EGG: {
      const egg = world.eggs.get(a);
      if (egg) {
        egg.readyAt -= K.tonicSecs;
        giveItem(7, -1);
      }
      break;
    }
    case OP.COLLECT: {
      const kin = world.kins.get(a);
      if (kin) {
        giveItem(0, kin.purse);
        kin.purse = 0;
      }
      break;
    }
    case OP.SELL: {
      const item = K.shops[a >> 1].items[a & 1].item;
      giveItem(item, -b);
      giveItem(0, op[4] ?? 0);
      break;
    }
    case OP.BUY: {
      const item = K.shops[a >> 1].items[a & 1].item;
      giveItem(item, b);
      giveItem(0, -(op[4] ?? 0));
      break;
    }
    case OP.INVEST:
      giveItem(0, -b);
      break;
    case OP.BUY_LAND:
      giveItem(0, -(op[4] ?? 0));
      for (let i = 0; i < K.plotsPerLand; i++) me.plots.push({ crop: 0, readyAt: 0, waterings: 0 });
      break;
  }
}

export interface RaceTicket {
  seed: string;
  entrants: string;
  ease: number;
  rested: boolean;
  rivals: Kin[];
  owners: { name: string; elder: boolean }[];
  /** The challenge this run is for, or null for a practice race. */
  challenge: number | null;
}

function parseTicket(text: string, challenge: number | null): RaceTicket {
  const [seed, entrants, ease, rested, rivalRows, owners] = JSON.parse(text) as [string, string, number, number, any[], [string, number][]];
  return {
    seed,
    entrants,
    ease,
    rested: rested === 1,
    rivals: rivalRows.map(parseKin),
    owners: owners.map(([name, elder]) => ({ name, elder: elder === 1 })),
    challenge,
  };
}

export interface RaceResult {
  order: number[];
  acorns: number;
  ticks: number;
  trips: number;
  cleared: number;
  landed: number;
  bonus: number;
  /** A rare food brought home, or 0. */
  found: number;
  /** The crop won and how many, or 0. */
  crop: number;
  cropUnits: number;
  hash: string;
}

export interface ChallengeResult {
  /** Finishing tick, or 0 if the Kinling didn't reach the line in time. */
  ticks: number;
  /** Place among those who have run so far. */
  place: number;
  handedIn: number;
  joined: number;
  /** NEAR won, in millionths, if it paid out with this run. */
  prizeMicro: number;
  hash: string;
}

export interface ChallengeGhosts {
  seed: string;
  field: string;
  ease: number;
  ghosts: { playerIndex: number; name: string; entrant: string; ticks: number; moves: number[] }[];
}

export function isGrown(kin: Kin): boolean {
  return kinLevel(kin.xp) >= K.adult;
}
