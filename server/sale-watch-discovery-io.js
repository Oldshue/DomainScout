'use strict';

/**
 * The one bounded, incremental reader/writer for the Sale Watch discovery
 * corpus (data/sale-watch-discovery.json). Every consumer (reconstruction
 * ingest, the ledger/projection reader, the publisher and the baseline
 * builder) goes through this module instead of
 * JSON.parse(fs.readFileSync(file, 'utf8')).
 *
 * Why: on 2026-11-04 the file grew past V8's maximum string length
 * (0x1fffffe8 characters) and every whole-file read threw "Cannot create a
 * string longer than 0x1fffffe8 characters", killing every probe wave at its
 * first stage. This reader reads fixed-size byte chunks, walks the top-level
 * object with a small byte state machine, and JSON.parses one array element
 * (or one scalar/small top-level field) at a time, so total file size is
 * irrelevant. Only a single element larger than maxValueBytes is rejected,
 * with a typed error instead of a crash.
 *
 * maxValueBytes is injectable so tests can prove the over-limit behaviour
 * with a few-kilobyte fixture.
 */

const fs = require('node:fs');
const path = require('node:path');

// V8's String::kMaxLength on 64-bit builds (0x1fffffe8 characters).
const V8_MAX_STRING_LENGTH = 0x1fffffe8;
/**
 * Size past which the discovery file is treated as out of bounds. Every reader
 * streams it element by element, so the V8 string length no longer applies to
 * the file (2026-11-10: the freshness check still measured against it and
 * reported a healthy 422 MB file as degraded). The remaining bound is the heap
 * of a full read (the updater and the ledger reader materialize the document):
 * parsed objects take a few times their JSON bytes and production runs a
 * 10 GiB heap, so 2 GiB leaves that headroom. Retention keeps the file near
 * 0.75 GB at steady state.
 */
const DISCOVERY_FILE_LIMIT_BYTES = 2 * 1024 ** 3;
const STREAMED_SECTIONS = Object.freeze(['entries', 'retiredEntries', 'ruledOut', 'movementHistory', 'departureAssociations', 'sourceResults']);
const DEFAULT_CHUNK_BYTES = 1 << 20;

class DiscoveryReadError extends Error {
  constructor(message, code = 'EDISCOVERYMALFORMED') {
    super(message);
    this.name = 'DiscoveryReadError';
    this.code = code;
  }
}

const B_OBJ_OPEN = 0x7b, B_OBJ_CLOSE = 0x7d, B_ARR_OPEN = 0x5b, B_ARR_CLOSE = 0x5d;
const B_QUOTE = 0x22, B_BACKSLASH = 0x5c, B_COMMA = 0x2c, B_COLON = 0x3a;
const isWs = b => b === 0x20 || b === 0x0a || b === 0x0d || b === 0x09;

/**
 * Streams `file`, calling onField(key, value) for every top-level field not
 * in `sections` and onItem(section, value, index) for every element of a
 * top-level array named in `sections`. Synchronous and chunked (fs.readSync);
 * memory is bounded by the largest single element, never by the file.
 * Returns { exists:false } for a missing file, else { exists:true, bytes, items }.
 * Throws DiscoveryReadError for malformed/truncated input or an element over
 * maxValueBytes; I/O errors other than ENOENT propagate.
 */
