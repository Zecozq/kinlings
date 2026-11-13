//! What the browser reads. `world` returns everything the game needs in one
//! call, as plain JSON arrays built by hand. Serde would add far more code to
//! the contract, and contract size is paid for in locked NEAR.
//!
//! Names are cleaned at the door and account ids are restricted by the
//! protocol, so nothing written here needs escaping. Field orders are listed
//! in `web/src/world.ts`.

use crate::rentals::MILLI;
use crate::state::*;
use crate::{now_secs, Valley};
use kinlings_core::items::{self, level_for, ACORN, FARMER_RANKS};
use kinlings_core::shop::SHOPS;
use near_sdk::serde::Deserialize;
use near_sdk::{env, AccountId};

const ONLINE_WINDOW_SECS: u32 = 180;
/// How many of a neighbour's Kinlings come back with the world, newest first.
const NEIGHBOUR_KINS: usize = 12;
/// How many of your own do. The rest are a page away, in `farm_kins`.
const OWN_KINS: usize = 60;
const FARM_EGGS: usize = 40;
/// NEAR amounts leave the contract in millionths, which fit in a JSON number.
const MICRO: u128 = MILLI / 1_000;

/// Elders' fields are scenery on a timer, so an Elder's farm always looks
/// tended. None of it is real produce: only a player's crops are on the ledger.
fn elder_crop(seed: u32, now: u32) -> (u32, u32) {
    let crop = 1 + seed % 6;
    let grow = items::crop(crop as u16).map_or(60, |info| info.grow_secs);
    let phase = (now + seed * 37) % grow;
    (crop, now + grow - phase)
}

fn number(out: &mut String, value: u128) {
    let mut digits = [0u8; 39];
    let mut at = digits.len();
    let mut rest = value;
    loop {
        at -= 1;
        digits[at] = b'0' + (rest % 10) as u8;
        rest /= 10;
        if rest == 0 {
            break;
        }
    }
    out.push_str(core::str::from_utf8(&digits[at..]).unwrap_or("0"));
}

fn text(out: &mut String, value: &str) {
    out.push('"');
    out.push_str(value);
    out.push('"');
}

macro_rules! row {
    ($out:expr; $($kind:ident $value:expr),+ $(,)?) => {{
        $out.push('[');
        let mut first = true;
        $(
            if !first { $out.push(','); }
            first = false;
            row!(@$kind $out, $value);
        )+
        let _ = first;
        $out.push(']');
    }};
    (@n $out:expr, $value:expr) => { number($out, $value as u128) };
    (@t $out:expr, $value:expr) => { text($out, $value) };
    (@list $out:expr, $value:expr) => {
        $out.push('[');
        for (index, entry) in $value.iter().enumerate() {
            if index > 0 { $out.push(','); }
            number($out, *entry as u128);
        }
        $out.push(']');
    };
}

