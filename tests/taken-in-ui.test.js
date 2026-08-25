'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadFrontend(search) {
  const source = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');
  const context = {
    URLSearchParams,
    window: {
      location: { protocol: 'http:', search, pathname: '/' },
      history: { pushState() {}, replaceState() {} },
    },
    document: { addEventListener() {} },
    console,
    setTimeout,
    clearTimeout,
    AbortController,
  };
  vm.runInNewContext(`${source}\n;globalThis.__app = app; globalThis.__state = state; globalThis.__beginLoadRequest = beginLoadRequest;`, context);
  context.__app.applyUrlParamsToState();
  return context;
}

const shared = loadFrontend('?stream=just-dropped&tld=.ai&takenIn=.dev,.shop&takenInMode=any&takenInMatch=any&sortField=taken_in_status&sortDir=ASC');
assert.strictEqual(shared.__state.stream, 'just-dropped');
assert.strictEqual(shared.__state.tld, '.ai');
assert.deepStrictEqual([...shared.__state.takenInTlds], ['.dev', '.shop']);
assert.strictEqual(shared.__state.takenInMode, 'any');
assert.strictEqual(shared.__state.takenInMatch, 'any');
assert.strictEqual(shared.__state.sortField, 'taken_in_status');
assert.strictEqual(shared.__state.sortDir, 'ASC');
assert.strictEqual(shared.__state.limit, 250, 'default review pages must stay bounded enough to render selected-TLD evidence immediately');

const legacy = loadFrontend('?stream=just-dropped&tld=.ai&takenIn=.app');
assert.strictEqual(legacy.__state.takenInMode, 'taken');
assert.strictEqual(legacy.__state.takenInMatch, 'all');
assert.deepStrictEqual([...legacy.__state.takenInTlds], ['.app']);

assert.strictEqual(shared.__app.normalizeTakenInTld('SHOP'), '.shop');
assert.strictEqual(shared.__app.normalizeTakenInTld('not a tld'), null);

