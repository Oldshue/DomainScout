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
 *   - which names LEFT seller/parking nameservers for a buyer's DNS
 *     (the observable footprint of an off-market sale), and
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

const CLASS_SELLER = 'seller';
const CLASS_PARKING = 'parking';
const CLASS_REGISTRAR = 'registrar';
const CLASS_HOSTING = 'hosting';
const CLASS_OTHER = 'other';
const CLASS_NONE = 'none';

// Registrar-default DNS: assigned to every name a registrar sells until the
// owner points it somewhere. Being here says "not yet pointed", nothing more.
const REGISTRAR_DEFAULT_NAMESERVERS = Object.freeze([
  { provider: 'GoDaddy default', nameserver: 'domaincontrol.com' },
  { provider: 'Namecheap default', nameserver: 'registrar-servers.com' },
  { provider: 'Hostinger default', nameserver: 'dns-parking.com' },
  { provider: 'eNom / Tucows default', nameserver: 'name-services.com' },
  { provider: 'IONOS default', nameserver: 'ui-dns.com' },
  { provider: 'IONOS default', nameserver: 'ui-dns.org' },
  { provider: 'IONOS default', nameserver: 'ui-dns.biz' },
  { provider: 'IONOS default', nameserver: 'ui-dns.de' },
  { provider: 'Dynadot default', nameserver: 'dynadot.com' },
  { provider: 'NameSilo default', nameserver: 'dnsowl.com' },
  { provider: 'NameSilo default', nameserver: 'namesilo.com' },
  { provider: 'Porkbun default', nameserver: 'porkbun.com' },
  { provider: 'Spaceship default', nameserver: 'spaceship.net' },
  { provider: 'Name.com default', nameserver: 'name.com' },
  { provider: 'Network Solutions default', nameserver: 'worldnic.com' },
  { provider: 'Register.com default', nameserver: 'register.com' },
  { provider: 'Gandi default', nameserver: 'gandi.net' },
  { provider: 'OVH default', nameserver: 'ovh.net' },
  { provider: 'Hover default', nameserver: 'hover.com' },
  { provider: 'Google Domains legacy', nameserver: 'googledomains.com' },
  { provider: 'Squarespace Domains default', nameserver: 'squarespacedns.com' },
  { provider: 'Wix Domains default', nameserver: 'wixdomains.com' },
  { provider: 'GoDaddy hold', nameserver: 'godaddy.com' },
  { provider: 'Alibaba / HiChina default', nameserver: 'hichina.com' },
  { provider: 'Alibaba Cloud default', nameserver: 'alidns.com' },
  { provider: 'DNSPod default', nameserver: 'dnspod.net' },
  { provider: 'Xinnet default', nameserver: 'xincache.com' },
  { provider: 'West.cn default', nameserver: 'myhostadmin.net' },
  { provider: 'Sav default', nameserver: 'sav.com' },
  { provider: 'Domain.com default', nameserver: 'domain.com' },
  { provider: 'Bluehost default', nameserver: 'bluehost.com' },
  { provider: 'HostGator default', nameserver: 'hostgator.com' },
  { provider: 'Namecheap hosting', nameserver: 'namecheaphosting.com' },
  { provider: 'SiteGround', nameserver: 'siteground.net' },
  { provider: 'DreamHost', nameserver: 'dreamhost.com' },
  { provider: '1&1 / IONOS hosting', nameserver: '1and1.com' },
  { provider: 'Cloudflare Registrar', nameserver: 'cloudflare-registrar.com' },
]);

// Hosting, CDN and site-builder DNS: a name on one of these is being used
// (or at least deliberately pointed) by an operator.
const HOSTING_NAMESERVERS = Object.freeze([
  { provider: 'Cloudflare', nameserver: 'ns.cloudflare.com' },
  { provider: 'Wix', nameserver: 'wixdns.net' },
  { provider: 'Squarespace', nameserver: 'squarespace.com' },
  { provider: 'Shopify', nameserver: 'shopify.com' },
  { provider: 'Vercel', nameserver: 'vercel-dns.com' },
  { provider: 'Netlify', nameserver: 'netlify.com' },
  { provider: 'NS1', nameserver: 'nsone.net' },
  { provider: 'AWS Route 53', nameserver: 'awsdns-00.com' },
  { provider: 'AWS Route 53', nameserver: 'awsdns' },
  { provider: 'Azure DNS', nameserver: 'azure-dns.com' },
  { provider: 'Azure DNS', nameserver: 'azure-dns.net' },
  { provider: 'Azure DNS', nameserver: 'azure-dns.org' },
  { provider: 'Azure DNS', nameserver: 'azure-dns.info' },
  { provider: 'Google Cloud DNS', nameserver: 'googledomains.com.' },
  { provider: 'Google Cloud DNS', nameserver: 'google.com' },
  { provider: 'DigitalOcean', nameserver: 'digitalocean.com' },
  { provider: 'Linode / Akamai', nameserver: 'linode.com' },
  { provider: 'Hetzner', nameserver: 'hetzner.com' },
  { provider: 'Hetzner', nameserver: 'hetzner.de' },
  { provider: 'DNSimple', nameserver: 'dnsimple.com' },
  { provider: 'DNS Made Easy', nameserver: 'dnsmadeeasy.com' },
  { provider: 'Hurricane Electric', nameserver: 'he.net' },
  { provider: 'ClouDNS', nameserver: 'cloudns.net' },
  { provider: 'Bunny', nameserver: 'bunny.net' },
  { provider: 'Webflow', nameserver: 'webflow.com' },
  { provider: 'GoDaddy Website Builder', nameserver: 'secureserver.net' },
  { provider: 'WordPress.com', nameserver: 'wordpress.com' },
  { provider: 'WP Engine', nameserver: 'wpengine.com' },
  { provider: 'Kinsta', nameserver: 'kinsta.com' },
  { provider: 'Fastly', nameserver: 'fastly.net' },
  { provider: 'Akamai', nameserver: 'akam.net' },
  { provider: 'Weebly', nameserver: 'weebly.com' },
  { provider: 'Duda', nameserver: 'dudamobile.com' },
  { provider: 'Strikingly', nameserver: 'strikingly.com' },
  { provider: 'Carrd', nameserver: 'carrd.co' },
  { provider: 'Framer', nameserver: 'framer.com' },
  { provider: 'HubSpot', nameserver: 'hubspot.net' },
  { provider: 'Zoho', nameserver: 'zoho.com' },
  { provider: 'Yandex', nameserver: 'yandex.net' },
  { provider: 'Tencent DNSPod Pro', nameserver: 'dnsv1.com' },
  { provider: 'Rackspace', nameserver: 'rackspace.com' },
  { provider: 'DNS.com', nameserver: 'dns.com' },
]);

