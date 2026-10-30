"""Original, reproducible notification sound proposals; standard-library DSP only.

Writes stereo PCM masters and optional MP3 listening copies. No third-party
recordings, network services, or application settings are used.
"""

from __future__ import annotations

import argparse
from array import array
import json
import math
from pathlib import Path
import random
import shutil
import subprocess
import sys
import wave


RATE = 48_000
TAU = 2 * math.pi


def attack(t: float, seconds: float) -> float:
    return math.sin(min(t / seconds, 1.0) * math.pi / 2) ** 2


def tine(t: float, hz: float) -> float:
    modulation = 1.15 * math.exp(-t / 0.075) * math.sin(TAU * hz * 2.0 * t)
    return attack(t, 0.008) * (
        math.sin(TAU * hz * t + modulation) * math.exp(-t / 0.32)
        + 0.15 * math.sin(TAU * hz * 2.002 * t) * math.exp(-t / 0.15)
        + 0.06 * math.sin(TAU * hz * 3.0 * t) * math.exp(-t / 0.085)
    )


def wood(t: float, hz: float) -> float:
    return attack(t, 0.0025) * (
        math.sin(TAU * hz * t) * math.exp(-t / 0.15)
        + 0.24 * math.sin(TAU * hz * 3.98 * t) * math.exp(-t / 0.045)
        + 0.055 * math.sin(TAU * hz * 9.7 * t) * math.exp(-t / 0.016)
    )


def glass(t: float, hz: float) -> float:
    modes = ((1.0, 1.0, 0.43), (2.756, 0.17, 0.25), (5.404, 0.04, 0.11))
    return attack(t, 0.0045) * sum(
        amplitude * math.sin(TAU * hz * ratio * t) * math.exp(-t / decay)
        for ratio, amplitude, decay in modes
    )


def warm(t: float, hz: float) -> float:
    carrier = (
        math.sin(TAU * hz * t)
        + 0.18 * math.sin(TAU * hz * 1.0018 * t)
        + 0.23 * math.sin(TAU * hz * 2 * t) * math.exp(-t / 0.25)
        + 0.06 * math.sin(TAU * hz * 3 * t) * math.exp(-t / 0.12)
    )
    return attack(t, 0.014) * carrier * math.exp(-t / 0.38)


def bubble(t: float, hz: float) -> float:
    # A rounded, falling pitch gives a water-drop impression without samples.
    phase = TAU * (hz * t + hz * 0.85 * 0.027 * (1 - math.exp(-t / 0.027)))
    return attack(t, 0.0035) * math.exp(-t / 0.105) * (
        math.sin(phase + 0.22 * math.sin(phase * 2) * math.exp(-t / 0.04))
        + 0.035 * math.sin(phase * 3)
    )


VOICES = {"tine": tine, "wood": wood, "glass": glass, "warm": warm, "bubble": bubble}


def synthesize(duration: float, notes: list[tuple], room: float):
    length = round(RATE * duration)
    left = array("d", [0.0]) * length
    right = array("d", [0.0]) * length
    rng = random.Random(20261030)
    for kind, start, hz, amplitude, pan, sustain in notes:
        offset = round(start * RATE)
        count = min(length - offset, round(sustain * RATE))
        voice = VOICES[kind]
        pan_left = math.cos((pan + 1) * math.pi / 4)
        pan_right = math.sin((pan + 1) * math.pi / 4)
        noise = 0.0
        for index in range(count):
            t = index / RATE
            sample = voice(t, hz)
            if kind == "wood":
                noise = noise * 0.66 + rng.uniform(-1, 1) * 0.34
                sample += noise * 0.10 * attack(t, 0.001) * math.exp(-t / 0.012)
            # Smoothly end each finite modal voice, even for shorter samples.
            tail = min(1.0, (count - 1 - index) / (RATE * 0.045))
            sample *= amplitude * math.sin(max(0, tail) * math.pi / 2) ** 2
            left[offset + index] += sample * pan_left
            right[offset + index] += sample * pan_right

    dry_left = array("d", left)
    dry_right = array("d", right)
    for delay, gain in ((0.023, 0.28), (0.061, 0.18), (0.119, 0.10), (0.197, 0.055)):
        samples = round(delay * RATE)
        for index in range(samples, length):
            left[index] += dry_right[index - samples] * gain * room
            right[index] += dry_left[index - samples] * gain * room

    # Equalize active-signal RMS for comparison, with generous peak headroom.
    energy = 0.0
    active = 0
    peak = 0.0
    for a, b in zip(left, right):
        level = max(abs(a), abs(b))
        peak = max(peak, level)
        if level > 0.003:
            energy += (a * a + b * b) / 2
            active += 1
    rms = math.sqrt(energy / max(active, 1))
    gain = min(0.085 / max(rms, 1e-9), 0.50 / max(peak, 1e-9))
    pcm = array("h")
    for index, (a, b) in enumerate(zip(left, right)):
        ending = min(1.0, (length - 1 - index) / (RATE * 0.055))
        gain_here = gain * math.sin(max(0, ending) * math.pi / 2) ** 2
        pcm.extend((round(a * gain_here * 32767), round(b * gain_here * 32767)))
    return pcm


