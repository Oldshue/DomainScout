'use strict';

/**
 * Live-sites site-observation stage.
 *
 * After a day's nameserver-movement tape lands (<universeDir>/<day>/ns/ and
 * ns-observed/<tld>/), every `went-live` name (DNS moved from nothing,
 * parking or a registrar default onto hosting) is fetched once over HTTPS
 * (HTTP fallback) with bounded concurrency, a strict whole-request deadline,
 * a response-size cap and an honest User-Agent. Each observation records the
 * final URL, HTTP status, title, meta/OG description and one class:
 *
 *   built | parked | for_sale | placeholder | redirect_offsite | error
 *
 * Classification reuses the repository's existing knowledge: nameserver
 * classes (server/nameserver-classes.js, server/sale-watch-dns.js), the
 * storefront/placeholder/spam page classifier (sale-watch-evidence
 * websitePurpose), the subject-domain sale-statement detector
 * (lander-evidence classifyLander) and the cataloged lander hosts.
 *
 * Kits: when many names from one day share one page template and title (one
 * actor's batch), every member is marked as a kit and only distinct sites
 * count as built.
 *
 * Output lives next to the day's tape on the data volume:
 *   <universeDir>/<day>/sites/observations.jsonl   (final, kit-collapsed)
 *   <universeDir>/<day>/sites/summary.json         (status, counts, receipts)
 *   <universeDir>/<day>/sites/observations.partial.jsonl (resume journal)
 * A redeploy mid-run resumes from the journal instead of refetching.
 *
 * Nothing here runs at require-time and nothing opens a connection unless
 * observeDay/fetchSite is called. All network access is injectable.
 */

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const readline = require('readline');
const cheerio = require('cheerio');

const SCHEMA = 'domainscout.live-sites/v1';
const CLASSIFIER_VERSION = 'live-sites-classifier-v1';
const CLASSES = Object.freeze(['built', 'parked', 'for_sale', 'placeholder', 'redirect_offsite', 'error']);
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DOMAIN_PATTERN = /^(?=.{3,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/;

const DEFAULTS = Object.freeze({
  concurrency: 48,
  timeoutMs: 8000,
  maxBytes: 256 * 1024,
  maxRedirects: 5,
  maxNames: 150000,
  kitThreshold: 5,
  kitTitleThreshold: 8,
  progressEvery: 500,
});

const DEFAULT_USER_AGENT = 'DomainScout-LiveSites/1.0 (+https://github.com/Oldshue/DomainScout; one homepage fetch per newly delegated domain)';

function intEnv(raw, fallback, min, max) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) return fallback;
  return n;
}

/** Resolves stage limits from env (DOMAINSCOUT_LIVE_SITES_*), clamped to safe ranges. */
function resolveLiveSitesConfig(env = process.env) {
  return {
    concurrency: intEnv(env.DOMAINSCOUT_LIVE_SITES_CONCURRENCY, DEFAULTS.concurrency, 1, 256),
    timeoutMs: intEnv(env.DOMAINSCOUT_LIVE_SITES_TIMEOUT_MS, DEFAULTS.timeoutMs, 1000, 30000),
    maxBytes: intEnv(env.DOMAINSCOUT_LIVE_SITES_MAX_BYTES, DEFAULTS.maxBytes, 16 * 1024, 2 * 1024 * 1024),
    maxRedirects: intEnv(env.DOMAINSCOUT_LIVE_SITES_MAX_REDIRECTS, DEFAULTS.maxRedirects, 0, 10),
    maxNames: intEnv(env.DOMAINSCOUT_LIVE_SITES_MAX_NAMES, DEFAULTS.maxNames, 1, 2000000),
    kitThreshold: intEnv(env.DOMAINSCOUT_LIVE_SITES_KIT_THRESHOLD, DEFAULTS.kitThreshold, 2, 10000),
    kitTitleThreshold: intEnv(env.DOMAINSCOUT_LIVE_SITES_KIT_TITLE_THRESHOLD, DEFAULTS.kitTitleThreshold, 2, 10000),
    userAgent: String(env.DOMAINSCOUT_LIVE_SITES_USER_AGENT || '').trim() || DEFAULT_USER_AGENT,
  };
}

