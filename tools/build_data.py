"""Build js/data.js (the EXAMS object the engine reads) from the question bank.

usage: python -I tools/build_data.py
Sources (all in tools/):
  bank_*.txt   — question pool, one item per @id
  papers.txt   — which items each exam paper contains, in order
  pagemap.json — original book page → pages of the typeset edition
Item syntax:
  Q: text         multiple-choice stem         O: text   open question
  * option        correct option                A: text   model answer
  - option        wrong option                  E: text   explanation (shown after the exam)
  N: text         note about a corrected answer key (appended to the explanation)
  {p:110} / {p:110-111} in E/N/A → "გვ. 110 (ახ. 155)" — Ioseliani, original page (typeset edition page).
The script stops on any malformed item, unknown id or duplicate option, and prints a summary.
"""
import json
import re
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")
TOOLS = Path(__file__).parent
ROOT = TOOLS.parent
LETTERS = "აბგდევზ"
TITLE = "ბიოლოგიური ფსიქოლოგია"

pagemap = {int(k): v for k, v in json.loads((TOOLS / "pagemap.json").read_text(encoding="utf-8")).items()}


def new_first(p):
    q = p
    while q not in pm_keys():
        q -= 1
    return pagemap[q][1] if q != p else pagemap[p][0]


def new_last(p):
    q = p
    while q not in pm_keys():
        q += 1
    return pagemap[q][0] if q != p else pagemap[p][1]


def pm_keys():
    return pagemap.keys()


def pages(match):
    a = int(match.group(1))
    b = int(match.group(2)) if match.group(2) else a
    na, nb = new_first(a), new_last(b)
    orig = f"{a}" if a == b else f"{a}–{b}"
    new = f"{na}" if na == nb else f"{na}–{nb}"
    return f"გვ. {orig} (ახ. {new})"


def expand(text):
    return re.sub(r"\{p:(\d+)(?:-(\d+))?\}", pages, text)


def fail(msg):
    print("ERROR:", msg)
    sys.exit(1)


# ── parse the bank ─────────────────────────────────────────────
items = {}
for path in sorted(TOOLS.glob("bank_*.txt")):
    cur = None
    for no, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        line = raw.rstrip()
        if not line or line.startswith("#"):
            continue
        where = f"{path.name}:{no}"
        if line.startswith("@"):
            iid = line[1:].strip()
            if iid in items:
                fail(f"{where}: duplicate id @{iid}")
            cur = {"id": iid, "where": where, "q": [], "o": [], "a": [], "e": [], "n": [], "opts": []}
            items[iid] = cur
            continue
        if cur is None:
            fail(f"{where}: text outside an item")
        tag, _, rest = line.partition(" ")
        if line.startswith(("Q:", "O:", "A:", "E:", "N:")):
            key = line[0].lower()
            cur[key].append(line[2:].strip())
        elif tag in ("*", "-"):
            cur["opts"].append((rest.strip(), tag == "*"))
        else:
            fail(f"{where}: unrecognised line: {line[:60]}")

for iid, it in items.items():
    w = it["where"]
    if len(it["q"]) + len(it["o"]) != 1:
        fail(f"{w}: @{iid} must have exactly one Q: or O:")
    if it["q"]:
        if len(it["opts"]) < 2:
            fail(f"{w}: @{iid} has fewer than 2 options")
        if not any(c for _, c in it["opts"]):
            fail(f"{w}: @{iid} has no correct option")
        texts = [t for t, _ in it["opts"]]
        if len(set(texts)) != len(texts):
            fail(f"{w}: @{iid} has duplicate options")
        if it["a"]:
            fail(f"{w}: @{iid} is multiple-choice but has A:")
    else:
        if len(it["a"]) != 1:
            fail(f"{w}: @{iid} open question needs exactly one A:")
        if it["opts"]:
            fail(f"{w}: @{iid} open question has options")
    if len(it["e"]) > 1 or len(it["n"]) > 1:
        fail(f"{w}: @{iid} has more than one E: or N:")


