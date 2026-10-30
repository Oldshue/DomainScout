'use strict';

// Token-readable batch lanes for AgentForge/agent clients: bulk zone-TLD lookup
// and bulk DNS-taken checks. Deliberately a standalone router module (no direct
// dependency on server/index.js internals) so it can be required and exercised
// in tests without booting the HTTP server or opening any sockets.

const express = require('express');
const dns = require('dns');

const MAX_BASE_NAMES = 500;
const MAX_DOMAINS = 200;
const MAX_GROUPED_BASE_NAMES = 1000;
const MAX_GROUPED_TLDS = 12;
const MAX_GROUPED_LOOKUPS = 3000;
const DNS_TIMEOUT_MS = 4000;
// High enough for 3000 lookups to finish well under 25s in normal conditions,
// still a bounded worker pool (never one socket per lookup beyond this cap).
const DNS_CONCURRENCY = 100;
const DOMAIN_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;
// A single DNS label: lowercase letters, digits, hyphen; no leading/trailing
// hyphen; 1..63 characters.
const LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const TIMEOUT_CODES = new Set(['ETIMEOUT', 'ETIMEDOUT']);
const ONLY_VALUES = new Set(['undelegated', 'delegated', 'errors']);

// ── /api/zone-tlds-batch: comma list -> normalized, deduped, ordered base names ──
function parseBaseNames(raw, normalizeBaseNameInput) {
  const rawStr = String(raw || '').trim();
  if (!rawStr) return { error: 'baseNames required' };
  const parts = rawStr.split(',').map(s => s.trim());
  if (parts.length > MAX_BASE_NAMES) {
    return { error: `baseNames must be 1..${MAX_BASE_NAMES} entries` };
  }
  const baseNames = [];
  const seen = new Set();
  for (const part of parts) {
    if (!part) return { error: 'baseNames contains an empty entry' };
    const normalized = normalizeBaseNameInput(part);
    if (!normalized) return { error: `invalid baseName: ${part}` };
    if (seen.has(normalized)) return { error: `duplicate baseName: ${normalized}` };
    seen.add(normalized);
    baseNames.push(normalized);
  }
  if (!baseNames.length) return { error: 'baseNames required' };
  return { baseNames };
}

// ── /api/dns-taken-batch: comma list -> validated, lowercase, ordered domains ──
function parseDomains(raw) {
  const rawStr = String(raw || '').trim();
  if (!rawStr) return { error: 'domains required' };
  const parts = rawStr.split(',').map(s => s.trim());
  if (parts.length > MAX_DOMAINS) {
    return { error: `domains must be 1..${MAX_DOMAINS} entries` };
  }
  const domains = [];
  for (const part of parts) {
    if (!part) return { error: 'domains contains an empty entry' };
    const lower = part.toLowerCase();
    if (!DOMAIN_RE.test(lower)) return { error: `invalid domain: ${part}` };
    domains.push(lower);
  }
  if (!domains.length) return { error: 'domains required' };
  return { domains };
}

function isValidLabel(label) {
  return LABEL_RE.test(label);
}

// Shared parser for the grouped baseNames/tlds lists. baseNames entries are a
// single strict lowercase label; tlds entries may be one label or a dotted
// suffix (co.uk). Duplicates and invalid entries are rejected with a message
// that names the offending entry and the limit.
function parseGroupedList(raw, listName, maxEntries, entryName, allowDots) {
  const rawStr = String(raw || '').trim();
  if (!rawStr) return { error: `${listName} required` };
  const parts = rawStr.split(',').map(s => s.trim());
  if (parts.length > maxEntries) {
    return { error: `${listName} must be 1..${maxEntries} entries (got ${parts.length})` };
  }
  const entries = [];
  const seen = new Set();
  for (const part of parts) {
    if (!part) return { error: `${listName} contains an empty entry` };
    const valid = allowDots ? part.split('.').every(isValidLabel) : isValidLabel(part);
    if (!valid) return { error: `invalid ${entryName}: ${part}` };
    if (seen.has(part)) return { error: `duplicate ${entryName}: ${part}` };
    seen.add(part);
    entries.push(part);
  }
  if (!entries.length) return { error: `${listName} required` };
  return { entries };
}

function parseGroupedBaseNames(raw) {
  return parseGroupedList(raw, 'baseNames', MAX_GROUPED_BASE_NAMES, 'baseName', false);
}

function parseGroupedTlds(raw) {
  return parseGroupedList(raw, 'tlds', MAX_GROUPED_TLDS, 'tld', true);
}

