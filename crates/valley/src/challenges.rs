//! Challenge races: real players race each other for NEAR.
//!
//! A player opens a challenge with an entry fee and a number of seats. Others
//! join by paying the same fee, from any NEAR wallet or from their own farm
//! account. Everyone runs the same course against the same field of the
//! Elders' Kinlings, whenever they like while it is open, and later runners
//! race the ghosts of earlier ones. The fastest share every entry fee, paid
//! straight to their wallets. The valley keeps none of it.
//!
//! Each run is checked the same way as a practice race: the contract plays the
//! moves through the same rules, so nobody can claim a time they didn't run.

use crate::races::hex;
use crate::rentals::{release_input, yocto_from_milli, MILLI, RELEASE_GAS};
use crate::state::*;
use crate::{now_secs, Valley, ValleyExt};
use kinlings_core::dash::{self, unpack_entrants, ENTRANT_LEN, MAX_MOVES, RACERS, TICKS_PER_SEC};
use kinlings_core::items::{grow, RACE_LEVEL_CAP, RACE_XP};
use kinlings_core::rng::Rng;
use near_sdk::json_types::U128;
use near_sdk::{env, near, require, AccountId, Gas, NearToken, Promise, PromiseError};

/// Entry fees, in thousandths of a NEAR.
pub const MIN_FEE_MILLI: u32 = 10;
pub const MAX_FEE_MILLI: u32 = 1_000;
pub const MIN_SEATS: u8 = 2;
pub const MAX_SEATS: u8 = RACERS as u8;
/// A challenge takes new runners for this long after it opens.
pub const CHALLENGE_SECS: u32 = 3_600;
/// A run, once begun, must be handed in within this.
pub const RUN_SECS: u32 = 600;
/// Stored for a run that didn't reach the line in time.
pub const DID_NOT_FINISH: u32 = u32::MAX;
/// How gently the Elders' field races, the same for everyone.
pub const CHALLENGE_EASE: u8 = 6;
const CLOCK_SLACK_SECS: u32 = 4;
const MAX_OPEN: usize = 40;
const MAX_HOSTED: usize = 3;
const DONE_KEPT: usize = 12;
const ENTRY_GAS: Gas = Gas::from_tgas(30);

/// How the entry fees are shared, by how many ran: percent to 1st, 2nd and 3rd.
pub fn prize_shares(runners: usize) -> [u128; 3] {
    match runners {
        0..=2 => [100, 0, 0],
        3 => [70, 30, 0],
        4 => [60, 30, 10],
        _ => [50, 30, 20],
    }
}

fn refund(to: &AccountId, amount: u128) {
    if amount > 0 {
        Promise::new(to.clone()).transfer(NearToken::from_yoctonear(amount)).detach();
    }
}

impl Challenge {
    pub fn closes_at(&self) -> u32 {
        self.opened + CHALLENGE_SECS
    }

    /// Runs begun and not yet handed in, that still could be.
    fn running(&self, now: u32) -> bool {
        self.entries.iter().any(|e| e.started > 0 && e.ticks == 0 && now <= e.started + RUN_SECS)
    }

    /// Everyone who joined has handed in a run.
    fn all_in(&self) -> bool {
        self.entries.iter().all(|e| e.ticks != 0)
    }

    /// Runners from fastest to slowest. A run never handed in counts as
    /// unfinished, and ties go to whoever ran first.
    pub fn standings(&self) -> Vec<usize> {
        let mut order: Vec<usize> = (0..self.entries.len()).collect();
        let time = |e: &ChallengeEntry| if e.ticks == 0 { DID_NOT_FINISH } else { e.ticks };
        order.sort_by_key(|&i| (time(&self.entries[i]), self.entries[i].started, i));
        order
    }
}

