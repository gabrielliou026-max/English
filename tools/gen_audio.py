"""Generate listening MP3s for a bank (American English, normal pace).

Usage:
  GEMINI_API_KEY=... python3 tools/gen_audio.py data/bank01.json [--force]
  python3 tools/gen_audio.py data/bank01.json --engine kokoro   # offline fallback

Engines:
  gemini  Gemini TTS (default). Dialogues use two-speaker generation (man/woman)
          so turns sound like a real conversation; the "Q:" line is read by a
          separate narrator voice.
  kokoro  Local Kokoro TTS; model files are downloaded to tools/models/.
"""
import argparse
import base64
import io
import json
import os
import time
import urllib.error
import urllib.request
import wave
from pathlib import Path

import lameenc
import numpy as np

ROOT = Path(__file__).resolve().parent.parent
SR = 24000

VOICES = {
    "gemini": {"M": "Puck", "W": "Kore", "Q": "Charon"},
    "kokoro": {"M": "am_fenrir", "W": "af_heart", "Q": "am_echo"},
}

GEMINI_MODEL = os.environ.get("GEMINI_TTS_MODEL", "gemini-3.8-flash-tts")
GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent"

KOKORO_URL = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/"
KOKORO_FILES = ["kokoro-v1.0.onnx", "voices-v1.0.bin"]


def silence(sec):
    return np.zeros(int(SR * sec), dtype=np.float32)


# ---------- Gemini ----------

class Gemini:
    def __init__(self):
        self.key = os.environ.get("GEMINI_API_KEY")
        if not self.key:
            raise SystemExit("GEMINI_API_KEY is not set")
        self.v = VOICES["gemini"]

    def _call(self, parts, speech):
        body = {
            "contents": [{"parts": parts}],
            "generationConfig": {
                "responseModalities": ["AUDIO"],
                "speechConfig": {"languageCode": "en-US", **speech},
            },
        }
        req = urllib.request.Request(
            GEMINI_URL.format(GEMINI_MODEL),
            data=json.dumps(body).encode(),
            headers={"x-goog-api-key": self.key, "Content-Type": "application/json"},
        )
        for attempt in range(6):
            try:
                with urllib.request.urlopen(req, timeout=120) as r:
                    d = json.load(r)
                data = base64.b64decode(d["candidates"][0]["content"]["parts"][0]["inlineData"]["data"])
                return self._decode(data)
            except urllib.error.HTTPError as e:
                msg = e.read().decode(errors="replace")
                if "per_day" in msg:
                    raise SystemExit("Gemini 每日額度已用完，明天再執行（已完成的音檔會自動略過）。\n" + msg[:400])
                if e.code not in (429, 500, 502, 503, 504) or attempt == 5:
                    raise SystemExit(f"Gemini TTS error {e.code}: {msg[:300]}")
            except (urllib.error.URLError, TimeoutError, KeyError):
                if attempt == 5:
                    raise
            time.sleep(2 ** (attempt + 1))

    @staticmethod
    def _decode(data):
        if data[:4] == b"RIFF":
            w = wave.open(io.BytesIO(data))
            assert w.getframerate() == SR and w.getsampwidth() == 2, "unexpected wav format"
            data = w.readframes(w.getnframes())
        return np.frombuffer(data, dtype="<i2").astype(np.float32) / 32768

    @staticmethod
    def _voice(name):
        return {"prebuiltVoiceConfig": {"voiceName": name}}

    def single(self, speaker, text):
        return self._call([{"text": text}], {"voiceConfig": self._voice(self.v[speaker])})

    def dialogue(self, turns):
        names = {"M": "Man", "W": "Woman"}
        parts = [{"text": t["t"], "speechMetadata": {"speaker": names[t["s"]]}} for t in turns]
        cfg = [{"speaker": names[s], "voiceConfig": self._voice(self.v[s])} for s in ("M", "W")]
        return self._call(parts, {"multiSpeakerVoiceConfig": {"speakerVoiceConfigs": cfg}})


# ---------- Kokoro ----------

class Kokoro:
    def __init__(self):
        from kokoro_onnx import Kokoro as K
        models = ROOT / "tools" / "models"
        models.mkdir(parents=True, exist_ok=True)
        for f in KOKORO_FILES:
            if not (models / f).exists():
                print(f"downloading {f} ...")
                urllib.request.urlretrieve(KOKORO_URL + f, models / f)
        self.tts = K(str(models / KOKORO_FILES[0]), str(models / KOKORO_FILES[1]))
        self.v = VOICES["kokoro"]

    def single(self, speaker, text):
        audio, sr = self.tts.create(text, voice=self.v[speaker], speed=1.0, lang="en-us")
        assert sr == SR
        return audio.astype(np.float32)

    def dialogue(self, turns):
        out = []
        for i, t in enumerate(turns):
            if i:
                out.append(silence(0.5))
            out.append(self.single(t["s"], t["t"]))
        return np.concatenate(out)


# ---------- build ----------

def render(engine, q):
    if "turns" in q:
        talk = [t for t in q["turns"] if t["s"] in "MW"]
        ask = [t for t in q["turns"] if t["s"] == "Q"]
        both = {t["s"] for t in talk} == {"M", "W"}
        parts = [engine.dialogue(talk) if both else engine.single(talk[0]["s"], " ".join(t["t"] for t in talk))]
        for t in ask:
            parts += [silence(0.9), engine.single("Q", t["t"])]
        return np.concatenate(parts)
    # single speaker: alternate male / female for variety
    return engine.single("M" if q["n"] % 2 else "W", q["stem"])


def spoken_text(q):
    return " ".join(t["t"] for t in q["turns"]) if "turns" in q else q["stem"]


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
    ap.add_argument("--engine", choices=["gemini", "kokoro"], default="gemini")
    ap.add_argument("--force", action="store_true", help="regenerate existing files")
    ap.add_argument("--only", help="comma-separated question numbers, e.g. 13,51")
    args = ap.parse_args()
    bank = json.loads(Path(args.bank_json).read_text("utf-8"))
    engine = Gemini() if args.engine == "gemini" else Kokoro()
    only = {int(n) for n in args.only.split(",")} if args.only else None
    for q in bank["questions"]:
        if "audio" not in q or (only and q["n"] not in only):
            continue
        out = ROOT / q["audio"]
        if out.exists() and not args.force:
            continue
        out.parent.mkdir(parents=True, exist_ok=True)
        audio = render(engine, q)
        sec = len(audio) / SR
        wps = len(spoken_text(q).split()) / sec
        out.write_bytes(to_mp3(np.concatenate([silence(0.3), audio, silence(0.3)])))
        flag = "  <-- check: unusual speaking rate" if not 1.2 <= wps <= 5.5 else ""
        print(f"{out.relative_to(ROOT)}  {sec:.1f}s  {wps:.1f} words/s{flag}", flush=True)


if __name__ == "__main__":
    main()
