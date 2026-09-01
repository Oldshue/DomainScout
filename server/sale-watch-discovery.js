'use strict';

const dns = require('node:dns').promises;
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const parentAuthorityCache = new Map();

const DNS_COFFEE_ORIGIN = 'https://dns.coffee';
const DNS_COFFEE_API_ORIGIN = 'https://api.dns.coffee';
const DAY_MS = 24 * 60 * 60 * 1000;

// These are seller/lander delegations, not generic registrar nameservers. A
// departure is a lead, never sale proof on its own.
const SELLER_NAMESERVERS = Object.freeze([
  { provider: 'Afternic', nameserver: 'ns1.afternic.com' },
  { provider: 'Afternic', nameserver: 'ns2.afternic.com' },
  { provider: 'Afternic', nameserver: 'ns3.afternic.com' },
  { provider: 'Afternic', nameserver: 'ns4.afternic.com' },
  { provider: 'Afternic', nameserver: 'ns5.afternic.com' },
  { provider: 'Afternic', nameserver: 'ns6.afternic.com' },
  { provider: 'Dan', nameserver: 'ns1.dan.com' },
  { provider: 'Dan', nameserver: 'ns2.dan.com' },
  { provider: 'Sedo', nameserver: 'ns1.sedoparking.com' },
  { provider: 'Sedo', nameserver: 'ns2.sedoparking.com' },
  { provider: 'Sedo', nameserver: 'sl1.sedo.com' },
  { provider: 'Sedo', nameserver: 'sl2.sedo.com' },
  { provider: 'Atom', nameserver: 'ns1.atom.com' },
  { provider: 'Atom', nameserver: 'ns2.atom.com' },
  { provider: 'Atom / Squadhelp', nameserver: 'ns1.squadhelp.com' },
  { provider: 'Atom / Squadhelp', nameserver: 'ns2.squadhelp.com' },
  { provider: 'BrandBucket', nameserver: 'ns1.brandbucket.com' },
  { provider: 'BrandBucket', nameserver: 'ns2.brandbucket.com' },
  { provider: 'Nameshift', nameserver: 'ns1.nameshift.com' },
  { provider: 'Nameshift', nameserver: 'ns2.nameshift.com' },
  { provider: 'Bodis', nameserver: 'ns1.bodis.com' },
  { provider: 'Bodis', nameserver: 'ns2.bodis.com' },
  { provider: 'ParkingCrew', nameserver: 'ns1.parkingcrew.net' },
  { provider: 'ParkingCrew', nameserver: 'ns2.parkingcrew.net' },
  { provider: 'Efty', nameserver: 'ns1.eftydns.com' },
  { provider: 'Efty', nameserver: 'ns2.eftydns.com' },
  { provider: 'HugeDomains / NameBright', nameserver: 'nsg1.namebrightdns.com' },
  { provider: 'HugeDomains / NameBright', nameserver: 'nsg2.namebrightdns.com' },
  { provider: 'BuyDomains', nameserver: 'ns.buydomains.com' },
  { provider: 'BuyDomains', nameserver: 'this-domain-for-sale.com' },
]);

const SELLER_NS_PATTERNS = Object.freeze([
  /(?:^|\.)afternic\.com$/i,
  /(?:^|\.)dan\.com$/i,
  /(?:^|\.)sedoparking\.com$/i,
  /(?:^|\.)sedo\.com$/i,
  /(?:^|\.)atom\.com$/i,
  /(?:^|\.)squadhelp\.com$/i,
  /(?:^|\.)brandbucket\.com$/i,
  /(?:^|\.)nameshift\.com$/i,
  /(?:^|\.)bodis\.com$/i,
  /(?:^|\.)parkingcrew\.net$/i,
  /(?:^|\.)eftydns\.com$/i,
  /(?:^|\.)namebrightdns\.com$/i,
  /(?:^|\.)buydomains\.com$/i,
]);

