'use strict';

// Minimal DNS wire codec (RFC 1035 + EDNS0 OPT) for authoritative-direct NS probes.
//
// Deliberately NOT dns.Resolver / c-ares: a TLD server answering a query for
// `label.tld` returns a REFERRAL (NOERROR, AA=0, NS records for the label in the
// AUTHORITY section, no answer). c-ares collapses that into ENODATA, which is
// indistinguishable from "name exists but has no NS". Reading the raw message
// keeps the referral visible, which is the positive registration evidence.
//
// Classification contract (must match what stored receipts mean):
//   not_taken → authoritative NXDOMAIN (AA=1, RCODE=3), the same negative the
//               recursive/DoH path accepts.
//   taken     → NOERROR with an NS record owned by exactly the queried name in the
//               answer or authority section (referral or authoritative answer).
//   unknown   → everything else: SERVFAIL, REFUSED, NOTIMP, truncation, non-AA
//               NXDOMAIN, NODATA, wildcard/synthesized answers without an exact NS,
//               CNAME at the name. Callers MUST fall back; never guess.
//   mismatch  → the message is not the reply to this query (ID or question
//               differs); ignore it and keep waiting.

const TYPE = { A: 1, NS: 2, CNAME: 5, SOA: 6, AAAA: 28, OPT: 41 };
const CLASS_IN = 1;
const RCODE = { NOERROR: 0, FORMERR: 1, SERVFAIL: 2, NXDOMAIN: 3, NOTIMP: 4, REFUSED: 5 };
const RCODE_NAMES = ['noerror', 'formerr', 'servfail', 'nxdomain', 'notimp', 'refused'];
const DEFAULT_UDP_PAYLOAD = 1232;

function normalizeName(name) {
  return String(name || '').trim().toLowerCase().replace(/\.+$/, '');
}

function encodeName(name) {
  const clean = normalizeName(name);
  const parts = clean ? clean.split('.') : [];
  const chunks = [];
  for (const part of parts) {
    const bytes = Buffer.from(part, 'ascii');
    if (bytes.length === 0 || bytes.length > 63) throw new Error(`invalid dns label: ${part}`);
    chunks.push(Buffer.from([bytes.length]), bytes);
  }
  chunks.push(Buffer.from([0]));
  const out = Buffer.concat(chunks);
  if (out.length > 255) throw new Error('dns name too long');
  return out;
}

// Build a single-question query. RD is left CLEAR: authoritative servers must not
// recurse, and a recursive answer from a misconfigured server would be evidence
// of the wrong kind. EDNS0 advertises a modest payload so referrals with glue fit.
function encodeQuery({ id, name, type = TYPE.NS, klass = CLASS_IN, edns = true, udpPayload = DEFAULT_UDP_PAYLOAD }) {
  if (!Number.isInteger(id) || id < 0 || id > 0xffff) throw new Error('query id must be a 16-bit integer');
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(0x0000, 2); // QR=0 OPCODE=0 AA=0 TC=0 RD=0 RA=0 Z=0 RCODE=0
  header.writeUInt16BE(1, 4); // QDCOUNT
  header.writeUInt16BE(0, 6); // ANCOUNT
  header.writeUInt16BE(0, 8); // NSCOUNT
  header.writeUInt16BE(edns ? 1 : 0, 10); // ARCOUNT
  const question = Buffer.alloc(4);
  question.writeUInt16BE(type, 0);
  question.writeUInt16BE(klass, 2);
  const parts = [header, encodeName(name), question];
  if (edns) {
    const opt = Buffer.alloc(11);
    opt[0] = 0; // root name
    opt.writeUInt16BE(TYPE.OPT, 1);
    opt.writeUInt16BE(Math.max(512, Math.min(4096, udpPayload)), 3); // CLASS = payload size
    opt.writeUInt32BE(0, 5); // TTL = ext RCODE 0, version 0, flags 0 (no DO)
    opt.writeUInt16BE(0, 9); // RDLENGTH
    parts.push(opt);
  }
  return Buffer.concat(parts);
}

