//! The rules of Kinlings, with no blockchain code in them. The contract and the
//! browser both compile this crate, so they cannot disagree about the rules.

pub mod dash;
pub mod farm;
pub mod genes;
pub mod items;
pub mod pricing;
pub mod rng;
pub mod shop;

#[cfg(feature = "sim")]
pub mod sim;
