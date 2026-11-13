// Two real browsers play the actual game against the live contract and take
// pictures along the way: farming, a pairing across players, a challenge race
// between them for NEAR, a hire, a NEAR stall sale and a practice race. Run
// the dev server first, then:
//   npm install --no-save playwright
//   node scripts/playtest.mjs <folder for screenshots>
// It spends a little testnet NEAR.

import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const out = process.argv[2] ?? "playtest-shots";
mkdirSync(out, { recursive: true });
const URL = process.env.KINLINGS_URL ?? "http://localhost:3000/";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let shot = 0;
const failures = [];

function check(condition, label) {
  console.log(`  ${condition ? "PASS" : "FAIL"}  ${label}`);
  if (!condition) failures.push(label);
}

async function player(browser, name) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  page.on("pageerror", (error) => {
    console.log(`  PAGE ERROR (${name}): ${error.message}`);
    failures.push(`page error: ${error.message}`);
  });
  page.on("console", (message) => {
    if (message.type() === "error") console.log(`  console (${name}): ${message.text()}`);
  });
  await page.goto(URL);
  await page.waitForSelector(".title input");
  await page.fill(".title input", name);
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => window.kinlings?.game.me, undefined, { timeout: 60_000 });
  return page;
}

async function snap(page, label) {
  shot += 1;
  await page.screenshot({ path: join(out, `${String(shot).padStart(2, "0")}-${label}.png`) });
  console.log(`  shot ${shot}: ${label}`);
}

const state = (page) =>
  page.evaluate(() => {
    const k = window.kinlings;
    const me = k.game.me;
    return {
      me: k.game.view.me,
      name: me.name,
      acorns: k.game.bag(0),
      sunwheat: k.game.bag(1),
      xp: me.xp,
      plots: me.plots,
      kins: k.game.myKins().map((kin) => ({ id: kin.id, name: kin.name, xp: kin.xp, purse: kin.purse, account: kin.account })),
      eggs: me.eggs,
      now: k.game.chainNow(),
    };
  });

/** Drives the live race with key events, the same path a person's keyboard takes. */
const drive = (page) =>
  page.evaluate(() => {
    const race = window.kinlingsRace;
    const key = (code, down = true) => window.dispatchEvent(new KeyboardEvent(down ? "keydown" : "keyup", { code }));
    let sprint = false;
    let turnedAt = 0;
    let poweredAt = 0;
    let next = 0;
    const powers = race.myPowers.length;
    const tick = () => {
      if (race.phase !== "racing") return;
      requestAnimationFrame(tick);
      const me = race.current.runners[0];
      const wants = sprint ? me.stamina > 1500 : me.stamina > 6000;
      if (wants !== sprint) {
        key("ArrowUp", wants);
        sprint = wants;
      }
      const lane = Math.max(0, Math.min(2, Math.floor((me.x + 5250) / 3500)));
      for (const row of race.sim.course) {
        const gap = row.pos - me.pos;
        if (gap < 0 || gap > me.v * 18 || row.kind > 3 || !((row.lanes >> lane) & 1)) continue;
        if (row.kind === 0 || row.kind === 2) {
          if (gap <= me.v * 10 && me.y === 0) key("Space");
        } else if (performance.now() - turnedAt > 350) {
          const open = [0, 1, 2].filter((l) => !((row.lanes >> l) & 1));
          if (open.length) {
            const target = open.reduce((a, b) => (Math.abs(b - lane) < Math.abs(a - lane) ? b : a));
            key(target < lane ? "ArrowLeft" : "ArrowRight");
            turnedAt = performance.now();
          }
        }
        break;
      }
      if (powers && performance.now() - poweredAt > 1500) {
        poweredAt = performance.now();
        key(`Digit${(next % powers) + 1}`);
        next += 1;
      }
    };
    requestAnimationFrame(tick);
  });

