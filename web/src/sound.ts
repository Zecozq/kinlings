// Sound for the game: effects are synthesised live with Web Audio, and the
// music is streamed from audio files built by tools/music/compose.py.

type Track = "valley" | "race" | "none";
type Stinger = "victory" | "defeat";

const MASTER_LEVEL = 0.8;
const MUSIC_LEVEL = 0.55;
const STINGER_LEVEL = 0.8;
const CROSSFADE = 1.4;
const MAX_VOICES = 64;

let audio: AudioContext | null = null;
let master: GainNode | null = null;
let sfxBus: GainNode | null = null;
let musicBus: GainNode | null = null;
let duckBus: GainNode | null = null;
let stingerBus: GainNode | null = null;
let reverbIn: GainNode | null = null;
let noiseBuffer: AudioBuffer | null = null;

let muted = false;
let gesture = false;
let voices = 0;

// Browsers refuse to start audio before the player interacts, so nothing
// plays (or even gets created) until the first gesture.
function armGesture() {
  if (typeof window === "undefined") return;
  const onGesture = () => {
    gesture = true;
    window.removeEventListener("pointerdown", onGesture, true);
    window.removeEventListener("keydown", onGesture, true);
    window.removeEventListener("touchend", onGesture, true);
    const context = ensureContext();
    if (context && context.state === "suspended") void context.resume();
    if (wantedTrack !== "none") playMusic(wantedTrack);
  };
  window.addEventListener("pointerdown", onGesture, true);
  window.addEventListener("keydown", onGesture, true);
  window.addEventListener("touchend", onGesture, true);
}

function ensureContext(): AudioContext | null {
  if (audio) return audio;
  if (!gesture || typeof AudioContext === "undefined") return null;
  try {
    const context = new AudioContext();
    const out = context.createGain();
    out.gain.value = muted ? 0 : MASTER_LEVEL;
    const limiter = context.createDynamicsCompressor();
    limiter.threshold.value = -8;
    limiter.knee.value = 6;
    limiter.ratio.value = 10;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.2;
    out.connect(limiter);
    limiter.connect(context.destination);

    const bus = context.createGain();
    bus.connect(out);

    const music = context.createGain();
    music.gain.value = MUSIC_LEVEL;
    const duck = context.createGain();
    music.connect(duck);
    duck.connect(out);

    const stinger = context.createGain();
    stinger.gain.value = STINGER_LEVEL;
    stinger.connect(out);

    // A small generated room gives the effects some air.
    const verb = context.createConvolver();
    const length = Math.floor(context.sampleRate * 0.7);
    const impulse = context.createBuffer(2, length, context.sampleRate);
    for (let channel = 0; channel < 2; channel++) {
      const data = impulse.getChannelData(channel);
      for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, 3);
    }
    verb.buffer = impulse;
    const send = context.createGain();
    send.gain.value = 0.3;
    send.connect(verb);
    const wet = context.createGain();
    wet.gain.value = 0.32;
    verb.connect(wet);
    wet.connect(bus);

    const noise = context.createBuffer(1, context.sampleRate * 2, context.sampleRate);
    const noiseData = noise.getChannelData(0);
    for (let i = 0; i < noiseData.length; i++) noiseData[i] = Math.random() * 2 - 1;

    audio = context;
    master = out;
    sfxBus = bus;
    musicBus = music;
    duckBus = duck;
    stingerBus = stinger;
    reverbIn = send;
    noiseBuffer = noise;
    return context;
  } catch {
    return null;
  }
}

function ready(): AudioContext | null {
  if (muted) return null;
  const context = ensureContext();
  if (context && context.state === "suspended") void context.resume();
  return context;
}

function voiceStarted(node: AudioScheduledSourceNode) {
  voices++;
  node.onended = () => {
    voices--;
  };
}

function vary(value: number, amount = 0.03) {
  return value * (1 + (Math.random() * 2 - 1) * amount);
}

// A small envelope that never clicks.
function shape(param: AudioParam, when: number, attack: number, peak: number, hold: number, decay: number) {
  param.setValueAtTime(0.0001, when);
  param.exponentialRampToValueAtTime(Math.max(peak, 0.0002), when + attack);
  if (hold > 0) param.setValueAtTime(Math.max(peak, 0.0002), when + attack + hold);
  param.exponentialRampToValueAtTime(0.0001, when + attack + hold + decay);
}

interface ToneOptions {
  to?: number;
  at?: number;
  attack?: number;
  hold?: number;
  filter?: number;
  send?: number;
  detune?: number;
}

