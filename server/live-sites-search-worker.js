'use strict';

// Exact public-feed search runs in a terminating child. It streams the
// publishable search projections, so private source journals and their large
// body strings are never retained by the interactive web process.
const fs = require('node:fs');
const readline = require('node:readline');

const KIT_TITLE_REPEAT = 8;
const SNIPPET_CHARS = 160;

function observedMs(item) {
  if (!item?.observedAt) return null;
  const value = Date.parse(item.observedAt);
  return Number.isFinite(value) ? value : null;
}
function compare(a, b) {
  const ao = observedMs(a), bo = observedMs(b);
  if (ao !== bo) {
    if (ao === null) return 1;
    if (bo === null) return -1;
    return bo - ao;
  }
  return a.domain < b.domain ? -1 : a.domain > b.domain ? 1 : 0;
}
function snippet(text, at, len) {
  const source = String(text || '');
  if (!source) return null;
  const start = Math.max(0, Math.min(at, source.length) - Math.floor((SNIPPET_CHARS - len) / 2));
  const end = Math.min(source.length, start + SNIPPET_CHARS);
  let value = source.slice(start, end).trim();
  if (start > 0) value = `…${value}`;
  if (end < source.length) value = `${value}…`;
  return value;
}

async function readFile(file, entries) {
  const lines = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (!row?.item?.domain || entries.has(row.item.domain)) continue;
    entries.set(row.item.domain, row);
  }
}

async function runSearch({ days, q = '', exclude = '', zone = '', cursor = null, limit = 50 }) {
  const seen = new Set();
  const zones = new Map();
  const result = [];
  let total = 0, more = false, last = null;
  for (const day of days) {
    const entries = new Map();
    for (const file of day.files) await readFile(file, entries);
    const titleCounts = new Map();
    for (const { item } of entries.values()) {
      const title = String(item.title || '').trim().toLowerCase();
      titleCounts.set(title, (titleCounts.get(title) || 0) + 1);
    }
    const matches = [];
    for (const { item, text } of entries.values()) {
      if (titleCounts.get(String(item.title || '').trim().toLowerCase()) >= KIT_TITLE_REPEAT) continue;
      if (seen.has(item.domain)) continue;
      seen.add(item.domain);
      const base = `${item.domain}\n${item.title}\n${item.description || ''}`.toLowerCase();
      const body = String(text || '').toLowerCase();
      let at = -1;
      if (q && !base.includes(q)) { at = body.indexOf(q); if (at < 0) continue; }
      if (exclude && (base.includes(exclude) || body.includes(exclude))) continue;
      matches.push(at < 0 ? item : { ...item, snippet: snippet(text, at, q.length) });
    }
    matches.sort(compare);
    for (const item of matches) zones.set(item.zone, (zones.get(item.zone) || 0) + 1);
    const filtered = zone ? matches.filter(item => item.zone === zone) : matches;
    total += filtered.length;
    if (cursor && day.day > cursor.d) continue;
    for (const item of filtered) {
      if (cursor && day.day === cursor.d) {
        const current = { observedAt: cursor.o === null ? null : new Date(cursor.o).toISOString(), domain: cursor.k };
        if (compare(item, current) <= 0) continue;
      }
      if (more) break;
      if (result.length >= limit) { more = true; break; }
      result.push(item); last = item;
    }
  }
  return { items: result, total, more, last, zones: [...zones].map(([z, n]) => ({ zone: z, count: n })).sort((a, b) => b.count - a.count || a.zone.localeCompare(b.zone)).slice(0, 50) };
}

if (require.main === module) {
  process.once('message', message => runSearch(message).then(value => process.send?.({ ok: true, value }), error => process.send?.({ ok: false, error: error.message })).finally(() => process.disconnect?.()));
}

module.exports = { runSearch };