impl Valley {
    /// The fee to pay, in thousandths of a NEAR, if this entry is allowed.
    /// `challenge` is `None` to open a new one.
    fn entry_fee(&self, challenge: Option<u32>, kin_id: u32, fee_milli: u32, seats: u8, player: &AccountId, now: u32) -> Option<u32> {
        let is_player = self.players.get(player).is_some_and(|p| !p.elder);
        let has_kin = self.kins.get(&kin_id).is_some_and(|k| !k.unborn && k.controlled_by(player, now));
        if !is_player || !has_kin {
            return None;
        }
        match challenge {
            None => {
                let hosted = self.open_challenges.iter().filter(|id| self.challenges.get(id).is_some_and(|c| c.host == *player && !c.settled)).count();
                let allowed = (MIN_FEE_MILLI..=MAX_FEE_MILLI).contains(&fee_milli)
                    && (MIN_SEATS..=MAX_SEATS).contains(&seats)
                    && self.open_challenges.len() < MAX_OPEN
                    && hosted < MAX_HOSTED;
                allowed.then_some(fee_milli)
            }
            Some(id) => {
                let c = self.challenges.get(&id)?;
                let allowed = !c.settled
                    && now < c.closes_at()
                    && c.entries.len() < c.seats as usize
                    && !c.entries.iter().any(|e| e.player == *player);
                allowed.then_some(c.fee_milli)
            }
        }
    }

    /// The Elders' Kinlings, shuffled by the course's seed. Everyone in a
    /// challenge races the same five.
    fn elder_field(&self, seed: &[u8]) -> Option<Vec<u32>> {
        let mut pool: Vec<u32> = Vec::new();
        for index in 0..self.roster.len().min(16) {
            let Some(player) = self.roster.get(index).and_then(|a| self.players.get(a)) else { continue };
            if player.elder {
                pool.extend(player.kins.iter().copied().filter(|id| self.kins.get(id).is_some_and(|k| !k.unborn)));
            }
        }
        if pool.is_empty() {
            return None;
        }
        let mut rng = Rng::from_seed(seed);
        let mut bag = pool.clone();
        let mut field = Vec::with_capacity(RACERS - 1);
        while field.len() < RACERS - 1 {
            if bag.is_empty() {
                bag = pool.clone();
            }
            let pick = rng.below(bag.len() as u32) as usize;
            field.push(bag.swap_remove(pick));
        }
        Some(field)
    }

    /// Books an entry that has been paid for, or sends the money back.
    /// Returns the challenge's id.
    pub(crate) fn enter_challenge(&mut self, challenge: Option<u32>, kin_id: u32, fee_milli: u32, seats: u8, player: &AccountId, paid: u128, payer: &AccountId) -> Option<u32> {
        let now = now_secs();
        let fee = self.entry_fee(challenge, kin_id, fee_milli, seats, player, now);
        let price = fee.map_or(0, yocto_from_milli);
        let mut fresh = None;
        if challenge.is_none() && fee.is_some() {
            let mut salted = env::random_seed();
            salted.extend_from_slice(b"challenge");
            salted.extend_from_slice(&self.next_challenge.to_le_bytes());
            salted.extend_from_slice(&now.to_le_bytes());
            let seed: [u8; 32] = env::sha256(&salted).try_into().expect("32 bytes");
            fresh = self.elder_field(&seed).map(|field| (seed, field));
        }
        let ready = fee.is_some() && paid >= price && (challenge.is_some() || fresh.is_some());
        if !ready {
            refund(payer, paid);
            return None;
        }
        refund(payer, paid - price);

        let entry = ChallengeEntry {
            player: player.clone(),
            payer: payer.clone(),
            kin: kin_id,
            started: 0,
            entrant: Vec::new(),
            ticks: 0,
            moves: Vec::new(),
            prize: 0,
        };
        let who = self.players.get(player).map_or(String::new(), |p| p.name.clone());
        let id = match challenge {
            Some(id) => {
                let c = self.challenges.get_mut(&id).expect("challenge");
                c.entries.push(entry);
                let host = self.players.get(&c.host).map_or(String::new(), |p| p.name.clone());
                self.tell_everyone(17, &who, &format!("joined {host}'s challenge"));
                id
            }
            None => {
                let (seed, field) = fresh.expect("a field");
                let mut field_entrants = vec![0u8; ENTRANT_LEN * field.len()];
                for (slot, kin) in field.iter().enumerate() {
                    self.entrant_of(*kin).pack(&mut field_entrants[slot * ENTRANT_LEN..(slot + 1) * ENTRANT_LEN]);
                }
                let id = self.next_challenge;
                self.next_challenge += 1;
                self.challenges.insert(
                    id,
                    Challenge {
                        host: player.clone(),
                        fee_milli: fee.expect("fee"),
                        seats,
                        opened: now,
                        seed,
                        field,
                        field_entrants,
                        entries: vec![entry],
                        settled: false,
                    },
                );
                self.open_challenges.push(id);
                let fee_text = crate::market::near_text(fee.expect("fee") as u128);
                self.tell_everyone(17, &who, &format!("opened a {fee_text} NEAR challenge"));
                id
            }
        };
        Some(id)
    }