shared.__state.takenInTlds = new Set(['.ai']);
shared.__state.takenInMode = 'taken';
shared.__state.takenInMatch = 'all';
const explicitPositive = { taken_in_evidence: [{ tld: '.ai', status: 'taken' }] };
assert.strictEqual(shared.__app.rowMatchesActiveSiblingEvidence(explicitPositive), true);
assert.strictEqual(shared.__app.rowMatchesActiveSiblingEvidence({ taken_in_evidence: [{ tld: '.ai', status: 'not_taken' }] }), false);
assert.strictEqual(shared.__app.rowMatchesActiveSiblingEvidence({ taken_in_evidence: [{ tld: '.ai', status: 'unknown' }] }), false);
assert.strictEqual(shared.__app.rowMatchesActiveSiblingEvidence({ taken_in_evidence: [] }), false);
assert.strictEqual(shared.__app.rowMatchesActiveSiblingEvidence({ taken_in_evidence: true }), false);
assert.match(shared.__app.activeSiblingEvidenceCell(explicitPositive), />\.ai taken</);
assert.strictEqual(shared.__app.knownExtensionLowerBound({ tld: '.com', ...explicitPositive }), 2, 'the source registration plus selected .ai evidence prove an honest minimum of two');
assert.strictEqual(shared.__app.knownExtensionLowerBound({ tld: '.com', tlds_lower_bound: 7, ...explicitPositive }), 7);
assert.deepStrictEqual([...shared.__app.knownTakenExtensions({ tld: '.com', ...explicitPositive })], ['.ai', '.com']);
assert.deepStrictEqual(
  [...shared.__app.knownTakenExtensions({ tld: '.shop', registration_available: 1 })],
  [],
  'the source extension must not be presented as taken for a registrar-confirmed available name'
);
assert.match(
  shared.__app.extensionCoverageCell({ tld: '.com', tlds_lower_bound: 7, ...explicitPositive }, 'fixture'),
  /extension-detail-trigger exact[\s\S]*>2<\/button>[\s\S]*\.ai taken/,
  'the concrete source and selected-TLD list must render as an immediate clickable number'
);
assert.doesNotMatch(
  shared.__app.extensionCoverageCell({ tld: '.com', tlds_lower_bound: 7, ...explicitPositive }, 'fixture'),
  /≥|known|>7</,
  'the table must not render a partial numeric total or completeness caveat'
);
assert.match(
  shared.__app.extensionCoverageCell({
    tld: '.com', tld_list: ['.ai', '.com', '.dev'], tlds_taken: 3,
    tlds_materialized: true, tlds_verified: true, tlds_checked_at: '2026-08-18T00:00:00Z', ...explicitPositive,
  }, 'fixture'),
  />3<\/[\s\S]*\.ai taken/,
  'a materialized total and selected-TLD evidence must render together'
);
assert.match(
  shared.__app.extensionCountCell({ tld: '.shop', registration_available: 1, tlds_taken: 0, tlds_verified: true, tlds_checked_at: '2026-08-18T00:00:00Z' }, 'fixture-shop'),
  /extension-detail-trigger exact[\s\S]*>0<\/button>/,
  'an unrelated exact-zero fixture must still open its concrete evidence view'
);
assert.match(
  shared.__app.extensionCountCell({ tld: '.shop' }, 'fixture-shop', true),
  /extension-detail-trigger exact[\s\S]*>1<\/button>/,
  'an unrelated registered source fixture must be numeric and clickable immediately'
);
assert.doesNotMatch(
  shared.__app.extensionCountCell({ tld: '.shop', tlds_lower_bound: 11 }, 'fixture-shop', true),
  /11|known|≥|…/,
  'legacy estimates must never replace the concrete materialized list cardinality'
);
shared.__state.takenInTlds = new Set(['.shop']);
assert.strictEqual(shared.__app.rowMatchesActiveSiblingEvidence({
  taken_in_evidence: [{ tld: '.shop', status: 'not_taken' }],
}), false, 'an unrelated .shop negative fixture must stay excluded from Taken only');
shared.__state.takenInTlds = new Set(['.dev', '.shop']);
shared.__state.takenInMode = 'any';
shared.__state.takenInMatch = 'any';

const expired = loadFrontend('?stream=_expired14&tld=.ai');
expired.__state.expiredCoverage = { complete: true };
assert.strictEqual(
  expired.__app.registrationOutboundUrl({
    domain: 'real-drop.ai', stream: 'just-dropped', registration_available: 1,
    drop_date: '2026-08-04', availability_checked_at: '2026-08-04T14:00:00Z',
  }),
  'https://www.spaceship.com/domain-search/?query=real-drop.ai&beast=false&tab=domains'
);
assert.strictEqual(expired.__app.registrationOutboundUrl({
  domain: 'still-pending.ai', stream: 'pending-delete', registration_available: 1,
  drop_date: '2026-08-04', availability_checked_at: '2026-08-04T14:00:00Z',
}), null, 'Pending names must never receive a registrar action');
expired.__state.expiredCoverage = { complete: false };
assert.strictEqual(expired.__app.registrationOutboundUrl({
  domain: 'partial.ai', stream: 'just-dropped', registration_available: 1,
  drop_date: '2026-08-04', availability_checked_at: '2026-08-04T14:00:00Z',
}), null, 'Incomplete universes must never receive a registrar action');

