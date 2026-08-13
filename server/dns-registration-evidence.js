'use strict';

function normalizeDomain(value) {
  return String(value || '').trim().toLowerCase().replace(/\.+$/, '');
}

function isExactOwnerName(value, domain) {
  return normalizeDomain(value) === normalizeDomain(domain);
}

function containsExactDelegationEvidence(value, domain) {
  const text = String(value || '').toLowerCase();
  const target = normalizeDomain(domain);
  if (!text || !target) return false;
  const marker = 'at delegation ';
  let offset = text.indexOf(marker);
  while (offset !== -1) {
    const remainder = text.slice(offset + marker.length).trimStart();
    const candidate = normalizeDomain((remainder.match(/^([^\s,;()\[\]]+)/) || [])[1]);
    if (candidate === target) return true;
    offset = text.indexOf(marker, offset + marker.length);
  }
  return false;
}

/**
 * Convert a DNS-over-HTTPS NS response into registration evidence.
 *
 * A clean NXDOMAIN is authoritative negative evidence. An exact NS/CNAME answer,
 * an exact NS authority record, or an extended-DNS error that says the resolver
 * reached a delegation at the queried name is positive evidence. Everything else
 * stays unknown; SERVFAIL, broken DNSSEC, and a delegation at an ancestor are never
 * silently counted as available.
 */
function interpretDohNsResponse(payload, domain) {
  if (!payload || typeof payload !== 'object' || !normalizeDomain(domain)) {
    return { status: 'unknown', reason: 'invalid-doh-response' };
  }

  const answer = Array.isArray(payload.Answer) ? payload.Answer : [];
  if (answer.some(record => isExactOwnerName(record?.name, domain) &&
      (Number(record?.type) === 2 || Number(record?.type) === 5))) {
    return { status: 'taken', reason: 'exact-dns-answer' };
  }

  const authority = Array.isArray(payload.Authority) ? payload.Authority : [];
  if (authority.some(record => isExactOwnerName(record?.name, domain) && Number(record?.type) === 2)) {
    return { status: 'taken', reason: 'exact-parent-delegation' };
  }

  const comments = Array.isArray(payload.Comment) ? payload.Comment : [payload.Comment];
  const extendedErrors = Array.isArray(payload.extended_dns_errors)
    ? payload.extended_dns_errors.map(item => item?.extra_text)
    : [];
  if ([...comments, ...extendedErrors].some(value => containsExactDelegationEvidence(value, domain))) {
    return { status: 'taken', reason: 'exact-delegation-error-evidence' };
  }

  if (Number(payload.Status) === 3) {
    return { status: 'not_taken', reason: 'nxdomain' };
  }
  return { status: 'unknown', reason: `dns-status-${String(payload.Status ?? 'missing')}` };
}

module.exports = {
  interpretDohNsResponse,
};
