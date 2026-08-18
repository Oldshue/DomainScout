'use strict';

const db = require('../server/db');
require('../server/provider-snapshot-registry');
const { getSupportedTldUniverse } = require('../server/tld-universe');
const { hydrateProviderExtensionEvidence } = require('../server/provider-extension-evidence');
const {
  listLargeProviderStreams,
  publishLargeProviderSnapshot,
  readLargeProviderSnapshotMeta,
  readSnapshotPayload,
  validateLargeProviderSnapshot,
} = require('../server/large-provider-snapshot');

const requested = process.argv.slice(2);
const streams = requested.length ? requested : listLargeProviderStreams();
for (const stream of streams) {
  const payload = readSnapshotPayload(stream);
  if (!payload?.domains?.length) {
    console.log(`${stream}: no current snapshot; skipped`);
    continue;
  }
  const meta = readLargeProviderSnapshotMeta(stream);
  const started = Date.now();
  hydrateProviderExtensionEvidence(db, payload.domains, getSupportedTldUniverse());
  const validation = validateLargeProviderSnapshot(stream, payload.domains);
  const manifest = publishLargeProviderSnapshot(stream, payload.domains, {
    generatedAt: meta.generatedAt,
    evidence: meta.evidence,
    validation,
  });
  console.log(`${stream}: ${manifest.count} rows projected in ${Date.now() - started}ms`);
}

db.close();
