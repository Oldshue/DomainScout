'use strict';

/**
 * Zone nameserver movement: the day-over-day delegation diff of one zone.
 *
 * The daily CZDS zone file carries the NS records of every delegated name.
 * Comparing two consecutive days, name by name, yields every delegation
 * movement in the zone: names that were added, names that were dropped, and
 * names whose nameserver set changed. Each side of a movement is classified
 * by what kind of operator the nameservers belong to (seller listing,
 * parking/monetization, registrar default DNS, hosting/site builder, other),
 * so downstream readers can ask the generic questions
 *
 *   - which names LEFT seller/parking nameservers for different DNS
 *     (an unconfirmed use change, never sale proof), and
 *   - which names MOVED onto hosting/builder DNS (a site going live),
 *
 * for any zone, without ever touching a marketplace feed.
 *
 * Both zone files are streamed in lock-step (a merge join on the owner name,
 * which the registries emit in byte order), so memory stays O(1) in the
 * zone size. The classifier reuses the seller/parking nameserver lists that
 * server/zone-ns-universe.js already maintains (single source of truth) and
 * adds a small registrar-default / hosting table of its own.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const { SELLER_PARKING_NAMESERVERS, PARKING_ONLY_NAMESERVERS } = require('./zone-ns-universe');
const {
  CLASS_SELLER, CLASS_PARKING, CLASS_REGISTRAR, CLASS_HOSTING, CLASS_OTHER, CLASS_NONE,
  CLASS_PRIORITY,
  REGISTRAR_DEFAULT_NAMESERVERS, HOSTING_NAMESERVERS,
  normalizeHost, buildClassifier, classifyNameservers,
} = require('./nameserver-classes');

// This module's buildClassifier default seller/parkingOnly tables are the
// zone-wide seller/parking universe (zone-ns-universe.js); registrar/hosting
// tables come from the shared, dependency-free server/nameserver-classes.js
// (single source of truth, also used by server/sale-watch-evidence.js).
function buildZoneClassifier({
  seller = SELLER_PARKING_NAMESERVERS,
  parkingOnly = PARKING_ONLY_NAMESERVERS,
  registrar = REGISTRAR_DEFAULT_NAMESERVERS,
  hosting = HOSTING_NAMESERVERS,
} = {}) {
  return buildClassifier({ seller, parkingOnly, registrar, hosting });
}


const NS_MARKER = '\tin\tns\t';

/**
 * Parses one zone line of the form `owner\tTTL\tin\tns\thost`. Returns
 * { name, host } (lowercase, trailing dots removed) or null for any other
 * record type, the apex, or a malformed line.
 */
function parseNsLine(line, apex) {
  // NS must be the record TYPE, never the covered type in an RRSIG record.
  const match = String(line).match(/^(\S+)\s+(?:(?:[0-9][0-9wdhms]*|IN)\s+){0,2}NS\s+(\S+)/i);
  if (!match) return null;
  let name = normalizeHost(match[1]);
  let host = normalizeHost(match[2]);
  if (name === apex || name === '@') return null;
  if (apex && !match[1].endsWith('.') && !name.includes('.')) name += '.' + apex;
  if (apex && !host.includes('.')) host += '.' + apex;
  if (!name || name === apex || name.startsWith('$') || name.startsWith(';') || !/^[a-z0-9_.-]+$/.test(name) || !/^[a-z0-9_.-]+$/.test(host)) return null;
  return { name, host };
}

/**
 * Async generator over one gzip zone file: yields { name, ns } for every
 * delegated name, in file order, with NS hosts sorted. The zone apex and
 * non-NS records are skipped. Names are yielded lowercase without the
 * trailing dot.
 */
