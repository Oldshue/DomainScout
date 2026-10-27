'use strict';

/**
 * Certificate Transparency log access for the near-live launch detector.
 *
 * - Chrome's v3 log list (https://www.gstatic.com/ct/log_list/v3/log_list.json)
 *   -> a small set of currently usable logs, preferring configured operators.
 * - RFC 6962 logs: GET <url>ct/v1/get-sth, GET <url>ct/v1/get-entries.
 * - C2SP static-ct-api (tiled) logs: GET <monitoring>checkpoint and
 *   GET <monitoring>tile/data/<N>[.p/<W>] (TileLeaf records).
 * - Certificates and precertificates are parsed with node:crypto
 *   X509Certificate; a minimal DER walker is the fallback for anything
 *   X509Certificate rejects (e.g. a bare TBSCertificate).
 * - DNS SANs are reduced to registrable domains with the repo's zone helper
 *   (observed-zones registrableName).
 *
 * Pure parsing plus injectable fetch: nothing here opens a connection unless a
 * client method is called.
 */

const zlib = require('node:zlib');
const { X509Certificate } = require('node:crypto');
const { domainToASCII } = require('node:url');

const LOG_LIST_URL = 'https://www.gstatic.com/ct/log_list/v3/log_list.json';
const DEFAULT_OPERATORS = ["Let's Encrypt", 'Google', 'Cloudflare'];
const TILE_WIDTH = 256;
const DEFAULT_USER_AGENT = 'DomainScout-CT/1.0 (+https://github.com/Oldshue/DomainScout; near-live launch detector, polite CT monitor)';

// ── TLS-structure decoding ─────────────────────────────────────────────────

function need(buf, off, n) {
  if (off + n > buf.length) throw new Error(`truncated CT structure at ${off} (+${n} > ${buf.length})`);
}

function opaque24(buf, off) {
  need(buf, off, 3);
  const len = (buf[off] << 16) | (buf[off + 1] << 8) | buf[off + 2];
  need(buf, off + 3, len);
  return [buf.subarray(off + 3, off + 3 + len), off + 3 + len];
}

function opaque16(buf, off) {
  need(buf, off, 2);
  const len = buf.readUInt16BE(off);
  need(buf, off + 2, len);
  return [buf.subarray(off + 2, off + 2 + len), off + 2 + len];
}

/** TimestampedEntry (RFC 6962 §3.4, identical in static-ct-api TileLeaf). */
function parseTimestampedEntry(buf, start) {
  need(buf, start, 10);
  const timestamp = Number(buf.readBigUInt64BE(start));
  const entryType = buf.readUInt16BE(start + 8);
  let off = start + 10;
  let cert = null;
  let tbs = null;
  if (entryType === 0) [cert, off] = opaque24(buf, off);
  else if (entryType === 1) { need(buf, off, 32); off += 32; [tbs, off] = opaque24(buf, off); }
  else throw new Error(`unknown CT entry_type ${entryType}`);
  [, off] = opaque16(buf, off); // CtExtensions
  return { timestamp, entryType, cert, tbs, off };
}

/** RFC 6962 get-entries item: { leaf_input, extra_data } (base64). */
function parseRfc6962Entry(item) {
  const leaf = Buffer.from(String(item?.leaf_input || ''), 'base64');
  need(leaf, 0, 2);
  if (leaf[0] !== 0 || leaf[1] !== 0) throw new Error(`unsupported MerkleTreeLeaf version ${leaf[0]} type ${leaf[1]}`);
  const entry = parseTimestampedEntry(leaf, 2);
  let precert = null;
  if (entry.entryType === 1 && item?.extra_data) {
    // PrecertChainEntry { ASN.1Cert pre_certificate; ASN.1Cert chain<0..2^24-1>; }
    try { [precert] = opaque24(Buffer.from(String(item.extra_data), 'base64'), 0); } catch { precert = null; }
  }
  return { timestamp: entry.timestamp, entryType: entry.entryType, cert: entry.cert, tbs: entry.tbs, precert };
}

