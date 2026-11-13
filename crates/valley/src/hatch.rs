//! Eggs, pairings and births. A hatch is decided in a later block than the one
//! the player acted in, so nobody can see a bad roll coming or undo it.

use crate::state::*;
use crate::{display_name, now_secs, sub_account, Valley, ValleyExt};
use kinlings_core::genes::{self, Genes, NAMED_SPECIES, STARTERS};
use kinlings_core::items::{self, *};
use kinlings_core::rng::Rng;
use near_sdk::{env, near, require, AccountId, Gas, NearToken, Promise, PromiseError};

const ROLL_GAS: Gas = Gas::from_tgas(28);
const SPAWN_GAS: Gas = Gas::from_tgas(12);
const BORN_GAS: Gas = Gas::from_tgas(6);
const MAX_ACCOUNT_LEN: usize = 64;
const RESERVED: [&str; 4] = ["bramble", "cinder", "moth", "nanawick"];
/// How many children a Kinling's own record lists, for the family tree. It can
/// have any number. They all point back to it.
const CHILDREN_LISTED: usize = 12;

/// A Kinling name becomes part of an account id, so it is lowercase letters only.
fn check_name(name: &str) {
    require!((2..=12).contains(&name.len()), "Names are 2 to 12 letters");
    require!(name.bytes().all(|b| b.is_ascii_lowercase()), "Names use only the letters a to z");
    require!(!RESERVED.contains(&name), "That name is taken");
}

#[near]
impl Valley {
    /// Starts a hatch. The result is rolled in `on_hatch`, a later block.
    pub fn hatch(&mut self, egg_id: u32, name: String) -> Promise {
        check_name(&name);
        let me = env::predecessor_account_id();
        let now = now_secs();
        let egg = self.eggs.get_mut(&egg_id).unwrap_or_else(|| env::panic_str("No such egg"));
        require!(egg.owner == me, "That isn't your egg");
        require!(!egg.hatching, "It is already hatching");
        require!(egg.ready_at <= now, "It isn't ready yet");
        egg.hatching = true;

        Self::ext(env::current_account_id()).with_static_gas(ROLL_GAS).on_hatch(egg_id, name)
    }

    #[private]
    pub fn on_hatch(&mut self, egg_id: u32, name: String) -> Promise {
        let egg = self.eggs.get(&egg_id).expect("egg").clone();
        let mut rng = Rng::from_seed(&env::random_seed());

        let (genes, generation, parent) = self.roll_genes(&egg, &mut rng);
        let id = self.next_kin;
        self.next_kin += 1;

        // A baby is a sub-account of its mother. NEAR account names stop at 64
        // characters, so a line that long starts a new branch under the valley,
        // numbered to keep it unique. The family tree carries on regardless.
        let parent_account = parent.map(|k| k.account).filter(|mother| name.len() + 1 + mother.as_str().len() <= MAX_ACCOUNT_LEN);
        let full_name = match &parent_account {
            Some(mother) => format!("{name}.{mother}"),
            None if generation > 0 => format!("{name}{id}.{}", env::current_account_id()),
            None => format!("{name}.{}", env::current_account_id()),
        };
        let account: AccountId = full_name.parse().expect("account");

        self.kins.insert(
            id,
            Kin {
                name: name.clone(),
                account: account.clone(),
                owner: egg.owner.clone(),
                genes: genes.pack(),
                mother: egg.mother,
                father: egg.father,
                generation,
                xp: 0,
                rest_until: 0,
                stud_fee: 0,
                wins: 0,
                children: Vec::new(),
                child_count: 0,
                unborn: true,
                food: 0,
                rent_milli: 0,
                renter: None,
                rented_until: 0,
                race_ready_at: 0,
            },
        );

        let creating = match parent_account {
            Some(mother) => {
                let mut input = Vec::with_capacity(32 + name.len());
                input.extend_from_slice(&self.kin_code);
                input.extend_from_slice(name.as_bytes());
                Promise::new(mother).function_call("spawn", input, NearToken::from_yoctonear(0), SPAWN_GAS)
            }
            None => Promise::new(account).create_account().use_global_contract(self.kin_code),
        };
        creating.then(Self::ext(env::current_account_id()).with_static_gas(BORN_GAS).on_born(id, egg_id))
    }

