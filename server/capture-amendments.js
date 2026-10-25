'use strict';
const fs = require('node:fs'), crypto = require('node:crypto');
const { PREFIX, verifiedObjectStream } = require('./universe-snapshots');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const manifestHash = manifest => hash(JSON.stringify(manifest));
const sha = value => /^[a-f0-9]{64}$/.test(value || '');
const identity = value => typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value);
function amendmentPrefix(manifest) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(manifest.day || '') || !identity(manifest.runId)) throw Error('Invalid amendment capture identity');
  return `${PREFIX}/runs/${manifest.day}/${manifest.runId}/amendments/delegation-removals/v1/`;
}
function missingRemovalZones(manifest) {
  return manifest.zones.filter(zone => zone.diff && !zone.diff.retainsAllRemovedDelegations && Number(zone.diff.counts?.dropped) > 0);
}
function validateRemovalAmendment(manifest, baselines, amendment) {
  if (manifest.schema !== 'domainscout.zone-universe/v2' || manifest.complete !== true || (manifest.failed || []).length || !Array.isArray(manifest.inventory) || new Set(manifest.inventory).size !== manifest.inventory.length || manifest.inventory.length !== manifest.zones.length || manifest.inventory.some(tld => !manifest.zones.some(zone => zone.tld === tld))) throw Error('Original capture is not complete');
  const expected = missingRemovalZones(manifest), prefix = amendmentPrefix(manifest);
  if (amendment?.schema !== 'domainscout.capture-evidence-amendment/v1' || amendment.kind !== 'delegation-removal-backfill' || amendment.accessScope !== 'organization-internal' || amendment.complete !== true || !identity(amendment.objectSetId) || !Number.isFinite(Date.parse(amendment.reconstructedAt))) throw Error('Invalid completed internal capture amendment');
  if (amendment.capture?.day !== manifest.day || amendment.capture?.runId !== manifest.runId || amendment.capture?.sha256 !== manifestHash(manifest)) throw Error('Amendment does not bind the original capture');
  if (!expected.length || !Array.isArray(amendment.zones) || amendment.zones.length !== expected.length) throw Error('Amendment does not cover all missing removal zones');
  const seen = new Set();
  for (const entry of amendment.zones) {
    const zone = expected.find(zone => zone.tld === entry.zone);
    if (!zone || seen.has(entry.zone)) throw Error('Amendment has an unexpected or duplicate zone');
    seen.add(entry.zone);
    const baseline = baselines.get(zone.diff.prevDay), prior = baseline?.zones.find(row => row.tld === zone.tld);
    if (baseline?.schema !== 'domainscout.zone-universe/v2' || baseline.complete !== true || (baseline.failed || []).length || !prior || !sha(prior.snapshot?.sha256) || !sha(zone.snapshot?.sha256)) throw Error('Amendment baseline snapshot evidence is missing');
    if (entry.baseline?.day !== baseline.day || entry.baseline?.runId !== baseline.runId || entry.baseline?.snapshotSha256 !== prior.snapshot.sha256 || entry.sourceSnapshotSha256 !== zone.snapshot.sha256) throw Error('Amendment snapshot binding mismatch');
    if (!Number.isSafeInteger(entry.expectedDropped) || entry.expectedDropped <= 0 || entry.expectedDropped !== zone.diff.counts.dropped) throw Error('Amendment removal count mismatch');
    const object = entry.movement;
    if (!object || !sha(object.sha256) || !Number.isSafeInteger(object.bytes) || object.bytes <= 0 || object.key !== `${prefix}objects/${amendment.objectSetId}/${entry.zone}.${object.sha256}.jsonl`) throw Error('Invalid amendment movement object receipt');
  }
  return amendment;
}
async function* discoverRemovalAmendments({ store, manifest, baselines }) {
  if (!store.list || !missingRemovalZones(manifest).length) return;
  const prefix = amendmentPrefix(manifest);
  for await (const item of store.list(prefix)) {
    if (!item.key.startsWith(prefix)) throw Error('Amendment listing escaped capture scope');
    const name = item.key.slice(prefix.length);
    if (name.startsWith('objects/')) continue;
    if (!/^[a-f0-9]{64}\.json$/.test(name)) throw Error('Invalid amendment manifest object key');
    const bytes = await store.get(item.key);
    if (bytes.length !== item.bytes || hash(bytes) !== name.slice(0, 64)) throw Error('Amendment manifest integrity mismatch');
    const amendment = validateRemovalAmendment(manifest, baselines, JSON.parse(bytes));
    yield { key: item.key, sha256: name.slice(0, 64), amendment };
  }
}
async function publishRemovalBackfill({ store, manifest, baselines, inputs, reconstructedAt, onProgress = () => {} }) {
  if (!store.putFile || !store.getStream || !store.put) throw Error('Evidence store cannot publish verified capture amendments');
  const expected = missingRemovalZones(manifest), objectSetId = crypto.randomUUID(), prefix = amendmentPrefix(manifest);
  if (inputs.length !== expected.length || new Set(inputs.map(input => input.zone)).size !== inputs.length) throw Error('Backfill inputs do not cover all missing removal zones');
  const zones = expected.map(zone => {
    const input = inputs.find(input => input.zone === zone.tld), baseline = baselines.get(zone.diff.prevDay), prior = baseline?.zones.find(row => row.tld === zone.tld);
    if (!input || input.day !== manifest.day || input.prevDay !== zone.diff.prevDay || input.expectedChanged !== 0 || input.expectedDropped !== zone.diff.counts.dropped || !sha(input.sha256) || !Number.isSafeInteger(input.bytes) || input.bytes <= 0 || !fs.existsSync(input.path)) throw Error('Invalid backfill input evidence');
    return { zone: zone.tld, baseline: { day: baseline?.day, runId: baseline?.runId, snapshotSha256: prior?.snapshot?.sha256 }, sourceSnapshotSha256: zone.snapshot?.sha256, expectedDropped: input.expectedDropped, movement: { key: `${prefix}objects/${objectSetId}/${zone.tld}.${input.sha256}.jsonl`, bytes: input.bytes, sha256: input.sha256 } };
  });
  const amendment = { schema: 'domainscout.capture-evidence-amendment/v1', kind: 'delegation-removal-backfill', accessScope: 'organization-internal', complete: true, capture: { day: manifest.day, runId: manifest.runId, sha256: manifestHash(manifest) }, objectSetId, reconstructedAt, zones };
  validateRemovalAmendment(manifest, baselines, amendment);
  // Unique object-set paths prevent a changed local input from overwriting any
  // earlier immutable evidence. A manifest becomes discoverable only at the end.
  for (const entry of zones) {
    const input = inputs.find(input => input.zone === entry.zone), receipt = await store.putFile(entry.movement.key, input.path, 'application/x-ndjson');
    if (receipt.bytes !== entry.movement.bytes || receipt.sha256 !== entry.movement.sha256) throw Error('Uploaded backfill input integrity mismatch');
    let pending = '', count = 0;
    const consume = line => {
      if (!line) return;
      const row = JSON.parse(line);
      if (row.kind !== 'dropped' || typeof row.domain !== 'string' || !row.domain.endsWith('.' + entry.zone) || row.window_start !== entry.baseline.day || row.window_end !== manifest.day || !Array.isArray(row.prev_ns) || !row.prev_ns.length || row.prev_ns.some(ns => typeof ns !== 'string' || !ns) || !Array.isArray(row.today_ns) || row.today_ns.length || row.today_class != null) throw Error('Backfill row is not a bound delegation removal');
      count++;
    };
    for await (const chunk of await verifiedObjectStream(store, entry.movement)) {
      const lines = (pending + chunk.toString('utf8')).split('\n'); pending = lines.pop();
      for (const line of lines) consume(line);
      if (pending.length > 1024 * 1024) throw Error('Backfill row exceeds canonical record budget');
    }
    consume(pending);
    if (count !== entry.expectedDropped) throw Error('Backfill row count does not match declared removals');
    onProgress({ verifiedZones: zones.indexOf(entry) + 1, totalZones: zones.length });
  }
  const bytes = Buffer.from(JSON.stringify(amendment)), sha256 = hash(bytes), key = prefix + sha256 + '.json';
  await store.put(key, bytes, 'application/json');
  const restored = await store.get(key);
  if (!Buffer.from(restored).equals(bytes)) throw Error('Published amendment manifest integrity mismatch');
  return { key, sha256, bytes: bytes.length, zones: zones.length, removed: zones.reduce((n, row) => n + row.expectedDropped, 0), amendment };
}
module.exports = { amendmentPrefix, manifestHash, missingRemovalZones, validateRemovalAmendment, discoverRemovalAmendments, publishRemovalBackfill };
