//! The Valley Dash practice race. A race starts the moment a player wants one,
//! free, against other people's real Kinlings running on instinct. The browser
//! plays it live. When it ends, the contract plays the same moves through the
//! same rules and pays what it saw: acorns from the Old Oak, crops and now and
//! then a rare food. Never NEAR: racing real people for NEAR is `challenges.rs`.
//!
//! Your rivals run for their owners, whether or not those owners are awake.
//! If one beats you, its owner gets that place's acorns.

use crate::state::*;
use crate::{display_name, now_secs, Valley, ValleyExt};
use kinlings_core::dash::{self, pack_entrants, unpack_entrants, Entrant, MAX_MOVES, PRIZES_PCT, RACERS, TICKS_PER_SEC};
use kinlings_core::genes::Genes;
use kinlings_core::items::*;
use near_sdk::{env, near, require, AccountId};

/// How many Kinlings are looked at to find well-matched rivals.
const RIVAL_PROBES: u32 = 16;
/// Friends whose Kinlings can be asked to race, and how many of each one's.
const MAX_FRIENDS: usize = 8;
const FRIEND_KINS: usize = 2;
/// New players' rivals start clumsy and sharpen up with each race they run.
const EASE_START: u32 = 27;
const EASE_STEP: u32 = 3;
/// A race not handed in by now has been abandoned.
const RUN_EXPIRES_SECS: u32 = 600;
/// Allowed difference between the race's own clock and the chain's.
const CLOCK_SLACK_SECS: u32 = 4;
const RACERS_KEPT: usize = 10;

pub(crate) fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(DIGITS[(byte >> 4) as usize] as char);
        out.push(DIGITS[(byte & 15) as usize] as char);
    }
    out
}

impl Valley {
    pub(crate) fn entrant_of(&self, id: u32) -> Entrant {
        let kin = self.kins.get(&id).expect("kin");
        Entrant::new(&Genes::unpack(&kin.genes), level_for(kin.xp, &KIN_LEVELS), kin.generation)
    }

    /// Picks five rivals of about the same strength as this Kinling. Anyone's
    /// Kinling may be drawn, including the Elders', so a new valley still has a
    /// race. Kinlings from `friends`' farms come first, if any are given.
    fn pick_rivals(&self, me: &AccountId, kin_id: u32, seed: &[u8], friends: &[u32]) -> [u32; RACERS - 1] {
        let mut rng = kinlings_core::rng::Rng::from_seed(seed);
        let mine = self.entrant_of(kin_id);
        let strength = |e: &Entrant| e.speed as u32 + e.stamina as u32 + dash::level_speed(e.level) as u32 * 2;
        let total = self.next_kin.saturating_sub(1).max(1);

        let mut candidates: Vec<(u32, u32)> = Vec::with_capacity(RIVAL_PROBES as usize + 24);
        let mut consider = |id: u32, valley: &Valley, friend: bool| {
            if id == kin_id || candidates.iter().any(|c| c.1 == id) {
                return;
            }
            let Some(kin) = valley.kins.get(&id) else { return };
            if kin.unborn || kin.owner == *me {
                return;
            }
            let gap = if friend { 0 } else { 1 + strength(&mine).abs_diff(strength(&valley.entrant_of(id))) };
            candidates.push((gap, id));
        };
        for &farm in friends.iter().take(MAX_FRIENDS) {
            let Some(friend) = self.roster.get(farm).and_then(|account| self.players.get(account)) else { continue };
            for &id in friend.kins.iter().rev().take(FRIEND_KINS) {
                consider(id, self, true);
            }
        }
        for _ in 0..RIVAL_PROBES {
            consider(1 + rng.below(total), self, false);
        }
        // The first few Kinlings are the Elders', so a line-up can always be filled.
        for id in 1..=8 {
            consider(id, self, false);
        }
        candidates.sort_unstable();

        let mut rivals = [0u32; RACERS - 1];
        for (slot, rival) in rivals.iter_mut().enumerate() {
            // Too few Kinlings in the valley? Someone runs twice.
            *rival = candidates.get(slot).or_else(|| candidates.first()).map_or(kin_id, |c| c.1);
        }
        rivals
    }

    fn refill_race_budget(&mut self, now: u32) {
        let gained = now.saturating_sub(self.race_budget_at).saturating_mul(RACE_BUDGET_PER_SEC);
        self.race_budget = self.race_budget.saturating_add(gained).min(RACE_BUDGET_CAP);
        self.race_budget_at = now;
    }

