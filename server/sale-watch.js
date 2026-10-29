'use strict';

const { assessSaleEntry, matchesSaleView, evidenceRank, isAlphaEntry, VERSION } = require('./sale-watch-evidence');
const { signalWeight, SIGNAL_POLICY_NOTE } = require('./domain-signal-policy');
const { SELLER_PARKING_NAMESERVERS } = require('./zone-ns-universe');

const fs = require('fs');
const path = require('path');

const DEFAULT_LEDGER_PATH = path.join(__dirname, '../config/sale-watch-ledger.json');
const DEFAULT_DISCOVERY_PATH = path.join(
  process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, '../data'),
  'sale-watch-discovery.json'
);

function normalizeStringList(value) {
  if (!Array.isArray(value)) return [];
  return value.map(item => String(item || '').trim()).filter(Boolean);
}

function normalizeEntry(entry) {
  const domain = String(entry?.domain || '').trim().toLowerCase();
  if (!/^[a-z0-9.-]+\.[a-z0-9-]+$/i.test(domain)) return null;
  const tier = ['verified', 'probable', 'suspected', 'transfer', 'excluded'].includes(entry.tier) ? entry.tier : 'suspected';
  return {
    domain,
    tier,
    classification: entry.classification || null,
    assessment: entry.assessment || null,
    reconstruction: entry.reconstruction || null,
    buyer: String(entry.buyer || 'Buyer not yet identified').trim(),
    reportDate: String(entry.reportDate || '').trim() || null,
    reportedPriceUsd: entry.reportedPriceUsd != null && entry.reportedPriceUsd !== '' && Number.isFinite(Number(entry.reportedPriceUsd))
      ? Number(entry.reportedPriceUsd)
      : null,
    venue: String(entry.venue || '').trim() || null,
    precision: String(entry.precision || (tier === 'verified' ? 'day-level' : 'bounded')).trim(),
    sellerNameservers: normalizeStringList(entry.sellerNameservers),
    buyerNameservers: normalizeStringList(entry.buyerNameservers),
    buyerTitle: String(entry.buyerTitle || '').trim() || null,
    buyerUrl: String(entry.buyerUrl || '').trim() || `https://${domain}/`,
    sourceUrl: String(entry.sourceUrl || '').trim() || null,
    rationale: String(entry.rationale || '').trim(),
    firstObservedAt: String(entry.firstObservedAt || '').trim() || null,
    lastObservedAt: String(entry.lastObservedAt || '').trim() || null,
    observationCount: Number.isFinite(Number(entry.observationCount)) ? Number(entry.observationCount) : null,
    observationStatus: String(entry.observationStatus || '').trim() || null,
    discovery: entry.discovery && typeof entry.discovery === 'object' ? entry.discovery : null,
    // A leads row merged from the candidate tape for the same q/window.
    ...(entry.tapeMatch && typeof entry.tapeMatch === 'object' ? { tapeMatch: entry.tapeMatch } : {}),
  };
}

function resolveLedgerPath() {
  const configured = String(process.env.DOMAINSCOUT_SALE_WATCH_LEDGER_PATH || '').trim();
  return configured ? path.resolve(configured) : DEFAULT_LEDGER_PATH;
}

function resolveDiscoveryPath() {
  const configured = String(process.env.DOMAINSCOUT_SALE_WATCH_DISCOVERY_PATH || '').trim();
  return configured ? path.resolve(configured) : DEFAULT_DISCOVERY_PATH;
}