function streamDiscoveryFile(file, {
  onField = () => {}, onItem = () => {}, onSection = () => {}, sections = STREAMED_SECTIONS,
  maxValueBytes = V8_MAX_STRING_LENGTH, chunkBytes = DEFAULT_CHUNK_BYTES,
} = {}) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch (error) {
    if (error.code === 'ENOENT') return { exists: false, bytes: 0, items: 0 };
    throw error;
  }
  const streamed = new Set(sections);
  const limit = Math.max(1, Math.floor(Number(maxValueBytes) || V8_MAX_STRING_LENGTH));
  const buffer = Buffer.allocUnsafe(Math.max(64, Math.floor(chunkBytes)));
  let mode = 'start';
  let key = null;
  let target = null; // 'key' | 'field' | 'item'
  let section = null;
  let itemIndex = 0;
  let items = 0;
  let parts = [], partBytes = 0, capStart = -1;
  let nest = 0, inString = false, escape = false, scalar = false;
  let offset = 0;

  const fail = msg => { throw new DiscoveryReadError(`${msg} at byte ${offset} of ${path.basename(file)}`); };
  const grow = n => { partBytes += n; if (partBytes > limit) throw new DiscoveryReadError(`discovery value in ${section || key || 'document'} exceeds ${limit} bytes at byte ${offset}`, 'EDISCOVERYVALUETOOLARGE'); };
  const beginCapture = i => { parts = []; partBytes = 0; capStart = i; };
  const finishCapture = (chunk, endExclusive) => {
    if (capStart >= 0 && endExclusive > capStart) { grow(endExclusive - capStart); parts.push(Buffer.from(chunk.subarray(capStart, endExclusive))); }
    capStart = -1;
    const text = Buffer.concat(parts, partBytes).toString('utf8');
    parts = []; partBytes = 0;
    try { return JSON.parse(text); } catch (error) { return fail(`malformed discovery value (${error.message})`); }
  };
  const dispatch = value => {
    if (target === 'key') { key = value; if (typeof key !== 'string') fail('non-string key'); mode = 'colon'; }
    else if (target === 'field') { onField(key, value); mode = 'key'; }
    else { onItem(section, value, itemIndex++); items += 1; mode = 'arr'; }
  };

  try {
    for (;;) {
      const n = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (n === 0) break;
      const chunk = n === buffer.length ? buffer : buffer.subarray(0, n);
      for (let i = 0; i < n; i++, offset++) {
        const b = chunk[i];
        switch (mode) {
          case 'start':
            if (isWs(b) || (offset === 0 && b === 0xef)) continue;
            if (offset <= 2 && (b === 0xbb || b === 0xbf)) continue; // UTF-8 BOM
            if (b !== B_OBJ_OPEN) fail('discovery document is not a JSON object');
            mode = 'key';
            continue;
          case 'key':
            if (isWs(b) || b === B_COMMA) continue;
            if (b === B_OBJ_CLOSE) { mode = 'done'; continue; }
            if (b !== B_QUOTE) fail('expected a field name');
            target = 'key'; section = null; beginCapture(i); nest = 0; inString = true; escape = false; scalar = false; mode = 'cap';
            continue;
          case 'colon':
            if (isWs(b)) continue;
            if (b !== B_COLON) fail('expected a colon');
            mode = 'value';
            continue;
          case 'value':
            if (isWs(b)) continue;
            if (b === B_ARR_OPEN && streamed.has(key)) { section = key; itemIndex = 0; mode = 'arr'; onSection(key); continue; }
            target = 'field'; section = null;
            break; // fall through to capture start below
          case 'arr':
            if (isWs(b) || b === B_COMMA) continue;
            if (b === B_ARR_CLOSE) { mode = 'key'; section = null; continue; }
            target = 'item';
            break;
          case 'done':
            if (isWs(b)) continue;
            fail('trailing content after the discovery document');
            break;
          case 'cap': {
            if (inString) {
              if (escape) escape = false;
              else if (b === B_BACKSLASH) escape = true;
              else if (b === B_QUOTE) { inString = false; if (nest === 0) dispatch(finishCapture(chunk, i + 1)); }
              continue;
            }
            if (scalar) {
              if (isWs(b) || b === B_COMMA || b === B_OBJ_CLOSE || b === B_ARR_CLOSE) {
                dispatch(finishCapture(chunk, i));
                i -= 1; offset -= 1; // reprocess the delimiter in the next mode
              }
              continue;
            }
            if (b === B_QUOTE) inString = true;
            else if (b === B_OBJ_OPEN || b === B_ARR_OPEN) nest += 1;
            else if (b === B_OBJ_CLOSE || b === B_ARR_CLOSE) { nest -= 1; if (nest === 0) dispatch(finishCapture(chunk, i + 1)); }
            continue;
          }
          default:
            fail(`unexpected reader state ${mode}`);
        }
        // Start capturing a value (field or array item) at byte b.
        beginCapture(i); inString = false; escape = false; scalar = false; nest = 0;
        if (b === B_QUOTE) inString = true;
        else if (b === B_OBJ_OPEN || b === B_ARR_OPEN) nest = 1;
        else if (b === B_OBJ_CLOSE || b === B_ARR_CLOSE || b === B_COMMA || b === B_COLON) fail('expected a value');
        else scalar = true;
        mode = 'cap';
      }
      if (mode === 'cap' && capStart >= 0) { grow(n - capStart); parts.push(Buffer.from(chunk.subarray(capStart, n))); capStart = 0; }
      else if (mode === 'cap') capStart = 0;
    }
  } finally {
    fs.closeSync(fd);
  }
  if (mode !== 'done') throw new DiscoveryReadError(`truncated discovery document (${path.basename(file)} ended in state ${mode} after ${offset} bytes)`, 'EDISCOVERYTRUNCATED');
  return { exists: true, bytes: offset, items };
}

