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

const legacy = loadFrontend('?stream=just-dropped&tld=.ai&takenIn=.app');
assert.strictEqual(legacy.__state.takenInMode, 'taken');
assert.strictEqual(legacy.__state.takenInMatch, 'all');
assert.deepStrictEqual([...legacy.__state.takenInTlds], ['.app']);

assert.strictEqual(shared.__app.normalizeTakenInTld('SHOP'), '.shop');
assert.strictEqual(shared.__app.normalizeTakenInTld('not a tld'), null);

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
assert.ok(frontendSource.includes('>Not verified</span>'));
assert.ok(frontendSource.includes('>Checking</span>'));
assert.ok(frontendSource.includes('>Unavailable</span>'));
assert.ok(!frontendSource.includes('class="sibling-status'), 'selected-TLD filtering must not add a redundant table sub-row');
assert.ok(frontendHtml.includes('id="taken-in-match"'));
assert.ok(frontendHtml.includes('Match all selected'));
assert.ok(frontendHtml.includes('Match any selected'));
assert.strictEqual(shared.__app.siblingCoverageSummary({ complete: true }, 12, false), '12 domains');
assert.strictEqual(shared.__app.siblingCoverageSummary({ complete: false, lowerBound: true }, 7, false), '7 known-positive domains · partial lower bound · complete coverage unavailable');
assert.strictEqual(shared.__app.siblingCoverageSummary({ complete: false, missingTlds: ['dev'], staleTlds: ['app'] }, 0, false), 'Coverage blocked · missing .dev · stale .app · no complete result claim');

console.log('taken-in-ui.test.js: all assertions passed');