function normalizeHost(value) {
  return String(value || '').toLowerCase().replace(/\.$/, '');
}

/**
 * Builds a suffix classifier over the four operator tables. Lookup is by
 * exact host first, then by every parent suffix of the host, so
 * `ns3.foo.example.net` matches an `example.net` entry.
 */
function buildClassifier({
  seller = SELLER_PARKING_NAMESERVERS,
  parkingOnly = PARKING_ONLY_NAMESERVERS,
  registrar = REGISTRAR_DEFAULT_NAMESERVERS,
  hosting = HOSTING_NAMESERVERS,
} = {}) {
  const table = new Map();
  const add = (list, klass) => {
    for (const entry of list) {
      const host = normalizeHost(entry?.nameserver);
      if (!host || table.has(host)) continue;
      table.set(host, { klass, provider: entry.provider });
    }
  };
  // Order matters: parking-only entries (shared with the seller universe by
  // zone-ns-universe) must classify as parking, sellers as seller.
  add(parkingOnly, CLASS_PARKING);
  add(seller, CLASS_SELLER);
  add(hosting, CLASS_HOSTING);
  add(registrar, CLASS_REGISTRAR);
  const cache = new Map();
  return function classifyHost(rawHost) {
    const host = normalizeHost(rawHost);
    if (!host) return { klass: CLASS_OTHER, provider: null };
    const cached = cache.get(host);
    if (cached) return cached;
    let found = null;
    let probe = host;
    for (;;) {
      const hit = table.get(probe);
      if (hit) { found = hit; break; }
      const dot = probe.indexOf('.');
      if (dot < 0) break;
      probe = probe.slice(dot + 1);
    }
    const result = found || { klass: CLASS_OTHER, provider: null };
    if (cache.size < 200000) cache.set(host, result);
    return result;
  };
}

const CLASS_PRIORITY = [CLASS_SELLER, CLASS_PARKING, CLASS_HOSTING, CLASS_REGISTRAR, CLASS_OTHER];

/**
 * Classifies a whole nameserver set: seller wins over parking, parking over
 * hosting, hosting over registrar default, registrar over other. The
 * provider is the one behind the winning class.
 */
function classifyNameservers(hosts, classifyHost) {
  if (!hosts || !hosts.length) return { klass: CLASS_NONE, provider: null };
  let best = null;
  for (const host of hosts) {
    const c = classifyHost(host);
    if (!best || CLASS_PRIORITY.indexOf(c.klass) < CLASS_PRIORITY.indexOf(best.klass)) best = c;
  }
  return best;
}


const NS_MARKER = '\tin\tns\t';

/**
 * Parses one zone line of the form `owner\tTTL\tin\tns\thost`. Returns
 * { name, host } (lowercase, trailing dots removed) or null for any other
 * record type, the apex, or a malformed line.
 */
function parseNsLine(line, apex) {
  const firstTab = line.indexOf('\t');
  if (firstTab <= 0) return null;
  const marker = line.indexOf(NS_MARKER, firstTab);
  if (marker < 0) return null;
  let name = line.slice(0, firstTab).toLowerCase();
  if (name.endsWith('.')) name = name.slice(0, -1);
  if (!name || name === apex) return null;
  let host = line.slice(marker + NS_MARKER.length).trim().toLowerCase();
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (!host) return null;
  return { name, host };
}

/**
 * Async generator over one gzip zone file: yields { name, ns } for every
 * delegated name, in file order, with NS hosts sorted. The zone apex and
 * non-NS records are skipped. Names are yielded lowercase without the
 * trailing dot.
 */
async function* delegations(zonePath, { zone } = {}) {
  const apex = zone ? String(zone).toLowerCase() : null;
  const input = fs.createReadStream(zonePath).pipe(zlib.createGunzip());
  let tail = '';
  let current = null;
  let hosts = [];
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
        if (current !== null) { hosts.sort(); yield { name: current, ns: hosts }; }
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
        if (current !== null) { hosts.sort(); yield { name: current, ns: hosts }; }
        current = parsed.name; hosts = [];
      }
      hosts.push(parsed.host);
    }
  }
  if (current !== null) { hosts.sort(); yield { name: current, ns: hosts }; }
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
async function diffZoneDelegations({ prevPath, todayPath, zone, classifyHost = buildClassifier(), onRow = () => {} }) {
  const left = delegations(prevPath, { zone })[Symbol.asyncIterator]();
  const right = delegations(todayPath, { zone })[Symbol.asyncIterator]();
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
 * (e.g. seller>hosting for off-market sale leads).
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
  buildClassifier, classifyNameservers, parseNsLine, delegations, diffZoneDelegations,
  writeZoneMovementTape, readZoneMovementTape, transitionKey,
};
