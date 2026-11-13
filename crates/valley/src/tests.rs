//! Whole-flow tests. Each one plays through the contract the way a browser would.

use crate::actions::*;
use crate::Valley;
use kinlings_core::dash;
use kinlings_core::genes::{self, NAMED_SPECIES};
use kinlings_core::items::{self, *};
use kinlings_core::rng::Rng;
use kinlings_core::shop::SHOPS;
use near_sdk::json_types::U128;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{testing_env, AccountId, NearToken, PromiseResult, PublicKey, RuntimeFeesConfig};

const VALLEY: &str = "kinlings.testnet";
const CODE_HASH: &str = "b84fca8d0485e2bf991a4f0565096238629ce0f5acb7d5df47626cba4d3d5e4f";

fn id(name: &str) -> AccountId {
    name.parse().unwrap()
}

fn context(caller: &str, now: u32) -> VMContextBuilder {
    let mut builder = VMContextBuilder::new();
    builder
        .current_account_id(id(VALLEY))
        .predecessor_account_id(id(caller))
        .signer_account_id(id(caller))
        .block_timestamp(now as u64 * 1_000_000_000)
        .account_balance(NearToken::from_near(100))
        .random_seed([now as u8; 32]);
    builder
}

fn at(caller: &str, now: u32) {
    testing_env!(context(caller, now).build());
}

fn at_with_results(caller: &str, now: u32, results: Vec<PromiseResult>) {
    testing_env!(
        context(caller, now).build(),
        near_sdk::test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        results
    );
}

fn session_key() -> PublicKey {
    "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp".parse().unwrap()
}

fn valley() -> Valley {
    at(VALLEY, 1_000);
    Valley::new(id(VALLEY), CODE_HASH.to_string())
}

/// Opens a farm and returns its account name.
fn farmer(v: &mut Valley, name: &str, now: u32) -> AccountId {
    at("anyone.testnet", now);
    let index = v.roster.len();
    v.open_account(session_key(), name.to_string(), None);
    format!("f{index}.{VALLEY}").parse().unwrap()
}

fn oak() -> AccountId {
    id(VALLEY)
}

/// Every acorn the test can see, wherever it is.
fn all_acorns(v: &Valley) -> u64 {
    let mut total = v.balance(&oak(), ACORN) as u64;
    for shop in 0..SHOPS.len() as u8 {
        total += v.balance(&v.shops.get(&shop).unwrap().account, ACORN) as u64;
    }
    for index in 0..v.roster.len() {
        total += v.balance(v.roster.get(index).unwrap(), ACORN) as u64;
    }
    for kin in 1..v.next_kin {
        if let Some(k) = v.kins.get(&kin) {
            total += v.balance(&k.account, ACORN) as u64;
        }
    }
    total
}

/// Hatches an egg all the way through both callbacks, returning the new Kinling's id.
fn hatch(v: &mut Valley, who: &AccountId, egg: u32, name: &str, now: u32) -> u32 {
    at(who.as_str(), now);
    v.hatch(egg, name.to_string());
    at(VALLEY, now + 1);
    v.on_hatch(egg, name.to_string());
    let kin = v.next_kin - 1;
    at_with_results(VALLEY, now + 2, vec![PromiseResult::Successful(vec![])]);
    assert!(v.on_born(kin, egg, Ok(())));
    kin
}

fn first_egg(v: &Valley, who: &AccountId) -> u32 {
    *v.players.get(who).unwrap().eggs.first().expect("an egg")
}

fn grow(v: &mut Valley, kin: u32) {
    v.kins.get_mut(&kin).unwrap().xp = KIN_LEVELS[ADULT_LEVEL as usize];
}

/// A pure-bred Kinling of a species, so tests know what it looks like.
fn give_grown_kin(v: &mut Valley, who: &AccountId, name: &str, species: u16, now: u32) -> u32 {
    let egg = first_egg_or_new(v, who, now);
    let kin = hatch(v, who, egg, name, now);
    let mut rng = Rng::from_seed(name.as_bytes());
    v.kins.get_mut(&kin).unwrap().genes = genes::founder(species, &mut rng).pack();
    grow(v, kin);
    kin
}

fn first_egg_or_new(v: &mut Valley, who: &AccountId, now: u32) -> u32 {
    match v.players.get(who).unwrap().eggs.first() {
        Some(egg) => *egg,
        None => {
            let egg = v.lay_egg(who, 0, 0, 0, now - 1, false);
            v.eggs.get_mut(&egg).unwrap().ready_at = now - 1;
            v.players.get_mut(who).unwrap().eggs.push(egg);
            egg
        }
    }
}

#[test]
fn a_new_valley_holds_exactly_every_acorn() {
    let v = valley();
    assert_eq!(all_acorns(&v), TOTAL_ACORNS as u64);
    assert_eq!(v.mt_supply("acorn".to_string()), Some(U128(TOTAL_ACORNS as u128)));
    assert_eq!(v.mt_balance_of(id("bramble.kinlings.testnet"), "acorn".to_string()), U128(3_500));
}

#[test]
fn a_new_farmer_gets_a_welcome_kit_and_an_egg() {
    let mut v = valley();
    let me = farmer(&mut v, "Rahul", 1_000);
    assert_eq!(me.as_str(), "f0.kinlings.testnet");
    assert_eq!(v.balance(&me, ACORN), WELCOME_ACORNS);
    assert_eq!(v.balance(&me, SUNWHEAT), 8);
    let egg = first_egg(&v, &me);
    assert_eq!(v.mt_balance_of(me.clone(), format!("egg:{egg}")), U128(1));
    assert_eq!(all_acorns(&v), TOTAL_ACORNS as u64);
}

#[test]
#[should_panic(expected = "The valley is out of travel money")]
fn the_front_door_shuts_before_storage_is_at_risk() {
    let mut v = valley();
    let mut poor = context("anyone.testnet", 1_000);
    poor.account_balance(NearToken::from_millinear(350)).storage_usage(0);
    testing_env!(poor.build());
    v.open_account(session_key(), "Asha".to_string(), None);
}

#[test]
fn display_names_are_cleaned() {
    let mut v = valley();
    let me = farmer(&mut v, "  <b>Ro\"bert</b>  ", 1_000);
    assert_eq!(v.players.get(&me).unwrap().name, "bRobertb");
}

#[test]
fn crops_grow_and_pay_out() {
    let mut v = valley();
    let me = farmer(&mut v, "Asha", 1_000);
    at(me.as_str(), 1_000);
    assert_eq!(v.act(vec![[PLANT, 0, SUNWHEAT as u32, 0]]), vec![1]);
    assert_eq!(v.balance(&me, SUNWHEAT), 7);

    at(me.as_str(), 1_039);
    assert_eq!(v.act(vec![[HARVEST, 0, 0, 0]]), vec![0], "not ripe yet");

    at(me.as_str(), 1_040);
    assert_eq!(v.act(vec![[HARVEST, 0, 0, 0]]), vec![1]);
    assert_eq!(v.balance(&me, SUNWHEAT), 9);
}

#[test]
fn one_stale_tap_does_not_spoil_the_batch() {
    let mut v = valley();
    let me = farmer(&mut v, "Asha", 1_000);
    at(me.as_str(), 1_000);
    let results = v.act(vec![
        [PLANT, 0, SUNWHEAT as u32, 0],
        [PLANT, 0, SUNWHEAT as u32, 0],
        [PLANT, 1, SUNWHEAT as u32, 0],
    ]);
    assert_eq!(results, vec![1, 0, 1]);
}

#[test]
fn locked_crops_need_a_higher_rank() {
    let mut v = valley();
    let me = farmer(&mut v, "Asha", 1_000);
    v.mint(&me, STARFIG, 1);
    at(me.as_str(), 1_000);
    assert_eq!(v.act(vec![[PLANT, 0, STARFIG as u32, 0]]), vec![0]);
    assert_eq!(v.balance(&me, STARFIG), 1);
}

#[test]
fn crop_mastery_adds_to_the_harvest() {
    let mut v = valley();
    let me = farmer(&mut v, "Asha", 1_000);
    v.players.get_mut(&me).unwrap().mastery[0] = MASTERY_HARVESTS[1] as u16;
    at(me.as_str(), 1_000);
    v.act(vec![[PLANT, 0, SUNWHEAT as u32, 0]]);
    at(me.as_str(), 1_100);
    v.act(vec![[HARVEST, 0, 0, 0]]);
    assert_eq!(v.balance(&me, SUNWHEAT), 7 + 2 + 2);
}

