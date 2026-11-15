'use strict';

const fs = require('node:fs');
const { openStore, dbPath, SCHEMA } = require('./live-sites-public-store');

function observedMs(item) {
  if (!item?.observedAt) return null;
  const value = Date.parse(item.observedAt);
  return Number.isFinite(value) ? value : null;
}
function compare(a, b) {
  const ao = observedMs(a), bo = observedMs(b);
  if (ao !== bo) { if (ao === null) return 1; if (bo === null) return -1; return bo - ao; }
  return a.domain < b.domain ? -1 : a.domain > b.domain ? 1 : 0;
}
function makeSnippet(text, at, len) {
  const source = String(text || '');
  if (!source) return null;
  const start = Math.max(0, Math.min(at, source.length) - Math.floor((160 - len) / 2));
  const end = Math.min(source.length, start + 160);
  let value = source.slice(start, end).trim();
  if (start > 0) value = `…${value}`;
  if (end < source.length) value = `${value}…`;
  return value;
}

function queryDay(universeDir, day, { q, exclude }) {
  const file = dbPath(universeDir, day);
  if (!fs.existsSync(file)) return null;
  const db = openStore(file, { readonly: true });
  try {
    if (db.prepare('SELECT value FROM projection_meta WHERE key=?').pluck().get('schema') !== SCHEMA) return null;
    const sources = db.prepare('SELECT name,dev,ino,offset,captured_size AS size,updated_at AS updatedAt FROM projection_sources').all();
    const names = new Set(sources.map(row => row.name));
    const observation = names.has('observations.jsonl') ? 'observations.jsonl' : names.has('observations.partial.jsonl') ? 'observations.partial.jsonl' : null;
    const active = [observation, names.has('ct-launches.jsonl') ? 'ct-launches.jsonl' : null].filter(Boolean);
    if (!active.length) return null;
    const placeholders = active.map(() => '?').join(',');
    const conditions = [];
    const args = [...active];
    if (q) { conditions.push('instr(search_lower, ?) > 0'); args.push(q); }
    if (exclude) { conditions.push('instr(search_lower, ?) = 0'); args.push(exclude); }
    const where = conditions.length ? `AND ${conditions.join(' AND ')}` : '';
    const bodyColumn = q ? 'body' : 'NULL AS body';
    const cte = `WITH ranked AS (
      SELECT *, row_number() OVER (PARTITION BY domain ORDER BY CASE source WHEN 'ct-launches.jsonl' THEN 1 ELSE 0 END) AS rn
      FROM projection_rows WHERE source IN (${placeholders})
    ), active AS (SELECT * FROM ranked WHERE rn=1),
    good AS (SELECT * FROM active WHERE lower(trim(title)) NOT IN (
      SELECT lower(trim(title)) FROM active GROUP BY lower(trim(title)) HAVING count(*) >= 8
    ))`;
    const sql = `${cte}
    SELECT domain,zone,day,title,description,url,observed_at AS observedAt,${bodyColumn}
    FROM good WHERE 1=1 ${where} ORDER BY CASE WHEN observed_at IS NULL THEN 1 ELSE 0 END, observed_at DESC, domain`;
    const sourceByName = new Map(sources.map(row => [row.name, row]));
    const sites = require('node:path').dirname(file);
    const final = require('node:path').join(sites, 'observations.jsonl');
    const partial = require('node:path').join(sites, 'observations.partial.jsonl');
    const ct = require('node:path').join(sites, 'ct-launches.jsonl');
    const expected = [fs.existsSync(final) ? final : partial, ct].filter(fs.existsSync);
    const freshness = expected.map(sourcePath => {
      const name = require('node:path').basename(sourcePath), state = sourceByName.get(name), stat = fs.statSync(sourcePath);
      return { name, verifiedBytes: Number(state?.offset || 0), sourceBytes: stat.size,
        currentIdentity: !!state && String(stat.dev) === String(state.dev) && String(stat.ino) === String(state.ino),
        updatedAt: state?.updatedAt || null };
    });
    const allDomains = (q || exclude) ? db.prepare(`${cte} SELECT domain FROM good`).iterate(...active) : null;
    return { db, rows: db.prepare(sql).iterate(...args), allDomains, sources, freshness };
  } catch (error) { db.close(); throw error; }
}

function run({ universeDir, days, q = '', exclude = '', zone = '', cursor = null, limit = 50 }) {
  const seen = new Set(), zones = new Map(), items = [], sourceStatus = [];
  let total = 0, more = false, last = null, missing = 0;
  for (const day of days) {
    const value = queryDay(universeDir, day, { q, exclude });
    if (!value) { missing += 1; continue; }
    sourceStatus.push({ day, sources: value.sources, freshness: value.freshness });
    const matches = [];
    try {
      for (const row of value.rows) {
        if (seen.has(row.domain)) continue;
        seen.add(row.domain);
        const item = { domain: row.domain, zone: row.zone, day: row.day, title: row.title, description: row.description, url: row.url, observedAt: row.observedAt };
        if (q) {
          const base = `${row.domain}\n${row.title}\n${row.description || ''}`.toLowerCase();
          if (!base.includes(q)) {
            const at = String(row.body || '').toLowerCase().indexOf(q);
            if (at >= 0) item.snippet = makeSnippet(row.body, at, q.length);
          }
        }
        matches.push(item);
      }
      if (value.allDomains) for (const row of value.allDomains) seen.add(row.domain);
    } finally { value.db.close(); }
    matches.sort(compare);
    for (const item of matches) zones.set(item.zone, (zones.get(item.zone) || 0) + 1);
    const filtered = zone ? matches.filter(item => item.zone === zone) : matches;
    total += filtered.length;
    if (cursor && day > cursor.d) continue;
    for (const item of filtered) {
      if (cursor && day === cursor.d) {
        const key = { domain: cursor.k, observedAt: cursor.o === null ? null : new Date(cursor.o).toISOString() };
        if (compare(item, key) <= 0) continue;
      }
      if (more) break;
      if (items.length >= limit) { more = true; break; }
      items.push(item); last = item;
    }
  }
  return { items, total, more, last, missing, sourceStatus, zones: [...zones].map(([z, count]) => ({ zone: z, count })).sort((a, b) => b.count - a.count || a.zone.localeCompare(b.zone)).slice(0, 50) };
}

process.on('message', message => {
  if (!message || message.type !== 'query') return;
  try { process.send?.({ id: message.id, ok: true, value: run(message.payload) }); }
  catch (error) { process.send?.({ id: message.id, ok: false, error: error.message }); }
});
