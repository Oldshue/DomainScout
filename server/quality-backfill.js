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
  const staleWhere = staleOnly
    ? "AND (quality_score IS NULL OR quality_score = 0 OR quality_reasons IS NULL OR quality_reasons = '')"
    : '';
  const rows = db.prepare(`
    SELECT *
    FROM domains
    WHERE registration_available = 1
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

if (require.main === module) {
  const force = process.argv.includes('--force');
  const limitArg = process.argv.find(arg => arg.startsWith('--limit='));
  const limit = limitArg ? limitArg.split('=')[1] : undefined;
  const summary = backfillAvailableQualityScores({ staleOnly: !force, limit });
  console.log(JSON.stringify(summary, null, 2));
}

module.exports = {
  backfillAvailableQualityScores,
};
