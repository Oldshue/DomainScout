/**
 * Live GoDaddy auction bid/price fetcher.
 *
 * GoDaddy's downloadable inventory feed regenerates only ONCE per day, so stored
 * auction_price/bid_count are up to a day stale — useless for spotting auctions
 * heating up. The live truth is the per-listing endpoint:
 *     GET https://www.godaddy.com/domain-auctions/api/listing/{listingId}
 * returning currentPrice, bidsOrOffersCount, nextBidPrice, endTime, listingStatus
 * (prices in micro-dollars). The listingId is already embedded in every stored
 * auction_url (…-<id>?isc=json_biddable).
 *
 * That endpoint is behind Akamai Bot Manager. Empirically (see the long probe in the
 * build): a plain request, headless Chrome, and headless Chromium ALL get a hard
 * "Access Denied" — Akamai blocks on the "HeadlessChrome" UA token and on the
 * SwiftShader WebGL renderer (the headless tell). What passes is REAL Google Chrome,
 * HEADFUL (so a real GPU / Metal WebGL renderer), with its genuine Chrome UA. So we
 * drive system Chrome via playwright-core (channel:'chrome', headless:false) in an
 * offscreen window, keep one page warmed on the auctions origin, and run the listing
 * fetches from inside that page (page-context fetch passes Akamai).
 *
 * Local-only and deliberately opt-in: this integration needs a real, headed Chrome
 * window. macOS does not reliably honor Chrome's offscreen window coordinates, so an
 * automatic warm-up can steal focus and expose the seed listing in the user's normal
 * desktop. The daily GoDaddy feed remains the safe default; operators who explicitly
 * accept headed browser automation can enable the live overlay with
 * DOMAINSCOUT_ENABLE_HEADED_LIVE_BIDS=1.
 */
const ENABLED = process.env.DOMAINSCOUT_ENABLE_HEADED_LIVE_BIDS === '1';
const REWARM_MS = Math.max(60_000, parseInt(process.env.LIVE_BIDS_REWARM_MS || '240000', 10));
const FETCH_CONCURRENCY = Math.max(1, parseInt(process.env.LIVE_BIDS_CONCURRENCY || '4', 10));
const NAV_TIMEOUT = 35_000;

let _pw = null;
try { _pw = require('playwright-core'); } catch { _pw = null; }

const API_BASE = 'https://www.godaddy.com/domain-auctions/api/listing/';
let _browser = null;
let _page = null;
let _warmedAt = 0;
let _starting = null;
let _seedId = null; // a real listing id from the current batch — used to warm on a www.godaddy.com page
let _unavailable = ENABLED ? (_pw ? null : 'playwright-core-missing') : 'headed-browser-disabled';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function launch() {
  if (!ENABLED) { _unavailable = 'disabled'; return false; }
  if (!_pw) { _unavailable = 'playwright-core-missing'; return false; }
  try {
    _browser = await _pw.chromium.launch({
      channel: 'chrome',          // REAL Google Chrome (not Chromium / not Chrome-for-Testing)
      headless: false,            // headful → real GPU → Metal WebGL, no SwiftShader tell
      args: [
        '--window-position=-32000,-32000', // offscreen — effectively invisible
        '--window-size=1280,900',
        '--disable-blink-features=AutomationControlled',
        '--no-first-run', '--no-default-browser-check', '--mute-audio',
      ],
    });
    _browser.on('disconnected', () => { _browser = null; _page = null; _warmedAt = 0; });
    _page = await _browser.newPage();
    return true;
  } catch (e) { _unavailable = `launch:${(e.message || e).toString().slice(0, 80)}`; _browser = null; _page = null; return false; }
}

