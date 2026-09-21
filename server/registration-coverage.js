'use strict';

// Collection success and suitability for comparison are separate receipt facts.
// Missing evidence is never inferred from the presence of a few matching rows.
const DEFAULT_RESEARCH_ZONES = Object.freeze(['com', 'ai', 'io', 'co', 'net', 'org', 'app', 'dev']);
const cleanZones = zones => [...new Set(zones.map(z => String(z).replace(/^\./, '').toLowerCase()))].sort();
function researchZones(value = process.env.DOMAINSCOUT_RESEARCH_ZONES) {
  return cleanZones(value ? String(value).split(',').map(x => x.trim()).filter(Boolean) : DEFAULT_RESEARCH_ZONES);
}
function observedZoneCounts(domains) {
  const counts = {};
  for (const domain of domains) { const zone = domain.slice(domain.lastIndexOf('.') + 1); counts[zone] = (counts[zone] || 0) + 1; }
  return counts;
}
function publicFeedCoverage(domains) {
  return { scope: 'provider_sample', complete: false, capped: true, rowLimit: 70000,
    methodology: 'whoisds-public-nrd', zoneCounts: observedZoneCounts(domains),
    notice: 'Capped public feed; extension selection is not a representative sample. Observed counts cannot establish market growth.' };
}
function assessRegistrationCoverage({ days = [], expectedDates = [], requiredZones = researchZones() } = {}) {
  const zones = cleanZones(requiredZones), byDay = new Map(days.map(d => [d.day || d.date, d]));
  const matrix = expectedDates.map(date => {
    const day = byDay.get(date), c = day?.coverage || {};
    const knownSample = /whoisds/i.test(String(day?.source || day?.sourceUrl || ''));
    const completeZones = cleanZones(Array.isArray(c.completeZones) ? c.completeZones : []);
    const eligible = !!day && !knownSample && c.capped === false && c.complete === true && !!c.methodology;
    return { date, source: day?.source || day?.sourceUrl || null,
      status: !day ? 'missing' : knownSample || c.capped === true ? 'sampled' : eligible ? 'verified' : 'unverified',
      methodology: c.methodology || null,
      zones: zones.map(zone => ({ zone, observedNames: c.zoneCounts?.[zone] ?? null,
        complete: eligible && completeZones.includes(zone) })) };
  });
  const methods = new Set(matrix.map(d => d.methodology).filter(Boolean));
  const missingDates = matrix.filter(d => d.status === 'missing').map(d => d.date);
  const incompleteZones = zones.filter(z => !matrix.length || matrix.some(d => !d.zones.find(x => x.zone === z).complete));
  const comparable = matrix.length > 0 && !missingDates.length && !incompleteZones.length && methods.size === 1;
  const reasons = [];
  if (missingDates.length) reasons.push('Missing source days: ' + missingDates.join(', '));
  if (matrix.some(d => d.status === 'sampled')) reasons.push('Capped or sampled source files cannot establish market-wide momentum');
  if (incompleteZones.length) reasons.push('Complete dated coverage is unverified for ' + incompleteZones.map(z => '.' + z).join(', '));
  if (methods.size > 1) reasons.push('Collection methodology changed within the comparison window');
  return { schema: 'domainscout.registration-coverage/v1', requiredZones: zones, expectedDates,
    complete: comparable, comparable, missingDates, incompleteZones, reasons, days: matrix,
    demandVerified: false, notice: reasons.join('. ') || 'Dated source coverage is comparable; registrations alone do not establish end-user demand.' };
}
module.exports = { DEFAULT_RESEARCH_ZONES, researchZones, observedZoneCounts, publicFeedCoverage, assessRegistrationCoverage };
