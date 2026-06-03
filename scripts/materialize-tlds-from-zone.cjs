const Database=require("better-sqlite3");
const db=new Database("data/domains.db");
db.pragma("journal_mode=WAL");
db.prepare("ATTACH DATABASE ? AS zi").run("data/zone_index.db");
const base="LOWER(SUBSTR(domain,1,INSTR(domain,'.')-1))";
console.log("materializing domains.tlds_taken from zone index...",new Date().toISOString());
const t0=Date.now();
const r=db.prepare(`
  UPDATE domains
  SET tlds_taken = COALESCE((SELECT ns.tld_count FROM zi.name_summary ns WHERE ns.base_name = ${base}), tlds_taken),
      tlds_checked_at = COALESCE(tlds_checked_at, datetime('now'))
  WHERE EXISTS (SELECT 1 FROM zi.name_summary ns WHERE ns.base_name = ${base})
`).run();
console.log("done:",r.changes,"rows updated in",((Date.now()-t0)/1000).toFixed(1),"s");
