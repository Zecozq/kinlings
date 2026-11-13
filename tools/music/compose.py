#!/usr/bin/env python3
"""
compose.py -- the Kinlings soundtrack, written and produced entirely in code.

Every sound here comes out of this file: no samples, no soundfonts, nothing
downloaded, so the licensing is clean. It needs numpy, scipy and ffmpeg
(set KINLINGS_FFMPEG or pass --ffmpeg if ffmpeg is not on the PATH).

Usage:
    python compose.py                     render everything and write the audio
    python compose.py --only valley,race  render only those tracks
    python compose.py --check             print scores and musical checks only
    python compose.py --out DIR           write the audio into DIR
    python compose.py --work DIR          keep wav files and spectrograms in DIR

Layout of this file:
    1  DSP primitives (filters, oscillators, envelopes)
    2  instruments
    3  effects (reverb, chorus, compressor, limiter, loudness)
    4  score engine (notation, chords, voice leading, mixer)
    5  compositions (valley, race, victory, defeat, film)
    6  checks and export
"""
from __future__ import annotations

import argparse
import hashlib
import os
import re
import subprocess
import sys
import time

import numpy as np
from scipy import signal
from scipy.ndimage import minimum_filter1d, uniform_filter1d

SR = 48000
# numpy on Windows defaults to 32-bit ints, so time and position arrays are
# always built with this float type to keep large indices from overflowing.
FLOAT = np.float64

# ---------------------------------------------------------------------------
# 1. DSP primitives
# ---------------------------------------------------------------------------


def rng(*key):
    """A generator seeded only by `key`, so a render never depends on call order."""
    digest = hashlib.sha256(repr(key).encode()).digest()
    return np.random.Generator(np.random.PCG64(int.from_bytes(digest[:8], "little")))


def times(n):
    return np.arange(int(n), dtype=FLOAT) / SR


NOTE_BASE = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
NOTE_RE = re.compile(r"^([A-G])([#b]*)(-?\d+)$")


def midi(name):
    """'F#5' -> 78. Numbers pass straight through."""
    if isinstance(name, (int, float)):
        return name
    match = NOTE_RE.match(name)
    if not match:
        raise ValueError(f"bad note name {name!r}")
    letter, accidental, octave = match.groups()
    return NOTE_BASE[letter] + accidental.count("#") - accidental.count("b") + 12 * (int(octave) + 1)


def note_name(pitch):
    names = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "G#", "A", "Bb", "B"]
    pitch = int(round(pitch))
    return f"{names[pitch % 12]}{pitch // 12 - 1}"


def mtof(pitch):
    return 440.0 * 2.0 ** ((pitch - 69.0) / 12.0)


def db(value):
    return 10.0 ** (value / 20.0)


def biquad(kind, freq, q=0.707, gain_db=0.0):
    """RBJ cookbook biquad, returned as (b, a) with a[0] == 1."""
    w0 = 2.0 * np.pi * np.clip(freq, 5.0, 0.49 * SR) / SR
    cos_w, sin_w = np.cos(w0), np.sin(w0)
    alpha = sin_w / (2.0 * q)
    amp = 10.0 ** (gain_db / 40.0)
    if kind == "lp":
        b = [(1 - cos_w) / 2, 1 - cos_w, (1 - cos_w) / 2]
        a = [1 + alpha, -2 * cos_w, 1 - alpha]
    elif kind == "hp":
        b = [(1 + cos_w) / 2, -(1 + cos_w), (1 + cos_w) / 2]
        a = [1 + alpha, -2 * cos_w, 1 - alpha]
    elif kind == "bp":
        b = [alpha, 0.0, -alpha]
        a = [1 + alpha, -2 * cos_w, 1 - alpha]
    elif kind == "peak":
        b = [1 + alpha * amp, -2 * cos_w, 1 - alpha * amp]
        a = [1 + alpha / amp, -2 * cos_w, 1 - alpha / amp]
    elif kind == "ls":
        root = 2.0 * np.sqrt(amp) * alpha
        b = [amp * ((amp + 1) - (amp - 1) * cos_w + root), 2 * amp * ((amp - 1) - (amp + 1) * cos_w), amp * ((amp + 1) - (amp - 1) * cos_w - root)]
        a = [(amp + 1) + (amp - 1) * cos_w + root, -2 * ((amp - 1) + (amp + 1) * cos_w), (amp + 1) + (amp - 1) * cos_w - root]
    elif kind == "hs":
        root = 2.0 * np.sqrt(amp) * alpha
        b = [amp * ((amp + 1) + (amp - 1) * cos_w + root), -2 * amp * ((amp - 1) + (amp + 1) * cos_w), amp * ((amp + 1) + (amp - 1) * cos_w - root)]
        a = [(amp + 1) - (amp - 1) * cos_w + root, 2 * ((amp - 1) - (amp + 1) * cos_w), (amp + 1) - (amp - 1) * cos_w - root]
    else:
        raise ValueError(kind)
    b, a = np.asarray(b, dtype=FLOAT), np.asarray(a, dtype=FLOAT)
    return b / a[0], a / a[0]


def eq_chain(x, bands):
    """Run a list of (kind, freq, q, gain_db) biquads over x (mono or n*2)."""
    for kind, freq, q, gain in bands:
        b, a = biquad(kind, freq, q, gain)
        x = signal.lfilter(b, a, x, axis=0)
    return x