impl Valley {
    fn write_farm(&self, out: &mut String, player: &Player, own: bool, wanted_kins: &mut Vec<u32>, wanted_eggs: &mut Vec<u32>) {
        out.push('[');
        number(out, player.index as u128);
        out.push(',');
        text(out, &player.name);
        out.push(',');
        number(out, player.xp as u128);
        out.push(',');
        number(out, player.kins.len() as u128);
        out.push_str(",[");
        let now = now_secs();
        for (index, plot) in player.plots.iter().enumerate() {
            if index > 0 {
                out.push(',');
            }
            if player.elder {
                let (crop, ready_at) = elder_crop(index as u32 + player.index, now);
                row!(out; n crop, n ready_at, n 0);
            } else {
                row!(out; n plot.crop, n plot.ready_at, n plot.waterings);
            }
        }
        out.push_str("],[");
        let shown = if own { OWN_KINS } else { NEIGHBOUR_KINS };
        for (index, kin) in player.kins.iter().rev().take(shown).enumerate() {
            if index > 0 {
                out.push(',');
            }
            number(out, *kin as u128);
            if !wanted_kins.contains(kin) {
                wanted_kins.push(*kin);
            }
        }
        out.push_str("],[");
        for (index, egg) in player.eggs.iter().take(FARM_EGGS).enumerate() {
            if index > 0 {
                out.push(',');
            }
            number(out, *egg as u128);
            if !wanted_eggs.contains(egg) {
                wanted_eggs.push(*egg);
            }
        }
        out.push_str("],");
        number(out, player.seen as u128);
        out.push(',');
        number(out, player.elder as u128);
        out.push_str(",[");
        for (index, mastery) in player.mastery.iter().enumerate() {
            if index > 0 {
                out.push(',');
            }
            number(out, *mastery as u128);
        }
        out.push_str("],");
        // The NEAR Social account this farm links to, and the farm's own account,
        // so the browser can check the two agree.
        text(out, player.social.as_deref().unwrap_or(""));
        out.push(',');
        text(out, self.roster.get(player.index).map_or("", |a| a.as_str()));
        out.push(']');
    }

    fn write_kin(&self, out: &mut String, id: u32) -> bool {
        let Some(kin) = self.kins.get(&id) else { return false };
        if kin.unborn {
            return false;
        }
        let owner = self.players.get(&kin.owner).map_or(u32::MAX, |p| p.index);
        let purse = self.balance(&kin.account, ACORN);
        row!(out;
            n id,
            t &kin.name,
            t kin.account.as_str(),
            n owner,
            n kin.xp,
            n kin.mother,
            n kin.father,
            n kin.generation,
            n kin.rest_until,
            n kin.stud_fee,
            n purse,
            n kin.wins,
            n kin.food,
            list kin.genes,
            list kin.children,
            n kin.rent_milli,
            n self.renter_index(kin),
            n kin.rented_until,
            n kin.child_count,
            n kin.race_ready_at,
        );
        true
    }

    fn renter_index(&self, kin: &Kin) -> u32 {
        if !kin.rented_out(now_secs()) {
            return u32::MAX;
        }
        kin.renter.as_ref().and_then(|renter| self.players.get(renter)).map_or(u32::MAX, |p| p.index)
    }

    pub(crate) fn write_kins_for_race(&self, out: &mut String, wanted: &[u32]) {
        out.push('[');
        for (slot, id) in wanted.iter().enumerate() {
            if slot > 0 {
                out.push(',');
            }
            self.write_kin(out, *id);
        }
        out.push(']');
    }

    fn write_kins(&self, out: &mut String, wanted: &[u32]) {
        out.push('[');
        let mut first = true;
        for id in wanted {
            if !first {
                out.push(',');
            }
            if self.write_kin(out, *id) {
                first = false;
            } else if !first {
                out.pop();
            }
        }
        out.push(']');
    }

    fn write_egg(&self, out: &mut String, id: u32) -> bool {
        let Some(egg) = self.eggs.get(&id) else { return false };
        row!(out;
            n id,
            n egg.mother,
            n egg.father,
            n egg.food,
            n egg.ready_at,
            n egg.warms,
            n egg.hatching,
            n egg.wild,
        );
        true
    }

    fn write_shops(&self, out: &mut String) {
        out.push('[');
        for id in 0..SHOPS.len() {
            if id > 0 {
                out.push(',');
            }
            let record = self.shops.get(&(id as u8)).expect("shop");
            let held = self.balance(&record.account, ACORN);
            let config = &SHOPS[id];
            row!(out;
                n held,
                n record.investor_pot,
                n record.closed,
                n record.shares,
                n self.balance(&record.account, config.items[0].item),
                n record.recent[0].0,
                n record.recent[0].1,
                n self.balance(&record.account, config.items[1].item),
                n record.recent[1].0,
                n record.recent[1].1,
                n record.last_tick,
            );
        }
        out.push(']');
    }

