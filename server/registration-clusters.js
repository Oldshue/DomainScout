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
 * Stage 2 (this file also owns it): the forward-join pass maps recorded
 * cluster members forward against market surfaces already captured
 * elsewhere with ZERO network calls — the for-sale universe day-sets (gz
 * text files registered in sale_watch_universe_days by
 * server/sale-watch-reconstruction.js) and the sales tape
 * (sale_watch_candidates.state='detected'). Live-site/drop checks are a
 * LATER stage and are not implemented here.
 */

const { readDaySet } = require('./sale-watch-reconstruction');

const DEFAULT_KIT_MIN = 15;
const DEFAULT_FAMILY_MIN_ZONES = 3;
const DEFAULT_SWEEP_LOOKBACK_DAYS = 21;
const DEFAULT_SWEEP_MIN_DAYS = 3;
const DEFAULT_MAX_MEMBERS_PER_CLUSTER = 400;
const DEFAULT_JOIN_BATCH_LIMIT = 20000;

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

/**
 * Stage 2 — forward-join pass. Never-throw. Selects members needing a check
 * (listed_seen_day IS NULL OR sold_seen_day IS NULL, ordered by
 * last_checked_day asc nulls first, LIMIT batchLimit env
 * DOMAINSCOUT_CLUSTER_JOIN_BATCH default 20000). Loads the newest universe
 * day-set once (max(day) in sale_watch_universe_days, streamed via the
 * shared readDaySet helper into a Set of domain strings) and marks any
 * matching, still-unlisted member as listed on that day. Runs one SQL pass
 * (a join over a temp batch table, not per-row queries) to mark members sold
 * when their domain matches a sale_watch_candidates row in state='detected'.
 * Sets last_checked_day = today for the whole batch. Logs one
 * `[RegClusters] join: B members checked, L newly listed, S newly sold`
 * line and returns the summary.
 */
async function runForwardJoinPass(clusterDb, { universeDir, day, batchLimit } = {}) {
  const today = day || new Date().toISOString().slice(0, 10);
  try {
    ensureClusterSchema(clusterDb);

    const limit = Number.isFinite(batchLimit) && batchLimit > 0
      ? Math.floor(batchLimit)
      : (parseInt(process.env.DOMAINSCOUT_CLUSTER_JOIN_BATCH, 10) || DEFAULT_JOIN_BATCH_LIMIT);

    const members = clusterDb.prepare(`
      SELECT cluster_id, domain
      FROM registration_cluster_members
      WHERE listed_seen_day IS NULL OR sold_seen_day IS NULL
      ORDER BY (last_checked_day IS NOT NULL), last_checked_day ASC
      LIMIT ?
    `).all(limit);

    if (!members.length) {
      console.log('[RegClusters] join: 0 members checked, 0 newly listed, 0 newly sold');
      return { checked: 0, listed: 0, sold: 0, day: today, ran: true };
    }

    // Stage the batch into a temp table so the sales pass (and the
    // last_checked_day sweep) can use a real join/EXISTS instead of a
    // per-row query, while still matching exact (cluster_id, domain) pairs.
    clusterDb.exec(`
      CREATE TEMP TABLE IF NOT EXISTS reg_cluster_join_batch (
        cluster_id INTEGER NOT NULL,
        domain TEXT NOT NULL,
        PRIMARY KEY (cluster_id, domain)
      ) WITHOUT ROWID;
    `);
    clusterDb.prepare('DELETE FROM reg_cluster_join_batch').run();
    const insertBatch = clusterDb.prepare('INSERT OR IGNORE INTO reg_cluster_join_batch (cluster_id, domain) VALUES (?, ?)');
    const insertBatchTxn = clusterDb.transaction((rows) => {
      for (const row of rows) insertBatch.run(row.cluster_id, row.domain);
    });
    insertBatchTxn(members);

    // Newest universe day-set, loaded once.
    let listedCount = 0;
    if (universeDir) {
      const newestRow = clusterDb.prepare('SELECT MAX(day) AS day FROM sale_watch_universe_days').get();
      const newestDay = newestRow?.day || null;
      if (newestDay) {
        let universeSet = null;
        try {
          universeSet = await readDaySet(universeDir, newestDay);
        } catch (err) {
          console.warn(`[RegClusters] join: failed to read universe day ${newestDay}: ${err.message}`);
          universeSet = null;
        }
        if (universeSet && universeSet.size) {
          const setListed = clusterDb.prepare(`
            UPDATE registration_cluster_members
            SET listed_seen_day = @day
            WHERE cluster_id = @clusterId AND domain = @domain AND listed_seen_day IS NULL
          `);
          const listedTxn = clusterDb.transaction((rows) => {
            for (const row of rows) {
              if (!universeSet.has(row.domain)) continue;
              const info = setListed.run({ day: newestDay, clusterId: row.cluster_id, domain: row.domain });
              if (info.changes > 0) listedCount += 1;
            }
          });
          listedTxn(members);
        }
      }
    }

    // One SQL pass for sales: join the staged batch against detected candidates.
    const soldInfo = clusterDb.prepare(`
      UPDATE registration_cluster_members
      SET sold_seen_day = (
        SELECT COALESCE(sc.exit_observed_day, sc.updated_at)
        FROM sale_watch_candidates sc
        WHERE sc.domain = registration_cluster_members.domain
          AND sc.state = 'detected'
      )
      WHERE sold_seen_day IS NULL
        AND EXISTS (
          SELECT 1 FROM reg_cluster_join_batch b
          WHERE b.cluster_id = registration_cluster_members.cluster_id
            AND b.domain = registration_cluster_members.domain
        )
        AND EXISTS (
          SELECT 1 FROM sale_watch_candidates sc
          WHERE sc.domain = registration_cluster_members.domain
            AND sc.state = 'detected'
        )
    `).run();
    const soldCount = soldInfo.changes;

    // last_checked_day = today for the whole batch.
    clusterDb.prepare(`
      UPDATE registration_cluster_members
      SET last_checked_day = @today
      WHERE EXISTS (
        SELECT 1 FROM reg_cluster_join_batch b
        WHERE b.cluster_id = registration_cluster_members.cluster_id
          AND b.domain = registration_cluster_members.domain
      )
    `).run({ today });

    clusterDb.prepare('DELETE FROM reg_cluster_join_batch').run();

    console.log(`[RegClusters] join: ${members.length} members checked, ${listedCount} newly listed, ${soldCount} newly sold`);
    return { checked: members.length, listed: listedCount, sold: soldCount, day: today, ran: true };
  } catch (err) {
    console.warn(`[RegClusters] runForwardJoinPass failed: ${err.message}`);
    return { checked: 0, listed: 0, sold: 0, day: today, ran: false, reason: 'error', error: err.message };
  }
}