/** A static-ct-api data tile: concatenated TileLeaf records. */
function parseTile(buf) {
  let data = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (data.length >= 2 && data[0] === 0x1f && data[1] === 0x8b) data = zlib.gunzipSync(data);
  const out = [];
  let off = 0;
  while (off < data.length) {
    const entry = parseTimestampedEntry(data, off);
    off = entry.off;
    let precert = null;
    if (entry.entryType === 1) [precert, off] = opaque24(data, off);
    [, off] = opaque16(data, off); // certificate_chain fingerprints
    out.push({ timestamp: entry.timestamp, entryType: entry.entryType, cert: entry.cert, tbs: entry.tbs, precert });
  }
  return out;
}

// ── SAN extraction ─────────────────────────────────────────────────────────

function derLen(buf, off) {
  need(buf, off, 1);
  const first = buf[off];
  if (first < 0x80) return { len: first, off: off + 1 };
  const n = first & 0x7f;
  if (n < 1 || n > 4) throw new Error('bad DER length');
  need(buf, off + 1, n);
  let len = 0;
  for (let i = 0; i < n; i += 1) len = len * 256 + buf[off + 1 + i];
  return { len, off: off + 1 + n };
}

const SAN_OID = Buffer.from([0x06, 0x03, 0x55, 0x1d, 0x11]);

/** dNSName entries of the subjectAltName extension found anywhere in a DER blob (cert or TBS). */
function derDnsNames(der) {
  if (!der || !der.length) return [];
  let at = der.indexOf(SAN_OID);
  while (at !== -1) {
    try {
      let off = at + SAN_OID.length;
      if (der[off] === 0x01) { const crit = derLen(der, off + 1); off = crit.off + crit.len; }
      if (der[off] !== 0x04) throw new Error('not an extnValue');
      const oct = derLen(der, off + 1);
      let p = oct.off;
      if (der[p] !== 0x30) throw new Error('not GeneralNames');
      const seq = derLen(der, p + 1);
      p = seq.off;
      const end = Math.min(der.length, seq.off + seq.len);
      const names = [];
      while (p < end) {
        const tag = der[p];
        const l = derLen(der, p + 1);
        if (tag === 0x82) names.push(der.subarray(l.off, l.off + l.len).toString('latin1'));
        p = l.off + l.len;
      }
      return names;
    } catch { at = der.indexOf(SAN_OID, at + 1); }
  }
  return [];
}

function sanString(value) {
  const out = [];
  for (const part of String(value || '').split(/,\s*/)) if (part.startsWith('DNS:')) out.push(part.slice(4).replace(/^"|"$/g, ''));
  return out;
}

/** DNS SAN host names of one parsed entry (certificate, precertificate, or TBS fallback). */
function entryDnsNames(entry) {
  const der = entry.entryType === 0 ? entry.cert : (entry.precert || null);
  if (der) {
    try { return sanString(new X509Certificate(der).subjectAltName); }
    catch { /* fall through to DER walk */ }
    const names = derDnsNames(der);
    if (names.length) return names;
  }
  return entry.tbs ? derDnsNames(entry.tbs) : [];
}

// Second-level labels under two-letter ccTLDs that act as public suffixes (co.uk, com.au, ...).
const CC_SECOND_LEVEL = new Set(['co', 'com', 'net', 'org', 'gov', 'edu', 'ac', 'or', 'ne', 'go', 'gob', 'mil', 'nom', 'ltd', 'plc', 'sch']);

/**
 * Host name -> { domain, zone } at the registrable level, or null. Wildcards
 * and www/deeper labels collapse to the registrable name; IP literals and
 * malformed names are dropped. The label check is the repo's zone helper.
 */
function registrableDomain(raw) {
  const { registrableName } = require('./observed-zones');
  let host = String(raw || '').trim().toLowerCase().replace(/^\*\./, '').replace(/\.+$/, '');
  if (!host || /[*\s:/@]/.test(host) || /^[\d.]+$/.test(host)) return null;
  if (/[^\x00-\x7f]/.test(host)) { host = domainToASCII(host); if (!host) return null; }
  const labels = host.split('.');
  if (labels.length < 2) return null;
  const tld = labels[labels.length - 1];
  if (!/^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/.test(tld)) return null;
  // A bare second-level public suffix (co.uk, com.au) is not registrable.
  if (labels.length === 2 && tld.length === 2 && CC_SECOND_LEVEL.has(labels[0])) return null;
  let zone = tld;
  if (tld.length === 2 && labels.length >= 3 && CC_SECOND_LEVEL.has(labels[labels.length - 2])) zone = `${labels[labels.length - 2]}.${tld}`;
  if (labels.length < zone.split('.').length + 1) return null;
  const domain = registrableName(host, zone);
  return domain ? { domain, zone } : null;
}

