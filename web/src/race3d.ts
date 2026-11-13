// The Valley Dash on screen: lining up, the countdown, your controls, the
// on-screen dials, and handing the finished race to the contract. Everything
// that decides who wins is in the Rust engine behind `DashSim`.

import { D, K } from "./core.ts";
import { DashSim, EVENT, MOVE, ghostTrack, type Frame, type RaceEvent, type RaceOutcome } from "./dash.ts";
import { el, itemIcon, portrait } from "./dom.ts";
import { type ChallengeResult, type Game, type RaceResult, type RaceTicket } from "./game.ts";
import { powersIn, type PowerInfo } from "./powers.ts";
import { RaceStage, type StageGhost } from "./race-stage.ts";
import { playMusic, playStinger, sound } from "./sound.ts";
import type { Scene } from "./three/valley3d.ts";
import type { Ui } from "./ui.ts";
import { DID_NOT_FINISH, itemName, nearText, standings, type Challenge, type Kin } from "./world.ts";

export interface RaceOptions {
  game: Game;
  kin: Kin;
  ui: Ui;
  scene: Scene;
  layer: HTMLElement;
  /** Run this challenge, for NEAR, instead of a practice race. */
  challenge?: Challenge;
  /** Farms whose Kinlings should line up first: friends from NEAR Social. */
  friends?: number[];
}

type Next = "again" | "challenges" | "valley";

const TICK_MS = 1000 / 30;
const COUNT_MS = 850;
const ORDINALS = ["1st", "2nd", "3rd", "4th", "5th", "6th"];
const FULL_BREATH = 10_000;

const capital = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);

/** Runs one race from the moment the player asks until they leave it. */
export async function runRace(options: RaceOptions): Promise<void> {
  const { game, kin, scene, layer, challenge } = options;
  const shell = new Shell(layer, kin, challenge);
  scene.paused = true;
  playMusic("race");

  let ticket: RaceTicket;
  let ghosts: StageGhost[] = [];
  try {
    if (challenge) {
      // Ghosts first: replaying them uses the same rules engine the live race will.
      ghosts = await loadGhosts(game, challenge).catch((error) => {
        console.warn("No ghosts this time", error);
        return [];
      });
      ticket = await game.challengeRun(challenge.id);
    } else {
      ticket = await game.raceStart(kin.id, options.friends ?? []);
    }
  } catch (error) {
    console.warn(error);
    const text = error instanceof Error && /already run/.test(error.message) ? "You've already run this challenge. Each runner gets one go." : "The race couldn't start. Please try again in a moment.";
    await shell.problem(text);
    leave(options, shell);
    return;
  }

  const race = new LiveRace(options, shell, ticket, ghosts);
  const next = await race.play();
  race.dispose();
  leave(options, shell);
  if (next === "again") void options.ui.startRace(kin);
  if (next === "challenges") options.ui.openRace("challenges");
}

/** The earlier runs of a challenge, ready to race against. */
async function loadGhosts(game: Game, challenge: Challenge): Promise<StageGhost[]> {
  const data = await game.challengeGhosts(challenge.id);
  if (!data) return [];
  const mine = game.view?.me;
  const runs = data.ghosts.filter((ghost) => ghost.playerIndex !== mine).slice(0, 5);
  const entryOf = (index: number) => challenge.entries.find((entry) => entry.playerIndex === index);
  const kins = await game.kinsById(runs.map((ghost) => entryOf(ghost.playerIndex)?.kinId ?? 0).filter((id) => id > 0));
  return runs.flatMap((ghost) => {
    const entry = entryOf(ghost.playerIndex);
    const kin = entry ? kins.get(entry.kinId) : undefined;
    if (!kin) return [];
    const level = parseInt(ghost.entrant.slice(12, 14), 16) || 1;
    const time = ghost.ticks === DID_NOT_FINISH ? "didn't finish" : `${(ghost.ticks / D.ticks).toFixed(1)} s`;
    return [{ look: kin.look, level, generation: kin.generation, name: `${ghost.name}'s ghost · ${time}`, track: ghostTrack(data.seed, ghost.entrant, data.field, data.ease, ghost.moves) }];
  });
}

function leave(options: RaceOptions, shell: Shell) {
  shell.remove();
  options.scene.paused = false;
  playMusic("valley");
}

