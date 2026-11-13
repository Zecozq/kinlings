//! What the valley remembers.

use kinlings_core::farm::Plot;
use kinlings_core::genes::PACKED_LEN;
use kinlings_core::shop::{Shelf, Shop};
use near_sdk::{near, AccountId};

/// A holder's fungible items, kept small on purpose: storage is what costs money.
#[near(serializers = [borsh])]
#[derive(Clone, Default, Debug)]
pub struct Bag(pub Vec<(u16, u32)>);

impl Bag {
    pub fn get(&self, item: u16) -> u32 {
        self.0.iter().find(|e| e.0 == item).map_or(0, |e| e.1)
    }

    pub fn add(&mut self, item: u16, quantity: u32) {
        match self.0.iter_mut().find(|e| e.0 == item) {
            Some(entry) => entry.1 += quantity,
            None => self.0.push((item, quantity)),
        }
    }

    /// Returns false, changing nothing, if there is not enough.
    pub fn take(&mut self, item: u16, quantity: u32) -> bool {
        let Some(index) = self.0.iter().position(|e| e.0 == item) else {
            return quantity == 0;
        };
        if self.0[index].1 < quantity {
            return false;
        }
        self.0[index].1 -= quantity;
        if self.0[index].1 == 0 {
            self.0.swap_remove(index);
        }
        true
    }
}

#[near(serializers = [borsh])]
#[derive(Clone, Copy, Default, Debug)]
pub struct SavedPlot {
    pub crop: u8,
    pub ready_at: u32,
    pub waterings: u8,
}

impl From<SavedPlot> for Plot {
    fn from(p: SavedPlot) -> Plot {
        Plot { crop: p.crop as u16, ready_at: p.ready_at, waterings: p.waterings }
    }
}

