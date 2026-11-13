//! Every item in the valley and the fixed numbers of the game.

/// Numeric ids keep balances tiny on chain. `token_id` gives the NEP-245 name.
pub const ACORN: u16 = 0;
pub const SUNWHEAT: u16 = 1;
pub const DEWBEAN: u16 = 2;
pub const EMBERROOT: u16 = 3;
pub const FROSTBERRY: u16 = 4;
pub const MOONMELON: u16 = 5;
pub const STARFIG: u16 = 6;
pub const TONIC: u16 = 7;
pub const WILD_EGG: u16 = 8;
/// The rare foods. Nobody can plant them and no shop sells them: they turn up
/// at harvests and races, and players trade them with each other.
pub const GLOWCAP: u16 = 9;
pub const DRAGONFRUIT: u16 = 10;
pub const HONEY: u16 = 11;

/// There are exactly this many acorns, forever.
pub const TOTAL_ACORNS: u32 = 10_000_000;

#[derive(Clone, Copy, Debug)]
pub struct Crop {
    pub item: u16,
    pub name: &'static str,
    /// Seconds from planting to ripe, unwatered.
    pub grow_secs: u32,
    /// Units per harvest. One unit is needed to plant again.
    pub harvest: u32,
    /// Farmer rank needed to plant it.
    pub rank: u8,
}

pub const CROPS: [Crop; 6] = [
    Crop { item: SUNWHEAT, name: "Sunwheat", grow_secs: 40, harvest: 2, rank: 1 },
    Crop { item: DEWBEAN, name: "Dewbean", grow_secs: 70, harvest: 2, rank: 1 },
    Crop { item: EMBERROOT, name: "Emberroot", grow_secs: 120, harvest: 2, rank: 2 },
    Crop { item: FROSTBERRY, name: "Frostberry", grow_secs: 180, harvest: 2, rank: 3 },
    Crop { item: MOONMELON, name: "Moonmelon", grow_secs: 300, harvest: 2, rank: 5 },
    Crop { item: STARFIG, name: "Starfig", grow_secs: 480, harvest: 2, rank: 7 },
];

/// Something a Kinling can eat. Every food can raise a Kinling only so far:
/// past `level_cap` it does nothing, so the higher levels need finer food.
#[derive(Clone, Copy, Debug)]
pub struct Food {
    pub item: u16,
    pub name: &'static str,
    /// Growth from eating one.
    pub xp: u32,
    /// The highest level this food can bring a Kinling to.
    pub level_cap: u8,
}

pub const FOODS: [Food; 9] = [
    Food { item: SUNWHEAT, name: "Sunwheat", xp: 2, level_cap: 3 },
    Food { item: DEWBEAN, name: "Dewbean", xp: 3, level_cap: 5 },
    Food { item: EMBERROOT, name: "Emberroot", xp: 5, level_cap: 8 },
    Food { item: FROSTBERRY, name: "Frostberry", xp: 8, level_cap: 11 },
    Food { item: MOONMELON, name: "Moonmelon", xp: 13, level_cap: 14 },
    Food { item: STARFIG, name: "Starfig", xp: 20, level_cap: 16 },
    Food { item: GLOWCAP, name: "Glowcap", xp: 32, level_cap: 20 },
    Food { item: DRAGONFRUIT, name: "Dragonfruit", xp: 64, level_cap: 25 },
    Food { item: HONEY, name: "Stardust Honey", xp: 120, level_cap: 30 },
];

pub fn food(item: u16) -> Option<&'static Food> {
    FOODS.iter().find(|f| f.item == item)
}

/// A rare find: per 1,000 tries, the chance of each rare food.
#[derive(Clone, Copy, Debug)]
pub struct Find {
    pub item: u16,
    pub per_mille: u32,
}

/// What can turn up when a crop is harvested, rarest first.
pub fn harvest_finds(crop: u16) -> &'static [Find] {
    const BERRY_FINDS: [Find; 1] = [Find { item: GLOWCAP, per_mille: 80 }];
    const FIG_FINDS: [Find; 3] = [
        Find { item: HONEY, per_mille: 10 },
        Find { item: DRAGONFRUIT, per_mille: 50 },
        Find { item: GLOWCAP, per_mille: 60 },
    ];
    match crop {
        FROSTBERRY | MOONMELON => &BERRY_FINDS,
        STARFIG => &FIG_FINDS,
        _ => &[],
    }
}

/// What a rested Kinling can bring home from winning a race, rarest first.
pub const RACE_WIN_FINDS: [Find; 2] = [Find { item: HONEY, per_mille: 40 }, Find { item: DRAGONFRUIT, per_mille: 250 }];

/// Picks at most one find from a roll in 0..1000.
pub fn pick_find(finds: &[Find], roll: u32) -> Option<u16> {
    let mut edge = 0;
    for find in finds {
        edge += find.per_mille;
        if roll < edge {
            return Some(find.item);
        }
    }
    None
}