function zoneOf(domain) {
  const value = String(domain || '');
  return value.slice(value.lastIndexOf('.') + 1);
}

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/\.$/, ''); } catch { return ''; }
}

function bareHost(host) {
  return String(host || '').toLowerCase().replace(/^www\./, '');
}

/** True when `host` is the domain itself, www.<domain> or any subdomain of it. */
function sameSite(host, domain) {
  const h = bareHost(host);
  const d = bareHost(domain);
  return !!h && (h === d || h.endsWith(`.${d}`));
}

function sha1(value) {
  return crypto.createHash('sha1').update(String(value)).digest('hex');
}

// ── Fetching ────────────────────────────────────────────────────────────────

function errorReason(error) {
  if (!error) return 'unknown';
  if (error.name === 'AbortError' || error.name === 'TimeoutError' || error.timedOut) return 'timeout';
  const code = error.cause?.code || error.code;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'EAI_NONAME') return 'dns';
  if (code === 'ECONNREFUSED') return 'refused';
  if (code === 'ECONNRESET' || code === 'UND_ERR_SOCKET' || code === 'EPIPE') return 'reset';
  if (/CERT|SSL|TLS|ERR_TLS|DEPTH_ZERO|SELF_SIGNED|UNABLE_TO_VERIFY|HOSTNAME_MISMATCH/i.test(String(code || '') + ' ' + String(error.cause?.message || error.message || ''))) return 'tls';
  if (error.reason) return error.reason;
  return 'network';
}

async function readCapped(response, maxBytes) {
  if (!response.body) return { text: '', bytes: 0, truncated: false };
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = maxBytes - bytes;
      if (value.byteLength > remaining) {
        if (remaining > 0) chunks.push(Buffer.from(value.buffer, value.byteOffset, remaining));
        bytes += Math.max(0, remaining);
        truncated = true;
        break;
      }
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
      bytes += value.byteLength;
    }
  } finally {
    if (truncated) await reader.cancel().catch(() => {});
    else reader.releaseLock?.();
  }
  return { text: new TextDecoder('utf-8', { fatal: false }).decode(Buffer.concat(chunks)), bytes, truncated };
}

async function discardBody(response) {
  try { await response.body?.cancel(); } catch { /* best effort */ }
}

/**
 * One scheme attempt with manual redirect following under ONE deadline that
 * covers every hop and the body read. Never throws.
 */