const PARKING_TEXT = /\b(?:domain is for sale|buy this domain|make an offer|afternic|sedo domain parking|dan\.com|squadhelp|atom premium domain|brandbucket|hugedomains|bodis|parkingcrew|efty)\b/i;
const NON_BUYER_TEXT = /(?:\bparking page\b|\bdomain is parked\b|\bparked domain\b|\bfor sale\b|\bte koop\b|\bresources and information\b|\bdomain details page\b|\bexpired domain\b|\bdomain is expired\b|\byour domain is expired\b|\bhas expired\b|\bparked free\b|\bchecking your browser\b|\bthis domain\b.{0,20}\b(?:sale|available)\b|域名到期|域名续费提醒|forsale\.dynadot\.com)/i;
const PLACEHOLDER_TEXT = /(?:\b(?:coming soon|opening soon|under construction|site is being built|redirecting)\b|^redirecting[.…]*$)/i;
const PARKING_NS_PATTERNS = Object.freeze([
  ...SELLER_NS_PATTERNS,
  /(?:^|\.)launch[12]\.spaceship\.net$/i,
  /(?:^|\.)abovedomains\.com$/i,
  /(?:^|\.)parklogic\.com$/i,
  /(?:^|\.)ztomy\.com$/i,
  /(?:^|\.)parktons\.com$/i,
  /(?:^|\.)namepros-dns\.(?:com|is)$/i,
  /(?:^|\.)expired-domain-ns\d+\.fabulous\.com$/i,
  /(?:^|\.)dns-expired\.com$/i,
  /(?:^|\.)[^.]*domain-expired\.myhostadmin\.net$/i,
  /(?:^|\.)[^.]*suspended\.zxcs\.(?:nl|be|de)$/i,
  /(?:^|\.)yourdomainprovider\.net$/i,
]);

function isoDay(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : null;
}

function daysBefore(day, count) {
  return isoDay(new Date(`${day}T00:00:00Z`).getTime() - count * DAY_MS);
}

function isWithinDays(first, second, toleranceDays) {
  const left = new Date(`${isoDay(first)}T00:00:00Z`).getTime();
  const right = new Date(`${isoDay(second)}T00:00:00Z`).getTime();
  return Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) <= toleranceDays * DAY_MS;
}

function extractEmbeddedData(html) {
  const marker = 'var data = ';
  let markerIndex = html.lastIndexOf(marker);
  if (markerIndex < 0) throw new Error('DNS Coffee page has no embedded data payload');
  const start = html.indexOf('{', markerIndex + marker.length);
  if (start < 0) throw new Error('DNS Coffee data payload has no object');
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < html.length; index += 1) {
    const char = html[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return JSON.parse(html.slice(start, index + 1));
    }
  }
  throw new Error('DNS Coffee data payload is incomplete');
}

async function fetchText(url, { fetchImpl = fetch, timeoutMs = 20_000, headers = {}, attempts = 3 } = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        headers: { 'user-agent': 'DomainScout-SaleWatch/1.0', accept: 'text/html,application/json', ...headers },
        redirect: 'follow',
        signal: controller.signal,
      });
      if (!response.ok) {
        const error = new Error(`${response.status} ${response.statusText}`);
        error.status = response.status;
        error.retryAfter = Number(response.headers?.get?.('retry-after') || 0);
        throw error;
      }
      return { response, text: await response.text() };
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || ![429, 500, 502, 503, 504].includes(error.status)) throw error;
      const waitMs = Math.max(error.retryAfter * 1000, attempt * 1250);
      await new Promise(resolve => setTimeout(resolve, Math.min(waitMs, 10_000)));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

