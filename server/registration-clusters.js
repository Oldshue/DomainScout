'use strict';

/**
 * Registration Cluster Detection — Stage 1 of registration-cluster mapping.
 *
 * Detects durable REGISTRATION CLUSTERS from the NRD lane already captured
 * in zone_index.db (zone_daily_tokens, zone_daily_new_names,
 * zone_keyword_tld_history) and records their members as cohorts in
 * sale_watch.db, so a later pass can map each cohort forward against market
 * surfaces (for-sale universe day-sets, the sale reconstruction tape).
 *
 * House style of server/sale-watch-reconstruction.js: caller passes
 * better-sqlite3 handles; every side-effecting dependency is
 * opts-injectable; orchestrators never throw. [RegClusters] log prefix
 * throughout.
 *
 * Forward-join against market surfaces is NOT this stage — no market checks
 * are implemented here.
 */

const DEFAULT_KIT_MIN = 15;
const DEFAULT_FAMILY_MIN_ZONES = 3;
const DEFAULT_SWEEP_LOOKBACK_DAYS = 21;
const DEFAULT_SWEEP_MIN_DAYS = 3;
const DEFAULT_MAX_MEMBERS_PER_CLUSTER = 400;

/**
 * Creates (IF NOT EXISTS) the tables this module owns. Idempotent — safe to
 * call on every use.
 */
function ensureClusterSchema(clusterDb) {
  clusterDb.exec(`
    CREATE TABLE IF NOT EXISTS registration_clusters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cluster_key TEXT NOT NULL,
      type TEXT NOT NULL,
      birth_day TEXT NOT NULL,
      last_active_day TEXT,
      member_count INTEGER NOT NULL DEFAULT 0,
      zones_json TEXT,
      meta_json TEXT,
      created_at TEXT,
      UNIQUE(cluster_key, type, birth_day)
    );

    CREATE TABLE IF NOT EXISTS registration_cluster_members (
      cluster_id INTEGER NOT NULL,
      domain TEXT NOT NULL,
      added_day TEXT NOT NULL,
      listed_seen_day TEXT,
      sold_seen_day TEXT,
      live_seen_day TEXT,
      dropped_seen_day TEXT,
      last_checked_day TEXT,
      PRIMARY KEY (cluster_id, domain)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS idx_reg_cluster_members_last_checked
      ON registration_cluster_members (last_checked_day);

    -- Tiny pass-tracking table so runDailyClusterPass can skip a day it has
    -- already processed (mirrors sale_watch_universe_days' already-persisted
    -- guard, but here we only need the day, not a payload).
    CREATE TABLE IF NOT EXISTS cluster_pass_days (
      day TEXT PRIMARY KEY,
      completed_at TEXT
    );
  `);
}

function dateMinusDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/**
 * Token-burst kits: bigram-compound tokens (word_count >= 2, length >= 9, no
 * internal-space unigrams/trigram+ phrases — those are excluded via the
 * `token NOT LIKE '% % %'` guard) whose .com registration count on `day`
 * clears minMembers (env DOMAINSCOUT_CLUSTER_KIT_MIN, default 15). Members
 * are recovered from zone_daily_new_names: any base_name (hyphens removed)
 * that CONTAINS the token (spaces removed), capped at 400 per cluster.
 */
function detectKitClusters(zoneDb, { day, minMembers } = {}) {
  const min = Number.isFinite(minMembers) && minMembers > 0
    ? minMembers
    : (parseInt(process.env.DOMAINSCOUT_CLUSTER_KIT_MIN, 10) || DEFAULT_KIT_MIN);

  const hits = zoneDb.prepare(`
    SELECT tld, token, word_count, reg_count
    FROM zone_daily_tokens
    WHERE report_date = @day
      AND tld = 'com'
      AND reg_count >= @min
      AND word_count >= 2
      AND length(token) >= 9
      AND token NOT LIKE '% % %'
  `).all({ day, min });

  if (!hits.length) return [];

  const nameRows = zoneDb.prepare(`
    SELECT base_name FROM zone_daily_new_names WHERE report_date = @day AND tld = 'com'
  `).all({ day });

  const clusters = [];
  for (const hit of hits) {
    const tokenCompact = String(hit.token || '').replace(/\s+/g, '');
    if (!tokenCompact) continue;
    const members = [];
    for (const row of nameRows) {
      const baseCompact = String(row.base_name || '').replace(/-/g, '');
      if (baseCompact.includes(tokenCompact)) {
        members.push(`${row.base_name}.com`);
        if (members.length >= DEFAULT_MAX_MEMBERS_PER_CLUSTER) break;
      }
    }
    if (!members.length) continue;
    clusters.push({ clusterKey: hit.token, type: 'kit', day, members, meta: { regCount: hit.reg_count } });
  }
  return clusters;
}

