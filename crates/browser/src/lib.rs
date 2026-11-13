//! The rules, for the browser. Everything comes back as JSON text in one
//! shared buffer: a function returns the length, and `output_ptr` says where.

use kinlings_core::dash::{self, Dash};
use kinlings_core::genes::POWER_COUNT;
use kinlings_core::items::{self, CROPS, FOODS};
use kinlings_core::pricing;
use kinlings_core::shop::{Shelf, Shop, SHOPS};
use kinlings_core::sim::Sim;
use std::cell::RefCell;

thread_local! {
    static OUTPUT: RefCell<String> = const { RefCell::new(String::new()) };
    static SIM: RefCell<Option<Sim>> = const { RefCell::new(None) };
    static DASH: RefCell<Option<Dash>> = const { RefCell::new(None) };
    static DASH_SETUP: RefCell<[u8; SETUP_LEN]> = const { RefCell::new([0; SETUP_LEN]) };
    static DASH_VIEW: RefCell<Vec<i32>> = const { RefCell::new(Vec::new()) };
    static DASH_COURSE: RefCell<Vec<i32>> = const { RefCell::new(Vec::new()) };
    static STAGED: RefCell<[Shop; 4]> = RefCell::new([
        Shop::opening(0, 0),
        Shop::opening(1, 0),
        Shop::opening(2, 0),
        Shop::opening(3, 0),
    ]);
}

const SETUP_LEN: usize = 32 + dash::ENTRANTS_LEN;
/// Numbers per racer in the view handed to the screen.
const RUNNER_FIELDS: usize = 18 + POWER_COUNT;

fn give(text: String) -> usize {
    let length = text.len();
    OUTPUT.with(|out| *out.borrow_mut() = text);
    length
}

#[no_mangle]
pub extern "C" fn output_ptr() -> *const u8 {
    OUTPUT.with(|out| out.borrow().as_ptr())
}

fn quoted_list(values: impl Iterator<Item = String>) -> String {
    values.map(|v| format!("\"{v}\"")).collect::<Vec<_>>().join(",")
}

fn numbers(values: &[u32]) -> String {
    values.iter().map(|v| v.to_string()).collect::<Vec<_>>().join(",")
}

/// The game's fixed numbers, so the browser never keeps its own copy of them.
#[no_mangle]
pub extern "C" fn constants() -> usize {
    let crops = CROPS
        .iter()
        .map(|c| {
            format!(
                "{{\"item\":{},\"name\":\"{}\",\"grow\":{},\"harvest\":{},\"rank\":{}}}",
                c.item, c.name, c.grow_secs, c.harvest, c.rank
            )
        })
        .collect::<Vec<_>>()
        .join(",");
    let foods = FOODS
        .iter()
        .map(|f| {
            let finds = (1..items::ITEM_COUNT)
                .filter_map(|crop| {
                    items::harvest_finds(crop).iter().find(|find| find.item == f.item).map(|find| format!("[{crop},{}]", find.per_mille))
                })
                .collect::<Vec<_>>()
                .join(",");
            let race = items::RACE_WIN_FINDS.iter().find(|find| find.item == f.item).map_or(0, |find| find.per_mille);
            format!(
                "{{\"item\":{},\"name\":\"{}\",\"xp\":{},\"cap\":{},\"rare\":{},\"finds\":[{finds}],\"raceFind\":{race}}}",
                f.item,
                f.name,
                f.xp,
                f.level_cap,
                items::is_rare(f.item)
            )
        })
        .collect::<Vec<_>>()
        .join(",");
    let shops = SHOPS
        .iter()
        .map(|s| {
            let slots = s
                .items
                .iter()
                .map(|i| format!("{{\"item\":{},\"base\":{},\"target\":{}}}", i.item, i.base, i.target))
                .collect::<Vec<_>>()
                .join(",");
            format!(
                "{{\"keeper\":\"{}\",\"label\":\"{}\",\"margin\":{},\"comfortable\":{},\"items\":[{slots}]}}",
                s.keeper, s.label, s.temperament.margin_pct, s.temperament.comfortable_till
            )
        })
        .collect::<Vec<_>>()
        .join(",");
    let tokens = quoted_list((0..items::ITEM_COUNT).map(|i| items::token_id(i).to_string()));
    give(format!(
        "{{\"crops\":[{crops}],\"foods\":[{foods}],\"shops\":[{shops}],\"tokens\":[{tokens}],\
\"ranks\":[{}],\"kinLevels\":[{}],\"adult\":{},\"raceLevelCap\":{},\"rest\":{},\"incubate\":{},\"warm\":{},\"maxWarms\":{},\
\"tonicSecs\":{},\"waterPct\":{},\"welcome\":{},\"pairing\":{},\"raceBonus\":{},\"raceCrops\":[{}],\"raceRest\":{},\"stallTax\":{},\
\"land\":[{}],\"plotsPerLand\":{},\"startPlots\":{},\"mastery\":[{}],\"total\":{}}}",
        numbers(&items::FARMER_RANKS),
        numbers(&items::KIN_LEVELS),
        items::ADULT_LEVEL,
        items::RACE_LEVEL_CAP,
        items::REST_SECS,
        items::INCUBATE_SECS,
        items::WARM_SECS,
        items::MAX_WARMS,
        items::TONIC_SECS,
        items::WATER_PCT,
        items::WELCOME_ACORNS,
        items::PAIRING_FEE,
        items::RACE_BONUS,
        numbers(&items::RACE_CROP_PRIZES),
        items::RACE_REST_SECS,
        items::STALL_TAX_PCT,
        numbers(&items::LAND_COSTS),
        items::PLOTS_PER_LAND,
        items::STARTING_PLOTS,
        numbers(&items::MASTERY_HARVESTS),
        items::TOTAL_ACORNS,
    ))
}