/**
 * Per-cluster rollup: id, cluster_key, type, birth_day, member_count,
 * listed_count, sold_count, and latest activity day (the max of the
 * cluster's listed/sold seen-days). Ordered by birth_day desc, default
 * limit 200. The surface a future UI/Mission reads.
 */
function readClusterOutcomes(clusterDb, { limit } = {}) {
  const cappedLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 200;
  const rows = clusterDb.prepare(`
    SELECT
      c.id AS id,
      c.cluster_key AS cluster_key,
      c.type AS type,
      c.birth_day AS birth_day,
      COUNT(m.domain) AS member_count,
      SUM(CASE WHEN m.listed_seen_day IS NOT NULL THEN 1 ELSE 0 END) AS listed_count,
      SUM(CASE WHEN m.sold_seen_day IS NOT NULL THEN 1 ELSE 0 END) AS sold_count,
      MAX(m.listed_seen_day) AS latest_listed_day,
      MAX(m.sold_seen_day) AS latest_sold_day
    FROM registration_clusters c
    LEFT JOIN registration_cluster_members m ON m.cluster_id = c.id
    GROUP BY c.id
    ORDER BY c.birth_day DESC, c.id DESC
    LIMIT ?
  `).all(cappedLimit);

  return rows.map((row) => ({
    id: row.id,
    cluster_key: row.cluster_key,
    type: row.type,
    birth_day: row.birth_day,
    member_count: row.member_count || 0,
    listed_count: row.listed_count || 0,
    sold_count: row.sold_count || 0,
    latest_activity_day: [row.latest_listed_day, row.latest_sold_day].filter(Boolean).sort().pop() || null,
  }));
}

module.exports = {
  ensureClusterSchema,
  detectKitClusters,
  detectFamilyClusters,
  detectSweepClusters,
  recordClusters,
  runDailyClusterPass,
  runForwardJoinPass,
  readClusterOutcomes,
  dateMinusDays,
  DEFAULT_KIT_MIN,
  DEFAULT_FAMILY_MIN_ZONES,
  DEFAULT_SWEEP_LOOKBACK_DAYS,
  DEFAULT_SWEEP_MIN_DAYS,
  DEFAULT_MAX_MEMBERS_PER_CLUSTER,
  DEFAULT_JOIN_BATCH_LIMIT,
};