PROPOSALS = [
    {
        "id": "01-soft-duet", "name": "轻柔双音", "duration": 1.45,
        "character": "两声柔和上行，简洁、清楚，作为默认款的候选。", "room": 0.7,
        "notes": [("tine", 0.035, 659.255, 0.72, -0.13, 0.95),
                  ("tine", 0.255, 880.0, 0.64, 0.13, 1.12)],
    },
    {
        "id": "02-wooden-taps", "name": "木质轻敲", "duration": 1.20,
        "character": "三次短促木质敲击，干净、低调，尾音较短。", "room": 0.35,
        "notes": [("wood", 0.035, 391.995, 0.82, -0.15, 0.65),
                  ("wood", 0.195, 523.251, 0.75, 0.0, 0.65),
                  ("wood", 0.365, 659.255, 0.70, 0.15, 0.75)],
    },
    {
        "id": "03-glass-chimes", "name": "清透风铃", "duration": 1.95,
        "character": "带轻微空间尾音的清透铃声，完成感更鲜明。", "room": 1.0,
        "notes": [("glass", 0.035, 783.991, 0.65, -0.18, 1.70),
                  ("glass", 0.205, 1046.502, 0.31, 0.18, 1.60)],
    },
    {
        "id": "04-warm-chord", "name": "温暖和弦", "duration": 1.85,
        "character": "低一些的电钢琴式和弦，圆润、平静。", "room": 0.9,
        "notes": [("warm", 0.035, 261.626, 0.45, -0.18, 1.65),
                  ("warm", 0.065, 329.628, 0.35, 0.02, 1.62),
                  ("warm", 0.100, 391.995, 0.32, 0.18, 1.59),
                  ("warm", 0.115, 523.251, 0.16, -0.03, 1.56)],
    },
    {
        "id": "05-soft-bubbles", "name": "软糯气泡", "duration": 1.05,
        "character": "两颗轻弹气泡，圆润、活泼，呼应小曦软团形象。", "room": 0.25,
        "notes": [("bubble", 0.035, 410.0, 0.8, -0.10, 0.62),
                  ("bubble", 0.245, 615.0, 0.7, 0.10, 0.68)],
    },
    {
        "id": "06-little-finish", "name": "完成小乐句", "duration": 2.05,
        "character": "四音上行的小乐句，完成一轮时更有轻量庆祝感。", "room": 0.7,
        "notes": [("tine", 0.035, 523.251, 0.60, -0.16, 0.85),
                  ("tine", 0.205, 659.255, 0.55, -0.05, 0.85),
                  ("tine", 0.375, 783.991, 0.53, 0.06, 0.85),
                  ("tine", 0.625, 1046.502, 0.47, 0.16, 1.25)],
    },
]


def write_wave(path: Path, pcm: array):
    output = array("h", pcm)
    if sys.byteorder != "little":
        output.byteswap()
    with wave.open(str(path), "wb") as handle:
        handle.setparams((2, 2, RATE, 0, "NONE", "not compressed"))
        handle.writeframes(output.tobytes())


def write_mp3(ffmpeg: str, path: Path):
    subprocess.run(
        [ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-i", str(path),
         "-codec:a", "libmp3lame", "-b:a", "160k", str(path.with_suffix(".mp3"))],
        check=True,
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output", type=Path,
        default=Path(__file__).resolve().parents[1] / "docs/assets/pomodoro-sounds-20261030",
    )
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    ffmpeg = shutil.which("ffmpeg")
    comparison = array("h")
    silence = array("h", [0]) * round(0.80 * RATE) * 2
    manifest = {
        "date": "2026-10-30",
        "source": "Original procedural synthesis; no third-party samples.",
        "status": "Candidates for user selection; not connected to the application.",
        "sample_rate_hz": RATE, "channels": 2, "pcm_bits": 16,
        "comparison_gap_seconds": 0.80, "proposals": [],
    }
    for proposal in PROPOSALS:
        pcm = synthesize(proposal["duration"], proposal["notes"], proposal["room"])
        path = args.output / f'{proposal["id"]}.wav'
        write_wave(path, pcm)
        if ffmpeg:
            write_mp3(ffmpeg, path)
        if comparison:
            comparison.extend(silence)
        comparison.extend(pcm)
        entry = {key: proposal[key] for key in ("id", "name", "duration", "character")}
        entry["peak_dbfs"] = round(20 * math.log10(max(abs(x) for x in pcm) / 32768), 2)
        entry["wav"] = path.name
        if ffmpeg:
            entry["mp3"] = path.with_suffix(".mp3").name
        manifest["proposals"].append(entry)
        print(json.dumps(entry, ensure_ascii=False))
    comparison_path = args.output / "00-all-versions.wav"
    write_wave(comparison_path, comparison)
    if ffmpeg:
        write_mp3(ffmpeg, comparison_path)
    (args.output / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8",
    )


if __name__ == "__main__":
    main()
