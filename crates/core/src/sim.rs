//! Fast-forward: a week of the valley's economy, played by simulated farmers.
//!
//! The shops here are the real shops. They use the same `pricing.rs` and the
//! same bookkeeping the contract uses. Only the farmers are invented, and the
//! screen says so.

use crate::items::{self, CROPS, LAND_COSTS, PAIRING_FEE, TOTAL_ACORNS};
use crate::rng::Rng;
use crate::shop::{Shop, MAX_TRADE, SHOPS};

/// One simulated step is ten valley minutes.
pub const STEP_SECS: u32 = 600;
/// Steps in a week.
pub const WEEK_STEPS: u32 = 7 * 24 * 6;
/// A crop only makes the news again after this many steps.
const NEWS_GAP_STEPS: u32 = 72;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Persona {
    /// Plants whatever is priciest right now.
    Chaser,
    /// Plants whatever is cheapest right now, expecting it to recover.
    Contrarian,
    /// Plants every crop in turn.
    Rotator,
    /// Plants only the most expensive crop it has unlocked.
    Prestige,
    /// Plants the fastest crop and never stops.
    Grinder,
    /// Holds its crops until the price is decent.
    Patient,
}

pub const PERSONAS: [Persona; 6] = [
    Persona::Chaser,
    Persona::Contrarian,
    Persona::Rotator,
    Persona::Prestige,
    Persona::Grinder,
    Persona::Patient,
];

#[derive(Clone, Copy, Debug)]
struct Plot {
    crop: usize,
    ready_at: u32,
}

#[derive(Clone, Debug)]
pub struct Farmer {
    pub persona: Persona,
    pub acorns: u32,
    pub crops: [u32; 6],
    mastery: [u32; 6],
    plots: Vec<Option<Plot>>,
    /// Hour of the day this farmer comes online.
    online_from: u32,
    online_hours: u32,
    turn: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Event {
    ShopClosed(usize),
    ShopReopened(usize),
    PriceSpike { crop: usize, percent: u32 },
    PriceCrash { crop: usize, percent: u32 },
}

pub struct Sim {
    pub now: u32,
    pub step: u32,
    rng: Rng,
    pub oak: u32,
    pub shops: [Shop; 4],
    pub farmers: Vec<Farmer>,
    closed_for: [u32; 4],
    alarmed: [i32; 6],
    last_news: [u32; 6],
    pub events: Vec<Event>,
    pub investments: u32,
}

/// Where a crop is traded: which shop and which shelf.
pub fn market_for(crop: usize) -> (usize, usize) {
    (crop / 2, crop % 2)
}

impl Sim {
    /// A fresh valley with `farmers` people playing.
    pub fn new(seed: u32, farmers: u32) -> Self {
        let shops = [
            Shop::opening(0, 0),
            Shop::opening(1, 0),
            Shop::opening(2, 0),
            Shop::opening(3, 0),
        ];
        Self::from_state(seed, farmers, shops, None)
    }

    /// Starts from the live valley's shops, so a judge fast-forwards from now.
    pub fn from_state(seed: u32, farmers: u32, mut shops: [Shop; 4], oak: Option<u32>) -> Self {
        for shop in shops.iter_mut() {
            shop.last_tick = 0;
        }
        let mut rng = Rng::from_seed(&seed.to_le_bytes());
        let mut crowd = Vec::with_capacity(farmers as usize);
        let welcome = items::WELCOME_ACORNS;
        for i in 0..farmers {
            let persona = PERSONAS[i as usize % PERSONAS.len()];
            crowd.push(Farmer {
                persona,
                acorns: welcome,
                crops: [8, 2, 0, 0, 0, 0],
                mastery: [0; 6],
                plots: vec![None; items::STARTING_PLOTS as usize],
                online_from: rng.below(24),
                online_hours: 1 + rng.below(3),
                turn: i as usize,
            });
        }
        let held_by_shops: u32 = shops.iter().map(|s| s.till + s.investor_pot).sum();
        let held_by_farmers = welcome * farmers;
        let oak = oak.unwrap_or(TOTAL_ACORNS - held_by_shops - held_by_farmers);
        Sim {
            now: 0,
            step: 0,
            rng,
            oak,
            shops,
            farmers: crowd,
            closed_for: [0; 4],
            alarmed: [0; 6],
            last_news: [0; 6],
            events: Vec::new(),
            investments: 0,
        }
    }

