'use strict';

// Out-of-process watchdog (bin/sale-watch-watchdog.js): repair escalation,
// its bound, issue open/update/close and loud secret failures. The freshness
// route, wave request, Railway restart and GitHub API are all injected; the
// clock is fake (sleep advances it), so nothing touches the network or rots.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const w = require('../bin/sale-watch-watchdog');

const T0 = Date.parse('2026-11-07T10:00:00.000Z');
const iso = ms => new Date(ms).toISOString();
const ENV = {
  DOMAINSCOUT_AGENT_TOKEN: 'agent-read-token-0000001',
  RAILWAY_API_TOKEN: 'railway-token-0000000001',
  DOMAINSCOUT_URL: 'https://domainscout.example',
  RAILWAY_SERVICE_ID: 'svc', RAILWAY_ENVIRONMENT_ID: 'env',
  GITHUB_TOKEN: 'gh-token', GITHUB_REPOSITORY: 'Oldshue/DomainScout',
};

function body(verdict, { checks = [], waveRunning = null } = {}) {
  return { schema: 'domainscout.sale-watch-freshness/v1', verdict, reasons: checks.filter(c => c.status !== 'ok').map(c => `${c.name}: ${c.detail}`), checks, waveRunning };
}
const STALE_WAVE = body('stale', { checks: [{ name: 'wave', status: 'stale', detail: 'last clean wave finished 300 min ago' }] });
const CURRENT = body('current', { checks: [{ name: 'wave', status: 'ok', detail: 'clean wave 10 min ago' }] });

// freshness: array of bodies (or 'down', or { http, raw } for a non-contract
// reply; raw undefined = a non-JSON body), consumed in order; the last repeats.
function harness({ freshness, waveStatus = 202, openIssue = null, restartAfter = null, restartError = null, health = null }) {
  let t = T0;
  let seq = [...freshness];
  const calls = { freshness: 0, wave: 0, restart: 0 };
  const extra = { health: 0, restartAt: null };
  const fetchImpl = async (url, opts = {}) => {
    if (url.endsWith(w.HEALTH_ROUTE)) {
      extra.health += 1;
      const h = health ? health(t, extra.restartAt) : { status: 200, body: { ok: true, uptimeSeconds: 99999 } };
      if (h === 'down') throw new Error('connect ECONNREFUSED');
      return { status: h.status, json: async () => h.body };
    }
    if (url.endsWith(w.WAVE_ROUTE)) {
      assert.equal(opts.method, 'POST');
      calls.wave += 1;
      return { status: waveStatus, json: async () => (waveStatus === 202 ? { started: true } : { started: false, reason: 'running' }) };
    }
    assert.ok(url.startsWith('https://domainscout.example' + w.FRESHNESS_ROUTE), url);
    assert.equal(opts.headers['x-domainscout-token'], ENV.DOMAINSCOUT_AGENT_TOKEN);
    calls.freshness += 1;
    const next = seq.length > 1 ? seq.shift() : seq[0];
    if (next === 'down') throw new Error('connect ECONNREFUSED');
    if (next && next.http) return { status: next.http, json: async () => { if (next.raw === undefined) throw new SyntaxError('Unexpected token <'); return next.raw; } };
    return { status: next.verdict === 'stale' && next.http503 ? 503 : 200, json: async () => next };
  };
  const railway = {
    restart: async () => {
      calls.restart += 1;
      extra.restartAt = t;
      if (restartAfter) { seq.length = 0; seq.push(...restartAfter); }
      if (restartError) throw restartError;
      return { deploymentId: 'dep-1' };
    },
  };
  const gh = {
    open: openIssue, events: [],
    async findOpenIssue() { return this.open; },
    async createIssue(title, text) { this.events.push(['create', title, text]); this.open = { number: 41 }; return { number: 41 }; },
    async updateIssue(n, text) { this.events.push(['update', n, text]); },
    async comment(n, text) { this.events.push(['comment', n, text]); },
    async closeIssue(n) { this.events.push(['close', n]); this.open = null; },
  };
  const errors = [];
  const run = state => w.runWatchdog({ env: ENV, fetchImpl, railway, github: gh, state, now: () => t, sleep: async ms => { t += ms; }, log: { log() {}, error(m) { errors.push(m); } } });
  return { run, calls, extra, errors, gh, advance: ms => { t += ms; }, now: () => t, setFreshness: list => { seq = [...list]; } };
}

