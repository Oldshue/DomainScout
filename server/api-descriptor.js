'use strict';

// Static descriptor of DomainScout's token-readable GET API for agent clients.
// Built from the route handlers in server/index.js, server/domainlab.js,
// server/universe-lane.js, and server/zone-intelligence.js. Documents only the
// req.query fields those handlers actually read. Never includes real tokens,
// credentials, or env values.

const AUTH_NOTE = 'Authenticate with header `x-domainscout-token: <token>` or `?token=<token>` on any GET /api/* route. All documented routes are read-only GET endpoints. Any unrecognized /api/* path answers a JSON 404 (never HTML).';

const ENDPOINTS = [
  {
    path: '/api/stats',
    summary: 'Cached dashboard stats snapshot (counts by stream, saved/seen/skipped, provider overlays).',
    params: [],
    response: 'JSON stats object; includes cached/stale/statsUpdatedAt metadata and a live saved count.',
  },
  {
    path: '/api/domains',
    summary: 'Paged, filterable, sortable domain search across all streams (the core research grid).',
    params: [
      { name: 'stream', type: 'string', required: false, description: 'Restrict results to a named inventory stream (e.g. godaddy-auction, godaddy-closeout, or a virtual _expiringNN/_expiredNN stream).' },
      { name: 'q', type: 'string', required: false, description: 'Base-name text search term.' },
      { name: 'searchMode', type: 'string', required: false, description: 'How q matches the base name: `contains`, `prefix`, or `suffix`.' },
      { name: 'page', type: 'integer', required: false, description: 'Page number, 1-based. Default 1.' },
      { name: 'limit', type: 'integer', required: false, description: 'Rows per page. Default 100.' },
      { name: 'sortField', type: 'string', required: false, description: 'Column to sort by (e.g. discovered_at). Default discovered_at.' },
      { name: 'sortDir', type: 'string', required: false, description: '`ASC` or `DESC` (case-insensitive). Default DESC.' },
      { name: 'dateWindow', type: 'string', required: false, description: 'Bounds results to a recent date window; ignored for the godaddy-closeout snapshot.' },
      { name: 'takenIn', type: 'string', required: false, description: 'Comma-separated TLD list (e.g. .com,.ai) used for the correlated taken-in-other-TLD evidence check.' },
      { name: 'takenInMode', type: 'string', required: false, description: 'One of `taken`, `not_taken`, or `any`. Default taken.' },
      { name: 'includeUnavailable', type: 'string', required: false, description: 'Value `1` includes unavailable/dropped rows in a virtual expiring/expired stream.' },
    ],
    response: 'JSON page: { total, page, limit, domains }. Provider-snapshot streams (godaddy-auction/closeout) additionally echo `sortApplied`, describing the sort actually used, and coerce any unsupported sortField to a supported one instead of erroring.',
  },
  {
    path: '/api/name-research',
    summary: 'Unique base names matching a search term, ranked by cross-TLD registration count (zone index plus internal DB).',
    params: [
      { name: 'term', type: 'string', required: true, description: 'Search term, 2+ characters (also accepted as `prefix`). Multiple terms may be separated by spaces/punctuation; each must be 2+ chars.' },
      { name: 'mode', type: 'string', required: false, description: 'One of `prefix`, `suffix`, `contains`, or `exact` (aliases such as start/starts/ends accepted). Default prefix.' },
      { name: 'limit', type: 'integer', required: false, description: 'Result page size (also accepted as pageSize/resultLimit).' },
      { name: 'offset', type: 'integer', required: false, description: 'Result page offset for deterministic paging.' },
    ],
    response: 'JSON rows of { base_name, tlds_taken, tld_list, com, ai }. `tlds_taken` is only an exact whole-root count when `tlds_verified` is true for that row; otherwise it is a lower-bound zone/DB observation.',
  },
  {
    path: '/api/tlds-check',
    summary: 'Hybrid (cached plus queued) cross-TLD availability check for one base name.',
    params: [
      { name: 'baseName', type: 'string', required: true, description: 'Base name to check (also accepted as `domain`). Must match [a-z0-9-]+.' },
      { name: 'force', type: 'boolean', required: false, description: 'Force a fresh coverage refresh instead of serving the cached receipt.' },
    ],
    response: 'JSON coverage projection: { baseName, count, lowerBound, label, taken, coverage, status, queued, tldUniverse }.',
  },
  {
    path: '/api/tlds-lookup-full',
    summary: 'Full IANA-root TLD lookup for one base name; returns a queued receipt while whole-root coverage is still running.',
    params: [
      { name: 'baseName', type: 'string', required: true, description: 'Base name to check (also accepted as `domain`).' },
      { name: 'force', type: 'boolean', required: false, description: 'Force a fresh coverage refresh instead of serving the cached receipt.' },
    ],
    response: '200 JSON { baseName, taken, count, all, allCount, coverage, checkedAt } when complete; 202 JSON with a queued receipt and no exact count while whole-root coverage is pending.',
  },
  {
    path: '/api/lander-check',
    summary: 'Detects whether a single domain currently resolves to a for-sale marketplace lander page.',
    params: [
      { name: 'domain', type: 'string', required: true, description: 'Fully-qualified domain to check (must match a valid domain shape).' },
    ],
    response: 'JSON lander detection result (platform match, for-sale phrase match, final URL).',
  },
  {
    path: '/api/universe/days',
    summary: 'Lists the zone-universe day snapshots available on the universe lane tape store.',
    params: [],
    response: 'JSON { days: [{ day, adds, zones, nsMovement }, ...] }. `nsMovement` is true when that day also has an imported nameserver-movement tape (ns/summary.json).',
  },
  {
    path: '/api/universe/search',
    summary: 'Searches one universe-lane day snapshot for matching zone names.',
    params: [
      { name: 'day', type: 'string', required: true, description: 'Universe day to search, YYYY-MM-DD.' },
      { name: 'q', type: 'string', required: false, description: 'Search text; required for all modes except regex; restricted to a-z, 0-9, dot, hyphen.' },
      { name: 'mode', type: 'string', required: false, description: 'One of `contains` (default), `prefix`, `suffix`, `exact`, or `regex`.' },
      { name: 'zone', type: 'string', required: false, description: 'Restrict matches to one zone/TLD (without leading dot).' },
      { name: 'limit', type: 'integer', required: false, description: 'Max items to return per page (1-500). Default 100.' },
      { name: 'cursor', type: 'integer', required: false, description: 'Opaque paging cursor from a previous response; 0 to start.' },
    ],
    response: 'JSON { day, total, items, nextCursor, partial, tookMs }. `partial: true` means a regex search timed out before scanning the full day.',
  },
  {
    path: '/api/universe/sample',
    summary: 'Returns a deterministic random sample of names from one universe-lane day snapshot.',
    params: [
      { name: 'day', type: 'string', required: true, description: 'Universe day to sample, YYYY-MM-DD.' },
      { name: 'zone', type: 'string', required: false, description: 'Restrict the sample pool to one zone/TLD (without leading dot).' },
      { name: 'n', type: 'integer', required: false, description: 'Sample size (1-500). Default 10.' },
    ],
    response: 'JSON { day, items }. Sampling is seeded by the day, so a given day plus zone plus n is reproducible.',
  },
  {
    path: '/api/universe/ns-movement',
    summary: 'Queries the nameserver-movement tape for one universe day: names whose nameservers/DNS class changed (departures, went-live, or listed-for-sale probes).',
    params: [
      { name: 'day', type: 'string', required: false, description: 'Universe day to query, YYYY-MM-DD. Defaults to the latest day that has an imported NS-movement tape.' },
      { name: 'selection', type: 'string', required: false, description: 'One of `departures`, `went-live`, or `listed`; restricts rows to that movement selection.' },
      { name: 'from', type: 'string', required: false, description: 'Comma-separated list of previous nameserver classes to require (seller, parking, registrar, hosting, other).' },
      { name: 'to', type: 'string', required: false, description: 'Comma-separated list of current nameserver classes to require (seller, parking, registrar, hosting, other).' },
      { name: 'state', type: 'string', required: false, description: 'Restrict to rows whose probe.state equals this value (e.g. `built`).' },
      { name: 'q', type: 'string', required: false, description: 'Domain text search term; restricted to a-z, 0-9, dot, hyphen.' },
      { name: 'zone', type: 'string', required: false, description: 'Restrict matches to one zone/TLD (without leading dot).' },
      { name: 'limit', type: 'integer', required: false, description: 'Max items to return per page (1-500). Default 200.' },
      { name: 'cursor', type: 'integer', required: false, description: 'Opaque paging cursor from a previous response; 0 to start.' },
    ],
    response: 'JSON { day, selection, total, items, nextCursor }. Each item is a movement row: { domain, prev_class, today_class, selection, probe: { state, ... }, ... }.',
  },
  {
    path: '/api/universe/ns-movement/summary',
    summary: 'Returns the day-level nameserver-movement summary totals recorded alongside the movement tape for one universe day.',
    params: [
      { name: 'day', type: 'string', required: false, description: 'Universe day to summarize, YYYY-MM-DD. Defaults to the latest day that has an imported NS-movement tape.' },
    ],
    response: 'JSON summary object exactly as imported for that day (the `summary` object from the first line of the ns-movement import).',
  },
  {
    path: '/api/universe/ns-movement/import',
    summary: 'POST-only write endpoint (not a token-readable GET route): imports one day\'s nameserver-movement tape. Body is JSON-lines; the first line must be {"summary": {...}} and remaining lines are individual movement rows. Requires an import token, distinct from the standard read token.',
    params: [
      { name: 'day', type: 'string', required: true, description: 'Universe day the import applies to, YYYY-MM-DD.' },
      { name: 'token', type: 'string', required: false, description: 'Import token (also accepted via the x-domainscout-token header); must match DOMAINSCOUT_UNIVERSE_IMPORT_TOKEN or DOMAINSCOUT_AGENT_TOKEN.' },
    ],
    response: 'JSON { day, rows, bytes, summary } on success. Responds 400 if the first body line is not {"summary": {...}}, or 401 if the token does not match.',
  },
  {
    path: '/api/domainlab/daily',
    summary: 'Daily-diff token/keyword registration counts across the zone index (DomainLab).',
    params: [
      { name: 'limit', type: 'integer', required: false, description: 'Maximum rows to return; bounded internally by computeDailyTokens.' },
    ],
    response: 'JSON { ok: true, ... } from computeDailyTokens describing per-token daily registration activity.',
  },
  {
    path: '/api/domainlab/trending',
    summary: 'Currently trending fragments/tokens across newly registered names (DomainLab).',
    params: [
      { name: 'limit', type: 'integer', required: false, description: 'Maximum rows to return; bounded internally by computeTrending.' },
    ],
    response: 'JSON { ok: true, ... } from computeTrending: ranked terms with momentum, quality score, and zone spread.',
  },
  {
    path: '/api/domainlab/term/:term',
    summary: 'Cross-TLD ownership and registration history for one exact token/term (DomainLab).',
    params: [
      { name: 'term', type: 'path', required: true, description: 'Lowercase token/term, [a-z0-9-]+, path segment (max 80 chars).' },
    ],
    response: 'JSON { ok: true, term, history, currentZones, exampleLiveDomains, crossTldOwnership, words }.',
  },
  {
    path: '/api/zone-intelligence',
    summary: 'Zone-diff evidence: token movement, per-token domains, drop events, gem ranking, or availability gaps.',
    params: [
      { name: 'from', type: 'string', required: false, description: 'Range start date, YYYY-MM-DD.' },
      { name: 'to', type: 'string', required: false, description: 'Range end date, YYYY-MM-DD.' },
      { name: 'mode', type: 'string', required: false, description: 'One of `movement` (default), `token-domains`, `drops`, `gems`, or `gaps`.' },
      { name: 'limit', type: 'integer', required: false, description: 'Maximum rows to return.' },
      { name: 'token', type: 'string', required: false, description: 'Token to look up; required when mode is token-domains.' },
      { name: 'onlyConfirmed', type: 'boolean', required: false, description: 'For mode gaps: only return rows with a confirmed availability gap.' },
    ],
    response: 'JSON { mode, range, rows, evidence } with a receipted completeness object describing source coverage for the range.',
  },
  {
    path: '/api/sale-watch',
    summary: 'Native end-user sale-ledger projection over AgentForge-collected sale evidence.',
    params: [],
    response: 'JSON sale-watch ledger projection for the current user.',
  },
  {
    path: '/api/sales-comps',
    summary: 'Comparable-sale rows for a domain shape (TLD, word count, theme regex, recency).',
    params: [
      { name: 'theme', type: 'string', required: false, description: 'A regex string (max 64 chars) matched against comp base names.' },
      { name: 'tld', type: 'string', required: false, description: 'Restrict comps to one TLD.' },
      { name: 'wordCount', type: 'integer', required: false, description: 'Restrict comps to a specific word count.' },
      { name: 'since', type: 'string', required: false, description: 'Only include comps sold on or after this date.' },
    ],
    response: 'JSON array of comparable sale rows, or 503 { error: "comps-unavailable" } if the comps DB is disabled or unreachable.',
  },
  {
    path: '/api/trends',
    summary: 'Combined TLD and keyword trend payload, backed by observed zone diffs.',
    params: [
      { name: 'tldLimit', type: 'integer', required: false, description: 'Max TLD trend rows (1-1000). Default 500.' },
      { name: 'keywordLimit', type: 'integer', required: false, description: 'Max keyword trend rows (1-1000). Default 300.' },
    ],
    response: 'JSON trend payload; 503 { error: "trend-read-unavailable" } if the read fails.',
  },
  {
    path: '/api/keyword-trends',
    summary: 'Keyword-only trend payload, backed by observed zone diffs.',
    params: [
      { name: 'limit', type: 'integer', required: false, description: 'Max keyword trend rows (1-1000). Default 300.' },
    ],
    response: 'JSON keyword trend payload; 503 { error: "trend-read-unavailable" } if the read fails.',
  },
  {
    path: '/api/config-status',
    summary: 'Operational configuration/health census (CZDS, registrar availability, drop feed, expired-market coverage).',
    params: [
      { name: 'lightweight', type: 'boolean', required: false, description: 'Value `1` returns a cheap subset (czds/prefix-scan flags only) instead of the full census.' },
      { name: 'full', type: 'boolean', required: false, description: 'Value `1` forces the full census even for an auction-desktop referer that would otherwise get the lightweight response.' },
    ],
    response: 'JSON configuration/status census object; shape varies with lightweight.',
  },
  {
    path: '/api/agentforge/streams',
    summary: 'Per-stream inventory summary (counts, price range, date range, latest scrape) for agent clients.',
    params: [],
    response: 'JSON { source, generatedAt, streams, aliases }. Each stream entry includes a ready-to-use queryUrl into /api/agentforge/domain-candidates.',
  },
  {
    path: '/api/health',
    summary: 'Lightweight liveness check for the DomainScout web process.',
    params: [],
    response: 'JSON liveness payload used for uptime/health monitoring.',
  },
];

