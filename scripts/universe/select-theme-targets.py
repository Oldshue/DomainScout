#!/usr/bin/env python3
"""Vendored from the MacBook universe-mining lane (select-theme-targets.py), unchanged logic.
Env contract: UNIVERSE_WORK is not read directly here (the work dir is argv[1]); UNIVERSE_WORDS
is honored transitively by the exec'd mine-universe-types.py segment (that script falls back to
server/assets/common-english.txt when unset). CODE = this script's own directory (scripts/universe),
used to locate the sibling mine-universe-types.py; W = the work dir argument, used for all
tape/probes data.
select-theme-targets.py <work_dir> [cap] : probe targets = members of rising/new themes (kit-collapsed examples are capped; re-derive
members from the tape by token carriage, up to cap per theme) + uniform sample. Writes probes/targets.txt and probes/target-meta.json (clusters = theme tokens)."""
import sys, os, re, json, random, collections
CODE = os.path.dirname(os.path.abspath(__file__))
W = sys.argv[1]; CAP = int(sys.argv[2]) if len(sys.argv) > 2 else 120; os.makedirs(f"{W}/probes", exist_ok=True)
SEGSRC = f"{CODE}/mine-universe-types.lane.py" if os.path.exists(f"{CODE}/mine-universe-types.lane.py") else f"{CODE}/mine-universe-types.py"
ns = {"__file__": SEGSRC}; exec(open(SEGSRC).read().split("# ---- universe tape ----")[0], ns); seg = ns["seg"]
tc = json.load(open(f"{W}/theme-convergence.json")); want = {r["theme"] for k in ("rising", "new") for r in tc[k]}
labels = collections.defaultdict(set)
for line in open(f"{W}/tape/adds.tsv"):
    lab, tld, _ = line.rstrip("\n").split("\t"); labels[lab].add(tld)
PREF = ["com", "net", "org", "app", "dev", "xyz", "co", "io", "ai"]
def pick_zone(zs):
    for p in PREF:
        if p in zs: return p
    return sorted(zs)[0]
members = collections.defaultdict(list)
for lab in labels:
    if not re.fullmatch(r"[a-z0-9-]{4,40}", lab): continue
    t = [x for x in seg(lab) if x != "?"]
    if len(t) < 2: continue
    for x in set(t):
        if x in want: members[x].append(lab)
random.seed(7); meta = {}
for t, labs in members.items():
    labs = sorted(set(labs)); random.shuffle(labs)
    for lab in labs[:CAP]:
        d = f"{lab}.{pick_zone(labels[lab])}"; meta.setdefault(d, {"clusters": [], "zones": sorted(labels[lab])})["clusters"].append(t)
alll = list(labels); random.shuffle(alll)
for lab in alll[:1500]:
    d = f"{lab}.{pick_zone(labels[lab])}"; meta.setdefault(d, {"clusters": [], "zones": sorted(labels[lab])})["clusters"].append("sample")
open(f"{W}/probes/targets.txt", "w").write("\n".join(sorted(meta)) + "\n"); json.dump(meta, open(f"{W}/probes/target-meta.json", "w"))
print("themes", len(members), "targets", len(meta))