/**
 * Multi-zone brand families: keywords whose zone_keyword_tld_history row for
 * `day` clears minZones (env DOMAINSCOUT_CLUSTER_FAMILY_MIN_ZONES, default
 * 3) and whose source is 'nrd-feed'. Members = keyword + each tld in
 * tlds_json.
 */
function detectFamilyClusters(zoneDb, { day, minZones } = {}) {
  const min = Number.isFinite(minZones) && minZones > 0
    ? minZones
    : (parseInt(process.env.DOMAINSCOUT_CLUSTER_FAMILY_MIN_ZONES, 10) || DEFAULT_FAMILY_MIN_ZONES);

  const rows = zoneDb.prepare(`
    SELECT keyword, tld_count, tlds_json
    FROM zone_keyword_tld_history
    WHERE trend_date = @day
      AND tld_count >= @min
      AND source = 'nrd-feed'
  `).all({ day, min });

  const clusters = [];
  for (const row of rows) {
    let tlds = [];
    try {
      const parsed = JSON.parse(row.tlds_json);
      if (Array.isArray(parsed)) tlds = parsed;
    } catch (_) { tlds = []; }
    const members = tlds
      .map((tld) => String(tld || '').replace(/^\./, ''))
      .filter(Boolean)
      .map((tld) => `${row.keyword}.${tld}`);
    if (!members.length) continue;
    clusters.push({ clusterKey: row.keyword, type: 'family', day, members, meta: { tldCount: row.tld_count } });
  }
  return clusters;
}

/**
 * Recurring kits: cluster_keys of type 'kit' already recorded in
 * registration_clusters appearing on >= minDays (env
 * DOMAINSCOUT_CLUSTER_SWEEP_MIN_DAYS, default 3) distinct birth_days within
 * lookbackDays (default 21, ending at `day`) get one 'sweep' cluster whose
 * birth_day is the earliest of those kit days and whose members are the
 * union of those kits' members (capped 400); meta lists the kit days.
 */
function detectSweepClusters(clusterDb, { day, lookbackDays, minDays } = {}) {
  const lookback = Number.isFinite(lookbackDays) && lookbackDays > 0
    ? lookbackDays
    : DEFAULT_SWEEP_LOOKBACK_DAYS;
  const minDaysCount = Number.isFinite(minDays) && minDays > 0
    ? minDays
    : (parseInt(process.env.DOMAINSCOUT_CLUSTER_SWEEP_MIN_DAYS, 10) || DEFAULT_SWEEP_MIN_DAYS);

  const since = dateMinusDays(day, lookback);
  const kitRows = clusterDb.prepare(`
    SELECT id, cluster_key, birth_day
    FROM registration_clusters
    WHERE type = 'kit' AND birth_day >= @since AND birth_day <= @day
  `).all({ since, day });
  if (!kitRows.length) return [];

  const byKey = new Map();
  for (const row of kitRows) {
    if (!byKey.has(row.cluster_key)) byKey.set(row.cluster_key, { days: new Set(), rows: [] });
    const entry = byKey.get(row.cluster_key);
    entry.days.add(row.birth_day);
    entry.rows.push(row);
  }

  const memberStmt = clusterDb.prepare('SELECT domain FROM registration_cluster_members WHERE cluster_id = ?');

  const clusters = [];
  for (const [clusterKey, entry] of byKey.entries()) {
    if (entry.days.size < minDaysCount) continue;
    const sortedDays = [...entry.days].sort();
    const memberSet = new Set();
    outer:
    for (const row of entry.rows) {
      for (const m of memberStmt.all(row.id)) {
        memberSet.add(m.domain);
        if (memberSet.size >= DEFAULT_MAX_MEMBERS_PER_CLUSTER) break outer;
      }
    }
    clusters.push({
      clusterKey,
      type: 'sweep',
      day: sortedDays[0],
      members: [...memberSet],
      meta: { kitDays: sortedDays },
    });
  }
  return clusters;
}

/**
 * Upserts clusters (UNIQUE(cluster_key, type, birth_day) tolerant — INSERT
 * OR IGNORE then refresh last_active_day/member_count) and INSERT OR IGNORE
 * members with added_day.
 */
