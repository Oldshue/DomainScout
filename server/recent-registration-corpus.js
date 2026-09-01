'use strict';

const { createHash } = require('crypto');
const { promisify } = require('util');
const { gzip, gunzip } = require('zlib');
const AdmZip = require('adm-zip');
const { GetObjectCommand, PutObjectCommand, S3Client } = require('@aws-sdk/client-s3');

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);
const DAY_MS = 86_400_000;

const isoDay = value => new Date(value).toISOString().slice(0, 10);
const previousUtcDay = (now = new Date()) => isoDay(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
const enumerateDays = (endDay, count) => Array.from({ length: count }, (_, index) => isoDay(Date.parse(`${endDay}T00:00:00Z`) - index * DAY_MS));
const normalizeDomains = lines => [...new Set(lines.map(value => String(value || '').trim().toLowerCase().replace(/\.$/, ''))
  .filter(value => /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?\.[a-z0-9-]{2,63}$/.test(value)))].sort();

async function fetchWhoisDsDay(day, fetchImpl = globalThis.fetch) {
  const sourceUrl = `https://www.whoisds.com/whois-database/newly-registered-domains/${Buffer.from(`${day}.zip`).toString('base64')}/nrd`;
  const response = await fetchImpl(sourceUrl, { headers: { 'user-agent': 'DomainScout/1.0 (+daily registry research)' }, signal: AbortSignal.timeout(90_000) });
  if (!response.ok) throw new Error(`WhoisDS ${day} returned HTTP ${response.status}`);
  const archive = Buffer.from(await response.arrayBuffer());
  if (archive.length < 1_000) throw new Error(`WhoisDS ${day} response was unexpectedly small`);
  const entry = new AdmZip(archive).getEntries().find(item => !item.isDirectory && item.entryName.endsWith('.txt'));
  if (!entry) throw new Error(`WhoisDS ${day} archive contained no text payload`);
  const domains = normalizeDomains(entry.getData().toString('utf8').split(/\r?\n/));
  if (domains.length < 1_000) throw new Error(`WhoisDS ${day} yielded only ${domains.length} valid domains`);
  return { domains, sourceUrl };
}

async function bodyToBuffer(body) {
  if (Buffer.isBuffer(body)) return body;
  if (typeof body?.transformToByteArray === 'function') return Buffer.from(await body.transformToByteArray());
  const chunks = [];
  for await (const chunk of body || []) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function createS3ObjectStore(env = process.env) {
  const bucket = String(env.DOMAINSCOUT_EVIDENCE_S3_BUCKET || '').trim();
  const endpoint = String(env.DOMAINSCOUT_EVIDENCE_S3_ENDPOINT || '').trim();
  const accessKeyId = String(env.DOMAINSCOUT_EVIDENCE_S3_ACCESS_KEY_ID || '').trim();
  const secretAccessKey = String(env.DOMAINSCOUT_EVIDENCE_S3_SECRET_ACCESS_KEY || '').trim();
  if (!bucket || !endpoint || !accessKeyId || !secretAccessKey) return null;
  const client = new S3Client({ endpoint, region: env.DOMAINSCOUT_EVIDENCE_S3_REGION || 'auto', forcePathStyle: /^(path|path-style)$/i.test(String(env.DOMAINSCOUT_EVIDENCE_S3_URL_STYLE || '')), credentials: { accessKeyId, secretAccessKey } });
  return {
    async get(key) { return bodyToBuffer((await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))).Body); },
    async put(key, body, contentType, metadata = {}) {
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType, CacheControl: key.endsWith('/latest.json') ? 'no-store' : 'public, max-age=31536000, immutable', Metadata: metadata }));
    },
  };
}

