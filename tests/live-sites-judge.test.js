'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const judge = require('../server/live-sites-judge');
const ls = require('../server/live-sites');
const { createLiveSitesFeed } = require('../server/live-sites-feed');
const { createLiveSitesStage } = require('../server/live-sites-stage');

const quiet = { log() {}, warn() {}, error() {} };

/** Stub model: labels each row from a test-supplied domain->label map (default legit_business). */
function stubClient(byDomain = {}, { fail = () => false, calls = [] } = {}) {
  return {
    model: 'stub-model',
    calls,
    async complete({ system, user }) {
      const payload = JSON.parse(user);
      calls.push({ system, rows: payload.rows });
      const failure = fail(payload.rows, calls.length);
      if (failure === 'hang') return new Promise(() => {});
      if (failure) throw new Error(String(failure));
      return JSON.stringify({ labels: payload.rows.map(row => ({ i: row.i, label: byDomain[row.domain] || 'legit_business' })) });
    },
  };
}

function built(domain, extra = {}) {
  return { domain, zone: domain.split('.').pop(), class: 'built', reason: 'operating_site', title: `${domain} site`, description: `About ${domain}`, titleReal: true, spam: false, kit: null, fingerprint: { title: 'x', skeleton: 'y' }, observedAt: '2026-10-25T09:00:00.000Z', version: ls.CLASSIFIER_VERSION, ...extra };
}

