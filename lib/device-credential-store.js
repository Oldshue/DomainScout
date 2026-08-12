'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const MAX_SECRET_BYTES = 4096;
const MAX_DIAGNOSTIC_BYTES = 2048;

class CredentialStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CredentialStoreError';
    this.code = code;
  }
}

function boundedIdentity(value, name) {
  const text = String(value || '');
  if (!/^[\x21-\x7e]{1,128}$/.test(text)) {
    throw new CredentialStoreError('INVALID_IDENTITY', `invalid credential ${name}`);
  }
  return text;
}

function helperCandidates(explicitPath) {
  return [
    explicitPath,
    process.env.DOMAINSCOUT_CREDENTIAL_HELPER,
    '/Applications/DomainScout.app/Contents/Helpers/DomainScoutCredentialStore',
    path.join(os.homedir(), 'Applications/DomainScout.app/Contents/Helpers/DomainScoutCredentialStore'),
  ].filter(Boolean);
}

function validateHelper(helperPath) {
  if (!path.isAbsolute(helperPath)) {
    throw new CredentialStoreError('INVALID_HELPER', 'credential helper path must be absolute');
  }
  let metadata;
  try {
    metadata = fs.lstatSync(helperPath);
  } catch (_) {
    throw new CredentialStoreError('HELPER_UNAVAILABLE', 'device credential helper is not installed');
  }
  const expectedUid = typeof process.getuid === 'function' ? process.getuid() : metadata.uid;
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== expectedUid || metadata.nlink !== 1) {
    throw new CredentialStoreError('INVALID_HELPER', 'device credential helper metadata is invalid');
  }
  if ((metadata.mode & 0o077) !== 0 || (metadata.mode & 0o100) === 0) {
    throw new CredentialStoreError('INVALID_HELPER', 'device credential helper permissions are invalid');
  }
  return helperPath;
}

function resolveHelper(options = {}) {
  let lastError = null;
  for (const candidate of helperCandidates(options.helperPath)) {
    try {
      return validateHelper(candidate);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new CredentialStoreError('HELPER_UNAVAILABLE', 'device credential helper is not installed');
}

function boundedDiagnostic(buffer) {
  return Buffer.from(buffer || '').subarray(0, MAX_DIAGNOSTIC_BYTES).toString('utf8').replace(/[\r\n]+/g, ' ').trim();
}

function invoke(operation, options = {}) {
  const service = boundedIdentity(options.service, 'service');
  const account = boundedIdentity(options.account, 'account');
  const helper = resolveHelper(options);
  const input = options.input == null ? undefined : Buffer.from(options.input);
  if (input && (input.length < 1 || input.length > MAX_SECRET_BYTES)) {
    throw new CredentialStoreError('INVALID_SECRET', 'credential byte length is invalid');
  }
  const result = spawnSync(helper, [operation, '--service', service, '--account', account], {
    input,
    encoding: null,
    timeout: 10_000,
    maxBuffer: MAX_SECRET_BYTES + MAX_DIAGNOSTIC_BYTES,
    env: {
      HOME: os.homedir(),
      PATH: '/usr/bin:/bin',
      TMPDIR: os.tmpdir(),
    },
    windowsHide: true,
  });
  if (result.error) {
    throw new CredentialStoreError('HELPER_FAILED', 'device credential helper failed to execute');
  }
  if (result.status === 2 && operation === 'get') return null;
  if (result.status !== 0) {
    const detail = boundedDiagnostic(result.stderr);
    throw new CredentialStoreError('HELPER_FAILED', detail || 'device credential helper rejected the request');
  }
  return Buffer.from(result.stdout || '');
}

function readCredential(options = {}) {
  const value = invoke('get', options);
  if (value == null) return null;
  if (value.length < 1 || value.length > MAX_SECRET_BYTES) {
    throw new CredentialStoreError('INVALID_SECRET', 'stored credential byte length is invalid');
  }
  return value;
}

function readUtf8Credential(options = {}) {
  const value = readCredential(options);
  if (value == null) return '';
  const text = value.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(value) || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new CredentialStoreError('INVALID_SECRET', 'stored credential encoding is invalid');
  }
  return text;
}

function storeCredential(secret, options = {}) {
  const value = Buffer.isBuffer(secret) ? secret : Buffer.from(String(secret), 'utf8');
  invoke('set', { ...options, input: value });
}

function deleteCredential(options = {}) {
  invoke('delete', options);
}

function selfTest(options = {}) {
  invoke('self-test', options);
}

module.exports = {
  CredentialStoreError,
  MAX_SECRET_BYTES,
  deleteCredential,
  readCredential,
  readUtf8Credential,
  resolveHelper,
  selfTest,
  storeCredential,
  validateHelper,
};