// Default NS resolver: node:dns promises Resolver, 4000ms timeout, single try
// (matches server/tlds-worker.js / server/market-sibling-scan-worker.js style).
function defaultResolveNs(domain) {
  const resolver = new dns.promises.Resolver({ timeout: DNS_TIMEOUT_MS, tries: 1 });
  return resolver.resolveNs(domain);
}

function isTimeoutError(err) {
  return !!(err && TIMEOUT_CODES.has(err.code));
}

// Retry a timed-out lookup once before surfacing it as an error. Other DNS
// failures (and definitive no-record answers) are passed straight through so
// they are never retried.
async function resolveNsWithRetry(resolver, domain) {
  try {
    return await resolver(domain);
  } catch (err) {
    if (!isTimeoutError(err)) throw err;
    return await resolver(domain);
  }
}

// One lookup outcome for a single base.tld: delegated (NS records present),
// undelegated (definitively no NS records), or error (timeout/other failure).
async function checkOne(resolver, domain) {
  let ns;
  try {
    ns = await resolveNsWithRetry(resolver, domain);
  } catch (err) {
    const code = err && err.code;
    if (code === 'ENOTFOUND' || code === 'ENODATA' || code === 'NXDOMAIN') {
      return { kind: 'undelegated' };
    }
    return { kind: 'error', error: code || (err && err.message) || 'ERROR' };
  }
  const list = Array.isArray(ns) ? ns : [];
  return list.length > 0 ? { kind: 'delegated' } : { kind: 'undelegated' };
}

// Bounded-concurrency map preserving input order in the output array.
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (true) {
      const current = nextIndex++;
      if (current >= items.length) return;
      results[current] = await fn(items[current], current);
    }
  }
  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

