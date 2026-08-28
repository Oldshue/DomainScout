'use strict';

function boundedRankedPageRequest({ offset, limit }, {
  defaultLimit = 100,
  minLimit = 25,
  maxLimit = 500,
  maxOffset = 100000,
} = {}) {
  const parsedOffset = Number.parseInt(offset, 10);
  const parsedLimit = Number.parseInt(limit, 10);
  return {
    offset: Number.isFinite(parsedOffset) ? Math.min(maxOffset, Math.max(0, parsedOffset)) : 0,
    limit: Number.isFinite(parsedLimit)
      ? Math.min(maxLimit, Math.max(minLimit, parsedLimit))
      : defaultLimit,
  };
}

function projectRankedPage(rows, { offset, limit, compare }) {
  const ranked = [...rows].sort(compare);
  const page = ranked.slice(offset, offset + limit);
  return {
    rows: page,
    candidateCount: ranked.length,
    hasMoreCandidates: ranked.length > offset + page.length,
  };
}

module.exports = { boundedRankedPageRequest, projectRankedPage };
