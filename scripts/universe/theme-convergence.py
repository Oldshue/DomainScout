#!/usr/bin/env python3
"""Vendored from the MacBook universe-mining lane (theme-convergence.py), unchanged logic.
Env contract: UNIVERSE_WORK is not read directly here (the work dir is argv[1]);
UNIVERSE_WORDS is honored transitively by the exec'd mine-universe-types.py segment
(that script falls back to server/assets/common-english.txt when unset).
CODE = this script's own directory (scripts/universe), used to locate the sibling
mine-universe-types.py; W = the work dir argument, used for all tape/probes/artifacts data.
Theme convergence over a universe tape. A theme = a dictionary token (>=4 chars, or EXTRA vocab) carried by labels.
Independence axes per theme (kit-collapsed): distinct 7-char roots outside the token, distinct constructions (token position x
co-token shape), distinct zones, style variety, and (when rdap records exist) distinct registrars + registration days.
Convergence = geometric breadth across axes; single-root dominance is penalized. Rise = share vs the reference span.
Usage: theme-convergence.py <work_dir> [ref_work_dir] -> <work_dir>/theme-convergence.{json,txt}"""
import sys, os, re, json, math, collections, glob
CODE = os.path.dirname(os.path.abspath(__file__))
W = sys.argv[1]; R = sys.argv[2] if len(sys.argv) > 2 else None
SEGSRC = f"{CODE}/mine-universe-types.lane.py" if os.path.exists(f"{CODE}/mine-universe-types.lane.py") else f"{CODE}/mine-universe-types.py"
src = open(SEGSRC).read().split("# ---- universe tape ----")[0]
ns = {"__file__": SEGSRC}; exec(src, ns)
SHORT_OK = {"ai", "os", "gpt", "llm", "bot", "bots", "hvac", "nft", "dao", "defi", "web3", "ev", "evs", "rx", "hoa", "cbd", "crm", "erp", "seo", "vpn", "iot", "api", "saas", "esg", "kyc", "aml", "rwa", "btc", "eth", "sol", "usd", "usdc", "usdt", "stable", "quant", "agent", "agents", "agentic", "copilot", "autopilot", "claw", "molt", "humanoid", "robotics"}
FRAG = {"ther", "vice", "ista", "ment", "tion", "tions", "ness", "ally", "ling", "ting", "ring", "ance", "ence", "ious", "able", "ible", "ical", "ward", "ship", "hood", "less", "ful", "ive", "ity", "ies", "ers", "ing", "ed", "ers"}
seg, words, EXTRA, CITIES, STOP, PRODUCT_ZONES = ns["seg"], ns["words"], ns["EXTRA"], ns["CITIES"], ns["STOP"], ns["PRODUCT_ZONES"]
JUNK = re.compile(r"(bet|bahis|giris|casino|slot|toto|zoushitu|kaiji|bifen|zuqiu|shitu|jiang|caiwang|youxi|tuku|yuebi|zonghui|shijihao|xianjin|dazuozha|danji|zhibo|dianjing|lordfilm|porn|sex|xxx|escort|whatsapp|1xbet|1win)")
GENERIC = STOP | {"online", "shop", "store", "group", "digital", "tech", "media", "design", "studio", "services", "service", "solutions", "consulting", "global", "world", "home", "house", "life", "pro", "plus", "hub", "labs", "lab", "app", "apps", "net", "web", "site", "info", "news", "today", "live", "official", "team", "club", "company", "inc", "llc", "ltd", "corp", "coop", "shopping", "market", "mart", "brand", "brands", "collection", "collections", "gallery", "center", "centre", "systems", "system", "network", "networks", "project", "projects", "creative", "international", "enterprises", "enterprise", "industries", "properties", "property", "realty", "real", "estate", "foundation", "care", "health", "capital", "partners", "agency", "marketing", "ventures", "holdings", "trading", "express", "direct", "central", "point", "zone", "spot", "place", "way", "works", "wear", "style", "fashion", "beauty", "photo", "photography", "auto", "cars", "car", "food", "foods", "kitchen", "travel", "tours", "hotel", "law", "legal", "medical", "dental", "clinic", "fitness", "sports", "music", "games", "game", "gaming", "book", "books", "art", "arts", "kids", "baby", "pet", "pets", "dog", "cat", "love", "family", "wedding", "events", "event", "party", "gift", "gifts", "print", "printing", "cleaning", "repair", "construction", "builders", "roofing", "plumbing", "electric", "solar", "energy", "power", "water", "garden", "farm", "coffee", "bakery", "pizza", "grill", "bar", "cafe", "wine", "beer", "money", "cash", "pay", "finance", "financial", "loans", "credit", "insurance", "tax", "jobs", "career", "school", "academy", "learning", "training", "coach", "coaching", "church", "ministry", "bible", "god", "jesus"}
def load(d):
    labs = {}
    for line in open(f"{d}/tape/adds.tsv"):
        lab, tld, ws = line.rstrip("\n").split("\t")
        if re.fullmatch(r"[a-z0-9-]{4,40}", lab) and not lab.startswith("xn--") and not JUNK.search(lab): labs.setdefault(lab, set()).add(tld)
    return labs
