#!/usr/bin/env python3
# Vendored from the proven MacBook universe-mining lane (scripts/universe/mine-universe-types.py).
# This is the name-TYPE miner over the CZDS universe tape (tape/adds.tsv).
# Env contract: UNIVERSE_WORK selects the data working directory (holds tape/adds.tsv,
#   tape/zones.json, optional tape-ref/*.tsv or nrd-ref/*.zip; emits universe-types.json,
#   universe-types.txt, tape/summary.json); defaults to the current working directory.
#   UNIVERSE_WORDS overrides the dictionary word-list path; defaults to
#   server/assets/common-english.txt resolved relative to this script's checkout location.
"""Name-TYPE miner over the UNIVERSE tape (tape/adds.tsv: label, tld, window_start from CZDS zone diffs).
Types: prefix families ({token}*), suffix families (*{token}), bigram themes, city grids. Kit collapse: one label
registered across many zones counts once; brand-root families (same >=7-char root, >=6 members) are flagged.
Reference rate = WhoisDS 28-day cut (share per 1000 registrations) so acceleration is share-vs-share, not count-vs-count.
Outputs universe-types.json / universe-types.txt (evidence rows for the governed classifier runs) + tape/summary.json."""
import re, collections, json, os, math, zipfile, glob, sys
CODE = os.path.dirname(os.path.abspath(__file__))
S = os.environ.get('UNIVERSE_WORK') or os.getcwd()
exec(open(f"{CODE}/mine-emergent-types.py").read().split("def seg(label)")[0].split("words = set")[0])  # nothing; keep imports
WORDS = os.environ.get('UNIVERSE_WORDS') or os.path.join(CODE, '..', '..', 'server', 'assets', 'common-english.txt')
words = set(w for w in open(WORDS).read().split() if len(w) >= 3)
src = open(f"{CODE}/mine-emergent-types.py").read()
EXTRA = eval(src.split("EXTRA = ")[1].split("\nCITIES")[0])
CITIES = eval(src.split("CITIES = ")[1].split("\ndef seg")[0])
def seg(label):
    out = []; i = 0; n = len(label)
    while i < n:
        best = None
        for j in range(min(n, i + 18), i + 1, -1):
            piece = label[i:j]
            if piece in EXTRA or piece in CITIES or (piece in words and (len(piece) >= 4 or j - i == n - i)): best = piece; break
        if not best:
            k = i + 1
            while k < n and not any(label[k:m] in words or label[k:m] in EXTRA for m in range(min(n, k + 18), k + 2, -1)): k += 1
            out.append("?"); i = k; continue
        out.append(best); i += len(best)
    return out
STOP = {"the", "and", "for", "com", "net", "org", "www", "online", "site", "web", "my", "your", "our", "get", "new", "best", "top", "free"}
PRODUCT_ZONES = eval(src.split("PRODUCT_ZONES = ")[1].split("\n")[0])
def kinds_of(lab):
    toks = [t for t in seg(lab) if t != "?"]
    if len(toks) < 2 or sum(len(t) for t in toks) < 0.75 * len(lab.replace("-", "")): return [], toks
    kinds = []; first, last = toks[0], toks[-1]
    if last not in STOP and len(last) >= 2: kinds.append("suffix:*" + last)
    if first not in STOP and len(first) >= 2: kinds.append("prefix:" + first + "*")
    for a, b in zip(toks, toks[1:]):
        if a not in STOP and b not in STOP and len(a) >= 3 and len(b) >= 3: kinds.append(f"theme:{a} {b}")
    if first in CITIES: kinds.append("grid:{city}+" + "".join(toks[1:]))
    if last in CITIES: kinds.append("grid:" + "".join(toks[:-1]) + "+{city}")
    return list(set(kinds)), toks
ok = re.compile(r"[a-z0-9-]{4,40}")
REF_LABELS = []
def ref_label_iter(): return REF_LABELS
# ---- universe tape ----
labels = collections.defaultdict(set)   # label -> zones
window = {}
total = 0; per_zone = collections.Counter()
for line in open(f"{S}/tape/adds.tsv"):
    lab, tld, ws = line.rstrip("\n").split("\t")
    total += 1; per_zone[tld] += 1
    if not ok.fullmatch(lab) or lab.startswith("xn--"): continue
    labels[lab].add(tld); window[tld] = ws