/** Plays the name screen and the hatch for the player's first or next egg. */
async function hatchNext(page, name) {
  const before = (await state(page)).kins.length;
  await page.evaluate(() => {
    const k = window.kinlings;
    const egg = k.game.view.eggs.get(k.game.me.eggs[0]);
    k.ui.hatchFlow(egg);
  });
  await page.waitForSelector(".modal input");
  await page.fill(".modal input", name);
  await snap(page, `name-${name}`);
  await page.click(".modal .btn.big");
  await page.waitForFunction((count) => window.kinlings.game.myKins().length > count, before, { timeout: 60_000 });
  await page.waitForSelector(".modal button:has-text('Hello!'), .modal button:has-text('Name it')", { timeout: 40_000 });
  await wait(800);
}

const closeModal = (page) => page.evaluate(() => window.kinlings.ui.closeModal());
const unique = (word) => word + Array.from({ length: 3 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join("");

async function main() {
  const browser = await chromium.launch({ args: ["--enable-webgl", "--ignore-gpu-blocklist", "--enable-gpu", "--use-angle=d3d11"] });
  console.log("Two strangers arrive");
  // Fresh names each run, so leftovers from earlier runs can't be mistaken for theirs.
  const ashaName = unique("Asha");
  const benName = unique("Ben");
  const asha = await player(browser, ashaName);
  const ben = await player(browser, benName);
  await wait(2500);
  await snap(asha, "first-view");

  console.log("First hatches");
  await hatchNext(asha, unique("ash"));
  await snap(asha, "reveal");
  await closeModal(asha);
  await hatchNext(ben, unique("ben"));
  await closeModal(ben);
  const a0 = await state(asha);
  const b0 = await state(ben);
  check(a0.kins.length === 1 && b0.kins.length === 1, "both hatched a Kinling");
  console.log(`  Asha's Kinling: ${a0.kins[0].account}`);

  console.log("Farming: tapping the real canvas");
  await asha.evaluate(() => window.kinlings.scene.jumpToLot(window.kinlings.game.view.me));
  await wait(800);
  const firstPlot = await asha.evaluate(() => {
    const k = window.kinlings;
    return k.scene.toScreen(k.scene.plotCentre(k.game.view.me, 0).x, k.scene.plotCentre(k.game.view.me, 0).y - 10);
  });
  await asha.mouse.click(firstPlot.x, firstPlot.y);
  await asha.waitForSelector(".popover .seed");
  await snap(asha, "seed-menu");
  await asha.click(".popover .btn.small");
  await asha.click(".popover .seed");
  await wait(1200);
  await snap(asha, "planted");
  await asha.evaluate(() => window.kinlings.game.flush());
  await wait(1200);
  const a1 = await state(asha);
  check(a1.plots.filter((p) => p.crop !== 0).length === 6, "planting on every empty plot worked");
  check(a1.sunwheat === 2, "six seeds were used");

  console.log("A neighbour helps");
  await ben.evaluate((lot) => window.kinlings.scene.jumpToLot(lot), a1.me);
  await wait(4500);
  const benStart = (await state(ben)).acorns;
  const neighbourPlot = await ben.evaluate((lot) => {
    const k = window.kinlings;
    const p = k.scene.plotCentre(lot, 2);
    return k.scene.toScreen(p.x, p.y - 10);
  }, a1.me);
  await ben.mouse.click(neighbourPlot.x, neighbourPlot.y);
  await wait(500);
  await snap(ben, "neighbour-watering");
  await ben.evaluate(() => window.kinlings.game.flush());
  await wait(1500);
  const benAfter = (await state(ben)).acorns;
  check(benAfter === benStart + 3, `helping paid the helper (${benStart} to ${benAfter})`);

  console.log("Harvest and sell");
  await wait(41_000);
  await asha.evaluate(async () => {
    await window.kinlings.game.refresh();
    window.kinlings.ui.harvestAll();
  });
  await wait(900);
  await snap(asha, "harvest");
  await asha.evaluate(() => window.kinlings.game.flush());
  await wait(1500);
  const a2 = await state(asha);
  check(a2.sunwheat === 14, `harvested six plots (${a2.sunwheat} Sunwheat)`);

  await asha.evaluate(() => window.kinlings.ui.openMarket());
  await wait(600);
  await snap(asha, "market");
  await asha.click(".btn.leaf:has-text('Sell 1')");
  await wait(600);
  await asha.evaluate(() => window.kinlings.game.flush());
  await wait(1500);
  const a3 = await state(asha);
  check(a3.acorns > a2.acorns, `selling earned acorns (${a2.acorns} to ${a3.acorns})`);
  await asha.hover(".price >> nth=0");
  await wait(400);
  await snap(asha, "price-reasoning");
  const reasoning = await asha.textContent(".tip");
  check(/right amount|short|swimming|nearly out/.test(reasoning ?? ""), "a shopkeeper explains its price");
  console.log(`  tooltip: ${reasoning}`);
  await asha.evaluate(() => window.kinlings.ui.closeSheet());

  console.log("Growing up and pairing");
  for (const page of [asha, ben]) {
    await page.evaluate(() => {
      const k = window.kinlings;
      const kin = k.game.myKins()[0];
      for (let i = 0; i < 5; i++) k.game.tap([4, kin.id, 1, 0]);
      return k.game.flush();
    });
  }
  await wait(1500);
  const b1 = await state(ben);
  await ben.evaluate((id) => {
    window.kinlings.game.tap([21, id, 25, 0]);
    return window.kinlings.game.flush();
  }, b1.kins[0].id);
  await wait(4500);
  await asha.evaluate(() => window.kinlings.game.refresh());
  await asha.evaluate((father) => window.kinlings.ui.openPair(undefined, father), b1.kins[0].id);
  await wait(800);
  await snap(asha, "pairing");
  await asha.click(".btn.leaf:has-text('Pair them')");
  await wait(600);
  await asha.evaluate(() => window.kinlings.game.flush());
  await wait(2500);
  await snap(asha, "egg-laid");
  const a4 = await state(asha);
  check(a4.eggs.length === 1, "an egg arrived in the nest");

  console.log("A friend warms the egg");
  await ben.evaluate(async (egg) => {
    const k = window.kinlings;
    await k.game.refresh();
    for (let i = 0; i < 8; i++) k.game.tap([5, egg, 0, 0]);
    return k.game.flush();
  }, a4.eggs[0]);
  await wait(3000);
  await asha.evaluate(() => window.kinlings.game.refresh());
  const egg = await asha.evaluate((id) => {
    const k = window.kinlings;
    const e = k.game.view.eggs.get(id);
    return { readyAt: e.readyAt, now: k.game.chainNow(), warms: e.warms };
  }, a4.eggs[0]);
  check(egg.warms === 8, "the egg was warmed by a real neighbour");
  await wait(Math.max(0, (egg.readyAt - egg.now) * 1000) + 3000);

  console.log("A baby, born under its mother");
  const babyName = unique("sp");
  await asha.evaluate(() => window.kinlings.game.refresh());
  await hatchNext(asha, babyName);
  await snap(asha, "baby-reveal");
  const a5 = await state(asha);
  const baby = a5.kins.find((k) => k.name === babyName);
  const mother = a5.kins.find((k) => k.name !== babyName);
  check(baby?.account === `${babyName}.${mother?.account}`, `the baby's account sits under its mother: ${baby?.account}`);
  await closeModal(asha);
  await wait(400);
  await asha.evaluate((name) => {
    const k = window.kinlings;
    const kin = k.game.myKins().find((x) => x.name === name);
    return k.ui.openFamily(kin);
  }, babyName);
  await wait(2500);
  await snap(asha, "family-tree");
  await closeModal(asha);

  console.log("Feeding stops where the food stops helping");
  await asha.evaluate(() => {
    const k = window.kinlings;
    const kin = k.game.myKins().find((x) => x.mother === 0);
    k.ui.tapKin(kin.id, k.game.view.me, 640, 360);
  });
  await wait(500);
  await snap(asha, "feeding-caps");
  check(await asha.$(".popover .seed.spent"), "Sunwheat is shown as too plain for a grown Kinling");
  await asha.evaluate(() => window.kinlings.ui.closePopover());

  console.log("A challenge race between the two players, for testnet NEAR");
  const earnedBefore = {
    asha: await asha.evaluate(() => window.kinlings.game.view.nearEarnedMicro),
    ben: await ben.evaluate(() => window.kinlings.game.view.nearEarnedMicro),
  };
  await asha.evaluate((id) => {
    const k = window.kinlings;
    k.ui.raceRacer = id;
    k.ui.openRace("challenges");
  }, mother.id);
  await asha.waitForSelector("button.chip:has-text('0.01 NEAR')", { timeout: 30_000 });
  await asha.click("button.chip:has-text('0.01 NEAR')");
  await asha.click("button.chip:has-text('2 runners')");
  await wait(400);
  await snap(asha, "challenge-open-form");
  await asha.click("button:has-text('Open it: 0.01 NEAR from my farm')");
  await asha.waitForSelector("button:has-text('Run it now with')", { timeout: 60_000 });
  await snap(asha, "challenge-opened");
  await asha.click("button:has-text('Run it now with')");
  await asha.waitForFunction(() => window.kinlingsRace?.phase === "racing", undefined, { timeout: 90_000 });
  await drive(asha);
  await asha.waitForSelector(".race-card.result", { timeout: 120_000 });
  await asha.waitForFunction(() => !/Handing your run in/.test(document.querySelector(".race-purse")?.textContent ?? "Handing your run in"), undefined, { timeout: 90_000 });
  await wait(1500);
  await snap(asha, "challenge-asha-result");
  check(await asha.$(".race-proof a"), "Asha's run was checked on NEAR");
  await asha.click("button:has-text('Back to the valley')");

  await ben.evaluate((id) => {
    const k = window.kinlings;
    k.ui.raceRacer = id;
    k.ui.openRace("challenges");
  }, b1.kins[0].id);
  // Join Asha's challenge in particular: other people's may be open too.
  const ashaChallenge = `.card.challenge:has-text("${ashaName}'s challenge")`;
  await ben.waitForSelector(`${ashaChallenge} button:has-text('Join with')`, { timeout: 60_000 });
  await snap(ben, "challenge-to-join");
  await ben.click(`${ashaChallenge} button:has-text('Join with')`);
  await ben.waitForSelector(`${ashaChallenge} button:has-text('Run it now with')`, { timeout: 60_000 });
  await ben.click(`${ashaChallenge} button:has-text('Run it now with')`);
  await ben.waitForFunction(() => window.kinlingsRace?.phase === "racing", undefined, { timeout: 90_000 });
  const ghosts = await ben.evaluate(() => window.kinlingsRace.stage.ghosts.length);
  check(ghosts === 1, "Ben races the ghost of Asha's run");
  await drive(ben);
  await wait(9_000);
  await snap(ben, "challenge-ghost");
  await ben.waitForSelector(".race-card.result", { timeout: 120_000 });
  await ben.waitForFunction(() => !/Handing your run in/.test(document.querySelector(".race-purse")?.textContent ?? "Handing your run in"), undefined, { timeout: 90_000 });
  await wait(2500);
  await snap(ben, "challenge-paid-out");
  await ben.click("button:has-text('Back to the valley')");
  await wait(6000);
  const earnedAfter = {
    asha: await asha.evaluate(async () => (await window.kinlings.game.refresh(), window.kinlings.game.view.nearEarnedMicro)),
    ben: await ben.evaluate(async () => (await window.kinlings.game.refresh(), window.kinlings.game.view.nearEarnedMicro)),
  };
  const won = earnedAfter.asha - earnedBefore.asha + (earnedAfter.ben - earnedBefore.ben);
  check(won === 20_000, `the winner was paid both entry fees (${won} millionths of a NEAR)`);

  console.log("Hiring a Kinling for NEAR");
  await ben.evaluate((id) => {
    window.kinlings.game.tap([22, id, 5, 0]);
    return window.kinlings.game.flush();
  }, b1.kins[0].id);
  await wait(4000);
  const owner = await ben.evaluate(async () => {
    const k = window.kinlings;
    await k.game.refresh();
    return k.game.view.nearEarnedMicro;
  });
  await asha.evaluate(() => window.kinlings.game.refresh());
  const hired = await asha.evaluate((id) => window.kinlings.game.hireFromFarm(id), b1.kins[0].id);
  check(hired, "Asha hired Ben's Kinling, paying from her own farm account");
  await wait(4000);
  const earned = await ben.evaluate(async () => {
    const k = window.kinlings;
    await k.game.refresh();
    return k.game.view.nearEarnedMicro;
  });
  check(earned > owner, `Ben was paid in NEAR (${owner} to ${earned} millionths)`);
  await snap(ben, "paid-in-near");

  console.log("A stall priced in NEAR");
  await ben.evaluate(() => {
    const k = window.kinlings;
    k.ui.openMarket();
    k.ui.setMarketTab("stalls");
  });
  await ben.waitForSelector(".price-picker select", { timeout: 20_000 });
  await ben.selectOption(".card select >> nth=0", "2");
  await ben.selectOption(".price-picker select", "near");
  await ben.fill(".price-picker input", "0.004");
  await snap(ben, "stall-near-form");
  await ben.click("button:has-text('Put it out')");
  await ben.evaluate(() => window.kinlings.game.flush());
  await wait(3000);
  const sellerEarned = await ben.evaluate(() => window.kinlings.game.view.nearEarnedMicro);
  await ben.evaluate(() => window.kinlings.ui.closeSheet());
  await asha.evaluate(async () => {
    const k = window.kinlings;
    await k.game.refresh();
    k.ui.openMarket();
    k.ui.setMarketTab("stalls");
  });
  const bensStall = `.card:has-text('from ${benName}') button:has-text('Buy for 0.004 NEAR')`;
  await asha.waitForSelector(bensStall, { timeout: 30_000 });
  await snap(asha, "stall-near-listing");
  await asha.click(bensStall);
  await asha.waitForSelector(".modal button:has-text('Pay from my farm')");
  await asha.click(".modal button:has-text('Pay from my farm')");
  await wait(9000);
  const sellerAfter = await ben.evaluate(async () => (await window.kinlings.game.refresh(), window.kinlings.game.view.nearEarnedMicro));
  check(sellerAfter - sellerEarned === 3_920, `Ben was paid 98% of the price in NEAR (${sellerAfter - sellerEarned} millionths)`);
  await asha.evaluate(() => window.kinlings.ui.closeSheet());

  console.log("A free practice race, played with the keyboard");
  const acornsBeforeRace = (await state(asha)).acorns;
  await asha.evaluate((id) => {
    const k = window.kinlings;
    k.ui.raceRacer = id;
    k.ui.openRace();
  }, b1.kins[0].id);
  await wait(800);
  await snap(asha, "race-sheet");
  await asha.click("button:has-text('Practice now (free)')");
  await asha.waitForFunction(() => window.kinlingsRace?.phase === "racing", undefined, { timeout: 90_000 });
  check((await state(asha)).acorns === acornsBeforeRace, "practice races are free to enter");
  await drive(asha);
  await wait(14_000);
  await snap(asha, "race-running");
  await asha.waitForSelector(".race-card.result", { timeout: 120_000 });
  await asha.waitForFunction(() => document.querySelector(".race-proof a") || /couldn't/.test(document.querySelector(".race-purse")?.textContent ?? ""), undefined, { timeout: 60_000 });
  await wait(800);
  await snap(asha, "race-finish");
  const proof = await asha.$eval(".race-proof a", (a) => a.href).catch(() => "");
  check(proof.includes("/txns/"), "the contract replayed the race and paid out");
  await asha.click("button:has-text('Back to the valley')");
  await wait(1200);

  console.log("Fast-forward");
  await asha.evaluate(() => {
    const k = window.kinlings;
    k.ui.openAlmanac();
    k.ui.almanacTab = "economy";
    k.ui.rerender();
  });
  await asha.click("button:has-text('Fast-forward a week')");
  await wait(20_000);
  await snap(asha, "fast-forward");
  await browser.close();

  console.log(failures.length ? `\n${failures.length} problems:\n- ${failures.join("\n- ")}` : "\nEverything passed.");
  process.exit(failures.length ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
