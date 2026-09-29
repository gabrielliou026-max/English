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

LISTENING_LAST = 60  # ALCPT: 1-60 listening, 61-100 reading (extended if dialogues run past 60)


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


# 說話者標示：PDF 中有 M:/W:、Man:/Woman:、A:/B:、W1:/W2:、「M :」等寫法
LABEL = re.compile(r"\b(Question|Man|Woman|M1|M2|W1|W2|M|W|A|B|Q)\s*:\s*")
QMARK = re.compile(r"\b(?:Question|Q)\s*:\s*")
NORMAL = {"Man": "M", "Woman": "W", "M1": "M", "W1": "W", "Question": "Q"}


def is_dialogue_stem(stem):
    m = LABEL.match(stem)
    return bool(m) and m.group(1) not in ("Q", "Question")


def split_turns(text):
    """'M: ... W: ... Q: ...' -> [{'s': 'M', 't': '...'}, ...]；s 為 M/W/M2/W2/Q"""
    parts = LABEL.split(text)
    raw = [(parts[i], parts[i + 1].strip()) for i in range(1, len(parts), 2) if parts[i + 1].strip()]
    labels = [NORMAL.get(s, s) for s, _ in raw]
    # A/B 沒有標性別：優先用對話中尚未出現的性別
    others = {s for s in labels if s not in ("A", "B", "Q")}
    pool = [g for g in ("M", "W") if g not in others] + ["M2", "W2"]
    ab = {"A": pool[0], "B": pool[1]}
    return [{"s": ab.get(s, s), "t": t} for s, (_, t) in zip(labels, raw)]


def split_question(n, stem):
    """單人陳述＋「Q:」提問 -> 說話者念前半、旁白念提問"""
    before, after = QMARK.split(stem, maxsplit=1)
    return [{"s": "M" if n % 2 else "W", "t": before.strip()}, {"s": "Q", "t": after.strip()}]


def categorize(section, stem, is_dialogue):
    if section == "listening":
        if is_dialogue:
            return "dialogue"
        return "question" if stem.rstrip().endswith("?") else "statement"
    if stem.startswith("(文法)"):
        return "grammar"
    if len(stem) > 180 or is_dialogue or QMARK.search(stem):
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
    parsed = [(b["n"], *parse_block(b)) for b in split_blocks(lines)]
    # 聽力通常是 1–60，但有些回數的對話題接續到 60 題之後（例如 61–66）
    dialogue_ns = {n for n, stem_lines, *_ in parsed if is_dialogue_stem(join(stem_lines))}
    listening_last = LISTENING_LAST
    while listening_last + 1 in dialogue_ns:
        listening_last += 1
    # 有些回數的 PDF 沒有標註（文法），無法區分文法與字彙，改標為 usage（文法・字彙）
    tagged = any(join(s).startswith("(文法)") for n, s, *_ in parsed if n > listening_last)
    questions = []
    for n, stem_lines, opts, answer, expl in parsed:
        section = "listening" if n <= listening_last else "reading"
        stem = join(stem_lines)
        is_dialogue = is_dialogue_stem(stem)
        cat = categorize(section, stem, is_dialogue)
        if section == "reading" and cat == "vocab" and not tagged:
            cat = "usage"
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
        if section == "listening" and is_dialogue:
            q["turns"] = split_turns(stem)
        elif section == "listening" and QMARK.search(stem):
            q["turns"] = split_question(n, stem)
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
                  "count": len(qs),
                  "listening": sum(q["section"] == "listening" for q in qs),
                  "reading": sum(q["section"] == "reading" for q in qs)})
    index.sort(key=lambda b: b["bank"])
    index_path.write_text(json.dumps(index, ensure_ascii=False, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
