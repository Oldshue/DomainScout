'use strict';

// Names the owner is watching.
//
// The star on a row saves that one listing, and most auction rows (the big
// provider snapshots) cannot be starred at all. Watching is by name instead:
// tap the eye on any row, or type a name that is not listed anywhere yet, and
// it is on the watchlist until removed. An agent connected through the tool
// server (server/mcp-oauth.js) reads this list with where each name is listed
// right now, so the owner hears the moment a watched name comes up at auction.
//
// Kept in its own small file on the data volume so the eye never waits on the
// main database.

const path = require('node:path');
const Database = require('better-sqlite3');
const { STREAM_DESCRIPTORS } = require('./provider-snapshot-registry');

const MAX_NAMES = 2000;
const LOOKUP_CACHE_MS = 3 * 60 * 1000;

// A domain as typed or pasted, in the form it is stored: lowercase host only.
function normalizeDomain(value) {
  const host = String(value || '').trim().toLowerCase()
    .replace(/^[a-z]+:\/\//, '').replace(/^www\./, '').split(/[/?#\s]/)[0].replace(/\.$/, '');
  return /^(?=.{3,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(host) ? host : '';
}

function openWatchlist({ dataDir, port }) {
  const db = new Database(path.join(dataDir, 'watchlist.db'));
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE IF NOT EXISTS watched (domain TEXT PRIMARY KEY, added INTEGER NOT NULL)');
  const names = () => db.prepare('SELECT domain, added FROM watched ORDER BY domain').all();
  const cache = new Map();

  // Where one name is listed right now, across every inventory stream.
  async function listingsFor(domain) {
    const hit = cache.get(domain);
    if (hit && Date.now() - hit.at < LOOKUP_CACHE_MS) return hit.rows;
    const label = domain.split('.')[0];
    const found = new Map();
    // Every venue board (a provider snapshot each: GoDaddy, Namecheap, Dynadot)
    // and the stored streams are searched separately; each is asked for names
    // starting with the label. A venue added to the registry is searched too.
    for (const stream of [...STREAM_DESCRIPTORS.map(d => d.stream), '']) {
      const url = new URL(`http://127.0.0.1:${port}/api/domains`);
      url.searchParams.set('q', label);
      url.searchParams.set('searchMode', 'prefix');
      url.searchParams.set('limit', '200');
      if (stream) url.searchParams.set('stream', stream);
      try {
        const r = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
        if (!r.ok) continue;
        for (const d of (await r.json()).domains || []) {
          if (String(d.domain).toLowerCase() !== domain) continue;
          found.set(`${d.stream}|${d.auction_end}`, {
            venue: d.source || d.stream,
            listing: d.stream,
            endsAt: d.auction_end || null,
            url: d.auction_url || null,
          });
        }
      } catch { /* that stream is tried again on the next read */ }
    }
    const rows = [...found.values()].sort((a, b) => String(a.endsAt).localeCompare(String(b.endsAt)));
    cache.set(domain, { at: Date.now(), rows });
    return rows;
  }

  return {
    db,
    names,
    has: domain => !!db.prepare('SELECT 1 FROM watched WHERE domain = ?').get(domain),
    add(value) {
      const domain = normalizeDomain(value);
      if (!domain) throw new Error('That is not a domain name.');
      if (db.prepare('SELECT COUNT(*) AS n FROM watched').get().n >= MAX_NAMES) throw new Error('The watchlist is full. Remove a name first.');
      db.prepare('INSERT OR IGNORE INTO watched VALUES (?, ?)').run(domain, Date.now());
      return domain;
    },
    remove(value) {
      const domain = normalizeDomain(value);
      if (domain) db.prepare('DELETE FROM watched WHERE domain = ?').run(domain);
      cache.delete(domain);
      return domain;
    },
    // Every watched name with where it is listed now. Changes only when a
    // name is added or removed, a listing appears or ends, or an end time moves.
    async current() {
      const now = Date.now();
      const out = [];
      const list = names();
      for (let i = 0; i < list.length; i += 4) {
        const batch = await Promise.all(list.slice(i, i + 4).map(async n => {
          const listings = await listingsFor(n.domain);
          return { domain: n.domain, atAuctionNow: listings.some(l => l.endsAt && Date.parse(l.endsAt) > now), listings };
        }));
        out.push(...batch);
      }
      return out;
    },
    // Routes for the app itself. Mounted behind the login.
    routes(app) {
      const reply = res => res.json({ domains: names().map(n => n.domain), count: names().length });
      app.get('/api/watch', (_req, res) => reply(res));
      app.put('/api/watch/:domain', (req, res) => {
        try { this.add(req.params.domain); } catch (err) { return res.status(400).json({ error: err.message }); }
        reply(res);
      });
      app.delete('/api/watch/:domain', (req, res) => { this.remove(req.params.domain); reply(res); });
      app.get('/api/watch/listings', async (_req, res) => res.json({ names: await this.current() }));
    },
  };
}

module.exports = { openWatchlist, normalizeDomain };
