//! Everything a player does in the normal loop.
//!
//! The browser queues taps and sends them together as `act`, a list of four
//! numbers each. A stale tap just fails on its own and the rest still count.

use crate::ledger::log_transfer;
use crate::state::*;
use crate::{now_secs, Valley, ValleyExt};
use kinlings_core::farm::Plot;
use kinlings_core::items::{self, *};
use kinlings_core::shop::{Shop, MAX_TRADE, SHOPS};
use near_sdk::{env, near, require, AccountId};

pub const PLANT: u32 = 1;
pub const WATER: u32 = 2;
pub const HARVEST: u32 = 3;
pub const FEED: u32 = 4;
pub const WARM: u32 = 5;
pub const SELL: u32 = 6;
pub const BUY: u32 = 7;
pub const INVEST: u32 = 8;
pub const CLAIM: u32 = 9;
pub const COLLECT: u32 = 10;
pub const WAVE: u32 = 11;
pub const BUY_LAND: u32 = 12;
pub const TONIC_EGG: u32 = 14;
pub const WILD_EGG_OPEN: u32 = 15;
pub const BREED: u32 = 20;
pub const STUD: u32 = 21;
pub const HIRE_OUT: u32 = 22;
pub const LIST_ITEM: u32 = 30;
pub const LIST_EGG: u32 = 31;
pub const LIST_KIN: u32 = 32;
pub const BUY_LISTING: u32 = 33;
pub const CANCEL_LISTING: u32 = 34;
/// The same three, priced in thousandths of a NEAR instead of acorns.
pub const LIST_ITEM_NEAR: u32 = 35;
pub const LIST_EGG_NEAR: u32 = 36;
pub const LIST_KIN_NEAR: u32 = 37;

const MAX_OPS: usize = 24;
const MAX_OPEN_LISTINGS: usize = 120;
/// The most one thing can be priced at on a stall, in thousandths of a NEAR.
pub const MAX_NEAR_PRICE_MILLI: u32 = 20_000;
const MAX_STUDS: usize = 80;
const PER_SHARE_SCALE: u128 = 1_000_000_000_000;

#[near]
impl Valley {
    /// A batch of moves from one player. Returns 1 or 0 for each move.
    pub fn act(&mut self, ops: Vec<[u32; 4]>) -> Vec<u8> {
        require!(ops.len() <= MAX_OPS, "Too many moves at once");
        let me = env::predecessor_account_id();
        let now = now_secs();
        let mut player = self.players.get(&me).unwrap_or_else(|| env::panic_str("Not a farmer")).clone();

        let results: Vec<u8> = ops
            .into_iter()
            .map(|op| self.apply(&me, &mut player, op, now) as u8)
            .collect();

        player.seen = now;
        let (index, xp) = (player.index, player.xp);
        self.players.insert(me, player);
        self.mark_seen(index, now);
        self.update_leaderboard(index, xp);
        results
    }
}

impl Valley {
    fn apply(&mut self, me: &AccountId, player: &mut Player, [code, a, b, c]: [u32; 4], now: u32) -> bool {
        match code {
            PLANT => self.plant(me, player, a as usize, b as u16, now),
            WATER => self.water(player, a, b as usize, now),
            HARVEST => self.harvest(me, player, a as usize, now),
            FEED => self.feed_kin(me, player, a, b as u16, now),
            WARM => self.warm_egg(player, a, now),
            SELL => self.sell_to_shop(me, a as usize, b, c, now),
            BUY => self.buy_from_shop(me, a as usize, b, c, now),
            INVEST => self.invest(me, a as usize, b, now),
            CLAIM => self.claim_dividend(me, a as usize),
            COLLECT => self.collect_purse(me, a),
            WAVE => self.wave(player, a, b),
            BUY_LAND => self.buy_land(me, player),
            TONIC_EGG => self.tonic_egg(me, a),
            WILD_EGG_OPEN => self.open_wild_egg(me, player, now),
            BREED => self.breed(me, player, a, b, c as u16, now),
            STUD => self.list_stud(me, a, b, now),
            HIRE_OUT => self.offer_for_hire(me, a, b),
            LIST_ITEM | LIST_ITEM_NEAR => self.list_item(me, a as u16, b, c, code == LIST_ITEM_NEAR),
            LIST_EGG | LIST_EGG_NEAR => self.list_egg(me, player, a, b, code == LIST_EGG_NEAR),
            LIST_KIN | LIST_KIN_NEAR => self.list_kin(me, player, a, b, now, code == LIST_KIN_NEAR),
            BUY_LISTING | CANCEL_LISTING => {
                // These hand things over through the stored player record, so
                // save this player first and pick up the result afterwards.
                self.players.insert(me.clone(), player.clone());
                let done = if code == BUY_LISTING {
                    self.buy_listing(me, a, b, c)
                } else {
                    self.cancel_listing(me, a)
                };
                *player = self.players.get(me).expect("player").clone();
                done
            }
            _ => false,
        }
    }