function createAgentBatchRouter({ getZoneTruth, normalizeBaseNameInput, resolveNs }) {
  if (typeof getZoneTruth !== 'function') throw new Error('createAgentBatchRouter requires getZoneTruth');
  if (typeof normalizeBaseNameInput !== 'function') throw new Error('createAgentBatchRouter requires normalizeBaseNameInput');
  const resolver = typeof resolveNs === 'function' ? resolveNs : defaultResolveNs;

  const router = express.Router();

  // ── GET /api/zone-tlds-batch?baseNames=a,b,c ──────────────────────────────
  router.get('/api/zone-tlds-batch', (req, res) => {
    const parsed = parseBaseNames(req.query.baseNames, normalizeBaseNameInput);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    // Optional membership filter: tlds=run,ai returns only membership in those
    // zones (taken/free) instead of every zone a name is in, so callers that
    // screen hundreds of names for one extension get small rows.
    let filter = null;
    if (req.query.tlds !== undefined && req.query.tlds !== '') {
      const t = parseGroupedTlds(String(req.query.tlds).split(',').map(x => x.trim().replace(/^\./, '')).join(','));
      if (t.error) return res.status(400).json({ error: t.error });
      filter = t.entries.map(x => '.' + x);
    }
    const only = req.query.only;
    if (only !== undefined && only !== '') {
      if (!filter) return res.status(400).json({ error: 'only requires tlds' });
      if (only !== 'free' && only !== 'taken') return res.status(400).json({ error: `invalid only: ${only} (expected free or taken)` });
    }
    const compact = req.query.compact === '1' || req.query.compact === 'true';
    const zoneTruth = getZoneTruth();
    let rows = parsed.baseNames.map(baseName => {
      const zoneInfo = zoneTruth.nameZones(baseName);
      const tlds = (zoneInfo && zoneInfo.tlds) || [];
      const exact = !!(zoneInfo && zoneInfo.exact);
      if (!filter) return compact ? { baseName, exact, count: tlds.length } : { baseName, exact, count: tlds.length, tlds };
      const have = new Set(tlds);
      const row = { baseName, exact, count: tlds.length, taken: filter.filter(t => have.has(t)) };
      // A name absent from the summary is only provably free when the summary is exact for absent labels.
      row.free = exact || (zoneTruth.exactForAbsentLabels && zoneTruth.exactForAbsentLabels()) ? filter.filter(t => !have.has(t)) : [];
      return row;
    });
    if (only === 'free') rows = rows.filter(r => r.free.length);
    if (only === 'taken') rows = rows.filter(r => r.taken.length);
    const body = { source: zoneTruth.source, asOf: zoneTruth.asOf, rows };
    if (filter) { body.tlds = filter; body.counts = { baseNames: parsed.baseNames.length, returned: rows.length }; }
    res.json(body);
  });

  // ── GET /api/dns-taken-batch ──────────────────────────────────────────────
  // Two modes share this route:
  //   1. Legacy domains= mode (unchanged): up to 200 fully-qualified domains,
  //      one row per domain.
  //   2. Grouped compact mode: baseNames= + tlds=, up to 1000 base names x 12
  //      TLDs (max 3000 lookups), one compact row per base name.
  router.get('/api/dns-taken-batch', async (req, res) => {
    // Legacy domains= mode stays byte-for-byte unchanged in shape and behavior.
    if (req.query.domains !== undefined) {
      const parsed = parseDomains(req.query.domains);
      if (parsed.error) return res.status(400).json({ error: parsed.error });
      const rows = await mapWithConcurrency(parsed.domains, DNS_CONCURRENCY, async domain => {
        try {
          const ns = await resolver(domain);
          const list = Array.isArray(ns) ? ns : [];
          return { domain, taken: list.length > 0, ns: list.length > 0 ? list[0] : null, error: null };
        } catch (err) {
          const code = err && err.code;
          if (code === 'ENOTFOUND' || code === 'ENODATA' || code === 'NXDOMAIN') {
            return { domain, taken: false, ns: null, error: null };
          }
          return { domain, taken: null, ns: null, error: code || (err && err.message) || 'ERROR' };
        }
      });
      return res.json({ checkedAt: new Date().toISOString(), rows });
    }

    // No mode requested: preserve the legacy no-parameter error.
    if (req.query.baseNames === undefined && req.query.tlds === undefined) {
      return res.status(400).json({ error: 'domains required' });
    }

    // Grouped compact mode.
    const baseParsed = parseGroupedBaseNames(req.query.baseNames);
    if (baseParsed.error) return res.status(400).json({ error: baseParsed.error });
    const tldsParsed = parseGroupedTlds(req.query.tlds);
    if (tldsParsed.error) return res.status(400).json({ error: tldsParsed.error });

    const baseNames = baseParsed.entries;
    const tlds = tldsParsed.entries;
    const lookups = baseNames.length * tlds.length;
    if (lookups > MAX_GROUPED_LOOKUPS) {
      return res.status(400).json({
        error: `lookups (baseNames x tlds) must be at most ${MAX_GROUPED_LOOKUPS} (got ${lookups})`,
      });
    }

    const only = req.query.only;
    if (only !== undefined && only !== '' && !ONLY_VALUES.has(only)) {
      return res.status(400).json({ error: `invalid only: ${only} (expected undelegated, delegated, or errors)` });
    }

    // Flatten lookups base-major so the per-base aggregation below can consume
    // the ordered results without re-indexing.
    const items = [];
    for (const base of baseNames) {
      for (const tld of tlds) {
        items.push({ base, tld, domain: `${base}.${tld}` });
      }
    }

    const outcomes = await mapWithConcurrency(items, DNS_CONCURRENCY, item =>
      checkOne(resolver, item.domain)
    );

    let delegatedCount = 0;
    let undelegatedCount = 0;
    let errorCount = 0;
    const rows = [];
    let cursor = 0;
    for (const base of baseNames) {
      const row = { base };
      const delegated = [];
      const undelegated = [];
      const errors = [];
      for (const tld of tlds) {
        const outcome = outcomes[cursor++];
        if (outcome.kind === 'delegated') {
          delegated.push(tld);
          delegatedCount += 1;
        } else if (outcome.kind === 'undelegated') {
          undelegated.push(tld);
          undelegatedCount += 1;
        } else {
          errors.push(tld);
          errorCount += 1;
        }
      }
      if (delegated.length) row.delegated = delegated;
      if (undelegated.length) row.undelegated = undelegated;
      if (errors.length) row.errors = errors;
      rows.push(row);
    }

    let visibleRows = rows;
    if (only === 'undelegated') {
      visibleRows = rows.filter(r => r.undelegated && r.undelegated.length > 0);
    } else if (only === 'delegated') {
      visibleRows = rows.filter(r => r.delegated && r.delegated.length === tlds.length);
    } else if (only === 'errors') {
      visibleRows = rows.filter(r => r.errors && r.errors.length > 0);
    }

    res.json({
      checkedAt: new Date().toISOString(),
      tlds,
      counts: {
        baseNames: baseNames.length,
        lookups,
        delegated: delegatedCount,
        undelegated: undelegatedCount,
        errors: errorCount,
      },
      rows: visibleRows,
    });
  });

  return router;
}

module.exports = {
  createAgentBatchRouter,
  parseBaseNames,
  parseDomains,
  parseGroupedBaseNames,
  parseGroupedTlds,
};
