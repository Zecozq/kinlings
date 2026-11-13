//! A single plot of soil.

use crate::items::{self, WATER_PCT};

/// How many times one growing crop can be watered.
pub const MAX_WATERINGS: u8 = 3;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Plot {
    /// The item id of what is growing, or 0 for empty soil.
    pub crop: u16,
    pub ready_at: u32,
    pub waterings: u8,
}

impl Plot {
    pub fn is_empty(&self) -> bool {
        self.crop == 0
    }

    pub fn is_ripe(&self, now: u32) -> bool {
        !self.is_empty() && now >= self.ready_at
    }

    /// Returns false if the plot is taken or the crop does not exist.
    pub fn plant(&mut self, crop: u16, now: u32) -> bool {
        match items::crop(crop) {
            Some(info) if self.is_empty() => {
                self.crop = crop;
                self.ready_at = now + info.grow_secs;
                self.waterings = 0;
                true
            }
            _ => false,
        }
    }

    /// Takes a quarter off the remaining time. Returns false if it can't be watered.
    pub fn water(&mut self, now: u32) -> bool {
        if self.is_empty() || self.is_ripe(now) || self.waterings >= MAX_WATERINGS {
            return false;
        }
        let remaining = self.ready_at - now;
        self.ready_at -= remaining * WATER_PCT / 100;
        self.waterings += 1;
        true
    }

    /// Empties a ripe plot and says what came out of it.
    pub fn harvest(&mut self, now: u32) -> Option<u16> {
        if !self.is_ripe(now) {
            return None;
        }
        let crop = self.crop;
        *self = Plot::default();
        Some(crop)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::items::SUNWHEAT;

    #[test]
    fn a_crop_grows_and_can_be_picked_once() {
        let mut plot = Plot::default();
        assert!(plot.plant(SUNWHEAT, 100));
        assert_eq!(plot.harvest(139), None);
        assert_eq!(plot.harvest(140), Some(SUNWHEAT));
        assert_eq!(plot.harvest(141), None);
        assert!(plot.is_empty());
    }

    #[test]
    fn you_cannot_plant_on_top_of_a_crop_or_plant_nonsense() {
        let mut plot = Plot::default();
        assert!(!plot.plant(items::TONIC, 0));
        assert!(plot.plant(SUNWHEAT, 0));
        assert!(!plot.plant(SUNWHEAT, 0));
    }

    #[test]
    fn watering_cuts_a_quarter_of_the_remaining_time_up_to_three_times() {
        let mut plot = Plot::default();
        plot.plant(SUNWHEAT, 0);
        assert!(plot.water(0));
        assert_eq!(plot.ready_at, 30);
        assert!(plot.water(0));
        assert!(plot.water(0));
        assert!(!plot.water(0));
    }

    #[test]
    fn a_ripe_or_empty_plot_cannot_be_watered() {
        let mut plot = Plot::default();
        assert!(!plot.water(0));
        plot.plant(SUNWHEAT, 0);
        assert!(!plot.water(40));
    }
}
