"""Fill in missing explanations with Gemini (marked as AI-generated in the app).

Usage: GEMINI_API_KEY=... python3 tools/gen_explain.py [--limit N] [--workers 4]

Results are stored in tools/explanations_ai.json ({question id: text}) and
written into data/bankNN.json as "explain" + "explain_ai": true. parse_pdf.py
merges the same file back in whenever a bank is re-parsed. Re-running skips
questions that already have an explanation.
"""
import argparse
import json
import os
import re
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
STORE = ROOT / "tools" / "explanations_ai.json"
MODEL = os.environ.get("GEMINI_TEXT_MODEL", "gemini-3.8-flash")
URL = f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent"

INSTRUCTIONS = (
    "你是 ALCPT 英文測驗的輔導老師，學生是台灣的軍職人員。請用繁體中文替下面這題寫解析，格式固定：\n"
    "1. 先列出 2–4 個重要單字或片語，每個一行，格式為「英文: 中文意思」。\n"
    "2. 最後一行以「解析：」開頭，說明題意、為什麼選正確答案（寫出「答案選X」），"
    "並指出主要干擾選項錯在哪裡（例如發音相近或字面陷阱）。\n"
    "不要改變正確答案，全部 180 字以內，不要使用 Markdown 或項目符號。\n\n"
)


def has_expl(q):
    return q.get("explain", "").strip() not in ("", "*", "-", "—")


def fmt(q):
    body = " ".join(f"{t['s']}: {t['t']}" for t in q["turns"]) if "turns" in q else q["stem"]
    opts = " / ".join(f"{k}. {v}" for k, v in q["options"].items())
    return f"題目：{body}\n選項：{opts}\n正確答案：{q['answer']}"


def examples(banks):
    """Two human-written explanations per section, used as style examples."""
    ex = {"listening": [], "reading": []}
    for b in banks:
        for q in json.loads((ROOT / b["file"]).read_text("utf-8"))["questions"]:
            if has_expl(q) and not q.get("explain_ai") and len(ex[q["section"]]) < 2 and 40 < len(q["explain"]) < 300:
                ex[q["section"]].append(q)
    return {k: "".join(f"範例\n{fmt(q)}\n{q['explain']}\n\n" for q in v) for k, v in ex.items()}


class QuotaExhausted(Exception):
    pass


def call(prompt, key, temperature):
    body = {"contents": [{"parts": [{"text": prompt}]}], "generationConfig": {"temperature": temperature}}
    req = urllib.request.Request(URL, data=json.dumps(body).encode(),
                                 headers={"x-goog-api-key": key, "Content-Type": "application/json"})
    for attempt in range(6):
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                d = json.load(r)
            return d["candidates"][0]["content"]["parts"][0]["text"].strip()
        except urllib.error.HTTPError as e:
            msg = e.read().decode(errors="replace")
            if "per_day" in msg or "PerDay" in msg:
                raise QuotaExhausted(msg[:300])
            if e.code not in (429, 500, 502, 503, 504) or attempt == 5:
                raise
        except (urllib.error.URLError, TimeoutError, KeyError):
            if attempt == 5:
                raise
        time.sleep(2 ** (attempt + 1))


def consistent(text, answer):
    """The explanation must name the right letter and no other letter as the answer."""
    picked = set(re.findall(r"(?:答案|正確答案|故|應)?選\s*[（(]?\s*([A-Da-d])\b", text))
    picked = {p.upper() for p in picked}
    return answer in picked and picked <= {answer}


def clean(text):
    text = re.sub(r"[*#`]+", "", text)             # stray markdown
    text = re.sub(r"^\s*[-•]\s*", "", text, flags=re.M)
    return re.sub(r"\n{2,}", "\n", text).strip()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0, help="stop after N new explanations")
    ap.add_argument("--workers", type=int, default=4)
    args = ap.parse_args()
    key = os.environ.get("GEMINI_API_KEY") or exit("GEMINI_API_KEY is not set")

    banks = json.loads((ROOT / "data" / "banks.json").read_text("utf-8"))
    store = json.loads(STORE.read_text("utf-8")) if STORE.exists() else {}
    ex = examples(banks)
    todo = []
    for b in banks:
        for q in json.loads((ROOT / b["file"]).read_text("utf-8"))["questions"]:
            if not has_expl(q) and q["id"] not in store:
                todo.append(q)
    if args.limit:
        todo = todo[:args.limit]
    print(f"{len(todo)} questions without explanation")

    lock = threading.Lock()
    stop = threading.Event()
    rejected = []

    def work(q):
        if stop.is_set():
            return
        prompt = INSTRUCTIONS + ex[q["section"]] + "請寫這題：\n" + fmt(q) + "\n"
        try:
            for temp in (0.3, 0.0):
                text = clean(call(prompt, key, temp))
                if consistent(text, q["answer"]):
                    break
            else:
                rejected.append(q["id"])
                return
        except QuotaExhausted as e:
            stop.set()
            print("Gemini 每日額度已用完，已儲存目前進度，明天再執行即可接續。", e)
            return
        with lock:
            store[q["id"]] = text
            if len(store) % 20 == 0:
                STORE.write_text(json.dumps(store, ensure_ascii=False, indent=1), "utf-8")
            print(q["id"], flush=True)

    with ThreadPoolExecutor(args.workers) as pool:
        list(pool.map(work, todo))
    STORE.write_text(json.dumps(dict(sorted(store.items())), ensure_ascii=False, indent=1), "utf-8")
    if rejected:
        print("answer mismatch, skipped:", rejected)
    merge(banks, store)


def merge(banks, store):
    """Write stored AI explanations into the bank files (only where none exists)."""
    for b in banks:
        path = ROOT / b["file"]
        data = json.loads(path.read_text("utf-8"))
        changed = False
        for q in data["questions"]:
            if q["id"] in store and (not has_expl(q) or q.get("explain_ai")):
                if q.get("explain") != store[q["id"]] or not q.get("explain_ai"):
                    q["explain"], q["explain_ai"] = store[q["id"]], True
                    changed = True
        if changed:
            path.write_text(json.dumps(data, ensure_ascii=False, indent=1), "utf-8")


if __name__ == "__main__":
    main()
