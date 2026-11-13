import "./style.css";
import { Signer } from "./chain.ts";
import { loadCore } from "./core.ts";
import { beginLogin, finishLogin, loginAvailable, returningFromLogin } from "./auth.ts";
import { $, el } from "./dom.ts";
import { Game, loadSaved } from "./game.ts";
import { Scene } from "./three/valley3d.ts";
import { Ui } from "./ui.ts";
import { connectWallet, walletAccount } from "./wallet.ts";

async function boot() {
  await loadCore();
  const canvas = $("valley") as HTMLCanvasElement;
  const saved = loadSaved();

  if (saved) {
    const game = Game.fromSaved(saved);
    begin(game, new Scene(canvas, game), false);
    return;
  }

  // Nobody yet: show the real valley behind the title screen.
  const visitor = new Game(new Signer("visitor.testnet", new Uint8Array(32)), "");
  visitor.start();
  const scene = new Scene(canvas, visitor);
  scene.goToLot(1);
  // For tools and films: the title screen's own valley.
  Object.assign(window, { kinlingsTitle: { scene } });
  if (returningFromLogin()) {
    await joinWithLogin(scene);
    return;
  }
  showTitle(scene);
}

async function joinWithLogin(scene: Scene) {
  scene.timeOverride = 0.28;
  const status = el("div", { class: "tagline" }, "Clearing a plot for you...");
  $("title-layer").replaceChildren(el("div", { class: "title" }, el("div", { class: "logo" }, "Kinlings"), status));
  try {
    const { name, identity } = await finishLogin();
    const game = await Game.join(name, identity);
    $("title-layer").replaceChildren();
    begin(game, scene, true);
  } catch (error) {
    console.error(error);
    showTitle(scene, "That sign-in didn't finish. You can play right away instead.");
  }
}

function begin(game: Game, scene: Scene, firstTime: boolean) {
  scene.game = game;
  scene.timeOverride = null;
  const ui = new Ui(game, scene);
  game.start();
  ui.start();
  let placed = false;
  game.listeners.add(() => {
    if (placed || !game.view) return;
    if (game.view.me > 1_000_000) {
      // The farm this browser remembers no longer exists, so start fresh.
      if (!firstTime) {
        localStorage.clear();
        location.reload();
      }
      return;
    }
    placed = true;
    scene.jumpToLot(game.view.me);
    if ((game.me?.eggs.length ?? 0) > 0) scene.showNest(game.view.me);
    if (firstTime) ui.banner("Welcome to the valley", "You have an egg waiting");
    // A wallet connected on the title screen is where this farm's NEAR goes.
    const wallet = walletAccount();
    if (wallet && !game.view.wallet) void game.setWallet(wallet);
    // An invitation to someone's challenge race.
    if (new URLSearchParams(location.search).has("challenge")) window.setTimeout(() => ui.openRace("challenges"), 600);
  });
  Object.assign(window, { kinlings: { game, scene, ui } });
}

function showTitle(scene: Scene, message = "") {
  scene.timeOverride = 0.28;
  const input = el("input", { maxlength: 16, placeholder: "Your farmer name", autocomplete: "off", spellcheck: "false" }) as HTMLInputElement;
  const status = el("div", { class: "title-note" }, message);
  const button = el("button", { class: "btn big leaf", type: "submit" }, "Play") as HTMLButtonElement;

  const walletLine = el("div", { class: "title-note" });
  const showWallet = () => {
    const wallet = walletAccount();
    walletLine.replaceChildren(
      wallet
        ? `Prizes and sales will be paid to ${wallet}.`
        : el(
            "button",
            {
              class: "linkish",
              onclick: async () => {
                const connected = await connectWallet().catch(() => null);
                if (!connected) status.textContent = "No wallet was connected. You can connect one later.";
                showWallet();
              },
            },
            "Connect a testnet NEAR wallet to get paid",
          ),
    );
  };
  showWallet();

  const play = async (event: Event) => {
    event.preventDefault();
    const name = input.value.trim() || "Farmer";
    button.disabled = true;
    status.textContent = "Clearing a plot for you...";
    try {
      const game = await Game.join(name);
      $("title-layer").replaceChildren();
      begin(game, scene, true);
    } catch (error) {
      console.error(error);
      status.textContent = "The valley gate is stuck. Please try again in a moment.";
      button.disabled = false;
    }
  };

  $("title-layer").replaceChildren(
    el(
      "div",
      { class: "title" },
      el("div", { class: "logo" }, "Kinlings"),
      el("div", { class: "tagline" }, "Raise mythical creatures. Race real players for testnet NEAR. Trade with your neighbours."),
      el("form", { onsubmit: play }, input, button),
      status,
      el("div", { class: "title-note" }, "Your farm gets its own NEAR account, so everyday play needs no pop-ups. Your first egg is waiting."),
      walletLine,
      loginAvailable()
        ? el(
            "button",
            {
              class: "linkish",
              onclick: () => {
                status.textContent = "Taking you to sign in...";
                void beginLogin(input.value.trim() || "Farmer").catch(() => {
                  status.textContent = "Sign-in isn't available right now. Press Play to start.";
                });
              },
            },
            "Or sign in with Google or email to keep your farm",
          )
        : null,
    ),
  );
  input.focus();
  void scene;
}

void boot();