test('a missing secret fails loudly (exit 2, summary says unknown), never a pass', async () => {
  for (const name of w.REQUIRED_SECRETS) {
    const env = { ...ENV, [name]: '' };
    assert.throws(() => w.checkConfig(env), err => err instanceof w.WatchdogConfigError && err.message.includes(name) && !err.message.includes(ENV[name] || '\u0000'));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-watchdog-'));
    const summary = path.join(dir, 'summary.md');
    const code = await w.main({ ...env, GITHUB_STEP_SUMMARY: summary, WATCHDOG_STATE_PATH: path.join(dir, 'state.json') });
    assert.equal(code, 2);
    assert.match(fs.readFileSync(summary, 'utf8'), /freshness: `unknown`[\s\S]*missing required secret/);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.throws(() => w.checkConfig({ ...ENV, DOMAINSCOUT_URL: 'http://plain.example' }), /https/);
});

test('current: no repair, exit 0, verdict in the summary', async () => {
  const h = harness({ freshness: [CURRENT] });
  const r = await h.run(null);
  assert.equal(r.exitCode, 0);
  assert.equal(r.verdict, 'current');
  assert.deepEqual(h.calls, { freshness: 1, wave: 0, restart: 0 });
  assert.match(r.summary, /^## Sale Watch freshness: `current`/);
  assert.equal(r.issue, null);
});

test('step 1: stale requests a wave; when the wave restores current there is no restart', async () => {
  const h = harness({ freshness: [STALE_WAVE, STALE_WAVE, CURRENT] });
  const r = await h.run(null);
  assert.equal(h.calls.wave, 1);
  assert.equal(h.calls.restart, 0);
  assert.equal(r.verdict, 'current');
  assert.equal(r.exitCode, 0);
  assert.equal(r.state.failingSince, null);
  assert.equal(r.state.waveRequestedSince, null);
});

test('step 2: waves still stale 75 min after the first request escalate to a Railway restart, even though later runs re-requested waves', async () => {
  const h = harness({ freshness: [STALE_WAVE], restartAfter: [CURRENT] });
  let state = null;
  // Runs every 15 minutes; each one re-requests a wave once the 30 min cooldown passes.
  for (let i = 0; i < 6; i += 1) {
    const r = await h.run(state);
    state = r.state;
    if (h.calls.restart) break;
    assert.equal(r.exitCode, 1);
    h.advance(15 * 60000);
  }
  assert.equal(h.calls.restart, 1, 'restarted once');
  assert.ok(h.calls.wave >= 2, 'waves were requested first');
  assert.equal(state.restarts.length, 1);
  assert.equal(state.lastVerdict, 'current');
});

test('an unreachable route counts as a failure; one blip never restarts, a sustained outage does', async () => {
  const h = harness({ freshness: ['down'], restartAfter: [CURRENT] });
  const first = await h.run(null);
  assert.equal(first.verdict, 'unreachable');
  assert.equal(first.exitCode, 1);
  assert.equal(h.calls.restart, 0, 'no restart on the first failing run');
  assert.equal(h.calls.freshness, w.OBSERVE_ATTEMPTS, 'retried before declaring it unreachable');
  h.advance(15 * 60000);
  const second = await h.run(first.state);
  assert.equal(h.calls.restart, 1);
  assert.equal(second.verdict, 'current');
  assert.equal(second.exitCode, 0);
});

test('the restart bound: cooldown and the daily cap withhold restarts and open one issue instead', async () => {
  // Cooldown: a restart 30 min ago.
  const cool = harness({ freshness: ['down'] });
  const r1 = await cool.run({ schema: w.STATE_SCHEMA, failingSince: iso(T0 - 60 * 60000), unreachableSince: iso(T0 - 60 * 60000), restarts: [iso(T0 - 30 * 60000)] });
  assert.equal(cool.calls.restart, 0);
  // The fake clock advances during observe retries, so the age is 30-31 min.
  assert.ok(r1.actions.some(a => /withheld: last restart 3[01] min ago \(cooldown 120 min\)/.test(a)), r1.actions.join('|'));
  assert.equal(r1.issue.action, 'opened');
  // Daily cap: three restarts in 24 h, the newest past the cooldown.
  const cap = harness({ freshness: ['down'], openIssue: { number: 41 } });
  const r2 = await cap.run({ schema: w.STATE_SCHEMA, failingSince: iso(T0 - 20 * 3600000), unreachableSince: iso(T0 - 20 * 3600000), restarts: [iso(T0 - 20 * 3600000), iso(T0 - 12 * 3600000), iso(T0 - 4 * 3600000)] });
  assert.equal(cap.calls.restart, 0);
  assert.ok(r2.actions.some(a => /3 restarts in 24 h \(cap 3\)/.test(a)), r2.actions.join('|'));
  assert.equal(r2.issue.action, 'updated', 'the one open issue is updated, never duplicated');
  assert.equal(cap.gh.events.filter(e => e[0] === 'create').length, 0);
  // Restarts older than 24 h fall out of the budget.
  assert.equal(w.restartBudget(w.normalizeState({ schema: w.STATE_SCHEMA, restarts: [iso(T0 - 25 * 3600000)] }), T0).allowed, true);
});

test('a healthy long pass is never restarted and gets no overlapping wave request; a stuck heartbeat is restarted', async () => {
  const longPass = body('stale', { checks: [{ name: 'wave', status: 'stale', detail: 'last clean wave finished 130 min ago' }], waveRunning: { healthy: true, stage: 'probe', startedAt: iso(T0 - 50 * 60000), lastHeartbeatAt: iso(T0 - 5000) } });
  const h = harness({ freshness: [longPass] });
  const r = await h.run({ schema: w.STATE_SCHEMA, failingSince: iso(T0 - 3 * 3600000), waveRequestedSince: iso(T0 - 3 * 3600000), lastWaveRequestAt: iso(T0 - 3 * 3600000) });
  assert.equal(h.calls.restart, 0);
  assert.equal(h.calls.wave, 0);
  assert.ok(r.actions.some(a => /healthy long pass/.test(a)));
  const stuck = body('stale', { checks: [{ name: 'wave-heartbeat', status: 'stale', detail: 'running wave silent for 600 s in probe' }], waveRunning: { healthy: false, stage: 'probe' } });
  const s = harness({ freshness: [stuck], waveStatus: 409, restartAfter: [CURRENT] });
  const rs = await s.run(null);
  assert.equal(s.calls.restart, 1, 'a stuck wave is restarted');
  assert.equal(rs.verdict, 'current');
});

test('issue: opened once not current past the bound, updated while failing, closed automatically on recovery', async () => {
  const degraded = body('degraded', { checks: [{ name: 'assessment-version', status: 'degraded', detail: 'stored assessments on v15, current v16' }] });
  const h = harness({ freshness: [degraded], waveStatus: 409 });
  const early = await h.run(null);
  assert.equal(early.issue, null, 'no issue before the repair bound');
  h.advance(w.ISSUE_AFTER_FAILING_MS);
  const opened = await h.run(early.state);
  assert.equal(opened.issue.action, 'opened');
  const created = h.gh.events.find(e => e[0] === 'create');
  assert.equal(created[1], w.ISSUE_TITLE);
  assert.match(created[2], /assessment-version/);
  h.advance(15 * 60000);
  const updated = await h.run(opened.state);
  assert.equal(updated.issue.action, 'updated');
  const rec = harness({ freshness: [CURRENT], openIssue: { number: 41 } });
  const closed = await rec.run(updated.state);
  assert.equal(closed.issue.action, 'closed');
  assert.deepEqual(rec.gh.events.map(e => e[0]), ['comment', 'close']);
  assert.equal(closed.state.failingSince, null);
});

test('a rejected agent token is reported and escalated, never restarted', async () => {
  const h = harness({ freshness: [CURRENT] });
  const r = await w.runWatchdog({
    env: ENV, railway: { restart: async () => { throw new Error('must not restart'); } }, github: h.gh,
    fetchImpl: async () => ({ status: 401, json: async () => ({ error: 'Unauthorized' }) }),
    now: () => T0, sleep: async () => {}, log: { log() {} },
  });
  assert.equal(r.exitCode, 1);
  assert.equal(r.issue.action, 'opened');
});

test('a reachable site whose route answers 404 has no freshness contract: reported loudly, never restarted, even past the window', async () => {
  const NOT_FOUND = { http: 404, raw: { error: 'not_found', path: w.FRESHNESS_ROUTE } };
  const h = harness({ freshness: [NOT_FOUND], restartAfter: [CURRENT] });
  let state = null;
  for (let i = 0; i < 4; i += 1) { // 45+ minutes of 404s
    const r = await h.run(state);
    state = r.state;
    assert.equal(r.verdict, 'no-contract');
    assert.equal(r.exitCode, 1);
    assert.ok(r.actions.some(a => /NO FRESHNESS CONTRACT \(not restarting\)/.test(a) && /HTTP 404/.test(a)), r.actions.join('|'));
    assert.equal(r.state.unreachableSince, null);
    assert.ok(r.issue && ['opened', 'updated'].includes(r.issue.action), 'issue opened/updated loudly');
    h.advance(15 * 60000);
  }
  assert.equal(h.calls.restart, 0, 'never restarted');
  assert.equal(h.calls.wave, 0, 'no wave request either');
  assert.equal(h.calls.freshness, 4, 'a definite answer is not retried');
  assert.ok(h.errors.some(m => /::error::/.test(m) && /no freshness contract/.test(m)));
  // A 200 SPA shell (non-JSON) and off-contract JSON are no-contract too.
  for (const reply of [{ http: 200 }, { http: 200, raw: { ok: true } }, { http: 410, raw: null }]) {
    const s = harness({ freshness: [reply] });
    const r = await s.run({ schema: w.STATE_SCHEMA, failingSince: iso(T0 - 3600000), unreachableSince: iso(T0 - 3600000) });
    assert.equal(r.verdict, 'no-contract', JSON.stringify(reply));
    assert.equal(s.calls.restart, 0);
    assert.equal(r.state.unreachableSince, null, 'a reachable reply resets the unreachable window');
  }
});

test('5xx without the contract is unreachable: restarted only after 10 consecutive minutes; a reachable reply in between resets the window', async () => {
  const BAD_GATEWAY = { http: 502, raw: { status: 'error', message: 'Application failed to respond' } };
  const h = harness({ freshness: [BAD_GATEWAY], restartAfter: [CURRENT] });
  const first = await h.run(null);
  assert.equal(first.verdict, 'unreachable');
  assert.equal(h.calls.freshness, w.OBSERVE_ATTEMPTS, '5xx is retried like a connection failure');
  assert.equal(h.calls.restart, 0);
  assert.ok(first.state.unreachableSince);
  // A 404 interlude: the site is reachable, the window resets.
  h.advance(8 * 60000);
  h.setFreshness([{ http: 404, raw: { error: 'not_found' } }]);
  const mid = await h.run(first.state);
  assert.equal(mid.state.unreachableSince, null);
  h.advance(7 * 60000);
  h.setFreshness([BAD_GATEWAY]);
  const again = await h.run(mid.state);
  assert.equal(h.calls.restart, 0, 'the window restarted at the 404; 15 min of mixed failures is not 10 min unreachable');
  h.advance(15 * 60000);
  const sustained = await h.run(again.state);
  assert.equal(h.calls.restart, 1, 'sustained 5xx restarts');
  assert.equal(sustained.verdict, 'current');
  assert.equal(sustained.state.lastRestart.confirmed, true);
});

test('a restart call that times out counts against the budget, is reported unconfirmed, and is confirmed from /api/health uptime', async () => {
  const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  const unreachable = { schema: w.STATE_SCHEMA, failingSince: iso(T0 - 3600000), unreachableSince: iso(T0 - 3600000) };
  // Fresh process: uptime counts from the restart request.
  const ok = harness({
    freshness: ['down'], restartAfter: [CURRENT], restartError: timeout,
    health: (t, at) => ({ status: 200, body: { ok: true, uptimeSeconds: Math.floor((t - at) / 1000) } }),
  });
  const r = await ok.run(unreachable);
  assert.equal(ok.calls.restart, 1);
  assert.equal(r.state.restarts.length, 1, 'counted against the budget');
  assert.ok(r.actions.some(a => /restart unconfirmed/.test(a)), r.actions.join('|'));
  assert.ok(r.actions.some(a => /restart confirmed: \/api\/health uptime/.test(a)), r.actions.join('|'));
  assert.ok(!r.actions.some(a => /restart failed/.test(a)), 'never logged as failed');
  assert.equal(r.state.lastRestart.confirmed, true);
  assert.equal(r.verdict, 'current');
  assert.ok(ok.extra.health >= 1);
  // The budget it spent blocks an immediate second restart.
  assert.equal(w.restartBudget(r.state, ok.now()).allowed, false);

  // Old process still serving: the restart stays unconfirmed and escalates.
  const stale = harness({ freshness: ['down'], restartError: timeout, health: () => ({ status: 200, body: { ok: true, uptimeSeconds: 99999 } }) });
  const s = await stale.run(unreachable);
  assert.equal(s.state.restarts.length, 1, 'still counted');
  assert.equal(s.state.lastRestart.confirmed, false);
  assert.ok(s.actions.some(a => /restart still unconfirmed: no fresh process/.test(a)), s.actions.join('|'));
  assert.equal(s.issue.action, 'opened');
  assert.match(stale.gh.events[0][2], /UNCONFIRMED/);

  // A definite failure (restart never sent) does not spend budget.
  const definite = Object.assign(new Error('Railway API HTTP 401'), { unconfirmed: false });
  const d = harness({ freshness: ['down'], restartError: definite });
  const rd = await d.run(unreachable);
  assert.equal(rd.state.restarts.length, 0);
  assert.ok(rd.actions.some(a => /restart failed: Railway API HTTP 401/.test(a)));
});

test('railwayClient marks a timed-out deploymentRestart unconfirmed and a failed lookup definite', async () => {
  const timeout = () => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  let n = 0;
  const fetchImpl = async () => {
    n += 1;
    if (n === 1) return { ok: true, status: 200, json: async () => ({ data: { deployments: { edges: [{ node: { id: 'dep-9', status: 'SUCCESS' } }] } } }) };
    throw timeout();
  };
  const client = w.railwayClient({ token: 't', serviceId: 's', environmentId: 'e', fetchImpl });
  await assert.rejects(client.restart(), err => err.unconfirmed === true && err.deploymentId === 'dep-9' && w.isRestartUnconfirmed(err));
  const lookupFails = w.railwayClient({ token: 't', serviceId: 's', environmentId: 'e', fetchImpl: async () => { throw timeout(); } });
  await assert.rejects(lookupFails.restart(), err => err.unconfirmed === false && !w.isRestartUnconfirmed(err));
});

test('a boot-time schema migration still running is reported pending: no wave request, no restart, even past the window', async () => {
  const PENDING = { ...body('stale'), http503: true, error: 'Sale Watch schema migration pending', migrationPending: { status: 'running', startedAt: iso(T0 - 3600000), attempts: 1, error: null } };
  const h = harness({ freshness: [PENDING], restartAfter: [CURRENT] });
  let state = { schema: w.STATE_SCHEMA, failingSince: iso(T0 - 3 * 3600000), unreachableSince: null };
  for (let i = 0; i < 3; i += 1) {
    const r = await h.run(state);
    state = r.state;
    assert.equal(r.verdict, 'stale');
    assert.ok(r.actions.some(a => /schema migration pending/.test(a) && /no restart/.test(a)), r.actions.join('|'));
    assert.equal(r.state.unreachableSince, null, 'a contract reply is reachable');
    h.advance(15 * 60000);
  }
  assert.equal(h.calls.restart, 0);
  assert.equal(h.calls.wave, 0);
  assert.equal(w.migrationPending({ body: PENDING }), true);
  assert.equal(w.restartReason({ kind: 'answered', verdict: 'stale', body: PENDING }, state, h.now()), null);
  // A finished (failed) migration is not pending: normal repair applies.
  assert.equal(w.migrationPending({ body: { ...PENDING, migrationPending: { status: 'failed' } } }), false);
});