def themes_of(labs, need_detail=True):
    T = collections.defaultdict(lambda: {"n": 0, "roots": collections.Counter(), "cons": collections.Counter(), "zones": collections.Counter(), "style": collections.Counter(), "ex": []})
    for lab, zs in labs.items():
        toks = [t for t in seg(lab) if t != "?"]
        if len(toks) < 2 or sum(len(t) for t in toks) < 0.75 * len(lab.replace("-", "")): continue
        for i, t in enumerate(toks):
            if (len(t) < 4 and t not in SHORT_OK) or t in FRAG: continue
            if t in GENERIC or t in CITIES or t.isdigit(): continue
            if t not in words and t not in EXTRA and t not in SHORT_OK: continue
            pos = "prefix" if i == 0 else ("suffix" if i == len(toks) - 1 else "mid")
            others = [x for j, x in enumerate(toks) if j != i]
            m = lab.replace(t, "|")
            roots = set(m[k:k+7] for k in range(0, max(1, len(m) - 6)) if "|" not in m[k:k+7] and "-" not in m[k:k+7]) or {lab}
            th = T[t]; th["n"] += 1
            for r in roots: th["roots"][r] += 1
            th["cons"][f"{pos}:{len(toks)}w:{'gen' if all(o in GENERIC for o in others) else 'spec'}"] += 1
            for o in others[:2]:
                if o not in GENERIC and o not in CITIES: th["cons"][f"co:{o}"] += 1
            for z in zs: th["zones"][z] += 1
            th["style"]["hyphen" if "-" in lab else ("digit" if re.search(r"\d", lab) else "plain")] += 1
            if len(th["ex"]) < 600: th["ex"].append(lab)
    return T
def family_members(d):
    out = set()
    try:
        U = json.load(open(f"{d}/universe-types.json"))
        for f in U.get("brandFamilies", []): out.update(f.get("members", []))
        # members lists are capped at 30 in the json; also drop labels containing any family root
        roots = [f["root"] for f in U.get("brandFamilies", []) if f.get("count", 0) >= 20]
        return out, roots
    except Exception: return out, []
L = load(W); fm, froots = family_members(W)
L = {k: v for k, v in L.items() if k not in fm and not any(r in k for r in froots)}
T = themes_of(L); n = len(L)
# probe states per label (if probed)
pstate = {}; ptitle = {}
try:
    for line in open(f"{W}/probes/results.ndjson"):
        r = json.loads(line); lab = r["domain"].split(".")[0]; pstate[lab] = r.get("state")
        if r.get("state") == "built": ptitle[lab] = f"{r['domain']} ({(r.get('title') or '')[:70]})"
except Exception: pass
ref = None
if R and os.path.exists(f"{R}/tape/adds.tsv"):
    LR = load(R); fmr, frr = family_members(R); LR = {k: v for k, v in LR.items() if k not in fmr and not any(r in k for r in frr)}
    TR = themes_of(LR); nr = len(LR); ref = {t: v["n"] for t, v in TR.items()}; refex = {t: v["ex"][:10] for t, v in TR.items()}
