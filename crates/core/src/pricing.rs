//! HOW SHOPKEEPERS SET PRICES
//!
//! This is the one file that decides every shop price in the valley. The game
//! contract runs this exact code on the blockchain, and the browser runs it
//! again to explain a price in plain words and to fast-forward the economy.
//!
//! A shopkeeper looks at four things, in this order:
//!
//!   1. SCARCITY  Do I have more or less of this than I like to keep?
//!   2. DEMAND    Lately, have people been buying this from me, or dumping it?
//!   3. MY TILL   Can I afford to keep buying? If money is short I offer less.
//!   4. MY CUT    I sell a little above the fair price and buy a little below it.
//!
//! All the maths is whole numbers, so every computer gets the identical answer.

/// What a shopkeeper knows about one item on its shelf.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ItemState {
    /// The price in a perfectly balanced market.
    pub base: u32,
    /// How many are on the shelf now.
    pub stock: u32,
    /// How many the shopkeeper likes to keep.
    pub target: u32,
    /// Units people sold to this shop recently (fades with time).
    pub recent_in: u32,
    /// Units people bought from this shop recently (fades with time).
    pub recent_out: u32,
}

/// A shopkeeper's personality.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Temperament {
    /// The gap kept on each side of the fair price, in percent.
    pub margin_pct: u32,
    /// How much cash the shopkeeper likes to have in the till.
    pub comfortable_till: u32,
}

/// The shopkeeper's answer, plus the working behind it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Quote {
    /// What the shop pays you for one.
    pub shop_pays: u32,
    /// What you pay the shop for one.
    pub shop_charges: u32,
    /// The fair price before the shopkeeper's cut.
    pub fair: u32,
    /// Step 1, as a percent change.
    pub scarcity_pct: i32,
    /// Step 2, as a percent change.
    pub demand_pct: i32,
    /// Step 3, as a percent change to what the shop will pay. Zero or negative.
    pub till_pct: i32,
}

/// Step 1. Empty shelf: price doubles. Right amount: no change.
/// Twice too much: 35% off. Four times too much or worse: 60% off.
pub fn scarcity_percent(stock: u32, target: u32) -> i32 {
    let fullness = (stock as u64 * 100 / target.max(1) as u64).min(1_000) as i32;
    match fullness {
        0..=100 => 100 - fullness,
        101..=200 => -(fullness - 100) * 35 / 100,
        201..=400 => -35 - (fullness - 200) * 25 / 200,
        _ => -60,
    }
}

/// Step 2. Net buying pushes the price up and net selling pushes it down,
/// by up to 25% either way. A burst worth a full shelf has the maximum effect.
pub fn demand_percent(recent_in: u32, recent_out: u32, target: u32) -> i32 {
    let net = recent_out as i64 - recent_in as i64;
    (net * 25 / target.max(1) as i64).clamp(-25, 25) as i32
}

/// Step 3. A full till changes nothing. As the till empties the shopkeeper
/// offers less, down to 60% off when it is bare.
pub fn till_percent(till: u32, comfortable_till: u32) -> i32 {
    if till >= comfortable_till {
        return 0;
    }
    let shortfall = 100 - (till as u64 * 100 / comfortable_till.max(1) as u64) as i32;
    -shortfall * 60 / 100
}

/// Puts the four steps together. Prices never fall below one acorn.
pub fn quote(item: &ItemState, till: u32, temperament: &Temperament) -> Quote {
    let scarcity_pct = scarcity_percent(item.stock, item.target);
    let demand_pct = demand_percent(item.recent_in, item.recent_out, item.target);
    let till_pct = till_percent(till, temperament.comfortable_till);

    let fair = apply_percent(apply_percent(item.base as i64, scarcity_pct), demand_pct).max(1);
    let shop_charges = apply_percent_up(fair, temperament.margin_pct as i32).max(1);
    let cautious = apply_percent(fair, -(temperament.margin_pct as i32));
    let shop_pays = apply_percent(cautious, till_pct).max(1);

    Quote {
        shop_pays: shop_pays as u32,
        shop_charges: shop_charges as u32,
        fair: fair as u32,
        scarcity_pct,
        demand_pct,
        till_pct,
    }
}

fn apply_percent(value: i64, percent: i32) -> i64 {
    value * (100 + percent as i64) / 100
}

fn apply_percent_up(value: i64, percent: i32) -> i64 {
    (value * (100 + percent as i64) + 99) / 100
}

