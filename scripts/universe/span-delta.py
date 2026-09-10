#!/usr/bin/env python3
# Vendored from the proven MacBook universe-mining lane (scripts/universe/span-delta.py).
# Span-over-span delta comparing two universe-tape WORK directories by name TYPE.
# Env contract: WORK directories are passed as positional args (older_dir, newer_dir, out.txt),
#   each holding tape/adds.tsv + tape/zones.json (produced by mine-universe-types.py runs).
#   This script execs the vendored mine-universe-types.py from its own checkout dir (CODE) to
#   reuse kinds_of()/PRODUCT_ZONES; UNIVERSE_WORDS still governs that exec's segmentation if set.
"""Span-over-span delta: compare two universe tapes (adds.tsv) by name TYPE share per 1000 and by zone.
Usage: span-delta.py <older_dir> <newer_dir> <out.txt>   (dirs hold tape/adds.tsv, tape/zones.json)"""
import sys, os, json, collections, re
CODE = os.path.dirname(os.path.abspath(__file__))
old, new, out = sys.argv[1:4]
src = open(f"{CODE}/mine-universe-types.py").read().split("# ---- universe tape ----")[0]
ns = {"__file__": f"{CODE}/mine-universe-types.py"}; exec(src, ns); kinds_of = ns["kinds_of"]
ok = re.compile(r"[a-z0-9-]{4,40}")
def load(d):
    labs = {}; days = {}
    z = json.load(open(f"{d}/tape/zones.json"))
    for line in open(f"{d}/tape/adds.tsv"):
        lab, tld, ws = line.rstrip("\n").split("\t")
        if ok.fullmatch(lab) and not lab.startswith("xn--"): labs.setdefault(lab, set()).add(tld)
    return labs, z
L1, Z1 = load(old); L2, Z2 = load(new)
PRODUCT_ZONES = ns["PRODUCT_ZONES"]
JUNKRE = re.compile(r"(bet|bahis|giris|casino|slot|toto|zoushitu|kaiji|bifen|zuqiu|shitu|jiang|caiwang|youxi|tuku|yuebi|zonghui|shijihao|xianjin|dazuozha|danji|zhibo|dianjing|lordfilm|porn|sex|xxx|escort|whatsapp|1xbet|1win|shit|wang|ian\b|jin\b)")
def types(labs):
    c = collections.Counter(); ex = collections.defaultdict(list); zc = collections.defaultdict(collections.Counter); mem = collections.defaultdict(list)
    for lab, zs in labs.items():
        ks, _ = kinds_of(lab)
        for k in ks:
            c[k] += 1
            if len(ex[k]) < 8: ex[k].append(lab)
            if len(mem[k]) < 400: mem[k].append(lab)
            for z in zs: zc[k][z] += 1
    return c, ex, zc, mem
C1, E1, Z1c, M1 = types(L1); C2, E2, Z2c, M2 = types(L2)
def junk(k, zc, mem):
    tok = k.split(":", 1)[1]
    zt = sum(zc.values()); pz = sum(v for z, v in zc.items() if z in PRODUCT_ZONES) / max(1, zt)
    if pz < 0.35 or JUNKRE.search(tok) or re.search(r"(.)\1\1", tok): return True
    return sum(1 for l in mem[:40] if JUNKRE.search(l)) >= 14
def kit(k, mem):
    tok = k.split(":", 1)[1]; ttoks = [x for x in re.split(r"[^a-z0-9]+", tok.replace("{city}", "")) if x]
    sc = collections.Counter()
    for l in mem:
        m = l
        for x in ttoks: m = m.replace(x, "|")
        for ss in set(m[i:i+7] for i in range(0, max(1, len(m) - 6)) if "|" not in m[i:i+7] and "-" not in m[i:i+7]): sc[ss] += 1
    return (sc.most_common(1)[0][1] / max(1, len(mem))) if sc else 0
n1, n2 = len(L1), len(L2)
rows = []
for k in set(C1) | set(C2):
    a, b = C1.get(k, 0), C2.get(k, 0)
    if a + b < 40: continue
    s1, s2 = 1000 * a / n1, 1000 * b / n2
    ratio = (s2 + 0.02) / (s1 + 0.02)
    rows.append((k, a, b, round(s1, 3), round(s2, 3), round(ratio, 2)))