    /// Replaces who is playing. Used by the strategy tournament.
    pub fn set_mix(&mut self, mix: &[Persona]) {
        for (i, farmer) in self.farmers.iter_mut().enumerate() {
            farmer.persona = mix[i % mix.len()];
        }
    }

    pub fn fair_price(&self, crop: usize) -> u32 {
        let (id, slot) = market_for(crop);
        self.shops[id].quote(id, slot).fair
    }

    /// How expensive a crop is right now compared with normal, in percent.
    fn heat(&self, crop: usize) -> u32 {
        let (id, slot) = market_for(crop);
        self.fair_price(crop) * 100 / SHOPS[id].items[slot].base
    }

    /// One farmer's whole net worth at today's prices.
    pub fn wealth(&self, farmer: &Farmer) -> u32 {
        let goods: u32 = (0..6).map(|c| farmer.crops[c] * self.fair_price(c)).sum();
        farmer.acorns + goods
    }

    pub fn step(&mut self) {
        self.now += STEP_SECS;
        self.step += 1;
        for id in 0..4 {
            let was_closed = self.shops[id].closed;
            let population = self.farmers.len() as u32;
            self.shops[id].catch_up(id, self.now, &mut self.oak, population);
            self.note_transition(id, was_closed);
        }
        let hour = (self.now / 3_600) % 24;
        for i in 0..self.farmers.len() {
            let farmer = &self.farmers[i];
            let since_online = (hour + 24 - farmer.online_from) % 24;
            if since_online < farmer.online_hours {
                self.play(i);
            }
        }
        self.rescue_shops();
        self.watch_prices();
    }

    fn note_transition(&mut self, id: usize, was_closed: bool) {
        match (was_closed, self.shops[id].closed) {
            (false, true) => self.events.push(Event::ShopClosed(id)),
            (true, false) => self.events.push(Event::ShopReopened(id)),
            _ => {}
        }
    }

    fn rank_of_wealth(acorns: u32) -> u8 {
        match acorns {
            0..=599 => 1,
            600..=1_599 => 2,
            1_600..=3_599 => 3,
            3_600..=7_999 => 5,
            _ => 7,
        }
    }

    fn unlocked(acorns: u32) -> Vec<usize> {
        let rank = Self::rank_of_wealth(acorns);
        (0..6).filter(|&c| CROPS[c].rank <= rank).collect()
    }

    fn choose_crop(&mut self, i: usize) -> usize {
        let farmer = &self.farmers[i];
        let unlocked = Self::unlocked(farmer.acorns);
        let persona = farmer.persona;
        let turn = farmer.turn;
        match persona {
            Persona::Chaser => *unlocked.iter().max_by_key(|&&c| self.heat(c)).unwrap(),
            Persona::Contrarian => *unlocked.iter().min_by_key(|&&c| self.heat(c)).unwrap(),
            Persona::Rotator | Persona::Patient => unlocked[turn % unlocked.len()],
            Persona::Prestige => *unlocked.last().unwrap(),
            Persona::Grinder => 0,
        }
    }

    /// How many times in ten minutes a farmer looks at the farm. A fast crop
    /// only pays if someone is there to pick it.
    fn attention(persona: Persona) -> u32 {
        match persona {
            Persona::Grinder => 10,
            Persona::Patient => 2,
            _ => 4,
        }
    }

    fn play(&mut self, i: usize) {
        let visits = Self::attention(self.farmers[i].persona);
        let start = self.now - STEP_SECS;
        for visit in 1..=visits {
            let clock = start + STEP_SECS * visit / visits;
            self.harvest(i, clock);
            self.sell(i);
            self.plant(i, clock);
        }
        self.spend(i);
    }

