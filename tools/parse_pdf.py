"""Parse an ALCPT transcript PDF into a question-bank JSON file.

Usage: python3 tools/parse_pdf.py <pdf> [--out data/] [--bank NN]
"""
import argparse
import json
import re
import sys
import unicodedata
from pathlib import Path

import pymupdf

LISTENING_LAST = 60  # ALCPT: 1-60 listening, 61-100 reading


def fix_chars(text):
    # PDF uses Kangxi radicals (e.g. U+2F42 "⽂") instead of normal CJK chars.
    return "".join(
        unicodedata.normalize("NFKC", c) if 0x2E80 <= ord(c) <= 0x2FDF else c
        for c in text
    )


NOISE = re.compile(r"^(-00:00|ALCPT \(ALCPT\.aspx\).*|回上頁 \(ALCPT\.aspx\))$")
QNUM = re.compile(r"^(\d{1,3})\.\s*$")
OPT = re.compile(r"^([A-D])\.\s?(.*)$")
ANS = re.compile(r"^作答：\s*答案：\s*([A-D])\s*$")


def read_lines(pdf):
    doc = pymupdf.open(pdf)
    raw = fix_chars("\n".join(p.get_text() for p in doc))
    m = re.search(r"第\s*(\d+)\s*回", raw)
    lines = [l.strip() for l in raw.splitlines()]
    return [l for l in lines if l and not NOISE.match(l)], (m.group(1) if m else None)


def split_blocks(lines):
    blocks, cur, expect = [], None, 1
    for l in lines:
        m = QNUM.match(l)
        if m and int(m.group(1)) == expect:
            cur = {"n": expect, "lines": []}
            blocks.append(cur)
            expect += 1
        elif cur:
            cur["lines"].append(l)
    return blocks


def join(parts):
    s = " ".join(parts)
    return re.sub(r"\s+", " ", s).strip()


def parse_block(b):
    stem, opts, answer, expl, stage, key = [], {}, None, [], "stem", None
    for l in b["lines"]:
        a = ANS.match(l)
        if a:
            answer, stage = a.group(1), "expl"
            continue
        o = OPT.match(l)
        if stage in ("stem", "opts") and o and (o.group(1) == "ABCD"[len(opts)]):
            key, stage = o.group(1), "opts"
            opts[key] = [o.group(2)]
        elif stage == "stem":
            stem.append(l)
        elif stage == "opts":
            opts[key].append(l)
        else:
            expl.append(l)
    if len(opts) != 4 or not answer:
        raise ValueError(f"Q{b['n']}: could not parse options/answer: {b['lines']}")
    return stem, {k: join(v) for k, v in opts.items()}, answer, "\n".join(expl).strip()


def split_turns(text):
    """'M: ... W: ... Q: ...' -> [{'s': 'M', 't': '...'}, ...]"""
    parts = re.split(r"\b([MWQ]):\s*", text)
    turns = []
    for i in range(1, len(parts), 2):
        t = parts[i + 1].strip()
        if t:
            turns.append({"s": parts[i], "t": t})
    return turns


def categorize(n, stem, is_dialogue):
    if n <= LISTENING_LAST:
        if is_dialogue:
            return "dialogue"
        return "question" if stem.rstrip().endswith("?") else "statement"
    if stem.startswith("(文法)"):
        return "grammar"
    if len(stem) > 180:
        return "reading"
    return "vocab"


CORRECTIONS = Path(__file__).with_name("corrections.json")


def apply_corrections(q, fixes):
    def fix(text):
        for old, new in fixes:
            text = text.replace(old, new)
        return text
    q["stem"] = fix(q["stem"])
    q["options"] = {k: fix(v) for k, v in q["options"].items()}
    for t in q.get("turns", []):
        t["t"] = fix(t["t"])
    if "explain" in q:
        q["explain"] = fix(q["explain"])


def build(pdf, bank=None):
    lines, detected = read_lines(pdf)
    bank = bank or detected
    if not bank:
        sys.exit("Bank number not found in PDF; pass --bank")
    bank = f"{int(bank):02d}"
    corrections = json.loads(CORRECTIONS.read_text("utf-8")) if CORRECTIONS.exists() else {}
    questions = []
    for b in split_blocks(lines):
        stem_lines, opts, answer, expl = parse_block(b)
        n = b["n"]
        section = "listening" if n <= LISTENING_LAST else "reading"
        stem = join(stem_lines)
        is_dialogue = section == "listening" and bool(re.match(r"^[MW]:", stem))
        cat = categorize(n, stem, is_dialogue)
        q = {
            "id": f"b{bank}-{n:03d}",
            "n": n,
            "section": section,
            "cat": cat,
            "stem": re.sub(r"^\(文法\)\s*", "", stem),
            "options": opts,
            "answer": answer,
        }
        if cat == "reading":
            # keep the passage's own line breaks readable
            q["stem"] = stem
        if is_dialogue:
            q["turns"] = split_turns(stem)
        if expl:
            q["explain"] = expl
        if section == "listening":
            q["audio"] = f"audio/b{bank}/{n:03d}.mp3"
        if q["id"] in corrections:
            apply_corrections(q, corrections[q["id"]])
        questions.append(q)
    return bank, questions


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pdf")
    ap.add_argument("--out", default="data")
    ap.add_argument("--bank")
    args = ap.parse_args()
    bank, qs = build(args.pdf, args.bank)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    path = out / f"bank{bank}.json"
    path.write_text(
        json.dumps({"bank": bank, "title": f"第 {bank} 回", "questions": qs},
                   ensure_ascii=False, indent=1),
        encoding="utf-8",
    )
    counts = {}
    for q in qs:
        counts[q["cat"]] = counts.get(q["cat"], 0) + 1
    print(f"{path}: {len(qs)} questions {counts}")

    # keep data/banks.json index in sync
    index_path = out / "banks.json"
    index = json.loads(index_path.read_text("utf-8")) if index_path.exists() else []
    index = [b for b in index if b["bank"] != bank]
    index.append({"bank": bank, "title": f"第 {bank} 回", "file": f"data/bank{bank}.json",
                  "count": len(qs)})
    index.sort(key=lambda b: b["bank"])
    index_path.write_text(json.dumps(index, ensure_ascii=False, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