impl From<Plot> for SavedPlot {
    fn from(p: Plot) -> SavedPlot {
        SavedPlot { crop: p.crop as u8, ready_at: p.ready_at, waterings: p.waterings }
    }
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Player {
    pub name: String,
    pub index: u32,
    pub elder: bool,
    pub seen: u32,
    pub xp: u32,
    pub plots: Vec<SavedPlot>,
    pub mastery: [u16; 6],
    pub helps_day: u16,
    pub helps: u8,
    pub kins: Vec<u32>,
    pub eggs: Vec<u32>,
    pub last_top_up: u32,
    /// Where NEAR earnings go, if not to this farm's own account.
    pub wallet: Option<AccountId>,
    /// All the NEAR this player has ever earned, in yoctoNEAR.
    pub near_earned: u128,
    /// Kinlings this player has on hire.
    pub rented: Vec<u32>,
    /// How many races this player has run.
    pub races: u32,
    /// The NEAR Social account this player linked, on mainnet, as they claim it.
    /// The browser checks near.social says the same before calling it verified.
    pub social: Option<String>,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Kin {
    pub name: String,
    pub account: AccountId,
    pub owner: AccountId,
    pub genes: [u8; PACKED_LEN],
    pub mother: u32,
    pub father: u32,
    pub generation: u32,
    pub xp: u32,
    pub rest_until: u32,
    pub stud_fee: u32,
    pub wins: u32,
    /// The first few children, for the family tree.
    pub children: Vec<u32>,
    /// How many children it has ever had.
    pub child_count: u32,
    /// True between the hatch roll and the account actually existing.
    pub unborn: bool,
    pub food: u8,
    /// Price to hire, in thousandths of a NEAR. Zero means it isn't for hire.
    pub rent_milli: u32,
    pub renter: Option<AccountId>,
    pub rented_until: u32,
    /// When the Old Oak will next add to this Kinling's race.
    pub race_ready_at: u32,
}

impl Kin {
    pub fn rented_out(&self, now: u32) -> bool {
        self.renter.is_some() && self.rented_until > now
    }

    /// Who can race and pair this Kinling right now.
    pub fn controlled_by(&self, who: &AccountId, now: u32) -> bool {
        match &self.renter {
            Some(renter) if self.rented_until > now => renter == who,
            _ => self.owner == *who,
        }
    }
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Egg {
    pub owner: AccountId,
    pub mother: u32,
    pub father: u32,
    pub food: u8,
    pub ready_at: u32,
    pub warms: u8,
    pub hatching: bool,
    /// Which kind of founder an egg without parents becomes.
    pub wild: bool,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Species {
    pub name: String,
    /// Player index plus one. Zero means it was named before the valley opened.
    pub finder: u32,
    pub named: bool,
    pub count: u32,
}

/// A shop's memory. Its money and stock live in its own NEP-245 balances, so
/// `till` and `stock` are rebuilt from the ledger whenever the shop is used.
#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct ShopRecord {
    pub account: AccountId,
    pub recent: [(u32, u32); 2],
    pub last_tick: u32,
    pub closed: bool,
    pub investor_pot: u32,
    pub shares: u32,
    pub per_share: u128,
}

impl ShopRecord {
    pub fn as_shop(&self, till: u32, stocks: [u32; 2]) -> Shop {
        let shelf = |slot: usize| Shelf {
            stock: stocks[slot],
            recent_in: self.recent[slot].0,
            recent_out: self.recent[slot].1,
        };
        Shop {
            till,
            shelves: [shelf(0), shelf(1)],
            last_tick: self.last_tick,
            closed: self.closed,
            investor_pot: self.investor_pot,
        }
    }

    pub fn absorb(&mut self, shop: &Shop) {
        self.recent = [
            (shop.shelves[0].recent_in, shop.shelves[0].recent_out),
            (shop.shelves[1].recent_in, shop.shelves[1].recent_out),
        ];
        self.last_tick = shop.last_tick;
        self.closed = shop.closed;
        self.investor_pot = shop.investor_pot;
    }
}

#[near(serializers = [borsh])]
#[derive(Clone, Copy, Debug, Default)]
pub struct Investment {
    pub shares: u32,
    pub settled_per_share: u128,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Listing {
    pub seller: AccountId,
    /// 0: a stack of items. 1: an egg. 2: a Kinling.
    pub kind: u8,
    pub id: u32,
    pub quantity: u32,
    /// The price of one: in acorns, or in thousandths of a NEAR if `in_near`.
    pub unit_price: u32,
    pub in_near: bool,
}

/// A race a player has started and not handed in yet.
#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Run {
    pub kin: u32,
    pub rivals: [u32; 5],
    pub seed: [u8; 32],
    /// The racers' numbers as they were at the start, so that nothing changing
    /// in the valley mid-race can change how the race plays back.
    pub entrants: Vec<u8>,
    pub started: u32,
    pub ease: u8,
    pub rested: bool,
}

/// A race between real players for NEAR. See `challenges.rs`.
#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Challenge {
    pub host: AccountId,
    /// Every runner pays this, in thousandths of a NEAR.
    pub fee_milli: u32,
    pub seats: u8,
    pub opened: u32,
    /// The course, the same for everyone.
    pub seed: [u8; 32],
    /// The Elders' Kinlings everyone races against, as they were at the start.
    pub field: Vec<u32>,
    pub field_entrants: Vec<u8>,
    pub entries: Vec<ChallengeEntry>,
    pub settled: bool,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct ChallengeEntry {
    pub player: AccountId,
    /// Who paid the fee, and gets it back if the challenge comes to nothing.
    pub payer: AccountId,
    pub kin: u32,
    /// When this runner began their one run, or zero if they haven't yet.
    pub started: u32,
    /// Their Kinling's numbers when they began.
    pub entrant: Vec<u8>,
    /// Their finishing tick, `DID_NOT_FINISH`, or zero if not handed in yet.
    pub ticks: u32,
    /// Their moves, so later runners can race their ghost.
    pub moves: Vec<u16>,
    /// What they won, in yoctoNEAR.
    pub prize: u128,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct FeedItem {
    pub at: u32,
    pub kind: u8,
    pub who: String,
    pub what: String,
}
