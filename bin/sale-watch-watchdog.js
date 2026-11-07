#!/usr/bin/env node
'use strict';

// Out-of-process Sale Watch watchdog (.github/workflows/sale-watch-watchdog.yml,
// every 15 minutes). Reads GET /api/sale-watch/freshness over HTTPS and
// repairs without a person:
//   1. not current          -> request a probe wave (POST /api/sale-watch/wave/run)
//   2. waves stuck / route  -> restart the Railway service (deploymentRestart)
//      does not answer
//   3. not current within   -> open or update ONE GitHub issue with the evidence;
//      the bound               it is closed automatically on recovery.
// A healthy long pass (a running wave with a fresh heartbeat) is never
// restarted. Restarts are bounded (cooldown + daily cap) through a state file
// the workflow carries between runs (actions/cache), so it cannot restart-loop.
// An unreachable site is a failure, never a pass. Missing secrets fail loudly.
//
// Every network call (freshness route, Railway API, GitHub API) is injected so
// tests/sale-watch-watchdog.test.js exercises the escalation without network.

const fs = require('node:fs');
const path = require('node:path');

const STATE_SCHEMA = 'domainscout.sale-watch-watchdog-state/v1';
const FRESHNESS_ROUTE = '/api/sale-watch/freshness';
const WAVE_ROUTE = '/api/sale-watch/wave/run';
const FRESHNESS_SCHEMA = 'domainscout.sale-watch-freshness/v1';

// ── Bounds ──────────────────────────────────────────────────────────────
const FETCH_TIMEOUT_MS = 20000;
/** Attempts per observation before the route counts as not answering. */
const OBSERVE_ATTEMPTS = 3;
const OBSERVE_RETRY_MS = 20000;
const POLL_INTERVAL_MS = 60000;
/** How long one run waits for a requested wave / a restart to restore current. */
const WAVE_RECOVERY_WAIT_MS = 5 * 60000;
const RESTART_RECOVERY_WAIT_MS = 6 * 60000;
/** At most one wave request per this window. */
const WAVE_REQUEST_COOLDOWN_MS = 30 * 60000;
/** Waves are stuck when a requested wave has had longer than one wave ceiling (55 min) and no clean wave followed. */
const WAVE_STUCK_AFTER_REQUEST_MS = 75 * 60000;
/** The route must have been failing at least this long before an unreachable site is restarted (no restart on one blip). */
const RESTART_UNREACHABLE_AFTER_MS = 10 * 60000;
const RESTART_COOLDOWN_MS = 2 * 60 * 60000;
const MAX_RESTARTS_PER_DAY = 3;
const DAY_MS = 24 * 60 * 60000;
/** Not current for this long (repairs included) opens/updates the issue. */
const ISSUE_AFTER_FAILING_MS = 45 * 60000;
const ISSUE_LABEL = 'sale-watch-freshness';
const ISSUE_TITLE = 'Sale Watch Probably sold is not current';

const REQUIRED_SECRETS = Object.freeze(['DOMAINSCOUT_AGENT_TOKEN', 'RAILWAY_API_TOKEN']);
const REQUIRED_CONFIG = Object.freeze(['DOMAINSCOUT_URL', 'RAILWAY_SERVICE_ID', 'RAILWAY_ENVIRONMENT_ID', 'GITHUB_TOKEN', 'GITHUB_REPOSITORY']);

class WatchdogConfigError extends Error {}