// Warm on a www.godaddy.com LISTING page (the bare /domain-auctions/ index 302s to
// auctions.godaddy.com/beta — a different origin where the relative API path returns
// SPA HTML, not JSON). A minimal slug + real id (x-<id>) resolves the listing and
// stays on www.godaddy.com. Then confirm a page-context API fetch is past Akamai
// (any status but 403; id 0 → 404 when through). All fetches use absolute URLs so
// origin can never drift.
async function warm() {
  const seed = _seedId || '706833294';
  try {
    await _page.goto(`https://www.godaddy.com/domain-auctions/x-${seed}`, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
  } catch { /* slow nav is fine; the probe below decides */ }
  for (let i = 0; i < 25; i++) {
    await sleep(600);
    try {
      // True clearance = the API returns real JSON. A 200 with HTML is Akamai's soft
      // block (SPA shell) and must NOT count as warmed, or every fetch parses HTML.
      const ok = await _page.evaluate(async (url) => {
        try {
          const r = await fetch(url, { headers: { accept: 'application/json' }, credentials: 'include' });
          if (r.status === 403) return false;
          if (!(r.headers.get('content-type') || '').includes('json')) return false;
          const j = await r.json(); return !!(j && j.listingId);
        } catch { return false; }
      }, API_BASE + seed);
      if (ok) { _warmedAt = Date.now(); return true; }
    } catch {}
  }
  return false;
}

async function ensureWarm() {
  if (_starting) return _starting;
  _starting = (async () => {
    try {
      if (!_browser || !_page) { if (!await launch()) return false; }
      if (Date.now() - _warmedAt > REWARM_MS) { if (!await warm()) { _unavailable = 'akamai-challenge'; return false; } }
      _unavailable = null;
      return true;
    } catch (e) { _unavailable = (e.message || e).toString().slice(0, 80); return false; }
    finally { _starting = null; }
  })();
  return _starting;
}

function normalize(d) {
  if (!d || !d.listingId) return null;
  const cost = a => (Array.isArray(a) && a[0] && typeof a[0].cost === 'number') ? a[0].cost / 1e6 : null;
  return {
    listingId: d.listingId,
    domain: d.domainName || null,
    bids: d.bidsOrOffersCount ?? null,
    price: cost(d.currentPrice),
    nextBid: cost(d.nextBidPrice),
    priceType: d.priceType || null,
    status: d.listingStatus || null,
    endTime: d.endTime || null,
    estValue: cost(d.estimatedValue),
    lastUpdated: d.lastUpdatedTime || null,
  };
}

/**
 * fetchLive(listingIds) → { ok, results: [normalized], unavailable? }
 * Runs the per-listing fetches inside the warmed page with bounded concurrency + jitter.
 */
async function fetchLive(listingIds) {
  const ids = [...new Set((listingIds || []).map(String).filter(s => /^\d+$/.test(s)))];
  if (!ids.length) return { ok: true, results: [] };
  _seedId = ids[0];
  if (!await ensureWarm()) return { ok: false, unavailable: _unavailable || 'unavailable', results: [] };

  let raw;
  try {
    raw = await _page.evaluate(async ({ ids, conc, base }) => {
      const out = []; let i = 0;
      async function worker() {
        while (i < ids.length) {
          const id = ids[i++];
          try {
            const r = await fetch(base + id, { headers: { accept: 'application/json' }, credentials: 'include' });
            if (r.status === 403) { out.push({ __blocked: true }); continue; }
            if (!r.ok) { out.push({ listingId: Number(id), __status: r.status }); continue; }
            out.push(await r.json());
          } catch (e) { out.push({ listingId: Number(id), __err: String(e) }); }
          await new Promise(s => setTimeout(s, 40 + Math.floor(Math.random() * 120))); // polite jitter
        }
      }
      await Promise.all(Array.from({ length: Math.min(conc, ids.length) }, worker));
      return out;
    }, { ids, conc: FETCH_CONCURRENCY, base: API_BASE });
  } catch (e) { return { ok: false, unavailable: (e.message || e).toString().slice(0, 80), results: [] }; }

  if (process.env.LIVE_BIDS_DEBUG === '1') console.error('[live-listings raw]', JSON.stringify((raw || [])[0]));
  if (Array.isArray(raw) && raw.some(x => x && x.__blocked)) { _warmedAt = 0; } // force re-warm next call
  return { ok: true, results: (raw || []).map(normalize).filter(Boolean) };
}

function status() {
  return { enabled: ENABLED, available: !!_browser, warmedAt: _warmedAt ? new Date(_warmedAt).toISOString() : null, unavailable: _unavailable };
}

async function shutdown() { try { await _browser?.close(); } catch {} _browser = null; _page = null; _warmedAt = 0; }
process.on('exit', () => { try { _browser?.close(); } catch {} });

module.exports = { fetchLive, status, shutdown, ENABLED };