junkrows = []; clean = []
for r in rows:
    k = r[0]
    if junk(k, Z2c[k] if C2.get(k) else Z1c[k], M2[k] if C2.get(k) else M1[k]): junkrows.append(r); continue
    conc = kit(k, M2[k]) if C2.get(k, 0) >= 20 else 0
    clean.append(r + (round(conc, 2), len(Z2c[k])))
up = sorted([r for r in clean if r[5] >= 1.5 and r[2] >= 30 and r[6] < 0.5], key=lambda r: -r[5] * (r[2] ** 0.5))[:70]
kits = sorted([r for r in clean if r[5] >= 1.5 and r[2] >= 30 and r[6] >= 0.5], key=lambda r: -r[2])[:25]
down = sorted([r for r in clean if r[5] <= 0.6 and r[1] >= 30], key=lambda r: r[5] * (r[1] ** 0.5))[:40]
jup = sorted([r for r in junkrows if r[5] >= 2 and r[2] >= 100], key=lambda r: -r[2])[:15]
lines = [f"SPAN DELTA: older span {n1} distinct labels vs newer span {n2}. THE TWO SPANS HAVE DIFFERENT LENGTHS (older window is longer), so raw counts are NOT comparable and a lower newer count is NOT a contraction; only the per-1000-label shares and the ratio (newer share / older share) and the per-day zone rates are comparable.",
         "RISING TYPES (type, older count, newer count, older share, newer share, ratio, newer examples):"]
lines += [f"- {k}, {a}, {b}, {s1}, {s2}, x{r}, zones {nz}, kit-concentration {cc}, {' '.join(E2.get(k, [])[:6])}" for k, a, b, s1, s2, r, cc, nz in up]
lines.append("RISING SINGLE-ACTOR KITS (same fields; one registrant's modifier sweep, collapsed):")
lines += [f"- {k}, {a}, {b}, {s1}, {s2}, x{r}, zones {nz}, kit-concentration {cc}, {' '.join(E2.get(k, [])[:5])}" for k, a, b, s1, s2, r, cc, nz in kits]
lines.append("JUNK WAVES (pinyin lottery/stream, betting, casino kits - report as zone pollution only):")
lines += [f"- {k}, {a}, {b}, x{r}, {' '.join(E2.get(k, [])[:3])}" for k, a, b, s1, s2, r in jup]
lines.append("FADING TYPES (type, older count, newer count, older share, newer share, ratio, older examples):")
lines += [f"- {k}, {a}, {b}, {s1}, {s2}, x{r}, {' '.join(E1.get(k, [])[:6])}" for k, a, b, s1, s2, r, cc, nz in down]
# zone-level: adds per day
zl = []
for t in set(Z1) | set(Z2):
    a = Z1.get(t, {}); b = Z2.get(t, {})
    if a.get("status") != "ok" or b.get("status") != "ok": continue
    import datetime as dt
    def days(z, end): 
        try: return max(1, (dt.date.fromisoformat(end) - dt.date.fromisoformat(z["window_start"])).days)
        except: return 1
    da = days(a, b["window_start"]); db = days(b, "2026-09-02")
    ra, rb = a["adds"] / da, b["adds"] / db
    if a["adds"] + b["adds"] >= 400: zl.append((t, round(ra), round(rb), round((rb + 1) / (ra + 1), 2), a["drops"], b["drops"]))
zl.sort(key=lambda x: -x[3])
lines.append("ZONE ADDS PER DAY (zone, older span adds/day, newer span adds/day, ratio, older drops, newer drops) — top accelerating:")
lines += [f"- .{t}, {ra}, {rb}, x{r}, {d1}, {d2}" for t, ra, rb, r, d1, d2 in zl[:25]]
lines.append("— top decelerating:")
lines += [f"- .{t}, {ra}, {rb}, x{r}, {d1}, {d2}" for t, ra, rb, r, d1, d2 in sorted(zl, key=lambda x: x[3])[:15]]
open(out, "w").write("\n".join(lines)); print("delta rows", len(up), len(down), "zones", len(zl))
