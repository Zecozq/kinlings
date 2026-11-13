// Everything drawn over the valley: the top bar, the dock, shops, Kinling
// cards and the moments that deserve a screen of their own.

import { VALLEY, accountExists, base58Encode, publicKeyHex, signWithSeed, toHex, view } from "./chain.ts";
import { K, quoteShop, type ShopQuote } from "./core.ts";
import {
  COLOURS,
  HEADS,
  HORNS,
  PATTERNS,
  TAILS,
  WINGS,
  classicName,
  speciesNumber,
  type Look,
} from "./creature.ts";
import { $, ICONS, eggIcon, el, itemIcon, portrait } from "./dom.ts";
import { fastForward } from "./fastforward.ts";
import { isGrown, type Game } from "./game.ts";
import { POWERS, might, powersIn } from "./powers.ts";
import { runRace, standingsRows } from "./race3d.ts";
import { buyListingWithWallet, connectWallet, disconnectWallet, joinChallengeWithWallet, openChallengeWithWallet, payHireWithWallet, walletAccount } from "./wallet.ts";
import { LOT, capitalise, eggColours, type Hit, type Scene } from "./three/valley3d.ts";
import { createKinViewer } from "./three/portrait.ts";
import { isMuted, setMuted, sound, startMusic } from "./sound.ts";
import {
  connectSocial,
  disconnectSocial,
  followingOf,
  linkFarmOnSocial,
  linkVerified,
  postOnSocial,
  profileOf,
  socialAccount,
  socialUrl,
  type SocialProfile,
} from "./social.ts";

/** Someone the player follows on NEAR Social who has a farm here. */
interface Friend {
  social: string;
  farm: number;
  account: string;
  profile: SocialProfile | null;
  verified: boolean;
}
import {
  ACORN,
  NOBODY,
  OP,
  TONIC,
  WILD_EGG,
  DID_NOT_FINISH,
  RARE_FOODS,
  cropInfo,
  foodHelps,
  foodInfo,
  farmerRank,
  itemName,
  kinLevel,
  nearText,
  parseKin,
  prizeShares,
  rankTitle,
  type Challenge,
  type Egg,
  type FeedEntry,
  type Kin,
  type Listing,
} from "./world.ts";

type RaceTab = "race" | "challenges" | "hire" | "champions";
const CHALLENGE_FEES = [10, 20, 50, 100];

const EMOTES = ["Hello!", "Nice farm!", "Thanks!", "Race you!"];
const NAME_IDEAS = ["ember", "moss", "pip", "wren", "sorrel", "juno", "fig", "bram", "nell", "ash", "tansy", "rue", "kit", "dew", "plum"];
const FOOD_HINTS: Record<number, string> = {
  1: "may wake Second Wind, and a tufted tail",
  2: "may wake Vine Snare, and butterfly wings",
  3: "may wake Fire Spit, and flame wings",
  4: "may wake Frost Breath, and a frost coat",
  5: "may wake Blink Step, and a spiral horn",
  6: "may wake Storm Bolt, and a coat of stars",
  9: "rare: often wakes Bubble Shield",
  10: "rare: often wakes Wind Dash",
  11: "rarest: always wakes a new power, and shinies are likelier",
};

/** A price box with its currency: acorns, or testnet NEAR. */
function pricePicker(acorns: number, near: number) {
  const input = el("input", { type: "number", min: 0.001, step: 1, value: acorns, style: "width:82px" }) as HTMLInputElement;
  const currency = el("select", {}, el("option", { value: "acorns" }, "acorns"), el("option", { value: "near" }, "NEAR")) as HTMLSelectElement;
  currency.addEventListener("change", () => {
    const inNear = currency.value === "near";
    input.step = inNear ? "0.001" : "1";
    input.value = String(inNear ? near : acorns);
  });
  return {
    node: el("span", { class: "price-picker" }, input, currency),
    /** The price as the contract wants it: acorns, or thousandths of a NEAR. */
    read(): { inNear: boolean; amount: number } {
      const inNear = currency.value === "near";
      const value = Number(input.value);
      return { inNear, amount: inNear ? Math.round(value * 1000) : Math.floor(value) };
    },
  };
}

function keeperLook(id: number): Look {
  const base = { eyes: 1, shiny: false, speed: 40, stamina: 40, luck: 40, seed: 900 + id * 37 };
  const looks = [
    { head: 4, horn: 0, wing: 0, tail: 2, pattern: 1, main: "#b4603a", accent: "#f2e6c9" },
    { head: 1, horn: 0, wing: 0, tail: 4, pattern: 0, main: "#e76f51", accent: "#f2e6c9" },
    { head: 1, horn: 3, wing: 4, tail: 1, pattern: 5, main: "#b9a3e3", accent: "#4c5fb1" },
    { head: 3, horn: 5, wing: 2, tail: 3, pattern: 3, main: "#f2e6c9", accent: "#e9a23b" },
  ];
  return { ...base, ...looks[id] };
}

function keeperPortrait(id: number, size = 72) {
  const kin = { xp: 40, look: keeperLook(id) } as Kin;
  return portrait(kin, size, 5);
}

function fallbackSpeciesName(look: Look): string {
  const species = speciesNumber(look);
  const classic = classicName(species);
  if (classic) return classic;
  const trait = [WINGS[look.wing], HORNS[look.horn], TAILS[look.tail]].find((t) => !t.startsWith("No"))!;
  return `${trait.split(" ")[0]} ${HEADS[look.head].split(" ")[0]}ling`;
}

interface Sheet {
  node: HTMLElement;
  body: HTMLElement;
  render: () => void;
  live: boolean;
  /** A form in it is half filled in, so the valley's refresh leaves it alone. */
  editing: boolean;
}

export class Ui {
  game: Game;
  scene: Scene;
  private sheet: Sheet | null = null;
  private popover: HTMLElement | null = null;
  private tip: HTMLElement | null = null;
  private species = new Map<number, { name: string; finder: number; named: boolean; count: number; finderName: string }>();
  private lastHud = "";
  private walletNudged = false;
  private socialProfile: SocialProfile | null = null;
  private socialLinked: boolean | null = null;
  private friends: Friend[] | null = null;
  private loadingFriends = false;
  private raceFriends = false;
  private coachStep = Number(localStorage.getItem("kinlings.coach") ?? 0);
  private pendingGift = new URLSearchParams(location.search).get("gift");
  private feedSeeded = false;
  private familyNoted = false;
  private bulkBar: HTMLElement;

  constructor(game: Game, scene: Scene) {
    this.game = game;
    this.scene = scene;
    this.bulkBar = el("div", { style: "position:fixed;bottom:96px;left:50%;transform:translateX(-50%);z-index:9;display:flex;gap:8px" });
    document.body.append(this.bulkBar);
  }

  start() {
    this.buildDock();
    this.buildNav();
    this.scene.onTap = (hit, x, y) => this.onTap(hit, x, y);
    this.game.listeners.add(() => this.onWorld());
    this.game.feedListeners.add((entries) => this.onFeed(entries));
    this.game.earningListeners.add((micro) => this.onNearEarned(micro));
    setInterval(() => this.tick(), 500);
    void this.loadSpecies();
    // Friends from NEAR Social, if this farm is linked, so races can ask for them.
    window.setTimeout(() => void this.loadFriends(), 4_000);
    window.addEventListener("pointerdown", () => startMusic(), { once: true });
    window.addEventListener("pointermove", (e) => this.moveTip(e));
  }

  private tick() {
    this.renderHud();
    this.renderBulkBar();
    this.renderFarmBadge();
  }

  private lastBadge = "";

  /** Whose farm this is on NEAR Social, when its owner has linked one. */
  private renderFarmBadge() {
    const view = this.game.view;
    if (!view) return;
    const farm = view.farms.get(this.scene.lotIndex());
    const social = farm?.social ?? "";
    const key = `${farm?.index}:${social}`;
    if (key === this.lastBadge) return;
    this.lastBadge = key;
    let badge = document.getElementById("farm-social");
    if (!badge) {
      badge = el("a", { id: "farm-social", class: "pill farm-social", target: "_blank", rel: "noopener" });
      $("nav").append(badge);
    }
    if (!farm || !social) {
      badge.replaceChildren();
      badge.style.display = "none";
      return;
    }
    badge.style.display = "";
    (badge as HTMLAnchorElement).href = socialUrl(social);
    badge.replaceChildren(`@${social}`);
    void profileOf(social).then((profile) => {
      if (this.lastBadge !== key || !badge) return;
      const verified = profile?.links?.kinlings === farm.account;
      const face = profile?.avatarUrl ? el("img", { class: "social-avatar small", src: profile.avatarUrl, alt: "" }) : null;
      badge.replaceChildren(...[face, `${profile?.name ?? social} · @${social}${verified ? " ✓" : ""}`].filter((part): part is HTMLElement | string => Boolean(part)));
      badge.title = verified ? "This farm and this near.social profile name each other" : "This farm says it is this near.social profile";
    });
  }

  // ----- Screen furniture ------------------------------------------------

  private renderHud() {
    const view = this.game.view;
    if (!view) return;
    const me = this.game.me;
    const acorns = this.game.bag(ACORN);
    const key = [me?.xp, acorns, view.online, view.players, isMuted(), this.game.nearBalance, view.wallet].join();
    if (key === this.lastHud) return;
    this.lastHud = key;
    const rank = me ? farmerRank(me.xp) : 1;
    const start = K.ranks[rank - 1];
    const next = K.ranks[rank] ?? start + 1;
    const progress = me ? Math.min(100, ((me.xp - start) / (next - start)) * 100) : 0;

    $("hud").replaceChildren(
      el(
        "div",
        { class: "hud-group" },
        el(
          "div",
          { class: "pill rank-pill" },
          el("span", { class: "rank-title" }, `Rank ${rank}: ${rankTitle(rank)}`),
          el("div", { class: "bar" }, el("i", { style: `width:${progress}%` })),
        ),
      ),
      el(
        "div",
        { class: "hud-group" },
        el(
          "button",
          { class: "pill near-pill", title: view.wallet ? `Your farm's testnet NEAR. Prizes and sales go to ${view.wallet}.` : "Your farm's testnet NEAR", onclick: () => this.openWallet() },
          el("span", { class: "near-mark" }, "Ⓝ"),
          this.nearText(this.game.nearBalance),
        ),
        view.wallet
          ? null
          : el("button", { class: "pill wallet-pill", title: "Connect a testnet NEAR wallet to be paid there", onclick: () => this.openWallet() }, "Connect wallet"),
        el("div", { class: "pill acorns", title: "Acorns" }, itemIcon(ACORN, 28), acorns.toLocaleString()),
        el("div", { class: "pill", title: "Farmers active in the last three minutes" }, el("span", { class: "dot" }), `${Math.max(me ? 1 : 0, view.online)} here`),
        el("button", { class: "round", title: "Sound", onclick: () => this.toggleSound() }, isMuted() ? "\u{1F507}" : "\u{1F50A}"),
      ),
    );
  }

  private toggleSound() {
    setMuted(!isMuted());
    this.lastHud = "";
    this.renderHud();
  }

  private buildDock() {
    const button = (label: string, icon: string, onclick: () => void, id?: string) => {
      const node = el("button", { class: "dock-btn", onclick, id, html: icon });
      node.append(label);
      return node;
    };
    $("dock").replaceChildren(
      button("Kinlings", ICONS.kin, () => this.openKinlings()),
      button("Pair", ICONS.heart, () => this.openPair()),
      button("Market", ICONS.basket, () => this.openMarket(), "dock-market"),
      button("Dash", ICONS.flag, () => this.openRace(), "dock-race"),
      button("Almanac", ICONS.book, () => this.openAlmanac()),
    );
  }

  private nearText(yocto: bigint | null): string {
    if (yocto === null) return "…";
    return (Number(yocto / 1_000_000_000_000_000n) / 1_000_000_000).toFixed(3);
  }

  private onNearEarned(micro: number) {
    sound.coin();
    const to = this.game.view?.wallet;
    this.banner(`+${(micro / 1_000_000).toFixed(4)} testnet NEAR`, to ? `Paid straight to ${to}` : "Paid into your farm account. Connect a wallet to collect it there.");
    if (!to && !this.walletNudged) {
      this.walletNudged = true;
      window.setTimeout(() => this.openWallet(), 2_400);
    }
  }

  private buildNav() {
    const go = (delta: number) => () => {
      this.scene.goToLot(this.scene.lotIndex() + delta);
      sound.pop();
    };
    $("nav").replaceChildren(
      el("button", { class: "nav-arrow left", onclick: go(-1), title: "Previous farm" }, "‹"),
      el("button", { class: "nav-arrow right", onclick: go(1), title: "Next farm" }, "›"),
      el("button", { class: "btn small plain nav-home", onclick: () => this.goHome() }, "Home"),
    );
  }

  goHome() {
    const me = this.game.view?.me;
    if (me !== undefined && me !== NOBODY) this.scene.goToLot(me);
  }

  private renderBulkBar() {
    const me = this.game.me;
    if (!me || this.sheet || this.popover) {
      this.bulkBar.replaceChildren();
      return;
    }
    const now = this.game.chainNow();
    const ripe = me.plots.filter((p) => p.crop !== 0 && p.readyAt <= now).length;
    const growing = me.plots.filter((p) => p.crop !== 0 && p.readyAt > now && p.waterings < 3).length;
    const buttons: HTMLElement[] = [];
    if (ripe >= 2) buttons.push(el("button", { class: "btn leaf", onclick: () => this.harvestAll() }, `Harvest all (${ripe})`));
    if (growing >= 2) buttons.push(el("button", { class: "btn sky", onclick: () => this.waterAll() }, `Water all (${growing})`));
    const key = `${ripe},${growing}`;
    if (this.bulkBar.dataset.key !== key) {
      this.bulkBar.dataset.key = key;
      this.bulkBar.replaceChildren(...buttons);
    }
  }

