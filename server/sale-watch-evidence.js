'use strict';

const cheerio = require('cheerio');
const landerHosts = require('../config/sale-watch-lander-hosts.json').hosts;
const { delegationEvidence } = require('./sale-watch-dns');
const { assessNameAlpha } = require('./domain-quality');
const DAY = 86400000;
const VERSION = 'sale-evidence-v11';
const host = value => { try { return new URL(value).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; } };
const normalizedStatus = value => String(value).toLowerCase().replace(/[^a-z]/g, '');
const sameDayWindow = (a, b, days = 7) => Number.isFinite(Date.parse(a)) && Number.isFinite(Date.parse(b)) && Math.abs(Date.parse(a) - Date.parse(b)) <= days * DAY;

function websitePurpose({ html = '', title = '', finalUrl = '', status = 200, hosts = landerHosts } = {}) {
  const finalHost = host(finalUrl);
  const knownLander = hosts.some(value => finalHost === value || finalHost.endsWith(`.${value}`));
  const $ = html ? cheerio.load(String(html).slice(0, 250000)) : null;
  if ($) $('script, style, noscript, template, svg').remove();
  const text = `${title} ${$ ? $('*').contents().filter((_, node) => node.type === 'text').map((_, node) => $(node).text()).get().join(' ') : ''}`.replace(/\s+/g, ' ').trim();
  // \b (ASCII-only \w in a non-/u regex) can never anchor on a Cyrillic or CJK
  // character, so those scripts' storefront phrases need a boundary that only
  // fires against an adjacent Latin letter/digit, never against absent \w.
  const domainSaleLatin = /\b(?:this domain (?:name )?(?:is |may be )?(?:for sale|available|can be yours)|buy (?:this|the) domain|purchase (?:this|the) domain|domain (?:name )?for sale|acquire (?:this|the) domain|inquire about this domain|make an offer (?:on|for) (?:this|the) domain|steht zum verkauf|domain kaufen|domain zu verkaufen|domaine (?:est )?[àa] vendre|acheter ce domaine|dominio (?:est[áa] )?en venta|comprar este dominio|dominio in vendita|domein te koop|dom[ííi]nio [àa] venda|sat[ıi]l[ıi]k (?:alan ad[ıi]|domain))\b/i.test(text);
  const domainSaleNonLatin = /(?<![a-z0-9])(?:домен продается|купить домен|域名出售|域名转让|出售此域名)(?![a-z0-9])/i.test(text);
  const domainSale = domainSaleLatin || domainSaleNonLatin;
  // Storefront and name-generator landers name themselves without ever saying
  // "this domain": premium-domain availability pages (Atom, DaaZ, private
  // portfolios), Squadhelp/Atom company-name-generator pages, and registrar
  // parking landings. None of these is a buyer using the name.
  const storefront = /\b(?:premium domain (?:name |names )?(?:available|for (?:sale|your brand))|premium domains?\b.{0,40}\b(?:available|for sale|turnkey)|turnkey businesses\b.{0,30}\bpremium domains?|(?:business|company|brand) name generator|business name - company name|parking landing|domain parked|parked (?:domain|page)|domain is parked|this domain is (?:parked|reserved)|domain name for your brand)\b/i.test(text);
  const offer = /\b(?:make an offer|buy now|lease.to.own|inquire now|request (?:a )?price|purchase domain|acquire domain)\b/i.test(text);
  const domainContext = /\b(?:premium domain|domain name|domain acquisition|domain portfolio|domain marketplace|domain broker|brandable domain)\b/i.test(text);
  const campaign = /(?:portfolio_landers|domain_redirect)/i.test(finalUrl);
  const accessWall = /\b(?:cloudflare access|authentication required|login required|please (?:log|sign) in to continue|sign in to continue|401 unauthorized|access restricted|this site is password protected)\b/i.test(text.slice(0, 3000));
  const challenge = accessWall || /\b(?:access denied|checking your browser|just a moment|verify you are human|403 forbidden|404 not found|website not found|enable javascript and cookies|security verification)\b/i.test(text.slice(0, 3000));
  // Default/installed server pages (CyberPanel, Apache/nginx/Plesk/cPanel stock
  // pages, host "website is ready" scaffolds) and single-generic-word template
  // titles ("Home | Resort", "Useable Site") are pre-launch scaffolding, not an
  // operator's own site; they must never establish buyerUse.
  const placeholder = /^(?:home|my wordpress|hello world|welcome|index of|default web site page|loading[.!… ]*|redirecting[.!… ]*|placeholder(?: .*|$)|welcome to [a-z0-9.-]+!?|apache2? .*default page|cyberpanel installed|default web page|it works!?|apache2? (?:ubuntu|debian )?default page|test page for the (?:apache|nginx).*|welcome to (?:nginx|caddy|litespeed|openresty|apache)!?|plesk (?:default|obsidian).*|cpanel|website is under construction|default backend|hostinger website builder|site not found|this site can.?t be reached|domain default page|your website is ready|useable site|home \| [a-z0-9]+|[a-z0-9]+ site)$/i.test(title.trim()) || /\b(?:coming soon|under construction|site is being built|nothing here yet|future home of|website is coming|site en construction|en construcci[oó]n|em constru[cç][aã]o|website in aanbouw|seite im aufbau)\b/i.test(text.slice(0, 3000));
  const spam = /\b(?:casino|slots?|gacor|togel|judi|poker|sportsbook|betting|bandar|situs|mahjong|jackpot|lottery|rtp\s*live|porn|xxx|sex videos|escort|viagra|cialis|levitra|without prescription|online pharmacy(?! in)|semalt|indexjump|news insider|crypto exchange|обмен крипт|域名|出售)\b/i.test(text.slice(0, 4000) + ' ' + title);
  const forSale = knownLander || campaign || domainSale || storefront || (offer && domainContext);
  const baseKind = forSale ? 'sales-lander' : status < 200 || status >= 300 || challenge ? 'unavailable' : placeholder ? 'placeholder' : title.trim() ? 'operating' : 'unknown';
  const kind = spam && baseKind === 'operating' ? 'spam' : baseKind;
  return { kind, spam, forSale, knownLander, finalHost, reason: knownLander ? `Destination is a cataloged domain storefront (${finalHost}).` : campaign ? 'Destination identifies a portfolio-lander redirect.' : forSale ? 'Visible page offers a domain for purchase or lease.' : kind === 'spam' ? 'Destination content is gambling, adult, pharma or SEO spam; not an end-user brand.' : kind === 'unavailable' ? (accessWall ? 'Destination is behind an access wall; buyer use cannot be observed.' : 'HTTP error or browser challenge; use could not be verified.') : kind === 'placeholder' ? 'Default or pre-launch page does not establish buyer use.' : null };
}