print("universe adds", total, "labels", len(labels), file=sys.stderr)
# ---- reference: prior universe tapes (tape-ref/*.tsv, label\ttld\twindow) if present, else WhoisDS prior 28 days ----
ref = collections.Counter(); ref_labels = 0
for rf in sorted(glob.glob(f"{S}/tape-ref/*.tsv")):
    seen = set()
    for l in open(rf):
        lab = l.split("\t")[0]
        if ok.fullmatch(lab) and lab not in seen: seen.add(lab)
    ref_labels += len(seen); REF_LABELS.extend(seen)
    for lab in seen:
        ks, _ = kinds_of(lab)
        for k in ks: ref[k] += 1
for z in ([] if ref_labels else sorted(glob.glob(f"{S}/../../4ac022e1-dfcf-443c-bba5-d3087db576b5/scratchpad/nrd/*.zip") + glob.glob(f"{S}/nrd-ref/*.zip"))[-29:-1]):
    seen = set()
    with zipfile.ZipFile(z) as zf:
        for n in zf.namelist():
            for l in zf.open(n).read().decode("utf-8", "ignore").split("\n"):
                d = l.strip().lower(); lab = d.partition(".")[0]
                if not ok.fullmatch(lab) or lab in seen: continue
                seen.add(lab)
    ref_labels += len(seen); REF_LABELS.extend(seen)
    for lab in seen:
        ks, _ = kinds_of(lab)
        for k in ks: ref[k] += 1
print("reference labels", ref_labels, file=sys.stderr)
# ---- types over the universe ----
T = collections.defaultdict(lambda: {"n": 0, "labels": [], "zones": collections.Counter(), "kits": 0})
roots = collections.defaultdict(list)
for lab, zs in labels.items():
    ks, toks = kinds_of(lab)
    for k in ks:
        t = T[k]; t["n"] += 1; t["labels"].append(lab)
        for z in zs: t["zones"][z] += 1
        if len(zs) >= 3: t["kits"] += 1
    pass
rows = []
for k, t in T.items():
    n = t["n"]
    if n < 8: continue
    share = 1000 * n / max(1, len(labels)); rshare = 1000 * ref[k] / max(1, ref_labels)
    accel = (share + 0.05) / (rshare + 0.05)
    zt = sum(t["zones"].values()); pshare = sum(c for z, c in t["zones"].items() if z in PRODUCT_ZONES) / max(1, zt)
    tok = k.split(":", 1)[1]
    junk = (pshare < 0.35) or bool(re.search(r"(.)\1\1", tok)) or bool(re.search(r"(bet|bahis|giris|casino|slot|toto|zoushitu|kaiji|bifen|zuqiu|shitu|jiang|caiwang|youxi|tuku|yuebi|zonghui|shijihao|xianjin|dazuozha|danji|lordfilm|porn|sex|xxx|escort|whatsapp|1xbet|1win)", tok)) or any(x in tok for x in ("film", "wang", "ying", "yuan"))
    labs = t["labels"]
    hyph = sum(1 for l in labs if "-" in l) / n; digits = sum(1 for l in labs if re.search(r"\d", l)) / n
    # actor concentration: share of labels sharing the most common 7+char root
    sc = collections.Counter(); ttoks = [x for x in re.split(r"[^a-z0-9]+", tok.replace("{city}", "")) if x]
    for l in labs:
        m = l
        for x in ttoks: m = m.replace(x, "|")
        subs = set(m[i:i+7] for i in range(0, max(1, len(m) - 6)) if "|" not in m[i:i+7] and "-" not in m[i:i+7])
        for ss in subs: sc[ss] += 1
    topsub, topn = sc.most_common(1)[0] if sc else ("", 0); conc = topn / n
    kindw = 1.6 if k.startswith("theme:") or k.startswith("grid:") else 1.0
    score = kindw * math.log(1 + n) * min(accel, 8) * (1 - conc) * (0.25 if conc > 0.5 else 1) * (0.15 if junk else 1) * (1 - 0.6 * hyph) * (1 - 0.6 * digits)
    rows.append({"type": k, "count": n, "sharePer1000": round(share, 2), "refSharePer1000": round(rshare, 2), "accel": round(accel, 2), "distinctZones": len(t["zones"]), "topZones": t["zones"].most_common(6), "productZoneShare": round(pshare, 2), "kitLabels": t["kits"], "rootConcentration": round(conc, 2), "dominantSubstring": topsub, "junkFlag": junk, "hyphenShare": round(hyph, 2), "digitShare": round(digits, 2), "examples": sorted(labs)[:24], "score": round(score, 2)})