/** The page furniture of a race: everything except the 3D view itself. */
class Shell {
  readonly root: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  readonly hud: HTMLElement;
  readonly centre: HTMLElement;
  readonly toasts: HTMLElement;

  private layer: HTMLElement;

  constructor(layer: HTMLElement, kin: Kin, challenge?: Challenge) {
    this.layer = layer;
    this.canvas = el("canvas", { class: "race-canvas" }) as HTMLCanvasElement;
    this.hud = el("div", { class: "race-hud" });
    this.centre = el("div", { class: "race-centre" }, this.lineUp(kin, challenge));
    this.toasts = el("div", { class: "race-toasts" });
    this.root = el("div", { class: "race-root" }, this.canvas, this.hud, this.toasts, this.centre);
    layer.replaceChildren(this.root);
  }

  private lineUp(kin: Kin, challenge?: Challenge): HTMLElement {
    const title = challenge ? `${capital(kin.name)} is lining up for ${challenge.hostName}'s challenge` : `${capital(kin.name)} is heading to the start`;
    const sub = challenge ? "Same course and field for every runner. Fastest time takes the pot." : "Finding rivals...";
    return el("div", { class: "race-lining" }, portrait(kin, 150), el("div", { class: "race-lining-title" }, title), el("div", { class: "race-lining-sub" }, sub));
  }

  /** Shows a message and waits for the player to dismiss it. */
  problem(text: string): Promise<void> {
    return new Promise((resolve) => {
      this.centre.replaceChildren(
        el(
          "div",
          { class: "race-card" },
          el("h2", {}, "Oh dear"),
          el("p", {}, text),
          el("button", { class: "btn big", onclick: () => resolve() }, "Back to the valley"),
        ),
      );
    });
  }

  toast(text: string, kind = "") {
    const line = el("div", { class: `race-toast ${kind}` }, text);
    this.toasts.append(line);
    while (this.toasts.children.length > 3) this.toasts.firstChild?.remove();
    window.setTimeout(() => line.remove(), 1_700);
  }

  remove() {
    this.layer.replaceChildren();
  }
}

class LiveRace {
  private sim: DashSim;
  private stage: RaceStage;
  private previous: Frame;
  private current: Frame;
  private queue: number[] = [];
  private accumulator = 0;
  private last = 0;
  private raf = 0;
  private phase: "intro" | "count" | "racing" | "done" = "intro";
  private phaseStart = 0;
  private lastCount = -1;
  private resolve: (next: Next) => void = () => undefined;
  private challenge: Challenge | null;
  private timerNode: HTMLElement | null = null;
  private rested: boolean;
  private myPowers: PowerInfo[];
  private buttons = new Map<number, { node: HTMLElement; shade: HTMLElement }>();
  private maxCooldown = new Map<number, number>();
  private lastHud = 0;
  private held = { sprint: false, brake: false };
  private names: string[];
  private placeNode!: HTMLElement;
  private breathNode!: HTMLElement;
  private speedNode!: HTMLElement;
  private dots: HTMLElement[] = [];
  private swipe: { x: number; y: number; id: number; used: boolean } | null = null;
  private lastFootstep = 0;
  private lastCleared = 0;
  private finishedAt = 0;
  private cleanups: (() => void)[] = [];
  private rivals: Kin[];
  private owners: { name: string; elder: boolean }[];
  private options: RaceOptions;
  private shell: Shell;

  constructor(options: RaceOptions, shell: Shell, ticket: RaceTicket, ghosts: StageGhost[] = []) {
    this.options = options;
    this.shell = shell;
    this.challenge = options.challenge ?? null;
    this.rested = ticket.rested;
    this.sim = new DashSim(ticket.seed, ticket.entrants, ticket.ease);
    this.current = this.sim.frame();
    this.previous = this.current;
    this.myPowers = powersIn(options.kin.powers);
    this.rivals = ticket.rivals;
    this.owners = ticket.owners;
    this.names = [capital(options.kin.name), ...ticket.rivals.map((rival) => capital(rival.name))];
    this.stage = new RaceStage(shell.canvas, this.sim.course, [
      { look: options.kin.look, level: levelFor(options.kin), generation: options.kin.generation, name: "", you: true, powers: options.kin.powers },
      ...ticket.rivals.map((rival, index) => ({
        look: rival.look,
        level: levelFor(rival),
        generation: rival.generation,
        name: `${capital(rival.name)}${ticket.owners[index]?.elder ? " (Elder)" : ""}`,
        you: false,
        powers: rival.powers,
      })),
    ]);
    this.stage.addGhosts(ghosts);
    this.buildHud();
    this.bindControls();
    Object.assign(window, { kinlingsRace: this });
  }

