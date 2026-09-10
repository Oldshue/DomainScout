#!/usr/bin/env python3
"""Vendored from the MacBook universe-mining lane (theme-trajectory.py), unchanged logic.
Env contract: UNIVERSE_WORK is not read directly here (the span work dir is argv[1] and each
day work dir is a positional arg); UNIVERSE_WORDS is honored transitively by the exec'd
mine-universe-types.py segment (that script falls back to server/assets/common-english.txt
when unset). CODE = this script's own directory (scripts/universe), used to locate the
sibling mine-universe-types.py; W = the span work dir argument, used for theme-convergence
and theme-trajectory data.
theme-trajectory.py <span_work_dir> <label> <day_work_dir>... -> <span_work_dir>/theme-trajectory.txt
Per theme token (rising+new from the span's theme-convergence.json), count carrying labels per day tape (same tokenization as
theme-convergence: dictionary tokens after kit/junk filtering). Days whose tape lacks .com are labelled partial."""
import sys, os, re, json, collections
CODE = os.path.dirname(os.path.abspath(__file__))
W = sys.argv[1]; days = sys.argv[2:]
SEGSRC = f"{CODE}/mine-universe-types.lane.py" if os.path.exists(f"{CODE}/mine-universe-types.lane.py") else f"{CODE}/mine-universe-types.py"
ns = {"__file__": SEGSRC}; exec(open(SEGSRC).read().split("# ---- universe tape ----")[0], ns); seg = ns["seg"]
tc = json.load(open(f"{W}/theme-convergence.json")); toks = [r["theme"] for k in ("rising", "new") for r in tc[k]]; want = set(toks)
JUNK = re.compile(r"(bet|bahis|giris|casino|slot|toto|porn|sex|xxx|escort|1xbet|1win)")
def count(d):
    c = collections.Counter(); n = 0; com = 0
    for line in open(f"{d}/tape/adds.tsv"):
        lab, tld, _ = line.rstrip("\n").split("\t"); n += 1; com += (tld == "com")
        if not re.fullmatch(r"[a-z0-9-]{4,40}", lab) or lab.startswith("xn--") or JUNK.search(lab): continue
        t = [x for x in seg(lab) if x != "?"]
        if len(t) < 2 or sum(len(x) for x in t) < 0.75 * len(lab.replace("-", "")): continue
        for x in set(t):
            if x in want: c[x] += 1
    return c, n, com
out = []; per = {}
for d in days:
    c, n, com = count(d); per[d] = (c, n, com); out.append(f"DAY {os.path.basename(d)}: adds {n}, .com adds {com}{' (PARTIAL: no .com in this tape)' if com == 0 else ''}")
out.append("THEME TRAJECTORY (theme, then per day: labels carrying the token and share per 1000 adds; ranking by span convergence):")
for t in toks:
    cells = ", ".join(f"{os.path.basename(d)}: {per[d][0][t]} ({1000*per[d][0][t]/max(1,per[d][1]):.2f}/k)" for d in days)
    out.append(f"- {t}, {cells}")
open(f"{W}/theme-trajectory.txt", "w").write("\n".join(out)); print("\n".join(out[:8]))
