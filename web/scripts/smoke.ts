// Plays the whole game on the real test network: two new players, a first
// hatch, food that stops helping at its level, a pairing, a baby born as a
// sub-account of its mother, trading, a hire paid in NEAR, a stall sale paid
// in NEAR, a free practice race and a challenge race between the two players
// for NEAR. Run it with `npm run smoke`. It spends a little testnet NEAR.

import { readFileSync } from "node:fs";
import { FRONT_DOOR_KEY, Signer, VALLEY, accountBalance, accountGlobalContract, fromHex, view } from "../src/chain.ts";

const SUNWHEAT = 1;
const DEWBEAN = 2;
const PLANT = 1,
  FEED = 4,
  WARM = 5,
  SELL = 6,
  BREED = 20,
  STUD = 21,
  HIRE_OUT = 22,
  LIST_ITEM_NEAR = 35;

const wait = (seconds: number) => new Promise((resolve) => setTimeout(resolve, seconds * 1000));
const near = (yocto: bigint) => (Number(yocto / 10n ** 18n) / 1e6).toFixed(4);
const pass = (label: string) => console.log(`  PASS  ${label}`);

function check(condition: unknown, label: string): void {
  if (!condition) throw new Error(`FAILED: ${label}`);
  pass(label);
}

const frontDoor = Signer.fromNearSecret(VALLEY, FRONT_DOOR_KEY);
const unique = () => Array.from({ length: 6 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join("");

async function world(viewer?: string, from = 0, limit = 16): Promise<any[]> {
  return view("world", { viewer, from, limit });
}

async function openFarm(name: string): Promise<{ signer: Signer; index: number }> {
  const session = await Signer.random("pending");
  const key = await session.publicKeyText();
  const opened = await frontDoor.call(VALLEY, "open_account", { session_key: key, name }, 40);
  if (!opened.ok) throw new Error(`open_account failed: ${opened.error}`);
  console.log(`  opened ${name}: gas ${(opened.gasBurnt / 1e12).toFixed(1)} Tgas, burned ${near(opened.tokensBurnt)} NEAR`);
  const signer = new Signer(opened.value as string, Buffer.from(session.seedHex(), "hex"));
  const index = (await myFarm(signer))[0] as number;
  return { signer, index };
}

async function myFarm(signer: Signer): Promise<any[]> {
  const w = await world(signer.accountId);
  const mine = w[4] as number;
  return (w[5] as any[]).find((farm) => farm[0] === mine);
}

async function act(signer: Signer, ops: number[][]): Promise<number[]> {
  const outcome = await signer.call(VALLEY, "act", { ops }, 15);
  if (!outcome.ok) throw new Error(`act failed: ${outcome.error}`);
  console.log(`    act ${JSON.stringify(ops)} -> ${JSON.stringify(outcome.value)} (${(outcome.gasBurnt / 1e12).toFixed(1)} Tgas)`);
  return outcome.value as number[];
}

async function hatchEgg(signer: Signer, egg: number, name: string): Promise<void> {
  const outcome = await signer.call(VALLEY, "hatch", { egg_id: egg, name }, 40);
  if (!outcome.ok) throw new Error(`hatch failed: ${outcome.error}`);
  console.log(`    hatched ${name}: ${(outcome.gasBurnt / 1e12).toFixed(1)} Tgas, burned ${near(outcome.tokensBurnt)} NEAR, tx ${outcome.hash}`);
}

async function kinIds(signer: Signer): Promise<number[]> {
  return (await myFarm(signer))[5] as number[];
}

async function main() {
  console.log("Opening two farms through the public front door");
  const a = await openFarm("Smoke A");
  const b = await openFarm("Smoke B");
  const accountA = a.signer.accountId;
  check((await accountBalance(accountA)) > 0n, "the new account exists and holds gas money");

  console.log("First hatches");
  const eggA = (await myFarm(a.signer))[6][0] as number;
  const eggB = (await myFarm(b.signer))[6][0] as number;
  const nameA = unique();
  const nameB = unique();
  await hatchEgg(a.signer, eggA, nameA);
  await hatchEgg(b.signer, eggB, nameB);
  const [kinA] = await kinIds(a.signer);
  const [kinB] = await kinIds(b.signer);
  check(kinA && kinB, "both players have a Kinling");
  const founderAccount = `${nameA}.${VALLEY}`;
  check(await accountGlobalContract(founderAccount), `${founderAccount} is a real account running the global contract`);
  check((await accountBalance(founderAccount)) === 0n, "and it holds zero NEAR");

  console.log("Farm loop, without any wallet");
  check((await act(a.signer, [[PLANT, 0, SUNWHEAT, 0]]))[0] === 1, "planted");
  check((await act(b.signer, [[2, a.index, 0, 0]]))[0] === 1, "a neighbour watered it");
  check((await act(a.signer, [[SELL, 0, 1, 1]]))[0] === 1, "sold a crop to a shop");

  console.log("Growing both Kinlings up");
  const feedA = Array.from({ length: 5 }, () => [FEED, kinA, SUNWHEAT, 0]);
  check((await act(a.signer, feedA)).every((r) => r === 1), "fed to adult");
  check((await act(b.signer, [...Array.from({ length: 5 }, () => [FEED, kinB, SUNWHEAT, 0])])).every((r) => r === 1), "fed to adult");
  check((await act(a.signer, [[FEED, kinA, SUNWHEAT, 0]]))[0] === 0, "Sunwheat can't raise a Kinling past level 3, so it isn't eaten");

  console.log("Pairing with another player's Kinling");
  check((await act(b.signer, [[STUD, kinB, 25, 0]]))[0] === 1, "B offered their Kinling on the Matchmaker board");
  check((await act(a.signer, [[BREED, kinA, kinB, SUNWHEAT]]))[0] === 1, "A paid to pair");
  const eggChild = (await myFarm(a.signer))[6][0] as number;
  const warmOps = Array.from({ length: 8 }, () => [WARM, eggChild, 0, 0]);
  check((await act(b.signer, warmOps)).every((r) => r === 1), "B warmed the egg eight times");

  const w = await world(accountA);
  const eggInfo = (w[7] as any[]).find((e) => e[0] === eggChild);
  const delay = Math.max(0, eggInfo[4] - (w[0] as number)) + 3;
  console.log(`  waiting ${delay}s for the egg to be ready`);
  await wait(delay);

  console.log("A baby, born as a sub-account of its mother");
  const childName = unique();
  await hatchEgg(a.signer, eggChild, childName);
  const childAccount = `${childName}.${nameA}.${VALLEY}`;
  check(await accountGlobalContract(childAccount), `${childAccount} exists as a sub-account of its mother`);
  const kids = await kinIds(a.signer);
  check(kids.length === 2, "A now has two Kinlings");
  const purse = await view<any[]>("kins_by_id", { ids: [kinB] });
  check((purse[0][10] as number) === 25, "the stud fee reached the father's own purse");

  console.log("A challenge race between the two players, for testnet NEAR");
  const fee = 10;
  const opened = await a.signer.call(VALLEY, "open_challenge_with_purse", { kin_id: kinA, fee_milli: fee, seats: 2 }, 60);
  check(opened.ok && typeof opened.value === "number", `A opened a 0.01 NEAR challenge from A's farm account (#${opened.value})`);
  const challenge = opened.value as number;
  const runA = await a.signer.call(VALLEY, "challenge_run", { challenge }, 40);
  check(runA.ok, "A began a run");
  const raceA = await drive(runA.value as string);
  const doneA = await a.signer.call(VALLEY, "challenge_finish", { challenge, moves: raceA.moves }, 80);
  check(doneA.ok, `A handed in ${raceA.local.ticks / 30} s: ${doneA.value}`);
  const ghosts = await view<any[]>("challenge_ghosts", { challenge });
  check(ghosts[3].length === 1, "B can race the ghost of A's run");
  const joined = await b.signer.call(VALLEY, "join_challenge_with_purse", { challenge, kin_id: kinB }, 60);
  check(joined.ok && joined.value === challenge, "B joined, paying from B's farm account");
  const earnedBefore = [await earnedOf(a.signer), await earnedOf(b.signer)];
  const runB = await b.signer.call(VALLEY, "challenge_run", { challenge }, 40);
  const raceB = await drive(runB.value as string);
  const doneB = await b.signer.call(VALLEY, "challenge_finish", { challenge, moves: raceB.moves }, 80);
  check(doneB.ok, `B handed in ${raceB.local.ticks / 30} s, which filled the last seat: ${doneB.value}`);
  const earnedAfter = [await earnedOf(a.signer), await earnedOf(b.signer)];
  const paid = earnedAfter[0] - earnedBefore[0] + (earnedAfter[1] - earnedBefore[1]);
  check(paid === fee * 2 * 1000, `the winner was paid both fees, ${paid / 1e6} NEAR, and the valley kept nothing`);

  console.log("Hiring a Kinling for testnet NEAR");
  check((await act(b.signer, [[HIRE_OUT, kinB, 5, 0]]))[0] === 1, "B put their Kinling up for hire at 0.005 NEAR");
  const ownerBefore = await accountBalance(b.signer.accountId);
  const hired = await a.signer.call(VALLEY, "rent_with_purse", { kin_id: kinB }, 45);
  check(hired.ok && hired.value === true, "A hired it, paying from A's own farm account");
  await wait(3);
  const ownerAfter = await accountBalance(b.signer.accountId);
  check(ownerAfter > ownerBefore, `B was paid in NEAR (+${near(ownerAfter - ownerBefore)})`);

  console.log("A stall priced in testnet NEAR");
  check((await act(b.signer, [[LIST_ITEM_NEAR, DEWBEAN, 1, 4]]))[0] === 1, "B put a Dewbean out for 0.004 NEAR");
  let stall: number[] | undefined;
  for (let attempt = 0; attempt < 6 && !stall; attempt++) {
    // A view can come from a node a block behind the one that took the move.
    if (attempt > 0) await wait(1.5);
    stall = ((await world(b.signer.accountId))[13] as number[][]).find((l) => l[1] === b.index && l[3] === DEWBEAN && l[6] === 1);
  }
  check(stall, "the stall shows its price in NEAR");
  const sellerBefore = await accountBalance(b.signer.accountId);
  const bought = await a.signer.call(VALLEY, "buy_listing_with_purse", { listing: stall![0], quantity: 1 }, 50);
  check(bought.ok && bought.value === true, "A bought it with NEAR from A's own farm account");
  // The payment is a few receipts behind the purchase.
  let sellerAfter = sellerBefore;
  for (let attempt = 0; attempt < 8 && sellerAfter <= sellerBefore; attempt++) {
    await wait(2);
    sellerAfter = await accountBalance(b.signer.accountId);
  }
  check(sellerAfter > sellerBefore, `B was paid in NEAR for it (+${near(sellerAfter - sellerBefore)})`);

  console.log("A free practice race, driven move by move");
  const acornsBefore = await acornsOf(a.signer);
  const ticket = await a.signer.call(VALLEY, "race_start", { kin_id: kinB, friends: null }, 40);
  check(ticket.ok && (await acornsOf(a.signer)) === acornsBefore, "practice races are free to enter");
  const practice = await drive(ticket.value as string);
  const finished = await a.signer.call(VALLEY, "race_finish", { moves: practice.moves }, 60);
  check(finished.ok, `the contract replayed every move (${(finished.gasBurnt / 1e12).toFixed(1)} Tgas)`);
  const answer = JSON.parse(finished.value as string);
  check(JSON.stringify(answer[0]) === JSON.stringify(practice.local.order), `the contract saw the same race: ${JSON.stringify(answer[0])}`);
  console.log(`  won ${answer[1]} acorns, ${answer[9]} of crop ${answer[8]}, rare find ${answer[7]}, and no NEAR. tx ${finished.hash}`);

  const balance = await accountBalance(accountA);
  console.log(`\nA's account still holds ${near(balance)} NEAR. Every move above was signed in the background.`);
  console.log("All on-chain checks passed.");
}

async function acornsOf(signer: Signer): Promise<number> {
  const bag = (await world(signer.accountId))[14] as number[][];
  return bag.find((pair) => pair[0] === 0)?.[1] ?? 0;
}

/** NEAR earned so far, in millionths. */
async function earnedOf(signer: Signer): Promise<number> {
  return ((await world(signer.accountId))[17] as any[])[1] as number;
}

/** Drives a race ticket through the real rules, and waits as long as the race would really take. */
async function drive(ticketText: string): Promise<{ moves: number[]; local: any }> {
  const [seed, entrants, ease] = JSON.parse(ticketText) as [string, string, number];
  const startedAt = Date.now();

  const wasm = await WebAssembly.instantiate(readFileSync(new URL("../public/core.wasm", import.meta.url)), {});
  const core = wasm.instance.exports as any;
  const read = (length: number) => new TextDecoder().decode(new Uint8Array(core.memory.buffer, core.output_ptr(), length));
  const K = JSON.parse(read(core.dash_constants()));
  new Uint8Array(core.memory.buffer, core.dash_setup_ptr(), 32 + entrants.length / 2).set(fromHex(seed + entrants));
  const rows = core.dash_start(ease);
  const raw = new Int32Array(core.memory.buffer, core.dash_course(), rows * 3);
  const course = Array.from({ length: rows }, (_, i) => ({ pos: raw[i * 3], kind: raw[i * 3 + 1], lanes: raw[i * 3 + 2] }));

  const moves: number[] = [];
  let lastMove = 0;
  let sprinting = false;
  let turned = 0;
  for (;;) {
    const v = new Int32Array(core.memory.buffer, core.dash_view(), 5 + K.racers * K.runnerFields);
    if (v[1] === 1) break;
    const tick = v[0] + 1;
    const [pos, x, y, speed, stamina] = [v[5], v[6], v[7], Math.max(300, v[8]), v[9]];
    const codes: number[] = [];
    const wants = sprinting ? stamina > 1500 : stamina > 6000;
    if (wants !== sprinting) {
      codes.push(wants ? 0 : 1);
      sprinting = wants;
    }
    const lane = Math.max(0, Math.min(2, Math.floor((x + 5250) / 3500)));
    for (const row of course) {
      const gap = row.pos - pos;
      if (gap < 0 || gap > speed * 18 || row.kind > 3 || !((row.lanes >> lane) & 1)) continue;
      if (row.kind === 0 || row.kind === 2) {
        if (gap <= speed * 10 && y === 0) codes.push(6);
      } else if (tick > turned) {
        const open = [0, 1, 2].filter((l) => !((row.lanes >> l) & 1));
        if (open.length) {
          const target = open.reduce((a, b) => (Math.abs(b - lane) < Math.abs(a - lane) ? b : a));
          codes.push(target < lane ? 4 : 5);
          turned = tick + 9;
        }
      }
      break;
    }
    const now = codes.slice(0, 4);
    for (const code of now) {
      moves.push(((tick - lastMove) << 4) | code);
      lastMove = tick;
    }
    core.dash_step(now[0] ?? -1, now[1] ?? -1, now[2] ?? -1, now[3] ?? -1);
  }
  const local = JSON.parse(read(core.dash_outcome()));
  const wall = (local.ticks / K.ticks) * 1000 - (Date.now() - startedAt);
  console.log(`  ${moves.length} moves, finished ${local.order.indexOf(0) + 1} of ${K.racers} in ${(local.ticks / K.ticks).toFixed(1)} s. Waiting ${Math.round(wall / 1000)}s, as long as the race would really take`);
  await wait(Math.max(0, wall / 1000) + 1);
  return { moves, local };
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