/// A shopkeeper explaining a price in its own words, for the tooltip.
#[cfg(feature = "explain")]
pub fn explain(
    item_name: &str,
    item: &ItemState,
    till: u32,
    temperament: &Temperament,
) -> Vec<String> {
    let q = quote(item, till, temperament);
    let mut reasons = Vec::new();

    let stock_line = if q.scarcity_pct > 40 {
        format!(
            "I'm nearly out of {item_name}: {} left and I like to keep {}. Price up {}%.",
            item.stock, item.target, q.scarcity_pct
        )
    } else if q.scarcity_pct > 0 {
        format!(
            "A bit short on {item_name}: {} on the shelf, I like {}. Price up {}%.",
            item.stock, item.target, q.scarcity_pct
        )
    } else if q.scarcity_pct == 0 {
        format!("I've got just the right amount of {item_name}: {}.", item.stock)
    } else {
        format!(
            "I'm swimming in {item_name}: {} here and I only want {}. {}% off.",
            item.stock, item.target, -q.scarcity_pct
        )
    };
    reasons.push(stock_line);

    if q.demand_pct > 0 {
        reasons.push(format!(
            "People keep buying it ({} sold lately against {} brought in). Up another {}%.",
            item.recent_out, item.recent_in, q.demand_pct
        ));
    } else if q.demand_pct < 0 {
        reasons.push(format!(
            "Everyone's dumping it on me ({} brought in lately, only {} bought). Down {}%.",
            item.recent_in, item.recent_out, -q.demand_pct
        ));
    }

    if q.till_pct < 0 {
        reasons.push(format!(
            "Money's tight: {till} acorns in the till, and I'm comfortable at {}. I can only offer {}% of what I'd like.",
            temperament.comfortable_till,
            100 + q.till_pct
        ));
    }

    reasons.push(format!(
        "So I'll charge you {} and pay you {}. The gap is how I eat.",
        q.shop_charges, q.shop_pays
    ));
    reasons
}

#[cfg(test)]
mod tests {
    use super::*;

    const CALM: Temperament = Temperament { margin_pct: 10, comfortable_till: 1_000 };

    fn item(stock: u32) -> ItemState {
        ItemState { base: 100, stock, target: 100, recent_in: 0, recent_out: 0 }
    }

    #[test]
    fn empty_shelf_doubles_the_price() {
        assert_eq!(quote(&item(0), 1_000, &CALM).fair, 200);
    }

    #[test]
    fn balanced_shelf_gives_the_base_price() {
        let q = quote(&item(100), 1_000, &CALM);
        assert_eq!(q.fair, 100);
        assert_eq!(q.shop_charges, 110);
        assert_eq!(q.shop_pays, 90);
    }

    #[test]
    fn flooding_makes_goods_cheap() {
        assert_eq!(quote(&item(200), 1_000, &CALM).fair, 65);
        assert_eq!(quote(&item(400), 1_000, &CALM).fair, 40);
        assert_eq!(quote(&item(5_000), 1_000, &CALM).fair, 40);
    }

    #[test]
    fn recent_dumping_lowers_the_price_and_buying_raises_it() {
        let dumped = ItemState { recent_in: 100, ..item(100) };
        let wanted = ItemState { recent_out: 100, ..item(100) };
        assert_eq!(quote(&dumped, 1_000, &CALM).fair, 75);
        assert_eq!(quote(&wanted, 1_000, &CALM).fair, 125);
    }

    #[test]
    fn a_poor_shop_offers_less_but_charges_the_same() {
        let rich = quote(&item(100), 1_000, &CALM);
        let poor = quote(&item(100), 0, &CALM);
        assert_eq!(poor.shop_charges, rich.shop_charges);
        assert_eq!(poor.shop_pays, 36);
    }

    #[test]
    fn prices_never_reach_zero() {
        let cheap = ItemState { base: 1, stock: 10_000, target: 1, recent_in: 10_000, recent_out: 0 };
        let q = quote(&cheap, 0, &CALM);
        assert!(q.shop_pays >= 1 && q.shop_charges >= 1);
    }

    #[test]
    fn a_shop_never_pays_more_than_it_charges() {
        for stock in (0..2_000).step_by(37) {
            for till in (0..1_200).step_by(53) {
                let q = quote(&item(stock), till, &CALM);
                assert!(q.shop_pays <= q.shop_charges, "stock {stock} till {till}");
            }
        }
    }
}