/// Growing one crop again and again makes you better at it: extra units per
/// harvest once you have brought in this many of that crop.
pub const MASTERY_HARVESTS: [u32; 3] = [6, 20, 50];

/// Extra units per harvest for a farmer with this many past harvests.
pub fn mastery_bonus(harvests: u32) -> u32 {
    MASTERY_HARVESTS.iter().filter(|&&needed| harvests >= needed).count() as u32
}

pub fn crop(item: u16) -> Option<&'static Crop> {
    if (SUNWHEAT..=STARFIG).contains(&item) {
        Some(&CROPS[(item - SUNWHEAT) as usize])
    } else {
        None
    }
}

/// The NEP-245 token id of a fungible item.
pub fn token_id(item: u16) -> &'static str {
    match item {
        ACORN => "acorn",
        SUNWHEAT => "sunwheat",
        DEWBEAN => "dewbean",
        EMBERROOT => "emberroot",
        FROSTBERRY => "frostberry",
        MOONMELON => "moonmelon",
        STARFIG => "starfig",
        TONIC => "tonic",
        WILD_EGG => "wildegg",
        GLOWCAP => "glowcap",
        DRAGONFRUIT => "dragonfruit",
        HONEY => "honey",
        _ => "",
    }
}

pub const ITEM_COUNT: u16 = 12;

/// Rare foods are never sold in shops, only found and traded.
pub fn is_rare(item: u16) -> bool {
    (GLOWCAP..=HONEY).contains(&item)
}

pub fn item_from_token(token: &str) -> Option<u16> {
    (0..ITEM_COUNT).find(|&item| token_id(item) == token)
}

// ----- Pacing -----------------------------------------------------------

/// Farmer rank from experience. Rank 1 is where everyone starts.
pub const FARMER_RANKS: [u32; 10] = [0, 12, 35, 80, 150, 260, 420, 650, 950, 1_400];
/// Kinling level from growth: the growth needed to reach each level, 1 to 30.
pub const KIN_LEVELS: [u32; 30] = [
    0, 4, 10, 20, 35, 55, 80, 110, 150, 200, //
    260, 330, 410, 500, 600, 720, 860, 1_020, 1_200, 1_400, //
    1_640, 1_920, 2_240, 2_600, 3_000, 3_500, 4_100, 4_800, 5_600, 6_500,
];
pub const MAX_KIN_LEVEL: u8 = KIN_LEVELS.len() as u8;
/// A Kinling is grown from this level, and may race and breed.
pub const ADULT_LEVEL: u8 = 3;
/// Racing helps a Kinling grow, but only up to this level. Past it, only food will do.
pub const RACE_LEVEL_CAP: u8 = 8;

pub fn level_for(xp: u32, table: &[u32]) -> u8 {
    table.iter().rposition(|&needed| xp >= needed).unwrap_or(0) as u8 + 1
}

/// Growth after gaining `gain`, where this source can bring a Kinling no
/// higher than `level_cap`. Never takes growth away.
pub fn grow(xp: u32, gain: u32, level_cap: u8) -> u32 {
    let ceiling = KIN_LEVELS[(level_cap.clamp(1, MAX_KIN_LEVEL) - 1) as usize];
    if xp >= ceiling {
        xp
    } else {
        xp.saturating_add(gain).min(ceiling)
    }
}

/// True if this food would still help a Kinling with this much growth.
pub fn food_helps(food: &Food, xp: u32) -> bool {
    level_for(xp, &KIN_LEVELS) < food.level_cap
}

/// Rest after a pairing, before a Kinling can pair again.
pub const REST_SECS: u32 = 120;
/// How long an egg takes with no help.
pub const INCUBATE_SECS: u32 = 180;
/// Time off a hatch per warm from a person.
pub const WARM_SECS: u32 = 15;
/// Warmers counted per egg.
pub const MAX_WARMS: u8 = 8;
/// Time off a hatch from a Warmth Tonic.
pub const TONIC_SECS: u32 = 60;
/// A watered crop loses this percentage of its remaining time.
pub const WATER_PCT: u32 = 25;

// ----- Money ------------------------------------------------------------

