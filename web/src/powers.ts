// What each race power is called and does. The rules themselves live in the
// Rust race engine; this file is only the words and pictures for the screen.

export interface PowerInfo {
  id: number;
  name: string;
  icon: string;
  key: string;
  text: string;
  /** Which food can wake it at a pairing. */
  food: string;
}

export const POWERS: PowerInfo[] = [
  { id: 0, name: "Fire Spit", icon: "🔥", key: "1", food: "Emberroot", text: "Spit a fireball at the racer ahead. It burns them and slows them down, or burns away a log or hedge in your path." },
  { id: 1, name: "Frost Breath", icon: "❄️", key: "2", food: "Frostberry", text: "Everyone just ahead of you is chilled and slows right down." },
  { id: 2, name: "Storm Bolt", icon: "⚡", key: "3", food: "Starfig", text: "Lightning strikes the nearest racer ahead, in any lane, and stops them dead for a moment." },
  { id: 3, name: "Wind Dash", icon: "💨", key: "4", food: "", text: "A burst of speed. You pass straight through anything in your way." },
  { id: 4, name: "Bubble Shield", icon: "🛡️", key: "5", food: "", text: "Blocks the next attack or crash." },
  { id: 5, name: "Vine Snare", icon: "🌿", key: "6", food: "Dewbean", text: "Leaves a snare behind you. The next racer through gets tangled." },
  { id: 6, name: "Blink Step", icon: "✨", key: "7", food: "Moonmelon", text: "Vanish and reappear further down the track." },
  { id: 7, name: "Second Wind", icon: "💗", key: "8", food: "Sunwheat", text: "Refills your breath and clears burns, chills and snares." },
];

export function powersIn(mask: number): PowerInfo[] {
  return POWERS.filter((power) => (mask >> power.id) & 1);
}

/** How hard a generation's powers hit, the same sum the race engine does. */
export function might(generation: number): number {
  const g = Math.min(generation, 1_000_000);
  return 100 + Math.floor((300 * g) / (g + 10));
}

/** The race stats and powers held in a Kinling's packed genes. */
export function statsFromGenes(genes: number[]) {
  return {
    speed: genes[16] | (genes[17] << 8),
    stamina: genes[18] | (genes[19] << 8),
    luck: genes[20] | (genes[21] << 8),
    shiny: genes[22] !== 0,
    powers: genes[23] | (genes[24] << 8),
  };
}
