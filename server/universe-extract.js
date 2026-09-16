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
    // No shell: the Railway image's /bin/sh is dash (no pipefail), and a
    // shell pipeline would report only gzip's exit code, so a failing `sort`
    // (bad path, disk full, OOM-killed) could be silently reported as
    // success — exactly the failure mode this lane must not repeat. Both
    // processes are spawned directly and BOTH exit codes are checked.
    const sort = spawn('sort', ['-u', '-S', '512M', '-T', tmpDir, rawPath], {
      env: { ...process.env, LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const gzip = spawn('gzip', ['-1'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const out = fs.createWriteStream(partPath);
    let stderr = '';
    const collect = chunk => { stderr += chunk.toString(); if (stderr.length > 4000) stderr = stderr.slice(-4000); };
    sort.stderr.on('data', collect); gzip.stderr.on('data', collect);
    sort.stdout.pipe(gzip.stdin); gzip.stdout.pipe(out);
    let settled = false; let sortCode = null; let gzipCode = null; let outDone = false;
    const fail = error => { if (settled) return; settled = true; fs.unlink(partPath, () => {}); reject(error); };
    const finish = () => {
      if (settled || sortCode === null || gzipCode === null || !outDone) return;
      if (sortCode !== 0 || gzipCode !== 0) return fail(new Error(`sortUniqueGzip failed (sort exit ${sortCode}, gzip exit ${gzipCode}): ${stderr.trim()}`));
      settled = true;
      fs.rename(partPath, outPath, err => { if (err) reject(err); else resolve({ outPath }); });
    };
    sort.on('error', fail); gzip.on('error', fail); out.on('error', fail);
    sort.on('close', code => { sortCode = code; if (code !== 0) gzip.stdin.end(); finish(); });
    gzip.on('close', code => { gzipCode = code; finish(); });
    out.on('finish', () => { outDone = true; finish(); });
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

// Canonical NS snapshots preserve the delegation evidence used by every
// downstream lane. Already ordered registry streams need no disk sort; an
// unordered source is retried through the same bounded external sorter.
function createDelegationExtractor(zone, { validateOrder = true, onProgress = () => {} } = {}) {
  const { parseNsLine } = require('./zone-ns-movement');
  let pending = '', last = '', bytes = 0;
  const line = raw => {
    const row = parseNsLine(raw, zone);
    if (!row || !row.name.endsWith('.' + zone)) return '';
    if (validateOrder && row.name < last) {
      const error = new Error(`Unordered delegation source: ${zone}`); error.code = 'UNSORTED_ZONE'; throw error;
    }
    last = row.name;
    return `${row.name}\t0\tin\tns\t${row.host}\n`;
  };
  return new Transform({
    transform(chunk, enc, cb) {
      try {
        bytes += chunk.length; onProgress(bytes);
        pending += chunk.toString('utf8'); const lines = pending.split('\n');pending = lines.pop();
        if (pending.length > 1024 * 1024) throw new Error('Zone record exceeds 1 MiB');
        cb(null,lines.map(line).join(''));
      } catch(error) {cb(error);}
    },
    flush(cb) {try {cb(null,pending ? line(pending) : '');} catch(error) {cb(error);}},
  });
}

async function streamSortedGzip({ input, outPath, tmpDir, signal }) {
  const {pipeline} = require('node:stream/promises');
  fs.mkdirSync(tmpDir,{recursive:true});
  const child = spawn('sort',['-u','-S','64M','-T',tmpDir],{env:{...process.env,LC_ALL:'C'},stdio:['pipe','pipe','pipe']});
  let stderr=''; child.stderr.on('data',c=>{stderr=(stderr+c).slice(-2000);});
  const exited = new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code)=>code===0?resolve():reject(new Error(`sort exited ${code}: ${stderr}`)));});
  const part = outPath+'.part';
  try {
    const jobs=[pipeline(input,child.stdin,{signal}),pipeline(child.stdout,zlib.createGzip({level:1}),fs.createWriteStream(part),{signal}),exited];
    await Promise.all(jobs).catch(async error=>{child.kill('SIGKILL');input.destroy(error);await Promise.allSettled(jobs);throw error;});
    await fs.promises.rename(part,outPath);
  } finally {if(child.exitCode===null)child.kill('SIGKILL');await fs.promises.rm(part,{force:true}).catch(()=>{});}
}

async function snapshotNames({ snapshotPath, outPath, zone, signal }) {
  const {pipeline} = require('node:stream/promises');
  const {PassThrough} = require('node:stream');
  let labels = 0, pending = '', last = '';
  // These are validated canonical NS rows, not arbitrary DNS master text.
  // Extract owner groups in batches instead of building/sorting nameserver
  // arrays and resolving an async generator once per registered name.
  function extractLines(lines) {
    let output = '';
    for (const line of lines) {
      if (!line) continue;
      const tab = line.indexOf('\t');
      if (tab < 1) throw new Error('Malformed canonical delegation snapshot');
      const name = line.slice(0, tab);
      if (name === last) continue;
      if (name < last) throw new Error('Canonical delegations are out of order');
      last = name;
      if (!name.endsWith('.' + zone)) throw new Error('Canonical delegation has the wrong zone');
      const label = name.slice(0, -zone.length - 1);
      if (label && !label.includes('.')) { labels++; output += label + '\n'; }
    }
    return output;
  }
  const parser = new Transform({
    transform(chunk, enc, cb) {
      try {
        const lines = (pending + chunk.toString('utf8')).split('\n');
        pending = lines.pop(); cb(null, extractLines(lines));
      } catch (error) { cb(error); }
    },
    flush(cb) { try { cb(null, extractLines([pending])); } catch (error) { cb(error); } },
  });
  const names = new PassThrough();
  const producing = pipeline(fs.createReadStream(snapshotPath), zlib.createGunzip(), parser, names, {signal});
  // Removing a suffix changes byte order: a-b.com < a.com, but a < a-b.
  await Promise.all([producing, streamSortedGzip({input:names,outPath,tmpDir:require('node:path').dirname(snapshotPath),signal})]);
  return labels;
}

module.exports.createDelegationExtractor=createDelegationExtractor;
module.exports.streamSortedGzip=streamSortedGzip;
module.exports.snapshotNames=snapshotNames;