    fn write_feed(&self, out: &mut String, since: u32) {
        out.push('[');
        let oldest = self.feed_count.saturating_sub(crate::FEED_SIZE).max(since);
        let mut first = true;
        for number_in_feed in oldest..self.feed_count {
            let Some(item) = self.feed.get(&(number_in_feed % crate::FEED_SIZE)) else { continue };
            if !first {
                out.push(',');
            }
            first = false;
            row!(out; n number_in_feed, n item.at, n item.kind, t &item.who, t &item.what);
        }
        out.push(']');
    }

    /// Everything the game screen shows, in one call.
    pub(crate) fn world_json(&self, viewer: Option<AccountId>, from: u32, limit: u32, since: u32) -> String {
        let now = now_secs();
        let mut out = String::with_capacity(8_192);
        let me = viewer.and_then(|v| self.players.get(&v).cloned().map(|p| (v, p)));

        let (mut kins, mut eggs) = (Vec::new(), Vec::new());
        out.push('[');
        number(&mut out, now as u128);
        out.push(',');
        number(&mut out, self.roster.len() as u128);
        out.push(',');
        let online = self.recent.iter().filter(|e| e.1 + ONLINE_WINDOW_SECS >= now).count();
        number(&mut out, online as u128);
        out.push(',');
        number(&mut out, self.oak() as u128);
        out.push(',');
        number(&mut out, me.as_ref().map_or(u32::MAX, |m| m.1.index) as u128);

        // The farms in view, then this player's own, deduplicated.
        out.push_str(",[");
        let mut wrote = 0;
        let last = from.saturating_add(limit).min(self.roster.len());
        let mine = me.as_ref().map(|m| m.1.index);
        for index in from..last {
            let Some(account) = self.roster.get(index) else { continue };
            let Some(player) = self.players.get(account) else { continue };
            if wrote > 0 {
                out.push(',');
            }
            self.write_farm(&mut out, player, mine == Some(index), &mut kins, &mut eggs);
            wrote += 1;
        }
        if let Some((_, player)) = me.as_ref() {
            if mine.is_some_and(|m| m < from || m >= last) {
                if wrote > 0 {
                    out.push(',');
                }
                self.write_farm(&mut out, player, true, &mut kins, &mut eggs);
            }
        }
        out.push(']');

        // The market, and the Kinlings this player has on hire, need these as well.
        let hired = me.as_ref().map_or(&[][..], |m| &m.1.rented[..]);
        let mut extras: Vec<u32> = hired.to_vec();
        extras.extend(self.rentals.iter());
        extras.extend(self.studs.iter());
        extras.extend(self.top_racers.iter().map(|e| e.0));
        for id in &extras {
            if !kins.contains(id) && kins.len() < 150 {
                kins.push(*id);
            }
        }
        // What is up for sale has to be visible too.
        for id in &self.open_listings {
            let Some(listing) = self.listings.get(id) else { continue };
            if listing.kind == 2 && !kins.contains(&listing.id) && kins.len() < 150 {
                kins.push(listing.id);
            }
            if listing.kind == 1 && !eggs.contains(&listing.id) {
                eggs.push(listing.id);
            }
        }
        out.push(',');
        self.write_kins(&mut out, &kins);

        out.push_str(",[");
        let mut first = true;
        for id in &eggs {
            if !first {
                out.push(',');
            }
            if self.write_egg(&mut out, *id) {
                first = false;
            } else if !first {
                out.pop();
            }
        }
        out.push(']');

        out.push(',');
        self.write_shops(&mut out);
        out.push(',');
        // The race economy: the Oak's budget, and the NEAR pot in millionths.
        row!(&mut out; n self.race_budget, n self.near_pot / MICRO);
        out.push_str(",[");
        for (index, (kin, wins)) in self.top_racers.iter().enumerate() {
            if index > 0 {
                out.push(',');
            }
            let owner = self.kins.get(kin).and_then(|k| self.players.get(&k.owner));
            row!(&mut out; n *kin, n *wins, t owner.map_or("Someone", |p| p.name.as_str()));
        }
        out.push_str("],");
        self.write_feed(&mut out, since);

        out.push_str(",[");
        for (index, kin) in self.studs.iter().enumerate() {
            if index > 0 {
                out.push(',');
            }
            number(&mut out, *kin as u128);
        }
        out.push_str("],[");
        let mut first = true;
        for id in &self.open_listings {
            let Some(listing) = self.listings.get(id) else { continue };
            if !first {
                out.push(',');
            }
            first = false;
            let seller = self.players.get(&listing.seller).map_or(u32::MAX, |p| p.index);
            row!(&mut out; n *id, n seller, n listing.kind, n listing.id, n listing.quantity, n listing.unit_price, n listing.in_near);
        }
        out.push(']');

        // This player's own bag: pairs of item and quantity.
        out.push_str(",[");
        if let Some((account, _)) = me.as_ref() {
            if let Some(bag) = self.bags.get(account) {
                for (index, (item, quantity)) in bag.0.iter().enumerate() {
                    if index > 0 {
                        out.push(',');
                    }
                    row!(&mut out; n *item, n *quantity);
                }
            }
        }
        out.push_str("],");

        // The leaderboard, with names.
        out.push('[');
        let mut first = true;
        for (index, xp) in &self.top {
            let Some(account) = self.roster.get(*index) else { continue };
            let Some(player) = self.players.get(account) else { continue };
            if !first {
                out.push(',');
            }
            first = false;
            row!(&mut out; n *index, t &player.name, n *xp, n level_for(*xp, &FARMER_RANKS), n player.elder);
        }
        out.push_str("],[");

        // Kinlings up for hire.
        for (index, kin) in self.rentals.iter().enumerate() {
            if index > 0 {
                out.push(',');
            }
            number(&mut out, *kin as u128);
        }
        out.push_str("],[");

        // This player's own NEAR details: wallet, total earned in millionths,
        // what they have on hire, and how many races they've run.
        match me.as_ref() {
            Some((_, player)) => {
                text(&mut out, player.wallet.as_ref().map_or("", |w| w.as_str()));
                out.push(',');
                number(&mut out, player.near_earned / MICRO);
                out.push_str(",[");
                let mut first = true;
                for id in &player.rented {
                    let Some(kin) = self.kins.get(id) else { continue };
                    if !kin.rented_out(now) || kin.renter.as_ref() != Some(&me.as_ref().unwrap().0) {
                        continue;
                    }
                    if !first {
                        out.push(',');
                    }
                    first = false;
                    number(&mut out, *id as u128);
                }
                out.push_str("],");
                number(&mut out, player.races as u128);
            }
            None => out.push_str("\"\",0,[],0"),
        }
        out.push_str("]]");
        out
    }