  private harvestAll() {
    const me = this.game.me;
    if (!me) return;
    const now = this.game.chainNow();
    me.plots.forEach((plot, slot) => {
      if (plot.crop !== 0 && plot.readyAt <= now) this.harvestPlot(me.index, slot);
    });
  }

  private waterAll() {
    const me = this.game.me;
    if (!me) return;
    const now = this.game.chainNow();
    me.plots.forEach((plot, slot) => {
      if (plot.crop !== 0 && plot.readyAt > now && plot.waterings < 3) this.waterPlot(me.index, slot);
    });
  }

  // ----- The world changed ------------------------------------------------

  private onWorld() {
    if (this.sheet?.live && !this.sheet.editing && !(document.activeElement instanceof HTMLInputElement)) {
      const top = this.sheet.body.scrollTop;
      this.sheet.render();
      this.sheet.body.scrollTop = top;
    }
    this.renderCoach();
    this.checkGift();
    this.noteFamilyEarnings();
  }

  private noteFamilyEarnings() {
    if (this.familyNoted || !this.game.me) return;
    this.familyNoted = true;
    const total = this.game.myKins().reduce((sum, kin) => sum + kin.purse, 0);
    const before = Number(localStorage.getItem("kinlings.purses") ?? total);
    if (total > before) this.banner(`While you were away, your family earned ${total - before} acorns`);
    window.setInterval(() => {
      localStorage.setItem("kinlings.purses", String(this.game.myKins().reduce((sum, kin) => sum + kin.purse, 0)));
    }, 15_000);
  }

  private onFeed(entries: FeedEntry[]) {
    if (!this.feedSeeded) {
      this.feedSeeded = true;
      entries = entries.slice(-2);
    }
    for (const entry of entries) {
      if (entry.kind >= 10 && entry.kind <= 13) {
        const target = [...(this.game.view?.farms.values() ?? [])].find((f) => f.name === entry.what);
        if (target) this.scene.bubble(target.index, EMOTES[entry.kind - 10]);
        this.ticker(`${entry.who} says "${EMOTES[entry.kind - 10]}" to ${entry.what}`);
        continue;
      }
      if (entry.kind === 2) {
        this.banner("A species nobody has ever seen", `${entry.who} just hatched it`);
        sound.fanfare();
      }
      if (entry.kind === 6) sound.bell();
      if (entry.kind === 14 || entry.kind === 16) sound.coin();
      if (entry.kind === 18) sound.fanfare();
      const myName = this.game.me?.name;
      if (entry.kind === 15 && entry.who === myName) {
        sound.fanfare();
        this.banner(`You ${entry.what}!`, "A rare food. It lets a Kinling grow far beyond what crops can, or sell it at your stall.");
      }
      if (entry.kind === 7) this.ticker(`${entry.who} named a new species: the ${entry.what}`);
      else this.ticker(`${entry.who} ${entry.what}`);
    }
  }

  ticker(text: string) {
    const line = el("div", { class: "tick" }, text);
    const box = $("ticker");
    box.append(line);
    while (box.children.length > 4) box.firstChild?.remove();
    setTimeout(() => line.remove(), 9_000);
  }

  banner(text: string, small?: string) {
    const card = el("div", { class: "banner-card" }, text, small ? el("small", {}, small) : null);
    $("banner").replaceChildren(card);
    setTimeout(() => card.remove(), 4_200);
  }

  // ----- Tapping the world --------------------------------------------------

  private onTap(hit: Hit | null, screenX: number, screenY: number) {
    this.closePopover();
    if (!hit) return;
    const view = this.game.view;
    if (!view || view.me === NOBODY) return;
    switch (hit.kind) {
      case "plot":
        this.tapPlot(hit.farm, hit.slot, screenX, screenY);
        break;
      case "egg":
        this.tapEgg(hit.farm, hit.egg);
        break;
      case "kin":
        this.tapKin(hit.id, hit.farm, screenX, screenY);
        break;
      case "sign":
        if (hit.farm !== view.me) this.emoteMenu(hit.farm, screenX, screenY);
        break;
    }
  }

  private tapPlot(farmIndex: number, slot: number, screenX: number, screenY: number) {
    const view = this.game.view!;
    const farm = view.farms.get(farmIndex)!;
    const plot = farm.plots[slot];
    const now = this.game.chainNow();
    const mine = farmIndex === view.me;

    if (farm.elder) {
      const { x, y } = this.plotWorld(farmIndex, slot);
      this.scene.float(x, y - 60, "Doing fine, thanks", "#fff6d0");
      return;
    }
    if (plot.crop === 0) {
      if (mine) this.seedMenu(slot, screenX, screenY);
      return;
    }
    if (plot.readyAt <= now) {
      if (mine) this.harvestPlot(farmIndex, slot);
      return;
    }
    this.waterPlot(farmIndex, slot);
  }

  private plotWorld(farm: number, slot: number) {
    return this.scene.plotCentre(farm, slot);
  }

  private harvestPlot(farmIndex: number, slot: number) {
    const me = this.game.me!;
    const plot = me.plots[slot];
    const info = cropInfo(plot.crop)!;
    const { x, y } = this.plotWorld(farmIndex, slot);
    const bonus = K.mastery.filter((needed) => me.mastery[info.item - 1] >= needed).length;
    this.scene.float(x, y - 50, `+${info.harvest + bonus}`, "#ffe58a");
    this.scene.burst(x, y - 30, "#f7d774", 12);
    sound.harvest();
    this.game.tap([OP.HARVEST, slot, 0, 0]);
    this.advanceCoach(4, true);
  }

  private waterPlot(farmIndex: number, slot: number) {
    const plot = this.game.view!.farms.get(farmIndex)!.plots[slot];
    const { x, y } = this.plotWorld(farmIndex, slot);
    if (plot.waterings >= 3) {
      this.scene.float(x, y - 60, "Soaked!", "#bfe9ff");
      return;
    }
    this.scene.splash(x, y);
    sound.water();
    if (farmIndex !== this.game.view!.me) this.scene.float(x, y - 60, "+3 for helping", "#ffe58a");
    this.game.tap([OP.WATER, farmIndex, slot, 0]);
    this.advanceCoach(3);
  }

  private seedMenu(slot: number, screenX: number, screenY: number) {
    const me = this.game.me!;
    const rank = farmerRank(me.xp);
    let everywhere = false;
    const allToggle = el(
      "button",
      {
        class: "btn small plain",
        style: "grid-column:1/-1",
        onclick: () => {
          everywhere = !everywhere;
          allToggle.textContent = everywhere ? "Every empty plot: on" : "Plant every empty plot";
        },
      },
      "Plant every empty plot",
    );
    const items = K.crops.map((crop) => {
      const locked = crop.rank > rank;
      const count = this.game.bag(crop.item);
      return el(
        "button",
        {
          class: "seed",
          disabled: locked || count === 0,
          onclick: () => {
            this.closePopover();
            this.plant(slot, crop.item, everywhere);
          },
        },
        itemIcon(crop.item, 38),
        crop.name,
        el("small", {}, locked ? `Rank ${crop.rank}` : `${count} left`),
      );
    });
    const market = el("button", { class: "btn small", style: "grid-column:1/-1", onclick: () => this.openMarket() }, "Buy more at the Market");
    this.showPopover(el("div", { class: "popover" }, allToggle, ...items, market), screenX, screenY);
  }

  private plant(slot: number, crop: number, everywhere: boolean) {
    const me = this.game.me!;
    const targets = everywhere
      ? me.plots.flatMap((plot, index) => (plot.crop === 0 ? [index] : []))
      : [slot];
    let seeds = this.game.bag(crop);
    for (const target of targets) {
      if (seeds <= 0) break;
      seeds -= 1;
      const { x, y } = this.plotWorld(me.index, target);
      this.scene.burst(x, y - 8, "#8a5a3c", 6);
      this.game.tap([OP.PLANT, target, crop, 0]);
    }
    sound.plant();
    this.advanceCoach(2);
  }

  private tapEgg(farmIndex: number, eggId: number) {
    const view = this.game.view!;
    const egg = view.eggs.get(eggId);
    if (!egg) return;
    const mine = farmIndex === view.me;
    const now = this.game.chainNow();
    if (mine && egg.readyAt <= now) {
      if (!egg.hatching) this.hatchFlow(egg);
      return;
    }
    if (egg.readyAt <= now) return;
    this.scene.wobbleEgg(eggId);
    sound.warm();
    if (egg.warms >= K.maxWarms) {
      this.ticker("That egg is as warm as it can get.");
      return;
    }
    this.game.tap([OP.WARM, eggId, 0, 0]);
  }

  private tapKin(id: number, farmIndex: number, screenX: number, screenY: number) {
    const view = this.game.view!;
    const kin = view.kins.get(id);
    if (!kin) return;
    this.scene.cheerKin(id);
    sound.pop();
    const mine = farmIndex === view.me;
    const species = this.speciesNameOf(kin);

    if (!mine) {
      const offered = kin.studFee > 0;
      this.showPopover(
        el(
          "div",
          { class: "popover wide" },
          el("h3", {}, capitalise(kin.name)),
          el("div", { class: "muted" }, `${species}, generation ${kin.generation}, level ${kinLevel(kin.xp)}`),
          this.powerChips(kin),
          el("button", { class: "btn small plain", onclick: () => this.openFamily(kin) }, "Family tree"),
          kin.rentMilli > 0 ? el("button", { class: "btn small sky", onclick: () => this.openHire() }, `Hire ${capitalise(kin.name)}: ${this.milliText(kin.rentMilli)}`) : null,
          offered
            ? el("button", { class: "btn small", onclick: () => this.openPair(undefined, kin.id) }, `Pair with ${capitalise(kin.name)} (${kin.studFee} acorns)`)
            : el("div", { class: "muted" }, "Not offered for pairing"),
        ),
        screenX,
        screenY,
      );
      return;
    }

    const level = kinLevel(kin.xp);
    const foods = K.foods
      .filter((food) => this.game.bag(food.item) > 0)
      .map((food) => {
        const helps = foodHelps(food.item, kin.xp);
        return el(
          "button",
          {
            class: `seed ${food.rare ? "rare" : ""} ${helps ? "" : "spent"}`,
            disabled: !helps,
            title: helps ? `+${food.xp} growth. Raises a Kinling up to level ${food.cap}.` : `${food.name} can only raise a Kinling to level ${food.cap}.`,
            onclick: () => this.feed(kin, food.item),
          },
          itemIcon(food.item, 34),
          food.name,
          el("small", {}, helps ? `+${food.xp} · to lvl ${food.cap}` : `only to lvl ${food.cap}`),
          el("small", {}, `${this.game.bag(food.item)} left`),
        );
      });
    const anyHelps = K.foods.some((food) => this.game.bag(food.item) > 0 && foodHelps(food.item, kin.xp));
    this.showPopover(
      el(
        "div",
        { class: "popover" },
        el("h3", { style: "grid-column:1/-1;text-align:center" }, `${capitalise(kin.name)}: level ${level} of ${K.kinLevels.length}`),
        this.levelBar(kin),
        ...foods,
        !anyHelps ? el("div", { class: "muted", style: "grid-column:1/-1;text-align:center" }, this.nextFoodHint(kin)) : null,
        kin.purse > 0
          ? el("button", { class: "btn small", style: "grid-column:1/-1", onclick: () => this.collect(kin) }, `Collect ${kin.purse} from its purse`)
          : null,
        el("button", { class: "btn small berry", style: "grid-column:1/-1", onclick: () => this.startRace(kin) }, "Race it now"),
        el("button", { class: "btn small plain", style: "grid-column:1/-1", onclick: () => this.openKinlings() }, "All my Kinlings"),
      ),
      screenX,
      screenY,
    );
  }

  /** How close a Kinling is to its next level. */
  private levelBar(kin: Kin): HTMLElement {
    const level = kinLevel(kin.xp);
    const start = K.kinLevels[level - 1];
    const next = K.kinLevels[level] ?? start;
    const progress = next > start ? Math.min(100, ((kin.xp - start) / (next - start)) * 100) : 100;
    return el(
      "div",
      { class: "level-bar", style: "grid-column:1/-1", title: next > start ? `${kin.xp - start} of ${next - start} growth to level ${level + 1}` : "As grown as a Kinling can be" },
      el("i", { style: `width:${progress}%` }),
    );
  }

  /** What would let this Kinling grow further, and where to get it. */
  private nextFoodHint(kin: Kin): string {
    const level = kinLevel(kin.xp);
    if (level >= K.kinLevels.length) return "As grown as a Kinling can be!";
    const next = K.foods.find((food) => food.cap > level)!;
    if (next.rare) {
      const where = next.finds.length ? `harvests of ${next.finds.map(([crop]) => itemName(crop)).join(" and ")}` : "";
      const race = next.raceFind > 0 ? "rested race wins" : "";
      return `To grow past level ${level} it needs ${next.name}, a rare food: found at ${[where, race].filter(Boolean).join(" and ")}, or bought from other players' stalls.`;
    }
    const crop = cropInfo(next.item);
    return `To grow past level ${level} it needs ${next.name}${crop && crop.rank > 1 ? ` (farmer rank ${crop.rank} can plant it)` : ""}, or something finer.`;
  }

  private feed(kin: Kin, item: number) {
    const food = foodInfo(item)!;
    sound.munch();
    this.scene.cheerKin(kin.id);
    const before = kinLevel(kin.xp);
    this.game.tap([OP.FEED, kin.id, item, 0]);
    const grown = this.game.kin(kin.id) ?? kin;
    const after = kinLevel(grown.xp);
    this.closePopover();
    if (after > before) {
      sound.hatch();
      const capped = !foodHelps(item, grown.xp) && after < K.kinLevels.length;
      const note = after === K.adult ? "It's grown! It can race and have babies now." : capped ? `That's as far as ${food.name} can take it.` : undefined;
      this.banner(`${capitalise(kin.name)} reached level ${after}!`, note);
    } else if (!foodHelps(item, grown.xp)) {
      this.banner(`${food.name} can't take ${capitalise(kin.name)} any further`, this.nextFoodHint(grown));
    }
    this.advanceCoach(5);
  }

