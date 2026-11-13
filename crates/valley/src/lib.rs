//! The valley contract: every item in one NEP-245 ledger, and the game's rules.
//!
//! Prices, genetics, races and crops live in `kinlings-core`, which has no
//! blockchain code in it. This crate keeps the books and enforces who may do what.

mod actions;
mod challenges;
mod hatch;
mod ledger;
mod market;
mod races;
mod rentals;
mod state;
#[cfg(test)]
mod tests;
mod views;

use kinlings_core::genes::NAMED_SPECIES;
use kinlings_core::items::{self, STARTING_PLOTS, TOTAL_ACORNS, WELCOME_ACORNS};
use kinlings_core::shop::{Shop, SHOPS};
use near_sdk::store::{LookupMap, Vector};
use near_sdk::{env, near, require, AccountId, Allowance, NearToken, PanicOnDefault, Promise, PublicKey};
use state::*;

/// How much NEAR a new player's account starts with: gas, and a little to hire with.
const STARTING_MONEY: NearToken = NearToken::from_millinear(150);
/// How much a low player gets back from `top_up`.
const TOP_UP: NearToken = NearToken::from_millinear(40);
const TOP_UP_EVERY_SECS: u32 = 3_600;
/// New farms per hour through the public front door.
const OPENINGS_PER_HOUR: u32 = 60;
/// Kept free on top of what storage locks, so the valley can always write.
const NEAR_RESERVE: NearToken = NearToken::from_millinear(300);

const FEED_SIZE: u32 = 36;
const MAX_RECENT: usize = 48;
const LEADERBOARD: usize = 10;

/// True if this much NEAR can go out and storage stays paid for, with room to spare.
fn can_spend(amount: NearToken) -> bool {
    let locked = env::storage_byte_cost().saturating_mul(env::storage_usage() as u128);
    let free = env::account_balance().saturating_sub(locked);
    free.saturating_sub(amount) > NEAR_RESERVE
}

pub(crate) fn now_secs() -> u32 {
    (env::block_timestamp_ms() / 1_000) as u32
}

/// A roll in 0..1000 that no player can choose. Different salts give
/// different rolls within one block.
pub(crate) fn roll(salt: &[u8]) -> u32 {
    let mut seed = env::random_seed();
    seed.extend_from_slice(salt);
    seed.extend_from_slice(&env::block_timestamp().to_le_bytes());
    let hash = env::sha256(&seed);
    u32::from_le_bytes([hash[0], hash[1], hash[2], hash[3]]) % 1_000
}

/// An item's name, as the game shows it.
pub(crate) fn item_name(item: u16) -> &'static str {
    if let Some(food) = items::food(item) {
        return food.name;
    }
    match item {
        items::ACORN => "Acorns",
        items::TONIC => "Warmth Tonic",
        items::WILD_EGG => "Wild Egg",
        _ => "Something",
    }
}