  play(): Promise<Next> {
    return new Promise((resolve) => {
      this.resolve = resolve;
      // A frame behind the "heading to the start" card, so the race doesn't stutter.
      requestAnimationFrame(async () => {
        await this.stage.warmUp(this.current);
        this.shell.centre.replaceChildren();
        this.phaseStart = performance.now();
        this.last = this.phaseStart;
        this.raf = requestAnimationFrame((time) => this.frame(time));
      });
    });
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    for (const cleanup of this.cleanups) cleanup();
    this.stage.dispose();
  }

  // ----- Controls -------------------------------------------------------

  private press(code: number) {
    if (this.phase === "racing") this.queue.push(code);
  }

  private setHeld(which: "sprint" | "brake", down: boolean) {
    if (this.held[which] === down) return;
    this.held[which] = down;
    if (which === "sprint") this.press(down ? MOVE.SPRINT_ON : MOVE.SPRINT_OFF);
    else this.press(down ? MOVE.BRAKE_ON : MOVE.BRAKE_OFF);
  }

  private usePower(power: PowerInfo) {
    const runner = this.current.runners[0];
    if (runner.cooldown[power.id] > 0 || this.phase !== "racing") return;
    this.press(MOVE.POWER + power.id);
  }

  private bindControls() {
    const key = (event: KeyboardEvent, down: boolean) => {
      const code = event.code;
      let handled = true;
      if (code === "ArrowUp" || code === "KeyW") this.setHeld("sprint", down);
      else if (code === "ArrowDown" || code === "KeyS") this.setHeld("brake", down);
      else if (!down) handled = code === "Space" || code.startsWith("Arrow");
      else if (event.repeat) handled = true;
      else if (code === "ArrowLeft" || code === "KeyA") this.press(MOVE.LEFT);
      else if (code === "ArrowRight" || code === "KeyD") this.press(MOVE.RIGHT);
      else if (code === "Space") this.press(MOVE.JUMP);
      else if (/^Digit[1-8]$/.test(code)) {
        const power = this.myPowers[Number(code.slice(5)) - 1];
        if (power) this.usePower(power);
      } else handled = false;
      if (handled) event.preventDefault();
    };
    const down = (event: KeyboardEvent) => key(event, true);
    const up = (event: KeyboardEvent) => key(event, false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    this.cleanups.push(() => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    });

    // Swipes on the track: left and right change lane, up jumps.
    const canvas = this.shell.canvas;
    const start = (event: PointerEvent) => {
      this.swipe = { x: event.clientX, y: event.clientY, id: event.pointerId, used: false };
    };
    const move = (event: PointerEvent) => {
      const swipe = this.swipe;
      if (!swipe || swipe.id !== event.pointerId || swipe.used) return;
      const dx = event.clientX - swipe.x;
      const dy = event.clientY - swipe.y;
      if (Math.abs(dx) > 26 && Math.abs(dx) > Math.abs(dy)) {
        swipe.used = true;
        this.press(dx < 0 ? MOVE.LEFT : MOVE.RIGHT);
      } else if (dy < -26) {
        swipe.used = true;
        this.press(MOVE.JUMP);
      }
    };
    const end = () => {
      this.swipe = null;
    };
    canvas.addEventListener("pointerdown", start);
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", end);
    canvas.addEventListener("pointercancel", end);

    // The tab was left: let go of anything held down.
    const blur = () => {
      this.setHeld("sprint", false);
      this.setHeld("brake", false);
    };
    window.addEventListener("blur", blur);
    this.cleanups.push(() => window.removeEventListener("blur", blur));
  }

