//! Players' stalls priced in NEAR, and the link to a player's NEAR Social account.
//!
//! Anyone can buy from a NEAR stall with any NEAR wallet, through
//! `buy_listing_near` with NEAR attached. A player can also pay from their own
//! farm account with `buy_listing_with_purse`, the same way hires are paid.
//! The seller is paid in NEAR the moment the sale goes through: to the wallet
//! they connected, or else to their farm account. A small cut feeds the
//! race prize pot.

use crate::ledger::log_transfer;
use crate::rentals::{release_input, yocto_from_milli, MILLI, RELEASE_GAS};
use crate::state::*;
use crate::{display_name, item_name, now_secs, Valley, ValleyExt};
use kinlings_core::items::{self, STALL_TAX_PCT};
use near_sdk::json_types::U128;
use near_sdk::{env, near, require, AccountId, Gas, NearToken, Promise, PromiseError};

const SALE_GAS: Gas = Gas::from_tgas(24);

fn refund(to: &AccountId, amount: u128) {
    if amount > 0 {
        Promise::new(to.clone()).transfer(NearToken::from_yoctonear(amount)).detach();
    }
}

/// "0.25" for 250 thousandths.
pub(crate) fn near_text(milli: u128) -> String {
    let whole = milli / 1_000;
    let part = milli % 1_000;
    if part == 0 {
        return whole.to_string();
    }
    let fraction = format!("{part:03}");
    format!("{whole}.{}", fraction.trim_end_matches('0'))
}

impl Valley {
    /// What `quantity` from a NEAR stall costs `buyer`, in yoctoNEAR, if they
    /// can buy it right now.
    fn near_sale(&self, id: u32, quantity: u32, buyer: &AccountId) -> Option<(Listing, u128)> {
        let listing = self.listings.get(&id)?.clone();
        if !listing.in_near || quantity == 0 || quantity > listing.quantity || listing.seller == *buyer {
            return None;
        }
        if !self.players.contains_key(buyer) {
            return None;
        }
        // The goods must still be sitting in escrow, or the sale would fail half way.
        let escrow = env::current_account_id();
        let now = now_secs();
        let in_escrow = match listing.kind {
            0 => true,
            1 => self.eggs.get(&listing.id).is_some_and(|e| e.owner == escrow && !e.hatching),
            _ => self.kins.get(&listing.id).is_some_and(|k| k.owner == escrow && !k.unborn && !k.rented_out(now)),
        };
        if !in_escrow {
            return None;
        }
        let price = yocto_from_milli(listing.unit_price) * quantity as u128;
        Some((listing, price))
    }

    /// Completes a NEAR sale that has been paid for, or sends the money back.
    pub(crate) fn settle_near_sale(&mut self, id: u32, quantity: u32, buyer: &AccountId, paid: u128, payer: &AccountId) -> bool {
        let Some((listing, price)) = self.near_sale(id, quantity, buyer).filter(|(_, price)| paid >= *price) else {
            refund(payer, paid);
            return false;
        };
        refund(payer, paid - price);

        let escrow = env::current_account_id();
        let (token, what) = match listing.kind {
            0 => {
                let item = listing.id as u16;
                self.credit(buyer, item, quantity);
                (items::token_id(item).to_string(), format!("{quantity} {}", item_name(item)))
            }
            1 => {
                self.hand_over_egg(listing.id, &escrow, buyer);
                (format!("egg:{}", listing.id), "an egg".to_string())
            }
            _ => {
                self.hand_over_kin(listing.id, &escrow, buyer);
                let name = self.kins.get(&listing.id).map_or(String::new(), |k| display_name(&k.name));
                (format!("kin:{}", listing.id), name)
            }
        };
        log_transfer(&escrow, buyer, &[token], &[quantity]);

        let to_seller = price - price * STALL_TAX_PCT as u128 / 100;
        let paid_out = self.pay_owner(&listing.seller, to_seller);
        self.near_pot += price - paid_out;
        self.remove_or_reduce_listing(id, listing, quantity);

        let who = self.players.get(buyer).map_or(String::new(), |p| p.name.clone());
        self.tell_everyone(16, &who, &format!("bought {what} for {} NEAR", near_text(price / MILLI)));
        true
    }
}

#[near]
impl Valley {
    /// Buys from a stall priced in NEAR, with NEAR attached, from any wallet.
    /// `farmer` is the player who gets what was bought, if not the wallet
    /// itself. Anything extra comes back, and so does all of it if the sale
    /// can't happen.
    #[payable]
    pub fn buy_listing_near(&mut self, listing: u32, quantity: u32, farmer: Option<AccountId>) -> bool {
        let payer = env::predecessor_account_id();
        let buyer = farmer.unwrap_or_else(|| payer.clone());
        self.settle_near_sale(listing, quantity, &buyer, env::attached_deposit().as_yoctonear(), &payer)
    }

    /// Buys from a stall priced in NEAR, paying from the player's own farm account.
    pub fn buy_listing_with_purse(&mut self, listing: u32, quantity: u32) -> Promise {
        let me = env::predecessor_account_id();
        let (_, price) = self.near_sale(listing, quantity, &me).unwrap_or_else(|| env::panic_str("That can't be bought right now"));
        Promise::new(me.clone())
            .function_call("release", release_input(price, &env::current_account_id()), NearToken::from_yoctonear(0), RELEASE_GAS)
            .then(Self::ext(env::current_account_id()).with_static_gas(SALE_GAS).on_sale_paid(listing, quantity, me, U128(price)))
    }

    #[private]
    pub fn on_sale_paid(&mut self, listing: u32, quantity: u32, buyer: AccountId, paid: U128, #[callback_result] sent: Result<(), PromiseError>) -> bool {
        if sent.is_err() {
            return false;
        }
        self.settle_near_sale(listing, quantity, &buyer, paid.0, &buyer)
    }

    /// Links this player's NEAR Social account, or unlinks it with `None`.
    /// On its own this is only a claim: the game shows a link as verified when
    /// the NEAR Social profile names this farm too, which only its owner can write.
    pub fn set_social(&mut self, account: Option<String>) {
        let me = env::predecessor_account_id();
        if let Some(name) = &account {
            require!(name.parse::<AccountId>().is_ok(), "That isn't a NEAR account name");
        }
        let player = self.players.get_mut(&me).unwrap_or_else(|| env::panic_str("Not a farmer"));
        let index = player.index;
        let old = std::mem::replace(&mut player.social, account.clone());
        if let Some(old) = old {
            if self.socials.get(&old) == Some(&index) {
                self.socials.remove(&old);
            }
        }
        if let Some(name) = account {
            self.socials.insert(name, index);
        }
    }
}