/// "a Glowcap", "a Dragonfruit", "some Stardust Honey".
pub(crate) fn with_article(item: u16) -> String {
    let name = item_name(item);
    if item == items::HONEY {
        format!("some {name}")
    } else {
        format!("a {name}")
    }
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Valley {
    pub(crate) owner: AccountId,
    pub(crate) kin_code: [u8; 32],
    pub(crate) players: LookupMap<AccountId, Player>,
    pub(crate) roster: Vector<AccountId>,
    pub(crate) bags: LookupMap<AccountId, Bag>,
    pub(crate) kins: LookupMap<u32, Kin>,
    pub(crate) eggs: LookupMap<u32, Egg>,
    pub(crate) next_kin: u32,
    pub(crate) next_egg: u32,
    pub(crate) shops: LookupMap<u8, ShopRecord>,
    pub(crate) investments: LookupMap<String, Investment>,
    pub(crate) species: LookupMap<u16, Species>,
    pub(crate) species_found: Vector<u16>,
    pub(crate) listings: LookupMap<u32, Listing>,
    pub(crate) open_listings: Vec<u32>,
    pub(crate) next_listing: u32,
    pub(crate) studs: Vec<u32>,
    pub(crate) rentals: Vec<u32>,
    pub(crate) runs: LookupMap<u32, Run>,
    pub(crate) top_racers: Vec<(u32, u32)>,
    /// NEAR Social accounts linked to farms, to find friends who play.
    pub(crate) socials: LookupMap<String, u32>,
    pub(crate) challenges: LookupMap<u32, Challenge>,
    /// Challenges still taking runners or waiting to pay out.
    pub(crate) open_challenges: Vec<u32>,
    /// The last few that paid out, so people can see how they went.
    pub(crate) done_challenges: Vec<u32>,
    pub(crate) next_challenge: u32,
    /// NEAR set aside for race winners, in yoctoNEAR.
    pub(crate) near_pot: u128,
    pub(crate) race_budget: u32,
    pub(crate) race_budget_at: u32,
    pub(crate) feed: LookupMap<u32, FeedItem>,
    pub(crate) feed_count: u32,
    pub(crate) gifts: LookupMap<String, u32>,
    pub(crate) recent: Vec<(u32, u32)>,
    pub(crate) top: Vec<(u32, u32)>,
    pub(crate) supply: [u64; items::ITEM_COUNT as usize],
    pub(crate) openings_hour: u32,
    pub(crate) openings: u32,
    pub(crate) first_farm: u32,
}

fn key(tag: u8, epoch: u8) -> Vec<u8> {
    vec![tag, epoch]
}

#[near]
impl Valley {
    /// Sets up the economy: every acorn that will ever exist, shared between
    /// the Old Oak and the shop tills. Passing the hash of the Kinling contract
    /// fixes the code all creatures will run.
    #[init]
    pub fn new(owner: AccountId, kin_code_hash: String) -> Self {
        Self::build(owner, kin_code_hash, 0)
    }

    /// Starts the valley over under fresh storage. Testing builds only.
    #[cfg(feature = "dev-reset")]
    #[init(ignore_state)]
    #[private]
    pub fn reset(owner: AccountId, kin_code_hash: String, epoch: u8) -> Self {
        Self::build(owner, kin_code_hash, epoch)
    }

    /// Creates the shopkeepers' accounts. They have no keys: they exist so a
    /// shop's money and stock sit under a real address anyone can look up.
    pub fn open_shops(&mut self) {
        self.only_owner();
        for id in 0..SHOPS.len() {
            let account = self.shops.get(&(id as u8)).expect("shop").account.clone();
            Promise::new(account).create_account().detach();
        }
    }

    /// Adds a computer-run neighbour with a grown Kinling. Elders are always
    /// labelled in the game. They keep the valley from feeling empty.
    pub fn add_elder(&mut self, label: String, display: String, kin_name: String, species: u16, stud_fee: u32, rent_milli: u32) {
        self.only_owner();
        let account = sub_account(&label);
        require!(!self.players.contains_key(&account), "That elder exists");
        let index = self.join(account.clone(), display, true);
        self.make_elder_kin(account, kin_name, species, stud_fee, rent_milli, index);
    }

    /// The public front door: creates a farmer's account with a browser key
    /// that can only play this game, plus a welcome gift and a first egg.
    /// `identity` is the key from a social login, which owns the account.
    pub fn open_account(&mut self, session_key: PublicKey, name: String, identity: Option<PublicKey>) -> String {
        let hour = now_secs() / 3_600;
        if hour != self.openings_hour {
            self.openings_hour = hour;
            self.openings = 0;
        }
        require!(self.openings < OPENINGS_PER_HOUR, "The valley is full this hour. Try again soon.");
        self.openings += 1;
        require!(can_spend(STARTING_MONEY), "The valley is out of travel money");

        let name = clean_display_name(&name);
        let index = self.roster.len();
        let account = sub_account(&format!("f{}", self.first_farm + index));
        self.join(account.clone(), name, false);
        self.mark_seen(index, now_secs());

        let welcome = items::oak_gift(WELCOME_ACORNS, self.oak());
        let oak = env::current_account_id();
        self.debit(&oak, items::ACORN, welcome);
        self.credit(&account, items::ACORN, welcome);
        self.mint(&account, items::SUNWHEAT, 8);
        self.mint(&account, items::DEWBEAN, 2);
        self.give_founder_egg(&account);

        // The account runs the same tiny contract as every Kinling, so that the
        // valley can spend from it when the player's own key asks it to.
        let mut creating = Promise::new(account.clone())
            .create_account()
            .transfer(STARTING_MONEY)
            .use_global_contract(self.kin_code)
            .add_access_key_allowance(session_key, Allowance::Unlimited, env::current_account_id(), "");
        if let Some(identity) = identity {
            creating = creating.add_full_access_key(identity);
        }
        creating.detach();
        account.to_string()
    }

    /// Refills a farmer's gas money, at most once an hour.
    pub fn top_up(&mut self) -> Promise {
        let account = env::predecessor_account_id();
        let now = now_secs();
        let player = self.players.get_mut(&account).expect("Not a farmer");
        require!(now >= player.last_top_up + TOP_UP_EVERY_SECS, "You were topped up recently");
        player.last_top_up = now;
        require!(can_spend(TOP_UP), "The valley is out of travel money");
        Promise::new(account).transfer(TOP_UP)
    }

    /// Who can add elders. Nobody can touch a player's items or Kinlings.
    pub fn owner(&self) -> AccountId {
        self.owner.clone()
    }
}

impl Valley {
    fn build(owner: AccountId, kin_code_hash: String, epoch: u8) -> Self {
        let kin_code: [u8; 32] = hex_32(&kin_code_hash);
        let mut valley = Self {
            owner,
            kin_code,
            players: LookupMap::new(key(b'p', epoch)),
            roster: Vector::new(key(b'r', epoch)),
            bags: LookupMap::new(key(b'b', epoch)),
            kins: LookupMap::new(key(b'k', epoch)),
            eggs: LookupMap::new(key(b'e', epoch)),
            next_kin: 1,
            next_egg: 1,
            shops: LookupMap::new(key(b's', epoch)),
            investments: LookupMap::new(key(b'i', epoch)),
            species: LookupMap::new(key(b'n', epoch)),
            species_found: Vector::new(key(b'f', epoch)),
            listings: LookupMap::new(key(b'l', epoch)),
            open_listings: Vec::new(),
            next_listing: 1,
            studs: Vec::new(),
            rentals: Vec::new(),
            runs: LookupMap::new(key(b'R', epoch)),
            top_racers: Vec::new(),
            socials: LookupMap::new(key(b'S', epoch)),
            challenges: LookupMap::new(key(b'C', epoch)),
            open_challenges: Vec::new(),
            done_challenges: Vec::new(),
            next_challenge: 1,
            near_pot: 0,
            race_budget: items::RACE_BUDGET_CAP,
            race_budget_at: now_secs(),
            feed: LookupMap::new(key(b'F', epoch)),
            feed_count: 0,
            gifts: LookupMap::new(key(b'g', epoch)),
            recent: Vec::new(),
            top: Vec::new(),
            supply: [0; items::ITEM_COUNT as usize],
            openings_hour: 0,
            openings: 0,
            first_farm: epoch as u32 * 1_000,
        };
        valley.fill_valley();
        valley
    }

    fn fill_valley(&mut self) {
        let valley = self;
        let now = now_secs();
        let mut held_by_shops = 0;
        for id in 0..SHOPS.len() {
            let config = &SHOPS[id];
            let opening = Shop::opening(id, now);
            let account = sub_account(config.label);
            valley.credit(&account, items::ACORN, opening.till);
            held_by_shops += opening.till;
            for slot in 0..2 {
                valley.mint(&account, config.items[slot].item, opening.shelves[slot].stock);
            }
            valley.shops.insert(
                id as u8,
                ShopRecord {
                    account,
                    recent: [(0, 0); 2],
                    last_tick: now,
                    closed: false,
                    investor_pot: 0,
                    shares: 0,
                    per_share: 0,
                },
            );
        }
        valley.credit(&env::current_account_id(), items::ACORN, TOTAL_ACORNS - held_by_shops);
        valley.supply[items::ACORN as usize] = TOTAL_ACORNS as u64;

        for (species, name) in NAMED_SPECIES {
            valley.species.insert(
                species,
                Species { name: name.to_string(), finder: 0, named: true, count: 0 },
            );
            valley.species_found.push(species);
        }
    }

    pub(crate) fn only_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "Owner only");
    }

    pub(crate) fn oak(&self) -> u32 {
        self.balance(&env::current_account_id(), items::ACORN)
    }

    /// Adds someone to the valley road.
    pub(crate) fn join(&mut self, account: AccountId, name: String, elder: bool) -> u32 {
        let index = self.roster.len();
        self.roster.push(account.clone());
        self.players.insert(
            account,
            Player {
                name,
                index,
                elder,
                seen: now_secs(),
                xp: 0,
                plots: vec![SavedPlot::default(); STARTING_PLOTS as usize],
                mastery: [0; 6],
                helps_day: 0,
                helps: 0,
                kins: Vec::new(),
                eggs: Vec::new(),
                last_top_up: 0,
                wallet: None,
                near_earned: 0,
                rented: Vec::new(),
                races: 0,
                social: None,
            },
        );
        index
    }

    pub(crate) fn tell_everyone(&mut self, kind: u8, who: &str, what: &str) {
        let slot = self.feed_count % FEED_SIZE;
        self.feed.insert(
            slot,
            FeedItem { at: now_secs(), kind, who: who.to_string(), what: what.to_string() },
        );
        self.feed_count += 1;
    }

    pub(crate) fn mark_seen(&mut self, index: u32, now: u32) {
        if let Some(entry) = self.recent.iter_mut().find(|e| e.0 == index) {
            entry.1 = now;
            return;
        }
        if self.recent.len() >= MAX_RECENT {
            let oldest = (0..self.recent.len()).min_by_key(|&i| self.recent[i].1).unwrap();
            self.recent.swap_remove(oldest);
        }
        self.recent.push((index, now));
    }

    pub(crate) fn update_leaderboard(&mut self, index: u32, xp: u32) {
        if let Some(entry) = self.top.iter_mut().find(|e| e.0 == index) {
            entry.1 = xp;
        } else if self.top.len() < LEADERBOARD {
            self.top.push((index, xp));
        } else {
            let lowest = (0..self.top.len()).min_by_key(|&i| self.top[i].1).unwrap();
            if self.top[lowest].1 < xp {
                self.top[lowest] = (index, xp);
            }
        }
        self.top.sort_unstable_by(|a, b| b.1.cmp(&a.1));
    }
}

