// Off-main read-only SQLite worker.
//
// better-sqlite3 is SYNCHRONOUS, so a heavy query on the main thread freezes the whole
// event loop for its full duration — and the _expiring/_expired virtual streams, when
// sorted by anything other than the indexed fast-path (reverse direction, alt columns,
// deep pages), materialize + temp-sort the full ~540k-row union for ~6-10s. While that
// runs, EVERY other request (other users, agents, a trivial just-dropped switch) hangs
// behind it (measured: a 19ms query took 6177ms concurrently). This worker holds its own
// read-only connection to domains.db and runs those heavy queries off the main thread, so
// the event loop stays responsive. It runs the EXACT SAME SQL the main thread would have
// run (the caller passes the built statement + params), so results are byte-identical —
// no correctness risk, only a thread boundary. The main thread keeps the writable
// connection (and does the cheap page enrichment); this worker never writes.
const { parentPort, workerData } = require('worker_threads');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const db = new Database(workerData.dbPath, { readonly: true });
// A read-only connection can still wait on the writer's WAL checkpoint; give it room
// rather than erroring out (the main thread's fallback would just re-run it anyway).
try { db.pragma('busy_timeout = 15000'); } catch (_) { /* non-fatal */ }

// Keep ordinary catalog reads independent from the much larger analytical warehouse.
// The caller creates a dedicated lane for SQL that actually references `zi.*`; attaching
// it to every worker let one warehouse checkpoint or long query strand all later catalog
// reads behind the same synchronous worker queue.
if (workerData.attachZoneIndex === true) {
  try {
    const ziPath = path.join(path.dirname(workerData.dbPath), 'zone_index.db');
    if (fs.existsSync(ziPath)) db.exec(`ATTACH DATABASE '${ziPath}' AS zi`);
  } catch (_) { /* zi optional */ }
}

const reportCache=new Map();
parentPort.on('message', (msg) => {
  const { id, sql, params, operation } = msg || {};
  try {
    let rows;
    if(operation){
      const methods={'domainlab.insights':'computeDailyInsights','domainlab.domains':'computeDailyDomains'};
      if(!methods[operation])throw new Error('Unknown read operation');
      const key=JSON.stringify([operation,params]);const cached=reportCache.get(key);
      if(cached && Date.now()-cached.at<60000)rows=cached.rows;
      else { rows=require('./domainlab')[methods[operation]](db,params||{});reportCache.set(key,{at:Date.now(),rows});if(reportCache.size>8)reportCache.delete(reportCache.keys().next().value); }
    } else rows=db.prepare(sql).all(params||{});
    parentPort.postMessage({ id, ok: true, rows });
  } catch (err) {
    parentPort.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
});