function decodeName(buf, offset) {
  const labels = [];
  let pos = offset;
  let next = null;
  let hops = 0;
  for (;;) {
    if (pos >= buf.length) throw new Error('dns name runs past message');
    const len = buf[pos];
    if (len === 0) { pos += 1; break; }
    if ((len & 0xc0) === 0xc0) {
      if (pos + 1 >= buf.length) throw new Error('dns pointer runs past message');
      const pointer = ((len & 0x3f) << 8) | buf[pos + 1];
      if (pointer >= pos) throw new Error('forward dns compression pointer');
      if (next === null) next = pos + 2;
      pos = pointer;
      if (++hops > 64) throw new Error('dns compression loop');
      continue;
    }
    if ((len & 0xc0) !== 0) throw new Error('unsupported dns label type');
    if (pos + 1 + len > buf.length) throw new Error('dns label runs past message');
    labels.push(buf.toString('ascii', pos + 1, pos + 1 + len).toLowerCase());
    pos += 1 + len;
  }
  return { name: labels.join('.'), next: next === null ? pos : next };
}

function decodeRecord(buf, offset) {
  const owner = decodeName(buf, offset);
  let pos = owner.next;
  if (pos + 10 > buf.length) throw new Error('dns record header runs past message');
  const type = buf.readUInt16BE(pos);
  const klass = buf.readUInt16BE(pos + 2);
  const ttl = buf.readUInt32BE(pos + 4);
  const rdlength = buf.readUInt16BE(pos + 8);
  pos += 10;
  if (pos + rdlength > buf.length) throw new Error('dns rdata runs past message');
  const record = { name: owner.name, type, class: klass, ttl, rdlength, rdataOffset: pos, data: null };
  if (type === TYPE.NS || type === TYPE.CNAME) {
    record.data = decodeName(buf, pos).name;
  } else if (type === TYPE.A && rdlength === 4) {
    record.data = `${buf[pos]}.${buf[pos + 1]}.${buf[pos + 2]}.${buf[pos + 3]}`;
  } else if (type === TYPE.AAAA && rdlength === 16) {
    const groups = [];
    for (let i = 0; i < 16; i += 2) groups.push(buf.readUInt16BE(pos + i).toString(16));
    record.data = groups.join(':').replace(/(^|:)0(:0)+(:|$)/, '::');
  } else if (type === TYPE.OPT) {
    record.udpPayload = klass;
    record.extendedRcode = (ttl >>> 24) & 0xff;
  }
  return { record, next: pos + rdlength };
}

function decodeMessage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) throw new Error('dns message too short');
  const id = buf.readUInt16BE(0);
  const bits = buf.readUInt16BE(2);
  const flags = {
    qr: Boolean(bits & 0x8000),
    opcode: (bits >> 11) & 0x0f,
    aa: Boolean(bits & 0x0400),
    tc: Boolean(bits & 0x0200),
    rd: Boolean(bits & 0x0100),
    ra: Boolean(bits & 0x0080),
  };
  let rcode = bits & 0x000f;
  const counts = [4, 6, 8, 10].map(o => buf.readUInt16BE(o));
  let pos = 12;
  const questions = [];
  for (let i = 0; i < counts[0]; i++) {
    const q = decodeName(buf, pos);
    if (q.next + 4 > buf.length) throw new Error('dns question runs past message');
    questions.push({ name: q.name, type: buf.readUInt16BE(q.next), class: buf.readUInt16BE(q.next + 2) });
    pos = q.next + 4;
  }
  const sections = [[], [], []];
  let truncatedSections = false;
  for (let s = 0; s < 3; s++) {
    for (let i = 0; i < counts[s + 1]; i++) {
      try {
        const { record, next } = decodeRecord(buf, pos);
        sections[s].push(record);
        pos = next;
      } catch (err) {
        // A TC=1 datagram is legitimately cut mid-section. Keep what decoded;
        // the classifier treats TC as unknown anyway.
        if (flags.tc) { truncatedSections = true; s = 3; break; }
        throw err;
      }
    }
  }
  const opt = sections[2].find(r => r.type === TYPE.OPT);
  if (opt) rcode = (opt.extendedRcode << 4) | rcode;
  return {
    id, flags, rcode, questions,
    answers: sections[0], authority: sections[1], additional: sections[2],
    truncatedSections,
  };
}

function rcodeName(rcode) {
  return RCODE_NAMES[rcode] || `rcode-${rcode}`;
}

