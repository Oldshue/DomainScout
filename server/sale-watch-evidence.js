'use strict';

const cheerio = require('cheerio');
const landerHosts = require('../config/sale-watch-lander-hosts.json').hosts;
const DAY = 86400000;
const VERSION = 'sale-evidence-v4';
const host = value => { try { return new URL(value).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; } };
const normalizedStatus = value => String(value).toLowerCase().replace(/[^a-z]/g, '');
const sameDayWindow = (a, b, days = 7) => Number.isFinite(Date.parse(a)) && Number.isFinite(Date.parse(b)) && Math.abs(Date.parse(a) - Date.parse(b)) <= days * DAY;

function websitePurpose({ html = '', title = '', finalUrl = '', status = 200, hosts = landerHosts } = {}) {
  const finalHost = host(finalUrl);
  const knownLander = hosts.some(value => finalHost === value || finalHost.endsWith(`.${value}`));
  const $ = cheerio.load(String(html).slice(0, 250000));
  $('script, style, noscript, template, svg').remove();
  const text = `${title} ${$('*').contents().filter((_, node) => node.type === 'text').map((_, node) => $(node).text()).get().join(' ')}`.replace(/\s+/g, ' ').trim();
  const domainSale = /\b(?:this domain (?:name )?(?:is |may be )?(?:for sale|available|can be yours)|buy (?:this|the) domain|purchase (?:this|the) domain|domain (?:name )?for sale|acquire (?:this|the) domain|inquire about this domain|make an offer (?:on|for) (?:this|the) domain)\b/i.test(text);
  const offer = /\b(?:make an offer|buy now|lease.to.own|inquire now|request (?:a )?price|purchase domain|acquire domain)\b/i.test(text);
  const domainContext = /\b(?:premium domain|domain name|domain acquisition|domain portfolio|domain marketplace|domain broker|brandable domain)\b/i.test(text);
  const campaign = /(?:portfolio_landers|domain_redirect)/i.test(finalUrl);
  const challenge = /\b(?:access denied|checking your browser|just a moment|verify you are human|403 forbidden|404 not found|website not found|enable javascript and cookies|security verification)\b/i.test(text.slice(0, 3000));
  const placeholder = /^(?:home|my wordpress|hello world|welcome|index of|default web site page|apache2? .*default page)$/i.test(title.trim()) || /\b(?:coming soon|under construction|site is being built|nothing here yet|future home of|website is coming)\b/i.test(text.slice(0, 3000));
  const forSale = knownLander || campaign || domainSale || (offer && domainContext);
  const kind = forSale ? 'sales-lander' : status < 200 || status >= 300 || challenge ? 'unavailable' : placeholder ? 'placeholder' : title.trim() ? 'operating' : 'unknown';
  return { kind, forSale, knownLander, finalHost, reason: knownLander ? `Destination is a cataloged domain storefront (${finalHost}).` : campaign ? 'Destination identifies a portfolio-lander redirect.' : forSale ? 'Visible page offers a domain for purchase or lease.' : kind === 'unavailable' ? 'HTTP error or browser challenge; use could not be verified.' : kind === 'placeholder' ? 'Default or pre-launch page does not establish buyer use.' : null };
}

function rdapEvidence(body, { checkedAt = new Date().toISOString(), sourceUrl = null } = {}) {
  const events = (Array.isArray(body?.events) ? body.events : []).filter(e => e.eventAction && Number.isFinite(Date.parse(e.eventDate))).map(e => ({ action: e.eventAction, date: e.eventDate }));
  const statuses = Array.isArray(body?.status) ? body.status : [];
  const registrar = body?.entities?.find(e => e.roles?.includes('registrar'));
  const registrarId = registrar?.publicIds?.find(e => /iana/i.test(e.type || ''))?.identifier || null;
  return { checkedAt, sourceUrl, events, statuses, registrarId,
    registrar: registrar?.vcardArray?.[1]?.find(e => e[0] === 'fn')?.[3] || null,
    lastChangedAt: events.filter(e => normalizedStatus(e.action) === 'lastchanged').map(e => e.date).sort().at(-1) || null,
    transferAt: events.filter(e => normalizedStatus(e.action) === 'transfer').map(e => e.date).sort().at(-1) || null,
    pendingTransfer: statuses.some(s => normalizedStatus(s) === 'pendingtransfer'),
    transferLocked: statuses.some(s => /^(?:client|server)?transferprohibited$/.test(normalizedStatus(s))),
  };
}