pub const WELCOME_ACORNS: u32 = 150;
pub const PAIRING_FEE: u32 = 60;
/// A practice race against the valley's Kinlings is free. What the Old Oak
/// puts up for a rested Kinling's race, at most, shared by the first three.
pub const RACE_BONUS: u32 = 60;
/// Crops a rested Kinling brings home for coming first, second or third.
pub const RACE_CROP_PRIZES: [u32; 3] = [3, 2, 1];
/// A Kinling is rested again this long after a boosted race. It can race
/// sooner, but the Oak only adds to rested Kinlings' races.
pub const RACE_REST_SECS: u32 = 60;
/// The Oak's race budget grows by this many acorns a second...
pub const RACE_BUDGET_PER_SEC: u32 = 1;
/// ...and holds at most this many.
pub const RACE_BUDGET_CAP: u32 = 6_000;
/// Growth a Kinling gets from running a race, and more for winning one.
pub const RACE_XP: u32 = 3;
pub const RACE_WIN_XP: u32 = 3;
/// Tax on trades between players, in percent.
pub const STALL_TAX_PCT: u32 = 2;
/// Acorns for helping a neighbour.
pub const HELP_ACORNS: u32 = 3;
/// Paid helps per day, so helping can't be farmed endlessly.
pub const DAILY_HELPS: u8 = 30;
/// Paid to the finder each time their discovered species is hatched again.
pub const SPECIES_ROYALTY: u32 = 8;
/// Of what a Kinling earns, the percentage to each parent.
pub const PARENT_SHARE_PCT: u32 = 10;
/// Of what a Kinling earns, the percentage to each grandparent.
pub const GRANDPARENT_SHARE_PCT: u32 = 3;
/// What more land costs, by plots already owned. Starts at 6 plots.
pub const LAND_COSTS: [u32; 3] = [480, 1_600, 4_400];
pub const STARTING_PLOTS: u8 = 6;
pub const PLOTS_PER_LAND: u8 = 2;

/// Gifts from the Old Oak shrink as it empties, so it can never go negative
/// and the economy steadies itself. Below this level it starts to tighten.
pub const OAK_COMFORT: u32 = 2_500_000;

/// A gift scaled by how full the Oak is.
pub fn oak_gift(amount: u32, oak: u32) -> u32 {
    if oak >= OAK_COMFORT {
        return amount.min(oak);
    }
    ((amount as u64 * oak as u64 / OAK_COMFORT as u64) as u32).min(oak)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_item_round_trips_through_its_token_id() {
        for item in 0..ITEM_COUNT {
            assert_eq!(item_from_token(token_id(item)), Some(item));
        }
        assert_eq!(item_from_token("nope"), None);
    }

    #[test]
    fn mastery_comes_with_practice() {
        assert_eq!(mastery_bonus(0), 0);
        assert_eq!(mastery_bonus(6), 1);
        assert_eq!(mastery_bonus(20), 2);
        assert_eq!(mastery_bonus(5_000), 3);
    }

    #[test]
    fn levels_start_at_one_and_stop_at_the_top() {
        assert_eq!(level_for(0, &FARMER_RANKS), 1);
        assert_eq!(level_for(12, &FARMER_RANKS), 2);
        assert_eq!(level_for(9_999, &FARMER_RANKS), 10);
        assert_eq!(level_for(0, &KIN_LEVELS), 1);
        assert_eq!(level_for(99_999, &KIN_LEVELS), 30);
        assert!(KIN_LEVELS.windows(2).all(|w| w[0] < w[1]));
    }

    #[test]
    fn each_food_raises_a_kinling_only_so_far() {
        let wheat = food(SUNWHEAT).unwrap();
        // Sunwheat stops at level 3, and never takes growth away.
        assert_eq!(grow(9, wheat.xp, wheat.level_cap), 10);
        assert_eq!(level_for(grow(9, wheat.xp, wheat.level_cap), &KIN_LEVELS), 3);
        assert!(!food_helps(wheat, 10));
        assert_eq!(grow(500, wheat.xp, wheat.level_cap), 500);
        // Honey goes all the way.
        let honey = food(HONEY).unwrap();
        assert!(food_helps(honey, 5_000));
        assert_eq!(grow(6_450, honey.xp, honey.level_cap), 6_500);
        assert!(!food_helps(honey, 6_500));
        // Finer food always helps for longer, and grows more.
        assert!(FOODS.windows(2).all(|w| w[0].level_cap < w[1].level_cap && w[0].xp < w[1].xp));
        assert_eq!(FOODS.last().unwrap().level_cap, MAX_KIN_LEVEL);
    }

    #[test]
    fn rare_foods_are_found_not_planted() {
        for item in [GLOWCAP, DRAGONFRUIT, HONEY] {
            assert!(is_rare(item) && crop(item).is_none() && food(item).is_some());
        }
        assert_eq!(pick_find(harvest_finds(SUNWHEAT), 0), None);
        assert_eq!(pick_find(harvest_finds(STARFIG), 0), Some(HONEY));
        assert_eq!(pick_find(harvest_finds(STARFIG), 10), Some(DRAGONFRUIT));
        assert_eq!(pick_find(harvest_finds(STARFIG), 60), Some(GLOWCAP));
        assert_eq!(pick_find(harvest_finds(STARFIG), 120), None);
        assert_eq!(pick_find(&RACE_WIN_FINDS, 289), Some(DRAGONFRUIT));
        assert_eq!(pick_find(&RACE_WIN_FINDS, 290), None);
    }

    #[test]
    fn oak_gifts_shrink_when_the_oak_is_low_and_never_exceed_it() {
        assert_eq!(oak_gift(40, 9_000_000), 40);
        assert_eq!(oak_gift(40, 1_250_000), 20);
        assert_eq!(oak_gift(40, 3), 0);
        assert_eq!(oak_gift(40, 0), 0);
    }
}