// Same-host delivery is not evidence that an operator is adopting this name.
// Compare visible brand text or a matching brand redirect, keeping uncertainty
// explicit for unrelated destination branding instead of guessing its business.
function destinationIdentity({ domain = '', title = '', finalUrl = '', brandText = '' } = {}) {
  const compact = value => String(value).toLowerCase().replace(/[^a-z0-9]/g, '');
  const label = compact(String(domain).split('.')[0]);
  // Printing a raw domain into a template is not adoption of its brand.
  const withoutDomain = value => String(value || '').replace(new RegExp(String(domain).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '');
  const matches = value => label.length >= 4 ? compact(value).includes(label)
    : label.length >= 2 && String(value).toLowerCase().split(/[^a-z0-9]+/).includes(label);
  const finalHost = host(finalUrl);
  // A destination title that merely echoes "<domain> - <marketing line>" does not
  // establish adoption of the name; the heading repeats it too.
  const rawTitle = String(title || '').toLowerCase().trim();
  const escapedDomain = String(domain).toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const separatorPattern = [' - ', ' \\| ', ' — ', ' – ', ': '].join('|');
  const templateMatch = rawTitle.match(new RegExp(`^(?:www\\.)?${escapedDomain}(?:${separatorPattern})(.*)$`));
  const templateTitle = !!(templateMatch && !matches(templateMatch[1]));
  const titleAligned = templateTitle ? false : matches(withoutDomain(title));
  const headingAligned = templateTitle ? false : matches(withoutDomain(brandText));
  const redirectAligned = !!(finalHost && finalHost !== String(domain).toLowerCase().replace(/^www\./,'') && compact(finalHost.split('.')[0]) === label && label.length >= 2);
  return { aligned: titleAligned || headingAligned || redirectAligned, titleAligned, headingAligned, redirectAligned, finalHost, templateTitle };
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
  // Backdate departures to their true day: the recovered multi-day tape stamps
  // every departure in its window with the LAST day scanned. Two exact sources
  // of the true day exist: a same-day daily tape imported later (handled as a
  // day-refinement upsert in server/sale-watch-reconstruction.js, which rewrites
  // the stored day fields directly), and the registry RDAP lastChangedAt, which
  // for a nameserver change falls on the day the change happened. Only the
  // latter needs computing here, at assessment time, against whatever day is
  // still on file.
  const movement = d.movement || {};
  const storedDepartureDate = d.departureDate || entry.reportDate;
  const multiDayMovementWindow = !!(movement.prevDay && movement.day
    && Number.isFinite(Date.parse(movement.prevDay)) && Number.isFinite(Date.parse(movement.day))
    && Date.parse(movement.day) - Date.parse(movement.prevDay) > DAY);
  let observedDepartureDate = storedDepartureDate;
  let departureDaySource = 'tape';
  if (multiDayMovementWindow && rdap.lastChangedAt) {
    const lastChangedDay = String(rdap.lastChangedAt).slice(0, 10);
    if (Date.parse(lastChangedDay) > Date.parse(movement.prevDay) && Date.parse(lastChangedDay) <= Date.parse(movement.day)) {
      observedDepartureDate = lastChangedDay;
      departureDaySource = 'rdap-last-changed';
    }
  }
  const purpose = websitePurpose({ title: hp.title || entry.buyerTitle || '', finalUrl: hp.finalUrl || entry.buyerUrl || '', status: hp.status ?? 200 });
  const nameQuality = assessNameAlpha(entry.domain).tier;
  const delegation = delegationEvidence(entry);
  const expiration = delegation.expiration || (rdap.statuses || []).some(s => ['redemptionperiod','pendingdelete'].includes(normalizedStatus(s)));
  const forSale = delegation.parking || purpose.forSale || hp.purpose?.forSale || hp.parked || d.parkingInfrastructure || d.stillSellerDelegated;
  const pending = rdap.pendingTransfer === true || (rdap.statuses || []).some(s => normalizedStatus(s) === 'pendingtransfer');
  const transferredAt = rdap.transferAt || (rdap.events || []).filter(e => normalizedStatus(e.action || e.eventAction) === 'transfer').map(e => e.date || e.eventDate).sort().at(-1);
  const prevRdap = previous?.discovery?.rdap;
  const previouslyPending = prevRdap?.pendingTransfer === true || (prevRdap?.statuses || []).some(s => normalizedStatus(s) === 'pendingtransfer');
  const changedIdentity = prevRdap?.registrarId && rdap.registrarId ? prevRdap.registrarId !== rdap.registrarId : previouslyPending && !pending && prevRdap?.registrar && rdap.registrar && prevRdap.registrar.toLowerCase() !== rdap.registrar.toLowerCase();
  const registrarChanged = !!(!rdap.error && changedIdentity && sameDayWindow(previous.lastObservedAt, rdap.checkedAt, 14));
  const recentTransfer = !!(transferredAt && sameDayWindow(transferredAt, observedDepartureDate));
  const previousTransfer = d.transferEvidence || previous?.discovery?.transferEvidence;
  const recordedRegistrarChange = !!(previousTransfer?.registrarChanged && sameDayWindow(previousTransfer.observedAt, observedDepartureDate, 30));
  const transfer = { pending, transferAt: transferredAt || null, recentTransfer, registrarChanged: registrarChanged || recordedRegistrarChange,
    fromRegistrar: registrarChanged ? prevRdap.registrar : previousTransfer?.fromRegistrar || null, toRegistrar: rdap.registrar || null,
    observedAt: registrarChanged ? rdap.checkedAt : previousTransfer?.observedAt || rdap.checkedAt || null, locked: rdap.transferLocked === true || (rdap.statuses || []).some(s => /^(?:client|server)?transferprohibited$/.test(normalizedStatus(s))) };
  const datedAt = entry.lastObservedAt || rdap.checkedAt;
  const stale = !Number.isFinite(Date.parse(datedAt)) || Date.parse(now) - Date.parse(datedAt) > 3 * DAY || Date.parse(datedAt) > Date.parse(now) + DAY;
  const reported = !entry.discovery && !!entry.sourceUrl && !/dns\.coffee|rdap\.org/i.test(entry.sourceUrl) && ['verified','probable'].includes(entry.tier);
  const moved = d.structurallyMoved === true;
  const bulkMigration = Number(d.movement?.cohortSize || 0) >= 10;
  const bulkAdoption = Number(d.kit?.size || 0) >= 3;
  const registrarOrigin = d.registrarOrigin === true;
  const identity = destinationIdentity({domain:entry.domain,title:hp.title || entry.buyerTitle,finalUrl:hp.finalUrl || entry.buyerUrl,brandText:hp.brandText || ''});
  const parkingOrigin = delegation.parkingOrigin;
  const buyerUse = moved && d.buyerUse === true && identity.aligned && !hp.error && !hp.placeholder && !['placeholder','unavailable','unknown'].includes(hp.purpose?.kind) && purpose.kind === 'operating' && !forSale && !expiration && !delegation.suspended;
  // A dated registry transfer or registrar change near a marketplace departure is
  // itself the sale footprint: an end-user buyer does not need to have built a site
  // yet for the control change to count (basis 'transfer'). Staying off-market in a
  // small, non-bulk cohort long enough to rule out relisting is a second, independent
  // footprint (basis 'off-market'). Both stay separate from the built-site rule
  // (basis 'built'); registrar-origin rows never qualify for either (no marketplace
  // departure to reverse-engineer from).
  const marketplaceOrigin = delegation.sellerOrigin === true;
  const recentTransfer14 = !!(transferredAt && sameDayWindow(transferredAt, observedDepartureDate, 14));
  const transferNearDeparture = recentTransfer14 || pending || registrarChanged || recordedRegistrarChange;
  const cleanDestination = !forSale && !expiration && !delegation.suspended && !delegation.parking && !bulkMigration && !bulkAdoption;
  const rawDaysSinceDeparture = Math.floor((Date.parse(now) - Date.parse(observedDepartureDate)) / DAY);
  const daysSinceDeparture = Number.isFinite(rawDaysSinceDeparture) ? rawDaysSinceDeparture : 0;
  const relisted = ['seller', 'parking'].includes(d.followUpMovement?.currentClass) || d.followUpMovement?.relisted === true;
  const offMarketQuiet = marketplaceOrigin && moved && cleanDestination && Number(d.movement?.cohortSize || 0) < 10 && ['registrar', 'hosting', 'other'].includes(d.movement?.currentClass) && daysSinceDeparture >= 14 && !relisted;
  let tier = 'suspected', classification = 'unconfirmed-move', reason, basis = null;
  if (reported) { tier = entry.tier; classification = 'reported-sale'; reason = entry.rationale; }
  else if (expiration) { tier = 'excluded'; classification = 'expiration'; reason = 'Current delegation or registry status indicates expiration or deletion processing. This is not evidence of an end-user purchase; retain the history and recheck.'; }
  else if (delegation.suspended) { tier = 'excluded'; classification = 'registry-hold'; reason = 'Destination nameservers indicate contact-verification failure or suspension. Keep following the domain, but this administrative change is not an acquisition lead.'; }
  else if (pending && !stale) { tier = 'transfer'; classification = 'transfer-in-progress'; reason = 'Registry reports pending transfer to another registrar. Sale and ownership change are unconfirmed; a lander may remain during transfer.'; }
  else if (forSale) { tier = 'excluded'; classification = 'lander-migration'; reason = purpose.reason || hp.purpose?.reason || 'Current evidence still points to sale or parking infrastructure; no buyer use established.'; }
  else if (marketplaceOrigin && moved && transferNearDeparture && cleanDestination && !stale) { tier = 'probable'; classification = 'likely-sale'; basis = 'transfer'; reason = 'Left marketplace DNS and the registry recorded a transfer to another registrar within 14 days. Buyer use is not required: the control change is the sale footprint. Owner consolidation across registrars remains possible.'; }
  // Registrar-origin rows (never on marketplace/parking DNS) must fall through to
  // the registrar-origin rule below instead of this built-site rule, even when a
  // dated transfer and an operating site are both present: registrar consolidation
  // reads identically to a sale here without independent marketplace evidence.
  // Parking-origin rows (Bodis/ParkingCrew/ParkLogic/Above) are not excluded here:
  // the required dated transfer/registrar-change clause already limits them, same
  // as any other seller-DNS departure.
  else if (moved && (entry.sellerNameservers || []).length > 0 && !registrarOrigin && buyerUse && !bulkMigration && !bulkAdoption && (recentTransfer || registrarChanged || recordedRegistrarChange) && !stale) { tier = 'probable'; classification = 'likely-sale'; basis = 'built'; reason = 'Seller-DNS departure and operating use are corroborated by a dated registrar transfer. A same-owner transfer or owner development remains possible; payment and ownership are not confirmed.'; }
  else if (offMarketQuiet && !stale) { tier = 'probable'; classification = 'likely-sale'; basis = 'off-market'; reason = `Left marketplace DNS for registrar-default or hosting nameservers in a small cohort and stayed off-market for ${daysSinceDeparture} days with no relisting or expiry. A same-registrar account transfer (marketplace fast transfer) leaves exactly this footprint; a withdrawn listing usually reappears on another marketplace instead.`; }
  else if (registrarOrigin && moved && buyerUse && (recentTransfer || registrarChanged || recordedRegistrarChange) && !bulkMigration && !bulkAdoption && !stale) { tier = 'suspected'; classification = 'transferred-and-built'; reason = 'The name changed registrar near its move off registrar-default DNS and now serves an operating site under its own brand. No marketplace listing was observed, so this may be a private sale or an owner consolidating registrars; treat as a lead, not a confirmed sale.'; }
  else if (moved && (registrarChanged || recordedRegistrarChange || recentTransfer) && !bulkAdoption && !stale) { tier='transfer'; classification='transfer-completed'; reason=`Seller-DNS departure is followed by a registrar transfer${transfer.fromRegistrar && transfer.toRegistrar ? ` from ${transfer.fromRegistrar} to ${transfer.toRegistrar}` : ''}. An end-user acquisition is not established; continue watching the destination. Payment and ownership remain unconfirmed.`; }
  else if (bulkAdoption && !stale) { tier = 'suspected'; classification = 'portfolio-kit'; reason = `${d.kit.size} names moved to the same destination brand within 30 days; one operator adopting many names is a portfolio or storefront, not an end-user acquisition.`; }
  else if (buyerUse && !registrarOrigin && !stale) { classification='acquisition-candidate'; reason='Observed seller departure followed by an operating destination. This is an unreported acquisition candidate, awaiting independent control-change evidence and follow-up; owner development is still possible.'; }
  else if (moved && delegation.sellerOrigin && delegation.destinationObserved && !bulkMigration && !stale && sameDayWindow(observedDepartureDate, now, 3)) { classification = 'seller-departure'; reason = 'Left identifiable sale infrastructure for a destination outside known parking and landers. This is an early lead, not a sale: owner development or an uncataloged migration remains possible. Follow-up is required.'; }
  else { reason = stale ? 'Historical observation is older than 72 hours; current sale or transfer status needs rechecking.' : 'DNS departure, a matching title, mail setup or an RDAP last-change timestamp cannot establish a sale. Independent transfer or transaction evidence is missing.'; }
  return { ...entry, tier, classification, rationale: reason, reportDate: observedDepartureDate,
    assessment: { version: VERSION, assessedAt: new Date(now).toISOString(), stale, reported, delegation, buyerUse: !!buyerUse, identity, parkingOrigin, transfer, basis, daysSinceDeparture, departureDay: observedDepartureDate, departureDaySource, nameQuality, contentQuality: purpose.spam ? 'spam' : 'ok',
      signals: [moved && 'Seller-DNS departure observed', buyerUse && 'Matching-brand operating destination observed', pending && 'Registry pending transfer', recentTransfer && 'Dated registry transfer', (registrarChanged || recordedRegistrarChange) && 'Observed registrar change', rdap.lastChangedAt && 'RDAP last changed (not sale proof)', registrarOrigin && 'Registrar-default origin (no marketplace listing observed)', transferNearDeparture && 'Registry transfer within 14 days of departure', offMarketQuiet && 'Stayed off-market after leaving marketplace DNS'].filter(Boolean),
      counterEvidence: [expiration && 'Expiration/deletion evidence contradicts a purchase inference', delegation.parking && 'Destination DNS remains on known parking or sale infrastructure', parkingOrigin && 'Prior delegation was parking infrastructure, not proof of a seller lander', !identity.aligned && moved && 'Destination branding does not establish adoption of this name', purpose.kind === 'placeholder' && purpose.reason, bulkMigration && `${d.movement.cohortSize} departures share this exact destination DNS set; a coordinated migration is possible`, bulkAdoption && `${d.kit.size} names share this destination brand; one operator adopting many names is a portfolio, not an end-user purchase`, rdap.error && `RDAP lookup unavailable: ${rdap.error}`, hp.error && `Website lookup unavailable: ${hp.error}`, forSale && (purpose.reason || 'Sale/parking destination persists'), stale && 'Current observation is stale', !reported && 'Payment and change of owner are not observed', !recentTransfer && !pending && !registrarChanged && !recordedRegistrarChange && 'No dated registrar transfer evidence'].filter(Boolean),
    },
    ...(entry.discovery ? { discovery: { ...d, transferEvidence: transfer } } : {}),
  };
}
function isAcquisitionLead(entry) {
  return ['likely-sale', 'acquisition-candidate', 'seller-departure', 'transfer-in-progress', 'transfer-completed', 'transferred-and-built'].includes(entry.classification) && !entry.assessment?.delegation?.expiration;
}

function isAlphaEntry(entry) {
  // 'transferred-and-built' (registrar-origin, no marketplace listing observed)
  // stays out of the alpha feed; it remains visible in leads/focus views.
  return ['likely-sale', 'acquisition-candidate'].includes(entry.classification)
    && entry.assessment?.nameQuality === 'alpha'
    && entry.assessment?.contentQuality !== 'spam'
    && !(Number(entry.discovery?.kit?.size || 0) >= 3);
}

const EVIDENCE_RANK_ORDER = ['likely-sale', 'transferred-and-built', 'acquisition-candidate', 'transfer-in-progress', 'transfer-completed', 'seller-departure', 'reported-sale'];
function evidenceRank(entry) {
  const idx = EVIDENCE_RANK_ORDER.indexOf(entry.classification);
  return idx === -1 ? 7 : idx;
}

function matchesSaleView(entry, view = 'all') {
  if (entry.classification === 'reported-sale') return false;
  if (view === 'leads') return isAcquisitionLead(entry);
  if (view === 'alpha') return isAlphaEntry(entry);
  if (view === 'focus') return ['likely-sale','acquisition-candidate','transfer-in-progress','transfer-completed','transferred-and-built'].includes(entry.classification);
  if (['transfer','probable','suspected','excluded'].includes(view)) return entry.tier === view;
  return true;
}

module.exports = { matchesSaleView, isAcquisitionLead, isAlphaEntry, evidenceRank, VERSION, websitePurpose, destinationIdentity, rdapEvidence, assessSaleEntry };
