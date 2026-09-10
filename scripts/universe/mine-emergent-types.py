#!/usr/bin/env python3
# Vendored from the proven MacBook universe-mining lane (scripts/universe/mine-emergent-types.py).
# This is the emergent name-TYPE miner over the WhoisDS newly-registered-domains corpus.
# Env contract: UNIVERSE_WORK selects the data working directory (holds nrd/, emits
#   emergent-types.json / emergent-types.txt); defaults to the current working directory.
#   UNIVERSE_WORDS overrides the dictionary word-list path; defaults to
#   server/assets/common-english.txt resolved relative to this script's checkout location.
"""Emergent name-TYPE miner over the WhoisDS newly-registered-domains corpus (all TLDs, 36 days).
Types = constructions/themes, not exact strings: prefix-token families ({token}*), suffix-token families (*{token}),
bigram themes (two consecutive dictionary words), and city+service grids. Each type is scored on breadth
(distinct labels, distinct TLDs, active days), burst share (max-day share of the window), and acceleration
(last 7 days vs prior 28 days per-day rate). Single-label multi-zone kits are collapsed to one label.
Output: emergent-types.json + emergent-types.txt (evidence rows for the governed analysis run).
"""
import zipfile, glob, re, collections, json, os, math, datetime
CODE = os.path.dirname(os.path.abspath(__file__))
S = os.environ.get('UNIVERSE_WORK') or os.getcwd()
WORDS = os.environ.get('UNIVERSE_WORDS') or os.path.join(CODE, '..', '..', 'server', 'assets', 'common-english.txt')
words = set(w for w in open(WORDS).read().split() if len(w) >= 3)
EXTRA = {"ai","os","gpt","llm","bot","bots","agent","agents","agentic","app","apps","hub","lab","labs","io","dev","ops","tech","fi","fy","ly","ify","ology","ai","claw","molt","humanoid","robotics","robot","robots","token","tokenized","stablecoin","crypto","defi","ev","evs","charger","chargers","charging","hvac","solar","battery","batteries","quote","quotes","estimate","estimates","bids","pricing","near","me","pro","pros","llc","inc","co","hq","now","today","daily","weekly","local","near","meds","rx","med","vet","dental","clinic","rehab","detox","sober","senior","seniors","care","homecare","nurse","nursing","doula","tutor","tutoring","coach","coaching","studio","studios","shop","store","mart","market","deals","sale","sales","cash","loan","loans","lend","pay","payments","wallet","vault","fund","funds","capital","invest","trade","trading","trader","quant","alpha","signal","signals","forecast","forecasts","insight","insights","intel","intelligence","memory","identity","auth","secure","security","shield","guard","watch","monitor","tracker","tracking","scan","scanner","audit","auditor","compliance","legal","law","lawyer","attorney","claims","insurance","insure","policy","permit","permits","zoning","inspection","inspector","contractor","roofing","roofer","plumber","plumbing","electric","electrician","landscaping","lawn","cleaning","cleaner","movers","moving","storage","junk","hauling","towing","detailing","wash","carwash","autobody","tire","tires","glass","windshield","fence","fencing","deck","decks","pool","pools","hvacpro","water","damage","restoration","mold","remediation","pest","control","exterminator","drain","sewer","septic","gutter","gutters","siding","painting","painter","flooring","tile","cabinet","kitchen","bath","remodel","remodeling","renovation","handyman","builder","builders","construction","concrete","paving","asphalt","excavation","grading","demolition","welding","fabrication","machining","cnc","3d","print","printing","laser","drone","drones","uav","lidar","gis","mapping","survey","surveying","geo","land","lots","acres","parcel","parcels","ranch","farm","farms","agri","agro","vineyard","winery","brewery","distillery","coffee","cafe","bakery","pizza","taco","tacos","sushi","ramen","bbq","grill","kitchen","catering","chef","meal","meals","prep","nutrition","diet","keto","fitness","gym","yoga","pilates","crossfit","boxing","mma","golf","tennis","pickleball","padel","ski","surf","dive","fishing","hunting","camp","camping","rv","boat","boats","marine","yacht","charter","charters","travel","trip","trips","tour","tours","hotel","hotels","resort","villa","villas","rental","rentals","airbnb","stay","stays","host","hosting","cloud","server","servers","node","nodes","edge","mesh","grid","chain","block","blocks","nft","dao","web3","metaverse","vr","ar","xr","game","games","gaming","esports","bet","bets","betting","casino","slot","slots","poker","lotto","lottery","win","wins","bonus","prize","prizes","reward","rewards","cashback","coupon","coupons","promo","deal","deals","discount","outlet","wholesale","supply","supplies","supplier","depot","warehouse","logistics","freight","cargo","shipping","courier","delivery","dispatch","fleet","fleets","truck","trucks","trucking","van","vans","auto","cars","car","motor","motors","dealer","dealers","autos","rent","lease","leasing","finance","financing","credit","debt","tax","taxes","1040","payroll","hr","recruit","recruiting","hire","hiring","jobs","job","career","careers","staffing","talent","interview","resume","cv","onboard","onboarding","training","learn","learning","academy","school","schools","college","university","campus","edu","course","courses","class","classes","kids","baby","mom","dad","family","pet","pets","dog","dogs","cat","cats","vet","grooming","groomer","daycare","boarding","walker","sitter","home","homes","house","houses","realty","realtor","estate","estates","property","properties","mortgage","title","escrow","hoa","condo","condos","apartment","apartments","rent","tenant","landlord","pm","manage","management","manager","admin","assistant","assist","help","helper","helpdesk","support","service","services","solutions","systems","system","platform","engine","stack","suite","kit","tool","tools","toolkit","flow","flows","pilot","copilot","autopilot","auto","automation","automate","workflow","ops","devops","mlops","aiops","secops","finops","dataops","gitops","cloudops","netops"}
CITIES = set("""newyork nyc losangeles la chicago houston phoenix philadelphia sanantonio sandiego dallas sanjose austin jacksonville fortworth columbus charlotte indianapolis sanfrancisco seattle denver nashville oklahomacity elpaso washington lasvegas boston portland louisville memphis detroit baltimore milwaukee albuquerque fresno tucson sacramento mesa kansascity atlanta omaha coloradosprings raleigh miami longbeach virginiabeach oakland minneapolis tulsa tampa arlington neworleans wichita cleveland bakersfield aurora anaheim honolulu santaana riverside corpuschristi lexington stockton henderson saintpaul stpaul cincinnati pittsburgh greensboro anchorage plano lincoln orlando irvine newark toledo durham chulavista fortwayne jerseycity stpetersburg laredo madison chandler buffalo lubbock scottsdale reno glendale gilbert winstonsalem northlasvegas norfolk chesapeake garland irving hialeah fremont boise richmond baton batonrouge spokane desmoines tacoma sanbernardino modesto fontana santaclarita birmingham oxnard fayetteville moreno huntington glendale yonkers aurora montgomery amarillo littlerock akron columbus augusta grandrapids shreveport saltlakecity huntsville mobile tallahassee grandprairie overlandpark knoxville worcester brownsville newportnews santarosa providence fortlauderdale chattanooga oceanside jackson garden cape sioux springfield peoria pembroke elgin salem lancaster corona eugene palmbay salinas pasadena fortcollins hayward pomona cary rockford alexandria escondido mckinney kansas joliet sunnyvale torrance bridgeport lakewood hollywood paterson naperville syracuse mesquite dayton savannah clarksville orange pasadena fullerton killeen frisco hampton mcallen warren bellevue westvalley columbia olathe sterling newhaven miramar waco thousandoaks cedarrapids charleston visalia topeka elizabeth gainesville thornton roseville carrollton coralsprings stamford simi concord hartford kent lafayette midland surprise denton victorville evansville santaclara abilene athens vallejo allentown norman beaumont independence murfreesboro annarbor springfield berkeley provo elmonte lansing fargo columbia downey costamesa wilmington arvada inglewood miamigardens carlsbad westminster rochester odessa manchester elgin westjordan roundrock clearwater waterbury gresham fairfield billings lowell sancarlos ventura pueblo highpoint westcovina richmond murrieta cambridge antioch templecity everett sanmateo edison boulder tuscaloosa toronto vancouver montreal calgary ottawa edmonton london manchester birmingham leeds glasgow liverpool bristol sydney melbourne brisbane perth adelaide auckland dubai singapore hongkong tokyo osaka seoul mumbai delhi bangalore bengaluru hyderabad chennai pune kolkata jakarta manila bangkok kualalumpur riyadh jeddah doha cairo lagos nairobi johannesburg capetown berlin munich hamburg frankfurt paris lyon madrid barcelona rome milan amsterdam brussels zurich geneva vienna prague warsaw stockholm oslo copenhagen helsinki dublin lisbon athens istanbul mexico mexicocity bogota lima santiago buenosaires saopaulo rio riodejaneiro""".split())
def seg(label):
    out = []; i = 0; n = len(label)
    while i < n:
        best = None
        for j in range(min(n, i + 18), i + 1, -1):
            piece = label[i:j]
            if piece in words or piece in EXTRA or piece in CITIES: best = piece; break
        if not best:
            # skip a char (unknown fragment) and keep going; mark with '?'
            k = i + 1
            while k < n and not any(label[k:m] in words or label[k:m] in EXTRA for m in range(min(n, k + 18), k + 2, -1)): k += 1
            out.append("?"); i = k; continue
        out.append(best); i += len(best)
    return out