#[test]
fn watering_a_neighbour_helps_them_and_pays_the_helper_up_to_a_limit() {
    let mut v = valley();
    let owner = farmer(&mut v, "Asha", 1_000);
    let helper = farmer(&mut v, "Ben", 1_000);
    at(owner.as_str(), 1_000);
    v.act(vec![[PLANT, 0, EMBERROOT as u32 - 2, 0]]);
    let ready = v.players.get(&owner).unwrap().plots[0].ready_at;

    at(helper.as_str(), 1_000);
    let before = v.balance(&helper, ACORN);
    assert_eq!(v.act(vec![[WATER, 0, 0, 0]]), vec![1]);
    assert!(v.players.get(&owner).unwrap().plots[0].ready_at < ready);
    assert_eq!(v.balance(&helper, ACORN), before + HELP_ACORNS);

    v.players.get_mut(&helper).unwrap().helps_day = (1_000 / 86_400) as u16;
    v.players.get_mut(&helper).unwrap().helps = DAILY_HELPS;
    let capped = v.balance(&helper, ACORN);
    assert_eq!(v.act(vec![[WATER, 0, 0, 0]]), vec![1]);
    assert_eq!(v.balance(&helper, ACORN), capped);
    assert_eq!(all_acorns(&v), TOTAL_ACORNS as u64);
}

#[test]
fn selling_to_a_shop_moves_goods_and_money_and_keeps_every_acorn() {
    let mut v = valley();
    let me = farmer(&mut v, "Asha", 1_000);
    v.mint(&me, SUNWHEAT, 40);
    let shop = id("bramble.kinlings.testnet");
    let shelf = v.balance(&shop, SUNWHEAT);

    at(me.as_str(), 1_000);
    assert_eq!(v.act(vec![[SELL, 0, 30, 1]]), vec![1]);
    assert_eq!(v.balance(&me, SUNWHEAT), 8 + 40 - 30);
    assert_eq!(v.balance(&shop, SUNWHEAT), shelf + 30);
    assert!(v.balance(&me, ACORN) > WELCOME_ACORNS);
    assert_eq!(all_acorns(&v), TOTAL_ACORNS as u64);
}

#[test]
fn a_seller_is_protected_by_their_minimum_price() {
    let mut v = valley();
    let me = farmer(&mut v, "Asha", 1_000);
    at(me.as_str(), 1_000);
    assert_eq!(v.act(vec![[SELL, 0, 2, 9_999]]), vec![0]);
    assert_eq!(v.balance(&me, SUNWHEAT), 8);
    assert_eq!(v.balance(&me, ACORN), WELCOME_ACORNS);
}

#[test]
fn a_failed_trade_keeps_the_clock_honest() {
    // Regression: a rejected sale must not apply villager demand twice.
    let mut v = valley();
    let me = farmer(&mut v, "Asha", 1_000);
    let shop = id("bramble.kinlings.testnet");
    v.credit(&shop, SUNWHEAT, 400);
    v.supply[SUNWHEAT as usize] += 400;

    at(me.as_str(), 2_800);
    v.act(vec![[SELL, 0, 2, 9_999]]);
    let after_first = v.balance(&shop, SUNWHEAT);
    assert!(after_first < 200 + 400, "villagers should have bought some");
    at(me.as_str(), 2_800);
    v.act(vec![[SELL, 0, 2, 9_999]]);
    assert_eq!(v.balance(&shop, SUNWHEAT), after_first, "no time passed, so no villagers came");
    assert_eq!(all_acorns(&v), TOTAL_ACORNS as u64);
}

#[test]
fn prices_slide_when_a_market_is_flooded() {
    let mut v = valley();
    let me = farmer(&mut v, "Asha", 1_000);
    v.mint(&me, SUNWHEAT, 200);
    at(me.as_str(), 1_000);
    let first_unit = {
        let (shop, _) = v.open_shop(0, 1_000).unwrap();
        shop.quote(0, 0).shop_pays
    };
    v.act(vec![[SELL, 0, 60, 1], [SELL, 0, 60, 1], [SELL, 0, 60, 1]]);
    let (shop, _) = v.open_shop(0, 1_000).unwrap();
    assert!(shop.quote(0, 0).shop_pays < first_unit);
}

#[test]
fn a_broke_shop_closes_and_an_investor_reopens_it_and_earns() {
    let mut v = valley();
    let investor = farmer(&mut v, "Asha", 1_000);
    let buyer = farmer(&mut v, "Ben", 1_000);
    let shop = id("bramble.kinlings.testnet");

    // Empty the till.
    let till = v.balance(&shop, ACORN);
    v.pay(&shop, &oak(), till - 10);
    v.pay(&oak(), &investor, 5_000);
    v.pay(&oak(), &buyer, 5_000);
    v.mint(&investor, DEWBEAN, 10);
    at(investor.as_str(), 1_000);
    v.act(vec![[SELL, 1, 10, 1]]);
    assert!(v.shops.get(&0).unwrap().closed);

    at(buyer.as_str(), 1_000);
    assert_eq!(v.act(vec![[BUY, 1, 1, 9_999]]), vec![0], "a closed shop sells nothing");

    at(investor.as_str(), 1_000);
    assert_eq!(v.act(vec![[INVEST, 0, 2_000, 0]]), vec![1]);
    assert!(!v.shops.get(&0).unwrap().closed);
    assert_eq!(v.stake_of(0, &investor).0, 2_000);

    at(buyer.as_str(), 1_000);
    assert_eq!(v.act(vec![[BUY, 1, 40, 9_999]]), vec![1]);
    let (_, due) = v.stake_of(0, &investor);
    assert!(due > 0, "the investor is owed a slice of that sale");

    let before = v.balance(&investor, ACORN);
    at(investor.as_str(), 1_000);
    assert_eq!(v.act(vec![[CLAIM, 0, 0, 0]]), vec![1]);
    assert_eq!(v.balance(&investor, ACORN), before + due);
    assert_eq!(v.stake_of(0, &investor).1, 0);
    assert_eq!(all_acorns(&v), TOTAL_ACORNS as u64);
}

#[test]
fn an_investor_adding_more_gets_their_dividend_and_the_books_still_balance() {
    // Regression: settling during a top-up must come out of the investor pot.
    let mut v = valley();
    let investor = farmer(&mut v, "Asha", 1_000);
    let buyer = farmer(&mut v, "Ben", 1_000);
    v.pay(&oak(), &investor, 9_000);
    v.pay(&oak(), &buyer, 9_000);
    at(investor.as_str(), 1_000);
    v.act(vec![[INVEST, 0, 1_000, 0]]);
    at(buyer.as_str(), 1_000);
    v.act(vec![[BUY, 1, 30, 9_999]]);
    let due = v.stake_of(0, &investor).1;
    assert!(due > 0);
    let pot_before = v.shops.get(&0).unwrap().investor_pot;

    at(investor.as_str(), 1_000);
    v.act(vec![[INVEST, 0, 1_000, 0]]);
    assert_eq!(v.shops.get(&0).unwrap().investor_pot, pot_before - due);
    assert_eq!(v.stake_of(0, &investor).1, 0);
    assert_eq!(all_acorns(&v), TOTAL_ACORNS as u64);
}

#[test]
fn a_first_egg_hatches_at_once_into_a_real_account() {
    let mut v = valley();
    let me = farmer(&mut v, "Asha", 1_000);
    let egg = first_egg(&v, &me);
    let kin = hatch(&mut v, &me, egg, "ember", 1_000);

    let record = v.kins.get(&kin).unwrap();
    assert_eq!(record.account.as_str(), "ember.kinlings.testnet");
    assert_eq!(record.generation, 0);
    assert!(!record.unborn);
    assert!(v.players.get(&me).unwrap().kins.contains(&kin));
    assert!(v.players.get(&me).unwrap().eggs.is_empty());
    assert_eq!(v.mt_supply(format!("kin:{kin}")), Some(U128(1)));
    assert_eq!(v.mt_supply(format!("egg:{egg}")), None);
}

#[test]
fn if_a_name_is_taken_the_egg_comes_back() {
    let mut v = valley();
    let me = farmer(&mut v, "Asha", 1_000);
    let egg = first_egg(&v, &me);
    at(me.as_str(), 1_000);
    v.hatch(egg, "ember".to_string());
    at(VALLEY, 1_001);
    v.on_hatch(egg, "ember".to_string());
    let kin = v.next_kin - 1;
    at_with_results(VALLEY, 1_002, vec![PromiseResult::Failed]);
    assert!(!v.on_born(kin, egg, Err(near_sdk::PromiseError::Failed)));
    assert!(v.kins.get(&kin).is_none());
    assert!(!v.eggs.get(&egg).unwrap().hatching);
    assert_eq!(first_egg(&v, &me), egg);
}

