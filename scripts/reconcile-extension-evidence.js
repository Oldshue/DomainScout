#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ALPHA_TLDS } = require('../server/domain-quality');
const { checkRegistryWhoisBatch } = require('../server/registry-whois-evidence');

const EXCLUDED = new Set(['.xyz', '.shop', '.info']);
const DEFAULT_ROOT = '/tmp/ds-current-recovery';
const DEFAULT_ARTIFACT = path.resolve(__dirname, '../artifacts/data/agent-x-extension-reconciliation.json');
const DEFAULT_IMPORT_ARTIFACT = path.resolve(__dirname, '../artifacts/data/agent-x-extension-import.json');

function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

function normalizeExtension(value) {
  const clean = String(value || '').trim().toLowerCase().replace(/^\.+|\.+$/g, '');
  return clean && clean.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ? `.${clean}` : null;
}

function parseDotdbCells(cells) {
  if (!Array.isArray(cells) || cells.length < 4) return [];
  return [...new Set(String(cells[3] || '').replace(/\s*More\s*$/i, '').split(',').map(normalizeExtension).filter(Boolean))].sort();
}

function receiptView(row) {
  if (!row) return null;
  return { domain: row.domain, status: row.status, source: row.source, server: row.server || null,
    checkedAt: row.checkedAt, bytes: Number(row.bytes) || 0, sha256: row.sha256 || null,
    ...(row.error ? { boundary: row.error } : {}) };
}

function laterThan(left, right) { return Date.parse(left || 0) > Date.parse(right || 0); }

function reconcileCell(observations, receipt) {
  const positive = observations.filter(item => item.status === 'registered');
  const latestPositive = positive.sort((a, b) => Date.parse(b.checkedAt || 0) - Date.parse(a.checkedAt || 0))[0] || null;
  if (receipt?.status === 'available' && (!latestPositive || laterThan(receipt.checkedAt, latestPositive.checkedAt))) {
    return { registered: false, decision: 'fresh-registry-negative', observations, registryWhois: receiptView(receipt) };
  }
  if (receipt?.status === 'registered') {
    return { registered: true, decision: 'registry-whois-positive', observations, registryWhois: receiptView(receipt) };
  }
  if (latestPositive) {
    return { registered: true, decision: 'materialized-positive; registry-unresolved', observations, registryWhois: receiptView(receipt) };
  }
  return { registered: false, decision: receipt?.status === 'available' ? 'registry-whois-negative' : 'unresolved', observations, registryWhois: receiptView(receipt) };
}

function loadInputs(root = DEFAULT_ROOT) {
  return { qualified: readJson(path.join(root, 'qualified.json')), prior: readJson(path.join(root, 'evidence.json')),
    comWhois: readJson(path.join(root, 'whois.json')), supplementWhois: readJson(path.join(root, 'supplement-whois.json')),
    dotdb: readJson(path.join(root, 'dotdb-reconciliation.json')), agentwall: readJson(path.join(root, 'dotdb-agentwall.json')) };
}

function buildScope(inputs) {
  const values = new Set(ALPHA_TLDS.map(normalizeExtension).filter(Boolean));
  for (const row of inputs.qualified) for (const extension of row.extensions || []) values.add(normalizeExtension(extension));
  for (const row of inputs.dotdb.rows || []) for (const extension of parseDotdbCells(row.cells)) values.add(extension);
  for (const extension of inputs.agentwall.extensions || []) values.add(normalizeExtension(extension));
  return [...values].filter(Boolean).sort();
}

function buildObservations(inputs) {
  const cells = new Map();
  const add = (baseName, extension, observation) => {
    const ext = normalizeExtension(extension); if (!baseName || !ext) return;
    const key = `${baseName}${ext}`; if (!cells.has(key)) cells.set(key, []); cells.get(key).push(observation);
  };
  for (const row of inputs.qualified) {
    const baseName = row.domain.replace(/\.com$/i, '');
    for (const extension of row.extensions || []) add(baseName, extension, { status: 'registered', evidenceType: 'DomainScout materialized positive', source: inputs.prior.snapshot?.source || 'DomainScout production /api/name-research', checkedAt: inputs.prior.checkedAt });
  }
  for (const row of inputs.dotdb.rows || []) for (const extension of parseDotdbCells(row.cells)) add(row.baseName, extension, { status: 'registered', evidenceType: 'third-party indexed registration observation', source: row.source, checkedAt: row.checkedAt });
  for (const extension of inputs.agentwall.extensions || []) add(inputs.agentwall.baseName, extension, { status: 'registered', evidenceType: inputs.agentwall.evidenceType, source: inputs.agentwall.source, checkedAt: inputs.agentwall.checkedAt });
  return cells;
}

