'use strict';

const fs = require('node:fs');
const { openStore, dbPath, SCHEMA, asciiMasks } = require('./live-sites-public-store');

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

function tableExists(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name=?").pluck().get(name);
}

function shortSearch(db, value) {
  if (value.length === 1) {
    const code = value.codePointAt(0);
    if (code < 32 || code > 126) return null;
    const ready = db.prepare('SELECT value FROM projection_meta WHERE key=?').pluck().get('ascii_masks_ready') === SCHEMA;
    const masks = asciiMasks(value);
    return { ready, column: code - 32 < 63 ? 'ascii_low' : 'ascii_high', mask: code - 32 < 63 ? masks.low : masks.high };
  }
  if (value.length !== 2 || !tableExists(db, 'projection_terms')) return null;
  const ready = db.prepare('SELECT value FROM projection_meta WHERE key=?').pluck().get('short_terms_ready') === SCHEMA;
  if (!ready) return { ready: false, expression: null };
  const terms = db.prepare('SELECT term FROM projection_terms WHERE instr(term,?)>0').pluck().all(value);
  const quote = term => `"${term.replaceAll('"', '""')}"`;
  return { ready: true, expression: terms.length && terms.length <= 4096 ? terms.map(quote).join(' OR ') : null, overflow: terms.length > 4096 };
}

function queryDay(universeDir, day, { q, exclude }) {
  const file = dbPath(universeDir, day);
  if (!fs.existsSync(file)) return null;
  const db = openStore(file, { readonly: true });
  try {
    if (db.prepare('SELECT value FROM projection_meta WHERE key=?').pluck().get('schema') !== SCHEMA) {
      db.close();
      return null;
    }
    const sources = db.prepare('SELECT name,dev,ino,offset,captured_size AS size,updated_at AS updatedAt FROM projection_sources').all();
    const names = new Set(sources.map(row => row.name));
    const observation = names.has('observations.jsonl') ? 'observations.jsonl' : names.has('observations.partial.jsonl') ? 'observations.partial.jsonl' : null;
    const active = [observation, names.has('ct-launches.jsonl') ? 'ct-launches.jsonl' : null].filter(Boolean);
    if (!active.length) {
      db.close();
      return null;
    }
    const placeholders = active.map(() => '?').join(',');
    const conditions = [];
    const args = [...active];
    const ftsPhrase = value => `"${value.replaceAll('"', '""')}"`;
    const shortIndexes = [];
    const conditionFor = (value, negate = false) => {
      if (value.length >= 3) {
        args.push(ftsPhrase(value));
        return `r.rowid ${negate ? 'NOT ' : ''}IN (SELECT rowid FROM projection_search WHERE projection_search MATCH ?)`;
      }
      const short = shortSearch(db, value);
      if (short) shortIndexes.push(short.ready);
      if (short?.ready && short.column) {
        args.push(short.mask);
        return `(r.${short.column} & ?) ${negate ? '=' : '!='} 0`;
      }
      if (short?.ready) {
        if (!short.expression && !short.overflow) return negate ? '1' : '0';
        if (short.overflow) {
          args.push(value);
          return `r.rowid ${negate ? 'NOT ' : ''}IN (SELECT rowid FROM projection_rows WHERE instr(search_lower, ?) > 0)`;
        }
        args.push(short.expression, value);
        return `r.rowid ${negate ? 'NOT ' : ''}IN (
          SELECT projection_search.rowid FROM projection_search
          JOIN projection_rows p ON p.rowid=projection_search.rowid
          WHERE projection_search MATCH ? AND instr(p.search_lower,?)>0
        )`;
      }
      args.push(value);
      return `r.rowid ${negate ? 'NOT ' : ''}IN (SELECT rowid FROM projection_rows WHERE instr(search_lower, ?) > 0)`;
    };
    if (q) {
      conditions.push(conditionFor(q));
    }
    if (exclude) {
      conditions.push(conditionFor(exclude, true));
    }
    const matched = conditions.length ? `CASE WHEN ${conditions.join(' AND ')} THEN 1 ELSE 0 END` : '1';
    const bodyColumn = q ? 'body' : 'NULL AS body';
    const cte = `WITH candidates AS (
      SELECT r.rowid AS rid,r.source,r.domain,r.title_key,r.zone,r.day,r.observed_at
      FROM projection_index r JOIN projection_sources s
        ON s.name=r.source AND s.generation=r.generation AND r.end_offset<=s.offset
      WHERE r.source IN (${placeholders})
    ), ranked AS (
      SELECT *, row_number() OVER (PARTITION BY domain ORDER BY CASE source WHEN 'ct-launches.jsonl' THEN 1 ELSE 0 END) AS rn
      FROM candidates
    ), active AS (SELECT rid,domain,title_key,zone,day,observed_at FROM ranked WHERE rn=1),
    qualified AS (
      SELECT rid,domain,zone,day,observed_at,count(*) OVER (PARTITION BY title_key) AS title_count FROM active
    ), good_ids AS (SELECT rid,domain FROM qualified WHERE title_count<8)`;
    const sql = `${cte}
    SELECT r.rowid AS rid,r.domain,r.zone,r.day,r.observed_at AS observedAt,${matched} AS matched
    FROM good_ids g JOIN projection_index r ON r.rowid=g.rid
    ORDER BY CASE WHEN r.observed_at IS NULL THEN 1 ELSE 0 END, r.observed_at DESC, r.domain`;
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
        shortSearchReady: shortIndexes.every(Boolean),
        updatedAt: state?.updatedAt || null };
    });
    const hydrate = db.prepare(`SELECT domain,zone,day,title,description,url,observed_at AS observedAt,${bodyColumn}
      FROM projection_rows WHERE rowid=?`);
    return { db, rows: db.prepare(sql).iterate(...args), hydrate, sources, freshness };
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
        if (!row.matched) continue;
        matches.push({ rid: row.rid, domain: row.domain, zone: row.zone, day: row.day, observedAt: row.observedAt });
      }
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
        const row = value.hydrate.get(item.rid);
        if (!row) continue;
        const hydrated = { domain: row.domain, zone: row.zone, day: row.day, title: row.title, description: row.description, url: row.url, observedAt: row.observedAt };
        if (q) {
          const base = `${row.domain}\n${row.title}\n${row.description || ''}`.toLowerCase();
          if (!base.includes(q)) {
            const at = String(row.body || '').toLowerCase().indexOf(q);
            if (at >= 0) hydrated.snippet = makeSnippet(row.body, at, q.length);
          }
        }
        items.push(hydrated); last = hydrated;
      }
    } finally { value.db.close(); }
  }
  return { items, total, more, last, missing, sourceStatus, zones: [...zones].map(([z, count]) => ({ zone: z, count })).sort((a, b) => b.count - a.count || a.zone.localeCompare(b.zone)).slice(0, 50) };
}

process.on('message', message => {
  if (!message || message.type !== 'query') return;
  try { process.send?.({ id: message.id, ok: true, value: run(message.payload) }); }
  catch (error) { process.send?.({ id: message.id, ok: false, error: error.message }); }
});