/** Throws WatchdogConfigError naming every missing secret/setting (never their values). */
function checkConfig(env) {
  const missing = [...REQUIRED_SECRETS, ...REQUIRED_CONFIG].filter(name => !String(env[name] || '').trim());
  if (missing.length) throw new WatchdogConfigError(`missing required secret/config: ${missing.join(', ')}`);
  const base = String(env.DOMAINSCOUT_URL).trim().replace(/\/+$/, '');
  if (!/^https:\/\//.test(base)) throw new WatchdogConfigError('DOMAINSCOUT_URL must be an https:// URL');
  return { base };
}

function emptyState() {
  // waveRequestedSince: first successful wave request of the current failing
  // episode. Later requests never reset it, so "waves stuck" stays measurable.
  return { schema: STATE_SCHEMA, failingSince: null, lastWaveRequestAt: null, waveRequestedSince: null, restarts: [], lastVerdict: null, lastCheckedAt: null };
}

function normalizeState(raw) {
  const s = raw && raw.schema === STATE_SCHEMA ? raw : {};
  return { ...emptyState(), ...s, restarts: Array.isArray(s.restarts) ? s.restarts.filter(x => Number.isFinite(Date.parse(x))) : [] };
}

// ── Observation ─────────────────────────────────────────────────────────

/** One GET of the freshness route: { kind: 'answered'|'unreachable'|'auth', verdict, body, httpStatus, error }. */
async function observeOnce({ base, token, fetchImpl }) {
  let response;
  try {
    response = await fetchImpl(base + FRESHNESS_ROUTE, { headers: { 'x-domainscout-token': token, accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (error) {
    return { kind: 'unreachable', verdict: 'unreachable', error: String((error && error.message) || error), httpStatus: null, body: null };
  }
  const httpStatus = response.status;
  if (httpStatus === 401 || httpStatus === 403) return { kind: 'auth', verdict: 'unreachable', httpStatus, error: `freshness route rejected the agent token (HTTP ${httpStatus})`, body: null };
  let body = null;
  try { body = await response.json(); } catch (_) { body = null; }
  if (!body || body.schema !== FRESHNESS_SCHEMA || !['current', 'degraded', 'stale'].includes(body.verdict)) {
    return { kind: 'unreachable', verdict: 'unreachable', httpStatus, error: `freshness route did not answer the contract (HTTP ${httpStatus})`, body: null };
  }
  return { kind: 'answered', verdict: body.verdict, httpStatus, body, error: null };
}

/** Retries an unreachable observation a few times so one blip is not an outage. */
async function observe(ctx) {
  let last = null;
  for (let i = 0; i < OBSERVE_ATTEMPTS; i += 1) {
    last = await observeOnce(ctx);
    if (last.kind !== 'unreachable') return last;
    if (i + 1 < OBSERVE_ATTEMPTS) await ctx.sleep(OBSERVE_RETRY_MS);
  }
  return last;
}

function check(obs, name) {
  return obs && obs.body && Array.isArray(obs.body.checks) ? obs.body.checks.find(c => c.name === name) || null : null;
}

/** A running wave with a fresh heartbeat: never restart, never request an overlapping wave. */
function healthyLongPass(obs) {
  return Boolean(obs && obs.body && obs.body.waveRunning && obs.body.waveRunning.healthy === true);
}

/** Why a restart is warranted, or null. Pure. */
function restartReason(obs, state, nowMs) {
  if (!obs || obs.kind === 'auth') return null; // a restart cannot fix credentials
  if (healthyLongPass(obs)) return null;
  const failingFor = state.failingSince ? nowMs - Date.parse(state.failingSince) : 0;
  if (obs.kind === 'unreachable') return failingFor >= RESTART_UNREACHABLE_AFTER_MS ? `route not answering for ${Math.round(failingFor / 60000)} min (${obs.error})` : null;
  const beat = check(obs, 'wave-heartbeat');
  if (beat && beat.status === 'stale') return `wave stuck: ${beat.detail}`;
  const wave = check(obs, 'wave');
  const since = state.waveRequestedSince || state.lastWaveRequestAt;
  if (wave && wave.status === 'stale' && since && nowMs - Date.parse(since) >= WAVE_STUCK_AFTER_REQUEST_MS) {
    return `waves stuck: first requested ${Math.round((nowMs - Date.parse(since)) / 60000)} min ago, still ${wave.detail}`;
  }
  return null;
}

/** { allowed, reason } for another restart under the cooldown and daily cap. Pure. */
function restartBudget(state, nowMs) {
  const recent = state.restarts.filter(at => nowMs - Date.parse(at) < DAY_MS).sort();
  if (recent.length >= MAX_RESTARTS_PER_DAY) return { allowed: false, reason: `${recent.length} restarts in 24 h (cap ${MAX_RESTARTS_PER_DAY})` };
  const last = recent[recent.length - 1];
  if (last && nowMs - Date.parse(last) < RESTART_COOLDOWN_MS) return { allowed: false, reason: `last restart ${Math.round((nowMs - Date.parse(last)) / 60000)} min ago (cooldown ${RESTART_COOLDOWN_MS / 60000} min)` };
  return { allowed: true, reason: null };
}

async function requestWave({ base, token, fetchImpl }) {
  try {
    const response = await fetchImpl(base + WAVE_ROUTE, { method: 'POST', headers: { 'x-domainscout-token': token, accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    let body = null;
    try { body = await response.json(); } catch (_) { body = null; }
    return { ok: response.status === 202, httpStatus: response.status, body };
  } catch (error) {
    return { ok: false, httpStatus: null, error: String((error && error.message) || error) };
  }
}

/** Polls until the verdict is current or the budget is spent; returns the last observation. */
async function waitForCurrent(ctx, budgetMs) {
  const until = ctx.now() + budgetMs;
  let obs = null;
  while (ctx.now() < until) {
    await ctx.sleep(POLL_INTERVAL_MS);
    obs = await observeOnce(ctx);
    if (obs.verdict === 'current') return obs;
    if (healthyLongPass(obs)) return obs; // a healthy pass is running; leave it alone
  }
  return obs;
}

// ── GitHub / Railway clients (default implementations) ───────────────────

function githubClient({ token, repo, fetchImpl }) {
  const api = async (method, p, body) => {
    const response = await fetchImpl(`https://api.github.com${p}`, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'content-type': 'application/json', 'user-agent': 'domainscout-sale-watch-watchdog' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`GitHub ${method} ${p.split('?')[0]}: HTTP ${response.status}`);
    return text ? JSON.parse(text) : null;
  };
  return {
    async findOpenIssue() {
      const list = await api('GET', `/repos/${repo}/issues?state=open&labels=${encodeURIComponent(ISSUE_LABEL)}&per_page=20`);
      return (list || []).find(issue => !issue.pull_request) || null;
    },
    createIssue: (title, body) => api('POST', `/repos/${repo}/issues`, { title, body, labels: [ISSUE_LABEL] }),
    updateIssue: (number, body) => api('PATCH', `/repos/${repo}/issues/${number}`, { body }),
    comment: (number, body) => api('POST', `/repos/${repo}/issues/${number}/comments`, { body }),
    closeIssue: number => api('PATCH', `/repos/${repo}/issues/${number}`, { state: 'closed', state_reason: 'completed' }),
  };
}

function railwayClient({ token, serviceId, environmentId, fetchImpl }) {
  const gql = async (query, variables) => {
    const response = await fetchImpl('https://backboard.railway.com/graphql/v2', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    let json = null;
    try { json = await response.json(); } catch (_) { json = null; }
    if (!response.ok || !json || json.errors) throw new Error(`Railway API HTTP ${response.status}${json && json.errors ? `: ${json.errors.map(e => e.message).join('; ')}` : ''}`);
    return json.data;
  };
  return {
    async restart() {
      const data = await gql('query($input: DeploymentListInput!) { deployments(first: 1, input: $input) { edges { node { id status createdAt } } } }',
        { input: { serviceId, environmentId, status: { in: ['SUCCESS'] } } });
      const node = data && data.deployments && data.deployments.edges && data.deployments.edges[0] && data.deployments.edges[0].node;
      if (!node) throw new Error('Railway API: no successful deployment to restart');
      await gql('mutation($id: String!) { deploymentRestart(id: $id) }', { id: node.id });
      return { deploymentId: node.id };
    },
  };
}

// ── Reporting ───────────────────────────────────────────────────────────

function evidenceMarkdown(report) {
  const obs = report.final || {};
  const lines = [
    `**Verdict:** \`${obs.verdict || 'unknown'}\` at ${report.checkedAt}`,
    `**Failing since:** ${report.state.failingSince || 'n/a'}`,
    '',
    '**Reasons**',
    ...((obs.body && obs.body.reasons) || [obs.error || 'none']).map(r => `- ${r}`),
    '',
    '**Repairs this run**',
    ...(report.actions.length ? report.actions.map(a => `- ${a}`) : ['- none']),
    `- restarts in last 24 h: ${report.state.restarts.length}`,
  ];
  if (obs.body && Array.isArray(obs.body.checks)) {
    lines.push('', '| check | status | detail |', '| --- | --- | --- |');
    for (const c of obs.body.checks) lines.push(`| ${c.name} | ${c.status} | ${String(c.detail || '').replace(/\|/g, '\\|')} |`);
  }
  return lines.join('\n');
}

// ── Run ─────────────────────────────────────────────────────────────────

/**
 * One watchdog run. Every dependency is injectable. Resolves with
 * { exitCode, verdict, actions, issue, state }; never rejects for an outage
 * (outages are reported), only for programming errors.
 */
async function runWatchdog({
  env = process.env, fetchImpl = fetch, sleep = ms => new Promise(r => setTimeout(r, ms)), now = () => Date.now(),
  railway = null, github = null, state: initialState = null, log = console,
} = {}) {
  const { base } = checkConfig(env);
  const ctx = { base, token: env.DOMAINSCOUT_AGENT_TOKEN, fetchImpl, sleep, now };
  const rail = railway || railwayClient({ token: env.RAILWAY_API_TOKEN, serviceId: env.RAILWAY_SERVICE_ID, environmentId: env.RAILWAY_ENVIRONMENT_ID, fetchImpl });
  const gh = github || githubClient({ token: env.GITHUB_TOKEN, repo: env.GITHUB_REPOSITORY, fetchImpl });
  const state = normalizeState(initialState);
  const actions = [];
  const iso = ms => new Date(ms).toISOString();
  state.restarts = state.restarts.filter(at => now() - Date.parse(at) < DAY_MS);

  let obs = await observe(ctx);
  const initialVerdict = obs.verdict;
  if (obs.verdict !== 'current' && !state.failingSince) state.failingSince = iso(now());

  let restartBlocked = null;
  if (obs.verdict !== 'current' && obs.kind !== 'auth') {
    if (healthyLongPass(obs)) {
      actions.push(`healthy long pass running (stage ${obs.body.waveRunning.stage || 'unknown'}); no wave request, no restart`);
    } else {
      // Step 1: request a wave (the route answers; a wave is not running).
      if (obs.kind === 'answered') {
        const due = !state.lastWaveRequestAt || now() - Date.parse(state.lastWaveRequestAt) >= WAVE_REQUEST_COOLDOWN_MS;
        if (due) {
          const result = await requestWave(ctx);
          actions.push(`requested a wave: ${result.ok ? 'started' : `not started (HTTP ${result.httpStatus || 'n/a'}${result.body && result.body.reason ? `, ${result.body.reason}` : ''}${result.error ? `, ${result.error}` : ''})`}`);
          if (result.ok) { state.lastWaveRequestAt = iso(now()); if (!state.waveRequestedSince) state.waveRequestedSince = state.lastWaveRequestAt; }
          if (result.ok) { const after = await waitForCurrent(ctx, WAVE_RECOVERY_WAIT_MS); if (after) obs = after; }
        } else actions.push(`wave already requested at ${state.lastWaveRequestAt}`);
      }
      // Step 2: restart when waves are stuck or the route does not answer.
      const reason = obs.verdict === 'current' ? null : restartReason(obs, state, now());
      if (reason) {
        const budget = restartBudget(state, now());
        if (!budget.allowed) { restartBlocked = budget.reason; actions.push(`restart warranted (${reason}) but withheld: ${budget.reason}`); }
        else {
          try {
            const result = await rail.restart();
            state.restarts.push(iso(now()));
            // A restart starts a fresh wave episode; the cooldown and daily cap bound the next one.
            state.waveRequestedSince = null;
            actions.push(`restarted Railway deployment ${result && result.deploymentId ? result.deploymentId : ''}: ${reason}`.replace('  ', ' '));
            const after = await waitForCurrent(ctx, RESTART_RECOVERY_WAIT_MS);
            if (after) obs = after;
          } catch (error) {
            restartBlocked = `restart failed: ${error.message}`;
            actions.push(restartBlocked);
          }
        }
      }
    }
  } else if (obs.kind === 'auth') actions.push(obs.error);

  const recovered = obs.verdict === 'current';
  const report = { checkedAt: iso(now()), initialVerdict, final: obs, actions, state };
  let issue = null;
  try {
    const open = await gh.findOpenIssue();
    if (recovered) {
      if (open) {
        await gh.comment(open.number, `Recovered: verdict \`current\` at ${report.checkedAt}.\n\n${evidenceMarkdown(report)}`);
        await gh.closeIssue(open.number);
        issue = { action: 'closed', number: open.number };
      }
    } else {
      const failingFor = now() - Date.parse(state.failingSince);
      const escalate = failingFor >= ISSUE_AFTER_FAILING_MS || Boolean(restartBlocked) || obs.kind === 'auth';
      if (escalate) {
        const body = `The Sale Watch watchdog could not restore \`current\` within its repair bound.\n\n${evidenceMarkdown(report)}`;
        if (open) { await gh.updateIssue(open.number, body); issue = { action: 'updated', number: open.number }; }
        else { const created = await gh.createIssue(ISSUE_TITLE, body); issue = { action: 'opened', number: created && created.number }; }
      }
    }
  } catch (error) {
    issue = { action: 'failed', error: error.message };
    actions.push(`GitHub issue update failed: ${error.message}`);
  }

  if (recovered) { state.failingSince = null; state.waveRequestedSince = null; }
  state.lastVerdict = obs.verdict;
  state.lastCheckedAt = report.checkedAt;
  const exitCode = recovered ? 0 : 1;
  const summary = [`## Sale Watch freshness: \`${obs.verdict}\``, '', evidenceMarkdown(report), '', `Issue: ${issue ? `${issue.action}${issue.number ? ` #${issue.number}` : ''}${issue.error ? ` (${issue.error})` : ''}` : 'none'}`].join('\n');
  log.log(`[sale-watch-watchdog] verdict ${obs.verdict} (was ${initialVerdict}); ${actions.join('; ') || 'no repair'}`);
  return { exitCode, verdict: obs.verdict, initialVerdict, actions, issue, state, summary };
}

function readStateFile(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}
function writeStateFile(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

async function main(env = process.env) {
  const summaryFile = env.GITHUB_STEP_SUMMARY;
  const appendSummary = text => { if (summaryFile) fs.appendFileSync(summaryFile, text + '\n'); };
  const stateFile = path.resolve(env.WATCHDOG_STATE_PATH || '.sale-watch-watchdog/state.json');
  try {
    const result = await runWatchdog({ env, state: readStateFile(stateFile) });
    writeStateFile(stateFile, result.state);
    appendSummary(result.summary);
    return result.exitCode;
  } catch (error) {
    const message = error instanceof WatchdogConfigError ? `configuration error: ${error.message}` : `watchdog error: ${error.message}`;
    console.error(`::error::Sale Watch watchdog ${message}`);
    appendSummary(`## Sale Watch freshness: \`unknown\`\n\nWatchdog ${message}`);
    return 2;
  }
}

if (require.main === module) {
  main().then(code => { process.exitCode = code; });
}

module.exports = {
  STATE_SCHEMA, FRESHNESS_ROUTE, WAVE_ROUTE, REQUIRED_SECRETS, REQUIRED_CONFIG, ISSUE_LABEL, ISSUE_TITLE,
  OBSERVE_ATTEMPTS, POLL_INTERVAL_MS, WAVE_RECOVERY_WAIT_MS, RESTART_RECOVERY_WAIT_MS, WAVE_REQUEST_COOLDOWN_MS,
  WAVE_STUCK_AFTER_REQUEST_MS, RESTART_UNREACHABLE_AFTER_MS, RESTART_COOLDOWN_MS, MAX_RESTARTS_PER_DAY, ISSUE_AFTER_FAILING_MS,
  WatchdogConfigError, checkConfig, normalizeState, observeOnce, observe, healthyLongPass, restartReason, restartBudget,
  githubClient, railwayClient, runWatchdog, main,
};
