'use strict';

/**
 * Live trends index over the live-sites observations (server/live-sites.js +
 * the near-live CT journal): which keywords builders are launching real sites
 * on, counted by INDEPENDENT operators, with rise, clusters, an Emerging lens,
 * builders-vs-registrations stages and display-only end-user sales context.
 *
 * Inputs (all on the data volume, never fetched):
 *   <universeDir>/<day>/sites/observations(.partial).jsonl + ct-launches.jsonl
 *   <universeDir>/<day>/tape/adds.tsv   (universe zone adds = registrations)
 * Cache (per day, incremental): <cacheDir>/sites/<day>.json holds the extracted
 * per-site terms plus the byte offset read from each journal, so a growing
 * journal is only read from where it was last read. <cacheDir>/regs/<day>.json
 * holds that day's registration term counts (built once per tape).
 *
 * Two keyword sources are kept separate: `domain` (words inside the domain
 * label, segmented with the universe themes miner's segmenter: common-english
 * words + the miner's EXTRA/CITIES vocabulary) and `text` (title + description
 * + page text words and adjacent two-word phrases, stop words removed,
 * lowercased, exact forms: "agent" and "agents" stay distinct).
 *
 * Sales are display-only: they never enter any score, rank, stage or flag.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const readline = require('readline');
const { isPublishable, createRateLimiter, clientKey } = require('./live-sites-feed');
const langs = require('./live-trends-lang');

const PATH = '/api/public/live-trends';
const VERSION = 'live-trends-v2';
// Registration term caches depend only on domain segmentation (unchanged).
const REG_VERSION = 'live-trends-reg-v2';
const LEXICON_VERSION = 'live-trends-lexicon-v1';
const MAX_REG_ODD_TERMS = 500000;
const MAX_LEXICON_TERMS = 500000;
// Registration history: a term present on >= 60% of 30+ history days, about
// once a day or more, and not growing (latest month vs earliest < 2x) is
// established vocabulary, not emerging.
const HISTORY_MIN_DAYS = 30;
const HISTORY_MIN_PRESENCE = 0.6;
const HISTORY_MAX_GROWTH = 2;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const CT_JOURNAL = 'ct-launches.jsonl';
const SPAN_DAYS = 14;
const WINDOWS = { '7d': 7, '14d': 14 };
const SOURCES = ['all', 'domain', 'text'];
const KINDS = ['all', 'emerging', 'trending', 'biggest', 'clusters'];
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const RISE_RECENT_DAYS = 3;
const RISE_PRIOR_DAYS = 7;
// Minimum distinct operators in the last 3 days before a rise is computed at
// all, so 1 -> 3 is never "trending".
const RISE_MIN_RECENT = 4;
// Coverage: a day counts only when it has data (>= COVERAGE_MIN_DAY_OPERATORS
// independent operators and >= COVERAGE_MIN_DAY_FRACTION of the median day),
// so zone gaps are excluded instead of counted as zeros. Rise is computed on
// SHARE of each window's operators, so near-live CT volume cannot inflate it.
const COVERAGE_MIN_DAY_OPERATORS = 3;
const COVERAGE_MIN_DAY_FRACTION = 0.2;
const RISE_MIN_COVERED_RECENT = 2;
const RISE_MIN_COVERED_PRIOR = 3;
const RISE_MIN_WINDOW_OPERATORS = 10;
const STAGE_FALLING_RISE = 0.7;
const STAGE_FORMING_RISE = 1;
const TRENDING_MIN_RISE = 1.5;
// A term with independent operators in several languages (same Latin-script
// token, recent activity in each) is global and gets a ranking boost.
const GLOBAL_MIN_LANG_OPS = 2;
const GLOBAL_MIN_LANGS = 2;
const GLOBAL_BOOST_PER_LANG = 0.25;
const GLOBAL_BOOST_MAX = 1.75;
const LATIN_TERM = /^[\p{Script=Latin}\p{N} ]+$/u;

/** Global flag and boost from per-language operator counts [{lang, operators, recent}]. */
function globalSignal(term, languages) {
  if (!LATIN_TERM.test(term)) return { global: false, boost: 1 };
  const strong = (languages || []).filter(l => l.operators >= GLOBAL_MIN_LANG_OPS && l.recent >= 1);
  if (strong.length < GLOBAL_MIN_LANGS) return { global: false, boost: 1 };
  return { global: true, boost: Math.min(GLOBAL_BOOST_MAX, 1 + GLOBAL_BOOST_PER_LANG * (strong.length - 1)) };
}
const REG_RISE_MIN = 6;
const MAX_TEXT_UNIGRAMS = 60;
const MAX_TEXT_BIGRAMS = 40;
const TEXT_MAX_CHARS = 3000;
const EXAMPLES = 5;
const SALES_DAYS = 90;
const SALES_RECENT = 5;
const MAX_REG_LABELS = 3000000;
const CLUSTER_CANDIDATES = 300;
const CLUSTER_MAX_MEMBERS = 10;
const CLUSTER_MIN_STRENGTH = 0.3;
const CLUSTER_TERMS_PER_OPERATOR = 60;

const FRONTIER_TERMS = Object.freeze(['ai', 'agent', 'agents', 'agentic', 'compute', 'inference', 'robot', 'robots', 'robotics', 'model', 'models', 'gpu', 'gpus', 'llm', 'llms']);

// Domain-label stop list: exactly the universe miner's STOP set.
const DOMAIN_STOP = new Set(['the', 'and', 'for', 'com', 'net', 'org', 'www', 'online', 'site', 'web', 'my', 'your', 'our', 'get', 'new', 'best', 'top', 'free']);

const TEXT_STOP = new Set(`a about above after again against all am an and any are as at be because been before being below between both but by can could did do does doing down during each few for from further had has have having he her here hers herself him himself his how i if in into is it its itself just me more most my myself no nor not now of off on once only or other our ours ourselves out over own same she should so some such than that the their theirs them themselves then there these they this those through to too under until up very was we were what when where which while who whom why will with would you your yours yourself yourselves also us may might must get got via per etc vs one two new www http https com html amp nbsp don doesn didn isn aren wasn weren won wouldn shouldn couldn ll ve re let lets yet ever every within without upon onto across along around among`.split(/\s+/).filter(Boolean));
// Web boilerplate that every site carries (navigation, legal, cookie banners).
const WEB_STOP = new Set(`home page menu login log sign signin signup register account cart search skip content main navigation nav toggle close open click here contact privacy policy terms conditions cookie cookies accept reject rights reserved copyright powered website site welcome email subscribe newsletter follow loading javascript enable browser back next previous submit send faq`.split(/\s+/).filter(Boolean));

const GENERIC_TITLES = new Set(['home', 'homepage', 'welcome', 'index', 'untitled', 'document', 'loading', 'website', 'mywebsite', 'mysite', 'reactapp', 'viteapp', 'vitereact', 'vitereactts', 'createnextapp', 'nextjs', 'dashboard', 'login', 'signin', 'comingsoon', 'underconstruction', 'app', 'myapp', 'newsite', 'test', 'blog']);

// End-user only: auction, drop-catch, closeout and wholesale venues never count.
const NON_END_USER_VENUE_RE = /namejet|snapnames|dropcatch|godaddy|dynadot|namecheap|porkbun|park\.io|catched|auction|closeout|wholesale|expired|backorder/i;

function requestError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

// ── Vocabulary: the universe themes miner's segmentation dictionary ─────────
let _vocab = null;
function minerVocabulary() {
  if (_vocab) return _vocab;
  const words = new Set();
  const common = new Map();
  const extra = new Set();
  const cities = new Set();
  try {
    const list = fs.readFileSync(path.join(__dirname, 'assets', 'common-english.txt'), 'utf8').split(/\s+/).filter(Boolean);
    list.forEach((word, i) => {
      const w = word.toLowerCase();
      if (!common.has(w)) common.set(w, i + 1);
      if (w.length >= 3) words.add(w);
    });
  } catch { /* degrade to EXTRA only */ }
  try {
    const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'universe', 'mine-emergent-types.py'), 'utf8');
    const extraSrc = src.split('EXTRA = ')[1].split('\nCITIES')[0];
    for (const m of extraSrc.matchAll(/"([^"]+)"/g)) extra.add(m[1]);
    const citySrc = /CITIES = set\("""([\s\S]*?)"""/.exec(src);
    if (citySrc) for (const c of citySrc[1].split(/\s+/)) if (c) cities.add(c);
  } catch { /* miner absent: dictionary only */ }
  // Adapter vocabulary (as the candidates theme source passes via extraWords):
  // frontier terms must segment as whole tokens or they can never trend.
  for (const w of FRONTIER_TERMS) extra.add(w);
  try { for (const w of require('./sale-watch-candidate-theme-source').SALE_TAPE_VOCABULARY) extra.add(w); } catch { /* optional */ }
  _vocab = { words, common, extra, cities };
  return _vocab;
}

/** Port of scripts/universe/mine-universe-types.py seg(): greedy longest match, '?' for unknown runs. */
function segChunk(label, v) {
  const greedy = segGreedy(label, v);
  if (!greedy.includes('?')) return greedy;
  // Greedy longest-match can strand a remainder (computeriver -> computer|?);
  // a full-coverage split over the same vocabulary wins when one exists.
  const full = segFull(label, v);
  return full || greedy;
}

