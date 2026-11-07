'use strict';

// Test-only hooks loaded by server/sale-watch-wave-child.js when
// DOMAINSCOUT_SALE_WATCH_WAVE_TEST_HOOKS=1. Injects synthetic, network-free
// stages into the off-main wave so tests can reproduce production shapes.

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function bulkInsert(db, count, day) {
  const insert = db.prepare(`INSERT OR IGNORE INTO sale_watch_candidates
    (domain, first_seen_day, last_seen_day, last_stream, exit_observed_day, state, next_probe_at, probe_count, evidence_json, updated_at)
    VALUES (?, ?, ?, 'zone-seller-departure', ?, 'exited', ?, 0, ?, ?)`);
  const pad = 'x'.repeat(400);
  for (let start = 0; start < count; start += 1000) {
    db.transaction(() => {
      for (let i = start; i < Math.min(count, start + 1000); i += 1) {
        insert.run(`backlog${i}.com`, day, day, day, '2099-01-01', JSON.stringify({ domain: `backlog${i}.com`, pad }), `${day}T00:00:00Z`);
      }
    })();
  }
  return count;
}

module.exports = function applyHooks(opts, db) {
  const scenario = opts.testScenario;
  const day = opts.now ? String(opts.now).slice(0, 10) : new Date().toISOString().slice(0, 10);
  opts.probeCandidate = async (_db, row) => ({ domain: row.domain, state: 'probing' });
  opts.markAdoptionKits = () => ({ members: 0 });
  opts.screenWentLiveTransfers = async () => null;
  opts.ingestDiscoveryCandidates = () => ({ queued: 0, scanned: 0 });
  if (scenario === 'backlog') {
    // A large synthetic backlog written synchronously, then a stage that
    // blocks its thread for 1.5 s (synchronous SQLite / fs.readSync stand-in).
    opts.ingestMovementCandidates = () => ({ queued: bulkInsert(db, Number(opts.backlogRows) || 20000, day) });
    opts.rdapSweep = () => { sleepSync(1500); return { checked: 0 }; };
  } else if (scenario === 'hang') {
    // Uninterruptible: the child's event loop never runs again.
    opts.rdapSweep = () => { sleepSync(120000); return { checked: 0 }; };
  } else if (scenario === 'select-hang') {
    // The pre-fix shape: a synchronous due selection on the child's own
    // connection that blocks its event loop (no heartbeats).
    opts.selectDueCandidates = () => { sleepSync(120000); return []; };
  } else if (scenario === 'wavesize-hang') {
    // The pre-fix shape of the wave-size backlog count: synchronous on the
    // child's own connection, blocking its event loop.
    opts.computeWaveSize = () => { sleepSync(120000); return 1; };
  }
};