function tone(frequency: number, duration: number, type: OscillatorType, volume: number, options: ToneOptions = {}) {
  const context = ready();
  if (!context || !sfxBus || voices > MAX_VOICES) return;
  const start = context.currentTime + (options.at ?? 0);
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, start);
  if (options.detune) oscillator.detune.setValueAtTime(options.detune, start);
  if (options.to) oscillator.frequency.exponentialRampToValueAtTime(options.to, start + duration);
  const attack = options.attack ?? 0.008;
  shape(gain.gain, start, attack, volume, options.hold ?? 0, Math.max(duration - attack, 0.02));
  let tail: AudioNode = oscillator;
  if (options.filter) {
    const lowpass = context.createBiquadFilter();
    lowpass.type = "lowpass";
    lowpass.frequency.value = options.filter;
    tail.connect(lowpass);
    tail = lowpass;
  }
  tail.connect(gain);
  gain.connect(sfxBus);
  if (options.send && reverbIn) {
    const send = context.createGain();
    send.gain.value = options.send;
    gain.connect(send);
    send.connect(reverbIn);
  }
  oscillator.start(start);
  oscillator.stop(start + (options.hold ?? 0) + duration + 0.05);
  voiceStarted(oscillator);
}

interface NoiseOptions {
  to?: number;
  at?: number;
  q?: number;
  kind?: BiquadFilterType;
  attack?: number;
  send?: number;
  flutter?: number;
}

function noise(duration: number, volume: number, frequency: number, options: NoiseOptions = {}) {
  const context = ready();
  if (!context || !sfxBus || !noiseBuffer || voices > MAX_VOICES) return;
  const start = context.currentTime + (options.at ?? 0);
  const source = context.createBufferSource();
  source.buffer = noiseBuffer;
  const filter = context.createBiquadFilter();
  filter.type = options.kind ?? "bandpass";
  filter.Q.value = options.q ?? 1;
  filter.frequency.setValueAtTime(frequency, start);
  if (options.to) filter.frequency.exponentialRampToValueAtTime(options.to, start + duration);
  const gain = context.createGain();
  const attack = options.attack ?? 0.004;
  shape(gain.gain, start, attack, volume, 0, Math.max(duration - attack, 0.02));
  source.connect(filter);
  filter.connect(gain);
  let tail: AudioNode = gain;
  if (options.flutter) {
    const flicker = context.createGain();
    flicker.gain.value = 0.6;
    const lfo = context.createOscillator();
    lfo.frequency.value = options.flutter;
    const depth = context.createGain();
    depth.gain.value = 0.4;
    lfo.connect(depth);
    depth.connect(flicker.gain);
    gain.connect(flicker);
    tail = flicker;
    lfo.start(start);
    lfo.stop(start + duration + 0.05);
    voiceStarted(lfo);
  }
  tail.connect(sfxBus);
  if (options.send && reverbIn) {
    const send = context.createGain();
    send.gain.value = options.send;
    tail.connect(send);
    send.connect(reverbIn);
  }
  source.start(start, Math.random() * 1.5);
  source.stop(start + duration + 0.05);
  voiceStarted(source);
}

// A struck metal voice built from inharmonic partials.
function bellVoice(frequency: number, duration: number, volume: number, at = 0, partials: [number, number][] = [[1, 1], [2, 0.5], [2.99, 0.3], [4.17, 0.15], [5.43, 0.08]]) {
  partials.forEach(([ratio, weight], index) => {
    tone(frequency * ratio, duration / (1 + index * 0.5), "sine", volume * weight, { at, attack: 0.003, send: 0.35 });
  });
}

// A little sparkle of random bright notes above a frequency.
function sparkle(frequency: number, count: number, spread: number, volume: number, at = 0) {
  for (let i = 0; i < count; i++) {
    tone(vary(frequency * (1 + Math.random()), 0.1), 0.18, "sine", volume, { at: at + (i * spread) / count, attack: 0.004, send: 0.5 });
  }
}