  private holdButton(label: string, kind: string, which: "sprint" | "brake"): HTMLElement {
    const node = el("button", { class: `race-btn ${kind}` }, label);
    const press = (event: Event) => {
      event.preventDefault();
      this.setHeld(which, true);
      node.classList.add("on");
    };
    const release = (event: Event) => {
      event.preventDefault();
      this.setHeld(which, false);
      node.classList.remove("on");
    };
    node.addEventListener("pointerdown", press);
    node.addEventListener("pointerup", release);
    node.addEventListener("pointerleave", release);
    node.addEventListener("pointercancel", release);
    return node;
  }

  // ----- Heads-up display ------------------------------------------------

  private buildHud() {
    this.placeNode = el("div", { class: "race-place" }, "");
    this.breathNode = el("i", {});
    this.speedNode = el("div", { class: "race-speed" }, "0");
    const track = el("div", { class: "race-track-bar" });
    this.dots = this.names.map((_, index) => {
      const dot = el("span", { class: `race-dot ${index === 0 ? "you" : ""}` });
      track.append(dot);
      return dot;
    });

    const quit = el("button", { class: "round race-quit", title: "Leave the race", onclick: () => this.quit() }, "✕");
    const jump = el("button", { class: "race-btn jump" }, "Jump");
    jump.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      this.press(MOVE.JUMP);
    });
    const left = el("button", { class: "race-btn lane" }, "◀");
    left.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      this.press(MOVE.LEFT);
    });
    const right = el("button", { class: "race-btn lane" }, "▶");
    right.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      this.press(MOVE.RIGHT);
    });

    const powers = el("div", { class: "race-powers" });
    this.myPowers.forEach((power, index) => {
      const shade = el("span", { class: "race-power-shade" });
      const node = el(
        "button",
        { class: "race-power", title: `${power.name}: ${power.text}` },
        power.icon,
        el("small", {}, String(index + 1)),
        shade,
      );
      node.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        this.usePower(power);
      });
      powers.append(node);
      this.buttons.set(power.id, { node, shade });
    });

    if (this.challenge) {
      this.timerNode = el("div", { class: "race-timer" }, "0.0 s");
      const best = standings(this.challenge).find((entry) => entry.ticks > 0 && entry.ticks !== DID_NOT_FINISH);
      if (best) track.title = `Time to beat: ${best.name}, ${(best.ticks / D.ticks).toFixed(1)} s`;
    }
    this.shell.hud.replaceChildren(
      el("div", { class: "race-top" }, this.timerNode ?? this.placeNode, track, quit),
      el(
        "div",
        { class: "race-bottom" },
        el(
          "div",
          { class: "race-left" },
          el("div", { class: "race-breath" }, el("span", {}, "Breath"), el("div", { class: "bar" }, this.breathNode)),
          this.speedNode,
          el("div", { class: "race-row" }, left, right),
          el("div", { class: "race-row" }, this.holdButton("Sprint", "sprint", "sprint"), this.holdButton("Slow", "slow", "brake")),
        ),
        el("div", { class: "race-right" }, powers, jump),
      ),
    );
  }

  private renderHud(now: number) {
    if (now - this.lastHud < 80) return;
    this.lastHud = now;
    const frame = this.current;
    const me = frame.runners[0];
    const order = frame.runners
      .map((runner, index) => ({ index, score: runner.finished ? 1_000_000_000 - runner.finished : runner.pos }))
      .sort((a, b) => b.score - a.score)
      .map((entry) => entry.index);
    const place = order.indexOf(0);
    const text = ORDINALS[place];
    if (this.placeNode.textContent !== text) {
      this.placeNode.textContent = text;
      this.placeNode.classList.remove("pop");
      void this.placeNode.offsetWidth;
      this.placeNode.classList.add("pop");
    }
    if (this.timerNode) this.timerNode.textContent = `${(frame.tick / D.ticks).toFixed(1)} s`;
    this.breathNode.style.width = `${(me.stamina / FULL_BREATH) * 100}%`;
    this.breathNode.className = me.winded ? "winded" : "";
    this.speedNode.textContent = `${Math.round(me.v * 0.108)} km/h`;
    frame.runners.forEach((runner, index) => {
      this.dots[index].style.left = `${Math.max(0, Math.min(100, (runner.pos / D.track) * 100))}%`;
    });
    for (const [id, button] of this.buttons) {
      const cooldown = me.cooldown[id];
      const known = this.maxCooldown.get(id) ?? cooldown;
      const most = Math.max(known, cooldown, 1);
      this.maxCooldown.set(id, cooldown === 0 ? most : most);
      button.shade.style.height = `${(cooldown / most) * 100}%`;
      button.node.classList.toggle("ready", cooldown === 0);
    }
  }

  // ----- The loop --------------------------------------------------------

  private frame(time: number) {
    if (this.phase === "done" && this.finishedAt === -1) return;
    this.raf = requestAnimationFrame((next) => this.frame(next));
    // After a long task the browser can hand us a timestamp from before it.
    const dt = Math.max(0, Math.min(0.1, (time - this.last) / 1000));
    this.last = time;

    if (this.phase === "intro" && time - this.phaseStart > this.stage.introMs) {
      this.phase = "count";
      this.phaseStart = time;
    }
    if (this.phase === "count") {
      const elapsed = time - this.phaseStart;
      const number = 3 - Math.floor(elapsed / COUNT_MS);
      if (number !== this.lastCount) {
        this.lastCount = number;
        if (number > 0) {
          sound.countdown();
          this.shell.centre.replaceChildren(el("div", { class: "race-count" }, String(number)));
        } else {
          sound.go();
          this.shell.centre.replaceChildren(el("div", { class: "race-count go" }, "GO!"));
          this.phase = "racing";
          this.phaseStart = time;
          this.last = time;
          if (this.held.sprint) this.queue.push(MOVE.SPRINT_ON);
          if (this.held.brake) this.queue.push(MOVE.BRAKE_ON);
          window.setTimeout(() => this.shell.centre.replaceChildren(), 650);
        }
      }
    }

    if (this.phase === "racing") {
      this.accumulator += dt * 1000;
      let steps = 0;
      while (this.accumulator >= TICK_MS && steps < 8) {
        this.accumulator -= TICK_MS;
        steps += 1;
        this.tick(time);
        if (this.current.over) {
          this.finish(time);
          break;
        }
      }
    }

    const alpha = this.phase === "racing" ? this.accumulator / TICK_MS : 1;
    this.stage.render(dt, this.previous, this.current, alpha, this.phase);
    this.renderHud(time);
  }

  private tick(time: number) {
    const moves = this.queue.splice(0, 4);
    this.sim.step(moves);
    this.previous = this.current;
    this.current = this.sim.frame();
    for (const event of this.current.events) this.onEvent(event, time);
    const me = this.current.runners[0];
    if (me.y === 0 && me.v > 150 && time - this.lastFootstep > Math.max(120, 300 - me.v * 0.3)) {
      this.lastFootstep = time;
      sound.footstep(Math.min(1, me.v / 800));
    }
  }

  private onEvent(event: RaceEvent, time: number) {
    this.stage.onEvent(event, this.current);
    const mine = event.a === 0;
    const byMe = event.b === 0;
    const near = Math.abs(this.current.runners[event.a].pos - this.current.runners[0].pos) < 40_000;
    switch (event.kind) {
      case EVENT.JUMP:
        if (mine) sound.jump();
        break;
      case EVENT.LAND:
        if (mine) sound.land();
        break;
      case EVENT.TRIP:
        if (mine) {
          sound.stumble();
          this.shell.toast("Ouch!", "bad");
        }
        break;
      case EVENT.CAST:
        if (mine || near) castSound(event.b);
        break;
      case EVENT.BURNED:
        sound.hit();
        if (mine) this.shell.toast(`${this.names[event.b]} burned you!`, "bad");
        else if (byMe) this.shell.toast(`You burned ${this.names[event.a]}!`, "good");
        break;
      case EVENT.CHILLED:
        if (mine) this.shell.toast(`${this.names[event.b]} froze you!`, "bad");
        else if (byMe) this.shell.toast(`${this.names[event.a]} is chilled!`, "good");
        break;
      case EVENT.ZAPPED:
        sound.hit();
        if (mine) this.shell.toast(`${this.names[event.b]} zapped you!`, "bad");
        else if (byMe) this.shell.toast(`You zapped ${this.names[event.a]}!`, "good");
        break;
      case EVENT.SNARED:
        if (mine) this.shell.toast("Tangled in vines!", "bad");
        else if (byMe) this.shell.toast(`${this.names[event.a]} ran into your vines!`, "good");
        break;
      case EVENT.BLOCKED:
        if (mine) this.shell.toast("Your shield held!", "good");
        break;
      case EVENT.DODGED:
        if (mine) this.shell.toast("Lucky dodge!", "good");
        break;
      case EVENT.BERRY:
        if (mine) {
          sound.berry();
          this.shell.toast("Fresh breath!", "good");
        }
        break;
      case EVENT.ORB:
        if (mine) {
          sound.orb();
          this.shell.toast("Powers recharged!", "good");
        }
        break;
      case EVENT.RAMP:
        if (mine) sound.whoosh();
        break;
      case EVENT.CLEARED:
        if (mine && time - this.lastCleared > 3_000) {
          this.lastCleared = time;
          this.shell.toast("Nice!", "good");
        }
        break;
      case EVENT.FINISH:
        if (event.a !== 0 && near) sound.whoosh();
        break;
    }
  }

  // ----- The end -----------------------------------------------------------

  private finish(time: number) {
    this.phase = "done";
    this.phaseStart = time;
    const outcome = this.sim.outcome();
    const place = outcome.order.indexOf(0);
    this.shell.hud.replaceChildren();
    playMusic("none");
    const moves = [...this.sim.moves()];
    if (this.challenge) {
      playStinger(outcome.finished ? "victory" : "defeat");
      const text = outcome.finished ? `${(outcome.ticks / D.ticks).toFixed(1)} s!` : "Time's up!";
      this.shell.centre.replaceChildren(el("div", { class: "race-count go" }, text));
      window.setTimeout(() => this.showChallengeResult(outcome, moves), 1_700);
      return;
    }
    playStinger(place === 0 ? "victory" : place < 3 ? "victory" : "defeat");
    this.shell.centre.replaceChildren(el("div", { class: `race-count ${place === 0 ? "go" : ""}` }, place === 0 ? "You won!" : `${ORDINALS[place]}!`));
    window.setTimeout(() => this.showResult(outcome, moves), 1_700);
  }

  /** A challenge run: the time is what counts, against everyone else's. */
  private showChallengeResult(outcome: RaceOutcome, moves: number[]) {
    const challenge = this.challenge!;
    const status = el("div", { class: "race-purse" }, "Handing your run in to NEAR, where it is checked move by move...");
    const table = el("div", { class: "race-ranks" });
    const proof = el("div", { class: "race-proof" });
    const standingsButton = el("button", { class: "btn big berry", onclick: () => this.leave("challenges") }, "See the challenge") as HTMLButtonElement;
    const back = el("button", { class: "btn big plain", onclick: () => this.leave("valley") }, "Back to the valley");
    standingsButton.disabled = true;
    const time = outcome.finished ? `${(outcome.ticks / D.ticks).toFixed(1)} seconds` : "didn't reach the line in time";
    this.shell.centre.replaceChildren(
      el(
        "div",
        { class: "race-card result" },
        el("h2", {}, `${this.names[0]}: ${time}`),
        el("div", { class: "muted" }, `${challenge.hostName}'s challenge · ${nearText(challenge.feeMilli)} NEAR to enter · ${challenge.seats} seats`),
        el(
          "div",
          { class: "race-stats" },
          el("span", {}, `${outcome.cleared} cleared`),
          el("span", {}, `${outcome.trips} trips`),
          el("span", {}, `${outcome.landed} hits landed`),
        ),
        status,
        table,
        proof,
        el("div", { class: "race-actions" }, standingsButton, back),
      ),
    );
    void this.handInChallenge(moves, status, table, proof, standingsButton);
  }

  private async handInChallenge(moves: number[], status: HTMLElement, table: HTMLElement, proof: HTMLElement, button: HTMLButtonElement) {
    const challenge = this.challenge!;
    let result: ChallengeResult | null = null;
    let lastError: unknown;
    for (let attempt = 0; attempt < 3 && !result; attempt++) {
      try {
        result = await this.options.game.challengeFinish(challenge.id, moves);
      } catch (error) {
        lastError = error;
        if (error instanceof Error && /Smart contract panicked|expired|no run/i.test(error.message)) break;
        await new Promise((resolve) => setTimeout(resolve, 1_200));
      }
    }
    button.disabled = false;
    if (!result) {
      console.warn(lastError);
      status.replaceChildren("The valley couldn't check this run, so it doesn't count. Sorry!");
      return;
    }
    proof.replaceChildren(
      el("a", { href: `https://testnet.nearblocks.io/txns/${result.hash}`, target: "_blank", rel: "noopener" }, "Checked move by move on NEAR ↗"),
      el(
        "button",
        {
          class: "btn small plain",
          onclick: () =>
            this.options.ui.shareOnSocial(
              result!.ticks > 0
                ? `I ran ${challenge.hostName}'s Kinlings challenge in ${(result!.ticks / D.ticks).toFixed(1)} s. Think you're faster? ${nearText(challenge.feeMilli)} testnet NEAR to enter, fastest takes the pot.`
                : `I'm in ${challenge.hostName}'s Kinlings challenge for testnet NEAR. Fastest time takes the pot!`,
            ),
        },
        "Share on near.social",
      ),
    );
    if (result.prizeMicro > 0) {
      sound.fanfare();
      status.replaceChildren(el("div", { class: "race-prize near" }, `You won ${nearText(result.prizeMicro / 1000)} testnet NEAR! It's on its way to your wallet.`));
    } else if (result.handedIn === challenge.seats || result.joined === challenge.seats && result.handedIn === result.joined) {
      status.replaceChildren(el("div", { class: "race-noprize" }, "Everyone has run, and the prizes have gone out."));
    } else {
      const waiting = result.joined - result.handedIn;
      const free = challenge.seats - result.joined;
      const parts = [`${ORDINALS[result.place - 1] ?? `#${result.place}`} of ${result.handedIn} so far.`];
      if (waiting > 0) parts.push(`${waiting} still to run.`);
      if (free > 0) parts.push(`${free} seat${free === 1 ? "" : "s"} free.`);
      parts.push("It pays out when every seat has run, or when it closes.");
      status.replaceChildren(el("div", { class: "race-noprize" }, parts.join(" ")));
    }
    try {
      const fresh = (await this.options.game.challenges()).list.find((entry) => entry.id === challenge.id);
      if (fresh) table.replaceChildren(...standingsRows(fresh, this.options.game.view?.me ?? -1));
    } catch (error) {
      console.warn(error);
    }
  }

  private showResult(outcome: RaceOutcome, moves: number[]) {
    const place = outcome.order.indexOf(0);
    const purse = el("div", { class: "race-purse" }, "Checking your race on NEAR...");
    const proof = el("div", { class: "race-proof" });

    const row = (racer: number, position: number) => {
      const kin = racer === 0 ? this.options.kin : this.rivals[racer - 1];
      const owner = racer === 0 ? "You" : this.owners[racer - 1]?.name ?? "";
      return el(
        "div",
        { class: `race-rank ${racer === 0 ? "you" : ""}` },
        el("b", {}, ORDINALS[position]),
        portrait(kin, 52),
        el("div", { class: "grow" }, el("div", {}, capital(kin.name)), el("small", {}, owner)),
      );
    };

    const again = el("button", { class: "btn big berry", onclick: () => this.leave("again") }, "Race again (free)") as HTMLButtonElement;
    const back = el("button", { class: "btn big plain", onclick: () => this.leave("valley") }, "Back to the valley");
    again.disabled = true;

    this.shell.centre.replaceChildren(
      el(
        "div",
        { class: "race-card result" },
        el("h2", {}, place === 0 ? `${this.names[0]} won!` : `${this.names[0]} came ${ORDINALS[place]}`),
        el("div", { class: "race-ranks" }, ...outcome.order.map(row)),
        el(
          "div",
          { class: "race-stats" },
          el("span", {}, `${(outcome.ticks / D.ticks).toFixed(1)} s`),
          el("span", {}, `${outcome.cleared} cleared`),
          el("span", {}, `${outcome.trips} trips`),
          el("span", {}, `${outcome.landed} hits landed`),
        ),
        purse,
        proof,
        el("div", { class: "race-actions" }, again, back),
      ),
    );

    void this.handIn(moves, outcome, purse, proof, again);
  }

  private async handIn(moves: number[], outcome: RaceOutcome, purse: HTMLElement, proof: HTMLElement, again: HTMLButtonElement) {
    let result: RaceResult | null = null;
    let lastError: unknown;
    for (let attempt = 0; attempt < 3 && !result; attempt++) {
      try {
        result = await this.options.game.raceFinish(moves);
      } catch (error) {
        lastError = error;
        // A rejection from the contract won't change on a retry.
        if (error instanceof Error && /Smart contract panicked|No race to finish|expired/.test(error.message)) break;
        await new Promise((resolve) => setTimeout(resolve, 1_200));
      }
    }
    again.disabled = false;
    if (!result) {
      console.warn(lastError);
      purse.replaceChildren("The valley couldn't check this race, so nothing was paid.");
      return;
    }
    const agrees = JSON.stringify(result.order) === JSON.stringify(outcome.order);
    if (!agrees) console.warn("The contract saw a different race", result.order, outcome.order);
    const lines: (HTMLElement | string)[] = [];
    if (result.acorns > 0) lines.push(el("div", { class: "race-prize" }, `+${result.acorns} acorns`));
    if (result.cropUnits > 0) {
      lines.push(el("div", { class: "race-prize crop" }, itemIcon(result.crop, 30), `+${result.cropUnits} ${itemName(result.crop)}`));
    }
    if (result.found > 0) {
      lines.push(el("div", { class: "race-prize rare" }, itemIcon(result.found, 34), `Found ${itemName(result.found)}! A rare food.`));
      sound.fanfare();
    }
    if (lines.length === 0) {
      const why = result.bonus === 0 && !this.rested ? "Rested Kinlings win acorns and crops: give it a minute between races." : "No prize this time. The top three win acorns and crops.";
      lines.push(el("div", { class: "race-noprize" }, why));
    }
    lines.push(el("div", { class: "race-noprize small" }, "Practice races never pay NEAR. Open a challenge to race real players for it."));
    purse.replaceChildren(...lines);
    if (result.acorns > 0) sound.coin();
    proof.replaceChildren(
      el("a", { href: `https://testnet.nearblocks.io/txns/${result.hash}`, target: "_blank", rel: "noopener" }, "Checked move by move on NEAR ↗"),
      result.order[0] === 0
        ? el(
            "button",
            { class: "btn small plain", onclick: () => this.options.ui.shareOnSocial(`${this.names[0]} just won the Valley Dash in Kinlings! Every move was checked on NEAR.`) },
            "Share on near.social",
          )
        : "",
    );
  }

  private leave(next: Next) {
    this.finishedAt = -1;
    this.resolve(next);
  }

  private quit() {
    if (this.phase === "done") {
      this.leave("valley");
      return;
    }
    this.phase = "done";
    this.finishedAt = -1;
    this.resolve(this.challenge ? "challenges" : "valley");
  }
}

