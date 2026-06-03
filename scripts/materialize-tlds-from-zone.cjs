// Materialize domains.tlds_taken = best available "registered in N extensions" count:
// MAX of the zone-index gTLD count and the DNS accuracy-worker count (which includes
// ccTLDs the zone files can't cover). The worker's cached count is the union total,
// so it supersedes the zone count whenever it exists. Run periodically as the worker
// and zone sync fill in coverage. WAL mode lets the server keep reading meanwhile.
const Database = require("better-sqlite3");
const db = new Database("data/domains.db");
db.pragma("journal_mode=WAL");
db.prepare("ATTACH DATABASE ? AS zi").run("data/zone_index.db");
const base = "LOWER(SUBSTR(domain,1,INSTR(domain,'.')-1))";
console.log("materializing tlds_taken = MAX(zone, dns-cache)...", new Date().toISOString());
const t0 = Date.now();
const r = db.prepare(`
  UPDATE domains
  SET tlds_taken = MAX(
        COALESCE((SELECT ns.tld_count FROM zi.name_summary ns WHERE ns.base_name = ${base}), 0),
        COALESCE((SELECT tc.count     FROM tld_check_cache tc WHERE tc.base_name = ${base}), 0)
      ),
      tlds_checked_at = COALESCE(tlds_checked_at, datetime('now'))
  WHERE EXISTS (SELECT 1 FROM zi.name_summary ns WHERE ns.base_name = ${base})
     OR EXISTS (SELECT 1 FROM tld_check_cache tc WHERE tc.base_name = ${base})
`).run();
console.log("done:", r.changes, "rows in", ((Date.now() - t0) / 1000).toFixed(1), "s");