    /// The account exists now, so the Kinling really has been born.
    #[private]
    pub fn on_born(&mut self, id: u32, egg_id: u32, #[callback_result] created: Result<(), PromiseError>) -> bool {
        if created.is_err() {
            // Most likely the name is taken. Put the egg back to try another.
            self.kins.remove(&id);
            self.eggs.get_mut(&egg_id).expect("egg").hatching = false;
            return false;
        }
        let egg = self.eggs.remove(&egg_id).expect("egg");
        let kin = self.kins.get_mut(&id).expect("kin");
        kin.unborn = false;
        let genes = Genes::unpack(&kin.genes);
        let (owner, name, mother, father) = (kin.owner.clone(), kin.name.clone(), kin.mother, kin.father);

        for parent in [mother, father] {
            if let Some(p) = self.kins.get_mut(&parent) {
                p.child_count += 1;
                if p.children.len() < CHILDREN_LISTED {
                    p.children.push(id);
                }
            }
        }
        let display = match self.players.get_mut(&owner) {
            Some(player) => {
                player.eggs.retain(|&e| e != egg_id);
                player.kins.push(id);
                player.name.clone()
            }
            None => "Someone".to_string(),
        };
        let _ = egg;
        self.record_species(genes.species(), &display, &name, &owner);
        true
    }

    /// The finder of a brand-new species gives it its name, once.
    pub fn name_species(&mut self, species: u16, name: String) {
        let me = env::predecessor_account_id();
        let index = self.players.get(&me).expect("Not a farmer").index;
        let chosen: String = name
            .chars()
            .filter(|c| c.is_ascii_alphabetic() || *c == ' ')
            .take(20)
            .collect();
        let chosen = chosen.trim().to_string();
        require!(chosen.len() >= 3, "Species names need at least 3 letters");
        let entry = self.species.get_mut(&species).expect("Nobody has found that yet");
        require!(entry.finder == index + 1, "Only its finder can name it");
        require!(!entry.named, "It already has a name");
        entry.name = chosen.clone();
        entry.named = true;
        let display = self.players.get(&me).expect("player").name.clone();
        self.tell_everyone(7, &display, &chosen);
    }

    /// Wraps an egg as a gift. The link holds a secret that can claim it once.
    pub fn gift_egg(&mut self, egg_id: u32, claim_key: String) {
        let me = env::predecessor_account_id();
        let egg = self.eggs.get_mut(&egg_id).expect("No such egg");
        require!(egg.owner == me && !egg.hatching, "That isn't your egg");
        require!(claim_key.len() == 64, "Bad gift key");
        let escrow = env::current_account_id();
        egg.owner = escrow;
        if let Some(player) = self.players.get_mut(&me) {
            player.eggs.retain(|&e| e != egg_id);
        }
        self.gifts.insert(claim_key, egg_id);
    }

    /// Claims a gifted egg. The signature proves the claimer holds the link's
    /// secret, and it is tied to their account so it can't be stolen from the chain.
    pub fn claim_gift(&mut self, claim_key: String, signature: String) {
        let me = env::predecessor_account_id();
        let egg_id = *self.gifts.get(&claim_key).expect("That gift has been claimed");
        let key: [u8; 32] = from_hex(&claim_key).try_into().expect("key");
        let signature: [u8; 64] = from_hex(&signature).try_into().expect("signature");
        require!(env::ed25519_verify(&signature, me.as_bytes(), &key), "That link doesn't match this gift");
        let player = self.players.get_mut(&me).expect("Not a farmer");
        player.eggs.push(egg_id);
        let name = player.name.clone();
        self.eggs.get_mut(&egg_id).expect("egg").owner = me;
        self.gifts.remove(&claim_key);
        self.tell_everyone(8, &name, "opened a gifted egg");
    }
}

impl Valley {
    #[cfg(test)]
    pub(crate) fn record_species_for_test(&mut self, species: u16, owner: &AccountId) {
        self.record_species(species, "Tester", "testling", owner);
    }

    fn roll_genes(&self, egg: &Egg, rng: &mut Rng) -> (Genes, u32, Option<Kin>) {
        let mother = self.kins.get(&egg.mother).cloned();
        let father = self.kins.get(&egg.father).cloned();
        match (mother, father) {
            (Some(m), Some(f)) => {
                let genes = genes::inherit(&Genes::unpack(&m.genes), &Genes::unpack(&f.genes), egg.food as u16, rng);
                let generation = m.generation.max(f.generation).saturating_add(1);
                (genes, generation, Some(m))
            }
            _ => {
                let species = if egg.wild {
                    NAMED_SPECIES[rng.below(NAMED_SPECIES.len() as u32) as usize].0
                } else {
                    STARTERS[rng.below(STARTERS.len() as u32) as usize]
                };
                (genes::founder(species, rng), 0, None)
            }
        }
    }

    /// Counts a birth. A species never seen before belongs to whoever found it.
    fn record_species(&mut self, species: u16, display: &str, kin_name: &str, owner: &AccountId) {
        let index = self.players.get(owner).map(|p| p.index);
        let oak = env::current_account_id();
        if let Some(entry) = self.species.get_mut(&species) {
            entry.count += 1;
            let (finder, known) = (entry.finder, entry.name.clone());
            if finder != 0 && Some(finder - 1) != index {
                if let Some(account) = self.roster.get(finder - 1).cloned() {
                    let royalty = oak_gift(SPECIES_ROYALTY, self.oak());
                    self.pay(&oak, &account, royalty);
                }
            }
            self.tell_everyone(1, display, &format!("hatched {} the {known}", display_name(kin_name)));
        } else {
            self.species.insert(
                species,
                Species {
                    name: "Unnamed".to_string(),
                    finder: index.map_or(0, |i| i + 1),
                    named: false,
                    count: 1,
                },
            );
            self.species_found.push(species);
            self.tell_everyone(2, display, "found a species nobody has ever seen");
        }
    }

