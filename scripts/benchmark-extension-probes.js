#!/usr/bin/env node
'use strict';

// Benchmark: old recursive path (public resolvers + DoH) vs new authoritative-direct
// path (TLD nameservers, raw UDP) on the SAME labels across the full non-zone
// extension set. Reports names/sec for each path and the agreement rate on every
// (label, extension) pair and every label where BOTH paths gave a definite answer.
//
//   node scripts/benchmark-extension-probes.js [--count 200] [--labels-file f]
//        [--tlds .io,.co,...] [--name-concurrency 4] [--json out.json]
//
// Labels default to the head of the persistent work queue (soonest-ending real
// inventory), then `domains`, then a deterministic synthetic set. Extensions
// default to universe.dnsTlds (every extension with no zone file). Uses the
// worker's own resolvers so the numbers reflect production code paths.

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) args[key] = true;
    else { args[key] = next; i += 1; }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const COUNT = Math.max(1, parseInt(args.count || '200', 10));
const NAME_CONCURRENCY = Math.max(1, parseInt(args['name-concurrency'] || '4', 10));
const TLD_CONCURRENCY = Math.max(1, parseInt(args['tld-concurrency'] || '160', 10));

const db = require('../server/db');
const worker = require('../server/tlds-worker');
const { getSupportedTldUniverse } = require('../server/tld-universe');

function syntheticLabels(n) {
  const a = ['blue', 'swift', 'nova', 'pixel', 'cloud', 'brick', 'ember', 'quill', 'orbit', 'maple'];
  const b = ['lab', 'works', 'hub', 'forge', 'craft', 'stack', 'flow', 'nest', 'path', 'point'];
  const out = [];
  for (let i = 0; out.length < n; i += 1) out.push(`${a[i % a.length]}${b[Math.floor(i / a.length) % b.length]}${i >= 100 ? i : ''}`);
  return out.slice(0, n);
}

function pickLabels() {
  if (args['labels-file']) {
    return { source: '--labels-file', labels: fs.readFileSync(path.resolve(args['labels-file']), 'utf8').split(/\r?\n/)
      .map(s => s.trim().toLowerCase()).filter(s => /^[a-z0-9-]+$/.test(s)).slice(0, COUNT) };
  }
  const sources = [
    { name: 'tld_work_queue', sql: 'SELECT base_name FROM tld_work_queue ORDER BY ord LIMIT ?' },
    { name: 'domains', sql: "SELECT DISTINCT base_name FROM domains WHERE base_name IS NOT NULL AND base_name != '' LIMIT ?" },
  ];
  for (const src of sources) {
    try {
      const rows = db.prepare(src.sql).all(COUNT).map(r => r.base_name).filter(Boolean);
      if (rows.length >= Math.min(COUNT, 20)) return { labels: rows.slice(0, COUNT), source: src.name };
    } catch (_) { /* table may not exist in a fresh data dir */ }
  }
  return { labels: syntheticLabels(COUNT), source: 'synthetic' };
}

function pickTlds() {
  if (args.tlds) {
    return { tlds: String(args.tlds).split(',').map(t => t.trim().toLowerCase()).filter(Boolean).map(t => t.startsWith('.') ? t : `.${t}`), source: '--tlds' };
  }
  const universe = getSupportedTldUniverse();
  if (universe.dnsTlds.length) return { tlds: universe.dnsTlds, source: `universe.dnsTlds (${universe.count} total, ${universe.indexedTlds.length} zone-indexed)` };
  return { tlds: ['.io', '.co', '.ai', '.de', '.uk', '.ca', '.fr', '.nl', '.us', '.me'], source: 'fallback-list' };
}

async function runPath(name, probe, labels, tlds) {
  const results = new Map(); // label -> Map(tld -> true|false|null)
  const reasons = {};
  const started = Date.now();
  let cursor = 0;
  const pool = Array.from({ length: NAME_CONCURRENCY }, async () => {
    while (cursor < labels.length) {
      const label = labels[cursor++];
      const perTld = new Map();
      let tc = 0;
      const inner = Array.from({ length: Math.min(TLD_CONCURRENCY, tlds.length) }, async () => {
        while (tc < tlds.length) {
          const tld = tlds[tc++];
          let value = null;
          try { value = await probe(`${label}${tld}`); }
          catch (err) { value = null; reasons[String(err && err.code || err && err.message || 'error')] = (reasons[String(err && err.code || err && err.message || 'error')] || 0) + 1; }
          perTld.set(tld, value);
        }
      });
      await Promise.all(inner);
      results.set(label, perTld);
    }
  });
  await Promise.all(pool);
  const seconds = (Date.now() - started) / 1000;
  let definite = 0, unknown = 0, taken = 0;
  for (const m of results.values()) for (const v of m.values()) { if (v === null) unknown += 1; else { definite += 1; if (v) taken += 1; } }
  return { name, seconds, namesPerSec: labels.length / Math.max(seconds, 1e-6), lookups: labels.length * tlds.length, definite, unknown, taken, reasons, results };
}