async function mapLimit(values, limit, mapper) {
  const output = new Array(values.length);
  let next = 0;
  async function worker() {
    while (true) {
      const index = next;
      next += 1;
      if (index >= values.length) return;
      output[index] = await mapper(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker));
  return output;
}

function cleanNameservers(value) {
  return [...new Set((Array.isArray(value) ? value : []).map(row => String(row?.name || row || '').trim().toLowerCase().replace(/\.$/, '')).filter(Boolean))].sort();
}

function hasSellerNameserver(nameservers) {
  return nameservers.some(nameserver => SELLER_NS_PATTERNS.some(pattern => pattern.test(nameserver)));
}

function hasParkingNameserver(nameservers) {
  return nameservers.some(nameserver => PARKING_NS_PATTERNS.some(pattern => pattern.test(nameserver)));
}

async function publicSellerDepartures({ sellerNameservers = SELLER_NAMESERVERS, after, fetchImpl = fetch } = {}) {
  const sourceResults = await mapLimit(sellerNameservers, 1, async source => {
    const url = `${DNS_COFFEE_ORIGIN}/nameservers/${encodeURIComponent(source.nameserver)}`;
    try {
      const { text } = await fetchText(url, { fetchImpl, attempts: 5 });
      const data = extractEmbeddedData(text);
      const rows = (data.archive_domains || [])
        .filter(row => !after || !row.last_seen || isoDay(row.last_seen) >= after)
        .map(row => ({
          domain: String(row.name || '').toLowerCase(),
          provider: source.provider,
          sellerNameserver: source.nameserver,
          firstSeen: row.first_seen || null,
          departureDate: isoDay(row.last_seen),
          parentZone: String(row.parent_zone?.name || '').toLowerCase() || null,
          sourceUrl: `${url}#archive-domains`,
        }));
      return { source, url, archiveRowsExposed: (data.archive_domains || []).length, totalArchiveRows: Number(data.archive_domain_count || 0), rows };
    } catch (error) {
      return { source, url, archiveRowsExposed: 0, totalArchiveRows: 0, rows: [], error: error.message };
    }
  });
  const byDomain = new Map();
  for (const result of sourceResults) {
    for (const row of result.rows) {
      if (!byDomain.has(row.domain)) byDomain.set(row.domain, { ...row, sellerNameservers: [], providers: [], sourceUrls: [] });
      const candidate = byDomain.get(row.domain);
      candidate.sellerNameservers.push(row.sellerNameserver);
      candidate.providers.push(row.provider);
      candidate.sourceUrls.push(row.sourceUrl);
      if (row.parentZone) candidate.parentZones = [...new Set([...(candidate.parentZones || []), row.parentZone])];
      if ((row.departureDate || '') > (candidate.departureDate || '')) candidate.departureDate = row.departureDate;
    }
  }
  for (const candidate of byDomain.values()) {
    candidate.sellerNameservers = [...new Set(candidate.sellerNameservers)].sort();
    candidate.providers = [...new Set(candidate.providers)].sort();
    candidate.sourceUrls = [...new Set(candidate.sourceUrls)].sort();
  }
  return { mode: 'public-reverse-nameserver', sourceResults, candidates: [...byDomain.values()] };
}

async function apiSellerDepartures({ apiKey, sellerNameservers = SELLER_NAMESERVERS, after, fetchImpl = fetch } = {}) {
  if (!apiKey) throw new Error('DNS Coffee API key is required');
  const sourceResults = await mapLimit(sellerNameservers, 4, async source => {
    const rows = [];
    let cursor = null;
    let pages = 0;
    do {
      const url = new URL(`/api/v1/nameservers/${encodeURIComponent(source.nameserver)}/domains/archive`, DNS_COFFEE_API_ORIGIN);
      url.searchParams.set('after', after);
      url.searchParams.set('limit', '10000');
      url.searchParams.set('parent_zone', 'true');
      if (cursor) url.searchParams.set('cursor', cursor);
      const { text } = await fetchText(url, { fetchImpl, headers: { 'X-API-Key': apiKey, accept: 'application/json' } });
      const body = JSON.parse(text);
      const pageRows = body.data || body.results || body.domains || [];
      for (const row of pageRows) rows.push({
        domain: String(row.name || row.domain || '').toLowerCase(),
        provider: source.provider,
        sellerNameserver: source.nameserver,
        firstSeen: row.first_seen || row.firstSeen || null,
        departureDate: isoDay(row.last_seen || row.lastSeen),
        parentZone: String(row.parent_zone?.name || row.parentZone?.name || row.parent_zone || row.parentZone || '').toLowerCase() || null,
        sourceUrl: `${DNS_COFFEE_ORIGIN}/nameservers/${encodeURIComponent(source.nameserver)}#archive-domains`,
      });
      cursor = body.has_more === true || body.hasMore === true ? (body.next_cursor || body.nextCursor || null) : null;
      pages += 1;
      if (pages > 1000) throw new Error(`cursor safety bound exceeded for ${source.nameserver}`);
    } while (cursor);
    return { source, rows, pages };
  });
  const byDomain = new Map();
  for (const result of sourceResults) {
    for (const row of result.rows) {
      if (!row.domain) continue;
      if (!byDomain.has(row.domain)) byDomain.set(row.domain, { ...row, sellerNameservers: [], providers: [], sourceUrls: [] });
      const candidate = byDomain.get(row.domain);
      candidate.sellerNameservers.push(row.sellerNameserver);
      candidate.providers.push(row.provider);
      candidate.sourceUrls.push(row.sourceUrl);
      if (row.parentZone) candidate.parentZones = [...new Set([...(candidate.parentZones || []), row.parentZone])];
      if ((row.departureDate || '') > (candidate.departureDate || '')) candidate.departureDate = row.departureDate;
    }
  }
  for (const candidate of byDomain.values()) {
    candidate.sellerNameservers = [...new Set(candidate.sellerNameservers)].sort();
    candidate.providers = [...new Set(candidate.providers)].sort();
    candidate.sourceUrls = [...new Set(candidate.sourceUrls)].sort();
  }
  return { mode: 'authenticated-cursor-complete', sourceResults, candidates: [...byDomain.values()] };
}

function rdapLastChanged(body) {
  const events = Array.isArray(body?.events) ? body.events : [];
  const relevant = events.filter(event => /last changed|transfer|updated/i.test(String(event.eventAction || '')));
  return relevant.map(event => event.eventDate).filter(Boolean).sort().at(-1) || null;
}

async function inspectHomepage(domain, fetchImpl = fetch) {
  for (const scheme of ['https', 'http']) {
    const requested = `${scheme}://${domain}/`;
    try {
      const { response, text } = await fetchText(requested, { fetchImpl, timeoutMs: 12_000, headers: { accept: 'text/html,*/*;q=0.8' } });
      const title = (text.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '')
        .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&#39;|&apos;/gi, "'").replace(/&quot;/gi, '"')
        .replace(/\s+/g, ' ').trim().slice(0, 240);
      const sample = `${title}\n${text.slice(0, 80_000)}`;
      const finalHost = (() => { try { return new URL(response.url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return null; } })();
      const parked = PARKING_TEXT.test(sample) || NON_BUYER_TEXT.test(`${title}\n${response.url}`) || finalHost?.includes('block.charter-prod.hosted.cujo.io');
      const placeholder = !parked && PLACEHOLDER_TEXT.test(title);
      const active = response.status < 500 && !parked && Boolean(title || response.url !== requested);
      return { requestedUrl: requested, finalUrl: response.url, finalHost, status: response.status, title: title || null, parked, placeholder, active };
    } catch (error) {
      if (scheme === 'http') return { requestedUrl: requested, finalUrl: null, status: null, title: null, parked: false, active: false, error: error.message };
    }
  }
  return { finalUrl: null, active: false };
}

async function inspectRdap(domain, fetchImpl = fetch) {
  try {
    const { text } = await fetchText(`https://rdap.org/domain/${encodeURIComponent(domain)}`, { fetchImpl, timeoutMs: 15_000, headers: { accept: 'application/rdap+json,application/json' } });
    const body = JSON.parse(text);
    return { lastChangedAt: rdapLastChanged(body), statuses: Array.isArray(body.status) ? body.status : [], registrar: body.entities?.find(entity => entity.roles?.includes('registrar'))?.vcardArray?.[1]?.find(row => row[0] === 'fn')?.[3] || null };
  } catch (error) {
    return { lastChangedAt: null, statuses: [], registrar: null, error: error.message };
  }
}

async function resolveParentDelegation(domain, parentZone) {
  const zone = String(parentZone || domain.split('.').at(-1) || '').replace(/\.$/, '');
  if (!zone) return { nameservers: [], parentZone: null, authorityServer: null, error: 'parent zone unavailable' };
  try {
    if (!parentAuthorityCache.has(zone)) {
      parentAuthorityCache.set(zone, (async () => {
        const authorityHosts = await dns.resolveNs(zone);
        for (const host of authorityHosts.slice(0, 4)) {
          const addresses = await dns.resolve4(host).catch(() => []);
          if (addresses[0]) return { host: String(host).replace(/\.$/, ''), address: addresses[0] };
        }
        return null;
      })());
    }
    const authority = await parentAuthorityCache.get(zone);
    const authorityServer = authority?.address || null;
    if (!authorityServer) throw new Error(`no IPv4 address for ${zone} authority`);
    const { stdout } = await execFileAsync('/usr/bin/dig', [
      `@${authorityServer}`, domain, 'NS', '+norecurse', '+noall', '+authority', '+time=2', '+tries=1',
    ], { timeout: 5_000, maxBuffer: 64 * 1024 });
    const nameservers = cleanNameservers(String(stdout || '').split(/\r?\n/).map(line => (
      line.match(/^\S+\s+\d+\s+IN\s+NS\s+(\S+)\.?$/i)?.[1] || ''
    )));
    if (!nameservers.length) throw new Error(`${zone} authority returned no delegation`);
    return { nameservers, parentZone: zone, authorityServer, authorityHost: authority.host, error: null };
  } catch (error) {
    return { nameservers: [], parentZone: zone, authorityServer: null, error: error.message };
  }
}

async function inspectDomainCandidate(candidate, { fetchImpl = fetch } = {}) {
  let coffee = { nameservers: [], archive_nameservers: [] };
  if (!candidate.departureDate) {
    try {
      const { text } = await fetchText(`${DNS_COFFEE_ORIGIN}/domains/${encodeURIComponent(candidate.domain)}`, { fetchImpl });
      coffee = extractEmbeddedData(text);
    } catch (error) {
      coffee = { error: error.message, nameservers: [], archive_nameservers: [] };
    }
  }
  const coffeeCurrent = cleanNameservers(coffee.nameservers);
  const [directNameservers, parentDelegation] = await Promise.all([
    dns.resolveNs(candidate.domain).then(cleanNameservers).catch(() => []),
    resolveParentDelegation(candidate.domain, candidate.parentZones?.[0] || candidate.parentZone),
  ]);
  const buyerNameservers = parentDelegation.nameservers.length ? parentDelegation.nameservers : (directNameservers.length ? directNameservers : coffeeCurrent);
  const stillObservedDelegation = buyerNameservers.some(nameserver => candidate.sellerNameservers.includes(nameserver));
  const stillSellerDelegated = hasSellerNameserver(buyerNameservers) || stillObservedDelegation;
  const parkingInfrastructure = hasParkingNameserver(buyerNameservers);
  const historyDeparture = (coffee.archive_nameservers || [])
    .filter(row => candidate.sellerNameservers.includes(String(row.name || '').toLowerCase()))
    .map(row => isoDay(row.last_seen)).filter(Boolean).sort().at(-1) || candidate.departureDate
      || (!stillSellerDelegated && candidate.detectionDate ? candidate.detectionDate : null);
  const structurallyMoved = buyerNameservers.length > 0 && !stillSellerDelegated;
  if (!structurallyMoved || parkingInfrastructure) {
    return {
      domain: candidate.domain,
      tier: 'ruled-out',
      buyer: 'Buyer not yet identified',
      reportDate: historyDeparture,
      reportedPriceUsd: null,
      venue: candidate.providers.join(' / '),
      precision: 'nameserver-derived lead',
      sellerNameservers: candidate.sellerNameservers,
      buyerNameservers,
      buyerTitle: null,
      buyerUrl: `https://${candidate.domain}/`,
      sourceUrl: candidate.sourceKind === 'targeted-control'
        ? `https://rdap.org/domain/${encodeURIComponent(candidate.domain)}`
        : `${DNS_COFFEE_ORIGIN}/domains/${encodeURIComponent(candidate.domain)}#archive-nameservers`,
      rationale: !structurallyMoved
        ? `No completed departure from the observed delegation is currently visible (${buyerNameservers.join(', ') || 'no authoritative nameservers'}).`
        : `Departed ${candidate.providers.join(' / ')} DNS on ${historyDeparture || 'the observed window'}, but moved to known parking or investor infrastructure (${buyerNameservers.join(', ')}).`,
      discovery: { structurallyMoved, stillSellerDelegated, stillObservedDelegation, parkingInfrastructure, departureDate: historyDeparture, parentDelegation, recursiveNameservers: directNameservers, watchReason: candidate.watchReason || null },
    };
  }
  const [homepage, rdap, mx] = await Promise.all([
    inspectHomepage(candidate.domain, fetchImpl),
    inspectRdap(candidate.domain, fetchImpl),
    dns.resolveMx(candidate.domain).then(rows => rows.map(row => row.exchange).filter(Boolean)).catch(() => []),
  ]);
  const changedNearDeparture = rdap.lastChangedAt && historyDeparture && isWithinDays(rdap.lastChangedAt, historyDeparture, 5);
  const label = candidate.domain.split('.')[0].replace(/^xn--/, '').replace(/[^a-z0-9]/g, '');
  const titleKey = String(homepage.title || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const finalHostKey = String(homepage.finalHost || '').split('.')[0].replace(/[^a-z0-9]/g, '');
  const sameHost = homepage.finalHost === candidate.domain;
  const titleAffinity = label.length >= 4 && titleKey.includes(label);
  const redirectedBrandAffinity = !sameHost && label.length >= 4 && finalHostKey.length >= 4
    && (label.includes(finalHostKey) || finalHostKey.includes(label));
  const normalizedDomainTitle = String(homepage.title || '').toLowerCase().replace(/^www\./, '').replace(/\s+/g, '');
  const domainOnlyTitle = normalizedDomainTitle === candidate.domain || titleKey === label;
  const fileDestination = /\.(?:pdf|docx?|xlsx?|pptx?)(?:$|[?#])/i.test(String(homepage.finalUrl || ''));
  const meaningfulMx = mx.filter(exchange => exchange && exchange !== '~' && !/(?:localhost|park-mx|deadletter|eye-mail)/i.test(exchange));
  const strongBuyerUse = homepage.active && !homepage.placeholder && !domainOnlyTitle && !parkingInfrastructure
    && ((sameHost && Boolean(homepage.title)) || titleAffinity || redirectedBrandAffinity || fileDestination);
  const weakBuyerUse = homepage.active && !parkingInfrastructure && !strongBuyerUse
    && (sameHost || titleAffinity || redirectedBrandAffinity);
  let tier = 'ruled-out';
  if (structurallyMoved && strongBuyerUse && changedNearDeparture) tier = 'probable';
  else if (structurallyMoved && strongBuyerUse) tier = 'suspected';
  else if (structurallyMoved && weakBuyerUse && changedNearDeparture) tier = 'suspected';
  else if (structurallyMoved && changedNearDeparture && !parkingInfrastructure && !homepage.parked && meaningfulMx.length) tier = 'suspected';
  const rationaleParts = [];
  if (structurallyMoved) rationaleParts.push(`departed ${candidate.providers.join(' / ')} seller DNS on ${historyDeparture || 'the observed window'} for ${buyerNameservers.join(', ')}`);
  else rationaleParts.push(stillSellerDelegated ? 'still uses a known seller/lander delegation' : 'has no current authoritative nameserver response');
  if (strongBuyerUse) rationaleParts.push(`now serves ${homepage.title ? `“${homepage.title}”` : 'a non-parking buyer surface'} with same-domain or matching-brand use`);
  else if (weakBuyerUse) rationaleParts.push(`now serves ${homepage.title ? `“${homepage.title}”` : 'a same-brand destination'}, but the surface is still thin or transitional`);
  else if (homepage.active && parkingInfrastructure) rationaleParts.push('the current page is on known parking or investor infrastructure');
  else if (homepage.active) rationaleParts.push('the live destination lacks enough same-brand evidence to call buyer use');
  else if (homepage.parked) rationaleParts.push('the current page still reads as parking or a sales lander');
  if (changedNearDeparture) rationaleParts.push(`RDAP changed ${isoDay(rdap.lastChangedAt)}, within five days of the DNS departure`);
  else if (rdap.lastChangedAt) rationaleParts.push(`latest RDAP change is ${isoDay(rdap.lastChangedAt)}`);
  if (meaningfulMx.length) rationaleParts.push(`buyer-grade mail is configured at ${meaningfulMx.slice(0, 3).join(', ')}`);
  return {
    domain: candidate.domain,
    tier,
    buyer: homepage.title || 'Buyer not yet identified',
    reportDate: historyDeparture,
    reportedPriceUsd: null,
    venue: candidate.providers.join(' / '),
    precision: changedNearDeparture ? 'day-level DNS + bounded RDAP' : 'nameserver-derived lead',
    sellerNameservers: candidate.sellerNameservers,
    buyerNameservers,
    buyerTitle: homepage.title,
    buyerUrl: homepage.finalUrl || `https://${candidate.domain}/`,
    sourceUrl: candidate.sourceKind === 'targeted-control'
      ? `https://rdap.org/domain/${encodeURIComponent(candidate.domain)}`
      : `${DNS_COFFEE_ORIGIN}/domains/${encodeURIComponent(candidate.domain)}#archive-nameservers`,
    rationale: `${rationaleParts.join('; ')}.`,
    discovery: {
      structurallyMoved,
      stillSellerDelegated,
      stillObservedDelegation,
      parkingInfrastructure,
      buyerUse: strongBuyerUse,
      weakBuyerUse,
      titleAffinity,
      redirectedBrandAffinity,
      domainOnlyTitle,
      fileDestination,
      sameHost,
      departureDate: historyDeparture,
      parentDelegation,
      recursiveNameservers: directNameservers,
      homepage,
      rdap,
      mx,
      dnsCoffeeHistoryUrl: `${DNS_COFFEE_ORIGIN}/domains/${encodeURIComponent(candidate.domain)}`,
      watchReason: candidate.watchReason || null,
    },
  };
}

async function discoverSaleLeads({
  now = new Date(),
  days = 7,
  apiKey = process.env.DNS_COFFEE_API_KEY,
  sellerNameservers = SELLER_NAMESERVERS,
  fetchImpl = fetch,
  concurrency = 10,
  watchedCandidates = [],
  onProgress = () => {},
} = {}) {
  const through = isoDay(now);
  const after = daysBefore(through, days - 1);
  const discovered = apiKey
    ? await apiSellerDepartures({ apiKey, sellerNameservers, after, fetchImpl })
    : await publicSellerDepartures({ sellerNameservers, after, fetchImpl });
  const candidateByDomain = new Map(discovered.candidates.map(candidate => [candidate.domain, candidate]));
  for (const watched of watchedCandidates) {
    if (!candidateByDomain.has(watched.domain)) candidateByDomain.set(watched.domain, { ...watched, detectionDate: through });
  }
  const candidates = [...candidateByDomain.values()];
  let completed = 0;
  const inspected = await mapLimit(candidates, concurrency, async candidate => {
    try {
      return await inspectDomainCandidate(candidate, { fetchImpl });
    } catch (error) {
      return { domain: candidate.domain, tier: 'error', error: error.message };
    } finally {
      completed += 1;
      onProgress({ completed, total: candidates.length, domain: candidate.domain });
    }
  });
  const entries = inspected.filter(row => row.tier === 'probable' || row.tier === 'suspected');
  return {
    schema: 'domainscout.sale-watch-discovery/v1',
    generatedAt: new Date().toISOString(),
    window: { after, through, days },
    mode: discovered.mode,
    coverage: {
      sellerNameserverSourcesConfigured: sellerNameservers.length,
      sellerNameserverSourcesSucceeded: discovered.sourceResults.filter(row => !row.error).length,
      sellerNameserverSourcesFailed: discovered.sourceResults.filter(row => row.error).length,
      reverseAssociationsExposed: discovered.sourceResults.reduce((sum, row) => sum + (row.rows?.length || 0), 0),
      uniqueDeparturesInspected: discovered.candidates.length,
      targetedControlsInspected: watchedCandidates.length,
      probable: entries.filter(row => row.tier === 'probable').length,
      suspected: entries.filter(row => row.tier === 'suspected').length,
      ruledOut: inspected.filter(row => row.tier === 'ruled-out').length,
      errors: inspected.filter(row => row.tier === 'error').length,
      authenticatedCursorComplete: discovered.mode === 'authenticated-cursor-complete',
    },
    sourceResults: discovered.sourceResults.map(row => ({
      provider: row.source.provider,
      nameserver: row.source.nameserver,
      rows: row.rows.length,
      pages: row.pages || null,
      exposed: row.archiveRowsExposed ?? null,
      totalArchiveRows: row.totalArchiveRows ?? null,
      error: row.error || null,
    })),
    entries,
    ruledOut: inspected.filter(row => row.tier === 'ruled-out'),
    errors: inspected.filter(row => row.tier === 'error'),
  };
}

module.exports = {
  DNS_COFFEE_ORIGIN,
  mapLimit,
  SELLER_NAMESERVERS,
  extractEmbeddedData,
  hasSellerNameserver,
  hasParkingNameserver,
  publicSellerDepartures,
  apiSellerDepartures,
  inspectDomainCandidate,
  resolveParentDelegation,
  discoverSaleLeads,
  inspectHomepage,
};
