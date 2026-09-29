"""Generate listening MP3s for a bank with Kokoro TTS (American English voices).

Usage: python3 tools/gen_audio.py data/bank01.json [--force]

Model files are downloaded to tools/models/ on first run (not committed).
"""
import argparse
import json
import urllib.request
from pathlib import Path

import lameenc
import numpy as np
from kokoro_onnx import Kokoro

ROOT = Path(__file__).resolve().parent.parent
MODELS = ROOT / "tools" / "models"
MODEL_URL = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/"
FILES = ["kokoro-v1.0.onnx", "voices-v1.0.bin"]

MALE, FEMALE, NARRATOR = "am_michael", "af_heart", "am_fenrir"
SPEED = 1.0  # normal speaking rate
SR = 24000


def ensure_models():
    MODELS.mkdir(parents=True, exist_ok=True)
    for f in FILES:
        p = MODELS / f
        if not p.exists():
            print(f"downloading {f} ...")
            urllib.request.urlretrieve(MODEL_URL + f, p)
    return Kokoro(str(MODELS / FILES[0]), str(MODELS / FILES[1]))


def silence(sec):
    return np.zeros(int(SR * sec), dtype=np.float32)


def segments(q):
    """[(voice, text, pause_before_sec)]"""
    if "turns" in q:
        voice = {"M": MALE, "W": FEMALE, "Q": NARRATOR}
        return [(voice[t["s"]], t["t"], 0.9 if t["s"] == "Q" else 0.5) for t in q["turns"]]
    # single speaker: alternate male / female for variety
    return [(MALE if q["n"] % 2 else FEMALE, q["stem"], 0)]


def to_mp3(samples):
    enc = lameenc.Encoder()
    enc.set_bit_rate(48)
    enc.set_in_sample_rate(SR)
    enc.set_channels(1)
    enc.set_quality(2)
    pcm = (np.clip(samples, -1, 1) * 32767).astype(np.int16).tobytes()
    return enc.encode(pcm) + enc.flush()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("bank_json")
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()
    bank = json.loads(Path(args.bank_json).read_text("utf-8"))
    tts = ensure_models()
    for q in bank["questions"]:
        if "audio" not in q:
            continue
        out = ROOT / q["audio"]
        if out.exists() and not args.force:
            continue
        out.parent.mkdir(parents=True, exist_ok=True)
        parts = [silence(0.3)]
        for voice, text, pause in segments(q):
            if pause:
                parts.append(silence(pause))
            audio, sr = tts.create(text, voice=voice, speed=SPEED, lang="en-us")
            assert sr == SR
            parts.append(audio.astype(np.float32))
        parts.append(silence(0.3))
        out.write_bytes(to_mp3(np.concatenate(parts)))
        print(out.relative_to(ROOT))


if __name__ == "__main__":
    main()