    // ----- Farming ------------------------------------------------------

    fn plant(&mut self, me: &AccountId, player: &mut Player, slot: usize, crop: u16, now: u32) -> bool {
        let Some(info) = items::crop(crop) else { return false };
        if slot >= player.plots.len() || level_for(player.xp, &FARMER_RANKS) < info.rank {
            return false;
        }
        let mut plot: Plot = player.plots[slot].into();
        if !plot.is_empty() || !self.burn(me, crop, 1) {
            return false;
        }
        plot.plant(crop, now);
        player.plots[slot] = plot.into();
        true
    }

    fn water(&mut self, helper: &mut Player, farm: u32, slot: usize, now: u32) -> bool {
        // Your own farm is already in memory, so never load a second copy of it.
        if farm == helper.index {
            let Some(saved) = helper.plots.get_mut(slot) else { return false };
            let mut plot: Plot = (*saved).into();
            if !plot.water(now) {
                return false;
            }
            *saved = plot.into();
            return true;
        }
        let Some(account) = self.roster.get(farm).cloned() else { return false };
        let Some(neighbour) = self.players.get_mut(&account) else { return false };
        let Some(saved) = neighbour.plots.get_mut(slot) else { return false };
        let mut plot: Plot = (*saved).into();
        if !plot.water(now) {
            return false;
        }
        *saved = plot.into();
        self.reward_help(helper, now);
        true
    }

    /// Helping someone else earns a little, up to a daily limit.
    fn reward_help(&mut self, helper: &mut Player, now: u32) {
        let day = (now / 86_400) as u16;
        if helper.helps_day != day {
            helper.helps_day = day;
            helper.helps = 0;
        }
        if helper.helps >= DAILY_HELPS {
            return;
        }
        helper.helps += 1;
        helper.xp += 1;
        let gift = oak_gift(HELP_ACORNS, self.oak());
        let oak = env::current_account_id();
        let account = self.roster.get(helper.index).cloned().expect("roster");
        self.pay(&oak, &account, gift);
    }

    fn harvest(&mut self, me: &AccountId, player: &mut Player, slot: usize, now: u32) -> bool {
        let Some(saved) = player.plots.get_mut(slot) else { return false };
        let mut plot: Plot = (*saved).into();
        let Some(crop) = plot.harvest(now) else { return false };
        *saved = plot.into();

        let info = items::crop(crop).expect("known crop");
        let index = (crop - SUNWHEAT) as usize;
        let units = info.harvest + mastery_bonus(player.mastery[index] as u32);
        player.mastery[index] = player.mastery[index].saturating_add(1);
        player.xp += info.rank as u32;
        self.mint(me, crop, units);

        // Now and then something rare turns up among the crop.
        let mut salt = me.as_bytes().to_vec();
        salt.extend_from_slice(&(slot as u32).to_le_bytes());
        if let Some(found) = pick_find(harvest_finds(crop), crate::roll(&salt)) {
            self.mint(me, found, 1);
            let name = player.name.clone();
            self.tell_everyone(15, &name, &format!("found {}", crate::with_article(found)));
        }
        true
    }

    fn feed_kin(&mut self, me: &AccountId, player: &mut Player, id: u32, item: u16, now: u32) -> bool {
        let Some(info) = items::food(item) else { return false };
        let Some(kin) = self.kins.get(&id) else { return false };
        // Every food raises a Kinling only so far: higher levels need finer food.
        if !kin.controlled_by(me, now) || kin.unborn || !food_helps(info, kin.xp) || !self.burn(me, item, 1) {
            return false;
        }
        let kin = self.kins.get_mut(&id).expect("kin");
        kin.xp = grow(kin.xp, info.xp, info.level_cap);
        kin.food = item as u8;
        player.xp += 1;
        true
    }

