/**
 * Expiry scanner — RDAP for .ai/.io/.sh/.bot, raw WHOIS TCP for others
 *
 * Strategy:
 *  1. Pick "discovered" domains from DB that haven't been WHOIS/RDAP-checked yet
 *  2. For .ai/.io/.sh/.bot → use RDAP (JSON, structured, no parsing fragility)
 *     - .ai RDAP: https://rdap.identitydigital.services/rdap/domain/{domain}
 *     - Proxy:    https://rdap.org/domain/{domain} (auto-routes to correct RDAP server)
 *  3. For .com/.net/.org → raw WHOIS TCP port 43 (CZDS zone diffs handle drops anyway)
 *  4. Domains expiring within 90 days → promoted to "pending-delete" stream
 *
 * Rate limits:
 *   - rdap.org proxy: ~3 req/sec safe
 *   - whois.nic.ai (legacy): very restrictive, skip raw WHOIS for .ai
 *   - whois.nic.io: 2-3 req/sec
 */
const net   = require('net');
const axios = require('axios');

// Only use raw WHOIS TCP for TLDs where RDAP is unreliable
const WHOIS_SERVERS = {
  '.io':  'whois.nic.io',
  '.sh':  'whois.nic.sh',
  '.bot': 'whois.nic.bot',
};

// RDAP is preferred — covers all target TLDs including .ai
const RDAP_TLDS = new Set(['.ai', '.io', '.sh', '.bot', '.com', '.net', '.org']);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * RDAP query via rdap.org proxy (routes to correct authoritative RDAP server)
 * For .ai this resolves to rdap.identitydigital.services/rdap/domain/{domain}
 */
async function rdapQuery(domain) {
  try {
    const resp = await axios.get(
      `https://rdap.org/domain/${encodeURIComponent(domain)}`,
      {
        timeout: 12000,
        headers: {
          Accept: 'application/rdap+json, application/json',
          'User-Agent': 'DomainScout/1.0',
        },
      }
    );

    const data = resp.data;
    const events = data.events || [];

    const expEvent = events.find(e =>
      e.eventAction === 'expiration' || e.eventAction === 'expiry'
    );
    const regEvent = events.find(e => e.eventAction === 'registration');

    const expiryDate = expEvent?.eventDate
      ? new Date(expEvent.eventDate).toISOString()
      : null;

    let ageYears = null;
    if (regEvent?.eventDate) {
      const created = new Date(regEvent.eventDate);
      ageYears = Math.floor((Date.now() - created.getTime()) / (365.25 * 24 * 60 * 60 * 1000));
    }

    return { expiry_date: expiryDate, age_years: ageYears };
  } catch (err) {
    // 404 = domain not found / available; other errors = transient, skip
    return { expiry_date: null, age_years: null };
  }
}

/**
 * Raw WHOIS query via TCP port 43 (fallback for TLDs with poor RDAP coverage)
 */
function whoisQuery(domain, server) {
  return new Promise((resolve, reject) => {
    const client = new net.Socket();
    let data = '';
    client.setTimeout(10000);
    client.connect(43, server, () => { client.write(domain + '\r\n'); });
    client.on('data', chunk => { data += chunk.toString(); });
    client.on('end', () => resolve(data));
    client.on('timeout', () => { client.destroy(); reject(new Error('WHOIS timeout')); });
    client.on('error', err => reject(err));
  });
}

function parseExpiryDate(whoisText) {
  const patterns = [
    /Registry Expiry Date:\s*([^\r\n]+)/i,
    /Expiry Date:\s*([^\r\n]+)/i,
    /Expiration Date:\s*([^\r\n]+)/i,
    /paid-till:\s*([^\r\n]+)/i,
    /expire:\s*([^\r\n]+)/i,
  ];
  for (const re of patterns) {
    const m = whoisText.match(re);
    if (m) {
      const d = new Date(m[1].trim());
      if (!isNaN(d.getTime())) return d.toISOString();
    }
  }
  return null;
}

