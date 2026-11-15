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
  const prefix = path.basename(sourcePath) === 'ct-launches.jsonl' ? 'ct-launches-public-v1' : 'public-feed-v1';
  return {
    projection: path.join(directory, `${prefix}.jsonl`),
    search: path.join(directory, `${prefix}.search.jsonl`),
    meta: path.join(directory, `${prefix}.meta.json`),
  };
}

async function validProjection(sourcePath, sourceStat = null) {
  const source = sourceStat || await fsp.stat(sourcePath);
  const paths = pathsFor(sourcePath);
  try {
    const [meta, projectionStat, searchStat] = await Promise.all([fsp.readFile(paths.meta, 'utf8').then(JSON.parse), fsp.stat(paths.projection), fsp.stat(paths.search)]);
    if (meta?.schema !== SCHEMA || meta.sourceSize !== source.size || meta.sourceMtimeMs !== source.mtimeMs
      || !Number.isInteger(meta.rows) || meta.rows < 0 || projectionStat.size !== meta.projectionBytes || searchStat.size !== meta.searchBytes) return null;
    return { ...paths, stat: projectionStat, searchStat, meta };
  } catch { return null; }
}

async function writeProjection({ sourcePath, sourceStat, rows }) {
  const paths = pathsFor(sourcePath);
  const token = `${process.pid}-${Date.now()}`;
  const projectionTmp = `${paths.projection}.${token}.tmp`;
  const searchTmp = `${paths.search}.${token}.tmp`;
  const metaTmp = `${paths.meta}.${token}.tmp`;
  const output = fs.createWriteStream(projectionTmp, { flags: 'wx' });
  const searchOutput = fs.createWriteStream(searchTmp, { flags: 'wx' });
  let count = 0;
  try {
    for await (const row of rows) {
      const { item, text = null } = row;
      if (!output.write(`${JSON.stringify(item)}\n`)) await once(output, 'drain');
      if (!searchOutput.write(`${JSON.stringify({ item, text })}\n`)) await once(searchOutput, 'drain');
      count += 1;
    }
    await new Promise((resolve, reject) => { output.end(resolve); output.once('error', reject); });
    await new Promise((resolve, reject) => { searchOutput.end(resolve); searchOutput.once('error', reject); });
    const [after, projectionStat, searchStat] = await Promise.all([fsp.stat(sourcePath), fsp.stat(projectionTmp), fsp.stat(searchTmp)]);
    if (after.size !== sourceStat.size || after.mtimeMs !== sourceStat.mtimeMs) throw new Error('live-sites source changed while its public projection was built');
    const meta = { schema: SCHEMA, source: path.basename(sourcePath), sourceSize: after.size, sourceMtimeMs: after.mtimeMs, projectionBytes: projectionStat.size, searchBytes: searchStat.size, rows: count, builtAt: new Date().toISOString() };
    await fsp.writeFile(metaTmp, JSON.stringify(meta));
    await fsp.rename(projectionTmp, paths.projection);
    await fsp.rename(searchTmp, paths.search);
    await fsp.rename(metaTmp, paths.meta);
    return { ...paths, meta };
  } catch (error) {
    output.destroy();
    searchOutput.destroy();
    await Promise.allSettled([fsp.rm(projectionTmp, { force: true }), fsp.rm(searchTmp, { force: true }), fsp.rm(metaTmp, { force: true })]);
    throw error;
  }
}

async function buildProjectionFromRecords({ sourcePath, records }) {
  const sourceStat = await fsp.stat(sourcePath);
  async function* items() { for (const record of records || []) if (isPublishable(record)) yield { item: publicItem(record), text: typeof record.text === 'string' ? record.text : null }; }
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
      if (isPublishable(record)) yield { item: publicItem({ ...record, day: record.day || day }), text: typeof record.text === 'string' ? record.text : null };
    }
  }
  return writeProjection({ sourcePath, sourceStat, rows: items() });
}

/** Advance an already-current projection after its single writer appends one source row. */
async function appendProjectionRecord({ sourcePath, previousStat, record }) {
  if (!previousStat) return false;
  const paths = pathsFor(sourcePath);
  let meta;
  try { meta = JSON.parse(await fsp.readFile(paths.meta, 'utf8')); } catch { return false; }
  const [projectionStat, searchStat, sourceStat] = await Promise.all([fsp.stat(paths.projection), fsp.stat(paths.search), fsp.stat(sourcePath)]);
  if (meta?.schema !== SCHEMA || meta.sourceSize !== previousStat.size || meta.sourceMtimeMs !== previousStat.mtimeMs
    || projectionStat.size !== meta.projectionBytes || searchStat.size !== meta.searchBytes) return false;
  let rows = meta.rows;
  if (isPublishable(record)) {
    const item = publicItem(record);
    const text = typeof record.text === 'string' ? record.text : null;
    await fsp.appendFile(paths.projection, `${JSON.stringify(item)}\n`);
    await fsp.appendFile(paths.search, `${JSON.stringify({ item, text })}\n`);
    rows += 1;
  }
  const [nextProjection, nextSearch] = await Promise.all([fsp.stat(paths.projection), fsp.stat(paths.search)]);
  const next = { ...meta, sourceSize: sourceStat.size, sourceMtimeMs: sourceStat.mtimeMs, projectionBytes: nextProjection.size, searchBytes: nextSearch.size, rows, builtAt: new Date().toISOString() };
  const tmp = `${paths.meta}.${process.pid}-${Date.now()}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(next));
  await fsp.rename(tmp, paths.meta);
  return true;
}

module.exports = { SCHEMA, FILE, META, publicItem, isPublishable, pathsFor, validProjection, buildProjectionFromRecords, buildProjectionFromSource, appendProjectionRecord };