function seedReceipts(inputs, checkpointRows = []) {
  const receipts = new Map();
  for (const row of [...inputs.comWhois, ...inputs.supplementWhois, ...checkpointRows]) {
    if (!row?.domain || !row?.status) continue;
    const normalized = { domain: String(row.domain).toLowerCase(), status: row.status,
      source: row.source || (row.server ? `registry-whois:${row.server}` : 'registry-whois-unavailable'), server: row.server || null,
      checkedAt: row.checkedAt, bytes: Number(row.bytes) || 0, sha256: row.sha256 || null,
      ...(row.error || row.boundary ? { error: row.error || row.boundary } : {}) };
    const old = receipts.get(normalized.domain); if (!old || laterThan(normalized.checkedAt, old.checkedAt)) receipts.set(normalized.domain, normalized);
  }
  return receipts;
}

function publicResult(inputs, scope, observations, receipts) {
  const capturedBaselines = new Map();
  for (const row of inputs.dotdb.rows || []) {
    const extensions = parseDotdbCells(row.cells);
    if (extensions.length) capturedBaselines.set(row.baseName, {
      rawCount: extensions.length, extensions, source: row.source, checkedAt: row.checkedAt,
      evidenceType: 'third-party indexed registration observation',
    });
  }
  capturedBaselines.set(inputs.agentwall.baseName, {
    rawCount: inputs.agentwall.extensions.length, activeSiteCount: inputs.agentwall.active,
    extensions: [...inputs.agentwall.extensions].sort(), source: inputs.agentwall.source,
    checkedAt: inputs.agentwall.checkedAt, evidenceType: inputs.agentwall.evidenceType,
  });
  const rows = inputs.qualified.map(sourceRow => {
    const domain = sourceRow.domain.toLowerCase(); const baseName = domain.replace(/\.com$/, '');
    const cells = scope.map(extension => ({ extension, ...reconcileCell(observations.get(`${baseName}${extension}`) || [], receipts.get(`${baseName}${extension}`)) }));
    const extensions = cells.filter(cell => cell.registered).map(cell => cell.extension);
    const eligibleExtensions = extensions.filter(extension => !EXCLUDED.has(extension));
    const unknownScope = cells.filter(cell => cell.decision === 'unresolved' || cell.decision.endsWith('registry-unresolved')).map(cell => cell.extension);
    return { domain, baseName, priceUsd: sourceRow.price, priceSource: inputs.prior.priceSource, priceCheckedWindow: inputs.prior.priceCheckedWindow,
      rawCount: extensions.length, eligibleCount: eligibleExtensions.length, extensions, eligibleExtensions,
      excludedExtensions: extensions.filter(extension => EXCLUDED.has(extension)), scopeCount: scope.length, unknownScope,
      capturedIndexObservation: capturedBaselines.get(baseName) || null,
      comRegistryWhois: receiptView(receipts.get(domain)), cells };
  });
  const audit = rows.find(row => row.domain === 'agentrust.com');
  const usable = rows.filter(row => row.domain !== 'agentrust.com').sort((a, b) => b.eligibleCount - a.eligibleCount || a.priceUsd - b.priceUsd || a.domain.localeCompare(b.domain)).map((row, index) => ({ rank: index + 1, ...row }));
  const matrixDomains = new Set(rows.flatMap(row => scope.map(extension => `${row.baseName}${extension}`)));
  const receiptRows = [...receipts.values()].filter(row => matrixDomains.has(row.domain));
  return { schemaVersion: 1, generatedAt: new Date().toISOString(), objective: inputs.prior.objective,
    evidencePolicy: { countMeaning: 'cardinality of the concrete registered extension list; not an active-site count or whole-IANA completeness claim', eligibleExclusions: [...EXCLUDED], precedence: 'a later conclusive direct registry-WHOIS negative overrides an older indexed positive; inconclusive or unavailable WHOIS does not erase a concrete positive observation' },
    explicitScope: { count: scope.length, extensions: scope, completeWholeIanaUniverse: false },
    receiptSummary: { total: receiptRows.length, registered: receiptRows.filter(row => row.status === 'registered').length, available: receiptRows.filter(row => row.status === 'available').length, unknown: receiptRows.filter(row => row.status === 'unknown').length },
    sourceBoundaries: [inputs.dotdb.boundary, 'Registry WHOIS may be unavailable, retired, throttled, or inconclusive; those cells remain explicit in unknownScope.', 'Registrar batch verification was unavailable because its configured monthly quota was exhausted.'],
    ranking: usable, auditOnly: { reason: 'AgentRust overlaps Agent+Trust and is not a literal Agent+X target', row: audit } };
}