export const sound = {
  pop() {
    tone(vary(420), 0.08, "sine", 0.36, { to: 880 });
    tone(vary(880), 0.06, "triangle", 0.14, { to: 1400, at: 0.01 });
    noise(0.025, 0.12, 4000, { q: 1.2 });
  },
  plant() {
    tone(vary(150), 0.16, "sine", 0.4, { to: 88 });
    noise(0.12, 0.28, 320, { kind: "lowpass", to: 160, q: 0.7 });
    noise(0.05, 0.1, 1400, { at: 0.05, q: 1.5 });
  },
  water() {
    [0, 0.07, 0.15].forEach((at, index) => {
      tone(vary(880 + index * 160, 0.05), 0.09, "sine", 0.18 - index * 0.02, { to: vary(1500 + index * 220, 0.05), at, send: 0.2 });
    });
    noise(0.22, 0.09, 3400, { q: 1.4, attack: 0.03 });
  },
  harvest() {
    [784, 988, 1175].forEach((f, index) => {
      tone(f, 0.16, "triangle", 0.3 - index * 0.04, { at: index * 0.065, send: 0.2 });
    });
    bellVoice(1568, 0.25, 0.1, 0.18);
    noise(0.1, 0.08, 2200, { q: 0.9 });
  },
  coin() {
    tone(987.8, 0.09, "square", 0.08, { filter: 3800, send: 0.15 });
    tone(1318.5, 0.32, "square", 0.08, { at: 0.07, filter: 3800, send: 0.3 });
    bellVoice(1975.5, 0.32, 0.12, 0.07, [[1, 1], [2.4, 0.3]]);
  },
  munch() {
    [0, 0.09, 0.2].forEach((at, index) => {
      noise(0.05, 0.22 + 0.05 * index, vary(1100, 0.4), { at, q: 2, kind: "bandpass" });
      tone(vary(170), 0.07, "square", 0.08, { at, to: 110, filter: 800 });
    });
  },
  warm() {
    tone(330, 0.5, "sine", 0.2, { to: 494, attack: 0.08, send: 0.4 });
    tone(494, 0.4, "sine", 0.08, { to: 659, attack: 0.1, at: 0.05, send: 0.4 });
    sparkle(1760, 3, 0.3, 0.04, 0.12);
  },
  crack() {
    noise(0.04, 0.4, 2600, { kind: "highpass", q: 0.7 });
    tone(vary(900), 0.05, "sawtooth", 0.12, { to: 240, filter: 2600 });
    tone(140, 0.08, "sine", 0.24, { to: 70 });
  },
  hatch() {
    [523.3, 659.3, 784, 1046.5, 1318.5].forEach((f, index) => {
      tone(f, 0.3, "triangle", 0.28, { at: index * 0.08, send: 0.3 });
    });
    bellVoice(1568, 0.8, 0.14, 0.42);
    sparkle(2093, 7, 0.5, 0.05, 0.3);
    noise(0.5, 0.08, 6000, { q: 0.6, at: 0.25 });
  },
  fanfare() {
    const hits: [number, number[]][] = [
      [0, [392, 523.3, 659.3]],
      [0.16, [440, 587.3, 698.5]],
      [0.32, [523.3, 659.3, 784]],
      [0.5, [587.3, 784, 987.8]],
      [0.72, [659.3, 784, 1046.5, 1318.5]],
    ];
    hits.forEach(([at, chord], index) => {
      const length = index === hits.length - 1 ? 0.9 : 0.18;
      chord.forEach((f) => {
        tone(f, length, "sawtooth", 0.11, { at, attack: 0.012, filter: 3600, send: 0.35 });
        tone(f * 1.003, length, "triangle", 0.12, { at, attack: 0.008, send: 0.2 });
      });
    });
    tone(130.8, 1.1, "triangle", 0.3, { at: 0.72, send: 0.2 });
    noise(0.9, 0.16, 8000, { kind: "highpass", at: 0.72, q: 0.7, send: 0.5 });
    bellVoice(2093, 1.0, 0.12, 0.72);
  },
  bell() {
    bellVoice(880, 1.2, 0.3);
    tone(440, 0.8, "sine", 0.1, { send: 0.3 });
  },
  cheer() {
    tone(vary(700), 0.1, "triangle", 0.22, { to: 1150 });
    tone(vary(1050), 0.16, "sine", 0.16, { at: 0.06, to: 1600, send: 0.3 });
    noise(0.22, 0.1, 1400, { q: 0.6, attack: 0.05 });
  },
  fail() {
    tone(220, 0.26, "triangle", 0.22, { to: 140 });
    tone(110, 0.3, "sine", 0.16, { to: 72 });
  },

  // Race effects.
  jump() {
    tone(vary(260), 0.16, "sine", 0.3, { to: 820, send: 0.15 });
    noise(0.12, 0.1, 900, { to: 2600, q: 1.2 });
  },
  land() {
    tone(vary(140), 0.18, "sine", 0.48, { to: 54 });
    noise(0.06, 0.24, 1000, { kind: "lowpass", q: 0.7 });
  },
  hit() {
    noise(0.06, 0.5, 1800, { q: 0.8 });
    tone(vary(190), 0.13, "square", 0.34, { to: 70, filter: 1400 });
    tone(90, 0.18, "sine", 0.38, { to: 48 });
  },
  stumble() {
    tone(vary(320), 0.22, "triangle", 0.22, { to: 120 });
    tone(vary(260), 0.2, "triangle", 0.2, { to: 110, at: 0.12 });
    noise(0.28, 0.12, 700, { q: 0.8, to: 300 });
  },
  fire() {
    noise(0.55, 0.3, 1100, { to: 360, q: 0.7, flutter: 28, send: 0.2, attack: 0.04 });
    tone(90, 0.45, "sawtooth", 0.14, { to: 58, filter: 300 });
    for (let i = 0; i < 6; i++) noise(0.02, 0.14, 4200, { at: Math.random() * 0.5, q: 1.2 });
  },
  frost() {
    noise(0.7, 0.13, 6500, { to: 2600, q: 1.2, attack: 0.05, send: 0.4 });
    [2349, 2793, 3136, 3729].forEach((f, index) => {
      tone(f, 0.28, "sine", 0.07, { at: index * 0.07, send: 0.5 });
    });
    tone(980, 0.5, "triangle", 0.08, { to: 740, attack: 0.04, send: 0.4 });
  },
  bolt() {
    tone(1900, 0.16, "sawtooth", 0.2, { to: 90, filter: 5200 });
    noise(0.12, 0.32, 3600, { q: 0.6 });
    tone(1500, 0.08, "sawtooth", 0.12, { to: 200, at: 0.06, filter: 3000 });
    tone(72, 0.34, "sine", 0.34, { to: 42, at: 0.02, send: 0.2 });
  },
  dash() {
    noise(0.3, 0.3, 500, { to: 3600, q: 0.8 });
    tone(200, 0.22, "triangle", 0.14, { to: 660 });
  },
  shield() {
    tone(330, 0.7, "sine", 0.14, { attack: 0.16, send: 0.45 });
    tone(495.5, 0.7, "sine", 0.1, { attack: 0.18, send: 0.45 });
    bellVoice(1320, 0.5, 0.14, 0.05);
    noise(0.5, 0.05, 5200, { q: 2, attack: 0.1, send: 0.4 });
  },
  vine() {
    noise(0.28, 0.16, 420, { to: 1300, q: 1.1, attack: 0.03 });
    tone(150, 0.26, "triangle", 0.2, { to: 260, filter: 1500 });
    tone(vary(330), 0.1, "triangle", 0.12, { at: 0.13, to: 220 });
  },
  blink() {
    tone(1250, 0.12, "sine", 0.2, { to: 300 });
    tone(320, 0.14, "sine", 0.2, { to: 1500, at: 0.1, send: 0.4 });
    sparkle(1760, 3, 0.15, 0.05, 0.14);
  },
  orb() {
    tone(523, 0.28, "triangle", 0.15, { to: 1046, send: 0.3 });
    bellVoice(1046.5, 0.7, 0.26, 0.16);
    sparkle(2093, 4, 0.25, 0.06, 0.2);
  },
  berry() {
    tone(vary(520), 0.06, "sine", 0.3, { to: 1000 });
    tone(1319, 0.2, "triangle", 0.16, { at: 0.05, send: 0.25 });
    noise(0.03, 0.08, 5000, { q: 1.2 });
  },
  countdown() {
    tone(880, 0.12, "triangle", 0.42, { send: 0.15 });
    tone(1760, 0.05, "sine", 0.12);
    noise(0.015, 0.12, 2400, { q: 1 });
  },
  go() {
    [880, 1109, 1319, 1760].forEach((f) => {
      tone(f, 0.5, "triangle", 0.18, { attack: 0.01, send: 0.25 });
      tone(f, 0.5, "sawtooth", 0.05, { attack: 0.012, filter: 3000 });
    });
    bellVoice(1760, 0.6, 0.15);
    noise(0.55, 0.14, 7000, { kind: "highpass", q: 0.7, attack: 0.02, send: 0.4 });
  },
  whoosh() {
    noise(0.42, 0.34, 420, { to: 4200, q: 1.1 });
  },
  footstep(intensity: number) {
    const level = Math.max(0, Math.min(1, intensity));
    tone(vary(95 + 45 * level, 0.08), 0.07 + 0.05 * level, "sine", 0.14 + 0.2 * level, { to: 50 });
    noise(0.04 + 0.02 * level, 0.05 + 0.13 * level, vary(800 + 1500 * level, 0.12), { q: 0.9 });
  },
};