    pub(crate) fn note_win(&mut self, kin_id: u32) {
        let Some(kin) = self.kins.get_mut(&kin_id) else { return };
        kin.wins = kin.wins.saturating_add(1);
        let wins = kin.wins;
        if let Some(entry) = self.top_racers.iter_mut().find(|e| e.0 == kin_id) {
            entry.1 = wins;
        } else if self.top_racers.len() < RACERS_KEPT {
            self.top_racers.push((kin_id, wins));
        } else if let Some(lowest) = (0..self.top_racers.len()).min_by_key(|&i| self.top_racers[i].1) {
            if self.top_racers[lowest].1 < wins {
                self.top_racers[lowest] = (kin_id, wins);
            }
        }
        self.top_racers.sort_unstable_by(|a, b| b.1.cmp(&a.1));
    }
}

#[near]
impl Valley {
    /// Lines up a race. Returns JSON: the seed, the racers' numbers as hex,
    /// how easy the rivals are, whether the prize is boosted, the rivals, and
    /// their owners' names.
    pub fn race_start(&mut self, kin_id: u32, friends: Option<Vec<u32>>) -> String {
        let me = env::predecessor_account_id();
        let now = now_secs();
        let kin = self.kins.get(&kin_id).cloned().unwrap_or_else(|| env::panic_str("No such Kinling"));
        require!(!kin.unborn && kin.controlled_by(&me, now), "That Kinling isn't yours to race");

        let player = self.players.get_mut(&me).unwrap_or_else(|| env::panic_str("Not a farmer"));
        let ease = EASE_START.saturating_sub(player.races.saturating_mul(EASE_STEP)) as u8;
        player.races = player.races.saturating_add(1);
        player.seen = now;
        let index = player.index;

        let mut salted = env::random_seed();
        salted.extend_from_slice(&index.to_le_bytes());
        salted.extend_from_slice(&now.to_le_bytes());
        let seed: [u8; 32] = env::sha256(&salted).try_into().expect("32 bytes");

        let rivals = self.pick_rivals(&me, kin_id, &seed, &friends.unwrap_or_default());
        let mut entrants = [Entrant::default(); RACERS];
        entrants[0] = self.entrant_of(kin_id);
        for (slot, rival) in rivals.iter().enumerate() {
            entrants[slot + 1] = self.entrant_of(*rival);
        }
        let packed = pack_entrants(&entrants);

        let rested = kin.race_ready_at <= now;
        if rested {
            self.kins.get_mut(&kin_id).expect("kin").race_ready_at = now + RACE_REST_SECS;
        }
        self.runs.insert(index, Run { kin: kin_id, rivals, seed, entrants: packed.to_vec(), started: now, ease, rested });
        self.mark_seen(index, now);

        let mut out = String::with_capacity(1_024);
        out.push_str("[\"");
        out.push_str(&hex(&seed));
        out.push_str("\",\"");
        out.push_str(&hex(&packed));
        out.push_str("\",");
        out.push_str(&ease.to_string());
        out.push(',');
        out.push(if rested { '1' } else { '0' });
        out.push(',');
        self.write_kins_for_race(&mut out, &rivals);
        out.push_str(",[");
        for (slot, rival) in rivals.iter().enumerate() {
            if slot > 0 {
                out.push(',');
            }
            let owner = self.kins.get(rival).and_then(|k| self.players.get(&k.owner));
            out.push('[');
            out.push('"');
            out.push_str(owner.map_or("Someone", |p| p.name.as_str()));
            out.push_str("\",");
            out.push(if owner.is_some_and(|p| p.elder) { '1' } else { '0' });
            out.push(']');
        }
        out.push_str("]]");
        out
    }