/**
 * Get expiry date for a single domain.
 * Prefers RDAP; falls back to raw WHOIS for non-.ai ccTLDs.
 */
async function getExpiry(domain) {
  const tld = domain.slice(domain.lastIndexOf('.'));

  // .ai always uses RDAP (whois.nic.ai is extremely rate-limited and deprecated)
  if (tld === '.ai' || !WHOIS_SERVERS[tld]) {
    return rdapQuery(domain);
  }

  // Other ccTLDs: try RDAP first, fall back to raw WHOIS
  const rdap = await rdapQuery(domain);
  if (rdap.expiry_date) return rdap;

  // WHOIS fallback
  try {
    const text = await whoisQuery(domain, WHOIS_SERVERS[tld]);
    const expiry_date = parseExpiryDate(text);
    return { expiry_date, age_years: null };
  } catch (_) {
    return { expiry_date: null, age_years: null };
  }
}

/**
 * Download and parse Tranco top-1M list for .ai/.io/.sh/.bot domain seeds.
 * Only seeds TLDs that have no zone files.
 */
async function fetchTrancoSeed() {
  console.log('[Expiry] Fetching Tranco top-1M seed list...');
  const TARGET_TLDS = ['.ai', '.io', '.sh', '.bot'];
  const url = 'https://tranco-list.eu/top-1m.csv.zip';

  try {
    const resp = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 60000,
      headers: { 'User-Agent': 'DomainScout/1.0' },
    });

    const { promisify } = require('util');
    const zlib = require('zlib');
    const buf = Buffer.from(resp.data);

    const sig = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
    let offset = buf.indexOf(sig);
    if (offset < 0) throw new Error('Invalid ZIP');

    const fnLen    = buf.readUInt16LE(offset + 26);
    const extraLen = buf.readUInt16LE(offset + 28);
    const dataStart = offset + 30 + fnLen + extraLen;
    const compressedSize = buf.readUInt32LE(offset + 18);
    const compressedData = buf.slice(dataStart, dataStart + compressedSize);

    const inflateRaw = promisify(zlib.inflateRaw);
    const csv = (await inflateRaw(compressedData)).toString('utf8');

    const domains = [];
    for (const line of csv.split('\n')) {
      const [, domain] = line.split(',');
      if (!domain) continue;
      const d = domain.trim().toLowerCase();
      const dotIdx = d.lastIndexOf('.');
      const tld = dotIdx >= 0 ? d.slice(dotIdx) : '';
      if (!TARGET_TLDS.includes(tld)) continue;
      const name = d.slice(0, dotIdx);
      if (!name || name.includes('.')) continue;
      domains.push({
        domain: d, tld,
        length: name.length,
        has_numbers: /\d/.test(name) ? 1 : 0,
        has_hyphens: /-/.test(name) ? 1 : 0,
        stream: 'discovered',
        source: 'Tranco Top-1M',
      });
    }

    console.log(`[Expiry] Tranco seed: ${domains.length} ccTLD domains`);
    return domains;
  } catch (err) {
    console.error('[Expiry] Tranco fetch failed:', err.message);
    return [];
  }
}

/**
 * Poll expiry for a batch of domains concurrently.
 * Returns domains expiring within daysThreshold.
 */
async function pollExpiryBatch(domains, daysThreshold = 90, concurrency = 5, delayMs = 350) {
  const soon = Date.now() + daysThreshold * 86400000;
  const results = [];

  for (let i = 0; i < domains.length; i += concurrency) {
    const batch = domains.slice(i, i + concurrency);

    const batchResults = await Promise.all(batch.map(async (domain) => {
      const { expiry_date, age_years } = await getExpiry(domain);
      if (!expiry_date) return { domain, expiry_date: null, age_years, is_pending: false };

      const expiryMs = new Date(expiry_date).getTime();
      const daysUntil = Math.floor((expiryMs - Date.now()) / 86400000);
      const is_pending = daysUntil <= daysThreshold && daysUntil >= -30;

      if (is_pending) {
        console.log(`[Expiry] 🔥 ${domain} expires in ${daysUntil}d (${expiry_date.slice(0, 10)})`);
      }

      return { domain, expiry_date, age_years, daysUntil, is_pending };
    }));

    results.push(...batchResults);
    if (i + concurrency < domains.length) await sleep(delayMs);
  }

  return results;
}