def explain(it):
    parts = []
    if it["e"]:
        parts.append(expand(it["e"][0]))
    if it["n"]:
        parts.append("⚠️ გასაღების შესწორება: " + expand(it["n"][0]))
    return "<br>".join(parts) or None


# ── parse the papers ───────────────────────────────────────────
papers = []
cur = None
for no, raw in enumerate((TOOLS / "papers.txt").read_text(encoding="utf-8").splitlines(), 1):
    line = raw.strip()
    if not line or line.startswith("#"):
        continue
    if line.startswith("==="):
        f = [x.strip() for x in line[3:].split("|")]
        if len(f) != 7:
            fail(f"papers.txt:{no}: header needs 7 fields")
        cur = {"key": f[0], "group": f[1], "order": int(f[2]), "variant": f[3], "vorder": int(f[4]),
               "label": f[5], "date": f[6], "ids": []}
        papers.append(cur)
        continue
    for iid in line.split():
        if iid not in items:
            fail(f"papers.txt:{no}: unknown id {iid}")
        if iid in cur["ids"]:
            fail(f"papers.txt:{no}: {iid} repeated in {cur['key']}")
        cur["ids"].append(iid)

# ── build EXAMS ────────────────────────────────────────────────
exams = {}
used = set()
for p in papers:
    qs = []
    n_mcq = n_open = 0
    for num, iid in enumerate(p["ids"], 1):
        it = items[iid]
        used.add(iid)
        q = {"id": f"{p['key']}-{num}", "bank": iid, "num": num, "score": 1,
             "img": None, "stmts": None, "table": None, "items": [], "note": None, "explain": explain(it)}
        if it["q"]:
            n_mcq += 1
            q["type"] = "mcq"
            q["text"] = it["q"][0]
            q["choices"] = [f"{LETTERS[i]}) {t}" for i, (t, _) in enumerate(it["opts"])]
            q["answer"] = "|".join(LETTERS[i] for i, (_, c) in enumerate(it["opts"]) if c)
            q["single_answer"] = None
        else:
            n_open += 1
            q["type"] = "open"
            q["text"] = it["o"][0]
            q["choices"] = None
            q["answer"] = None
            q["single_answer"] = expand(it["a"][0])
        qs.append(q)
    minutes = round((n_mcq * 1.5 + n_open * 2) / 5) * 5
    minutes = max(minutes, 10)
    exams[p["key"]] = {
        "year": p["group"], "order": p["order"], "variant": p["variant"], "vorder": p["vorder"],
        "variantLabel": p["label"], "title": TITLE, "date": p["date"],
        "maxScore": len(qs), "duration": f"{minutes} წთ", "logo": None, "questions": qs,
    }

out = ROOT / "js" / "data.js"
body = json.dumps(exams, ensure_ascii=False, indent=1)
out.write_text(
    "// ============================================================\n"
    "// data.js — biological psychology exam questions (EXAMS)\n"
    "// Generated by tools/build_data.py from tools/bank_*.txt and tools/papers.txt.\n"
    "// Do not edit by hand: change the bank and rebuild.\n"
    "// ============================================================\n\n"
    f"const EXAMS = {body};\n",
    encoding="utf-8",
)

n_items = len(items)
unused = sorted(set(items) - used)
mcq = sum(1 for it in items.values() if it["q"])
multi = [iid for iid, it in items.items() if it["q"] and sum(c for _, c in it["opts"]) > 1]
notes = [iid for iid, it in items.items() if it["n"]]
disputed = [iid for iid, it in items.items() if it["e"] and "სადავოა" in it["e"][0]]
print(f"bank: {n_items} items ({mcq} multiple-choice, {n_items - mcq} open); papers: {len(papers)}")
for p in papers:
    e = exams[p["key"]]
    nm = sum(1 for q in e["questions"] if q["type"] == "mcq")
    print(f"  {p['key']:6} {p['group']} · {p['label']}: {nm} ტესტი + {len(e['questions']) - nm} ღია, {e['duration']}")
print("unused items:", unused or "none")
print("multi-answer:", multi)
print("key corrections (N:):", len(notes), notes)
print("disputed:", disputed)
print("written:", out, out.stat().st_size, "bytes")