function agreement(oldRun, newRun, labels, tlds) {
  let pairsBoth = 0, pairsAgree = 0, labelsBoth = 0, labelsAgree = 0;
  const disagreements = [];
  for (const label of labels) {
    const a = oldRun.results.get(label), b = newRun.results.get(label);
    let labelBoth = true, labelAgree = true;
    for (const tld of tlds) {
      const x = a ? a.get(tld) : null, y = b ? b.get(tld) : null;
      if (x === null || y === null || x === undefined || y === undefined) { labelBoth = false; continue; }
      pairsBoth += 1;
      if (x === y) pairsAgree += 1; else { labelAgree = false; disagreements.push({ label, tld, recursive: x, authoritative: y }); }
    }
    if (labelBoth) { labelsBoth += 1; if (labelAgree) labelsAgree += 1; }
  }
  return { pairsBoth, pairsAgree, pairAgreementRate: pairsBoth ? pairsAgree / pairsBoth : null, labelsBoth, labelsAgree, labelAgreementRate: labelsBoth ? labelsAgree / labelsBoth : null, disagreements: disagreements.slice(0, 50) };
}

(async () => {
  const { labels, source: labelSource } = pickLabels();
  const { tlds, source: tldSource } = pickTlds();
  console.log(`labels=${labels.length} (${labelSource}) extensions=${tlds.length} (${tldSource}) name_concurrency=${NAME_CONCURRENCY} tld_concurrency=${TLD_CONCURRENCY}`);

  const oldRun = await runPath('recursive (old)', d => worker.resolveNsRecursive(d), labels, tlds);
  console.log(`old  recursive     : ${oldRun.seconds.toFixed(1)}s  ${oldRun.namesPerSec.toFixed(3)} names/sec  lookups=${oldRun.lookups} definite=${oldRun.definite} unknown=${oldRun.unknown} taken=${oldRun.taken}`);
  const newRun = await runPath('authoritative (new)', d => worker.resolveNsLimited(d), labels, tlds);
  console.log(`new  authoritative : ${newRun.seconds.toFixed(1)}s  ${newRun.namesPerSec.toFixed(3)} names/sec  lookups=${newRun.lookups} definite=${newRun.definite} unknown=${newRun.unknown} taken=${newRun.taken}`);
  const agree = agreement(oldRun, newRun, labels, tlds);
  console.log(`agreement: pairs ${agree.pairsAgree}/${agree.pairsBoth} (${agree.pairAgreementRate === null ? 'n/a' : (agree.pairAgreementRate * 100).toFixed(2) + '%'}); labels ${agree.labelsAgree}/${agree.labelsBoth} (${agree.labelAgreementRate === null ? 'n/a' : (agree.labelAgreementRate * 100).toFixed(2) + '%'})`);
  if (agree.disagreements.length) console.log('disagreements (first 50):', JSON.stringify(agree.disagreements));
  const health = worker.authoritativeResolver.snapshot();
  console.log(`authoritative stats: ${JSON.stringify(health.stats)} unknown-reasons(new)=${JSON.stringify(newRun.reasons)} unknown-reasons(old)=${JSON.stringify(oldRun.reasons)}`);
  const degraded = Object.entries(health.tlds).filter(([, h]) => !h.healthy).map(([t]) => t);
  if (degraded.length) console.log(`tlds routed to fallback: ${degraded.join(',')}`);
  if (args.json) {
    fs.writeFileSync(path.resolve(args.json), JSON.stringify({ labels: labels.length, labelSource, extensions: tlds.length, tldSource,
      old: { ...oldRun, results: undefined }, new: { ...newRun, results: undefined }, agreement: agree, authoritative: health }, null, 2));
  }
  worker.authoritativeResolver.close();
  process.exit(agree.pairAgreementRate === 1 ? 0 : 2);
})().catch(err => { console.error('benchmark failed:', err); process.exit(1); });