    fn species_json(&self, from: u32, limit: u32) -> String {
        let mut out = String::with_capacity(2_048);
        out.push('[');
        let last = from.saturating_add(limit).min(self.species_found.len());
        let mut first = true;
        for index in from..last {
            let Some(species) = self.species_found.get(index) else { continue };
            let Some(entry) = self.species.get(species) else { continue };
            if !first {
                out.push(',');
            }
            first = false;
            let finder = entry
                .finder
                .checked_sub(1)
                .and_then(|index| self.roster.get(index))
                .and_then(|account| self.players.get(account))
                .map_or("", |player| player.name.as_str());
            row!(&mut out; n *species, t &entry.name, n entry.finder, n entry.named, n entry.count, t finder);
        }
        out.push(']');
        out
    }

    fn kins_json(&self, ids: &[u32]) -> String {
        let mut out = String::with_capacity(512);
        self.write_kins(&mut out, ids);
        out
    }

    pub(crate) fn stake_of(&self, shop: u32, account: &AccountId) -> (u32, u32) {
        let key = format!("{shop}:{account}");
        let Some(stake) = self.investments.get(&key) else { return (0, 0) };
        let Some(record) = self.shops.get(&(shop as u8)) else { return (0, 0) };
        let due = stake.shares as u128 * (record.per_share - stake.settled_per_share) / 1_000_000_000_000;
        (stake.shares, due as u32)
    }
}

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct WorldArgs {
    viewer: Option<AccountId>,
    from: Option<u32>,
    limit: Option<u32>,
    since: Option<u32>,
}

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct PageArgs {
    from: Option<u32>,
    limit: Option<u32>,
}

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct KinArgs {
    ids: Vec<u32>,
}

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct StakeArgs {
    account: AccountId,
}

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct ChallengeArgs {
    challenge: u32,
}

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct SocialArgs {
    accounts: Vec<String>,
}

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct FarmKinsArgs {
    index: u32,
    from: Option<u32>,
    limit: Option<u32>,
}

