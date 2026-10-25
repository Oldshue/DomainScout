'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { resolveEvidenceStorageConfig } = require('../server/evidence-storage-config');
const { createS3ObjectStore } = require('../server/recent-registration-corpus');
const account = 'daily-archive';
const env = { DOMAINSCOUT_EVIDENCE_S3_CREDENTIAL_ACCOUNT: account };
const saved = { schema: 'domainscout.evidence-s3/v1', account, bucket: 'fixture-bucket', endpoint: 'https://archive.example.invalid', accessKeyId: 'fixture-access', secretAccessKey: 'fixture-secret', region: 'auto', urlStyle: 'path' };
const read = value => () => JSON.stringify(value);

test('device connection uses one fixed service and binds every field to its account', () => {
  const result = resolveEvidenceStorageConfig(env, { readCredential: identity => {
    assert.deepEqual(identity, { service: 'domainscout.evidence-s3', account }); return JSON.stringify(saved);
  }});
  assert.equal(result.source, 'device'); assert.equal(result.boundary, null);
  assert.equal(result.configuration.endpoint, saved.endpoint);
  assert.equal(result.configuration.secretAccessKey, saved.secretAccessKey);
});

test('partial environment never combines a saved secret with an overridden endpoint or bucket', () => {
  for (const suffix of ['BUCKET', 'ENDPOINT', 'ACCESS_KEY_ID', 'SECRET_ACCESS_KEY', 'REGION', 'URL_STYLE']) {
    let reads = 0;
    const r = resolveEvidenceStorageConfig({ ...env, ['DOMAINSCOUT_EVIDENCE_S3_' + suffix]: 'override' }, { readCredential: () => { reads++; return JSON.stringify(saved); } });
    assert.equal(reads, 0); assert.equal(r.configuration, null); assert.equal(r.boundary, 'partial_environment_connection');
  }
});

test('complete environment remains usable without invoking the device store', () => {
  const direct = Object.fromEntries(Object.entries({ BUCKET: 'bucket', ENDPOINT: saved.endpoint, ACCESS_KEY_ID: 'a', SECRET_ACCESS_KEY: 's' }).map(([k,v]) => ['DOMAINSCOUT_EVIDENCE_S3_' + k, v]));
  const r = resolveEvidenceStorageConfig({ ...env, ...direct }, { readCredential: () => { throw Error('must not read'); } });
  assert.equal(r.source, 'environment'); assert.equal(r.configuration.region, 'auto');
  assert.ok(createS3ObjectStore(direct)); assert.equal(createS3ObjectStore({DOMAINSCOUT_EVIDENCE_S3_BUCKET:'only-bucket'}), null);
});

test('unavailable and malformed connections fail closed without disclosing helper diagnostics or secrets', () => {
  for (const options of [
    { readCredential: () => { throw Error('fixture-secret'); } },
    { readCredential: () => '' }, { readCredential: () => 'fixture-secret' },
    { readCredential: read({ ...saved, schema: 'other/v1' }) },
    { readCredential: read({ ...saved, account: 'different-service-account' }) },
    { readCredential: read({ ...saved, secretAccessKey: '' }) },
    ...['http://archive.invalid', 'https://user:password@archive.invalid', 'https://archive.invalid?token=x'].map(endpoint => ({readCredential:read({...saved,endpoint})})),
  ]) {
    const r = resolveEvidenceStorageConfig(env, options);
    assert.equal(r.configuration, null); assert.equal(JSON.stringify(r).includes('fixture-secret'), false);
  }
  let reads=0;
  assert.equal(resolveEvidenceStorageConfig({}, {readCredential:()=>{reads++;}}).boundary, 'connection_missing');
  assert.equal(resolveEvidenceStorageConfig({...env,DOMAINSCOUT_EVIDENCE_S3_CREDENTIAL_ACCOUNT:'../wrong'}, {readCredential:()=>{reads++;}}).boundary,'invalid_connection_reference');
  assert.equal(reads,0);
});
