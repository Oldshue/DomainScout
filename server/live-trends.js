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

const PATH = '/api/public/live-trends';
const VERSION = 'live-trends-v1';
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
const TRENDING_MIN_RISE = 1.5;
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

function segGreedy(label, v) {
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
      out.push('?');
      i = k;
      continue;
    }
    out.push(best);
    i += best.length;
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

/** Exact-form words and adjacent two-word phrases from title + description + page text. */
function textTerms(title, description, text) {
  const source = [title, description, text].filter(Boolean).map(String).join(' . ').slice(0, TEXT_MAX_CHARS)
    .normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const uni = new Set();
  const bi = new Set();
  for (const phrase of source.split(/[.,;:!?|·•–—()[\]{}"<>/\\\n\r\t#*=+_~@]+/)) {
    const tokens = phrase.match(/[a-z0-9]+/g) || [];
    let prev = null;
    for (const token of tokens) {
      const valid = token.length >= 2 && token.length <= 24 && /^[a-z][a-z0-9]*$/.test(token) && !TEXT_STOP.has(token) && !WEB_STOP.has(token);
      if (!valid) { prev = null; continue; }
      if (uni.size < MAX_TEXT_UNIGRAMS) uni.add(token);
      if (prev && bi.size < MAX_TEXT_BIGRAMS) bi.add(`${prev} ${token}`);
      prev = token;
    }
    if (uni.size >= MAX_TEXT_UNIGRAMS && bi.size >= MAX_TEXT_BIGRAMS) break;
  }
  return [...uni, ...bi];
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
  };
}

/** Collapses sites into operators (union-find over operatorKeys). Returns site -> operator id. */
function operatorIndex(sites) {
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
  return site => find(site.ok[0]);
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

function lexicalNovelty(term) {
  const { common } = minerVocabulary();
  const one = word => {
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
function emergingScore({ term, operators, perMillion = null, roles = 0, partners = 0, zones = 0, frontierShare = 0 }) {
  if (!(operators >= 2)) return 0;
  const regNovelty = perMillion == null ? 1 : 1 / (1 + Math.log10(1 + perMillion));
  const novelty = regNovelty * lexicalNovelty(term);
  const adoption = Math.log2(1 + operators);
  const widening = 1 + (roles >= 2 ? 0.4 : 0) + Math.min(partners, 10) * 0.05 + (zones >= 2 ? 0.3 : 0);
  const frontier = 1 + 1.5 * Math.min(1, Math.max(0, frontierShare));
  return round(novelty * adoption * widening * frontier, 4);
}

const sumRange = (arr, from, to) => { let s = 0; for (let i = from; i < to; i++) s += arr[i] || 0; return s; };

function hasRegistrations(regs) { return Array.isArray(regs) && regs.some(v => v != null); }

/** Built share (builders per registration) over the last 3 days fell below 70% of the prior 7 days'. */
function builtShareFalling(built, regs) {
  if (!hasRegistrations(regs)) return false;
  const S = built.length;
  const r3 = sumRange(regs, S - 3, S); const r7 = sumRange(regs, S - 10, S - 3);
  if (r3 + r7 === 0) return false;
  const b3 = sumRange(built, S - 3, S); const b7 = sumRange(built, S - 10, S - 3);
  const prior = b7 / (r7 + 1);
  return prior > 0 && b3 / (r3 + 1) < 0.7 * prior;
}

/** Speculative: registrations rising (with a floor) while built launches are flat or falling. */
function speculativeFlag(built, regs) {
  if (!hasRegistrations(regs)) return false;
  const S = built.length;
  const r3 = sumRange(regs, S - 3, S); const r7 = sumRange(regs, S - 10, S - 3);
  const b3 = sumRange(built, S - 3, S); const b7 = sumRange(built, S - 10, S - 3);
  const regsRising = r3 >= REG_RISE_MIN && r3 / 3 >= 1.5 * ((r7 + 1) / 7);
  const builtFlat = b3 / 3 <= 1.1 * ((b7 + 1) / 7);
  return regsRising && builtFlat;
}

/** Organic pickup: built launches by independent operators growing. */
function organicFlag(built) {
  const S = built.length;
  const b3 = sumRange(built, S - 3, S); const b7 = sumRange(built, S - 10, S - 3);
  return b3 >= 3 && b3 / 3 > 1.2 * ((b7 + 1) / 7);
}

/**
 * Stage: confirmed (both weeks active, broad, real businesses), forming (3+
 * independent builders across 3+ days this week, widening, built share not
 * falling), otherwise watch.
 */
function stageFor(m) {
  const falling = !!m.builtShareFalling;
  if (m.opsFirstWeek >= 2 && m.opsLastWeek >= 2 && m.daysFirstWeek >= 2 && m.daysLastWeek >= 2
    && m.operators14 >= 8 && m.zones >= 2 && m.described >= 5 && !falling) return 'confirmed';
  if (m.opsLastWeek >= 3 && m.daysLastWeek >= 3 && (m.roles >= 2 || m.partners >= 3 || m.zones >= 2) && !falling) return 'forming';
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
  return { window: windowKey, windowDays: WINDOWS[windowKey], source, kind, limit };
}

// ── The index ──────────────────────────────────────────────────────────────
function createLiveTrends({
  universeDir,
  cacheDir,
  salesLoader = null,
  baselineLoader = null,
  baselineDays = 60,
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
    let n = 0;
    for (const label of labels) {
      const seen = new Set();
      for (const [term] of domainEntries(segmentDomainLabel(label))) {
        if (seen.has(term)) continue;
        seen.add(term);
        counts.set(term, (counts.get(term) || 0) + 1);
      }
      if (++n % 5000 === 0) await yieldLoop();
    }
    const kept = {};
    for (const [term, count] of counts) if (!term.includes(' ') || count >= 2) kept[term] = count;
    const value = { version: VERSION, day, signature, total: labels.size, counts: kept };
    try { await writeJsonAtomic(path.join(cache, 'regs', `${day}.json`), value); } catch (error) { log.warn?.(`[LiveTrends] regs cache write failed for ${day}: ${error.message}`); }
    return value;
  }

  /** Registration term counts for a day: memo, then disk cache, then (if allowed) a build. undefined = not built yet. */
  async function loadReg(day, allowBuild) {
    const file = path.join(universeDir, day, 'tape', 'adds.tsv');
    const stat = await statOrNull(file);
    if (!stat) return null;
    const signature = `${stat.size}:${Math.trunc(stat.mtimeMs)}`;
    const memo = regMemo.get(day);
    if (memo && memo.signature === signature) return memo;
    let value = await readJson(path.join(cache, 'regs', `${day}.json`));
    if (!value || value.version !== VERSION || value.signature !== signature) {
      if (!allowBuild) return undefined;
      value = await buildRegDay(day, file, signature);
    }
    const loaded = { signature, total: value.total, counts: new Map(Object.entries(value.counts || {})) };
    regMemo.set(day, loaded);
    return loaded;
  }

  function scheduleWarm(days) {
    for (const day of days) pendingRegs.add(day);
    if (warming || !pendingRegs.size) return warming;
    warming = (async () => {
      while (pendingRegs.size) {
        const day = [...pendingRegs].sort().pop();
        pendingRegs.delete(day);
        try { await loadReg(day, true); } catch (error) { log.warn?.(`[LiveTrends] registrations for ${day} failed: ${error.message}`); }
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
    const lists = ordered.map(site => siteEntries(site, source));
    const siteCount = new Map();
    for (const list of lists) {
      const seen = new Set();
      for (const [term] of list) { if (!seen.has(term)) { seen.add(term); siteCount.set(term, (siteCount.get(term) || 0) + 1); } }
    }
    const terms = new Map();
    const ops = ordered.map(opOf);
    ordered.forEach((site, i) => {
      const op = ops[i];
      const di = dayIndex.get(site.day);
      const present = new Set(lists[i].map(e => e[0]));
      const frontierHere = FRONTIER_TERMS.filter(f => present.has(f));
      for (const [term, role, partner, src] of lists[i]) {
        if (siteCount.get(term) < 2) continue;
        let t = terms.get(term);
        if (!t) {
          t = { term, days: Array(SPAN_DAYS).fill(null), ops: new Set(), zones: new Set(), roles: new Set(), partners: new Set(), sources: { domain: new Set(), text: new Set() }, described: new Set(), frontierOps: new Set(), frontierPartners: new Map(), examples: [], lastSite: -1 };
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
        const words = term.split(' ');
        const frontier = frontierHere.filter(f => f !== term && !words.includes(f));
        if (frontier.length) {
          t.frontierOps.add(op);
          for (const f of frontier) t.frontierPartners.set(f, (t.frontierPartners.get(f) || 0) + 1);
        }
        if (t.examples.length < 40) t.examples.push({ domain: site.d, title: site.ti, day: site.day, op });
      }
    });
    return { terms, ordered, ops, lists, dayIndex };
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

  function metrics(t, windowDays, regsByDay, days) {
    const S = SPAN_DAYS;
    const series = t.days.map(s => (s ? s.size : 0));
    const windowOps = unionDays(t, S - windowDays, S);
    const last7 = unionDays(t, S - 7, S);
    const first7 = unionDays(t, 0, S - 7);
    const last3 = unionDays(t, S - RISE_RECENT_DAYS, S).size;
    const prior7 = unionDays(t, S - RISE_RECENT_DAYS - RISE_PRIOR_DAYS, S - RISE_RECENT_DAYS).size;
    const active = (from, to) => series.slice(from, to).filter(Boolean).length;
    const registrations = days.map(day => {
      const reg = regsByDay.get(day);
      return reg ? (reg.counts.get(t.term) || 0) : null;
    });
    const regsKnown = hasRegistrations(registrations);
    const falling = builtShareFalling(series, registrations);
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
      rise: riseScore(last3, prior7),
      series,
      registrations: regsKnown ? registrations : null,
      zones: t.zones.size,
      roles: t.roles.size,
      partners: t.partners.size,
      described: t.described.size,
      builtShareFalling: falling,
    };
    m.stage = stageFor(m);
    m.speculative = speculativeFlag(series, registrations);
    m.organic = organicFlag(series);
    return m;
  }

  function baselineFor(term, baselineRegs, hook) {
    let count = 0;
    let total = 0;
    for (const reg of baselineRegs.values()) { count += reg.counts.get(term) || 0; total += reg.total || 0; }
    const daysCovered = baselineRegs.size;
    const fromHook = hook && hook.get(term);
    let perDay = daysCovered ? count / daysCovered : null;
    let perMillion = daysCovered && total ? (count / total) * 1e6 : null;
    if (fromHook && fromHook.days > 0) {
      const hookPerDay = fromHook.count / fromHook.days;
      perDay = Math.max(perDay || 0, hookPerDay);
      if (fromHook.total) perMillion = Math.max(perMillion || 0, (fromHook.count / fromHook.total) * 1e6);
    }
    return {
      perDay: perDay == null ? null : round(perDay, 2),
      perMillion: perMillion == null ? null : round(perMillion, 2),
      days: daysCovered,
      zoneHistoryDays: fromHook ? fromHook.days : 0,
      commonRank: term.includes(' ') ? null : (minerVocabulary().common.get(term) || null),
    };
  }

  async function buildModel(spanInfo, source, windowDays) {
    const { days } = spanInfo;
    const sites = [];
    for (const day of days) { const st = dayStates.get(day); if (st) sites.push(...st.sites); }
    const { terms, ordered, ops, lists } = aggregate(sites, days, source);
    const { regs } = await loadRegs(days, buildBudget);
    const baselineWanted = [];
    for (let k = 1; k <= baselineDays; k++) baselineWanted.push(addDays(days[0], -k));
    const existing = new Set(spanInfo.dirs);
    const { regs: baselineRegs, missing } = await loadRegs(baselineWanted.filter(d => existing.has(d)), buildBudget);
    const S = SPAN_DAYS;
    const windowStart = days[S - windowDays];
    const windowOps = new Set();
    ordered.forEach((site, i) => { if (site.day >= windowStart) windowOps.add(ops[i]); });
    const scored = [];
    for (const t of terms.values()) {
      const m = metrics(t, windowDays, regs, days);
      if (m.operators < 1) continue;
      scored.push({ t, m });
    }
    stats.models += 1;
    return { days, terms, ordered, ops, lists, scored, regs, baselineRegs, baselineMissing: missing.length, windowOps, windowStart, sites: sites.length };
  }

  function keywordItem({ t, m }, sales) {
    return {
      keyword: t.term,
      sources: { domain: t.sources.domain.size, text: t.sources.text.size },
      operators: m.operators,
      operators7: m.operators7,
      daysActive: m.daysActive,
      rise: m.rise,
      series: m.series,
      registrations: m.registrations,
      stage: m.stage,
      speculative: m.speculative,
      organic: m.organic,
      examples: examplesOf(t.examples),
      // Display-only context: never read by any score, rank, stage or flag.
      sales: salesFor(t.term, sales),
    };
  }

  async function query(rawQuery = {}) {
    const q = parseQuery(rawQuery);
    const info = await span();
    const base = { window: q.window, source: q.source, kind: q.kind, generatedAt: new Date(now()).toISOString() };
    const emptyLists = {
      ...(q.kind === 'all' || q.kind === 'emerging' ? { emerging: [] } : {}),
      ...(q.kind === 'all' || q.kind === 'trending' ? { trending: [] } : {}),
      ...(q.kind === 'all' || q.kind === 'biggest' ? { biggest: [] } : {}),
      ...(q.kind === 'all' || q.kind === 'clusters' ? { clusters: [] } : {}),
    };
    if (!info) return { ...base, asOf: null, days: [], coverage: { sites: 0, operators: 0, registrationDays: 0, baselineDays: 0, baselinePending: 0, salesAvailable: !!salesLoader }, ...emptyLists };
    for (const day of info.days) await indexDay(day);
    for (const day of [...dayStates.keys()]) if (!info.days.includes(day)) dayStates.delete(day);
    const signature = info.days.map(d => { const st = dayStates.get(d); return st ? `${d}:${st.rev}:${st.sites.length}` : `${d}:-`; }).join('|');
    const memoKey = `${signature}#${q.source}#${q.windowDays}`;
    let entry = models.get(memoKey);
    if (!entry || now() - entry.at > memoMs) {
      entry = { at: now(), model: await buildModel(info, q.source, q.windowDays) };
      models.set(memoKey, entry);
      while (models.size > 12) models.delete(models.keys().next().value);
    }
    const model = entry.model;
    const sales = await loadSales();
    const lists = {};

    const biggestRanked = model.scored.filter(x => x.m.operators >= 1)
      .sort((a, b) => b.m.operators - a.m.operators || b.m.daysActive - a.m.daysActive || a.t.term.localeCompare(b.t.term));
    if (q.kind === 'all' || q.kind === 'biggest') lists.biggest = biggestRanked.slice(0, q.limit).map(x => keywordItem(x, sales));

    if (q.kind === 'all' || q.kind === 'trending') {
      lists.trending = model.scored.filter(x => x.m.rise != null && x.m.rise >= TRENDING_MIN_RISE)
        .map(x => ({ x, score: round(x.m.rise * Math.log2(1 + x.m.operators) * (x.m.daysActive / q.windowDays), 4) }))
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
        const baseline = baselineFor(x.t.term, model.baselineRegs, hook);
        const frontierShare = x.t.ops.size ? x.t.frontierOps.size / x.t.ops.size : 0;
        const score = emergingScore({ term: x.t.term, operators: x.m.operators, perMillion: baseline.perMillion, roles: x.m.roles, partners: x.m.partners, zones: x.m.zones, frontierShare });
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
        baselineDays: model.baselineRegs.size,
        baselinePending: model.baselineMissing,
        salesAvailable: !!sales,
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
      for (const [term] of model.lists[i]) if (candidateSet.has(term)) { set.add(term); siteTerms.add(term); }
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
      const rise = riseScore(union(S - 3, S).size, union(S - 10, S - 3).size);
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
    const wanted = [...info.days];
    for (let k = 1; k <= baselineDays; k++) wanted.push(addDays(info.days[0], -k));
    const missing = [];
    for (const day of wanted.filter(d => existing.has(d))) if ((await loadReg(day, false)) === undefined) missing.push(day);
    if (missing.length) scheduleWarm(missing);
    return { days: info.days.length, registrationsPending: missing.length };
  }

  return { query, refresh, indexDay, whenWarm: () => warming || Promise.resolve(), cacheStats: () => ({ ...stats, days: dayStates.size }) };
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
  emergingScore,
  stageFor,
  speculativeFlag,
  organicFlag,
  builtShareFalling,
  buildClusters,
  isEndUserSale,
  termInLabel,
};