    fn harvest(&mut self, i: usize, now: u32) {
        let farmer = &mut self.farmers[i];
        for plot in farmer.plots.iter_mut() {
            if let Some(p) = plot {
                if p.ready_at <= now {
                    let bonus = items::mastery_bonus(farmer.mastery[p.crop]);
                    farmer.crops[p.crop] += CROPS[p.crop].harvest + bonus;
                    farmer.mastery[p.crop] += 1;
                    *plot = None;
                }
            }
        }
    }

    fn sell(&mut self, i: usize) {
        for crop in 0..6 {
            let (id, slot) = market_for(crop);
            // Keep enough to replant.
            let keep = self.farmers[i].plots.len() as u32 / 2 + 1;
            let mut surplus = self.farmers[i].crops[crop].saturating_sub(keep);
            if self.farmers[i].persona == Persona::Patient && self.heat(crop) < 95 {
                continue;
            }
            while surplus > 0 {
                let batch = surplus.min(MAX_TRADE);
                let was_closed = self.shops[id].closed;
                let Some((taken, paid)) = self.shops[id].buy_from_player(id, slot, batch) else {
                    break;
                };
                self.note_transition(id, was_closed);
                if taken == 0 {
                    break;
                }
                self.farmers[i].acorns += paid;
                self.farmers[i].crops[crop] -= taken;
                surplus -= taken;
            }
        }
    }

    fn plant(&mut self, i: usize, now: u32) {
        for index in 0..self.farmers[i].plots.len() {
            if self.farmers[i].plots[index].is_some() {
                continue;
            }
            let crop = self.choose_crop(i);
            self.farmers[i].turn += 1;
            if self.farmers[i].crops[crop] == 0 && !self.buy_seed(i, crop) {
                continue;
            }
            self.farmers[i].crops[crop] -= 1;
            self.farmers[i].plots[index] =
                Some(Plot { crop, ready_at: now + CROPS[crop].grow_secs });
        }
    }

    fn buy_seed(&mut self, i: usize, crop: usize) -> bool {
        let (id, slot) = market_for(crop);
        if self.shops[id].closed || self.shops[id].shelves[slot].stock == 0 {
            return false;
        }
        let price = self.shops[id].quote(id, slot).shop_charges;
        if self.farmers[i].acorns < price {
            return false;
        }
        let Some(charged) = self.shops[id].sell_to_player(id, slot, 1) else { return false };
        self.farmers[i].acorns -= charged;
        self.farmers[i].crops[crop] += 1;
        true
    }

    /// Farmers spend on families and land, which moves acorns back to the Oak.
    fn spend(&mut self, i: usize) {
        let acorns = self.farmers[i].acorns;
        let plots = self.farmers[i].plots.len() as u8;
        let purchases = (plots.saturating_sub(items::STARTING_PLOTS) / items::PLOTS_PER_LAND) as usize;
        if purchases < LAND_COSTS.len() && acorns > LAND_COSTS[purchases] * 2 {
            let cost = LAND_COSTS[purchases];
            self.farmers[i].acorns -= cost;
            self.oak += cost;
            for _ in 0..items::PLOTS_PER_LAND {
                self.farmers[i].plots.push(None);
            }
        }
        // Breeders feed their Kinlings before a pairing, so crops have real demand.
        if self.farmers[i].acorns > 480 && self.rng.below(6) == 0 {
            let food = self.rng.below(6) as usize;
            if self.farmers[i].crops[food] > 0 || self.buy_seed(i, food) {
                self.farmers[i].crops[food] -= 1;
                self.farmers[i].acorns -= PAIRING_FEE;
                self.oak += PAIRING_FEE;
            }
        }
    }

    /// After a shop has been shut for a while, someone with money reopens it.
    fn rescue_shops(&mut self) {
        for id in 0..4 {
            if !self.shops[id].closed {
                self.closed_for[id] = 0;
                continue;
            }
            self.closed_for[id] += 1;
            if self.closed_for[id] < 18 {
                continue;
            }
            let needed = SHOPS[id].temperament.comfortable_till;
            let backer = (0..self.farmers.len())
                .filter(|&i| self.farmers[i].acorns >= needed)
                .max_by_key(|&i| self.farmers[i].acorns);
            if let Some(i) = backer {
                self.farmers[i].acorns -= needed;
                let was_closed = self.shops[id].closed;
                self.shops[id].invest(id, needed);
                self.note_transition(id, was_closed);
                self.investments += 1;
            }
        }
    }