/** Unique registrable domains named by one entry. */
function entryDomains(entry) {
  const seen = new Map();
  for (const name of entryDnsNames(entry)) {
    const reg = registrableDomain(name);
    if (reg && !seen.has(reg.domain)) seen.set(reg.domain, reg);
  }
  return [...seen.values()];
}

// ── Log list ───────────────────────────────────────────────────────────────

const withSlash = url => (String(url).endsWith('/') ? String(url) : `${url}/`);

function inInterval(log, nowMs) {
  const t = log.temporal_interval;
  if (!t) return true;
  const start = Date.parse(t.start_inclusive || '');
  const end = Date.parse(t.end_exclusive || '');
  return (!Number.isFinite(start) || start <= nowMs) && (!Number.isFinite(end) || nowMs < end);
}

/**
 * Usable logs from a v3 log list: state.usable, temporal interval covering
 * now, operators in preference order, round-robin across operators up to max.
 * `include` (from DOMAINSCOUT_CT_LOGS) is either explicit `rfc6962:<url>` /
 * `static:<url>` / `<url>` entries or description substrings.
 */
function selectLogs(list, { operators = DEFAULT_OPERATORS, max = 6, now = Date.now(), include = [] } = {}) {
  const explicit = [];
  const filters = [];
  for (const raw of include) {
    const value = String(raw || '').trim();
    if (!value) continue;
    const m = value.match(/^(rfc6962|static):(https?:\/\/.+)$/i);
    if (m) explicit.push({ id: m[2], name: m[2], operator: 'configured', api: m[1].toLowerCase(), url: withSlash(m[2]) });
    else if (/^https?:\/\//i.test(value)) explicit.push({ id: value, name: value, operator: 'configured', api: 'rfc6962', url: withSlash(value) });
    else filters.push(value.toLowerCase());
  }
  if (explicit.length && !filters.length) return explicit.slice(0, Math.max(1, max));
  const prefs = operators.map(op => String(op).toLowerCase());
  const groups = new Map();
  for (const operator of list?.operators || []) {
    const opName = String(operator?.name || '');
    const rank = prefs.indexOf(opName.toLowerCase());
    if (!filters.length && rank === -1) continue;
    const add = (log, api) => {
      if (!log?.state?.usable || !inInterval(log, now)) return;
      const url = api === 'static' ? log.monitoring_url : log.url;
      if (!url) return;
      const name = String(log.description || url);
      if (filters.length && !filters.some(f => name.toLowerCase().includes(f))) return;
      const key = rank === -1 ? prefs.length : rank;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ id: String(log.log_id || url), name, operator: opName, api, url: withSlash(url), mmd: log.mmd || null });
    };
    for (const log of operator?.logs || []) add(log, 'rfc6962');
    for (const log of operator?.tiled_logs || []) add(log, 'static');
  }
  const ordered = [...groups.keys()].sort((a, b) => a - b).map(key => groups.get(key).sort((x, y) => x.name.localeCompare(y.name)));
  const out = [...explicit];
  for (let i = 0; out.length < max && ordered.some(group => i < group.length); i += 1) {
    for (const group of ordered) if (i < group.length && out.length < max) out.push(group[i]);
  }
  return out;
}

// ── HTTP clients ───────────────────────────────────────────────────────────