/// A Kinling's name as people see it: the account name with a capital letter.
pub(crate) fn display_name(name: &str) -> String {
    let mut letters = name.chars();
    match letters.next() {
        Some(first) => first.to_uppercase().chain(letters).collect(),
        None => String::new(),
    }
}

/// An account directly under the valley.
pub(crate) fn sub_account(label: &str) -> AccountId {
    format!("{label}.{}", env::current_account_id()).parse().expect("bad account name")
}

/// Keeps names printable and short. Nothing here needs escaping in JSON.
pub(crate) fn clean_display_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == ' ' || *c == '-')
        .take(16)
        .collect();
    let trimmed = cleaned.trim();
    if trimmed.is_empty() {
        "Farmer".to_string()
    } else {
        trimmed.to_string()
    }
}

fn hex_32(text: &str) -> [u8; 32] {
    let bytes = text.as_bytes();
    require!(bytes.len() == 64, "Expected a 32-byte hex hash");
    let nibble = |c: u8| match c {
        b'0'..=b'9' => c - b'0',
        b'a'..=b'f' => c - b'a' + 10,
        _ => env::panic_str("Bad hex"),
    };
    let mut out = [0u8; 32];
    for i in 0..32 {
        out[i] = nibble(bytes[i * 2]) << 4 | nibble(bytes[i * 2 + 1]);
    }
    out
}