    /// Pays a challenge out, or gives the fees back if nobody had anyone to beat.
    pub(crate) fn settle(&mut self, id: u32) {
        let Some(mut c) = self.challenges.get(&id).cloned() else { return };
        if c.settled {
            return;
        }
        let runners = c.entries.len();
        let fee = yocto_from_milli(c.fee_milli);
        let order = c.standings();
        let finishers = order.iter().filter(|&&i| c.entries[i].ticks != 0 && c.entries[i].ticks != DID_NOT_FINISH).count();
        let host = self.players.get(&c.host).map_or(String::new(), |p| p.name.clone());

        if runners < 2 || finishers == 0 {
            for entry in &c.entries {
                refund(&entry.payer, fee);
            }
            self.tell_everyone(18, &host, "had a challenge end with nobody to beat, so every fee went back");
        } else {
            let pot = fee * runners as u128;
            let shares = prize_shares(runners);
            let mut amounts = [0u128; 3];
            for place in 0..3 {
                // A share for a place nobody finished in goes to the winner.
                let target = if place < finishers { place } else { 0 };
                amounts[target] += pot * shares[place] / 100;
            }
            amounts[0] += pot - amounts.iter().sum::<u128>();
            for (place, amount) in amounts.iter().enumerate() {
                if *amount == 0 || place >= finishers {
                    continue;
                }
                let slot = order[place];
                let winner = c.entries[slot].player.clone();
                let paid = self.pay_owner(&winner, *amount);
                self.near_pot += amount - paid;
                c.entries[slot].prize = paid;
            }
            let first = &c.entries[order[0]];
            let name = self.players.get(&first.player).map_or(String::new(), |p| p.name.clone());
            let won = crate::market::near_text(first.prize / MILLI);
            self.tell_everyone(18, &name, &format!("won {won} NEAR in {host}'s challenge"));
            let kin = first.kin;
            self.note_win(kin);
        }

        c.settled = true;
        for entry in c.entries.iter_mut() {
            entry.moves = Vec::new();
        }
        self.challenges.insert(id, c);
        self.open_challenges.retain(|&open| open != id);
        self.done_challenges.push(id);
        if self.done_challenges.len() > DONE_KEPT {
            let oldest = self.done_challenges.remove(0);
            self.challenges.remove(&oldest);
        }
    }
}

#[near]
impl Valley {
    /// Opens a challenge, paying the entry fee with NEAR attached from any
    /// wallet. `farmer` is the player who races, if not the wallet itself.
    /// Returns the challenge's id, or nothing (with the NEAR sent back).
    #[payable]
    pub fn open_challenge(&mut self, kin_id: u32, fee_milli: u32, seats: u8, farmer: Option<AccountId>) -> Option<u32> {
        let payer = env::predecessor_account_id();
        let player = farmer.unwrap_or_else(|| payer.clone());
        self.enter_challenge(None, kin_id, fee_milli, seats, &player, env::attached_deposit().as_yoctonear(), &payer)
    }

    /// Joins a challenge, paying with NEAR attached from any wallet.
    #[payable]
    pub fn join_challenge(&mut self, challenge: u32, kin_id: u32, farmer: Option<AccountId>) -> Option<u32> {
        let payer = env::predecessor_account_id();
        let player = farmer.unwrap_or_else(|| payer.clone());
        self.enter_challenge(Some(challenge), kin_id, 0, 0, &player, env::attached_deposit().as_yoctonear(), &payer)
    }

