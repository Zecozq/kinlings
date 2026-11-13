//! Hiring Kinlings for real NEAR, and being paid it.
//!
//! Anyone can pay from any NEAR wallet by calling `rent_kin` with NEAR attached.
//! A player with no wallet can pay from their own farm account: its key can't
//! attach NEAR, so the valley asks the account to send it, through the same tiny
//! contract every Kinling runs. That account will only obey the valley, and the
//! valley only asks when the account's own key said to.
//!
//! The owner's share goes straight to their account the moment a hire is paid.

use crate::state::*;
use crate::{now_secs, Valley, ValleyExt};
use near_sdk::json_types::U128;
use near_sdk::{env, near, require, AccountId, Gas, NearToken, Promise, PromiseError};

/// One thousandth of a NEAR. Prices are set in these.
pub const MILLI: u128 = 1_000_000_000_000_000_000_000;
/// How long one hire lasts.
pub const RENT_SECS: u32 = 1_800;
pub const MAX_RENT_MILLI: u32 = 5_000;
/// Of each hire: the owner's share, in percent.
const OWNER_PCT: u128 = 85;
/// Each parent's owner gets this much. What's left feeds the NEAR prize pot.
const PARENT_PCT: u128 = 3;
const MAX_RENTALS: usize = 64;
/// The most Kinlings one farmer can have on hire at a time.
const MAX_HIRED: usize = 16;

pub(crate) const RELEASE_GAS: Gas = Gas::from_tgas(5);
const PAID_GAS: Gas = Gas::from_tgas(16);

pub const fn yocto_from_milli(milli: u32) -> u128 {
    milli as u128 * MILLI
}

/// The input the Kinling contract's `release` expects.
pub(crate) fn release_input(amount: u128, to: &AccountId) -> Vec<u8> {
    let mut input = Vec::with_capacity(16 + to.as_str().len());
    input.extend_from_slice(&amount.to_le_bytes());
    input.extend_from_slice(to.as_bytes());
    input
}

impl Valley {
    pub(crate) fn offer_for_hire(&mut self, me: &AccountId, id: u32, milli: u32) -> bool {
        let Some(kin) = self.kins.get_mut(&id) else { return false };
        if kin.owner != *me || kin.unborn || milli > MAX_RENT_MILLI {
            return false;
        }
        if milli == 0 {
            kin.rent_milli = 0;
            self.rentals.retain(|&k| k != id);
            return true;
        }
        if !self.rentals.contains(&id) {
            if self.rentals.len() >= MAX_RENTALS {
                return false;
            }
            self.rentals.push(id);
        }
        kin.rent_milli = milli;
        true
    }

    /// Takes a Kinling off the hire list, as when it is sold.
    pub(crate) fn stop_hire(&mut self, id: u32) {
        if let Some(kin) = self.kins.get_mut(&id) {
            kin.rent_milli = 0;
        }
        self.rentals.retain(|&k| k != id);
    }

    /// Pays a Kinling's owner straight to their account. Elders have no use for
    /// money, so what they would earn stays in the prize pot.
    pub(crate) fn pay_owner(&mut self, owner: &AccountId, amount: u128) -> u128 {
        let Some(player) = self.players.get_mut(owner) else { return 0 };
        if player.elder || amount == 0 {
            return 0;
        }
        player.near_earned += amount;
        let to = player.wallet.clone().unwrap_or_else(|| owner.clone());
        Promise::new(to).transfer(NearToken::from_yoctonear(amount)).detach();
        amount
    }

    fn share_rent(&mut self, kin: &Kin, price: u128) {
        let mut left = price;
        left -= self.pay_owner(&kin.owner, price * OWNER_PCT / 100);
        for parent in [kin.mother, kin.father] {
            if let Some(owner) = self.kins.get(&parent).map(|p| p.owner.clone()) {
                left -= self.pay_owner(&owner, price * PARENT_PCT / 100);
            }
        }
        self.near_pot += left;
    }