  private collect(kin: Kin) {
    sound.coin();
    this.game.tap([OP.COLLECT, kin.id, 0, 0]);
    this.closePopover();
  }

  private emoteMenu(farm: number, screenX: number, screenY: number) {
    this.showPopover(
      el(
        "div",
        { class: "popover wide" },
        ...EMOTES.map((text, emote) =>
          el(
            "button",
            {
              class: "btn small plain",
              onclick: () => {
                this.game.tap([OP.WAVE, farm, emote, 0]);
                this.scene.bubble(farm, text);
                this.closePopover();
                sound.pop();
              },
            },
            text,
          ),
        ),
      ),
      screenX,
      screenY,
    );
  }

  private showPopover(node: HTMLElement, screenX: number, screenY: number) {
    this.popover = node;
    $("popover-layer").replaceChildren(node);
    const rect = node.getBoundingClientRect();
    const left = Math.max(8, Math.min(innerWidth - rect.width - 8, screenX - rect.width / 2));
    const top = Math.max(8, Math.min(innerHeight - rect.height - 90, screenY - rect.height - 18));
    node.style.left = `${left}px`;
    node.style.top = `${top}px`;
  }

  private closePopover() {
    this.popover?.remove();
    this.popover = null;
  }

  // ----- Sheets -------------------------------------------------------------

  private openSheet(title: string, render: (body: HTMLElement) => void, live = true) {
    this.closePopover();
    this.closeSheet();
    const body = el("div", { class: "sheet-body" });
    // A half-filled form, such as a stall's item and price, lives only on the
    // page. The valley refreshes every few seconds and would redraw the sheet
    // under the player's hands, so picking or typing marks it as being edited
    // and pressing a button (acting on it) lets the next refresh redraw it.
    const editing = (value: boolean) => () => {
      if (this.sheet?.body === body) this.sheet.editing = value;
    };
    body.addEventListener("input", editing(true));
    body.addEventListener("change", editing(true));
    body.addEventListener("click", (event) => {
      if ((event.target as HTMLElement | null)?.closest("button")) editing(false)();
    }, true);
    const node = el(
      "div",
      { class: "sheet" },
      el(
        "div",
        { class: "sheet-head" },
        el("h2", {}, title),
        el("button", { class: "round", title: "Close", onclick: () => this.closeSheet() }, "✕"),
      ),
      body,
    );
    $("sheet-layer").replaceChildren(node);
    const doRender = () => {
      this.hideTip();
      render(body);
    };
    this.sheet = { node, body, render: doRender, live, editing: false };
    doRender();
    sound.pop();
  }

  private closeSheet() {
    this.hideTip();
    this.sheet?.node.remove();
    this.sheet = null;
  }

  private rerender() {
    this.sheet?.render();
  }

  // ----- Market -------------------------------------------------------------

  private marketTab: "shops" | "stalls" = "shops";

  openMarket() {
    this.advanceCoach(7);
    this.openSheet("Market", (body) => {
      const tabs = el(
        "div",
        { class: "tabs" },
        el("button", { class: `tab ${this.marketTab === "shops" ? "on" : ""}`, onclick: () => this.setMarketTab("shops") }, "Shopkeepers"),
        el("button", { class: `tab ${this.marketTab === "stalls" ? "on" : ""}`, onclick: () => this.setMarketTab("stalls") }, "Farmers' stalls"),
      );
      if (this.marketTab === "shops") body.replaceChildren(tabs, ...K.shops.map((_, id) => this.shopCard(id)));
      else body.replaceChildren(tabs, ...this.stallsView());
    });
  }

  private setMarketTab(tab: "shops" | "stalls") {
    this.marketTab = tab;
    this.rerender();
  }

  private shopQuote(id: number): ShopQuote {
    const view = this.game.view!;
    const shop = view.shops[id];
    return quoteShop(
      id,
      [
        shop.held,
        shop.pot,
        shop.closed ? 1 : 0,
        shop.lastTick,
        shop.shelves[0].stock,
        shop.shelves[0].recentIn,
        shop.shelves[0].recentOut,
        shop.shelves[1].stock,
        shop.shelves[1].recentIn,
        shop.shelves[1].recentOut,
      ],
      view.oak,
      view.players,
      Math.floor(this.game.chainNow()),
    );
  }

  private shopCard(id: number): HTMLElement {
    const shop = K.shops[id];
    const quote = this.shopQuote(id);
    const state = this.game.view!.shops[id];
    const cards = shop.items.map((entry, slot) => this.shopRow(id, slot, entry.item, quote));
    const lines: (HTMLElement | null)[] = [];
    if (quote.closed) {
      const reopen = Math.ceil(shop.comfortable * 0.25);
      const input = el("input", { type: "number", min: 1, value: reopen, style: "width:110px" }) as HTMLInputElement;
      lines.push(
        el("p", {}, `${shop.keeper} went broke. The shop stays shut until someone puts up at least ${reopen} acorns. Backers earn a share of its future sales.`),
        el(
          "div",
          { class: "row" },
          input,
          el(
            "button",
            {
              class: "btn",
              onclick: () => {
                const amount = Math.floor(Number(input.value));
                if (amount > 0 && amount <= this.game.bag(ACORN)) {
                  this.game.tap([OP.INVEST, id, amount, 0]);
                  sound.coin();
                  this.ticker(`You backed ${shop.keeper} with ${amount} acorns.`);
                }
              },
            },
            "Back this shop",
          ),
        ),
      );
    }
    return el(
      "div",
      { class: "card" },
      el(
        "div",
        { class: "shop-head" },
        keeperPortrait(id),
        el(
          "div",
          { class: "grow" },
          el("h3", {}, shop.keeper, " ", quote.closed ? el("span", { class: "closed-stamp" }, "CLOSED") : null),
          el("div", { class: "muted" }, `${quote.till.toLocaleString()} acorns in the till${state.shares > 0 ? `, ${state.shares.toLocaleString()} backed by farmers` : ""}`),
        ),
        !quote.closed && state.shares === 0 ? null : null,
      ),
      ...lines,
      ...cards,
      this.investRow(id, quote),
    );
  }

  private investRow(id: number, quote: ShopQuote): HTMLElement | null {
    if (quote.closed) return null;
    return el(
      "button",
      {
        class: "btn small plain",
        style: "margin-top:6px",
        onclick: () => {
          const amount = Math.min(200, this.game.bag(ACORN));
          if (amount > 0) {
            this.game.tap([OP.INVEST, id, amount, 0]);
            sound.coin();
            this.ticker(`You backed ${K.shops[id].keeper} with ${amount} acorns.`);
          }
        },
      },
      "Back this shop with 200",
    );
  }

  private shopRow(id: number, slot: number, item: number, quote: ShopQuote): HTMLElement {
    const q = quote.slots[slot];
    const market = id * 2 + slot;
    const have = this.game.bag(item);
    const movement = q.fair - K.shops[id].items[slot].base;
    const arrow = movement > 0 ? el("span", { class: "up" }, ` up ${Math.round((movement / K.shops[id].items[slot].base) * 100)}%`) : movement < 0 ? el("span", { class: "down" }, ` down ${Math.round((-movement / K.shops[id].items[slot].base) * 100)}%`) : null;

    const sell = (units: number) => {
      const amount = Math.min(units, have, 60);
      if (amount <= 0) return;
      this.game.tap([OP.SELL, market, amount, Math.max(1, Math.floor(q.pays * 0.5)), amount * q.pays]);
      sound.coin();
    };
    const buy = (units: number) => {
      if (this.game.bag(ACORN) < q.charges * units) return;
      this.game.tap([OP.BUY, market, units, Math.ceil(q.charges * 1.6), units * q.charges]);
      sound.coin();
    };
    const disabled = quote.closed;
    const isWildEgg = item === WILD_EGG;
    return el(
      "div",
      { style: "padding:7px 0;border-top:2px dashed rgba(74,51,34,.2)" },
      el(
        "div",
        { class: "row spread" },
        el("div", { class: "row" }, itemIcon(item, 38), el("div", {}, el("b", {}, itemName(item)), arrow, el("div", { class: "muted" }, `You have ${have}, on the shelf ${q.stock}`))),
        el(
          "div",
          { class: "row" },
          this.priceTag("They pay", q.pays, q.why),
          this.priceTag("They charge", q.charges, q.why),
        ),
      ),
      el(
        "div",
        { class: "row wrap", style: "margin-top:6px" },
        !isWildEgg ? el("button", { class: "btn small leaf", disabled: disabled || have < 1, onclick: () => sell(1) }, "Sell 1") : null,
        !isWildEgg ? el("button", { class: "btn small leaf", disabled: disabled || have < 1, onclick: () => sell(10) }, "Sell 10") : null,
        !isWildEgg ? el("button", { class: "btn small leaf", disabled: disabled || have < 1, onclick: () => sell(have) }, "Sell all") : null,
        el("button", { class: "btn small", disabled, onclick: () => buy(1) }, "Buy 1"),
        !isWildEgg ? el("button", { class: "btn small", disabled, onclick: () => buy(5) }, "Buy 5") : null,
        isWildEgg && have > 0 ? el("button", { class: "btn small sky", onclick: () => this.game.tap([OP.WILD_EGG_OPEN, 0, 0, 0]) }, "Put one in the nest") : null,
      ),
    );
  }

  private priceTag(label: string, amount: number, why: string[]): HTMLElement {
    const node = el("div", { class: "price" }, el("small", {}, label), el("b", {}, amount));
    node.addEventListener("pointerenter", (e) => this.showTip(why, e as PointerEvent));
    node.addEventListener("pointerleave", () => this.hideTip());
    node.addEventListener("click", (e) => this.showTip(why, e as PointerEvent));
    return node;
  }

  private showTip(lines: string[], event: PointerEvent | MouseEvent) {
    this.hideTip();
    this.tip = el("div", { class: "tip" }, ...lines.map((line) => el("p", {}, line)));
    document.body.append(this.tip);
    this.placeTip(event);
  }

  private placeTip(event: PointerEvent | MouseEvent) {
    if (!this.tip) return;
    const rect = this.tip.getBoundingClientRect();
    this.tip.style.left = `${Math.max(8, Math.min(innerWidth - rect.width - 8, event.clientX - rect.width - 12))}px`;
    this.tip.style.top = `${Math.max(8, Math.min(innerHeight - rect.height - 8, event.clientY - rect.height / 2))}px`;
  }

  private moveTip(event: PointerEvent) {
    if (this.tip) this.placeTip(event);
  }

  private hideTip() {
    this.tip?.remove();
    this.tip = null;
  }

  private stallsView(): HTMLElement[] {
    const world = this.game.view!;
    const rows = world.listings.map((listing) => {
      // Only the farms near the camera are loaded, so fall back on the valley's
      // list of top farmers for a seller further down the road.
      const seller = world.farms.get(listing.seller)?.name ?? world.top.find((leader) => leader.index === listing.seller)?.name ?? "A neighbour";
      const mine = listing.seller === world.me;
      let picture: Node = el("div", {});
      let label: string;
      if (listing.kind === 0) {
        picture = itemIcon(listing.itemId, 40);
        label = `${listing.quantity} ${itemName(listing.itemId)}`;
      } else if (listing.kind === 1) {
        const egg = world.eggs.get(listing.itemId);
        if (egg) {
          const [a, b] = eggColours(egg, this.game);
          picture = eggIcon(a, b, egg.id, 44);
        }
        label = "An egg, unhatched";
      } else {
        const kin = world.kins.get(listing.itemId);
        if (kin) picture = portrait(kin, 56);
        label = kin ? `${capitalise(kin.name)} the ${this.speciesNameOf(kin)}` : "A Kinling";
      }
      const affordable = listing.inNear || this.game.bag(ACORN) >= listing.unitPrice;
      const priceText = listing.inNear ? `${nearText(listing.unitPrice)} NEAR` : `${listing.unitPrice} acorns`;
      const rare = listing.kind === 0 && RARE_FOODS.includes(listing.itemId);
      return el(
        "div",
        { class: `card row spread ${rare ? "rare-stall" : ""}` },
        el(
          "div",
          { class: "row" },
          picture,
          el("div", {}, el("b", {}, label), el("div", { class: "muted" }, `from ${seller}${listing.kind === 0 && listing.quantity > 1 ? `, ${priceText} each` : ""}`)),
        ),
        mine
          ? el("button", { class: "btn small plain", onclick: () => this.game.tap([OP.CANCEL_LISTING, listing.id, 0, 0]) }, "Take back")
          : el(
              "button",
              {
                class: `btn small ${listing.inNear ? "sky" : ""}`,
                disabled: !affordable,
                onclick: () => {
                  if (listing.inNear) {
                    this.buyWithNear(listing, label);
                    return;
                  }
                  this.game.tap([OP.BUY_LISTING, listing.id, 1, listing.unitPrice]);
                  sound.coin();
                },
              },
              `Buy for ${priceText}`,
            ),
      );
    });

    const sellable = [...K.foods.map((food) => food.item), TONIC, WILD_EGG].filter((item) => this.game.bag(item) > 0);
    const itemSelect = el(
      "select",
      {},
      ...sellable.map((item) => el("option", { value: item }, `${itemName(item)} (${this.game.bag(item)})${RARE_FOODS.includes(item) ? " ★ rare" : ""}`)),
    ) as HTMLSelectElement;
    const quantity = el("input", { type: "number", min: 1, value: 1, style: "width:64px" }) as HTMLInputElement;
    const price = pricePicker(15, 0.02);
    const form = el(
      "div",
      { class: "card" },
      el("h3", {}, "Open your own stall"),
      el(
        "p",
        { class: "muted" },
        `Sell to other players for acorns or for testnet NEAR. NEAR goes straight to your wallet when something sells. ${K.stallTax}% goes to the valley. Rare foods are never in the shops, so this is the only place to buy them.`,
      ),
      el(
        "div",
        { class: "row wrap" },
        itemSelect,
        el("span", {}, "×", quantity),
        el("span", {}, "at ", price.node, " each"),
        el(
          "button",
          {
            class: "btn",
            disabled: sellable.length === 0,
            onclick: () => {
              const item = Number(itemSelect.value);
              const { inNear, amount } = price.read();
              if (!item || amount < 1) return;
              this.game.tap([inNear ? OP.LIST_ITEM_NEAR : OP.LIST_ITEM, item, Math.max(1, Math.floor(Number(quantity.value))), amount]);
              sound.coin();
            },
          },
          "Put it out",
        ),
      ),
    );
    return [form, ...(rows.length ? rows : [el("p", { class: "muted" }, "No stalls yet. Be the first!")])];
  }