const frontendSource = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');
const frontendHtml = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
assert.ok(frontendSource.includes('no partial results shown'));
assert.ok(frontendSource.includes('Partial names are intentionally hidden.'));
assert.ok(frontendSource.includes('Pending delete${tld} · not registerable yet'));
assert.ok(frontendSource.includes('Register ${this._escapeHtml(d.domain)} at Spaceship'));
assert.ok(frontendSource.includes("params.set('takenInMatch', state.takenInMatch)"));
assert.ok(frontendSource.includes("params.set('takenInEvidence', this.takenInEvidenceMode())"));
assert.ok(frontendSource.includes("data.error === 'sibling-index-warming'"));
assert.ok(frontendSource.includes('Preparing selected-TLD evidence'));
const siblingWarmingBlock = frontendSource.slice(
  frontendSource.indexOf("if (data.error === 'sibling-index-warming')"),
  frontendSource.indexOf("throw new Error", frontendSource.indexOf("if (data.error === 'sibling-index-warming')"))
);
assert.ok(siblingWarmingBlock.includes('this.renderTableLoading('), 'warming selected-TLD evidence must render progress inside the table');
assert.ok(!siblingWarmingBlock.includes('this.renderTable([])'), 'a temporary warming response must never render a final empty state');
assert.ok(siblingWarmingBlock.includes('checkedCount'));
assert.ok(siblingWarmingBlock.includes('pairCount'));
assert.ok(frontendSource.includes("tbody.setAttribute?.('aria-busy', 'true')"));
assert.ok(frontendSource.includes("emptyState.style.display = 'none'"));
assert.ok(frontendSource.includes('if (!requestIsCurrent()) return;'));
assert.ok(frontendSource.includes("err.name === 'AbortError' || !requestIsCurrent()"));
assert.ok(frontendSource.includes('if (requestIsCurrent()) bar.style.display'));
const firstLoad = shared.__beginLoadRequest();
assert.strictEqual(firstLoad.isCurrent(), true);
const secondLoad = shared.__beginLoadRequest();
assert.strictEqual(firstLoad.signal.aborted, true, 'a newer filter request must abort the prior request');
assert.strictEqual(firstLoad.isCurrent(), false, 'a superseded response must never be current');
assert.strictEqual(secondLoad.isCurrent(), true);
shared.__state.takenInMode = 'taken';
assert.strictEqual(shared.__app.takenInEvidenceMode(), 'partial');
shared.__state.takenInMode = 'any';
assert.strictEqual(shared.__app.takenInEvidenceMode(), 'complete');
shared.__state.takenInMode = 'not_taken';
assert.strictEqual(shared.__app.takenInEvidenceMode(), 'complete');
assert.ok(!frontendSource.includes('Queued for supported extension universe check">&hellip;'));
assert.ok(!frontendSource.includes('Resolving exact extension count'));
assert.ok(frontendSource.includes('app.openRowTldModal'));
assert.doesNotMatch(shared.__app.extensionCountCell({}, 'fixture', false), /Not verified|Checking|Unavailable|known|≥|…/);
assert.match(shared.__app.extensionCountCell({}, 'fixture', false), /extension-detail-trigger exact[\s\S]*>0<\/button>/);
assert.ok(!frontendSource.includes('class="sibling-status'), 'selected-TLD filtering must not add a redundant table sub-row');
assert.ok(frontendHtml.includes('id="taken-in-match"'));
assert.ok(frontendHtml.includes('Match all selected'));
assert.ok(frontendHtml.includes('Match any selected'));
assert.ok(frontendHtml.includes('id="taken-in-active-status"'));
assert.match(frontendHtml, /<option value="250" selected>250<\/option>/);
assert.ok(frontendSource.includes("mode.disabled = !hasSelection"));
assert.ok(frontendSource.includes("match.disabled = !hasSelection"));
assert.ok(frontendSource.includes('Selected-TLD evidence mismatch · unsafe rows withheld'));
assert.ok(frontendSource.includes('Explicit selected-TLD registration evidence'));
assert.ok(frontendSource.includes('this._renderedSiblingScope !== siblingScope'));
assert.ok(frontendSource.includes('Verifying explicit ${[...state.takenInTlds].join'));
assert.ok(!frontendSource.includes('data-needs-tld'), 'rows must arrive populated instead of starting per-cell polling');
assert.ok(!frontendSource.includes('setupTldObserver'), 'rendering must not launch whole-root checks for visible cells');
assert.doesNotMatch(frontendSource, /autoRefineTlds[\s\S]{0,200}godaddy/, 'provider streams must not be excluded from exact-count refinement');
assert.doesNotMatch(frontendSource, /known taken|At least \$\{d\.tlds_lower_bound\}/, 'partial numeric labels must not leak through table, detail, or popover UI');
assert.ok(frontendSource.includes("tldTotal: null"));
assert.ok(!frontendSource.includes('~1,285'));
assert.ok(!frontendSource.includes("slice(0, 25)"));
assert.ok(frontendSource.includes("tbody.innerHTML = ''"));
assert.strictEqual(shared.__app.siblingCoverageSummary({ complete: true }, 12, false), '12 domains');
assert.strictEqual(shared.__app.siblingCoverageSummary({ complete: false, lowerBound: true }, 7, false), '7 known-positive domains · partial lower bound · complete coverage unavailable');
assert.strictEqual(shared.__app.siblingCoverageSummary({ complete: false, missingTlds: ['dev'], staleTlds: ['app'] }, 0, false), 'Coverage blocked · missing .dev · stale .app · no complete result claim');