rd = collections.defaultdict(lambda: {"reg": set(), "days": set()}); rmeta = {}
for f in glob.glob(f"{W}/artifacts/rdap/*.json"):
    for r in json.load(open(f))["data"]["records"]:
        if r.get("registered"): rmeta[r["domain"].split(".")[0]] = (r.get("registrarId"), r["registered"][:10])
rows = []
def kit_collapse(t, mem):
    """drop members sharing a dominant 8-char substring outside the theme token (one actor's modifier sweep)"""
    sc = collections.Counter()
    for l in mem:
        for ss in set(l[k:k+8] for k in range(0, max(1, len(l) - 7)) if "-" not in l[k:k+8] and l[k:k+8] != t and not (len(t) >= 8 and l[k:k+8] in t)): sc[ss] += 1
    dropped = 0; keep = mem
    for ss, c in sc.most_common(4):
        if c >= 12 and c / max(1, len(mem)) >= 0.2:
            before = len(keep); keep = [l for l in keep if ss not in l]; dropped += before - len(keep)
    return keep, dropped
for t, v in T.items():
    if v["n"] < 12: continue
    mem, kitdrop = kit_collapse(t, v["ex"])
    if len(mem) < 12: continue
    kitshare = kitdrop / max(1, len(v["ex"]))
    cotop = v["cons"].most_common(1)[0][1] / v["n"] if any(k.startswith("co:") for k in v["cons"]) else 0
    cot = [(k[3:], c) for k, c in v["cons"].most_common(60) if k.startswith("co:")]
    cotop = (cot[0][1] / v["n"]) if cot else 0
    gridshare = sum(1 for l in mem if any(c in l for c in CITIES if len(c) >= 6)) / max(1, len(mem))
    top_root = v["roots"].most_common(1)[0][1] / v["n"] if v["roots"] else 0
    indep_roots = sum(1 for _, c in v["roots"].items() if c <= 3)  # roots that appear at most 3 times = independent-looking
    cons = sum(1 for k, c in v["cons"].items() if not k.startswith("co:")); cotok = sum(1 for k in v["cons"] if k.startswith("co:"))
    zt = sum(v["zones"].values()); pz = sum(c for z, c in v["zones"].items() if z in PRODUCT_ZONES) / max(1, zt)
    regs = set(); days = set()
    for lab in v["ex"]:
        if lab in rmeta: regs.add(rmeta[lab][0]); days.add(rmeta[lab][1])
    share = 1000 * v["n"] / n; rshare = (1000 * ref.get(t, 0) / nr) if ref else None
    rise = ((share + 0.02) / (rshare + 0.02)) if rshare is not None else None
    conv = math.log(1 + indep_roots) * math.log(1 + cons) * math.log(1 + min(cotok, 60)) * math.log(1 + len(v["zones"])) * (1 - top_root) * (1 - min(0.9, cotop)) * (1 - kitshare) * (0.3 if pz < 0.5 else 1) * (0.5 if gridshare > 0.5 else 1)
    ps = collections.Counter(pstate[l] for l in v["ex"] if l in pstate)
    built = [ptitle[l] for l in v["ex"] if l in ptitle][:6]
    rows.append({"theme": t, "labels": v["n"], "kitShareRemoved": round(kitshare, 2), "topCoTokenShare": round(cotop, 2), "cityGridShare": round(gridshare, 2), "probeStates": dict(ps), "builtMembers": built, "sharePer1000": round(share, 3), "refSharePer1000": (round(rshare, 3) if rshare is not None else None), "rise": (round(rise, 2) if rise else None),
                 "independentRoots": indep_roots, "topRootShare": round(top_root, 2), "constructions": cons, "coTokens": cotok, "zones": len(v["zones"]), "topZones": v["zones"].most_common(4), "productZoneShare": round(pz, 2),
                 "styleMix": dict(v["style"]), "registrarsSampled": len(regs), "daysSampled": len(days), "convergence": round(conv, 2), "examples": mem[:14], "olderExamples": (refex.get(t, [])[:8] if ref else []), "topCoTokens": [k[3:] for k, _ in v["cons"].most_common(40) if k.startswith("co:")][:10]})