async function fetchOnce(startUrl, { fetchImpl, timeoutMs, maxBytes, maxRedirects, userAgent }) {
  const controller = new AbortController();
  // Ref'd on purpose: the deadline must keep the loop alive while a request is
  // pending (Node 22 otherwise drains with the fetch unresolved). It is always
  // cleared in `finally`, so it never outlives the attempt.
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const hops = [];
  let url = startUrl;
  try {
    for (let hop = 0; ; hop += 1) {
      const response = await fetchImpl(url, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'user-agent': userAgent,
          accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
          'accept-language': 'en;q=0.9,*;q=0.5',
        },
      });
      const location = response.headers.get('location');
      if (response.status >= 300 && response.status < 400 && location) {
        await discardBody(response);
        let next;
        try { next = new URL(location, url).href; } catch { return { ok: false, reason: 'bad_redirect', hops, finalUrl: url, status: response.status }; }
        if (!/^https?:$/.test(new URL(next).protocol)) return { ok: false, reason: 'bad_redirect', hops, finalUrl: next, status: response.status };
        hops.push(next);
        if (hop + 1 > maxRedirects) return { ok: false, reason: 'too_many_redirects', hops, finalUrl: next, status: response.status };
        url = next;
        continue;
      }
      const contentType = String(response.headers.get('content-type') || '').toLowerCase();
      const textual = !contentType || /text\/html|application\/xhtml|text\/plain/.test(contentType);
      let body = { text: '', bytes: 0, truncated: false };
      if (textual) body = await readCapped(response, maxBytes);
      else await discardBody(response);
      return { ok: true, finalUrl: url, status: response.status, contentType, html: body.text, bytes: body.bytes, truncated: body.truncated, hops };
    }
  } catch (error) {
    return { ok: false, reason: controller.signal.aborted ? 'timeout' : errorReason(error), hops, finalUrl: url, status: null };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetches a domain's homepage: HTTPS first, HTTP only when HTTPS failed at the
 * transport level (an HTTPS HTTP-status answer is kept as the observation).
 * Returns { ok, scheme, requestedUrl, finalUrl, status, html, ... } or
 * { ok:false, reason }. Never throws.
 */
async function fetchSite(domain, opts = {}) {
  const config = {
    fetchImpl: opts.fetchImpl || globalThis.fetch,
    timeoutMs: opts.timeoutMs || DEFAULTS.timeoutMs,
    maxBytes: opts.maxBytes || DEFAULTS.maxBytes,
    maxRedirects: Number.isInteger(opts.maxRedirects) ? opts.maxRedirects : DEFAULTS.maxRedirects,
    userAgent: opts.userAgent || DEFAULT_USER_AGENT,
  };
  const urlFor = opts.urlFor || ((scheme, name) => `${scheme}://${name}/`);
  const attempts = [];
  for (const scheme of ['https', 'http']) {
    const requestedUrl = urlFor(scheme, domain);
    const result = await fetchOnce(requestedUrl, config);
    if (result.ok || result.status) return { ...result, scheme, requestedUrl, attempts };
    attempts.push({ scheme, reason: result.reason });
  }
  return { ok: false, scheme: null, requestedUrl: urlFor('https', domain), finalUrl: null, status: null, reason: attempts.at(-1)?.reason || 'network', attempts };
}

// ── Page parsing & classification ──────────────────────────────────────────

function cleanText(value, max) {
  const text = String(value || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** Extracts title, description, visible text sample, meta-refresh target and a template skeleton. */
function parsePage(html, baseUrl) {
  const source = String(html || '');
  const $ = cheerio.load(source.slice(0, 512 * 1024));
  const title = cleanText($('title').first().text() || $('meta[property="og:title"]').attr('content') || $('meta[name="twitter:title"]').attr('content') || '', 200);
  const description = cleanText($('meta[name="description"]').attr('content') || $('meta[property="og:description"]').attr('content') || $('meta[name="twitter:description"]').attr('content') || '', 300);
  let metaRefresh = null;
  const refresh = $('meta[http-equiv]').filter((_, el) => String($(el).attr('http-equiv') || '').toLowerCase() === 'refresh').first().attr('content');
  const refreshUrl = refresh && String(refresh).match(/url\s*=\s*['"]?([^'"\s;]+)/i)?.[1];
  if (refreshUrl) { try { metaRefresh = new URL(refreshUrl, baseUrl).href; } catch { metaRefresh = null; } }
  const scripts = $('script[src]').map((_, el) => $(el).attr('src')).get().join(' ');
  $('script, style, noscript, template, svg').remove();
  const text = cleanText($('body').text() || $.root().text(), 4000);
  const tags = (source.slice(0, 65536).match(/<([a-z][a-z0-9-]*)\b(?:[^>]*?\bclass\s*=\s*["']([^"']*)["'])?/gi) || []).slice(0, 400)
    .map(tag => tag.toLowerCase().replace(/\s+/g, ' ').replace(/[0-9]+/g, '0')).join('>');
  return { title, description, text, metaRefresh, scripts, skeleton: sha1(tags).slice(0, 16) };
}

const GENERIC_TITLES = /^(?:home|homepage|home page|index|index of .*|untitled|untitled document|document|welcome|welcome!|loading|loading\.{0,3}|redirecting.*|react app|vite app|vite \+ react.*|next\.js|nuxt|create next app|my site|my website|my blog|website|site|blog|just another wordpress site|my wordpress.*|hello world!?|test|test page|it works!?|default page|404.*|403.*|error.*|not found|page not found|access denied|forbidden|just a moment\.{0,3}|attention required.*|coming soon|under construction|maintenance.*|null|undefined)$/i;

/** A title a person could read in a feed: not empty, not just the domain, not a framework/server default. */
function isRealTitle(title, domain) {
  const value = cleanText(title, 300);
  if (value.length < 2) return false;
  const lower = value.toLowerCase();
  const bare = bareHost(domain);
  const label = bare.split('.')[0];
  if ([bare, `www.${bare}`, label, `https://${bare}`, `http://${bare}`].includes(lower.replace(/\/$/, ''))) return false;
  if (GENERIC_TITLES.test(lower)) return false;
  if (!/[\p{L}\p{N}]/u.test(value)) return false;
  return true;
}

const PARKED_TEXT = /(?:\brelated searches\b|\bsponsored listings\b|\bthis domain (?:is|has been) parked\b|\bparked (?:free|domain|courtesy|page)\b|\bdomain parking\b|\bparking page\b|\bthe domain (?:name )?[a-z0-9.-]+ (?:has been|is|was) registered\b|\bthis domain (?:name )?(?:has been|was|is) (?:just )?registered\b|\b(?:recently|just) registered (?:at|with|via|by)\b|\bregistered (?:at|with|through) (?:namecheap|godaddy|porkbun|dynadot|namesilo|spaceship|hostinger|ionos|name\.com|gandi|squarespace)\b|\bthis (?:web )?page is (?:parked|provided courtesy)\b|\bcourtesy of (?:godaddy|namecheap|dynadot|porkbun|namesilo)\b|\bbuy this domain\b)/i;
const PARKED_MARKUP = /(?:adsense\/domains\/caf\.js|\/caf\/\?|parkingcrew|bodis\.com|sedoparking|parklogic|above\.com\/|dsparking|parking-lander|img1\.wsimg\.com\/parking|ww\d\.[a-z0-9-]+\.[a-z]+\/\?|window\.park\b|park\.js)/i;
const PARKING_HOST = /(?:^|\.)(?:sedoparking\.com|bodis\.com|parkingcrew\.net|parklogic\.com|above\.com|dsparking\.com|uniregistrymarket\.link|smartname\.com|ztomy\.com|sslparking\.com|parktons\.com|dnparking\.com|domainparking\.[a-z]+)$/i;

let cachedEvidence = null;
function evidenceModules() {
  if (!cachedEvidence) {
    cachedEvidence = {
      websitePurpose: require('./sale-watch-evidence').websitePurpose,
      classifyLander: require('./lander-evidence').classifyLander,
      hasParkingClassNameserver: require('./sale-watch-dns').hasParkingClassNameserver,
      landerHosts: require('../config/sale-watch-lander-hosts.json').hosts,
    };
  }
  return cachedEvidence;
}

function isLanderHost(host) {
  const h = bareHost(host);
  return evidenceModules().landerHosts.some(value => h === value || h.endsWith(`.${value}`));
}

/**
 * Classifies one fetched page. Input: { domain, fetched (fetchSite result),
 * nameservers? (today's NS for this name) }. Output: { class, reason, title,
 * description, finalUrl, status, spam, titleReal, fingerprint }.
 */
function classifyObservation({ domain, fetched, nameservers = [] }) {
  const mods = evidenceModules();
  const base = { title: null, description: null, finalUrl: fetched?.finalUrl || null, status: fetched?.status ?? null, spam: false, titleReal: false, fingerprint: null };
  const nsParked = Array.isArray(nameservers) && nameservers.length > 0 && mods.hasParkingClassNameserver(nameservers);
  if (!fetched || (!fetched.ok && !fetched.status)) {
    if (nsParked) return { ...base, class: 'parked', reason: 'parking_nameservers' };
    return { ...base, class: 'error', reason: fetched?.reason || 'no_response' };
  }
  if (!fetched.ok) {
    // Redirect chain failure (too many hops / non-http target).
    const host = hostOf(fetched.finalUrl);
    if (host && !sameSite(host, domain)) {
      if (isLanderHost(host)) return { ...base, class: 'for_sale', reason: 'lander_host_redirect' };
      if (PARKING_HOST.test(bareHost(host))) return { ...base, class: 'parked', reason: 'parking_host_redirect' };
    }
    return { ...base, class: 'error', reason: fetched.reason || 'redirect_failure' };
  }
  const finalHost = hostOf(fetched.finalUrl);
  const page = parsePage(fetched.html, fetched.finalUrl);
  const titleReal = isRealTitle(page.title, domain);
  const withPage = {
    ...base,
    title: page.title || null,
    description: page.description || null,
    titleReal,
    fingerprint: { title: normalizeTemplateTitle(page.title, domain), skeleton: page.skeleton },
  };
  // Off-site destination (HTTP redirect chain or an immediate meta refresh).
  const offsiteTarget = !sameSite(finalHost, domain) ? fetched.finalUrl
    : (page.metaRefresh && !sameSite(hostOf(page.metaRefresh), domain) ? page.metaRefresh : null);
  if (offsiteTarget) {
    const host = hostOf(offsiteTarget);
    if (isLanderHost(host)) return { ...withPage, finalUrl: offsiteTarget, class: 'for_sale', reason: 'lander_host_redirect' };
    if (PARKING_HOST.test(bareHost(host)) || /(?:portfolio_landers|domain_redirect|parking)/i.test(offsiteTarget)) return { ...withPage, finalUrl: offsiteTarget, class: 'parked', reason: 'parking_host_redirect' };
    return { ...withPage, finalUrl: offsiteTarget, class: 'redirect_offsite', reason: 'offsite_destination' };
  }
  if (fetched.status < 200 || fetched.status >= 300) {
    return { ...withPage, class: 'error', reason: `http_${fetched.status}` };
  }
  const purpose = mods.websitePurpose({ html: fetched.html, title: page.title, finalUrl: fetched.finalUrl, status: fetched.status });
  const lander = mods.classifyLander({ domain, html: fetched.html, status: fetched.status, finalUrl: fetched.finalUrl });
  const spam = !!purpose.spam;
  if (purpose.forSale || lander.forSale) return { ...withPage, spam, class: 'for_sale', reason: lander.forSale ? lander.reason : 'storefront_or_offer' };
  const sample = `${page.title}\n${page.text}`;
  if (nsParked || PARKED_TEXT.test(sample) || PARKED_MARKUP.test(`${page.scripts}\n${String(fetched.html || '').slice(0, 65536)}`)) {
    return { ...withPage, spam, class: 'parked', reason: nsParked ? 'parking_nameservers' : 'parking_page_signals' };
  }
  if (purpose.kind === 'unavailable') return { ...withPage, spam, class: 'error', reason: 'challenge_or_access_wall' };
  if (purpose.kind === 'placeholder') return { ...withPage, spam, class: 'placeholder', reason: 'default_or_prelaunch_page' };
  if (!page.title && page.text.length < 200) return { ...withPage, spam, class: 'placeholder', reason: 'empty_page' };
  if (!titleReal && page.text.length < 200) return { ...withPage, spam, class: 'placeholder', reason: 'thin_default_page' };
  return { ...withPage, spam, class: 'built', reason: spam ? 'operating_spam_content' : 'operating_site' };
}

// ── Kit collapse ────────────────────────────────────────────────────────────

/** Lowercases a title and replaces the domain/label with a token so one template's titles collide. */
function normalizeTemplateTitle(title, domain) {
  let value = String(title || '').toLowerCase();
  const bare = bareHost(domain);
  const label = bare.split('.')[0];
  const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (bare) value = value.replace(new RegExp(`(?:www\\.)?${escape(bare)}`, 'g'), '{domain}');
  if (label.length >= 3) value = value.replace(new RegExp(escape(label), 'g'), '{name}');
  return value.replace(/[0-9]+/g, '0').replace(/\s+/g, ' ').trim();
}

/**
 * Marks one actor's batch: records with a fetched page are grouped by
 * (normalized title + page skeleton); a group of >= kitThreshold distinct
 * domains is a kit. Independently, a non-generic normalized title shared by
 * >= kitTitleThreshold domains is a kit (same lander, different markup).
 * Mutates and returns records; returns kit descriptors sorted by size.
 */
function collapseKits(records, { kitThreshold = DEFAULTS.kitThreshold, kitTitleThreshold = DEFAULTS.kitTitleThreshold } = {}) {
  const byTemplate = new Map();
  const byTitle = new Map();
  for (const record of records) {
    record.kit = null;
    const fp = record.fingerprint;
    if (!fp) continue;
    const tKey = `${fp.title}|${fp.skeleton}`;
    if (!byTemplate.has(tKey)) byTemplate.set(tKey, []);
    byTemplate.get(tKey).push(record);
    if (record.titleReal && fp.title && fp.title.replace(/\{(?:name|domain)\}/g, '').replace(/[^\p{L}\p{N}]+/gu, '').length >= 4) {
      if (!byTitle.has(fp.title)) byTitle.set(fp.title, []);
      byTitle.get(fp.title).push(record);
    }
  }
  const kits = new Map();
  const mark = (key, group, basis) => {
    const domains = new Set(group.map(record => record.domain));
    const id = `kit-${sha1(`${basis}:${key}`).slice(0, 12)}`;
    for (const record of group) {
      if (record.kit) continue;
      record.kit = { id, size: domains.size, basis };
    }
    if (!kits.has(id)) kits.set(id, { id, basis, size: domains.size, title: group[0].title || null, builtMembers: group.filter(record => record.class === 'built').length, examples: [...domains].slice(0, 5) });
  };
  for (const [key, group] of byTemplate) if (new Set(group.map(r => r.domain)).size >= kitThreshold) mark(key, group, 'template');
  for (const [key, group] of byTitle) if (new Set(group.map(r => r.domain)).size >= kitTitleThreshold) mark(key, group, 'title');
  return [...kits.values()].sort((a, b) => b.size - a.size || a.id.localeCompare(b.id));
}

// ── Day stage ───────────────────────────────────────────────────────────────

function sitesDir(directory, day) {
  if (!DAY_PATTERN.test(String(day || ''))) throw new Error(`Invalid day: ${day}`);
  return path.join(directory, day, 'sites');
}

async function atomicWrite(file, content) {
  const part = `${file}.${process.pid}.${Date.now()}.part`;
  await fsp.writeFile(part, content);
  await fsp.rename(part, file);
}

async function readJsonFile(file) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function readSiteSummary(directory, day) {
  return readJsonFile(path.join(sitesDir(directory, day), 'summary.json'));
}

/**
 * Streams every went-live row of one day across the CZDS tape and the
 * observed-zone fragments, de-duplicated by domain (first row wins).
 */
async function readWentLive(directory, day, { maxNames = DEFAULTS.maxNames } = {}) {
  const { dayMovementTapes } = require('./universe-lane');
  const tapes = dayMovementTapes(directory, day);
  const seen = new Map();
  let malformed = 0;
  let truncated = 0;
  for (const tape of tapes) {
    const lines = readline.createInterface({ input: fs.createReadStream(tape.tape, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line || line.indexOf('went-live') === -1) continue;
      let row;
      try { row = JSON.parse(line); } catch { malformed += 1; continue; }
      if (row.selection !== 'went-live') continue;
      const domain = String(row.domain || '').toLowerCase().replace(/\.$/, '');
      if (!DOMAIN_PATTERN.test(domain) || seen.has(domain)) continue;
      if (seen.size >= maxNames) { truncated += 1; continue; }
      seen.set(domain, { domain, nameservers: Array.isArray(row.today_ns) ? row.today_ns : [], provider: row.today_provider || null, source: tape.source });
    }
  }
  return { tapes: tapes.map(t => t.source), rows: [...seen.values()], malformed, truncated };
}

async function mapLimit(items, limit, worker, signal) {
  let next = 0;
  async function run() {
    for (;;) {
      if (signal?.aborted) return;
      const index = next;
      next += 1;
      if (index >= items.length) return;
      await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, run));
}

function toRecord(day, row, fetched, classified, observedAt) {
  return {
    domain: row.domain,
    zone: zoneOf(row.domain),
    day,
    class: classified.class,
    reason: classified.reason,
    status: classified.status ?? null,
    url: fetched?.requestedUrl || `https://${row.domain}/`,
    finalUrl: classified.finalUrl || null,
    scheme: fetched?.scheme || null,
    redirects: fetched?.hops?.length || 0,
    bytes: fetched?.bytes || 0,
    title: classified.title || null,
    description: classified.description || null,
    titleReal: !!classified.titleReal,
    spam: !!classified.spam,
    fingerprint: classified.fingerprint || null,
    provider: row.provider || null,
    observedAt,
    version: CLASSIFIER_VERSION,
  };
}

function countClasses(records) {
  const counts = Object.fromEntries(CLASSES.map(name => [name, 0]));
  const errors = {};
  for (const record of records) {
    counts[record.class] = (counts[record.class] || 0) + 1;
    if (record.class === 'error') errors[record.reason] = (errors[record.reason] || 0) + 1;
  }
  return { counts, errors };
}

/**
 * Observes every went-live name of one day and persists the result next to
 * the tape. Resumable (journal), idempotent (a complete day with the current
 * classifier version is skipped unless force), bounded (concurrency, per-name
 * deadline, byte cap, name cap). Throws only for unusable input (no tape) or
 * storage failure; a failing site never fails the stage.
 */
async function observeDay({ directory, day, force = false, env = process.env, config: overrides = {}, fetchImpl, urlFor, signal, now = () => new Date(), log = console, onProgress } = {}) {
  if (!directory) throw new Error('directory is required');
  const config = { ...resolveLiveSitesConfig(env), ...overrides };
  const outDir = sitesDir(directory, day);
  const summaryPath = path.join(outDir, 'summary.json');
  const finalPath = path.join(outDir, 'observations.jsonl');
  const journalPath = path.join(outDir, 'observations.partial.jsonl');
  const previous = await readJsonFile(summaryPath).catch(() => null);
  if (!force && previous?.status === 'complete' && previous.version === CLASSIFIER_VERSION) {
    return { skipped: 'complete', day, summary: previous };
  }
  const input = await readWentLive(directory, day, { maxNames: config.maxNames });
  if (!input.tapes.length) {
    const error = new Error(`No NS movement tape for day ${day}`);
    error.code = 'NO_TAPE';
    throw error;
  }
  await fsp.mkdir(outDir, { recursive: true });
  const startedAt = now().toISOString();
  const done = new Map();
  if (force) await fsp.rm(journalPath, { force: true });
  else {
    try {
      const lines = readline.createInterface({ input: fs.createReadStream(journalPath, { encoding: 'utf8' }), crlfDelay: Infinity });
      for await (const line of lines) {
        if (!line) continue;
        try { const record = JSON.parse(line); if (record?.domain && record.version === CLASSIFIER_VERSION) done.set(record.domain, record); } catch { /* torn final line from a crash */ }
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const resumed = done.size;
  const pending = input.rows.filter(row => !done.has(row.domain));
  const writeStatus = async extra => atomicWrite(summaryPath, JSON.stringify({
    schema: SCHEMA, version: CLASSIFIER_VERSION, day, status: 'running', startedAt,
    total: input.rows.length, observed: done.size, resumed, tapes: input.tapes,
    truncatedNames: input.truncated, malformedRows: input.malformed, updatedAt: now().toISOString(), ...extra,
  }));
  await writeStatus({});
  // A cleaned-but-unrenamed journal would lose its torn tail; ensure it ends on a line boundary.
  const journal = fs.createWriteStream(journalPath, { flags: 'a' });
  let journalError = null;
  journal.on('error', error => { journalError = error; });
  const appendJournal = record => new Promise((resolve, reject) => {
    if (journalError) return reject(journalError);
    const ok = journal.write(`${JSON.stringify(record)}\n`);
    if (ok) resolve(); else journal.once('drain', resolve);
  });
  let sinceProgress = 0;
  let progressChain = Promise.resolve();
  try {
    await mapLimit(pending, config.concurrency, async row => {
      let fetched;
      let classified;
      try {
        fetched = await fetchSite(row.domain, { fetchImpl, urlFor, timeoutMs: config.timeoutMs, maxBytes: config.maxBytes, maxRedirects: config.maxRedirects, userAgent: config.userAgent });
        classified = classifyObservation({ domain: row.domain, fetched, nameservers: row.nameservers });
      } catch (error) {
        classified = { class: 'error', reason: `classifier_failure:${String(error?.message || error).slice(0, 80)}`, status: fetched?.status ?? null };
      }
      const record = toRecord(day, row, fetched, classified, now().toISOString());
      done.set(row.domain, record);
      await appendJournal(record);
      sinceProgress += 1;
      if (sinceProgress >= DEFAULTS.progressEvery) {
        sinceProgress = 0;
        progressChain = progressChain.then(() => writeStatus({})).catch(error => log?.warn?.(`[LiveSites] progress write failed: ${error.message}`));
        onProgress?.({ day, observed: done.size, total: input.rows.length });
      }
    }, signal);
  } finally {
    await new Promise(resolve => journal.end(resolve));
    await progressChain;
  }
  if (journalError) throw journalError;
  if (signal?.aborted) {
    await writeStatus({ status: 'interrupted', error: 'Stage aborted; journal retained for resume' });
    const error = new Error('Live-sites stage aborted');
    error.code = 'ABORTED';
    throw error;
  }
  const records = input.rows.map(row => done.get(row.domain)).filter(Boolean);
  const kits = collapseKits(records, config);
  const { counts, errors } = countClasses(records);
  const builtRecords = records.filter(record => record.class === 'built');
  const builtIndependent = builtRecords.filter(record => !record.kit).length;
  const kitsWithBuilt = kits.filter(kit => kit.builtMembers > 0).length;
  const publishable = builtRecords.filter(record => !record.kit && !record.spam && record.titleReal).length;
  const tmp = `${finalPath}.part`;
  await fsp.writeFile(tmp, records.map(record => JSON.stringify(record)).join('\n') + (records.length ? '\n' : ''));
  await fsp.rename(tmp, finalPath);
  const finishedAt = now().toISOString();
  const summary = {
    schema: SCHEMA, version: CLASSIFIER_VERSION, day, status: 'complete', startedAt, finishedAt,
    durationMs: Date.parse(finishedAt) - Date.parse(startedAt),
    total: input.rows.length, observed: records.length, resumed, tapes: input.tapes,
    truncatedNames: input.truncated, malformedRows: input.malformed,
    counts, errors,
    built: { pages: builtRecords.length, independent: builtIndependent, kitBatches: kitsWithBuilt, distinct: builtIndependent + kitsWithBuilt, publishable },
    kits: { count: kits.length, names: records.filter(record => record.kit).length, largest: kits.slice(0, 25) },
    limits: { concurrency: config.concurrency, timeoutMs: config.timeoutMs, maxBytes: config.maxBytes, maxRedirects: config.maxRedirects, maxNames: config.maxNames, kitThreshold: config.kitThreshold, kitTitleThreshold: config.kitTitleThreshold },
    userAgent: config.userAgent,
  };
  await atomicWrite(summaryPath, JSON.stringify(summary));
  await fsp.rm(journalPath, { force: true });
  log?.log?.(`[LiveSites] ${day}: observed ${records.length} went-live names; built ${builtRecords.length} (${summary.built.distinct} distinct, ${publishable} publishable), kits ${kits.length}`);
  return { day, summary };
}

/** Days (newest first) that have a movement tape, with each day's site-observation summary or null. */
async function listObservationDays(directory) {
  const { dayMovementTapes } = require('./universe-lane');
  let entries;
  try { entries = await fsp.readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const days = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !DAY_PATTERN.test(entry.name)) continue;
    const hasTape = dayMovementTapes(directory, entry.name).length > 0;
    const summary = await readSiteSummary(directory, entry.name).catch(error => ({ status: 'unreadable', error: error.message }));
    if (hasTape || summary) days.push({ day: entry.name, hasTape, summary });
  }
  return days.sort((a, b) => b.day.localeCompare(a.day));
}

module.exports = {
  SCHEMA, CLASSIFIER_VERSION, CLASSES, DEFAULTS, DEFAULT_USER_AGENT,
  resolveLiveSitesConfig, fetchSite, parsePage, isRealTitle, classifyObservation,
  normalizeTemplateTitle, collapseKits, readWentLive, observeDay, listObservationDays,
  readSiteSummary, sitesDir, sameSite, zoneOf,
};
