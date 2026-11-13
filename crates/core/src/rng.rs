//! A small random number generator. On chain it is seeded from a block that
//! did not exist when the player acted, so nobody can predict or replay a roll.

#[derive(Clone, Debug)]
pub struct Rng(u64);

impl Rng {
    pub fn from_seed(seed: &[u8]) -> Self {
        // FNV-1a folds any seed into 64 bits.
        let mut hash = 0xcbf2_9ce4_8422_2325u64;
        for byte in seed {
            hash ^= *byte as u64;
            hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
        let mut rng = Rng(hash);
        rng.next_u32();
        rng
    }

    /// wyrand: fast, small and well distributed.
    pub fn next_u32(&mut self) -> u32 {
        self.0 = self.0.wrapping_add(0xa076_1d64_78bd_642f);
        let t = (self.0 as u128).wrapping_mul((self.0 ^ 0xe703_7ed1_a0b4_28db) as u128);
        ((t >> 64) as u64 ^ t as u64) as u32
    }

    /// A number from 0 up to, but not including, `n`.
    pub fn below(&mut self, n: u32) -> u32 {
        ((self.next_u32() as u64 * n.max(1) as u64) >> 32) as u32
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_seed_same_numbers() {
        let mut a = Rng::from_seed(b"seed");
        let mut b = Rng::from_seed(b"seed");
        for _ in 0..100 {
            assert_eq!(a.next_u32(), b.next_u32());
        }
    }

    #[test]
    fn below_is_in_range_and_roughly_even() {
        let mut rng = Rng::from_seed(b"even");
        let mut counts = [0u32; 6];
        for _ in 0..60_000 {
            counts[rng.below(6) as usize] += 1;
        }
        for count in counts {
            assert!((9_000..11_000).contains(&count), "{counts:?}");
        }
    }
}
