//! The Valley Dash, a race you drive yourself.
//!
//! You run, sprint, jump and spit fire in the browser, thirty ticks a second.
//! Afterwards the contract plays your exact moves through this same file and
//! pays only what it saw happen. Everything is whole-number arithmetic, so the
//! two can never disagree, and there is no server to trust.
//!
//! Distances are millimetres and speeds are millimetres per tick.

use crate::genes::{Genes, BLINK, BOLT, DASH, FIRE, FROST, HORN, MEND, POWER_COUNT, SHIELD, VINE, WING};
use crate::rng::Rng;

pub const TICKS_PER_SEC: u32 = 30;
pub const RACERS: usize = 6;
pub const LANES: i32 = 3;
pub const LANE_WIDTH: i32 = 3_500;
pub const TRACK_LEN: i32 = 800_000;
/// A race that goes on this long is over, wherever anyone has got to.
pub const MAX_TICKS: u32 = 90 * TICKS_PER_SEC;
/// The most moves one race can record.
pub const MAX_MOVES: usize = 2_000;
/// Nobody can use a power this soon after the start.
const START_COOLDOWN: u16 = 60;

// ----- What can be on the track ------------------------------------------

pub const LOG: u8 = 0;
pub const ROCK: u8 = 1;
pub const HEDGE: u8 = 2;
pub const MUD: u8 = 3;
pub const RAMP: u8 = 4;
pub const BERRY: u8 = 5;
pub const ORB: u8 = 6;

/// How long a hazard is, along the track.
pub const fn depth(kind: u8) -> i32 {
    match kind {
        LOG => 1_200,
        ROCK => 2_000,
        HEDGE => 2_400,
        MUD => 14_000,
        RAMP => 3_000,
        _ => 1_600,
    }
}