function classifyAuthoritativeNsResponse(message, query) {
  const qname = normalizeName(query && query.name);
  if (!message || !qname) return { status: 'unknown', reason: 'invalid-message' };
  if (query.id !== undefined && message.id !== query.id) return { status: 'mismatch', reason: 'id-mismatch' };
  const q = message.questions[0];
  if (!q || normalizeName(q.name) !== qname || q.type !== (query.type || TYPE.NS) || q.class !== CLASS_IN) {
    return { status: 'mismatch', reason: 'question-mismatch' };
  }
  if (!message.flags.qr) return { status: 'mismatch', reason: 'not-a-response' };
  if (message.flags.tc) return { status: 'unknown', reason: 'truncated' };
  if (message.flags.opcode !== 0) return { status: 'unknown', reason: 'opcode' };

  const exactNs = record => record.type === TYPE.NS && record.class === CLASS_IN && normalizeName(record.name) === qname;
  const nsRecords = [...message.answers.filter(exactNs), ...message.authority.filter(exactNs)];

  if (message.rcode === RCODE.NOERROR) {
    if (nsRecords.length) {
      const inAnswer = message.answers.some(exactNs);
      return {
        status: 'taken',
        reason: inAnswer ? 'exact-ns-answer' : 'exact-referral',
        nameservers: [...new Set(nsRecords.map(r => r.data).filter(Boolean))],
      };
    }
    if (message.answers.some(r => r.type === TYPE.CNAME && normalizeName(r.name) === qname)) {
      return { status: 'unknown', reason: 'cname-at-name' };
    }
    // NODATA (SOA in authority), wildcard synthesis, or an empty NOERROR: the
    // authoritative server is not telling us the name is delegated. Fall back.
    return { status: 'unknown', reason: message.authority.some(r => r.type === TYPE.SOA) ? 'nodata' : 'noerror-without-ns' };
  }
  if (message.rcode === RCODE.NXDOMAIN) {
    if (!message.flags.aa) return { status: 'unknown', reason: 'nxdomain-not-authoritative' };
    return { status: 'not_taken', reason: 'nxdomain' };
  }
  return { status: 'unknown', reason: rcodeName(message.rcode) };
}

// Test/fixture helper: build a response message from a plain description.
function encodeResponse({ id, name, type = TYPE.NS, rcode = 0, aa = false, tc = false, answers = [], authority = [], additional = [] }) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  let bits = 0x8000;
  if (aa) bits |= 0x0400;
  if (tc) bits |= 0x0200;
  bits |= (rcode & 0x0f);
  header.writeUInt16BE(bits, 2);
  header.writeUInt16BE(name ? 1 : 0, 4);
  header.writeUInt16BE(answers.length, 6);
  header.writeUInt16BE(authority.length, 8);
  header.writeUInt16BE(additional.length, 10);
  const parts = [header];
  if (name) {
    const question = Buffer.alloc(4);
    question.writeUInt16BE(type, 0);
    question.writeUInt16BE(CLASS_IN, 2);
    parts.push(encodeName(name), question);
  }
  const encodeRecord = record => {
    let rdata;
    if (record.type === TYPE.NS || record.type === TYPE.CNAME) rdata = encodeName(record.data);
    else if (record.type === TYPE.A) rdata = Buffer.from(String(record.data).split('.').map(Number));
    else if (record.type === TYPE.SOA) rdata = Buffer.concat([encodeName(record.mname || 'a.' + record.name), encodeName(record.rname || 'hostmaster.' + record.name), Buffer.alloc(20)]);
    else rdata = Buffer.isBuffer(record.data) ? record.data : Buffer.alloc(0);
    const fixed = Buffer.alloc(10);
    fixed.writeUInt16BE(record.type, 0);
    fixed.writeUInt16BE(record.class || CLASS_IN, 2);
    fixed.writeUInt32BE(record.ttl || 172800, 4);
    fixed.writeUInt16BE(rdata.length, 8);
    return Buffer.concat([encodeName(record.name), fixed, rdata]);
  };
  for (const list of [answers, authority, additional]) for (const record of list) parts.push(encodeRecord(record));
  return Buffer.concat(parts);
}

module.exports = {
  CLASS_IN,
  DEFAULT_UDP_PAYLOAD,
  RCODE,
  TYPE,
  classifyAuthoritativeNsResponse,
  decodeMessage,
  decodeName,
  encodeName,
  encodeQuery,
  encodeResponse,
  normalizeName,
  rcodeName,
};
