//! NEP-245: one contract holds every item in the game.
//!
//! Token ids are `acorn`, `sunwheat`, `tonic` and the like for stackable items,
//! and `egg:12` or `kin:34` for one-of-a-kind ones.

use crate::state::Bag;
use crate::{Valley, ValleyExt};
use kinlings_core::items;
use near_sdk::json_types::U128;
use near_sdk::{
    assert_one_yocto, env, ext_contract, near, require, AccountId, Gas, NearToken, PromiseOrValue,
};

const RECEIVER_GAS: Gas = Gas::from_tgas(30);
const RESOLVE_GAS: Gas = Gas::from_tgas(10);

pub enum Token {
    Item(u16),
    Egg(u32),
    Kin(u32),
}

pub fn parse_token(token: &str) -> Option<Token> {
    if let Some(id) = token.strip_prefix("kin:") {
        return id.parse().ok().map(Token::Kin);
    }
    if let Some(id) = token.strip_prefix("egg:") {
        return id.parse().ok().map(Token::Egg);
    }
    items::item_from_token(token).map(Token::Item)
}

#[near(serializers = [json])]
pub struct MtToken {
    pub token_id: String,
    pub owner_id: Option<AccountId>,
}

#[ext_contract(ext_receiver)]
#[allow(dead_code)]
trait Receiver {
    fn mt_on_transfer(
        &mut self,
        sender_id: AccountId,
        previous_owner_ids: Vec<AccountId>,
        token_ids: Vec<String>,
        amounts: Vec<U128>,
        msg: String,
    ) -> PromiseOrValue<Vec<U128>>;
}

fn log_event(event: &str, data: &str) {
    env::log_str(&format!(
        "EVENT_JSON:{{\"standard\":\"nep245\",\"version\":\"1.0.0\",\"event\":\"{event}\",\"data\":[{data}]}}"
    ));
}

/// Writes an `mt_transfer` event. All the names involved are valid account
/// ids or plain token ids, so they need no escaping.
pub fn log_transfer(from: &AccountId, to: &AccountId, tokens: &[String], amounts: &[u32]) {
    let ids = tokens.iter().map(|t| format!("\"{t}\"")).collect::<Vec<_>>().join(",");
    let quantities = amounts.iter().map(|a| format!("\"{a}\"")).collect::<Vec<_>>().join(",");
    log_event(
        "mt_transfer",
        &format!("{{\"old_owner_id\":\"{from}\",\"new_owner_id\":\"{to}\",\"token_ids\":[{ids}],\"amounts\":[{quantities}]}}"),
    );
}

pub fn log_mint_or_burn(event: &str, owner: &AccountId, token: &str, amount: u32) {
    log_event(
        event,
        &format!("{{\"owner_id\":\"{owner}\",\"token_ids\":[\"{token}\"],\"amounts\":[\"{amount}\"]}}"),
    );
}

impl Valley {
    pub(crate) fn balance(&self, account: &AccountId, item: u16) -> u32 {
        self.bags.get(account).map_or(0, |bag| bag.get(item))
    }

    pub(crate) fn credit(&mut self, account: &AccountId, item: u16, quantity: u32) {
        if quantity == 0 {
            return;
        }
        match self.bags.get_mut(account) {
            Some(bag) => bag.add(item, quantity),
            None => {
                let mut bag = Bag::default();
                bag.add(item, quantity);
                self.bags.insert(account.clone(), bag);
            }
        }
    }

    /// Returns false, changing nothing, if the balance is too low.
    pub(crate) fn debit(&mut self, account: &AccountId, item: u16, quantity: u32) -> bool {
        if quantity == 0 {
            return true;
        }
        match self.bags.get_mut(account) {
            Some(bag) => bag.take(item, quantity),
            None => false,
        }
    }

    /// Moves acorns between two holders. Returns false if the payer is short.
    pub(crate) fn pay(&mut self, from: &AccountId, to: &AccountId, acorns: u32) -> bool {
        if !self.debit(from, items::ACORN, acorns) {
            return false;
        }
        self.credit(to, items::ACORN, acorns);
        true
    }

    pub(crate) fn mint(&mut self, account: &AccountId, item: u16, quantity: u32) {
        self.credit(account, item, quantity);
        self.supply[item as usize] += quantity as u64;
        log_mint_or_burn("mt_mint", account, items::token_id(item), quantity);
    }