// One adjudication boundary is used for fresh probes and all persisted sources.
// DNS, MX and a generic RDAP update are correlated operational changes, not
// three independent transaction witnesses. Never promote them to sale proof.
function assessSaleEntry(entry, { now = new Date(), previous = null } = {}) {
  const d = entry.discovery || {};
  const hp = d.homepage || {};
  const rdap = d.rdap || {};
  const purpose = websitePurpose({ title: hp.title || entry.buyerTitle || '', finalUrl: hp.finalUrl || entry.buyerUrl || '', status: hp.status ?? 200 });
  const forSale = purpose.forSale || hp.purpose?.forSale || hp.parked || d.parkingInfrastructure || d.stillSellerDelegated;
  const pending = rdap.pendingTransfer === true || (rdap.statuses || []).some(s => normalizedStatus(s) === 'pendingtransfer');
  const transferredAt = rdap.transferAt || (rdap.events || []).filter(e => normalizedStatus(e.action || e.eventAction) === 'transfer').map(e => e.date || e.eventDate).sort().at(-1);
  const prevRdap = previous?.discovery?.rdap;
  const previouslyPending = prevRdap?.pendingTransfer === true || (prevRdap?.statuses || []).some(s => normalizedStatus(s) === 'pendingtransfer');
  const changedIdentity = prevRdap?.registrarId && rdap.registrarId ? prevRdap.registrarId !== rdap.registrarId : previouslyPending && !pending && prevRdap?.registrar && rdap.registrar && prevRdap.registrar.toLowerCase() !== rdap.registrar.toLowerCase();
  const registrarChanged = !!(!rdap.error && changedIdentity && sameDayWindow(previous.lastObservedAt, rdap.checkedAt, 14));
  const recentTransfer = !!(transferredAt && sameDayWindow(transferredAt, d.departureDate || entry.reportDate));
  const previousTransfer = d.transferEvidence || previous?.discovery?.transferEvidence;
  const recordedRegistrarChange = !!(previousTransfer?.registrarChanged && sameDayWindow(previousTransfer.observedAt, d.departureDate || entry.reportDate, 30));
  const transfer = { pending, transferAt: transferredAt || null, recentTransfer, registrarChanged: registrarChanged || recordedRegistrarChange,
    fromRegistrar: registrarChanged ? prevRdap.registrar : previousTransfer?.fromRegistrar || null, toRegistrar: rdap.registrar || null,
    observedAt: registrarChanged ? rdap.checkedAt : previousTransfer?.observedAt || rdap.checkedAt || null, locked: rdap.transferLocked === true || (rdap.statuses || []).some(s => /^(?:client|server)?transferprohibited$/.test(normalizedStatus(s))) };
  const datedAt = entry.lastObservedAt || rdap.checkedAt;
  const stale = !Number.isFinite(Date.parse(datedAt)) || Date.parse(now) - Date.parse(datedAt) > 3 * DAY || Date.parse(datedAt) > Date.parse(now) + DAY;
  const reported = !entry.discovery && !!entry.sourceUrl && !/dns\.coffee|rdap\.org/i.test(entry.sourceUrl) && ['verified','probable'].includes(entry.tier);
  const moved = d.structurallyMoved === true;
  const bulkMigration = Number(d.movement?.cohortSize || 0) >= 10;
  const buyerUse = moved && d.buyerUse === true && !hp.placeholder && purpose.kind === 'operating' && !forSale;
  let tier = 'suspected', classification = 'unconfirmed-move', reason;
  if (reported) { tier = entry.tier; classification = 'reported-sale'; reason = entry.rationale; }
  else if (pending && !stale) { tier = 'transfer'; classification = 'transfer-in-progress'; reason = 'Registry reports pending transfer to another registrar. Sale and ownership change are unconfirmed; a lander may remain during transfer.'; }
  else if (forSale) { tier = 'excluded'; classification = 'lander-migration'; reason = purpose.reason || hp.purpose?.reason || 'Current evidence still points to sale or parking infrastructure; no buyer use established.'; }
  else if (moved && (entry.sellerNameservers || []).some(ns => !/bodis|parkingcrew|sedoparking/i.test(ns)) && buyerUse && !bulkMigration && (recentTransfer || registrarChanged || recordedRegistrarChange) && !stale) { tier = 'probable'; classification = 'likely-sale'; reason = 'Seller-DNS departure and operating use are corroborated by a dated registrar transfer. A same-owner transfer or owner development remains possible; payment and ownership are not confirmed.'; }
  else if (moved && (registrarChanged || recordedRegistrarChange || recentTransfer) && !stale) { tier='transfer'; classification='transfer-completed'; reason=`Seller-DNS departure is followed by a registrar transfer${transfer.fromRegistrar && transfer.toRegistrar ? ` from ${transfer.fromRegistrar} to ${transfer.toRegistrar}` : ''}. Operating buyer use is not established yet; continue watching the destination. Payment and ownership remain unconfirmed.`; }
  else if (buyerUse && !stale) { classification='acquisition-candidate'; reason='Observed seller departure followed by an operating destination. This is an unreported acquisition candidate, awaiting independent control-change evidence and follow-up; owner development is still possible.'; }
  else { reason = stale ? 'Historical observation is older than 72 hours; current sale or transfer status needs rechecking.' : 'DNS departure, a matching title, mail setup or an RDAP last-change timestamp cannot establish a sale. Independent transfer or transaction evidence is missing.'; }
  return { ...entry, tier, classification, rationale: reason,
    assessment: { version: VERSION, assessedAt: new Date(now).toISOString(), stale, reported, buyerUse: !!buyerUse, transfer,
      signals: [moved && 'Seller-DNS departure observed', buyerUse && 'Operating destination observed', pending && 'Registry pending transfer', recentTransfer && 'Dated registry transfer', (registrarChanged || recordedRegistrarChange) && 'Observed registrar change', rdap.lastChangedAt && 'RDAP last changed (not sale proof)'].filter(Boolean),
      counterEvidence: [bulkMigration && `${d.movement.cohortSize} departures share this exact destination DNS set; a coordinated migration is possible`, rdap.error && `RDAP lookup unavailable: ${rdap.error}`, hp.error && `Website lookup unavailable: ${hp.error}`, forSale && (purpose.reason || 'Sale/parking destination persists'), stale && 'Current observation is stale', !reported && 'Payment and change of owner are not observed', !recentTransfer && !pending && !registrarChanged && !recordedRegistrarChange && 'No dated registrar transfer evidence'].filter(Boolean),
    },
    ...(entry.discovery ? { discovery: { ...d, transferEvidence: transfer } } : {}),
  };
}
module.exports = { VERSION, websitePurpose, rdapEvidence, assessSaleEntry };