function recordClusters(clusterDb, clusters, { day } = {}) {
  const list = Array.isArray(clusters) ? clusters : [];
  if (!list.length) return { clusters: 0, members: 0 };

  const insertCluster = clusterDb.prepare(`
    INSERT OR IGNORE INTO registration_clusters
      (cluster_key, type, birth_day, last_active_day, member_count, zones_json, meta_json, created_at)
    VALUES (@clusterKey, @type, @birthDay, @lastActiveDay, @memberCount, @zonesJson, @metaJson, datetime('now'))
  `);
  const selectId = clusterDb.prepare('SELECT id FROM registration_clusters WHERE cluster_key = ? AND type = ? AND birth_day = ?');
  const updateCluster = clusterDb.prepare(`
    UPDATE registration_clusters
    SET last_active_day = @lastActiveDay, member_count = @memberCount,
        zones_json = COALESCE(@zonesJson, zones_json), meta_json = COALESCE(@metaJson, meta_json)
    WHERE id = @id
  `);
  const insertMember = clusterDb.prepare(`
    INSERT OR IGNORE INTO registration_cluster_members (cluster_id, domain, added_day)
    VALUES (@clusterId, @domain, @addedDay)
  `);

  let clustersRecorded = 0;
  let membersRecorded = 0;

  const txn = clusterDb.transaction((items) => {
    for (const cluster of items) {
      const birthDay = cluster.day || day;
      const members = Array.isArray(cluster.members) ? cluster.members : [];
      const zonesJson = cluster.zones ? JSON.stringify(cluster.zones) : null;
      const metaJson = cluster.meta ? JSON.stringify(cluster.meta) : null;

      insertCluster.run({
        clusterKey: cluster.clusterKey, type: cluster.type, birthDay,
        lastActiveDay: day || birthDay, memberCount: members.length, zonesJson, metaJson,
      });
      const row = selectId.get(cluster.clusterKey, cluster.type, birthDay);
      if (!row) continue;
      updateCluster.run({ id: row.id, lastActiveDay: day || birthDay, memberCount: members.length, zonesJson, metaJson });
      clustersRecorded += 1;

      for (const domain of members) {
        const info = insertMember.run({ clusterId: row.id, domain, addedDay: day || birthDay });
        if (info.changes > 0) membersRecorded += 1;
      }
    }
  });
  txn(list);

  return { clusters: clustersRecorded, members: membersRecorded };
}

/**
 * Never-throw orchestrator for the newest complete NRD day (the newest
 * complete day may lag "yesterday UTC", so we use MAX(report_date) present
 * in zone_daily_tokens rather than computing yesterday directly). Skips
 * (with reason) if that day was already passed, tracked in
 * cluster_pass_days. Runs the three detectors, records them, logs one
 * `[RegClusters] pass <day>: K kits, F families, S sweeps, M new members`
 * line, and returns the summary.
 */
async function runDailyClusterPass(clusterDb, zoneDb, opts = {}) {
  let day = null;
  try {
    ensureClusterSchema(clusterDb);

    const dayRow = zoneDb.prepare('SELECT MAX(report_date) AS day FROM zone_daily_tokens').get();
    day = opts.day || dayRow?.day || null;
    if (!day) {
      console.warn('[RegClusters] runDailyClusterPass: no report_date found in zone_daily_tokens, skipping');
      return { day: null, ran: false, reason: 'no-data' };
    }

    const already = clusterDb.prepare('SELECT 1 FROM cluster_pass_days WHERE day = ? LIMIT 1').get(day);
    if (already) {
      console.log(`[RegClusters] runDailyClusterPass: ${day} already passed, skipping`);
      return { day, ran: false, reason: 'already-passed' };
    }

    const kits = (opts.detectKitClusters || detectKitClusters)(zoneDb, { day, minMembers: opts.kitMin });
    const families = (opts.detectFamilyClusters || detectFamilyClusters)(zoneDb, { day, minZones: opts.familyMinZones });
    const kitResult = recordClusters(clusterDb, kits, { day });
    const familyResult = recordClusters(clusterDb, families, { day });

    const sweeps = (opts.detectSweepClusters || detectSweepClusters)(clusterDb, {
      day, lookbackDays: opts.sweepLookbackDays, minDays: opts.sweepMinDays,
    });
    const sweepResult = recordClusters(clusterDb, sweeps, { day });

    clusterDb.prepare(`
      INSERT OR IGNORE INTO cluster_pass_days (day, completed_at)
      VALUES (?, datetime('now'))
    `).run(day);

    const newMembers = kitResult.members + familyResult.members + sweepResult.members;
    console.log(`[RegClusters] pass ${day}: ${kits.length} kits, ${families.length} families, ${sweeps.length} sweeps, ${newMembers} new members`);

    return { day, ran: true, kits: kits.length, families: families.length, sweeps: sweeps.length, newMembers };
  } catch (err) {
    console.warn(`[RegClusters] runDailyClusterPass failed: ${err.message}`);
    return { day: opts.day || day, ran: false, reason: 'error', error: err.message };
  }
}

module.exports = {
  ensureClusterSchema,
  detectKitClusters,
  detectFamilyClusters,
  detectSweepClusters,
  recordClusters,
  runDailyClusterPass,
  dateMinusDays,
  DEFAULT_KIT_MIN,
  DEFAULT_FAMILY_MIN_ZONES,
  DEFAULT_SWEEP_LOOKBACK_DAYS,
  DEFAULT_SWEEP_MIN_DAYS,
  DEFAULT_MAX_MEMBERS_PER_CLUSTER,
};
