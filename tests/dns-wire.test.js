'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  TYPE, RCODE, classifyAuthoritativeNsResponse, decodeMessage, encodeQuery, encodeResponse, encodeName,
} = require('../server/dns-wire');

const QUERY = { id: 0x1234, name: 'widget.io' };

function classify(buf, query = QUERY) {
  return classifyAuthoritativeNsResponse(decodeMessage(buf), query);
}

test('encodes an RD=0 NS query with one question and an EDNS OPT record', () => {
  const buf = encodeQuery({ id: 0x1234, name: 'Widget.IO.' });
  assert.equal(buf.readUInt16BE(0), 0x1234);
  assert.equal(buf.readUInt16BE(2) & 0x0100, 0, 'RD must be clear for authoritative-direct queries');
  assert.equal(buf.readUInt16BE(4), 1);
  assert.equal(buf.readUInt16BE(10), 1, 'one additional (OPT) record');
  const decoded = decodeMessage(Buffer.concat([buf.subarray(0, 2), Buffer.from([0x80, 0x00]), buf.subarray(4)]));
  assert.deepEqual(decoded.questions, [{ name: 'widget.io', type: TYPE.NS, class: 1 }]);
  assert.equal(decoded.additional[0].type, TYPE.OPT);
  assert.equal(decoded.additional[0].udpPayload, 1232);
});

test('decodes compressed names (pointers) in answers and authority', () => {
  const buf = encodeResponse({
    id: 1, name: 'widget.io', aa: false,
    authority: [{ name: 'widget.io', type: TYPE.NS, data: 'ns1.widget.io' }],
    additional: [{ name: 'ns1.widget.io', type: TYPE.A, data: '192.0.2.1' }],
  });
  // Rewrite the authority owner name as a compression pointer to the question (offset 12).
  const qEnd = 12 + encodeName('widget.io').length + 4;
  const pointer = Buffer.from([0xc0, 12]);
  const patched = Buffer.concat([buf.subarray(0, qEnd), pointer, buf.subarray(qEnd + encodeName('widget.io').length)]);
  const msg = decodeMessage(patched);
  assert.equal(msg.authority[0].name, 'widget.io');
  assert.equal(msg.authority[0].data, 'ns1.widget.io');
  assert.equal(msg.additional[0].data, '192.0.2.1');
});

test('authoritative NXDOMAIN → not_taken', () => {
  const buf = encodeResponse({ id: 0x1234, name: 'widget.io', aa: true, rcode: RCODE.NXDOMAIN,
    authority: [{ name: 'io', type: TYPE.SOA }] });
  assert.deepEqual(classify(buf), { status: 'not_taken', reason: 'nxdomain' });
});

test('non-authoritative NXDOMAIN is never accepted as negative evidence', () => {
  const buf = encodeResponse({ id: 0x1234, name: 'widget.io', aa: false, rcode: RCODE.NXDOMAIN });
  assert.equal(classify(buf).status, 'unknown');
  assert.equal(classify(buf).reason, 'nxdomain-not-authoritative');
});

test('referral (NOERROR, NS for the label in AUTHORITY, AA=0) → taken', () => {
  const buf = encodeResponse({ id: 0x1234, name: 'widget.io', aa: false,
    authority: [
      { name: 'widget.io', type: TYPE.NS, data: 'ns1.example.net' },
      { name: 'widget.io', type: TYPE.NS, data: 'ns2.example.net' },
    ] });
  const out = classify(buf);
  assert.equal(out.status, 'taken');
  assert.equal(out.reason, 'exact-referral');
  assert.deepEqual(out.nameservers, ['ns1.example.net', 'ns2.example.net']);
});

test('authoritative NS answer for the label → taken', () => {
  const buf = encodeResponse({ id: 0x1234, name: 'widget.io', aa: true,
    answers: [{ name: 'widget.io', type: TYPE.NS, data: 'ns1.example.net' }] });
  assert.equal(classify(buf).status, 'taken');
  assert.equal(classify(buf).reason, 'exact-ns-answer');
});