/** A challenge's table: everyone who joined, fastest first. */
export function standingsRows(challenge: Challenge, me: number): HTMLElement[] {
  return standings(challenge).map((entry, position) => {
    const time =
      entry.ticks === 0 ? (entry.started > 0 ? "running..." : "yet to run") : entry.ticks === DID_NOT_FINISH ? "didn't finish" : `${(entry.ticks / D.ticks).toFixed(1)} s`;
    const prize = entry.prizeMicro > 0 ? el("b", { class: "near-text" }, `+${nearText(entry.prizeMicro / 1000)} NEAR`) : null;
    return el(
      "div",
      { class: `race-rank ${entry.playerIndex === me ? "you" : ""}` },
      el("b", {}, entry.ticks > 0 && entry.ticks !== DID_NOT_FINISH ? ORDINALS[position] : "·"),
      el("div", { class: "grow" }, el("div", {}, `${entry.name} with ${capital(entry.kinName)}`), el("small", {}, time)),
      prize,
    );
  });
}

function castSound(power: number) {
  [sound.fire, sound.frost, sound.bolt, sound.dash, sound.shield, sound.vine, sound.blink, sound.berry][power]?.();
}

function levelFor(kin: Kin): number {
  return K.kinLevels.reduce((level, needed, index) => (kin.xp >= needed ? index + 1 : level), 1);
}