  /** Buys one of something from a stall priced in NEAR. */
  private buyWithNear(listing: Listing, label: string) {
    const spendable = this.game.spendableMilli();
    const wallet = walletAccount();
    const done = (ok: boolean) => {
      this.closeModal();
      this.banner(ok ? "Bought!" : "That didn't go through", ok ? "The seller has been paid in NEAR" : "No NEAR was kept. Someone may have got there first.");
      if (ok) sound.fanfare();
    };
    this.modal(
      el("h2", {}, `Buy for ${nearText(listing.unitPrice)} NEAR`),
      el("p", {}, `${listing.kind === 0 ? `One ${itemName(listing.itemId)}` : label}. The seller gets ${100 - K.stallTax}% straight away.`),
      el(
        "button",
        {
          class: "btn leaf",
          disabled: spendable < listing.unitPrice,
          onclick: async () => {
            this.banner("Buying...");
            done(await this.game.buyListingFromFarm(listing.id, 1).catch(() => false));
          },
        },
        spendable >= listing.unitPrice ? `Pay from my farm (${nearText(spendable)} NEAR to spend)` : `Your farm has ${nearText(spendable)} NEAR to spend`,
      ),
      el(
        "button",
        {
          class: "btn sky",
          onclick: async () => {
            try {
              this.banner("Check your wallet to approve");
              await buyListingWithWallet(listing.id, 1, listing.unitPrice, this.game.signer.accountId);
              await this.game.refresh();
              done(true);
            } catch (error) {
              console.warn(error);
              done(false);
            }
          },
        },
        wallet ? `Pay from ${wallet}` : "Pay from a NEAR wallet",
      ),
      this.closeButton(),
    );
  }

  // ----- Kinlings -----------------------------------------------------------

  private olderKins: Kin[] = [];

  openKinlings() {
    this.olderKins = [];
    this.openSheet("My Kinlings", (body) => {
      const kins = this.game.myKins();
      const hired = this.game.hiredKins();
      const me = this.game.me;
      if (!me) return;
      const eggs = me.eggs.map((id) => this.game.view!.eggs.get(id)).filter((e): e is Egg => Boolean(e));
      const more = me.kinCount - kins.length - this.olderKins.length;
      body.replaceChildren(
        el("p", { class: "muted" }, `You have ${me.kinCount.toLocaleString()} Kinling${me.kinCount === 1 ? "" : "s"}. There's no limit, so keep breeding.`),
        ...eggs.map((egg) => this.eggCard(egg)),
        ...hired.map((kin) => this.kinCard(kin)),
        ...kins.map((kin) => this.kinCard(kin)),
        ...this.olderKins.map((kin) => this.kinCard(kin)),
        more > 0 ? el("button", { class: "btn small plain", onclick: () => void this.loadOlderKins() }, `Show older Kinlings (${more.toLocaleString()} more)`) : "",
        kins.length === 0 && eggs.length === 0 ? el("p", {}, "No Kinlings yet.") : "",
        this.upgradesCard(),
      );
    });
  }

  private async loadOlderKins() {
    const me = this.game.me;
    if (!me) return;
    const from = this.game.myKins().length + this.olderKins.length;
    const [, ids] = await view<[number, number[]]>("farm_kins", { index: me.index, from, limit: 40 });
    const rows = await view<any[]>("kins_by_id", { ids });
    this.olderKins.push(...rows.map(parseKin));
    this.rerender();
  }

  private eggCard(egg: Egg): HTMLElement {
    const [a, b] = eggColours(egg, this.game);
    const now = this.game.chainNow();
    const left = Math.max(0, Math.ceil(egg.readyAt - now));
    const ready = left === 0;
    const tonics = this.game.bag(TONIC);
    return el(
      "div",
      { class: "card row spread" },
      el(
        "div",
        { class: "row" },
        eggIcon(a, b, egg.id, 56),
        el("div", {}, el("b", {}, egg.hatching ? "Hatching..." : ready ? "Ready to hatch!" : `Hatches in ${formatTime(left)}`), el("div", { class: "muted" }, `Warmed ${egg.warms} of ${K.maxWarms} times`)),
      ),
      el(
        "div",
        { class: "row wrap", style: "justify-content:flex-end" },
        ready && !egg.hatching ? el("button", { class: "btn small leaf", onclick: () => this.hatchFlow(egg) }, "Hatch") : null,
        !ready && tonics > 0 ? el("button", { class: "btn small", onclick: () => this.game.tap([OP.TONIC_EGG, egg.id, 0, 0]) }, `Tonic (${tonics})`) : null,
        el("button", { class: "btn small plain", onclick: () => this.sellEgg(egg) }, "Sell"),
        el("button", { class: "btn small plain", onclick: () => this.giftEgg(egg) }, "Gift to a friend"),
      ),
    );
  }

  private sellEgg(egg: Egg) {
    const price = pricePicker(200, 0.05);
    this.modal(
      el("h2", {}, "Sell this egg unhatched"),
      el("p", {}, "Nobody knows what's inside, not even you. A good pedigree is what buyers pay for. Price it in acorns, or in testnet NEAR paid straight to your wallet."),
      price.node,
      el(
        "button",
        {
          class: "btn",
          onclick: () => {
            const { inNear, amount } = price.read();
            if (amount < 1) return;
            this.game.tap([inNear ? OP.LIST_EGG_NEAR : OP.LIST_EGG, egg.id, amount, 0]);
            this.closeModal();
          },
        },
        "Put it on my stall",
      ),
    );
  }

  private async giftEgg(egg: Egg) {
    const seed = crypto.getRandomValues(new Uint8Array(32));
    const seedHex = toHex(seed);
    const claimKey = await publicKeyHex(seedHex);
    this.modal(el("h2", {}, "Wrapping it up..."));
    const outcome = await this.game.call("gift_egg", { egg_id: egg.id, claim_key: claimKey }, 12);
    if (!outcome.ok) {
      this.modal(el("h2", {}, "That didn't work"), el("p", {}, "Please try again in a moment."), this.closeButton());
      return;
    }
    const link = `${location.origin}${location.pathname}?gift=${seedHex}`;
    this.modal(
      el("h2", {}, "A gift for a friend"),
      el("p", {}, "Send this link to anyone. They open it, play right away, and find your egg in their nest."),
      el("p", { class: "mono" }, link),
      el(
        "button",
        {
          class: "btn",
          onclick: async () => {
            await navigator.clipboard.writeText(link);
            this.ticker("Link copied.");
          },
        },
        "Copy link",
      ),
      " ",
      this.closeButton(),
    );
  }

  private checkGift() {
    const seed = this.pendingGift;
    const me = this.game.me;
    if (!seed || !me) return;
    this.pendingGift = null;
    history.replaceState(null, "", location.pathname);
    void this.claimGift(seed);
  }

  private async claimGift(seed: string) {
    const claimKey = await publicKeyHex(seed);
    const signature = await signWithSeed(seed, this.game.signer.accountId);
    const outcome = await this.game.call("claim_gift", { claim_key: claimKey, signature }, 12);
    if (outcome.ok) this.banner("Someone sent you an egg!", "It's in your nest.");
    else this.ticker("That gift has already been claimed.");
  }

  private kinCard(kin: Kin): HTMLElement {
    const now = this.game.chainNow();
    const level = kinLevel(kin.xp);
    const grown = isGrown(kin);
    const rest = Math.max(0, Math.ceil(kin.restUntil - now));
    const start = K.kinLevels[level - 1];
    const next = K.kinLevels[level] ?? start + 1;
    const progress = Math.min(100, ((kin.xp - start) / (next - start)) * 100);
    const look = kin.look;

    // Stats have no ceiling, so the bars fill along a curve.
    const statBar = (label: string, value: number, kind: string) =>
      el("div", { class: "stat" }, el("span", {}, label), el("div", { class: "bar" }, el("i", { class: kind, style: `width:${Math.round((100 * value) / (value + 60))}%` })), value.toLocaleString());

    const traits = [HEADS[look.head], HORNS[look.horn], WINGS[look.wing], TAILS[look.tail], PATTERNS[look.pattern]].filter((t) => !t.startsWith("No") && t !== "Plain");

    const offer = el("input", { type: "number", min: 1, value: kin.studFee || 40, style: "width:76px" }) as HTMLInputElement;
    const price = pricePicker(500, 0.1);
    const hirePrice = el("input", { type: "number", min: 0.001, step: 0.001, max: 5, value: kin.rentMilli ? kin.rentMilli / 1000 : 0.01, style: "width:82px" }) as HTMLInputElement;
    const outOnHire = kin.renterIndex !== NOBODY && kin.rentedUntil > now;
    const myHire = outOnHire && kin.renterIndex === this.game.view!.me;
    const owned = kin.owner === this.game.view!.me;

    return el(
      "div",
      { class: "card" },
      el(
        "div",
        { class: "row" },
        portrait(kin, 118),
        el(
          "div",
          { class: "grow" },
          el("h3", {}, capitalise(kin.name), look.shiny ? " ✨" : ""),
          el("div", { class: "muted" }, `${this.speciesNameOf(kin)}, generation ${kin.generation}`, kin.generation > 0 ? ` (powers ×${(might(kin.generation) / 100).toFixed(1)})` : ""),
          el("div", { class: "row", style: "margin:4px 0" }, el("span", { style: "font-size:14px" }, `Level ${level} of ${K.kinLevels.length}`), el("div", { class: "bar grow" }, el("i", { style: `width:${progress}%` }))),
          K.foods.some((food) => this.game.bag(food.item) > 0 && foodHelps(food.item, kin.xp)) || level >= K.kinLevels.length
            ? null
            : el("div", { class: "muted small" }, this.nextFoodHint(kin)),
          statBar("Speed", look.speed, "speed"),
          statBar("Stamina", look.stamina, "stamina"),
          statBar("Luck", look.luck, "luck"),
        ),
      ),
      this.powerChips(kin),
      el("div", { style: "margin:6px 0" }, ...traits.map((t) => el("span", { class: "chip" }, t)), kin.wins > 0 ? el("span", { class: "chip" }, `${kin.wins} wins`) : null, kin.childCount > 0 ? el("span", { class: "chip" }, `${kin.childCount} children`) : null),
      el(
        "div",
        { class: "muted" },
        myHire
          ? `On hire to you for ${formatTime(Math.ceil(kin.rentedUntil - now))}.`
          : outOnHire
            ? `Out on hire for ${formatTime(Math.ceil(kin.rentedUntil - now))}.`
            : !grown
              ? `Can race now. Feed it to level ${K.adult} and it can have babies.`
              : rest > 0
                ? `Can race. Resting ${formatTime(rest)} before it can pair.`
                : `Grown, rested and ready.`,
      ),
      el(
        "div",
        { class: "row wrap", style: "margin-top:8px" },
        !outOnHire || myHire ? el("button", { class: "btn small berry", onclick: () => this.startRace(kin) }, "Race") : null,
        kin.purse > 0 && owned ? el("button", { class: "btn small", onclick: () => this.collect(kin) }, `Collect ${kin.purse}`) : null,
        el("button", { class: "btn small plain", onclick: () => this.openFamily(kin) }, "Family tree"),
        grown && (!outOnHire || myHire) ? el("button", { class: "btn small", onclick: () => this.openPair(kin.id) }, "Pair") : null,
      ),
      owned
        ? el(
            "div",
            { class: "row wrap", style: "margin-top:8px" },
            kin.rentMilli > 0
              ? el("button", { class: "btn small plain", onclick: () => this.game.tap([OP.HIRE_OUT, kin.id, 0, 0]) }, `Stop hiring out (${this.milliText(kin.rentMilli)})`)
              : el(
                  "span",
                  {},
                  hirePrice,
                  " NEAR ",
                  el(
                    "button",
                    {
                      class: "btn small sky",
                      onclick: () => {
                        const milli = Math.round(Number(hirePrice.value) * 1000);
                        if (milli >= 1 && milli <= 5000) {
                          this.game.tap([OP.HIRE_OUT, kin.id, milli, 0]);
                          this.ticker(`${capitalise(kin.name)} is up for hire. You'll be paid in NEAR.`);
                        }
                      },
                    },
                    "Hire out",
                  ),
                ),
          )
        : null,
      grown && owned
        ? el(
            "div",
            { class: "row wrap", style: "margin-top:8px" },
            kin.studFee > 0
              ? el("button", { class: "btn small plain", onclick: () => this.game.tap([OP.STUD, kin.id, 0, 0]) }, `Stop offering (${kin.studFee})`)
              : el("span", {}, offer, " ", el("button", { class: "btn small plain", onclick: () => this.game.tap([OP.STUD, kin.id, Math.floor(Number(offer.value)), 0]) }, "Offer for pairing")),
            el(
              "span",
              {},
              price.node,
              " ",
              el(
                "button",
                {
                  class: "btn small plain",
                  onclick: () => {
                    const { inNear, amount } = price.read();
                    if (amount >= 1) this.game.tap([inNear ? OP.LIST_KIN_NEAR : OP.LIST_KIN, kin.id, amount, 0]);
                  },
                },
                "Sell",
              ),
            ),
          )
        : null,
    );
  }