/**
 * Main runner: seed from Tranco, poll unpolled domains from DB for expiry.
 */
async function runWhoisExpiry(db, opts = {}) {
  const { maxPoll = 300, daysThreshold = 90 } = opts;
  const TARGET_TLDS = ['.ai', '.io', '.sh', '.bot'];

  // NOTE: Tranco seeding removed — Tranco = most popular active sites (wrong source for expiring domains)
  // Only poll domains that arrived via real sources: auctions, crt.sh, pending-delete

  // Pick unpolled domains (any stream except discovered, target TLDs, not yet RDAP-checked)
  const toCheck = db.prepare(`
    SELECT domain FROM domains
    WHERE tld IN (${TARGET_TLDS.map(() => '?').join(',')})
      AND whois_checked IS NULL
      AND stream != 'discovered'
    ORDER BY
      CASE stream
        WHEN 'pending-delete' THEN 1
        WHEN 'godaddy-auction' THEN 2
        ELSE 3
      END,
      discovered_at DESC
    LIMIT ?
  `).all(...TARGET_TLDS, maxPoll).map(r => r.domain);

  if (toCheck.length === 0) {
    console.log('[Expiry] No unpolled domains — all up to date');
    return { pending: [] };
  }

  console.log(`[Expiry] Polling ${toCheck.length} domains for expiry (RDAP)...`);
  const polled = await pollExpiryBatch(toCheck, daysThreshold, 5, 350);

  // 3. Write results back to DB
  // Update expiry fields on all matching rows for this domain (any stream)
  const updateExpiry = db.prepare(`
    UPDATE domains SET
      expiry_date   = @expiry_date,
      age_years     = COALESCE(@age_years, age_years),
      whois_checked = datetime('now'),
      drop_date     = CASE WHEN @is_pending = 1 THEN substr(@expiry_date, 1, 10) ELSE drop_date END
    WHERE domain = @domain
  `);

  // Insert a pending-delete row if one doesn't exist yet (avoids UNIQUE conflict)
  const upsertPending = db.prepare(`
    INSERT OR IGNORE INTO domains
      (domain, tld, stream, source, expiry_date, drop_date, length, has_numbers, has_hyphens)
    SELECT domain, tld, 'pending-delete', source,
           @expiry_date, substr(@expiry_date, 1, 10),
           length, has_numbers, has_hyphens
    FROM domains
    WHERE domain = @domain
    LIMIT 1
  `);

  const markChecked = db.prepare(
    `UPDATE domains SET whois_checked = datetime('now') WHERE domain = @domain`
  );

  db.transaction(results => {
    for (const r of results) {
      if (r.expiry_date) {
        updateExpiry.run({
          domain:      r.domain,
          expiry_date: r.expiry_date,
          age_years:   r.age_years ?? null,
          is_pending:  r.is_pending ? 1 : 0,
        });
        if (r.is_pending) {
          upsertPending.run({ domain: r.domain, expiry_date: r.expiry_date });
        }
      } else {
        markChecked.run({ domain: r.domain });
      }
    }
  })(polled);

  const pending = polled.filter(r => r.is_pending);
  console.log(`[Expiry] Done: ${polled.length} polled, ${pending.length} pending-delete`);

  return {
    pending: pending.map(r => ({
      domain:           r.domain,
      expiry_date:      r.expiry_date,
      days_until_expiry: r.daysUntil,
    })),
  };
}

module.exports = { runWhoisExpiry, getExpiry, fetchTrancoSeed };