fn read_args<T: for<'a> Deserialize<'a>>() -> T {
    let input = env::input().unwrap_or_default();
    near_sdk::serde_json::from_slice(&input).unwrap_or_else(|_| env::panic_str("Bad arguments"))
}

fn load() -> Valley {
    env::state_read().unwrap_or_else(|| env::panic_str("Not initialised"))
}

fn answer(json: String) {
    env::value_return(json.as_bytes());
}

// Plain exported functions, so the hand-built JSON is returned as it is.

#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn world() {
    env::setup_panic_hook();
    let args: WorldArgs = read_args();
    let valley = load();
    answer(valley.world_json(args.viewer, args.from.unwrap_or(0), args.limit.unwrap_or(6).min(16), args.since.unwrap_or(0)));
}

#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn species_page() {
    env::setup_panic_hook();
    let args: PageArgs = read_args();
    let valley = load();
    answer(valley.species_json(args.from.unwrap_or(0), args.limit.unwrap_or(60).min(100)));
}

#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn kins_by_id() {
    env::setup_panic_hook();
    let args: KinArgs = read_args();
    let valley = load();
    let ids: Vec<u32> = args.ids.into_iter().take(64).collect();
    answer(valley.kins_json(&ids));
}

/// A page of one farm's Kinling ids, newest first, after the total.
#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn farm_kins() {
    env::setup_panic_hook();
    let args: FarmKinsArgs = read_args();
    let valley = load();
    let account = valley.roster.get(args.index).unwrap_or_else(|| env::panic_str("No such farm"));
    let player = valley.players.get(account).unwrap_or_else(|| env::panic_str("No such farm"));
    let mut out = String::from("[");
    number(&mut out, player.kins.len() as u128);
    out.push_str(",[");
    let limit = args.limit.unwrap_or(60).min(100) as usize;
    for (index, kin) in player.kins.iter().rev().skip(args.from.unwrap_or(0) as usize).take(limit).enumerate() {
        if index > 0 {
            out.push(',');
        }
        number(&mut out, *kin as u128);
    }
    out.push_str("]]");
    answer(out);
}

/// Which of these NEAR Social accounts have linked a farm here: for each one,
/// `[farm index, farm account]`, or `null`.
#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn farms_of_socials() {
    env::setup_panic_hook();
    let args: SocialArgs = read_args();
    let valley = load();
    answer(valley.farms_of_socials_json(&args.accounts));
}

/// Every open challenge, then the last few that paid out. Each row:
/// `[id, host index, host name, fee in thousandths, seats, opened, closes,
/// paid out, [[player index, name, kin id, kin name, started, ticks, won in
/// millionths], ...]]`, after the time now.
#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn challenges() {
    env::setup_panic_hook();
    let valley = load();
    answer(valley.challenges_json());
}