    pub(crate) fn burn(&mut self, account: &AccountId, item: u16, quantity: u32) -> bool {
        if !self.debit(account, item, quantity) {
            return false;
        }
        self.supply[item as usize] -= quantity as u64;
        log_mint_or_burn("mt_burn", account, items::token_id(item), quantity);
        true
    }

    fn holder_balance(&self, account: &AccountId, token: &str) -> u32 {
        match parse_token(token) {
            Some(Token::Item(item)) => self.balance(account, item),
            Some(Token::Kin(id)) => self.kins.get(&id).map_or(0, |k| (k.owner == *account && !k.unborn) as u32),
            Some(Token::Egg(id)) => self.eggs.get(&id).map_or(0, |e| (e.owner == *account) as u32),
            None => 0,
        }
    }

    fn token_supply(&self, token: &str) -> Option<U128> {
        let total = match parse_token(token)? {
            Token::Item(item) => self.supply[item as usize],
            Token::Kin(id) => self.kins.get(&id).filter(|k| !k.unborn).map(|_| 1)?,
            Token::Egg(id) => self.eggs.get(&id).map(|_| 1)?,
        };
        Some(U128(total as u128))
    }

    /// Moves one token and fixes up everything that points at its owner.
    fn move_token(&mut self, from: &AccountId, to: &AccountId, token: &str, amount: u128) {
        require!(amount > 0 && amount <= u32::MAX as u128, "Bad amount");
        let amount = amount as u32;
        match parse_token(token).unwrap_or_else(|| env::panic_str("Unknown token")) {
            Token::Item(item) => {
                require!(self.debit(from, item, amount), "Not enough to send");
                self.credit(to, item, amount);
            }
            Token::Kin(id) => {
                require!(amount == 1, "A Kinling is one of a kind");
                self.hand_over_kin(id, from, to);
            }
            Token::Egg(id) => {
                require!(amount == 1, "An egg is one of a kind");
                self.hand_over_egg(id, from, to);
            }
        }
    }

    pub(crate) fn hand_over_kin(&mut self, id: u32, from: &AccountId, to: &AccountId) {
        let kin = self.kins.get_mut(&id).unwrap_or_else(|| env::panic_str("No such Kinling"));
        require!(kin.owner == *from && !kin.unborn, "That Kinling isn't yours to give");
        require!(!kin.rented_out(crate::now_secs()), "That Kinling is out on hire");
        kin.owner = to.clone();
        kin.stud_fee = 0;
        self.studs.retain(|&k| k != id);
        self.stop_hire(id);
        if let Some(sender) = self.players.get_mut(from) {
            sender.kins.retain(|&k| k != id);
        }
        if let Some(receiver) = self.players.get_mut(to) {
            receiver.kins.push(id);
        }
    }

    pub(crate) fn hand_over_egg(&mut self, id: u32, from: &AccountId, to: &AccountId) {
        let egg = self.eggs.get_mut(&id).unwrap_or_else(|| env::panic_str("No such egg"));
        require!(egg.owner == *from && !egg.hatching, "That egg isn't yours to give");
        egg.owner = to.clone();
        if let Some(sender) = self.players.get_mut(from) {
            sender.eggs.retain(|&e| e != id);
        }
        if let Some(receiver) = self.players.get_mut(to) {
            receiver.eggs.push(id);
        }
    }

    fn check_lengths(token_ids: &[String], amounts: &[U128]) {
        require!(!token_ids.is_empty() && token_ids.len() == amounts.len(), "Token and amount lists differ");
        require!(token_ids.len() <= 16, "Too many tokens at once");
    }

    fn batch_move(&mut self, from: &AccountId, to: &AccountId, token_ids: &[String], amounts: &[U128]) {
        require!(from != to, "Sending to yourself");
        Self::check_lengths(token_ids, amounts);
        for (token, amount) in token_ids.iter().zip(amounts) {
            self.move_token(from, to, token, amount.0);
        }
        let quantities: Vec<u32> = amounts.iter().map(|a| a.0 as u32).collect();
        log_transfer(from, to, token_ids, &quantities);
    }
}

type Approval = Option<(AccountId, u64)>;

#[near]
impl Valley {
    pub fn mt_balance_of(&self, account_id: AccountId, token_id: String) -> U128 {
        U128(self.holder_balance(&account_id, &token_id) as u128)
    }

    pub fn mt_batch_balance_of(&self, account_id: AccountId, token_ids: Vec<String>) -> Vec<U128> {
        token_ids.iter().map(|t| U128(self.holder_balance(&account_id, t) as u128)).collect()
    }