days = sorted(glob.glob(f"{S}/nrd/*.zip"))
window_days = 7
recs = []  # (day, label, tld)
for z in days:
    day = os.path.basename(z)[:-4]
    try:
        with zipfile.ZipFile(z) as zf:
            for n in zf.namelist():
                for line in zf.open(n).read().decode("utf-8", "ignore").split("\n"):
                    dom = line.strip().lower()
                    if not dom or "." not in dom: continue
                    lab, _, tld = dom.partition(".")
                    if not re.fullmatch(r"[a-z0-9-]{4,40}", lab) or lab.startswith("xn--"): continue
                    recs.append((day, lab, tld))
    except Exception:
        pass
alldays = sorted(set(d for d, _, _ in recs)); recent = set(alldays[-window_days:]); base = set(alldays[:-window_days])
print("records", len(recs), "days", len(alldays), "recent", sorted(recent))
# collapse same label across zones on the same day to ONE (kit collapse) -> label-day set
labelday = {}
for d, lab, tld in recs: labelday.setdefault((lab, d), set()).add(tld)
# type extraction per unique (label, day)
TYPE = collections.defaultdict(lambda: {"recent": collections.Counter(), "base": collections.Counter(), "labels_recent": set(), "labels_base": set(), "tlds": collections.Counter(), "examples": collections.Counter()})
STOP = {"the", "and", "for", "com", "net", "org", "www", "online", "site", "web", "my", "your", "our", "get", "new", "best", "top", "free"}
for (lab, d), tlds in labelday.items():
    toks = [t for t in seg(lab) if t != "?"]
    if len(toks) < 2: continue
    kinds = []
    first, last = toks[0], toks[-1]
    if last not in STOP and len(last) >= 2: kinds.append(("suffix:*" + last, last))
    if first not in STOP and len(first) >= 2: kinds.append(("prefix:" + first + "*", first))
    for a, b in zip(toks, toks[1:]):
        if a not in STOP and b not in STOP and len(a) >= 3 and len(b) >= 3: kinds.append((f"theme:{a} {b}", a + b))
    if first in CITIES and len(toks) >= 2: kinds.append(("grid:{city}+" + "".join(toks[1:]), "".join(toks[1:])))
    if last in CITIES and len(toks) >= 2: kinds.append(("grid:" + "".join(toks[:-1]) + "+{city}", "".join(toks[:-1])))
    for kind, _ in set(kinds):
        T = TYPE[kind]
        if d in recent: T["recent"][d] += 1; T["labels_recent"].add(lab)
        else: T["base"][d] += 1; T["labels_base"].add(lab)
        for t in tlds: T["tlds"][t] += 1
        T["examples"][lab] += 1
