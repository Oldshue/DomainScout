'use strict';
const { readUtf8Credential } = require('../lib/device-credential-store');
const PREFIX = 'DOMAINSCOUT_EVIDENCE_S3_';
const FIELDS = { bucket: 'BUCKET', endpoint: 'ENDPOINT', accessKeyId: 'ACCESS_KEY_ID', secretAccessKey: 'SECRET_ACCESS_KEY', region: 'REGION', urlStyle: 'URL_STYLE' };
const REQUIRED = ['bucket', 'endpoint', 'accessKeyId', 'secretAccessKey'];

// A saved connection is indivisible: never combine its secret with an endpoint
// override from the launch environment. Return only bounded diagnostic codes.
function resolveEvidenceStorageConfig(env = process.env, { readCredential = readUtf8Credential } = {}) {
  const direct = Object.fromEntries(Object.entries(FIELDS).map(([field, suffix]) => [field, String(env[PREFIX + suffix] || '').trim()]));
  if (Object.values(direct).some(Boolean)) {
    return REQUIRED.every(field => direct[field])
      ? { configuration: { ...direct, region: direct.region || 'auto' }, source: 'environment', boundary: null }
      : { configuration: null, source: 'environment', boundary: 'partial_environment_connection' };
  }
  const account = String(env[PREFIX + 'CREDENTIAL_ACCOUNT'] || '');
  if (!account) return { configuration: null, source: null, boundary: 'connection_missing' };
  if (!/^[a-zA-Z0-9_.-]{1,128}$/.test(account)) return { configuration: null, source: 'device', boundary: 'invalid_connection_reference' };
  let text;
  try { text = readCredential({ service: 'domainscout.evidence-s3', account }); }
  catch { return { configuration: null, source: 'device', boundary: 'device_connection_unavailable' }; }
  if (!text) return { configuration: null, source: 'device', boundary: 'device_connection_missing' };
  try {
    const saved = JSON.parse(text);
    if (saved.schema !== 'domainscout.evidence-s3/v1' || saved.account !== account) throw Error();
    const configuration = Object.fromEntries(Object.keys(FIELDS).map(field => [field, typeof saved[field] === 'string' ? saved[field].trim() : '']));
    if (!REQUIRED.every(field => configuration[field]) || Object.values(configuration).some(value => /[\u0000-\u0020\u007f]/.test(value))) throw Error();
    const endpoint = new URL(configuration.endpoint);
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw Error();
    if (configuration.urlStyle && !['path', 'path-style', 'virtual'].includes(configuration.urlStyle)) throw Error();
    return { configuration: { ...configuration, region: configuration.region || 'auto' }, source: 'device', boundary: null };
  } catch { return { configuration: null, source: 'device', boundary: 'device_connection_invalid' }; }
}
module.exports = { resolveEvidenceStorageConfig };