    pub fn mt_supply(&self, token_id: String) -> Option<U128> {
        self.token_supply(&token_id)
    }

    pub fn mt_batch_supply(&self, token_ids: Vec<String>) -> Vec<Option<U128>> {
        token_ids.iter().map(|t| self.token_supply(t)).collect()
    }

    pub fn mt_token(&self, token_ids: Vec<String>) -> Vec<Option<MtToken>> {
        token_ids
            .into_iter()
            .map(|token_id| {
                self.token_supply(&token_id)?;
                let owner_id = match parse_token(&token_id)? {
                    Token::Kin(id) => self.kins.get(&id).map(|k| k.owner.clone()),
                    Token::Egg(id) => self.eggs.get(&id).map(|e| e.owner.clone()),
                    Token::Item(_) => None,
                };
                Some(MtToken { token_id, owner_id })
            })
            .collect()
    }

    #[payable]
    pub fn mt_transfer(
        &mut self,
        receiver_id: AccountId,
        token_id: String,
        amount: U128,
        approval: Approval,
        memo: Option<String>,
    ) {
        assert_one_yocto();
        let _ = memo;
        require!(approval.is_none(), "Approvals are not supported");
        let sender = env::predecessor_account_id();
        self.batch_move(&sender, &receiver_id, &[token_id], &[amount]);
    }

    #[payable]
    pub fn mt_batch_transfer(
        &mut self,
        receiver_id: AccountId,
        token_ids: Vec<String>,
        amounts: Vec<U128>,
        approvals: Option<Vec<Approval>>,
        memo: Option<String>,
    ) {
        assert_one_yocto();
        let _ = memo;
        require!(approvals.is_none(), "Approvals are not supported");
        let sender = env::predecessor_account_id();
        self.batch_move(&sender, &receiver_id, &token_ids, &amounts);
    }

    #[payable]
    pub fn mt_transfer_call(
        &mut self,
        receiver_id: AccountId,
        token_id: String,
        amount: U128,
        approval: Approval,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<Vec<U128>> {
        require!(approval.is_none(), "Approvals are not supported");
        self.mt_batch_transfer_call(receiver_id, vec![token_id], vec![amount], None, memo, msg)
    }

    #[payable]
    pub fn mt_batch_transfer_call(
        &mut self,
        receiver_id: AccountId,
        token_ids: Vec<String>,
        amounts: Vec<U128>,
        approvals: Option<Vec<Approval>>,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<Vec<U128>> {
        assert_one_yocto();
        let _ = memo;
        require!(approvals.is_none(), "Approvals are not supported");
        let sender = env::predecessor_account_id();
        self.batch_move(&sender, &receiver_id, &token_ids, &amounts);
        let owners = vec![sender.clone(); token_ids.len()];
        ext_receiver::ext(receiver_id.clone())
            .with_static_gas(RECEIVER_GAS)
            .with_attached_deposit(NearToken::from_yoctonear(0))
            .mt_on_transfer(sender.clone(), owners, token_ids.clone(), amounts.clone(), msg)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(RESOLVE_GAS)
                    .mt_resolve_transfer(sender, receiver_id, token_ids, amounts),
            )
            .into()
    }

    /// Takes back whatever the receiver says it did not use. Returns the
    /// amounts the receiver kept.
    #[private]
    pub fn mt_resolve_transfer(
        &mut self,
        sender_id: AccountId,
        receiver_id: AccountId,
        token_ids: Vec<String>,
        amounts: Vec<U128>,
    ) -> Vec<U128> {
        let unused: Vec<U128> = match env::promise_result_checked(0, 4_096) {
            Ok(value) => near_sdk::serde_json::from_slice::<Vec<U128>>(&value)
                .ok()
                .filter(|list| list.len() == amounts.len())
                .unwrap_or_else(|| vec![U128(0); amounts.len()]),
            Err(_) => amounts.clone(),
        };
        let mut kept = Vec::with_capacity(amounts.len());
        for (index, token) in token_ids.iter().enumerate() {
            let sent = amounts[index].0;
            let held = self.holder_balance(&receiver_id, token) as u128;
            let refund = unused[index].0.min(sent).min(held);
            if refund > 0 {
                self.move_token(&receiver_id, &sender_id, token, refund);
                log_transfer(&receiver_id, &sender_id, core::slice::from_ref(token), &[refund as u32]);
            }
            kept.push(U128(sent - refund));
        }
        kept
    }
}