    fn warm_egg(&mut self, helper: &mut Player, id: u32, now: u32) -> bool {
        let Some(egg) = self.eggs.get_mut(&id) else { return false };
        if egg.hatching || egg.warms >= MAX_WARMS || egg.ready_at <= now {
            return false;
        }
        egg.warms += 1;
        egg.ready_at = egg.ready_at.saturating_sub(WARM_SECS).max(now);
        let owner = egg.owner.clone();
        let mine = self.roster.get(helper.index).is_some_and(|a| *a == owner);
        if !mine {
            self.reward_help(helper, now);
        }
        true
    }

    fn tonic_egg(&mut self, me: &AccountId, id: u32) -> bool {
        let owned = self.eggs.get(&id).is_some_and(|e| e.owner == *me && !e.hatching);
        if !owned || !self.burn(me, TONIC, 1) {
            return false;
        }
        let egg = self.eggs.get_mut(&id).expect("egg");
        egg.ready_at = egg.ready_at.saturating_sub(TONIC_SECS);
        true
    }

    fn open_wild_egg(&mut self, me: &AccountId, player: &mut Player, now: u32) -> bool {
        if !self.burn(me, WILD_EGG, 1) {
            return false;
        }
        let id = self.lay_egg(me, 0, 0, 0, now, true);
        player.eggs.push(id);
        true
    }

    fn collect_purse(&mut self, me: &AccountId, id: u32) -> bool {
        let Some(kin) = self.kins.get(&id) else { return false };
        if kin.owner != *me || kin.unborn {
            return false;
        }
        let account = kin.account.clone();
        let amount = self.balance(&account, ACORN);
        if amount == 0 {
            return false;
        }
        self.pay(&account, me, amount);
        log_transfer(&account, me, &[token_id(ACORN).to_string()], &[amount]);
        true
    }

    fn wave(&mut self, player: &Player, farm: u32, emote: u32) -> bool {
        let Some(account) = self.roster.get(farm).cloned() else { return false };
        let Some(them) = self.players.get(&account) else { return false };
        let target = them.name.clone();
        let name = player.name.clone();
        self.tell_everyone(10 + (emote % 4) as u8, &name, &target);
        true
    }

    // ----- Upgrades -----------------------------------------------------

    fn buy_land(&mut self, me: &AccountId, player: &mut Player) -> bool {
        let bought = (player.plots.len() as u8 - STARTING_PLOTS) / PLOTS_PER_LAND;
        let Some(&cost) = LAND_COSTS.get(bought as usize) else { return false };
        let oak = env::current_account_id();
        if !self.pay(me, &oak, cost) {
            return false;
        }
        for _ in 0..PLOTS_PER_LAND {
            player.plots.push(SavedPlot::default());
        }
        true
    }

    // ----- Shops --------------------------------------------------------

    /// Loads a shop from its record and its own ledger balances, and catches
    /// it up on the time that has passed.
    pub(crate) fn open_shop(&mut self, id: usize, now: u32) -> Option<(Shop, ShopRecord)> {
        let record = self.shops.get(&(id as u8))?.clone();
        let items = SHOPS[id].items;
        let held = self.balance(&record.account, ACORN);
        let stocks = [self.balance(&record.account, items[0].item), self.balance(&record.account, items[1].item)];
        let mut shop = record.as_shop(held - record.investor_pot, stocks);

        let oak_account = env::current_account_id();
        let mut oak = self.oak();
        let oak_before = oak;
        shop.catch_up(id, now, &mut oak, self.roster.len());
        // Time passing moves money between the Oak and the till, and stock on and off the shelf.
        if oak > oak_before {
            self.debit(&record.account, ACORN, oak - oak_before);
            self.credit(&oak_account, ACORN, oak - oak_before);
        } else if oak < oak_before {
            self.debit(&oak_account, ACORN, oak_before - oak);
            self.credit(&record.account, ACORN, oak_before - oak);
        }
        for slot in 0..2 {
            let now_stock = shop.shelves[slot].stock;
            if now_stock > stocks[slot] {
                self.mint(&record.account, items[slot].item, now_stock - stocks[slot]);
            } else if now_stock < stocks[slot] {
                self.burn(&record.account, items[slot].item, stocks[slot] - now_stock);
            }
        }
        Some((shop, record))
    }