    /// Hands in a finished race. The contract runs it again from the moves
    /// alone, so a browser can't claim anything that didn't happen.
    /// Returns JSON: finishing order, acorns won, finishing tick, trips,
    /// obstacles cleared, hits landed, the Oak's boost, a rare find, and the
    /// crop won with how many.
    pub fn race_finish(&mut self, moves: Vec<u16>) -> String {
        require!(moves.len() <= MAX_MOVES, "Too many moves");
        let me = env::predecessor_account_id();
        let now = now_secs();
        let index = self.players.get(&me).unwrap_or_else(|| env::panic_str("Not a farmer")).index;
        let run = self.runs.remove(&index).unwrap_or_else(|| env::panic_str("No race to finish"));
        require!(now <= run.started + RUN_EXPIRES_SECS, "That race has expired");

        let outcome = dash::replay(&run.seed, unpack_entrants(&run.entrants), run.ease, &moves);
        require!(
            now + CLOCK_SLACK_SECS >= run.started + outcome.ticks / TICKS_PER_SEC,
            "That race finished faster than it could have been run"
        );

        // A rested Kinling's race has a prize from the Oak, out of a budget that
        // refills over time, so racing can't drain the Oak.
        let oak = env::current_account_id();
        self.refill_race_budget(now);
        let bonus = if run.rested { oak_gift(RACE_BONUS, self.oak()).min(self.race_budget) } else { 0 };
        self.race_budget -= bonus;
        let pot = bonus;

        let kin_of = |racer: u8| if racer == 0 { run.kin } else { run.rivals[racer as usize - 1] };
        let mut won = 0;
        let mut place_won = None;
        for (place, share) in PRIZES_PCT.iter().enumerate() {
            let racer = outcome.order[place];
            let prize = pot * share / 100;
            if racer == 0 {
                place_won = Some(place);
                if prize > 0 {
                    self.pay_kin_holder(&oak, run.kin, prize, Some(&me));
                }
                won = prize;
            } else if prize > 0 {
                let rival = kin_of(racer);
                let owner_is_person = self
                    .kins
                    .get(&rival)
                    .and_then(|k| self.players.get(&k.owner))
                    .is_some_and(|p| !p.elder);
                // An Elder has no use for acorns, so its share just stays with the Oak.
                if owner_is_person {
                    self.pay_kin(&oak, rival, prize);
                }
            }
        }

        let winner_racer = outcome.order[0];
        let winner_kin = kin_of(winner_racer);
        self.note_win(winner_kin);

        // A rested Kinling in the first three brings home crops the player can grow.
        let mut crop_won = (0u16, 0u32);
        if let (true, Some(place)) = (run.rested, place_won) {
            let rank = level_for(self.players.get(&me).map_or(0, |p| p.xp), &FARMER_RANKS);
            let unlocked: Vec<u16> = CROPS.iter().filter(|c| c.rank <= rank).map(|c| c.item).collect();
            let mut salt = me.as_bytes().to_vec();
            salt.push(b'c');
            let crop = unlocked[crate::roll(&salt) as usize % unlocked.len()];
            let units = RACE_CROP_PRIZES[place];
            self.mint(&me, crop, units);
            crop_won = (crop, units);
        }

        // Racing is how a Kinling grows up fast, up to a point. Past that, only food will do.
        let player_won = winner_racer == 0;
        if let Some(kin) = self.kins.get_mut(&run.kin) {
            let gain = if player_won { RACE_XP + RACE_WIN_XP } else { RACE_XP };
            kin.xp = grow(kin.xp, gain, RACE_LEVEL_CAP);
        }
        // A rested winner sometimes brings home something rare.
        let mut found = 0u16;
        if player_won && run.rested {
            let mut salt = me.as_bytes().to_vec();
            salt.push(b'd');
            if let Some(item) = pick_find(&RACE_WIN_FINDS, crate::roll(&salt)) {
                self.mint(&me, item, 1);
                found = item;
            }
        }
        let player = self.players.get_mut(&me).expect("player");
        player.xp += 2;
        player.seen = now;
        let (name, xp) = (player.name.clone(), player.xp);
        self.update_leaderboard(index, xp);
        self.mark_seen(index, now);
        if player_won {
            let kin_name = self.kins.get(&run.kin).map_or(String::new(), |k| k.name.clone());
            let mut news = format!("won the Valley Dash with {}", display_name(&kin_name));
            if found != 0 {
                news.push_str(&format!(" and found {}", crate::with_article(found)));
            }
            self.tell_everyone(6, &name, &news);
        }

        let mut out = String::with_capacity(96);
        out.push('[');
        out.push('[');
        for (slot, racer) in outcome.order.iter().enumerate() {
            if slot > 0 {
                out.push(',');
            }
            out.push_str(&racer.to_string());
        }
        out.push_str("],");
        let found = found as u32;
        for value in [won, outcome.ticks, outcome.trips as u32, outcome.cleared as u32, outcome.hits_landed as u32, bonus, found, crop_won.0 as u32] {
            out.push_str(&value.to_string());
            out.push(',');
        }
        out.push_str(&crop_won.1.to_string());
        out.push(']');
        out
    }
}
