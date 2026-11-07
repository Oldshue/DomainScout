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
// Only a real connection failure or an HTTP 5xx without the contract counts as
// unreachable, and a restart needs RESTART_UNREACHABLE_AFTER_MS of consecutive
// unreachable observations (state.unreachableSince; any reachable reply resets
// it). A reachable site whose route answers 404 or anything outside the
// contract is a build with NO freshness contract: reported loudly (::error::,
// issue) and never restarted. A Railway restart call that times out may still
// have restarted the service: it counts against the restart budget, is
// reported as unconfirmed, and /api/health uptime is then polled to confirm
// whether the deployment actually restarted.
//
// Every network call (freshness route, Railway API, GitHub API) is injected so
// tests/sale-watch-watchdog.test.js exercises the escalation without network.

const fs = require('node:fs');
const path = require('node:path');

const STATE_SCHEMA = 'domainscout.sale-watch-watchdog-state/v1';
const FRESHNESS_ROUTE = '/api/sale-watch/freshness';
const WAVE_ROUTE = '/api/sale-watch/wave/run';
const FRESHNESS_SCHEMA = 'domainscout.sale-watch-freshness/v1';
const HEALTH_ROUTE = '/api/health';

// ── Bounds ──────────────────────────────────────────────────────────────
const FETCH_TIMEOUT_MS = 20000;
/** Attempts per observation before the route counts as not answering. */
const OBSERVE_ATTEMPTS = 3;
const OBSERVE_RETRY_MS = 20000;
const POLL_INTERVAL_MS = 60000;
/** How long one run waits for a requested wave / a restart to restore current. */
const WAVE_RECOVERY_WAIT_MS = 5 * 60000;
const RESTART_RECOVERY_WAIT_MS = 6 * 60000;
/** After an unconfirmed (timed-out) restart call, how long /api/health uptime is polled for a fresh process. */
const RESTART_CONFIRM_WAIT_MS = 3 * 60000;
const RESTART_CONFIRM_POLL_MS = 15000;
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
  // unreachableSince: first observation of the current run of consecutive
  // connection failures / 5xx. Any reachable reply clears it.
  return { schema: STATE_SCHEMA, failingSince: null, unreachableSince: null, lastWaveRequestAt: null, waveRequestedSince: null, restarts: [], lastRestart: null, lastVerdict: null, lastCheckedAt: null };
}

function normalizeState(raw) {
  const s = raw && raw.schema === STATE_SCHEMA ? raw : {};
  return { ...emptyState(), ...s, restarts: Array.isArray(s.restarts) ? s.restarts.filter(x => Number.isFinite(Date.parse(x))) : [] };
}

// ── Observation ─────────────────────────────────────────────────────────

/**
 * One GET of the freshness route: { kind: 'answered'|'unreachable'|'no-contract'|'auth', verdict, body, httpStatus, error }.
 * unreachable = connection failure or 5xx without the contract; no-contract =
 * the site answered (404, HTML, other JSON) but this build has no freshness route.
 */
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
  if (body && body.schema === FRESHNESS_SCHEMA && ['current', 'degraded', 'stale'].includes(body.verdict)) {
    return { kind: 'answered', verdict: body.verdict, httpStatus, body, error: null };
  }
  if (httpStatus >= 500) {
    return { kind: 'unreachable', verdict: 'unreachable', httpStatus, error: `freshness route answered HTTP ${httpStatus} without the contract`, body: null };
  }
  return {
    kind: 'no-contract', verdict: 'no-contract', httpStatus, body: null,
    error: `this build has no freshness contract: ${FRESHNESS_ROUTE} answered HTTP ${httpStatus}${body && body.error ? ` (${body.error})` : ''} from a reachable site; not restarting`,
  };
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

/** The boot-time schema migration is still running off-main: report pending, never restart or request a wave. */
function migrationPending(obs) {
  return Boolean(obs && obs.body && obs.body.migrationPending && obs.body.migrationPending.status === 'running');
}