fn shelf(stock: u32, recent_in: u32, recent_out: u32) -> Shelf {
    Shelf { stock, recent_in, recent_out }
}

fn item_name(item: u16) -> &'static str {
    match items::food(item) {
        Some(food) => food.name,
        None if item == items::TONIC => "Warmth Tonic",
        None => "Wild Egg",
    }
}

/// Today's prices at one shop, with each keeper's reasoning, caught up to now
/// exactly as the contract would.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn quotes(
    id: usize,
    held: u32,
    pot: u32,
    closed: u32,
    last_tick: u32,
    stock_a: u32,
    in_a: u32,
    out_a: u32,
    stock_b: u32,
    in_b: u32,
    out_b: u32,
    oak: u32,
    population: u32,
    now: u32,
) -> usize {
    let mut shop = Shop {
        till: held.saturating_sub(pot),
        shelves: [shelf(stock_a, in_a, out_a), shelf(stock_b, in_b, out_b)],
        last_tick,
        closed: closed != 0,
        investor_pot: pot,
    };
    let mut oak = oak;
    shop.catch_up(id, now.max(last_tick), &mut oak, population);

    let config = &SHOPS[id];
    let slots = (0..2)
        .map(|slot| {
            let q = shop.quote(id, slot);
            let why = pricing::explain(
                item_name(config.items[slot].item),
                &shop.item_state(id, slot),
                shop.till,
                &config.temperament,
            );
            format!(
                "{{\"pays\":{},\"charges\":{},\"fair\":{},\"scarcity\":{},\"demand\":{},\"tillPct\":{},\"stock\":{},\"why\":[{}]}}",
                q.shop_pays,
                q.shop_charges,
                q.fair,
                q.scarcity_pct,
                q.demand_pct,
                q.till_pct,
                shop.shelves[slot].stock,
                quoted_list(why.into_iter())
            )
        })
        .collect::<Vec<_>>()
        .join(",");
    give(format!("{{\"till\":{},\"closed\":{},\"slots\":[{slots}]}}", shop.till, shop.closed))
}

/// Stages one live shop for the next simulation.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn sim_shop(
    id: usize,
    held: u32,
    pot: u32,
    closed: u32,
    stock_a: u32,
    in_a: u32,
    out_a: u32,
    stock_b: u32,
    in_b: u32,
    out_b: u32,
) {
    STAGED.with(|staged| {
        staged.borrow_mut()[id] = Shop {
            till: held.saturating_sub(pot),
            shelves: [shelf(stock_a, in_a, out_a), shelf(stock_b, in_b, out_b)],
            last_tick: 0,
            closed: closed != 0,
            investor_pot: pot,
        };
    });
}

/// Starts a simulated week from the staged shops.
#[no_mangle]
pub extern "C" fn sim_start(seed: u32, farmers: u32, oak: u32) {
    let shops = STAGED.with(|staged| *staged.borrow());
    SIM.with(|sim| *sim.borrow_mut() = Some(Sim::from_state(seed, farmers, shops, Some(oak))));
}

/// Advances one step of ten valley minutes and returns the numbers to draw.
#[no_mangle]
pub extern "C" fn sim_step() -> usize {
    let frame = SIM.with(|sim| {
        let mut sim = sim.borrow_mut();
        let sim = sim.as_mut().expect("sim_start first");
        sim.step();
        sim.frame_json()
    });
    give(frame)
}

// ----- The Valley Dash ----------------------------------------------------
//
// The browser writes the seed and the racers into a shared buffer, then steps
// the race once per tick and reads a flat block of numbers back to draw from.

