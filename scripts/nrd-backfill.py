#!/usr/bin/env python3
"""Backfill DomainLab daily tables from the public WhoisDS newly-registered-domains feed.
All zones present in the feed. Tokenization mirrors segmentBaseName:
hyphen-split first, then dictionary longest-match, whole label as fallback.

Usage: nrd-backfill.py [END_DATE] [DAYS]
  END_DATE  newest date to import, YYYY-MM-DD (default: yesterday — the feed
            publishes previous full days)
  DAYS      how many days back from END_DATE (default: 3 for a nightly top-up;
            use 30 for a fresh backfill)
Already-imported dates are skipped, so re-runs and overlaps are free."""
import base64, datetime, io, json, sqlite3, subprocess, zipfile, re, sys
from collections import defaultdict

DB = "/Users/hamp/DomainScout/data/zone_index.db"
END = (datetime.date.fromisoformat(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1]
       else datetime.date.today() - datetime.timedelta(days=1))
DAYS = int(sys.argv[2]) if len(sys.argv) > 2 else 3

WORDS = set()
for w in open("/usr/share/dict/words"):
    w = w.strip().lower()
    if 2 <= len(w) <= 20 and w.isalpha():
        WORDS.add(w)

def segment(label):
    parts = [p for p in label.split("-") if p]
    out = []
    for part in parts:
        if not part.isalpha() or len(part) < 2:
            continue
        i, n = 0, len(part)
        seg = []
        while i < n:
            best = None
            for j in range(min(n, i + 20), i + 1, -1):
                cand = part[i:j]
                if len(cand) >= 3 and cand in WORDS:
                    best = cand
                    break
            if best:
                seg.append(best)
                i += len(best)
            else:
                i += 1
        out.extend(seg)
    toks = {}
    if out:
        for t in out:
            toks[t] = 1
        for a, b in zip(out, out[1:]):
            toks[f"{a} {b}"] = 2
        if len(out) >= 3:
            for a, b, c in zip(out, out[1:], out[2:]):
                toks[f"{a} {b} {c}"] = 3
    lbl = label.replace("-", "")
    if lbl and lbl not in toks:
        toks[lbl] = max(1, len(out) or 1)
    return toks

def fetch_day(d):
    b64 = base64.b64encode(f"{d}.zip".encode()).decode()
    url = f"https://www.whoisds.com/whois-database/newly-registered-domains/{b64}/nrd"
    out = subprocess.run(["curl", "-sSL", "-m", "60", url], capture_output=True)
    if out.returncode != 0 or len(out.stdout) < 1000:
        return None
    try:
        zf = zipfile.ZipFile(io.BytesIO(out.stdout))
        name = next(n for n in zf.namelist() if n.endswith(".txt"))
        return zf.read(name).decode("utf-8", "replace").splitlines()
    except Exception:
        return None

db = sqlite3.connect(DB)
db.execute("PRAGMA busy_timeout = 120000")
total_names = 0
dates_done = []
for i in range(DAYS):
    d = END - datetime.timedelta(days=i)
    ds = d.isoformat()
    exists = db.execute("SELECT 1 FROM zone_daily_new_names WHERE report_date=? LIMIT 1", (ds,)).fetchone()
    if exists:
        print(f"{ds}: already imported, skip", flush=True)
        continue
    lines = fetch_day(ds)
    if not lines:
        print(f"{ds}: feed unavailable", flush=True)
        continue
    by_zone_names = defaultdict(list)
    token_counts = defaultdict(lambda: defaultdict(lambda: [0, 1]))  # zone -> token -> [count, wc]
    for line in lines:
        dom = line.strip().lower().rstrip(".")
        if not dom or "." not in dom:
            continue
        label, _, tld = dom.partition(".")
        tld = tld.split(".")[-1] if "." in tld else tld
        if not label or not tld or not tld.isalpha():
            continue
        by_zone_names[tld].append(label)
        for tok, wc in segment(label).items():
            tc = token_counts[tld][tok]
            tc[0] += 1
            tc[1] = wc
    cur = db.cursor()
    cur.execute("BEGIN IMMEDIATE")
    n_names = 0
    for tld, labels in by_zone_names.items():
        cur.executemany(
            "INSERT OR IGNORE INTO zone_daily_new_names (tld, report_date, base_name) VALUES (?, ?, ?)",
            [(tld, ds, l) for l in labels])
        n_names += len(labels)
    for tld, toks in token_counts.items():
        cur.executemany(
            """INSERT INTO zone_daily_tokens (tld, report_date, token, word_count, reg_count)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(tld, report_date, token) DO UPDATE SET reg_count = reg_count + excluded.reg_count""",
            [(tld, ds, tok, wc, c) for tok, (c, wc) in toks.items()])
    db.commit()
    total_names += n_names
    dates_done.append(ds)
    print(f"{ds}: {n_names} names, {sum(len(t) for t in token_counts.values())} zone-tokens", flush=True)
db.close()
print(f"DONE: {len(dates_done)} dates, {total_names} names imported")