// Music -------------------------------------------------------------------

const tracks = new Map<string, Promise<AudioBuffer | null>>();

function trackUrl(name: string, extension: string) {
  return `${import.meta.env.BASE_URL}audio/${name}.${extension}`;
}

function preferredFormats(): string[] {
  try {
    const probe = document.createElement("audio");
    return probe.canPlayType('audio/ogg; codecs="vorbis"') ? ["ogg", "m4a"] : ["m4a", "ogg"];
  } catch {
    return ["ogg", "m4a"];
  }
}

function loadTrack(name: string): Promise<AudioBuffer | null> {
  const context = ensureContext();
  if (!context) return Promise.resolve(null);
  let pending = tracks.get(name);
  if (!pending) {
    pending = (async () => {
      for (const extension of preferredFormats()) {
        try {
          const response = await fetch(trackUrl(name, extension));
          if (!response.ok) continue;
          return await context.decodeAudioData(await response.arrayBuffer());
        } catch {
          // Try the next format; an unplayable track is simply silent.
        }
      }
      return null;
    })();
    tracks.set(name, pending);
    // A track that failed to load may succeed on a later request.
    void pending.then((buffer) => {
      if (!buffer) tracks.delete(name);
    });
  }
  return pending;
}

interface Playing {
  track: Track;
  source: AudioBufferSourceNode;
  gain: GainNode;
}

