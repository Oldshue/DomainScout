'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const readline = require('node:readline');
const { once } = require('node:events');
const { isSpamText, isDefaultOrChallengeTitle } = require('./website-content-quality');

const SCHEMA = 'domainscout.live-sites-public-projection/v1';
const FILE = 'public-feed-v1.jsonl';
const META = 'public-feed-v1.meta.json';

function publicItem(record) {
  const domain = String(record.domain);
  let url = record.finalUrl || record.url || `https://${domain}/`;
  try { const parsed = new URL(url); if (!/^https?:$/.test(parsed.protocol)) url = `https://${domain}/`; }
  catch { url = `https://${domain}/`; }
  return { domain, zone: domain.slice(domain.lastIndexOf('.') + 1), day: record.day, title: String(record.title), description: record.description ? String(record.description) : null, url, observedAt: record.observedAt || null };
}

function isPublishable(record) {
  return !!record && record.class === 'built' && !record.kit && !record.spam && record.titleReal === true
    && typeof record.title === 'string' && record.title.trim().length > 0 && typeof record.domain === 'string'
    && !isDefaultOrChallengeTitle(record.title) && !isSpamText(`${record.title}\n${record.description || ''}`);
}

function pathsFor(sourcePath) {
  const directory = path.dirname(sourcePath);
  return { projection: path.join(directory, FILE), meta: path.join(directory, META) };
}

async function validProjection(sourcePath, sourceStat = null) {
  const source = sourceStat || await fsp.stat(sourcePath);
  const paths = pathsFor(sourcePath);
  try {
    const [meta, projectionStat] = await Promise.all([fsp.readFile(paths.meta, 'utf8').then(JSON.parse), fsp.stat(paths.projection)]);
    if (meta?.schema !== SCHEMA || meta.sourceSize !== source.size || meta.sourceMtimeMs !== source.mtimeMs
      || !Number.isInteger(meta.rows) || meta.rows < 0 || projectionStat.size !== meta.projectionBytes) return null;
    return { ...paths, stat: projectionStat, meta };
  } catch { return null; }
}

async function writeProjection({ sourcePath, sourceStat, rows }) {
  const paths = pathsFor(sourcePath);
  const token = `${process.pid}-${Date.now()}`;
  const projectionTmp = `${paths.projection}.${token}.tmp`;
  const metaTmp = `${paths.meta}.${token}.tmp`;
  const output = fs.createWriteStream(projectionTmp, { flags: 'wx' });
  let count = 0;
  try {
    for await (const item of rows) {
      if (!output.write(`${JSON.stringify(item)}\n`)) await once(output, 'drain');
      count += 1;
    }
    await new Promise((resolve, reject) => { output.end(resolve); output.once('error', reject); });
    const [after, projectionStat] = await Promise.all([fsp.stat(sourcePath), fsp.stat(projectionTmp)]);
    if (after.size !== sourceStat.size || after.mtimeMs !== sourceStat.mtimeMs) throw new Error('live-sites source changed while its public projection was built');
    const meta = { schema: SCHEMA, source: path.basename(sourcePath), sourceSize: after.size, sourceMtimeMs: after.mtimeMs, projectionBytes: projectionStat.size, rows: count, builtAt: new Date().toISOString() };
    await fsp.writeFile(metaTmp, JSON.stringify(meta));
    await fsp.rename(projectionTmp, paths.projection);
    await fsp.rename(metaTmp, paths.meta);
    return { ...paths, meta };
  } catch (error) {
    output.destroy();
    await Promise.allSettled([fsp.rm(projectionTmp, { force: true }), fsp.rm(metaTmp, { force: true })]);
    throw error;
  }
}

async function buildProjectionFromRecords({ sourcePath, records }) {
  const sourceStat = await fsp.stat(sourcePath);
  async function* items() { for (const record of records || []) if (isPublishable(record)) yield publicItem(record); }
  return writeProjection({ sourcePath, sourceStat, rows: items() });
}

async function buildProjectionFromSource({ sourcePath, day }) {
  const sourceStat = await fsp.stat(sourcePath);
  async function* items() {
    const lines = readline.createInterface({ input: fs.createReadStream(sourcePath), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line) continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      if (isPublishable(record)) yield publicItem({ ...record, day: record.day || day });
    }
  }
  return writeProjection({ sourcePath, sourceStat, rows: items() });
}

module.exports = { SCHEMA, FILE, META, publicItem, isPublishable, pathsFor, validProjection, buildProjectionFromRecords, buildProjectionFromSource };