/// Where to write the 32-byte seed followed by the packed racers.
#[no_mangle]
pub extern "C" fn dash_setup_ptr() -> *mut u8 {
    DASH_SETUP.with(|setup| setup.borrow_mut().as_mut_ptr())
}

/// Starts a race from the setup buffer. Returns how many rows the course has.
#[no_mangle]
pub extern "C" fn dash_start(ease: u32) -> usize {
    let setup = DASH_SETUP.with(|setup| *setup.borrow());
    let entrants = dash::unpack_entrants(&setup[32..]);
    let race = Dash::new(&setup[..32], entrants, ease as u8, true);
    let rows = race.hazards.len();
    DASH_COURSE.with(|course| {
        let mut course = course.borrow_mut();
        course.clear();
        for hazard in &race.hazards {
            course.extend_from_slice(&[hazard.pos, hazard.kind as i32, hazard.lanes as i32]);
        }
    });
    DASH.with(|slot| *slot.borrow_mut() = Some(race));
    rows
}

/// The course, as position, kind and lanes for each row.
#[no_mangle]
pub extern "C" fn dash_course() -> *const i32 {
    DASH_COURSE.with(|course| course.borrow().as_ptr())
}

/// Plays one tick with up to four of the player's moves. -1 means no move.
#[no_mangle]
pub extern "C" fn dash_step(a: i32, b: i32, c: i32, d: i32) {
    let mut moves = [0u8; 4];
    let mut count = 0;
    for code in [a, b, c, d] {
        if code >= 0 {
            moves[count] = code as u8;
            count += 1;
        }
    }
    DASH.with(|slot| {
        if let Some(race) = slot.borrow_mut().as_mut() {
            race.step(&moves[..count]);
        }
    });
}

/// Refreshes the numbers to draw from and returns where they are.
#[no_mangle]
pub extern "C" fn dash_view() -> *const i32 {
    DASH_VIEW.with(|view| {
        let mut view = view.borrow_mut();
        view.clear();
        DASH.with(|slot| {
            let slot = slot.borrow();
            let Some(race) = slot.as_ref() else { return };
            view.extend_from_slice(&[
                race.tick as i32,
                race.over as i32,
                race.events.len() as i32,
                race.shots.len() as i32,
                race.traps.len() as i32,
            ]);
            for r in &race.runners {
                view.extend_from_slice(&[
                    r.pos,
                    r.x,
                    r.y,
                    r.v,
                    r.stamina,
                    r.winded as i32,
                    r.sprint as i32,
                    r.brake as i32,
                    r.mud as i32,
                    r.stumble as i32,
                    r.burn as i32,
                    r.chill as i32,
                    r.stun as i32,
                    r.snare as i32,
                    r.dash as i32,
                    r.shield as i32,
                    r.finished as i32,
                    r.lane,
                ]);
                view.extend(r.cooldown.iter().map(|c| *c as i32));
            }
            for e in &race.events {
                view.extend_from_slice(&[e.kind as i32, e.a as i32, e.b as i32, e.value]);
            }
            for s in &race.shots {
                view.extend_from_slice(&[s.owner as i32, s.target as i32, s.pos, s.x, s.life as i32]);
            }
            for trap in &race.traps {
                view.extend_from_slice(&[trap.owner as i32, trap.pos, trap.lane as i32]);
            }
        });
        view.as_ptr()
    })
}

/// How the finished race came out, as the contract will see it.
#[no_mangle]
pub extern "C" fn dash_outcome() -> usize {
    let text = DASH.with(|slot| {
        let slot = slot.borrow();
        let Some(race) = slot.as_ref() else { return String::from("null") };
        let outcome = race.outcome();
        format!(
            "{{\"order\":[{}],\"ticks\":{},\"finished\":{},\"trips\":{},\"cleared\":{},\"landed\":{}}}",
            outcome.order.iter().map(|o| o.to_string()).collect::<Vec<_>>().join(","),
            outcome.ticks,
            outcome.player_finished,
            outcome.trips,
            outcome.cleared,
            outcome.hits_landed
        )
    });
    give(text)
}

/// The numbers the race screen needs to know.
#[no_mangle]
pub extern "C" fn dash_constants() -> usize {
    give(format!(
        "{{\"ticks\":{},\"racers\":{},\"lanes\":{},\"laneWidth\":{},\"track\":{},\"maxMoves\":{},\"runnerFields\":{},\"powers\":{},\"maxTicks\":{}}}",
        dash::TICKS_PER_SEC,
        dash::RACERS,
        dash::LANES,
        dash::LANE_WIDTH,
        dash::TRACK_LEN,
        dash::MAX_MOVES,
        RUNNER_FIELDS,
        POWER_COUNT,
        dash::MAX_TICKS
    ))
}