function paramsForOpenApi(endpoint) {
  return (endpoint.params || []).map(p => ({
    name: p.name,
    in: endpoint.path.indexOf(':' + p.name) !== -1 ? 'path' : 'query',
    required: !!p.required,
    description: p.description,
    schema: { type: p.type === 'integer' ? 'integer' : p.type === 'boolean' ? 'boolean' : 'string' },
  }));
}

function openApiPathFor(endpoint) {
  return endpoint.path.replace(/:([a-zA-Z0-9_]+)/g, '{$1}');
}

function describeApi() {
  const paths = {};
  for (const endpoint of ENDPOINTS) {
    paths[openApiPathFor(endpoint)] = {
      get: {
        summary: endpoint.summary,
        parameters: paramsForOpenApi(endpoint),
        responses: {
          200: { description: endpoint.response || 'Successful response.' },
        },
      },
    };
  }
  return {
    openapi: '3.0.3',
    info: {
      title: 'DomainScout API',
      version: '1.0.0',
      description: AUTH_NOTE,
    },
    paths,
    components: {
      securitySchemes: {
        apiKey: {
          type: 'apiKey',
          in: 'header',
          name: 'x-domainscout-token',
        },
      },
    },
    security: [{ apiKey: [] }],
  };
}

function llmsText(baseUrl) {
  const raw = String(baseUrl || '');
  const base = raw.length && raw.charAt(raw.length - 1) === '/' ? raw.slice(0, -1) : raw;
  const lines = [];
  lines.push('# DomainScout API - agent guide');
  lines.push('');
  lines.push('## Authentication');
  lines.push('Send header `x-domainscout-token: <token>` OR append `?token=<token>` to any GET /api/* request. There is no other supported auth mechanism for read-only agent access.');
  lines.push('');
  lines.push('## Machine-readable schema');
  lines.push('Fetch ' + base + '/openapi.json for the full OpenAPI 3.0.3 document (built by describeApi()).');
  lines.push('');
  lines.push('## Errors');
  lines.push('Every request path under /api/ that does not match a known route answers a JSON 404 (never an HTML page). All documented routes below are GET-only.');
  lines.push('');
  lines.push('## Pending extension counts');
  lines.push('An extension/TLD count can be labeled pending (or carry a lower-bound/partial-coverage flag) until whole-root verification finishes for that base name. Pending means the count shown is real evidence observed so far (zone index and/or cache), but it is not yet proven to be the exact count across every accessible TLD. Once whole-root verification completes, the count is replaced by the exact, receipted value.');
  lines.push('');
  lines.push('## Endpoints');
  for (const endpoint of ENDPOINTS) {
    lines.push('### ' + endpoint.path);
    lines.push(endpoint.summary);
    const queryParams = (endpoint.params || []).filter(p => endpoint.path.indexOf(':' + p.name) === -1);
    const examplePath = endpoint.path.replace(/:([a-zA-Z0-9_]+)/g, 'example');
    const parts = queryParams.map(p => p.name + '=VALUE');
    parts.push('token=YOUR_TOKEN');
    const qs = '?' + parts.join('&');
    lines.push('curl -H "x-domainscout-token: YOUR_TOKEN" "' + base + examplePath + qs + '"');
    lines.push('');
  }
  lines.push('## Off-market sale detection via nameserver movement');
  lines.push('A name that leaves seller or parking nameservers for a buyer\'s own DNS, and then goes on to serve a built site (probe.state `built`), is the footprint of an off-market sale that never showed up on any public marketplace. Use GET /api/universe/ns-movement with selection=departures, from=seller,parking, and state=built to surface exactly those candidates for one universe day:');
  lines.push('curl -H "x-domainscout-token: YOUR_TOKEN" "' + base + '/api/universe/ns-movement?day=2026-09-04&selection=departures&from=seller,parking&state=built&limit=100&token=YOUR_TOKEN"');
  lines.push('');
  return lines.join('\n');
}

module.exports = { ENDPOINTS, describeApi, llmsText };
