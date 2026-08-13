'use strict';

const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const schemaReadyDatabases = new WeakSet();

function parseJson(value, fallback) {
  try {
    const parsed = JSON.parse(value);
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function normalizeBaseName(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 80);
}

function normalizeUniverse(universe) {
  const tlds = [...new Set((universe?.tlds || [])
    .map(value => String(value || '').trim().toLowerCase())
    .filter(Boolean)
    .map(tld => tld.startsWith('.') ? tld : `.${tld}`)
  )].sort();
  const id = String(universe?.id || universe?.identity || universe?.source || '').trim();
  const version = String(universe?.version || universe?.hash || '').trim();
  return {
    ...universe,
    id,
    version,
    tlds,
    count: tlds.length,
    authoritative: universe?.authoritative === true,
  };
}

function ensureNameverseCoverageSchema(database) {
  if (schemaReadyDatabases.has(database)) return;
  const columns = new Set(database.prepare('PRAGMA table_info(tld_check_cache)').all().map(column => column.name));
  const additions = [
    ['universe_id', 'TEXT'],
    ['universe_version', 'TEXT'],
    ['checked_count', 'INTEGER NOT NULL DEFAULT 0'],
    ['total_count', 'INTEGER NOT NULL DEFAULT 0'],
    ['completed_at', 'TEXT'],
    ['coverage_status', "TEXT NOT NULL DEFAULT 'partial'"],
    ['evidence_json', "TEXT NOT NULL DEFAULT '[]'"],
    ['failures_json', "TEXT NOT NULL DEFAULT '[]'"],
  ];
  let migratedLegacyRows = false;
  for (const [name, definition] of additions) {
    if (columns.has(name)) continue;
    database.exec(`ALTER TABLE tld_check_cache ADD COLUMN ${name} ${definition}`);
    if (name === 'coverage_status') migratedLegacyRows = true;
  }

  database.exec(`
    CREATE TABLE IF NOT EXISTS nameverse_check_progress (
      base_name        TEXT PRIMARY KEY,
      universe_id      TEXT NOT NULL,
      universe_version TEXT NOT NULL,
      total_count      INTEGER NOT NULL,
      checked_json     TEXT NOT NULL DEFAULT '[]',
      evidence_json    TEXT NOT NULL DEFAULT '[]',
      failures_json    TEXT NOT NULL DEFAULT '[]',
      started_at       TEXT NOT NULL,
      updated_at       TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_nameverse_progress_updated
      ON nameverse_check_progress(updated_at, base_name);
    CREATE TABLE IF NOT EXISTS tld_work_queue (
      base_name TEXT PRIMARY KEY,
      ord INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_tld_work_queue_ord ON tld_work_queue(ord);
  `);

  if (migratedLegacyRows) {
    database.prepare(`
      UPDATE tld_check_cache
      SET coverage_status = 'partial',
          checked_count = CASE WHEN checked_count > 0 THEN checked_count ELSE 0 END,
          total_count = CASE WHEN total_count > 0 THEN total_count ELSE all_count END,
          completed_at = NULL,
          evidence_json = CASE WHEN evidence_json IS NULL OR evidence_json = '' THEN '[]' ELSE evidence_json END,
          failures_json = CASE WHEN failures_json IS NULL OR failures_json = '' THEN '[]' ELSE failures_json END
      WHERE universe_id IS NULL OR universe_version IS NULL
    `).run();
    try {
      database.exec(`
        UPDATE domains
        SET tlds_taken = NULL, tlds_checked_at = NULL
        WHERE base_name IN (SELECT base_name FROM tld_check_cache WHERE coverage_status != 'complete')
      `);
    } catch { /* tests may provide only the cache table */ }
  }
  schemaReadyDatabases.add(database);
}

function rowToCoverageReceipt(row) {
  if (!row) return null;
  const evidence = parseJson(row.evidence_json, []);
  const legacyTaken = parseJson(row.taken_json, []);
  const positives = Array.isArray(evidence) && evidence.length
    ? evidence
    : (Array.isArray(legacyTaken) ? legacyTaken.map(tld => ({
        tld, status: 'taken', source: 'legacy-cache', checkedAt: row.checked_at || null,
      })) : []);
  const failures = parseJson(row.failures_json, []);
  return {
    baseName: row.base_name,
    universeId: row.universe_id || null,
    universeVersion: row.universe_version || null,
    checkedCount: Number(row.checked_count || 0),
    totalCount: Number(row.total_count || row.all_count || 0),
    completedAt: row.completed_at || null,
    status: ['complete', 'partial', 'stale'].includes(row.coverage_status) ? row.coverage_status : 'partial',
    count: Number(row.count || positives.length || 0),
    positives,
    failures: Array.isArray(failures) ? failures : [],
    checkedAt: row.checked_at || null,
  };
}

function evaluateCoverageReceipt(rowOrReceipt, universeInput, options = {}) {
  const universe = normalizeUniverse(universeInput);
  const receipt = rowOrReceipt && Object.prototype.hasOwnProperty.call(rowOrReceipt, 'universeId')
    ? rowOrReceipt
    : rowToCoverageReceipt(rowOrReceipt);
  if (!receipt) return { status: 'partial', current: false, complete: false, receipt: null };
  const maxAgeMs = Number(options.maxAgeMs || DEFAULT_MAX_AGE_MS);
  const nowMs = options.now instanceof Date ? options.now.getTime() : Number(options.now || Date.now());
  const completedMs = receipt.completedAt ? new Date(receipt.completedAt).getTime() : NaN;
  const structurallyComplete = receipt.status === 'complete' &&
    receipt.universeId === universe.id &&
    receipt.universeVersion === universe.version &&
    receipt.checkedCount === universe.count &&
    receipt.totalCount === universe.count &&
    receipt.failures.length === 0 &&
    Number.isFinite(completedMs);
  const current = structurallyComplete && completedMs <= nowMs && nowMs - completedMs <= maxAgeMs;
  const status = current
    ? 'complete'
    : (receipt.status === 'complete' || receipt.status === 'stale' ? 'stale' : 'partial');
  return { status, current, complete: current, receipt: { ...receipt, status } };
}

function projectCoverageReceipt(row, universe, options = {}) {
  const evaluated = evaluateCoverageReceipt(row, universe, options);
  const receipt = evaluated.receipt;
  const lowerBound = receipt ? Math.max(0, Number(receipt.count || receipt.positives.length || 0)) : 0;
  return {
    extensions: evaluated.complete ? lowerBound : null,
    extensionsLowerBound: evaluated.complete ? null : (lowerBound > 0 ? lowerBound : null),
    extensionsLabel: evaluated.complete ? String(lowerBound) : (lowerBound > 0 ? `At least ${lowerBound} (not verified)` : 'Not verified'),
    verified: evaluated.complete,
    receipt,
  };
}

function enqueueNameverseRefresh(database, baseName, ord = -1) {
  ensureNameverseCoverageSchema(database);
  const clean = normalizeBaseName(baseName);
  if (!clean) return false;
  return database.prepare(`
    INSERT INTO tld_work_queue (base_name, ord) VALUES (?, ?)
    ON CONFLICT(base_name) DO UPDATE SET ord = MIN(COALESCE(tld_work_queue.ord, 0), excluded.ord)
  `).run(clean, Number.isFinite(Number(ord)) ? Number(ord) : -1).changes > 0;
}

function createNameverseCoverageProducer(options) {
  const database = options.database;
  const resolver = options.resolver;
  if (!database || typeof resolver !== 'function') throw new Error('database and resolver are required');
  ensureNameverseCoverageSchema(database);
  const batchSize = Math.max(1, Math.min(2000, Number(options.batchSize || 250)));
  const concurrency = Math.max(1, Math.min(250, Number(options.concurrency || 80)));
  const now = typeof options.now === 'function' ? options.now : () => new Date();
  const source = String(options.source || 'dns-ns');

  const getProgress = database.prepare('SELECT * FROM nameverse_check_progress WHERE base_name = ?');
  const getCache = database.prepare('SELECT * FROM tld_check_cache WHERE base_name = ?');
  const upsertProgress = database.prepare(`
    INSERT INTO nameverse_check_progress (
      base_name, universe_id, universe_version, total_count, checked_json,
      evidence_json, failures_json, started_at, updated_at
    ) VALUES (
      @baseName, @universeId, @universeVersion, @totalCount, @checkedJson,
      @evidenceJson, @failuresJson, @startedAt, @updatedAt
    )
    ON CONFLICT(base_name) DO UPDATE SET
      universe_id = excluded.universe_id,
      universe_version = excluded.universe_version,
      total_count = excluded.total_count,
      checked_json = excluded.checked_json,
      evidence_json = excluded.evidence_json,
      failures_json = excluded.failures_json,
      started_at = excluded.started_at,
      updated_at = excluded.updated_at
  `);
  const publishCache = database.prepare(`
    INSERT INTO tld_check_cache (
      base_name, count, taken_json, all_count, source, checked_at,
      universe_id, universe_version, checked_count, total_count, completed_at,
      coverage_status, evidence_json, failures_json
    ) VALUES (
      @baseName, @count, @takenJson, @totalCount, @source, @checkedAt,
      @universeId, @universeVersion, @checkedCount, @totalCount, @completedAt,
      @status, @evidenceJson, @failuresJson
    )
    ON CONFLICT(base_name) DO UPDATE SET
      count = excluded.count,
      taken_json = excluded.taken_json,
      all_count = excluded.all_count,
      source = excluded.source,
      checked_at = excluded.checked_at,
      universe_id = excluded.universe_id,
      universe_version = excluded.universe_version,
      checked_count = excluded.checked_count,
      total_count = excluded.total_count,
      completed_at = excluded.completed_at,
      coverage_status = excluded.coverage_status,
      evidence_json = excluded.evidence_json,
      failures_json = excluded.failures_json
  `);
  const deleteProgress = database.prepare('DELETE FROM nameverse_check_progress WHERE base_name = ?');
  const upsertBaseCount = database.prepare(`
    INSERT INTO base_tld_counts (base_name, tld_count, source, updated_at)
    VALUES (@baseName, @count, @source, @checkedAt)
    ON CONFLICT(base_name) DO UPDATE SET
      tld_count = excluded.tld_count, source = excluded.source, updated_at = excluded.updated_at
  `);
  const updateDomains = database.prepare(`
    UPDATE domains SET tlds_taken = @count, tlds_checked_at = @checkedAt WHERE base_name = @baseName
  `);

  async function refreshBaseName(baseName, universeInput, seedResults = []) {
    const cleanBase = normalizeBaseName(baseName);
    if (!cleanBase) throw new Error('invalid base name');
    const universe = normalizeUniverse(universeInput);
    if (!universe.authoritative || !universe.id || !universe.version || !universe.tlds.length) {
      return {
        baseName: cleanBase,
        universeId: universe.id || null,
        universeVersion: universe.version || null,
        checkedCount: 0,
        totalCount: universe.count,
        completedAt: null,
        status: 'partial',
        count: 0,
        positives: [],
        failures: [{ tld: null, reason: 'iana-universe-not-authoritative', attempts: 0 }],
      };
    }

    const timestamp = now().toISOString();
    let progress = getProgress.get(cleanBase);
    if (!progress || progress.universe_id !== universe.id ||
        progress.universe_version !== universe.version || Number(progress.total_count) !== universe.count) {
      progress = null;
    }
    const checked = new Set(progress ? parseJson(progress.checked_json, []) : []);
    const evidenceByTld = new Map((progress ? parseJson(progress.evidence_json, []) : [])
      .filter(item => item && item.tld)
      .map(item => [item.tld, item]));
    const failuresByTld = new Map((progress ? parseJson(progress.failures_json, []) : [])
      .filter(item => item && item.tld)
      .map(item => [item.tld, item]));
    for (const result of Array.isArray(seedResults) ? seedResults : []) {
      const tld = String(result?.tld || '').toLowerCase();
      if (!universe.tlds.includes(tld) || checked.has(tld)) continue;
      if (result.status === 'taken' || result.status === 'not_taken') {
        checked.add(tld);
        failuresByTld.delete(tld);
        if (result.status === 'taken') {
          evidenceByTld.set(tld, {
            tld, status: 'taken', source: String(result.source || source), checkedAt: timestamp,
          });
        }
      }
    }
    const targets = universe.tlds.filter(tld => !checked.has(tld)).slice(0, batchSize);

    let cursor = 0;
    const results = [];
    const pool = Array.from({ length: Math.min(concurrency, targets.length) }, async () => {
      while (cursor < targets.length) {
        const tld = targets[cursor++];
        try {
          const result = await resolver(`${cleanBase}${tld}`, tld, cleanBase);
          const status = result === true || result === 'taken'
            ? 'taken'
            : (result === false || result === 'not_taken' ? 'not_taken' : 'unknown');
          results.push({ tld, status });
        } catch (error) {
          results.push({
            tld, status: 'unknown',
            reason: String(error?.code || error?.message || 'lookup-failed'),
          });
        }
      }
    });
    await Promise.all(pool);

    for (const result of results) {
      if (result.status === 'taken' || result.status === 'not_taken') {
        checked.add(result.tld);
        failuresByTld.delete(result.tld);
        if (result.status === 'taken') {
          evidenceByTld.set(result.tld, {
            tld: result.tld, status: 'taken', source, checkedAt: timestamp,
          });
        }
      } else {
        const previous = failuresByTld.get(result.tld);
        failuresByTld.set(result.tld, {
          tld: result.tld,
          reason: result.reason || 'lookup-unknown',
          attempts: Number(previous?.attempts || 0) + 1,
        });
      }
    }

    const positives = [...evidenceByTld.values()].sort((a, b) => a.tld.localeCompare(b.tld));
    const failures = [...failuresByTld.values()].sort((a, b) => a.tld.localeCompare(b.tld));
    const complete = checked.size === universe.count && failures.length === 0;
    const receipt = {
      baseName: cleanBase,
      universeId: universe.id,
      universeVersion: universe.version,
      checkedCount: checked.size,
      totalCount: universe.count,
      completedAt: complete ? timestamp : null,
      status: complete ? 'complete' : 'partial',
      count: positives.length,
      positives,
      failures,
      checkedAt: timestamp,
    };

    database.transaction(() => {
      if (!complete) {
        upsertProgress.run({
          baseName: cleanBase,
          universeId: universe.id,
          universeVersion: universe.version,
          totalCount: universe.count,
          checkedJson: JSON.stringify([...checked].sort()),
          evidenceJson: JSON.stringify(positives),
          failuresJson: JSON.stringify(failures),
          startedAt: progress?.started_at || timestamp,
          updatedAt: timestamp,
        });
      } else {
        // Publication is atomic: incomplete successor work lives only in the
        // progress table. A previously complete receipt is never overwritten by
        // a partial refresh, so readers either see the last complete snapshot or
        // fail closed while the first snapshot is built.
        publishCache.run({
          baseName: cleanBase,
          count: positives.length,
          takenJson: JSON.stringify(positives.map(item => item.tld)),
          totalCount: universe.count,
          source: `nameverse:${universe.id}:${universe.version}`,
          checkedAt: timestamp,
          universeId: universe.id,
          universeVersion: universe.version,
          checkedCount: checked.size,
          completedAt: timestamp,
          status: 'complete',
          evidenceJson: JSON.stringify(positives),
          failuresJson: JSON.stringify(failures),
        });
        deleteProgress.run(cleanBase);
        upsertBaseCount.run({
          baseName: cleanBase, count: positives.length,
          source: `nameverse:${universe.version}`, checkedAt: timestamp,
        });
        updateDomains.run({ baseName: cleanBase, count: positives.length, checkedAt: timestamp });
      }
    })();

    return receipt;
  }

  function readReceipt(baseName, universe, projectionOptions) {
    return projectCoverageReceipt(getCache.get(normalizeBaseName(baseName)), universe, projectionOptions);
  }

  return { refreshBaseName, readReceipt };
}

module.exports = {
  DEFAULT_MAX_AGE_MS,
  createNameverseCoverageProducer,
  enqueueNameverseRefresh,
  ensureNameverseCoverageSchema,
  evaluateCoverageReceipt,
  normalizeUniverse,
  projectCoverageReceipt,
  rowToCoverageReceipt,
};
