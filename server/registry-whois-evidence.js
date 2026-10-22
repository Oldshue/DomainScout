'use strict';

const crypto = require('node:crypto');
const net = require('node:net');

const NEGATIVE_RE = /domain not found|no match for|not found|no data found|no entries found|no objects found|not currently registered|object does not exist|status:\s*free|available for registration/i;
// Some registries operate an authoritative WHOIS service but omit the referral
// from IANA. Keep these root-scoped (never domain-scoped) and still report the
// exact server used in every receipt.
const ROOT_WHOIS_OVERRIDES = Object.freeze({
  uk: 'whois.nic.uk',
});

function queryWhois(query, server, options = {}) {
  const timeoutMs = Math.max(500, Math.min(30_000, Number(options.timeoutMs) || 8_000));
  const maxBytes = Math.max(1024, Math.min(2 * 1024 * 1024, Number(options.maxBytes) || 512 * 1024));
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    const chunks = [];
    let bytes = 0;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      error ? reject(error) : resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.connect(43, server, () => socket.write(`${query}\r\n`));
    socket.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > maxBytes) return finish(new Error('WHOIS response exceeded byte limit'));
      chunks.push(chunk);
    });
    socket.on('end', () => finish(null, Buffer.concat(chunks)));
    socket.on('timeout', () => finish(new Error('WHOIS timeout')));
    socket.on('error', error => finish(error));
  });
}

function rootLabel(domain) {
  const labels = String(domain || '').trim().toLowerCase().replace(/\.$/, '').split('.');
  return labels.length >= 2 && labels.every(Boolean) ? labels.at(-1) : null;
}

function parseIanaWhoisServer(text) {
  const match = String(text || '').match(/^whois:\s*([^\s]+)\s*$/im);
  return match ? match[1].toLowerCase() : null;
}

function classifyWhois(text, domain) {
  const body = String(text || '');
  if (!body.trim()) return 'unknown';
  const escaped = String(domain || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const exactField = new RegExp(`(?:^|\\n)\\s*(?:domain(?: name)?|domainname|\\[domain name\\])\\s*:?\\s*${escaped}\\s*(?:\\r?$|\\n)`, 'im');
  if (exactField.test(body)) return 'registered';
  if (NEGATIVE_RE.test(body)) return 'available';
  return 'unknown';
}

function receipt(domain, server, status, buffer, checkedAt, error = null) {
  const bytes = buffer?.length || 0;
  return {
    domain,
    status,
    source: server ? `registry-whois:${server}` : 'registry-whois-unavailable',
    server: server || null,
    checkedAt,
    bytes,
    sha256: bytes ? crypto.createHash('sha256').update(buffer).digest('hex') : null,
    ...(error ? { error } : {}),
  };
}

async function checkRegistryWhoisBatch(domains, options = {}) {
  const query = options.query || queryWhois;
  const checkedAt = options.checkedAt || new Date().toISOString();
  const concurrency = Math.max(1, Math.min(8, Number(options.concurrency) || 3));
  const unique = [...new Set((domains || []).map(value => String(value || '').trim().toLowerCase()).filter(Boolean))];
  const serverByRoot = new Map();
  const roots = [...new Set(unique.map(rootLabel).filter(Boolean))];
  for (const root of roots) {
    try {
      const iana = await query(root, 'whois.iana.org', options);
      serverByRoot.set(root, parseIanaWhoisServer(iana) || ROOT_WHOIS_OVERRIDES[root] || null);
    } catch (_) {
      serverByRoot.set(root, ROOT_WHOIS_OVERRIDES[root] || null);
    }
  }
  const out = new Array(unique.length);
  let cursor = 0;
  const pool = Array.from({ length: Math.min(concurrency, unique.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= unique.length) return;
      const domain = unique[index];
      const server = serverByRoot.get(rootLabel(domain)) || null;
      if (!server) {
        out[index] = receipt(domain, null, 'unknown', null, checkedAt, 'registry WHOIS unavailable or retired');
        continue;
      }
      try {
        const body = await query(domain, server, options);
        const status = classifyWhois(body, domain);
        out[index] = receipt(domain, server, status, body, checkedAt, status === 'unknown' ? 'WHOIS response inconclusive' : null);
      } catch (error) {
        out[index] = receipt(domain, server, 'unknown', null, checkedAt, error?.message || 'WHOIS query failed');
      }
    }
  });
  await Promise.all(pool);
  return out;
}

module.exports = {
  checkRegistryWhoisBatch,
  classifyWhois,
  parseIanaWhoisServer,
  queryWhois,
  ROOT_WHOIS_OVERRIDES,
  rootLabel,
};