async function tmp(t, prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function writeDay(directory, day, records, summary = {}) {
  const ns = path.join(directory, day, 'ns');
  await fs.mkdir(ns, { recursive: true });
  await fs.writeFile(path.join(ns, 'movement.jsonl'), JSON.stringify({ domain: 'a.com', selection: 'went-live' }) + '\n');
  await fs.writeFile(path.join(ns, 'summary.json'), '{}');
  const sites = path.join(directory, day, 'sites');
  await fs.mkdir(sites, { recursive: true });
  await fs.writeFile(path.join(sites, 'observations.jsonl'), records.map(r => JSON.stringify(r)).join('\n') + '\n');
  await fs.writeFile(path.join(sites, 'summary.json'), JSON.stringify({ status: 'complete', version: ls.CLASSIFIER_VERSION, day, total: records.length, observed: records.length, built: { pages: records.length, publishable: records.length }, ...summary }));
}

const readRows = async (directory, day) => (await fs.readFile(path.join(directory, day, 'sites', 'observations.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));

// ── Parsing and batching ────────────────────────────────────────────────────
test('parseLabels accepts strict JSON only and nulls invalid, unknown or conflicting entries', () => {
  const { labels, invalid } = judge.parseLabels(JSON.stringify({ labels: [{ i: 0, label: 'gambling' }, { i: 1, label: 'bogus' }, { i: 2, label: 'adult' }, { i: 2, label: 'legit_business' }, { i: 9, label: 'adult' }] }), 4);
  assert.deepEqual(labels, ['gambling', null, null, null]);
  assert.equal(invalid, 3);
  assert.throws(() => judge.parseLabels('sure! here are the labels', 2), /invalid JSON/);
  assert.throws(() => judge.parseLabels('{"x":1}', 2), /labels array/);
  assert.deepEqual(judge.parseLabels('```json\n{"labels":[{"i":0,"label":"content_or_media"}]}\n```', 1).labels, ['content_or_media']);
});

test('judgeRows sends batches of batchSize rows with domain, title and description', async () => {
  const rows = Array.from({ length: 450 }, (_, i) => ({ domain: `site${String.fromCharCode(97 + (i % 26))}x${i}.com`, title: `Title ${i}`, description: `Desc ${i}` }));
  const client = stubClient({ [rows[3].domain]: 'gambling' });
  const result = await judge.judgeRows(rows, { client, batchSize: 200, concurrency: 2 });
  assert.equal(result.batches, 3);
  assert.deepEqual(client.calls.map(call => call.rows.length).sort((a, b) => b - a), [200, 200, 50]);
  assert.deepEqual(Object.keys(client.calls[0].rows[0]).sort(), ['description', 'domain', 'i', 'title']);
  assert.equal(result.labels.size, 450);
  assert.equal(result.labels.get(rows[3].domain), 'gambling');
  assert.match(client.calls[0].system, /strict JSON/);
});

test('a failed or timed-out batch leaves its rows unlabelled and is recorded, never thrown', async () => {
  const rows = Array.from({ length: 6 }, (_, i) => ({ domain: `r${'abcdef'[i]}.com`, title: 't', description: '' }));
  const client = stubClient({}, { fail: batch => (batch[0].domain === 'rc.com' ? 'hang' : batch[0].domain === 're.com' ? 'DeepSeek HTTP 500' : false) });
  const result = await judge.judgeRows(rows, { client, batchSize: 2, timeoutMs: 1000, concurrency: 3 });
  assert.deepEqual([...result.labels.keys()].sort(), ['ra.com', 'rb.com']);
  assert.equal(result.failures.length, 2);
  assert.ok(result.failures.some(f => /timed out/.test(f.error)));
  assert.ok(result.failures.some(f => /HTTP 500/.test(f.error)));
});

test('DeepSeek client posts a JSON-mode chat completion with the env key and returns the content', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => { seen.push({ url, init }); return new Response(JSON.stringify({ choices: [{ message: { content: '{"labels":[]}' } }] }), { status: 200 }); };
  const { client } = judge.resolveJudgeClient({ DEEPSEEK_API_KEY: 'sk-test' }, { fetchImpl });
  assert.equal(await client.complete({ system: 's', user: 'u' }), '{"labels":[]}');
  assert.equal(seen[0].url, 'https://api.deepseek.com/chat/completions');
  assert.equal(seen[0].init.headers.authorization, 'Bearer sk-test');
  const body = JSON.parse(seen[0].init.body);
  assert.equal(body.model, 'deepseek-chat');
  assert.deepEqual(body.response_format, { type: 'json_object' });
  const failing = judge.createDeepSeekClient({ apiKey: 'k', fetchImpl: async () => new Response('quota', { status: 402 }) });
  await assert.rejects(failing.complete({ system: 's', user: 'u' }), /HTTP 402/);
  assert.equal(judge.resolveJudgeClient({}).client, null);
  assert.equal(judge.judgeConfigured({ DEEPSEEK_API_KEY: '  ' }), false);
});

// ── Record-level judgement ─────────────────────────────────────────────────
test('applyJudgement labels only eligible rows and reports counts; no client is unconfigured, not silent', async () => {
  const records = [built('shop.com'), built('casino-x.com'), built('kit.com', { kit: { id: 'k' } }), { domain: 'p.com', class: 'parked' }, built('bad.com', { title: 'Caf�' })];
  const none = await judge.applyJudgement(records, { client: null, log: quiet });
  assert.equal(none.status, 'unconfigured');
  assert.equal(none.unlabelled, 2);
  assert.match(none.error, /DEEPSEEK_API_KEY/);
  const summary = await judge.applyJudgement(records, { client: stubClient({ 'casino-x.com': 'gambling' }), log: quiet });
  assert.equal(summary.status, 'complete');
  assert.equal(summary.eligible, 2);
  assert.equal(summary.withheld, 1);
  assert.equal(summary.counts.gambling, 1);
  assert.equal(records[0].judgement.label, 'legit_business');
  assert.equal(records[0].judgement.version, judge.JUDGE_VERSION);
  assert.equal(records[2].judgement, undefined, 'kit rows are not sent to the model');
  assert.equal(records[4].judgement, undefined, 'U+FFFD titles are not eligible');
  assert.equal(judge.publishableCount(records), 1);
});

// ── Backfill of rows already on disk ───────────────────────────────────────
test('judgeDay labels unlabelled on-disk rows, keeps existing labels, and records summary.judgement', async t => {
  const directory = await tmp(t, 'domainscout-judge-day-');
  const day = '2026-10-25';
  await writeDay(directory, day, [built('bakery.com'), built('slots.com'), built('blog.net', { judgement: { label: 'content_or_media', model: 'old', version: judge.JUDGE_VERSION } })]);
  const client = stubClient({ 'slots.com': 'gambling' });
  const result = await judge.judgeDay({ directory, day, client, log: quiet });
  assert.equal(result.judgement.status, 'complete');
  assert.equal(client.calls.length, 1);
  assert.deepEqual(client.calls[0].rows.map(r => r.domain), ['bakery.com', 'slots.com'], 'already-labelled rows are not resent');
  const rows = Object.fromEntries((await readRows(directory, day)).map(r => [r.domain, r]));
  assert.equal(rows['slots.com'].judgement.label, 'gambling');
  assert.equal(rows['blog.net'].judgement.model, 'old');
  const summary = JSON.parse(await fs.readFile(path.join(directory, day, 'sites', 'summary.json'), 'utf8'));
  assert.equal(summary.judgement.withheld, 1);
  assert.equal(summary.built.publishable, 2);
  assert.equal(judge.judgementPending(summary), false);
});

test('judgeDay with a failing model leaves rows unlabelled and marks the day failed', async t => {
  const directory = await tmp(t, 'domainscout-judge-fail-');
  const day = '2026-10-25';
  await writeDay(directory, day, [built('one.com'), built('two.com')]);
  const result = await judge.judgeDay({ directory, day, client: stubClient({}, { fail: () => 'DeepSeek HTTP 503' }), log: quiet });
  assert.equal(result.judgement.status, 'failed');
  assert.equal(result.judgement.unlabelled, 2);
  assert.ok((await readRows(directory, day)).every(r => !r.judgement));
  const summary = JSON.parse(await fs.readFile(path.join(directory, day, 'sites', 'summary.json'), 'utf8'));
  assert.equal(judge.judgementPending(summary), true);
});

// ── Stage: backfill of the newest two days and health ──────────────────────
test('stage backfill queues judge-only runs for the newest two complete days with unlabelled rows', async t => {
  const root = await tmp(t, 'domainscout-judge-stage-');
  const universeDir = path.join(root, 'universe');
  await writeDay(universeDir, '2026-10-22', [built('a.com')]);
  await writeDay(universeDir, '2026-10-23', [built('a.com')]);
  await writeDay(universeDir, '2026-10-24', [built('a.com')], { judgement: { status: 'complete', eligible: 1, labelled: 1, unlabelled: 0 } });
  await writeDay(universeDir, '2026-10-25', [built('a.com')]);
  const jobs = [];
  const stage = createLiveSitesStage({ universeDir, dataDir: root, env: { DEEPSEEK_API_KEY: 'k' }, log: quiet, runDay: async job => { jobs.push(job); return { ok: true }; } });
  const result = await stage.backfill({ days: 3 });
  assert.deepEqual(result.queued, []);
  assert.deepEqual(result.judgeQueued, ['2026-10-25'], 'only the newest two days are considered; 10-24 is fully labelled');
  await stage.idle();
  assert.deepEqual(jobs.map(j => [j.day, j.judge]), [['2026-10-25', true]]);
  const unconfigured = createLiveSitesStage({ universeDir, dataDir: root, env: {}, log: quiet, runDay: async () => assert.fail('no key, no judge run') });
  assert.deepEqual((await unconfigured.backfill({ days: 3 })).judgeQueued, []);
});

test('stage health alerts on unlabelled rows from a failed or unconfigured judgement', async t => {
  const root = await tmp(t, 'domainscout-judge-health-');
  const universeDir = path.join(root, 'universe');
  await writeDay(universeDir, '2026-10-25', [built('a.com')], { judgement: { status: 'failed', eligible: 40, labelled: 0, unlabelled: 40, withheld: 0, error: 'model call timed out after 120000ms', failedBatches: 1 } });
  const stage = createLiveSitesStage({ universeDir, dataDir: root, env: {}, log: quiet, runDay: async () => ({ ok: true }) });
  const health = await stage.health();
  assert.equal(health.status, 'failed');
  assert.equal(health.judgeConfigured, false);
  assert.ok(health.alerts.some(a => a.includes('2026-10-25') && a.includes('40 of 40 rows unlabelled') && a.includes('timed out')), JSON.stringify(health.alerts));
  assert.equal(health.days[0].judgement.status, 'failed');
});

// ── Feed ───────────────────────────────────────────────────────────────────
test('feed serves legit/personal/content and unlabelled rows; withholds harmful labels and U+FFFD titles', async t => {
  const directory = await tmp(t, 'domainscout-judge-feed-');
  const day = '2026-10-25';
  const label = l => ({ judgement: { label: l, model: 'stub', version: judge.JUDGE_VERSION } });
  await writeDay(directory, day, [
    built('biz.com', label('legit_business')),
    built('club.org', label('personal_or_community')),
    built('news.net', label('content_or_media')),
    built('pending.com'),
    built('bet.com', label('gambling')),
    built('xxx.com', label('adult')),
    built('login-bank.com', label('scam_or_phishing')),
    built('seo.com', label('spam_template')),
    built('garbled.com', { title: 'Caf� ��' }),
  ]);
  const body = await createLiveSitesFeed({ universeDir: directory }).query({});
  assert.deepEqual(body.items.map(i => i.domain), ['biz.com', 'club.org', 'news.net', 'pending.com']);
  assert.ok(!JSON.stringify(body).includes('judgement'));
});

test('feed collapses a numbered domain series of 5+ names in a day; 4 stay', async t => {
  const directory = await tmp(t, 'domainscout-judge-series-');
  const day = '2026-10-25';
  const series = ['slot88.com', 'slot777.com', 'slot-1.net', 'slot2.com', 'slot99.org'].map((d, i) => built(d, { title: `Distinct title ${'abcde'[i]}` }));
  const small = ['shop1.com', 'shop2.com', 'shop3.com', 'shop4.com'].map((d, i) => built(d, { title: `Shop ${'abcd'[i]}` }));
  await writeDay(directory, day, [...series, ...small, built('plain.com')]);
  const body = await createLiveSitesFeed({ universeDir: directory }).query({});
  assert.deepEqual(body.items.map(i => i.domain), ['plain.com', 'shop1.com', 'shop2.com', 'shop3.com', 'shop4.com']);
});

// ── Kit collapse and titles in the stage ───────────────────────────────────
test('collapseKits marks a numbered series (same letters, differing digits) of 5+ as one kit', () => {
  assert.equal(ls.numberedSeriesKey('slot88.com'), 'slot');
  assert.equal(ls.numberedSeriesKey('slot-777.net'), 'slot');
  assert.equal(ls.numberedSeriesKey('acme.com'), null);
  assert.equal(ls.numberedSeriesKey('a1.com'), null);
  const records = ['bet1.com', 'bet22.com', 'bet333.net', 'bet4.org', 'bet55.com', 'win1.com', 'win2.com', 'acme.com'].map(domain => ({ domain, class: 'built', titleReal: true, fingerprint: { title: domain, skeleton: domain } }));
  const kits = ls.collapseKits(records, { kitThreshold: 5, kitTitleThreshold: 8, kitSeriesThreshold: 5 });
  assert.equal(kits.length, 1);
  assert.equal(kits[0].basis, 'series');
  assert.equal(kits[0].size, 5);
  assert.ok(records.slice(0, 5).every(r => r.kit?.basis === 'series'));
  assert.ok(records.slice(5).every(r => r.kit === null));
});

test('isRealTitle rejects titles containing U+FFFD', () => {
  assert.equal(ls.isRealTitle('Caf� Paris', 'cafe.com'), false);
  assert.equal(ls.isRealTitle('Café Paris', 'cafe.com'), true);
});

test('observeDay judges built rows with the injected model client and persists label + summary.judgement', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'domainscout-live-judge-day-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const day = '2026-10-24';
  const nsDir = path.join(directory, day, 'ns');
  await fs.mkdir(nsDir, { recursive: true });
  const names = ['acme-bakery.com', 'luckyspin-palace.com', 'riverside-chess.org'];
  await fs.writeFile(path.join(nsDir, 'movement.jsonl'), names.map(domain => JSON.stringify({ kind: 'changed', domain, selection: 'went-live', prev_class: 'registrar', today_class: 'hosting', today_ns: ['ns1.example-host.com'] })).join('\n') + '\n');
  await fs.writeFile(path.join(nsDir, 'summary.json'), JSON.stringify({ day }));
  const titles = { 'acme-bakery.com': 'Acme Bakery Portland', 'luckyspin-palace.com': 'Lucky Spin Palace Online', 'riverside-chess.org': 'Riverside Chess Club' };
  const fetchImpl = async url => {
    const host = new URL(url).hostname;
    const body = `<!doctype html><html><head><title>${titles[host]}</title><meta name="description" content="About ${host}"></head><body><main><h1>${titles[host]}</h1><p>${'Welcome to our place with friendly people and a lot to read about here. '.repeat(6)}</p></main></body></html>`;
    return new Response(body, { status: 200, headers: { 'content-type': 'text/html' } });
  };
  const calls = [];
  const client = stubClient({ 'luckyspin-palace.com': 'gambling', 'riverside-chess.org': 'personal_or_community' }, { calls });
  const { summary } = await ls.observeDay({ directory, day, fetchImpl, env: {}, config: { concurrency: 2 }, log: quiet, judgeClient: client });
  assert.equal(summary.status, 'complete');
  assert.equal(calls.length, 1, 'one batch for three rows');
  assert.equal(summary.judgement.status, 'complete');
  assert.equal(summary.judgement.labelled, 3);
  assert.equal(summary.judgement.withheld, 1);
  assert.equal(summary.judgement.counts.gambling, 1);
  assert.equal(summary.built.publishable, 2);
  const rows = (await fs.readFile(path.join(directory, day, 'sites', 'observations.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const byDomain = Object.fromEntries(rows.map(r => [r.domain, r]));
  assert.equal(byDomain['luckyspin-palace.com'].judgement.label, 'gambling');
  assert.equal(byDomain['acme-bakery.com'].judgement.label, 'legit_business');
  const body = await createLiveSitesFeed({ universeDir: directory }).query({});
  assert.deepEqual(body.items.map(i => i.domain).sort(), ['acme-bakery.com', 'riverside-chess.org']);
});