def tv_lowpass(x, cutoff, q=0.8, block=96):
    """Two-pole low-pass whose cutoff follows the per-sample array `cutoff`."""
    n = x.size
    centres = np.clip(cutoff[np.minimum(np.arange(block // 2, n + block, block, dtype=np.int64), n - 1)], 20.0, 0.45 * SR)
    w0 = 2.0 * np.pi * centres / SR
    cos_w, sin_w = np.cos(w0), np.sin(w0)
    alpha = sin_w / (2.0 * q)
    a0 = 1.0 + alpha
    b0 = (1.0 - cos_w) / 2.0 / a0
    b1 = (1.0 - cos_w) / a0
    a1 = -2.0 * cos_w / a0
    a2 = (1.0 - alpha) / a0
    out = np.empty(n, dtype=FLOAT)
    zi = np.zeros(2)
    for index, start in enumerate(range(0, n, block)):
        end = min(n, start + block)
        out[start:end], zi = signal.lfilter([b0[index], b1[index], b0[index]], [1.0, a1[index], a2[index]], x[start:end], zi=zi)
    return out


def saw_wave(freqs, phase0=0.0):
    """Band-limited sawtooth (polyBLEP) from a per-sample frequency array."""
    dt = np.clip(np.asarray(freqs, dtype=FLOAT) / SR, 1e-6, 0.49)
    phase = (phase0 + np.cumsum(dt)) % 1.0
    out = 2.0 * phase - 1.0
    low = phase < dt
    x = phase[low] / dt[low]
    out[low] -= x + x - x * x - 1.0
    high = phase > 1.0 - dt
    x = (phase[high] - 1.0) / dt[high]
    out[high] -= x * x + x + x + 1.0
    return out


def phase_of(freqs, phase0=0.0):
    return phase0 + np.cumsum(np.asarray(freqs, dtype=FLOAT) / SR)


def sine(freqs, phase0=0.0):
    return np.sin(2.0 * np.pi * phase_of(freqs, phase0))


def adsr(n, attack, decay, sustain, release, gate):
    """Envelope in seconds: fast sin^2 attack, exponential decay and release."""
    t = times(n)
    attack = max(attack, 1e-4)
    decay = max(decay, 1e-3)
    after = np.maximum(t - attack, 0.0)
    body = sustain + (1.0 - sustain) * np.exp(-after / decay * 4.0)
    env = np.where(t < attack, np.sin(np.clip(t / attack, 0.0, 1.0) * np.pi / 2.0) ** 2, body)
    release = max(release, 1e-3)
    return env * np.where(t > gate, np.exp(-np.maximum(t - gate, 0.0) / release * 5.0), 1.0)


def declick(x, seconds=0.003):
    """Force a smooth end, so a note never stops on a non-zero sample."""
    count = min(int(seconds * SR), x.shape[0])
    if count > 1:
        ramp = np.linspace(1.0, 0.0, count, dtype=FLOAT)
        if x.ndim == 2:
            ramp = ramp[:, None]
        x = x.copy()
        x[-count:] *= ramp
    return x


def vibrato(t, rate, depth, delay, phase=0.0):
    """Relative pitch deviation that fades in after `delay` seconds."""
    return depth * np.sin(2.0 * np.pi * rate * t + phase) * np.clip((t - delay) / 0.45, 0.0, 1.0)


def stereo(mono, pan=0.0):
    """Equal-power pan a mono signal. pan runs from -1 (left) to 1 (right)."""
    angle = (pan + 1.0) * np.pi / 4.0
    return np.stack([mono * np.cos(angle), mono * np.sin(angle)], axis=1)


# ---------------------------------------------------------------------------
# 2. Instruments
#
# Each instrument takes (pitch, seconds held, velocity 0-1, variant) and
# returns float32 audio, mono or (n, 2). Notes are cached by pitch, a duration
# bucket, a velocity bucket and a round-robin variant: repeated notes become
# cheap, and the variants stop repeated notes sounding machine-gunned.
# ---------------------------------------------------------------------------

_cache: dict = {}
_cache_bytes = [0]
CACHE_LIMIT = 1_800_000_000


def instrument(fn):
    def wrapped(pitch, dur=0.5, vel=0.8, var=0, **kw):
        dur_key = max(0.05, round(dur * 20.0) / 20.0)
        vel_key = round(np.clip(vel, 0.05, 1.0) * 12.0) / 12.0
        key = (fn.__name__, round(float(pitch), 3), dur_key, vel_key, var, tuple(sorted(kw.items())))
        hit = _cache.get(key)
        if hit is None:
            hit = declick(np.asarray(fn(float(pitch), dur_key, vel_key, var, **kw), dtype=np.float32))
            _cache_bytes[0] += hit.nbytes
            if _cache_bytes[0] > CACHE_LIMIT:
                _cache.clear()
                _cache_bytes[0] = hit.nbytes
            _cache[key] = hit
        return hit

    wrapped.__name__ = fn.__name__
    return wrapped


# --- winds -----------------------------------------------------------------


def _wind(pitch, dur, vel, var, harmonics, vib_rate, vib_depth, breath, chiff, attack, release=0.14):
    R = rng("wind", pitch, dur, vel, var, harmonics)
    n = int((dur + 2.5 * release) * SR)
    t = times(n)
    f0 = mtof(pitch)
    vib = vibrato(t, vib_rate + R.uniform(-0.25, 0.25), vib_depth, max(0.1, dur * 0.3), R.uniform(0.0, 6.28))
    freq = f0 * (1.0 + vib - 0.012 * np.exp(-t / 0.035))
    env = adsr(n, attack, 0.1, 0.92, release, dur)
    phase = 2.0 * np.pi * phase_of(freq, R.uniform())
    tone = np.zeros(n, dtype=FLOAT)
    for k, amp in enumerate(harmonics, start=1):
        if k * f0 < 0.45 * SR:
            # Blowing harder brings the overtones forward, as on a real flute.
            tone += amp * (1.0 if k == 1 else (0.55 + 0.55 * vel)) * np.sin(k * phase)
    tone *= env * (1.0 + 6.0 * vib)
    noise = R.standard_normal(n)
    centre = min(f0 * 2.6, 8000.0)
    air = signal.lfilter(*biquad("bp", centre, 1.1), noise) * env
    chiff_env = np.exp(-t / 0.018) * (1.0 - np.exp(-t / 0.002))
    burst = signal.lfilter(*biquad("bp", min(f0 * 4.5, 9500.0), 0.9), R.standard_normal(n)) * chiff_env
    return 0.75 * tone + breath * air + chiff * burst


@instrument
def flute(pitch, dur, vel, var):
    return _wind(pitch, dur, vel, var, (1.0, 0.4, 0.2, 0.11, 0.05, 0.03), 5.1, 0.0055, 0.1, 0.34, 0.05)


@instrument
def ocarina(pitch, dur, vel, var):
    return _wind(pitch, dur, vel, var, (1.0, 0.13, 0.06, 0.02), 4.7, 0.0035, 0.15, 0.2, 0.03, 0.1)


@instrument
def piccolo(pitch, dur, vel, var):
    return _wind(pitch, dur, vel, var, (1.0, 0.22, 0.07, 0.03), 5.6, 0.0045, 0.08, 0.3, 0.025, 0.08)


@instrument
def reed(pitch, dur, vel, var, kind="clarinet"):
    amps = {
        "clarinet": (1.0, 0.08, 0.55, 0.05, 0.32, 0.04, 0.18, 0.03, 0.1),
        "bassoon": (0.7, 1.0, 0.72, 0.52, 0.36, 0.26, 0.18, 0.12, 0.08, 0.05),
        "accordion": (1.0, 0.72, 0.55, 0.44, 0.34, 0.27, 0.2, 0.15, 0.1, 0.08),
    }[kind]
    attack = {"clarinet": 0.025, "bassoon": 0.03, "accordion": 0.02}[kind]
    voice = _wind(pitch, dur, vel, var, amps, 5.3, 0.004 if kind != "accordion" else 0.0, 0.05, 0.12, attack, 0.08)
    if kind == "accordion":
        # Two reeds tuned a few cents apart give the musette beat.
        other = _wind(pitch + 0.09, dur, vel, var + 40, amps, 5.3, 0.0, 0.04, 0.1, attack, 0.08)
        size = min(voice.size, other.size)
        voice = 0.65 * (voice[:size] + other[:size])
    if kind == "bassoon":
        voice = eq_chain(voice, [("peak", 520.0, 1.2, 5.0), ("peak", 1250.0, 1.5, 3.0), ("lp", 3800.0, 0.7, 0.0)])
    return voice


# --- bowed strings and brass -----------------------------------------------


@instrument
def strings(pitch, dur, vel, var, atk=0.14, rel=0.28, voices=6, detune=7.0, bright=1.0, trem=0.0):
    """A section: detuned saw stack, a filter that opens with the bow, a swell.
    trem > 0 adds a measured bowed tremolo at about 11 strokes a second."""
    R = rng("str", pitch, dur, vel, var, atk, voices)
    f0 = mtof(pitch)
    n = int((dur + 1.3 * rel) * SR)
    t = times(n)
    left = np.zeros(n, dtype=FLOAT)
    right = np.zeros(n, dtype=FLOAT)
    for i in range(voices):
        cents = detune * (2.0 * i / (voices - 1) - 1.0) + R.normal(0.0, 1.6)
        vib = vibrato(t, R.uniform(4.7, 6.1), R.uniform(0.0016, 0.0034), 0.25, R.uniform(0.0, 6.28))
        wave = saw_wave(f0 * 2.0 ** (cents / 1200.0) * (1.0 + vib), R.uniform())
        place = (2.0 * i / (voices - 1) - 1.0) * 0.72
        left += wave * np.cos((place + 1.0) * np.pi / 4.0)
        right += wave * np.sin((place + 1.0) * np.pi / 4.0)
    opening = 1.0 - np.exp(-t / max(0.04, atk))
    cutoff = 1.5 * f0 + (800.0 + 3800.0 * vel) * bright * (0.35 + 0.65 * opening)
    left = tv_lowpass(left, cutoff, 0.75)
    right = tv_lowpass(right, cutoff, 0.75)
    env = adsr(n, atk, 0.2, 0.9, rel, dur)
    if trem > 0.0:
        env = env * (1.0 - trem * (0.5 + 0.5 * np.sin(2.0 * np.pi * 11.0 * t)))
    out = np.stack([left * env, right * env], axis=1) / (voices ** 0.5) * 0.9
    return eq_chain(out, [("hp", 80.0, 0.7, 0.0), ("peak", 950.0, 0.8, 2.0), ("peak", 3300.0, 1.0, 2.5), ("hs", 9000.0, 0.7, -4.0)])


@instrument
def brass(pitch, dur, vel, var, voices=4, detune=5.0, bright=1.0, slide=0.0, wah=0.0):
    """Horn or trumpet: the filter blats open, the pitch scoops up, it saturates.
    slide bends the note by that many semitones; wah opens and shuts a mute."""
    R = rng("brass", pitch, dur, vel, var, voices, bright)
    f0 = mtof(pitch)
    release = 0.11
    n = int((dur + 2.0 * release) * SR)
    t = times(n)
    scoop = -0.018 * np.exp(-t / 0.028) * (1.2 - 0.5 * vel)
    if slide:
        scoop = scoop + (2.0 ** (slide * np.clip(t / dur, 0.0, 1.0) / 12.0) - 1.0)
    mono = np.zeros(n, dtype=FLOAT)
    for i in range(voices):
        cents = detune * (2.0 * i / max(1, voices - 1) - 1.0) + R.normal(0.0, 1.2)
        vib = vibrato(t, R.uniform(4.9, 5.7), R.uniform(0.0015, 0.0035), 0.3, R.uniform(0.0, 6.28))
        mono += saw_wave(f0 * 2.0 ** (cents / 1200.0) * (1.0 + vib + scoop), R.uniform())
    mono /= voices ** 0.5
    swell = (1.0 - np.exp(-t / 0.02)) * (0.55 + 0.45 * np.exp(-t / 0.26))
    cutoff = f0 * (0.9 + 1.5 * vel) + (500.0 + 4600.0 * vel) * bright * swell
    if wah:
        cutoff = cutoff * (1.0 - wah * (0.5 + 0.5 * np.cos(2.0 * np.pi * 5.0 * t)))
    mono = tv_lowpass(mono, cutoff, 1.1)
    mono = np.tanh(mono * (1.2 + 1.3 * vel)) * 0.8
    env = adsr(n, 0.012 + 0.05 * (1.0 - vel), 0.28, 0.82, release, dur)
    breath = signal.lfilter(*biquad("bp", min(f0 * 3.0, 6000.0), 1.0), R.standard_normal(n)) * np.exp(-t / 0.05)
    out = (mono + 0.08 * vel * breath) * env
    return eq_chain(out, [("hp", 90.0, 0.7, 0.0), ("peak", 1250.0, 0.9, 2.5), ("hs", 7000.0, 0.7, -3.0)])


# --- plucked strings (Karplus-Strong) --------------------------------------


def _karplus(f0, n, t60, damp, pick, softness, vel, R):
    """Plucked-string delay loop run in vectorised blocks one period long."""
    period = SR / f0
    delay = max(2, int(period - damp))
    stretch = (delay + damp) / period
    length = int(n / stretch) + 4
    gain = 10.0 ** (-3.0 * (delay + damp) / (SR * t60))
    # Excitation: the triangular shape of a string pulled aside at the pluck
    # point, which makes the tone fundamental-heavy like a real string, plus
    # a little noise for the sound of the fingertip.
    pluck = np.arange(delay, dtype=FLOAT) / delay
    peak = max(pick, 1.0 / delay)
    shape = np.where(pluck < peak, pluck / peak, (1.0 - pluck) / (1.0 - peak))
    burst = shape - shape.mean() + 0.1 * R.standard_normal(delay)
    pole = np.exp(-2.0 * np.pi * min(f0 * softness * (1.0 + 2.0 * vel), 0.4 * SR) / SR)
    burst = signal.lfilter([1.0 - pole], [1.0, -pole], burst)
    burst -= burst.mean()
    # y[i] = x[i] + gain * ((1-damp) * y[i-delay] + damp * y[i-delay-1])
    y = np.zeros(length + 1, dtype=FLOAT)
    y[1 : delay + 1] = burst
    pos = delay + 1
    while pos < length + 1:
        stop = min(pos + delay, length + 1)
        y[pos:stop] = gain * ((1.0 - damp) * y[pos - delay : stop - delay] + damp * y[pos - delay - 1 : stop - delay - 1])
        pos = stop
    y = y[1:]
    # Resample by the tiny factor that puts the note exactly in tune.
    out = np.interp(np.arange(n, dtype=FLOAT) * stretch, np.arange(length, dtype=FLOAT), y)
    return out / (np.max(np.abs(out)) + 1e-9)


@instrument
def harp(pitch, dur, vel, var):
    R = rng("harp", pitch, dur, vel, var)
    f0 = mtof(pitch)
    t60 = np.interp(pitch, [36.0, 60.0, 84.0, 100.0], [3.6, 2.8, 1.5, 0.8])
    n = int(min(t60 * 1.15, dur + 2.4) * SR)
    y = _karplus(f0, n, t60, 0.16, 0.26, 4.5, vel, R) * (0.35 + 0.65 * vel)
    return y * adsr(n, 0.002, 0.1, 1.0, 0.5, dur + 1.6)


@instrument
def lute(pitch, dur, vel, var):
    R = rng("lute", pitch, dur, vel, var)
    f0 = mtof(pitch)
    t60 = np.interp(pitch, [40.0, 64.0, 84.0], [2.1, 1.6, 0.9])
    n = int(min(t60 * 0.95, dur + 0.9) * SR)
    y = _karplus(f0, n, t60, 0.33, 0.14, 8.0, vel, R) * (0.3 + 0.7 * vel)
    return y * adsr(n, 0.001, 0.06, 1.0, 0.25, dur + 0.5)


@instrument
def pizz(pitch, dur, vel, var):
    R = rng("pizz", pitch, dur, vel, var)
    f0 = mtof(pitch)
    t60 = np.interp(pitch, [36.0, 60.0, 84.0], [0.9, 0.55, 0.3])
    n = int(max(0.25, t60 * 1.1) * SR)
    y = _karplus(f0, n, t60, 0.42, 0.22, 5.0, vel, R) * (0.3 + 0.7 * vel)
    return eq_chain(y, [("peak", 280.0, 1.0, 3.0), ("hs", 5000.0, 0.7, -4.0)])


# --- tuned percussion ------------------------------------------------------


def _modal(n, f0, ratios, amps, decays, R):
    t = times(n)
    out = np.zeros(n, dtype=FLOAT)
    for ratio, amp, decay in zip(ratios, amps, decays):
        freq = f0 * ratio
        if freq < 0.45 * SR:
            out += amp * np.exp(-t / decay) * np.sin(2.0 * np.pi * freq * t + R.uniform(0.0, 6.28))
    return out


@instrument
def glock(pitch, dur, vel, var):
    R = rng("glock", pitch, vel, var)
    f0 = mtof(pitch)
    n = int(1.7 * SR)
    y = _modal(n, f0, [1.0, 2.76, 5.4, 8.93, 13.34], [1.0, 0.42, 0.2, 0.08, 0.03], [0.85, 0.32, 0.14, 0.07, 0.04], R)
    t = times(n)
    strike = eq_chain(R.standard_normal(n), [("bp", 7000.0, 1.2, 0.0)]) * np.exp(-t / 0.004)
    return (y + 0.18 * vel * strike) * (0.4 + 0.6 * vel) * adsr(n, 0.001, 0.1, 1.0, 0.4, 1.3)


@instrument
def celesta(pitch, dur, vel, var):
    """FM over a bar's natural modes gives the bell-through-a-felt-hammer tone."""
    R = rng("celesta", pitch, vel, var)
    f0 = mtof(pitch)
    n = int(1.6 * SR)
    t = times(n)
    index = (1.2 + 1.8 * vel) * np.exp(-t / 0.09)
    fm = np.sin(2.0 * np.pi * f0 * t + index * np.sin(2.0 * np.pi * f0 * 3.5 * t + R.uniform(0.0, 6.28)))
    modes = _modal(n, f0, [1.0, 2.0, 4.0], [0.5, 0.26, 0.12], [0.9, 0.45, 0.22], R)
    body = 0.7 * fm * np.exp(-t / 0.9) + modes
    return body * (0.45 + 0.55 * vel) * adsr(n, 0.002, 0.1, 1.0, 0.4, 1.2)


@instrument
def bell(pitch, dur, vel, var):
    R = rng("bell", pitch, vel, var)
    f0 = mtof(pitch)
    n = int(3.4 * SR)
    ratios = [0.5, 1.0, 1.183, 1.502, 2.0, 2.51, 2.99, 4.05, 5.2]
    amps = [0.35, 1.0, 0.5, 0.62, 0.46, 0.2, 0.26, 0.12, 0.07]
    decays = [2.2, 1.6, 1.1, 1.0, 0.9, 0.5, 0.42, 0.25, 0.14]
    return _modal(n, f0, ratios, amps, decays, R) * (0.4 + 0.6 * vel)


@instrument
def marimba(pitch, dur, vel, var):
    R = rng("marimba", pitch, vel, var)
    f0 = mtof(pitch)
    n = int(1.2 * SR)
    t = times(n)
    decay = float(np.interp(pitch, [48.0, 72.0, 96.0], [0.55, 0.32, 0.18]))
    y = _modal(n, f0, [1.0, 3.93, 9.2], [1.0, 0.3 + 0.2 * vel, 0.08], [decay, decay * 0.38, decay * 0.14], R)
    click = signal.lfilter(*biquad("lp", 2200.0, 0.7), R.standard_normal(n)) * np.exp(-t / 0.004)
    return (y + 0.25 * vel * click) * (0.45 + 0.55 * vel) * adsr(n, 0.001, 0.08, 1.0, 0.2, 1.0)


# --- basses, voices and pads -----------------------------------------------


@instrument
def bass(pitch, dur, vel, var):
    """Warm round bass: sine body, a little octave and twelfth on the attack."""
    R = rng("bass", pitch, vel, var)
    f0 = mtof(pitch)
    n = int((dur + 0.2) * SR)
    t = times(n)
    env = adsr(n, 0.006, 0.32, 0.64, 0.12, dur)
    w = 2.0 * np.pi * f0 * t
    y = np.sin(w) + 0.42 * np.exp(-t / 0.5) * np.sin(2.0 * w + R.uniform(0.0, 3.0)) + 0.2 * np.exp(-t / 0.18) * np.sin(3.0 * w + R.uniform(0.0, 3.0))
    return np.tanh(1.4 * y) * env * (0.5 + 0.5 * vel)


@instrument
def drive_bass(pitch, dur, vel, var):
    """Picked, slightly gritty bass for the race: saw plus sub, snappy filter."""
    R = rng("dbass", pitch, vel, var)
    f0 = mtof(pitch)
    n = int((dur + 0.08) * SR)
    t = times(n)
    saw = saw_wave(np.full(n, f0 * 1.003), R.uniform()) + saw_wave(np.full(n, f0 * 0.997), R.uniform())
    cutoff = f0 * 1.4 + (400.0 + 2600.0 * vel) * np.exp(-t / 0.075)
    y = tv_lowpass(saw * 0.5, cutoff, 1.0) + 0.9 * np.sin(2.0 * np.pi * f0 * t)
    return np.tanh(y * 1.5) * adsr(n, 0.003, 0.2, 0.75, 0.05, dur) * 0.8


@instrument
def lead(pitch, dur, vel, var):
    """Heroic double for the brass hook: two saws and a square, gently filtered."""
    R = rng("lead", pitch, vel, var)
    f0 = mtof(pitch)
    n = int((dur + 0.2) * SR)
    t = times(n)
    vib = vibrato(t, 5.8, 0.004, 0.22, R.uniform(0.0, 6.28))
    freq = f0 * (1.0 + vib)
    y = saw_wave(freq * 1.004, R.uniform()) + saw_wave(freq * 0.996, R.uniform())
    y += 0.7 * np.sign(np.sin(2.0 * np.pi * phase_of(freq, R.uniform())))
    cutoff = f0 * 2.2 + (1400.0 + 4200.0 * vel) * (0.45 + 0.55 * np.exp(-t / 0.16))
    y = tv_lowpass(y * 0.34, cutoff, 0.9)
    return y * adsr(n, 0.008, 0.2, 0.85, 0.09, dur)


FORMANTS = {
    "ah": [(790.0, 1.0), (1150.0, 0.5), (2850.0, 0.22), (3500.0, 0.1)],
    "oo": [(340.0, 1.0), (800.0, 0.2), (2300.0, 0.05)],
    "ee": [(330.0, 1.0), (2300.0, 0.5), (3100.0, 0.25)],
}


@instrument
def choir(pitch, dur, vel, var, vowel="ah"):
    """Saw stack through vowel formants, with slow vibrato and a long swell."""
    R = rng("choir", pitch, dur, vel, var, vowel)
    f0 = mtof(pitch)
    n = int((dur + 0.5) * SR)
    t = times(n)
    out = []
    for side in range(2):
        mix = np.zeros(n, dtype=FLOAT)
        for voice in range(4):
            cents = R.normal(0.0, 7.0)
            vib = vibrato(t, R.uniform(4.2, 5.4), R.uniform(0.0025, 0.0045), 0.35, R.uniform(0.0, 6.28))
            mix += saw_wave(f0 * 2.0 ** (cents / 1200.0) * (1.0 + vib), R.uniform())
        shaped = sum(amp * signal.lfilter(*biquad("bp", freq, 7.0), mix) for freq, amp in FORMANTS[vowel])
        out.append(shaped * adsr(n, 0.42, 0.3, 0.92, 0.42, dur))
    return np.stack(out, axis=1) * (0.6 + 0.5 * vel) * 0.85


@instrument
def glass(pitch, dur, vel, var):
    """Slow-breathing additive pad for the moments of wonder."""
    R = rng("glass", pitch, dur, vel, var)
    f0 = mtof(pitch)
    n = int((dur + 0.7) * SR)
    t = times(n)
    out = []
    for side in range(2):
        drift = 1.0 + 0.0012 * np.sin(2.0 * np.pi * R.uniform(0.2, 0.5) * t + R.uniform(0.0, 6.28))
        phase = 2.0 * np.pi * phase_of(f0 * drift, R.uniform())
        wave = np.sin(phase) + 0.42 * np.sin(2.0 * phase) + 0.18 * np.sin(3.0 * phase) + 0.08 * np.sin(5.0 * phase)
        out.append(wave * adsr(n, 0.9, 0.5, 0.88, 0.6, dur))
    return np.stack(out, axis=1) * (0.4 + 0.45 * vel)


# --- orchestral and kit percussion -----------------------------------------


@instrument
def timpani(pitch, dur, vel, var):
    R = rng("timp", pitch, vel, var)
    f0 = mtof(pitch)
    n = int(2.6 * SR)
    t = times(n)
    bend = 1.0 + 0.015 * np.exp(-t / 0.08)
    freqs = [1.0, 1.504, 1.742, 2.0, 2.245, 2.494, 2.8]
    amps = [1.0, 0.55, 0.3, 0.33, 0.17, 0.13, 0.08]
    decays = [0.9, 0.62, 0.46, 0.36, 0.28, 0.22, 0.16]
    y = np.zeros(n, dtype=FLOAT)
    for ratio, amp, decay in zip(freqs, amps, decays):
        y += amp * np.exp(-t / decay) * np.sin(2.0 * np.pi * phase_of(f0 * ratio * bend, R.uniform()))
    stick = signal.lfilter(*biquad("lp", 1600.0, 0.7), R.standard_normal(n)) * np.exp(-t / 0.012)
    return (y + 0.45 * vel * stick) * (0.35 + 0.65 * vel)


@instrument
def taiko(pitch, dur, vel, var):
    """Huge drum: the head drops in pitch, the skin slaps, the shell rings."""
    R = rng("taiko", pitch, vel, var)
    f0 = mtof(pitch)
    n = int(1.3 * SR)
    t = times(n)
    freq = f0 * (1.0 + 1.4 * np.exp(-t / 0.018) + 0.25 * np.exp(-t / 0.11))
    body = np.sin(2.0 * np.pi * phase_of(freq, R.uniform())) * np.exp(-t / 0.3)
    body += 0.4 * np.sin(2.0 * np.pi * phase_of(freq * 1.51, R.uniform())) * np.exp(-t / 0.13)
    slap = eq_chain(R.standard_normal(n), [("bp", 2400.0, 0.7, 0.0)]) * np.exp(-t / 0.018)
    return np.tanh((body + 0.5 * vel * slap) * 1.6) * (0.4 + 0.6 * vel)


@instrument
def kick(pitch, dur, vel, var):
    R = rng("kick", pitch, vel, var)
    n = int(0.55 * SR)
    t = times(n)
    freq = 52.0 + 122.0 * np.exp(-t / 0.022) + 22.0 * np.exp(-t / 0.09)
    body = np.sin(2.0 * np.pi * phase_of(freq, R.uniform())) * np.exp(-t / 0.18)
    click = eq_chain(R.standard_normal(n), [("bp", 3500.0, 0.9, 0.0)]) * np.exp(-t / 0.005)
    return np.tanh(1.7 * body + 0.32 * vel * click) * (0.4 + 0.6 * vel)


@instrument
def snare(pitch, dur, vel, var):
    R = rng("snare", pitch, vel, var)
    n = int(0.42 * SR)
    t = times(n)
    tone = np.sin(2.0 * np.pi * phase_of(208.0 + 90.0 * np.exp(-t / 0.02), R.uniform()))
    tone += 0.55 * np.sin(2.0 * np.pi * phase_of(332.0 + 60.0 * np.exp(-t / 0.018), R.uniform()))
    wires = eq_chain(R.standard_normal(n), [("bp", 4200.0, 0.55, 0.0), ("peak", 1200.0, 0.8, 3.0)])
    return (0.5 * tone * np.exp(-t / 0.07) + 0.85 * wires * np.exp(-t / (0.1 + 0.05 * vel))) * (0.35 + 0.65 * vel)


@instrument
def tom(pitch, dur, vel, var):
    R = rng("tom", pitch, vel, var)
    f0 = mtof(pitch)
    n = int(0.75 * SR)
    t = times(n)
    freq = f0 * (1.0 + 0.55 * np.exp(-t / 0.03))
    body = np.sin(2.0 * np.pi * phase_of(freq, R.uniform())) * np.exp(-t / 0.22)
    hit = eq_chain(R.standard_normal(n), [("bp", 1400.0, 0.8, 0.0)]) * np.exp(-t / 0.018)
    return np.tanh(1.4 * body + 0.3 * vel * hit) * (0.4 + 0.6 * vel)


@instrument
def hat(pitch, dur, vel, var, openness=0.0):
    """Six inharmonic squares, the old drum-machine recipe for cymbal metal."""
    R = rng("hat", vel, var, openness)
    n = int((0.08 + 0.34 * openness) * SR) + int(0.02 * SR)
    t = times(n)
    y = np.zeros(n, dtype=FLOAT)
    for freq in (205.3, 304.4, 369.6, 522.7, 540.0, 800.0):
        y += np.sign(np.sin(2.0 * np.pi * freq * 1.3 * t + R.uniform(0.0, 6.28)))
    y = eq_chain(y + 0.8 * R.standard_normal(n), [("hp", 7200.0, 0.8, 0.0)])
    return y * np.exp(-t / (0.018 + 0.11 * openness)) * (0.35 + 0.65 * vel) * 0.32


@instrument
def crash(pitch, dur, vel, var):
    R = rng("crash", vel, var)
    n = int(3.2 * SR)
    t = times(n)
    out = []
    for side in range(2):
        noise = R.standard_normal(n)
        partials = sum(np.sin(2.0 * np.pi * R.uniform(3000.0, 14000.0) * t + R.uniform(0.0, 6.28)) for _ in range(24)) / 5.0
        body = eq_chain(noise + partials, [("hp", 3200.0, 0.7, 0.0), ("peak", 7500.0, 0.7, 3.0)])
        env = 0.14 * np.exp(-t / 0.014) + np.exp(-t / 0.5) * 0.9 + 0.22 * np.exp(-t / 1.1)
        out.append(body * env)
    return np.stack(out, axis=1) * (0.3 + 0.7 * vel) * 0.3


@instrument
def shaker(pitch, dur, vel, var):
    R = rng("shaker", vel, var)
    n = int(0.11 * SR)
    t = times(n)
    env = (1.0 - np.exp(-t / 0.008)) * np.exp(-t / 0.03)
    return eq_chain(R.standard_normal(n), [("bp", 6200.0, 0.7, 0.0)]) * env * (0.35 + 0.65 * vel) * 0.55


@instrument
def tambourine(pitch, dur, vel, var):
    R = rng("tamb", vel, var)
    n = int(0.3 * SR)
    t = times(n)
    env = np.exp(-t / 0.012) + 0.6 * np.exp(-np.maximum(t - 0.02, 0.0) / 0.05) * (t > 0.02)
    jingles = eq_chain(R.standard_normal(n), [("bp", 9000.0, 1.1, 0.0)])
    bright = sum(np.sin(2.0 * np.pi * freq * t) for freq in (7600.0, 9400.0, 11300.0)) * np.exp(-t / 0.04) / 3.0
    return (jingles * 0.8 + bright * 0.5) * env * (0.35 + 0.65 * vel) * 0.55


@instrument
def triangle(pitch, dur, vel, var):
    R = rng("tri", vel, var)
    f0 = mtof(pitch)
    n = int(1.4 * SR)
    return _modal(n, f0, [1.0, 2.76, 5.4, 7.7], [1.0, 0.4, 0.28, 0.12], [0.9, 0.62, 0.3, 0.16], R) * (0.35 + 0.65 * vel) * 0.45


@instrument
def woodblock(pitch, dur, vel, var):
    R = rng("wood", pitch, vel, var)
    f0 = mtof(pitch)
    n = int(0.16 * SR)
    t = times(n)
    return _modal(n, f0, [1.0, 1.52, 2.76], [1.0, 0.6, 0.18], [0.05, 0.035, 0.015], R) * (0.5 + 0.5 * vel) * (1.0 - np.exp(-t / 0.0005))


# --- gestures for transitions ----------------------------------------------


@instrument
def cymbal_swell(pitch, dur, vel, var):
    """A cymbal played backwards, rising to a stop exactly `dur` seconds later."""
    R = rng("swell", dur, vel, var)
    n = int(dur * SR)
    t = times(n)
    progress = t / dur
    out = []
    for side in range(2):
        body = eq_chain(R.standard_normal(n), [("hp", 2600.0, 0.7, 0.0), ("peak", 8000.0, 0.7, 4.0)])
        out.append(body * progress ** 2.6 * (0.2 + 0.8 * progress))
    x = np.stack(out, axis=1) * (0.35 + 0.65 * vel) * 0.42
    return x * adsr(n, 0.05, 0.1, 1.0, 0.02, dur)[:, None]


@instrument
def riser(pitch, dur, vel, var):
    """Noise sweeping up behind a rising whistle tone, for the race build."""
    R = rng("riser", dur, vel, var)
    n = int(dur * SR)
    t = times(n)
    progress = t / dur
    cutoff = 250.0 * (45.0 ** progress)
    out = []
    for side in range(2):
        noise = tv_lowpass(R.standard_normal(n), cutoff, 2.2)
        tone = sine(180.0 * (5.0 ** progress) * (1.0 + 0.004 * np.sin(2.0 * np.pi * 7.0 * t)), R.uniform())
        out.append((0.55 * noise + 0.25 * tone) * progress ** 1.8)
    return np.stack(out, axis=1) * (0.4 + 0.6 * vel) * adsr(n, 0.2, 0.1, 1.0, 0.02, dur)[:, None]


@instrument
def boom(pitch, dur, vel, var):
    """Sub impact under a big downbeat."""
    R = rng("boom", vel, var)
    n = int(1.6 * SR)
    t = times(n)
    freq = 34.0 + 62.0 * np.exp(-t / 0.05)
    body = np.sin(2.0 * np.pi * phase_of(freq, R.uniform())) * np.exp(-t / 0.55)
    thump = signal.lfilter(*biquad("lp", 400.0, 0.7), R.standard_normal(n)) * np.exp(-t / 0.05)
    return np.tanh(1.6 * body + 0.5 * thump) * (0.4 + 0.6 * vel)


# ---------------------------------------------------------------------------
# 3. Effects
#
# Anything with memory takes `loop=True` for tracks that wrap: a filter or
# compressor settles on a copy of the end of the track first, and reverb is a
# true circular convolution, so the tail of bar 64 lands in the top of bar 1.
# ---------------------------------------------------------------------------


def make_ir(seconds=2.4, predelay=0.02, tone=1.0, name="hall"):
    """Generated stereo impulse response: early taps, then a damped noise tail."""
    R = rng("ir", name, seconds, predelay, tone)
    n = int(seconds * SR)
    t = times(n)
    out = []
    for side in range(2):
        noise = R.standard_normal(n)
        low = signal.lfilter(*biquad("lp", 320.0), noise)
        high = signal.lfilter(*biquad("hp", 3200.0), noise)
        mid = noise - low - high
        tail = (low * np.exp(-6.9 * t / (seconds * 0.95))
                + mid * np.exp(-6.9 * t / (seconds * 0.78))
                + tone * high * np.exp(-6.9 * t / (seconds * 0.42)))
        early = np.zeros(n, dtype=FLOAT)
        for _ in range(14):
            when = R.uniform(0.004, 0.09)
            early[int(when * SR)] += R.choice([-1.0, 1.0]) * np.exp(-when / 0.05)
        wet = tail * np.minimum(t / 0.006, 1.0)
        ir = np.zeros(n, dtype=FLOAT)
        shift = int(predelay * SR)
        ir[shift:] = wet[: n - shift]
        ir += early * np.sqrt(np.sum(wet ** 2)) * 0.33
        out.append(ir / np.sqrt(np.sum(ir ** 2)))
    return np.stack(out, axis=1)


def convolve(x, ir, loop=False):
    """FFT convolution of stereo x with stereo ir. Circular when loop is True."""
    n = x.shape[0]
    size = n if loop else n + ir.shape[0] - 1
    out = np.zeros((size, 2), dtype=FLOAT)
    for side in range(2):
        out[:, side] = np.fft.irfft(np.fft.rfft(x[:, side], size) * np.fft.rfft(ir[:, side], size), size)
    return out[:n]


def apply_loop(fn, x, loop, seconds=1.0):
    """Run an IIR-style fn so that its state is correct at the loop wrap."""
    if not loop:
        return fn(x)
    pre = min(int(seconds * SR), x.shape[0])
    return fn(np.concatenate([x[-pre:], x]))[pre:]


def eq_loop(x, bands, loop=False):
    return apply_loop(lambda data: eq_chain(data, bands), x, loop)


def chorus(x, rate=0.7, depth_ms=2.4, base_ms=11.0, mix=0.5, loop=False):
    """Slow modulated delay, opposite on each side, to thicken and widen."""
    n = x.shape[0]
    t = times(n)
    if loop:
        rate = round(rate * n / SR) * SR / n
    wet = np.zeros_like(x)
    span = np.arange(n, dtype=FLOAT)
    pad = int((base_ms + depth_ms) * 0.002 * SR) + 3
    for side in range(2):
        lfo = np.sin(2.0 * np.pi * rate * t + (0.0 if side == 0 else np.pi * 0.7))
        delay = (base_ms + depth_ms * lfo) * 0.001 * SR
        source = np.concatenate([x[-pad:, side], x[:, side], x[:pad, side]]) if loop else np.concatenate([np.zeros(pad), x[:, side], np.zeros(pad)])
        wet[:, side] = np.interp(span - delay + pad, np.arange(source.size, dtype=FLOAT), source)
    return (1.0 - mix * 0.5) * x + mix * wet


def widen(x, width=1.3):
    """Mid/side width control. Above 1 widens, below 1 narrows."""
    mid = 0.5 * (x[:, 0] + x[:, 1])
    side = 0.5 * (x[:, 0] - x[:, 1]) * width
    return np.stack([mid + side, mid - side], axis=1)


def compress(x, threshold=-18.0, ratio=2.5, attack=0.012, release=0.14, knee=6.0, loop=False):
    """Feed-forward stereo-linked compressor on a 2 ms control grid."""
    n = x.shape[0]
    block = int(0.002 * SR)
    level = np.maximum(np.abs(x[:, 0]), np.abs(x[:, 1]))
    edges = np.arange(0, n, block, dtype=np.int64)
    peaks = np.maximum.reduceat(level, edges)
    a_coef = np.exp(-0.002 / attack)
    r_coef = np.exp(-0.002 / release)
    env = np.empty(peaks.size, dtype=FLOAT)
    state = 0.0
    for sweep in range(2 if loop else 1):
        for i, value in enumerate(peaks):
            coef = a_coef if value > state else r_coef
            state = coef * state + (1.0 - coef) * value
            env[i] = state
    over = 20.0 * np.log10(np.maximum(env, 1e-6)) - threshold
    reduction = np.zeros_like(over)
    soft = (over > -knee / 2.0) & (over < knee / 2.0)
    reduction[soft] = (1.0 / ratio - 1.0) * (over[soft] + knee / 2.0) ** 2 / (2.0 * knee)
    hard = over >= knee / 2.0
    reduction[hard] = (1.0 / ratio - 1.0) * over[hard]
    centres = edges.astype(FLOAT) + block / 2.0
    gain = np.interp(np.arange(n, dtype=FLOAT), centres, 10.0 ** (reduction / 20.0))
    return x * gain[:, None]


def true_peak(x):
    """Linear inter-sample peak estimate using 4x oversampling."""
    chunk = signal.resample_poly(x, 4, 1, axis=0)
    return float(np.max(np.abs(chunk)))


def limit(x, ceiling_db=-1.2, window=0.02, loop=False):
    """Look-ahead limiter. Gain dips are a minimum then a moving average of the
    same length, which guarantees no sample gets past the ceiling."""
    ceiling = db(ceiling_db)
    pre = min(int(0.2 * SR), x.shape[0])
    extended = np.concatenate([x[-pre:], x, x[:pre]]) if loop else x
    span = int(window * SR) | 1
    oversampled = np.max(np.abs(signal.resample_poly(extended, 4, 1, axis=0)), axis=1)
    level = np.maximum.reduceat(oversampled, np.arange(0, oversampled.size, 4, dtype=np.int64))
    size = min(level.size, extended.shape[0])
    wanted = np.minimum(1.0, ceiling / np.maximum(level[:size], 1e-9))
    gain = uniform_filter1d(minimum_filter1d(wanted, span, mode="nearest"), span, mode="nearest")
    if size < extended.shape[0]:
        gain = np.concatenate([gain, np.full(extended.shape[0] - size, gain[-1])])
    out = extended * gain[:, None]
    return out[pre:-pre] if loop else out


_K_PRE = (np.array([1.53512485958697, -2.69169618940638, 1.19839281085285]), np.array([1.0, -1.69065929318241, 0.73248077421585]))
_K_RLB = (np.array([1.0, -2.0, 1.0]), np.array([1.0, -1.99004745483398, 0.99007225036621]))


def lufs(x):
    """Integrated loudness per ITU BS.1770 with both gates (48 kHz filters)."""
    weighted = signal.lfilter(*_K_RLB, signal.lfilter(*_K_PRE, x, axis=0), axis=0)
    size, hop = int(0.4 * SR), int(0.1 * SR)
    power = np.sum(weighted ** 2, axis=1)
    cum = np.concatenate([[0.0], np.cumsum(power, dtype=FLOAT)])
    starts = np.arange(0, power.size - size, hop, dtype=np.int64)
    if starts.size == 0:
        return -70.0
    energy = (cum[starts + size] - cum[starts]) / size
    loudness = -0.691 + 10.0 * np.log10(np.maximum(energy, 1e-12))
    gated = energy[loudness > -70.0]
    if gated.size == 0:
        return -70.0
    threshold = -0.691 + 10.0 * np.log10(np.mean(gated)) - 10.0
    final = energy[loudness > threshold]
    return float(-0.691 + 10.0 * np.log10(np.mean(final)))


def master(x, target=-15.0, ceiling_db=-1.2, loop=False, tries=4, tilt=0.0):
    """Bus compression, optional tilt EQ, then make-up gain and limiting until
    loudness is on target."""
    if tilt:
        x = eq_loop(x, [("hs", 6000.0, 0.7, tilt), ("ls", 180.0, 0.7, -0.3 * tilt)], loop)
    x = compress(x, threshold=-17.0, ratio=1.8, attack=0.03, release=0.3, knee=8.0, loop=loop)
    x = np.tanh(x * 0.9) / 0.9  # the faintest glue
    gain = 1.0
    out = x
    for _ in range(tries):
        out = limit(x * gain, ceiling_db, loop=loop)
        off = target - lufs(out)
        if abs(off) < 0.05:
            break
        gain *= db(off)
    return out


# ---------------------------------------------------------------------------
# 4. Score engine
# ---------------------------------------------------------------------------

CHORD_RE = re.compile(r"^([A-G])([#b]?)(m7b5|maj7|m7|m9|m|7sus|7|sus4|sus2|dim7|dim|aug|add9|6)?(?:/([A-G])([#b]?))?$")
QUALITIES = {
    None: (0, 4, 7), "m": (0, 3, 7), "7": (0, 4, 7, 10), "maj7": (0, 4, 7, 11), "m7": (0, 3, 7, 10),
    "m9": (0, 3, 7, 10, 14), "sus4": (0, 5, 7), "sus2": (0, 2, 7), "7sus": (0, 5, 7, 10),
    "dim": (0, 3, 6), "dim7": (0, 3, 6, 9), "aug": (0, 4, 8), "add9": (0, 4, 7, 14), "m7b5": (0, 3, 6, 10), "6": (0, 4, 7, 9),
}


class Chord:
    def __init__(self, symbol):
        match = CHORD_RE.match(symbol)
        if not match:
            raise ValueError(f"bad chord {symbol!r}")
        letter, acc, quality, bass_letter, bass_acc = match.groups()
        self.symbol = symbol
        self.root = (NOTE_BASE[letter] + acc.count("#") - acc.count("b")) % 12
        self.intervals = QUALITIES[quality]
        self.tones = {(self.root + interval) % 12 for interval in self.intervals}
        if bass_letter:
            self.bass = (NOTE_BASE[bass_letter] + (bass_acc or "").count("#") - (bass_acc or "").count("b")) % 12
        else:
            self.bass = self.root

    def has(self, pitch):
        return int(round(pitch)) % 12 in self.tones

    def bass_note(self, low=36):
        """The bass pitch in the octave starting at `low`."""
        return low + (self.bass - low) % 12

    def tone_note(self, degree, low=36):
        """A chord tone: degree 0 is the root, 1 the next interval up, and so on."""
        interval = self.intervals[degree % len(self.intervals)]
        return low + (self.root + interval - low) % 12


def voice_lead(chord, previous, low, high, count=4):
    """Pick chord tones in [low, high] that move as little as possible from the
    previous voicing. It keeps the root and third, avoids bass-register seconds
    and only leaves out the fifth when there are too few voices for every tone."""
    pool = [p for p in range(int(low), int(high) + 1) if p % 12 in chord.tones]
    best, best_cost = None, 1e12
    from itertools import combinations

    needed = [(chord.root + chord.intervals[1]) % 12, chord.root % 12]
    if len(chord.intervals) >= 4 and count >= 4:
        needed.append((chord.root + chord.intervals[3]) % 12)
    for combo in combinations(pool, count):
        classes = {p % 12 for p in combo}
        if not all(c in classes for c in needed):
            continue
        spacing_bad = any(combo[i + 1] - combo[i] < 3 and combo[i] < 60 for i in range(count - 1))
        crowded = any(combo[i + 1] - combo[i] < 2 for i in range(count - 1))
        if spacing_bad or crowded:
            continue
        cost = sum(abs(a - b) for a, b in zip(combo, previous)) if previous else sum(abs(p - (low + high) / 2.0) * 0.2 for p in combo)
        cost += 3.0 * (count - len(classes))  # doubling a note is a small sin
        if cost < best_cost:
            best, best_cost = combo, cost
    if best is None:
        raise ValueError(f"no voicing for {chord.symbol} in {low}..{high}")
    return list(best)


def parse_line(text):
    """'D5:3 F#5:1 r:2' -> [(pitch or None, units)]."""
    events = []
    for token in text.replace("|", " ").split():
        name, _, length = token.partition(":")
        length = float(length) if length else 1.0
        events.append((None if name == "r" else midi(name), length))
    return events


class Grid:
    """Bars and subdivisions at a fixed tempo. Bars are numbered from 1."""

    def __init__(self, unit, per_bar, origin=0.0):
        self.unit = unit
        self.per_bar = per_bar
        self.origin = origin

    def at(self, bar, unit=0.0):
        return self.origin + ((bar - 1) * self.per_bar + unit) * self.unit


class Song:
    """A track under construction: named stereo stems plus a record of the
    score, so the same data can be printed and checked as music."""

    def __init__(self, name, seconds, loop=False, seed=None):
        self.name = name
        self.loop = loop
        self.n = int(round(seconds * SR))
        self.stems: dict = {}
        self.human = rng("humanise", name if seed is None else seed)
        self.counter = 0
        self.lines: list = []    # (label, grid, bar, units-per-bar events)
        self.chart: dict = {}    # (grid-id, bar) -> [(unit, chord symbol)]
        self.sections: list = []  # (label, start seconds, end seconds, note)
        self.grids: list = []
        self.stem_levels: dict = {}
        self.mix_gains: dict = {}

    def grid(self, unit, per_bar, origin=0.0):
        grid = Grid(unit, per_bar, origin)
        self.grids.append(grid)
        return grid

    def add(self, stem, audio, when, gain=1.0, pan=0.0):
        buffer = self.stems.get(stem)
        if buffer is None:
            buffer = self.stems[stem] = np.zeros((self.n, 2), dtype=np.float32)
        if audio.ndim == 1:
            angle = (pan + 1.0) * np.pi / 4.0
            data = np.stack([audio * np.cos(angle), audio * np.sin(angle)], axis=1).astype(np.float32)
        else:
            data = audio
        data = data * gain
        start = int(round(when * SR))
        length = data.shape[0]
        if self.loop:
            start %= self.n
            first = min(self.n - start, length)
            buffer[start : start + first] += data[:first]
            done = first
            while done < length:  # the tail wraps round to the top of the track
                chunk = min(self.n, length - done)
                buffer[:chunk] += data[done : done + chunk]
                done += chunk
        else:
            if start < 0:
                data = data[-start:]
                length = data.shape[0]
                start = 0
            stop = min(self.n, start + length)
            if stop > start:
                buffer[start:stop] += data[: stop - start]

    def note(self, stem, inst, pitch, when, dur, vel=0.8, pan=0.0, tight=0.006, gain=1.0, **kw):
        self.counter += 1
        when = when + float(self.human.normal(0.0, tight))
        vel = float(np.clip(vel * (1.0 + float(self.human.normal(0.0, 0.05))), 0.05, 1.0))
        audio = inst(pitch, dur, vel, self.counter % 3, **kw)
        self.add(stem, audio, when, gain, pan)

    def line(self, stem, inst, grid, bar, text, vel=0.8, pan=0.0, shift=0, legato=0.96, tight=0.008, gain=1.0, label=None, accent=True, **kw):
        """Play a written melody. Durations are in the grid's units."""
        if "|" in text:
            for segment in text.split("|")[:-1]:
                total = sum(length for _, length in parse_line(segment))
                if segment.strip() and abs(total - grid.per_bar) > 1e-6:
                    raise ValueError(f"bar of {total} units in {segment!r} (expected {grid.per_bar})")
        unit = 0.0
        phrase_vel = vel
        events = parse_line(text)
        for pitch, length in events:
            if pitch is not None:
                when = grid.at(bar, unit)
                strong = unit % (grid.per_bar / 2.0) == 0.0
                note_vel = phrase_vel * (1.06 if accent and strong else (0.92 if accent else 1.0))
                self.note(stem, inst, pitch + shift, when, length * grid.unit * legato, note_vel, pan, tight, gain, **kw)
            unit += length
        if label:
            self.lines.append((label, grid, bar, [(None if p is None else p + shift, u) for p, u in events]))
        return unit

    def set_chords(self, grid, first_bar, chords, label=""):
        """Record harmony: each entry is a bar of 'Am' or 'Em7@0 A7@3' (symbol@unit)."""
        for index, entry in enumerate(chords):
            bar = first_bar + index
            parsed = []
            for token in entry.split():
                symbol, _, unit = token.partition("@")
                parsed.append((float(unit) if unit else 0.0, symbol))
            self.chart[(id(grid), bar)] = parsed

    def chord_at(self, grid, bar, unit=0.0):
        entries = self.chart.get((id(grid), bar))
        if not entries:
            return None
        current = entries[0][1]
        for start, symbol in entries:
            if unit >= start:
                current = symbol
        return Chord(current)

    def section(self, label, start, end, note=""):
        self.sections.append((label, start, end, note))

    # --- mixing -----------------------------------------------------------

    def mixdown(self, spec, target=-15.0, ceiling_db=-1.2, duck=None, reverbs=None, automation=None, tilt=0.0):
        """Mix the stems. `spec` maps stem -> settings (gain, pan, width, eq,
        comp, chorus, sends). `duck` is (gain array, stems). `automation` is a
        per-sample gain for stems or a callback on the final bus."""
        reverbs = reverbs or {
            "hall": make_ir(2.5, 0.022, 1.0, "hall"),
            "plate": make_ir(1.25, 0.008, 1.2, "plate"),
            "cathedral": make_ir(4.2, 0.03, 0.8, "cathedral"),
        }
        buses = {name: np.zeros((self.n, 2), dtype=FLOAT) for name in reverbs}
        total = np.zeros((self.n, 2), dtype=FLOAT)
        duck_gain, duck_stems = duck if duck else (None, ())
        self.mix_gains = {stem: settings.get("gain", 1.0) for stem, settings in spec.items() if isinstance(settings, dict)}
        for stem, buffer in self.stems.items():
            settings = spec.get(stem, {})
            x = np.asarray(buffer, dtype=FLOAT)
            if settings.get("eq"):
                x = eq_loop(x, settings["eq"], self.loop)
            if settings.get("comp"):
                x = compress(x, loop=self.loop, **settings["comp"])
            if settings.get("chorus"):
                x = chorus(x, loop=self.loop, **settings["chorus"])
            if settings.get("width") is not None:
                x = widen(x, settings["width"])
            if settings.get("pan"):
                x = _balance(x, settings["pan"])
            if stem in duck_stems:
                x = x * duck_gain[:, None]
            if automation and stem in automation:
                x = x * automation[stem][:, None]
            x = x * settings.get("gain", 1.0)
            level = float(np.sqrt(np.mean(x ** 2)))
            self.stem_levels[stem] = (20.0 * np.log10(max(level, 1e-9)), float(np.max(np.abs(x))))
            total += x
            for bus_name, send in settings.get("sends", {}).items():
                buses[bus_name] += x * send
        for name, ir in reverbs.items():
            wet = convolve(buses[name], ir, self.loop)
            # Clean the wet return: reverb below 220 Hz is just mud.
            total += eq_loop(wet, [("hp", 220.0, 0.7, 0.0), ("hs", 8000.0, 0.7, -2.0)], self.loop)
        if automation and "bus" in automation:
            total = automation["bus"](total)
        return master(total, target=target, ceiling_db=ceiling_db, loop=self.loop, tilt=tilt)


def _balance(x, pan):
    """Stereo balance for an already stereo stem."""
    left = min(1.0, 1.0 - pan) if pan > 0.0 else 1.0
    right = min(1.0, 1.0 + pan) if pan < 0.0 else 1.0
    return x * np.array([left, right], dtype=FLOAT)[None, :]


def duck_envelope(n, hits, depth=0.35, attack=0.008, release=0.18, loop=False):
    """Sidechain-style gain curve dipping at each hit time, for the pump."""
    env = np.zeros(n, dtype=FLOAT)
    span = int((attack + 5.0 * release) * SR)
    t = times(span)
    shape = (1.0 - np.exp(-t / attack)) * np.exp(-np.maximum(t - attack, 0.0) / release)
    for hit in hits:
        start = int(hit * SR)
        if start >= n:
            continue
        end = min(n, start + span)
        env[start:end] = np.maximum(env[start:end], shape[: end - start])
        if loop and start + span > n:
            over = start + span - n
            env[:over] = np.maximum(env[:over], shape[-over:])
    return 1.0 - depth * env


# ---------------------------------------------------------------------------
# 5. Compositions
# ---------------------------------------------------------------------------


def harmony_segments(song, grid, bar):
    """[(start unit, length in units, Chord)] for the bar, from the chord chart."""
    entries = song.chart[(id(grid), bar)]
    out = []
    for index, (unit, symbol) in enumerate(entries):
        end = entries[index + 1][0] if index + 1 < len(entries) else grid.per_bar
        out.append((unit, end - unit, Chord(symbol)))
    return out


def next_chord(song, grid, bar):
    """The chord that the next bar opens on (for leading bass approach notes)."""
    next_bar = bar + 1
    entries = song.chart.get((id(grid), next_bar))
    if entries is None:
        entries = song.chart[(id(grid), 1)]  # loops wrap back to bar 1
    return Chord(entries[0][1])


def arpeggio_tones(chord, base=50):
    """Six tones climbing through a chord: bass, then root-fifth-octave spread."""
    root = chord.tone_note(0, low=base)
    fifth = chord.tone_note(2, low=root)
    third = chord.tone_note(1, low=root)
    return [chord.bass_note(low=base - 12), root, fifth, root + 12, third + 12, fifth + 12]


# Valley: the main farming theme, written out as a lead sheet.
VALLEY_HOOK_A = (
    "D5:3 F#5:1 G5:1 A5:1 | B5:3 G5:1 F#5:1 E5:1 | F#5:3 D5:1 E5:1 F#5:1 | E5:3 A4:1 B4:1 C#5:1 |"
    " D5:3 G5:1 A5:1 B5:1 | A5:3 F#5:1 E5:1 D5:1 | G5:3 E5:1 F#5:1 G5:1 | A5:5 A4:1"
)
VALLEY_HOOK_B = (
    "D5:3 F#5:1 G5:1 A5:1 | B5:3 G5:1 F#5:1 E5:1 | F#5:3 B5:1 A5:1 G5:1 | A5:3 G5:1 F#5:1 E5:1 |"
    " D5:3 G5:1 A5:1 B5:1 | D6:3 A5:1 G5:1 F#5:1 | G5:2 E5:2 C#5:2 | D5:6"
)
VALLEY_BRIDGE_1 = (
    "F#5:2 E5:1 D5:2 E5:1 | B4:3 G5:3 | F#5:2 E5:1 D5:2 A4:1 | C#5:3 E5:3 |"
    " F#5:2 E5:1 D5:2 E5:1 | B4:3 B5:3 | G5:2 F#5:1 E5:2 G5:1 | F#5:3 A#4:1 C#5:1 E5:1"
)
VALLEY_BRIDGE_2 = (
    "D5:2 E5:1 G5:2 A5:1 | E5:2 F#5:1 A5:2 B5:1 | F#5:2 A5:1 C#6:3 | D6:3 B5:1 A5:1 G5:1 |"
    " B5:3 G5:1 F#5:1 E5:1 | A5:3 E5:1 F#5:1 G5:1 | F#5:2 A5:2 B5:2 | D#6:5 r:1"
)
VALLEY_CHORDS = {
    "Intro": ("D", "G", "D/F#", "A7sus@0 A7@3"),
    "A1": ("D", "G", "Bm", "A", "G", "D/F#", "Em7", "A"),
    "A2": ("D", "G", "Bm", "A7", "G", "D/F#", "Em7@0 A7@3", "D"),
    "B": ("Bm", "G", "D", "A", "Bm", "G", "Em7", "F#7", "G", "A", "F#m", "Bm", "G", "A", "B7sus@0 B7@3", "B7"),
    "Lift": ("E", "A", "C#m", "B", "A", "E/G#", "F#m7", "B", "E", "A", "C#m", "B7", "A", "E/G#", "F#m7@0 B7@3", "E"),
    "Outro": ("E", "A", "A7", "A7"),
}


def valley():
    bar = 80000.0 / SR
    song = Song("valley", 64 * bar, loop=True)
    g = song.grid(bar / 6.0, 6)
    song.section("Intro", g.at(1), g.at(5), "harp, soft strings, celesta teases the tune")
    song.section("A", g.at(5), g.at(21), "flute melody, lute strum, pizz bass, shaker")
    song.section("A2", g.at(21), g.at(29), "violins take the tune, horn counterline, tambourine")
    song.section("B", g.at(29), g.at(45), "B minor adventure: horn tune, tremolo, big drums")
    song.section("Lift", g.at(45), g.at(61), "tune up a tone in E, full orchestra, descant")
    song.section("Outro", g.at(61), g.at(65), "thins out, A7 pulls back to D at the loop")
    song.set_chords(g, 1, VALLEY_CHORDS["Intro"])
    song.set_chords(g, 5, VALLEY_CHORDS["A1"])
    song.set_chords(g, 13, VALLEY_CHORDS["A2"])
    song.set_chords(g, 21, ["D", "G", "Bm", "A7", "G", "D/F#", "Em7@0 A7@3", "D"])
    song.set_chords(g, 29, VALLEY_CHORDS["B"])
    song.set_chords(g, 45, VALLEY_CHORDS["Lift"])
    song.set_chords(g, 61, VALLEY_CHORDS["Outro"])

    # --- the tune itself -------------------------------------------------
    pad_prev = None
    tune_flute = dict(stem="flute", inst=flute, vel=0.75, pan=0.0, tight=0.008)
    song.line(**tune_flute, grid=g, bar=4, text="r:5 A4:1")
    song.line(**tune_flute, grid=g, bar=5, text=VALLEY_HOOK_A, label="Hook 1 (flute)")
    song.line(**tune_flute, grid=g, bar=13, text=VALLEY_HOOK_B, label="Hook 2 (flute)")
    song.line("violins", strings, g, 20, "r:5 A4:1", vel=0.72, tight=0.012, atk=0.05)
    song.line("violins", strings, g, 21, VALLEY_HOOK_B, vel=0.72, tight=0.012, atk=0.05, label="Hook 2 (violins)", legato=1.05)
    song.line("cellos", strings, g, 21, VALLEY_HOOK_B, vel=0.66, shift=-12, tight=0.012, atk=0.06, legato=1.05, bright=0.8)
    song.line("horn_lead", brass, g, 29, VALLEY_BRIDGE_1, vel=0.72, shift=-12, tight=0.012, voices=3, bright=0.55, label="Bridge 1 (horn, 8vb)", legato=1.0)
    song.line("cellos", strings, g, 29, VALLEY_BRIDGE_1, vel=0.62, shift=-12, tight=0.012, atk=0.08, legato=1.05, bright=0.8)
    song.line("violins", strings, g, 37, VALLEY_BRIDGE_2, vel=0.8, tight=0.012, atk=0.06, label="Bridge 2 (violins)", legato=1.05)
    song.line("horn_lead", brass, g, 37, VALLEY_BRIDGE_2, vel=0.66, shift=-12, tight=0.012, voices=3, bright=0.55, legato=1.0)
    song.line("cellos", strings, g, 37, VALLEY_BRIDGE_2, vel=0.56, shift=-12, tight=0.012, atk=0.08, legato=1.05, bright=0.8)
    # Pickup into the lift, then the tune up a whole tone with everything on it.
    song.line("violins", strings, g, 44, "r:5 B4:1", vel=0.86, tight=0.01, atk=0.04)
    song.line("trumpet", brass, g, 44, "r:5 B4:1", vel=0.8, tight=0.01, voices=4, bright=1.0)
    for start, text, name in ((45, VALLEY_HOOK_A, "Lift hook 1"), (53, VALLEY_HOOK_B, "Lift hook 2")):
        song.line("violins", strings, g, start, text, vel=0.86, shift=2, tight=0.012, atk=0.04, legato=1.06, label=f"{name} (violins, E)")
        song.line("trumpet", brass, g, start, text, vel=0.84, shift=-10, tight=0.012, voices=4, bright=0.95)
        song.line("cellos", strings, g, start, text, vel=0.7, shift=-10, tight=0.012, atk=0.05, legato=1.05, bright=0.85)
        song.line("flute", flute, g, start, text, vel=0.62, shift=2, tight=0.012)

    # --- teasers and tags on celesta -------------------------------------
    song.line("bells", celesta, g, 3, "D6:3 F#6:1 G6:1 A6:1 | A6:3", vel=0.62, tight=0.008)
    song.line("bells", celesta, g, 61, "E6:3 G#6:1 A6:1 B6:1 | C#7:3 B6:1 A6:1 G6:1 | E6:2 G6:2 A6:2 | r:1 C#6:2 E6:3", vel=0.58, tight=0.008, label="Outro tag (celesta)")

    # --- accompaniment by section ----------------------------------------
    for b in range(1, 65):
        section = "Intro" if b < 5 else "A" if b < 21 else "A2" if b < 29 else "B" if b < 45 else "Lift" if b < 61 else "Outro"
        segments = harmony_segments(song, g, b)

        # Sustained strings: voice-led, four voices, bigger in big sections.
        pad_vel = {"Intro": 0.34, "A": 0.42, "A2": 0.5, "B": 0.58, "Lift": 0.7, "Outro": 0.4}[section]
        for unit, length, chord in segments:
            pad_prev = voice_lead(chord, pad_prev, 57, 74, 4)
            trem = 0.55 if section == "B" else 0.0
            for voice, pitch in enumerate(pad_prev):
                song.note("pad", strings, pitch, g.at(b, unit), length * g.unit * 1.04, pad_vel, pan=(voice - 1.5) * 0.3, tight=0.018, atk=0.28 if section != "B" else 0.1, rel=0.4, voices=5, detune=8.0, bright=0.75, trem=trem)

        # Harp rolls throughout, twice as busy under the climax.
        if section in ("Intro", "A", "A2", "Lift", "Outro"):
            pattern = {"Intro": [0, 2, 3, 4, 5, 4], "A": [0, 1, 3, 4, 5, 3], "A2": [0, 2, 3, 5, 4, 3], "Lift": [0, 3, 4, 5, 4, 5], "Outro": [0, 2, 3, 4, 3, 2]}[section]
            harp_vel = {"Intro": 0.56, "A": 0.46, "A2": 0.5, "Lift": 0.62, "Outro": 0.52}[section]
            for unit in range(6):
                chord = song.chord_at(g, b, unit)
                tones = arpeggio_tones(chord, base=50)
                song.note("harp", harp, tones[pattern[unit]], g.at(b, unit), 2.2, harp_vel * (1.0 if unit % 3 == 0 else 0.86), pan=-0.25 + 0.1 * unit, tight=0.008)
        if section == "B":
            for unit in (0, 3):
                chord = song.chord_at(g, b, unit)
                for offset, tone in enumerate(arpeggio_tones(chord, base=50)[:5]):
                    song.note("harp", harp, tone, g.at(b, unit) + offset * 0.045, 1.8, 0.42, pan=-0.3 + 0.15 * offset, tight=0.004)

        # Lute: boom-chick-chick, the dance of the tune. Rests in the bridge.
        if section in ("A", "A2", "Lift"):
            lute_vel = {"A": 0.68, "A2": 0.7, "Lift": 0.72}[section]
            for unit in range(6):
                chord = song.chord_at(g, b, unit)
                shape = voice_lead(chord, None, 59, 74, 3)
                if unit in (0, 3):
                    bass_pitch = chord.bass_note(low=48) if unit == 0 else chord.tone_note(2, low=45)
                    song.note("lute", lute, bass_pitch, g.at(b, unit), 1.2, lute_vel, pan=0.32, tight=0.008)
                strum_vel = lute_vel * (0.5 if unit in (1, 4) else 0.62)
                strum_start = g.at(b, unit) + (0.012 if unit not in (0, 3) else 0.02)
                for string_index, pitch in enumerate(shape):
                    song.note("lute", lute, pitch, strum_start + 0.012 * string_index, 0.7, strum_vel, pan=0.28, tight=0.004)

        # Bass line: root, fifth, and an approach note into the next bar.
        if section != "Intro" or b >= 3:
            bass_vel = {"Intro": 0.5, "A": 0.66, "A2": 0.7, "B": 0.75, "Lift": 0.8, "Outro": 0.5}[section]
            chord = segments[0][2]
            root = chord.bass_note(low=38)
            fifth = chord.tone_note(2, low=33)
            coming = next_chord(song, g, b).bass_note(low=38)
            scale = {4, 6, 8, 9, 11, 1, 3} if section == "Lift" else {2, 4, 6, 7, 9, 11, 1}
            approach = coming - 2 if (coming - 2) % 12 in scale else coming - 1
            song.note("bass", bass, root, g.at(b, 0), 2.0 * g.unit, bass_vel, tight=0.004)
            song.note("bass", bass, fifth, g.at(b, 3), 1.8 * g.unit, bass_vel * 0.88, tight=0.004)
            if section in ("A", "A2", "Lift", "B"):
                song.note("bass", bass, approach, g.at(b, 5), 0.9 * g.unit, bass_vel * 0.78, tight=0.004)
            if section in ("A", "A2", "Lift"):
                song.note("pizz", pizz, root + 12, g.at(b, 0), 0.4, 0.55, pan=-0.15, tight=0.006)
                song.note("pizz", pizz, fifth + 12, g.at(b, 3), 0.4, 0.5, pan=-0.15, tight=0.006)

        # Light percussion: a jig pulse, then a stronger march under the lift.
        if section in ("A", "A2", "Lift"):
            shaker_shape = [1.0, 0.45, 0.6, 0.85, 0.45, 0.6]
            for unit in range(6):
                song.note("shaker", shaker, 60, g.at(b, unit), 0.05, 0.62 * shaker_shape[unit], pan=-0.4, tight=0.006)
        if section in ("A2", "Lift"):
            for unit in (0, 3):
                song.note("tamb", tambourine, 60, g.at(b, unit), 0.1, 0.62, pan=0.45, tight=0.006)
            if section == "Lift":
                for unit in (2, 5):
                    song.note("tamb", tambourine, 60, g.at(b, unit), 0.1, 0.38, pan=0.45, tight=0.006)
        # A soft hand drum on the two main pulses keeps the dance on its feet.
        if section in ("A", "A2"):
            level = 0.46 if section == "A" else 0.56
            song.note("handdrum", tom, 45, g.at(b, 0), 0.3, level, pan=-0.15, tight=0.005)
            song.note("handdrum", tom, 52, g.at(b, 3), 0.3, level * 0.78, pan=-0.15, tight=0.005)
            song.note("handdrum", tom, 52, g.at(b, 5), 0.3, level * 0.5, pan=-0.15, tight=0.005)
        if section == "A" and (b - 5) % 4 == 3:
            song.note("bells", glock, 86, g.at(b, 2), 0.3, 0.42, pan=0.3, tight=0.004)
        if section in ("A", "Lift", "A2") and (b - 5) % 2 == 1:
            chord = song.chord_at(g, b, 1)
            sparkle = voice_lead(chord, None, 84, 96, 3)
            song.note("bells", celesta, sparkle[-1], g.at(b, 1), 0.3, 0.42, pan=0.35, tight=0.004)
            song.note("bells", celesta, sparkle[-2], g.at(b, 2), 0.3, 0.38, pan=0.3, tight=0.004)

    # A triangle rings out at the top of each four-bar phrase of the lift.
    for b in range(45, 61, 4):
        song.note("triangle", triangle, 96, g.at(b), 0.5, 0.6, pan=0.25, tight=0.002)

    # --- the middle eight drives: drums, horns, and a fill into the lift ---
    for b in range(29, 45):
        song.note("drums", taiko, 41, g.at(b, 0), 1.0, 0.78, pan=-0.08, tight=0.004)
        song.note("drums", taiko, 45, g.at(b, 3), 1.0, 0.62, pan=0.1, tight=0.004)
        song.note("drums", taiko, 45, g.at(b, 5), 1.0, 0.5, pan=0.1, tight=0.004)
        song.note("snare_soft", snare, 60, g.at(b, 3), 0.1, 0.32, pan=-0.2, tight=0.004)
        if b % 4 == 0:
            song.note("drums", timpani, Chord(song.chart[(id(g), b)][0][1]).bass_note(low=45), g.at(b, 0), 1.0, 0.7, tight=0.004)
        for unit in (0, 1, 2, 3, 4, 5):
            song.note("shaker", shaker, 60, g.at(b, unit), 0.05, 0.34 + 0.2 * (unit % 3 == 0), pan=-0.4, tight=0.006)
    for hit in range(12):
        song.note("drums", timpani, 47, g.at(44, 0) + hit * bar / 12.0, 1.0, 0.34 + 0.05 * hit, tight=0.002)
    song.note("cym", cymbal_swell, 60, g.at(44), bar, 0.75)
    song.note("cym", cymbal_swell, 60, g.at(28), bar, 0.6)
    for b, vel in ((45, 0.85), (53, 0.65), (29, 0.6)):
        song.note("cym", crash, 60, g.at(b), 2.0, vel, tight=0.002)
    song.note("drums", boom, 33, g.at(45), 1.5, 0.8, tight=0.002)
    for b in range(45, 61):
        song.note("drums", taiko, 40, g.at(b, 0), 1.0, 0.56, tight=0.004)
        song.note("drums", taiko, 40, g.at(b, 3), 1.0, 0.44, tight=0.004)
        if b % 2 == 1:
            song.note("drums", timpani, Chord(song.chart[(id(g), b)][0][1]).bass_note(low=40), g.at(b, 0), 1.0, 0.6, tight=0.004)
    # Descant: flute sits a chord tone above the tune's long notes.
    for start, text in ((45, VALLEY_HOOK_A), (53, VALLEY_HOOK_B)):
        unit_pos = 0.0
        bar_pos = 0
        for pitch, length in parse_line(text):
            if pitch is not None and length >= 3.0:
                b = start + bar_pos
                chord = song.chord_at(g, b, unit_pos)
                up = pitch + 2 + 3
                while up % 12 not in chord.tones:
                    up += 1
                if up <= 96:
                    song.note("descant", flute, up, g.at(b, unit_pos), length * g.unit * 0.92, 0.62, pan=0.2, tight=0.01)
            unit_pos += length
            while unit_pos >= 6.0:
                unit_pos -= 6.0
                bar_pos += 1
    # Woven horn line in A2 (the counter-melody), and swirling harp into B.
    song.line("horn_counter", brass, g, 21, "A4:3 F#4:3 | B4:3 D5:3 | F#4:3 D4:3 | E4:3 C#4:3 | B3:3 G4:3 | A4:3 D5:3 | B4:2 G4:2 E4:2 | F#4:6", vel=0.46, voices=2, bright=0.4, legato=1.04, tight=0.012, label="Counter (horn)")
    for index in range(12):
        song.note("harp", harp, (62, 64, 66, 69, 71, 74, 76, 78, 81, 83, 86, 88)[index], g.at(28, 4) + index * 0.03, 1.4, 0.4 + 0.03 * index, pan=-0.4 + 0.07 * index, tight=0.003)

    # Quiet bell tolls mark the phrases of the intro and outro.
    for b, pitch in ((1, 74), (3, 81), (61, 88), (63, 81)):
        song.note("bells", bell, pitch, g.at(b), 2.0, 0.4, pan=0.2, tight=0.002)

    mix = {
        "flute": dict(gain=0.5, pan=0.0, eq=[("hp", 300.0, 0.7, 0.0), ("peak", 2600.0, 1.0, 1.5)], sends={"hall": 0.32}),
        "violins": dict(gain=0.36, eq=[("hp", 240.0, 0.7, 0.0), ("peak", 3200.0, 0.9, 2.0), ("hs", 8500.0, 0.7, -1.0)], chorus=dict(rate=0.5, depth_ms=1.8, mix=0.4), sends={"hall": 0.42}, width=1.15),
        "cellos": dict(gain=0.28, eq=[("hp", 90.0, 0.7, 0.0), ("lp", 5200.0, 0.7, 0.0)], sends={"hall": 0.3}),
        "horn_lead": dict(gain=0.42, eq=[("hp", 120.0, 0.7, 0.0), ("lp", 4800.0, 0.7, 0.0)], sends={"hall": 0.42}),
        "horn_counter": dict(gain=0.32, pan=-0.2, eq=[("hp", 140.0, 0.7, 0.0), ("lp", 3600.0, 0.7, 0.0)], sends={"hall": 0.42}),
        "trumpet": dict(gain=0.36, eq=[("hp", 180.0, 0.7, 0.0), ("hs", 7500.0, 0.7, -2.0)], sends={"hall": 0.4}),
        "descant": dict(gain=0.34, eq=[("hp", 700.0, 0.7, 0.0)], sends={"hall": 0.5}),
        "pad": dict(gain=0.15, eq=[("hp", 300.0, 0.7, 0.0), ("lp", 6500.0, 0.7, 0.0)], chorus=dict(rate=0.35, depth_ms=2.6, mix=0.6), sends={"hall": 0.42}, width=1.35),
        "harp": dict(gain=0.38, eq=[("hp", 180.0, 0.7, 0.0), ("peak", 2800.0, 1.0, 3.5)], sends={"hall": 0.34}),
        "lute": dict(gain=0.3, pan=0.1, eq=[("hp", 180.0, 0.7, 0.0), ("peak", 2900.0, 1.0, 3.5)], sends={"plate": 0.22}),
        "bass": dict(gain=0.5, eq=[("lp", 900.0, 0.7, 0.0)], comp=dict(threshold=-18.0, ratio=3.0, attack=0.01, release=0.12)),
        "pizz": dict(gain=0.3, eq=[("hp", 130.0, 0.7, 0.0)], sends={"plate": 0.25}),
        "bells": dict(gain=0.38, eq=[("hp", 500.0, 0.7, 0.0)], sends={"hall": 0.5}),
        "shaker": dict(gain=1.0, eq=[("hp", 3000.0, 0.7, 0.0)], sends={"plate": 0.15}),
        "tamb": dict(gain=0.75, eq=[("hp", 4000.0, 0.7, 0.0)], sends={"plate": 0.2}),
        "drums": dict(gain=0.5, eq=[("hp", 28.0, 0.7, 0.0)], comp=dict(threshold=-14.0, ratio=2.5, attack=0.005, release=0.1), sends={"hall": 0.22}),
        "snare_soft": dict(gain=0.36, sends={"plate": 0.25}),
        "handdrum": dict(gain=0.3, eq=[("hp", 70.0, 0.7, 0.0)], sends={"plate": 0.18}),
        "triangle": dict(gain=0.32, eq=[("hp", 1500.0, 0.7, 0.0)], sends={"hall": 0.3}),
        "cym": dict(gain=0.42, eq=[("hp", 800.0, 0.7, 0.0)], sends={"hall": 0.3}),
    }
    return song, mix


# Race: 160 bpm in E minor, written as an eight-bar brass hook.
RACE_HOOK = (
    "B4:2 E5:2 G5:3 F#5:1 | E5:2 C5:1 G5:5 | D5:2 G5:2 B5:3 A5:1 | F#5:2 D5:1 A5:5 |"
    " B5:2 B5:1 A5:1 G5:2 E5:2 | G5:2 G5:1 F#5:1 E5:2 C5:2 | C5:2 E5:2 A5:2 G5:2 | D#5:2 F#5:2 B5:4"
)
RACE_COUNTER = "G4:4 E4:4 | G4:4 C5:4 | B4:4 G4:4 | A4:4 F#4:4 | G4:4 B4:4 | G4:4 E4:4 | A4:4 C5:4 | B4:4 F#4:4"
RACE_RISE = "E5:8 | F#5:8 | G5:8 | A5:8 | A5:8 | B5:8 | C6:8 | B5:4 D#6:4"
RACE_CALLS = "E5:2 G5:2 C6:3 B5:1 | F#5:2 A5:2 D6:3 C6:1 | E5:2 F#5:2 A5:2 B5:2 | D#5:2 F#5:2 A5:2 B5:2"
RACE_CHORDS = {
    "Intro": ("Em", "Em", "C", "D"),
    "Hook": ("Em", "C", "G", "D", "Em", "C", "Am", "B7"),
    "Tension": ("C", "D", "Em", "F", "F#dim", "G", "Am", "B7"),
    "HookUp": ("F#m", "D", "A", "E", "F#m", "D", "Bm", "C#7"),
    "Break": ("Em", "Em", "Em", "Em", "C", "D", "B7sus", "B7"),
    "Final": ("Em", "C", "Am", "B7"),
}


def chord_below(pitch, chord):
    """The next chord tone beneath a melody note, for brass harmony."""
    down = pitch - 1
    while down % 12 not in chord.tones:
        down -= 1
    return down


def race():
    bar = 1.5
    song = Song("race", 48 * bar, loop=True)
    g = song.grid(bar / 8.0, 8)
    plan = [("Intro", 1, 5, "gallop strings and drums wind up"), ("Hook 1", 5, 13, "trumpets and lead state the hook"),
            ("Hook 2", 13, 21, "violins double it, horn countermelody"), ("Tension", 21, 29, "rising bass line, stabs, snare build"),
            ("Hook up", 29, 37, "tune up a tone in F# minor, biggest moment"), ("Break", 37, 45, "taiko and pedal, then calls climb"),
            ("Final", 45, 49, "last four bars of hook, fill back to the top")]
    for label, a, b, note in plan:
        song.section(label, g.at(a), g.at(b), note)
    song.set_chords(g, 1, RACE_CHORDS["Intro"])
    song.set_chords(g, 5, RACE_CHORDS["Hook"])
    song.set_chords(g, 13, RACE_CHORDS["Hook"])
    song.set_chords(g, 21, RACE_CHORDS["Tension"])
    song.set_chords(g, 29, RACE_CHORDS["HookUp"])
    song.set_chords(g, 37, RACE_CHORDS["Break"])
    song.set_chords(g, 45, RACE_CHORDS["Final"])

    # --- hooks -----------------------------------------------------------
    def brass_hook(start, text, shift, label, vel=0.86):
        song.line("trumpet", brass, g, start, text, vel=vel, shift=shift, tight=0.006, voices=4, bright=1.1, label=label)
        song.line("lead", lead, g, start, text, vel=vel * 0.8, shift=shift, tight=0.003)

    brass_hook(5, RACE_HOOK, 0, "Hook 1 (trumpet)")
    brass_hook(13, RACE_HOOK, 0, "Hook 2 (trumpet)", vel=0.9)
    song.line("violins", strings, g, 13, RACE_HOOK, vel=0.78, shift=12, tight=0.008, atk=0.03, rel=0.1, label="Hook 2 (violins 8va)")
    song.line("horn", brass, g, 13, RACE_COUNTER, vel=0.6, tight=0.01, voices=3, bright=0.5, legato=1.02, label="Counter (horns)")
    brass_hook(29, RACE_HOOK, 2, "Hook up (trumpet, F#m)", vel=0.96)
    song.line("violins", strings, g, 29, RACE_HOOK, vel=0.84, shift=14, tight=0.008, atk=0.03, rel=0.1)
    song.line("horn", brass, g, 29, RACE_COUNTER, vel=0.68, shift=2, tight=0.01, voices=3, bright=0.55, legato=1.02)
    song.line("piccolo", piccolo, g, 29, RACE_HOOK, vel=0.6, shift=14, tight=0.008)
    unit_pos = 0.0
    bar_pos = 0
    for pitch, length in parse_line(RACE_HOOK):  # trumpets split into harmony at the climax
        chord = song.chord_at(g, 29 + bar_pos, unit_pos)
        if pitch is not None and length >= 1.0 and chord is not None:
            song.note("trumpet2", brass, chord_below(pitch + 2, chord), g.at(29 + bar_pos, unit_pos), length * g.unit * 0.96, 0.78, pan=0.15, tight=0.008, voices=3, bright=0.9)
        unit_pos += length
        while unit_pos >= 8.0:
            unit_pos -= 8.0
            bar_pos += 1
    brass_hook(45, "B5:2 B5:1 A5:1 G5:2 E5:2 | G5:2 G5:1 F#5:1 E5:2 C5:2 | C5:2 E5:2 A5:2 G5:2 | D#5:2 F#5:2 B5:4", 0, "Final hook", vel=0.92)
    song.line("violins", strings, g, 45, "B5:2 B5:1 A5:1 G5:2 E5:2 | G5:2 G5:1 F#5:1 E5:2 C5:2 | C5:2 E5:2 A5:2 G5:2 | D#5:2 F#5:2 B5:4", vel=0.8, shift=12, tight=0.008, atk=0.03, rel=0.1)
    song.line("violins", strings, g, 21, RACE_RISE, vel=0.76, tight=0.01, atk=0.2, rel=0.12, legato=1.0, label="Tension rise (violins)")
    song.line("trumpet", brass, g, 41, RACE_CALLS, vel=0.86, tight=0.006, voices=4, bright=1.05, label="Break calls (trumpet)")
    song.line("lead", lead, g, 41, RACE_CALLS, vel=0.66, tight=0.003)

    # --- rhythm section ---------------------------------------------------
    kick_times, chord_stab_prev = [], None
    for b in range(1, 49):
        chord = song.chord_at(g, b, 0.0)
        section = next(label for label, a, stop, _ in plan if a <= b < stop)
        hook_like = section.startswith("Hook") or section == "Final"
        root = chord.bass_note(low=28)
        # Driving bass: eighths with an octave pop to keep the feet moving.
        if section != "Break" or b >= 41:
            for unit in range(8):
                pitch = root + (12 if unit in (3, 7) else 0)
                vel = 0.84 if unit == 0 else 0.7 if unit % 2 == 0 else 0.62
                song.note("bass", drive_bass, pitch, g.at(b, unit), g.unit * 0.9, vel, tight=0.004)
        else:
            song.note("bass", drive_bass, root, g.at(b), bar * 0.95, 0.72, tight=0.004)
        # Spiccato strings gallop: long-short-short on every beat.
        if section != "Break" or b >= 41:
            for beat in range(4):
                for offset, vel in ((0.0, 0.72), (1.0, 0.52), (1.5, 0.56)):
                    pitch = chord.tone_note(0, low=48) + (12 if beat == 3 and offset == 1.5 else 0)
                    song.note("spiccato", strings, pitch, g.at(b, beat * 2 + offset), 0.1, vel, pan=-0.1, tight=0.004, atk=0.006, rel=0.05, voices=4, detune=6.0, bright=0.9)
        # High rhythmic stabs that sit between the melody notes.
        if hook_like or section in ("Tension", "Intro"):
            stab = voice_lead(chord, chord_stab_prev, 60, 76, 4)
            chord_stab_prev = stab
            stab_units = (3, 6) if section == "Tension" else (1, 3, 5, 7)
            for unit in stab_units:
                for voice, pitch in enumerate(stab):
                    song.note("stabs", brass, pitch, g.at(b, unit), 0.12, 0.72 if hook_like else 0.6, pan=(voice - 1.5) * 0.35, tight=0.004, voices=2, bright=0.6)
        # String pad holding the harmony under everything.
        if section != "Intro":
            pad = voice_lead(chord, None, 55, 72, 4)
            for voice, pitch in enumerate(pad):
                song.note("pad", strings, pitch, g.at(b), bar * 1.02, 0.5, pan=(voice - 1.5) * 0.3, tight=0.012, atk=0.1, rel=0.2, voices=5, bright=0.9, trem=0.4 if section == "Tension" else 0.0)

        # Drum kit and big drums.
        for unit in (0, 2, 4, 6):
            song.note("kick", kick, 60, g.at(b, unit), 0.2, 0.92 if unit in (0, 4) else 0.82, tight=0.003)
            kick_times.append(g.at(b, unit))
        for unit in (2, 6):
            song.note("snare", snare, 60, g.at(b, unit), 0.2, 0.9, pan=0.04, tight=0.003)
        hat_units = [u * 0.5 for u in range(16)] if section in ("Hook 2", "Hook up", "Final", "Tension") else [float(u) for u in range(8)]
        for unit in hat_units:
            openness = 0.8 if unit == 7.0 else 0.0
            song.note("hats", hat, 60, g.at(b, unit), 0.05, 0.7 if unit % 2 == 0 else 0.5, pan=0.3, tight=0.003, openness=openness)
        if hook_like:
            for unit in (1, 3, 5, 7):
                song.note("tamb", tambourine, 60, g.at(b, unit), 0.1, 0.56, pan=-0.45, tight=0.004)
        # Taiko tresillo, the thrill under the hook.
        if hook_like or section == "Tension":
            for unit, vel in ((0, 0.92), (3, 0.72), (6, 0.8)):
                song.note("taiko", taiko, 39, g.at(b, unit), 1.0, vel, tight=0.003)
        elif section == "Break" and b < 41:
            for unit, vel in ((0, 0.9), (1.5, 0.5), (3, 0.72), (4.5, 0.5), (6, 0.8), (7.5, 0.5)):
                song.note("taiko", taiko, 37 if unit == 0 else 41, g.at(b, unit), 1.0, vel, tight=0.003)
        if (b - 1) % 8 == 0 or b in (5, 13, 21, 29, 37, 45):
            song.note("drums", timpani, chord.bass_note(low=40), g.at(b), 1.0, 0.8, tight=0.002)
        if b in (1, 5, 13, 21, 29, 37, 45):
            song.note("cym", crash, 60, g.at(b), 2.5, 0.9, tight=0.002)
            song.note("boom", boom, 28, g.at(b), 1.5, 0.75, tight=0.002)

    # Pads hold the Intro and the Break pedal lightly (a low E drone under it).
    for b in range(37, 41):
        song.note("pad", strings, 40, g.at(b), bar * 1.02, 0.5, tight=0.012, atk=0.2, rel=0.2, voices=5, bright=0.5)
        song.note("pad", strings, 64, g.at(b), bar * 1.02, 0.4, tight=0.012, atk=0.2, rel=0.2, voices=5, bright=0.6, trem=0.6)

    # Drum fills: each eight-bar phrase ends on a tom fall and a cymbal swell.
    for fill_bar in (4, 12, 20, 36, 44, 48):
        pitches = [64, 62, 60, 57, 55, 52, 48, 45]
        for hit, pitch in enumerate(pitches):
            song.note("toms", tom, pitch, g.at(fill_bar, 4.0 + hit * 0.5), 0.3, 0.68 + hit * 0.03, pan=-0.3 + hit * 0.09, tight=0.003)
        song.note("cym", cymbal_swell, 60, g.at(fill_bar), bar, 0.7)
    # Tension: the snare climbs in density over the last two bars into the key change.
    for hit in range(16):
        song.note("snare", snare, 60, g.at(27, hit * 0.5), 0.1, 0.45 + 0.03 * hit, tight=0.002)
    for hit in range(32):
        song.note("snare", snare, 60, g.at(28, hit * 0.25), 0.1, 0.5 + 0.014 * hit, tight=0.002)
    song.note("cym", cymbal_swell, 60, g.at(27), 2.0 * bar, 0.8)
    song.note("riser", riser, 60, g.at(27), 2.0 * bar, 0.6)
    for hit in range(16):  # the break's closing snare build
        song.note("snare", snare, 60, g.at(44, hit * 0.5), 0.1, 0.5 + 0.03 * hit, tight=0.002)
    song.note("riser", riser, 60, g.at(43), 2.0 * bar, 0.65)
    song.note("riser", riser, 60, g.at(4), bar, 0.45)
    # Sparkling glockenspiel on the hook's long notes, a detail for the ear.
    for start, shift in ((13, 0), (29, 2)):
        unit_pos = 0.0
        bar_pos = 0
        for pitch, length in parse_line(RACE_HOOK):
            if pitch is not None and length >= 3.0:
                song.note("glock", glock, pitch + 12 + shift, g.at(start + bar_pos, unit_pos), 0.3, 0.56, pan=0.3, tight=0.003)
            unit_pos += length
            while unit_pos >= 8.0:
                unit_pos -= 8.0
                bar_pos += 1

    pump = duck_envelope(song.n, kick_times, depth=0.3, attack=0.004, release=0.06, loop=True)
    mix = {
        "trumpet": dict(gain=0.95, eq=[("hp", 180.0, 0.7, 0.0), ("peak", 2800.0, 1.0, 3.0)], comp=dict(threshold=-20.0, ratio=2.5, attack=0.012, release=0.12), sends={"hall": 0.28}),
        "trumpet2": dict(gain=0.32, pan=0.15, eq=[("hp", 200.0, 0.7, 0.0)], sends={"hall": 0.3}),
        "lead": dict(gain=0.34, eq=[("hp", 300.0, 0.7, 0.0)], chorus=dict(rate=0.7, depth_ms=1.1, mix=0.5), sends={"plate": 0.25}),
        "violins": dict(gain=0.34, eq=[("hp", 300.0, 0.7, 0.0), ("peak", 3200.0, 0.9, 3.0)], chorus=dict(rate=0.5, depth_ms=1.6, mix=0.35), sends={"hall": 0.3}, width=1.2),
        "piccolo": dict(gain=0.24, eq=[("hp", 800.0, 0.7, 0.0)], sends={"hall": 0.35}),
        "horn": dict(gain=0.3, pan=-0.15, eq=[("hp", 130.0, 0.7, 0.0), ("lp", 4200.0, 0.7, 0.0)], sends={"hall": 0.32}),
        "stabs": dict(gain=0.2, eq=[("hp", 220.0, 0.7, 0.0), ("lp", 6000.0, 0.7, 0.0)], sends={"plate": 0.3}, width=1.4),
        "pad": dict(gain=0.12, eq=[("hp", 260.0, 0.7, 0.0), ("lp", 6000.0, 0.7, 0.0)], chorus=dict(rate=0.4, depth_ms=2.4, mix=0.5), sends={"hall": 0.3}, width=1.4),
        "spiccato": dict(gain=0.26, eq=[("hp", 110.0, 0.7, 0.0), ("hs", 7000.0, 0.7, -3.0)], sends={"plate": 0.15}),
        "bass": dict(gain=0.36, eq=[("hp", 42.0, 0.7, 0.0), ("lp", 3200.0, 0.7, 0.0)], comp=dict(threshold=-16.0, ratio=3.5, attack=0.006, release=0.09)),
        "kick": dict(gain=0.3, eq=[("hp", 42.0, 0.7, 0.0), ("peak", 3200.0, 1.0, 3.0)]),
        "snare": dict(gain=0.42, eq=[("hp", 150.0, 0.7, 0.0)], sends={"plate": 0.25}),
        "hats": dict(gain=1.0, eq=[("hp", 6000.0, 0.7, 0.0)]),
        "tamb": dict(gain=1.3, eq=[("hp", 4500.0, 0.7, 0.0)], sends={"plate": 0.15}),
        "taiko": dict(gain=0.3, eq=[("hp", 48.0, 0.7, 0.0), ("peak", 1800.0, 1.0, 3.0)], sends={"hall": 0.18}),
        "toms": dict(gain=0.42, eq=[("hp", 70.0, 0.7, 0.0)], sends={"hall": 0.2}),
        "drums": dict(gain=0.3, eq=[("hp", 40.0, 0.7, 0.0)], sends={"hall": 0.2}),
        "boom": dict(gain=0.24, eq=[("hp", 30.0, 0.7, 0.0)]),
        "cym": dict(gain=0.38, eq=[("hp", 900.0, 0.7, 0.0)], sends={"hall": 0.25}),
        "riser": dict(gain=0.3, eq=[("hp", 250.0, 0.7, 0.0)]),
        "glock": dict(gain=0.3, eq=[("hp", 800.0, 0.7, 0.0)], sends={"hall": 0.4}),
        "_duck": (pump, ("bass", "pad", "stabs", "spiccato", "lead")),
    }
    return song, mix


def victory():
    """Eight seconds of brass and timpani built on the valley hook."""
    unit = 0.25
    song = Song("victory", 8.2)
    g = song.grid(unit, 6)
    song.section("Fanfare", 0.0, g.at(4), "hook opening on trumpets, drums and snare roll")
    song.section("Final chord", g.at(4), 8.2, "D major with cymbals, ringing out")
    song.set_chords(g, 1, ["D", "G", "A7", "D", "D"])
    tune = "D5:3 F#5:1 G5:1 A5:1 | B5:3 G5:1 A5:1 B5:1 | C#6:3 A5:1 B5:1 C#6:1 | D6:6 | D6:5"
    song.line("trumpet", brass, g, 1, tune, vel=0.92, tight=0.005, voices=4, bright=1.1, label="Victory fanfare (trumpet)")
    song.line("lead", lead, g, 1, tune, vel=0.7, tight=0.003)
    song.line("violins", strings, g, 1, tune, vel=0.8, shift=12, tight=0.006, atk=0.02, rel=0.25)
    previous = None
    for b in range(1, 6):
        chord = song.chord_at(g, b)
        hold = 6.0 if b < 5 else 5.0
        previous = voice_lead(chord, previous, 55, 72, 4)
        for voice, pitch in enumerate(previous):
            song.note("horn", brass, pitch, g.at(b), hold * unit * 1.02, 0.78, pan=(voice - 1.5) * 0.25, tight=0.006, voices=3, bright=0.7)
        for offset, tone in enumerate(arpeggio_tones(chord, base=50)):
            song.note("harp", harp, tone, g.at(b) + offset * 0.04, 1.6, 0.56, pan=-0.3 + 0.12 * offset, tight=0.002)
        song.note("bass", bass, chord.bass_note(low=26), g.at(b), hold * unit, 0.85, tight=0.002)
        song.note("drums", timpani, chord.bass_note(low=38), g.at(b), 1.0, 0.92, tight=0.002)
        song.note("drums", taiko, 39, g.at(b), 1.0, 0.86, tight=0.002)
    for hit in range(int(4 * 6 * 2)):  # snare rolls through the fanfare
        when = g.at(1) + hit * unit / 2.0
        song.note("snare", snare, 60, when, 0.1, 0.5 + 0.012 * hit, tight=0.002)
    song.note("cym", crash, 60, g.at(4), 3.0, 1.0, tight=0.001)
    song.note("cym", crash, 60, g.at(5), 2.6, 0.7, tight=0.001)
    song.note("cym", cymbal_swell, 60, g.at(3), 6.0 * unit, 0.85)
    song.note("drums", boom, 29, g.at(4), 1.6, 0.9, tight=0.001)
    song.note("bells", bell, 86, g.at(4), 3.0, 0.7, tight=0.001)
    song.note("bells", glock, 98, g.at(4), 1.0, 0.8, tight=0.001)
    for index, pitch in enumerate((86, 90, 93, 98)):
        song.note("bells", celesta, pitch, g.at(5) + index * 0.13, 1.0, 0.7, pan=0.3, tight=0.002)
    mix = {
        "trumpet": dict(gain=0.5, eq=[("hp", 180.0, 0.7, 0.0), ("peak", 3000.0, 1.0, 2.0)], sends={"hall": 0.32}),
        "lead": dict(gain=0.2, eq=[("hp", 300.0, 0.7, 0.0)], sends={"plate": 0.25}),
        "violins": dict(gain=0.3, eq=[("hp", 400.0, 0.7, 0.0)], sends={"hall": 0.3}, width=1.2),
        "horn": dict(gain=0.28, eq=[("hp", 120.0, 0.7, 0.0)], sends={"hall": 0.35}),
        "harp": dict(gain=0.4, eq=[("hp", 180.0, 0.7, 0.0)], sends={"hall": 0.3}),
        "bass": dict(gain=0.4, eq=[("lp", 900.0, 0.7, 0.0)]),
        "drums": dict(gain=0.42, eq=[("hp", 28.0, 0.7, 0.0)], sends={"hall": 0.2}),
        "snare": dict(gain=0.26, eq=[("hp", 200.0, 0.7, 0.0)], sends={"plate": 0.2}),
        "cym": dict(gain=0.45, eq=[("hp", 900.0, 0.7, 0.0)], sends={"hall": 0.25}),
        "bells": dict(gain=0.32, eq=[("hp", 700.0, 0.7, 0.0)], sends={"hall": 0.45}),
    }
    return song, mix


def defeat():
    """A friendly 'aww': a sliding muted trombone, then a cheeky consoling tag."""
    song = Song("defeat", 5.3)
    g = song.grid(0.25, 8)
    song.section("Aww", 0.0, 2.9, "muted brass slumps chromatically over pizz bass")
    song.section("Tag", 2.9, 5.3, "pizzicato shrug, celesta 'try again', soft C major")
    song.set_chords(g, 1, ["Eb@0 D7@2 Db7@4 C@6", "C", "C", "C"])
    line = "G4:2 F#4:2 F4:2 E4:2 | E4:8"
    song.line("trombone", brass, g, 1, "G4:2 F#4:2 F4:2", vel=0.62, tight=0.006, voices=3, bright=0.42, wah=0.5, legato=0.9, label="Aww (muted trombone)")
    song.line("trombone", brass, g, 1, "r:6 E4:10", vel=0.66, tight=0.006, voices=3, bright=0.42, wah=0.65, slide=-1.0)
    song.line("clarinet", reed, g, 1, line, vel=0.5, shift=-12, tight=0.008, kind="bassoon")
    song.note("pizz", pizz, 39, g.at(1, 0), 0.6, 0.72, tight=0.003)
    song.note("pizz", pizz, 38, g.at(1, 2), 0.6, 0.7, tight=0.003)
    song.note("pizz", pizz, 37, g.at(1, 4), 0.6, 0.7, tight=0.003)
    song.note("pizz", pizz, 36, g.at(1, 6), 0.6, 0.72, tight=0.003)
    song.note("woodblock", woodblock, 79, g.at(2, 5), 0.1, 0.5, pan=-0.3, tight=0.002)
    for b, unit, pitch in ((3, 0, 48), (3, 2, 55), (3, 4, 48), (3, 6, 55)):
        song.note("pizz", pizz, pitch, g.at(b, unit), 0.4, 0.64, pan=-0.15, tight=0.003)
    song.line("bells", celesta, g, 3, "C6:1 E6:1 G6:1 C7:3 r:2 | G6:1 E6:1 C6:6", vel=0.66, tight=0.004, label="Tag (celesta)")
    pad = voice_lead(Chord("C"), None, 55, 72, 4)
    for voice, pitch in enumerate(pad):
        song.note("pad", strings, pitch, g.at(3, 4), 2.2, 0.5, pan=(voice - 1.5) * 0.3, tight=0.008, atk=0.4, rel=0.8, voices=5, bright=0.8)
    song.note("bells", glock, 96, g.at(4, 0), 1.0, 0.6, tight=0.002)
    mix = {
        "trombone": dict(gain=0.6, eq=[("hp", 150.0, 0.7, 0.0), ("lp", 3200.0, 0.7, 0.0)], sends={"hall": 0.3}),
        "clarinet": dict(gain=0.35, eq=[("hp", 100.0, 0.7, 0.0)], sends={"hall": 0.25}),
        "pizz": dict(gain=0.55, eq=[("hp", 70.0, 0.7, 0.0)], sends={"plate": 0.3}),
        "bells": dict(gain=0.7, eq=[("hp", 700.0, 0.7, 0.0)], sends={"hall": 0.5}),
        "pad": dict(gain=0.16, eq=[("hp", 250.0, 0.7, 0.0)], sends={"hall": 0.5}, width=1.4),
        "woodblock": dict(gain=0.4, sends={"plate": 0.2}),
    }
    return song, mix


def film():
    """The film score, made to picture: one continuous arc in six movements,
    in the film's order. Wonder (the night and the hatch), valley (the farm),
    market, reveal (pairing and a new hatch), race (two challenge races) and
    the finale."""
    unit_valley = 5.0 / 18.0
    valley_bars = 18  # 30 s of farm
    race_intro, race_breather, race_tail = 6, 3, 3
    race_bars = race_intro + 8 + race_breather + 8 + race_tail  # 28 bars of 1.5 s
    hook_1 = race_intro + 1  # the first race starts on this downbeat
    breather = hook_1 + 8
    hook_2 = breather + race_breather  # the second race
    tail = hook_2 + 8
    t_valley = 12.0
    t_market = t_valley + valley_bars * 6 * unit_valley
    t_reveal = t_market + 20.0
    t_race = t_reveal + 20.0
    t_finale = t_race + race_bars * 1.5
    song = Song("film", t_finale + 8.0 * 5.0 / 3.0 + 1.6)
    gw = song.grid(1.0, 4, 0.0)
    gv = song.grid(unit_valley, 6, t_valley)
    gm = song.grid(0.25, 8, t_market)
    ga = song.grid(4.0 / 6.0, 6, t_reveal)
    gr = song.grid(0.1875, 8, t_race)
    gf = song.grid(unit_valley, 6, t_finale)
    song.section("Wonder", 0.0, t_valley, "celesta, glass pad, choir, harp; a hint of the tune")
    song.section("Valley", t_valley, t_market, "flute tune over harp and bass, voice band kept clear")
    song.section("Market", t_market, t_reveal, "clarinet and pizzicato tiptoe; snare builds")
    song.section("Reveal", t_reveal, t_race, "choir and cathedral reverb, tune broadened in C")
    song.section("Race", t_race, t_finale, "groove, race hook, breather, race hook, tail; big drums, brass")
    song.section("Finale", t_finale, song.n / SR, "tune in full orchestra, warm D major ending")
    song.set_chords(gw, 1, ["D", "Bm7", "Gadd9@0 A7sus@2"])
    song.set_chords(gv, 1, list(VALLEY_CHORDS["A1"]) + list(VALLEY_CHORDS["A2"]) + ["G", "E7"])
    song.set_chords(gm, 1, ["Am", "Am", "Dm", "E7", "Am", "F", "D7", "B7", "C", "B7"])
    song.set_chords(ga, 1, ["C", "F", "Am", "G", "C@0 B7@3"])
    race_hook_chords = ["Em", "C", "G", "D", "Em", "C", "Am", "B7"]
    song.set_chords(gr, 1, ["Em", "C", "Em", "C", "Am", "B7"] + race_hook_chords + ["Em", "C", "B7"] + race_hook_chords + ["Em", "C", "B7"])
    song.set_chords(gf, 1, list(VALLEY_CHORDS["A2"]))

    def voiced_pad(grid, bar, stem, inst, low, high, vel, prev, count=4, pan_spread=0.3, **kw):
        for unit, length, chord in harmony_segments(song, grid, bar):
            prev = voice_lead(chord, prev, low, high, count)
            for voice, pitch in enumerate(prev):
                song.note(stem, inst, pitch, grid.at(bar, unit), length * grid.unit * 1.03, vel, pan=(voice - (count - 1) / 2.0) * pan_spread, tight=0.012, **kw)
        return prev

    def harp_roll(grid, bar, pattern, vel, base=50, stem="harp"):
        for unit in range(6):
            chord = song.chord_at(grid, bar, unit)
            tones = arpeggio_tones(chord, base=base)
            song.note(stem, harp, tones[pattern[unit]], grid.at(bar, unit), 2.0, vel * (1.0 if unit % 3 == 0 else 0.86), pan=-0.25 + 0.1 * unit, tight=0.008)

    def bass_walk(grid, bar, vel, pizz_too=True):
        chord = song.chord_at(grid, bar, 0.0)
        root = chord.bass_note(low=38)
        song.note("bass", bass, root, grid.at(bar, 0), 2.0 * grid.unit, vel, tight=0.004)
        song.note("bass", bass, chord.tone_note(2, low=33), grid.at(bar, 3), 1.8 * grid.unit, vel * 0.88, tight=0.004)
        if pizz_too:
            song.note("pizz", pizz, root + 12, grid.at(bar, 0), 0.4, 0.55, pan=-0.15, tight=0.006)
            song.note("pizz", pizz, chord.tone_note(2, low=45), grid.at(bar, 3), 0.4, 0.5, pan=-0.15, tight=0.006)

    # ---- Wonder (0-12 s) -------------------------------------------------
    prev = None
    for b in range(1, 4):
        prev = voiced_pad(gw, b, "glass", glass, 69, 86, 0.36, prev, count=4, pan_spread=0.4)
        for unit, length, chord in harmony_segments(song, gw, b):
            song.note("choir", choir, chord.tone_note(0, low=62), gw.at(b, unit), length * gw.unit, 0.3, tight=0.02, vowel="oo")
            song.note("choir", choir, chord.tone_note(2, low=62), gw.at(b, unit), length * gw.unit, 0.26, pan=0.2, tight=0.02, vowel="oo")
    song.line("bells", celesta, gw, 1, "D6:2 F#6:1 G6:1 | A6:2 B6:2 | A6:4", vel=0.72, tight=0.01, label="Wonder tease (celesta)")
    song.line("glock", glock, gw, 1, "r:2 F#7:1 G7:1 | A7:2 B7:2 | A7:4", vel=0.42, tight=0.008)
    for b, pitch in ((1, 74), (3, 78)):
        song.note("bells", bell, pitch, gw.at(b), 2.0, 0.42, pan=0.2, tight=0.002)
    for beat in range(12):
        chord = song.chord_at(gw, 1 + beat // 4, float(beat % 4))
        tone = arpeggio_tones(chord, base=62)[[0, 2, 3, 4, 3, 2][beat % 6]]
        song.note("harp", harp, tone + 12, gw.at(1, beat), 2.6, 0.5, pan=-0.3 + 0.05 * beat, tight=0.02)
    for index in range(18):  # a harp gliss up the D major pentatonic into the valley
        song.note("harp", harp, 62 + 12 * (index // 5) + (0, 2, 4, 7, 9)[index % 5], gw.at(3, 2) + index * 0.11, 1.8, 0.42 + index * 0.018, pan=-0.5 + index * 0.05, tight=0.002)
    song.note("cym", cymbal_swell, 60, gw.at(3, 2), 2.0, 0.5)

    # ---- Valley (12-42 s): the verse, under a voice ------------------------
    song.line("flute", ocarina, gv, 0, "r:5 A4:1", vel=0.5, shift=0)  # pickup just before bar 1
    song.line("flute", ocarina, gv, 1, VALLEY_HOOK_A, vel=0.55, tight=0.01, label="Hook 1 (ocarina, under narration)")
    song.line("flute", ocarina, gv, 9, VALLEY_HOOK_B, vel=0.57, tight=0.01, label="Hook 2 (ocarina, under narration)")
    song.line("violins", strings, gv, 8, "r:5 A4:1", vel=0.38, tight=0.012, atk=0.06)
    song.line("violins", strings, gv, 9, VALLEY_HOOK_B, vel=0.38, tight=0.012, atk=0.06, legato=1.05, label="Hook 2 (violins)")
    song.line("flute", ocarina, gv, valley_bars - 1, "G5:6 | E5:3 G#4:3", vel=0.5, tight=0.01)
    pad_prev = None
    for b in range(1, valley_bars + 1):
        pad_prev = voiced_pad(gv, b, "pad", strings, 57, 74, 0.34, pad_prev, atk=0.3, rel=0.4, voices=5, bright=0.7)
        harp_roll(gv, b, [0, 3, 4, 5, 4, 3], 0.44 if b < 9 else 0.5, base=62)
        bass_walk(gv, b, 0.58)
        for unit, shape in enumerate((1.0, 0.45, 0.6, 0.85, 0.45, 0.6)):
            song.note("shaker", shaker, 60, gv.at(b, unit), 0.05, 0.48 * shape, pan=-0.35, tight=0.006)
        if b % 2 == 0:
            chord = song.chord_at(gv, b, 1)
            sparkle = voice_lead(chord, None, 84, 96, 3)
            song.note("bells", celesta, sparkle[-1], gv.at(b, 1), 0.3, 0.5, pan=0.3, tight=0.004)
            song.note("bells", celesta, sparkle[-2], gv.at(b, 2), 0.3, 0.42, pan=0.3, tight=0.004)
    for pitch in (74, 78, 81):
        song.note("bells", bell, pitch + 12, gv.at(1), 1.5, 0.3, pan=0.25, tight=0.002)

    # ---- Market (42-62 s): mischief ----------------------------------------
    market_tune = ("A4:1 r:1 C5:1 D5:1 E5:2 C5:1 r:1 | E5:1 r:1 B4:1 G#4:1 A4:2 r:2 | F5:1 r:1 E5:1 F5:1 A5:2 F5:1 r:1 | E5:1 r:1 D5:1 C#5:1 B4:2 G#4:2 |"
                   " A4:1 r:1 C5:1 D5:1 E5:2 G5:1 r:1 | A5:1 r:1 G5:1 F5:1 C5:2 A4:1 r:1 | F#5:1 r:1 E5:1 D5:1 A4:2 C5:1 r:1 | D#5:1 r:1 F#5:1 B5:1 A5:2 F#5:1 r:1")
    song.line("clarinet", reed, gm, 1, market_tune, vel=0.74, legato=0.68, tight=0.006, kind="clarinet", label="Market tune (clarinet)")
    song.line("bassoon", reed, gm, 1, "A3:2 r:2 E3:2 r:2 | F3:2 r:2 E3:2 r:2 | D3:2 r:2 A3:2 r:2 | E3:2 r:2 B3:2 r:2 | A3:2 r:2 E3:2 r:2 | F3:2 r:2 C4:2 r:2 | D3:2 r:2 A3:2 r:2 | B2:2 r:2 F#3:2 r:2", vel=0.66, legato=0.55, tight=0.006, kind="bassoon")
    song.line("violins", strings, gm, 9, "E5:2 G5:2 C6:2 E6:2 | D#6:8", vel=0.7, tight=0.012, atk=0.05, legato=1.0, label="Market build (violins)")
    for b in range(1, 11):
        chord = song.chord_at(gm, b, 0.0)
        song.note("pizz", pizz, chord.bass_note(low=38), gm.at(b, 0), 0.4, 0.72, pan=-0.1, tight=0.004)
        song.note("pizz", pizz, chord.tone_note(2, low=33), gm.at(b, 4), 0.4, 0.66, pan=-0.1, tight=0.004)
        song.note("bass", bass, chord.bass_note(low=26), gm.at(b, 0), 2.0 * gm.unit, 0.62, tight=0.004)
        song.note("bass", bass, chord.tone_note(2, low=26), gm.at(b, 4), 2.0 * gm.unit, 0.58, tight=0.004)
        voicing = voice_lead(chord, None, 64, 78, 3)
        for unit in (1, 3, 5, 7):
            for pitch in voicing:
                song.note("marimba", marimba, pitch, gm.at(b, unit), 0.4, 0.5, pan=0.25, tight=0.005)
        if b <= 8:
            song.note("woodblock", woodblock, 80, gm.at(b, 2), 0.1, 0.6, pan=-0.35, tight=0.003)
            song.note("woodblock", woodblock, 74, gm.at(b, 6), 0.1, 0.55, pan=-0.35, tight=0.003)
            for unit in (0.5, 2.5, 4.5, 6.5):
                song.note("shaker", shaker, 60, gm.at(b, unit), 0.05, 0.5, pan=0.3, tight=0.004)
    for hit in range(32):  # build: snare crescendo into the race
        song.note("snare", snare, 60, gm.at(9, hit * 0.5), 0.1, 0.32 + hit * 0.02, tight=0.002)
    for hit in range(8):
        song.note("drums", timpani, 40, gm.at(10, hit), 0.6, 0.5 + hit * 0.05, tight=0.002)
    song.note("cym", cymbal_swell, 60, gm.at(9), 4.0, 0.85)
    song.note("riser", riser, 60, gm.at(9), 4.0, 0.7)

    # ---- Race: two challenge races ---------------------------------------------
    final_bars = "B5:2 B5:1 A5:1 G5:2 E5:2 | G5:2 G5:1 F#5:1 E5:2 C5:2 | D#5:2 F#5:2 B5:4"
    for start_bar, label in ((hook_1, "Race hook (trumpet), first race"), (hook_2, "Race hook (trumpet), second race")):
        song.line("trumpet", brass, gr, start_bar, RACE_HOOK, vel=0.94, tight=0.006, voices=4, bright=1.1, label=label)
        song.line("lead", lead, gr, start_bar, RACE_HOOK, vel=0.76, tight=0.003)
        song.line("violins", strings, gr, start_bar, RACE_HOOK, vel=0.76, shift=12, tight=0.008, atk=0.03, rel=0.1)
    # The breather between the races: the counter-line alone, in the violins.
    song.line("violins", strings, gr, breather, "G5:4 E5:4 | G5:4 C6:4 | B5:4 F#5:4", vel=0.6, tight=0.01, atk=0.05, rel=0.2, label="Breather (violins)")
    song.line("trumpet", brass, gr, tail, final_bars, vel=0.96, tight=0.006, voices=4, bright=1.1, label="Race tail (trumpet)")
    song.line("lead", lead, gr, tail, final_bars, vel=0.78, tight=0.003)
    song.line("violins", strings, gr, tail, final_bars, vel=0.8, shift=12, tight=0.008, atk=0.03, rel=0.1)
    stab_prev = None
    kicks = []
    for b in range(1, race_bars + 1):
        intro = b < hook_1
        resting = breather <= b < hook_2
        chord = song.chord_at(gr, b, 0.0)
        root = chord.bass_note(low=28)
        for unit in range(8):
            song.note("bass", drive_bass, root + (12 if unit in (3, 7) else 0), gr.at(b, unit), gr.unit * 0.9, 0.62 if intro else 0.78, tight=0.004)
        if b >= hook_1 - 2:
            for beat in range(4):
                for offset, vel in ((0.0, 0.72), (1.0, 0.52), (1.5, 0.56)):
                    song.note("spiccato", strings, chord.tone_note(0, low=48), gr.at(b, beat * 2 + offset), 0.1, vel * (0.8 if intro else 1.0), pan=-0.1, tight=0.004, atk=0.006, rel=0.05, voices=4, bright=0.9)
        stab_prev = voice_lead(chord, stab_prev, 60, 76, 4)
        if not intro:
            for unit in (1, 3, 5, 7):
                for voice, pitch in enumerate(stab_prev):
                    song.note("stabs", brass, pitch, gr.at(b, unit), 0.12, 0.6 if resting else 0.72, pan=(voice - 1.5) * 0.35, tight=0.004, voices=2, bright=0.6)
        for unit in (0, 2, 4, 6):
            if intro and unit in (2, 6) and b < hook_1 - 2:
                continue
            song.note("kick", kick, 60, gr.at(b, unit), 0.2, (0.92 if unit in (0, 4) else 0.82) * (0.8 if intro else 1.0), tight=0.003)
            kicks.append(gr.at(b, unit))
        if not intro:
            for unit in (2, 6):
                song.note("snare", snare, 60, gr.at(b, unit), 0.2, 0.9, pan=0.04, tight=0.003)
        for unit in range(16):
            song.note("hats", hat, 60, gr.at(b, unit * 0.5), 0.05, (0.7 if unit % 4 == 0 else 0.5) * (0.75 if intro else 1.0), pan=0.3, tight=0.003, openness=0.8 if unit == 14 else 0.0)
        if not intro and not resting:
            for unit, vel in ((0, 0.92), (3, 0.72), (6, 0.8)):
                song.note("taiko", taiko, 39, gr.at(b, unit), 1.0, vel, tight=0.003)
            for unit in (1, 3, 5, 7):
                song.note("tamb", tambourine, 60, gr.at(b, unit), 0.1, 0.56, pan=-0.45, tight=0.004)
    # Arriving from the reveal, then the build into the first race.
    song.note("cym", crash, 60, gr.at(1), 2.5, 0.6, tight=0.001)
    for hit in range(16):
        song.note("snare", snare, 60, gr.at(hook_1 - 1, hit * 0.5), 0.1, 0.34 + hit * 0.03, tight=0.002)
    song.note("cym", cymbal_swell, 60, gr.at(hook_1 - 1), 1.5, 0.85)
    song.note("riser", riser, 60, gr.at(hook_1 - 2), 3.0, 0.65)
    for start_bar in (hook_1, hook_2):
        song.note("cym", crash, 60, gr.at(start_bar), 3.0, 1.0, tight=0.001)
        song.note("boom", boom, 28, gr.at(start_bar), 1.5, 1.0, tight=0.001)
    song.note("cym", crash, 60, gr.at(tail), 2.5, 0.8, tight=0.001)
    pitches = [64, 62, 60, 57, 55, 52, 48, 45]
    for fill_bar in (breather - 1, hook_2 - 1, tail - 1):
        for hit, pitch in enumerate(pitches):
            song.note("toms", tom, pitch, gr.at(fill_bar, 4.0 + hit * 0.5), 0.3, 0.7 + hit * 0.03, pan=-0.3 + hit * 0.09, tight=0.003)
    song.note("cym", cymbal_swell, 60, gr.at(race_bars), 1.5, 0.9)

    # ---- Reveal: awe, before the races ------------------------------------------
    song.line("violins", strings, ga, 1, "C5:3 E5:1 F5:1 G5:1 | A5:3 F5:1 E5:1 D5:1 | E5:3 C5:1 D5:1 E5:1 | D5:3 G4:1 A4:1 B4:1 | C5:6", vel=0.56, tight=0.015, atk=0.25, rel=0.4, legato=1.02, label="Reveal tune (violins, C)")
    song.line("horn_lead", brass, ga, 1, "C4:3 E4:1 F4:1 G4:1 | A4:3 F4:1 E4:1 D4:1 | E4:3 C4:1 D4:1 E4:1 | D4:3 G3:1 A3:1 B3:1 | C4:6", vel=0.54, tight=0.015, voices=3, bright=0.45, legato=1.0)
    prev_choir = None
    for b in range(1, 6):
        prev_choir = voiced_pad(ga, b, "choir", choir, 55, 72, 0.5, prev_choir, count=4, pan_spread=0.4, vowel="ah")
        for unit, length, chord in harmony_segments(song, ga, b):
            song.note("bass", bass, chord.bass_note(low=26), ga.at(b, unit), length * ga.unit, 0.5, tight=0.008)
            for u in range(int(unit), int(unit + length)):
                tone = arpeggio_tones(chord, base=62)[[0, 2, 3, 4, 5, 4][u % 6]]
                song.note("harp", harp, tone, ga.at(b, u), 2.2, 0.44, pan=-0.3 + 0.1 * u, tight=0.01)
                if u % 3 == 2:
                    song.note("bells", celesta, chord.tone_note(u % 3 + 1, low=84), ga.at(b, u), 0.4, 0.42, pan=0.3, tight=0.004)
    song.note("bells", bell, 72, ga.at(1), 2.0, 0.5, pan=0.2, tight=0.001)
    song.note("bells", bell, 76, ga.at(3), 2.0, 0.42, pan=-0.2, tight=0.001)
    for hit in range(16):
        song.note("drums", timpani, 45, ga.at(5, 3) + hit * 0.125, 0.5, 0.3 + hit * 0.03, tight=0.002)
    song.note("cym", cymbal_swell, 60, ga.at(5, 3), 2.0, 0.75)

    # ---- Finale -------------------------------------------------------------------
    song.line("flute", flute, gf, 1, VALLEY_HOOK_B, vel=0.7, tight=0.01)
    song.line("violins", strings, gf, 1, VALLEY_HOOK_B, vel=0.88, tight=0.012, atk=0.04, legato=1.05, label="Finale tune (violins, D)")
    song.line("trumpet", brass, gf, 1, VALLEY_HOOK_B, vel=0.86, shift=-12, tight=0.012, voices=4, bright=0.95)
    song.line("cellos", strings, gf, 1, VALLEY_HOOK_B, vel=0.72, shift=-12, tight=0.012, atk=0.05, legato=1.05, bright=0.85)
    pad_prev = None
    for b in range(1, 9):
        pad_prev = voiced_pad(gf, b, "pad", strings, 57, 74, 0.74, pad_prev, atk=0.12, rel=0.5, voices=5, bright=0.9)
        harp_roll(gf, b, [0, 3, 4, 5, 4, 5], 0.62)
        bass_walk(gf, b, 0.86)
        for unit in range(6):
            chord = song.chord_at(gf, b, unit)
            shape = voice_lead(chord, None, 59, 74, 3)
            if unit in (0, 3):
                song.note("lute", lute, chord.bass_note(low=48) if unit == 0 else chord.tone_note(2, low=45), gf.at(b, unit), 1.0, 0.7, pan=0.3, tight=0.008)
            for string_index, pitch in enumerate(shape):
                song.note("lute", lute, pitch, gf.at(b, unit) + 0.014 + 0.012 * string_index, 0.6, 0.45, pan=0.3, tight=0.004)
            song.note("shaker", shaker, 60, gf.at(b, unit), 0.05, 0.6 * (1.0, 0.45, 0.6, 0.85, 0.45, 0.6)[unit], pan=-0.4, tight=0.006)
        for unit in (0, 3):
            song.note("tamb", tambourine, 60, gf.at(b, unit), 0.1, 0.66, pan=0.45, tight=0.004)
            song.note("taiko", taiko, 40, gf.at(b, unit), 1.0, 0.58, tight=0.004)
        if b % 2 == 1:
            song.note("timp", timpani, song.chord_at(gf, b, 0.0).bass_note(low=38), gf.at(b, 0), 1.0, 0.72, tight=0.004)
    song.note("cym", crash, 60, gf.at(1), 3.0, 1.0, tight=0.001)
    song.note("boom", boom, 26, gf.at(1), 1.5, 0.9, tight=0.001)
    song.note("cym", crash, 60, gf.at(8), 3.0, 0.9, tight=0.001)
    song.note("timp", timpani, 38, gf.at(8), 1.6, 0.9, tight=0.002)
    for pitch, pan_value in ((74, -0.2), (81, 0.2)):
        song.note("bells", bell, pitch, gf.at(8), 1.5, 0.55, pan=pan_value, tight=0.001)

    # Clear the speech band during the two narrated passages.
    n = song.n
    t = times(n)
    dip = np.clip(np.minimum(np.minimum((t - t_valley + 0.4) / 1.2, (t_market + 0.2 - t) / 1.2), 1.0), 0.0, 1.0)
    dip = np.maximum(dip, np.clip(np.minimum(np.minimum((t - t_reveal + 0.2) / 1.5, (t_race + race_intro * 1.5 - 0.2 - t) / 1.5), 1.0), 0.0, 1.0))

    def speech_band_mask(x):
        carved = eq_chain(x, [("peak", 450.0, 0.9, -5.0), ("peak", 1100.0, 0.7, -8.0), ("peak", 2500.0, 1.0, -6.0)])
        return x * (1.0 - dip[:, None]) + carved * dip[:, None]

    # The opening is deliberately hushed: everything before the valley sits about 11 dB down.
    hush = 0.28 + 0.72 * np.clip((t - t_valley + 1.0) / 1.0, 0.0, 1.0)
    pump_gain = duck_envelope(n, kicks, depth=0.3, attack=0.004, release=0.06)
    mix = {
        "flute": dict(gain=0.5, eq=[("hp", 300.0, 0.7, 0.0), ("peak", 2600.0, 1.0, 1.5)], sends={"hall": 0.3}),
        "violins": dict(gain=0.36, eq=[("hp", 240.0, 0.7, 0.0), ("peak", 3200.0, 0.9, 2.0)], chorus=dict(rate=0.5, depth_ms=1.8, mix=0.4), sends={"hall": 0.42, "cathedral": 0.2}, width=1.15),
        "cellos": dict(gain=0.28, eq=[("hp", 90.0, 0.7, 0.0), ("lp", 5200.0, 0.7, 0.0)], sends={"hall": 0.3}),
        "horn_lead": dict(gain=0.4, eq=[("hp", 120.0, 0.7, 0.0), ("lp", 4800.0, 0.7, 0.0)], sends={"hall": 0.3, "cathedral": 0.35}),
        "trumpet": dict(gain=0.85, eq=[("hp", 180.0, 0.7, 0.0), ("peak", 2800.0, 1.0, 3.0)], comp=dict(threshold=-20.0, ratio=2.5, attack=0.012, release=0.12), sends={"hall": 0.28}),
        "lead": dict(gain=0.3, eq=[("hp", 300.0, 0.7, 0.0)], chorus=dict(rate=0.7, depth_ms=1.1, mix=0.5), sends={"plate": 0.25}),
        "stabs": dict(gain=0.2, eq=[("hp", 220.0, 0.7, 0.0), ("lp", 6000.0, 0.7, 0.0)], sends={"plate": 0.3}, width=1.4),
        "pad": dict(gain=0.15, eq=[("hp", 300.0, 0.7, 0.0), ("lp", 6500.0, 0.7, 0.0)], chorus=dict(rate=0.35, depth_ms=2.6, mix=0.6), sends={"hall": 0.42}, width=1.35),
        "spiccato": dict(gain=0.26, eq=[("hp", 110.0, 0.7, 0.0), ("hs", 7000.0, 0.7, -3.0)], sends={"plate": 0.15}),
        "harp": dict(gain=0.38, eq=[("hp", 180.0, 0.7, 0.0), ("peak", 2800.0, 1.0, 3.5)], sends={"hall": 0.34, "cathedral": 0.15}),
        "lute": dict(gain=0.3, pan=0.1, eq=[("hp", 180.0, 0.7, 0.0), ("peak", 2900.0, 1.0, 3.5)], sends={"plate": 0.22}),
        "bass": dict(gain=0.4, eq=[("hp", 36.0, 0.7, 0.0), ("lp", 2400.0, 0.7, 0.0)], comp=dict(threshold=-18.0, ratio=3.0, attack=0.008, release=0.1)),
        "pizz": dict(gain=0.32, eq=[("hp", 100.0, 0.7, 0.0)], sends={"plate": 0.25}),
        "bells": dict(gain=0.38, eq=[("hp", 500.0, 0.7, 0.0)], sends={"hall": 0.5, "cathedral": 0.25}),
        "glock": dict(gain=0.26, eq=[("hp", 800.0, 0.7, 0.0)], sends={"hall": 0.5}),
        "glass": dict(gain=0.14, eq=[("hp", 200.0, 0.7, 0.0)], chorus=dict(rate=0.3, depth_ms=3.0, mix=0.6), sends={"cathedral": 0.5}, width=1.4),
        "choir": dict(gain=0.28, eq=[("hp", 170.0, 0.7, 0.0)], chorus=dict(rate=0.25, depth_ms=3.0, mix=0.5), sends={"cathedral": 0.5}, width=1.3),
        "shaker": dict(gain=0.9, eq=[("hp", 3000.0, 0.7, 0.0)], sends={"plate": 0.15}),
        "tamb": dict(gain=1.0, eq=[("hp", 4500.0, 0.7, 0.0)], sends={"plate": 0.15}),
        "clarinet": dict(gain=0.36, pan=-0.1, eq=[("hp", 170.0, 0.7, 0.0), ("peak", 2200.0, 1.0, 2.0)], sends={"hall": 0.22}),
        "bassoon": dict(gain=0.24, pan=0.15, eq=[("hp", 120.0, 0.7, 0.0)], sends={"hall": 0.2}),
        "marimba": dict(gain=0.26, eq=[("hp", 200.0, 0.7, 0.0)], sends={"plate": 0.25}),
        "woodblock": dict(gain=0.32, sends={"plate": 0.2}),
        "kick": dict(gain=0.3, eq=[("hp", 42.0, 0.7, 0.0), ("peak", 3200.0, 1.0, 3.0)]),
        "snare": dict(gain=0.4, eq=[("hp", 150.0, 0.7, 0.0)], sends={"plate": 0.25}),
        "hats": dict(gain=1.0, eq=[("hp", 6000.0, 0.7, 0.0)]),
        "taiko": dict(gain=0.3, eq=[("hp", 48.0, 0.7, 0.0), ("peak", 1800.0, 1.0, 3.0)], sends={"hall": 0.18}),
        "toms": dict(gain=0.42, eq=[("hp", 70.0, 0.7, 0.0)], sends={"hall": 0.2}),
        "drums": dict(gain=0.32, eq=[("hp", 40.0, 0.7, 0.0)], sends={"hall": 0.2}),
        "timp": dict(gain=0.32, eq=[("hp", 40.0, 0.7, 0.0)], sends={"hall": 0.25}),
        "boom": dict(gain=0.26, eq=[("hp", 30.0, 0.7, 0.0)]),
        "cym": dict(gain=0.42, eq=[("hp", 900.0, 0.7, 0.0)], sends={"hall": 0.25}),
        "riser": dict(gain=0.32, eq=[("hp", 250.0, 0.7, 0.0)]),
        "_duck": (pump_gain, ("bass", "pad", "stabs", "spiccato", "lead")),
        "_auto": {"bus": speech_band_mask, "glass": hush, "choir": hush, "bells": hush, "glock": hush, "harp": hush, "cym": hush, "flute": hush},
    }
    return song, mix


COMPOSERS = {"valley": valley, "race": race, "victory": victory, "defeat": defeat, "film": film}


# ---------------------------------------------------------------------------
# 6. Checks and export
# ---------------------------------------------------------------------------

BANDS = [("sub 20-60", 20, 60), ("bass 60-250", 60, 250), ("low-mid 250-500", 250, 500), ("mid 500-2k", 500, 2000),
         ("upper-mid 2-4k", 2000, 4000), ("presence 4-8k", 4000, 8000), ("air 8-16k", 8000, 16000)]


def band_powers(x, start=0.0, end=None):
    """Average power in each band over [start, end] seconds, from averaged FFT frames."""
    a = int(start * SR)
    b = x.shape[0] if end is None else int(end * SR)
    mono = np.mean(x[a:b], axis=1)
    frame = 8192
    hop = 4096
    window = np.hanning(frame)
    powers = np.zeros(frame // 2 + 1, dtype=FLOAT)
    count = 0
    for i in range(0, max(1, mono.size - frame), hop):
        chunk = mono[i : i + frame]
        if chunk.size < frame:
            break
        powers += np.abs(np.fft.rfft(chunk * window)) ** 2
        count += 1
    powers /= max(1, count)
    freqs = np.fft.rfftfreq(frame, 1.0 / SR)
    return [(label, float(powers[(freqs >= lo) & (freqs < hi)].sum())) for label, lo, hi in BANDS]


def print_band_table(x, start=0.0, end=None, heading="whole track"):
    rows = band_powers(x, start, end)
    total = sum(value for _, value in rows) + 1e-12
    print(f"    spectral balance ({heading}):")
    for label, value in rows:
        share = value / total
        print(f"      {label:18s} {100.0 * share:5.1f}%  {10.0 * np.log10(share + 1e-9):6.1f} dB")


def clash_scan(song):
    """Strong-beat semitone clashes between written lines that sound together."""
    timed = {}
    for label, g, bar, events in song.lines:
        start = g.at(bar)
        notes = timed.setdefault(label, [])
        unit = 0.0
        for pitch, length in events:
            if pitch is not None:
                notes.append((start + unit * g.unit, start + (unit + length) * g.unit, pitch, (bar, unit, g)))
            unit += length
    labels = list(timed)
    flagged = 0
    for i, first in enumerate(labels):
        for second in labels[i + 1:]:
            for a_start, a_end, a_pitch, (a_bar, a_unit, a_grid) in timed[first]:
                if a_unit % (a_grid.per_bar / 2.0) != 0.0:
                    continue
                for b_start, b_end, b_pitch, _ in timed[second]:
                    if a_start < b_end and b_start < a_end and (a_pitch - b_pitch) % 12 in (1, 11):
                        flagged += 1
                        print(f"      clash: {note_name(a_pitch)} ({first}) against {note_name(b_pitch)} ({second}) at {a_start:.2f}s")
    print(f"    strong-beat semitone clashes between written lines: {flagged}")


def speech_band_share(x):
    """Fraction of the signal's power that falls between 300 Hz and 3 kHz."""
    mono = np.mean(x, axis=1)
    spec = np.abs(np.fft.rfft(mono)) ** 2
    freqs = np.fft.rfftfreq(mono.size, 1.0 / SR)
    return float(spec[(freqs >= 300.0) & (freqs < 3000.0)].sum() / (spec.sum() + 1e-12))


def stereo_correlation(x):
    left = x[:, 0] - x[:, 0].mean()
    right = x[:, 1] - x[:, 1].mean()
    return float(np.sum(left * right) / (np.sqrt(np.sum(left ** 2) * np.sum(right ** 2)) + 1e-12))


def seam_report(x):
    """Compare the wrap (last sample into first) with the music's own motion."""
    diff = np.abs(np.diff(x, axis=0))
    typical_step = float(np.quantile(diff, 0.999))
    max_step = float(diff.max())
    wrap_step = float(np.max(np.abs(x[0] - x[-1])))
    second = np.abs(np.diff(x, n=2, axis=0))
    typical_curve = float(np.quantile(second, 0.999))
    wrap_curve = float(np.max(np.abs(x[1] - 2.0 * x[0] + x[-1])))
    wrap_curve2 = float(np.max(np.abs(x[0] - 2.0 * x[-1] + x[-2])))
    head = float(np.sqrt(np.mean(x[: int(0.3 * SR)] ** 2)))
    tail = float(np.sqrt(np.mean(x[-int(0.3 * SR) :] ** 2)))
    return dict(wrap_step=wrap_step, typical_step=typical_step, max_step=max_step, wrap_curve=max(wrap_curve, wrap_curve2),
                typical_curve=typical_curve, head_rms=head, tail_rms=tail)


def ebur_measure(path):
    """Integrated loudness and true peak of a file, as measured by ffmpeg."""
    run = subprocess.run([FFMPEG, "-hide_banner", "-nostats", "-i", path, "-af", "ebur128=peak=true", "-f", "null", "-"], capture_output=True, text=True)
    text = run.stderr
    i_match = re.findall(r"I:\s*(-?\d+\.\d+) LUFS", text)
    p_match = re.findall(r"Peak:\s*(-?\d+\.\d+) dBFS", text)
    lra = re.findall(r"LRA:\s*(-?\d+\.\d+) LU", text)
    return (float(i_match[-1]) if i_match else None, float(p_match[-1]) if p_match else None, float(lra[-1]) if lra else None)


def decode(path):
    run = subprocess.run([FFMPEG, "-hide_banner", "-loglevel", "error", "-i", path, "-f", "f32le", "-ac", "2", "-ar", str(SR), "-"], capture_output=True)
    raw = np.frombuffer(run.stdout, dtype=np.float32)
    return raw.reshape(-1, 2).astype(FLOAT)


def write_wav(path, x):
    """Float32 WAV through ffmpeg's pcm_f32le demuxer, so scipy.io is not needed."""
    data = np.asarray(x, dtype=np.float32)
    args = [FFMPEG, "-hide_banner", "-loglevel", "error", "-y", "-f", "f32le", "-ar", str(SR), "-ac", "2", "-i", "-", "-c:a", "pcm_s24le", path]
    subprocess.run(args, input=data.tobytes(), check=True)


def encode(wav_path, out_path):
    if out_path.endswith(".ogg"):
        quality = str(OGG_QUALITY)
        args = ["-c:a", "libvorbis", "-q:a", quality]
    else:
        args = ["-c:a", "aac", "-b:a", M4A_BITRATE, "-movflags", "+faststart"]
    subprocess.run([FFMPEG, "-hide_banner", "-loglevel", "error", "-y", "-i", wav_path, *args, "-ar", str(SR), "-ac", "2", out_path], check=True)


def spectrogram_image(path, png_path, width=1400, height=500):
    """A mono spectrogram (log frequency) so the build-up of a track can be seen."""
    args = [FFMPEG, "-hide_banner", "-loglevel", "error", "-y", "-i", path, "-lavfi",
            f"aformat=channel_layouts=mono,showspectrumpic=s={width}x{height}:legend=1:scale=log:fscale=log:color=intensity", png_path]
    subprocess.run(args, check=True)


def describe(song):
    """Print the chord chart, melody and section map, and sanity-check the writing."""
    print(f"\n  ===== {song.name}: {song.n / SR:.2f} s, loop={song.loop} =====")
    for label, start, end, note in song.sections:
        print(f"    {start:7.2f}s - {end:7.2f}s  {label:12s} {note}")
    for grid in song.grids:
        bars = sorted(b for (gid, b) in song.chart if gid == id(grid))
        if bars:
            print(f"    chord chart from {grid.origin:.2f}s (bar: chord):")
            row = []
            for b in bars:
                entries = song.chart[(id(grid), b)]
                row.append(f"{b}:" + "/".join(s for _, s in entries))
                if len(row) == 8:
                    print("      " + "  ".join(row))
                    row = []
            if row:
                print("      " + "  ".join(row))
    for label, g, bar, events in song.lines:
        unit = 0.0
        current = bar
        pitches = [p for p, _ in events if p is not None]
        lines = []
        cell = []
        strong_total = strong_ok = 0
        flagged = []
        rhythm_cells = []
        rhythm_now = []
        for pitch, length in events:
            while unit >= g.per_bar:
                unit -= g.per_bar
                current += 1
                lines.append(" ".join(cell))
                rhythm_cells.append(tuple(rhythm_now))
                cell, rhythm_now = [], []
            token = "rest" if pitch is None else note_name(pitch)
            cell.append(f"{token}x{length:g}")
            rhythm_now.append((unit, length))
            if pitch is not None and unit % (g.per_bar / 2.0) == 0.0:
                chord = song.chord_at(g, current, unit)
                strong_total += 1
                if chord is None:
                    pass
                elif chord.has(pitch):
                    strong_ok += 1
                else:
                    flagged.append(f"bar {current} beat {unit:g}: {note_name(pitch)} over {chord.symbol}")
            unit += length
        lines.append(" ".join(cell))
        rhythm_cells.append(tuple(rhythm_now))
        print(f"    melody '{label}' (bars from {bar}):")
        for index, text in enumerate(lines):
            print(f"      {bar + index:3d}  {text}")
        if pitches:
            low, high = min(pitches), max(pitches)
            leaps = np.abs(np.diff(pitches))
            distinct = len(set(rhythm_cells))
            repeats = len(rhythm_cells) - distinct
            cadence = song.chord_at(g, current, max(unit - 1.0, 0.0))
            print(f"      range {note_name(low)}-{note_name(high)} ({high - low} semitones); largest leap {int(leaps.max()) if leaps.size else 0}; "
                  f"strong-beat chord tones {strong_ok}/{strong_total}; repeated bar rhythms {repeats}/{len(rhythm_cells)}; "
                  f"ends on {note_name(pitches[-1])} over {cadence.symbol if cadence else '?'}")
            if flagged:
                print("      non-chord strong beats (should be deliberate passing notes or suspensions):")
                for item in flagged:
                    print(f"        {item}")
    clash_scan(song)


FFMPEG = os.environ.get("KINLINGS_FFMPEG", "ffmpeg")
OGG_QUALITY = 3.0   # libvorbis quality: about 112 kbps at 48 kHz stereo
M4A_BITRATE = "64k"
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
TRACK_DEFAULTS = {
    "valley": dict(target=-15.0, ceiling=-1.3, tilt=2.0),
    "race": dict(target=-14.5, ceiling=-1.2, tilt=0.5),
    "victory": dict(target=-14.5, ceiling=-1.2, tilt=1.0),
    "defeat": dict(target=-16.0, ceiling=-1.5, tilt=1.0),
    "film": dict(target=-18.0, ceiling=-1.5, tilt=1.5),
}
M4A_TRACKS = ("valley", "race", "victory", "defeat")


def render_track(name):
    started = time.time()
    fn = COMPOSERS[name]
    song, mix = fn()
    defaults = TRACK_DEFAULTS[name]
    duck = mix.pop("_duck", None)
    automation = mix.pop("_auto", None)
    audio = song.mixdown(mix, target=defaults["target"], ceiling_db=defaults["ceiling"], duck=duck, automation=automation, tilt=defaults["tilt"])
    if not song.loop:
        fade = int(0.35 * SR)
        audio = audio.copy()
        audio[-fade:] *= np.linspace(1.0, 0.0, fade, dtype=FLOAT)[:, None]
        audio[:int(0.004 * SR)] *= np.linspace(0.0, 1.0, int(0.004 * SR), dtype=FLOAT)[:, None]
    print(f"  rendered {name} in {time.time() - started:.1f}s")
    return song, audio


def analyse(name, song, audio, ogg_path, png_path):
    print(f"\n  ----- {name}: measurements -----")
    print(f"    stem levels after mix gain (dBFS rms, peak):")
    for stem, (level, peak) in sorted(song.stem_levels.items(), key=lambda item: -item[1][0]):
        print(f"      {stem:14s} {level:7.1f}   peak {peak:6.3f}")
    print(f"    render: LUFS (internal) {lufs(audio):6.2f}, peak {20.0 * np.log10(np.max(np.abs(audio)) + 1e-9):6.2f} dBFS, "
          f"true peak {20.0 * np.log10(true_peak(audio)):6.2f} dBTP, correlation {stereo_correlation(audio):5.2f}, "
          f"silent fraction {float(np.mean(np.max(np.abs(audio), axis=1) < 1e-4)):.4f}, finite {bool(np.isfinite(audio).all())}")
    print_band_table(audio)
    print("    loudness by section (LUFS, peak dBFS, share of energy in the 300 Hz-3 kHz speech band):")
    for label, start, end, _ in song.sections:
        a, b = int(start * SR), int(end * SR)
        segment = audio[a:b]
        print(f"      {label:12s} {start:7.2f}-{end:7.2f}s  LUFS {lufs(segment):6.2f}  peak {20.0 * np.log10(np.max(np.abs(segment)) + 1e-9):6.2f}  speech band {100.0 * speech_band_share(segment):5.1f}%")
    if song.mix_gains:
        print("    stem balance by section (rms dB after mix gain, raw stems, top 6):")
        for label, start, end, _ in song.sections:
            a, b = int(start * SR), int(end * SR)
            rows = []
            for stem, buffer in song.stems.items():
                level = float(np.sqrt(np.mean((buffer[a:b] * song.mix_gains.get(stem, 1.0)) ** 2)) + 1e-9)
                rows.append((20.0 * np.log10(level), stem))
            rows.sort(reverse=True)
            print(f"      {label:12s} " + ", ".join(f"{stem} {level:.1f}" for level, stem in rows[:6]))
    if song.loop:
        # The reverb must wrap: an impulse at the very last sample has to ring into sample 0 onward.
        probe = np.zeros((song.n, 2), dtype=FLOAT)
        probe[-1, :] = 1.0
        ir = make_ir(2.5, 0.022, 1.0, "hall")
        ring = convolve(probe, ir, loop=True)
        head_energy = float(np.sum(ring[:int(2.0 * SR)] ** 2))
        tail_energy = float(np.sum(ring[int(2.0 * SR):] ** 2))
        print(f"    reverb wrap test: energy of a last-sample impulse landing in the first 2 s: {head_energy:.3f} vs {tail_energy:.6f} elsewhere (circular OK: {head_energy > 100.0 * tail_energy})")
    measured, peak, lra = ebur_measure(ogg_path)
    print(f"    ogg (ffmpeg ebur128): integrated {measured} LUFS, true peak {peak} dBTP, LRA {lra} LU, size {os.path.getsize(ogg_path) / 1e6:.2f} MB")
    decoded = decode(ogg_path)
    print(f"    decoded ogg: {decoded.shape[0]} frames vs {audio.shape[0]} rendered, peak {np.max(np.abs(decoded)):.3f}")
    if song.loop:
        seam = seam_report(audio)
        coded = seam_report(decoded)
        print(f"    seam (render): wrap step {seam['wrap_step']:.5f} vs 99.9th pct step {seam['typical_step']:.5f}, wrap curve {seam['wrap_curve']:.5f} vs {seam['typical_curve']:.5f}, head {seam['head_rms']:.3f} tail {seam['tail_rms']:.3f}")
        print(f"    seam (ogg):    wrap step {coded['wrap_step']:.5f} vs 99.9th pct step {coded['typical_step']:.5f}, wrap curve {coded['wrap_curve']:.5f} vs {coded['typical_curve']:.5f}, head {coded['head_rms']:.3f} tail {coded['tail_rms']:.3f}")
    spectrogram_image(ogg_path, png_path)
    print(f"    spectrogram: {png_path}")


def main():
    global FFMPEG
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--only", default=",".join(COMPOSERS), help="comma-separated tracks to render")
    parser.add_argument("--out", default=os.path.join(ROOT, "web", "public", "audio"), help="output directory for .ogg/.m4a")
    parser.add_argument("--work", default=None, help="directory for wav files and spectrograms (default: temp dir)")
    parser.add_argument("--check", action="store_true", help="print scores and checks without rendering audio")
    parser.add_argument("--ffmpeg", default=None, help="path to ffmpeg")
    args = parser.parse_args()
    if args.ffmpeg:
        FFMPEG = args.ffmpeg
    names = [name for name in args.only.split(",") if name]
    work = args.work or os.path.join(os.environ.get("TEMP", "."), "kinlings_music")
    os.makedirs(work, exist_ok=True)
    os.makedirs(args.out, exist_ok=True)
    for name in names:
        if args.check:
            song, _ = COMPOSERS[name]()
            describe(song)
            continue
        print(f"\n=== {name} ===")
        song, audio = render_track(name)
        describe(song)
        wav_path = os.path.join(work, f"{name}.wav")
        write_wav(wav_path, audio)
        ogg_path = os.path.join(args.out, f"{name}.ogg")
        encode(wav_path, ogg_path)
        if name in M4A_TRACKS:
            encode(wav_path, os.path.join(args.out, f"{name}.m4a"))
        analyse(name, song, audio, ogg_path, os.path.join(work, f"{name}.png"))
        _cache.clear()
        _cache_bytes[0] = 0


if __name__ == "__main__":
    main()