  private upgradesCard(): HTMLElement {
    const me = this.game.me!;
    const purchases = (me.plots.length - K.startPlots) / K.plotsPerLand;
    const landCost = K.land[purchases];
    const acorns = this.game.bag(ACORN);
    return el(
      "div",
      { class: "card" },
      el("h3", {}, "Grow the farm"),
      el(
        "div",
        { class: "row wrap", style: "margin-top:8px" },
        landCost !== undefined
          ? el("button", { class: "btn small leaf", disabled: acorns < landCost, onclick: () => { this.game.tap([OP.BUY_LAND, 0, 0, 0, landCost]); sound.coin(); } }, `2 more plots: ${landCost.toLocaleString()}`)
          : el("span", { class: "chip" }, "All land bought"),
      ),
      el("h3", { style: "margin-top:12px" }, "Crop skill"),
      el("p", { class: "muted" }, "Keep growing one crop and each harvest yields more."),
      el(
        "div",
        { class: "row wrap" },
        ...K.crops.map((crop) => {
          const practice = me.mastery[crop.item - 1];
          const stars = K.mastery.filter((needed) => practice >= needed).length;
          return el("span", { class: "chip" }, `${crop.name} ${"★".repeat(stars)}${"☆".repeat(3 - stars)}`);
        }),
      ),
    );
  }

  speciesNameOf(kin: Kin): string {
    const species = speciesNumber(kin.look);
    const known = this.species.get(species);
    if (known && known.named) return known.name;
    return classicName(species) ?? fallbackSpeciesName(kin.look);
  }

  private async loadSpecies() {
    try {
      const rows = await view<any[]>("species_page", { from: 0, limit: 100 });
      for (const row of rows) this.species.set(row[0], { name: row[1], finder: row[2], named: row[3] === 1, count: row[4], finderName: row[5] });
    } catch {
      // Names fall back to the built-in ones.
    }
  }

  // ----- Pairing ------------------------------------------------------------

  private pairMother = 0;
  private pairFather = 0;
  private pairFood = 0;

  openPair(mother?: number, father?: number) {
    if (mother !== undefined) this.pairMother = mother;
    if (father !== undefined) this.pairFather = father;
    const grown = this.game.usableKins().filter(isGrown);
    if (!grown.some((kin) => kin.id === this.pairMother) && grown.length > 0) this.pairMother = grown[0].id;
    this.openSheet("Pair two Kinlings", (body) => body.replaceChildren(...this.pairView()), false);
  }

  private pairView(): (HTMLElement | string)[] {
    const world = this.game.view!;
    const now = this.game.chainNow();
    const mine = this.game.usableKins().filter(isGrown);
    const rested = (kin: Kin) => kin.restUntil <= now;
    const isMine = (kin: Kin) => mine.some((m) => m.id === kin.id);
    const partners = [
      ...mine.filter((kin) => kin.id !== this.pairMother),
      ...world.studs.map((id) => world.kins.get(id)).filter((kin): kin is Kin => Boolean(kin) && !isMine(kin!)),
    ];
    const pick = (kin: Kin, selected: boolean, choose: () => void) =>
      el(
        "button",
        { class: `pick ${selected ? "on" : ""}`, disabled: !rested(kin), onclick: () => { choose(); this.rerender(); sound.pop(); } },
        portrait(kin, 84),
        capitalise(kin.name),
        el("small", {}, isMine(kin) ? `Gen ${kin.generation} ${kin.owner === world.me ? "" : "(hired)"}` : `${kin.studFee} acorns`),
        el("small", { class: "power-row" }, powersIn(kin.powers).map((power) => power.icon).join("")),
        el("small", {}, rested(kin) ? "" : `resting ${formatTime(Math.ceil(kin.restUntil - now))}`),
      );

    const mother = world.kins.get(this.pairMother);
    const father = world.kins.get(this.pairFather);
    const fee = father && !isMine(father) ? father.studFee : 0;
    const total = K.pairing + fee;
    const can = mother && father && mother.id !== father.id && rested(mother) && rested(father) && this.game.bag(ACORN) >= total;
    const babyPowers = mother && father ? powersIn(mother.powers | father.powers) : [];

    const foods = K.foods.filter((food) => this.game.bag(food.item) > 0);
    return [
      el("p", {}, "Your Kinling lays the egg, so the baby joins your family. Babies keep every power both parents have and always come out stronger. You can have as many as you like."),
      mine.length === 0 ? el("p", { class: "error" }, "You need a grown Kinling first. Feed yours until it reaches level " + K.adult + ".") : "",
      el("h3", {}, "Your Kinling"),
      el("div", { class: "picker", style: "margin:8px 0 14px" }, ...mine.map((kin) => pick(kin, kin.id === this.pairMother, () => { this.pairMother = kin.id; }))),
      el("h3", {}, "Its partner"),
      el("div", { class: "picker", style: "margin:8px 0 14px" }, ...partners.map((kin) => pick(kin, kin.id === this.pairFather, () => { this.pairFather = kin.id; }))),
      el("h3", {}, "Serve a meal"),
      el(
        "div",
        { class: "picker", style: "margin:8px 0 14px" },
        el("button", { class: `pick ${this.pairFood === 0 ? "on" : ""}`, onclick: () => { this.pairFood = 0; this.rerender(); } }, "No meal", el("small", {}, "Leave it to chance")),
        ...foods.map((food) =>
          el(
            "button",
            { class: `pick ${food.rare ? "rare" : ""} ${this.pairFood === food.item ? "on" : ""}`, onclick: () => { this.pairFood = food.item; this.rerender(); } },
            itemIcon(food.item, 40),
            food.name,
            el("small", {}, FOOD_HINTS[food.item]),
          ),
        ),
      ),
      babyPowers.length ? el("div", { class: "card" }, el("b", {}, "The baby will have: "), babyPowers.map((power) => `${power.icon} ${power.name}`).join(", ")) : "",
      el("button", { class: "btn small sky", onclick: () => this.openHire() }, "Hire a champion to pair with"),
      el(
        "div",
        { class: "row spread card" },
        el("div", {}, el("b", {}, `${total} acorns`), el("div", { class: "muted" }, fee ? `${K.pairing} to the Old Oak, ${fee} to the partner's purse` : `${K.pairing} to the Old Oak`)),
        el(
          "button",
          {
            class: "btn leaf",
            disabled: !can,
            onclick: () => {
              if (!mother || !father) return;
              this.game.tap([OP.BREED, mother.id, father.id, this.pairFood]);
              this.closeSheet();
              sound.hatch();
              this.banner(`${capitalise(mother.name)} and ${capitalise(father.name)} are expecting!`, "An egg is on its way to your nest.");
            },
          },
          "Pair them",
        ),
      ),
    ];
  }

  // ----- The Valley Dash -----------------------------------------------------

  private raceTab: RaceTab = "race";
  private raceRacer = 0;
  private challengeList: { now: number; list: Challenge[]; at: number } | null = null;
  private loadingChallenges = false;
  private newFee = 20;
  private newSeats = 4;

  openRace(tab: RaceTab = "race") {
    this.raceTab = tab;
    if (tab === "challenges") void this.loadChallenges();
    this.openSheet("The Valley Dash", (body) => {
      const tabButton = (id: RaceTab, label: string) =>
        el(
          "button",
          {
            class: `tab ${this.raceTab === id ? "on" : ""}`,
            onclick: () => {
              this.raceTab = id;
              if (id === "challenges") void this.loadChallenges();
              this.rerender();
            },
          },
          label,
        );
      const tabs = el(
        "div",
        { class: "tabs" },
        tabButton("race", "Practice"),
        tabButton("challenges", "Challenges for NEAR"),
        tabButton("hire", "Hire a champion"),
        tabButton("champions", "Champions"),
      );
      if (this.raceTab === "challenges" && (!this.challengeList || performance.now() - this.challengeList.at > 8_000)) void this.loadChallenges();
      const content =
        this.raceTab === "race"
          ? this.raceView()
          : this.raceTab === "challenges"
            ? this.challengesView()
            : this.raceTab === "hire"
              ? this.hireView()
              : this.championsView();
      body.replaceChildren(tabs, ...content);
    });
  }

  private async loadChallenges() {
    if (this.loadingChallenges) return;
    this.loadingChallenges = true;
    try {
      const fresh = await this.game.challenges();
      this.challengeList = { ...fresh, at: performance.now() };
      if (this.raceTab === "challenges") this.rerender();
    } catch (error) {
      console.warn("Could not read the challenges", error);
    } finally {
      this.loadingChallenges = false;
    }
  }

  openHire() {
    this.closePopover();
    this.openRace("hire");
  }

  private milliText(milli: number): string {
    return `${(milli / 1000).toFixed(3).replace(/0+$/, "").replace(/\.$/, ".0")} NEAR`;
  }

  private powerChips(kin: Kin): HTMLElement {
    return el(
      "div",
      { class: "power-chips" },
      ...powersIn(kin.powers).map((power) => el("span", { class: "power-chip", title: power.text }, power.icon, " ", power.name)),
    );
  }

  private raceView(): HTMLElement[] {
    const world = this.game.view!;
    const now = this.game.chainNow();
    const racers = this.game.usableKins();
    if (!racers.some((kin) => kin.id === this.raceRacer) && racers.length > 0) this.raceRacer = racers[0].id;
    const chosen = racers.find((kin) => kin.id === this.raceRacer);
    const rested = chosen ? chosen.raceReadyAt <= now : false;
    const purse = rested ? Math.min(K.raceBonus, world.raceBudget) : 0;

    if (racers.length === 0) {
      return [
        el("div", { class: "card" }, el("h3", {}, "You need a Kinling to race"), el("p", {}, "Hatch your egg, or hire a champion for a while.")),
        el("button", { class: "btn sky", onclick: () => this.openHire() }, "Hire a champion"),
      ];
    }

    return [
      el("h3", {}, "Pick your racer"),
      el(
        "div",
        { class: "picker", style: "margin:8px 0 14px" },
        ...racers.map((kin) =>
          el(
            "button",
            { class: `pick ${kin.id === this.raceRacer ? "on" : ""}`, onclick: () => { this.raceRacer = kin.id; this.rerender(); sound.pop(); } },
            portrait(kin, 80),
            capitalise(kin.name),
            el("small", {}, `Gen ${kin.generation}${kin.owner === world.me ? "" : " · hired"}`),
            el("small", { class: "power-row" }, powersIn(kin.powers).map((power) => power.icon).join("")),
          ),
        ),
      ),
      chosen ? this.powerChips(chosen) : el("span", {}),
      el(
        "div",
        { class: "card" },
        el("h3", {}, rested ? `Free practice. The Oak puts up ${purse} acorns` : "Free practice, just for the fun of it"),
        el(
          "p",
          { class: "muted" },
          rested
            ? `Race the valley's Kinlings any time, for free. Rested, so the top three share the acorns and take home crops: ${K.raceCrops.join(", ")} for 1st, 2nd and 3rd. A rested win sometimes brings home a rare food, too. Practice never pays NEAR.`
            : `It can race again right now, just for practice. Rested again, with acorns and crops to win, in ${formatTime(Math.max(0, Math.ceil(chosen!.raceReadyAt - now)))}.`,
        ),
      ),
      this.friends && this.friends.length > 0
        ? el(
            "label",
            { class: "row", style: "gap:8px;margin:6px 0" },
            (() => {
              const box = el("input", { type: "checkbox" }) as HTMLInputElement;
              box.checked = this.raceFriends;
              box.addEventListener("change", () => (this.raceFriends = box.checked));
              return box;
            })(),
            `Race my NEAR Social friends' Kinlings first (${this.friends.length} play here)`,
          )
        : el("span", {}),
      el(
        "button",
        { class: "btn big berry", style: "width:100%", disabled: !chosen, onclick: () => chosen && this.startRace(chosen) },
        "Practice now (free)",
      ),
      el(
        "button",
        { class: "btn big sky", style: "width:100%;margin-top:8px", onclick: () => { this.raceTab = "challenges"; void this.loadChallenges(); this.rerender(); } },
        "Race real players for NEAR",
      ),
      el(
        "div",
        { class: "card controls-card" },
        el("h3", {}, "How to race"),
        el("p", {}, el("b", {}, "Left / Right"), " or swipe: change lane."),
        el("p", {}, el("b", {}, "Up"), " or hold Sprint: run faster, using up breath."),
        el("p", {}, el("b", {}, "Down"), " or hold Slow: ease off and get your breath back."),
        el("p", {}, el("b", {}, "Space"), " or Jump: over logs, hedges and fireballs."),
        el("p", {}, el("b", {}, "1 to 8"), " or the power buttons: spit fire and all the rest."),
      ),
      el(
        "p",
        { class: "muted" },
        "Your rivals are real Kinlings owned by other players, running on instinct. If one beats you, its owner gets that place's acorns. Afterwards the contract replays your moves to confirm the result.",
      ),
    ];
  }

  // ----- Challenges: real players, real (test) NEAR ---------------------------

