'use strict';

// Pure stream helpers for the cloud-native registration-universe pull.
// createLabelExtractor mirrors, byte-for-byte, the MacBook awk extractor:
//   awk '{n=split(tolower($1),a,".")} n==3 && a[2]==t && (a[3]=="" || a[3]==t) {print a[1]}'
// diffSortedGzip/sortUniqueGzip/countGzipLines operate on the resulting
// newline-delimited, LC_ALL=C-sorted, gzip-compressed label files.

const { spawn } = require('child_process');
const fs = require('fs');
const zlib = require('zlib');
const { Transform } = require('stream');

function extractLabel(rawLine, wantedTld) {
  const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
  if (!line) return null;
  const spaceIndex = line.search(/\s/);
  const firstField = spaceIndex === -1 ? line : line.slice(0, spaceIndex);
  if (!firstField) return null;
  const parts = firstField.toLowerCase().split('.');
  if (parts.length !== 3 || parts[1] !== wantedTld) return null;
  if (parts[2] !== '' && parts[2] !== wantedTld) return null;
  if (!parts[0]) return null;
  return parts[0];
}

// Transform: zone-file text lines in, one label per line out.
function createLabelExtractor(tld) {
  const wantedTld = String(tld || '').toLowerCase();
  let pending = '';
  return new Transform({
    transform(chunk, encoding, callback) {
      pending += chunk.toString('utf8');
      const lines = pending.split('\n');
      pending = lines.pop();
      let out = '';
      for (const rawLine of lines) {
        const label = extractLabel(rawLine, wantedTld);
        if (label) out += `${label}\n`;
      }
      callback(null, out);
    },
    flush(callback) {
      const label = pending ? extractLabel(pending, wantedTld) : null;
      callback(null, label ? `${label}\n` : '');
    },
  });
}

// Spawn a single `sort -u | gzip` pipeline with shell redirection so Node
// never buffers the (potentially large) sorted stream itself. Writes
// `${outPath}.part` then renames on success only.
function sortUniqueGzip({ rawPath, outPath, tmpDir }) {
  return new Promise((resolve, reject) => {
    const partPath = `${outPath}.part`;
    const cmd = `LC_ALL=C sort -u -S 512M -T ${tmpDir} ${rawPath} | gzip -1 > ${partPath}`;
    const child = spawn('/bin/sh', ['-c', cmd], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) {
        fs.rename(partPath, outPath, err => { if (err) reject(err); else resolve({ outPath }); });
      } else {
        fs.unlink(partPath, () => {});
        reject(new Error(`sortUniqueGzip failed (exit ${code}): ${stderr.trim()}`));
      }
    });
  });
}

// Async-iterate non-empty lines of a gzip file as Buffers (not strings) so
// downstream comparisons can use Buffer.compare — never localeCompare.
async function* readGzipLines(filePath) {
  const stream = fs.createReadStream(filePath).pipe(zlib.createGunzip());
  let pending = Buffer.alloc(0);
  for await (const chunk of stream) {
    pending = Buffer.concat([pending, chunk]);
    let index = pending.indexOf(10);
    while (index !== -1) {
      let line = pending.slice(0, index);
      if (line.length && line[line.length - 1] === 13) line = line.slice(0, -1);
      if (line.length) yield line;
      pending = pending.slice(index + 1);
      index = pending.indexOf(10);
    }
  }
  if (pending.length) yield pending;
}

// Line-by-line merge of two byte-sorted, deduplicated gzip label files.
async function diffSortedGzip({ prevPath, todayPath, onAdd, onDrop }) {
  const havePrev = prevPath && fs.existsSync(prevPath);
  const prevIter = havePrev ? readGzipLines(prevPath) : (async function* noop() {})();
  const todayIter = readGzipLines(todayPath);
  let prevCount = 0;
  let todayCount = 0;
  let adds = 0;
  let drops = 0;
  let prevNext = await prevIter.next();
  let todayNext = await todayIter.next();
  while (!prevNext.done || !todayNext.done) {
    if (prevNext.done) {
      todayCount += 1;
      adds += 1;
      if (onAdd) onAdd(todayNext.value.toString('utf8'));
      todayNext = await todayIter.next();
    } else if (todayNext.done) {
      prevCount += 1;
      drops += 1;
      if (onDrop) onDrop(prevNext.value.toString('utf8'));
      prevNext = await prevIter.next();
    } else {
      const cmp = Buffer.compare(prevNext.value, todayNext.value);
      if (cmp === 0) {
        prevCount += 1;
        todayCount += 1;
        prevNext = await prevIter.next();
        todayNext = await todayIter.next();
      } else if (cmp < 0) {
        prevCount += 1;
        drops += 1;
        if (onDrop) onDrop(prevNext.value.toString('utf8'));
        prevNext = await prevIter.next();
      } else {
        todayCount += 1;
        adds += 1;
        if (onAdd) onAdd(todayNext.value.toString('utf8'));
        todayNext = await todayIter.next();
      }
    }
  }
  return { prevCount, todayCount, adds, drops };
}

async function countGzipLines(filePath) {
  let count = 0;
  // eslint-disable-next-line no-unused-vars
  for await (const _line of readGzipLines(filePath)) count += 1;
  return count;
}

module.exports = {
  createLabelExtractor,
  sortUniqueGzip,
  diffSortedGzip,
  countGzipLines,
  readGzipLines,
};