#[test]
fn a_baby_is_a_sub_account_of_its_mother() {
    let mut v = valley();
    let mum = farmer(&mut v, "Asha", 1_000);
    let dad = farmer(&mut v, "Ben", 1_000);
    let mother = give_grown_kin(&mut v, &mum, "ember", NAMED_SPECIES[0].0, 1_000);
    let father = give_grown_kin(&mut v, &dad, "pearl", NAMED_SPECIES[2].0, 1_000);
    v.pay(&oak(), &mum, 1_000);

    at(dad.as_str(), 1_010);
    assert_eq!(v.act(vec![[STUD, father, 50, 0]]), vec![1]);
    at(mum.as_str(), 1_010);
    assert_eq!(v.act(vec![[BREED, mother, father, SUNWHEAT as u32]]), vec![1]);
    assert_eq!(v.balance(&v.kins.get(&father).unwrap().account.clone(), ACORN), 50);

    let egg = first_egg(&v, &mum);
    let ready = v.eggs.get(&egg).unwrap().ready_at;
    let baby = hatch(&mut v, &mum, egg, "spark", ready);
    let child = v.kins.get(&baby).unwrap();
    assert_eq!(child.account.as_str(), "spark.ember.kinlings.testnet");
    assert_eq!(child.generation, 1);
    assert_eq!(child.mother, mother);
    assert_eq!(child.father, father);
    assert!(v.kins.get(&mother).unwrap().children.contains(&baby));
    assert_eq!(all_acorns(&v), TOTAL_ACORNS as u64);
}

#[test]
fn you_cannot_pair_with_a_kinling_that_is_not_offered() {
    let mut v = valley();
    let mum = farmer(&mut v, "Asha", 1_000);
    let dad = farmer(&mut v, "Ben", 1_000);
    let mother = give_grown_kin(&mut v, &mum, "ember", NAMED_SPECIES[0].0, 1_000);
    let father = give_grown_kin(&mut v, &dad, "pearl", NAMED_SPECIES[2].0, 1_000);
    v.pay(&oak(), &mum, 1_000);
    at(mum.as_str(), 1_010);
    assert_eq!(v.act(vec![[BREED, mother, father, 0]]), vec![0]);
}

#[test]
fn a_kinling_can_pair_again_after_resting() {
    let mut v = valley();
    let me = farmer(&mut v, "Asha", 1_000);
    let a = give_grown_kin(&mut v, &me, "ember", NAMED_SPECIES[0].0, 1_000);
    let b = give_grown_kin(&mut v, &me, "pearl", NAMED_SPECIES[2].0, 1_000);
    v.pay(&oak(), &me, 1_000);
    at(me.as_str(), 1_010);
    assert_eq!(v.act(vec![[BREED, a, b, 0]]), vec![1]);
    assert_eq!(v.act(vec![[BREED, a, b, 0]]), vec![0], "still resting");
    at(me.as_str(), 1_010 + REST_SECS);
    assert_eq!(v.act(vec![[BREED, a, b, 0]]), vec![1]);
}

#[test]
fn there_is_no_limit_on_eggs_or_children() {
    let mut v = valley();
    let me = farmer(&mut v, "Asha", 1_000);
    let a = give_grown_kin(&mut v, &me, "ember", NAMED_SPECIES[0].0, 1_000);
    let b = give_grown_kin(&mut v, &me, "pearl", NAMED_SPECIES[2].0, 1_000);
    v.pay(&oak(), &me, 20_000);
    let mut now = 1_010;
    for _ in 0..30 {
        at(me.as_str(), now);
        assert_eq!(v.act(vec![[BREED, a, b, 0]]), vec![1]);
        now += REST_SECS;
    }
    assert_eq!(v.players.get(&me).unwrap().eggs.len(), 30, "nothing stops a nest filling up");

    let eggs = v.players.get(&me).unwrap().eggs.clone();
    for (n, egg) in eggs.iter().enumerate() {
        let name: String = format!("b{}", ["a", "b", "c", "d", "e", "f"][n % 6].repeat(n % 5 + 1)) + ["x", "y", "z", "q", "w"][n / 6];
        hatch(&mut v, &me, *egg, &name, now + 500);
    }
    let parent = v.kins.get(&a).unwrap();
    assert_eq!(parent.child_count, 30);
    assert_eq!(parent.children.len(), 12, "only the first few are listed on the parent");
    assert_eq!(v.players.get(&me).unwrap().kins.len(), 32);
}

