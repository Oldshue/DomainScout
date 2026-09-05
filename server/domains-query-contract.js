'use strict';

// Pure helpers for GET /api/domains page-size honesty.
//
// Evidence that motivated this module: a customer agent sent `limit=10000`;
// the handler clamped it silently against the server's own bounds and
// returned fewer rows than `total` implied, with `totalCapped` reporting
// false — so the agent's counts were wrong and it had no signal that the
// server had overridden its requested page size, nor whether another page
// of results existed. These helpers make both facts explicit and are kept
// dependency-free (no database, no request/response objects) so they are
// trivial to unit test directly.

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

module.exports = { computeLimitApplied, computeHasMore };
