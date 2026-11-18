'use strict';

// DomainScout as a tool server (MCP) that an agent platform connects to by
// sign-in, with no token to copy.
//
// An app that speaks the Model Context Protocol points at POST /mcp. It is
// told where sign-in lives, registers itself, sends the owner to
// /oauth/authorize (the ordinary DomainScout login guards that page), and on
// approval receives a read-only token it renews by itself. The tools read the
// same GET /api/* routes the agent token reads; nothing here can write.
//
// Spec: MCP authorization (OAuth 2.1 + PKCE, RFC 9728 protected resource
// metadata, RFC 8414 server metadata, RFC 7591 dynamic client registration).

const crypto = require('node:crypto');
const path = require('node:path');
const Database = require('better-sqlite3');
const { describeApi } = require('./api-descriptor');

const ACCESS_MS = 60 * 60 * 1000;
const REFRESH_MS = 180 * 24 * 60 * 60 * 1000;
const CODE_MS = 5 * 60 * 1000;
const MAX_CLIENTS = 500;
const MAX_RESULT_CHARS = 120000;
const PROTOCOL = '2025-06-18';

const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const random = bytes => crypto.randomBytes(bytes).toString('base64url');
const escapeHtml = value => String(value || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function openStore(dataDir) {
  const db = new Database(path.join(dataDir, 'mcp-oauth.db'));
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS clients (client_id TEXT PRIMARY KEY, name TEXT NOT NULL, redirect_uris TEXT NOT NULL, created INTEGER NOT NULL, used INTEGER);
    CREATE TABLE IF NOT EXISTS codes (hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL, challenge TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS tokens (hash TEXT PRIMARY KEY, kind TEXT NOT NULL, client_id TEXT NOT NULL, expires INTEGER NOT NULL);
  `);
  return db;
}

// A redirect address an app may register: https anywhere, http only on the
// machine itself (a desktop app's loopback listener).
function validRedirect(value) {
  try {
    const u = new URL(value);
    if (u.hash) return false;
    if (u.protocol === 'https:') return true;
    return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  } catch {
    return false;
  }
}

const TOOLS = [
  {
    name: 'flagged_names',
    description: 'The domain names the owner has flagged (their Saved list), each with where it is listed for auction or sale (venue), when that listing ends, its current price and its listing address. A listing end time in the past means the name is not at auction right now. The result changes only when a listing does (a name goes to auction, its price or bids move, it ends), so it is the thing to watch to catch a flagged name the moment it is listed.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'describe_api',
    description: 'Lists every read-only DomainScout data route with its parameters: auction and expiring inventory search, the live feed of newly launched sites, registration universe, sale watch, trends, extension counts and more. Read this before using api_get.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'api_get',
    description: 'Reads one DomainScout data route. path is a route from describe_api (for example /api/domains or /api/public/live-sites); query holds its parameters.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'A route beginning with /api/' },
        query: { type: 'object', description: 'Query parameters as name/value pairs', additionalProperties: true },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
];

// options: { dataDir, port, sessionAuthed(req), agentTokenOk(req), safeReturnPath }
function installMcp(app, options) {
  const db = openStore(options.dataDir);
  const sweep = () => {
    const now = Date.now();
    db.prepare('DELETE FROM codes WHERE expires < ?').run(now);
    db.prepare('DELETE FROM tokens WHERE expires < ?').run(now);
  };
  const baseUrl = req => {
    if (process.env.DOMAINSCOUT_PUBLIC_URL) return process.env.DOMAINSCOUT_PUBLIC_URL.replace(/\/+$/, '');
    const host = req.get('host') || 'localhost';
    const local = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);
    return (local ? 'http' : 'https') + '://' + host;
  };
  const noStore = res => res.set({ 'Cache-Control': 'no-store', Pragma: 'no-cache' });

  // ── Where sign-in lives ────────────────────────────────────────────────────
  app.get(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'], (req, res) => {
    const base = baseUrl(req);
    res.json({ resource: base + '/mcp', authorization_servers: [base], bearer_methods_supported: ['header'], resource_name: 'DomainScout' });
  });
  app.get(['/.well-known/oauth-authorization-server', '/.well-known/oauth-authorization-server/mcp'], (req, res) => {
    const base = baseUrl(req);
    res.json({
      issuer: base,
      authorization_endpoint: base + '/oauth/authorize',
      token_endpoint: base + '/oauth/token',
      registration_endpoint: base + '/oauth/register',
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
    });
  });

  // ── An app introduces itself ───────────────────────────────────────────────
  app.post('/oauth/register', (req, res) => {
    noStore(res);
    const uris = Array.isArray(req.body?.redirect_uris) ? req.body.redirect_uris.map(String).slice(0, 5) : [];
    if (!uris.length || !uris.every(validRedirect)) {
      return res.status(400).json({ error: 'invalid_redirect_uri', error_description: 'redirect_uris must be https addresses.' });
    }
    // Registrations nobody finished signing in with are the first to go.
    const count = db.prepare('SELECT COUNT(*) AS n FROM clients').get().n;
    if (count >= MAX_CLIENTS) {
      db.prepare('DELETE FROM clients WHERE client_id IN (SELECT client_id FROM clients ORDER BY used IS NOT NULL, COALESCE(used, created) LIMIT ?)').run(count - MAX_CLIENTS + 1);
    }
    const clientId = 'ds_' + random(18);
    const name = String(req.body?.client_name || 'An app').replace(/\s+/g, ' ').trim().slice(0, 80) || 'An app';
    db.prepare('INSERT INTO clients VALUES (?, ?, ?, ?, NULL)').run(clientId, name, JSON.stringify(uris), Date.now());
    res.status(201).json({
      client_id: clientId,
      client_name: name,
      redirect_uris: uris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    });
  });

  // ── The owner approves ─────────────────────────────────────────────────────
  function readRequest(source) {
    const client = db.prepare('SELECT * FROM clients WHERE client_id = ?').get(String(source.client_id || ''));
    const redirect = String(source.redirect_uri || '');
    if (!client || !JSON.parse(client.redirect_uris).includes(redirect)) return { problem: 'This connection request is not valid. Start again from the app you were connecting.' };
    const fields = {
      client_id: client.client_id,
      redirect_uri: redirect,
      state: String(source.state || '').slice(0, 500),
      code_challenge: String(source.code_challenge || '').slice(0, 200),
    };
    const refuse = error => {
      const back = new URL(redirect);
      back.searchParams.set('error', error);
      if (fields.state) back.searchParams.set('state', fields.state);
      return { redirect: back.href };
    };
    if (source.response_type !== 'code') return refuse('unsupported_response_type');
    if (!fields.code_challenge || (source.code_challenge_method || 'S256') !== 'S256') return refuse('invalid_request');
    return { client, fields, refuse };
  }
  app.get('/oauth/authorize', (req, res) => {
    noStore(res);
    if (!options.sessionAuthed(req)) {
      return res.redirect('/login?next=' + encodeURIComponent(options.safeReturnPath(req.originalUrl, '/')));
    }
    const asked = readRequest(req.query);
    if (asked.problem) return res.status(400).type('html').send(page('Cannot connect', `<p>${escapeHtml(asked.problem)}</p>`));
    if (asked.redirect) return res.redirect(asked.redirect);
    // The form can only be sent from this page, in this login session.
    const nonce = random(18);
    if (req.session) req.session.mcpConsent = nonce;
    const hidden = Object.entries({ ...asked.fields, response_type: 'code', code_challenge_method: 'S256', nonce })
      .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`).join('');
    const host = new URL(asked.fields.redirect_uri).host;
    res.set('X-Frame-Options', 'DENY').type('html').send(page('Connect to DomainScout', `
      <h1>Let ${escapeHtml(asked.client.name)} read your DomainScout?</h1>
      <p><strong>${escapeHtml(host)}</strong> will be able to read your flagged names, auction inventory, the live feed and research data. It cannot change anything.</p>
      <form method="post" action="/oauth/authorize">${hidden}
        <button name="decision" value="allow" class="go">Allow</button>
        <button name="decision" value="deny" class="no">Not now</button>
      </form>`));
  });
  app.post('/oauth/authorize', (req, res) => {
    noStore(res);
    if (!options.sessionAuthed(req)) return res.redirect('/login');
    const asked = readRequest(req.body || {});
    if (asked.problem) return res.status(400).type('html').send(page('Cannot connect', `<p>${escapeHtml(asked.problem)}</p>`));
    if (asked.redirect) return res.redirect(asked.redirect);
    const expected = req.session?.mcpConsent;
    if (req.session) delete req.session.mcpConsent;
    const local = !req.session?.authed; // a request from the machine itself has no login session
    if (!local && (!expected || expected !== req.body?.nonce)) {
      return res.status(400).type('html').send(page('Cannot connect', '<p>That page was out of date. Start again from the app you were connecting.</p>'));
    }
    if (req.body?.decision !== 'allow') return res.redirect(asked.refuse('access_denied').redirect);
    sweep();
    const code = random(32);
    db.prepare('INSERT INTO codes VALUES (?, ?, ?, ?, ?)').run(hash(code), asked.client.client_id, asked.fields.redirect_uri, asked.fields.code_challenge, Date.now() + CODE_MS);
    db.prepare('UPDATE clients SET used = ? WHERE client_id = ?').run(Date.now(), asked.client.client_id);
    const back = new URL(asked.fields.redirect_uri);
    back.searchParams.set('code', code);
    if (asked.fields.state) back.searchParams.set('state', asked.fields.state);
    res.redirect(back.href);
  });

  // ── Tokens ─────────────────────────────────────────────────────────────────
  function issue(clientId) {
    const access = random(32);
    const refresh = random(32);
    const now = Date.now();
    db.prepare('INSERT INTO tokens VALUES (?, ?, ?, ?)').run(hash(access), 'access', clientId, now + ACCESS_MS);
    db.prepare('INSERT INTO tokens VALUES (?, ?, ?, ?)').run(hash(refresh), 'refresh', clientId, now + REFRESH_MS);
    return { access_token: access, token_type: 'Bearer', expires_in: Math.floor(ACCESS_MS / 1000), refresh_token: refresh, scope: 'read' };
  }
  app.post('/oauth/token', (req, res) => {
    noStore(res);
    const b = req.body || {};
    const refuse = (error, description) => res.status(400).json({ error, error_description: description });
    sweep();
    if (b.grant_type === 'authorization_code') {
      const row = db.prepare('SELECT * FROM codes WHERE hash = ?').get(hash(b.code || ''));
      // A code works once, whether or not the rest checks out.
      if (row) db.prepare('DELETE FROM codes WHERE hash = ?').run(row.hash);
      const proof = crypto.createHash('sha256').update(String(b.code_verifier || '')).digest('base64url');
      if (!row || row.expires < Date.now() || row.client_id !== b.client_id || row.redirect_uri !== b.redirect_uri || row.challenge !== proof) {
        return refuse('invalid_grant', 'That code is not valid.');
      }
      return res.json(issue(row.client_id));
    }
    if (b.grant_type === 'refresh_token') {
      const row = db.prepare("SELECT * FROM tokens WHERE hash = ? AND kind = 'refresh'").get(hash(b.refresh_token || ''));
      if (!row || row.expires < Date.now() || row.client_id !== b.client_id) return refuse('invalid_grant', 'Sign in again.');
      // Each renewal replaces the token it was made with.
      db.prepare('DELETE FROM tokens WHERE hash = ?').run(row.hash);
      return res.json(issue(row.client_id));
    }
    refuse('unsupported_grant_type', 'Use authorization_code or refresh_token.');
  });

  // ── The tools ──────────────────────────────────────────────────────────────
  async function read(pathname, query) {
    const route = String(pathname || '');
    if (!/^\/api\/[A-Za-z0-9/_.:-]*$/.test(route) || route.includes('..') || route === '/api/login') {
      throw new Error('path must be a data route beginning with /api/. Use describe_api to see them.');
    }
    const url = new URL('http://127.0.0.1:' + options.port + route);
    for (const [k, v] of Object.entries(query && typeof query === 'object' ? query : {})) {
      if (v !== null && v !== undefined && k !== 'token') url.searchParams.set(k, String(v));
    }
    const r = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(90000) });
    const text = await r.text();
    if (!r.ok) throw new Error('DomainScout answered ' + r.status + ': ' + text.slice(0, 300));
    return text;
  }
  async function callTool(name, input) {
    if (name === 'describe_api') return JSON.stringify(describeApi());
    if (name === 'api_get') return read(input?.path, input?.query);
    if (name === 'flagged_names') {
      const page = JSON.parse(await read('/api/domains', { saved: 1, limit: 500 }));
      const now = Date.now();
      // Nothing here changes unless a name's listing does, so an agent can
      // watch this result and be told the moment one goes to auction or ends.
      return JSON.stringify({
        count: page.total,
        names: (page.domains || []).slice().sort((a, b) => String(a.domain).localeCompare(String(b.domain))).map(d => ({
          domain: d.domain,
          venue: d.source,
          listing: d.stream,
          endsAt: d.auction_end,
          endsInFuture: d.auction_end ? Date.parse(d.auction_end) > now : null,
          price: d.auction_price,
          bids: d.bid_count,
          url: d.auction_url,
          notes: d.notes,
        })),
      });
    }
    throw new Error('There is no tool with that name.');
  }

  app.all('/mcp', async (req, res) => {
    noStore(res);
    const bearer = (req.get('authorization') || '').match(/^Bearer\s+(\S+)$/i)?.[1];
    const token = bearer && db.prepare("SELECT * FROM tokens WHERE hash = ? AND kind = 'access' AND expires > ?").get(hash(bearer), Date.now());
    if (!token && !options.agentTokenOk(req)) {
      return res.status(401)
        .set('WWW-Authenticate', `Bearer resource_metadata="${baseUrl(req)}/.well-known/oauth-protected-resource"`)
        .json({ error: 'unauthorized' });
    }
    if (req.method !== 'POST') return res.status(405).set('Allow', 'POST').end();
    const message = req.body || {};
    const reply = result => res.json({ jsonrpc: '2.0', id: message.id, result });
    const fault = (code, text) => res.json({ jsonrpc: '2.0', id: message.id ?? null, error: { code, message: text } });
    if (Array.isArray(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return fault(-32600, 'Send one JSON-RPC request.');
    // Notifications get no reply.
    if (message.id === undefined) return res.status(202).end();
    if (message.method === 'initialize') {
      return reply({ protocolVersion: PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: 'DomainScout', version: '1' }, instructions: 'Read-only access to the owner’s DomainScout: flagged names, auction inventory, newly launched sites and research data.' });
    }
    if (message.method === 'ping') return reply({});
    if (message.method === 'tools/list') return reply({ tools: TOOLS });
    if (message.method === 'tools/call') {
      try {
        const text = await callTool(message.params?.name, message.params?.arguments || {});
        return reply({ content: [{ type: 'text', text: text.length > MAX_RESULT_CHARS ? text.slice(0, MAX_RESULT_CHARS) + '\n… (cut short: ask for fewer rows with limit, or the next page)' : text }] });
      } catch (err) {
        return reply({ isError: true, content: [{ type: 'text', text: err.message }] });
      }
    }
    fault(-32601, 'Method not found.');
  });

  return { db, tools: TOOLS };
}

function page(title, body) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0f14;color:#e6edf3;font:17px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{max-width:440px;padding:32px 24px}h1{font-size:24px;line-height:1.25;margin:0 0 16px}p{color:#9fb0c0;margin:0 0 24px}strong{color:#e6edf3}form{display:flex;gap:12px;flex-wrap:wrap}button{font:inherit;font-weight:600;min-height:48px;padding:0 24px;border-radius:8px;border:1px solid #2b3642;cursor:pointer}.go{background:#3fb950;border-color:#3fb950;color:#04130a;flex:1}.no{background:transparent;color:#9fb0c0}</style></head><body><main>${body}</main></body></html>`;
}

module.exports = { installMcp, validRedirect, TOOLS };