    /// Books a hire that has been paid for, or sends the money back.
    pub(crate) fn start_rental(&mut self, kin_id: u32, renter: &AccountId, paid: u128, payer: &AccountId) -> bool {
        let now = now_secs();
        let on_offer = self
            .kins
            .get(&kin_id)
            .filter(|k| !k.unborn && k.rent_milli > 0 && !k.rented_out(now) && k.owner != *renter)
            .cloned();
        let hired_now = self.players.get(renter).map(|p| {
            p.rented
                .iter()
                .filter(|id| self.kins.get(id).is_some_and(|k| k.rented_out(now) && k.renter.as_ref() == Some(renter)))
                .count()
        });
        let price = on_offer.as_ref().map_or(0, |k| yocto_from_milli(k.rent_milli));
        let accepted = on_offer.filter(|_| hired_now.is_some_and(|count| count < MAX_HIRED) && paid >= price);
        let Some(kin) = accepted else {
            if paid > 0 {
                Promise::new(payer.clone()).transfer(NearToken::from_yoctonear(paid)).detach();
            }
            return false;
        };
        if paid > price {
            Promise::new(payer.clone()).transfer(NearToken::from_yoctonear(paid - price)).detach();
        }

        let record = self.kins.get_mut(&kin_id).expect("kin");
        record.renter = Some(renter.clone());
        record.rented_until = now + RENT_SECS;

        let kins = &self.kins;
        let player = self.players.get_mut(renter).expect("renter");
        player.rented.retain(|id| kins.get(id).is_some_and(|k| k.rented_out(now) && k.renter.as_ref() == Some(renter)));
        player.rented.push(kin_id);
        let who = player.name.clone();

        self.share_rent(&kin, price);
        self.tell_everyone(14, &who, &format!("hired {}", crate::display_name(&kin.name)));
        true
    }
}

#[near]
impl Valley {
    /// Hires a Kinling with NEAR attached, from any wallet. `farmer` is the
    /// player who gets the Kinling, if that isn't the wallet itself.
    #[payable]
    pub fn rent_kin(&mut self, kin_id: u32, farmer: Option<AccountId>) -> bool {
        let payer = env::predecessor_account_id();
        let renter = farmer.unwrap_or_else(|| payer.clone());
        self.start_rental(kin_id, &renter, env::attached_deposit().as_yoctonear(), &payer)
    }

    /// Hires a Kinling with NEAR from the player's own farm account.
    pub fn rent_with_purse(&mut self, kin_id: u32) -> Promise {
        let me = env::predecessor_account_id();
        require!(self.players.contains_key(&me), "Not a farmer");
        let kin = self.kins.get(&kin_id).unwrap_or_else(|| env::panic_str("No such Kinling"));
        require!(kin.rent_milli > 0, "That Kinling isn't for hire");
        let price = yocto_from_milli(kin.rent_milli);
        Promise::new(me.clone())
            .function_call("release", release_input(price, &env::current_account_id()), NearToken::from_yoctonear(0), RELEASE_GAS)
            .then(Self::ext(env::current_account_id()).with_static_gas(PAID_GAS).on_purse_paid(kin_id, me, U128(price)))
    }

    #[private]
    pub fn on_purse_paid(&mut self, kin_id: u32, renter: AccountId, paid: U128, #[callback_result] sent: Result<(), PromiseError>) -> bool {
        if sent.is_err() {
            return false;
        }
        self.start_rental(kin_id, &renter, paid.0, &renter)
    }

    /// Says where this player's NEAR earnings should go, or back to their farm
    /// account if `None`. Only this player's own key can call this.
    pub fn set_wallet(&mut self, wallet: Option<AccountId>) {
        let me = env::predecessor_account_id();
        let player = self.players.get_mut(&me).unwrap_or_else(|| env::panic_str("Not a farmer"));
        player.wallet = wallet;
    }

    /// Sends NEAR from the player's farm account to their wallet.
    pub fn cash_out(&mut self, milli: u32, to: Option<AccountId>) -> Promise {
        let me = env::predecessor_account_id();
        let player = self.players.get(&me).unwrap_or_else(|| env::panic_str("Not a farmer"));
        let target = to.or_else(|| player.wallet.clone()).unwrap_or_else(|| env::panic_str("Where to? Connect a wallet first"));
        require!(milli > 0, "Nothing to send");
        Promise::new(me).function_call("release", release_input(yocto_from_milli(milli), &target), NearToken::from_yoctonear(0), RELEASE_GAS)
    }

    /// Adds to the NEAR prize pot. Anyone can.
    #[payable]
    pub fn fund_pot(&mut self) {
        self.near_pot += env::attached_deposit().as_yoctonear();
    }
}
