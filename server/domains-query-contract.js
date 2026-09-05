'use strict';

// Pure helpers for GET /api/domains query-contract honesty.
//
// Evidence that motivated computeLimitApplied/computeHasMore: a customer agent sent
// `limit=10000`; the handler clamped it silently against the server's own bounds and
// returned fewer rows than `total` implied, with `totalCapped` reporting false — so the
// agent's counts were wrong and it had no signal that the server had overridden its
// requested page size, nor whether another page of results existed.
//
// Evidence that motivated unsupportedSortResponse/ignoredQueryParams: customer agents sent
// `sortField=quality_score`, `sort=auction_price&order=asc`, and `max_price=20` against the
// SQLite path of GET /api/domains. All three were silently ignored — an unsupported sort
// field silently fell back to the default sort with no error, and unread query params (typos
// or wrong names) were dropped with no signal at all. The provider-snapshot path already
// answers with an explicit `sortApplied` (see server/provider-query-worker-policy.js
// resolveProviderSnapshotSort); the SQLite path needed the same honesty plus an explicit
// `ignoredParams` list. These helpers make both facts explicit and are kept dependency-free
// (no database, no request/response objects) so they are trivial to unit test directly.

/**
 * Describe how the handler's own bounded-integer clamp treated the caller's
 * raw `limit` query value.
 *
 * @param {*} rawLimit - the raw, unparsed `req.query.limit` value (may be
 *   undefined, a string, or already a number).
 * @param {number} enforced - the limit the handler actually enforced after
 *   `parseBoundedPositiveInt` (i.e. `limitNum`).
 * @returns {{ requested: number|null, enforced: number, reason: 'max-page-size'|'as-requested' }}
 */
function computeLimitApplied(rawLimit, enforced) {
  const parsed = Number.parseInt(String(rawLimit ?? ''), 10);
  const requested = Number.isFinite(parsed) ? parsed : null;
  const reason = requested !== null && requested !== enforced
    ? 'max-page-size'
    : 'as-requested';
  return { requested, enforced, reason };
}

/**
 * Determine whether another page of results is available for the current
 * request, without lying when the true total is unknown or was itself
 * capped by an early-terminating count query.
 *
 * @param {{ page: number, limit: number, total: number|null, returned: number }} args
 *   `total` should be passed as `null` (not the capped estimate) whenever the
 *   caller's own total was capped, so this falls back to the row-count
 *   signal instead of comparing against a number that is known to be wrong.
 * @returns {boolean}
 */
function computeHasMore({ page, limit, total, returned }) {
  if (total == null || !Number.isFinite(total)) {
    return returned === limit;
  }
  return page * limit < total;
}

/**
 * Build the 400 response body for a `sortField` the handler does not
 * recognize, so an unsupported sort request fails loudly instead of
 * silently falling back to the default sort.
 *
 * @param {*} sortField - the raw, unparsed `req.query.sortField` value.
 * @param {string[]} allowedFields - the sort fields the handler accepts.
 * @returns {{ error: 'unsupported_sort_field', sortField: *, supported: string[] }}
 */
function unsupportedSortResponse(sortField, allowedFields) {
  return { error: 'unsupported_sort_field', sortField, supported: allowedFields };
}

/**
 * List the query-string parameter names present on the request that the
 * handler never reads, so a mistyped or unsupported param (e.g. `sort`
 * instead of `sortField`, or `max_price` instead of `maxPrice`) is surfaced
 * to the caller instead of being silently dropped.
 *
 * @param {Object} query - the request's `req.query` object.
 * @param {string[]} readNames - every query param name the handler reads,
 *   whether via destructuring or a direct `req.query.<name>` access.
 * @returns {string[]} the present param names not in `readNames`, in the
 *   order they appear on `query` (possibly empty).
 */
function ignoredQueryParams(query, readNames) {
  const read = new Set(readNames);
  return Object.keys(query || {}).filter(name => !read.has(name));
}

module.exports = {
  computeLimitApplied,
  computeHasMore,
  unsupportedSortResponse,
  ignoredQueryParams,
};