    pub(crate) fn lay_egg(&mut self, owner: &AccountId, mother: u32, father: u32, food: u8, now: u32, wild: bool) -> u32 {
        let id = self.next_egg;
        self.next_egg += 1;
        self.eggs.insert(
            id,
            Egg {
                owner: owner.clone(),
                mother,
                father,
                food,
                ready_at: now + INCUBATE_SECS,
                warms: 0,
                hatching: false,
                wild,
            },
        );
        id
    }

    /// A first egg hatches fast: a new player should not have to wait.
    pub(crate) fn give_founder_egg(&mut self, account: &AccountId) {
        let id = self.next_egg;
        self.next_egg += 1;
        self.eggs.insert(
            id,
            Egg {
                owner: account.clone(),
                mother: 0,
                father: 0,
                food: 0,
                ready_at: now_secs(),
                warms: 0,
                hatching: false,
                wild: false,
            },
        );
        self.players.get_mut(account).expect("player").eggs.push(id);
    }

    pub(crate) fn breed(&mut self, me: &AccountId, player: &mut Player, mother: u32, father: u32, food: u16, now: u32) -> bool {
        if mother == father {
            return false;
        }
        let (Some(m), Some(f)) = (self.kins.get(&mother).cloned(), self.kins.get(&father).cloned()) else {
            return false;
        };
        let grown = |k: &Kin| !k.unborn && level_for(k.xp, &KIN_LEVELS) >= ADULT_LEVEL && k.rest_until <= now;
        // A Kinling on hire counts as yours for as long as you have it.
        if !m.controlled_by(me, now) || !grown(&m) || !grown(&f) {
            return false;
        }
        let stud_fee = if f.controlled_by(me, now) { 0 } else { f.stud_fee };
        if !f.controlled_by(me, now) && stud_fee == 0 {
            return false;
        }
        if food != 0 && items::food(food).is_none() {
            return false;
        }
        let total = PAIRING_FEE + stud_fee;
        if self.balance(me, ACORN) < total || (food != 0 && self.balance(me, food) == 0) {
            return false;
        }
        if food != 0 {
            self.burn(me, food, 1);
        }
        let oak = env::current_account_id();
        self.pay(me, &oak, PAIRING_FEE);
        if stud_fee > 0 {
            self.pay_kin(me, father, stud_fee);
        }
        self.kins.get_mut(&mother).expect("kin").rest_until = now + REST_SECS;
        self.kins.get_mut(&father).expect("kin").rest_until = now + REST_SECS;
        let id = self.lay_egg(me, mother, father, food as u8, now, false);
        player.eggs.push(id);
        let (name, mother_name, father_name) = (player.name.clone(), m.name, f.name);
        self.tell_everyone(3, &name, &format!("paired {} with {}", display_name(&mother_name), display_name(&father_name)));
        true
    }

    /// A computer-run neighbour's grown Kinling.
    pub(crate) fn make_elder_kin(&mut self, owner: AccountId, name: String, species: u16, stud_fee: u32, rent_milli: u32, index: u32) {
        check_name(&name);
        let mut rng = Rng::from_seed(&env::random_seed());
        let genes = genes::founder(species, &mut rng);
        let account = sub_account(&name);
        let id = self.next_kin;
        self.next_kin += 1;
        self.kins.insert(
            id,
            Kin {
                name,
                account: account.clone(),
                owner: owner.clone(),
                genes: genes.pack(),
                mother: 0,
                father: 0,
                generation: 0,
                xp: KIN_LEVELS[4],
                rest_until: 0,
                stud_fee,
                wins: 0,
                children: Vec::new(),
                child_count: 0,
                unborn: false,
                food: 0,
                rent_milli,
                renter: None,
                rented_until: 0,
                race_ready_at: 0,
            },
        );
        self.players.get_mut(&owner).expect("elder").kins.push(id);
        self.studs.push(id);
        if rent_milli > 0 {
            self.rentals.push(id);
        }
        let _ = index;
        Promise::new(account).create_account().use_global_contract(self.kin_code).detach();
    }
}

fn from_hex(text: &str) -> Vec<u8> {
    let bytes = text.as_bytes();
    require!(bytes.len() % 2 == 0, "Bad hex");
    let nibble = |c: u8| match c {
        b'0'..=b'9' => c - b'0',
        b'a'..=b'f' => c - b'a' + 10,
        _ => env::panic_str("Bad hex"),
    };
    bytes.chunks(2).map(|pair| nibble(pair[0]) << 4 | nibble(pair[1])).collect()
}
