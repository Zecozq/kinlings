//! How Kinlings inherit. Each trait comes as a pair of alleles, one from each
//! parent. Only the stronger shows, so a plain Kinling can carry a rare trait
//! and pass it on.
//!
//! Powers and stats are different. A baby keeps every power both parents have,
//! and always comes out stronger than the stronger parent, so a family line
//! never stops getting better.

use crate::items;
use crate::rng::Rng;

pub const HEAD: usize = 0;
pub const HORN: usize = 1;
pub const WING: usize = 2;
pub const TAIL: usize = 3;
pub const PATTERN: usize = 4;
pub const EYES: usize = 5;
pub const MAIN_COLOR: usize = 6;
pub const ACCENT_COLOR: usize = 7;
pub const LOCI: usize = 8;

/// How many alleles each locus has.
pub const ALLELES: [u8; LOCI] = [5, 6, 5, 5, 6, 4, 16, 16];

/// Alleles listed strongest first. Commoner traits overpower rarer ones.
pub const DOMINANCE: [&[u8]; LOCI] = [
    &[0, 1, 2, 3, 4],
    &[0, 1, 3, 4, 2, 5],
    &[0, 1, 2, 4, 3],
    &[0, 1, 2, 3, 4],
    &[0, 1, 2, 3, 4, 5],
    &[0, 1, 2, 3],
    &[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    &[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
];

/// Chance in 1,000 that one allele changes at random.
pub const MUTATION_PER_MILLE: u32 = 40;
/// Chance in 1,000 that a parent's last meal writes its trait into the egg.
pub const FOOD_PER_MILLE: u32 = 180;
/// Chance in 1,000 of a shiny hatch, unless a parent is shiny.
pub const SHINY_PER_MILLE: u32 = 8;
pub const SHINY_PARENT_PER_MILLE: u32 = 120;

pub const PACKED_LEN: usize = 25;

// Race powers. A Kinling holds them as bits in `Genes::powers`.
pub const FIRE: usize = 0;
pub const FROST: usize = 1;
pub const BOLT: usize = 2;
pub const DASH: usize = 3;
pub const SHIELD: usize = 4;
pub const VINE: usize = 5;
pub const BLINK: usize = 6;
pub const MEND: usize = 7;
pub const POWER_COUNT: usize = 8;

/// What a baby adds to the better parent's stat: this much at least...
pub const GROWTH_MIN: u16 = 2;
/// ...plus a roll below this.
pub const GROWTH_SPREAD: u32 = 5;

/// Chance in 1,000 that a pairing wakes a power neither parent had.
pub const AWAKEN_PER_MILLE: u32 = 60;
/// Chance in 1,000 that the food served at a pairing wakes its power.
pub const FOOD_POWER_PER_MILLE: u32 = 250;
/// The same for the rare foods, which are far more potent.
pub const RARE_FOOD_POWER_PER_MILLE: u32 = 550;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Genes {
    pub alleles: [[u8; 2]; LOCI],
    pub speed: u16,
    pub stamina: u16,
    pub luck: u16,
    pub shiny: bool,
    /// One bit per power this Kinling can use in a race.
    pub powers: u16,
}

impl Genes {
    pub fn pack(&self) -> [u8; PACKED_LEN] {
        let mut out = [0u8; PACKED_LEN];
        for (locus, pair) in self.alleles.iter().enumerate() {
            out[locus * 2] = pair[0];
            out[locus * 2 + 1] = pair[1];
        }
        out[16..18].copy_from_slice(&self.speed.to_le_bytes());
        out[18..20].copy_from_slice(&self.stamina.to_le_bytes());
        out[20..22].copy_from_slice(&self.luck.to_le_bytes());
        out[22] = self.shiny as u8;
        out[23..25].copy_from_slice(&self.powers.to_le_bytes());
        out
    }

    pub fn unpack(bytes: &[u8; PACKED_LEN]) -> Self {
        let mut alleles = [[0u8; 2]; LOCI];
        for (locus, pair) in alleles.iter_mut().enumerate() {
            *pair = [bytes[locus * 2], bytes[locus * 2 + 1]];
        }
        Genes {
            alleles,
            speed: u16::from_le_bytes([bytes[16], bytes[17]]),
            stamina: u16::from_le_bytes([bytes[18], bytes[19]]),
            luck: u16::from_le_bytes([bytes[20], bytes[21]]),
            shiny: bytes[22] != 0,
            powers: u16::from_le_bytes([bytes[23], bytes[24]]),
        }
    }

    /// The trait that actually shows at a locus.
    pub fn shows(&self, locus: usize) -> u8 {
        let [a, b] = self.alleles[locus];
        let rank = |allele: u8| DOMINANCE[locus].iter().position(|&x| x == allele).unwrap_or(99);
        if rank(a) <= rank(b) {
            a
        } else {
            b
        }
    }

    /// Species is what you can see: head, horns, wings and tail.
    pub fn species(&self) -> u16 {
        self.shows(HEAD) as u16 * 150
            + self.shows(HORN) as u16 * 25
            + self.shows(WING) as u16 * 5
            + self.shows(TAIL) as u16
    }
}

pub const SPECIES_COUNT: u16 = 750;

/// Builds a species number from its visible parts.
pub const fn species_of(head: u16, horn: u16, wing: u16, tail: u16) -> u16 {
    head * 150 + horn * 25 + wing * 5 + tail
}

/// The fifteen species that already have names when the valley opens.
pub const NAMED_SPECIES: [(u16, &str); 15] = [
    (species_of(0, 1, 1, 0), "Dragon"),
    (species_of(0, 0, 0, 0), "Drake"),
    (species_of(2, 2, 0, 2), "Unicorn"),
    (species_of(2, 0, 2, 2), "Pegasus"),
    (species_of(2, 2, 2, 2), "Alicorn"),
    (species_of(2, 3, 0, 2), "Kirin"),
    (species_of(3, 0, 2, 2), "Griffin"),
    (species_of(3, 5, 3, 4), "Phoenix"),
    (species_of(3, 5, 2, 3), "Roc"),
    (species_of(1, 0, 0, 1), "Kitsune"),
    (species_of(1, 3, 0, 1), "Jackalope"),
    (species_of(1, 0, 1, 0), "Manticore"),
    (species_of(1, 4, 1, 0), "Chimera"),
    (species_of(4, 0, 0, 1), "Yeti"),
    (species_of(4, 4, 0, 0), "Golem"),
];

/// The species new players can get from their first egg.
pub const STARTERS: [u16; 6] = [
    NAMED_SPECIES[0].0,
    NAMED_SPECIES[2].0,
    NAMED_SPECIES[6].0,
    NAMED_SPECIES[7].0,
    NAMED_SPECIES[9].0,
    NAMED_SPECIES[13].0,
];

pub fn species_parts(species: u16) -> [u8; 4] {
    [
        (species / 150) as u8,
        (species % 150 / 25) as u8,
        (species % 25 / 5) as u8,
        (species % 5) as u8,
    ]
}

/// The trait a food can write into an egg.
fn food_effect(food: u16) -> Option<(usize, u8)> {
    match food {
        items::SUNWHEAT => Some((TAIL, 2)),
        items::DEWBEAN => Some((WING, 4)),
        items::EMBERROOT => Some((WING, 3)),
        items::FROSTBERRY => Some((PATTERN, 4)),
        items::MOONMELON => Some((HORN, 2)),
        items::STARFIG => Some((PATTERN, 5)),
        _ => None,
    }
}

/// The power a food can wake in an egg, and the chance in 1,000 that it does.
pub fn food_power(food: u16) -> Option<(usize, u32)> {
    match food {
        items::SUNWHEAT => Some((MEND, FOOD_POWER_PER_MILLE)),
        items::DEWBEAN => Some((VINE, FOOD_POWER_PER_MILLE)),
        items::EMBERROOT => Some((FIRE, FOOD_POWER_PER_MILLE)),
        items::FROSTBERRY => Some((FROST, FOOD_POWER_PER_MILLE)),
        items::MOONMELON => Some((BLINK, FOOD_POWER_PER_MILLE)),
        items::STARFIG => Some((BOLT, FOOD_POWER_PER_MILLE)),
        items::GLOWCAP => Some((SHIELD, RARE_FOOD_POWER_PER_MILLE)),
        items::DRAGONFRUIT => Some((DASH, RARE_FOOD_POWER_PER_MILLE)),
        _ => None,
    }
}

/// Each kind of head is born with its own power.
fn birth_power(head: u8) -> usize {
    match head {
        0 => FIRE,
        1 => BLINK,
        2 => SHIELD,
        3 => BOLT,
        _ => FROST,
    }
}

/// A brand-new founder of the given species, with random hidden traits.
pub fn founder(species: u16, rng: &mut Rng) -> Genes {
    let parts = species_parts(species);
    let mut alleles = [[0u8; 2]; LOCI];
    for (locus, pair) in alleles.iter_mut().enumerate() {
        let (shown, hidden) = if locus <= TAIL {
            // Visible parts are locked in. The hidden copy is the same or rarer.
            let shown = parts[locus];
            (shown, weakest_of(locus, shown, rng.below(ALLELES[locus] as u32) as u8))
        } else {
            let a = rng.below(ALLELES[locus] as u32) as u8;
            let b = rng.below(ALLELES[locus] as u32) as u8;
            (a, b)
        };
        *pair = if rng.below(2) == 0 { [shown, hidden] } else { [hidden, shown] };
    }
    Genes {
        alleles,
        speed: 30 + rng.below(16) as u16,
        stamina: 30 + rng.below(16) as u16,
        luck: 20 + rng.below(21) as u16,
        shiny: rng.below(1_000) < SHINY_PER_MILLE,
        powers: founder_powers(parts[HEAD], rng),
    }
}

/// One power from its head, and an even chance of a second that any kind can have.
fn founder_powers(head: u8, rng: &mut Rng) -> u16 {
    let mut powers = 1u16 << birth_power(head);
    if rng.below(2) == 0 {
        powers |= 1 << [DASH, VINE, MEND][rng.below(3) as usize];
    }
    powers
}

fn weakest_of(locus: usize, shown: u8, candidate: u8) -> u8 {
    let rank = |allele: u8| DOMINANCE[locus].iter().position(|&x| x == allele).unwrap_or(99);
    if rank(candidate) >= rank(shown) {
        candidate
    } else {
        shown
    }
}

/// A baby from two parents. `food` is what was served at the pairing.
pub fn inherit(mother: &Genes, father: &Genes, food: u16, rng: &mut Rng) -> Genes {
    let mut alleles = [[0u8; 2]; LOCI];
    for locus in 0..LOCI {
        let from_mother = mother.alleles[locus][rng.below(2) as usize];
        let from_father = father.alleles[locus][rng.below(2) as usize];
        alleles[locus] = [mutate(locus, from_mother, rng), mutate(locus, from_father, rng)];
    }
    if let Some((locus, allele)) = food_effect(food) {
        if rng.below(1_000) < FOOD_PER_MILLE {
            // Both copies, so the food's trait reliably shows.
            alleles[locus] = [allele, allele];
        }
    }
    // Every power from both parents comes down, and sometimes a new one wakes.
    let mut powers = mother.powers | father.powers;
    if let Some((power, per_mille)) = food_power(food) {
        if rng.below(1_000) < per_mille {
            powers |= 1 << power;
        }
    }
    if food == items::HONEY {
        // Stardust Honey always wakes a power neither parent has.
        let missing = (0..POWER_COUNT).filter(|p| powers >> p & 1 == 0).count() as u32;
        if missing > 0 {
            let pick = rng.below(missing) as usize;
            let power = (0..POWER_COUNT).filter(|p| powers >> p & 1 == 0).nth(pick).expect("a missing power");
            powers |= 1 << power;
        }
    }
    if rng.below(1_000) < AWAKEN_PER_MILLE {
        powers |= 1 << rng.below(POWER_COUNT as u32);
    }
    let shiny_chance = if mother.shiny || father.shiny || food == items::HONEY {
        SHINY_PARENT_PER_MILLE
    } else {
        SHINY_PER_MILLE
    };
    Genes {
        alleles,
        speed: child_stat(mother.speed, father.speed, rng),
        stamina: child_stat(mother.stamina, father.stamina, rng),
        luck: child_stat(mother.luck, father.luck, rng),
        shiny: rng.below(1_000) < shiny_chance,
        powers,
    }
}

fn mutate(locus: usize, allele: u8, rng: &mut Rng) -> u8 {
    if rng.below(1_000) < MUTATION_PER_MILLE {
        rng.below(ALLELES[locus] as u32) as u8
    } else {
        allele
    }
}

/// Always better than the better parent, so every generation is stronger. Stats
/// have no ceiling. The race turns them into speed on a curve that flattens out.
fn child_stat(a: u16, b: u16, rng: &mut Rng) -> u16 {
    a.max(b).saturating_add(GROWTH_MIN + rng.below(GROWTH_SPREAD) as u16)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pure(species: u16) -> Genes {
        let parts = species_parts(species);
        let mut alleles = [[0u8; 2]; LOCI];
        for locus in 0..4 {
            alleles[locus] = [parts[locus]; 2];
        }
        Genes { alleles, speed: 50, stamina: 50, luck: 50, shiny: false, powers: 1 << FIRE }
    }

    #[test]
    fn genes_survive_packing() {
        let mut rng = Rng::from_seed(b"pack");
        let g = founder(NAMED_SPECIES[2].0, &mut rng);
        assert_eq!(Genes::unpack(&g.pack()), g);
    }

    #[test]
    fn named_species_are_all_different_and_in_range() {
        let mut seen = std::collections::HashSet::new();
        for (species, _) in NAMED_SPECIES {
            assert!(species < SPECIES_COUNT);
            assert!(seen.insert(species));
        }
    }

    #[test]
    fn founders_show_the_species_they_were_made_as() {
        for seed in 0u32..200 {
            let mut rng = Rng::from_seed(&seed.to_le_bytes());
            for species in STARTERS {
                assert_eq!(founder(species, &mut rng).species(), species);
            }
        }
    }

    #[test]
    fn species_number_round_trips() {
        for species in 0..SPECIES_COUNT {
            let [h, o, w, t] = species_parts(species);
            assert_eq!(species_of(h as u16, o as u16, w as u16, t as u16), species);
        }
    }

    #[test]
    fn the_stronger_allele_shows() {
        let mut g = pure(NAMED_SPECIES[0].0);
        g.alleles[HORN] = [2, 1];
        assert_eq!(g.shows(HORN), 1, "dragon horns beat the unicorn horn");
        g.alleles[HORN] = [2, 2];
        assert_eq!(g.shows(HORN), 2, "two rare copies are needed to show it");
    }

    #[test]
    fn two_plain_parents_can_hatch_a_rare_trait() {
        let mut carrier = pure(NAMED_SPECIES[0].0);
        carrier.alleles[HORN] = [1, 2];
        assert_eq!(carrier.shows(HORN), 1);
        let mut rare = 0;
        for seed in 0u32..2_000 {
            let mut rng = Rng::from_seed(&seed.to_le_bytes());
            if inherit(&carrier, &carrier, 0, &mut rng).shows(HORN) == 2 {
                rare += 1;
            }
        }
        assert!((350..650).contains(&rare), "about one in four, got {rare} of 2000");
    }

    #[test]
    fn food_nudges_the_egg() {
        let parent = pure(NAMED_SPECIES[2].0);
        let count = |food| {
            (0u32..4_000)
                .filter(|seed| {
                    let mut rng = Rng::from_seed(&seed.to_le_bytes());
                    inherit(&parent, &parent, food, &mut rng).shows(WING) == 3
                })
                .count()
        };
        assert!(count(items::EMBERROOT) > count(items::SUNWHEAT) * 3);
    }

    #[test]
    fn cross_breeding_finds_new_species() {
        let dragon = pure(NAMED_SPECIES[0].0);
        let unicorn = pure(NAMED_SPECIES[2].0);
        let named: Vec<u16> = NAMED_SPECIES.iter().map(|s| s.0).collect();
        let mut first_generation = Vec::new();
        for seed in 0u32..200 {
            let mut rng = Rng::from_seed(&seed.to_le_bytes());
            first_generation.push(inherit(&dragon, &unicorn, 0, &mut rng));
        }
        let mut brand_new = std::collections::HashSet::new();
        for seed in 0u32..3_000 {
            let mut rng = Rng::from_seed(&seed.to_le_bytes());
            let a = first_generation[rng.below(200) as usize];
            let b = first_generation[rng.below(200) as usize];
            let species = inherit(&a, &b, 0, &mut rng).species();
            if !named.contains(&species) {
                brand_new.insert(species);
            }
        }
        assert!(brand_new.len() >= 10, "only {} new species", brand_new.len());
    }

    #[test]
    fn every_baby_is_stronger_than_both_parents() {
        let mut high = pure(NAMED_SPECIES[0].0);
        high.speed = 90;
        high.stamina = 70;
        high.luck = 60;
        let low = pure(NAMED_SPECIES[0].0);
        for seed in 0u32..500 {
            let mut rng = Rng::from_seed(&seed.to_le_bytes());
            let child = inherit(&high, &low, 0, &mut rng);
            assert!(child.speed > high.speed);
            assert!(child.stamina > high.stamina);
            assert!(child.luck > high.luck);
        }
    }

    #[test]
    fn a_family_line_keeps_climbing_for_a_hundred_generations() {
        let mut rng = Rng::from_seed(b"line");
        let mut parent = pure(NAMED_SPECIES[0].0);
        let mut mate = pure(NAMED_SPECIES[2].0);
        for _ in 0..100 {
            let child = inherit(&parent, &mate, 0, &mut rng);
            assert!(child.speed > parent.speed.max(mate.speed));
            mate = parent;
            parent = child;
        }
        assert!(parent.speed >= 250, "only reached {}", parent.speed);
    }

    #[test]
    fn stats_never_wrap_around() {
        let mut top = pure(NAMED_SPECIES[0].0);
        top.speed = u16::MAX;
        top.stamina = u16::MAX;
        top.luck = u16::MAX;
        let mut rng = Rng::from_seed(b"top");
        assert_eq!(inherit(&top, &top, 0, &mut rng).speed, u16::MAX);
    }

    #[test]
    fn babies_keep_every_power_from_both_parents() {
        let mut mother = pure(NAMED_SPECIES[0].0);
        mother.powers = 1 << FIRE | 1 << DASH;
        let mut father = pure(NAMED_SPECIES[2].0);
        father.powers = 1 << SHIELD | 1 << VINE;
        let both = mother.powers | father.powers;
        for seed in 0u32..1_000 {
            let mut rng = Rng::from_seed(&seed.to_le_bytes());
            assert_eq!(inherit(&mother, &father, 0, &mut rng).powers & both, both);
        }
    }

    #[test]
    fn food_can_wake_a_power() {
        let parent = pure(NAMED_SPECIES[2].0);
        let woke = |food| {
            (0u32..4_000)
                .filter(|seed| {
                    let mut rng = Rng::from_seed(&seed.to_le_bytes());
                    inherit(&parent, &parent, food, &mut rng).powers >> FROST & 1 == 1
                })
                .count()
        };
        assert!(woke(items::FROSTBERRY) > woke(items::SUNWHEAT) * 3);
    }

    #[test]
    fn stardust_honey_always_wakes_a_new_power() {
        let parent = pure(NAMED_SPECIES[2].0);
        for seed in 0u32..500 {
            let mut rng = Rng::from_seed(&seed.to_le_bytes());
            let baby = inherit(&parent, &parent, items::HONEY, &mut rng);
            assert!(baby.powers.count_ones() > parent.powers.count_ones());
        }
        // Even with every power already, it does no harm.
        let mut full = parent;
        full.powers = (1 << POWER_COUNT) - 1;
        let mut rng = Rng::from_seed(b"full");
        assert_eq!(inherit(&full, &full, items::HONEY, &mut rng).powers, full.powers);
    }

    #[test]
    fn each_head_is_born_with_its_own_power() {
        for seed in 0u32..100 {
            let mut rng = Rng::from_seed(&seed.to_le_bytes());
            let dragon = founder(NAMED_SPECIES[0].0, &mut rng);
            assert_eq!(dragon.powers >> FIRE & 1, 1);
            let yeti = founder(NAMED_SPECIES[13].0, &mut rng);
            assert_eq!(yeti.powers >> FROST & 1, 1);
        }
    }
}