/// What a runner needs to race the ghosts of those who ran before:
/// `["seed", "field", ease, [[player index, name, "entrant", ticks, [moves]], ...]]`.
#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn challenge_ghosts() {
    env::setup_panic_hook();
    let args: ChallengeArgs = read_args();
    let valley = load();
    answer(valley.challenge_ghosts_json(args.challenge));
}

impl Valley {
    pub(crate) fn challenges_json(&self) -> String {
        let mut out = String::with_capacity(2_048);
        out.push('[');
        number(&mut out, now_secs() as u128);
        out.push_str(",[");
        let mut first = true;
        for id in self.open_challenges.iter().chain(self.done_challenges.iter().rev()) {
            let Some(c) = self.challenges.get(id) else { continue };
            if !first {
                out.push(',');
            }
            first = false;
            let host = self.players.get(&c.host);
            row!(&mut out; n *id, n host.map_or(u32::MAX, |p| p.index), t host.map_or("Someone", |p| p.name.as_str()),
                n c.fee_milli, n c.seats, n c.opened, n c.closes_at(), n c.settled);
            // Reopen the row to add the runners.
            out.pop();
            out.push_str(",[");
            for (index, entry) in c.entries.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                let player = self.players.get(&entry.player);
                let kin = self.kins.get(&entry.kin);
                row!(&mut out; n player.map_or(u32::MAX, |p| p.index), t player.map_or("Someone", |p| p.name.as_str()),
                    n entry.kin, t kin.map_or("", |k| k.name.as_str()), n entry.started, n entry.ticks, n entry.prize / MICRO);
            }
            out.push_str("]]");
        }
        out.push_str("]]");
        out
    }

    pub(crate) fn challenge_ghosts_json(&self, id: u32) -> String {
        let Some(c) = self.challenges.get(&id) else { return "null".to_string() };
        let mut out = String::with_capacity(4_096);
        out.push_str("[\"");
        out.push_str(&crate::races::hex(&c.seed));
        out.push_str("\",\"");
        out.push_str(&crate::races::hex(&c.field_entrants));
        out.push_str("\",");
        number(&mut out, crate::challenges::CHALLENGE_EASE as u128);
        out.push_str(",[");
        let mut first = true;
        for entry in c.entries.iter().filter(|e| e.ticks != 0 && !e.moves.is_empty()) {
            if !first {
                out.push(',');
            }
            first = false;
            let player = self.players.get(&entry.player);
            out.push('[');
            number(&mut out, player.map_or(u32::MAX, |p| p.index) as u128);
            out.push(',');
            text(&mut out, player.map_or("Someone", |p| p.name.as_str()));
            out.push_str(",\"");
            out.push_str(&crate::races::hex(&entry.entrant));
            out.push_str("\",");
            number(&mut out, entry.ticks as u128);
            out.push(',');
            out.push('[');
            for (index, step) in entry.moves.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                number(&mut out, *step as u128);
            }
            out.push_str("]]");
        }
        out.push_str("]]");
        out
    }

    pub(crate) fn farms_of_socials_json(&self, accounts: &[String]) -> String {
        let mut out = String::from("[");
        for (index, social) in accounts.iter().take(300).enumerate() {
            if index > 0 {
                out.push(',');
            }
            let farm = self.socials.get(social).and_then(|&farm| self.roster.get(farm).map(|account| (farm, account)));
            match farm {
                Some((farm, account)) => row!(&mut out; n farm, t account.as_str()),
                None => out.push_str("null"),
            }
        }
        out.push(']');
        out
    }
}

#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn stakes() {
    env::setup_panic_hook();
    let args: StakeArgs = read_args();
    let valley = load();
    let mut out = String::from("[");
    for shop in 0..SHOPS.len() as u32 {
        if shop > 0 {
            out.push(',');
        }
        let (shares, due) = valley.stake_of(shop, &args.account);
        row!(&mut out; n shares, n due);
    }
    out.push(']');
    answer(out);
}
