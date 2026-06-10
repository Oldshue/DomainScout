const db = require('./db');
const { computeDomainQuality } = require('./domain-quality');

const updateQuality = db.prepare(`
  UPDATE domains
  SET quality_score = @quality_score,
      quality_reasons = @quality_reasons
  WHERE id = @id
`);

function positiveInt(value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function backfillAvailableQualityScores(options = {}) {
  const limit = positiveInt(options.limit || process.env.DOMAINSCOUT_QUALITY_BACKFILL_LIMIT, 5000, 1, 100000);
  const staleOnly = options.staleOnly !== false;
  // scope: 'available' (expired/registerable only) or 'all' (every domain so the
  // "Best quality" sort is meaningful on auction streams too, not just expired).
  const scopeWhere = options.scope === 'all' ? '1=1' : 'registration_available = 1';
  // "Scored" is marked by quality_reasons being present — NOT by score>0, because
  // 0 is a legitimate score (gibberish/unavailable). Using score=0 as the stale
  // marker would re-select those rows forever and never terminate the loop.
  const staleWhere = staleOnly
    ? "AND (quality_reasons IS NULL OR quality_reasons = '')"
    : '';
  const rows = db.prepare(`
    SELECT *
    FROM domains
    WHERE ${scopeWhere}
      ${staleWhere}
    ORDER BY COALESCE(tlds_taken, 0) DESC, length ASC, domain ASC
    LIMIT @limit
  `).all({ limit });

  if (rows.length === 0) return { scanned: 0, updated: 0 };

  let updated = 0;
  db.transaction((items) => {
    for (const row of items) {
      const quality = computeDomainQuality(row);
      updateQuality.run({ id: row.id, ...quality });
      updated += 1;
    }
  })(rows);

  return { scanned: rows.length, updated };
}

// Score every domain in batches until the (stale) set is exhausted.
function backfillAllQualityScores({ batch = 20000, force = false } = {}) {
  let total = 0, rounds = 0;
  for (;;) {
    const { updated } = backfillAvailableQualityScores({ scope: 'all', staleOnly: !force, limit: batch });
    total += updated;
    rounds += 1;
    if (updated === 0) break;
    if (process.stdout.isTTY) process.stdout.write(`\r  scored ${total}...`);
  }
  return { total, rounds };
}

if (require.main === module) {
  const force = process.argv.includes('--force');
  const all = process.argv.includes('--all');
  const limitArg = process.argv.find(arg => arg.startsWith('--limit='));
  const limit = limitArg ? limitArg.split('=')[1] : undefined;
  const summary = all
    ? backfillAllQualityScores({ force })
    : backfillAvailableQualityScores({ staleOnly: !force, limit });
  console.log('\n' + JSON.stringify(summary, null, 2));
}

module.exports = {
  backfillAvailableQualityScores,
  backfillAllQualityScores,
};