async function* delegations(zonePath, { zone, signal } = {}) {
  const apex = zone ? String(zone).toLowerCase() : null;
  const source = fs.createReadStream(zonePath, { signal });
  const input = zlib.createGunzip();
  source.on('error', error => input.destroy(error));
  source.pipe(input);
  let tail = '';
  let current = null;
  let hosts = [];
  try {
  for await (const chunk of input) {
    const text = tail + chunk.toString('utf8');
    let start = 0;
    for (;;) {
      const nl = text.indexOf('\n', start);
      if (nl < 0) { tail = text.slice(start); break; }
      const line = text.slice(start, nl);
      start = nl + 1;
      const parsed = parseNsLine(line, apex);
      if (!parsed) continue;
      if (parsed.name !== current) {
        if (current !== null) { hosts = [...new Set(hosts)].sort(); yield { name: current, ns: hosts }; }
        current = parsed.name;
        hosts = [];
      }
      hosts.push(parsed.host);
    }
  }
  if (tail) {
    const parsed = parseNsLine(tail, apex);
    if (parsed) {
      if (parsed.name !== current) {
        if (current !== null) { hosts = [...new Set(hosts)].sort(); yield { name: current, ns: hosts }; }
        current = parsed.name; hosts = [];
      }
      hosts.push(parsed.host);
    }
  }
  if (current !== null) { hosts = [...new Set(hosts)].sort(); yield { name: current, ns: hosts }; }
  } finally { source.destroy(); input.destroy(); }
}