    /// Opens a challenge, paying from the player's own farm account.
    pub fn open_challenge_with_purse(&mut self, kin_id: u32, fee_milli: u32, seats: u8) -> Promise {
        self.pay_entry_from_purse(None, kin_id, fee_milli, seats)
    }

    /// Joins a challenge, paying from the player's own farm account.
    pub fn join_challenge_with_purse(&mut self, challenge: u32, kin_id: u32) -> Promise {
        self.pay_entry_from_purse(Some(challenge), kin_id, 0, 0)
    }

    #[private]
    #[allow(clippy::too_many_arguments)]
    pub fn on_entry_paid(
        &mut self,
        challenge: Option<u32>,
        kin_id: u32,
        fee_milli: u32,
        seats: u8,
        player: AccountId,
        paid: U128,
        #[callback_result] sent: Result<(), PromiseError>,
    ) -> Option<u32> {
        if sent.is_err() {
            return None;
        }
        self.enter_challenge(challenge, kin_id, fee_milli, seats, &player, paid.0, &player)
    }

    /// Calls off a challenge nobody else has joined, and gives the fee back.
    pub fn cancel_challenge(&mut self, challenge: u32) {
        let me = env::predecessor_account_id();
        let c = self.challenges.get(&challenge).cloned().unwrap_or_else(|| env::panic_str("No such challenge"));
        require!(c.host == me && !c.settled, "Only its host can call it off");
        require!(c.entries.len() == 1 && c.entries[0].started == 0, "Someone has joined or it has been run");
        refund(&c.entries[0].payer, yocto_from_milli(c.fee_milli));
        self.challenges.remove(&challenge);
        self.open_challenges.retain(|&open| open != challenge);
    }

    /// Begins this player's one run of a challenge. Returns the same ticket as
    /// `race_start`: seed, racers' numbers, ease, rested, rivals, their owners.
    pub fn challenge_run(&mut self, challenge: u32) -> String {
        let me = env::predecessor_account_id();
        let now = now_secs();
        let c = self.challenges.get(&challenge).cloned().unwrap_or_else(|| env::panic_str("No such challenge"));
        require!(!c.settled && now < c.closes_at(), "That challenge has closed");
        let slot = c.entries.iter().position(|e| e.player == me).unwrap_or_else(|| env::panic_str("You haven't joined that challenge"));
        require!(c.entries[slot].started == 0, "You have already run it");
        let kin_id = c.entries[slot].kin;
        let kin = self.kins.get(&kin_id).cloned().unwrap_or_else(|| env::panic_str("No such Kinling"));
        require!(!kin.unborn && kin.controlled_by(&me, now), "That Kinling isn't yours to race any more");

        let mut mine = vec![0u8; ENTRANT_LEN];
        self.entrant_of(kin_id).pack(&mut mine);
        let mut packed = mine.clone();
        packed.extend_from_slice(&c.field_entrants);
        let record = self.challenges.get_mut(&challenge).expect("challenge");
        record.entries[slot].started = now;
        record.entries[slot].entrant = mine;
        if let Some(player) = self.players.get_mut(&me) {
            player.seen = now;
        }

        let mut out = String::with_capacity(1_024);
        out.push_str("[\"");
        out.push_str(&hex(&c.seed));
        out.push_str("\",\"");
        out.push_str(&hex(&packed));
        out.push_str("\",");
        out.push_str(&CHALLENGE_EASE.to_string());
        out.push_str(",0,");
        self.write_kins_for_race(&mut out, &c.field);
        out.push_str(",[");
        for (slot, rival) in c.field.iter().enumerate() {
            if slot > 0 {
                out.push(',');
            }
            let owner = self.kins.get(rival).and_then(|k| self.players.get(&k.owner));
            out.push_str("[\"");
            out.push_str(owner.map_or("Someone", |p| p.name.as_str()));
            out.push_str("\",1]");
        }
        out.push_str("]]");
        out
    }

