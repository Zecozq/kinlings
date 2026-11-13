//! Shops as little businesses: who they are, how time passes for them, and
//! what happens when someone trades. Prices themselves come from `pricing.rs`.

use crate::items;
use crate::pricing::{self, ItemState, Quote, Temperament};

#[derive(Clone, Copy, Debug)]
pub struct ItemConfig {
    pub item: u16,
    pub base: u32,
    pub target: u32,
    /// Units per hour that villagers buy when the shelf is over target, or
    /// bring in when it is under.
    pub villagers_per_hour: u32,
}

#[derive(Clone, Copy, Debug)]
pub struct ShopConfig {
    pub keeper: &'static str,
    /// The first part of this shopkeeper's account name.
    pub label: &'static str,
    pub temperament: Temperament,
    pub opening_till: u32,
    pub items: [ItemConfig; 2],
}

pub const SHOPS: [ShopConfig; 4] = [
    ShopConfig {
        keeper: "Bramble",
        label: "bramble",
        temperament: Temperament { margin_pct: 12, comfortable_till: 2_500 },
        opening_till: 3_500,
        items: [
            ItemConfig { item: items::SUNWHEAT, base: 12, target: 200, villagers_per_hour: 540 },
            ItemConfig { item: items::DEWBEAN, base: 20, target: 150, villagers_per_hour: 310 },
        ],
    },
    ShopConfig {
        keeper: "Cinder",
        label: "cinder",
        temperament: Temperament { margin_pct: 15, comfortable_till: 3_500 },
        opening_till: 5_000,
        items: [
            ItemConfig { item: items::EMBERROOT, base: 36, target: 100, villagers_per_hour: 180 },
            ItemConfig { item: items::FROSTBERRY, base: 56, target: 70, villagers_per_hour: 120 },
        ],
    },
    ShopConfig {
        keeper: "Moth",
        label: "moth",
        temperament: Temperament { margin_pct: 18, comfortable_till: 5_000 },
        opening_till: 7_000,
        items: [
            ItemConfig { item: items::MOONMELON, base: 100, target: 45, villagers_per_hour: 72 },
            ItemConfig { item: items::STARFIG, base: 180, target: 28, villagers_per_hour: 45 },
        ],
    },
    ShopConfig {
        keeper: "Nana Wick",
        label: "nanawick",
        temperament: Temperament { margin_pct: 10, comfortable_till: 2_000 },
        opening_till: 3_000,
        items: [
            ItemConfig { item: items::TONIC, base: 48, target: 40, villagers_per_hour: 40 },
            ItemConfig { item: items::WILD_EGG, base: 240, target: 12, villagers_per_hour: 6 },
        ],
    },
];

/// Villagers haggle: they pay this percentage of the fair price. A shop that
/// stuffs its shelves with goods only villagers will take slowly loses money.
pub const VILLAGER_PRICE_PCT: u32 = 70;