function sameHosts(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Streams the movement between two zone snapshots of the same zone.
 * onRow receives { kind: 'added'|'dropped'|'changed', name, prev, today }
 * where prev/today are { ns, klass, provider } (prev absent for added,
 * today absent for dropped); it may return a promise, which is awaited
 * before the join advances (backpressure). Returns counters. Throws if either snapshot is
 * not in byte order (the merge join would be silently wrong otherwise).
 */
async function diffZoneDelegations({ prevPath, todayPath, zone, signal, classifyHost = buildZoneClassifier(), onRow = () => {} }) {
  const left = delegations(prevPath, { zone, signal })[Symbol.asyncIterator]();
  const right = delegations(todayPath, { zone, signal })[Symbol.asyncIterator]();
  const counts = { prevNames: 0, todayNames: 0, added: 0, dropped: 0, changed: 0, unchanged: 0 };
  let lastLeft = '';
  let lastRight = '';
  const nextLeft = async () => {
    const r = await left.next();
    if (r.done) return null;
    if (r.value.name < lastLeft) throw new Error(`previous zone is not in byte order at ${r.value.name} (after ${lastLeft})`);
    lastLeft = r.value.name; counts.prevNames += 1; return r.value;
  };
  const nextRight = async () => {
    const r = await right.next();
    if (r.done) return null;
    if (r.value.name < lastRight) throw new Error(`today zone is not in byte order at ${r.value.name} (after ${lastRight})`);
    lastRight = r.value.name; counts.todayNames += 1; return r.value;
  };
  const side = (entry) => {
    const c = classifyNameservers(entry.ns, classifyHost);
    return { ns: entry.ns, klass: c.klass, provider: c.provider };
  };
  try {
  let a = await nextLeft();
  let b = await nextRight();
  while (a || b) {
    if (a && (!b || a.name < b.name)) {
      counts.dropped += 1;
      await onRow({ kind: 'dropped', name: a.name, prev: side(a), today: null });
      a = await nextLeft();
    } else if (b && (!a || b.name < a.name)) {
      counts.added += 1;
      await onRow({ kind: 'added', name: b.name, prev: null, today: side(b) });
      b = await nextRight();
    } else {
      if (sameHosts(a.ns, b.ns)) counts.unchanged += 1;
      else {
        counts.changed += 1;
        await onRow({ kind: 'changed', name: a.name, prev: side(a), today: side(b) });
      }
      a = await nextLeft();
      b = await nextRight();
    }
  }
  return counts;
  } finally { await Promise.allSettled([left.return(), right.return()]); }
}

const TAPE_COLUMNS = ['kind', 'domain', 'prev_class', 'today_class', 'prev_provider', 'today_provider', 'prev_ns', 'today_ns'];

function transitionKey(row) {
  const from = row.prev ? row.prev.klass : CLASS_NONE;
  const to = row.today ? row.today.klass : CLASS_NONE;
  return `${from}>${to}`;
}

/**
 * Writes the movement tape for one zone-day to `outDir`:
 *   movement-<zone>-<day>.tsv.gz  every added / dropped / changed name with
 *                                 both sides classified (TAPE_COLUMNS header)
 *   movement-<zone>-<day>.meta.json  counts by kind and by class transition,
 *                                 the top providers gained and lost, timing.
 * Rows are written for every movement; readers filter by transition
 * (e.g. seller>hosting for unconfirmed use-change leads).
 */
async function writeZoneMovementTape({ prevPath, todayPath, zone, day, prevDay, outDir, log = () => {} }) {
  fs.mkdirSync(outDir, { recursive: true });
  const base = path.join(outDir, `movement-${zone}-${day}`);
  const tmp = `${base}.tsv.gz.part`;
  const gz = zlib.createGzip({ level: 6 });
  const out = fs.createWriteStream(tmp);
  gz.pipe(out);
  const finished = new Promise((resolve, reject) => { out.on('finish', resolve); out.on('error', reject); gz.on('error', reject); });
  const write = (line) => (gz.write(line) ? null : new Promise((resolve) => gz.once('drain', resolve)));
  await write(`${TAPE_COLUMNS.join('\t')}\n`);
  const transitions = new Map();
  const gained = new Map();
  const lost = new Map();
  const bump = (map, key) => map.set(key, (map.get(key) || 0) + 1);
  const startedAt = Date.now();
  let rows = 0;
  const counts = await diffZoneDelegations({
    prevPath, todayPath, zone,
    onRow: (row) => {
      rows += 1;
      bump(transitions, transitionKey(row));
      if (row.today && row.today.provider) bump(gained, `${row.today.klass}:${row.today.provider}`);
      if (row.prev && row.prev.provider) bump(lost, `${row.prev.klass}:${row.prev.provider}`);
      const line = [
        row.kind, row.name,
        row.prev ? row.prev.klass : '', row.today ? row.today.klass : '',
        row.prev ? (row.prev.provider || '') : '', row.today ? (row.today.provider || '') : '',
        row.prev ? row.prev.ns.join(',') : '', row.today ? row.today.ns.join(',') : '',
      ].join('\t') + '\n';
      if (rows % 100000 === 0) log(`[ZoneNsMovement] ${zone} ${day}: ${rows} movement rows so far`);
      return write(line);
    },
  });
  gz.end();
  await finished;
  fs.renameSync(tmp, `${base}.tsv.gz`);
  const top = (map) => [...map.entries()].sort((x, y) => y[1] - x[1]).slice(0, 40).map(([key, count]) => ({ key, count }));
  const meta = {
    type: 'domainscout.zone-ns-movement/v1',
    zone, day, prevDay: prevDay || null,
    prevZone: path.basename(prevPath), todayZone: path.basename(todayPath),
    counts, rows,
    transitions: Object.fromEntries([...transitions.entries()].sort((x, y) => y[1] - x[1])),
    topGained: top(gained), topLost: top(lost),
    columns: TAPE_COLUMNS,
    elapsedMs: Date.now() - startedAt,
    generatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(`${base}.meta.json`, JSON.stringify(meta, null, 1));
  log(`[ZoneNsMovement] ${zone} ${day}: ${counts.added} added, ${counts.dropped} dropped, ${counts.changed} changed (${counts.unchanged} unchanged) in ${Math.round(meta.elapsedMs / 1000)}s`);
  return meta;
}

/**
 * Reads a movement tape back as an async generator of row objects
 * (TAPE_COLUMNS keys, ns fields split into arrays). Optional `where`
 * predicate filters rows before they are yielded.
 */
async function* readZoneMovementTape(tapePath, { where = () => true } = {}) {
  const input = fs.createReadStream(tapePath).pipe(zlib.createGunzip());
  let tail = '';
  let header = null;
  for await (const chunk of input) {
    const text = tail + chunk.toString('utf8');
    let start = 0;
    for (;;) {
      const nl = text.indexOf('\n', start);
      if (nl < 0) { tail = text.slice(start); break; }
      const line = text.slice(start, nl);
      start = nl + 1;
      if (!line) continue;
      const fields = line.split('\t');
      if (!header) { header = fields; continue; }
      const row = {};
      header.forEach((key, i) => { row[key] = fields[i] || ''; });
      row.prev_ns = row.prev_ns ? row.prev_ns.split(',') : [];
      row.today_ns = row.today_ns ? row.today_ns.split(',') : [];
      if (where(row)) yield row;
    }
  }
}

module.exports = {
  CLASS_SELLER, CLASS_PARKING, CLASS_REGISTRAR, CLASS_HOSTING, CLASS_OTHER, CLASS_NONE,
  REGISTRAR_DEFAULT_NAMESERVERS, HOSTING_NAMESERVERS, TAPE_COLUMNS,
  buildClassifier: buildZoneClassifier, classifyNameservers, parseNsLine, delegations, diffZoneDelegations,
  writeZoneMovementTape, readZoneMovementTape, transitionKey,
};