let wantedTrack: Track = "none";
let playing: Playing | null = null;
let musicRequest = 0;

function fadeCurve(start: number, end: number, length: number) {
  // Equal-power, so a crossfade between two tracks holds its loudness.
  return Float32Array.from({ length }, (_, i) => {
    const phase = i / (length - 1);
    return start === 0 ? Math.sin((phase * Math.PI) / 2) * end : Math.cos((phase * Math.PI) / 2) * start;
  });
}

function fadeOutPlaying(context: AudioContext) {
  if (!playing) return;
  const { source, gain } = playing;
  playing = null;
  const now = context.currentTime;
  const level = Math.max(gain.gain.value, 0.001);
  gain.gain.cancelScheduledValues(now);
  gain.gain.setValueCurveAtTime(fadeCurve(level, 0, 24), now, CROSSFADE);
  try {
    source.stop(now + CROSSFADE + 0.05);
  } catch {
    // Already stopped.
  }
}

export function playMusic(track: Track) {
  wantedTrack = track;
  if (!gesture) return;
  const context = ensureContext();
  if (!context || !musicBus) return;
  if (context.state === "suspended") void context.resume();
  const request = ++musicRequest;
  if (track === "none") {
    fadeOutPlaying(context);
    return;
  }
  if (playing && playing.track === track) return;
  void loadTrack(track).then((buffer) => {
    if (!buffer || request !== musicRequest || !musicBus) return;
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    const gain = context.createGain();
    source.connect(gain);
    gain.connect(musicBus);
    const now = context.currentTime + 0.02;
    fadeOutPlaying(context);
    gain.gain.setValueCurveAtTime(fadeCurve(0, 1, 24), now, CROSSFADE);
    source.start(now);
    playing = { track, source, gain };
    // Warm up the stingers once the music is going.
    void loadTrack("victory");
    void loadTrack("defeat");
  });
}

export function startMusic() {
  // startMusic is called from a pointer handler, so this counts as a gesture.
  gesture = true;
  playMusic("valley");
}

export function playStinger(name: Stinger) {
  if (!gesture) return;
  const context = ensureContext();
  if (!context || !stingerBus || !duckBus) return;
  void loadTrack(name).then((buffer) => {
    if (!buffer || muted || !stingerBus || !duckBus) return;
    if (context.state === "suspended") void context.resume();
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(stingerBus);
    const now = context.currentTime + 0.02;
    source.start(now);
    // Duck the music under the stinger, then let it swell back.
    const duck = duckBus.gain;
    const hold = Math.max(buffer.duration - 0.6, 0.2);
    duck.cancelScheduledValues(now);
    duck.setValueAtTime(duck.value, now);
    duck.linearRampToValueAtTime(0.22, now + 0.18);
    duck.setValueAtTime(0.22, now + hold);
    duck.linearRampToValueAtTime(1, now + hold + 1.1);
  });
}

export function setMuted(value: boolean) {
  muted = value;
  if (audio && master) {
    const now = audio.currentTime;
    master.gain.cancelScheduledValues(now);
    master.gain.setValueAtTime(master.gain.value, now);
    master.gain.linearRampToValueAtTime(value ? 0 : MASTER_LEVEL, now + 0.08);
  }
}

export function isMuted() {
  return muted;
}

armGesture();