#[test]
fn a_family_line_never_runs_out_of_room() {
    let mut v = valley();
    let me = farmer(&mut v, "Asha", 1_000);
    let mut mother = give_grown_kin(&mut v, &me, "firstofall", NAMED_SPECIES[0].0, 1_000);
    let father = give_grown_kin(&mut v, &me, "pearl", NAMED_SPECIES[2].0, 1_000);
    v.pay(&oak(), &me, 20_000);
    let mut now = 1_010;
    let mut longest = 0;
    let mut branched = false;
    for generation in 1..=14u32 {
        at(me.as_str(), now);
        assert_eq!(v.act(vec![[BREED, mother, father, 0]]), vec![1], "generation {generation}");
        let egg = *v.players.get(&me).unwrap().eggs.last().unwrap();
        let ready = v.eggs.get(&egg).unwrap().ready_at;
        let name = format!("littleone{}", ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m", "n"][generation as usize - 1]);
        let baby = hatch(&mut v, &me, egg, &name, ready);
        let child = v.kins.get(&baby).unwrap();
        assert_eq!(child.generation, generation);
        assert_eq!(child.mother, mother);
        assert!(child.account.as_str().len() <= 64);
        longest = longest.max(child.account.as_str().len());
        if child.account.as_str().starts_with(&format!("{name}{baby}.")) {
            branched = true;
        }
        grow(&mut v, baby);
        mother = baby;
        now = ready + REST_SECS + 10;
    }
    assert!(branched, "a long line should have started a new branch (longest {longest})");
}

#[test]
fn babies_are_stronger_and_keep_their_parents_powers() {
    let mut v = valley();
    let me = farmer(&mut v, "Asha", 1_000);
    let mother = give_grown_kin(&mut v, &me, "ember", NAMED_SPECIES[0].0, 1_000);
    let father = give_grown_kin(&mut v, &me, "pearl", NAMED_SPECIES[2].0, 1_000);
    v.pay(&oak(), &me, 1_000);
    at(me.as_str(), 1_010);
    v.act(vec![[BREED, mother, father, 0]]);
    let egg = *v.players.get(&me).unwrap().eggs.last().unwrap();
    let ready = v.eggs.get(&egg).unwrap().ready_at;
    let baby = hatch(&mut v, &me, egg, "spark", ready);

    let genes_of = |v: &Valley, id: u32| genes::Genes::unpack(&v.kins.get(&id).unwrap().genes);
    let (m, f, b) = (genes_of(&v, mother), genes_of(&v, father), genes_of(&v, baby));
    assert!(b.speed > m.speed.max(f.speed));
    assert!(b.stamina > m.stamina.max(f.stamina));
    assert_eq!(b.powers & (m.powers | f.powers), m.powers | f.powers, "every power comes down");
}

#[test]
fn earnings_climb_the_family_tree() {
    let mut v = valley();
    let me = farmer(&mut v, "Asha", 1_000);
    let grandma = give_grown_kin(&mut v, &me, "gran", NAMED_SPECIES[0].0, 1_000);
    let grandpa = give_grown_kin(&mut v, &me, "gramp", NAMED_SPECIES[2].0, 1_000);
    let mum = give_grown_kin(&mut v, &me, "mum", NAMED_SPECIES[0].0, 1_000);
    let dad = give_grown_kin(&mut v, &me, "dad", NAMED_SPECIES[2].0, 1_000);
    v.kins.get_mut(&mum).unwrap().mother = grandma;
    v.kins.get_mut(&mum).unwrap().father = grandpa;
    let child = give_grown_kin(&mut v, &me, "kid", NAMED_SPECIES[0].0, 1_000);
    v.kins.get_mut(&child).unwrap().mother = mum;
    v.kins.get_mut(&child).unwrap().father = dad;

    v.pay_kin(&oak(), child, 1_000);
    let purse = |v: &Valley, k: u32| v.balance(&v.kins.get(&k).unwrap().account, ACORN);
    assert_eq!(purse(&v, mum), 100);
    assert_eq!(purse(&v, dad), 100);
    assert_eq!(purse(&v, grandma), 30);
    assert_eq!(purse(&v, grandpa), 30);
    assert_eq!(purse(&v, child), 740);
    assert_eq!(all_acorns(&v), TOTAL_ACORNS as u64);

    at(me.as_str(), 1_100);
    assert_eq!(v.act(vec![[COLLECT, child, 0, 0]]), vec![1]);
    assert_eq!(purse(&v, child), 0);
}

#[test]
fn a_brand_new_species_belongs_to_its_finder() {
    let mut v = valley();
    let finder = farmer(&mut v, "Asha", 1_000);
    let other = farmer(&mut v, "Ben", 1_000);
    let unseen = genes::species_of(4, 2, 4, 3);
    assert!(v.species.get(&unseen).is_none());

    v.record_species_for_test(unseen, &finder);
    let species = v.species.get(&unseen).unwrap().clone();
    assert_eq!(species.finder, 1);
    assert!(!species.named);

    at(other.as_str(), 1_000);
    let before = v.balance(&finder, ACORN);
    v.record_species_for_test(unseen, &other);
    assert_eq!(v.balance(&finder, ACORN), before + SPECIES_ROYALTY, "the finder earns a royalty");
    assert_eq!(v.species.get(&unseen).unwrap().count, 2);

    at(finder.as_str(), 1_000);
    v.name_species(unseen, "Moonbelly".to_string());
    assert_eq!(v.species.get(&unseen).unwrap().name, "Moonbelly");
}

#[test]
#[should_panic(expected = "Only its finder can name it")]
fn only_the_finder_can_name_a_species() {
    let mut v = valley();
    let finder = farmer(&mut v, "Asha", 1_000);
    let other = farmer(&mut v, "Ben", 1_000);
    let unseen = genes::species_of(4, 2, 4, 3);
    v.record_species_for_test(unseen, &finder);
    at(other.as_str(), 1_000);
    v.name_species(unseen, "Stolen".to_string());
}

#[test]
fn buying_from_a_stall_delivers_an_egg_and_pays_the_seller_less_tax() {
    // Regression: the buyer's cached record must not overwrite the delivery.
    let mut v = valley();
    let seller = farmer(&mut v, "Asha", 1_000);
    let buyer = farmer(&mut v, "Ben", 1_000);
    v.pay(&oak(), &buyer, 1_000);
    let egg = first_egg(&v, &seller);

    at(seller.as_str(), 1_000);
    assert_eq!(v.act(vec![[LIST_EGG, egg, 300, 0]]), vec![1]);
    assert!(v.players.get(&seller).unwrap().eggs.is_empty());
    let listing = v.open_listings[0];

    // The buyer's own first egg fills their nest but a purchase may still land.
    at(buyer.as_str(), 1_000);
    let seller_had = v.balance(&seller, ACORN);
    assert_eq!(v.act(vec![[BUY_LISTING, listing, 1, 300]]), vec![1]);
    assert_eq!(v.eggs.get(&egg).unwrap().owner, buyer);
    assert!(v.players.get(&buyer).unwrap().eggs.contains(&egg));
    assert_eq!(v.balance(&seller, ACORN), seller_had + 300 - 300 * STALL_TAX_PCT / 100);
    assert!(v.open_listings.is_empty());
    assert_eq!(all_acorns(&v), TOTAL_ACORNS as u64);
}

#[test]
fn a_cancelled_stall_returns_the_goods() {
    let mut v = valley();
    let seller = farmer(&mut v, "Asha", 1_000);
    let egg = first_egg(&v, &seller);
    at(seller.as_str(), 1_000);
    v.act(vec![[LIST_EGG, egg, 300, 0], [LIST_ITEM, SUNWHEAT as u32, 3, 9]]);
    assert_eq!(v.balance(&seller, SUNWHEAT), 5);
    let (first, second) = (v.open_listings[0], v.open_listings[1]);
    assert_eq!(v.act(vec![[CANCEL_LISTING, first, 0, 0], [CANCEL_LISTING, second, 0, 0]]), vec![1, 1]);
    assert_eq!(v.balance(&seller, SUNWHEAT), 8);
    assert!(v.players.get(&seller).unwrap().eggs.contains(&egg));
}

#[test]
fn you_cannot_buy_your_own_listing() {
    let mut v = valley();
    let seller = farmer(&mut v, "Asha", 1_000);
    at(seller.as_str(), 1_000);
    v.act(vec![[LIST_ITEM, SUNWHEAT as u32, 3, 9]]);
    let listing = v.open_listings[0];
    assert_eq!(v.act(vec![[BUY_LISTING, listing, 1, 9]]), vec![0]);
}

fn elders(v: &mut Valley) {
    at(VALLEY, 1_000);
    for (index, (label, kin)) in [("oldtam", "bracken"), ("wren", "pearl"), ("granny", "sorrel"), ("hollis", "fern"), ("bea", "yarrow")]
        .iter()
        .enumerate()
    {
        v.add_elder(label.to_string(), label.to_string(), kin.to_string(), NAMED_SPECIES[index].0, 40, 10);
    }
}

/// Runs a race to the end through both contract calls, with a player who does nothing.
fn run_race(v: &mut Valley, me: &AccountId, kin: u32, now: u32) -> String {
    at(me.as_str(), now);
    v.race_start(kin, None);
    at(me.as_str(), now + 130);
    v.race_finish(vec![])
}

#[test]
fn a_race_is_there_whenever_you_want_one_and_keeps_every_acorn() {
    let mut v = valley();
    elders(&mut v);
    let me = farmer(&mut v, "Asha", 1_000);
    let kin = give_grown_kin(&mut v, &me, "ember", NAMED_SPECIES[0].0, 1_000);
    let before = v.balance(&me, ACORN);
    at(me.as_str(), 1_010);
    let answer = v.race_start(kin, None);
    assert!(answer.starts_with("[\""));
    assert_eq!(v.balance(&me, ACORN), before, "practice races are free");
    let index = v.players.get(&me).unwrap().index;
    let run = v.runs.get(&index).unwrap().clone();
    assert!(run.rested);
    assert!(run.rivals.iter().all(|r| *r != kin));
    assert_eq!(run.entrants.len(), dash::ENTRANTS_LEN);

    at(me.as_str(), 1_140);
    v.race_finish(vec![]);
    assert!(v.runs.get(&index).is_none());
    assert_eq!(all_acorns(&v), TOTAL_ACORNS as u64);
}

fn drive(run: &crate::state::Run, skill: u32, aggression: u32) -> (dash::Outcome, Vec<u16>) {
    let entrants = dash::unpack_entrants(&run.entrants);
    let mut race = dash::Dash::new(&run.seed, entrants, run.ease, false);
    let mut rng = Rng::from_seed(b"driver");
    let mut mind = dash::Mind::default();
    let mut log = Vec::new();
    let mut last = 0u32;
    while !race.over {
        let mut chosen = [0u8; 8];
        let count = race.decide(0, skill, aggression, &mut rng, &mut mind, &mut chosen);
        let tick = race.tick + 1;
        for &code in &chosen[..count] {
            log.push(dash::log_entry((tick - last) as u16, code));
            last = tick;
        }
        race.step(&chosen[..count]);
    }
    (race.outcome(), log)
}

#[test]
fn the_contract_plays_the_moves_itself() {
    let mut v = valley();
    elders(&mut v);
    let me = farmer(&mut v, "Asha", 1_000);
    let kin = give_grown_kin(&mut v, &me, "ember", NAMED_SPECIES[0].0, 1_000);
    at(me.as_str(), 1_010);
    v.race_start(kin, None);
    let index = v.players.get(&me).unwrap().index;
    let run = v.runs.get(&index).unwrap().clone();

    let (expected, log) = drive(&run, 95, 40);
    let seconds = expected.ticks / dash::TICKS_PER_SEC;
    at(me.as_str(), 1_010 + seconds);
    let answer = v.race_finish(log);
    let order = expected.order.map(|n| n.to_string()).join(",");
    assert!(answer.starts_with(&format!("[[{order}],")), "{answer}");
}

#[test]
#[should_panic(expected = "faster than it could have been run")]
fn you_cannot_hand_in_a_race_before_it_could_be_over() {
    let mut v = valley();
    elders(&mut v);
    let me = farmer(&mut v, "Asha", 1_000);
    let kin = give_grown_kin(&mut v, &me, "ember", NAMED_SPECIES[0].0, 1_000);
    at(me.as_str(), 1_010);
    v.race_start(kin, None);
    at(me.as_str(), 1_012);
    v.race_finish(vec![]);
}

#[test]
#[should_panic(expected = "No race to finish")]
fn a_race_can_only_be_handed_in_once() {
    let mut v = valley();
    elders(&mut v);
    let me = farmer(&mut v, "Asha", 1_000);
    let kin = give_grown_kin(&mut v, &me, "ember", NAMED_SPECIES[0].0, 1_000);
    run_race(&mut v, &me, kin, 1_010);
    at(me.as_str(), 1_400);
    v.race_finish(vec![]);
}

#[test]
fn only_a_rested_kinling_gets_the_oaks_boost() {
    let mut v = valley();
    elders(&mut v);
    let me = farmer(&mut v, "Asha", 1_000);
    let kin = give_grown_kin(&mut v, &me, "ember", NAMED_SPECIES[0].0, 1_000);
    let index = v.players.get(&me).unwrap().index;
    at(me.as_str(), 1_010);
    v.race_start(kin, None);
    assert!(v.runs.get(&index).unwrap().rested);
    at(me.as_str(), 1_020);
    v.race_start(kin, None);
    assert!(!v.runs.get(&index).unwrap().rested, "ran again straight away");
    at(me.as_str(), 1_010 + RACE_REST_SECS + 1);
    v.race_start(kin, None);
    assert!(v.runs.get(&index).unwrap().rested);
}

#[test]
fn a_race_can_be_run_as_soon_as_a_kinling_hatches() {
    let mut v = valley();
    elders(&mut v);
    let me = farmer(&mut v, "Asha", 1_000);
    let egg = first_egg(&v, &me);
    let kin = hatch(&mut v, &me, egg, "ember", 1_000);
    run_race(&mut v, &me, kin, 1_010);
}

#[test]
#[should_panic(expected = "isn't yours to race")]
fn you_cannot_race_someone_elses_kinling() {
    let mut v = valley();
    elders(&mut v);
    let me = farmer(&mut v, "Asha", 1_000);
    let them = farmer(&mut v, "Ben", 1_000);
    let kin = give_grown_kin(&mut v, &them, "pearl", NAMED_SPECIES[0].0, 1_000);
    at(me.as_str(), 1_010);
    v.race_start(kin, None);
}

// ----- Hiring for NEAR ----------------------------------------------------

const MILLI: u128 = crate::rentals::MILLI;

fn pay_rent(v: &mut Valley, payer: &str, kin: u32, farmer: Option<&AccountId>, milli: u128, now: u32) -> bool {
    let mut ctx = context(payer, now);
    ctx.attached_deposit(NearToken::from_yoctonear(milli * MILLI));
    testing_env!(ctx.build());
    v.rent_kin(kin, farmer.cloned())
}

#[test]
fn a_hire_pays_the_owner_and_hands_over_the_kinling_for_a_while() {
    let mut v = valley();
    elders(&mut v);
    let owner = farmer(&mut v, "Asha", 1_000);
    let hirer = farmer(&mut v, "Ben", 1_000);
    let kin = give_grown_kin(&mut v, &owner, "ember", NAMED_SPECIES[0].0, 1_000);
    at(owner.as_str(), 1_000);
    assert_eq!(v.act(vec![[HIRE_OUT, kin, 20, 0]]), vec![1]);
    assert!(v.rentals.contains(&kin));

    assert!(pay_rent(&mut v, "alice.testnet", kin, Some(&hirer), 20, 1_010));
    let record = v.kins.get(&kin).unwrap();
    assert_eq!(record.renter.as_ref(), Some(&hirer));
    assert_eq!(v.players.get(&owner).unwrap().near_earned, 17 * MILLI, "85% to the owner");
    assert_eq!(v.near_pot, 3 * MILLI, "what's left feeds the prize pot");

    // The hirer can race it.
    let index = v.players.get(&hirer).unwrap().index;
    at(hirer.as_str(), 1_020);
    v.race_start(kin, None);
    assert_eq!(v.runs.get(&index).unwrap().kin, kin);
}

#[test]
#[should_panic(expected = "isn't yours to race")]
fn the_owner_cannot_race_a_kinling_while_it_is_out_on_hire() {
    let mut v = valley();
    elders(&mut v);
    let owner = farmer(&mut v, "Asha", 1_000);
    let hirer = farmer(&mut v, "Ben", 1_000);
    let kin = give_grown_kin(&mut v, &owner, "ember", NAMED_SPECIES[0].0, 1_000);
    at(owner.as_str(), 1_000);
    v.act(vec![[HIRE_OUT, kin, 20, 0]]);
    assert!(pay_rent(&mut v, hirer.as_str(), kin, None, 20, 1_010));
    at(owner.as_str(), 1_020);
    v.race_start(kin, None);
}

#[test]
fn a_hire_ends_by_itself() {
    let mut v = valley();
    elders(&mut v);
    let owner = farmer(&mut v, "Asha", 1_000);
    let hirer = farmer(&mut v, "Ben", 1_000);
    let kin = give_grown_kin(&mut v, &owner, "ember", NAMED_SPECIES[0].0, 1_000);
    at(owner.as_str(), 1_000);
    v.act(vec![[HIRE_OUT, kin, 20, 0]]);
    assert!(pay_rent(&mut v, hirer.as_str(), kin, None, 20, 1_010));
    let after = 1_010 + crate::rentals::RENT_SECS + 1;
    assert!(v.kins.get(&kin).unwrap().controlled_by(&owner, after));
    assert!(!v.kins.get(&kin).unwrap().controlled_by(&hirer, after));
    assert!(pay_rent(&mut v, hirer.as_str(), kin, None, 20, after), "and it can be hired again");
}

#[test]
fn a_short_payment_or_a_kinling_already_out_is_refused() {
    let mut v = valley();
    elders(&mut v);
    let owner = farmer(&mut v, "Asha", 1_000);
    let hirer = farmer(&mut v, "Ben", 1_000);
    let other = farmer(&mut v, "Cal", 1_000);
    let kin = give_grown_kin(&mut v, &owner, "ember", NAMED_SPECIES[0].0, 1_000);
    at(owner.as_str(), 1_000);
    v.act(vec![[HIRE_OUT, kin, 20, 0]]);
    assert!(!pay_rent(&mut v, hirer.as_str(), kin, None, 19, 1_010), "too little");
    assert!(pay_rent(&mut v, hirer.as_str(), kin, None, 20, 1_010));
    assert!(!pay_rent(&mut v, other.as_str(), kin, None, 20, 1_020), "already out");
    assert_eq!(v.kins.get(&kin).unwrap().renter.as_ref(), Some(&hirer));
}

#[test]
fn earnings_go_to_the_owners_wallet_once_they_have_set_one() {
    let mut v = valley();
    elders(&mut v);
    let owner = farmer(&mut v, "Asha", 1_000);
    let hirer = farmer(&mut v, "Ben", 1_000);
    let kin = give_grown_kin(&mut v, &owner, "ember", NAMED_SPECIES[0].0, 1_000);
    at(owner.as_str(), 1_000);
    v.act(vec![[HIRE_OUT, kin, 20, 0]]);
    v.set_wallet(Some(id("asha.testnet")));
    assert_eq!(v.players.get(&owner).unwrap().wallet, Some(id("asha.testnet")));
    assert!(pay_rent(&mut v, hirer.as_str(), kin, None, 20, 1_010));
    assert_eq!(v.players.get(&owner).unwrap().near_earned, 17 * MILLI);
}

#[test]
fn an_elders_earnings_feed_the_prize_pot() {
    let mut v = valley();
    elders(&mut v);
    let hirer = farmer(&mut v, "Ben", 1_000);
    assert!(pay_rent(&mut v, hirer.as_str(), 1, None, 10, 1_010));
    assert_eq!(v.near_pot, 10 * MILLI);
}

#[test]
fn paying_from_a_farm_account_books_the_hire_when_the_money_arrives() {
    let mut v = valley();
    elders(&mut v);
    let hirer = farmer(&mut v, "Ben", 1_000);
    at(hirer.as_str(), 1_010);
    v.rent_with_purse(1);
    assert!(v.kins.get(&1).unwrap().renter.is_none(), "nothing happens until it is paid");
    at_with_results(VALLEY, 1_011, vec![PromiseResult::Successful(vec![])]);
    assert!(v.on_purse_paid(1, hirer.clone(), U128(10 * MILLI), Ok(())));
    assert_eq!(v.kins.get(&1).unwrap().renter.as_ref(), Some(&hirer));
    assert!(v.players.get(&hirer).unwrap().rented.contains(&1));
}

#[test]
fn a_farm_account_that_cannot_pay_gets_nothing() {
    let mut v = valley();
    elders(&mut v);
    let hirer = farmer(&mut v, "Ben", 1_000);
    at_with_results(VALLEY, 1_011, vec![PromiseResult::Failed]);
    assert!(!v.on_purse_paid(1, hirer, U128(10 * MILLI), Err(near_sdk::PromiseError::Failed)));
    assert!(v.kins.get(&1).unwrap().renter.is_none());
}

#[test]
fn a_hired_kinling_can_parent_a_baby_that_stays_with_the_hirer() {
    let mut v = valley();
    elders(&mut v);
    let owner = farmer(&mut v, "Asha", 1_000);
    let hirer = farmer(&mut v, "Ben", 1_000);
    let champion = give_grown_kin(&mut v, &owner, "ember", NAMED_SPECIES[0].0, 1_000);
    let mine = give_grown_kin(&mut v, &hirer, "pearl", NAMED_SPECIES[2].0, 1_000);
    v.pay(&oak(), &hirer, 1_000);
    at(owner.as_str(), 1_000);
    v.act(vec![[HIRE_OUT, champion, 20, 0]]);
    assert!(pay_rent(&mut v, hirer.as_str(), champion, None, 20, 1_010));
    at(hirer.as_str(), 1_020);
    assert_eq!(v.act(vec![[BREED, mine, champion, 0]]), vec![1]);
    let egg = *v.players.get(&hirer).unwrap().eggs.last().unwrap();
    assert_eq!(v.eggs.get(&egg).unwrap().owner, hirer);
}

#[test]
#[should_panic(expected = "out on hire")]
fn a_kinling_out_on_hire_cannot_be_given_away() {
    let mut v = valley();
    elders(&mut v);
    let owner = farmer(&mut v, "Asha", 1_000);
    let hirer = farmer(&mut v, "Ben", 1_000);
    let kin = give_grown_kin(&mut v, &owner, "ember", NAMED_SPECIES[0].0, 1_000);
    at(owner.as_str(), 1_000);
    v.act(vec![[HIRE_OUT, kin, 20, 0]]);
    assert!(pay_rent(&mut v, hirer.as_str(), kin, None, 20, 1_010));
    let mut ctx = context(owner.as_str(), 1_020);
    ctx.attached_deposit(NearToken::from_yoctonear(1));
    testing_env!(ctx.build());
    v.mt_transfer(id("someone.testnet"), format!("kin:{kin}"), U128(1), None, None);
}

/// Makes a Kinling far faster than anyone, so tests can count on a win.
fn make_champion(v: &mut Valley, kin: u32) {
    let record = v.kins.get_mut(&kin).unwrap();
    let mut genes = genes::Genes::unpack(&record.genes);
    genes.speed = 60_000;
    genes.stamina = 60_000;
    genes.luck = 60_000;
    record.genes = genes.pack();
}

#[test]
fn winning_a_rested_practice_race_pays_acorns_and_crops_but_never_near() {
    let mut v = valley();
    elders(&mut v);
    let me = farmer(&mut v, "Asha", 1_000);
    let kin = give_grown_kin(&mut v, &me, "ember", NAMED_SPECIES[0].0, 1_000);
    let mut ctx = context("kinlings-bank.testnet", 1_000);
    ctx.attached_deposit(NearToken::from_near(10));
    testing_env!(ctx.build());
    v.fund_pot();
    make_champion(&mut v, kin);
    let acorns = v.balance(&me, ACORN);
    let crops_before: u32 = CROPS.iter().map(|c| v.balance(&me, c.item)).sum();

    at(me.as_str(), 1_010);
    v.race_start(kin, None);
    let index = v.players.get(&me).unwrap().index;
    let run = v.runs.get(&index).unwrap().clone();
    let (outcome, log) = drive(&run, 100, 60);
    assert_eq!(outcome.order[0], 0, "this test needs a win");
    at(me.as_str(), 1_200);
    let answer = v.race_finish(log);
    assert_eq!(v.near_pot, 10_000 * MILLI, "practice never pays NEAR");
    assert_eq!(v.players.get(&me).unwrap().near_earned, 0);
    assert!(v.balance(&me, ACORN) > acorns, "the Oak's prize");
    let crops_after: u32 = CROPS.iter().map(|c| v.balance(&me, c.item)).sum();
    assert_eq!(crops_after, crops_before + RACE_CROP_PRIZES[0]);
    assert!(answer.ends_with(&format!(",{}]", RACE_CROP_PRIZES[0])), "{answer}");
    assert_eq!(v.kins.get(&kin).unwrap().wins, 1);
    assert_eq!(v.top_racers[0], (kin, 1));
    assert_eq!(all_acorns(&v), TOTAL_ACORNS as u64);
}

#[test]
fn racing_grows_a_kinling_only_up_to_a_point() {
    let mut v = valley();
    elders(&mut v);
    let me = farmer(&mut v, "Asha", 1_000);
    let kin = give_grown_kin(&mut v, &me, "ember", NAMED_SPECIES[0].0, 1_000);
    let ceiling = KIN_LEVELS[RACE_LEVEL_CAP as usize - 1];
    v.kins.get_mut(&kin).unwrap().xp = ceiling - 1;
    run_race(&mut v, &me, kin, 2_000);
    assert_eq!(v.kins.get(&kin).unwrap().xp, ceiling);
    run_race(&mut v, &me, kin, 3_000);
    assert_eq!(v.kins.get(&kin).unwrap().xp, ceiling);
    // Above it, racing never takes growth away.
    v.kins.get_mut(&kin).unwrap().xp = 5_000;
    run_race(&mut v, &me, kin, 4_000);
    assert_eq!(v.kins.get(&kin).unwrap().xp, 5_000);
}

#[test]
fn nep245_transfer_moves_a_kinling_and_keeps_lists_right() {
    let mut v = valley();
    let a = farmer(&mut v, "Asha", 1_000);
    let b = farmer(&mut v, "Ben", 1_000);
    let kin = give_grown_kin(&mut v, &a, "ember", NAMED_SPECIES[0].0, 1_000);
    let mut ctx = context(a.as_str(), 1_000);
    ctx.attached_deposit(NearToken::from_yoctonear(1));
    testing_env!(ctx.build());
    v.mt_transfer(b.clone(), format!("kin:{kin}"), U128(1), None, None);
    assert_eq!(v.kins.get(&kin).unwrap().owner, b);
    assert!(!v.players.get(&a).unwrap().kins.contains(&kin));
    assert!(v.players.get(&b).unwrap().kins.contains(&kin));
    assert_eq!(v.mt_balance_of(b, format!("kin:{kin}")), U128(1));
    assert_eq!(v.mt_balance_of(a, format!("kin:{kin}")), U128(0));
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn nep245_transfers_need_one_yocto() {
    let mut v = valley();
    let a = farmer(&mut v, "Asha", 1_000);
    at(a.as_str(), 1_000);
    v.mt_transfer(id("someone.testnet"), "sunwheat".to_string(), U128(1), None, None);
}

#[test]
fn crop_supply_tracks_every_mint_and_burn() {
    let mut v = valley();
    let me = farmer(&mut v, "Asha", 1_000);
    let token = || items::token_id(SUNWHEAT).to_string();
    let start = v.mt_supply(token()).unwrap().0;
    at(me.as_str(), 1_000);
    v.act(vec![[PLANT, 0, SUNWHEAT as u32, 0]]);
    assert_eq!(v.mt_supply(token()).unwrap().0, start - 1);
    at(me.as_str(), 1_100);
    v.act(vec![[HARVEST, 0, 0, 0]]);
    assert_eq!(v.mt_supply(token()).unwrap().0, start + 1);
}

#[test]
fn a_gifted_egg_needs_the_secret_from_the_link() {
    let mut v = valley();
    let giver = farmer(&mut v, "Asha", 1_000);
    let egg = first_egg(&v, &giver);
    at(giver.as_str(), 1_000);
    let key = "11".repeat(32);
    v.gift_egg(egg, key.clone());
    assert_eq!(v.eggs.get(&egg).unwrap().owner, oak());
    assert!(v.players.get(&giver).unwrap().eggs.is_empty());
    assert_eq!(v.gifts.get(&key), Some(&egg));
}

// ----- Foods, finds, NEAR stalls and NEAR Social ---------------------------

#[test]
fn each_food_raises_a_kinling_only_so_far_and_rarer_food_goes_further() {
    let mut v = valley();
    let me = farmer(&mut v, "Asha", 1_000);
    let egg = first_egg(&v, &me);
    let kin = hatch(&mut v, &me, egg, "ember", 1_000);
    let wheat = v.balance(&me, SUNWHEAT);
    at(me.as_str(), 1_010);
    let fed = v.act(vec![[FEED, kin, SUNWHEAT as u32, 0]; 8]);
    // Sunwheat brings it to level 3 and then stops helping, so it isn't eaten.
    assert_eq!(fed.iter().filter(|&&ok| ok == 1).count(), 5);
    assert_eq!(level_for(v.kins.get(&kin).unwrap().xp, &KIN_LEVELS), 3);
    assert_eq!(v.balance(&me, SUNWHEAT), wheat - 5);
    // A Glowcap takes it further.
    v.mint(&me, GLOWCAP, 1);
    assert_eq!(v.act(vec![[FEED, kin, GLOWCAP as u32, 0]]), vec![1]);
    assert_eq!(level_for(v.kins.get(&kin).unwrap().xp, &KIN_LEVELS), 5);
    assert_eq!(v.balance(&me, GLOWCAP), 0);
    // Things that aren't food can't be eaten.
    v.mint(&me, TONIC, 1);
    assert_eq!(v.act(vec![[FEED, kin, TONIC as u32, 0]]), vec![0]);
}

#[test]
fn starfig_harvests_sometimes_turn_up_rare_food() {
    let mut v = valley();
    let me = farmer(&mut v, "Asha", 1_000);
    v.players.get_mut(&me).unwrap().xp = FARMER_RANKS[9];
    v.mint(&me, STARFIG, 300);
    let mut now = 2_000;
    for _ in 0..300 {
        at(me.as_str(), now);
        assert_eq!(v.act(vec![[PLANT, 0, STARFIG as u32, 0]]), vec![1]);
        now += 600;
        at(me.as_str(), now);
        assert_eq!(v.act(vec![[HARVEST, 0, 0, 0]]), vec![1]);
        now += 1;
    }
    let (glow, fruit, honey) = (v.balance(&me, GLOWCAP), v.balance(&me, DRAGONFRUIT), v.balance(&me, HONEY));
    // About 6%, 5% and 1% of harvests.
    assert!((6..=36).contains(&glow), "{glow} glowcaps");
    assert!((4..=30).contains(&fruit), "{fruit} dragonfruit");
    assert!(honey <= 12, "{honey} honey");
    assert_eq!(v.supply[GLOWCAP as usize], glow as u64);
}

#[test]
fn rare_food_at_a_pairing_is_eaten_and_allowed() {
    let mut v = valley();
    let me = farmer(&mut v, "Asha", 1_000);
    let a = give_grown_kin(&mut v, &me, "ember", NAMED_SPECIES[0].0, 1_000);
    let b = give_grown_kin(&mut v, &me, "pearl", NAMED_SPECIES[2].0, 1_000);
    v.mint(&me, HONEY, 1);
    at(me.as_str(), 1_010);
    assert_eq!(v.act(vec![[BREED, a, b, HONEY as u32]]), vec![1]);
    assert_eq!(v.balance(&me, HONEY), 0);
    let egg = *v.players.get(&me).unwrap().eggs.last().unwrap();
    assert_eq!(v.eggs.get(&egg).unwrap().food, HONEY as u8);
}

fn buy_near(v: &mut Valley, payer: &str, listing: u32, quantity: u32, farmer: Option<&AccountId>, milli: u128, now: u32) -> bool {
    let mut ctx = context(payer, now);
    ctx.attached_deposit(NearToken::from_yoctonear(milli * MILLI));
    testing_env!(ctx.build());
    v.buy_listing_near(listing, quantity, farmer.cloned())
}

#[test]
fn a_stall_priced_in_near_pays_the_seller_in_near_and_hands_over_the_goods() {
    let mut v = valley();
    let seller = farmer(&mut v, "Asha", 1_000);
    let buyer = farmer(&mut v, "Ben", 1_000);
    v.mint(&seller, DRAGONFRUIT, 3);
    at(seller.as_str(), 1_010);
    assert_eq!(v.act(vec![[LIST_ITEM_NEAR, DRAGONFRUIT as u32, 3, 50]]), vec![1]);
    let listing = v.open_listings[0];
    assert!(v.listings.get(&listing).unwrap().in_near);

    // Acorns can't buy it.
    v.pay(&oak(), &buyer, 1_000);
    at(buyer.as_str(), 1_020);
    assert_eq!(v.act(vec![[BUY_LISTING, listing, 1, 1_000]]), vec![0]);

    // Any wallet can, for a farmer, and pays only what it costs.
    assert!(buy_near(&mut v, "alice.testnet", listing, 2, Some(&buyer), 130, 1_030));
    assert_eq!(v.balance(&buyer, DRAGONFRUIT), 2);
    assert_eq!(v.listings.get(&listing).unwrap().quantity, 1);
    assert_eq!(v.players.get(&seller).unwrap().near_earned, 98 * MILLI, "98% to the seller");
    assert_eq!(v.near_pot, 2 * MILLI);

    // Too little is refused, and nothing changes hands.
    assert!(!buy_near(&mut v, "alice.testnet", listing, 1, Some(&buyer), 40, 1_040));
    assert_eq!(v.balance(&buyer, DRAGONFRUIT), 2);
}

#[test]
fn a_kinling_can_be_sold_for_near_from_a_farm_account() {
    let mut v = valley();
    let seller = farmer(&mut v, "Asha", 1_000);
    let buyer = farmer(&mut v, "Ben", 1_000);
    let kin = give_grown_kin(&mut v, &seller, "ember", NAMED_SPECIES[0].0, 1_000);
    at(seller.as_str(), 1_010);
    assert_eq!(v.act(vec![[LIST_KIN_NEAR, kin, 200, 0]]), vec![1]);
    let listing = v.open_listings[0];

    at(buyer.as_str(), 1_020);
    v.buy_listing_with_purse(listing, 1);
    assert_eq!(v.kins.get(&kin).unwrap().owner, oak(), "nothing moves until the money arrives");
    at_with_results(VALLEY, 1_021, vec![PromiseResult::Successful(vec![])]);
    assert!(v.on_sale_paid(listing, 1, buyer.clone(), U128(200 * MILLI), Ok(())));
    assert_eq!(v.kins.get(&kin).unwrap().owner, buyer);
    assert!(v.players.get(&buyer).unwrap().kins.contains(&kin));
    assert!(!v.players.get(&seller).unwrap().kins.contains(&kin));
    assert!(v.open_listings.is_empty());
}

#[test]
fn a_sale_paid_for_after_the_stall_closed_is_refunded() {
    let mut v = valley();
    let seller = farmer(&mut v, "Asha", 1_000);
    let buyer = farmer(&mut v, "Ben", 1_000);
    v.mint(&seller, HONEY, 1);
    at(seller.as_str(), 1_010);
    v.act(vec![[LIST_ITEM_NEAR, HONEY as u32, 1, 300]]);
    let listing = v.open_listings[0];
    at(buyer.as_str(), 1_020);
    v.buy_listing_with_purse(listing, 1);
    at(seller.as_str(), 1_021);
    v.act(vec![[CANCEL_LISTING, listing, 0, 0]]);
    at_with_results(VALLEY, 1_022, vec![PromiseResult::Successful(vec![])]);
    assert!(!v.on_sale_paid(listing, 1, buyer.clone(), U128(300 * MILLI), Ok(())));
    assert_eq!(v.balance(&buyer, HONEY), 0);
    assert_eq!(v.balance(&seller, HONEY), 1);
}

#[test]
fn a_near_social_link_can_be_set_found_and_moved() {
    let mut v = valley();
    let asha = farmer(&mut v, "Asha", 1_000);
    let ben = farmer(&mut v, "Ben", 1_000);
    at(asha.as_str(), 1_010);
    v.set_social(Some("asha.near".to_string()));
    let asha_index = v.players.get(&asha).unwrap().index;
    let found = v.farms_of_socials_json(&["nobody.near".to_string(), "asha.near".to_string()]);
    assert_eq!(found, format!("[null,[{asha_index},\"{asha}\"]]"));
    // Moving the link frees the old name.
    v.set_social(Some("asha2.near".to_string()));
    assert_eq!(v.farms_of_socials_json(&["asha.near".to_string()]), "[null]");
    at(ben.as_str(), 1_020);
    v.set_social(None);
    assert!(v.players.get(&ben).unwrap().social.is_none());
}

#[test]
#[should_panic(expected = "isn't a NEAR account name")]
fn a_social_link_must_be_an_account_name() {
    let mut v = valley();
    let asha = farmer(&mut v, "Asha", 1_000);
    at(asha.as_str(), 1_010);
    v.set_social(Some("Not An Account!".to_string()));
}

// ----- Challenge races between real players, for NEAR ----------------------

use crate::challenges::{CHALLENGE_EASE, CHALLENGE_SECS, DID_NOT_FINISH};

fn open_with_wallet(v: &mut Valley, payer: &str, player: &AccountId, kin: u32, fee: u32, seats: u8, now: u32) -> Option<u32> {
    let mut ctx = context(payer, now);
    ctx.attached_deposit(NearToken::from_yoctonear(fee as u128 * MILLI));
    testing_env!(ctx.build());
    v.open_challenge(kin, fee, seats, Some(player.clone()))
}

fn join_with_wallet(v: &mut Valley, payer: &str, player: &AccountId, id: u32, kin: u32, fee: u32, now: u32) -> Option<u32> {
    let mut ctx = context(payer, now);
    ctx.attached_deposit(NearToken::from_yoctonear(fee as u128 * MILLI));
    testing_env!(ctx.build());
    v.join_challenge(id, kin, Some(player.clone()))
}

fn drive_raw(seed: &[u8], packed: &[u8], ease: u8, skill: u32) -> (dash::Outcome, Vec<u16>) {
    let mut race = dash::Dash::new(seed, dash::unpack_entrants(packed), ease, false);
    let mut rng = Rng::from_seed(b"driver");
    let mut mind = dash::Mind::default();
    let mut log = Vec::new();
    let mut last = 0u32;
    while !race.over {
        let mut chosen = [0u8; 8];
        let count = race.decide(0, skill, 50, &mut rng, &mut mind, &mut chosen);
        let tick = race.tick + 1;
        for &code in &chosen[..count] {
            log.push(dash::log_entry((tick - last) as u16, code));
            last = tick;
        }
        race.step(&chosen[..count]);
    }
    (race.outcome(), log)
}

/// Runs one player's go at a challenge and hands it in. Returns the answer.
fn run_challenge(v: &mut Valley, me: &AccountId, id: u32, skill: u32, now: u32) -> String {
    at(me.as_str(), now);
    let ticket = v.challenge_run(id);
    assert!(ticket.starts_with('['));
    let record = v.challenges.get(&id).unwrap().clone();
    let entry = record.entries.iter().find(|e| e.player == *me).unwrap();
    let mut packed = entry.entrant.clone();
    packed.extend_from_slice(&record.field_entrants);
    let (outcome, log) = drive_raw(&record.seed, &packed, CHALLENGE_EASE, skill);
    at(me.as_str(), now + outcome.ticks / dash::TICKS_PER_SEC + 1);
    v.challenge_finish(id, log)
}

fn three_racers(v: &mut Valley) -> [(AccountId, u32); 3] {
    elders(v);
    let asha = farmer(v, "Asha", 1_000);
    let ben = farmer(v, "Ben", 1_000);
    let cora = farmer(v, "Cora", 1_000);
    let a = give_grown_kin(v, &asha, "ember", NAMED_SPECIES[0].0, 1_000);
    let b = give_grown_kin(v, &ben, "pearl", NAMED_SPECIES[2].0, 1_000);
    let c = give_grown_kin(v, &cora, "sorrel", NAMED_SPECIES[4].0, 1_000);
    [(asha, a), (ben, b), (cora, c)]
}

#[test]
fn a_challenge_pays_every_entry_fee_to_the_fastest() {
    let mut v = valley();
    let [(asha, a), (ben, b), (cora, c)] = three_racers(&mut v);
    make_champion(&mut v, a);
    let id = open_with_wallet(&mut v, "asha-wallet.testnet", &asha, a, 50, 3, 1_010).expect("opened");
    assert_eq!(join_with_wallet(&mut v, "ben-wallet.testnet", &ben, id, b, 50, 1_020), Some(id));

    // Runners go whenever they like; nothing pays out while a seat is free.
    run_challenge(&mut v, &asha, id, 100, 1_030);
    run_challenge(&mut v, &ben, id, 85, 1_300);
    assert!(!v.challenges.get(&id).unwrap().settled);
    assert_eq!(join_with_wallet(&mut v, "cora-wallet.testnet", &cora, id, c, 50, 1_500), Some(id));
    let answer = run_challenge(&mut v, &cora, id, 85, 1_510);
    assert!(answer.contains(",3,3,"), "{answer}");

    let record = v.challenges.get(&id).unwrap().clone();
    assert!(record.settled, "the last seat's run pays out");
    let order = record.standings();
    assert_eq!(record.entries[order[0]].player, asha);
    let finished = record.entries.iter().filter(|e| e.ticks != DID_NOT_FINISH).count();
    let total: u128 = record.entries.iter().map(|e| e.prize).sum();
    assert_eq!(total, 150 * MILLI, "every fee goes to the runners and the valley keeps nothing");
    if finished == 3 {
        assert_eq!(record.entries[order[0]].prize, 105 * MILLI, "70% of three fees");
        assert_eq!(record.entries[order[1]].prize, 45 * MILLI);
        assert_eq!(record.entries[order[2]].prize, 0);
    }
    assert_eq!(v.players.get(&asha).unwrap().near_earned, record.entries[order[0]].prize);
    assert!(v.open_challenges.is_empty() && v.done_challenges == vec![id]);
    assert!(record.entries.iter().all(|e| e.moves.is_empty()), "ghosts are let go once it pays out");
}

#[test]
fn a_challenge_can_be_paid_from_a_farm_account_and_called_off_while_alone() {
    let mut v = valley();
    let [(asha, a), _, _] = three_racers(&mut v);
    at(asha.as_str(), 1_010);
    v.open_challenge_with_purse(a, 20, 2);
    assert!(v.open_challenges.is_empty(), "nothing happens until it is paid");
    at_with_results(VALLEY, 1_011, vec![PromiseResult::Successful(vec![])]);
    let id = v.on_entry_paid(None, a, 20, 2, asha.clone(), U128(20 * MILLI), Ok(())).expect("opened");
    assert_eq!(v.challenges.get(&id).unwrap().fee_milli, 20);
    assert_eq!(v.challenges.get(&id).unwrap().field.len(), 5);
    at(asha.as_str(), 1_020);
    v.cancel_challenge(id);
    assert!(v.challenges.get(&id).is_none() && v.open_challenges.is_empty());
}

#[test]
fn a_challenge_turns_away_a_full_house_a_second_seat_and_a_short_fee() {
    let mut v = valley();
    let [(asha, a), (ben, b), (cora, c)] = three_racers(&mut v);
    let id = open_with_wallet(&mut v, "asha-wallet.testnet", &asha, a, 50, 2, 1_010).unwrap();
    assert_eq!(join_with_wallet(&mut v, "asha-wallet.testnet", &asha, id, a, 50, 1_011), None, "already in it");
    assert_eq!(join_with_wallet(&mut v, "ben-wallet.testnet", &ben, id, b, 40, 1_012), None, "too little");
    assert_eq!(join_with_wallet(&mut v, "ben-wallet.testnet", &ben, id, b, 50, 1_013), Some(id));
    assert_eq!(join_with_wallet(&mut v, "cora-wallet.testnet", &cora, id, c, 50, 1_014), None, "full");
    assert_eq!(open_with_wallet(&mut v, "cora-wallet.testnet", &cora, c, 5, 2, 1_015), None, "fee too small");
    assert_eq!(open_with_wallet(&mut v, "cora-wallet.testnet", &cora, a, 50, 2, 1_016), None, "not her Kinling");
    assert_eq!(join_with_wallet(&mut v, "cora-wallet.testnet", &cora, 99, c, 50, 1_017), None, "no such challenge");
}

#[test]
#[should_panic(expected = "already run it")]
fn a_challenge_can_be_run_only_once() {
    let mut v = valley();
    let [(asha, a), _, _] = three_racers(&mut v);
    let id = open_with_wallet(&mut v, "asha-wallet.testnet", &asha, a, 50, 2, 1_010).unwrap();
    run_challenge(&mut v, &asha, id, 80, 1_020);
    at(asha.as_str(), 1_300);
    v.challenge_run(id);
}

#[test]
#[should_panic(expected = "faster than it could have been run")]
fn a_challenge_run_cannot_be_handed_in_too_soon() {
    let mut v = valley();
    let [(asha, a), _, _] = three_racers(&mut v);
    let id = open_with_wallet(&mut v, "asha-wallet.testnet", &asha, a, 50, 2, 1_010).unwrap();
    at(asha.as_str(), 1_020);
    v.challenge_run(id);
    let record = v.challenges.get(&id).unwrap().clone();
    let mut packed = record.entries[0].entrant.clone();
    packed.extend_from_slice(&record.field_entrants);
    let (_, log) = drive_raw(&record.seed, &packed, CHALLENGE_EASE, 90);
    at(asha.as_str(), 1_025);
    v.challenge_finish(id, log);
}

#[test]
#[should_panic(expected = "still open")]
fn a_challenge_cannot_be_paid_out_while_others_may_still_run() {
    let mut v = valley();
    let [(asha, a), (ben, b), _] = three_racers(&mut v);
    let id = open_with_wallet(&mut v, "asha-wallet.testnet", &asha, a, 100, 4, 1_010).unwrap();
    join_with_wallet(&mut v, "ben-wallet.testnet", &ben, id, b, 100, 1_011).unwrap();
    run_challenge(&mut v, &asha, id, 90, 1_020);
    at(asha.as_str(), 1_400);
    v.settle_challenge(id);
}

#[test]
fn when_some_never_run_their_shares_go_up_the_table() {
    let mut v = valley();
    let [(asha, a), (ben, b), (cora, c)] = three_racers(&mut v);
    let id = open_with_wallet(&mut v, "asha-wallet.testnet", &asha, a, 100, 4, 1_010).unwrap();
    join_with_wallet(&mut v, "ben-wallet.testnet", &ben, id, b, 100, 1_011).unwrap();
    join_with_wallet(&mut v, "cora-wallet.testnet", &cora, id, c, 100, 1_012).unwrap();
    make_champion(&mut v, a);
    run_challenge(&mut v, &asha, id, 100, 1_020);
    let ghosts = v.challenge_ghosts_json(id);
    assert!(ghosts.contains("\"Asha\""), "later runners can race Asha's ghost: {ghosts}");
    at("anyone.testnet", 1_010 + CHALLENGE_SECS + 1);
    v.settle_challenge(id);
    let record = v.challenges.get(&id).unwrap();
    assert!(record.settled);
    assert_eq!(record.entries[0].prize, 300 * MILLI, "the only finisher takes every fee");
    assert!(v.challenge_ghosts_json(id).ends_with(",[]]"));
    assert!(v.challenges_json().contains(&format!("[{id},")));
}
