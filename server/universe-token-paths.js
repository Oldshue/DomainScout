'use strict';

// Single list of universe POST paths that the outer auth gate (requireAuth ->
// agentTokenAllowed in server/index.js) admits with DOMAINSCOUT_UNIVERSE_IMPORT_TOKEN
// or DOMAINSCOUT_AGENT_TOKEN. Routes listed here still run their own guard.
// Add a path here only for token-driven operator/automation triggers; every
// other POST stays session-only.
const UNIVERSE_TOKEN_POST_PATHS = Object.freeze([
  '/api/universe/import',
  '/api/universe/summary/import',
  '/api/universe/ns-movement/import',
  '/api/universe/pull',
  '/api/universe/observed/run',
]);

// Mutating automation routes that require the narrower agent token. The
// universe-import token must not gain registrar-check authority.
const AGENT_TOKEN_POST_PATHS = Object.freeze([
  '/api/extension-evidence/check',
]);

module.exports = { AGENT_TOKEN_POST_PATHS, UNIVERSE_TOKEN_POST_PATHS };
