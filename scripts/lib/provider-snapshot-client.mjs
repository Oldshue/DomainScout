export class ProviderSnapshotChangedError extends Error {
  constructor(stream, expected, actual) {
    super(`${stream} provider snapshot changed during deterministic scan (${expected} -> ${actual})`);
    this.name = 'ProviderSnapshotChangedError';
  }
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function fetchProviderSnapshotPage({
  base,
  stream,
  offset,
  snapshotSha256 = null,
  pageSize,
  fields,
  tlds,
  timeoutMs = 60_000,
  maxAttempts = 12,
  fetchImpl = fetch,
  sleep = wait,
}) {
  const url = new URL('/api/provider-snapshots/scan', base);
  for (const [key, value] of Object.entries({
    stream,
    offset: String(offset),
    limit: String(pageSize),
    fields: fields.join(','),
    tlds: [...tlds].join(','),
  })) url.searchParams.set(key, value);
  if (snapshotSha256) url.searchParams.set('snapshotSha256', snapshotSha256);

  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let retryAfterMs = Math.min(10_000, attempt * 2_000);
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
      const body = await response.json().catch(() => ({}));
      if (response.status === 409) {
        throw new ProviderSnapshotChangedError(
          stream,
          snapshotSha256 || 'initial',
          body.actualSnapshotSha256 || 'unknown',
        );
      }
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}${body.error ? ` (${body.error})` : ''}`);
        error.retryable = response.status === 429 || response.status >= 500;
        retryAfterMs = Math.max(250, Math.min(10_000, Number(body.retryAfterMs) || retryAfterMs));
        throw error;
      }
      if (body.inventoryHealth?.current !== true || body.inventoryHealth?.serveable !== true || !body.snapshotSha256) {
        const error = new Error('inventory is not current and serveable');
        error.retryable = true;
        throw error;
      }
      if (!Array.isArray(body.columns) || !Array.isArray(body.rows)) {
        throw new Error('response has no snapshot rows');
      }
      return body;
    } catch (error) {
      if (error instanceof ProviderSnapshotChangedError) throw error;
      lastError = error;
      const retryable = error.retryable === true || error.name === 'TimeoutError' || error.name === 'AbortError' || error instanceof TypeError;
      if (!retryable || attempt === maxAttempts) break;
      await sleep(retryAfterMs);
    }
  }
  throw new Error(`${stream} snapshot offset ${offset} failed: ${lastError?.message || lastError}`);
}