/// Half of "recent" trading is forgotten every ten minutes.
pub const DEMAND_HALF_LIFE_SECS: u32 = 600;
/// A shop shuts when its till falls below this fraction of comfortable, in percent.
pub const CLOSE_TILL_PCT: u32 = 3;
/// How much a closed shop must hold before it can reopen, in percent of comfortable.
pub const REOPEN_TILL_PCT: u32 = 25;
/// Of every sale, the percentage set aside for investors.
pub const INVESTOR_CUT_PCT: u32 = 10;
/// Largest number of units in one trade.
pub const MAX_TRADE: u32 = 60;
/// A shelf holds at most this many times what the keeper likes to keep.
pub const SHELF_CAP_MULTIPLE: u32 = 5;
/// Money in the till beyond this many times comfortable goes to the Old Oak as rent.
pub const RENT_ABOVE_MULTIPLE: u32 = 3;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct Shelf {
    pub stock: u32,
    pub recent_in: u32,
    pub recent_out: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Shop {
    pub till: u32,
    pub shelves: [Shelf; 2],
    pub last_tick: u32,
    pub closed: bool,
    /// Acorns set aside for investors, not yet claimed.
    pub investor_pot: u32,
}

impl Shop {
    pub fn opening(id: usize, now: u32) -> Self {
        let config = &SHOPS[id];
        Shop {
            till: config.opening_till,
            shelves: [
                Shelf { stock: config.items[0].target, ..Default::default() },
                Shelf { stock: config.items[1].target, ..Default::default() },
            ],
            last_tick: now,
            closed: false,
            investor_pot: 0,
        }
    }

    pub fn item_state(&self, id: usize, slot: usize) -> ItemState {
        let config = &SHOPS[id].items[slot];
        let shelf = &self.shelves[slot];
        ItemState {
            base: config.base,
            stock: shelf.stock,
            target: config.target,
            recent_in: shelf.recent_in,
            recent_out: shelf.recent_out,
        }
    }

    pub fn quote(&self, id: usize, slot: usize) -> Quote {
        pricing::quote(&self.item_state(id, slot), self.till, &SHOPS[id].temperament)
    }

    /// Catches a shop up on what happened since anyone last looked. This is
    /// how the economy moves when nobody is around, with no server running.
    /// Villager money moves to and from the Old Oak, so no acorns are created.
    pub fn catch_up(&mut self, id: usize, now: u32, oak: &mut u32, population: u32) {
        let elapsed = now.saturating_sub(self.last_tick);
        if elapsed == 0 {
            return;
        }
        self.last_tick = now;
        for slot in 0..2 {
            let config = SHOPS[id].items[slot];
            let shelf = &mut self.shelves[slot];
            shelf.recent_in = fade(shelf.recent_in, elapsed);
            shelf.recent_out = fade(shelf.recent_out, elapsed);

            let villagers = villagers_arriving(config.villagers_per_hour, elapsed, population);
            if villagers == 0 || self.closed {
                continue;
            }
            let fair = pricing::quote(
                &ItemState {
                    base: config.base,
                    stock: self.shelves[slot].stock,
                    target: config.target,
                    recent_in: self.shelves[slot].recent_in,
                    recent_out: self.shelves[slot].recent_out,
                },
                self.till,
                &SHOPS[id].temperament,
            )
            .fair;
            let shelf = &mut self.shelves[slot];
            if shelf.stock > config.target {
                // Villagers buy the surplus, paying from the Old Oak.
                let units = villagers.min(shelf.stock - config.target);
                let haggled = (fair * VILLAGER_PRICE_PCT / 100).max(1);
                let bill = items::oak_gift(units.saturating_mul(haggled), *oak);
                let units = (bill / haggled).min(units);
                let bill = units * haggled;
                shelf.stock -= units;
                *oak -= bill;
                self.till += bill;
            } else if shelf.stock < config.target {
                // Farmers from over the hill top the shelf up.
                let units = villagers.min(config.target - shelf.stock);
                let units = if fair == 0 { units } else { units.min(self.till / fair) };
                let bill = units * fair;
                shelf.stock += units;
                self.till -= bill;
                *oak += bill;
            }
        }
        let rent_above = SHOPS[id].temperament.comfortable_till * RENT_ABOVE_MULTIPLE;
        if self.till > rent_above {
            *oak += self.till - rent_above;
            self.till = rent_above;
        }
        self.update_closed(id);
    }

    /// A player sells to the shop, one unit at a time so the price slides as
    /// the shelf fills. The keeper stops when the shelf is full or the money
    /// runs out. Returns how many it took and what it paid in total.
    pub fn buy_from_player(&mut self, id: usize, slot: usize, units: u32) -> Option<(u32, u32)> {
        if self.closed || units == 0 || units > MAX_TRADE {
            return None;
        }
        let cap = SHOPS[id].items[slot].target * SHELF_CAP_MULTIPLE;
        let (mut taken, mut paid) = (0, 0);
        for _ in 0..units {
            let price = self.quote(id, slot).shop_pays;
            if price > self.till || self.shelves[slot].stock >= cap {
                break;
            }
            self.till -= price;
            paid += price;
            taken += 1;
            self.shelves[slot].stock += 1;
            self.shelves[slot].recent_in += 1;
        }
        self.update_closed(id);
        Some((taken, paid))
    }

    /// A player buys from the shop. Returns what it cost in total.
    pub fn sell_to_player(&mut self, id: usize, slot: usize, units: u32) -> Option<u32> {
        if self.closed || units == 0 || units > MAX_TRADE || self.shelves[slot].stock < units {
            return None;
        }
        let mut charged = 0;
        for _ in 0..units {
            let price = self.quote(id, slot).shop_charges;
            charged += price;
            self.shelves[slot].stock -= 1;
            self.shelves[slot].recent_out += 1;
            self.till += price;
        }
        // Investors take their slice of the sale, kept apart from the till.
        let cut = charged * INVESTOR_CUT_PCT / 100;
        self.till -= cut;
        self.investor_pot += cut;
        self.update_closed(id);
        Some(charged)
    }

    fn update_closed(&mut self, id: usize) {
        let comfortable = SHOPS[id].temperament.comfortable_till;
        if !self.closed && self.till * 100 < comfortable * CLOSE_TILL_PCT {
            self.closed = true;
        } else if self.closed && self.till * 100 >= comfortable * REOPEN_TILL_PCT {
            self.closed = false;
        }
    }

    /// A player puts money in. Reopens the shop if that is enough.
    pub fn invest(&mut self, id: usize, acorns: u32) {
        self.till += acorns;
        self.update_closed(id);
    }

    pub fn is_closed(&self) -> bool {
        self.closed
    }
}

/// More farmers means a bigger town to feed, so markets deepen as the valley
/// fills up.
fn villagers_arriving(per_hour: u32, elapsed: u32, population: u32) -> u32 {
    let crowd_pct = 100 + 8 * population.min(400) as u64;
    (per_hour as u64 * crowd_pct * elapsed as u64 / 360_000) as u32
}

fn fade(value: u32, elapsed: u32) -> u32 {
    let halvings = elapsed / DEMAND_HALF_LIFE_SECS;
    if halvings >= 32 {
        return 0;
    }
    let halved = value >> halvings;
    let rest = elapsed % DEMAND_HALF_LIFE_SECS;
    halved - (halved as u64 * rest as u64 / (2 * DEMAND_HALF_LIFE_SECS as u64)) as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    const BRAMBLE: usize = 0;

    #[test]
    fn a_new_shop_is_balanced_and_open() {
        let shop = Shop::opening(BRAMBLE, 0);
        assert_eq!(shop.quote(BRAMBLE, 0).fair, 12);
        assert!(!shop.is_closed());
    }

    #[test]
    fn selling_a_lot_slides_the_price_down() {
        let mut shop = Shop::opening(BRAMBLE, 0);
        let first = shop.quote(BRAMBLE, 1).shop_pays;
        shop.buy_from_player(BRAMBLE, 1, 60).unwrap();
        assert!(shop.quote(BRAMBLE, 1).shop_pays < first);
    }

    #[test]
    fn a_shop_cannot_sell_what_it_does_not_have() {
        let mut shop = Shop::opening(BRAMBLE, 0);
        shop.shelves[0].stock = 3;
        assert_eq!(shop.sell_to_player(BRAMBLE, 0, 4), None);
        assert!(shop.sell_to_player(BRAMBLE, 0, 3).is_some());
    }

    #[test]
    fn a_full_shelf_stops_buying() {
        let mut shop = Shop::opening(BRAMBLE, 0);
        shop.shelves[0].stock = 1_000;
        assert_eq!(shop.buy_from_player(BRAMBLE, 0, 10), Some((0, 0)));
    }

    #[test]
    fn a_rich_shop_sends_its_excess_to_the_oak() {
        let mut shop = Shop::opening(BRAMBLE, 0);
        shop.till = 100_000;
        let mut oak = 1_000;
        shop.catch_up(BRAMBLE, 1, &mut oak, 0);
        assert_eq!(shop.till, 2_500 * RENT_ABOVE_MULTIPLE);
        assert_eq!(oak + shop.till, 101_000);
    }

    #[test]
    fn recent_trading_fades_with_time() {
        assert_eq!(fade(800, 0), 800);
        assert_eq!(fade(800, DEMAND_HALF_LIFE_SECS), 400);
        assert_eq!(fade(800, DEMAND_HALF_LIFE_SECS * 2), 200);
        assert_eq!(fade(800, DEMAND_HALF_LIFE_SECS * 40), 0);
    }

    #[test]
    fn villagers_buy_the_surplus_with_oak_money_and_no_acorn_is_lost() {
        let mut shop = Shop::opening(BRAMBLE, 0);
        shop.shelves[0].stock = 400;
        let mut oak = 5_000_000;
        let before = oak + shop.till;
        shop.catch_up(BRAMBLE, 3_600, &mut oak, 4);
        assert!(shop.shelves[0].stock < 400);
        assert_eq!(oak + shop.till, before);
    }

    #[test]
    fn a_shop_that_runs_out_of_money_closes_until_someone_invests() {
        let mut shop = Shop::opening(BRAMBLE, 0);
        for _ in 0..500 {
            if shop.is_closed() {
                break;
            }
            shop.shelves[1].stock = 0; // keep the shelf from filling
            shop.buy_from_player(BRAMBLE, 1, 60);
        }
        assert!(shop.is_closed(), "till left: {}", shop.till);
        assert_eq!(shop.buy_from_player(BRAMBLE, 1, 1), None);
        shop.invest(BRAMBLE, 100);
        assert!(shop.is_closed(), "100 acorns is not enough to reopen");
        shop.invest(BRAMBLE, 1_000);
        assert!(!shop.is_closed());
    }

    #[test]
    fn investors_get_a_slice_of_sales_and_the_books_balance() {
        let mut shop = Shop::opening(BRAMBLE, 0);
        let before = shop.till;
        let charged = shop.sell_to_player(BRAMBLE, 0, 10).unwrap();
        assert_eq!(shop.till + shop.investor_pot, before + charged);
        assert!(shop.investor_pot > 0);
    }
}