test('NS records owned by an ancestor or sibling never count for the label', () => {
  const buf = encodeResponse({ id: 0x1234, name: 'widget.io', aa: true,
    authority: [{ name: 'io', type: TYPE.NS, data: 'a0.nic.io' }, { name: 'widgets.io', type: TYPE.NS, data: 'ns.x' }] });
  assert.equal(classify(buf).status, 'unknown');
  assert.equal(classify(buf).reason, 'noerror-without-ns');
});

test('SERVFAIL and REFUSED → unknown (caller must fall back)', () => {
  for (const rcode of [RCODE.SERVFAIL, RCODE.REFUSED, RCODE.NOTIMP]) {
    const buf = encodeResponse({ id: 0x1234, name: 'widget.io', rcode });
    assert.equal(classify(buf).status, 'unknown', `rcode ${rcode}`);
  }
  assert.equal(classify(encodeResponse({ id: 0x1234, name: 'widget.io', rcode: RCODE.SERVFAIL })).reason, 'servfail');
});

test('truncated response → unknown even when a referral is visible', () => {
  const buf = encodeResponse({ id: 0x1234, name: 'widget.io', tc: true,
    authority: [{ name: 'widget.io', type: TYPE.NS, data: 'ns1.example.net' }] });
  assert.deepEqual(classify(buf), { status: 'unknown', reason: 'truncated' });
});

test('truncated datagram cut mid-record still decodes and classifies as unknown', () => {
  const full = encodeResponse({ id: 0x1234, name: 'widget.io', tc: true,
    authority: [{ name: 'widget.io', type: TYPE.NS, data: 'ns1.example.net' }] });
  const cut = full.subarray(0, full.length - 5);
  const msg = decodeMessage(cut);
  assert.equal(msg.truncatedSections, true);
  assert.equal(classifyAuthoritativeNsResponse(msg, QUERY).status, 'unknown');
});

test('ID mismatch → mismatch (ignored, not evidence)', () => {
  const buf = encodeResponse({ id: 0x9999, name: 'widget.io', aa: true, rcode: RCODE.NXDOMAIN });
  assert.deepEqual(classify(buf), { status: 'mismatch', reason: 'id-mismatch' });
});

test('question mismatch → mismatch (ignored, not evidence)', () => {
  const buf = encodeResponse({ id: 0x1234, name: 'other.io', aa: true, rcode: RCODE.NXDOMAIN });
  assert.deepEqual(classify(buf), { status: 'mismatch', reason: 'question-mismatch' });
  const wrongType = encodeResponse({ id: 0x1234, name: 'widget.io', type: TYPE.A, aa: true, rcode: RCODE.NXDOMAIN });
  assert.equal(classify(wrongType).status, 'mismatch');
});

test('NODATA (NOERROR + SOA, no NS) and wildcard-style answers → unknown', () => {
  const nodata = encodeResponse({ id: 0x1234, name: 'widget.io', aa: true, authority: [{ name: 'io', type: TYPE.SOA }] });
  assert.deepEqual(classify(nodata), { status: 'unknown', reason: 'nodata' });
  const wildcard = encodeResponse({ id: 0x1234, name: 'widget.io', aa: true,
    answers: [{ name: 'widget.io', type: TYPE.A, data: '203.0.113.9' }] });
  assert.equal(classify(wildcard).status, 'unknown');
  const cname = encodeResponse({ id: 0x1234, name: 'widget.io', aa: true,
    answers: [{ name: 'widget.io', type: TYPE.CNAME, data: 'park.example' }] });
  assert.deepEqual(classify(cname), { status: 'unknown', reason: 'cname-at-name' });
});

test('malformed messages throw instead of classifying', () => {
  assert.throws(() => decodeMessage(Buffer.alloc(5)), /too short/);
  const loop = Buffer.concat([Buffer.from([0, 0, 0x80, 0, 0, 1, 0, 0, 0, 0, 0, 0]), Buffer.from([0xc0, 12, 0, 2, 0, 1])]);
  assert.throws(() => decodeMessage(loop), /pointer|loop/);
});
