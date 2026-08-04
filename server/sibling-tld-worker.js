'use strict';

const dns = require('dns').promises;
const db = require('./db');
const { normalizeTld } = require('./taken-in-status');

function positiveInt(value, fallback, min, max) {
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

async function resolveSiblingTldStatus(baseName, tld, timeoutMs = 2500) {
  let timer;
  try {
    const records = await Promise.race([
      dns.resolveNs(`${baseName}${tld}`),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error('DNS timeout'), { code: 'ETIMEOUT' })), timeoutMs);
      }),
    ]);
    return Array.isArray(records) && records.length ? 'taken' : 'not_taken';
  } catch (err) {
    if (['ENOTFOUND', 'ENODATA', 'NXDOMAIN'].includes(String(err?.code || '').toUpperCase())) {
      return 'not_taken';
    }
    return 'unchecked';
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function createSiblingTldWorker(options = {}) {
  const database = options.db || db;
  const resolver = options.resolver || resolveSiblingTldStatus;
  const batchSize = positiveInt(options.batchSize || process.env.DOMAINSCOUT_SIBLING_TLD_BATCH, 100, 1, 1000);
  const concurrency = positiveInt(options.concurrency || process.env.DOMAINSCOUT_SIBLING_TLD_CONCURRENCY, 20, 1, 100);
  const timeoutMs = positiveInt(options.timeoutMs || process.env.DOMAINSCOUT_SIBLING_TLD_TIMEOUT_MS, 2500, 300, 15000);
  const maxAgeHours = positiveInt(options.maxAgeHours || process.env.DOMAINSCOUT_SIBLING_TLD_MAX_AGE_HOURS, 6, 1, 168);
  let running = false;
  let updateHook = typeof options.onUpdate === 'function' ? options.onUpdate : () => {};

  const popDue = database.prepare(`
    SELECT base_name, tld, attempts
    FROM sibling_tld_queue
    WHERE datetime(next_attempt_at) <= datetime('now')
    ORDER BY requested_at, base_name, tld
    LIMIT @limit
  `);
  const upsertStatus = database.prepare(`
    INSERT INTO sibling_tld_status (base_name, tld, status, source, checked_at)
    VALUES (@baseName, @tld, @status, 'dns-ns', datetime('now'))
    ON CONFLICT(base_name, tld) DO UPDATE SET
      status = excluded.status,
      source = excluded.source,
      checked_at = excluded.checked_at
  `);
  const deleteQueue = database.prepare('DELETE FROM sibling_tld_queue WHERE base_name = @baseName AND tld = @tld');
  const retryQueue = database.prepare(`
    UPDATE sibling_tld_queue
    SET attempts = attempts + 1,
        next_attempt_at = datetime('now', '+' || @delaySeconds || ' seconds')
    WHERE base_name = @baseName AND tld = @tld
  `);

  function queueState(targetTlds = []) {
    const targets = [...new Set(targetTlds.map(normalizeTld).filter(Boolean))];
    if (!targets.length) return { pending: 0, checked: 0, running };
    const placeholders = targets.map((_, index) => `@target${index}`).join(',');
    const params = Object.fromEntries(targets.map((target, index) => [`target${index}`, target]));
    const pending = database.prepare(`SELECT COUNT(*) AS n FROM sibling_tld_queue WHERE tld IN (${placeholders})`).get(params).n;
    const checked = database.prepare(`SELECT COUNT(*) AS n FROM sibling_tld_status WHERE tld IN (${placeholders})`).get(params).n;
    return { pending, checked, running };
  }

  function enqueue({ sourceTlds = [], targetTlds = [], limit = 5000 } = {}) {
    const targets = [...new Set(targetTlds.map(normalizeTld).filter(Boolean))].slice(0, 8);
    const sources = [...new Set(sourceTlds.map(normalizeTld).filter(Boolean))].slice(0, 16);
    const boundedLimit = positiveInt(limit, 5000, 1, 20000);
    let queued = 0;

    for (const [targetIndex, target] of targets.entries()) {
      const params = { target, limit: boundedLimit, maxAgeHours };
      const sourceClause = sources.length
        ? `AND d.tld IN (${sources.map((source, index) => {
            params[`source${targetIndex}_${index}`] = source;
            return `@source${targetIndex}_${index}`;
          }).join(',')})`
        : '';
      const info = database.prepare(`
        INSERT OR IGNORE INTO sibling_tld_queue (base_name, tld, requested_at, next_attempt_at)
        SELECT candidate.base_name, @target, datetime('now'), datetime('now')
        FROM (
          SELECT DISTINCT d.base_name
          FROM domains d
          WHERE d.stream = 'just-dropped'
            AND d.base_name IS NOT NULL AND d.base_name != ''
            AND (d.registration_available IS NULL OR d.registration_available = 1)
            ${sourceClause}
            AND NOT EXISTS (
              SELECT 1 FROM sibling_tld_status status
              WHERE status.base_name = d.base_name AND status.tld = @target
                AND datetime(status.checked_at) > datetime('now', '-' || @maxAgeHours || ' hours')
            )
          ORDER BY d.discovered_at DESC
          LIMIT @limit
        ) candidate
      `).run(params);
      queued += info.changes;
    }

    const state = queueState(targets);
    if (state.pending > 0 && process.env.DOMAINSCOUT_SIBLING_TLD_WORKER !== '0') {
      setImmediate(() => drain().catch(err => console.warn('[SiblingTLD] worker failed:', err.message)));
    }
    return { ...state, queued, targetTlds: targets };
  }

  async function drain() {
    if (running || process.env.DOMAINSCOUT_SIBLING_TLD_WORKER === '0') return;
    running = true;
    let changed = 0;
    try {
      for (;;) {
        const rows = popDue.all({ limit: batchSize });
        if (!rows.length) break;
        let cursor = 0;
        const results = [];
        const pool = Array.from({ length: Math.min(concurrency, rows.length) }, async () => {
          while (cursor < rows.length) {
            const row = rows[cursor++];
            const status = await resolver(row.base_name, row.tld, timeoutMs);
            results.push({ ...row, status });
          }
        });
        await Promise.all(pool);
        database.transaction(items => {
          for (const item of items) {
            const params = { baseName: item.base_name, tld: item.tld };
            if (item.status === 'taken' || item.status === 'not_taken') {
              upsertStatus.run({ ...params, status: item.status });
              deleteQueue.run(params);
              changed++;
            } else {
              const delaySeconds = Math.min(900, 15 * (2 ** Math.min(6, Number(item.attempts || 0))));
              retryQueue.run({ ...params, delaySeconds });
            }
          }
        })(results);
        if (changed) updateHook(changed);
        if (rows.length < batchSize) break;
      }
    } finally {
      running = false;
    }
  }

  function setUpdateHook(hook) {
    updateHook = typeof hook === 'function' ? hook : () => {};
  }

  return { drain, enqueue, queueState, setUpdateHook };
}

const defaultWorker = createSiblingTldWorker();

module.exports = {
  createSiblingTldWorker,
  resolveSiblingTldStatus,
  enqueueSiblingTldChecks: options => defaultWorker.enqueue(options),
  getSiblingTldQueueState: targetTlds => defaultWorker.queueState(targetTlds),
  setSiblingTldUpdateHook: hook => defaultWorker.setUpdateHook(hook),
};
