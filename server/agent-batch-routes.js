'use strict';

// Token-readable batch lanes for AgentForge/agent clients: bulk zone-TLD lookup
// and bulk DNS-taken checks. Deliberately a standalone router module (no direct
// dependency on server/index.js internals) so it can be required and exercised
// in tests without booting the HTTP server or opening any sockets.

const express = require('express');
const dns = require('dns');

const MAX_BASE_NAMES = 500;
const MAX_DOMAINS = 200;
const DNS_TIMEOUT_MS = 4000;
const DNS_CONCURRENCY = 40;
const DOMAIN_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

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

// Default NS resolver: node:dns promises Resolver, 4000ms timeout, single try
// (matches server/tlds-worker.js / server/market-sibling-scan-worker.js style).
function defaultResolveNs(domain) {
  const resolver = new dns.promises.Resolver({ timeout: DNS_TIMEOUT_MS, tries: 1 });
  return resolver.resolveNs(domain);
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
    const zoneTruth = getZoneTruth();
    const rows = parsed.baseNames.map(baseName => {
      const zoneInfo = zoneTruth.nameZones(baseName);
      const tlds = (zoneInfo && zoneInfo.tlds) || [];
      return { baseName, exact: !!(zoneInfo && zoneInfo.exact), count: tlds.length, tlds };
    });
    res.json({ source: zoneTruth.source, asOf: zoneTruth.asOf, rows });
  });

  // ── GET /api/dns-taken-batch?domains=a.io,b.co ────────────────────────────
  router.get('/api/dns-taken-batch', async (req, res) => {
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
    res.json({ checkedAt: new Date().toISOString(), rows });
  });

  return router;
}

module.exports = { createAgentBatchRouter, parseBaseNames, parseDomains };
