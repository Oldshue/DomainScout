'use strict';

// Cheap generation detection for immutable provider snapshots. The caller owns
// persistence and queue writes; this module guarantees an unchanged generation
// never opens its (potentially very large) snapshot index.

function snapshotGenerationFingerprint(meta) {
  if (!meta || meta.error) return null;
  const identity = meta.generationId || meta.snapshotSha256;
  if (!identity) return null;
  return `${identity}:${Number(meta.count) || 0}`;
}

function probeProviderGenerations({
  streams,
  readMeta,
  readIndex,
  readFingerprint,
  extractCandidates,
  admit,
  release,
  candidateLimit,
  nowMs = Date.now(),
}) {
  const changed = {};
  const fingerprints = {};
  const errors = [];
  for (const stream of streams) {
    let openedIndex = false;
    try {
      const fingerprint = snapshotGenerationFingerprint(readMeta(stream));
      if (!fingerprint || fingerprint === readFingerprint(stream)) continue;
      const index = readIndex(stream);
      if (!index) continue;
      openedIndex = true;
      changed[stream] = extractCandidates(index, {
        nowMs,
        endIsExpiry: index.excludeEnded !== false,
        limit: candidateLimit,
      });
      fingerprints[stream] = fingerprint;
    } catch (error) {
      errors.push({ stream, error });
    } finally {
      if (openedIndex) {
        try { release(stream); } catch (_) {}
      }
    }
  }
  if (Object.keys(fingerprints).length) admit(changed, fingerprints);
  return { changedStreams: Object.keys(fingerprints), errors };
}

module.exports = { probeProviderGenerations, snapshotGenerationFingerprint };