    pub(crate) fn close_shop(&mut self, id: usize, shop: &Shop, record: &mut ShopRecord) {
        record.absorb(shop);
        self.shops.insert(id as u8, record.clone());
    }

    fn sell_to_shop(&mut self, me: &AccountId, market: usize, units: u32, min_each: u32, now: u32) -> bool {
        let (id, slot) = (market / 2, market % 2);
        if id >= SHOPS.len() || units == 0 || units > MAX_TRADE {
            return false;
        }
        let item = SHOPS[id].items[slot].item;
        if self.balance(me, item) < units {
            return false;
        }
        let Some((mut shop, mut record)) = self.open_shop(id, now) else { return false };
        let was_closed = shop.closed;
        let mut trial = shop;
        let accepted = trial
            .buy_from_player(id, slot, units)
            .filter(|&(taken, paid)| taken > 0 && paid >= min_each.saturating_mul(taken));
        let Some((taken, paid)) = accepted else {
            // Only the time that passed is kept, not the trade.
            self.close_shop(id, &shop, &mut record);
            return false;
        };
        shop = trial;
        self.debit(me, item, taken);
        self.credit(&record.account, item, taken);
        self.pay(&record.account, me, paid);
        log_transfer(me, &record.account, &[token_id(item).to_string()], &[taken]);
        log_transfer(&record.account, me, &[token_id(ACORN).to_string()], &[paid]);
        self.announce_closure(id, was_closed, shop.closed);
        self.close_shop(id, &shop, &mut record);
        true
    }

    fn buy_from_shop(&mut self, me: &AccountId, market: usize, units: u32, max_each: u32, now: u32) -> bool {
        let (id, slot) = (market / 2, market % 2);
        if id >= SHOPS.len() || units == 0 || units > MAX_TRADE {
            return false;
        }
        let item = SHOPS[id].items[slot].item;
        let Some((mut shop, mut record)) = self.open_shop(id, now) else { return false };
        let mut trial = shop;
        let Some(charged) = trial.sell_to_player(id, slot, units) else {
            self.close_shop(id, &shop, &mut record);
            return false;
        };
        if charged > max_each.saturating_mul(units) || self.balance(me, ACORN) < charged {
            self.close_shop(id, &shop, &mut record);
            return false;
        }
        shop = trial;
        self.pay(me, &record.account, charged);
        self.debit(&record.account, item, units);
        self.credit(me, item, units);
        log_transfer(me, &record.account, &[token_id(ACORN).to_string()], &[charged]);
        log_transfer(&record.account, me, &[token_id(item).to_string()], &[units]);
        self.share_with_investors(&mut shop, &mut record);
        self.close_shop(id, &shop, &mut record);
        true
    }

    /// With no investors, the slice set aside goes straight back into the till.
    fn share_with_investors(&mut self, shop: &mut Shop, record: &mut ShopRecord) {
        if record.shares == 0 {
            shop.till += shop.investor_pot;
            shop.investor_pot = 0;
        } else {
            let fresh = shop.investor_pot - record.investor_pot;
            record.per_share += fresh as u128 * PER_SHARE_SCALE / record.shares as u128;
        }
    }

    fn announce_closure(&mut self, id: usize, was_closed: bool, closed: bool) {
        if !was_closed && closed {
            self.tell_everyone(4, SHOPS[id].keeper, "ran out of money and closed");
        } else if was_closed && !closed {
            self.tell_everyone(5, SHOPS[id].keeper, "is open again");
        }
    }