  private challengesView(): HTMLElement[] {
    const world = this.game.view!;
    const data = this.challengeList;
    const now = data ? data.now + (performance.now() - data.at) / 1000 : this.game.chainNow();
    const me = world.me;
    const racers = this.game.usableKins();
    if (!racers.some((kin) => kin.id === this.raceRacer) && racers.length > 0) this.raceRacer = racers[0].id;
    const chosen = racers.find((kin) => kin.id === this.raceRacer);
    const spendable = this.game.spendableMilli();
    const wallet = walletAccount();

    const intro = el(
      "div",
      { class: "card challenge-intro" },
      el("h3", {}, "Race real players for testnet NEAR"),
      el(
        "p",
        {},
        "Open a challenge or join one. Every runner pays the same entry fee into the pot, and the fastest times share all of it, paid straight to their wallets. The valley keeps nothing.",
      ),
      el(
        "p",
        { class: "muted" },
        "Everyone runs the same course against the same field, once, whenever they like in the hour it's open. You race the ghosts of anyone who ran before you, and the contract checks every run move by move.",
      ),
      el(
        "div",
        { class: "row spread" },
        el("span", {}, `Your farm can spend ${nearText(spendable)} NEAR`),
        el("button", { class: "btn small plain", onclick: () => this.openWallet() }, wallet ? `Wallet: ${wallet}` : "Connect a wallet"),
      ),
    );

    if (racers.length === 0) return [intro, el("p", { class: "muted" }, "Hatch your egg first, or hire a champion, to have a racer.")];

    const picker = el(
      "div",
      { class: "picker", style: "margin:8px 0" },
      ...racers.map((kin) =>
        el(
          "button",
          { class: `pick ${kin.id === this.raceRacer ? "on" : ""}`, onclick: () => { this.raceRacer = kin.id; this.rerender(); sound.pop(); } },
          portrait(kin, 64),
          capitalise(kin.name),
          el("small", { class: "power-row" }, powersIn(kin.powers).map((power) => power.icon).join("")),
        ),
      ),
    );

    const feeButtons = el(
      "div",
      { class: "row wrap" },
      ...CHALLENGE_FEES.map((fee) =>
        el("button", { class: `chip ${this.newFee === fee ? "on" : ""}`, onclick: () => { this.newFee = fee; this.rerender(); } }, `${nearText(fee)} NEAR`),
      ),
    );
    const seatButtons = el(
      "div",
      { class: "row wrap" },
      ...[2, 3, 4, 5, 6].map((seats) =>
        el("button", { class: `chip ${this.newSeats === seats ? "on" : ""}`, onclick: () => { this.newSeats = seats; this.rerender(); } }, `${seats} runners`),
      ),
    );
    const shares = prizeShares(this.newSeats).filter((share) => share > 0);
    const pot = this.newFee * this.newSeats;
    const openCard = el(
      "div",
      { class: "card" },
      el("h3", {}, "Open a challenge"),
      el("div", { class: "muted" }, "Pick your racer:"),
      picker,
      el("div", { class: "muted" }, "Entry fee:"),
      feeButtons,
      el("div", { class: "muted", style: "margin-top:6px" }, "Runners:"),
      seatButtons,
      el(
        "p",
        {},
        `A full field makes a ${nearText(pot)} NEAR pot: ${shares.map((share, place) => `${["1st", "2nd", "3rd"][place]} ${nearText((pot * share) / 100)}`).join(", ")}.`,
      ),
      el(
        "div",
        { class: "row wrap" },
        el(
          "button",
          { class: "btn leaf", disabled: !chosen || spendable < this.newFee, onclick: () => chosen && void this.openChallenge(chosen, "farm") },
          spendable >= this.newFee ? `Open it: ${nearText(this.newFee)} NEAR from my farm` : `Your farm needs ${nearText(this.newFee)} NEAR`,
        ),
        el("button", { class: "btn sky", disabled: !chosen, onclick: () => chosen && void this.openChallenge(chosen, "wallet") }, wallet ? `Pay from ${wallet}` : "Pay from a wallet"),
      ),
    );

    if (!data) return [intro, openCard, el("p", { class: "muted" }, "Looking for open challenges...")];

    const mine = data.list.filter((c) => !c.settled && c.entries.some((entry) => entry.playerIndex === me));
    const open = data.list.filter((c) => !c.settled && !c.entries.some((entry) => entry.playerIndex === me) && c.entries.length < c.seats && now < c.closes);
    const done = data.list.filter((c) => c.settled).slice(0, 6);

    const header = (c: Challenge) =>
      el(
        "div",
        { class: "row spread" },
        el("b", {}, `${c.hostName}'s challenge`),
        el("span", { class: "chip near" }, `${nearText(c.feeMilli)} NEAR · pot ${nearText(c.feeMilli * c.entries.length)}`),
      );
    const timing = (c: Challenge) => {
      const left = Math.max(0, Math.ceil(c.closes - now));
      return `${c.entries.length} of ${c.seats} joined · ${left > 0 ? `closes in ${formatTime(left)}` : "closed"}`;
    };

    const myCard = (c: Challenge) => {
      const entry = c.entries.find((e) => e.playerIndex === me)!;
      const kin = world.kins.get(entry.kinId);
      const closed = now >= c.closes;
      const allIn = c.entries.every((e) => e.ticks !== 0);
      const runButton =
        entry.started === 0 && !closed && kin
          ? el("button", { class: "btn berry", onclick: () => void this.startChallenge(c, kin) }, `Run it now with ${capitalise(kin.name)}`)
          : null;
      const settleButton =
        (closed && !c.entries.some((e) => e.started > 0 && e.ticks === 0 && now - e.started < 600)) || (c.hostIndex === me && c.entries.length >= 2 && allIn)
          ? el("button", { class: "btn leaf", onclick: () => void this.settleChallenge(c) }, closed ? "Pay it out now" : "Close it and pay out")
          : null;
      const cancelButton =
        c.hostIndex === me && c.entries.length === 1 && entry.started === 0
          ? el("button", { class: "btn small plain", onclick: () => void this.cancelChallenge(c) }, "Call it off (fee back)")
          : null;
      return el(
        "div",
        { class: "card challenge" },
        header(c),
        el("div", { class: "muted" }, timing(c)),
        el("div", { class: "race-ranks" }, ...standingsRows(c, me)),
        el("div", { class: "row wrap" }, runButton, settleButton, cancelButton, el("button", { class: "btn small plain", onclick: () => void this.shareChallenge(c) }, "Invite someone")),
      );
    };

    const openCardFor = (c: Challenge) => {
      const best = c.entries.filter((e) => e.ticks > 0 && e.ticks !== DID_NOT_FINISH).sort((a, b) => a.ticks - b.ticks)[0];
      return el(
        "div",
        { class: "card challenge" },
        header(c),
        el("div", { class: "muted" }, timing(c)),
        el("div", {}, best ? `Time to beat: ${(best.ticks / 30).toFixed(1)} s by ${best.name}` : "Nobody has run it yet."),
        el(
          "div",
          { class: "row wrap" },
          el(
            "button",
            { class: "btn leaf", disabled: !chosen || spendable < c.feeMilli, onclick: () => chosen && void this.joinChallenge(c, chosen, "farm") },
            chosen ? `Join with ${capitalise(chosen.name)}: ${nearText(c.feeMilli)} NEAR` : "Pick a racer above",
          ),
          el("button", { class: "btn sky", disabled: !chosen, onclick: () => chosen && void this.joinChallenge(c, chosen, "wallet") }, wallet ? `Pay from ${wallet}` : "Pay from a wallet"),
        ),
      );
    };

    const doneCard = (c: Challenge) => {
      const winner = c.entries.find((e) => e.prizeMicro > 0 && e.prizeMicro === Math.max(...c.entries.map((x) => x.prizeMicro)));
      return el(
        "div",
        { class: "card challenge done" },
        header(c),
        el("div", {}, winner ? `${winner.name} won ${nearText(winner.prizeMicro / 1000)} NEAR` : "Nobody finished, so every fee went back."),
        el("div", { class: "race-ranks" }, ...standingsRows(c, me)),
      );
    };

    return [
      intro,
      ...(mine.length ? [el("h3", {}, "Your challenges"), ...mine.map(myCard)] : []),
      el("h3", {}, "Open challenges"),
      ...(open.length ? open.map(openCardFor) : [el("p", { class: "muted" }, "None open right now. Open one and invite a friend!")]),
      openCard,
      ...(done.length ? [el("h3", {}, "Recently paid out"), ...done.map(doneCard)] : []),
    ];
  }

  private async openChallenge(kin: Kin, payWith: "farm" | "wallet") {
    sound.coin();
    this.banner(payWith === "wallet" ? "Check your wallet to approve" : "Opening your challenge...");
    try {
      if (payWith === "wallet") {
        await openChallengeWithWallet(kin.id, this.newFee, this.newSeats, this.game.signer.accountId);
      } else if ((await this.game.openChallengeFromFarm(kin.id, this.newFee, this.newSeats)) === null) {
        throw new Error("refused");
      }
      await this.loadChallenges();
      const opened = this.challengeList?.list.find((c) => !c.settled && c.hostIndex === this.game.view?.me && c.entries[0]?.kinId === kin.id && c.entries[0].started === 0);
      if (!opened) throw new Error("not found");
      this.banner("Your challenge is open", "Run it now to set the time to beat, then invite friends");
      sound.fanfare();
      this.rerender();
    } catch (error) {
      console.warn(error);
      this.banner("That challenge didn't open", "No NEAR was kept: anything paid comes back.");
    }
  }

  private async joinChallenge(c: Challenge, kin: Kin, payWith: "farm" | "wallet") {
    sound.coin();
    this.banner(payWith === "wallet" ? "Check your wallet to approve" : `Joining ${c.hostName}'s challenge...`);
    try {
      if (payWith === "wallet") await joinChallengeWithWallet(c.id, kin.id, c.feeMilli, this.game.signer.accountId);
      else if (!(await this.game.joinChallengeFromFarm(c.id, kin.id))) throw new Error("refused");
      await this.loadChallenges();
      const joined = this.challengeList?.list.find((x) => x.id === c.id)?.entries.some((e) => e.playerIndex === this.game.view?.me);
      if (!joined) throw new Error("not joined");
      this.banner(`You're in ${c.hostName}'s challenge`, "Run it whenever you're ready, within the hour");
      this.rerender();
    } catch (error) {
      console.warn(error);
      this.banner("That didn't go through", "No NEAR was kept. It may have filled up first.");
    }
  }

  private async settleChallenge(c: Challenge) {
    const done = await this.game.settleChallenge(c.id).catch(() => false);
    this.banner(done ? "Paid out" : "It can't pay out yet", done ? "Prizes are on their way to the winners' wallets" : "Someone may still be running");
    await this.loadChallenges();
  }

  private async cancelChallenge(c: Challenge) {
    const done = await this.game.cancelChallenge(c.id).catch(() => false);
    this.banner(done ? "Called off" : "That couldn't be called off", done ? "Your fee is on its way back" : undefined);
    await this.loadChallenges();
  }

  private async shareChallenge(c: Challenge) {
    const text = `I've opened a ${nearText(c.feeMilli)} NEAR race in Kinlings. Fastest time takes the pot! ${location.origin}${location.pathname}?challenge=${c.id}`;
    try {
      await navigator.clipboard.writeText(text);
      this.ticker("Invitation copied. Send it to a friend!");
    } catch {
      this.ticker(text);
    }
  }

  async startChallenge(c: Challenge, kin: Kin) {
    this.closeSheet();
    this.closePopover();
    await runRace({ game: this.game, kin, ui: this, scene: this.scene, layer: $("race-layer"), challenge: c });
    void this.loadChallenges();
  }

