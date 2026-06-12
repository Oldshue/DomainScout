// Volume maintenance server. Boots WITHOUT opening SQLite, so it stays up even
// when the data volume is full and the real app crash-loops. Lets an operator
// inspect disk usage and delete regenerable artifacts over HTTP, then restore
// the normal start command. Guards: never deletes domains.db (the core data),
// never escapes the volume root, token-gated mutations.
const http = require('http');
const fs = require('fs');
const path = require('path');

const VOL = process.env.RAILWAY_VOLUME_MOUNT_PATH || '/data';
const PORT = process.env.PORT || 8080;
const TOKEN = process.env.DOMAINSCOUT_AGENT_TOKEN || '';
const PROTECTED = new Set(['domains.db']); // never delete the core dataset

function walk(dir) {
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    try {
      if (e.isDirectory()) out.push(...walk(full));
      else { const st = fs.statSync(full); out.push({ path: full, size: st.size }); }
    } catch { /* vanished mid-walk */ }
  }
  return out;
}

function diskReport() {
  let stat = null;
  try { const s = fs.statfsSync(VOL); stat = { totalMB: +(s.blocks * s.bsize / 1e6).toFixed(1), freeMB: +(s.bfree * s.bsize / 1e6).toFixed(1) }; } catch (e) { stat = { error: e.message }; }
  const files = walk(VOL).sort((a, b) => b.size - a.size);
  return {
    volume: VOL,
    disk: stat,
    totalFiles: files.length,
    largest: files.slice(0, 40).map(f => ({ path: f.path, MB: +(f.size / 1e6).toFixed(2) })),
  };
}

function safeTarget(p) {
  const resolved = path.resolve(p);
  if (!resolved.startsWith(path.resolve(VOL) + path.sep)) return { ok: false, reason: 'outside volume' };
  if (PROTECTED.has(path.basename(resolved))) return { ok: false, reason: 'protected file' };
  return { ok: true, resolved };
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const json = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body, null, 2)); };

  // Healthcheck — keep the deploy alive.
  if (url.pathname === '/api/stats' || url.pathname === '/healthz') {
    return json(200, { ok: true, mode: 'volume-maintenance', ...diskReport() });
  }
  if (url.pathname === '/_maint/report') return json(200, diskReport());

  // Token-gated delete. Accepts ?path= (single) or ?glob=<basename-substring>.
  if (url.pathname === '/_maint/rm') {
    if (!TOKEN || url.searchParams.get('token') !== TOKEN) return json(403, { error: 'forbidden' });
    const deleted = [];
    const errors = [];
    const targets = [];
    if (url.searchParams.get('path')) targets.push(url.searchParams.get('path'));
    const glob = url.searchParams.get('glob');
    if (glob) {
      for (const f of walk(VOL)) {
        if (path.basename(f.path).includes(glob)) targets.push(f.path);
      }
    }
    for (const t of targets) {
      const chk = safeTarget(t);
      if (!chk.ok) { errors.push({ path: t, reason: chk.reason }); continue; }
      try { fs.rmSync(chk.resolved, { force: true }); deleted.push(chk.resolved); }
      catch (e) { errors.push({ path: t, reason: e.message }); }
    }
    return json(200, { deleted, errors, after: diskReport().disk });
  }

  json(404, { error: 'not found' });
}).listen(PORT, () => {
  console.log(`[volume-maint] up on :${PORT}, volume=${VOL}`);
  const r = diskReport();
  console.log(`[volume-maint] disk: ${JSON.stringify(r.disk)}; largest: ${r.largest.slice(0, 8).map(f => f.path.split('/').pop() + '=' + f.MB + 'MB').join(', ')}`);
});