    fn invest(&mut self, me: &AccountId, id: usize, acorns: u32, now: u32) -> bool {
        if id >= SHOPS.len() || acorns == 0 {
            return false;
        }
        let Some((mut shop, mut record)) = self.open_shop(id, now) else { return false };
        if !self.pay(me, &record.account, acorns) {
            self.close_shop(id, &shop, &mut record);
            return false;
        }
        let due = self.settle_dividend(me, id, &record);
        shop.investor_pot = shop.investor_pot.saturating_sub(due);
        let key = investment_key(id, me);
        let mut stake = self.investments.get(&key).copied().unwrap_or_default();
        stake.shares += acorns;
        stake.settled_per_share = record.per_share;
        self.investments.insert(key, stake);
        record.shares += acorns;

        let was_closed = shop.closed;
        shop.invest(id, acorns);
        self.announce_closure(id, was_closed, shop.closed);
        self.close_shop(id, &shop, &mut record);
        true
    }

    fn settle_dividend(&mut self, me: &AccountId, id: usize, record: &ShopRecord) -> u32 {
        let key = investment_key(id, me);
        let Some(stake) = self.investments.get(&key).copied() else { return 0 };
        let due = (stake.shares as u128 * (record.per_share - stake.settled_per_share) / PER_SHARE_SCALE) as u32;
        if due > 0 {
            self.pay(&record.account, me, due);
        }
        due
    }

    fn claim_dividend(&mut self, me: &AccountId, id: usize) -> bool {
        let Some(mut record) = self.shops.get(&(id as u8)).cloned() else { return false };
        let due = self.settle_dividend(me, id, &record);
        if due == 0 {
            return false;
        }
        let key = investment_key(id, me);
        let mut stake = self.investments.get(&key).copied().unwrap_or_default();
        stake.settled_per_share = record.per_share;
        self.investments.insert(key, stake);
        record.investor_pot = record.investor_pot.saturating_sub(due);
        self.shops.insert(id as u8, record);
        true
    }

    // ----- Player-owned stalls ------------------------------------------

    fn add_listing(&mut self, listing: Listing) -> bool {
        let too_dear = listing.in_near && listing.unit_price > MAX_NEAR_PRICE_MILLI;
        if self.open_listings.len() >= MAX_OPEN_LISTINGS || listing.unit_price == 0 || too_dear {
            return false;
        }
        let id = self.next_listing;
        self.next_listing += 1;
        self.listings.insert(id, listing);
        self.open_listings.push(id);
        true
    }

    fn list_item(&mut self, me: &AccountId, item: u16, quantity: u32, unit_price: u32, in_near: bool) -> bool {
        if item == ACORN || item >= ITEM_COUNT || quantity == 0 || unit_price == 0 || !self.debit(me, item, quantity) {
            return false;
        }
        let listed = self.add_listing(Listing { seller: me.clone(), kind: 0, id: item as u32, quantity, unit_price, in_near });
        if !listed {
            self.credit(me, item, quantity);
        }
        listed
    }

    fn list_egg(&mut self, me: &AccountId, player: &mut Player, id: u32, price: u32, in_near: bool) -> bool {
        if !self.eggs.get(&id).is_some_and(|e| e.owner == *me && !e.hatching) {
            return false;
        }
        if !self.add_listing(Listing { seller: me.clone(), kind: 1, id, quantity: 1, unit_price: price, in_near }) {
            return false;
        }
        let escrow = env::current_account_id();
        self.eggs.get_mut(&id).expect("egg").owner = escrow;
        player.eggs.retain(|&e| e != id);
        true
    }

    fn list_kin(&mut self, me: &AccountId, player: &mut Player, id: u32, price: u32, now: u32, in_near: bool) -> bool {
        if !self.kins.get(&id).is_some_and(|k| k.owner == *me && !k.unborn && !k.rented_out(now)) {
            return false;
        }
        if !self.add_listing(Listing { seller: me.clone(), kind: 2, id, quantity: 1, unit_price: price, in_near }) {
            return false;
        }
        let escrow = env::current_account_id();
        let kin = self.kins.get_mut(&id).expect("kin");
        kin.owner = escrow;
        kin.stud_fee = 0;
        self.studs.retain(|&k| k != id);
        self.stop_hire(id);
        player.kins.retain(|&k| k != id);
        true
    }