function segFull(label, v) {
  const n = label.length;
  if (n > 40) return null;
  const ok = piece => v.extra.has(piece) || v.cities.has(piece) || (v.words.has(piece) && piece.length >= 3);
  const best = Array(n + 1).fill(null);
  best[n] = { words: [], cost: 0 };
  for (let i = n - 1; i >= 0; i--) {
    for (let j = i + 2; j <= Math.min(n, i + 18); j++) {
      const piece = label.slice(i, j);
      if (!best[j] || !ok(piece)) continue;
      const cost = best[j].cost + 1 + (piece.length <= 3 ? 0.5 : 0);
      if (!best[i] || cost < best[i].cost) best[i] = { words: [piece, ...best[j].words], cost };
    }
  }
  return best[0] ? best[0].words : null;
}

/** Greedy pieces of a label: known words, and the unknown runs between them (kept as text). */
function segPieces(label, v) {
  const out = [];
  const n = label.length;
  let i = 0;
  const known = piece => v.words.has(piece) || v.extra.has(piece);
  while (i < n) {
    let best = null;
    for (let j = Math.min(n, i + 18); j > i + 1; j--) {
      const piece = label.slice(i, j);
      if (v.extra.has(piece) || v.cities.has(piece) || (v.words.has(piece) && (piece.length >= 4 || j === n))) { best = piece; break; }
    }
    if (!best) {
      let k = i + 1;
      while (k < n) {
        let hit = false;
        for (let m = Math.min(n, k + 18); m > k + 2; m--) { if (known(label.slice(k, m))) { hit = true; break; } }
        if (hit) break;
        k += 1;
      }
      out.push({ text: label.slice(i, k), unknown: true });
      i = k;
      continue;
    }
    out.push({ text: best, unknown: false });
    i += best.length;
  }
  return out;
}

function segGreedy(label, v) {
  return segPieces(label, v).map(p => (p.unknown ? '?' : p.text));
}

/**
 * Out-of-vocabulary terms in a registered label (mcp, saas, gpt, and the
 * compound with an adjacent known word: chat+gpt = chatgpt), so the
 * registration history counts neologisms instead of losing them as '?'.
 */
function unknownTerms(label) {
  const v = minerVocabulary();
  const out = new Set();
  for (const chunk of String(label || '').toLowerCase().split(/[^a-z]+/)) {
    if (!chunk) continue;
    const pieces = segPieces(chunk, v);
    pieces.forEach((piece, i) => {
      if (!piece.unknown) return;
      const r = piece.text;
      if (r.length < 2 || r.length > 15) return;
      out.add(r);
      const prev = pieces[i - 1];
      const next = pieces[i + 1];
      if (r.length <= 5 && prev && !prev.unknown && prev.text.length + r.length <= 15) out.add(prev.text + r);
      if (r.length <= 5 && next && !next.unknown && r.length + next.text.length <= 15) out.add(r + next.text);
    });
  }
  return out;
}

/** Token sequence of a domain label ('?' marks unknown runs; hyphens/digits split). */
function segmentDomainLabel(label) {
  const v = minerVocabulary();
  const out = [];
  const chunks = String(label || '').toLowerCase().split(/[^a-z]+/);
  chunks.forEach((chunk, index) => {
    if (!chunk) return;
    if (out.length && index > 0) out.push('?');
    out.push(...segChunk(chunk, v));
  });
  while (out[0] === '?') out.shift();
  while (out[out.length - 1] === '?') out.pop();
  return out;
}

const isDomainWord = t => t !== '?' && t.length >= 2 && !DOMAIN_STOP.has(t);

/**
 * Domain keyword entries [term, role, partner] from a segmented label: each
 * known word with its role (head = last word, modifier = earlier word, solo =
 * one-word name) and partners, plus adjacent two-word phrases.
 */
function domainEntries(seq) {
  const words = (seq || []).filter(isDomainWord);
  const entries = [];
  words.forEach((term, i) => {
    const role = words.length === 1 ? 'solo' : i === words.length - 1 ? 'head' : 'modifier';
    const partners = words.filter((_, j) => j !== i);
    if (!partners.length) entries.push([term, role, null]);
    for (const p of partners) entries.push([term, role, p]);
  });
  for (let i = 0; i + 1 < (seq || []).length; i++) {
    if (isDomainWord(seq[i]) && isDomainWord(seq[i + 1])) entries.push([`${seq[i]} ${seq[i + 1]}`, null, null]);
  }
  return entries;
}