/// How high you must be to clear it. A rock is too tall to jump.
pub const fn height(kind: u8) -> i32 {
    match kind {
        LOG => 900,
        HEDGE => 1_500,
        ROCK => 4_200,
        _ => 0,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Hazard {
    pub pos: i32,
    pub kind: u8,
    /// One bit per lane.
    pub lanes: u8,
    /// Fire has destroyed it, for everyone.
    pub burnt: bool,
    /// One bit per racer that has already dealt with it.
    pub met: u8,
}

/// Lays out a course. There is always a way through every row.
pub fn build_course(seed: &[u8]) -> Vec<Hazard> {
    let mut rng = Rng::from_seed(seed);
    let mut rows = Vec::with_capacity(48);
    let mut at = 70_000;
    let end = TRACK_LEN - 40_000;
    let mut add = |pos: i32, kind: u8, lanes: u8| rows.push(Hazard { pos, kind, lanes, burnt: false, met: 0 });

    while at < end {
        let progress = at * 100 / end;
        let lane = rng.below(3) as u8;
        let open = 1u8 << lane;
        let blocked = 0b111 & !open;
        // Early rows are simple. The harder patterns arrive as the race goes on.
        let roll = rng.below(if progress < 25 { 54 } else { 100 });
        match roll {
            0..=17 => add(at, ROCK, open),
            18..=33 => add(at, ROCK, blocked),
            34..=53 => add(at, LOG, 0b111),
            54..=69 => add(at, HEDGE, blocked),
            70..=81 => add(at, MUD, if rng.below(3) == 0 { 0b111 } else { blocked }),
            82..=91 => {
                add(at, RAMP, open);
                add(at + 24_000, ORB, open);
            }
            _ => {
                add(at, LOG, 0b111);
                add(at + 22_000, ROCK, open);
            }
        }
        if rng.below(100) < 55 {
            let treat = if rng.below(100) < 30 { ORB } else { BERRY };
            add(at + 16_000 + rng.below(5_000) as i32, treat, 1 << rng.below(3));
        }
        at += 44_000 - (progress * 90) + rng.below(6_000) as i32;
    }
    rows.sort_by_key(|h| h.pos);
    rows
}

// ----- Who is racing ------------------------------------------------------

pub const ENTRANT_LEN: usize = 15;
pub const ENTRANTS_LEN: usize = ENTRANT_LEN * RACERS;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Entrant {
    pub speed: u16,
    pub stamina: u16,
    pub luck: u16,
    pub level: u8,
    pub generation: u32,
    pub powers: u16,
    pub wings: bool,
    pub horn: bool,
}

impl Entrant {
    pub fn new(genes: &Genes, level: u8, generation: u32) -> Self {
        Entrant {
            speed: genes.speed,
            stamina: genes.stamina,
            luck: genes.luck,
            level,
            generation,
            powers: genes.powers,
            wings: genes.shows(WING) != 0,
            horn: genes.shows(HORN) != 0,
        }
    }

    pub fn has(&self, power: usize) -> bool {
        self.powers >> power & 1 == 1
    }

    pub fn pack(&self, out: &mut [u8]) {
        out[0..2].copy_from_slice(&self.speed.to_le_bytes());
        out[2..4].copy_from_slice(&self.stamina.to_le_bytes());
        out[4..6].copy_from_slice(&self.luck.to_le_bytes());
        out[6] = self.level;
        out[7..11].copy_from_slice(&self.generation.to_le_bytes());
        out[11..13].copy_from_slice(&self.powers.to_le_bytes());
        out[13] = self.wings as u8;
        out[14] = self.horn as u8;
    }

    pub fn unpack(bytes: &[u8]) -> Self {
        Entrant {
            speed: u16::from_le_bytes([bytes[0], bytes[1]]),
            stamina: u16::from_le_bytes([bytes[2], bytes[3]]),
            luck: u16::from_le_bytes([bytes[4], bytes[5]]),
            level: bytes[6],
            generation: u32::from_le_bytes([bytes[7], bytes[8], bytes[9], bytes[10]]),
            powers: u16::from_le_bytes([bytes[11], bytes[12]]),
            wings: bytes[13] != 0,
            horn: bytes[14] != 0,
        }
    }
}

pub fn pack_entrants(entrants: &[Entrant; RACERS]) -> [u8; ENTRANTS_LEN] {
    let mut out = [0u8; ENTRANTS_LEN];
    for (index, entrant) in entrants.iter().enumerate() {
        entrant.pack(&mut out[index * ENTRANT_LEN..(index + 1) * ENTRANT_LEN]);
    }
    out
}

pub fn unpack_entrants(bytes: &[u8]) -> [Entrant; RACERS] {
    let mut out = [Entrant::default(); RACERS];
    for (index, entrant) in out.iter_mut().enumerate() {
        *entrant = Entrant::unpack(&bytes[index * ENTRANT_LEN..(index + 1) * ENTRANT_LEN]);
    }
    out
}

// ----- How stats and generations turn into a race --------------------------

/// Climbs towards `max` and flattens out, so nothing ever runs away with a race.
const fn curve(value: i32, max: i32, half: i32) -> i32 {
    max * value / (value + half)
}

/// How hard a Kinling's powers hit, in percent. A founder is 100, and every
/// generation is higher than the last.
pub fn might(generation: u32) -> i32 {
    100 + curve(generation.min(1_000_000) as i32, 300, 10)
}

/// Later generations recharge their powers sooner.
fn recharge(base: u16, generation: u32) -> u16 {
    (base as i32 * 100 / (100 + curve(generation.min(1_000_000) as i32, 70, 10))) as u16
}

/// What a Kinling's level adds to its cruising speed. Every level helps, the
/// first few the most, so a well-fed Kinling is faster but never untouchable.
pub fn level_speed(level: u8) -> i32 {
    curve(level.saturating_sub(1) as i32, 96, 14)
}

/// What a Kinling's level adds to its racing sense when it runs on instinct.
fn level_sense(level: u8) -> i32 {
    curve(level.saturating_sub(1) as i32, 18, 8)
}

pub fn cruise_speed(e: &Entrant) -> i32 {
    540 + curve(e.speed as i32, 180, 120) + level_speed(e.level)
}

const FULL_BREATH: i32 = 10_000;
const CATCH_BREATH: i32 = 3_000;

fn drain(e: &Entrant) -> i32 {
    72 - curve(e.stamina as i32, 34, 100)
}

fn regen(e: &Entrant) -> i32 {
    26 + curve(e.stamina as i32, 24, 100)
}

/// Chance in 100 of shrugging off an attack.
fn dodge_chance(e: &Entrant) -> u32 {
    curve(e.luck as i32, 30, 120) as u32
}

const ACCEL: i32 = 14;
const BRAKE_FORCE: i32 = 30;
const LANE_SPEED: i32 = 450;
const JUMP_V: i32 = 440;
const RAMP_V: i32 = 640;
const GRAVITY: i32 = 44;
const WING_GRAVITY: i32 = 38;
/// A jump pressed just before landing still counts.
const JUMP_BUFFER: u8 = 4;

const SHOT_SPEED: i32 = 2_200;
const SHOT_STEER: i32 = 220;
const SHOT_LIFE: u16 = 60;
const SHOT_RANGE: i32 = 60_000;
const FROST_RANGE: i32 = 40_000;
const BOLT_RANGE: i32 = 120_000;
const SLIPSTREAM: i32 = 9_000;
const MAX_SHOTS: usize = 12;
const MAX_TRAPS: usize = 10;

/// Base recharge in ticks, per power.
const COOLDOWNS: [u16; POWER_COUNT] = [150, 210, 300, 210, 270, 150, 240, 360];

// ----- Moves ---------------------------------------------------------------

pub const SPRINT_ON: u8 = 0;
pub const SPRINT_OFF: u8 = 1;
pub const BRAKE_ON: u8 = 2;
pub const BRAKE_OFF: u8 = 3;
pub const LEFT: u8 = 4;
pub const RIGHT: u8 = 5;
pub const JUMP: u8 = 6;
/// `POWER + n` uses power `n`.
pub const POWER: u8 = 7;
const LAST_MOVE: u8 = POWER + POWER_COUNT as u8 - 1;

// ----- What happens, for the screen to draw --------------------------------

pub const E_JUMP: u8 = 1;
pub const E_LAND: u8 = 2;
pub const E_TRIP: u8 = 3;
pub const E_CAST: u8 = 4;
pub const E_BURNED: u8 = 5;
pub const E_CHILLED: u8 = 6;
pub const E_ZAPPED: u8 = 7;
pub const E_SNARED: u8 = 8;
pub const E_BLOCKED: u8 = 9;
pub const E_DODGED: u8 = 10;
pub const E_BERRY: u8 = 11;
pub const E_ORB: u8 = 12;
pub const E_RAMP: u8 = 13;
pub const E_HAZARD_BURNT: u8 = 14;
pub const E_FINISH: u8 = 15;
pub const E_CLEARED: u8 = 16;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Event {
    pub kind: u8,
    pub a: u8,
    pub b: u8,
    pub value: i32,
}

// ----- The race ------------------------------------------------------------

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Runner {
    pub pos: i32,
    pub x: i32,
    pub lane: i32,
    pub y: i32,
    pub vy: i32,
    pub v: i32,
    pub stamina: i32,
    pub winded: bool,
    pub sprint: bool,
    pub brake: bool,
    pub mud: bool,
    pub jump_buffer: u8,
    pub stumble: u16,
    pub burn: u16,
    pub chill: u16,
    pub stun: u16,
    pub snare: u16,
    pub dash: u16,
    pub shield: u16,
    pub cooldown: [u16; POWER_COUNT],
    /// The tick it crossed the line. Zero until then.
    pub finished: u32,
    /// The first hazard it hasn't got past yet.
    pub next: u16,
    pub trips: u16,
    pub cleared: u16,
    pub hits_landed: u16,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Shot {
    pub owner: u8,
    /// Which racer it is chasing, or `NO_TARGET`.
    pub target: u8,
    pub pos: i32,
    pub x: i32,
    pub life: u16,
}

pub const NO_TARGET: u8 = 255;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Trap {
    pub owner: u8,
    pub pos: i32,
    pub lane: u8,
}

/// What a computer-run racer remembers between ticks.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Mind {
    /// The last row it made up its mind about.
    pub seen: u16,
    /// It didn't notice that row, and will run straight in.
    pub blind: bool,
    /// Whether it means to hop or go around that row.
    pub hop: bool,
}

impl Default for Mind {
    fn default() -> Self {
        Mind { seen: u16::MAX, blind: false, hop: false }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Outcome {
    /// Racer indexes, winner first.
    pub order: [u8; RACERS],
    pub ticks: u32,
    pub player_finished: bool,
    pub trips: u16,
    pub cleared: u16,
    pub hits_landed: u16,
}

#[derive(Clone, Debug)]
pub struct Dash {
    pub tick: u32,
    pub entrants: [Entrant; RACERS],
    pub runners: [Runner; RACERS],
    pub hazards: Vec<Hazard>,
    pub shots: Vec<Shot>,
    pub traps: Vec<Trap>,
    pub events: Vec<Event>,
    pub over: bool,
    finish_order: Vec<u8>,
    skill: [u8; RACERS],
    aggression: [u8; RACERS],
    minds: [Mind; RACERS],
    rng: Rng,
    record: bool,
}

const NO_POWER: usize = POWER_COUNT;

fn lane_of(x: i32) -> i32 {
    ((x + LANE_WIDTH * 3 / 2) / LANE_WIDTH).clamp(0, LANES - 1)
}

fn lane_centre(lane: i32) -> i32 {
    (lane - 1) * LANE_WIDTH
}

impl Dash {
    /// `ease` makes the computer-run racers worse. New players get some.
    pub fn new(seed: &[u8], entrants: [Entrant; RACERS], ease: u8, record: bool) -> Self {
        // The racers' own dice, kept apart from the ones that laid the course.
        let mut salted = seed.to_vec();
        salted.push(b'r');
        let mut rng = Rng::from_seed(&salted);
        let mut skill = [0u8; RACERS];
        let mut aggression = [0u8; RACERS];
        let mut runners = [Runner::default(); RACERS];
        for index in 0..RACERS {
            let e = &entrants[index];
            let natural = 46 + curve(e.luck as i32, 22, 60) + level_sense(e.level) + rng.below(14) as i32;
            skill[index] = (natural - ease as i32).clamp(20, 92) as u8;
            aggression[index] = 16 + rng.below(16) as u8;
            let start_lane = (index % 3) as i32;
            runners[index] = Runner {
                x: lane_centre(start_lane),
                lane: start_lane,
                stamina: FULL_BREATH,
                cooldown: [START_COOLDOWN; POWER_COUNT],
                pos: -(((index / 3) as i32) * 4_000),
                ..Runner::default()
            };
        }
        Dash {
            tick: 0,
            entrants,
            runners,
            hazards: build_course(seed),
            shots: Vec::with_capacity(MAX_SHOTS),
            traps: Vec::with_capacity(MAX_TRAPS),
            events: Vec::new(),
            over: false,
            finish_order: Vec::with_capacity(RACERS),
            skill,
            aggression,
            minds: [Mind::default(); RACERS],
            rng,
            record,
        }
    }

    fn emit(&mut self, kind: u8, a: usize, b: usize, value: i32) {
        if self.record {
            self.events.push(Event { kind, a: a as u8, b: b as u8, value });
        }
    }

    /// Plays one tick. `moves` are the player's, for racer 0.
    pub fn step(&mut self, moves: &[u8]) {
        if self.over {
            return;
        }
        self.events.clear();
        self.tick += 1;
        for &code in moves {
            self.apply(0, code);
        }
        for index in 1..RACERS {
            let (skill, aggression) = (self.skill[index] as u32, self.aggression[index] as u32);
            let mut mind = self.minds[index];
            let mut rng = self.rng.clone();
            let mut chosen = [0u8; 8];
            let count = self.decide(index, skill, aggression, &mut rng, &mut mind, &mut chosen);
            self.rng = rng;
            self.minds[index] = mind;
            for &code in &chosen[..count] {
                self.apply(index, code);
            }
        }
        for index in 0..RACERS {
            self.advance(index);
        }
        self.fly_shots();
        if self.runners[0].finished != 0 || self.tick >= MAX_TICKS {
            self.over = true;
        }
    }

    pub fn apply(&mut self, index: usize, code: u8) {
        if code > LAST_MOVE || self.runners[index].finished != 0 {
            return;
        }
        let runner = &mut self.runners[index];
        match code {
            SPRINT_ON => runner.sprint = true,
            SPRINT_OFF => runner.sprint = false,
            BRAKE_ON => runner.brake = true,
            BRAKE_OFF => runner.brake = false,
            LEFT => runner.lane = (runner.lane - 1).max(0),
            RIGHT => runner.lane = (runner.lane + 1).min(LANES - 1),
            JUMP => runner.jump_buffer = JUMP_BUFFER,
            _ => self.cast(index, (code - POWER) as usize),
        }
    }

    // ----- Powers --------------------------------------------------------

    /// The nearest racer ahead of this one, within `range`, and within one
    /// lane if `near_lane` is set.
    fn nearest_ahead(&self, index: usize, range: i32, near_lane: bool) -> usize {
        let me = &self.runners[index];
        let mut best = NO_POWER;
        let mut best_gap = i32::MAX;
        for (other, them) in self.runners.iter().enumerate() {
            if other == index || them.finished != 0 {
                continue;
            }
            let gap = them.pos - me.pos;
            if gap <= 0 || gap > range || gap >= best_gap {
                continue;
            }
            if near_lane && (them.x - me.x).abs() > LANE_WIDTH + LANE_WIDTH / 2 {
                continue;
            }
            best = other;
            best_gap = gap;
        }
        best
    }

    fn nearest_behind(&self, index: usize, range: i32) -> bool {
        let me = &self.runners[index];
        self.runners.iter().enumerate().any(|(other, them)| {
            other != index && them.finished == 0 && me.pos > them.pos && me.pos - them.pos <= range
        })
    }

    fn cast(&mut self, index: usize, power: usize) {
        let entrant = self.entrants[index];
        let runner = self.runners[index];
        if power >= POWER_COUNT || !entrant.has(power) || runner.cooldown[power] > 0 || runner.stun > 0 {
            return;
        }
        let strength = might(entrant.generation);
        let scaled = |base: i32| (base * strength / 100) as u16;
        self.runners[index].cooldown[power] = recharge(COOLDOWNS[power], entrant.generation);
        let mut struck = NO_POWER;

        match power {
            FIRE => {
                let target = self.nearest_ahead(index, SHOT_RANGE, true);
                if self.shots.len() < MAX_SHOTS {
                    self.shots.push(Shot {
                        owner: index as u8,
                        target: if target == NO_POWER { NO_TARGET } else { target as u8 },
                        pos: runner.pos + 1_000,
                        x: runner.x,
                        life: SHOT_LIFE,
                    });
                }
                struck = target;
            }
            FROST => {
                let ticks = scaled(45);
                for other in 0..RACERS {
                    let them = self.runners[other];
                    let gap = them.pos - runner.pos;
                    if other != index && them.finished == 0 && gap > 0 && gap <= FROST_RANGE && self.strike(other, index) {
                        self.runners[other].chill = ticks;
                        self.emit(E_CHILLED, other, index, ticks as i32);
                    }
                }
            }
            BOLT => {
                let target = self.nearest_ahead(index, BOLT_RANGE, false);
                if target != NO_POWER {
                    struck = target;
                    if self.strike(target, index) {
                        let ticks = 14 + (8 * strength / 100) as u16;
                        let hit = &mut self.runners[target];
                        hit.stun = ticks;
                        hit.v = hit.v * 30 / 100;
                        self.emit(E_ZAPPED, target, index, ticks as i32);
                    }
                }
            }
            DASH => {
                let me = &mut self.runners[index];
                me.dash = scaled(30);
                me.stumble = 0;
            }
            SHIELD => self.runners[index].shield = scaled(120),
            VINE => {
                if self.traps.len() < MAX_TRAPS {
                    self.traps.push(Trap {
                        owner: index as u8,
                        pos: runner.pos - 2_000,
                        lane: lane_of(runner.x) as u8,
                    });
                }
            }
            BLINK => {
                let leap = 22_000 + 20_000 * (strength - 100) / 300;
                self.runners[index].pos = (runner.pos + leap).min(TRACK_LEN - 1);
            }
            MEND => {
                let me = &mut self.runners[index];
                me.stamina = (me.stamina + 6_000 * strength / 100).min(FULL_BREATH);
                me.winded = false;
                me.burn = 0;
                me.chill = 0;
                me.snare = 0;
            }
            _ => {}
        }
        let target_value = if struck == NO_POWER { -1 } else { struck as i32 };
        self.emit(E_CAST, index, power, target_value);
    }

    /// Whether an attack gets through. A shield or plain luck can stop it.
    fn strike(&mut self, target: usize, from: usize) -> bool {
        if self.runners[target].shield > 0 {
            self.runners[target].shield = 0;
            self.emit(E_BLOCKED, target, from, 0);
            return false;
        }
        if self.rng.below(100) < dodge_chance(&self.entrants[target]) {
            self.emit(E_DODGED, target, from, 0);
            return false;
        }
        self.runners[from].hits_landed += 1;
        true
    }

    fn fly_shots(&mut self) {
        let mut index = 0;
        while index < self.shots.len() {
            let mut shot = self.shots[index];
            shot.pos += SHOT_SPEED;
            shot.life = shot.life.saturating_sub(1);
            let mut done = shot.life == 0 || shot.pos >= TRACK_LEN + 20_000;

            if shot.target != NO_TARGET {
                let target = shot.target as usize;
                let them = self.runners[target];
                shot.x += (them.x - shot.x).clamp(-SHOT_STEER, SHOT_STEER);
                if them.finished != 0 || shot.pos > them.pos + 8_000 {
                    done = true;
                } else if (them.pos - shot.pos).abs() < SHOT_SPEED && (them.x - shot.x).abs() < 1_500 && them.y < 1_900 {
                    done = true;
                    let owner = shot.owner as usize;
                    if self.strike(target, owner) {
                        let ticks = (40 * might(self.entrants[owner].generation) / 100) as u16;
                        let hit = &mut self.runners[target];
                        hit.burn = ticks;
                        hit.v = hit.v * 70 / 100;
                        self.emit(E_BURNED, target, owner, ticks as i32);
                    }
                }
            } else {
                // Fired at nothing, it burns the first log or hedge in its way.
                let lane = lane_of(shot.x);
                let row = self.hazards.iter().position(|h| {
                    !h.burnt
                        && (h.kind == LOG || h.kind == HEDGE)
                        && h.lanes >> lane & 1 == 1
                        && h.pos <= shot.pos
                        && h.pos + depth(h.kind) + SHOT_SPEED > shot.pos
                });
                if let Some(row) = row {
                    self.hazards[row].burnt = true;
                    done = true;
                    self.emit(E_HAZARD_BURNT, shot.owner as usize, 0, row as i32);
                }
            }

            if done {
                self.shots.swap_remove(index);
            } else {
                self.shots[index] = shot;
                index += 1;
            }
        }
    }

    // ----- Running -------------------------------------------------------

    fn advance(&mut self, index: usize) {
        let entrant = self.entrants[index];
        let mut r = self.runners[index];

        if r.finished != 0 {
            // Past the line: run it off, so the screen has something to show.
            r.v = (r.v - 8).max(200);
            r.pos += r.v;
            self.runners[index] = r;
            return;
        }

        for timer in [&mut r.stumble, &mut r.burn, &mut r.chill, &mut r.stun, &mut r.snare, &mut r.dash, &mut r.shield] {
            *timer = timer.saturating_sub(1);
        }
        for timer in r.cooldown.iter_mut() {
            *timer = timer.saturating_sub(1);
        }
        r.jump_buffer = r.jump_buffer.saturating_sub(1);

        let cruise = cruise_speed(&entrant);
        let sprinting = r.sprint && !r.brake && !r.winded && r.stun == 0 && r.dash == 0;
        let mut target = cruise;
        if sprinting {
            target = target * 134 / 100;
        }
        if r.brake {
            target = target * 60 / 100;
        }
        if r.winded {
            target = target * 82 / 100;
        }
        if r.dash > 0 {
            target = cruise * 165 / 100;
        }
        if r.mud && r.y == 0 && r.dash == 0 {
            target = target * 58 / 100;
        }
        if r.burn > 0 {
            target = target * 68 / 100;
        }
        if r.chill > 0 {
            target = target * 72 / 100;
        }
        if r.snare > 0 {
            target = target * 45 / 100;
        }
        if r.stumble > 0 {
            target = target * 40 / 100;
        }
        if r.stun > 0 {
            target = target * 12 / 100;
        }
        // Tucking in behind someone is free speed.
        let in_slipstream = self.runners.iter().enumerate().any(|(other, them)| {
            other != index && them.pos > r.pos && them.pos - r.pos < SLIPSTREAM && (them.x - r.x).abs() < LANE_WIDTH / 2
        });
        if in_slipstream {
            target = target * 106 / 100;
        }

        if r.v < target {
            r.v = (r.v + ACCEL).min(target);
        } else {
            r.v = (r.v - BRAKE_FORCE).max(target);
        }

        if sprinting {
            r.stamina -= drain(&entrant);
            if r.stamina <= 0 {
                r.stamina = 0;
                r.winded = true;
            }
        } else if r.dash == 0 {
            r.stamina = (r.stamina + regen(&entrant) * if r.brake { 3 } else { 1 }).min(FULL_BREATH);
            if r.winded && r.stamina >= CATCH_BREATH {
                r.winded = false;
            }
        }

        let previous = r.pos;
        r.pos += r.v;

        let wanted = lane_centre(r.lane);
        r.x += (wanted - r.x).clamp(-LANE_SPEED, LANE_SPEED);

        if r.y > 0 {
            r.y += r.vy;
            r.vy -= if entrant.wings { WING_GRAVITY } else { GRAVITY };
            if r.y <= 0 {
                r.y = 0;
                r.vy = 0;
                self.emit(E_LAND, index, 0, 0);
            }
        }
        if r.y == 0 && r.jump_buffer > 0 && r.stun == 0 && r.stumble == 0 {
            r.jump_buffer = 0;
            r.y = 1;
            r.vy = JUMP_V;
            self.emit(E_JUMP, index, 0, 0);
        }

        r.mud = false;
        self.meet_hazards(index, previous, &entrant, &mut r);
        self.meet_traps(index, previous, &entrant, &mut r);

        if r.pos >= TRACK_LEN {
            r.finished = self.tick;
            self.finish_order.push(index as u8);
            self.emit(E_FINISH, index, self.finish_order.len(), 0);
        }
        self.runners[index] = r;
    }

    fn meet_hazards(&mut self, index: usize, previous: i32, entrant: &Entrant, r: &mut Runner) {
        let bit = 1u8 << index;
        let mut row = r.next as usize;
        while row < self.hazards.len() {
            let hazard = self.hazards[row];
            if hazard.pos > r.pos {
                break;
            }
            if hazard.pos + depth(hazard.kind) <= previous {
                if row == r.next as usize {
                    r.next += 1;
                }
                row += 1;
                continue;
            }
            let in_lane = hazard.lanes >> lane_of(r.x) & 1 == 1;
            if hazard.burnt || !in_lane || hazard.met & bit != 0 {
                row += 1;
                continue;
            }
            match hazard.kind {
                LOG | ROCK | HEDGE => {
                    self.hazards[row].met |= bit;
                    if r.dash > 0 || r.y >= height(hazard.kind) {
                        r.cleared += 1;
                        self.emit(E_CLEARED, index, hazard.kind as usize, row as i32);
                    } else if r.shield > 0 {
                        r.shield = 0;
                        r.cleared += 1;
                        self.emit(E_BLOCKED, index, index, row as i32);
                    } else {
                        r.stumble = if entrant.horn { 13 } else { 20 };
                        r.v = r.v * 45 / 100;
                        r.stamina = (r.stamina - 500).max(0);
                        r.trips += 1;
                        self.emit(E_TRIP, index, hazard.kind as usize, row as i32);
                    }
                }
                MUD => {
                    if r.y == 0 {
                        r.mud = true;
                    }
                }
                RAMP => {
                    if r.y == 0 {
                        self.hazards[row].met |= bit;
                        r.y = 1;
                        r.vy = RAMP_V;
                        self.emit(E_RAMP, index, 0, row as i32);
                    }
                }
                BERRY => {
                    if r.y < 3_000 {
                        self.hazards[row].met |= bit;
                        r.stamina = (r.stamina + 2_500).min(FULL_BREATH);
                        if r.stamina >= CATCH_BREATH {
                            r.winded = false;
                        }
                        self.emit(E_BERRY, index, 0, row as i32);
                    }
                }
                ORB => {
                    if r.y < 4_500 {
                        self.hazards[row].met |= bit;
                        for timer in r.cooldown.iter_mut() {
                            *timer = (*timer as u32 * 40 / 100) as u16;
                        }
                        self.emit(E_ORB, index, 0, row as i32);
                    }
                }
                _ => {}
            }
            row += 1;
        }
    }

    fn meet_traps(&mut self, index: usize, previous: i32, _entrant: &Entrant, r: &mut Runner) {
        let lane = lane_of(r.x) as u8;
        let mut trap = 0;
        while trap < self.traps.len() {
            let t = self.traps[trap];
            if t.owner as usize != index && t.lane == lane && previous < t.pos && r.pos >= t.pos && r.y < 800 {
                self.traps.swap_remove(trap);
                let owner = t.owner as usize;
                // Saved and reloaded around `strike`, which may touch this racer.
                self.runners[index] = *r;
                if self.strike(index, owner) {
                    let ticks = (36 * might(self.entrants[owner].generation) / 100) as u16;
                    self.runners[index].snare = ticks;
                    self.emit(E_SNARED, index, owner, ticks as i32);
                }
                *r = self.runners[index];
                continue;
            }
            trap += 1;
        }
    }

    // ----- Computer-run racers -------------------------------------------

    /// What a racer does this tick. Rivals run on this. It writes move codes
    /// into `out` and returns how many.
    pub fn decide(&self, index: usize, skill: u32, aggression: u32, rng: &mut Rng, mind: &mut Mind, out: &mut [u8; 8]) -> usize {
        let r = &self.runners[index];
        let entrant = &self.entrants[index];
        if r.finished != 0 {
            return 0;
        }
        let mut count = 0;
        let mut push = |code: u8, count: &mut usize| {
            if *count < out.len() {
                out[*count] = code;
                *count += 1;
            }
        };

        // Pace: run hard when there's breath, harder when falling behind the
        // player, and ease off when far in front, so the pack stays close.
        let behind_player = if index == 0 { 0 } else { self.runners[0].pos - r.pos };
        let wants_sprint = if behind_player > 40_000 {
            r.stamina > 800
        } else if behind_player < -70_000 {
            false
        } else if r.sprint {
            r.stamina > 1_500
        } else {
            r.stamina > 5_500
        };
        if wants_sprint != r.sprint {
            push(if wants_sprint { SPRINT_ON } else { SPRINT_OFF }, &mut count);
        }

        // The road ahead.
        let lane = lane_of(r.x);
        let speed = r.v.max(300);
        let horizon = speed * 18;
        let mut row = r.next as usize;
        while row < self.hazards.len() {
            let hazard = &self.hazards[row];
            if hazard.pos > r.pos + horizon {
                break;
            }
            let gap = hazard.pos - r.pos;
            let blocks = matches!(hazard.kind, LOG | ROCK | HEDGE | MUD);
            if gap >= 0 && blocks && !hazard.burnt && hazard.lanes >> lane & 1 == 1 {
                if mind.seen != row as u16 {
                    mind.seen = row as u16;
                    mind.blind = rng.below(100) >= skill;
                    mind.hop = hazard.kind == LOG || (hazard.kind == HEDGE && rng.below(2) == 0);
                }
                if !mind.blind {
                    if mind.hop {
                        if gap <= speed * 10 && r.y == 0 {
                            push(JUMP, &mut count);
                        }
                    } else if r.lane == lane {
                        let left_free = lane > 0 && hazard.lanes >> (lane - 1) & 1 == 0;
                        let right_free = lane < LANES - 1 && hazard.lanes >> (lane + 1) & 1 == 0;
                        if left_free && (!right_free || rng.below(2) == 0) {
                            push(LEFT, &mut count);
                        } else if right_free {
                            push(RIGHT, &mut count);
                        } else if lane == 0 {
                            push(RIGHT, &mut count);
                        } else {
                            push(LEFT, &mut count);
                        }
                    }
                }
                break;
            }
            row += 1;
        }

        // Powers, every few ticks so they don't all go off at once.
        if (self.tick + index as u32) % 10 == 0 {
            for power in 0..POWER_COUNT {
                if !entrant.has(power) || r.cooldown[power] > 0 {
                    continue;
                }
                let worthwhile = match power {
                    FIRE => self.nearest_ahead(index, 45_000, true) != NO_POWER,
                    FROST => self.nearest_ahead(index, 30_000, false) != NO_POWER,
                    BOLT => self.nearest_ahead(index, BOLT_RANGE, false) != NO_POWER,
                    DASH => r.pos > 60_000,
                    SHIELD => self.shots.iter().any(|s| s.target == index as u8),
                    VINE => self.nearest_behind(index, 20_000),
                    BLINK => r.pos > 60_000 && r.stumble > 0,
                    MEND => r.stamina < 2_500 || r.burn > 0 || r.snare > 0,
                    _ => false,
                };
                if worthwhile && rng.below(100) < aggression {
                    push(POWER + power as u8, &mut count);
                    break;
                }
            }
        }
        count
    }

    pub fn outcome(&self) -> Outcome {
        let mut order = [0u8; RACERS];
        let mut filled = 0;
        for &racer in &self.finish_order {
            order[filled] = racer;
            filled += 1;
        }
        let mut rest: Vec<u8> = (0..RACERS as u8).filter(|r| !self.finish_order.contains(r)).collect();
        rest.sort_by(|a, b| self.runners[*b as usize].pos.cmp(&self.runners[*a as usize].pos).then(a.cmp(b)));
        for racer in rest {
            order[filled] = racer;
            filled += 1;
        }
        let me = &self.runners[0];
        Outcome {
            order,
            ticks: if me.finished != 0 { me.finished } else { self.tick },
            player_finished: me.finished != 0,
            trips: me.trips,
            cleared: me.cleared,
            hits_landed: me.hits_landed,
        }
    }
}

/// One entry in a move log: ticks since the previous entry, and what was pressed.
pub const fn log_entry(ticks_since_last: u16, code: u8) -> u16 {
    ticks_since_last << 4 | code as u16
}

/// Plays a recorded race again, start to finish. This is what the contract
/// trusts. A log is one entry per move, in order.
pub fn replay(seed: &[u8], entrants: [Entrant; RACERS], ease: u8, log: &[u16]) -> Outcome {
    let mut race = Dash::new(seed, entrants, ease, false);
    let mut moves: Vec<u8> = Vec::with_capacity(8);
    let mut position = 0;
    let mut next_tick = log.first().map_or(u32::MAX, |entry| (entry >> 4) as u32);

    while !race.over {
        let tick = race.tick + 1;
        moves.clear();
        while position < log.len() && next_tick <= tick {
            moves.push((log[position] & 15) as u8);
            position += 1;
            next_tick = match log.get(position) {
                Some(entry) => next_tick + (entry >> 4) as u32,
                None => u32::MAX,
            };
        }
        race.step(&moves);
    }
    race.outcome()
}

/// How a pot is split between first, second and third, in percent.
pub const PRIZES_PCT: [u32; 3] = [55, 30, 15];

#[cfg(test)]
mod tests {
    use super::*;

    fn entrant(speed: u16, stamina: u16, luck: u16, generation: u32, powers: u16) -> Entrant {
        Entrant { speed, stamina, luck, level: 4, generation, powers, wings: false, horn: false }
    }

    fn field(me: Entrant) -> [Entrant; RACERS] {
        let rival = entrant(38, 38, 30, 0, 1 << FIRE);
        [me, rival, rival, rival, rival, rival]
    }

    /// Plays as racer 0, using the same brain as the rivals but its own dice,
    /// and writes down every move as a real player's browser would.
    fn play(seed: &[u8], entrants: [Entrant; RACERS], ease: u8, skill: u32, aggression: u32) -> (Outcome, Vec<u16>) {
        let mut race = Dash::new(seed, entrants, ease, false);
        let mut rng = Rng::from_seed(b"the player's own dice");
        let mut mind = Mind::default();
        let mut log = Vec::new();
        let mut last_tick = 0u32;
        while !race.over {
            let mut chosen = [0u8; 8];
            let count = race.decide(0, skill, aggression, &mut rng, &mut mind, &mut chosen);
            let tick = race.tick + 1;
            for &code in &chosen[..count] {
                log.push(log_entry((tick - last_tick) as u16, code));
                last_tick = tick;
            }
            race.step(&chosen[..count]);
        }
        (race.outcome(), log)
    }

    fn place(outcome: &Outcome) -> usize {
        outcome.order.iter().position(|&r| r == 0).unwrap()
    }

    fn average_place(me: Entrant, skill: u32, aggression: u32, ease: u8) -> f64 {
        let total: usize = (0u32..300)
            .map(|seed| place(&play(&seed.to_le_bytes(), field(me), ease, skill, aggression).0))
            .sum();
        total as f64 / 300.0 + 1.0
    }

    #[test]
    #[ignore = "prints a table for tuning"]
    fn balance_table() {
        let me = entrant(38, 38, 30, 0, 1 << FIRE);
        for ease in [0u8, 10, 18, 28] {
            for (skill, aggression) in [(35, 5), (50, 10), (65, 15), (75, 25), (90, 40), (100, 60)] {
                let mut places = [0u32; RACERS];
                let (mut seconds, mut trips, mut hits, mut landed) = (0u32, 0u32, 0u32, 0u32);
                let runs = 300u32;
                for seed in 0..runs {
                    let entrants = field(me);
                    let mut race = Dash::new(&seed.to_le_bytes(), entrants, ease, true);
                    let mut rng = Rng::from_seed(b"dice");
                    let mut mind = Mind::default();
                    while !race.over {
                        let mut chosen = [0u8; 8];
                        let count = race.decide(0, skill, aggression, &mut rng, &mut mind, &mut chosen);
                        race.step(&chosen[..count]);
                        hits += race.events.iter().filter(|e| matches!(e.kind, E_BURNED | E_CHILLED | E_ZAPPED | E_SNARED) && e.a == 0).count() as u32;
                    }
                    let outcome = race.outcome();
                    places[place(&outcome)] += 1;
                    seconds += outcome.ticks / TICKS_PER_SEC;
                    trips += outcome.trips as u32;
                    landed += outcome.hits_landed as u32;
                }
                println!(
                    "ease {ease:2} skill {skill:3} aggr {aggression:2} | places {:?} | {:.1}s trips {:.1} landed {:.1} got hit {:.1}",
                    places, seconds as f64 / runs as f64, trips as f64 / runs as f64, landed as f64 / runs as f64, hits as f64 / runs as f64
                );
            }
        }
    }

    #[test]
    fn a_replay_of_the_moves_gives_exactly_the_same_race() {
        let me = entrant(40, 40, 30, 2, 1 << FIRE | 1 << DASH | 1 << SHIELD | 1 << VINE);
        for seed in 0u32..150 {
            let seed = seed.to_le_bytes();
            let entrants = field(me);
            let (live, log) = play(&seed, entrants, 0, 85, 40);
            assert_eq!(replay(&seed, entrants, 0, &log), live, "seed {seed:?}");
        }
    }

    #[test]
    fn the_same_seed_gives_the_same_course() {
        assert_eq!(build_course(b"a"), build_course(b"a"));
        assert_ne!(build_course(b"a"), build_course(b"b"));
    }

    #[test]
    fn every_row_can_be_got_past() {
        for seed in 0u32..2_000 {
            for hazard in build_course(&seed.to_le_bytes()) {
                if hazard.kind == ROCK {
                    assert_ne!(hazard.lanes, 0b111, "a wall of rocks can't be jumped");
                }
                assert!(hazard.pos < TRACK_LEN);
                assert!(hazard.lanes != 0);
            }
        }
    }

    #[test]
    fn courses_have_plenty_going_on() {
        for seed in 0u32..200 {
            let course = build_course(&seed.to_le_bytes());
            let rows = course.iter().filter(|h| h.kind <= MUD).count();
            assert!((11..=40).contains(&rows), "{rows} rows");
        }
    }

    #[test]
    fn a_race_ends_in_a_sensible_time() {
        for seed in 0u32..200 {
            let (outcome, _) = play(&seed.to_le_bytes(), field(entrant(38, 38, 30, 0, 1)), 0, 60, 20);
            assert!(outcome.player_finished);
            let seconds = outcome.ticks / TICKS_PER_SEC;
            assert!((30..=75).contains(&seconds), "{seconds} s");
        }
    }

    #[test]
    fn standing_still_loses() {
        let log: Vec<u16> = Vec::new();
        let me = entrant(38, 38, 30, 0, 1);
        let outcome = replay(b"lazy", field(me), 0, &log);
        assert!(place(&outcome) >= 4, "a player who does nothing came {}", place(&outcome) + 1);
    }

    #[test]
    fn good_driving_beats_bad_driving() {
        let me = entrant(38, 38, 30, 0, 1 << FIRE);
        let good = average_place(me, 98, 40, 0);
        let poor = average_place(me, 35, 5, 0);
        assert!(good + 1.0 < poor, "good {good:.2} poor {poor:.2}");
    }

    #[test]
    fn a_new_player_can_win_without_being_perfect() {
        let me = entrant(38, 38, 30, 0, 1 << FIRE);
        let decent = average_place(me, 75, 15, 18);
        assert!(decent < 3.0, "a decent new player averaged place {decent:.2}");
    }

    #[test]
    fn perfect_play_does_not_always_win() {
        let me = entrant(38, 38, 30, 0, 1 << FIRE);
        let wins = (0u32..300)
            .filter(|seed| place(&play(&seed.to_le_bytes(), field(me), 0, 100, 60).0) == 0)
            .count();
        assert!(wins > 100 && wins < 298, "perfect play won {wins} of 300");
    }

    #[test]
    fn later_generations_race_better() {
        let founder = average_place(entrant(38, 38, 30, 0, 1 << FIRE), 75, 25, 0);
        let eighth = average_place(entrant(75, 75, 65, 8, 1 << FIRE | 1 << DASH | 1 << SHIELD), 75, 25, 0);
        assert!(eighth + 0.5 < founder, "gen 8 {eighth:.2} founder {founder:.2}");
    }

    #[test]
    fn might_always_rises_and_flattens() {
        let mut last = might(0);
        assert_eq!(last, 100);
        for generation in [1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 500, 5_000, 900_000] {
            let now = might(generation);
            assert!(now >= last, "{generation}");
            assert!(now <= 400);
            last = now;
        }
        assert!(might(1) > might(0) && might(10) > might(5));
    }

    #[test]
    fn every_level_helps_but_less_each_time() {
        let gains: Vec<i32> = (1..=30u8).map(level_speed).collect();
        assert_eq!(gains[0], 0);
        assert!(gains.windows(2).all(|w| w[1] >= w[0]));
        assert!(gains[29] > gains[9] && gains[9] > gains[2]);
        assert!(gains[9] - gains[0] > gains[29] - gains[19]);
        // Even the best-fed Kinling is only about a tenth faster.
        assert!(gains[29] * 100 / cruise_speed(&Entrant::default()) <= 12);
    }

    #[test]
    fn stats_keep_helping_at_any_size_and_never_overflow() {
        let huge = entrant(u16::MAX, u16::MAX, u16::MAX, u32::MAX, u16::MAX);
        assert!(cruise_speed(&huge) > cruise_speed(&entrant(500, 500, 500, 50, 1)));
        assert!(cruise_speed(&huge) < 800);
        let (outcome, _) = play(b"huge", [huge; RACERS], 0, 90, 40);
        assert!(outcome.player_finished);
    }

    fn scripted(power: usize, range_check: impl Fn(&Dash) -> bool) -> Dash {
        let me = entrant(38, 38, 0, 3, 1 << power);
        let mut rival = entrant(38, 38, 0, 0, 0);
        rival.luck = 0;
        let mut race = Dash::new(b"scripted", [me, rival, rival, rival, rival, rival], 0, true);
        race.hazards.clear();
        for runner in race.runners.iter_mut() {
            runner.cooldown = [0; POWER_COUNT];
        }
        race.runners[0].pos = 100_000;
        for (index, runner) in race.runners.iter_mut().enumerate().skip(1) {
            runner.pos = 100_000 + 6_000 * index as i32;
            runner.x = 0;
            runner.lane = 1;
        }
        race.runners[0].x = 0;
        race.runners[0].lane = 1;
        race.step(&[POWER + power as u8]);
        let mut guard = 0;
        while !range_check(&race) && guard < 120 {
            race.step(&[]);
            guard += 1;
        }
        race
    }

    #[test]
    fn spitting_fire_burns_the_racer_ahead() {
        let race = scripted(FIRE, |race| race.runners.iter().any(|r| r.burn > 0));
        assert!(race.runners[1].burn > 0, "the nearest racer ahead should be burning");
    }

    #[test]
    fn a_shield_stops_a_fireball() {
        let me = entrant(38, 38, 0, 3, 1 << FIRE);
        let rival = entrant(38, 38, 0, 0, 0);
        let mut race = Dash::new(b"shield", [me, rival, rival, rival, rival, rival], 0, true);
        race.hazards.clear();
        for runner in race.runners.iter_mut() {
            runner.cooldown = [0; POWER_COUNT];
            runner.x = 0;
            runner.lane = 1;
            runner.pos = 100_000;
        }
        race.runners[1].pos = 110_000;
        race.runners[1].shield = 200;
        race.step(&[POWER + FIRE as u8]);
        for _ in 0..30 {
            race.step(&[]);
        }
        assert_eq!(race.runners[1].burn, 0);
        assert_eq!(race.runners[1].shield, 0, "the shield is used up");
    }

    #[test]
    fn a_jump_clears_a_fireball() {
        let me = entrant(38, 38, 0, 3, 1 << FIRE);
        let rival = entrant(38, 38, 0, 0, 0);
        let mut race = Dash::new(b"hop", [me, rival, rival, rival, rival, rival], 0, true);
        race.hazards.clear();
        for runner in race.runners.iter_mut() {
            runner.cooldown = [0; POWER_COUNT];
            runner.x = 0;
            runner.lane = 1;
            runner.pos = 100_000;
        }
        race.runners[1].pos = 112_000;
        race.runners[1].y = 3_000;
        race.runners[1].vy = 0;
        race.shots.push(Shot { owner: 0, target: 1, pos: 110_000, x: 0, life: 3 });
        race.step(&[]);
        assert_eq!(race.runners[1].burn, 0);
    }

    #[test]
    fn powers_grow_with_the_generation() {
        let burn_from = |generation: u32| {
            let me = entrant(38, 38, 0, 3, 1 << FIRE);
            let rival = entrant(38, 38, 0, 0, 0);
            let mut entrants = [me, rival, rival, rival, rival, rival];
            entrants[0].generation = generation;
            let mut race = Dash::new(b"grow", entrants, 0, true);
            race.hazards.clear();
            for runner in race.runners.iter_mut() {
                runner.cooldown = [0; POWER_COUNT];
                runner.x = 0;
                runner.lane = 1;
                runner.pos = 100_000;
            }
            race.runners[1].pos = 110_000;
            race.step(&[POWER + FIRE as u8]);
            let mut most = 0;
            for _ in 0..30 {
                race.step(&[]);
                most = most.max(race.runners[1].burn);
            }
            most
        };
        assert!(burn_from(10) > burn_from(1));
        assert!(burn_from(1) > burn_from(0));
    }

    #[test]
    fn jumping_clears_a_log_and_running_into_it_trips() {
        let me = entrant(38, 38, 30, 0, 0);
        let rival = entrant(38, 38, 30, 0, 0);
        let setup = || {
            let mut race = Dash::new(b"log", [me, rival, rival, rival, rival, rival], 0, true);
            race.hazards = vec![Hazard { pos: 20_000, kind: LOG, lanes: 0b111, burnt: false, met: 0 }];
            race
        };
        let mut tripped = setup();
        while tripped.runners[0].pos < 30_000 && !tripped.over {
            tripped.step(&[]);
        }
        assert_eq!(tripped.runners[0].trips, 1);

        let mut jumped = setup();
        while jumped.runners[0].pos < 30_000 && !jumped.over {
            let gap = 20_000 - jumped.runners[0].pos;
            let moves: &[u8] = if gap > 0 && gap < jumped.runners[0].v * 10 { &[JUMP] } else { &[] };
            jumped.step(moves);
        }
        assert_eq!(jumped.runners[0].trips, 0);
        assert_eq!(jumped.runners[0].cleared, 1);
    }

    #[test]
    fn sprinting_runs_you_out_of_breath() {
        let me = entrant(38, 38, 30, 0, 0);
        let rival = entrant(38, 38, 30, 0, 0);
        let mut race = Dash::new(b"breath", [me, rival, rival, rival, rival, rival], 0, true);
        race.hazards.clear();
        race.step(&[SPRINT_ON]);
        let mut top = 0;
        for _ in 0..240 {
            race.step(&[]);
            top = top.max(race.runners[0].v);
        }
        assert!(race.runners[0].winded || race.runners[0].stamina < FULL_BREATH);
        assert!(top > cruise_speed(&me) * 120 / 100);
    }

    #[test]
    fn braking_catches_your_breath_faster() {
        let me = entrant(38, 38, 30, 0, 0);
        let rival = entrant(38, 38, 30, 0, 0);
        let breath_after = |moves: &[u8]| {
            let mut race = Dash::new(b"brake", [me, rival, rival, rival, rival, rival], 0, true);
            race.hazards.clear();
            race.runners[0].stamina = 1_000;
            race.step(moves);
            for _ in 0..60 {
                race.step(&[]);
            }
            race.runners[0].stamina
        };
        assert!(breath_after(&[BRAKE_ON]) > breath_after(&[]) + 1_500);
    }

    #[test]
    fn entrants_survive_packing() {
        let entrants = field(entrant(1_234, 567, 89, 4_000_000, 0xABCD));
        assert_eq!(unpack_entrants(&pack_entrants(&entrants)), entrants);
    }

    #[test]
    fn a_junk_log_is_harmless() {
        let log: Vec<u16> = (0..2_000).map(|i| (i as u16).wrapping_mul(40_503)).collect();
        let outcome = replay(b"junk", field(entrant(38, 38, 30, 0, 255)), 0, &log);
        assert_eq!(outcome.order.len(), RACERS);
    }

    #[test]
    fn everyone_is_placed_exactly_once() {
        for seed in 0u32..100 {
            let (outcome, _) = play(&seed.to_le_bytes(), field(entrant(38, 38, 30, 0, 1)), 0, 70, 20);
            let mut order = outcome.order;
            order.sort_unstable();
            assert_eq!(order, [0, 1, 2, 3, 4, 5]);
        }
    }
}