    fn buy_listing(&mut self, me: &AccountId, id: u32, quantity: u32, max_each: u32) -> bool {
        let Some(listing) = self.listings.get(&id).cloned() else { return false };
        // A stall priced in NEAR is paid with NEAR, through `buy_listing_near`.
        if listing.in_near || quantity == 0 || quantity > listing.quantity || listing.unit_price > max_each || listing.seller == *me {
            return false;
        }
        let total = listing.unit_price.saturating_mul(quantity);
        if self.balance(me, ACORN) < total {
            return false;
        }
        let tax = total * STALL_TAX_PCT / 100;
        let oak = env::current_account_id();
        self.pay(me, &listing.seller, total - tax);
        self.pay(me, &oak, tax);
        let escrow = oak;
        match listing.kind {
            0 => {
                self.credit(me, listing.id as u16, quantity);
            }
            1 => self.hand_over_egg(listing.id, &escrow, me),
            _ => {
                // A slice of any sale climbs the family tree.
                self.hand_over_kin(listing.id, &escrow, me);
            }
        }
        self.remove_or_reduce_listing(id, listing, quantity);
        true
    }

    pub(crate) fn remove_or_reduce_listing(&mut self, id: u32, mut listing: Listing, quantity: u32) {
        if quantity == listing.quantity {
            self.listings.remove(&id);
            self.open_listings.retain(|&l| l != id);
        } else {
            listing.quantity -= quantity;
            self.listings.insert(id, listing);
        }
    }

    fn cancel_listing(&mut self, me: &AccountId, id: u32) -> bool {
        let Some(listing) = self.listings.get(&id).cloned() else { return false };
        if listing.seller != *me {
            return false;
        }
        let escrow = env::current_account_id();
        match listing.kind {
            0 => self.credit(me, listing.id as u16, listing.quantity),
            1 => self.hand_over_egg(listing.id, &escrow, me),
            _ => self.hand_over_kin(listing.id, &escrow, me),
        }
        self.listings.remove(&id);
        self.open_listings.retain(|&l| l != id);
        true
    }

    fn list_stud(&mut self, me: &AccountId, id: u32, fee: u32, now: u32) -> bool {
        let Some(kin) = self.kins.get_mut(&id) else { return false };
        if kin.owner != *me || kin.unborn || kin.rented_out(now) || level_for(kin.xp, &KIN_LEVELS) < ADULT_LEVEL {
            return false;
        }
        kin.stud_fee = fee;
        if fee == 0 {
            self.studs.retain(|&k| k != id);
            return true;
        }
        if !self.studs.contains(&id) {
            if self.studs.len() >= MAX_STUDS {
                return false;
            }
            self.studs.push(id);
        }
        true
    }

    /// Pays a Kinling's own purse, with a slice climbing to its parents and grandparents.
    pub(crate) fn pay_kin(&mut self, from: &AccountId, id: u32, amount: u32) -> bool {
        self.pay_kin_holder(from, id, amount, None)
    }

    /// The same, but what the Kinling would keep goes to `holder` instead of
    /// its purse: a player gets their race winnings at once.
    pub(crate) fn pay_kin_holder(&mut self, from: &AccountId, id: u32, amount: u32, holder: Option<&AccountId>) -> bool {
        if !self.debit(from, ACORN, amount) {
            return false;
        }
        let Some(kin) = self.kins.get(&id).cloned() else {
            self.credit(from, ACORN, amount);
            return false;
        };
        let mut remaining = amount;
        for parent in [kin.mother, kin.father] {
            remaining -= self.pay_ancestor(parent, amount, PARENT_SHARE_PCT);
            if let Some(p) = self.kins.get(&parent).cloned() {
                remaining -= self.pay_ancestor(p.mother, amount, GRANDPARENT_SHARE_PCT);
                remaining -= self.pay_ancestor(p.father, amount, GRANDPARENT_SHARE_PCT);
            }
        }
        self.credit(holder.unwrap_or(&kin.account), ACORN, remaining);
        true
    }

    fn pay_ancestor(&mut self, id: u32, amount: u32, percent: u32) -> u32 {
        let Some(ancestor) = self.kins.get(&id) else { return 0 };
        let account = ancestor.account.clone();
        let cut = amount * percent / 100;
        self.credit(&account, ACORN, cut);
        cut
    }
}

fn investment_key(shop: usize, account: &AccountId) -> String {
    format!("{shop}:{account}")
}