// Auction evidence is lossless across sibling-TLD filtering: a missing per-listing
// observation must not erase the verified provider snapshot's bids or price.
const snapshotAuction = {
  stream: 'fixture-auction', bid_count: 3, auction_price: 17,
  live_inventory_at: '2026-08-14T18:54:33.039Z',
};
assert.match(shared.__app._bidsCell(snapshotAuction), />3</);
assert.match(shared.__app._bidsCell(snapshotAuction), /Verified provider inventory/);
assert.match(shared.__app._bidsCell(snapshotAuction), />snap</);
assert.match(shared.__app._priceCell(snapshotAuction), />\$17</);
assert.match(shared.__app._priceCell(snapshotAuction), /Verified provider inventory/);
assert.match(shared.__app._priceCell(snapshotAuction), />snap</);
const liveAuction = {
  ...snapshotAuction, live_bids: 5, live_price: 21,
  live_fetched_at: new Date().toISOString(),
};
assert.match(shared.__app._bidsCell(liveAuction), />5</);
assert.match(shared.__app._priceCell(liveAuction), />\$21</);
assert.match(shared.__app._priceCell(liveAuction), /Current per-listing auction observation/);
assert.doesNotMatch(shared.__app._priceCell(liveAuction), />snap</);

// Sibling evidence is generation-scoped to one provider stream. An unrelated
// provider transition must clear only that scoped filter, while a same-stream
// refresh retains it. This stays provider-neutral: no production provider names
// participate in the transition contract.
shared.__state.stream = 'fixture-provider-a';
shared.__state.takenInTlds = new Set(['.ai']);
shared.__state.takenInMode = 'not_taken';
shared.__state.takenInMatch = 'any';
shared.__state.sortField = 'taken_in_status';
shared.__state.sortDir = 'ASC';
shared.__state.sortExplicit = true;
assert.strictEqual(shared.__app.clearStreamScopedFilters('fixture-provider-a', 'fixture-provider-a'), false);
assert.deepStrictEqual([...shared.__state.takenInTlds], ['.ai']);
assert.strictEqual(shared.__app.clearStreamScopedFilters('fixture-provider-a', 'fixture-provider-b'), true);
assert.deepStrictEqual([...shared.__state.takenInTlds], []);
assert.strictEqual(shared.__state.takenInMode, 'taken');
assert.strictEqual(shared.__state.takenInMatch, 'all');
assert.strictEqual(shared.__state.sortField, 'discovered_at');
assert.strictEqual(shared.__state.sortDir, 'DESC');
assert.strictEqual(shared.__state.sortExplicit, false);
assert.ok(frontendSource.includes('this.renderTable(responseDomains'), 'only a completed response may decide that a result set is truly empty');
assert.ok(frontendSource.includes('Preparing selected-TLD evidence'));

console.log('taken-in-ui.test.js: all assertions passed');