/**
 * Reads the discovery document into an object (null when missing). Arrays in
 * `sections` are rebuilt element by element; `filter(section, item)` may drop
 * elements before they are retained. Throws DiscoveryReadError on malformed
 * input so a caller can keep its existing data instead of replacing it.
 */
function readDiscovery(file, { sections = STREAMED_SECTIONS, filter = null, maxValueBytes, chunkBytes } = {}) {
  const doc = {};
  const result = streamDiscoveryFile(file, {
    sections, maxValueBytes, chunkBytes,
    onField: (k, v) => { doc[k] = v; },
    onSection: s => { if (!Array.isArray(doc[s])) doc[s] = []; },
    onItem: (s, item) => {
      if (filter && !filter(s, item)) return;
      (doc[s] || (doc[s] = [])).push(item);
    },
  });
  if (!result.exists) return null;
  return doc;
}

/** readDiscovery that never throws on malformed input: returns { value, error }. */
function readDiscoverySafe(file, options = {}) {
  try { return { value: readDiscovery(file, options), error: null }; } catch (error) {
    if (error instanceof DiscoveryReadError) return { value: null, error };
    throw error;
  }
}

/**
 * Writes `doc` to `file` atomically (same-directory temp + fsync + rename),
 * serializing each array element of `sections` separately so no single
 * JSON.stringify call ever has to produce the whole document.
 */
function writeDiscovery(file, doc, { sections = STREAMED_SECTIONS, mode = 0o600 } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(temporary, 'w', mode);
  const streamed = new Set(sections);
  let pending = [];
  let pendingBytes = 0;
  const flush = () => { if (pending.length) { fs.writeSync(fd, pending.join('')); pending = []; pendingBytes = 0; } };
  const write = text => { pending.push(text); pendingBytes += text.length; if (pendingBytes >= DEFAULT_CHUNK_BYTES) flush(); };
  try {
    write('{');
    let first = true;
    for (const [k, v] of Object.entries(doc || {})) {
      if (v === undefined) continue;
      write(`${first ? '' : ','}\n${JSON.stringify(k)}:`);
      first = false;
      if (streamed.has(k) && Array.isArray(v)) {
        write('[');
        for (let i = 0; i < v.length; i++) write(`${i ? ',' : ''}\n${JSON.stringify(v[i] === undefined ? null : v[i])}`);
        write('\n]');
      } else write(JSON.stringify(v));
    }
    write('\n}\n');
    flush();
    fs.fsyncSync(fd);
  } catch (error) {
    fs.closeSync(fd);
    fs.rmSync(temporary, { force: true });
    throw error;
  }
  fs.closeSync(fd);
  fs.renameSync(temporary, file);
  return file;
}

module.exports = {
  V8_MAX_STRING_LENGTH, DISCOVERY_FILE_LIMIT_BYTES, STREAMED_SECTIONS, DiscoveryReadError,
  streamDiscoveryFile, readDiscovery, readDiscoverySafe, writeDiscovery,
};
