'use strict';

const { assessSaleEntry, matchesSaleView, VERSION } = require('./sale-watch-evidence');
const { signalWeight, SIGNAL_POLICY_NOTE } = require('./domain-signal-policy');

const fs = require('fs');
const path = require('path');

const DEFAULT_LEDGER_PATH = path.join(__dirname, '../config/sale-watch-ledger.json');
const DEFAULT_DISCOVERY_PATH = path.join(
  process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, '../data'),
  'sale-watch-discovery.json'
);

function normalizeStringList(value) {
  if (!Array.isArray(value)) return [];
  return value.map(item => String(item || '').trim()).filter(Boolean);
}

function normalizeEntry(entry) {
  const domain = String(entry?.domain || '').trim().toLowerCase();
  if (!/^[a-z0-9.-]+\.[a-z0-9-]+$/i.test(domain)) return null;
  const tier = ['verified', 'probable', 'suspected', 'transfer', 'excluded'].includes(entry.tier) ? entry.tier : 'suspected';
  return {
    domain,
    tier,
    classification: entry.classification || null,
    assessment: entry.assessment || null,
    reconstruction: entry.reconstruction || null,
    buyer: String(entry.buyer || 'Buyer not yet identified').trim(),
    reportDate: String(entry.reportDate || '').trim() || null,
    reportedPriceUsd: entry.reportedPriceUsd != null && entry.reportedPriceUsd !== '' && Number.isFinite(Number(entry.reportedPriceUsd))
      ? Number(entry.reportedPriceUsd)
      : null,
    venue: String(entry.venue || '').trim() || null,
    precision: String(entry.precision || (tier === 'verified' ? 'day-level' : 'bounded')).trim(),
    sellerNameservers: normalizeStringList(entry.sellerNameservers),
    buyerNameservers: normalizeStringList(entry.buyerNameservers),
    buyerTitle: String(entry.buyerTitle || '').trim() || null,
    buyerUrl: String(entry.buyerUrl || '').trim() || `https://${domain}/`,
    sourceUrl: String(entry.sourceUrl || '').trim() || null,
    rationale: String(entry.rationale || '').trim(),
    firstObservedAt: String(entry.firstObservedAt || '').trim() || null,
    lastObservedAt: String(entry.lastObservedAt || '').trim() || null,
    observationCount: Number.isFinite(Number(entry.observationCount)) ? Number(entry.observationCount) : null,
    observationStatus: String(entry.observationStatus || '').trim() || null,
    discovery: entry.discovery && typeof entry.discovery === 'object' ? entry.discovery : null,
  };
}

function resolveLedgerPath() {
  const configured = String(process.env.DOMAINSCOUT_SALE_WATCH_LEDGER_PATH || '').trim();
  return configured ? path.resolve(configured) : DEFAULT_LEDGER_PATH;
}

function resolveDiscoveryPath() {
  const configured = String(process.env.DOMAINSCOUT_SALE_WATCH_DISCOVERY_PATH || '').trim();
  return configured ? path.resolve(configured) : DEFAULT_DISCOVERY_PATH;
}