class CtHttpError extends Error {
  constructor(message, { status = null, retryAfter = null } = {}) {
    super(message);
    this.name = 'CtHttpError';
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

async function httpGet(url, { fetchImpl = globalThis.fetch, timeoutMs = 20000, userAgent = DEFAULT_USER_AGENT, as = 'json' } = {}) {
  let res;
  try {
    res = await fetchImpl(url, { headers: { 'user-agent': userAgent, accept: as === 'json' ? 'application/json' : '*/*' }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new CtHttpError(`network: ${error?.message || error}`);
  }
  if (!res.ok) {
    let snippet = '';
    try { snippet = (await res.text()).replace(/\s+/g, ' ').trim().slice(0, 160); } catch { /* ignore */ }
    throw new CtHttpError(`HTTP ${res.status}${snippet ? ` "${snippet}"` : ''} for ${url}`, { status: res.status, retryAfter: res.headers?.get?.('retry-after') || null });
  }
  if (as === 'json') return res.json();
  if (as === 'text') return res.text();
  return Buffer.from(await res.arrayBuffer());
}

function createRfc6962Client(log, opts = {}) {
  const base = withSlash(log.url);
  return {
    api: 'rfc6962',
    async head() {
      const sth = await httpGet(`${base}ct/v1/get-sth`, opts);
      const treeSize = Number(sth?.tree_size);
      if (!Number.isSafeInteger(treeSize) || treeSize < 0) throw new Error(`invalid STH tree_size from ${base}`);
      return { treeSize, timestamp: Number(sth.timestamp) || null };
    },
    /** Entries [start, min(start+batch, treeSize)); logs may return fewer than asked. */
    async read(start, treeSize, batch) {
      const end = Math.min(treeSize, start + batch) - 1;
      if (end < start) return [];
      const body = await httpGet(`${base}ct/v1/get-entries?start=${start}&end=${end}`, opts);
      const items = Array.isArray(body?.entries) ? body.entries.slice(0, end - start + 1) : [];
      if (!items.length) throw new Error(`get-entries returned no entries for ${start}-${end}`);
      return items.map((item, i) => {
        try { return { index: start + i, ...parseRfc6962Entry(item) }; }
        catch (error) { return { index: start + i, error: error.message }; }
      });
    },
  };
}

/** static-ct-api tile path: 1234067 -> x001/x234/067. */
function tilePath(index) {
  let digits = String(Math.trunc(index));
  while (digits.length % 3) digits = `0${digits}`;
  const groups = digits.match(/\d{3}/g);
  return groups.map((g, i) => (i < groups.length - 1 ? `x${g}` : g)).join('/');
}

function parseCheckpoint(text) {
  const lines = String(text || '').split('\n');
  const treeSize = Number(lines[1]);
  if (!lines[0] || !/^\d+$/.test(lines[1] || '') || !Number.isSafeInteger(treeSize)) throw new Error('invalid checkpoint');
  return { origin: lines[0], treeSize, rootHash: lines[2] || null };
}

function createStaticClient(log, opts = {}) {
  const base = withSlash(log.url);
  return {
    api: 'static',
    async head() {
      const checkpoint = parseCheckpoint(await httpGet(`${base}checkpoint`, { ...opts, as: 'text' }));
      return { treeSize: checkpoint.treeSize, timestamp: null, origin: checkpoint.origin };
    },
    /** Entries from `start` to the end of its tile (at most one tile per call). */
    async read(start, treeSize) {
      if (start >= treeSize) return [];
      const n = Math.floor(start / TILE_WIDTH);
      const width = Math.min(TILE_WIDTH, treeSize - n * TILE_WIDTH);
      const full = `${base}tile/data/${tilePath(n)}`;
      let buf;
      if (width === TILE_WIDTH) buf = await httpGet(full, { ...opts, as: 'buffer' });
      else {
        try { buf = await httpGet(`${full}.p/${width}`, { ...opts, as: 'buffer' }); }
        catch (error) {
          // A partial tile may already have been replaced by the full tile.
          if (error.status !== 404) throw error;
          buf = await httpGet(full, { ...opts, as: 'buffer' });
        }
      }
      const leaves = parseTile(buf);
      const out = [];
      for (let i = start - n * TILE_WIDTH; i < Math.min(leaves.length, width); i += 1) out.push({ index: n * TILE_WIDTH + i, ...leaves[i] });
      if (!out.length) throw new Error(`tile ${n} had no entries at ${start}`);
      return out;
    },
  };
}

function createLogClient(log, opts = {}) {
  return log.api === 'static' ? createStaticClient(log, opts) : createRfc6962Client(log, opts);
}

module.exports = {
  LOG_LIST_URL, DEFAULT_OPERATORS, TILE_WIDTH, DEFAULT_USER_AGENT, CtHttpError,
  parseTimestampedEntry, parseRfc6962Entry, parseTile, derDnsNames, sanString, entryDnsNames,
  registrableDomain, entryDomains, selectLogs, httpGet, tilePath, parseCheckpoint,
  createRfc6962Client, createStaticClient, createLogClient,
};
