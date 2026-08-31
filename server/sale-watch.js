'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_LEDGER_PATH = path.join(__dirname, '../config/sale-watch-ledger.json');

function normalizeStringList(value) {
  if (!Array.isArray(value)) return [];
  return value.map(item => String(item || '').trim()).filter(Boolean);
}

function normalizeEntry(entry) {
  const domain = String(entry?.domain || '').trim().toLowerCase();
  if (!/^[a-z0-9.-]+\.[a-z0-9-]+$/i.test(domain)) return null;
  const tier = entry.tier === 'verified' ? 'verified' : 'probable';
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
  };
}

function resolveLedgerPath() {
  const configured = String(process.env.DOMAINSCOUT_SALE_WATCH_LEDGER_PATH || '').trim();
  return configured ? path.resolve(configured) : DEFAULT_LEDGER_PATH;
}

function readSaleWatchLedger(filePath = resolveLedgerPath()) {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const entries = (Array.isArray(raw.entries) ? raw.entries : [])
    .map(normalizeEntry)
    .filter(Boolean)
    .sort((a, b) => {
      if (a.tier !== b.tier) return a.tier === 'verified' ? -1 : 1;
      return String(b.reportDate || '').localeCompare(String(a.reportDate || ''))
        || (b.reportedPriceUsd || 0) - (a.reportedPriceUsd || 0);
    });
  const verified = entries.filter(row => row.tier === 'verified').length;
  return {
    schema: 'domainscout.sale-watch-ledger/v1',
    generatedAt: raw.generatedAt || null,
    window: raw.window || null,
    coverage: raw.coverage || {},
    counts: {
      verified,
      probable: entries.length - verified,
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
      res.json(readSaleWatchLedger(options.ledgerPath));
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
  normalizeEntry,
  readSaleWatchLedger,
  registerSaleWatchRoutes,
};