const PHRASE_SPLIT = /[.,;:!?|·•–—()[\]{}"<>/\\\n\r\t#*=+_~@。、，．！？：；「」『』【】]+/u;

function textSource(title, description, text) {
  return [title, description, text].filter(Boolean).map(String).join(' . ').slice(0, TEXT_MAX_CHARS);
}

/**
 * A keyword token in any language or script: starts with a letter, 2-24
 * characters, not a stop word of any common web language, not web boilerplate.
 */
function isKeywordToken(token) {
  const n = [...token].length;
  return n >= 2 && n <= 24 && /^\p{L}[\p{L}\p{M}\p{N}ー]*$/u.test(token)
    && !TEXT_STOP.has(token) && !WEB_STOP.has(token) && !langs.isStopWord(token) && !langs.WEB_STOP_INTL.has(token);
}

/**
 * Exact-form words and adjacent two-word phrases from title + description +
 * page text, in every language: stop words of every common web language are
 * removed, Latin tokens are diacritic-folded (fur, cafe), other scripts kept.
 */
function textTerms(title, description, text) {
  const source = textSource(title, description, text);
  const uni = new Set();
  const bi = new Set();
  for (const phrase of source.split(PHRASE_SPLIT)) {
    let prev = null;
    for (const token of langs.tokenize(phrase)) {
      if (!isKeywordToken(token)) { prev = null; continue; }
      if (uni.size < MAX_TEXT_UNIGRAMS) uni.add(token);
      if (prev && bi.size < MAX_TEXT_BIGRAMS) bi.add(`${prev} ${token}`);
      prev = token;
    }
    if (uni.size >= MAX_TEXT_UNIGRAMS && bi.size >= MAX_TEXT_BIGRAMS) break;
  }
  return [...uni, ...bi];
}

/** Dominant language of a site from its title, description and text (null = unknown). */
function siteLanguage(record) {
  return langs.detectLanguage(textSource(record.title, record.description, record.text));
}

/** Text keyword entries: phrases give their words a role (first = modifier, second = head). */
function textEntries(terms) {
  const entries = [];
  const roled = new Set();
  for (const term of terms || []) {
    const space = term.indexOf(' ');
    if (space === -1) continue;
    const a = term.slice(0, space);
    const b = term.slice(space + 1);
    entries.push([term, null, null], [a, 'modifier', b], [b, 'head', a]);
    roled.add(a); roled.add(b);
  }
  for (const term of terms || []) if (!term.includes(' ') && !roled.has(term)) entries.push([term, null, null]);
  return entries;
}

function normTitle(title, label) {
  let t = String(title || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
  if (label && label.length >= 3) t = t.split(label).join(' ');
  return t.replace(/[^a-z0-9]+/g, '');
}

/**
 * Keys linking sites run by one operator: the same label in several zones, a
 * numbered series (shop1, shop2 -> shop#), the same non-generic title, and the
 * same template fingerprint. Sites sharing any key collapse to one operator.
 */
function operatorKeys(record) {
  const domain = String(record.domain || '').toLowerCase();
  const dot = domain.indexOf('.');
  const label = dot > 0 ? domain.slice(0, dot) : domain;
  const keys = [`l:${label}`];
  if (/\d/.test(label)) {
    const series = label.replace(/\d+/g, '#');
    if (series.replace(/[#-]/g, '').length >= 2) keys.push(`n:${series}`);
  }
  const nt = normTitle(record.title, label);
  if (nt.length >= 6 && !GENERIC_TITLES.has(nt)) keys.push(`t:${nt}`);
  const fp = record.fingerprint;
  if (fp && typeof fp.skeleton === 'string' && fp.skeleton && typeof fp.title === 'string') {
    const ft = fp.title.replace(/\{(?:name|domain)\}/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '');
    if (ft.length >= 4 && !GENERIC_TITLES.has(ft)) keys.push(`f:${ft}|${fp.skeleton}`);
  }
  return keys;
}

function siteEntry(record, day) {
  const domain = String(record.domain).toLowerCase();
  const dot = domain.indexOf('.');
  return {
    d: domain,
    z: domain.slice(dot + 1),
    day,
    ti: String(record.title || '').trim().slice(0, 140),
    de: !!(record.description && String(record.description).trim()),
    ok: operatorKeys(record),
    ds: segmentDomainLabel(domain.slice(0, dot)),
    tt: textTerms(record.title, record.description, record.text),
    lg: siteLanguage(record),
  };
}

// ── Template networks ──────────────────────────────────────────────────────
// A network running one title template across many sites (APK/mod/cheat
// download mirrors, casino/slot/togel doorways, ...) varies the brand,
// version and numbers per site so exact-title keys miss it. Structural test,
// never a keyword list: sites sharing a distinctive title shingle (the same
// 4-word sequence, numbers -> #) or the same title skeleton (domain/brand
// words -> *, numbers -> #) on the same or adjacent days, at or above
// TEMPLATE_MIN_SITES sites, are one operator. At SPAM_KIT_MIN_SITES+ sites the
// network is reported as a spam kit.
const TEMPLATE_MIN_SITES = 8;
const SPAM_KIT_MIN_SITES = 25;
const TEMPLATE_SHINGLE = 4;
const MAX_NETWORKS_REPORTED = 20;

function isTemplateContent(token) {
  return token !== '#' && token !== '*' && [...token].length >= 2 && !langs.isStopWord(token) && !TEXT_STOP.has(token);
}

/** Template keys of a site's title: 4-word shingles (g:) and the brand-free skeleton (s:). */
function templateKeys(site) {
  const title = site && site.ti;
  if (!title) return [];
  const domain = String(site.d || '').toLowerCase();
  const label = domain.split('.')[0];
  const brand = new Set((site.ds || []).filter(w => w !== '?' && w.length >= 3));
  if (label) brand.add(label);
  const tokens = [];
  for (const raw of langs.tokenize(title)) {
    const t = /\p{N}/u.test(raw) ? '#' : raw;
    if (t === '#' && tokens[tokens.length - 1] === '#') continue;
    tokens.push(t);
  }
  const keys = new Set();
  for (let i = 0; i + TEMPLATE_SHINGLE <= tokens.length; i++) {
    const gram = tokens.slice(i, i + TEMPLATE_SHINGLE);
    if (gram.filter(isTemplateContent).length >= 2) keys.add(`g:${gram.join(' ')}`);
  }
  const skeleton = [];
  for (const t of tokens) {
    const v = brand.has(t) ? '*' : t;
    if ((v === '*' || v === '#') && skeleton[skeleton.length - 1] === v) continue;
    skeleton.push(v);
  }
  if (skeleton.filter(isTemplateContent).length >= 3) keys.add(`s:${skeleton.join(' ')}`);
  return [...keys];
}

const dayGap = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

/**
 * Collapses sites into operators (union-find over operatorKeys plus template
 * networks). Returns site -> operator id; the function carries `networks`
 * (every collapsed group of TEMPLATE_MIN_SITES+ sites with its site count).
 */
function operatorIndex(sites, { minSites = TEMPLATE_MIN_SITES, kitMinSites = SPAM_KIT_MIN_SITES } = {}) {
  const parent = new Map();
  const find = key => {
    let root = key;
    while (parent.has(root) && parent.get(root) !== root) root = parent.get(root);
    let node = key;
    while (node !== root) { const next = parent.get(node); parent.set(node, root); node = next; }
    return root;
  };
  const union = (a, b) => {
    if (!parent.has(a)) parent.set(a, a);
    if (!parent.has(b)) parent.set(b, b);
    const ra = find(a); const rb = find(b);
    if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  };
  for (const site of sites) {
    const [first, ...rest] = site.ok;
    if (!parent.has(first)) parent.set(first, first);
    for (const key of rest) union(first, key);
  }
  // Template keys -> day -> site indexes.
  const byKey = new Map();
  sites.forEach((site, idx) => {
    const day = DAY_PATTERN.test(String(site.day || '')) ? site.day : '1970-01-01';
    for (const key of templateKeys(site)) {
      let byDay = byKey.get(key);
      if (!byDay) { byDay = new Map(); byKey.set(key, byDay); }
      let list = byDay.get(day);
      if (!list) { list = []; byDay.set(day, list); }
      list.push(idx);
    }
  });
  const templateOf = new Map();
  for (const [key, byDay] of byKey) {
    if ([...byDay.values()].reduce((n, l) => n + l.length, 0) < minSites) continue;
    const dayList = [...byDay.keys()].sort();
    let run = [];
    const flush = () => {
      const members = run.flatMap(d => byDay.get(d));
      if (members.length >= minSites) {
        const node = `T:${key}@${run[0]}`;
        for (const i of members) {
          union(node, sites[i].ok[0]);
          if (!templateOf.has(i)) templateOf.set(i, key);
        }
      }
      run = [];
    };
    for (const d of dayList) {
      if (run.length && dayGap(run[run.length - 1], d) > 1) flush();
      run.push(d);
    }
    flush();
  }
  const groups = new Map();
  sites.forEach((site, idx) => {
    const root = find(site.ok[0]);
    let g = groups.get(root);
    if (!g) { g = { sites: 0, template: null, first: null, last: null, examples: [] }; groups.set(root, g); }
    g.sites += 1;
    if (!g.template && templateOf.has(idx)) g.template = templateOf.get(idx);
    if (site.day) {
      if (!g.first || site.day < g.first) g.first = site.day;
      if (!g.last || site.day > g.last) g.last = site.day;
    }
    if (g.examples.length < 3 && site.d) g.examples.push(site.d);
  });
  const networks = [...groups.values()].filter(g => g.sites >= minSites)
    .map(g => ({
      template: g.template ? g.template.slice(2) : null,
      via: g.template ? (g.template[0] === 'g' ? 'shingle' : 'skeleton') : 'key',
      sites: g.sites,
      firstDay: g.first,
      lastDay: g.last,
      spamKit: g.sites >= kitMinSites,
      examples: g.examples,
    }))
    .sort((a, b) => b.sites - a.sites || String(a.template).localeCompare(String(b.template)));
  const opOf = site => find(site.ok[0]);
  opOf.networks = networks;
  return opOf;
}

function networkSummary(networks) {
  const list = networks || [];
  return {
    collapsed: list.length,
    collapsedSites: list.reduce((n, g) => n + g.sites, 0),
    spamKits: list.filter(g => g.spamKit).length,
    top: list.slice(0, MAX_NETWORKS_REPORTED),
  };
}

function round(value, digits = 2) {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

/** Rise = last-3-day operator rate vs prior-7-day rate (+1 smoothing), null below the floor. */
function riseScore(last3, prior7, { minRecent = RISE_MIN_RECENT } = {}) {
  if (!(last3 >= minRecent)) return null;
  return round((last3 / RISE_RECENT_DAYS) / ((prior7 + 1) / RISE_PRIOR_DAYS));
}

function unionIdx(daySets, idx) {
  const out = new Set();
  for (const i of idx) { const set = daySets[i]; if (set) for (const v of set) out.add(v); }
  return out;
}

/**
 * Rise windows over the span from each day's operator set: covered days only;
 * recent = the last RISE_RECENT_DAYS covered days, prior = the
 * RISE_PRIOR_DAYS covered days before them. `sufficient` requires minimum
 * covered days and operators in both windows.
 */
function riseWindows(dayOps, { minDayOperators = COVERAGE_MIN_DAY_OPERATORS, minDayFraction = COVERAGE_MIN_DAY_FRACTION } = {}) {
  const sizes = dayOps.map(set => (set ? set.size : 0));
  const nonzero = sizes.filter(Boolean).sort((a, b) => a - b);
  const median = nonzero.length ? nonzero[Math.floor((nonzero.length - 1) / 2)] : 0;
  const floor = Math.max(minDayOperators, Math.ceil(minDayFraction * median));
  const covered = [];
  sizes.forEach((n, i) => { if (n >= floor) covered.push(i); });
  const recent = covered.slice(-RISE_RECENT_DAYS);
  const prior = covered.slice(0, Math.max(0, covered.length - RISE_RECENT_DAYS)).slice(-RISE_PRIOR_DAYS);
  const recentTotal = unionIdx(dayOps, recent).size;
  const priorTotal = unionIdx(dayOps, prior).size;
  const sufficient = recent.length >= RISE_MIN_COVERED_RECENT && prior.length >= RISE_MIN_COVERED_PRIOR
    && recentTotal >= RISE_MIN_WINDOW_OPERATORS && priorTotal >= RISE_MIN_WINDOW_OPERATORS;
  return { covered, coveredSet: new Set(covered), recent, recentSet: new Set(recent), prior, recentTotal, priorTotal, floor, sufficient };
}

/** Share-based rise: recent share of operators vs prior share (+1 smoothing); null without coverage or below the floor. */
function shareRise(recentOps, priorOps, w, { minRecent = RISE_MIN_RECENT } = {}) {
  if (!w || !w.sufficient || !w.recentTotal) return null;
  if (!(recentOps >= minRecent)) return null;
  const recentShare = recentOps / w.recentTotal;
  const priorShare = (priorOps + 1) / (w.priorTotal + 1);
  return round(recentShare / priorShare);
}

function riseCoverage(w, days) {
  return {
    basis: 'share of each window\'s independent operators',
    recentDays: w.recent.map(i => days[i]),
    priorDays: w.prior.map(i => days[i]),
    excludedDays: days.filter((_, i) => !w.coveredSet.has(i)),
    recentOperators: w.recentTotal,
    priorOperators: w.priorTotal,
    minDayOperators: w.floor,
    minCoveredRecent: RISE_MIN_COVERED_RECENT,
    minCoveredPrior: RISE_MIN_COVERED_PRIOR,
    minWindowOperators: RISE_MIN_WINDOW_OPERATORS,
    sufficient: w.sufficient,
  };
}

// Well-established tech/web vocabulary that the general-English frequency list
// does not rank (it predates the current naming wave): never "emerging".
const ESTABLISHED_VOCABULARY = new Set(`chatgpt gpt openai chatbot chatbots saas paas iaas crm erp seo sem ppc api apis app apps cloud crypto cryptocurrency bitcoin btc ethereum eth blockchain nft nfts defi web3 metaverse fintech proptech edtech insurtech healthtech regtech martech startup startups ecommerce dropshipping iot vpn wifi smartphone android ios iphone ipad software hardware analytics devops cybersecurity bigdata ai ml dashboard plugin plugins wordpress shopify woocommerce podcast podcasts influencer streaming esports gaming online digital tech technology internet website websites email marketing`.split(/\s+/).filter(Boolean));

/** True for established vocabulary: a known tech/web word, or a phrase made only of them. */
function isEstablishedVocabulary(term) {
  const parts = String(term).split(' ');
  return parts.every(w => ESTABLISHED_VOCABULARY.has(w));
}

/** Established by registration history: steady, frequent presence across a long history without growth. */
function historyEstablished({ days = 0, presentDays = 0, count = 0, growth = null } = {}) {
  if (!(days >= HISTORY_MIN_DAYS)) return false;
  if (presentDays / days < HISTORY_MIN_PRESENCE || count < days) return false;
  return growth == null || growth < HISTORY_MAX_GROWTH;
}

function lexicalNovelty(term) {
  const { common } = minerVocabulary();
  const one = word => {
    if (ESTABLISHED_VOCABULARY.has(word)) return 0.02;
    const rank = common.get(word);
    return rank ? Math.min(1, 0.02 + (rank / 10000) ** 1.5) : 1;
  };
  const parts = term.split(' ');
  return parts.length === 1 ? one(term) : Math.sqrt(parts.reduce((p, w) => p * one(w), 1));
}

/**
 * Emerging score: novelty (rare in registrations and in common English) x
 * independent adoption x widening usage (roles, partners, extensions) x
 * frontier pull. Fewer than 2 independent operators never emerges.
 */
function emergingScore({ term, operators, perMillion = null, roles = 0, partners = 0, zones = 0, frontierShare = 0, presence = 0, established = false }) {
  if (!(operators >= 2) || established || isEstablishedVocabulary(term)) return 0;
  // Rare in the whole registration history, and absent on most history days.
  const regNovelty = (perMillion == null ? 1 : 1 / (1 + Math.log10(1 + perMillion))) * (1 - 0.7 * Math.min(1, Math.max(0, presence || 0)));
  const novelty = regNovelty * lexicalNovelty(term);
  const adoption = Math.log2(1 + operators);
  const widening = 1 + (roles >= 2 ? 0.4 : 0) + Math.min(partners, 10) * 0.05 + (zones >= 2 ? 0.3 : 0);
  const frontier = 1 + 1.5 * Math.min(1, Math.max(0, frontierShare));
  return round(novelty * adoption * widening * frontier, 4);
}

const sumRange = (arr, from, to) => { let s = 0; for (let i = from; i < to; i++) s += arr[i] || 0; return s; };

function hasRegistrations(regs) { return Array.isArray(regs) && regs.some(v => v != null); }

const rangeIdx = (from, to) => { const out = []; for (let i = Math.max(0, from); i < to; i++) out.push(i); return out; };
const sumIdx = (arr, idx) => { let total = 0; for (const i of idx) total += arr[i] || 0; return total; };
const legacyWindows = n => ({ recent: rangeIdx(n - 3, n), prior: rangeIdx(n - 10, n - 3) });
const knownIdx = (regs, idx) => idx.filter(i => regs[i] != null);

/** Built share (builders per registration) in the recent covered window fell below 70% of the prior window's. */
function builtShareFalling(built, regs, { window = null } = {}) {
  if (!hasRegistrations(regs)) return false;
  const w = window || legacyWindows(built.length);
  const R = knownIdx(regs, w.recent); const P = knownIdx(regs, w.prior);
  if (!R.length || !P.length) return false;
  const r3 = sumIdx(regs, R); const r7 = sumIdx(regs, P);
  if (r3 + r7 === 0) return false;
  const prior = sumIdx(built, P) / (r7 + 1);
  return prior > 0 && sumIdx(built, R) / (r3 + 1) < 0.7 * prior;
}

/** Speculative: registrations rising (with a floor) while built launches are flat or falling (share-based with a window). */
function speculativeFlag(built, regs, { window = null, builtRise = null } = {}) {
  if (!hasRegistrations(regs)) return false;
  const w = window || legacyWindows(built.length);
  const R = knownIdx(regs, w.recent); const P = knownIdx(regs, w.prior);
  if (!R.length || !P.length) return false;
  const r3 = sumIdx(regs, R); const r7 = sumIdx(regs, P);
  const regsRising = r3 >= REG_RISE_MIN && r3 / R.length >= 1.5 * ((r7 + 1) / P.length);
  const builtFlat = window
    ? builtRise != null && builtRise <= 1.1
    : sumIdx(built, w.recent) / w.recent.length <= 1.1 * ((sumIdx(built, w.prior) + 1) / w.prior.length);
  return regsRising && builtFlat;
}

/** Organic pickup: built launches by independent operators growing (share-based with a window). */
function organicFlag(built, { window = null, builtRise = null } = {}) {
  const w = window || legacyWindows(built.length);
  const b3 = sumIdx(built, w.recent);
  if (window) return b3 >= 3 && builtRise != null && builtRise > 1.2;
  const b7 = sumIdx(built, w.prior);
  return b3 >= 3 && b3 / 3 > 1.2 * ((b7 + 1) / 7);
}

/**
 * Stage: confirmed (both weeks active, broad, real businesses), forming (3+
 * independent builders across 3+ days this week, widening, share-based rise
 * not below 1), otherwise watch. A falling share (riseRaw < 0.7) or falling
 * built-per-registration share blocks both.
 */
function stageFor(m) {
  const shareFalling = m.riseRaw != null && m.riseRaw < STAGE_FALLING_RISE;
  const falling = !!m.builtShareFalling || shareFalling;
  if (m.opsFirstWeek >= 2 && m.opsLastWeek >= 2 && m.daysFirstWeek >= 2 && m.daysLastWeek >= 2
    && m.operators14 >= 8 && m.zones >= 2 && m.described >= 5 && !falling) return 'confirmed';
  if (m.opsLastWeek >= 3 && m.daysLastWeek >= 3 && (m.roles >= 2 || m.partners >= 3 || m.zones >= 2) && !falling
    && (m.riseRaw == null || m.riseRaw >= STAGE_FORMING_RISE)) return 'forming';
  return 'watch';
}

function isEndUserSale(row) {
  if (!row || typeof row.domain !== 'string') return false;
  if (row.side && row.side !== 'enduser') return false;
  return !NON_END_USER_VENUE_RE.test(String(row.venue || ''));
}

function termInLabel(term, label, seq) {
  const words = seq.filter(t => t !== '?');
  if (!term.includes(' ')) {
    if (label === term || words.includes(term)) return true;
    const v = minerVocabulary();
    // Out-of-vocabulary terms cannot appear as segments; fall back to the exact string.
    return term.length >= 4 && !v.words.has(term) && !v.extra.has(term) && label.includes(term);
  }
  const [a, b] = term.split(' ');
  for (let i = 0; i + 1 < seq.length; i++) if (seq[i] === a && seq[i + 1] === b) return true;
  return label.includes(a + b) && label.replace(/-/g, '') === a + b;
}

// ── Cluster building ──────────────────────────────────────────────────────
/**
 * Groups keywords by co-occurrence across the same operators (cosine strength
 * co / sqrt(na * nb)), merging strongest pairs first with a member cap so no
 * hub term chains everything together. No LLM.
 */
function buildClusters(opTerms, termOps, { minStrength = CLUSTER_MIN_STRENGTH, maxMembers = CLUSTER_MAX_MEMBERS, minCo = 2 } = {}) {
  const pairs = new Map();
  for (const terms of opTerms.values()) {
    const list = [...terms].slice(0, CLUSTER_TERMS_PER_OPERATOR).sort();
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const key = `${list[i]}\u0000${list[j]}`;
        pairs.set(key, (pairs.get(key) || 0) + 1);
      }
    }
  }
  const edges = [];
  for (const [key, co] of pairs) {
    if (co < minCo) continue;
    const [a, b] = key.split('\u0000');
    if (a.split(' ').includes(b) || b.split(' ').includes(a)) continue; // a phrase and its own word
    const strength = co / Math.sqrt(termOps.get(a) * termOps.get(b));
    if (strength >= minStrength) edges.push({ a, b, co, strength });
  }
  edges.sort((x, y) => y.strength - x.strength || y.co - x.co || (x.a + x.b).localeCompare(y.a + y.b));
  const parent = new Map();
  const members = new Map();
  const find = t => { while (parent.get(t) !== t) t = parent.get(t); return t; };
  const ensure = t => { if (!parent.has(t)) { parent.set(t, t); members.set(t, [t]); } };
  const degree = new Map();
  for (const e of edges) {
    ensure(e.a); ensure(e.b);
    const ra = find(e.a); const rb = find(e.b);
    if (ra === rb) { degree.set(e.a, (degree.get(e.a) || 0) + e.strength); degree.set(e.b, (degree.get(e.b) || 0) + e.strength); continue; }
    if (members.get(ra).length + members.get(rb).length > maxMembers) continue;
    parent.set(rb, ra);
    members.set(ra, members.get(ra).concat(members.get(rb)));
    members.delete(rb);
    degree.set(e.a, (degree.get(e.a) || 0) + e.strength);
    degree.set(e.b, (degree.get(e.b) || 0) + e.strength);
  }
  return [...members.values()].filter(list => list.length >= 2)
    .map(list => list.slice().sort((x, y) => (termOps.get(y) - termOps.get(x)) || ((degree.get(y) || 0) - (degree.get(x) || 0)) || x.localeCompare(y)));
}

// ── File helpers ───────────────────────────────────────────────────────────
async function readJson(file) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch { return null; }
}

async function writeJsonAtomic(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(value));
  await fsp.rename(tmp, file);
}

async function statOrNull(file) {
  try { return await fsp.stat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function readRange(file, start, end) {
  const handle = await fsp.open(file, 'r');
  try {
    const length = end - start;
    const buffer = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const { bytesRead } = await handle.read(buffer, offset, length - offset, start + offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    return buffer.subarray(0, offset);
  } finally { await handle.close(); }
}

function addDays(day, delta) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

const yieldLoop = () => new Promise(resolve => setImmediate(resolve));

function parseQuery(query = {}) {
  const one = value => (Array.isArray(value) ? value[0] : value);
  const windowKey = String(one(query.window) ?? '').trim().toLowerCase() || '7d';
  if (!Object.prototype.hasOwnProperty.call(WINDOWS, windowKey)) throw requestError('window must be 7d or 14d');
  const source = String(one(query.source) ?? '').trim().toLowerCase() || 'all';
  if (!SOURCES.includes(source)) throw requestError('source must be domain, text or all');
  const kind = String(one(query.kind) ?? '').trim().toLowerCase() || 'all';
  if (!KINDS.includes(kind)) throw requestError('kind must be all, emerging, trending, biggest or clusters');
  let limit = DEFAULT_LIMIT;
  const rawLimit = one(query.limit);
  if (rawLimit !== undefined && rawLimit !== '') {
    if (!/^\d+$/.test(String(rawLimit))) throw requestError(`limit must be an integer from 1 to ${MAX_LIMIT}`);
    limit = Number(rawLimit);
    if (limit < 1 || limit > MAX_LIMIT) throw requestError(`limit must be an integer from 1 to ${MAX_LIMIT}`);
  }
  const lang = String(one(query.lang) ?? '').trim().toLowerCase() || 'all';
  if (lang !== 'all' && !langs.LANGUAGES.includes(lang)) throw requestError(`lang must be all or one of ${langs.LANGUAGES.join(', ')}`);
  return { window: windowKey, windowDays: WINDOWS[windowKey], source, kind, limit, lang };
}

// ── The index ──────────────────────────────────────────────────────────────
function createLiveTrends({
  universeDir,
  cacheDir,
  salesLoader = null,
  baselineLoader = null,
  // null = all registration history the universe holds; a number limits folding to that many days.
  baselineDays = null,
  buildBudget = 2,
  memoMs = 60000,
  now = () => Date.now(),
  log = console,
} = {}) {
  if (!universeDir) throw new Error('universeDir is required');
  const cache = cacheDir || path.join(universeDir, '..', 'live-trends');
  const dayStates = new Map();
  const regMemo = new Map();
  const models = new Map();
  let operations = Promise.resolve();
  function exclusive(fn) {
    const result = operations.then(fn);
    operations = result.catch(() => {});
    return result;
  }
  const pendingRegs = new Set();
  let warming = null;
  let salesMemo = { at: 0, rows: null };
  const stats = { dayReads: 0, regBuilds: 0, models: 0 };

  async function sourceFiles(day) {
    const dir = path.join(universeDir, day, 'sites');
    const files = [];
    let stat = await statOrNull(path.join(dir, 'observations.jsonl'));
    if (stat) files.push(['observations.jsonl', stat]);
    else {
      stat = await statOrNull(path.join(dir, 'observations.partial.jsonl'));
      if (stat) files.push(['observations.partial.jsonl', stat]);
    }
    const ct = await statOrNull(path.join(dir, CT_JOURNAL));
    if (ct) files.push([CT_JOURNAL, ct]);
    return files;
  }

  /** Incrementally extracts one day's sites: reads each journal only past its saved offset. */
  async function indexDay(day) {
    const files = await sourceFiles(day);
    if (!files.length) return null;
    const cacheFile = path.join(cache, 'sites', `${day}.json`);
    let state = dayStates.get(day);
    if (!state) {
      state = await readJson(cacheFile);
      if (!state || state.version !== VERSION || state.day !== day || !Array.isArray(state.sites) || !state.files) state = null;
    }
    const fresh = () => ({ version: VERSION, day, rev: 0, files: {}, sites: [] });
    if (!state) state = fresh();
    const names = files.map(([name]) => name);
    // The final file replaces the resume journal (kit-collapsed): rebuild the day.
    if (Object.keys(state.files).some(name => !names.includes(name))
      || files.some(([name, stat]) => state.files[name] && stat.size < state.files[name].offset)) state = fresh();
    let changed = false;
    const seen = new Set(state.sites.map(site => site.d));
    for (const [name, stat] of files) {
      const entry = state.files[name] || (state.files[name] = { offset: 0 });
      if (stat.size <= entry.offset) continue;
      const buffer = await readRange(path.join(universeDir, day, 'sites', name), entry.offset, stat.size);
      stats.dayReads += 1;
      let end = buffer.lastIndexOf(10) + 1;
      if (name === 'observations.jsonl') end = buffer.length; // final file: complete
      if (end <= 0) continue;
      entry.offset += end;
      changed = true;
      for (const line of buffer.subarray(0, end).toString('utf8').split('\n')) {
        if (!line.trim()) continue;
        let record;
        try { record = JSON.parse(line); } catch { continue; }
        // Built, titled, non-kit, non-spam only: the existing filters drop
        // gambling/adult/lottery/pharma spam and flagged kits.
        if (!isPublishable(record) || seen.has(String(record.domain).toLowerCase())) continue;
        if (!String(record.domain).includes('.')) continue;
        seen.add(String(record.domain).toLowerCase());
        state.sites.push(siteEntry(record, day));
      }
    }
    if (changed) {
      state.rev = (state.rev || 0) + 1;
      try { await writeJsonAtomic(cacheFile, state); } catch (error) { log.warn?.(`[LiveTrends] cache write failed for ${day}: ${error.message}`); }
    }
    dayStates.set(day, state);
    return state;
  }

  async function listDayDirs() {
    let entries;
    try { entries = await fsp.readdir(universeDir, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    return entries.filter(e => e.isDirectory() && DAY_PATTERN.test(e.name)).map(e => e.name).sort();
  }

  /** 14 calendar days (oldest first) ending at the newest day with site observations. */
  async function span() {
    const dirs = await listDayDirs();
    for (let i = dirs.length - 1; i >= 0; i--) {
      if ((await sourceFiles(dirs[i])).length) {
        const anchor = dirs[i];
        const days = [];
        for (let k = SPAN_DAYS - 1; k >= 0; k--) days.push(addDays(anchor, -k));
        return { anchor, days, dirs };
      }
    }
    return null;
  }

  // ── Registrations (universe zone adds) ──
  async function buildRegDay(day, file, signature) {
    stats.regBuilds += 1;
    const labels = new Set();
    const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
    for await (const line of rl) {
      if (labels.size >= MAX_REG_LABELS) break;
      const tab = line.indexOf('\t');
      const label = (tab === -1 ? line : line.slice(0, tab)).trim().toLowerCase();
      if (label && /^[a-z0-9-]{1,63}$/.test(label)) labels.add(label); // one label in many zones counts once
    }
    const counts = new Map();
    const odd = new Map();
    let n = 0;
    for (const label of labels) {
      const seen = new Set();
      for (const [term] of domainEntries(segmentDomainLabel(label))) {
        if (seen.has(term)) continue;
        seen.add(term);
        counts.set(term, (counts.get(term) || 0) + 1);
      }
      for (const term of unknownTerms(label)) {
        if (seen.has(term)) continue;
        seen.add(term);
        if (odd.has(term) || odd.size < MAX_REG_ODD_TERMS) odd.set(term, (odd.get(term) || 0) + 1);
      }
      if (++n % 5000 === 0) await yieldLoop();
    }
    const kept = {};
    for (const [term, count] of counts) if (!term.includes(' ') || count >= 2) kept[term] = count;
    for (const [term, count] of odd) if (count >= 2 && !(term in kept)) kept[term] = count;
    const value = { version: REG_VERSION, day, signature, total: labels.size, counts: kept };
    try { await writeJsonAtomic(path.join(cache, 'regs', `${day}.json`), value); } catch (error) { log.warn?.(`[LiveTrends] regs cache write failed for ${day}: ${error.message}`); }
    return value;
  }

  /** Registration term counts for a day: memo, then disk cache, then (if allowed) a build. undefined = not built yet. */
  async function loadReg(day, allowBuild, memoize = true) {
    const file = path.join(universeDir, day, 'tape', 'adds.tsv');
    const stat = await statOrNull(file);
    if (!stat) return null;
    const signature = `${stat.size}:${Math.trunc(stat.mtimeMs)}`;
    const memo = regMemo.get(day);
    if (memo && memo.signature === signature) return memo;
    let value = await readJson(path.join(cache, 'regs', `${day}.json`));
    if (!value || value.version !== REG_VERSION || value.signature !== signature) {
      if (!allowBuild) return undefined;
      value = await buildRegDay(day, file, signature);
    }
    const loaded = { signature, total: value.total, counts: new Map(Object.entries(value.counts || {})) };
    if (memoize) regMemo.set(day, loaded);
    return loaded;
  }

  function scheduleWarm(days) {
    for (const day of days) pendingRegs.add(day);
    if (warming || !pendingRegs.size) return warming;
    warming = (async () => {
      while (pendingRegs.size) {
        const day = [...pendingRegs].sort().pop();
        pendingRegs.delete(day);
        try { await loadReg(day, true, false); } catch (error) { log.warn?.(`[LiveTrends] registrations for ${day} failed: ${error.message}`); }
      }
    })().finally(() => { warming = null; });
    return warming;
  }

  async function loadRegs(days, budget) {
    const out = new Map();
    const missing = [];
    let left = budget;
    for (const day of days.slice().reverse()) {
      let value = await loadReg(day, false);
      if (value === undefined && left > 0) { left -= 1; value = await loadReg(day, true); }
      if (value === undefined) missing.push(day);
      else if (value) out.set(day, value);
    }
    if (missing.length) scheduleWarm(missing);
    return { regs: out, missing };
  }

  // ── Registration history lexicon (all universe history, folded once per day) ──
  let lexicon = null;
  const lexiconFile = () => path.join(cache, 'lexicon.json');
  async function loadLexicon() {
    if (lexicon) return lexicon;
    const v = await readJson(lexiconFile());
    lexicon = v && v.version === LEXICON_VERSION && v.terms && v.days
      ? { days: v.days, total: v.total || 0, months: v.months || {}, terms: new Map(Object.entries(v.terms)) }
      : { days: {}, total: 0, months: {}, terms: new Map() };
    return lexicon;
  }

  /**
   * Folds every universe day before `beforeDay` that has a zone-adds tape into
   * a cumulative lexicon: term -> [count, daysPresent, firstDay, {month: count}].
   * Builds at most `budget` missing day caches inline; the rest warm in the
   * background and fold on a later call.
   */
  async function historyLexicon(beforeDay, dirs, budget) {
    const lex = await loadLexicon();
    let wanted = (dirs || []).filter(d => d < beforeDay);
    if (Number.isFinite(baselineDays) && baselineDays > 0) { const from = addDays(beforeDay, -baselineDays); wanted = wanted.filter(d => d >= from); }
    let left = budget;
    let changed = false;
    const pending = [];
    for (const day of wanted.slice().reverse()) {
      if (lex.days[day]) continue;
      const file = path.join(universeDir, day, 'tape', 'adds.tsv');
      const stat = await statOrNull(file);
      if (!stat) continue;
      const signature = `${stat.size}:${Math.trunc(stat.mtimeMs)}`;
      let value = await readJson(path.join(cache, 'regs', `${day}.json`));
      if (!value || value.version !== REG_VERSION || value.signature !== signature) {
        if (left <= 0) { pending.push(day); continue; }
        left -= 1;
        value = await buildRegDay(day, file, signature);
      }
      const month = day.slice(0, 7);
      lex.days[day] = signature;
      lex.total += value.total || 0;
      lex.months[month] = (lex.months[month] || 0) + (value.total || 0);
      for (const [term, count] of Object.entries(value.counts || {})) {
        let e = lex.terms.get(term);
        if (!e) {
          if (lex.terms.size >= MAX_LEXICON_TERMS) continue;
          e = [0, 0, day, {}];
          lex.terms.set(term, e);
        }
        e[0] += count; e[1] += 1;
        if (day < e[2]) e[2] = day;
        e[3][month] = (e[3][month] || 0) + count;
      }
      changed = true;
      await yieldLoop();
    }
    if (pending.length) scheduleWarm(pending);
    if (changed) {
      try { await writeJsonAtomic(lexiconFile(), { version: LEXICON_VERSION, days: lex.days, total: lex.total, months: lex.months, terms: Object.fromEntries(lex.terms) }); }
      catch (error) { log.warn?.(`[LiveTrends] lexicon write failed: ${error.message}`); }
    }
    const folded = Object.keys(lex.days).sort();
    return { lex, days: folded.length, firstDay: folded[0] || null, pending: pending.length };
  }

  function historyGrowth(e, lex) {
    const months = Object.keys(lex.months).sort();
    if (!e || months.length < 2) return null;
    const rate = m => ((e[3][m] || 0) + 0.5) / Math.max(1, lex.months[m]);
    return rate(months[months.length - 1]) / rate(months[0]);
  }

  async function loadSales() {
    if (!salesLoader) return null;
    if (salesMemo.rows && now() - salesMemo.at < 10 * 60000) return salesMemo.rows;
    const sinceDate = new Date(now() - SALES_DAYS * 86400000).toISOString().slice(0, 10);
    let rows = [];
    try { rows = (await salesLoader({ sinceDate })) || []; } catch (error) { log.warn?.(`[LiveTrends] sales unavailable: ${error.message}`); rows = []; }
    const prepared = rows.filter(isEndUserSale).filter(row => !row.date || String(row.date) >= sinceDate).map(row => {
      const domain = String(row.domain).toLowerCase();
      const label = domain.slice(0, domain.indexOf('.') > 0 ? domain.indexOf('.') : domain.length);
      return { row: { domain, price: Number(row.price) || null, date: row.date || null, venue: row.venue || null, sourceUrl: row.sourceUrl || null }, label, seq: segmentDomainLabel(label) };
    }).sort((a, b) => String(b.row.date || '').localeCompare(String(a.row.date || '')));
    salesMemo = { at: now(), rows: prepared };
    return prepared;
  }

  function salesFor(term, sales) {
    if (!sales) return { count: 0, recent: [], available: false };
    const hits = sales.filter(s => termInLabel(term, s.label, s.seq));
    return { count: hits.length, recent: hits.slice(0, SALES_RECENT).map(s => s.row), available: true };
  }

  // ── Aggregation ──
  function siteEntries(site, source) {
    const out = [];
    if (source !== 'text') for (const e of domainEntries(site.ds)) out.push([e[0], e[1], e[2], 'domain']);
    if (source !== 'domain') for (const e of textEntries(site.tt)) out.push([e[0], e[1], e[2], 'text']);
    return out;
  }

  function aggregate(sites, days, source) {
    const dayIndex = new Map(days.map((d, i) => [d, i]));
    const opOf = operatorIndex(sites);
    const ordered = sites.slice().sort((a, b) => b.day.localeCompare(a.day) || a.d.localeCompare(b.d));
    // Count with one temporary site at a time. Keeping every role/source tuple
    // for the entire corpus multiplied the resident index by millions of arrays.
    const lists = [];
    const siteCount = new Map();
    for (const site of ordered) {
      const list = siteEntries(site, source);
      const seen = new Set();
      for (const [term] of list) { if (!seen.has(term)) { seen.add(term); siteCount.set(term, (siteCount.get(term) || 0) + 1); } }
    }
    const terms = new Map();
    const ops = ordered.map(opOf);
    ordered.forEach((site, i) => {
      const op = ops[i];
      const di = dayIndex.get(site.day);
      const entries = siteEntries(site, source);
      const present = new Set(entries.map(e => e[0]));
      // Clustering only needs unique terms, not the role/source tuples.
      lists.push([...present].filter(term => siteCount.get(term) >= 2));
      const frontierHere = FRONTIER_TERMS.filter(f => present.has(f));
      for (const [term, role, partner, src] of entries) {
        if (siteCount.get(term) < 2) continue;
        let t = terms.get(term);
        if (!t) {
          t = { term, days: Array(SPAN_DAYS).fill(null), ops: new Set(), zones: new Set(), roles: new Set(), partners: new Set(), sources: { domain: new Set(), text: new Set() }, langs: new Map(), described: new Set(), frontierOps: new Set(), frontierPartners: new Map(), examples: [], lastSite: -1 };
          terms.set(term, t);
        }
        (t.days[di] || (t.days[di] = new Set())).add(op);
        t.ops.add(op);
        t.sources[src].add(op);
        if (role) t.roles.add(role);
        if (partner && t.partners.size < 50) t.partners.add(partner);
        if (t.lastSite === i) continue;
        t.lastSite = i;
        t.zones.add(site.z);
        if (site.de) t.described.add(op);
        if (site.lg) {
          let byLang = t.langs.get(site.lg);
          if (!byLang) { byLang = Array(SPAN_DAYS).fill(null); t.langs.set(site.lg, byLang); }
          (byLang[di] || (byLang[di] = new Set())).add(op);
        }
        const words = term.split(' ');
        const frontier = frontierHere.filter(f => f !== term && !words.includes(f));
        if (frontier.length) {
          t.frontierOps.add(op);
          for (const f of frontier) t.frontierPartners.set(f, (t.frontierPartners.get(f) || 0) + 1);
        }
        if (t.examples.length < 40) t.examples.push({ domain: site.d, title: site.ti, day: site.day, op });
      }
    });
    return { terms, ordered, ops, lists, dayIndex, networks: opOf.networks };
  }

  function unionDays(t, from, to) {
    const out = new Set();
    for (let i = Math.max(0, from); i < to; i++) if (t.days[i]) for (const op of t.days[i]) out.add(op);
    return out;
  }

  function examplesOf(list, limit = EXAMPLES) {
    const seenOps = new Set();
    const out = [];
    for (const ex of list) {
      if (seenOps.has(ex.op)) continue;
      seenOps.add(ex.op);
      out.push({ domain: ex.domain, title: ex.title, day: ex.day });
      if (out.length >= limit) break;
    }
    return out;
  }

  function metrics(t, windowDays, regsByDay, days, w) {
    const S = SPAN_DAYS;
    const series = t.days.map(s => (s ? s.size : 0));
    const windowOps = unionDays(t, S - windowDays, S);
    const last7 = unionDays(t, S - 7, S);
    const first7 = unionDays(t, 0, S - 7);
    // Covered-day windows only; rise on share of each window's operators.
    const last3 = unionIdx(t.days, w.recent).size;
    const prior7 = unionIdx(t.days, w.prior).size;
    const riseRaw = shareRise(last3, prior7, w, { minRecent: 0 });
    const active = (from, to) => series.slice(from, to).filter(Boolean).length;
    const registrations = days.map(day => {
      const reg = regsByDay.get(day);
      return reg ? (reg.counts.get(t.term) || 0) : null;
    });
    const regsKnown = hasRegistrations(registrations);
    const falling = builtShareFalling(series, registrations, { window: w });
    const m = {
      operators: windowOps.size,
      operators7: last7.size,
      operators14: t.ops.size,
      opsFirstWeek: first7.size,
      opsLastWeek: last7.size,
      daysActive: active(S - windowDays, S),
      daysFirstWeek: active(0, S - 7),
      daysLastWeek: active(S - 7, S),
      last3,
      prior7,
      rise: shareRise(last3, prior7, w),
      riseRaw,
      recentShare: w.sufficient && w.recentTotal ? round(last3 / w.recentTotal, 4) : null,
      priorShare: w.sufficient && w.priorTotal ? round(prior7 / w.priorTotal, 4) : null,
      series,
      registrations: regsKnown ? registrations : null,
      zones: t.zones.size,
      roles: t.roles.size,
      partners: t.partners.size,
      described: t.described.size,
      builtShareFalling: falling,
    };
    m.languages = [...t.langs].map(([lang, byLang]) => {
      const ops = new Set(); const recent = new Set();
      for (let i = Math.max(0, S - windowDays); i < S; i++) if (byLang[i]) for (const op of byLang[i]) { ops.add(op); if (w.recentSet.has(i)) recent.add(op); }
      return { lang, operators: ops.size, recent: recent.size };
    }).filter(l => l.operators > 0).sort((a, b) => b.operators - a.operators || a.lang.localeCompare(b.lang));
    Object.assign(m, globalSignal(t.term, m.languages));
    m.stage = stageFor(m);
    m.speculative = speculativeFlag(series, registrations, { window: w, builtRise: riseRaw });
    m.organic = organicFlag(series, { window: w, builtRise: riseRaw });
    return m;
  }

  /** Novelty evidence for a term against the whole registration history plus the zone-history hook and word frequency. */
  function baselineFor(term, history, hook) {
    const lex = history.lex;
    const e = lex.terms.get(term);
    const days = history.days;
    const count = e ? e[0] : 0;
    const presentDays = e ? e[1] : 0;
    let perDay = days ? count / days : null;
    let perMillion = days && lex.total ? (count / lex.total) * 1e6 : null;
    const fromHook = hook && hook.get(term);
    if (fromHook && fromHook.days > 0) {
      const hookPerDay = fromHook.count / fromHook.days;
      perDay = Math.max(perDay || 0, hookPerDay);
      if (fromHook.total) perMillion = Math.max(perMillion || 0, (fromHook.count / fromHook.total) * 1e6);
    }
    const growth = historyGrowth(e, lex);
    const presence = days ? presentDays / days : null;
    const byHistory = historyEstablished({ days, presentDays, count, growth });
    const byVocabulary = isEstablishedVocabulary(term);
    return {
      perDay: perDay == null ? null : round(perDay, 2),
      perMillion: perMillion == null ? null : round(perMillion, 2),
      days,
      historyFrom: history.firstDay,
      presentDays,
      presence: presence == null ? null : round(presence, 2),
      firstSeen: e ? e[2] : null,
      growth: growth == null ? null : round(growth, 2),
      zoneHistoryDays: fromHook ? fromHook.days : 0,
      commonRank: term.includes(' ') ? null : (minerVocabulary().common.get(term) || null),
      established: byHistory || byVocabulary,
      establishedBy: byVocabulary ? 'vocabulary' : byHistory ? 'registration-history' : null,
    };
  }

  async function buildModel(spanInfo, source, windowDays, lang = 'all') {
    const started = Date.now();
    const { days } = spanInfo;
    const sites = [];
    for (const day of days) { const st = dayStates.get(day); if (st) for (const site of st.sites) if (lang === 'all' || site.lg === lang) sites.push(site); }
    const { terms, ordered, ops, lists, networks, dayIndex } = aggregate(sites, days, source);
    if (Date.now() - started > 1000) log.info?.(`[LiveTrends] aggregated ${sites.length} sites, ${terms.size} terms in ${Date.now() - started}ms`);
    const { regs } = await loadRegs(days, buildBudget);
    const history = await historyLexicon(days[0], spanInfo.dirs, buildBudget);
    const S = SPAN_DAYS;
    const windowStart = days[S - windowDays];
    const windowOps = new Set();
    ordered.forEach((site, i) => { if (site.day >= windowStart) windowOps.add(ops[i]); });
    const dayOps = days.map(() => new Set());
    const daySites = days.map(() => 0);
    ordered.forEach((site, i) => { const di = dayIndex.get(site.day); if (di == null) return; dayOps[di].add(ops[i]); daySites[di] += 1; });
    const riseWindow = riseWindows(dayOps);
    const coverageDays = days.map((day, i) => {
      const st = dayStates.get(day);
      return { day, sites: daySites[i], operators: dayOps[i].size, sources: st ? Object.keys(st.files || {}).sort() : [], covered: riseWindow.coveredSet.has(i) };
    });
    const scored = [];
    for (const t of terms.values()) {
      const m = metrics(t, windowDays, regs, days, riseWindow);
      if (m.operators < 1) continue;
      scored.push({ t, m });
    }
    if (Date.now() - started > 1000) log.info?.(`[LiveTrends] model ready in ${Date.now() - started}ms`);
    stats.models += 1;
    return { days, terms, ordered, ops, lists, scored, regs, history, baselineMissing: history.pending, windowOps, windowStart, sites: sites.length, networks, riseWindow, coverageDays };
  }

  function keywordItem({ t, m }, sales) {
    return {
      keyword: t.term,
      sources: { domain: t.sources.domain.size, text: t.sources.text.size },
      operators: m.operators,
      operators7: m.operators7,
      daysActive: m.daysActive,
      rise: m.rise,
      share: { recent: m.recentShare, prior: m.priorShare },
      series: m.series,
      registrations: m.registrations,
      stage: m.stage,
      speculative: m.speculative,
      organic: m.organic,
      languages: m.languages,
      global: !!m.global,
      examples: examplesOf(t.examples),
      // Display-only context: never read by any score, rank, stage or flag.
      sales: salesFor(t.term, sales),
    };
  }

  async function query(rawQuery = {}) {
    const q = parseQuery(rawQuery);
    const info = await span();
    const base = { window: q.window, source: q.source, kind: q.kind, lang: q.lang, generatedAt: new Date(now()).toISOString() };
    const emptyLists = {
      ...(q.kind === 'all' || q.kind === 'emerging' ? { emerging: [] } : {}),
      ...(q.kind === 'all' || q.kind === 'trending' ? { trending: [] } : {}),
      ...(q.kind === 'all' || q.kind === 'biggest' ? { biggest: [] } : {}),
      ...(q.kind === 'all' || q.kind === 'clusters' ? { clusters: [] } : {}),
    };
    if (!info) return { ...base, asOf: null, days: [], coverage: { sites: 0, operators: 0, registrationDays: 0, baselineDays: 0, baselinePending: 0, salesAvailable: !!salesLoader, days: [], rise: null }, ...emptyLists };
    for (const day of info.days) await indexDay(day);
    for (const day of [...dayStates.keys()]) if (!info.days.includes(day)) dayStates.delete(day);
    for (const day of regMemo.keys()) if (!info.days.includes(day)) regMemo.delete(day);
    const signature = info.days.map(d => { const st = dayStates.get(d); return st ? `${d}:${st.rev}:${st.sites.length}` : `${d}:-`; }).join('|');
    const modelFor = async lang => {
      const memoKey = `${q.source}#${q.windowDays}#${lang}`;
      // Superseded corpus generations are never reusable. Release them before
      // allocating a replacement rather than retaining twelve large snapshots.
      for (const [key, value] of models) {
        if (value.signature !== signature || now() - value.at > memoMs) models.delete(key);
      }
      let entry = models.get(memoKey);
      if (!entry || now() - entry.at > memoMs) {
        const model = await buildModel(info, q.source, q.windowDays, lang);
        entry = { at: now(), signature, model };
        models.set(memoKey, entry);
        while (models.size > 12) models.delete(models.keys().next().value);
      }
      return entry.model;
    };
    const model = await modelFor(q.lang);
    if (q.lang !== 'all') {
      // Languages and the global flag always describe the whole index.
      const whole = await modelFor('all');
      const byTerm = new Map(whole.scored.map(x => [x.t.term, x.m]));
      for (const x of model.scored) {
        const w = byTerm.get(x.t.term);
        if (w) { x.m.languages = w.languages; x.m.global = w.global; x.m.boost = w.boost; }
      }
    }
    const sales = await loadSales();
    const lists = {};

    const biggestRanked = model.scored.filter(x => x.m.operators >= 1)
      .sort((a, b) => b.m.operators - a.m.operators || b.m.daysActive - a.m.daysActive || a.t.term.localeCompare(b.t.term));
    if (q.kind === 'all' || q.kind === 'biggest') lists.biggest = biggestRanked.slice(0, q.limit).map(x => keywordItem(x, sales));

    if (q.kind === 'all' || q.kind === 'trending') {
      lists.trending = model.scored.filter(x => x.m.rise != null && x.m.rise >= TRENDING_MIN_RISE)
        .map(x => ({ x, score: round(x.m.rise * Math.log2(1 + x.m.operators) * (x.m.daysActive / q.windowDays) * (x.m.boost || 1), 4) }))
        .sort((a, b) => b.score - a.score || a.x.t.term.localeCompare(b.x.t.term))
        .slice(0, q.limit).map(({ x, score }) => ({ ...keywordItem(x, sales), score }));
    }

    if (q.kind === 'all' || q.kind === 'emerging') {
      // Emerging excludes the common words that dominate Biggest.
      // Only common-vocabulary words at the top of Biggest are excluded; a novel
      // term that happens to be big in a small window stays eligible.
      const biggestTop = new Set(biggestRanked.slice(0, Math.max(25, q.limit)).map(x => x.t.term)
        .filter(term => lexicalNovelty(term) < 0.5));
      let hook = null;
      const candidates = model.scored.filter(x => x.m.operators >= 2 && !biggestTop.has(x.t.term) && !/^\d/.test(x.t.term));
      if (baselineLoader && candidates.length) {
        try { hook = await baselineLoader(candidates.map(x => x.t.term)); } catch (error) { log.warn?.(`[LiveTrends] zone-history baseline unavailable: ${error.message}`); hook = null; }
      }
      lists.emerging = candidates.map(x => {
        const baseline = baselineFor(x.t.term, model.history, hook);
        const frontierShare = x.t.ops.size ? x.t.frontierOps.size / x.t.ops.size : 0;
        const score = round(emergingScore({ term: x.t.term, operators: x.m.operators, perMillion: baseline.perMillion, roles: x.m.roles, partners: x.m.partners, zones: x.m.zones, frontierShare, presence: baseline.presence, established: baseline.established }) * (x.m.boost || 1), 4);
        return { x, baseline, frontierShare, score };
      }).filter(e => e.score > 0)
        .sort((a, b) => b.score - a.score || b.x.m.operators - a.x.m.operators || a.x.t.term.localeCompare(b.x.t.term))
        .slice(0, q.limit)
        .map(({ x, baseline, frontierShare, score }) => ({
          ...keywordItem(x, sales),
          score,
          evidence: {
            baselineFrequency: baseline,
            operators: x.m.operators,
            roles: [...x.t.roles].sort(),
            partners: [...x.t.partners].slice(0, 12),
            zones: [...x.t.zones].sort(),
            frontierShare: round(frontierShare, 2),
            frontierPartners: [...x.t.frontierPartners].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([term, sites]) => ({ term, sites })),
            examples: examplesOf(x.t.examples),
          },
        }));
    }

    if (q.kind === 'all' || q.kind === 'clusters') lists.clusters = clustersOf(model, q, sales);

    return {
      ...base,
      asOf: info.anchor,
      days: info.days,
      coverage: {
        sites: model.sites,
        operators: model.windowOps.size,
        registrationDays: model.regs.size,
        baselineDays: model.history.days,
        baselineFrom: model.history.firstDay,
        baselinePending: model.baselineMissing,
        salesAvailable: !!sales,
        networks: networkSummary(model.networks),
        days: model.coverageDays,
        rise: riseCoverage(model.riseWindow, model.days),
      },
      ...lists,
    };
  }

  function clustersOf(model, q, sales) {
    const totalOps = model.windowOps.size;
    const byTerm = new Map(model.scored.map(x => [x.t.term, x]));
    const candidates = model.scored
      .filter(x => x.m.operators >= 2 && !(totalOps >= 20 && x.m.operators > 0.25 * totalOps))
      .sort((a, b) => b.m.operators - a.m.operators || a.t.term.localeCompare(b.t.term))
      .slice(0, CLUSTER_CANDIDATES);
    const candidateSet = new Set(candidates.map(x => x.t.term));
    const termOps = new Map(candidates.map(x => [x.t.term, x.m.operators]));
    const opTerms = new Map();
    const windowSites = [];
    model.ordered.forEach((site, i) => {
      if (site.day < model.windowStart) return;
      const op = model.ops[i];
      let set = opTerms.get(op);
      if (!set) { set = new Set(); opTerms.set(op, set); }
      const siteTerms = new Set();
      for (const term of model.lists[i]) if (candidateSet.has(term)) { set.add(term); siteTerms.add(term); }
      windowSites.push({ site, op, terms: siteTerms });
    });
    const groups = buildClusters(opTerms, termOps);
    const S = SPAN_DAYS;
    return groups.map(members => {
      const memberSet = new Set(members);
      const days = Array.from({ length: S }, (_, i) => {
        const out = new Set();
        for (const term of members) { const d = byTerm.get(term).t.days[i]; if (d) for (const op of d) out.add(op); }
        return out;
      });
      const union = (from, to) => { const out = new Set(); for (let i = from; i < to; i++) for (const op of days[i]) out.add(op); return out; };
      const operators = union(S - q.windowDays, S).size;
      const rise = shareRise(unionIdx(days, model.riseWindow.recent).size, unionIdx(days, model.riseWindow.prior).size, model.riseWindow);
      const examples = examplesOf(windowSites.filter(w => [...w.terms].filter(t => memberSet.has(t)).length >= 2)
        .map(w => ({ domain: w.site.d, title: w.site.ti, day: w.site.day, op: w.op })));
      return {
        name: members.slice(0, 3).join(' · '),
        members: members.map(term => { const x = byTerm.get(term); return { keyword: term, operators: x.m.operators, stage: x.m.stage, speculative: x.m.speculative }; }),
        operators,
        rise,
        series: days.map(s => s.size),
        examples,
      };
    }).sort((a, b) => b.operators - a.operators || (b.rise || 0) - (a.rise || 0) || a.name.localeCompare(b.name))
      .slice(0, q.limit);
  }

  /** Indexes newly landed observations for the span and warms registration caches in the background. */
  async function refresh() {
    const info = await span();
    if (!info) return { days: 0 };
    for (const day of info.days) await indexDay(day);
    const existing = new Set(info.dirs);
    const missing = [];
    for (const day of info.days.filter(d => existing.has(d))) if ((await loadReg(day, false)) === undefined) missing.push(day);
    if (missing.length) scheduleWarm(missing);
    const history = await historyLexicon(info.days[0], info.dirs, 0);
    return { days: info.days.length, registrationsPending: missing.length + history.pending };
  }

  return { query: input => exclusive(() => query(input)), refresh: () => exclusive(refresh), indexDay: day => exclusive(() => indexDay(day)), whenWarm: () => warming || Promise.resolve(), cacheStats: () => ({ ...stats, days: dayStates.size, retainedModels: models.size }) };
}

function registerLiveTrendsRoutes(app, trends, { env = process.env, limiter, maxAgeSeconds } = {}) {
  const max = Number(env.DOMAINSCOUT_LIVE_SITES_RATE_LIMIT) > 0 ? Math.trunc(Number(env.DOMAINSCOUT_LIVE_SITES_RATE_LIMIT)) : 120;
  const take = limiter || createRateLimiter({ windowMs: 60000, max });
  const maxAge = Number.isFinite(maxAgeSeconds) ? maxAgeSeconds : 60;
  const cors = res => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    res.set('Vary', 'Accept-Encoding');
  };
  app.options(PATH, (req, res) => { cors(res); res.set('Access-Control-Max-Age', '600'); res.status(204).end(); });
  app.get(PATH, async (req, res) => {
    cors(res);
    const verdict = take(clientKey(req));
    if (!verdict.allowed) {
      res.set('Retry-After', String(verdict.retryAfterSeconds));
      res.set('Cache-Control', 'no-store');
      return res.status(429).json({ error: 'rate limit exceeded' });
    }
    try {
      const body = await trends.query(req.query || {});
      res.set('Cache-Control', `public, max-age=${maxAge}`);
      return res.status(200).json(body);
    } catch (error) {
      const status = error.statusCode && error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 503;
      res.set('Cache-Control', 'no-store');
      if (status === 503) console.error(`[LiveTrends] read failed: ${error.message}`);
      return res.status(status).json({ error: status === 503 ? 'live trends unavailable' : error.message });
    }
  });
}

module.exports = {
  PATH,
  VERSION,
  FRONTIER_TERMS,
  RISE_MIN_RECENT,
  createLiveTrends,
  registerLiveTrendsRoutes,
  parseQuery,
  segmentDomainLabel,
  domainEntries,
  textTerms,
  textEntries,
  operatorKeys,
  operatorIndex,
  riseScore,
  shareRise,
  riseWindows,
  emergingScore,
  stageFor,
  speculativeFlag,
  organicFlag,
  builtShareFalling,
  buildClusters,
  isEndUserSale,
  termInLabel,
  unknownTerms,
  isEstablishedVocabulary,
  historyEstablished,
  templateKeys,
  networkSummary,
  TEMPLATE_MIN_SITES,
  SPAM_KIT_MIN_SITES,
  globalSignal,
  siteLanguage,
  isKeywordToken,
};