  private hireView(): HTMLElement[] {
    const world = this.game.view!;
    const now = this.game.chainNow();
    const offers = world.rentals
      .map((id) => world.kins.get(id))
      .filter((kin): kin is Kin => Boolean(kin) && kin!.owner !== world.me)
      .sort((a, b) => b.look.speed + b.look.stamina - (a.look.speed + a.look.stamina));
    const spendable = this.game.spendableMilli();
    const wallet = walletAccount();

    const card = (kin: Kin) => {
      const out = kin.renterIndex !== NOBODY && kin.rentedUntil > now;
      const owner = world.farms.get(kin.owner);
      const payable = spendable >= kin.rentMilli;
      return el(
        "div",
        { class: "card" },
        el(
          "div",
          { class: "row" },
          portrait(kin, 84),
          el(
            "div",
            { class: "grow" },
            el("h3", {}, capitalise(kin.name)),
            el("div", { class: "muted" }, `${this.speciesNameOf(kin)}, generation ${kin.generation}${owner ? `, ${owner.elder ? "Elder " : ""}${owner.name}'s` : ""}`),
            el("div", {}, `Speed ${kin.look.speed}  ·  Stamina ${kin.look.stamina}  ·  Luck ${kin.look.luck}`),
            this.powerChips(kin),
          ),
        ),
        out
          ? el("div", { class: "muted" }, `Hired by someone for ${formatTime(Math.ceil(kin.rentedUntil - now))}`)
          : el(
              "div",
              { class: "row wrap", style: "margin-top:8px" },
              el(
                "button",
                { class: "btn small leaf", disabled: !payable, onclick: () => void this.hire(kin) },
                payable ? `Hire 30 min: ${this.milliText(kin.rentMilli)}` : `Needs ${this.milliText(kin.rentMilli)}`,
              ),
              el("button", { class: "btn small sky", onclick: () => void this.hireWithWallet(kin) }, wallet ? `Pay with ${wallet}` : "Pay with a wallet"),
            ),
      );
    };

    return [
      el(
        "div",
        { class: "card" },
        el("h3", {}, "Hire a champion with NEAR"),
        el("p", {}, "Race a stronger Kinling, or pair yours with it: the baby gets all its powers and comes out stronger still. Most of what you pay goes straight to the owner's NEAR account."),
        el("div", { class: "row spread" }, el("span", {}, `You can spend ${(spendable / 1000).toFixed(3)} NEAR`), el("button", { class: "btn small plain", onclick: () => this.openWallet() }, "My NEAR")),
      ),
      ...(offers.length ? offers.map(card) : [el("p", { class: "muted" }, "Nobody is hiring out a Kinling right now.")]),
    ];
  }

  private async hire(kin: Kin) {
    sound.coin();
    this.closeSheet();
    this.banner(`Hiring ${capitalise(kin.name)}...`);
    const hired = await this.game.hireFromFarm(kin.id).catch(() => false);
    if (hired) {
      sound.fanfare();
      this.banner(`${capitalise(kin.name)} is yours for 30 minutes`, "Race it, or pair yours with it");
      this.raceRacer = kin.id;
      this.openRace("race");
    } else {
      this.banner("That hire didn't go through", "No NEAR was taken. Someone may have got there first.");
    }
  }

  private async hireWithWallet(kin: Kin) {
    try {
      this.banner("Check your wallet to approve");
      await payHireWithWallet(kin.id, kin.rentMilli, this.game.signer.accountId);
      await this.game.refresh();
      this.lastHud = "";
      const hired = this.game.view?.hired.includes(kin.id);
      this.banner(hired ? `${capitalise(kin.name)} is yours for 30 minutes` : "The wallet didn't complete that hire");
    } catch (error) {
      console.warn(error);
      this.banner("The wallet didn't complete that hire");
    }
  }

  private championsView(): HTMLElement[] {
    const world = this.game.view!;
    if (world.topRacers.length === 0) return [el("p", { class: "muted" }, "Nobody has won a race yet. It could be you.")];
    return world.topRacers.map((entry, place) => {
      const kin = world.kins.get(entry.kin);
      return el(
        "div",
        { class: "card row spread" },
        el("div", { class: "row" }, kin ? portrait(kin, 62) : null, el("div", {}, el("b", {}, `${place + 1}. ${kin ? capitalise(kin.name) : "A Kinling"}`), el("div", { class: "muted" }, `${entry.owner}'s`))),
        el("span", {}, `${entry.wins} wins`),
      );
    });
  }

  async startRace(kin: Kin) {
    this.closeSheet();
    this.closePopover();
    this.advanceCoach(6);
    await runRace({
      game: this.game,
      kin,
      ui: this,
      scene: this.scene,
      layer: $("race-layer"),
      friends: this.raceFriends && this.friends ? this.friends.map((friend) => friend.farm) : [],
    });
  }

  // ----- My NEAR --------------------------------------------------------------

  openWallet() {
    this.openSheet("My NEAR", (body) => body.replaceChildren(...this.walletView()));
  }

  private walletView(): HTMLElement[] {
    const world = this.game.view!;
    const account = this.game.signer.accountId;
    const balance = this.game.nearBalance;
    const connected = walletAccount();
    const payoutTo = world.wallet || account;
    const amount = el("input", { type: "number", min: 0.001, step: 0.001, value: 0.01, style: "width:100px" }) as HTMLInputElement;
    const typed = el("input", { placeholder: "you.testnet", autocomplete: "off", spellcheck: "false", style: "width:200px" }) as HTMLInputElement;

    return [
      el(
        "div",
        { class: "card" },
        el("h3", {}, `${this.nearText(balance)} testnet NEAR`),
        el("p", { class: "muted" }, `You can spend ${(this.game.spendableMilli() / 1000).toFixed(3)} of it. The rest pays for your moves.`),
        el("p", {}, `Earned so far: ${(world.nearEarnedMicro / 1_000_000).toFixed(4)} NEAR`),
        el("p", { class: "mono" }, account),
        el(
          "div",
          { class: "row wrap" },
          el("button", { class: "btn small plain", onclick: async () => { await navigator.clipboard.writeText(account); this.ticker("Account copied."); } }, "Copy my account"),
          el("a", { class: "btn small plain", href: `https://testnet.nearblocks.io/address/${account}`, target: "_blank", rel: "noopener" }, "See it on NEAR"),
          el("a", { class: "btn small plain", href: "https://near-faucet.io/", target: "_blank", rel: "noopener" }, "Get free test NEAR"),
        ),
      ),
      el(
        "div",
        { class: "card" },
        el("h3", {}, "Your wallet"),
        el("p", {}, `Your earnings are paid to ${payoutTo}.`),
        connected
          ? el(
              "div",
              { class: "row wrap" },
              el("span", { class: "chip" }, `Connected: ${connected}`),
              el(
                "button",
                {
                  class: "btn small plain",
                  onclick: async () => {
                    await disconnectWallet();
                    await this.game.setWallet(null);
                    this.rerender();
                  },
                },
                "Disconnect",
              ),
            )
          : el(
              "button",
              {
                class: "btn small sky",
                onclick: async () => {
                  const wallet = await connectWallet().catch((error) => {
                    console.warn(error);
                    return null;
                  });
                  if (!wallet) {
                    this.ticker("No wallet was connected.");
                    return;
                  }
                  await this.game.setWallet(wallet);
                  this.banner(`Connected ${wallet}`, "Your earnings will go there");
                  this.rerender();
                },
              },
              "Connect a NEAR wallet",
            ),
        el("div", { class: "row wrap", style: "margin-top:10px" }, typed, el("button", { class: "btn small plain", onclick: async () => { const value = typed.value.trim(); if (/^[a-z0-9._-]{2,64}$/.test(value)) { await this.game.setWallet(value); this.banner("Saved", `Earnings will go to ${value}`); this.rerender(); } } }, "Pay me here instead")),
      ),
      el(
        "div",
        { class: "card" },
        el("h3", {}, "Send NEAR to your wallet"),
        el(
          "div",
          { class: "row wrap" },
          amount,
          el(
            "button",
            {
              class: "btn small",
              disabled: !world.wallet,
              onclick: async () => {
                const milli = Math.round(Number(amount.value) * 1000);
                if (milli < 1 || milli > this.game.spendableMilli()) {
                  this.ticker("You can't send that much.");
                  return;
                }
                const done = await this.game.cashOut(milli, null).catch(() => false);
                this.banner(done ? "Sent" : "That didn't send", done ? `${amount.value} NEAR is on its way to ${world.wallet}` : undefined);
                this.rerender();
              },
            },
            world.wallet ? `Send to ${world.wallet}` : "Connect a wallet first",
          ),
        ),
      ),
      this.socialCard(),
      el(
        "p",
        { class: "muted" },
        `This is NEAR's test network, so it's play money with no real value. The valley's own fund, from its small cut of hires and sales, holds ${(world.nearPotMicro / 1_000_000).toFixed(3)} NEAR.`,
      ),
    ];
  }

  // ----- NEAR Social ----------------------------------------------------------

  private socialCard(): HTMLElement {
    const me = this.game.me;
    const farmAccount = this.game.signer.accountId;
    const connected = socialAccount();
    const linked = me?.social ?? "";
    if (!connected && !linked) {
      return el(
        "div",
        { class: "card social-card" },
        el("h3", {}, "NEAR Social"),
        el(
          "p",
          {},
          "Link your near.social profile to put your name and picture on your farm, find the people you follow who play Kinlings, race their Kinlings and share your wins.",
        ),
        el("p", { class: "muted" }, "It uses your NEAR mainnet account. Kinlings never posts anything unless you press Post."),
        el("button", { class: "btn sky", onclick: () => void this.connectNearSocial() }, "Connect NEAR Social"),
      );
    }
    const account = connected ?? linked;
    if (!this.socialProfile || this.socialProfile.accountId !== account) {
      void profileOf(account).then((found) => {
        this.socialProfile = found;
        this.rerender();
      });
      if (this.socialLinked === null) void linkVerified(account, farmAccount).then((ok) => { this.socialLinked = ok; this.rerender(); });
    }
    if (this.friends === null) void this.loadFriends();
    const profile = this.socialProfile;
    const avatar = profile?.avatarUrl ? el("img", { class: "social-avatar", src: profile.avatarUrl, alt: "" }) : el("div", { class: "social-avatar blank" }, "@");
    const status = this.socialLinked
      ? el("span", { class: "chip ok" }, "Linked both ways ✓")
      : linked === account
        ? el("button", { class: "btn small leaf", onclick: () => void this.linkOnProfile() }, "Show this farm on my near.social profile")
        : el("button", { class: "btn small leaf", onclick: () => void this.connectNearSocial() }, "Link this farm");
    const friends = this.friends;
    return el(
      "div",
      { class: "card social-card" },
      el("h3", {}, "NEAR Social"),
      el(
        "div",
        { class: "row" },
        avatar,
        el(
          "div",
          { class: "grow" },
          el("b", {}, profile?.name ?? account),
          el("div", {}, el("a", { href: socialUrl(account), target: "_blank", rel: "noopener" }, `@${account} ↗`)),
          status,
        ),
      ),
      el("h3", { style: "margin-top:10px" }, "Friends playing Kinlings"),
      friends === null
        ? el("p", { class: "muted" }, "Looking through who you follow...")
        : friends.length === 0
          ? el("p", { class: "muted" }, "Nobody you follow on near.social has a farm here yet. Invite them!")
          : el("div", { class: "friends" }, ...friends.map((friend) => this.friendRow(friend))),
      el(
        "div",
        { class: "row wrap", style: "margin-top:8px" },
        el("button", { class: "btn small plain", onclick: () => this.shareOnSocial("I'm raising mythical creatures in Kinlings, a farming game on NEAR. Come race me for testnet NEAR!") }, "Invite on near.social"),
        el(
          "button",
          {
            class: "btn small plain",
            onclick: async () => {
              await disconnectSocial();
              await this.game.setSocial(null);
              this.socialProfile = null;
              this.socialLinked = null;
              this.friends = null;
              this.rerender();
            },
          },
          "Unlink",
        ),
      ),
    );
  }

  private friendRow(friend: Friend): HTMLElement {
    const face = friend.profile?.avatarUrl ? el("img", { class: "social-avatar small", src: friend.profile.avatarUrl, alt: "" }) : el("div", { class: "social-avatar small blank" }, "@");
    return el(
      "div",
      { class: "row friend" },
      face,
      el("div", { class: "grow" }, el("b", {}, friend.profile?.name ?? friend.social), el("small", { class: "muted" }, ` @${friend.social}${friend.verified ? " ✓" : ""}`)),
      el(
        "button",
        {
          class: "btn small plain",
          onclick: () => {
            this.closeSheet();
            this.scene.goToLot(friend.farm);
          },
        },
        "Visit",
      ),
    );
  }

  private async connectNearSocial() {
    try {
      const account = await connectSocial();
      if (!account) {
        this.ticker("No NEAR Social account was connected.");
        return;
      }
      await this.game.setSocial(account);
      this.socialProfile = null;
      this.socialLinked = null;
      this.friends = null;
      this.banner(`Linked to @${account}`, "Now show this farm on your profile, so friends know it's you");
      this.rerender();
    } catch (error) {
      console.warn(error);
      this.banner("NEAR Social didn't connect", "You can try again any time");
    }
  }

  private async linkOnProfile() {
    this.banner("Check your wallet to approve", "This only adds your farm to your near.social profile");
    const done = await linkFarmOnSocial(this.game.signer.accountId).catch(() => false);
    this.socialLinked = done;
    this.banner(done ? "Linked both ways ✓" : "Your profile didn't show the link yet", done ? "Friends will see your farm is really yours" : "It can take a moment. Check again soon.");
    this.rerender();
  }

  private async loadFriends() {
    const account = socialAccount() ?? this.game.me?.social;
    if (!account || this.loadingFriends) return;
    this.loadingFriends = true;
    try {
      const following = await followingOf(account);
      const farms = await this.game.farmsOfSocials(following);
      const found: Friend[] = [];
      following.forEach((social, index) => {
        const farm = farms[index];
        if (farm) found.push({ social, farm: farm[0], account: farm[1], profile: null, verified: false });
      });
      await Promise.all(
        found.map(async (friend) => {
          friend.profile = await profileOf(friend.social);
          friend.verified = friend.profile?.links?.kinlings === friend.account;
        }),
      );
      this.friends = found;
    } catch (error) {
      console.warn("Could not find friends on NEAR Social", error);
      this.friends = [];
    } finally {
      this.loadingFriends = false;
      this.rerender();
    }
  }

  /** Lets the player write a post, and posts it only when they press Post. */
  shareOnSocial(text: string) {
    const box = el("textarea", { rows: 4, maxlength: 1000, style: "width:100%" }) as HTMLTextAreaElement;
    box.value = `${text}\n${location.origin}${location.pathname}`;
    const status = el("div", { class: "muted" }, socialAccount() ? `Posting as @${socialAccount()}` : "You'll pick your NEAR account first.");
    this.modal(
      el("h2", {}, "Share on near.social"),
      box,
      status,
      el(
        "button",
        {
          class: "btn sky",
          onclick: async () => {
            status.textContent = "Check your wallet to approve...";
            const posted = await postOnSocial(box.value.trim()).catch(() => false);
            this.closeModal();
            this.banner(posted ? "Posted on near.social" : "That post didn't show up", posted ? "Your friends can see it now" : "Your wallet may not have sent it");
          },
        },
        "Post",
      ),
      this.closeButton(),
    );
  }

  // ----- Almanac -------------------------------------------------------------

  private almanacTab: "species" | "leaders" | "economy" | "how" = "species";

  openAlmanac() {
    void this.loadSpecies().then(() => this.rerender());
    this.openSheet("Almanac", (body) => {
      const tab = (id: typeof this.almanacTab, label: string) =>
        el("button", { class: `tab ${this.almanacTab === id ? "on" : ""}`, onclick: () => { this.almanacTab = id; this.rerender(); } }, label);
      const tabs = el("div", { class: "tabs" }, tab("species", "Species"), tab("leaders", "Top farmers"), tab("economy", "The economy"), tab("how", "How it works"));
      const content =
        this.almanacTab === "species" ? this.speciesView() : this.almanacTab === "leaders" ? this.leadersView() : this.almanacTab === "economy" ? this.economyView() : this.howView();
      body.replaceChildren(tabs, ...content);
    }, false);
  }

  private speciesView(): HTMLElement[] {
    const found = [...this.species.entries()];
    const row = ([id, info]: [number, { name: string; finder: number; named: boolean; count: number; finderName: string }]) => {
      const parts = [Math.floor(id / 150), Math.floor((id % 150) / 25), Math.floor((id % 25) / 5), id % 5];
      const look: Look = { head: parts[0], horn: parts[1], wing: parts[2], tail: parts[3], pattern: 0, eyes: 0, main: COLOURS[(id * 7) % 16][1], accent: COLOURS[(id * 11 + 4) % 16][1], shiny: false, seed: id + 1, speed: 40, stamina: 40, luck: 40 };
      const kin = { xp: 40, look } as Kin;
      const finder = info.finder === 0 ? "Known since the valley opened" : `Found by ${info.finderName}`;
      return el("div", { class: "card row" }, portrait(kin, 64, 5), el("div", { class: "grow" }, el("b", {}, info.named ? info.name : "Not named yet"), el("div", { class: "muted" }, `${finder}. Hatched ${info.count} times.`)));
    };
    return [
      el("p", {}, `${found.length} of 750 kinds of Kinling have been seen. Cross two different ones and you may be the first to hatch something new. The first to find it names it, and earns a little every time anyone hatches another.`),
      ...found.map(row),
    ];
  }

  private leadersView(): HTMLElement[] {
    const world = this.game.view!;
    return world.top.map((leader, place) =>
      el(
        "div",
        { class: "card row spread" },
        el("div", {}, el("b", {}, `${place + 1}. ${leader.name}`), leader.elder ? el("span", { class: "chip" }, "Elder") : null, el("div", { class: "muted" }, rankTitle(leader.level))),
        el("span", {}, `${leader.xp} xp`),
      ),
    );
  }

  private economyView(): HTMLElement[] {
    const world = this.game.view!;
    return [
      el(
        "div",
        { class: "card" },
        el("h3", {}, "Every acorn is accounted for"),
        el("p", {}, `There are exactly ${K.total.toLocaleString()} acorns, forever. The Old Oak holds ${world.oak.toLocaleString()} of them. The rest are in pockets, shop tills and Kinlings' purses.`),
        el("p", { class: "muted" }, "When the Oak runs low, its gifts shrink on their own, so nothing needs patching."),
      ),
      el(
        "div",
        { class: "card" },
        el("h3", {}, "Watch a week go by"),
        el("p", {}, "Simulate a whole week of trading in one minute, starting from the real shops as they are now."),
        el("button", { class: "btn", onclick: () => { this.closeSheet(); fastForward($("modal-layer"), world); } }, "Fast-forward a week"),
      ),
    ];
  }

  private howView(): HTMLElement[] {
    const kin = this.game.myKins()[0];
    const account = kin?.account ?? `ember.${VALLEY}`;
    return [
      el(
        "div",
        { class: "card" },
        el("h3", {}, "There's more to your Kinling than it looks"),
        el("p", {}, "Every Kinling is a real account on NEAR, and its babies are sub-accounts of it. The family tree isn't kept in a database: it is the account name."),
        el("p", { class: "mono" }, account),
        el("p", {}, "Your items are real too. One contract holds every acorn, crop, egg and Kinling as NEP-245 tokens, and nobody can take them from you."),
        el("p", {}, "Your farm has its own NEAR account, with a key in your browser that can only play this game, so everyday moves need no pop-ups or fees from you."),
        el(
          "p",
          {},
          "NEAR is what the valley's real money runs on. Challenge races are paid for in testnet NEAR and won in it. Hiring a champion costs NEAR and pays its owner. Stalls can sell eggs, Kinlings and rare foods for NEAR. Connect a testnet wallet and every prize, fee and sale lands in it.",
        ),
        el("p", {}, "Races are checked like everything else: when you finish, the contract plays back every move you made and pays only what it saw."),
      ),
      el(
        "div",
        { class: "card" },
        el("h3", {}, "The Elders"),
        el("p", {}, "Farms marked ELDER are run by the computer, so the valley is never empty and races always have a field. Everyone else you see is a real person."),
      ),
    ];
  }

  // ----- Family tree ----------------------------------------------------------

  private async openFamily(kin: Kin) {
    this.closePopover();
    const lookup = new Map<number, Kin>([[kin.id, kin]]);
    const fetchIds = async (ids: number[]) => {
      const wanted = ids.filter((id) => id !== 0 && !lookup.has(id));
      if (wanted.length === 0) return;
      const rows = await view<any[]>("kins_by_id", { ids: wanted });
      for (const row of rows) {
        const parsed = parseKin(row);
        lookup.set(parsed.id, parsed);
      }
    };
    await fetchIds([kin.mother, kin.father, ...kin.children]);
    const parents = [lookup.get(kin.mother), lookup.get(kin.father)].filter((k): k is Kin => Boolean(k));
    await fetchIds(parents.flatMap((p) => [p.mother, p.father]));
    const grandparents = parents.flatMap((p) => [lookup.get(p.mother), lookup.get(p.father)]).filter((k): k is Kin => Boolean(k));
    const children = kin.children.map((id) => lookup.get(id)).filter((k): k is Kin => Boolean(k));

    const node = (member: Kin, highlight = false) =>
      el(
        "div",
        { style: `display:inline-flex;flex-direction:column;align-items:center;margin:2px 6px;${highlight ? "transform:scale(1.08)" : ""}` },
        portrait(member, highlight ? 120 : 84),
        el("b", { style: "font-size:15px" }, capitalise(member.name)),
      );
    const rowOf = (label: string, members: Kin[]) =>
      members.length ? el("div", { style: "margin-bottom:6px" }, el("div", { class: "muted" }, label), el("div", {}, ...members.map((member) => node(member)))) : null;

    this.modal(
      el("h2", {}, `${capitalise(kin.name)}'s family`),
      rowOf("Grandparents", grandparents),
      rowOf("Parents", parents),
      el("div", { style: "margin:4px 0 8px" }, node(kin, true)),
      rowOf(kin.childCount > children.length ? `Children (first ${children.length} of ${kin.childCount})` : "Children", children),
      el("p", {}, children.length || parents.length ? "When a Kinling earns, a slice climbs up to its parents and grandparents. Every generation is stronger than the last." : "A founder of a brand new family line."),
      this.powerChips(kin),
      el("p", { class: "mono" }, kin.account),
      this.closeButton(),
    );
  }

  // ----- Hatching -------------------------------------------------------------

  hatchFlow(egg: Egg) {
    this.closeSheet();
    const ideas = [...NAME_IDEAS].sort(() => Math.random() - 0.5).slice(0, 5);
    const input = el("input", { maxlength: 12, placeholder: "a name", autocomplete: "off", spellcheck: "false" }) as HTMLInputElement;
    const error = el("div", { class: "error" });
    const motherAccount = this.game.view!.kins.get(egg.mother)?.account ?? VALLEY;

    const submit = async () => {
      const name = input.value.trim().toLowerCase();
      if (!/^[a-z]{2,12}$/.test(name)) {
        error.textContent = "Use 2 to 12 letters, a to z.";
        return;
      }
      const full = `${name}.${motherAccount}`;
      error.textContent = "Checking the name...";
      try {
        if (full.length <= 64 && (await accountExists(full))) {
          error.textContent = "Someone in this family already has that name.";
          return;
        }
      } catch {
        // If the check fails, the hatch itself will catch a clash.
      }
      this.closeModal();
      void this.runHatch(egg, name);
    };

    this.modal(
      el("h2", {}, "Something's moving in there"),
      el("p", {}, "What will you call it?"),
      input,
      el("div", { class: "suggestions" }, ...ideas.map((idea) => el("button", { class: "btn small plain", onclick: () => { input.value = idea; } }, capitalise(idea)))),
      error,
      el("button", { class: "btn big leaf", onclick: submit }, "Hatch!"),
      el("p", { class: "muted" }, "Pick carefully. A name stays with a Kinling forever."),
    );
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") void submit();
    });
    input.focus();
  }

  private async runHatch(egg: Egg, name: string) {
    const before = new Set(this.game.myKins().map((k) => k.id));
    this.scene.wobbleEgg(egg.id, 6);
    sound.crack();
    const crackTimer = window.setInterval(() => {
      const crack = Math.min(1, (performance.now() - started) / 3000);
      this.scene.setCrack(egg.id, crack);
      this.scene.wobbleEgg(egg.id, 3);
      if (Math.random() < 0.3) sound.crack();
    }, 180);
    const started = performance.now();

    let outcome;
    try {
      outcome = await this.game.hatch(egg.id, name);
    } catch (error) {
      window.clearInterval(crackTimer);
      this.modal(el("h2", {}, "The egg settled down"), el("p", {}, "Something went wrong reaching the valley. Tap your egg to try again."), this.closeButton());
      console.warn(error);
      return;
    }
    window.clearInterval(crackTimer);
    this.scene.setCrack(egg.id, 0);

    if (!outcome.ok || outcome.value === false) {
      this.modal(el("h2", {}, "It needs a different name"), el("p", {}, "Someone took that name just now. Tap your egg to pick another."), this.closeButton());
      return;
    }
    sound.hatch();
    await this.loadSpecies();
    await this.game.refresh();
    const born = this.game.myKins().find((k) => !before.has(k.id));
    if (born) this.reveal(born);
    this.scene.goToLot(this.game.view!.me);
    this.advanceCoach(1);
  }

  private reveal(kin: Kin) {
    const canvas = el("canvas", { style: "width:340px;height:300px" }) as HTMLCanvasElement;
    const ratio = Math.min(devicePixelRatio || 1, 2);
    canvas.width = 340 * ratio;
    canvas.height = 300 * ratio;
    const viewer = createKinViewer(canvas, kin.look, { level: 3, generation: kin.generation });
    viewer.setJoy(1);
    window.setTimeout(() => viewer.setJoy(0), 2_000);

    const species = speciesNumber(kin.look);
    const info = this.species.get(species);
    const mine = this.game.view!.me;
    const isNew = info && info.finder === mine + 1 && !info.named;
    const look = kin.look;
    const traits = [HEADS[look.head], HORNS[look.horn], WINGS[look.wing], TAILS[look.tail], PATTERNS[look.pattern]].filter((t) => !t.startsWith("No") && t !== "Plain");

    const close = () => {
      viewer.stop();
      this.closeModal();
    };

    if (isNew) {
      sound.fanfare();
      const input = el("input", { maxlength: 20, placeholder: "name this species" }) as HTMLInputElement;
      this.modal(
        el("h2", {}, "Nobody has ever seen one of these"),
        canvas,
        el("p", {}, `You are the first in the valley to hatch this kind of Kinling. Give the species its name, for everyone, forever.`),
        input,
        el(
          "button",
          {
            class: "btn big",
            onclick: async () => {
              const name = input.value.trim();
              if (name.length < 3) return;
              viewer.stop();
              this.closeModal();
              await this.game.call("name_species", { species, name }, 12);
              await this.loadSpecies();
              this.banner(`The ${name}`, "Named by you, for everyone");
            },
          },
          "Name it",
        ),
      );
      return;
    }

    this.modal(
      el("h2", {}, `Meet ${capitalise(kin.name)}!`),
      canvas,
      el("p", {}, el("b", {}, `A ${this.speciesNameOf(kin)}`), look.shiny ? " and it's shiny!" : ""),
      el("div", {}, ...traits.map((t) => el("span", { class: "chip" }, t))),
      this.powerChips(kin),
      el("p", {}, kin.generation > 0 ? `Generation ${kin.generation}: it has every power its parents had, and it's stronger than both.` : "It can race right away. Tap the Dash to try."),
      el("button", { class: "btn big leaf", onclick: close }, "Hello!"),
    );
  }

  // ----- Modals ----------------------------------------------------------------

  modal(...children: (Node | string | null)[]) {
    const scrim = el("div", { class: "scrim" }, el("div", { class: "modal" }, ...children));
    $("modal-layer").replaceChildren(scrim);
  }

  closeModal() {
    $("modal-layer").replaceChildren();
  }

  private closeButton() {
    return el("button", { class: "btn", onclick: () => this.closeModal() }, "Close");
  }

  // ----- Coach ------------------------------------------------------------------

  /** Steps happen in order, except that a player may skip ahead when allowed. */
  private advanceCoach(reached: number, mayskip = false) {
    if (reached === this.coachStep + 1 || (mayskip && reached > this.coachStep)) {
      this.coachStep = reached;
      localStorage.setItem("kinlings.coach", String(reached));
      this.renderCoach();
    }
  }

  private renderCoach() {
    const me = this.game.me;
    const box = $("coach");
    if (!me) return;
    let text = "";
    switch (this.coachStep) {
      case 0:
        text = me.eggs.length ? "Your egg is ready. Tap it!" : "";
        break;
      case 1:
        text = "Tap an empty plot to plant something.";
        break;
      case 2:
        text = "Tap a growing crop to water it. Neighbours can help too.";
        break;
      case 3:
        text = "When a crop sparkles, tap it to pick it.";
        break;
      case 4:
        text = "Tap your Kinling to feed it.";
        break;
      case 5:
        text = "Now open the Dash and race your Kinling!";
        break;
      case 6:
        text = "Open the Market and see what people pay today.";
        break;
      case 7:
        text = "Use the arrows to walk next door and help a neighbour.";
        setTimeout(() => this.advanceCoach(8), 14_000);
        break;
    }
    if (box.dataset.text === text) return;
    box.dataset.text = text;
    box.replaceChildren(...(text ? [el("div", { class: "coach-card" }, text)] : []));
  }
}

function formatTime(seconds: number): string {
  if (seconds >= 60) return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${seconds}s`;
}

export { LOT, POWERS, base58Encode };
