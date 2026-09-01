'use strict';

const crypto = require('node:crypto');

const KEY_BYTES = 32;
const MAX_USERNAME_LENGTH = 64;
const MAX_PASSWORD_LENGTH = 512;
const DUMMY_SALT = Buffer.from('DomainScout-auth-dummy-salt-v1', 'utf8');
const DUMMY_HASH = Buffer.alloc(KEY_BYTES);

function decodeBase64(value, field) {
  const raw = String(value || '');
  const decoded = Buffer.from(raw, 'base64');
  if (decoded.length < 16 || decoded.toString('base64') !== raw) {
    throw new Error(`Invalid ${field}`);
  }
  return decoded;
}

function decodeHash(value) {
  const raw = String(value || '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(raw)) throw new Error('Invalid passwordHash');
  return Buffer.from(raw, 'hex');
}

function parseAuthUsers(raw) {
  if (!String(raw || '').trim()) return new Map();
  let records;
  try {
    records = JSON.parse(raw);
  } catch {
    throw new Error('DOMAINSCOUT_AUTH_USERS_JSON must be valid JSON');
  }
  if (!Array.isArray(records) || records.length === 0 || records.length > 100) {
    throw new Error('DOMAINSCOUT_AUTH_USERS_JSON must be a non-empty array of at most 100 users');
  }

  const users = new Map();
  for (const candidate of records) {
    const username = String(candidate?.username || '').trim();
    if (!username || username.length > MAX_USERNAME_LENGTH || /[\u0000-\u001f\u007f]/.test(username)) {
      throw new Error('Invalid auth username');
    }
    if (users.has(username)) throw new Error(`Duplicate auth username: ${username}`);
    users.set(username, Object.freeze({
      username,
      salt: decodeBase64(candidate.salt, 'salt'),
      passwordHash: decodeHash(candidate.passwordHash),
    }));
  }
  return users;
}

function derivePasswordHash(password, salt) {
  return crypto.scryptSync(String(password), salt, KEY_BYTES, { maxmem: 64 * 1024 * 1024 });
}

function buildAuthRecord(username, password, salt = crypto.randomBytes(24)) {
  const cleanUsername = String(username || '').trim();
  if (!cleanUsername || cleanUsername.length > MAX_USERNAME_LENGTH) throw new Error('Invalid auth username');
  if (typeof password !== 'string' || !password || password.length > MAX_PASSWORD_LENGTH) {
    throw new Error('Invalid auth password');
  }
  const saltBuffer = Buffer.isBuffer(salt) ? salt : Buffer.from(salt);
  if (saltBuffer.length < 16) throw new Error('Auth salt must contain at least 16 bytes');
  return {
    username: cleanUsername,
    salt: saltBuffer.toString('base64'),
    passwordHash: derivePasswordHash(password, saltBuffer).toString('hex'),
  };
}

function verifyCredentials(users, username, password) {
  const cleanUsername = typeof username === 'string' ? username.trim() : '';
  const safePassword = typeof password === 'string' && password.length <= MAX_PASSWORD_LENGTH ? password : '';
  const record = users.get(cleanUsername);
  const salt = record?.salt || DUMMY_SALT;
  const expected = record?.passwordHash || DUMMY_HASH;
  const actual = derivePasswordHash(safePassword, salt);
  return Boolean(record && safePassword && crypto.timingSafeEqual(actual, expected));
}

function safeReturnPath(value, fallback = '/') {
  const candidate = String(value || '').trim();
  if (!candidate.startsWith('/') || candidate.startsWith('//') || /[\u0000-\u001f\u007f]/.test(candidate)) {
    return fallback;
  }
  try {
    const url = new URL(candidate, 'https://domainscout.invalid');
    if (url.origin !== 'https://domainscout.invalid') return fallback;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return fallback;
  }
}

function escapeHtmlAttribute(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

module.exports = {
  buildAuthRecord,
  escapeHtmlAttribute,
  parseAuthUsers,
  safeReturnPath,
  verifyCredentials,
};