function readOptionalDiscovery(filePath) {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return value && typeof value === 'object' ? value : null;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function recencyKey(entry) {
  const raw = entry.reportDate || '';
  return String(raw).slice(0, 10);
}

// Stage 2b: readSaleWatchLedger gains an optional third source — a
// reconstructionEntries array (already shaped like normalizeEntry's output by
// server/sale-watch-reconstruction.js's readReconstructionEntries). These are
// merged into byDomain AFTER the seed ledger and discovery entries, and never
// overwrite an existing domain row (seed/discovery evidence always wins a
// conflict). Counts and the recency-first sort apply unchanged. Backward
// compatible: callers that omit the third argument default to [].
function readSaleWatchLedger(
  filePath = resolveLedgerPath(),
  discoveryPath = resolveDiscoveryPath(),
  reconstructionEntries = []
) {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const discovery = readOptionalDiscovery(discoveryPath);
  const byDomain = new Map();
  for (const entry of Array.isArray(raw.entries) ? raw.entries : []) {
    const normalized = normalizeEntry(entry);
    if (normalized) byDomain.set(normalized.domain, normalized);
  }
  for (const entry of Array.isArray(discovery?.entries) ? discovery.entries : []) {
    const normalized = normalizeEntry(entry);
    if (normalized && (!byDomain.has(normalized.domain) || byDomain.get(normalized.domain).discovery)) byDomain.set(normalized.domain, normalized);
  }
  for (const entry of [...(discovery?.ruledOut || []), ...(discovery?.retiredEntries || []).filter(row => !(discovery?.entries || []).some(current => current.domain === row.domain)).map(row => ({ ...row, tier: 'excluded', discovery: row.latestEvidence || row.discovery }))]) {
    const normalized = normalizeEntry(entry);
    if (!normalized) continue;
    const prior = byDomain.get(normalized.domain);
    if (!prior || prior.discovery) byDomain.set(normalized.domain, normalized);
  }
  for (const entry of Array.isArray(reconstructionEntries) ? reconstructionEntries : []) {
    const normalized = normalizeEntry(entry);
    if (normalized && (!byDomain.has(normalized.domain) || (byDomain.get(normalized.domain).discovery && String(normalized.lastObservedAt||'') >= String(byDomain.get(normalized.domain).lastObservedAt||'')))) byDomain.set(normalized.domain, normalized);
    else if(normalized?.reconstruction && byDomain.get(normalized.domain)?.discovery){const current=byDomain.get(normalized.domain);byDomain.set(normalized.domain,{...current,reconstruction:normalized.reconstruction});}
  }
  // Re-adjudicate all stored sources and expose exclusions instead of laundering old labels.
  for (const [domain, entry] of byDomain) {
    const assessed = assessSaleEntry(entry);
    // Old discovery files are audit evidence too; they must not re-admit signals
    // that the queue's owner policy excludes. Keep them in the excluded view.
    byDomain.set(domain, signalWeight(domain.split('.').at(-1)) === 0
      ? { ...assessed, tier: 'excluded', classification: 'policy-excluded', rationale: `${SIGNAL_POLICY_NOTE} ${assessed.rationale || ''}`.trim() }
      : assessed);
  }
  const allEntries = [...byDomain.values()]
    .sort((a, b) => {
      const aKey = recencyKey(a);
      const bKey = recencyKey(b);
      if (aKey !== bKey) {
        if (!aKey) return 1;
        if (!bKey) return -1;
        return bKey.localeCompare(aKey);
      }
      return a.domain < b.domain ? -1 : a.domain > b.domain ? 1 : 0;
    });
  const excludedEntries = allEntries.filter(row => row.tier === 'excluded');
  const entries = allEntries.filter(row => row.tier !== 'excluded');
  const verified = entries.filter(row => row.tier === 'verified').length;
  const probable = entries.filter(row => row.tier === 'probable').length;
  const suspected = entries.filter(row => row.tier === 'suspected').length;
  return {
    schema: 'domainscout.sale-watch-ledger/v1',
    classifierVersion: VERSION,
    excludedEntries,
    excludedCount: excludedEntries.length,
    transferCount: entries.filter(row => row.tier === 'transfer').length,
    generatedAt: [raw.generatedAt, discovery?.generatedAt].filter(Boolean).sort().at(-1) || null,
    window: raw.window || null,
    coverage: {
      ...(raw.coverage || {}),
      nameserverDiscovery: discovery?.coverage || null,
      nameserverDeparturesInspected: Number(discovery?.coverage?.uniqueDeparturesInspected || 0),
      nameserverAssociationsExposed: Number(discovery?.coverage?.reverseAssociationsExposed || 0),
      discoveryMode: discovery?.mode || 'awaiting-first-scan',
    },
    counts: {
      verified,
      probable,
      suspected,
      admitted: entries.length,
      auctionPricesShown: 0,
    },
    entries,
  };
}

// Merge retained evidence and reconstruction into a single chronological page.
// Cursor keys use the displayed departure date, never the latest probe date.
function pageSaleLedger(ledger, reconstructionEntries, { view = 'all', q = '', after = null, pageSize = 500, scanLimit = 1000 } = {}) {
  const key = entry => ({ date: recencyKey(entry), domain: entry.domain });
  const compare = (a, b) => b.date.localeCompare(a.date) || (a.domain < b.domain ? -1 : a.domain > b.domain ? 1 : 0);
  const boundary = reconstructionEntries.length === scanLimit ? key(reconstructionEntries.at(-1)) : null;
  const rows = [...ledger.entries, ...ledger.excludedEntries].filter(entry => {
    const position = key(entry);
    return matchesSaleView(entry, view) && (!q || JSON.stringify(entry).toLowerCase().includes(q.toLowerCase()))
      && (!after || compare(position, after) > 0)
      && (!boundary || compare(position, boundary) <= 0);
  }).sort((a,b) => compare(key(a),key(b)));
  const page = rows.slice(0,pageSize);
  const more = rows.length > pageSize || !!boundary;
  const last = rows.length > pageSize ? key(page.at(-1)) : boundary;
  ledger.entries = page.filter(entry => entry.tier !== 'excluded');
  ledger.excludedEntries = page.filter(entry => entry.tier === 'excluded');
  ledger.view = view;
  ledger.counts = { verified: page.filter(e=>e.tier==='verified').length, probable: page.filter(e=>e.tier==='probable').length, suspected: page.filter(e=>e.tier==='suspected').length, admitted: ledger.entries.length, auctionPricesShown: 0 };
  ledger.transferCount = page.filter(e=>e.tier==='transfer').length;
  ledger.excludedCount = ledger.excludedEntries.length;
  ledger.pagination = { pageSize, nextCursor: more && last ? Buffer.from(JSON.stringify(last)).toString('base64url') : null };
  return ledger;
}

// Stage 2b: registerSaleWatchRoutes accepts an optional
// options.reconstructionLoader() that returns the reconstruction entries
// array (typically readReconstructionEntries on the recon db handle). A
// missing loader defaults to [].
// A failing read returns an explicit 503 instead of a misleading empty ledger.
function registerSaleWatchRoutes(app, options = {}) {
  app.get('/api/sale-watch', async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const offset = Math.max(0, Math.floor(Number(_req.query?.offset) || 0));
      const pageSize = 500;
      let after = null;
      const cursor = String(_req.query?.cursor || '').slice(0,1024);
      if (cursor) {
        after = JSON.parse(Buffer.from(cursor,'base64url').toString());
        if (!after || typeof after.date !== 'string' || !/^(?:[0-9]{4}-[0-9]{2}-[0-9]{2})?$/.test(after.date) || typeof after.domain !== 'string' || !/^[a-z0-9.-]{1,253}$/.test(after.domain)) throw new Error('Invalid page cursor');
      }
      const view = ['all','leads','focus','transfer','probable','suspected','excluded'].includes(_req.query?.view) ? _req.query.view : 'all';
      const cloud = await require('./sale-watch-cloud').readCloudLedger({query:String(_req.query?.q||'').slice(0,100),offset,view,cursor});
      if(cloud?.ledger)return res.json({...cloud.ledger,delivery:{source:'cloud-reconstruction',fetchedAt:cloud.fetchedAt}});
      let reconstructionEntries = [];
      if (typeof options.reconstructionLoader === 'function') {
        try {
          reconstructionEntries = await options.reconstructionLoader({q:String(_req.query?.q||'').slice(0,100),offset:after ? 0 : offset,limit:1000,view,after}) || [];
        } catch (error) {
          throw new Error('Reconstruction page unavailable: ' + error.message);
        }
      }
      const ledger=readSaleWatchLedger(options.ledgerPath, options.discoveryPath, reconstructionEntries);
      pageSaleLedger(ledger, reconstructionEntries, { view, q: String(_req.query?.q || '').slice(0,100), after, pageSize });
      ledger.coverage.reconstruction = typeof options.reconstructionCoverage === 'function' ? await options.reconstructionCoverage() : null;
      if(cloud?.error)ledger.delivery={source:'local-evidence',warning:cloud.error};
      res.json(ledger);
    } catch (error) {
      res.status(503).json({
        schema: 'domainscout.sale-watch-ledger/v1',
        error: 'Sale Watch ledger is temporarily unavailable',
        detail: error.message,
      });
    }
  });
}

module.exports = {
  pageSaleLedger,
  DEFAULT_LEDGER_PATH,
  DEFAULT_DISCOVERY_PATH,
  normalizeEntry,
  readSaleWatchLedger,
  registerSaleWatchRoutes,
};