function readOptionalDiscovery(filePath) {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return value && typeof value === 'object' ? value : null;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function recencyKey(entry) {
  const raw = entry.reportDate || '';
  return String(raw).slice(0, 10);
}

// Stage 2b: readSaleWatchLedger gains an optional third source — a
// reconstructionEntries array (already shaped like normalizeEntry's output by
// server/sale-watch-reconstruction.js's readReconstructionEntries). These are
// merged into byDomain AFTER the seed ledger and discovery entries, and never
// overwrite an existing domain row (seed/discovery evidence always wins a
// conflict). Counts and the recency-first sort apply unchanged. Backward
// compatible: callers that omit the third argument default to [].
function readSaleWatchLedger(
  filePath = resolveLedgerPath(),
  discoveryPath = resolveDiscoveryPath(),
  reconstructionEntries = []
) {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const discovery = readOptionalDiscovery(discoveryPath);
  const byDomain = new Map();
  for (const entry of Array.isArray(raw.entries) ? raw.entries : []) {
    const normalized = normalizeEntry(entry);
    if (normalized) byDomain.set(normalized.domain, normalized);
  }
  for (const entry of Array.isArray(discovery?.entries) ? discovery.entries : []) {
    const normalized = normalizeEntry(entry);
    if (normalized && (!byDomain.has(normalized.domain) || byDomain.get(normalized.domain).discovery)) byDomain.set(normalized.domain, normalized);
  }
  for (const entry of [...(discovery?.ruledOut || []), ...(discovery?.retiredEntries || []).filter(row => !(discovery?.entries || []).some(current => current.domain === row.domain)).map(row => ({ ...row, tier: 'excluded', discovery: row.latestEvidence || row.discovery }))]) {
    const normalized = normalizeEntry(entry);
    if (!normalized) continue;
    const prior = byDomain.get(normalized.domain);
    if (!prior || prior.discovery) byDomain.set(normalized.domain, normalized);
  }
  // Rows read from the stored assessment (entry.storedAssessment) already carry
  // the adjudicator's tier/classification/rationale; they are never re-assessed
  // per request, and an older-VERSION row keeps serving until the worker replaces it.
  const storedRows = new Set();
  for (const entry of Array.isArray(reconstructionEntries) ? reconstructionEntries : []) {
    const normalized = normalizeEntry(entry);
    if (normalized && entry.storedAssessment) storedRows.add(normalized);
    if (normalized && (!byDomain.has(normalized.domain) || (byDomain.get(normalized.domain).discovery && String(normalized.lastObservedAt||'') >= String(byDomain.get(normalized.domain).lastObservedAt||'')))) byDomain.set(normalized.domain, normalized);
    else if(normalized?.reconstruction && byDomain.get(normalized.domain)?.discovery){const current=byDomain.get(normalized.domain);byDomain.set(normalized.domain,{...current,reconstruction:normalized.reconstruction});}
  }
  // Re-adjudicate all stored sources and expose exclusions instead of laundering old labels.
  for (const [domain, entry] of byDomain) {
    const assessed = storedRows.has(entry) ? entry : assessSaleEntry(entry);
    // Old discovery files are audit evidence too; they must not re-admit signals
    // that the queue's owner policy excludes. Keep them in the excluded view.
    byDomain.set(domain, signalWeight(domain.split('.').at(-1)) === 0
      ? { ...assessed, tier: 'excluded', classification: 'policy-excluded', rationale: `${SIGNAL_POLICY_NOTE} ${assessed.rationale || ''}`.trim() }
      : assessed);
  }
  const allEntries = [...byDomain.values()]
    .sort((a, b) => {
      const aKey = recencyKey(a);
      const bKey = recencyKey(b);
      if (aKey !== bKey) {
        if (!aKey) return 1;
        if (!bKey) return -1;
        return bKey.localeCompare(aKey);
      }
      const rankDiff = evidenceRank(a) - evidenceRank(b);
      if (rankDiff !== 0) return rankDiff;
      const lengthDiff = a.domain.length - b.domain.length;
      if (lengthDiff !== 0) return lengthDiff;
      return a.domain < b.domain ? -1 : a.domain > b.domain ? 1 : 0;
    });
  const excludedEntries = allEntries.filter(row => row.tier === 'excluded');
  const entries = allEntries.filter(row => row.tier !== 'excluded');
  const verified = entries.filter(row => row.tier === 'verified').length;
  const probable = entries.filter(row => row.tier === 'probable').length;
  const suspected = entries.filter(row => row.tier === 'suspected').length;
  return {
    schema: 'domainscout.sale-watch-ledger/v1',
    classifierVersion: VERSION,
    excludedEntries,
    excludedCount: excludedEntries.length,
    transferCount: entries.filter(row => row.tier === 'transfer').length,
    generatedAt: [raw.generatedAt, discovery?.generatedAt].filter(Boolean).sort().at(-1) || null,
    window: raw.window || null,
    coverage: {
      ...(raw.coverage || {}),
      nameserverDiscovery: discovery?.coverage || null,
      nameserverDeparturesInspected: Number(discovery?.coverage?.uniqueDeparturesInspected || 0),
      nameserverAssociationsExposed: Number(discovery?.coverage?.reverseAssociationsExposed || 0),
      discoveryMode: discovery?.mode || 'awaiting-first-scan',
    },
    counts: {
      verified,
      probable,
      suspected,
      admitted: entries.length,
      auctionPricesShown: 0,
    },
    entries,
  };
}

// Merge retained evidence and reconstruction into a single chronological page.
// Cursor keys use the displayed departure date, never the latest probe date.
function pageSaleLedger(ledger, reconstructionEntries, { view = 'all', q = '', after = null, pageSize = 500, scanLimit = 1000 } = {}) {
  // q matches only buyer-meaningful text (domain, label words, observed site
  // text, theme families) -- never JSON keys, classifier reasons,
  // counterEvidence, nameservers or registrars.
  const { buildSearchDocument, matchDocument } = require('./sale-watch-search');
  const needle = String(q || '').trim().toLowerCase();
  const matchFor = entry => matchDocument(buildSearchDocument(entry.domain, entry), needle, entry.domain);
  const key = entry => ({ date: recencyKey(entry), rank: evidenceRank(entry), domain: entry.domain });
  const compare = (a, b) => b.date.localeCompare(a.date)
    || ((a.rank || 0) - (b.rank || 0))
    || (a.domain.length - b.domain.length)
    || (a.domain < b.domain ? -1 : a.domain > b.domain ? 1 : 0);
  const boundary = reconstructionEntries.length === scanLimit ? key(reconstructionEntries.at(-1)) : null;
  const rows = [...ledger.entries, ...ledger.excludedEntries].filter(entry => {
    const position = key(entry);
    // Tape-merged leads rows (same q and window as /api/sale-watch/candidates)
    // stay in leads even before their classification marks them as a lead.
    const tapeLead = view === 'leads' && needle && entry.tapeMatch;
    if (!matchesSaleView(entry, view) && !tapeLead) return false;
    if (needle) {
      const match = matchFor(entry) || (tapeLead && entry.tapeMatch.matchedOn
        ? { matchedOn: entry.tapeMatch.matchedOn, matchedTerm: entry.tapeMatch.matchedTerm || needle } : null);
      if (!match) return false;
      entry.matchedOn = match.matchedOn;
      entry.matchedTerm = match.matchedTerm;
    }
    return true
      && (!after || compare(position, after) > 0)
      && (!boundary || compare(position, boundary) <= 0);
  }).sort((a,b) => compare(key(a),key(b)));
  const page = rows.slice(0,pageSize);
  const more = rows.length > pageSize || !!boundary;
  const last = rows.length > pageSize ? key(page.at(-1)) : boundary;
  ledger.entries = page.filter(entry => entry.tier !== 'excluded');
  ledger.excludedEntries = page.filter(entry => entry.tier === 'excluded');
  ledger.view = view;
  ledger.counts = { verified: page.filter(e=>e.tier==='verified').length, probable: page.filter(e=>e.tier==='probable').length, suspected: page.filter(e=>e.tier==='suspected').length, admitted: ledger.entries.length, auctionPricesShown: 0 };
  ledger.transferCount = page.filter(e=>e.tier==='transfer').length;
  ledger.excludedCount = ledger.excludedEntries.length;
  ledger.pagination = { pageSize, nextCursor: more && last ? Buffer.from(JSON.stringify(last)).toString('base64url') : null };
  return ledger;
}

// Compact agent-page surface: /api/sale-watch?days=N&compact=1 bounds the daily
// "Alpha sales" reads that an agent JSON-fetch tool with a response-size limit
// otherwise rejects as "payload too large". `days` drops entries/excludedEntries
// whose displayed departure day (recencyKey) is older than today - days, applied
// AFTER paging on the already-merged ledger so cursoring stays unaffected.
// `compact` re-maps each row to only the fields an agent page needs.
function applyDaysWindow(ledger, days) {
  const cutoffKey = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const keep = entry => recencyKey(entry) >= cutoffKey;
  ledger.entries = ledger.entries.filter(keep);
  ledger.excludedEntries = ledger.excludedEntries.filter(keep);
  ledger.counts = {
    verified: ledger.entries.filter(row => row.tier === 'verified').length,
    probable: ledger.entries.filter(row => row.tier === 'probable').length,
    suspected: ledger.entries.filter(row => row.tier === 'suspected').length,
    admitted: ledger.entries.length,
    auctionPricesShown: 0,
  };
  ledger.transferCount = ledger.entries.filter(row => row.tier === 'transfer').length;
  ledger.excludedCount = ledger.excludedEntries.length;
  ledger.days = days;
  return ledger;
}

// Cheap derivation only: match the seller nameservers already on the entry
// against the known seller/parking nameserver table. No network lookups.
function marketplaceFromNameservers(nameservers) {
  for (const raw of nameservers || []) {
    const host = String(raw || '').toLowerCase().replace(/\.$/, '');
    if (!host) continue;
    const match = SELLER_PARKING_NAMESERVERS.find(row => host === row.nameserver || host.endsWith(`.${row.nameserver}`));
    if (match) return match.provider;
  }
  return null;
}

function compactEntry(entry) {
  const discovery = entry.discovery || {};
  const rdap = discovery.rdap || {};
  const assessment = entry.assessment || {};
  return {
    domain: entry.domain,
    classification: entry.classification,
    tier: entry.tier,
    reportDate: entry.reportDate,
    buyerTitle: entry.buyerTitle,
    buyerUrl: entry.buyerUrl,
    venue: entry.venue,
    sellerNameservers: entry.sellerNameservers,
    buyerNameservers: entry.buyerNameservers,
    basis: assessment.basis ?? null,
    departureDaySource: assessment.departureDaySource ?? null,
    registrar: rdap.registrar ?? null,
    transferAt: rdap.transferAt ?? null,
    signals: assessment.signals ?? [],
    counterEvidence: assessment.counterEvidence ?? [],
    rationale: entry.rationale,
    marketplace: marketplaceFromNameservers(entry.sellerNameservers),
  };
}

// Stage 2b: registerSaleWatchRoutes accepts an optional
// options.reconstructionLoader() that returns the reconstruction entries
// array (typically readReconstructionEntries on the recon db handle). A
// missing loader defaults to [].
// A failing read returns an explicit 503 instead of a misleading empty ledger.
// Shared, bounded deferred read for the Sale Watch reconstruction lane. On a cold boot
// the reconstruction page can take longer than an HTTP caller should wait, and a lane
// timeout must never surface as a failed page. Identical concurrent requests share one
// in-flight read; a caller waits at most waitMs, then gets { status: 'pending' } (the
// route answers 202) while the read finishes in the background for the next poll.
// Completed values are reused for ttlMs. A failed read is reported once to the caller
// that observes it and then cleared so the next poll retries.
function createDeferredRead({ waitMs = 8000, ttlMs = 30000, maxEntries = 16, now = Date.now } = {}) {
  const entries = new Map();
  function settledWithin(promise, ms) {
    return new Promise(resolve => {
      const t = setTimeout(() => resolve(false), Math.max(0, ms));
      // Ref'd on purpose: a caller is awaiting this bounded wait, and it is
      // cleared the moment the read settles.
      promise.then(() => { clearTimeout(t); resolve(true); }, () => { clearTimeout(t); resolve(true); });
    });
  }
  // opts.waitMs overrides the bound for one caller; Infinity waits for the
  // shared read to settle (it is still bounded by the loader's own timeout).
  async function read(key, start, opts = {}) {
    const limit = Number.isFinite(opts.waitMs) || opts.waitMs === Infinity ? opts.waitMs : waitMs;
    let e = entries.get(key);
    if (e && e.status === 'done' && now() - e.at > ttlMs) { entries.delete(key); e = null; }
    if (!e) {
      const entry = { status: 'running', startedAt: new Date(now()).toISOString(), value: undefined, error: null, at: 0 };
      entry.promise = Promise.resolve().then(start).then(
        value => { entry.status = 'done'; entry.value = value; entry.at = now(); return value; },
        error => { entry.status = 'error'; entry.error = error; entry.at = now(); throw error; });
      entry.promise.catch(() => {});
      entries.set(key, entry);
      while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
      e = entry;
    }
    if (e.status === 'running') {
      if (limit === Infinity) await e.promise.then(() => {}, () => {});
      else await settledWithin(e.promise, limit);
    }
    if (e.status === 'done') return { status: 'ready', value: e.value };
    if (e.status === 'error') {
      if (entries.get(key) === e) entries.delete(key);
      throw e.error;
    }
    return { status: 'pending', startedAt: e.startedAt };
  }
  return { read, _entries: entries };
}

function registerSaleWatchRoutes(app, options = {}) {
  const reconstructionPages = createDeferredRead({ waitMs: Number.isFinite(options.reconstructionWaitMs) ? options.reconstructionWaitMs : 8000, ttlMs: 30000 });
  const reconstructionCoverageRead = createDeferredRead({ waitMs: Number.isFinite(options.coverageWaitMs) ? options.coverageWaitMs : 2000, ttlMs: 60000 });
  let lastCoverage = null;
  // Which ledger read path answered last ('read-time' before the first complete
  // stored pass, then 'stored'). While read-time serves, non-q pages keep the
  // f3c6494 bounded wait + 202 poll; stored pages and q searches are awaited.
  let lastLedgerSource = null;
  app.get('/api/sale-watch', async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const offset = Math.max(0, Math.floor(Number(_req.query?.offset) || 0));
      let after = null;
      const cursor = String(_req.query?.cursor || '').slice(0,1024);
      if (cursor) {
        after = JSON.parse(Buffer.from(cursor,'base64url').toString());
        if (!after || typeof after.date !== 'string' || !/^(?:[0-9]{4}-[0-9]{2}-[0-9]{2})?$/.test(after.date) || typeof after.domain !== 'string' || !/^[a-z0-9.-]{1,253}$/.test(after.domain) || (after.rank !== undefined && !Number.isFinite(after.rank))) throw new Error('Invalid page cursor');
        // Missing rank means an old (pre-rank) cursor; treat it as the strongest bucket (0) is wrong,
        // so default to the weakest-known rank boundary (0) only when truly absent -- matches spec.
        after = { date: after.date, rank: Number.isFinite(after.rank) ? after.rank : 0, domain: after.domain };
      }
      const view = ['all','leads','focus','alpha','transfer','probable','suspected','excluded'].includes(_req.query?.view) ? _req.query.view : 'all';
      // The browser builds an expandable evidence panel for every returned row.
      // Keep that interactive work bounded and let the existing cursor carry the
      // operator through the complete ledger. Machine/compact consumers retain
      // the larger historical page contract.
      const surface = _req.query?.surface === 'interactive' ? 'interactive' : '';
      const interactive = surface === 'interactive';
      const pageSize = interactive ? 100 : (view === 'alpha' ? 5000 : 500);
      const reconstructionScanLimit = interactive ? pageSize + 1 : (view === 'alpha' ? 5000 : 1000);
      let days = null;
      if (_req.query?.days !== undefined) {
        const parsedDays = Math.floor(Number(_req.query.days));
        if (Number.isFinite(parsedDays) && parsedDays >= 1 && parsedDays <= 60) days = parsedDays;
      }
      const compact = _req.query?.compact === '1' || _req.query?.compact === 1;
      const cloud = await require('./sale-watch-cloud').readCloudLedger({query:String(_req.query?.q||'').slice(0,100),offset,view,cursor,days,compact,surface});
      if(cloud?.ledger)return res.json({...cloud.ledger,delivery:{source:'cloud-reconstruction',fetchedAt:cloud.fetchedAt}});
      // Coverage is supplementary. Start it lazily only after the page read has
      // been dispatched/completed: both operations use the same read-worker
      // lane, so enqueuing a full-history census first would strand the indexed
      // page behind it even if this handler did not await the census.
      let coverageOutcome = null;
      const startCoverage = () => {
        if (!coverageOutcome) coverageOutcome = typeof options.reconstructionCoverage === 'function'
          ? reconstructionCoverageRead.read('coverage', () => options.reconstructionCoverage()).then(
            o => { if (o.status === 'ready') { lastCoverage = o.value; return o.value; } return lastCoverage ? { ...lastCoverage, refreshing: true } : { pending: true, startedAt: o.startedAt }; },
            error => (lastCoverage ? { ...lastCoverage, refreshing: true, lastError: error.message } : { unavailable: true, detail: error.message }))
          : Promise.resolve(null);
        return coverageOutcome;
      };
      // The indexed page is useful before the full-history coverage census.
      // Keep that supplementary read running, but never hold an interactive
      // browser response behind it. Its result populates lastCoverage for the
      // next response.
      const coverageForResponse = () => {
        const pendingCoverage = startCoverage();
        return interactive
          ? Promise.resolve(lastCoverage ? { ...lastCoverage, refreshing: true } : { pending: true })
          : pendingCoverage;
      };
      let reconstructionEntries = [];
      let pageLedgerStore = null;
      if (typeof options.reconstructionLoader === 'function') {
        const loaderQuery = {q:String(_req.query?.q||'').slice(0,100),offset:after ? 0 : offset,limit:reconstructionScanLimit,view,after,...(days ? { days } : {})};
        const pageKey = JSON.stringify(loaderQuery);
        let outcome;
        try {
          // A q search is served by the persisted search index, so it answers
          // the caller directly instead of the 202 "pending" poll protocol.
          // The page is an indexed read of the stored assessment, so every
          // caller waits for it (bounded by the read lane's own timeout); a 202
          // comes only from the store itself being missing (first boot).
          outcome = await reconstructionPages.read(pageKey, () => options.reconstructionLoader(loaderQuery),
            loaderQuery.q || lastLedgerSource !== 'read-time' ? { waitMs: Infinity } : undefined);
        } catch (error) {
          throw new Error('Reconstruction page unavailable: ' + error.message);
        }
        if (outcome.status === 'pending') {
          await coverageForResponse();
          res.set('Retry-After', '3');
          return res.status(202).json({
            schema: 'domainscout.sale-watch-ledger/v1',
            status: 'pending',
            detail: 'Reconstruction page is being computed; retry shortly',
            startedAt: outcome.startedAt,
            retryAfterMs: 3000,
          });
        }
        const value = outcome.value;
        // A stored-page loader answers { status, entries }. 'pending' means the
        // stored assessment does not exist yet (first boot), the only steady-
        // state-free case that answers 202.
        if (value && !Array.isArray(value) && value.status === 'pending') {
          // Never reuse a pending answer: the next poll re-reads the store.
          reconstructionPages._entries.delete(pageKey);
          await coverageForResponse();
          res.set('Retry-After', '5');
          return res.status(202).json({
            schema: 'domainscout.sale-watch-ledger/v1',
            status: 'pending',
            detail: 'Stored Sale Watch assessment is being built for the first time; retry shortly',
            startedAt: outcome.startedAt || null,
            retryAfterMs: 5000,
          });
        }
        reconstructionEntries = Array.isArray(value) ? value : (value && Array.isArray(value.entries) ? value.entries : []);
        if (value && !Array.isArray(value) && value.ledgerStore) pageLedgerStore = { ...value.ledgerStore, source: value.source || value.ledgerStore.serving || null };
        if (value && !Array.isArray(value) && typeof value.source === 'string') lastLedgerSource = value.source;
      }
      const ledger=readSaleWatchLedger(options.ledgerPath, options.discoveryPath, reconstructionEntries);
      pageSaleLedger(ledger, reconstructionEntries, { view, q: String(_req.query?.q || '').slice(0,100), after, pageSize, scanLimit: reconstructionScanLimit });
      if (days) applyDaysWindow(ledger, days);
      const reconstructionCoverageValue = await coverageForResponse();
      // ledgerStore: which read path served this page (fresh, from the page) plus
      // assessed/total counts (from the cached coverage read).
      ledger.coverage.reconstruction = reconstructionCoverageValue && typeof reconstructionCoverageValue === 'object' && pageLedgerStore
        ? { ...reconstructionCoverageValue, ledgerStore: { assessed: null, total: null, ...(reconstructionCoverageValue.ledgerStore || {}), ...pageLedgerStore } }
        : reconstructionCoverageValue;
      if(cloud?.error)ledger.delivery={source:'local-evidence',warning:cloud.error};
      if (view === 'alpha') {
        const returned = [...ledger.entries, ...ledger.excludedEntries].filter(isAlphaEntry).length;
        ledger.alpha = { returned, windowDays: 30 };
        // A page count is not a total. Only publish total when this response is
        // known to contain the end of the cursor stream.
        if (ledger.pagination?.nextCursor == null) ledger.alpha.total = returned;
      }
      if (compact) {
        ledger.entries = ledger.entries.map(compactEntry);
        ledger.excludedEntries = ledger.excludedEntries.map(compactEntry);
        ledger.compact = true;
      }
      res.json(ledger);
    } catch (error) {
      res.status(503).json({
        schema: 'domainscout.sale-watch-ledger/v1',
        error: 'Sale Watch ledger is temporarily unavailable',
        detail: error.message,
      });
    }
  });

  // GET /api/sale-watch/candidates -- the full weekly sale-candidate tape.
  //
  // Same auth as /api/sale-watch (the global requireAuth in server/index.js
  // covers every /api/* path, including the x-domainscout-token agent header),
  // the same store, and the SAME platform/parking-batch and expiry exclusions.
  // What it drops is the ledger's evidence-tier view gate -- that gate is why a
  // research run keeps re-reading the same few dozen pre-scored names. A failing
  // read answers 503 with detail; it never degrades to an empty list.
  app.get('/api/sale-watch/candidates', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const { normalizeQuery, CandidateQueryError, SCHEMA } = require('./sale-watch-candidates');
    let query;
    try {
      query = normalizeQuery(req.query || {});
    } catch (error) {
      // A bad query (including a cursor minted for a different query) is the
      // caller's 400, not a store outage.
      if (error instanceof CandidateQueryError) {
        return res.status(error.status || 400).json({
          schema: SCHEMA,
          error: 'Invalid sale-watch candidates query',
          detail: error.message,
        });
      }
      return res.status(503).json({
        schema: SCHEMA,
        error: 'Sale Watch candidate tape is temporarily unavailable',
        detail: error.message,
      });
    }
    try {
      // Always resolve `days` to explicit from/to before going downstream: the
      // window must not drift under a caller midway through paging, and the
      // cursor digest is bound to it.
      const params = {
        from: query.from,
        to: query.to,
        q: query.q,
        tld: query.tld,
        built: query.built,
        limit: query.limit,
        cursor: String(req.query?.cursor || '').slice(0, 1024),
      };
      const cloud = await require('./sale-watch-cloud').readCloudCandidates(params);
      if (cloud?.tape) return res.json({ ...cloud.tape, delivery: { source: 'cloud-reconstruction', fetchedAt: cloud.fetchedAt } });
      if (typeof options.candidateLoader !== 'function') throw new Error('Sale Watch reconstruction store is not configured on this deployment');
      const tape = await options.candidateLoader(params);
      if (!tape || typeof tape !== 'object' || !Array.isArray(tape.rows)) throw new Error('Sale Watch candidate store returned no tape');
      if (cloud?.error) tape.delivery = { source: 'local-reconstruction', warning: cloud.error };
      res.json(tape);
    } catch (error) {
      res.status(503).json({
        schema: SCHEMA,
        error: 'Sale Watch candidate tape is temporarily unavailable',
        detail: error.message,
      });
    }
  });
}

module.exports = {
  pageSaleLedger,
  DEFAULT_LEDGER_PATH,
  DEFAULT_DISCOVERY_PATH,
  normalizeEntry,
  readSaleWatchLedger,
  registerSaleWatchRoutes,
};
