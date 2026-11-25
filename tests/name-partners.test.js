'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { registerNamePartnersRoutes } = require('../server/name-partners');

// Stub universe summary: X+labs / X+ai rows, and zone truth for X+target.
const PAIRS = {
  labs: [['open', 30], ['nova', 12], ['x9', 9]],
  ai: [['open', 150], ['chat', 100]],
};
const ZONES = { openinference: ['.com', '.dev'] };
const COM_TAKEN = new Set(['novainference.com', 'computechat.com']);

function stubTruth(probes) {
  return {
    asOf: '2026-11-25',
    partners(anchor, position, { limit }) {
      return (PAIRS[anchor] || []).slice(0, limit).map(([word, tld_count]) => ({ word, base_name: word + anchor, tld_count }));
    },
    zoneMembership(name) {
      if (ZONES[name]) return { exact: true, tlds: ZONES[name].slice(), unresolved: [] };
      return { exact: true, tlds: [], unresolved: ['.com'] };
    },
  };
}

async function call(query) {
  const probes = [];
  const app = express();
  registerNamePartnersRoutes(app, {
    getZoneTruth: () => stubTruth(probes),
    getResolver: () => ({
      async probe(domain) {
        probes.push(domain);
        if (domain === 'chatinference.com') return { status: 'unknown', reason: 'timeout' };
        return { status: COM_TAKEN.has(domain) ? 'taken' : 'not_taken' };
      },
    }),
  });
  const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/name-partners?${query}`);
    return { status: res.status, body: await res.json(), probes };
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test('ranks words held with every anchor first, then by zones, letters only by default', async () => {
  const { status, body } = await call('anchors=labs,ai');
  assert.equal(status, 200);
  assert.deepEqual(body.words.map(w => w.word), ['open', 'chat', 'nova']);
  assert.deepEqual(body.words[0].anchors, { labs: 30, ai: 150 });
  assert.equal(body.words[0].targets, undefined);
});

test('settles a .com-only target by authoritative probe: taken, open or unknown', async () => {
  const { body, probes } = await call('anchors=labs,ai&targets=inference');
  const by = Object.fromEntries(body.words.map(w => [w.word, w.targets.inference]));
  assert.equal(by.open.status, 'taken');
  assert.deepEqual(by.open.zones, ['.com', '.dev']);
  assert.equal(by.nova.status, 'taken');
  assert.deepEqual(by.nova.zones, ['.com']);
  assert.equal(by.chat.status, 'unknown');
  assert.deepEqual(by.chat.unresolved, ['.com']);
  assert.ok(!probes.includes('openinference.com'), 'a name already in a zone needs no probe');
  assert.equal(body.probed, 2);
});

test('targetPosition=prefix builds target+word; resolve=0 leaves anchors unresolved', async () => {
  const pre = await call('anchors=ai&targets=compute&targetPosition=prefix');
  const by = Object.fromEntries(pre.body.words.map(w => [w.word, w.targets.compute]));
  assert.equal(by.chat.name, 'computechat');
  assert.equal(by.chat.status, 'taken');
  assert.equal(by.open.name, 'computeopen');
  assert.equal(by.open.status, 'open');
  const raw = await call('anchors=ai&targets=compute&resolve=0');
  assert.equal(raw.body.words[0].targets.compute.status, 'unknown');
  assert.equal(raw.probes.length, 0);
});

test('rejects a missing or one-letter anchor', async () => {
  assert.equal((await call('anchors=')).status, 400);
  assert.equal((await call('anchors=a')).status, 400);
});