function createRecentRegistrationCorpus(options = {}) {
  const store = options.objectStore === undefined ? createS3ObjectStore() : options.objectStore;
  const fetchDay = options.fetchDay || fetchWhoisDsDay;
  const now = options.now || (() => new Date());
  const prefix = options.prefix || process.env.DOMAINSCOUT_RECENT_REGISTRATION_PREFIX || 'domainscout/corpora/newly-registered-domains/v1';
  const lookback = Math.max(3, Math.min(45, Number(options.lookbackDays || process.env.DOMAINSCOUT_RECENT_REGISTRATION_DAYS || 14)));
  const warningHours = Number(options.warningHours || process.env.DOMAINSCOUT_RECENT_REGISTRATION_WARNING_HOURS || 36);
  const staleHours = Number(options.staleHours || process.env.DOMAINSCOUT_RECENT_REGISTRATION_STALE_HOURS || 48);
  const logger = options.logger || console;
  const latestKey = `${prefix}/latest.json`;
  let manifestCache = null;
  let manifestCachedAt = 0;
  const dayCache = new Map();
  let activeRefresh = null;
  let lastAttempt = null;

  async function loadManifest(force = false) {
    if (!store) return null;
    if (!force && manifestCache && Date.now() - manifestCachedAt < 300_000) return manifestCache;
    try {
      const manifest = JSON.parse((await store.get(latestKey)).toString('utf8'));
      if (manifest.schema !== 'domainscout.recent-registration-corpus/v1' || !Array.isArray(manifest.days)) throw new Error('latest pointer has an unsupported schema');
      manifestCache = manifest;
      manifestCachedAt = Date.now();
      return manifest;
    } catch (error) {
      if (manifestCache) return manifestCache;
      if (error?.name === 'NoSuchKey' || error?.$metadata?.httpStatusCode === 404) return null;
      throw error;
    }
  }

  function freshness(manifest) {
    if (!store) return { schema: 'domainscout.corpus-freshness/v1', status: 'unconfigured', current: false, warningHours, staleHours, reason: 'S3 evidence store is not configured' };
    if (!manifest) return { schema: 'domainscout.corpus-freshness/v1', status: 'unavailable', current: false, warningHours, staleHours, reason: 'No complete corpus receipt has been accepted', lastAttempt };
    const ageHours = Math.max(0, (now().getTime() - Date.parse(`${manifest.latestDate}T23:59:59.999Z`)) / 3_600_000);
    const status = ageHours > staleHours ? 'stale' : ageHours > warningHours ? 'warning' : 'current';
    return { schema: 'domainscout.corpus-freshness/v1', status, current: status === 'current', latestDate: manifest.latestDate, oldestDate: manifest.oldestDate, acceptedAt: manifest.acceptedAt, runId: manifest.runId, ageHours: Number(ageHours.toFixed(2)), warningHours, staleHours, source: manifest.source, dayCount: manifest.days.length, totalNames: manifest.days.reduce((sum, day) => sum + day.count, 0), lastAttempt };
  }
  async function status() {
    try { return freshness(await loadManifest()); }
    catch (error) { return { schema: 'domainscout.corpus-freshness/v1', status: 'unavailable', current: false, reason: error.message, warningHours, staleHours, lastAttempt }; }
  }

  async function performRefresh(endDay = previousUtcDay(now())) {
    if (!store) throw new Error('S3 evidence store is not configured');
    const startedAt = now().toISOString();
    const runId = `${startedAt.replace(/[:.]/g, '-')}-${Math.random().toString(16).slice(2, 10)}`;
    const requestedDays = enumerateDays(endDay, lookback);
    const days = [];
    lastAttempt = { runId, startedAt, status: 'running', requestedDays };
    try {
      for (const day of requestedDays) {
        const source = await fetchDay(day);
        const raw = Buffer.from(`${source.domains.join('\n')}\n`);
        const digest = `sha256:${createHash('sha256').update(raw).digest('hex')}`;
        const body = await gzipAsync(raw, { level: 9 });
        const key = `${prefix}/runs/${runId}/days/${day}.ndjson.gz`;
        await store.put(key, body, 'application/x-ndjson', { schema: 'domainscout-recent-registration-day-v1', day, digest: digest.slice(7) });
        days.push({ day, key, count: source.domains.length, digest, bytes: body.length, sourceUrl: source.sourceUrl });
      }
      const acceptedAt = now().toISOString();
      const receipt = { schema: 'domainscout.recent-registration-receipt/v1', runId, status: 'complete', startedAt, acceptedAt, requestedDays, succeeded: days.length, failed: 0, days };
      await store.put(`${prefix}/runs/${runId}/receipt.json`, Buffer.from(JSON.stringify(receipt)), 'application/json');
      const manifest = { schema: 'domainscout.recent-registration-corpus/v1', runId, acceptedAt, source: 'WhoisDS public newly-registered-domains feed', latestDate: requestedDays[0], oldestDate: requestedDays.at(-1), days };
      await store.put(latestKey, Buffer.from(JSON.stringify(manifest)), 'application/json');
      manifestCache = manifest; manifestCachedAt = Date.now(); dayCache.clear();
      lastAttempt = { ...lastAttempt, status: 'complete', acceptedAt, succeeded: days.length, failed: 0 };
      logger.log(`[RecentRegistrationCorpus] accepted ${runId}: ${days.length} days, ${days.reduce((sum, item) => sum + item.count, 0)} names`);
      return manifest;
    } catch (error) {
      const failedAt = now().toISOString();
      lastAttempt = { ...lastAttempt, status: 'failed', failedAt, succeeded: days.length, failed: 1, error: error.message };
      try { await store.put(`${prefix}/runs/${runId}/receipt.json`, Buffer.from(JSON.stringify({ schema: 'domainscout.recent-registration-receipt/v1', runId, status: 'failed', startedAt, failedAt, requestedDays, succeeded: days.length, failed: 1, error: error.message, days })), 'application/json'); } catch (_) {}
      logger.warn(`[RecentRegistrationCorpus] refresh failed closed after ${days.length}/${requestedDays.length}: ${error.message}`);
      throw error;
    }
  }

  async function refresh(options = {}) {
    if (!activeRefresh) activeRefresh = performRefresh(options.endDay).finally(() => { activeRefresh = null; });
    return activeRefresh;
  }
  async function loadDay(day) {
    if (dayCache.has(day.day)) return dayCache.get(day.day);
    const raw = await gunzipAsync(await store.get(day.key));
    if (`sha256:${createHash('sha256').update(raw).digest('hex')}` !== day.digest) throw new Error(`Digest mismatch for ${day.day}`);
    const domains = normalizeDomains(raw.toString('utf8').split(/\r?\n/));
    if (domains.length !== day.count) throw new Error(`Count mismatch for ${day.day}`);
    dayCache.set(day.day, domains);
    return domains;
  }
  async function search({ contains, days = lookback, allowStale = false } = {}) {
    const needle = String(contains || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
    if (needle.length < 2) throw new Error('contains must have at least two domain-label characters');
    const manifest = await loadManifest();
    const state = freshness(manifest);
    if (!manifest) return { schema: 'domainscout.recent-registration-search/v1', freshness: state, matches: [], searchedDays: [] };
    if (state.status === 'stale' && !allowStale) { const error = new Error(`Corpus is stale at ${state.ageHours} hours`); error.code = 'CORPUS_STALE'; error.freshness = state; throw error; }
    const selected = manifest.days.slice(0, Math.max(1, Math.min(lookback, Number(days) || lookback)));
    const matches = [];
    for (const day of selected) for (const domain of await loadDay(day)) if (domain.split('.')[0].includes(needle)) matches.push({ domain, reportDate: day.day });
    return { schema: 'domainscout.recent-registration-search/v1', generatedAt: now().toISOString(), query: { contains: needle, days: selected.length }, freshness: state, searchedDays: selected.map(day => day.day), matches };
  }
  async function refreshIfDue() { const state = await status(); return state.status === 'current' ? { refreshed: false, freshness: state } : { refreshed: true, freshness: freshness(await refresh()) }; }
  return { refresh, refreshIfDue, search, status };
}

function registerRecentRegistrationCorpusRoutes(app, corpus) {
  app.get('/api/recent-registration-corpus/status', async (_req, res) => { const state = await corpus.status(); res.set('Cache-Control', 'no-store'); res.status(['unavailable', 'unconfigured'].includes(state.status) ? 503 : 200).json(state); });
  app.get('/api/recent-registration-corpus/search', async (req, res) => {
    try { res.set('Cache-Control', 'no-store'); res.json(await corpus.search({ contains: req.query.contains, days: req.query.days, allowStale: /^(1|true|yes)$/i.test(String(req.query.allowStale || '')) })); }
    catch (error) { res.status(error.code === 'CORPUS_STALE' ? 503 : 400).json({ error: error.code || 'invalid_request', detail: error.message, freshness: error.freshness }); }
  });
  app.post('/api/recent-registration-corpus/refresh', async (_req, res) => {
    try { const manifest = await corpus.refresh(); res.json({ ok: true, runId: manifest.runId, latestDate: manifest.latestDate, acceptedAt: manifest.acceptedAt }); }
    catch (error) { res.status(503).json({ ok: false, error: 'refresh_failed', detail: error.message, freshness: await corpus.status() }); }
  });
}

module.exports = { createRecentRegistrationCorpus, createS3ObjectStore, enumerateDays, fetchWhoisDsDay, normalizeDomains, previousUtcDay, registerRecentRegistrationCorpusRoutes };
