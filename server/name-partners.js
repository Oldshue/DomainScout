'use strict';

// Partner words: for anchors such as "labs" and "ai", the words registered
// alongside them in the most zones (X in X+labs), and whether X+target (or
// target+X) is registered for each target keyword. Ranking is index-only on
// the universe summary. The summary carries no row for a label held only in an
// anchor zone such as .com, so those are settled by one authoritative probe at
// the zone's own nameservers; `status` is then taken, open or unknown, never a
// guess. An open .com still gets a registry check by the buyer before purchase.
//   GET /api/name-partners?anchors=labs,ai&targets=inference,compute
//       &position=suffix&targetPosition=suffix|prefix&limit=2000
async function mapLimitNamePartners(items, limit, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; await fn(items[i]); }
  });
  await Promise.all(workers);
}

function registerNamePartnersRoutes(app, { getZoneTruth, getResolver }) {
  app.get('/api/name-partners', async (req, res) => {
    try {
      const list = value => String(value || '').toLowerCase().split(/[\s,]+/).map(v => v.replace(/[^a-z0-9-]/g, '')).filter(Boolean);
      const anchors = [...new Set(list(req.query.anchors || req.query.anchor))].slice(0, 8);
      const targets = [...new Set(list(req.query.targets || req.query.target))].slice(0, 8);
      if (!anchors.length || anchors.some(a => a.length < 2)) {
        return res.status(400).json({ error: 'anchors: one to eight words of 2+ characters' });
      }
      const side = value => String(value || '').toLowerCase() === 'prefix' ? 'prefix' : 'suffix';
      const position = side(req.query.position);
      const targetPosition = req.query.targetPosition == null ? position : side(req.query.targetPosition);
      // perAnchor is how deep each anchor is read before words are merged. It
    // stays deep even for a short page, or a word strong on one anchor never
    // meets its weaker pairing on another and the both-anchors rank is wrong.
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 1000, 1), 20000);
      const perAnchor = Math.min(Math.max(parseInt(req.query.perAnchor, 10) || Math.max(limit * 4, 5000), limit), 100000);
      const minLength = Math.max(parseInt(req.query.minLength, 10) || 2, 1);
      const maxLength = Math.max(parseInt(req.query.maxLength, 10) || 24, minLength);
      const lettersOnly = !['0', 'false', 'no'].includes(String(req.query.lettersOnly ?? '1').toLowerCase());
      const resolveAnchors = !['0', 'false', 'no'].includes(String(req.query.resolve ?? '1').toLowerCase());
      const zoneTruth = getZoneTruth();
      if (typeof zoneTruth.partners !== 'function') {
        return res.status(503).json({ error: 'partner words need the universe summary, which is not loaded' });
      }
      const words = new Map();
      for (const anchor of anchors) {
        for (const row of zoneTruth.partners(anchor, position, { limit: perAnchor })) {
          const w = row.word;
          if (w.length < minLength || w.length > maxLength) continue;
          if (lettersOnly && !/^[a-z]+$/.test(w)) continue;
          let entry = words.get(w);
          if (!entry) { entry = { word: w, anchors: {}, anchorsMatched: 0, zones: 0 }; words.set(w, entry); }
          entry.anchors[anchor] = row.tld_count;
          entry.anchorsMatched += 1;
          entry.zones += row.tld_count;
        }
      }
      const ranked = [...words.values()].sort((a, b) =>
        b.anchorsMatched - a.anchorsMatched || b.zones - a.zones || (a.word < b.word ? -1 : 1));
      const page = ranked.slice(0, limit);
      const pending = [];
      for (const entry of page) {
        if (!targets.length) break;
        entry.targets = {};
        for (const target of targets) {
          const name = targetPosition === 'prefix' ? target + entry.word : entry.word + target;
          const membership = zoneTruth.zoneMembership ? zoneTruth.zoneMembership(name) : zoneTruth.nameZones(name);
          const zones = membership.tlds || [];
          const unresolved = membership.unresolved || [];
          const result = {
            name,
            zones,
            unresolved,
            status: zones.length ? 'taken' : (membership.exact && !unresolved.length ? 'open' : 'unknown'),
          };
          entry.targets[target] = result;
          if (!zones.length && membership.exact && unresolved.length) pending.push(result);
        }
      }
      let probed = 0;
      if (resolveAnchors && pending.length) {
        const resolver = getResolver();
        const budget = pending.slice(0, 6000);
        await mapLimitNamePartners(budget, 48, async result => {
          const still = [];
          for (const tld of result.unresolved) {
            const answer = await resolver.probe(result.name + tld);
            probed += 1;
            if (answer.status === 'taken') result.zones.push(tld);
            else if (answer.status !== 'not_taken') still.push(tld);
          }
          result.unresolved = still;
          result.status = result.zones.length ? 'taken' : (still.length ? 'unknown' : 'open');
        });
      }
      res.json({ anchors, targets, position, targetPosition, total: ranked.length, probed, asOf: zoneTruth.asOf || null, words: page });
    } catch (err) {
      console.error('[name-partners]', err);
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = { registerNamePartnersRoutes };