rows.sort(key=lambda x: -x["score"])
subc = collections.Counter()
for lab in labels:
    if len(lab) < 9: continue
    for ss in set(lab[i:i+9] for i in range(0, len(lab) - 8)): subc[ss] += 1
cand = sorted([ss for ss, c in subc.items() if c >= 6 and not re.search(r"(.)\1\1", ss)], key=lambda x: -subc[x])[:4000]
cs = set(cand)
refsub = collections.Counter()
for z in ref_label_iter():
    if len(z) < 9: continue
    for ss in set(z[i:i+9] for i in range(0, len(z) - 8)):
        if ss in cs: refsub[ss] += 1
BIGWORDS = [w for w in words if len(w) >= 9]
def dictish(ss):
    if ss in words: return True
    if any(ss in w for w in BIGWORDS): return True
    for i in range(3, 7):
        if ss[:i] in words and ss[i:] in words: return True
    return False
members = collections.defaultdict(list)
for lab in labels:
    if len(lab) < 9: continue
    for ss in set(lab[i:i+9] for i in range(0, len(lab) - 8)):
        if ss in cs: members[ss].append(lab)
assigned = set(); fams = []
JUNKRE = re.compile(r"(bet|bahis|giris|casino|slot|toto|zoushitu|kaiji|bifen|zuqiu|shitu|jiang|caiwang|youxi|tuku|yuebi|zonghui|shijihao|xianjin|dazuozha|danji|lordfilm|porn|sex|xxx|escort|whatsapp|1xbet|1win)")
for ss in cand:
    if dictish(ss) or (refsub[ss] / max(1, ref_labels)) > 0.3 * (subc[ss] / max(1, len(labels))) + 3 / max(1, ref_labels): continue
    mem = sorted(l for l in members[ss] if l not in assigned)
    if len(mem) < 6: continue
    zs = collections.Counter(z for l in mem for z in labels[l]); zt = sum(zs.values())
    pz = sum(c for z, c in zs.items() if z in PRODUCT_ZONES) / max(1, zt)
    dig = sum(1 for l in mem if re.search(r"\d", l)) / len(mem)
    if JUNKRE.search(ss) or sum(1 for l in mem[:20] if JUNKRE.search(l)) >= 6 or pz < 0.4 or dig > 0.5: continue
    assigned.update(mem); fams.append((ss, mem))
fams.sort(key=lambda x: -len(x[1]))
json.dump({"rows": rows[:800], "brandFamilies": [{"root": r, "members": v[:30], "count": len(v)} for r, v in fams[:200]]}, open(f"{S}/universe-types.json", "w"), indent=1)
json.dump({"totalAdds": total, "distinctLabels": len(labels), "zones": per_zone.most_common(), "window": window, "referenceLabels": ref_labels}, open(f"{S}/tape/summary.json", "w"), indent=1)
keep = [x for x in rows if not x["junkFlag"]] + [x for x in rows if x["junkFlag"]][:15]
lines = [f"{x['type']}, universe count {x['count']} ({x['sharePer1000']} per 1000 adds) vs prior-28d reference {x['refSharePer1000']} per 1000, accel x{x['accel']}, zones {x['distinctZones']} top {x['topZones']}, product-zone share {x['productZoneShare']}, cross-zone kit labels {x['kitLabels']}, root concentration {x['rootConcentration']}, hyphen share {x['hyphenShare']}, digit share {x['digitShare']}{', JUNK-FLAGGED' if x['junkFlag'] else ''}, examples: {' '.join(x['examples'][:18])}" for x in keep[:260]]
open(f"{S}/universe-types.txt", "w").write("\n".join(lines))
print("types", len(rows), "families", len(fams)); print("\n".join(lines[:25]))