    /// Hands in this player's run. Returns JSON: finishing tick (or 0 if it
    /// didn't finish), place among those who have run so far, how many have
    /// run, how many joined, and the NEAR won in millionths if it paid out.
    pub fn challenge_finish(&mut self, challenge: u32, moves: Vec<u16>) -> String {
        require!(moves.len() <= MAX_MOVES, "Too many moves");
        let me = env::predecessor_account_id();
        let now = now_secs();
        let c = self.challenges.get(&challenge).cloned().unwrap_or_else(|| env::panic_str("No such challenge"));
        require!(!c.settled, "That challenge has paid out");
        let slot = c.entries.iter().position(|e| e.player == me).unwrap_or_else(|| env::panic_str("You haven't joined that challenge"));
        let entry = &c.entries[slot];
        require!(entry.started > 0 && entry.ticks == 0, "There's no run of yours to hand in");
        require!(now <= entry.started + RUN_SECS, "That run has expired");

        let mut packed = entry.entrant.clone();
        packed.extend_from_slice(&c.field_entrants);
        let outcome = dash::replay(&c.seed, unpack_entrants(&packed), CHALLENGE_EASE, &moves);
        require!(
            now + CLOCK_SLACK_SECS >= entry.started + outcome.ticks / TICKS_PER_SEC,
            "That race finished faster than it could have been run"
        );
        let ticks = if outcome.player_finished { outcome.ticks } else { DID_NOT_FINISH };
        let kin_id = entry.kin;
        let record = self.challenges.get_mut(&challenge).expect("challenge");
        record.entries[slot].ticks = ticks;
        record.entries[slot].moves = moves;
        let full = record.entries.len() == record.seats as usize;
        let done = full && record.all_in();
        let standing = record.standings();
        let place = standing.iter().position(|&i| i == slot).unwrap_or(0) + 1;
        let handed_in = record.entries.iter().filter(|e| e.ticks != 0).count();
        let joined = record.entries.len();

        if let Some(kin) = self.kins.get_mut(&kin_id) {
            kin.xp = grow(kin.xp, RACE_XP, RACE_LEVEL_CAP);
        }
        let name = self.players.get(&me).map_or(String::new(), |p| p.name.clone());
        let host = self.players.get(&c.host).map_or(String::new(), |p| p.name.clone());
        if ticks != DID_NOT_FINISH {
            let tenths = ticks * 10 / TICKS_PER_SEC;
            self.tell_everyone(17, &name, &format!("ran {host}'s challenge in {}.{} s", tenths / 10, tenths % 10));
        }
        if done {
            self.settle(challenge);
        }
        let prize = self.challenges.get(&challenge).map_or(0, |c| c.entries[slot].prize);
        format!(
            "[{},{place},{handed_in},{joined},{}]",
            if ticks == DID_NOT_FINISH { 0 } else { ticks },
            prize / (MILLI / 1_000)
        )
    }

    /// Pays a challenge out once it has closed and nobody is still running,
    /// or early, if its host likes, once everyone who joined has run. Anyone
    /// can call it after the close.
    pub fn settle_challenge(&mut self, challenge: u32) {
        let me = env::predecessor_account_id();
        let now = now_secs();
        let c = self.challenges.get(&challenge).cloned().unwrap_or_else(|| env::panic_str("No such challenge"));
        require!(!c.settled, "That challenge has paid out");
        let closed = now >= c.closes_at() && !c.running(now);
        let early = me == c.host && c.entries.len() >= MIN_SEATS as usize && c.all_in();
        require!(closed || early, "That challenge is still open");
        self.settle(challenge);
    }
}

impl Valley {
    fn pay_entry_from_purse(&mut self, challenge: Option<u32>, kin_id: u32, fee_milli: u32, seats: u8) -> Promise {
        let me = env::predecessor_account_id();
        let fee = self
            .entry_fee(challenge, kin_id, fee_milli, seats, &me, now_secs())
            .unwrap_or_else(|| env::panic_str("You can't enter that challenge"));
        let price = yocto_from_milli(fee);
        let valley = env::current_account_id();
        Promise::new(me.clone())
            .function_call("release", release_input(price, &valley), NearToken::from_yoctonear(0), RELEASE_GAS)
            .then(Self::ext(valley).with_static_gas(ENTRY_GAS).on_entry_paid(challenge, kin_id, fee_milli, seats, me, U128(price)))
    }
}