/** Why a restart is warranted, or null. Pure. */
function restartReason(obs, state, nowMs) {
  if (!obs || obs.kind === 'auth') return null; // a restart cannot fix credentials
  if (obs.kind === 'no-contract') return null; // a restart cannot add a route the build lacks
  if (healthyLongPass(obs)) return null;
  if (migrationPending(obs)) return null; // a restart would only re-run the migration from the start
  if (obs.kind === 'unreachable') {
    const unreachableFor = state.unreachableSince ? nowMs - Date.parse(state.unreachableSince) : 0;
    return unreachableFor >= RESTART_UNREACHABLE_AFTER_MS ? `route not answering for ${Math.round(unreachableFor / 60000)} min (${obs.error})` : null;
  }
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

// ── Restart confirmation ────────────────────────────────────────────────

function isTimeoutError(error) {
  if (!error) return false;
  if (error.name === 'TimeoutError' || error.name === 'AbortError') return true;
  if (error.cause && error.cause !== error && isTimeoutError(error.cause)) return true;
  return /timed? ?out|timeout|aborted/i.test(String(error.message || ''));
}

/** A restart call whose outcome is unknown (it may have restarted the service). */
function isRestartUnconfirmed(error) {
  return Boolean(error) && (error.unconfirmed === true || (error.unconfirmed !== false && isTimeoutError(error)));
}

async function readHealth({ base, fetchImpl }) {
  try {
    const response = await fetchImpl(base + HEALTH_ROUTE, { headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    let body = null;
    try { body = await response.json(); } catch (_) { body = null; }
    return { httpStatus: response.status, body, error: null };
  } catch (error) {
    return { httpStatus: null, body: null, error: String((error && error.message) || error) };
  }
}

/**
 * Polls /api/health until the serving process is younger than the restart
 * request (uptime <= time since the request) or the budget is spent.
 * Resolves { confirmed, evidence }; never rejects.
 */
async function confirmRestart(ctx, requestedAtMs, budgetMs = RESTART_CONFIRM_WAIT_MS) {
  const until = ctx.now() + budgetMs;
  let last = null;
  for (;;) {
    const health = await readHealth(ctx);
    const up = health.body && Number.isFinite(Number(health.body.uptimeSeconds)) ? Number(health.body.uptimeSeconds) : null;
    const since = ctx.now() - requestedAtMs;
    if (up != null && up * 1000 <= since) {
      return { confirmed: true, evidence: `/api/health uptime ${up}s, ${Math.round(since / 1000)}s after the restart request` };
    }
    last = up != null ? `/api/health uptime ${up}s predates the restart request` : `/api/health ${health.httpStatus ? `HTTP ${health.httpStatus}` : `unreachable (${health.error})`}`;
    if (ctx.now() >= until) break;
    await ctx.sleep(RESTART_CONFIRM_POLL_MS);
  }
  return { confirmed: false, evidence: `no fresh process within ${Math.round(budgetMs / 60000)} min (last: ${last})` };
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
      let data;
      try {
        data = await gql('query($input: DeploymentListInput!) { deployments(first: 1, input: $input) { edges { node { id status createdAt } } } }',
          { input: { serviceId, environmentId, status: { in: ['SUCCESS'] } } });
      } catch (error) {
        // The restart was never sent: a definite failure, not unconfirmed.
        error.unconfirmed = false;
        throw error;
      }
      const node = data && data.deployments && data.deployments.edges && data.deployments.edges[0] && data.deployments.edges[0].node;
      if (!node) { const error = new Error('Railway API: no successful deployment to restart'); error.unconfirmed = false; throw error; }
      try {
        await gql('mutation($id: String!) { deploymentRestart(id: $id) }', { id: node.id });
      } catch (error) {
        if (isTimeoutError(error)) {
          const unconfirmed = new Error(`deploymentRestart ${node.id} timed out (${error.message || error.name})`);
          unconfirmed.unconfirmed = true;
          unconfirmed.deploymentId = node.id;
          throw unconfirmed;
        }
        error.unconfirmed = false;
        throw error;
      }
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
  if (report.state.lastRestart) {
    const r = report.state.lastRestart;
    lines.push(`- last restart: ${r.at} (${r.confirmed ? 'confirmed' : 'UNCONFIRMED'}${r.evidence ? `: ${r.evidence}` : ''})`);
  }
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

  const observedFrom = now();
  let obs = await observe(ctx);
  const initialVerdict = obs.verdict;
  if (obs.verdict !== 'current' && !state.failingSince) state.failingSince = iso(now());
  // Consecutive-unreachable window: only connection failures / 5xx extend it.
  if (obs.kind === 'unreachable') { if (!state.unreachableSince) state.unreachableSince = iso(observedFrom); }
  else state.unreachableSince = null;

  let restartBlocked = null;
  if (obs.kind === 'no-contract') {
    actions.push(`NO FRESHNESS CONTRACT (not restarting): ${obs.error}`);
    (log.error || log.log).call(log, `::error::Sale Watch watchdog: ${obs.error}`);
  } else if (obs.verdict !== 'current' && obs.kind !== 'auth') {
    if (migrationPending(obs)) {
      actions.push(`schema migration pending (started ${obs.body.migrationPending.startedAt || 'unknown'}, attempt ${obs.body.migrationPending.attempts || '?'}); no wave request, no restart`);
    } else if (healthyLongPass(obs)) {
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
          const requestedAt = now();
          try {
            const result = await rail.restart();
            state.restarts.push(iso(requestedAt));
            state.lastRestart = { at: iso(requestedAt), confirmed: true, evidence: 'Railway accepted deploymentRestart', reason };
            // A restart starts a fresh wave episode; the cooldown and daily cap bound the next one.
            state.waveRequestedSince = null;
            actions.push(`restarted Railway deployment ${result && result.deploymentId ? result.deploymentId : ''}: ${reason}`.replace('  ', ' '));
            const after = await waitForCurrent(ctx, RESTART_RECOVERY_WAIT_MS);
            if (after) obs = after;
          } catch (error) {
            if (isRestartUnconfirmed(error)) {
              // The call may have restarted the service: it spends budget either way.
              state.restarts.push(iso(requestedAt));
              state.waveRequestedSince = null;
              actions.push(`restart unconfirmed: Railway call did not answer (${error.message}); counted against the restart budget: ${reason}`);
              const confirmation = await confirmRestart(ctx, requestedAt);
              state.lastRestart = { at: iso(requestedAt), confirmed: confirmation.confirmed, evidence: confirmation.evidence, reason };
              if (confirmation.confirmed) {
                actions.push(`restart confirmed: ${confirmation.evidence}`);
                const after = await waitForCurrent(ctx, RESTART_RECOVERY_WAIT_MS);
                if (after) obs = after;
              } else {
                restartBlocked = `restart still unconfirmed: ${confirmation.evidence}`;
                actions.push(restartBlocked);
              }
            } else {
              restartBlocked = `restart failed: ${error.message}`;
              actions.push(restartBlocked);
            }
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
      const escalate = failingFor >= ISSUE_AFTER_FAILING_MS || Boolean(restartBlocked) || obs.kind === 'auth' || obs.kind === 'no-contract';
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
  STATE_SCHEMA, FRESHNESS_ROUTE, WAVE_ROUTE, HEALTH_ROUTE, REQUIRED_SECRETS, REQUIRED_CONFIG, ISSUE_LABEL, ISSUE_TITLE,
  OBSERVE_ATTEMPTS, POLL_INTERVAL_MS, WAVE_RECOVERY_WAIT_MS, RESTART_RECOVERY_WAIT_MS, WAVE_REQUEST_COOLDOWN_MS,
  WAVE_STUCK_AFTER_REQUEST_MS, RESTART_UNREACHABLE_AFTER_MS, RESTART_COOLDOWN_MS, MAX_RESTARTS_PER_DAY, ISSUE_AFTER_FAILING_MS,
  RESTART_CONFIRM_WAIT_MS, RESTART_CONFIRM_POLL_MS,
  WatchdogConfigError, checkConfig, normalizeState, observeOnce, observe, healthyLongPass, migrationPending, restartReason, restartBudget,
  isTimeoutError, isRestartUnconfirmed, confirmRestart,
  githubClient, railwayClient, runWatchdog, main,
};