PRODUCT_ZONES = {"com","net","org","co","io","ai","app","dev","us","ca","co.uk","uk","de","fr","nl","au","com.au","nz","ie","es","it","se","ch","at","be","dk","no","fi","pt","tech","cloud","systems","solutions","agency","studio","health","care","finance","capital","fund","money","legal","law","homes","house","services","pro","one","xyz"}
BULK_ZONES = {"ru","cn","com.cn","net.cn","org.cn","hl.cn","lol","icu","cam","vu","lat","sbs","cfd","top","buzz","click","monster","rest","hair","asia","casa","cc","ec.cc","vip","fun","site","online","store","shop","website","space","live","world","today","life","digital","email","press","host","page","best","bond","boats","beer","quest","cyou"}
rows = []
for kind, T in TYPE.items():
    r = sum(T["recent"].values()); b = sum(T["base"].values())
    if r < 6: continue
    rate_r = r / len(recent); rate_b = b / max(1, len(base))
    accel = (rate_r + 0.5) / (rate_b + 0.5)
    maxday = max(T["recent"].values()) / r
    active = len(T["recent"])
    breadth = len(T["labels_recent"]); zones = len(T["tlds"])
    ztot = sum(T["tlds"].values()); pshare = sum(c for t, c in T["tlds"].items() if t in PRODUCT_ZONES) / max(1, ztot)
    tok = kind.split(":", 1)[1]
    junk = (pshare < 0.35) or bool(re.search(r"(.)\1\1", tok)) or any(k in tok for k in ("bet", "casino", "slot", "toto", "film", "lordfilm", "wang", "ying", "yuan", "giris", "girisler", "whatsapp", "whatapps", "porn", "sex", "xxx", "escort"))
    hyph = sum(1 for l in T["labels_recent"] if "-" in l) / max(1, breadth)
    digits = sum(1 for l in T["labels_recent"] if re.search(r"\d", l)) / max(1, breadth)
    score = math.log(1 + breadth) * accel * (1 - maxday) * min(1, active / 4) * (0.15 if junk else 1) * (1 - 0.6 * hyph) * (1 - 0.6 * digits)
    rows.append({"type": kind, "recent7": r, "baseline28": b, "perDayRecent": round(rate_r, 1), "perDayBase": round(rate_b, 1), "accel": round(accel, 2), "maxDayShare": round(maxday, 2), "activeDays": active, "distinctLabelsRecent": breadth, "distinctZones": zones,
                 "topZones": T["tlds"].most_common(6), "productZoneShare": round(pshare, 2), "junkFlag": junk, "hyphenShare": round(hyph, 2), "digitShare": round(digits, 2), "examplesRecent": sorted(T["labels_recent"])[:16], "examplesBase": sorted(T["labels_base"])[:6], "score": round(score, 2)})
rows.sort(key=lambda x: -x["score"])
json.dump(rows[:400], open(f"{S}/emergent-types.json", "w"), indent=1)
rows = [x for x in rows if not x["junkFlag"]] + [x for x in rows if x["junkFlag"]][:12]
lines = [f"{x['type']}, last7 {x['recent7']} ({x['perDayRecent']}/day) vs prior {x['baseline28']} ({x['perDayBase']}/day), accel x{x['accel']}, max-day share {x['maxDayShare']}, active days {x['activeDays']}/7, distinct labels {x['distinctLabelsRecent']}, zones {x['distinctZones']} top {x['topZones']}, product-zone share {x['productZoneShare']}, hyphen share {x['hyphenShare']}, digit share {x['digitShare']}{', JUNK-FLAGGED' if x['junkFlag'] else ''}, recent examples: {' '.join(x['examplesRecent'][:14])}, earlier examples: {' '.join(x['examplesBase'][:5])}" for x in rows[:170]]
open(f"{S}/emergent-types.txt", "w").write("\n".join(lines))
print("types scored", len(rows)); print("\n".join(lines[:40]))