    fn watch_prices(&mut self) {
        for crop in 0..6 {
            let heat = self.heat(crop) as i32;
            let quiet = self.step >= self.last_news[crop] + NEWS_GAP_STEPS;
            if heat >= 175 && self.alarmed[crop] != 1 && quiet {
                self.alarmed[crop] = 1;
                self.last_news[crop] = self.step;
                self.events.push(Event::PriceSpike { crop, percent: heat as u32 - 100 });
            } else if heat <= 42 && self.alarmed[crop] != -1 && quiet {
                self.alarmed[crop] = -1;
                self.last_news[crop] = self.step;
                self.events.push(Event::PriceCrash { crop, percent: 100 - heat as u32 });
            } else if (70..=135).contains(&heat) {
                self.alarmed[crop] = 0;
            }
        }
    }

    /// Every acorn in the simulation, wherever it is.
    pub fn acorns_in_existence(&self) -> u32 {
        let shops: u32 = self.shops.iter().map(|s| s.till + s.investor_pot).sum();
        let farmers: u32 = self.farmers.iter().map(|f| f.acorns).sum();
        shops + farmers + self.oak
    }

    /// The numbers the fast-forward screen draws, as JSON.
    pub fn frame_json(&mut self) -> String {
        let mut prices = Vec::with_capacity(6);
        for crop in 0..6 {
            prices.push(self.fair_price(crop).to_string());
        }
        let tills: Vec<String> = self.shops.iter().map(|s| s.till.to_string()).collect();
        let closed: Vec<String> = self.shops.iter().map(|s| (s.closed as u8).to_string()).collect();
        let mut events = Vec::new();
        for event in self.events.drain(..) {
            events.push(match event {
                Event::ShopClosed(id) => {
                    format!("[\"closed\",{id},0]")
                }
                Event::ShopReopened(id) => format!("[\"reopened\",{id},0]"),
                Event::PriceSpike { crop, percent } => format!("[\"spike\",{crop},{percent}]"),
                Event::PriceCrash { crop, percent } => format!("[\"crash\",{crop},{percent}]"),
            });
        }
        format!(
            "{{\"step\":{},\"prices\":[{}],\"tills\":[{}],\"closed\":[{}],\"oak\":{},\"events\":[{}]}}",
            self.step,
            prices.join(","),
            tills.join(","),
            closed.join(","),
            self.oak,
            events.join(",")
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn week(seed: u32, farmers: u32) -> Sim {
        let mut sim = Sim::new(seed, farmers);
        for _ in 0..WEEK_STEPS {
            sim.step();
        }
        sim
    }

    #[test]
    fn no_acorn_is_ever_created_or_lost() {
        let mut sim = Sim::new(7, 80);
        assert_eq!(sim.acorns_in_existence(), TOTAL_ACORNS);
        for _ in 0..WEEK_STEPS {
            sim.step();
            assert_eq!(sim.acorns_in_existence(), TOTAL_ACORNS, "step {}", sim.step);
        }
    }

    #[test]
    fn a_week_is_the_same_every_time_for_a_given_seed() {
        let a = week(3, 40);
        let b = week(3, 40);
        assert_eq!(a.oak, b.oak);
        assert_eq!(a.shops, b.shops);
    }

    #[test]
    fn prices_really_move() {
        let mut sim = Sim::new(11, 120);
        let (mut low, mut high) = ([u32::MAX; 6], [0u32; 6]);
        for _ in 0..WEEK_STEPS {
            sim.step();
            for crop in 0..6 {
                let heat = sim.heat(crop);
                low[crop] = low[crop].min(heat);
                high[crop] = high[crop].max(heat);
            }
        }
        for crop in 0..4 {
            assert!(
                high[crop] >= low[crop] + 40,
                "{} barely moved: {}..{}%",
                CROPS[crop].name, low[crop], high[crop]
            );
        }
    }

    #[test]
    fn busy_markets_ruin_shops_and_players_rescue_them() {
        let mut closed = 0;
        let mut reopened = 0;
        for seed in 0..10 {
            let mut sim = Sim::new(seed, 200);
            for _ in 0..WEEK_STEPS {
                sim.step();
                for event in sim.events.drain(..) {
                    match event {
                        Event::ShopClosed(_) => closed += 1,
                        Event::ShopReopened(_) => reopened += 1,
                        _ => {}
                    }
                }
            }
        }
        assert!(closed > 0, "no shop ever went broke");
        assert!(reopened > 0, "no shop ever reopened");
    }

    #[test]
    fn the_old_oak_lasts_the_week() {
        for seed in 0..5 {
            assert!(week(seed, 200).oak > 0);
        }
    }

    #[test]
    #[ignore = "prints a table for tuning"]
    fn diagnostics() {
        for farmers in [3u32, 8, 20, 72, 200] {
            let mut sim = Sim::new(5, farmers);
            let (mut low, mut high, mut sum) = ([u32::MAX; 6], [0u32; 6], [0u64; 6]);
            let (mut closed, mut reopened) = (0, 0);
            for _ in 0..WEEK_STEPS {
                sim.step();
                for crop in 0..6 {
                    let heat = sim.heat(crop);
                    low[crop] = low[crop].min(heat);
                    high[crop] = high[crop].max(heat);
                    sum[crop] += heat as u64;
                }
                for event in sim.events.drain(..) {
                    match event {
                        Event::ShopClosed(_) => closed += 1,
                        Event::ShopReopened(_) => reopened += 1,
                        _ => {}
                    }
                }
            }
            let avg: Vec<u64> = sum.iter().map(|s| s / WEEK_STEPS as u64).collect();
            let mut worth = [0u32; 6];
            for f in &sim.farmers {
                let index = PERSONAS.iter().position(|p| *p == f.persona).unwrap();
                worth[index] += sim.wealth(f);
            }
            let tills: Vec<u32> = sim.shops.iter().map(|s| s.till).collect();
            println!("farmers {farmers:>3}: low {low:?} high {high:?} avg {avg:?}");
            println!("   oak {} tills {tills:?} closed {closed} reopened {reopened}", sim.oak);
            println!("   stock {:?}", sim.shops.iter().map(|s| (s.shelves[0].stock, s.shelves[1].stock)).collect::<Vec<_>>());
            println!("   worth by persona {worth:?}");
        }
    }

    /// Half the valley plays one strategy and half plays another. Returns how
    /// much the first half is worth, as a percentage of the second.
    fn match_up(a: Persona, b: Persona, seeds: u32) -> u64 {
        let (mut worth_a, mut worth_b) = (0u64, 0u64);
        for seed in 0..seeds {
            let mut sim = Sim::new(seed + 500, 60);
            sim.set_mix(&[a, b]);
            for _ in 0..WEEK_STEPS {
                sim.step();
            }
            for farmer in &sim.farmers {
                if farmer.persona == a {
                    worth_a += sim.wealth(farmer) as u64;
                } else {
                    worth_b += sim.wealth(farmer) as u64;
                }
            }
        }
        worth_a * 100 / worth_b.max(1)
    }

    /// The promise in GAME_LOOP.md: no fixed strategy dominates. A strategy
    /// dominates if it clearly beats every other one head to head. Every
    /// strategy must have someone who can stand up to it.
    #[test]
    fn no_fixed_strategy_dominates() {
        for (i, &a) in PERSONAS.iter().enumerate() {
            let mut line = Vec::new();
            let mut beaten = 0;
            for (j, &b) in PERSONAS.iter().enumerate() {
                if i == j {
                    continue;
                }
                let percent = match_up(a, b, 3);
                line.push(format!("{b:?} {percent}%"));
                if percent > 115 {
                    beaten += 1;
                }
            }
            println!("{a:?}: {}", line.join(", "));
            assert!(beaten < PERSONAS.len() - 1, "{a:?} beats everyone");
        }
    }
}