function importPayloads(result) {
  const byExtension = new Map();
  for (const row of [...result.ranking, result.auditOnly.row]) for (const cell of row.cells) {
    const receipt = cell.registryWhois;
    if (!receipt || !['registered', 'available'].includes(receipt.status)) continue;
    if (!byExtension.has(cell.extension)) byExtension.set(cell.extension, []);
    byExtension.get(cell.extension).push(receipt);
  }
  return [...byExtension].sort(([left], [right]) => left.localeCompare(right)).map(([extension, receipts]) => ({
    provider: 'receipt', tlds: [extension],
    baseNames: receipts.map(receipt => receipt.domain.slice(0, -extension.length)), receipts,
  }));
}

function compactResult(result) {
  const compactRow = row => ({
    rank: row.rank, domain: row.domain, baseName: row.baseName, priceUsd: row.priceUsd,
    priceSource: row.priceSource, priceCheckedWindow: row.priceCheckedWindow,
    rawCount: row.rawCount, eligibleCount: row.eligibleCount, extensions: row.extensions,
    eligibleExtensions: row.eligibleExtensions, excludedExtensions: row.excludedExtensions,
    scopeCount: row.scopeCount, unknownScope: row.unknownScope,
    capturedIndexObservation: row.capturedIndexObservation, comRegistryWhois: row.comRegistryWhois,
    positiveEvidence: row.cells.filter(cell => cell.registered).map(cell => ({
      extension: cell.extension, decision: cell.decision,
      observations: cell.observations, registryWhois: cell.registryWhois,
    })),
    directRegistryNegativeScope: row.cells.filter(cell => cell.decision === 'fresh-registry-negative' || cell.decision === 'registry-whois-negative').map(cell => cell.extension),
  });
  return { schemaVersion: result.schemaVersion, generatedAt: result.generatedAt, objective: result.objective,
    evidencePolicy: result.evidencePolicy, explicitScope: result.explicitScope,
    receiptSummary: result.receiptSummary, sourceBoundaries: result.sourceBoundaries,
    ranking: result.ranking.map(compactRow), auditOnly: { reason: result.auditOnly.reason, row: compactRow(result.auditOnly.row) } };
}

async function main() {
  const root = process.env.RECONCILIATION_ROOT || DEFAULT_ROOT;
  const output = process.env.RECONCILIATION_OUTPUT || path.join(root, 'complete-reconciliation.json');
  const artifact = process.env.RECONCILIATION_ARTIFACT || DEFAULT_ARTIFACT;
  const importArtifact = process.env.RECONCILIATION_IMPORT_ARTIFACT || DEFAULT_IMPORT_ARTIFACT;
  const checkpoint = process.env.RECONCILIATION_CHECKPOINT || path.join(root, 'registry-whois-receipts.json');
  const inputs = loadInputs(root); const scope = buildScope(inputs); const observations = buildObservations(inputs);
  const checkpointRows = fs.existsSync(checkpoint) ? readJson(checkpoint) : []; const receipts = seedReceipts(inputs, checkpointRows);
  if (process.env.RECONCILIATION_RECHECK_REGISTERED === '1') {
    for (const [domain, row] of receipts) if (row.status === 'registered') receipts.delete(domain);
  }
  const domains = [];
  for (const row of inputs.qualified) { const baseName = row.domain.replace(/\.com$/i, ''); for (const extension of scope) { const domain = `${baseName}${extension}`; if (!receipts.has(domain)) domains.push(domain); } }
  const chunkSize = Math.max(20, Math.min(200, Number(process.env.RECONCILIATION_CHUNK_SIZE) || 160));
  for (let offset = 0; offset < domains.length; offset += chunkSize) {
    const batch = domains.slice(offset, offset + chunkSize); const checked = await checkRegistryWhoisBatch(batch, { concurrency: 2, timeoutMs: 10_000 });
    for (const row of checked) receipts.set(row.domain, row);
    fs.writeFileSync(checkpoint, `${JSON.stringify([...receipts.values()], null, 2)}\n`, { mode: 0o600 });
    process.stderr.write(`checked ${Math.min(offset + batch.length, domains.length)}/${domains.length}; receipts=${receipts.size}\n`);
  }
  const result = publicResult(inputs, scope, observations, receipts); fs.mkdirSync(path.dirname(artifact), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`); fs.writeFileSync(artifact, `${JSON.stringify(compactResult(result), null, 2)}\n`);
  fs.writeFileSync(importArtifact, `${JSON.stringify({ schemaVersion: 1, generatedAt: result.generatedAt, endpoint: '/api/extension-evidence/check', batches: importPayloads(result) }, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ output, artifact, importArtifact, scope: scope.length, rows: result.ranking.length, receipts: result.receiptSummary, top: result.ranking.slice(0, 10).map(row => ({ rank: row.rank, domain: row.domain, priceUsd: row.priceUsd, rawCount: row.rawCount, eligibleCount: row.eligibleCount, unknown: row.unknownScope.length })) }, null, 2)}\n`);
}

if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });

module.exports = { buildObservations, buildScope, compactResult, importPayloads, normalizeExtension, parseDotdbCells, publicResult, reconcileCell, seedReceipts };
