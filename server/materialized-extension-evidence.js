'use strict';

const BASE_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const LABEL_RE = BASE_RE;

function normalizeBaseName(value) {
  const clean = String(value || '').trim().toLowerCase();
  return BASE_RE.test(clean) ? clean : null;
}

function normalizeLogicalTld(value) {
  const clean = String(value || '').trim().toLowerCase().replace(/^\.+|\.+$/g, '');
  if (!clean || !clean.split('.').every(label => LABEL_RE.test(label))) return null;
  return `.${clean}`;
}

function parseEvidenceRequest(body, { maxBaseNames = 500, maxTlds = 100, maxLookups = 5000 } = {}) {
  const rawBases = body?.baseNames;
  const rawTlds = body?.tlds;
  if (!Array.isArray(rawBases) || !rawBases.length || rawBases.length > maxBaseNames) {
    return { error: `baseNames must contain 1..${maxBaseNames} items` };
  }
  if (!Array.isArray(rawTlds) || !rawTlds.length || rawTlds.length > maxTlds) {
    return { error: `tlds must contain 1..${maxTlds} items` };
  }
  const baseNames = rawBases.map(normalizeBaseName);
  const tlds = rawTlds.map(normalizeLogicalTld);
  if (baseNames.some((value, index) => !value || value !== String(rawBases[index]).trim().toLowerCase())) {
    return { error: 'baseNames must be normalized DNS labels' };
  }
  if (tlds.some(value => !value)) return { error: 'tlds must be valid root or multi-label suffixes' };
  if (new Set(baseNames).size !== baseNames.length) return { error: 'baseNames must be unique' };
  if (new Set(tlds).size !== tlds.length) return { error: 'tlds must be unique' };
  if (baseNames.length * tlds.length > maxLookups) {
    return { error: `baseNames x tlds must be at most ${maxLookups}` };
  }
  return { baseNames, tlds };
}

function readPositiveExtensionEvidence(database, baseNames, options = {}) {
  const names = [...new Set((baseNames || []).map(normalizeBaseName).filter(Boolean))];
  const out = new Map();
  const maxAgeHours = Math.max(1, Math.min(24 * 30, Number(options.maxAgeHours) || 168));
  for (let offset = 0; offset < names.length; offset += 900) {
    const batch = names.slice(offset, offset + 900);
    const placeholders = batch.map(() => '?').join(',');
    const rows = database.prepare(`
      SELECT base_name, tld, source, checked_at
      FROM sibling_tld_status
      WHERE base_name IN (${placeholders})
        AND status = 'taken'
        AND datetime(checked_at) >= datetime('now', '-' || ? || ' hours')
      ORDER BY base_name, tld
    `).all(...batch, maxAgeHours);
    for (const row of rows) {
      const tld = normalizeLogicalTld(row.tld);
      if (!tld) continue;
      if (!out.has(row.base_name)) out.set(row.base_name, []);
      out.get(row.base_name).push({ tld, source: row.source, checkedAt: row.checked_at });
    }
  }
  return out;
}

function persistRegistrarEvidence(database, request, registrarRows, checkedAt = new Date().toISOString()) {
  const allowed = new Map();
  for (const baseName of request.baseNames) {
    for (const tld of request.tlds) allowed.set(`${baseName}${tld}`, { baseName, tld });
  }
  const upsert = database.prepare(`
    INSERT INTO sibling_tld_status (base_name, tld, status, source, checked_at)
    VALUES (@baseName, @tld, @status, @source, @checkedAt)
    ON CONFLICT(base_name, tld) DO UPDATE SET
      status = excluded.status, source = excluded.source, checked_at = excluded.checked_at
  `);
  const insertPositive = database.prepare('INSERT OR IGNORE INTO cctld_taken_idx (tld, base_name) VALUES (@tld, @baseName)');
  const deletePositive = database.prepare('DELETE FROM cctld_taken_idx WHERE tld = @tld AND base_name = @baseName');
  const persisted = [];
  database.transaction(rows => {
    for (const row of rows || []) {
      const domain = String(row?.domain || '').trim().toLowerCase();
      const target = allowed.get(domain);
      const status = row?.status === 'registered' ? 'taken' : (row?.status === 'available' ? 'not_taken' : null);
      if (!target || !status) continue;
      const item = {
        ...target,
        domain,
        status,
        source: String(row.source || 'godaddy-registrar-fast'),
        checkedAt: row.checkedAt || checkedAt,
      };
      upsert.run(item);
      if (status === 'taken') insertPositive.run(item);
      else deletePositive.run(item);
      persisted.push(item);
    }
  })(registrarRows);
  return persisted;
}

function parseRegistryWhoisReceipts(body, request, options = {}) {
  const rows = body?.receipts;
  const maxRows = options.maxRows || 500;
  if (!Array.isArray(rows) || !rows.length || rows.length > maxRows) return { error: `receipts must contain 1..${maxRows} items` };
  const allowed = new Set(request.baseNames.flatMap(baseName => request.tlds.map(tld => `${baseName}${tld}`)));
  const now = Number(options.now || Date.now());
  const parsed = [];
  for (const row of rows) {
    const domain = String(row?.domain || '').trim().toLowerCase();
    const status = row?.status;
    const server = String(row?.server || '').trim().toLowerCase();
    const source = String(row?.source || '').trim().toLowerCase();
    const checkedAtMs = Date.parse(row?.checkedAt || '');
    const bytes = Number(row?.bytes);
    const sha256 = String(row?.sha256 || '').toLowerCase();
    if (!allowed.has(domain) || !['registered', 'available'].includes(status)) return { error: 'receipt domain/status is outside the requested evidence matrix' };
    if (!/^[a-z0-9.-]+$/.test(server) || source !== `registry-whois:${server}`) return { error: 'receipt source must identify its exact registry WHOIS server' };
    if (!Number.isFinite(checkedAtMs) || checkedAtMs > now + 5 * 60_000 || checkedAtMs < now - 30 * 24 * 60 * 60_000) return { error: 'receipt checkedAt must be within the last 30 days' };
    if (!Number.isInteger(bytes) || bytes < 1 || bytes > 2 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(sha256)) return { error: 'receipt byte count or SHA-256 is invalid' };
    parsed.push({ domain, status, server, source, checkedAt: new Date(checkedAtMs).toISOString(), bytes, sha256 });
  }
  if (new Set(parsed.map(row => row.domain)).size !== parsed.length) return { error: 'receipt domains must be unique' };
  return { rows: parsed };
}

module.exports = {
  normalizeBaseName,
  normalizeLogicalTld,
  parseEvidenceRequest,
  parseRegistryWhoisReceipts,
  persistRegistrarEvidence,
  readPositiveExtensionEvidence,
};
