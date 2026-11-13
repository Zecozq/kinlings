// A week of the valley's economy in a minute. This runs the same Rust shop
// rules the contract runs, with simulated farmers, in this browser only.

import { K, stageSimShop, startSim, stepSim, type SimFrame } from "./core.ts";
import { el } from "./dom.ts";
import { itemName, type World } from "./world.ts";

const WEEK_STEPS = 7 * 24 * 6;
const SECONDS = 60;
const SIM_FARMERS = 60;
const LINE_COLOURS = ["#c9a93f", "#5cc4b8", "#ef7b30", "#6fb0d8", "#8d6bb0", "#3f7d5c"];

export function fastForward(modalLayer: HTMLElement, world: World) {
  const chart = el("canvas", { class: "ff-canvas" }) as HTMLCanvasElement;
  const log = el("div", { class: "ff-log" });
  const tills = el("div", { class: "ff-tills" });
  const clock = el("h3", {}, "Monday, 00:00");
  const oakLine = el("span", { class: "muted" });
  const legend = el(
    "div",
    { class: "row wrap", style: "justify-content:center;gap:12px;margin:6px 0" },
    ...K.crops.map((crop, i) =>
      el(
        "span",
        { style: "font-size:14px;font-weight:600" },
        el("span", { style: `color:${LINE_COLOURS[i]}` }, "■ "),
        crop.name,
      ),
    ),
  );

  const scrim = el(
    "div",
    { class: "scrim" },
    el(
      "div",
      { class: "modal wide" },
      el("h2", {}, "Fast-forward: one week in one minute"),
      el(
        "p",
        { class: "muted" },
        `Simulated farmers, starting from the valley's real shops right now. The prices come from the same pricing file the game uses. Nothing here touches the real valley.`,
      ),
      el("div", { class: "row spread" }, clock, oakLine),
      chart,
      legend,
      tills,
      log,
      el("div", { style: "margin-top:12px" }, el("button", { class: "btn", onclick: () => stop() }, "Done")),
    ),
  );
  modalLayer.append(scrim);

  world.shops.forEach((shop, id) => {
    stageSimShop(id, [
      shop.held,
      shop.pot,
      shop.closed ? 1 : 0,
      shop.shelves[0].stock,
      shop.shelves[0].recentIn,
      shop.shelves[0].recentOut,
      shop.shelves[1].stock,
      shop.shelves[1].recentIn,
      shop.shelves[1].recentOut,
    ]);
  });
  startSim(Date.now() >>> 0, SIM_FARMERS, world.oak);

  const history: SimFrame[] = [];
  let done = 0;
  let stopped = false;
  const started = performance.now();

  function stop() {
    stopped = true;
    scrim.remove();
  }

  const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

  function note(text: string, step: number) {
    const day = days[Math.min(6, Math.floor(step / 144))];
    const hour = Math.floor((step % 144) / 6);
    log.prepend(el("div", {}, el("b", {}, `${day} ${String(hour).padStart(2, "0")}:00 `), text));
  }

  function tick() {
    if (stopped) return;
    const elapsed = (performance.now() - started) / 1000;
    const wanted = Math.min(WEEK_STEPS, Math.floor((elapsed / SECONDS) * WEEK_STEPS));
    while (done < wanted) {
      const frame = stepSim();
      history.push(frame);
      done += 1;
      for (const [kind, a, b] of frame.events) {
        if (kind === "closed") note(`${K.shops[a].keeper} ran out of money and closed.`, frame.step);
        if (kind === "reopened") note(`Someone invested. ${K.shops[a].keeper} is open again.`, frame.step);
        if (kind === "spike") note(`${itemName(K.crops[a].item)} shot up ${b}%.`, frame.step);
        if (kind === "crash") note(`${itemName(K.crops[a].item)} crashed: down ${b}%.`, frame.step);
      }
    }
    if (history.length > 0) drawFrame();
    if (done < WEEK_STEPS) requestAnimationFrame(tick);
    else note("The week is over. Press Done, or look back at what happened.", WEEK_STEPS);
  }

  function drawFrame() {
    const last = history[history.length - 1];
    const day = days[Math.min(6, Math.floor(last.step / 144))];
    const hour = Math.floor((last.step % 144) / 6);
    clock.textContent = `${day}, ${String(hour).padStart(2, "0")}:00`;
    oakLine.textContent = `The Old Oak holds ${last.oak.toLocaleString()} acorns`;

    tills.replaceChildren(
      ...K.shops.map((shop, id) =>
        el(
          "div",
          { class: `ff-till ${last.closed[id] ? "shut" : ""}` },
          el("b", {}, shop.keeper),
          el("div", {}, last.closed[id] ? "CLOSED" : `${last.tills[id].toLocaleString()} in till`),
        ),
      ),
    );

    const ratio = Math.min(devicePixelRatio || 1, 2);
    const width = chart.clientWidth;
    const height = chart.clientHeight;
    chart.width = width * ratio;
    chart.height = height * ratio;
    const ctx = chart.getContext("2d")!;
    ctx.scale(ratio, ratio);
    const padding = { left: 40, right: 8, top: 10, bottom: 18 };
    const plotWidth = width - padding.left - padding.right;
    const plotHeight = height - padding.top - padding.bottom;

    // Each crop is drawn relative to its normal price: 100% means balanced.
    const maximum = 220;
    const yFor = (percent: number) => padding.top + plotHeight * (1 - percent / maximum);

    ctx.strokeStyle = "rgba(74,51,34,.18)";
    ctx.fillStyle = "#7a624c";
    ctx.font = "12px Fredoka, sans-serif";
    ctx.lineWidth = 1;
    for (const mark of [0, 50, 100, 150, 200]) {
      const y = yFor(mark);
      ctx.beginPath();
      ctx.moveTo(padding.left, y);
      ctx.lineTo(width - padding.right, y);
      ctx.stroke();
      ctx.fillText(`${mark}%`, 4, y + 4);
    }
    for (let day = 1; day < 7; day++) {
      const x = padding.left + (day / 7) * plotWidth;
      ctx.beginPath();
      ctx.moveTo(x, padding.top);
      ctx.lineTo(x, height - padding.bottom);
      ctx.stroke();
    }
    days.forEach((name, index) => ctx.fillText(name.slice(0, 3), padding.left + ((index + 0.36) / 7) * plotWidth, height - 4));

    ctx.lineWidth = 2.6;
    ctx.lineJoin = "round";
    K.crops.forEach((_, cropIndex) => {
      const shop = K.shops[Math.floor(cropIndex / 2)];
      const base = shop.items[cropIndex % 2].base;
      ctx.strokeStyle = LINE_COLOURS[cropIndex];
      ctx.beginPath();
      // Averaged over three valley hours, so the chart shows the tide and not the ripples.
      const window = 18;
      for (let index = window - 1; index < history.length; index += 3) {
        let total = 0;
        for (let back = 0; back < window; back++) total += history[index - back].prices[cropIndex];
        const percent = (total * 100) / window / base;
        const x = padding.left + (index / WEEK_STEPS) * plotWidth;
        const y = yFor(Math.min(maximum, percent));
        if (index === window - 1) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    });
  }

  requestAnimationFrame(tick);
}