rising = sorted([r for r in rows if (r["rise"] or 0) >= 1.3 and r["independentRoots"] >= 10], key=lambda r: -(r["convergence"] * min(r["rise"], 8)))[:110]
new = sorted([r for r in rows if r["refSharePer1000"] is not None and r["refSharePer1000"] < 0.01 and r["independentRoots"] >= 8], key=lambda r: -r["convergence"])[:40]
stable = sorted([r for r in rows if r["rise"] and 0.8 <= r["rise"] < 1.3], key=lambda r: -r["convergence"])[:40]
fading = sorted([r for r in rows if r["rise"] and r["rise"] <= 0.6 and (r["refSharePer1000"] or 0) >= 0.1], key=lambda r: r["rise"] / max(1, math.log(1 + (r["refSharePer1000"] or 0) * 100)))[:40]
json.dump({"rising": rising, "new": new, "stable": stable, "fading": fading}, open(f"{W}/theme-convergence.json", "w"), indent=1)
lines = ["THEME CONVERGENCE (themes = dictionary tokens after removing single-actor kit families and junk; independence axes = independent roots, constructions, co-tokens, zones, style; rise = share vs reference span):", "RISING CONVERGENCE:"]
def fmt(r): return f"- {r['theme']}, labels {r['labels']}, share {r['sharePer1000']} vs ref {r['refSharePer1000']}, rise x{r['rise']}, kit share removed {r['kitShareRemoved']}, top co-token share {r['topCoTokenShare']}, city-grid share {r['cityGridShare']}, independent roots {r['independentRoots']}, top-root share {r['topRootShare']}, constructions {r['constructions']}, co-tokens {r['coTokens']} (top: {' '.join(r['topCoTokens'])}), zones {r['zones']} {r['topZones']}, product-zone share {r['productZoneShare']}, style {r['styleMix']}, probe states {r['probeStates']}, built members: {' ; '.join(r.get('builtMembers', [])) or 'none probed'}, registrars/days sampled {r['registrarsSampled']}/{r['daysSampled']}, convergence {r['convergence']}, examples: {' '.join(r['examples'][:12])}, older-span examples: {' '.join(r.get('olderExamples', [])[:6])}"
lines += [fmt(r) for r in rising]; lines.append("NEW THEMES (absent from the reference span):"); lines += [fmt(r) for r in new]
lines.append("STABLE HIGH-CONVERGENCE THEMES:"); lines += [fmt(r) for r in stable]; lines.append("FADING THEMES:"); lines += [fmt(r) for r in fading]
open(f"{W}/theme-convergence.txt", "w").write("\n".join(lines)); print("themes", len(rows), "rising", len(rising), "new", len(new), "fading", len(fading)); print("\n".join(l[:200] for l in lines[:40]))
if False:
  for r in rows[:220]:
    lines.append(f"{r['theme']}, labels {r['labels']}, share {r['sharePer1000']} vs ref {r['refSharePer1000']}, rise x{r['rise']}, kit share removed {r['kitShareRemoved']}, top co-token share {r['topCoTokenShare']}, city-grid share {r['cityGridShare']}, independent roots {r['independentRoots']}, top-root share {r['topRootShare']}, constructions {r['constructions']}, co-tokens {r['coTokens']} (top: {' '.join(r['topCoTokens'])}), zones {r['zones']} {r['topZones']}, product-zone share {r['productZoneShare']}, style {r['styleMix']}, registrars/days sampled {r['registrarsSampled']}/{r['daysSampled']}, convergence {r['convergence']}, examples: {' '.join(r['examples'][:12])}, older-span examples: {' '.join(r.get('olderExamples', [])[:6])}")
open(f"{W}/theme-convergence.txt", "w").write("\n".join(lines)); print("themes", len(rows)); print("\n".join(l[:230] for l in lines[:30]))
