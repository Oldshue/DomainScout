'use strict';

// Regenerates tests/fixtures/ct/* from DER certificates (recorded with openssl):
//   node scripts/make-ct-fixtures.js <leaf.der> <precert.der>
// Encodes them exactly as CT logs serve them: an RFC 6962 get-entries body
// (x509 + precert entries) and a C2SP static-ct-api data tile (TileLeaf).

const fs = require('fs');
const path = require('path');

const out = path.join(__dirname, '..', 'tests', 'fixtures', 'ct');
const [leafPath, prePath] = process.argv.slice(2);
const leaf = fs.readFileSync(leafPath);
const pre = fs.readFileSync(prePath);

function derLen(buf, off) {
  const first = buf[off];
  if (first < 0x80) return { len: first, off: off + 1 };
  const n = first & 0x7f;
  let len = 0;
  for (let i = 0; i < n; i += 1) len = len * 256 + buf[off + 1 + i];
  return { len, off: off + 1 + n };
}
/** First element (TBSCertificate) of a Certificate SEQUENCE. */
function tbsOf(der) {
  const outer = derLen(der, 1);
  const start = outer.off;
  const inner = derLen(der, start + 1);
  return der.subarray(start, inner.off + inner.len);
}
const u24 = b => { const h = Buffer.alloc(3); h.writeUIntBE(b.length, 0, 3); return Buffer.concat([h, b]); };
const u16 = b => { const h = Buffer.alloc(2); h.writeUInt16BE(b.length); return Buffer.concat([h, b]); };
const u64 = n => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; };
const u16n = n => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
const issuerKeyHash = Buffer.alloc(32, 7);
const TS = 1793095200000; // 2026-10-27T10:00:00Z

function timestamped(type, ts) {
  const signed = type === 0 ? u24(leaf) : Buffer.concat([issuerKeyHash, u24(tbsOf(pre))]);
  return Buffer.concat([u64(ts), u16n(type), signed, u16(Buffer.alloc(0))]);
}
function leafInput(type, ts) { return Buffer.concat([Buffer.from([0, 0]), timestamped(type, ts)]); }

fs.mkdirSync(out, { recursive: true });
const entries = [
  { leaf_input: leafInput(0, TS).toString('base64'), extra_data: u24(Buffer.alloc(0)).toString('base64') },
  { leaf_input: leafInput(1, TS + 1000).toString('base64'), extra_data: Buffer.concat([u24(pre), u24(Buffer.alloc(0))]).toString('base64') },
];
fs.writeFileSync(path.join(out, 'rfc6962-get-entries.json'), JSON.stringify({ entries }, null, 1) + '\n');
fs.writeFileSync(path.join(out, 'rfc6962-get-sth.json'), JSON.stringify({ tree_size: 1002, timestamp: TS, sha256_root_hash: Buffer.alloc(32).toString('base64'), tree_head_signature: 'BAMARzBF' }) + '\n');

// Static tile: 3 leaves -> x509, precert, x509 (partial tile of width 3).
const fingerprints = u16(Buffer.alloc(32, 9));
const tile = Buffer.concat([
  timestamped(0, TS), fingerprints,
  timestamped(1, TS + 1000), u24(pre), fingerprints,
  timestamped(0, TS + 2000), fingerprints,
]);
fs.writeFileSync(path.join(out, 'static-tile-data.bin'), tile);
fs.writeFileSync(path.join(out, 'static-checkpoint.txt'), 'example.ct.test/2026h2\n259\nAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\n\n— example.ct.test/2026h2 AAAAAA==\n');
fs.writeFileSync(path.join(out, 'leaf.der'), leaf);
fs.writeFileSync(path.join(out, 'precert.der'), pre);

const logList = {
  version: 'fixture', operators: [
    { name: 'Google', logs: [
      { description: "Google 'Argon2026h2' log", log_id: 'argon26h2', url: 'https://ct.googleapis.com/logs/us1/argon2026h2/', state: { usable: { timestamp: '2025-01-01T00:00:00Z' } }, temporal_interval: { start_inclusive: '2026-07-01T00:00:00Z', end_exclusive: '2027-01-01T00:00:00Z' } },
      { description: "Google 'Argon2027h1' log", log_id: 'argon27h1', url: 'https://ct.googleapis.com/logs/us1/argon2027h1/', state: { usable: { timestamp: '2025-01-01T00:00:00Z' } }, temporal_interval: { start_inclusive: '2027-01-01T00:00:00Z', end_exclusive: '2027-07-01T00:00:00Z' } },
      { description: "Google 'Old' log", log_id: 'old', url: 'https://ct.googleapis.com/logs/old/', state: { retired: { timestamp: '2024-01-01T00:00:00Z' } } },
    ] },
    { name: "Let's Encrypt", logs: [], tiled_logs: [
      { description: "Let's Encrypt 'Willow2026h2d'", log_id: 'willow', submission_url: 'https://willow.ct.letsencrypt.org/2026h2d/', monitoring_url: 'https://mon.willow.ct.letsencrypt.org/2026h2d/', state: { usable: { timestamp: '2025-01-01T00:00:00Z' } }, temporal_interval: { start_inclusive: '2026-07-01T00:00:00Z', end_exclusive: '2027-01-01T00:00:00Z' } },
    ] },
    { name: 'Cloudflare', logs: [
      { description: "Cloudflare 'Nimbus2026'", log_id: 'nimbus26', url: 'https://ct.cloudflare.com/logs/nimbus2026/', state: { usable: { timestamp: '2025-01-01T00:00:00Z' } }, temporal_interval: { start_inclusive: '2026-01-01T00:00:00Z', end_exclusive: '2027-01-01T00:00:00Z' } },
    ] },
    { name: 'Other Operator', logs: [
      { description: 'Other log', log_id: 'other', url: 'https://other.example/ct/', state: { usable: { timestamp: '2025-01-01T00:00:00Z' } } },
    ] },
  ],
};
fs.writeFileSync(path.join(out, 'log_list.json'), JSON.stringify(logList, null, 1) + '\n');
console.log('fixtures written to', out);
