'use strict';

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
  const tier = ['verified', 'probable', 'suspected'].includes(entry.tier) ? entry.tier : 'suspected';
  return {
    domain,
    tier,
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
  const raw = entry.reportDate || entry.lastObservedAt || entry.firstObservedAt || '';
  return String(raw).slice(0, 10);
}

function readSaleWatchLedger(filePath = resolveLedgerPath(), discoveryPath = resolveDiscoveryPath()) {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const discovery = readOptionalDiscovery(discoveryPath);
  const byDomain = new Map();
  for (const entry of Array.isArray(raw.entries) ? raw.entries : []) {
    const normalized = normalizeEntry(entry);
    if (normalized) byDomain.set(normalized.domain, normalized);
  }
  for (const entry of Array.isArray(discovery?.entries) ? discovery.entries : []) {
    const normalized = normalizeEntry(entry);
    if (normalized && !byDomain.has(normalized.domain)) byDomain.set(normalized.domain, normalized);
  }
  const tierOrder = { verified: 0, probable: 1, suspected: 2 };
  const entries = [...byDomain.values()]
    .sort((a, b) => {
      const aKey = recencyKey(a);
      const bKey = recencyKey(b);
      if (aKey !== bKey) {
        if (!aKey) return 1;
        if (!bKey) return -1;
        return bKey.localeCompare(aKey);
      }
      return (b.reportedPriceUsd || 0) - (a.reportedPriceUsd || 0)
        || (tierOrder[a.tier] - tierOrder[b.tier])
        || a.domain.localeCompare(b.domain);
    });
  const verified = entries.filter(row => row.tier === 'verified').length;
  const probable = entries.filter(row => row.tier === 'probable').length;
  const suspected = entries.filter(row => row.tier === 'suspected').length;
  return {
    schema: 'domainscout.sale-watch-ledger/v1',
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

function registerSaleWatchRoutes(app, options = {}) {
  app.get('/api/sale-watch', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      res.json(readSaleWatchLedger(options.ledgerPath, options.discoveryPath));
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
  DEFAULT_LEDGER_PATH,
  DEFAULT_DISCOVERY_PATH,
  normalizeEntry,
  readSaleWatchLedger,
  registerSaleWatchRoutes,
};
