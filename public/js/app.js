/* DomainScout — frontend app */

if (window.location.protocol === 'file:') {
  window.location.replace('http://localhost:3737/');
}
const API = '';

const state = {
  stream: 'all',
  tld: 'all',
  q: '',
  searchMode: 'contains',
  sortField: 'discovered_at',
  sortDir: 'DESC',
  page: 1,
  limit: 1000,
  // filters
  minLength: '', maxLength: '',
  minAge: '', maxAge: '',
  maxPrice: '',
  noNumbers: false, noHyphens: false,
  hasWayback: false, dnsAvailable: false, hasBids: false,
  hideSkipped: false, expiryToday: false, dateWindow: 'any',
  domainSuffix: '',
  takenInTlds: new Set(),
  total: 0,
  streamCounts: {}, // cached from stats — used to skip COUNT(*) on stream switches
  domainMap: {},   // id → domain object, for modal lookups
  modalDomain: null, // currently open domain
};

let searchTimeout = null;
let loadAbortController = null;

const app = {
  // ── TLD scroll-check queue ──
  tldQueue: [],
  tldActive: 0,
  tldObserver: null,
  tldTotal: 160,

  // ── Apply filters from URL query params on load ──
  // Makes filtered views deep-linkable/shareable and reload-safe, and lets an
  // automated client scope a query by navigating to a URL instead of driving the
  // UI controls. Accepts DomainScout's own param names plus intuitive aliases.
  applyUrlParamsToState() {
    let params;
    try { params = new URLSearchParams(window.location.search); } catch { return; }
    if (![...params.keys()].length) return;
    const get = (...names) => {
      for (const n of names) { const v = params.get(n); if (v != null && v !== '') return v; }
      return null;
    };
    const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v || ''));

    // Auction-end date window: today | tomorrow | next3 | next7 | next14 | next30
    const dwRaw = get('dateWindow', 'date-window', 'auction-end', 'auctionEnd', 'auction_end', 'ending', 'ends', 'endingWithin');
    if (dwRaw) {
      const v = String(dwRaw).toLowerCase().trim();
      const map = { today: 'today', tomorrow: 'tomorrow', '3': 'next3', next3: 'next3', '7': 'next7', next7: 'next7', '14': 'next14', next14: 'next14', '30': 'next30', next30: 'next30', any: 'any' };
      const mapped = map[v] || (/^next\d+$/.test(v) ? v : null);
      if (mapped) state.dateWindow = mapped;
    }
    if (truthy(get('expiryToday', 'endsToday', 'endingToday'))) state.expiryToday = true;

    const stream = get('stream'); if (stream) state.stream = stream;
    const tld = get('tld'); if (tld) state.tld = (tld === 'all' || tld.startsWith('.')) ? tld : '.' + tld;
    const q = get('q', 'search', 'query', 'keyword'); if (q) state.q = q;
    const sm = get('searchMode'); if (sm) state.searchMode = sm;
    const maxPrice = get('maxPrice', 'max-price'); if (maxPrice) state.maxPrice = maxPrice;
    const minLength = get('minLength', 'min-length'); if (minLength) state.minLength = minLength;
    const maxLength = get('maxLength', 'max-length'); if (maxLength) state.maxLength = maxLength;
    if (truthy(get('noNumbers'))) state.noNumbers = true;
    if (truthy(get('noHyphens'))) state.noHyphens = true;
    if (truthy(get('hasBids'))) state.hasBids = true;
    const sortField = get('sortField'); if (sortField) state.sortField = sortField;
    const sortDir = get('sortDir'); if (/^(asc|desc)$/i.test(sortDir || '')) state.sortDir = sortDir.toUpperCase();
    const limit = parseInt(get('limit') || '', 10); if (Number.isFinite(limit) && limit > 0) state.limit = limit;
  },

  // ── Init ──
  async init() {
    this.applyUrlParamsToState();
    this.syncControlsFromState();
    // Back/Forward: restore the view encoded in the URL (shareable + history nav,
    // like ExpiredDomains). _restoringFromUrl stops loadDomains from pushing a new
    // history entry for a navigation we are merely replaying.
    window.addEventListener('popstate', async () => {
      this._restoringFromUrl = true;
      try {
        this.applyUrlParamsToState();
        this.syncControlsFromState();
        await this.loadDomains();
      } finally {
        this._restoringFromUrl = false;
      }
    });
    await this.loadStats();
    await Promise.all([this.loadDomains(), this.checkConfig()]);
    this.refreshGoDaddyPricesOnOpen();
    setInterval(() => this.loadStats(), 30000);
  },

  async refreshGoDaddyPricesOnOpen() {
    const countEl = document.getElementById('result-count');
    const wasGoDaddyView = () => ['godaddy-auction', 'godaddy-closeout'].includes(state.stream);
    try {
      const before = await fetch(`${API}/api/godaddy-refresh`).then(r => r.ok ? r.json() : null).catch(() => null);
      if (Number(before?.inventory?.maxAgeMs) < 2 * 60 * 1000) return;

      const shouldReloadGoDaddy = wasGoDaddyView();
      if (countEl && shouldReloadGoDaddy) {
        countEl.textContent = `${state.total.toLocaleString()} domains · refreshing GoDaddy prices`;
      }
      await fetch(`${API}/api/godaddy-refresh`, { method: 'POST' });
      const started = Date.now();
      const maxWaitMs = 10 * 60 * 1000;
      while (Date.now() - started < maxWaitMs) {
        await new Promise(r => setTimeout(r, 1500));
        const resp = await fetch(`${API}/api/godaddy-refresh`);
        if (!resp.ok) break;
        const data = await resp.json();
        if (Number(data.inventory?.maxAgeMs) < 2 * 60 * 1000) break;
        if (!data.running) break;
        if (countEl && shouldReloadGoDaddy) {
          countEl.textContent = `${state.total.toLocaleString()} domains · refreshing GoDaddy prices`;
        }
      }
      await this.loadStats();
      if (shouldReloadGoDaddy || wasGoDaddyView()) await this.loadDomains();
    } catch (_) {
      // Price refresh is best-effort; the table can still load from the last cache.
    }
  },

  syncControlsFromState() {
    // Browsers may restore prior form values after reloads. DomainScout state is
    // intentionally in-memory, so make the visible controls match the fresh state
    // before the first query runs.
    document.querySelectorAll('input').forEach(el => { el.autocomplete = 'off'; });
    document.getElementById('search-input').value = state.q;
    document.getElementById('search-mode').value = state.searchMode;
    document.getElementById('maxPrice').value = state.maxPrice;
    document.getElementById('minLength').value = state.minLength;
    document.getElementById('maxLength').value = state.maxLength;
    document.getElementById('minAge').value = state.minAge;
    document.getElementById('maxAge').value = state.maxAge;
    document.getElementById('noNumbers').checked = state.noNumbers;
    document.getElementById('noHyphens').checked = state.noHyphens;
    document.getElementById('hasWayback').checked = state.hasWayback;
    document.getElementById('dnsAvailable').checked = state.dnsAvailable;
    document.getElementById('hasBids').checked = state.hasBids;
    document.getElementById('hideSkipped').checked = state.hideSkipped;
    document.getElementById('expiryToday').checked = state.expiryToday;
    document.getElementById('date-window').value = state.dateWindow || 'any';
    document.getElementById('domainSuffix').value = state.domainSuffix;
    document.getElementById('sort-select').value = `${state.sortField}|${state.sortDir}`;
    document.getElementById('limit-select').value = String(state.limit);
    document.querySelectorAll('.stream-tab').forEach(el => {
      const active = el.dataset.stream === state.stream ||
        (el.id === 'godaddy-tab' && state.stream.startsWith('godaddy-'));
      el.classList.toggle('active', active);
    });
    document.querySelectorAll('.tld-pill').forEach(el =>
      el.classList.toggle('active', el.dataset.tld === state.tld));
    document.querySelectorAll('.taken-in-pill').forEach(el => el.classList.remove('active'));
    const expiringLabel = document.getElementById('expiry-active-label');
    const expiringClear = document.getElementById('expiry-clear-btn');
    if (expiringLabel) expiringLabel.style.display = 'none';
    if (expiringClear) expiringClear.style.display = 'none';
  },

  _escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
  },

  openResearchKeyword(keyword) {
    this.setStream('_research');
    setTimeout(() => {
      const input = document.getElementById('research-prefix');
      if (input) input.value = keyword;
      this.runResearch();
    }, 50);
  },

  async openTrendKeyword(keyword, date = '') {
    const clean = String(keyword || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
    if (!clean) return;
    const modal = document.getElementById('trend-detail-modal');
    const title = document.getElementById('trend-detail-title');
    const meta = document.getElementById('trend-detail-meta');
    const dates = document.getElementById('trend-detail-dates');
    const body = document.getElementById('trend-detail-body');
    const researchBtn = document.getElementById('trend-detail-research');
    modal.style.display = 'flex';
    title.textContent = clean;
    meta.textContent = 'Loading trend history...';
    dates.innerHTML = '';
    body.innerHTML = '<span style="color:var(--muted);font-size:11px">Loading...</span>';
    researchBtn.onclick = () => {
      this.closeTrendDetail();
      this.openResearchKeyword(clean);
    };
    try {
      const url = `${API}/api/trend-keyword?keyword=${encodeURIComponent(clean)}${date ? `&date=${encodeURIComponent(date)}` : ''}`;
      const data = await fetch(url).then(r => r.json());
      if (data.error) throw new Error(data.error);
      this._renderTrendDetail(data);
    } catch (err) {
      meta.textContent = 'Error';
      body.innerHTML = `<span style="color:var(--red);font-size:11px">${this._escapeHtml(err.message)}</span>`;
    }
  },

  closeTrendDetail() {
    const modal = document.getElementById('trend-detail-modal');
    if (modal) modal.style.display = 'none';
  },

  _renderTrendDetail(data) {
    const keyword = data.keyword || '';
    const title = document.getElementById('trend-detail-title');
    const meta = document.getElementById('trend-detail-meta');
    const dates = document.getElementById('trend-detail-dates');
    const body = document.getElementById('trend-detail-body');
    const selected = data.selected || {};
    const selectedTlds = Array.isArray(selected.tlds) ? selected.tlds : [];
    const currentTlds = Array.isArray(data.currentTlds) ? data.currentTlds : [];
    const currentSet = new Set(currentTlds);
    const localByTld = new Map((data.localTlds || []).map(row => [row.tld, row]));

    title.textContent = keyword;
    meta.textContent = `${currentTlds.length.toLocaleString()} current extensions · ${data.dates?.length || 0} recorded dates`;

    const dateRows = data.dates || [];
    dates.innerHTML = dateRows.length
      ? dateRows.map(row => {
          const active = row.trend_date === data.selectedDate;
          const source = String(row.source || '').includes('observed-feeds') ? 'obs' :
            String(row.source || '').includes('coverage') ? 'base' : 'zone';
          const count = row.hasTldList ? (row.tlds?.length || row.tld_count || 0) : row.tld_count;
          return `<button onclick="app.openTrendKeyword('${keyword}','${row.trend_date}')"
            style="width:100%;display:flex;justify-content:space-between;gap:8px;margin-bottom:6px;padding:7px 8px;background:${active ? 'rgba(198,241,74,.12)' : 'transparent'};border:1px solid ${active ? 'var(--accent)' : 'var(--border-light)'};color:${active ? 'var(--accent)' : 'var(--muted)'};font-family:var(--font-mono);font-size:11px;cursor:pointer;text-align:left">
            <span>${row.trend_date}</span><span>${count} ${source}</span>
          </button>`;
        }).join('')
      : '<span style="color:var(--muted);font-size:11px">No dated trend history yet.</span>';

    const renderPills = (tlds, mode) => {
      if (!tlds.length) return '<span style="color:var(--muted);font-size:11px">No exact extension list captured for this date yet.</span>';
      return tlds.map(tld => {
        const info = localByTld.get(tld);
        const price = info?.price != null ? ` $${Number(info.price).toLocaleString()}` : '';
        const href = info?.url || `https://${keyword}${tld}/`;
        const isCurrent = currentSet.has(tld);
        const color = mode === 'current' || isCurrent ? 'var(--accent)' : 'var(--muted)';
        return `<a href="${href}" target="_blank" rel="noopener"
          title="${this._escapeHtml([info?.domain, ...(info?.streams || [])].filter(Boolean).join(' · '))}"
          style="display:inline-block;margin:3px 4px 3px 0;padding:4px 8px;border:1px solid var(--border);border-radius:3px;color:${color};text-decoration:none;font-size:11px;white-space:nowrap">${tld}${price}</a>`;
      }).join('');
    };

    const selectedSource = String(selected.source || '').replaceAll('+', ' + ');
    body.innerHTML = `
      <div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">Registered Extensions · ${this._escapeHtml(data.selectedDate || 'current')}</div>
      <div style="margin-bottom:14px;line-height:2">${renderPills(selectedTlds, 'selected')}</div>
      <div style="font-size:10px;color:var(--muted);margin-bottom:18px">
        ${selectedTlds.length ? `${selectedTlds.length} extensions on this date` : `${selected.tld_count || 0} extensions counted on this date`}
        ${selectedSource ? ` · ${this._escapeHtml(selectedSource)}` : ''}
      </div>
      <div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">Current Known Coverage</div>
      <div style="line-height:2">${renderPills(currentTlds, 'current')}</div>
    `;
  },

  async checkConfig() {
    try {
      const resp = await fetch(`${API}/api/config-status`);
      const data = await resp.json();
      if (!data.czdsConfigured) {
        // Show setup info (non-blocking — auctions still work without it)
        const inst = document.getElementById('setup-instructions');
        if (inst) inst.style.display = 'block';
      }
    } catch (_) {}
  },

  // ── Generic dropdown toggle (shared by Expiring + Expired) ──
  toggleDropdown(ddId, tabId, e) {
    e.stopPropagation();
    // Close any other open dropdowns first
    document.querySelectorAll('.stream-dropdown.open').forEach(el => { if (el.id !== ddId) el.classList.remove('open'); });
    const dd  = document.getElementById(ddId);
    const btn = document.getElementById(tabId);
    const isOpen = dd.classList.contains('open');
    dd.classList.toggle('open', !isOpen);
    if (!isOpen) {
      const rect = btn.getBoundingClientRect();
      dd.style.top  = rect.bottom + 'px';
      dd.style.left = rect.left + 'px';
      const close = (ev) => {
        if (!dd.contains(ev.target) && ev.target.id !== tabId) {
          dd.classList.remove('open');
          document.removeEventListener('click', close);
        }
      };
      setTimeout(() => document.addEventListener('click', close), 0);
    }
  },

  setStreamDropdown(stream, tabId, ddId) {
    document.getElementById(ddId).classList.remove('open');
    document.querySelectorAll(`#${ddId} .stream-dropdown-item`).forEach(el =>
      el.classList.toggle('active', el.dataset.stream === stream));
    document.getElementById(tabId).classList.add('active');
    this.setStream(stream);
  },

  // ── Stream nav ──
  _toolPanels: ['_research', '_lookup', '_trending', '_tldgrowth'],

  _hideAllToolPanels() {
    document.getElementById('research-panel').style.display  = 'none';
    document.getElementById('lookup-panel').style.display    = 'none';
    document.getElementById('trending-panel').style.display  = 'none';
    document.getElementById('tldgrowth-panel').style.display = 'none';
    document.querySelector('.toolbar').style.display = '';
    document.getElementById('table-wrap').style.display = '';
    document.querySelector('.pagination').style.display = '';
  },

  setStream(stream) {
    // Handle tool panels
    if (stream === '_research') {
      state.stream = '_research';
      document.querySelectorAll('.stream-tab').forEach(el =>
        el.classList.toggle('active', el.dataset.stream === '_research'));
      this._hideAllToolPanels();
      this.showResearchPanel();
      return;
    }
    if (stream === '_lookup') {
      state.stream = '_lookup';
      document.querySelectorAll('.stream-tab').forEach(el =>
        el.classList.toggle('active', el.dataset.stream === '_lookup'));
      this._hideAllToolPanels();
      this.showLookupPanel();
      return;
    }
    if (stream === '_trending') {
      state.stream = '_trending';
      document.querySelectorAll('.stream-tab').forEach(el =>
        el.classList.toggle('active', el.dataset.stream === '_trending'));
      this._hideAllToolPanels();
      this.showTrendingPanel();
      return;
    }
    if (stream === '_tldgrowth') {
      state.stream = '_tldgrowth';
      document.querySelectorAll('.stream-tab').forEach(el =>
        el.classList.toggle('active', el.dataset.stream === '_tldgrowth'));
      this._hideAllToolPanels();
      this.showTldGrowthPanel();
      return;
    }

    // Leaving a tool panel — restore main UI
    if (this._toolPanels.includes(state.stream)) {
      this._hideAllToolPanels();
    }

    state.stream = stream;
    state.page = 1;
    document.querySelectorAll('.stream-tab').forEach(el => {
      el.classList.toggle('active', el.dataset.stream === stream);
    });
    // Group tabs stay highlighted when a sub-stream is active
    const expiringTab = document.getElementById('expiring-tab');
    if (expiringTab) expiringTab.classList.toggle('active', stream.startsWith('_expiring'));
    const expiredTab = document.getElementById('expired-tab');
    if (expiredTab) expiredTab.classList.toggle('active', stream.startsWith('_expired'));
    const godaddyTab = document.getElementById('godaddy-tab');
    if (godaddyTab) godaddyTab.classList.toggle('active', stream === 'godaddy-auction' || stream === 'godaddy-closeout' || stream === 'godaddy-premium');
    this.loadDomains();
  },

  // ── TLD filter ──
  setTLD(tld) {
    state.tld = tld;
    state.page = 1;
    document.querySelectorAll('.tld-pill').forEach(el => {
      el.classList.toggle('active', el.dataset.tld === tld);
    });
    this.loadDomains();
  },

  // ── Search ──
  onSearch() {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      state.q = document.getElementById('search-input').value.trim();
      state.searchMode = document.getElementById('search-mode').value;
      state.page = 1;
      this.loadDomains();
    }, 300);
  },

  // ── Filters ──
  applyFilters() {
    state.minLength = document.getElementById('minLength').value;
    state.maxLength = document.getElementById('maxLength').value;
    state.minAge = document.getElementById('minAge').value;
    state.maxAge = document.getElementById('maxAge').value;
    state.maxPrice = document.getElementById('maxPrice').value;
    state.noNumbers = document.getElementById('noNumbers').checked;
    state.noHyphens = document.getElementById('noHyphens').checked;
    state.hasWayback = document.getElementById('hasWayback').checked;
    state.dnsAvailable = document.getElementById('dnsAvailable').checked;
    state.hasBids = document.getElementById('hasBids').checked;
    state.hideSkipped = document.getElementById('hideSkipped').checked;
    state.expiryToday = document.getElementById('expiryToday').checked;
    state.dateWindow = document.getElementById('date-window').value || 'any';
    if (state.dateWindow !== 'any') {
      state.expiryToday = false;
      document.getElementById('expiryToday').checked = false;
    }
    state.domainSuffix = document.getElementById('domainSuffix').value.trim();

    const sortVal = document.getElementById('sort-select').value;
    const [sf, sd] = sortVal.split('|');
    state.sortField = sf;
    state.sortDir = sd;
    const parsedLimit = parseInt(document.getElementById('limit-select').value, 10);
    state.limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 1000;
    state.page = 1;
    this.loadDomains();
  },

  toggleTakenIn(tld) {
    if (state.takenInTlds.has(tld)) {
      state.takenInTlds.delete(tld);
    } else {
      state.takenInTlds.add(tld);
    }
    document.querySelectorAll('.taken-in-pill').forEach(el =>
      el.classList.toggle('active', state.takenInTlds.has(el.dataset.tld)));
    state.page = 1;
    this.loadDomains();
  },

  resetFilters() {
    state.stream = 'all';
    state.tld = 'all';
    state.q = '';
    state.searchMode = 'contains';
    state.minLength = ''; state.maxLength = '';
    state.minAge = ''; state.maxAge = '';
    state.maxPrice = '';
    state.noNumbers = false; state.noHyphens = false;
    state.hasWayback = false; state.dnsAvailable = false; state.hasBids = false;
    state.hideSkipped = false; state.expiryToday = false; state.dateWindow = 'any';
    state.domainSuffix = '';
    state.takenInTlds = new Set();
    state.page = 1;

    document.getElementById('search-input').value = '';
    document.getElementById('search-mode').value = 'contains';
    document.getElementById('maxPrice').value = '';
    document.getElementById('minLength').value = '';
    document.getElementById('maxLength').value = '';
    document.getElementById('minAge').value = '';
    document.getElementById('maxAge').value = '';
    document.getElementById('noNumbers').checked = false;
    document.getElementById('noHyphens').checked = false;
    document.getElementById('hasWayback').checked = false;
    document.getElementById('dnsAvailable').checked = false;
    document.getElementById('hasBids').checked = false;
    document.getElementById('hideSkipped').checked = false;
    document.getElementById('expiryToday').checked = false;
    document.getElementById('date-window').value = 'any';
    document.getElementById('domainSuffix').value = '';
    document.getElementById('sort-select').value = 'discovered_at|DESC';

    document.querySelectorAll('.stream-tab').forEach(el => el.classList.toggle('active', el.dataset.stream === 'all'));
    document.querySelectorAll('.tld-pill').forEach(el => el.classList.toggle('active', el.dataset.tld === 'all'));
    document.querySelectorAll('.taken-in-pill').forEach(el => el.classList.remove('active'));
    this.clearExpiringFilter();

    this.loadDomains();
  },

  applyExpiringFilter() {
    const days = parseInt(document.getElementById('expiring-days').value);
    if (!days || days < 1) return;
    state.stream = `_expiring${days}`;
    state.page = 1;
    document.querySelectorAll('.stream-tab').forEach(el => el.classList.remove('active'));
    document.getElementById('expiry-active-label').textContent = `Expiring within ${days} day${days === 1 ? '' : 's'}`;
    document.getElementById('expiry-active-label').style.display = 'block';
    document.getElementById('expiry-clear-btn').style.display = '';
    this.loadDomains();
  },

  clearExpiringFilter() {
    document.getElementById('expiring-days').value = '';
    document.getElementById('expiry-active-label').style.display = 'none';
    document.getElementById('expiry-clear-btn').style.display = 'none';
    if (state.stream && state.stream.startsWith('_expiring')) {
      state.stream = 'all';
      document.querySelectorAll('.stream-tab').forEach(el => el.classList.toggle('active', el.dataset.stream === 'all'));
      this.loadDomains();
    }
  },

  // ── Sort ──
  sort(field) {
    if (state.sortField === field) {
      state.sortDir = state.sortDir === 'DESC' ? 'ASC' : 'DESC';
    } else {
      state.sortField = field;
      // auction_end defaults to ASC (soonest first); everything else DESC
      state.sortDir = field === 'auction_end' ? 'ASC' : 'DESC';
    }
    state.page = 1;
    // Keep the sort-select dropdown in sync so applyFilters() doesn't overwrite state
    const sel = document.getElementById('sort-select');
    if (sel) {
      const target = `${state.sortField}|${state.sortDir}`;
      const opt = Array.from(sel.options).find(o => o.value === target);
      if (opt) sel.value = target;
    }
    this.updateSortUI();
    this.loadDomains();
  },

  updateSortUI() {
    document.querySelectorAll('thead th').forEach(th => {
      th.classList.remove('sorted');
      const arrow = th.querySelector('.sort-arrow');
      if (arrow) arrow.textContent = '';
    });
    // Find the th for the current sort field
    const fieldMap = {
      domain: 0, stream: 1, tld: 2, length: 3,
      tlds_taken: 4, age_years: 5, wayback_snapshots: 6, bid_count: 7, auction_price: 8,
      expiry_date: 9, auction_end: 10, discovered_at: 11,
    };
    const idx = fieldMap[state.sortField];
    if (idx !== undefined) {
      const th = document.querySelectorAll('thead th')[idx];
      if (th) {
        th.classList.add('sorted');
        const arrow = th.querySelector('.sort-arrow');
        if (arrow) arrow.textContent = state.sortDir === 'DESC' ? '↓' : '↑';
      }
    }
  },

  // ── Pagination ──
  prevPage() { if (state.page > 1) { state.page--; this.loadDomains(); } },
  nextPage() {
    const maxPage = Math.ceil(state.total / state.limit);
    if (state.page < maxPage) { state.page++; this.loadDomains(); }
  },

  // ── Load domains ──
  async loadDomains() {
    // Cancel any in-flight request so TLD/stream switching feels instant
    if (loadAbortController) loadAbortController.abort();
    loadAbortController = new AbortController();
    const signal = loadAbortController.signal;

    const bar = document.getElementById('loading-bar');
    bar.style.display = 'block';
    // Fade existing rows instead of blanking — keeps context while loading
    const tbody = document.getElementById('domain-tbody');
    if (tbody.children.length > 0) tbody.style.opacity = '0.35';

    const params = new URLSearchParams();

    // Special views
    if (state.stream === '_saved') {
      params.set('saved', '1');
    } else if (state.stream === '_unseen') {
      params.set('seen', '0');
      params.set('skipped', '0');
    } else if (state.stream && state.stream.startsWith('_expiring')) {
      params.set('stream', state.stream);
      if (state.sortField === 'discovered_at') params.set('sortField', 'expiry_date');
      if (state.sortDir === 'DESC' && state.sortField === 'discovered_at') params.set('sortDir', 'ASC');
    } else if (state.stream && state.stream.startsWith('_expired')) {
      params.set('stream', state.stream);
      if (state.sortField === 'discovered_at') params.set('sortField', 'expiry_date');
      if (state.sortDir === 'DESC' && state.sortField === 'discovered_at') params.set('sortDir', 'DESC');
    } else if (state.stream !== 'all') {
      params.set('stream', state.stream);
    }

    if (state.tld !== 'all') params.set('tld', state.tld);
    if (state.q) { params.set('q', state.q); params.set('searchMode', state.searchMode); }
    if (state.maxPrice) params.set('maxPrice', state.maxPrice);
    if (state.minLength) params.set('minLength', state.minLength);
    if (state.maxLength) params.set('maxLength', state.maxLength);
    if (state.minAge) params.set('minAge', state.minAge);
    if (state.maxAge) params.set('maxAge', state.maxAge);
    if (state.noNumbers) params.set('noNumbers', '1');
    if (state.noHyphens) params.set('noHyphens', '1');
    if (state.hasWayback) params.set('hasWayback', '1');
    if (state.dnsAvailable) params.set('dnsAvailable', '1');
    if (state.hasBids) params.set('hasBids', '1');
    if (state.hideSkipped) params.set('skipped', '0');
    if (state.expiryToday) params.set('expiryToday', '1');
    if (state.dateWindow && state.dateWindow !== 'any') params.set('dateWindow', state.dateWindow);
    if (state.domainSuffix) params.set('domainSuffix', state.domainSuffix);
    if (state.takenInTlds.size > 0) params.set('takenIn', [...state.takenInTlds].join(','));
    params.set('sortField', state.sortField);
    params.set('sortDir', state.sortDir);
    params.set('page', state.page);
    params.set('limit', state.limit);

    // Reflect the current view in the address bar so it is shareable, survives a
    // reload, and Back/Forward navigate between views (like ExpiredDomains). Use
    // pushState when the FILTER state changed (stream/tld/search/date/etc.) so
    // Back returns to the previous search; use replaceState for same-filter
    // pagination/sort so we do not spam history. popstate (handled in init)
    // restores state from the URL. _restoringFromUrl guards the popstate reload
    // from pushing a new entry.
    try {
      const urlParams = new URLSearchParams(params.toString());
      urlParams.delete('knownTotal');
      const qs = urlParams.toString();
      const newUrl = qs ? `?${qs}` : window.location.pathname;
      const filterKeys = ['stream', 'tld', 'q', 'searchMode', 'maxPrice', 'minLength', 'maxLength', 'minAge', 'maxAge', 'noNumbers', 'noHyphens', 'hasWayback', 'dnsAvailable', 'hasBids', 'skipped', 'expiryToday', 'dateWindow', 'domainSuffix', 'takenIn'];
      const filterSig = (p) => filterKeys.map(k => `${k}=${p.get(k) || ''}`).join('&');
      const cur = new URLSearchParams(window.location.search);
      if (!this._restoringFromUrl && filterSig(urlParams) !== filterSig(cur)) {
        window.history.pushState(null, '', newUrl);
      } else {
        window.history.replaceState(null, '', newUrl);
      }
    } catch { /* history API unavailable — non-fatal */ }

    // Skip server-side COUNT on page 2+ — total doesn't change while paginating.
    // Auction streams age out continuously, so do not trust a cached total there.
    const auctionEndSort = state.sortField === 'auction_end' && state.sortDir === 'ASC';
    const activeAuctionView = ['godaddy-auction', 'namecheap-auction'].includes(state.stream);
    if (!auctionEndSort && !activeAuctionView && state.page > 1 && state.total != null) {
      params.set('knownTotal', state.total);
    } else if (!auctionEndSort && !activeAuctionView) {
      // Page 1: use stream count cache when no filters active
      const noFilters = !state.q && !state.maxPrice && !state.minLength && !state.maxLength &&
        !state.minAge && !state.maxAge && !state.noNumbers && !state.noHyphens &&
        !state.hasWayback && !state.dnsAvailable && !state.hideSkipped && !state.hasBids &&
        !state.expiryToday && (!state.dateWindow || state.dateWindow === 'any') && !state.domainSuffix &&
        !state.takenInTlds.size && state.tld === 'all';
      if (noFilters) {
        const cached = state.streamCounts[state.stream];
        if (cached != null) params.set('knownTotal', cached);
      }
    }

    try {
      const resp = await fetch(`${API}/api/domains?${params}`, { signal });
      if (resp.status === 401) { window.location.href = '/login'; return; }
      const data = await resp.json();
      state.total = data.total;
      tbody.style.opacity = '';
      this.renderTable(data.domains);
      this.updatePagination(data.total, data.page, data.limit);
      document.getElementById('result-count').textContent =
        `${data.total.toLocaleString()} domains`;
    } catch (err) {
      if (err.name === 'AbortError') return; // superseded by a newer request
      console.error('Failed to load domains:', err);
      document.getElementById('result-count').textContent = 'Error loading';
      tbody.style.opacity = '';
    } finally {
      if (!signal.aborted) bar.style.display = 'none';
    }
  },

  // ── Load stats ──
  async loadStats() {
    try {
      const resp = await fetch(`${API}/api/stats`);
      const data = await resp.json();

      document.getElementById('stat-total').textContent = data.total.toLocaleString();
      document.getElementById('stat-unseen').textContent = data.unseen.toLocaleString();
      document.getElementById('stat-saved').textContent = data.saved.toLocaleString();

      // Stream counts in sidebar — also cache for knownTotal hint
      const streamMap = {};
      for (const s of data.byStream) {
        streamMap[s.stream] = s.n;
        state.streamCounts[s.stream] = s.n;
      }
      state.streamCounts['all'] = data.total;
      state.streamCounts['_saved'] = data.saved;
      state.streamCounts['_unseen'] = data.unseen;
      document.getElementById('count-all').textContent = data.total.toLocaleString();
      document.getElementById('count-pending-delete').textContent = (streamMap['pending-delete'] || 0).toLocaleString();
      document.getElementById('count-just-dropped').textContent = (streamMap['just-dropped'] || 0).toLocaleString();
      document.getElementById('count-godaddy-auction').textContent = (streamMap['godaddy-auction'] || 0).toLocaleString();
      document.getElementById('count-godaddy-closeout').textContent = (streamMap['godaddy-closeout'] || 0).toLocaleString();
      const premEl = document.getElementById('count-godaddy-premium');
      if (premEl) premEl.textContent = (streamMap['godaddy-premium'] || 0).toLocaleString();
      document.getElementById('count-namecheap-auction').textContent = (streamMap['namecheap-auction'] || 0).toLocaleString();
      document.getElementById('count-marketplace').textContent = (streamMap['marketplace'] || 0).toLocaleString();
      document.getElementById('count-expiring7').textContent  = (data.expiring7  || 0).toLocaleString();
      document.getElementById('count-expiring14').textContent = (data.expiring14 || 0).toLocaleString();
      document.getElementById('count-expiring30').textContent = (data.expiring30 || 0).toLocaleString();
      document.getElementById('count-expiring60').textContent = (data.expiring60 || 0).toLocaleString();
      document.getElementById('count-expiring90').textContent = (data.expiring90 || 0).toLocaleString();
      document.getElementById('count-expired30').textContent = (data.expired30 || 0).toLocaleString();
      state.streamCounts['_expiring7']  = data.expiring7  || 0;
      state.streamCounts['_expiring14'] = data.expiring14 || 0;
      state.streamCounts['_expiring30'] = data.expiring30 || 0;
      state.streamCounts['_expiring60'] = data.expiring60 || 0;
      state.streamCounts['_expiring90'] = data.expiring90 || 0;
      state.streamCounts['_expired30']  = data.expired30  || 0;
      document.getElementById('count-saved-view').textContent = data.saved.toLocaleString();
      document.getElementById('count-unseen-view').textContent = data.unseen.toLocaleString();

      // Last run
      if (data.lastRun && data.lastRun.length > 0) {
        const last = data.lastRun[0];
        const d = new Date(last.ran_at);
        document.getElementById('last-run').textContent =
          `Last scraped: ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
      }
    } catch (_) {}
  },

  // ── Render table ──
  renderTable(domains) {
    const tbody = document.getElementById('domain-tbody');
    const emptyState = document.getElementById('empty-state');

    if (!domains || domains.length === 0) {
      tbody.innerHTML = '';
      // Only show the full empty/setup state when the DB is truly empty
      const isFiltered = state.stream !== 'all' || state.tld !== 'all' || state.q ||
        state.minLength || state.maxLength || state.noNumbers || state.noHyphens ||
        state.hasWayback || state.dnsAvailable || state.expiryToday ||
        (state.dateWindow && state.dateWindow !== 'any');
      if (isFiltered) {
        emptyState.style.display = 'flex';
        // GoDaddy auctions run on a daily cycle that closes in the early afternoon
        // (Pacific). After that, "ends today only" is correctly empty because every
        // auction ending today has already closed — explain that instead of the
        // generic "no match", which reads as broken when the filter is working.
        const auctionStream = state.stream === 'godaddy-auction' || state.stream === 'godaddy-closeout';
        const endsTodayOn = state.expiryToday || state.dateWindow === 'today';
        document.getElementById('empty-msg').textContent = (auctionStream && endsTodayOn)
          ? "Today's GoDaddy auctions have all ended for the day. Switch the date filter to Tomorrow to see the next batch."
          : 'No domains match your current filters.';
        document.getElementById('setup-instructions').style.display = 'none';
      } else {
        emptyState.style.display = 'flex';
        document.getElementById('empty-msg').textContent = 'Click "Scrape Now" to fetch domains from all streams.';
        document.getElementById('setup-instructions').style.display = '';
      }
      return;
    }
    emptyState.style.display = 'none';

    // Cache domains by id for modal lookups
    state.domainMap = {};
    for (const d of domains) state.domainMap[d.id] = d;

    // When sorted by auction_end ASC, skip any rows that have already ended
    const now = Date.now();
    const filteredDomains = (state.sortField === 'auction_end' && state.sortDir === 'ASC')
      ? domains.filter(d => !d.auction_end || new Date(d.auction_end).getTime() > now)
      : domains;
    tbody.innerHTML = filteredDomains.map(d => this.renderRow(d)).join('');
    this.setupTldObserver();

    // Show/hide stream column based on current view
    const showStream = state.stream === 'all' || state.stream.startsWith('_');
    const streamTh = document.querySelector('thead th.col-stream');
    if (streamTh) streamTh.style.display = showStream ? '' : 'none';
  },

  renderRow(d) {
    const streamBadge = {
      'pending-delete':    `<span class="badge badge-pending">Pending</span>`,
      'just-dropped':      `<span class="badge badge-dropped">Dropped</span>`,
      'godaddy-auction':   `<span class="badge badge-auction">GoDaddy</span>`,
      'godaddy-closeout':  `<span class="badge badge-closeout">Closeout</span>`,
      'godaddy-premium':   `<span class="badge badge-premium">Premium</span>`,
      'namecheap-auction': `<span class="badge badge-auction">Namecheap</span>`,
      'marketplace':       `<span class="badge badge-market">Market</span>`,
      'discovered':        `<span class="badge badge-discovered">Tracked</span>`,
    }[d.stream] || `<span class="badge">${d.stream}</span>`;

    // Hide stream column when already filtered to a specific stream
    const showStream = state.stream === 'all' || state.stream.startsWith('_');

    const bids = d.bid_count > 0
      ? `<span style="color:var(--accent);font-weight:600">${d.bid_count}</span>`
      : `<span class="dot-muted">—</span>`;

    const wb = d.wayback_snapshots > 0
      ? `<span style="color:var(--blue);font-family:var(--font-mono);font-size:10px" title="First: ${d.wayback_first || '?'} Last: ${d.wayback_last || '?'}">${d.wayback_snapshots.toLocaleString()}</span>`
      : `<span class="dot-muted">—</span>`;

    const age = d.age_years !== null && d.age_years !== undefined
      ? `<span class="num">${d.age_years}y</span>`
      : `<span class="dot-muted">—</span>`;

    const price = d.auction_price
      ? `<span class="price-text">$${Number(d.auction_price).toLocaleString()}</span>`
      : `<span class="dot-muted">—</span>`;

    const found = d.discovered_at
      ? `<span class="date-text">${new Date(d.discovered_at).toLocaleDateString([], { month: 'short', day: 'numeric' })}</span>`
      : '';

    // Drops column — actual domain registration expiry date (from RDAP)
    let dropsCell = `<span class="dot-muted">—</span>`;
    if (d.expiry_date) {
      const exp = new Date(d.expiry_date);
      const daysLeft = Math.floor((exp - Date.now()) / 86400000);
      const dateStr = exp.toLocaleDateString([], { month: 'short', day: 'numeric', year: '2-digit' });
      if (daysLeft <= 30) {
        dropsCell = `<span style="color:#f56565;font-size:11px;font-weight:600" title="${daysLeft} days until drop">🔥 ${dateStr}</span>`;
      } else if (daysLeft <= 60) {
        dropsCell = `<span style="color:#ed8936;font-size:11px;font-weight:600" title="${daysLeft} days until drop">⚡ ${dateStr}</span>`;
      } else if (daysLeft <= 90) {
        dropsCell = `<span style="color:#ecc94b;font-size:11px" title="${daysLeft} days until drop">${dateStr}</span>`;
      } else {
        dropsCell = `<span style="color:var(--muted);font-size:11px" title="${daysLeft} days until drop">${dateStr}</span>`;
      }
    }

    // Auction End column — when the catching/selling auction closes
    let auctionEndCell = `<span class="dot-muted">—</span>`;
    if (d.auction_end) {
      const exp = new Date(d.auction_end);
      const msLeft = exp - Date.now();
      const dateStr = exp.toLocaleDateString([], { month: 'short', day: 'numeric', year: '2-digit' });
      const timeStr = exp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const fullTitle = `${dateStr} at ${timeStr}`;

      let countdownStr;
      if (msLeft <= 0) {
        countdownStr = 'Ended';
        auctionEndCell = `<span style="color:var(--muted);font-size:11px" title="${fullTitle}">${countdownStr}</span>`;
      } else {
        const hoursLeft = msLeft / 3600000;
        const daysLeft  = Math.floor(hoursLeft / 24);
        if (hoursLeft < 1) {
          const minsLeft = Math.floor(msLeft / 60000);
          countdownStr = `${minsLeft}m`;
          auctionEndCell = `<span style="color:#f56565;font-size:11px;font-weight:700" title="${fullTitle}">🔥 ${countdownStr}</span>`;
        } else if (hoursLeft < 24) {
          countdownStr = `${Math.floor(hoursLeft)}h ${Math.floor((hoursLeft % 1) * 60)}m`;
          auctionEndCell = `<span style="color:#f56565;font-size:11px;font-weight:600" title="${fullTitle}">🔥 ${countdownStr}</span>`;
        } else if (daysLeft <= 3) {
          countdownStr = `${daysLeft}d ${Math.floor(hoursLeft % 24)}h`;
          auctionEndCell = `<span style="color:#ed8936;font-size:11px;font-weight:600" title="${fullTitle}">⚡ ${countdownStr}</span>`;
        } else if (daysLeft <= 7) {
          countdownStr = `${daysLeft}d`;
          auctionEndCell = `<span style="color:#ecc94b;font-size:11px" title="${fullTitle}">⚡ ${countdownStr}</span>`;
        } else {
          auctionEndCell = `<span style="color:var(--muted);font-size:11px" title="${fullTitle}">${dateStr}</span>`;
        }
      }
    }

    const extLink = d.auction_url
      ? `<a class="domain-ext-link" href="${d.auction_url}" target="_blank" rel="noopener" title="Open auction" onclick="event.stopPropagation()">↗</a>`
      : '';
    const domainLink = `<span class="domain-name domain-clickable" onclick="app.openModal(${d.id})">${d.domain}</span>${extLink}`;

    const saveBtn = `<button class="action-btn ${d.saved ? 'saved' : ''}" title="${d.saved ? 'Unsave' : 'Save'}" onclick="app.toggleSaved(${d.id}, ${d.saved})">★</button>`;
    const skipBtn = `<button class="action-btn ${d.skipped ? 'skipped' : ''}" title="${d.skipped ? 'Unskip' : 'Skip'}" onclick="app.toggleSkipped(${d.id}, ${d.skipped})">✗</button>`;
    const markSeen = d.seen ? '' : `<button class="action-btn" title="Mark seen" onclick="app.markSeen(${d.id})">👁</button>`;

    const rowClass = [
      d.saved ? 'saved-row' : '',
      d.skipped ? 'skipped-row' : '',
      d.seen ? 'seen-row' : '',
    ].filter(Boolean).join(' ');
    const baseName = d.base_name || d.domain.slice(0, d.domain.lastIndexOf('.'));
    const tldsVerified = d.tlds_verified !== false && d.tlds_checked_at && d.tlds_taken != null;
    const tldCount = Number(d.tlds_taken || 0);
    const autoRefineTlds = state.limit <= 250 && !['godaddy-auction', 'godaddy-closeout'].includes(state.stream);
    const needsTldRefine = autoRefineTlds && !tldsVerified &&
      baseName && !baseName.includes('.');
    const tldCellAttrs = needsTldRefine
      ? ` data-needs-tld="1" data-base-name="${baseName}" data-domain-id="${d.id}"`
      : '';
    const tldsCell = tldsVerified
      ? tldCount > 0
        ? `<button onclick="app.openTldModal('${baseName}',${tldCount},this)" style="background:none;border:none;cursor:pointer;font-family:var(--font-mono);font-size:11px;padding:0;text-decoration:underline dotted;color:${tldCount > 3 ? 'var(--accent);font-weight:600' : 'var(--muted)'}" title="Click to see extensions">${tldCount}</button>`
        : `<span class="dot-muted">0</span>`
      : `<span class="dot-muted" title="Queued for supported TLD universe check">&hellip;</span>`;

    return `<tr class="${rowClass}" id="row-${d.id}">
      <td class="col-domain-cell">${domainLink}</td>
      <td class="col-stream-cell" style="${showStream ? '' : 'display:none'}">${streamBadge}</td>
      <td class="tld-text">${d.tld}</td>
      <td class="num">${d.length}</td>
      <td class="num" id="tld-cell-${d.id}"${tldCellAttrs}>${tldsCell}</td>
      <td>${age}</td>
      <td>${wb}</td>
      <td style="text-align:center">${bids}</td>
      <td>${price}</td>
      <td>${dropsCell}</td>
      <td>${auctionEndCell}</td>
      <td>${found}</td>
      <td>
        <div class="row-actions">
          ${saveBtn}${skipBtn}${markSeen}
        </div>
      </td>
    </tr>`;
  },

  // ── Domain actions ──
  async toggleSaved(id, current) {
    const newVal = current ? 0 : 1;
    this.updateRowState(id, { saved: newVal });
    await this.patch(id, { saved: newVal });
    this.loadStats();
  },

  async toggleSkipped(id, current) {
    const newVal = current ? 0 : 1;
    this.updateRowState(id, { skipped: newVal });
    await this.patch(id, { skipped: newVal });
    this.loadStats();
  },

  // Update a single row in-place without reloading the table
  updateRowState(id, changes) {
    const row = document.getElementById(`row-${id}`);
    if (!row) return;
    if (changes.saved !== undefined) {
      const btn = row.querySelector('.action-btn[title="Save"], .action-btn[title="Unsave"]');
      if (btn) {
        btn.title = changes.saved ? 'Unsave' : 'Save';
        btn.className = `action-btn${changes.saved ? ' saved' : ''}`;
        btn.setAttribute('onclick', `app.toggleSaved(${id}, ${changes.saved})`);
      }
      row.classList.toggle('saved-row', !!changes.saved);
    }
    if (changes.skipped !== undefined) {
      const btn = row.querySelector('.action-btn[title="Skip"], .action-btn[title="Unskip"]');
      if (btn) {
        btn.title = changes.skipped ? 'Unskip' : 'Skip';
        btn.className = `action-btn${changes.skipped ? ' skipped' : ''}`;
        btn.setAttribute('onclick', `app.toggleSkipped(${id}, ${changes.skipped})`);
      }
      row.classList.toggle('skipped-row', !!changes.skipped);
    }
  },

  async markSeen(id) {
    await this.patch(id, { seen: true });
    const row = document.getElementById(`row-${id}`);
    if (row) row.classList.add('seen-row');
    this.loadStats();
  },

  async patch(id, body) {
    try {
      await fetch(`${API}/api/domains/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (err) {
      console.error('Patch error:', err);
    }
  },

  // ── Pagination UI ──
  updatePagination(total, page, limit) {
    const maxPage = Math.ceil(total / limit) || 1;
    document.getElementById('page-info').textContent =
      `Page ${page} of ${maxPage} (${total.toLocaleString()} total)`;
    document.getElementById('prev-btn').disabled = page <= 1;
    document.getElementById('next-btn').disabled = page >= maxPage;
  },

  // ── Manual scrape ──
  async triggerScrape() {
    const btn = document.getElementById('scrape-btn');
    btn.disabled = true;
    btn.textContent = '⟳ Scraping...';
    try {
      await fetch(`${API}/api/scrape`, { method: 'POST' });
      this.showToast('Scrape started — runs in background');
      setTimeout(() => this.loadStats(), 3000);
      setTimeout(() => this.loadDomains(), 8000);
    } catch (_) {
      this.showToast('Error starting scrape');
    } finally {
      setTimeout(() => {
        btn.disabled = false;
        btn.textContent = '▶ Scrape Now';
      }, 3000);
    }
  },

  // ── TLD scroll-check ──
  setupTldObserver() {
    if (this.tldObserver) { this.tldObserver.disconnect(); this.tldObserver = null; }
    this.tldQueue = [];
    const cells = Array.from(document.querySelectorAll('[data-needs-tld]')).slice(0, 25);
    if (!cells.length) return;

    const scrollRoot = document.querySelector('.table-wrap') || null;
    this.tldObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const cell = entry.target;
        this.tldObserver.unobserve(cell);
        const baseName = cell.dataset.baseName;
        const id = parseInt(cell.dataset.domainId);
        if (!baseName || !id) continue;
        cell.innerHTML = `<span class="tld-loading">…</span>`;
        delete cell.dataset.needsTld;
        this.tldQueue.push({ baseName, id, cell });
        this.drainTldQueue();
      }
    }, { root: scrollRoot, threshold: 0, rootMargin: '400px 0px' });

    cells.forEach(el => this.tldObserver.observe(el));
  },

  drainTldQueue() {
    while (this.tldActive < 3 && this.tldQueue.length > 0) {
      const item = this.tldQueue.shift();
      this.tldActive++;
      this.fetchTldCount(item.baseName, item.id, item.cell)
        .finally(() => { this.tldActive--; this.drainTldQueue(); });
    }
  },

  async fetchTldCount(baseName, id, cell) {
    try {
      const resp = await fetch(`${API}/api/tlds-check-hybrid?baseName=${encodeURIComponent(baseName)}`);
      const data = await resp.json();
      if (data.error) throw new Error(data.error);
      const total = data.all ? data.all.length : this.tldTotal;
      this.tldTotal = total;
      const previousCount = state.domainMap[id]?.tlds_taken;
      if (state.domainMap[id]) {
        state.domainMap[id].tlds_taken = data.count;
        state.domainMap[id].tlds_checked_at = data.checkedAt || new Date().toISOString();
      }
      if (cell && cell.isConnected) {
        cell.innerHTML = data.count > 3
          ? `<button onclick="app.openTldModal('${baseName}',${data.count},this)" style="background:none;border:none;cursor:pointer;font-family:var(--font-mono);font-size:11px;padding:0;text-decoration:underline dotted;color:var(--accent);font-weight:600" title="Click to see extensions">${data.count}</button>`
          : data.count > 0 ? `<button onclick="app.openTldModal('${baseName}',${data.count},this)" style="background:none;border:none;cursor:pointer;font-family:var(--font-mono);font-size:11px;padding:0;text-decoration:underline dotted;color:var(--muted)" title="Click to see extensions">${data.count}</button>`
          : `<span class="dot-muted">0</span>`;
      }
      if (state.sortField === 'tlds_taken' && previousCount !== data.count) {
        clearTimeout(this._tldReloadTimer);
        this._tldReloadTimer = setTimeout(() => this.loadDomains(), 1500);
      }
    } catch (_) {
      if (cell && cell.isConnected) cell.innerHTML = `<span class="dot-muted">—</span>`;
    }
  },

  // ── Domain detail modal ──
  openModal(id) {
    const d = state.domainMap[id];
    if (!d) return;
    state.modalDomain = d;

    const baseName = d.domain.slice(0, d.domain.lastIndexOf('.'));

    // Header
    document.getElementById('modal-domain-name').textContent = d.domain;
    const streamLabels = {
      'pending-delete': 'Pending', 'just-dropped': 'Dropped',
      'godaddy-auction': 'GoDaddy', 'godaddy-closeout': 'Closeout', 'godaddy-premium': 'Premium', 'namecheap-auction': 'Namecheap',
      'marketplace': 'Market', 'discovered': 'Tracked',
    };
    const badgeClasses = {
      'pending-delete': 'badge-pending', 'just-dropped': 'badge-dropped',
      'godaddy-auction': 'badge-auction', 'godaddy-closeout': 'badge-closeout', 'godaddy-premium': 'badge-premium', 'namecheap-auction': 'badge-auction',
      'marketplace': 'badge-market',
    };
    document.getElementById('modal-stream-badge').innerHTML =
      `<span class="badge ${badgeClasses[d.stream] || ''}">${streamLabels[d.stream] || d.stream}</span>`;

    const alink = document.getElementById('modal-auction-link');
    if (d.auction_url) {
      alink.href = d.auction_url;
      alink.style.display = '';
    } else {
      alink.style.display = 'none';
    }

    // Info grid
    const fmt = (label, val) => `<div class="modal-info-item">
      <span class="modal-info-label">${label}</span>
      <span class="modal-info-val">${val}</span>
    </div>`;
    const modalBids = d.bid_count > 0 ? `<span style="color:var(--accent)">${d.bid_count}</span>` : '—';
    const wb = d.wayback_snapshots > 0
      ? `<span style="color:var(--blue)">${d.wayback_snapshots.toLocaleString()}</span>${d.wayback_first ? ` <span style="color:var(--muted);font-size:10px">(${d.wayback_first?.slice(0,4)}–${d.wayback_last?.slice(0,4)})</span>` : ''}`
      : '—';
    const price = d.auction_price ? `$${Number(d.auction_price).toLocaleString()}` : '—';
    const drops = d.expiry_date ? new Date(d.expiry_date).toLocaleDateString([], {month:'short',day:'numeric',year:'2-digit'}) : '—';
    const aend  = d.auction_end  ? new Date(d.auction_end).toLocaleDateString([], {month:'short',day:'numeric',year:'2-digit'}) : '—';
    const found = d.discovered_at ? new Date(d.discovered_at).toLocaleDateString([], {month:'short',day:'numeric'}) : '—';
    document.getElementById('modal-info-grid').innerHTML =
      fmt('TLD', d.tld) +
      fmt('Length', d.length) +
      fmt('Age', d.age_years != null ? d.age_years + 'y' : '—') +
      fmt('Wayback', wb) +
      fmt('Bids', modalBids) +
      fmt('Price', price) +
      fmt('Drops', drops) +
      fmt('Auction End', aend) +
      fmt('Bids', d.bid_count > 0 ? `<span style="color:var(--accent)">${d.bid_count}</span>` : '—') +
      fmt('Found', found);

    // TLD section
    const verifiedTlds = d.tlds_verified !== false && d.tlds_checked_at && d.tlds_taken != null;
    const checkedAt = verifiedTlds ? d.tlds_checked_at : null;
    const checkedAgo = checkedAt ? (() => {
      const mins = Math.floor((Date.now() - new Date(checkedAt)) / 60000);
      return mins < 60 ? `${mins}m ago` : `${Math.floor(mins/60)}h ago`;
    })() : null;
    document.getElementById('modal-tlds-meta').textContent = checkedAgo ? `checked ${checkedAgo}` : '';
    document.getElementById('modal-check-btn').disabled = false;
    document.getElementById('modal-check-btn').textContent = checkedAt ? '↻ Re-check' : '↻ Check Now';

    document.getElementById('modal-tlds-result').innerHTML = checkedAt
      ? `<div class="tlds-summary"><strong>${d.tlds_taken || 0}</strong> verified across ${d.tlds_all_count || 'the supported'} TLDs. Use Re-check to refresh live coverage.</div>`
      : `<div class="tlds-checking">TLDs have not been verified across the supported TLD universe yet. Use Check Now to refresh coverage.</div>`;

    // Actions
    const saveBtn = document.getElementById('modal-save-btn');
    const skipBtn = document.getElementById('modal-skip-btn');
    saveBtn.className = 'modal-action-btn' + (d.saved ? ' active-save' : '');
    saveBtn.textContent = d.saved ? '★ Saved' : '★ Save';
    skipBtn.className = 'modal-action-btn modal-skip-btn' + (d.skipped ? ' active-skip' : '');
    skipBtn.textContent = d.skipped ? '✗ Skipped' : '✗ Skip';

    document.getElementById('domain-modal').style.display = 'flex';
    document.addEventListener('keydown', this._modalKeyHandler);

  },

  closeModal() {
    document.getElementById('domain-modal').style.display = 'none';
    document.removeEventListener('keydown', this._modalKeyHandler);
    state.modalDomain = null;
  },

  _modalKeyHandler(e) {
    if (e.key === 'Escape') { app.closeModal(); app.closeTldModal(); }
  },

  async checkTLDs() {
    const d = state.modalDomain;
    if (!d) return;
    const baseName = d.domain.slice(0, d.domain.lastIndexOf('.'));
    const btn = document.getElementById('modal-check-btn');
    const resultEl = document.getElementById('modal-tlds-result');

    btn.disabled = true;
    btn.textContent = '↻ Checking...';

    try {
      const resp = await fetch(`${API}/api/tlds-check-hybrid?baseName=${encodeURIComponent(baseName)}&force=1`);
      const data = await resp.json();
      if (data.error) throw new Error(data.error);

      const takenSet = new Set(data.taken);
      const allTlds = data.all || [];
      const freeTlds = allTlds.filter(t => !takenSet.has(t));

      document.getElementById('modal-tlds-meta').textContent = 'just checked';
      btn.textContent = '↻ Re-check';
      btn.disabled = false;

      // Update state so re-open shows count
      if (state.domainMap[d.id]) {
        state.domainMap[d.id].tlds_taken = data.count;
        state.domainMap[d.id].tlds_checked_at = data.checkedAt;
        state.modalDomain = state.domainMap[d.id];
      }

      // Update the TLDs cell in the table row if visible
      const total = data.all ? data.all.length : app.tldTotal;
      app.tldTotal = total;
      const tldsCell = document.getElementById(`tld-cell-${d.id}`);
      if (tldsCell) {
        tldsCell.innerHTML = data.count > 3
          ? `<span style="color:var(--accent);font-weight:600">${data.count}</span>`
          : data.count > 0 ? `<span class="dot-muted">${data.count}</span>`
          : `<span class="dot-muted">0</span>`;
      }

      const takenPills = data.taken.map(t =>
        `<a class="tld-result-pill taken" href="https://${baseName}${t}" target="_blank" rel="noopener">${t}</a>`).join('');
      const freePills = freeTlds.map(t =>
        `<span class="tld-result-pill free">${t}</span>`).join('');

      resultEl.innerHTML = `
        <div class="tlds-summary"><strong>${data.count}</strong> of ${allTlds.length} TLDs registered</div>
        ${data.taken.length > 0 ? `
          <div class="tlds-taken-group">
            <div class="tlds-group-label">Taken (${data.taken.length})</div>
            <div class="tlds-pill-grid">${takenPills}</div>
          </div>` : '<div class="tlds-summary" style="color:var(--green)">No other TLDs registered</div>'}
        <div class="tlds-free-group">
          <div class="tlds-group-label">Available (${freeTlds.length})</div>
          <div class="tlds-pill-grid">${freePills}</div>
        </div>`;
    } catch (err) {
      btn.disabled = false;
      btn.textContent = '↻ Retry';
      resultEl.innerHTML = `<div class="tlds-checking" style="color:var(--red)">Error: ${err.message}</div>`;
    }
  },

  async modalToggleSaved() {
    const d = state.modalDomain;
    if (!d) return;
    const newVal = d.saved ? 0 : 1;
    d.saved = newVal;
    if (state.domainMap[d.id]) state.domainMap[d.id].saved = newVal;
    const btn = document.getElementById('modal-save-btn');
    btn.className = 'modal-action-btn' + (newVal ? ' active-save' : '');
    btn.textContent = newVal ? '★ Saved' : '★ Save';
    this.updateRowState(d.id, { saved: newVal });
    await this.patch(d.id, { saved: newVal });
    this.loadStats();
  },

  async modalToggleSkipped() {
    const d = state.modalDomain;
    if (!d) return;
    const newVal = d.skipped ? 0 : 1;
    d.skipped = newVal;
    if (state.domainMap[d.id]) state.domainMap[d.id].skipped = newVal;
    const btn = document.getElementById('modal-skip-btn');
    btn.className = 'modal-action-btn modal-skip-btn' + (newVal ? ' active-skip' : '');
    btn.textContent = newVal ? '✗ Skipped' : '✗ Skip';
    this.updateRowState(d.id, { skipped: newVal });
    await this.patch(d.id, { skipped: newVal });
    this.loadStats();
  },

  // ── Research Panel ──
  researchCheckQueue: [],
  researchCheckActive: 0,
  _researchAllNames: [],
  _researchBaseList: [],   // unfiltered — source of truth for applyResearchFilter
  _landerResults: {},      // domain → { forSale, price, platform } | { available, price }
  _researchPage: 1,
  _researchPageSize: 50,

  showResearchPanel() {
    document.querySelector('.toolbar').style.display = 'none';
    document.getElementById('table-wrap').style.display = 'none';
    document.getElementById('loading-bar').style.display = 'none';
    document.querySelector('.pagination').style.display = 'none';
    document.getElementById('research-panel').style.display = 'block';
    document.getElementById('research-prefix').focus();
  },

  hideResearchPanel() {
    document.querySelector('.toolbar').style.display = '';
    document.getElementById('table-wrap').style.display = '';
    document.querySelector('.pagination').style.display = '';
    document.getElementById('research-panel').style.display = 'none';
  },

  // ── TLD Lookup panel ──
  _lookupLastResultBase: '',

  showLookupPanel() {
    document.querySelector('.toolbar').style.display = 'none';
    document.getElementById('table-wrap').style.display = 'none';
    document.getElementById('loading-bar').style.display = 'none';
    document.querySelector('.pagination').style.display = 'none';
    document.getElementById('lookup-panel').style.display = 'block';
    document.getElementById('lookup-input').focus();
  },

  _lookupInput() {
    const current = this._normalizeLookupBaseName(document.getElementById('lookup-input').value);
    if (current === this._lookupLastResultBase) return;
    document.getElementById('lookup-results').style.display = 'none';
    document.getElementById('lookup-status').textContent = '';
  },

  _normalizeLookupBaseName(value) {
    let clean = String(value || '').trim().toLowerCase();
    clean = clean.replace(/^https?:\/\//, '').replace(/[/?#].*$/, '');
    clean = clean.replace(/^www\./, '');
    if (clean.includes('.')) clean = clean.slice(0, clean.indexOf('.'));
    return clean.replace(/[^a-z0-9-]/g, '');
  },

  async runLookup() {
    const raw = this._normalizeLookupBaseName(document.getElementById('lookup-input').value);
    if (!raw || raw.length < 2) return;

    const btn    = document.getElementById('lookup-btn');
    const status = document.getElementById('lookup-status');
    const results = document.getElementById('lookup-results');
    const summary = document.getElementById('lookup-summary');
    const pills   = document.getElementById('lookup-pills');

    btn.disabled = true;
    btn.textContent = '⟳ Checking…';
    status.textContent = '';
    results.style.display = 'none';

    try {
      status.textContent = 'Checking full IANA TLD universe…';
      const hResp = await fetch(`${API}/api/tlds-lookup-full?baseName=${encodeURIComponent(raw)}`);
      const hData = await hResp.json();
      if (!hResp.ok || hData.error) throw new Error(hData.error || 'Lookup failed');

      const takenTlds = [...new Set(hData.taken || [])].sort();
      const allUniverse = hData.all || hData.tldUniverse?.tlds || [];
      const zoneSet = new Set(hData.zone || []);
      const zoneTlds = takenTlds.filter(t => zoneSet.has(t));
      const liveTlds = takenTlds.filter(t => !zoneSet.has(t));
      const total = takenTlds.length;

      if (!total) {
        status.textContent = `"${raw}" not found in the ${hData.allCount || allUniverse.length || 'IANA'} TLD universe`;
        return;
      }

      const renderPill = (tld, isLive) =>
        `<a href="https://${raw}${tld}/" target="_blank" rel="noopener"
            style="display:inline-flex;align-items:center;gap:4px;padding:5px 10px;
                   border:1px solid ${isLive ? 'var(--accent)' : 'var(--border)'};
                   border-radius:3px;color:var(--accent);text-decoration:none;
                   font-family:var(--font-mono);font-size:12px;white-space:nowrap"
            title="${isLive ? 'Live DNS check' : 'Zone index'}"
            >${tld}</a>`;

      pills.innerHTML =
        zoneTlds.sort().map(t => renderPill(t, false)).join('') +
        liveTlds.sort().map(t => renderPill(t, true)).join('');

      const checkedAt = hData.checkedAt ? ` · checked ${new Date(hData.checkedAt).toLocaleString()}` : '';
      const timing = hData.durationMs ? ` · ${(hData.durationMs / 1000).toFixed(1)}s` : '';
      summary.textContent =
        `${raw} is registered in ${total} of ${(hData.allCount || allUniverse.length || 0).toLocaleString()} IANA TLD${(hData.allCount || allUniverse.length || 0) === 1 ? '' : 's'} ` +
        `(${zoneTlds.length} from zone index · ${liveTlds.length} from fresh DNS)${checkedAt}${timing}`;

      this._lookupLastResultBase = raw;
      status.textContent = '';
      results.style.display = 'block';
    } catch (err) {
      status.textContent = 'Error: ' + err.message;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Lookup →';
    }
  },

  showTrendingPanel() {
    document.querySelector('.toolbar').style.display = 'none';
    document.getElementById('table-wrap').style.display = 'none';
    document.getElementById('loading-bar').style.display = 'none';
    document.querySelector('.pagination').style.display = 'none';
    document.getElementById('trending-panel').style.display = 'block';
    this.loadTrending();
  },

  showTldGrowthPanel() {
    document.querySelector('.toolbar').style.display = 'none';
    document.getElementById('table-wrap').style.display = 'none';
    document.getElementById('loading-bar').style.display = 'none';
    document.querySelector('.pagination').style.display = 'none';
    document.getElementById('tldgrowth-panel').style.display = 'block';
    this.loadTldGrowth();
  },

  async loadTrending() {
    const status  = document.getElementById('trending-status');
    const noData  = document.getElementById('trending-no-data');
    const content = document.getElementById('trending-content');
    status.textContent = 'Loading…';
    noData.style.display = 'none';
    content.style.display = 'none';
    try {
      const data = await fetch('/api/trends?tldLimit=500').then(r => r.json());
      if (!data.hasData || !data.keywords.length) {
        status.textContent = '';
        noData.style.display = 'block';
        return;
      }
      const tbody = document.getElementById('trending-tbody');
      const maxCount = Math.max(1, ...data.keywords.map(kw => kw.tld_count || 0));
      const modeLabel = data.keywordMode === 'mixed'
        ? `daily trend + observed feeds`
        : data.keywordMode === 'coverage-baseline'
        ? 'coverage baseline'
        : 'daily trend';
      tbody.innerHTML = data.keywords.map((kw, i) => {
        const width = Math.max(3, Math.round(((kw.tld_count || 0) / maxCount) * 100));
        const keyword = this._escapeHtml(kw.keyword);
        const source = String(kw.source || '').includes('observed-feeds') ? 'observed' :
          String(kw.source || '').includes('coverage-baseline') ? 'baseline' : 'zone';
        const date = this._escapeHtml(kw.trend_date || '');
        return `
        <tr style="border-bottom:1px solid var(--border)">
          <td style="padding:6px 12px 6px 0;color:var(--muted);font-size:10px">${i + 1}</td>
          <td style="padding:6px 12px">
            <span style="cursor:pointer;color:var(--accent);font-weight:600"
              data-keyword="${keyword}"
              onclick="app.openTrendKeyword(this.dataset.keyword)"
            >${keyword}</span>
            <button onclick="event.stopPropagation();app.openResearchKeyword('${keyword}')"
              style="margin-left:8px;background:none;border:none;color:var(--blue);font-family:var(--font-mono);font-size:10px;cursor:pointer;padding:0">research</button>
            <div style="margin-top:5px;height:3px;background:rgba(255,255,255,.06);overflow:hidden">
              <div style="height:100%;width:${width}%;background:var(--accent)"></div>
            </div>
          </td>
          <td style="padding:6px 12px;text-align:right;color:var(--muted);font-size:10px">
            ${date}<br><span style="color:var(--muted)">${source}</span>
          </td>
          <td style="padding:6px 0 6px 12px;text-align:right;color:var(--accent);font-weight:700">${kw.tld_count}</td>
        </tr>
      `;
      }).join('');
      status.textContent = `${data.keywords.length} terms · ${modeLabel} · ${data.keywords[0]?.trend_date || ''}`;
      content.style.display = 'block';
    } catch (err) {
      status.textContent = 'Error: ' + err.message;
    }
  },

  async loadTldGrowth() {
    const status  = document.getElementById('tldgrowth-status');
    const noData  = document.getElementById('tldgrowth-no-data');
    const content = document.getElementById('tldgrowth-content');
    status.textContent = 'Loading…';
    noData.style.display = 'none';
    content.style.display = 'none';
    try {
      const data = await fetch('/api/tld-trends?limit=500').then(r => r.json());
      if (!data.hasData || !data.tlds.length) {
        status.textContent = '';
        noData.style.display = 'block';
        return;
      }
      const tbody = document.getElementById('tldgrowth-tbody');
      const maxTotal = Math.max(1, ...data.tlds.map(t => t.today_total || 0));
      tbody.innerHTML = data.tlds.map(t => {
        const width = Math.max(3, Math.round(((t.today_total || 0) / maxTotal) * 100));
        const tld = this._escapeHtml(t.tld);
        const metric = t.metric || (t.observed ? 'observed-activity' : t.baseline ? 'zone-baseline' : 'zone-growth');
        const source = metric === 'observed-activity' ? 'observed activity' : metric === 'zone-growth' ? 'zone growth' : 'zone baseline';
        let metricText = 'baseline';
        let metricColor = 'var(--muted)';
        let activityText = '—';
        let dropped = '—';
        if (metric === 'zone-growth') {
          const pct = Number(t.growth_pct || 0);
          const sign = pct > 0 ? '+' : '';
          metricText = `${sign}${pct}%`;
          metricColor = pct > 5 ? '#22c55e' : pct > 1 ? 'var(--accent)' : pct < -1 ? '#f87171' : 'var(--muted)';
          activityText = `+${(t.new_count || 0).toLocaleString()}`;
          dropped = `-${(t.dropped_count || 0).toLocaleString()}`;
        } else if (metric === 'observed-activity') {
          metricText = 'observed';
          metricColor = 'var(--blue)';
          activityText = `${(t.new_count || 0).toLocaleString()} / ${t.activityWindowDays || data.observedActivityDays || 10}d`;
          dropped = 'n/a';
        }
        return `
          <tr style="border-bottom:1px solid var(--border)">
            <td style="padding:6px 12px 6px 0;color:var(--text);font-weight:600">
              .${tld}<br><span style="color:var(--muted);font-size:9px;font-weight:400">${source} · ${this._escapeHtml(t.stat_date || '')}</span>
            </td>
            <td style="padding:6px 12px;text-align:right;font-weight:700;color:${metricColor}">${metricText}</td>
            <td style="padding:6px 12px;text-align:right;color:var(--muted)">${activityText}</td>
            <td style="padding:6px 12px;text-align:right;color:var(--muted)">${dropped}</td>
            <td style="padding:6px 0 6px 12px;text-align:right;color:var(--muted)">
              ${(t.today_total || 0).toLocaleString()}
              <div style="margin-top:5px;height:3px;background:rgba(255,255,255,.06);overflow:hidden">
                <div style="height:100%;width:${width}%;background:var(--accent)"></div>
              </div>
            </td>
          </tr>
        `;
      }).join('');
      const metrics = data.metrics || data.tldMetrics || {};
      status.textContent = `${data.tlds.length} TLDs · ${metrics.zoneGrowth || 0} real zone-growth · ${metrics.observedActivity || 0} observed activity · ${metrics.baseline || 0} baseline`;
      content.style.display = 'block';
    } catch (err) {
      status.textContent = 'Error: ' + err.message;
    }
  },

  _researchMode: 'prefix',

  setResearchMode(mode) {
    this._researchMode = mode;
    const pfxBtn = document.getElementById('research-mode-prefix');
    const conBtn = document.getElementById('research-mode-contains');
    const sfxBtn = document.getElementById('research-mode-suffix');
    pfxBtn.style.background = mode === 'prefix' ? 'var(--accent)' : 'transparent';
    pfxBtn.style.color      = mode === 'prefix' ? 'var(--bg)'     : 'var(--muted)';
    conBtn.style.background = mode === 'contains' ? 'var(--accent)' : 'transparent';
    conBtn.style.color      = mode === 'contains' ? 'var(--bg)'     : 'var(--muted)';
    sfxBtn.style.background = mode === 'suffix' ? 'var(--accent)' : 'transparent';
    sfxBtn.style.color      = mode === 'suffix' ? 'var(--bg)'     : 'var(--muted)';
  },

  async runResearch() {
    const rawInput = document.getElementById('research-prefix').value.trim().toLowerCase();
    const terms = [...new Set(rawInput
      .split(/[^a-z0-9-]+/)
      .map(t => t.trim())
      .filter(t => t.length >= 2 && t !== 'or' && t !== 'and'))];
    if (!terms.length) {
      this.showToast('Enter at least one term with 2+ characters');
      return;
    }
    const prefix = terms.slice(0, 6).join(',');
    const mode = this._researchMode || 'prefix';
    const btn = document.getElementById('research-btn');
    const status = document.getElementById('research-status');
    const results = document.getElementById('research-results');
    const help = document.getElementById('research-help');

    btn.disabled = true;
    btn.textContent = '⟳ Analyzing...';
    status.textContent = '';
    results.style.display = 'none';
    help.style.display = 'none';

    try {
      const saleLimit = this._researchPageSize * 3;
      const resultLimit = this._researchPageSize * 20;
      status.textContent = `Checking TLD coverage and .com/.ai prices for the first ${saleLimit} names…`;
      const resp = await fetch(`${API}/api/name-research?prefix=${encodeURIComponent(prefix)}&mode=${mode}&saleLimit=${saleLimit}&resultLimit=${resultLimit}`);
      const data = await resp.json();
      if (!resp.ok || data.error) throw new Error(data.error || 'Research failed');
      const names = data.names || [];

      if (!names.length) {
        const dir = mode === 'suffix' ? 'ending with' : 'starting with';
        status.textContent = `No base names found ${dir} "${terms.join(' / ')}" with TLD data`;
        help.style.display = 'block';
        return;
      }

      this._researchAllNames = names;
      this._researchBaseList = names;
      this._researchTerms = terms;
      this._landerResults = {};
      this._researchPage = 1;
      this._tldLists = {};
      this._hybridCounts = {};
      this._hybridCountGen++;
      // Reset filter controls
      const rfListing = document.getElementById('rf-listing-only');
      const rfPrice   = document.getElementById('rf-max-price');
      const rfMinTlds = document.getElementById('rf-min-tlds');
      if (rfListing) rfListing.checked = false;
      if (rfPrice)   rfPrice.value = '';
      if (rfMinTlds) rfMinTlds.value = '';
      const rfCount   = document.getElementById('rf-match-count');
      if (rfCount)    rfCount.textContent = '';
      const gen = this._hybridCountGen;

      // Pre-populate TLD lists so the sweep can use them immediately
      names.forEach(n => { if (n.tld_list) this._tldLists[n.base_name] = n.tld_list; });

      // Start with indexed counts so large research sets render immediately.
      this._researchAllNames.sort((a, b) => (b.tlds_taken ?? 0) - (a.tlds_taken ?? 0));

      let statusMsg = `${names.length} names · sorted by TLDs taken`;
      if (data.limited && data.available) statusMsg += ` · top ${names.length.toLocaleString()} of ${Number(data.available).toLocaleString()} loaded`;
      if (data.zoneAuthoritative) {
        statusMsg += ` · zone index: ${data.zoneIndexedTlds} TLDs / ${Number(data.zoneIndexedNames || 0).toLocaleString()} names`;
      } else {
        statusMsg += ' · zone index empty: not full universe yet';
      }
      if (data.tldUniverse?.count) statusMsg += ` · universe: ${data.tldUniverse.count} TLDs`;
      if (data.saleChecked) statusMsg += ` · prices checked: ${data.saleChecked}`;
      if (data.summaryNames) statusMsg += ` · summary: ${Number(data.summaryNames).toLocaleString()} names`;
      if (data.sedoConfigured && data.sedoCount > 0) statusMsg += ` · ${data.sedoCount} from Sedo`;
      status.textContent = statusMsg;

      this.renderResearchResults();
      results.style.display = 'block';
      this._prefetchResearchSalePages(4, 3, gen);
      document.getElementById('research-check-all-btn').style.display = '';
    } catch (err) {
      status.textContent = 'Error: ' + err.message;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Analyze →';
    }
  },

  async startCzdsSync() {
    const btn = document.getElementById('research-sync-btn');
    const status = document.getElementById('research-status');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Indexing...';
    }
    if (status) status.textContent = 'Starting CZDS zone index build...';
    try {
      const resp = await fetch(`${API}/api/czds-sync`, { method: 'POST' });
      const data = await resp.json();
      if (!resp.ok || data.error) throw new Error(data.error || 'Failed to start CZDS sync');
      if (status) status.textContent = data.message || 'CZDS sync started';
    } catch (err) {
      if (status) status.textContent = `Index build unavailable: ${err.message}`;
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Build Index';
      }
    }
  },

  renderResearchResults() {
    const all   = this._researchAllNames;
    const ps    = this._researchPageSize;
    const page  = this._researchPage;
    const total = all.length;
    const pages = Math.ceil(total / ps);
    const start = (page - 1) * ps;
    const slice = all.slice(start, start + ps);

    // Store tld lists keyed by base_name so onclick can look them up without
    // embedding JSON inside an HTML attribute (which breaks on quote conflicts).
    slice.forEach(n => { if (n.tld_list) this._tldLists[n.base_name] = n.tld_list; });

    const tbody = document.getElementById('research-tbody');
    tbody.innerHTML = slice.map((n, i) => {
      const absIdx = start + i;
      const comCell = this._researchTldCell(n.base_name, '.com', n.com, absIdx);
      const aiCell  = this._researchTldCell(n.base_name, '.ai',  n.ai,  absIdx);
      // Use cached hybrid count if available (from a prior page visit), else zone count
      const displayCount = this._hybridCounts[n.base_name] ?? n.tlds_taken;
      const tldsCell = n.tlds_taken != null
        ? `<button data-base="${n.base_name}" onclick="app.openTldModal('${n.base_name}',${displayCount},this)" id="research-tlds-${absIdx}" style="background:none;border:none;cursor:pointer;color:var(--accent);font-weight:600;font-family:var(--font-mono);font-size:12px;padding:0;text-decoration:underline dotted" title="Click to see all extensions">${displayCount}</button>`
        : `<button data-base="${n.base_name}" onclick="app.openTldModal('${n.base_name}',0,this)" id="research-tlds-${absIdx}" style="background:none;border:none;cursor:pointer;color:var(--muted);font-family:var(--font-mono);font-size:10px;padding:0;text-decoration:underline dotted" title="Check this name across TLDs">check</button>`;
      return `<tr id="research-row-${absIdx}" style="border-bottom:1px solid var(--border-light)">
        <td style="padding:7px 10px 7px 0">
          <a href="https://${n.base_name}.com/" target="_blank" rel="noopener" style="color:var(--accent);text-decoration:none;font-weight:600">${n.base_name}</a>
          <span style="color:var(--muted);font-size:10px;margin-left:6px">
            <a href="https://www.godaddy.com/domainsearch/find?checkAvail=1&domainToCheck=${n.base_name}" target="_blank" rel="noopener" style="color:var(--blue);text-decoration:none">gd↗</a>
          </span>
        </td>
        <td style="text-align:center;padding:7px 10px">${tldsCell}</td>
        <td id="research-com-${absIdx}" style="padding:7px 10px">${comCell}</td>
        <td id="research-ai-${absIdx}" style="padding:7px 10px">${aiCell}</td>
      </tr>`;
    }).join('');

    // Pagination controls
    let pager = document.getElementById('research-pager');
    if (!pager) {
      pager = document.createElement('div');
      pager.id = 'research-pager';
      pager.style.cssText = 'display:flex;align-items:center;gap:10px;margin-top:12px;font-family:var(--font-mono);font-size:11px;color:var(--muted)';
      document.getElementById('research-results').appendChild(pager);
    }
    pager.innerHTML = `
      <button class="page-btn" ${page <= 1 ? 'disabled' : ''} onclick="app.researchGoPage(${page - 1})">← Prev</button>
      <span>Page ${page} of ${pages} &nbsp;·&nbsp; ${total.toLocaleString()} names &nbsp;·&nbsp; showing ${start + 1}–${Math.min(start + ps, total)}</span>
      <button class="page-btn" ${page >= pages ? 'disabled' : ''} onclick="app.researchGoPage(${page + 1})">Next →</button>
    `;

    document.getElementById('research-status').textContent = `${total.toLocaleString()} names`;

    // Research renders immediately from the zone index/cache. Lander checks are
    // explicit via "Check page" because broad prefixes can return thousands of
    // names and should not start marketplace probes automatically.
    this._sweepHybridCounts(slice, this._hybridCountGen);
  },

  researchGoPage(page) {
    this._researchPage = page;
    this.renderResearchResults();
    document.getElementById('research-panel').scrollTop = 0;
  },

  // ── Auto DNS-check tlds_taken for research rows without data ──
  _researchTldQ: [],
  _researchTldActive: 0,

  _startResearchTldChecks(slice, start) {
    // Cancel any pending queue from previous page
    this._researchTldQ = [];

    for (let i = 0; i < slice.length; i++) {
      const n = slice[i];
      if (n.tlds_taken != null) continue; // already have data
      const absIdx = start + i;
      this._researchTldQ.push({ baseName: n.base_name, absIdx, nameObj: n });
    }
    this._drainResearchTldQ();
  },

  _drainResearchTldQ() {
    while (this._researchTldActive < 4 && this._researchTldQ.length > 0) {
      const item = this._researchTldQ.shift();
      this._researchTldActive++;
      this._fetchResearchTlds(item).finally(() => {
        this._researchTldActive--;
        this._drainResearchTldQ();
      });
    }
  },

  async _fetchResearchTlds({ baseName, absIdx, nameObj }) {
    const cell = document.getElementById(`research-tlds-${absIdx}`);
    try {
      const resp = await fetch(`${API}/api/tlds-check?baseName=${encodeURIComponent(baseName)}`);
      const data = await resp.json();
      if (data.error) throw new Error(data.error);
      // Update the in-memory name object so re-renders are correct
      nameObj.tlds_taken = data.count;
      if (cell && cell.isConnected) {
        cell.outerHTML = data.count > 0
          ? `<span style="color:${data.count > 10 ? 'var(--accent)' : 'var(--muted)'};font-weight:${data.count > 10 ? '600' : '400'}">${data.count}</span>`
          : `<span style="color:var(--muted)">0</span>`;
      }
    } catch (_) {
      if (cell && cell.isConnected) cell.textContent = '—';
    }
  },

  _researchTldCell(baseName, tld, info, rowIdx) {
    const domain = `${baseName}${tld}`;
    const idSuffix = tld === '.com' ? `com-${rowIdx}` : `ai-${rowIdx}`;

    // Cached lander result (from a previous or background check) — show immediately
    const cached = this._landerResults[domain];
    if (cached) return this._formatLanderResult(domain, cached);

    if (info) {
      // In our DB
      const isMarket = info.stream === 'marketplace' || info.stream === 'godaddy-premium';
      if (info.price) {
        const priceStr = `$${Number(info.price).toLocaleString()}`;
        const urlAttr = info.url ? ` href="${info.url}" target="_blank" rel="noopener"` : '';
        const live = info.live ? ' · live' : '';
        return `<a${urlAttr} id="research-${idSuffix}" style="color:var(--green);font-weight:600;text-decoration:none" title="${info.source || info.stream}${live}">${priceStr} 💰</a>`;
      } else if (info.forSale || isMarket) {
        const urlAttr = info.url ? ` href="${info.url}" target="_blank" rel="noopener"` : '';
        return `<a${urlAttr} id="research-${idSuffix}" style="color:var(--yellow);text-decoration:none" title="${info.source || 'Listing found'}">${domain} ↗</a>`;
      } else if (info.checked) {
        return `<span id="research-${idSuffix}" style="color:var(--muted);font-size:10px" title="Checked: no priced listing found">—</span>`;
      } else {
        return `<span id="research-${idSuffix}" style="color:var(--muted)" title="Registered (stream: ${info.stream})">${domain}</span>`;
      }
    }

    // Not yet checked — the explicit "Check page" action will populate this.
    return `<span id="research-btn-${idSuffix}" style="color:var(--muted);font-size:10px">…</span>`;
  },

  async _prefetchResearchSalePages(startPage, pageCount, gen) {
    const ps = this._researchPageSize;
    const start = Math.max(0, (startPage - 1) * ps);
    const names = this._researchAllNames.slice(start, start + (pageCount * ps));
    const baseNames = names
      .filter(n => !(n.com?.checked && n.ai?.checked) && !(n.com?.price != null && n.ai?.price != null))
      .map(n => n.base_name);
    if (!baseNames.length) return;
    try {
      const resp = await fetch(`${API}/api/research-sale-info`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseNames }),
      });
      if (!resp.ok || this._hybridCountGen !== gen) return;
      const data = await resp.json();
      const byBase = new Map((data.names || []).map(n => [n.base_name, n]));
      for (const list of [this._researchAllNames, this._researchBaseList]) {
        for (const n of list) {
          const update = byBase.get(n.base_name);
          if (!update) continue;
          if (update.com) n.com = update.com;
          if (update.ai) n.ai = update.ai;
        }
      }
    } catch (_) {}
  },

  // ── TLD popover: floating panel anchored to the clicked button ──
  _tldPopoverDismiss: null,
  _tldLists: {},
  _hybridCounts: {},   // baseName → accurate total count (zone + live DNS)
  _hybridCountGen: 0,  // incremented on each new search to cancel stale sweeps

  async openTldModal(baseName, tldCount, triggerEl) {
    const pop    = document.getElementById('tld-modal');
    const body   = document.getElementById('tld-modal-body');
    const nameEl = document.getElementById('tld-modal-name');
    const countEl = document.getElementById('tld-modal-count');
    const gdLink  = document.getElementById('tld-modal-godaddy');
    const ncLink  = document.getElementById('tld-modal-namecheap');

    nameEl.textContent  = baseName;
    countEl.textContent = `${tldCount} TLDs`;
    gdLink.href  = `https://www.godaddy.com/domainsearch/find?checkAvail=1&domainToCheck=${baseName}`;
    ncLink.href  = `https://www.namecheap.com/domains/registration/results/?domain=${baseName}`;

    // Position to the right of the trigger button
    pop.style.display = 'block';
    const rect = (triggerEl || pop).getBoundingClientRect();
    const ph   = Math.min(360, window.innerHeight - 40);
    pop.style.left    = `${rect.right + 8}px`;
    pop.style.top     = `${Math.max(8, Math.min(rect.top, window.innerHeight - ph - 8))}px`;
    pop.style.maxHeight = `${ph}px`;

    if (this._tldPopoverDismiss) {
      document.removeEventListener('click', this._tldPopoverDismiss);
      this._tldPopoverDismiss = null;
    }

    // Phase 1: zone index TLDs (pre-loaded in Research, fetch for Auctions)
    let zoneTlds = this._tldLists[baseName];
    if (!zoneTlds) {
      body.innerHTML = '<span style="color:var(--muted);font-size:11px">Loading…</span>';
      try {
        const resp = await fetch(`${API}/api/zone-tlds?baseName=${encodeURIComponent(baseName)}`);
        const data = await resp.json();
        zoneTlds = data.tlds || [];
        this._tldLists[baseName] = zoneTlds;
      } catch (_) {
        body.innerHTML = '<span style="color:var(--muted);font-size:11px">Failed to load</span>';
        return;
      }
    }
    const zoneCount = Math.max(Number(tldCount) || 0, zoneTlds.length);
    countEl.textContent = `${zoneCount} TLD${zoneCount === 1 ? '' : 's'}`;
    if (triggerEl && zoneCount > Number(triggerEl.textContent || 0)) triggerEl.textContent = zoneCount;

    const renderPills = (tlds) => tlds.map(tld =>
      `<a href="https://${baseName}${tld}/" target="_blank" rel="noopener"
         style="display:inline-block;margin:2px 3px;padding:3px 8px;border:1px solid var(--border);border-radius:3px;color:var(--accent);text-decoration:none;font-family:var(--font-mono);font-size:11px;white-space:nowrap"
         >${tld}</a>`
    ).join('');

    // Show zone TLDs + live-check placeholder
    body.innerHTML = (zoneTlds.length ? renderPills(zoneTlds) : '')
      + `<div id="tld-live-section" style="margin-top:6px;font-size:10px;color:var(--muted)">Checking major TLDs…</div>`;

    // Phase 2: live DNS check for gap TLDs not yet in zone index
    try {
      const r = await fetch(`${API}/api/tlds-check-hybrid?baseName=${encodeURIComponent(baseName)}`);
      const d = await r.json();
      const liveSection = document.getElementById('tld-live-section');
      if (!liveSection) return; // popover closed
      const dnsTlds = d.taken || d.live || [];
      const zoneSet = new Set(zoneTlds);
      const newTlds = dnsTlds.filter(t => !zoneSet.has(t));
      const mergedTlds = [...new Set([...zoneTlds, ...dnsTlds])].sort();
      const total = d.count ?? mergedTlds.length;
      countEl.textContent = `${total} TLD${total === 1 ? '' : 's'}`;
      this._hybridCounts[baseName] = total;
      this._tldLists[baseName] = mergedTlds;
      if (triggerEl) triggerEl.textContent = total;

      if (!newTlds.length) {
        liveSection.remove();
      } else {
        liveSection.outerHTML = renderPills(newTlds);
      }
    } catch (_) {
      const s = document.getElementById('tld-live-section');
      if (s) s.remove();
    }
  },

  closeTldModal() {
    document.getElementById('tld-modal').style.display = 'none';
    if (this._tldPopoverDismiss) {
      document.removeEventListener('click', this._tldPopoverDismiss);
      this._tldPopoverDismiss = null;
    }
  },

  // ── Background sweep: get accurate hybrid counts for all research rows ──
  // After all counts for the current page are fetched, update tlds_taken on
  // each name object, re-sort the full list by tlds_taken DESC, and re-render.
  async _sweepHybridCounts(slice, gen) {
    const exactTerms = new Set(this._researchTerms || []);
    const candidates = slice
      .filter(n => n.tlds_taken != null && this._hybridCounts[n.base_name] == null)
      .sort((a, b) => {
        const ax = exactTerms.has(a.base_name) ? 1 : 0;
        const bx = exactTerms.has(b.base_name) ? 1 : 0;
        if (ax !== bx) return bx - ax;
        return (a.tlds_taken ?? 9999) - (b.tlds_taken ?? 9999);
      })
      .slice(0, 40);
    const CONC = 1;
    let i = 0;
    const run = async () => {
      while (i < candidates.length) {
        if (this._hybridCountGen !== gen) return; // new search started, abort
        const n = candidates[i++];
        try {
          const r = await fetch(`${API}/api/tlds-check-hybrid?baseName=${encodeURIComponent(n.base_name)}`);
          if (!r.ok || this._hybridCountGen !== gen) continue;
          const d = await r.json();
          const zoneTlds = this._tldLists[n.base_name] || [];
          const zoneSet  = new Set(zoneTlds);
          const taken    = d.taken || d.live || [];
          const newTlds  = taken.filter(t => !zoneSet.has(t));
          const total    = d.count ?? (zoneTlds.length + newTlds.length);
          this._hybridCounts[n.base_name] = total;
          n.tlds_taken = total;
          if (taken.length) this._tldLists[n.base_name] = [...new Set([...zoneTlds, ...taken])].sort();
          // Update any visible count button for this name
          const btn = document.querySelector(`button[data-base="${n.base_name}"]`);
          if (btn) btn.textContent = total;
        } catch (_) {}
      }
    };
    await Promise.all(Array.from({ length: CONC }, run));

  },

  // ── Full upfront sweep: runs on ALL names before first render ──
  async _runFullHybridSweep(names, gen, statusEl) {
    const CONC = 6;
    let i = 0;
    let done = 0;
    const total = names.length;
    const run = async () => {
      while (i < total) {
        if (this._hybridCountGen !== gen) return;
        const n = names[i++];
        if (this._hybridCounts[n.base_name] != null) { done++; continue; }
        try {
          const r = await fetch(`${API}/api/tlds-check-hybrid?baseName=${encodeURIComponent(n.base_name)}`);
          if (!r.ok || this._hybridCountGen !== gen) { done++; continue; }
          const d = await r.json();
          const zoneTlds = this._tldLists[n.base_name] || [];
          const zoneSet  = new Set(zoneTlds);
          const newTlds  = (d.live || []).filter(t => !zoneSet.has(t));
          const hybrid   = zoneTlds.length + newTlds.length;
          this._hybridCounts[n.base_name] = hybrid;
          n.tlds_taken = hybrid;
        } catch (_) {}
        done++;
        if (statusEl && done % 5 === 0) {
          statusEl.textContent = `Checking TLDs… ${done}/${total}`;
        }
      }
    };
    await Promise.all(Array.from({ length: CONC }, run));
    if (this._hybridCountGen !== gen) return;
    names.sort((a, b) => (b.tlds_taken ?? 0) - (a.tlds_taken ?? 0));
    this._researchAllNames.sort((a, b) => (b.tlds_taken ?? 0) - (a.tlds_taken ?? 0));
    this._researchBaseList.sort((a, b) => (b.tlds_taken ?? 0) - (a.tlds_taken ?? 0));
    this.renderResearchResults();
    if (statusEl && this._hybridCountGen === gen) {
      statusEl.textContent = `${total.toLocaleString()} names · live TLD refinement complete`;
    }
  },

  async researchCheckLander(domain, idSuffix) {
    const cell = document.getElementById(`research-${idSuffix}`);
    if (!cell) return;
    try {
      const resp = await fetch(`${API}/api/lander-check?domain=${encodeURIComponent(domain)}`);
      const data = await resp.json();
      this._landerResults[domain] = data; // cache for filter
      cell.innerHTML = this._formatLanderResult(domain, data);
    } catch (err) {
      cell.innerHTML = `<span style="color:var(--muted);font-size:10px">—</span>`;
    }
  },

  _formatLanderResult(domain, data) {
    if (data.error && !data.forSale) {
      return `<span style="color:var(--muted);font-size:10px" title="${data.error}">—</span>`;
    }
    if (!data.forSale || !data.price) {
      return `<span style="color:var(--muted);font-size:10px">—</span>`;
    }
    const platformStr = data.platform ? ` · ${data.platform}` : '';
    const priceStr = `$${Number(data.price).toLocaleString()}`;
    const urlAttr = data.url ? ` href="${data.url}" target="_blank" rel="noopener"` : ` href="https://${domain}/" target="_blank" rel="noopener"`;
    return `<a${urlAttr} style="color:var(--green);font-weight:600;text-decoration:none" title="${data.source || ''}${platformStr}">${priceStr} 💰</a>`;
  },

  _landerCheckGen: 0, // incremented on each new page render to cancel stale workers

  async researchCheckAll(scope = 'page') {
    const allNames = this._researchBaseList.length ? this._researchBaseList : (this._researchAllNames || []);
    if (!allNames.length) return;
    const pageSize = this._researchPageSize;
    const pageStart = Math.max(0, (this._researchPage - 1) * pageSize);
    const fullSweep = scope === 'all';
    const base = fullSweep ? allNames : allNames.slice(pageStart, pageStart + pageSize);
    if (!base.length) return;

    const gen = ++this._landerCheckGen;

    // Build list of unchecked .com and .ai domains for the requested scope.
    const toCheck = [];
    const needsSaleCheck = (n, tld) => {
      const domain = `${n.base_name}${tld}`;
      if (this._landerResults[domain]) return false;
      const info = tld === '.com' ? n.com : n.ai;
      if (!info) return true;
      if (info.price != null) return false;
      return !info.checked;
    };
    base.forEach((n, i) => {
      const absIdx = fullSweep ? i : pageStart + i;
      if (needsSaleCheck(n, '.com'))
        toCheck.push({ domain: `${n.base_name}.com`, idSuffix: `com-${absIdx}` });
      if (needsSaleCheck(n, '.ai'))
        toCheck.push({ domain: `${n.base_name}.ai`,  idSuffix: `ai-${absIdx}` });
    });
    if (!toCheck.length) return;

    const status = document.getElementById('research-status');

    // ── Step 1: GoDaddy bulk availability check ──────────────────────────────
    // Instantly marks available (unregistered) domains — no lander check needed for those.
    const landerQueue = [...toCheck]; // default: lander-check everything
    try {
      const resp = await fetch(`${API}/api/bulk-availability`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(toCheck.map(d => d.domain)),
      });
      if (resp.ok && this._landerCheckGen === gen) {
        const data = await resp.json();
        const availMap = {};
        for (const d of (data.domains || [])) availMap[d.domain.toLowerCase()] = d;

        landerQueue.length = 0; // rebuild — only register registered domains
        for (const item of toCheck) {
          if (this._landerCheckGen !== gen) return;
          const avail = availMap[item.domain.toLowerCase()];
          if (avail?.available) {
            // Show registration price immediately — no lander needed
            const regPrice = avail.price ? Math.round(avail.price / 1000000) : null;
            this._landerResults[item.domain] = { available: true, checked: true, forSale: false, price: regPrice };
            const cell = document.getElementById(`research-${item.idSuffix}`);
            if (cell) {
              const priceUsd = regPrice ? `$${regPrice}/yr` : '';
              cell.innerHTML = `<span style="color:var(--accent);font-size:10px" title="Available for registration">${priceUsd || 'avail.'}</span>`;
            }
          } else {
            landerQueue.push(item); // registered — needs lander check
          }
        }
      }
    } catch (_) { /* GoDaddy API unavailable — fall back to full lander queue */ }

    if (!landerQueue.length || this._landerCheckGen !== gen) return;

    // ── Step 2: Lander check for registered domains ──────────────────────────
    let done = 0;
    const total = landerQueue.length;
    if (status && this._landerCheckGen === gen)
      status.textContent = `${fullSweep ? 'Checking all landers' : 'Checking page landers'}… 0/${total}`;

    const queue = [...landerQueue];
    const worker = async () => {
      while (queue.length > 0) {
        if (this._landerCheckGen !== gen) return;
        const item = queue.shift();
        await this.researchCheckLander(item.domain, item.idSuffix);
        done++;
        if (status && this._landerCheckGen === gen)
          status.textContent = `${fullSweep ? 'Checking all landers' : 'Checking page landers'}… ${done}/${total}`;
      }
    };

    await Promise.all([worker(), worker(), worker(), worker(), worker(), worker(), worker(), worker()]);
    if (this._landerCheckGen !== gen) return;
    if (status) status.textContent = `${base.length.toLocaleString()} ${fullSweep ? 'names' : 'visible names'} · lander check complete`;
    // Auto-apply filter now that all checks are in — culls non-matching names
    const rfActive = document.getElementById('rf-listing-only')?.checked
                  || document.getElementById('rf-max-price')?.value;
    if (rfActive) this.applyResearchFilter();
  },

  // ── Research filters ─────────────────────────────────────────────────────
  applyResearchFilter() {
    const listingOnly = document.getElementById('rf-listing-only')?.checked;
    const maxPriceRaw = document.getElementById('rf-max-price')?.value;
    const maxPrice    = maxPriceRaw ? parseInt(maxPriceRaw) : null;
    const minTldsRaw  = document.getElementById('rf-min-tlds')?.value;
    const minTlds     = minTldsRaw ? parseInt(minTldsRaw) : null;

    const base = this._researchBaseList.length ? this._researchBaseList : this._researchAllNames;

    if (!listingOnly && !maxPrice && !minTlds) {
      this._researchAllNames = base;
    } else {
      this._researchAllNames = base.filter(n => {
        if (minTlds && Number(n.tlds_taken || 0) < minTlds) return false;
        const com = this._getLanderData(n, '.com');
        const ai  = this._getLanderData(n, '.ai');

        if (!listingOnly && !maxPrice) return true;

        // "Checked" means we have a result (from lander check, GoDaddy API, or DB)
        const comChecked = com !== null;
        const aiChecked  = ai  !== null;

        // Neither TLD checked yet → pass through (still loading)
        if (!comChecked && !aiChecked) return true;

        const comForSale = !!com?.forSale;
        const aiForSale  = !!ai?.forSale;

        // Both checked but neither has a listing → cull
        if (!comForSale && !aiForSale) return false;

        // Price filter — cull if all known listings exceed the limit
        if (maxPrice) {
          const comOk = comForSale && com.price != null && com.price <= maxPrice;
          const aiOk  = aiForSale  && ai.price  != null && ai.price  <= maxPrice;
          if (!comOk && !aiOk) return false;
        }

        return true;
      });
    }

    this._researchPage = 1;
    const matchEl = document.getElementById('rf-match-count');
    if (matchEl) {
      matchEl.textContent = (listingOnly || maxPrice || minTlds)
        ? `${this._researchAllNames.length} of ${base.length}`
        : '';
    }
    this.renderResearchResults();
  },

  _getLanderData(n, tld) {
    const domain = n.base_name + tld;
    if (this._landerResults[domain]) return this._landerResults[domain];
    // Fall back to DB info baked into the name object
    const info = tld === '.com' ? n.com : n.ai;
    if (!info) return null;
    const price = info.price || null;
    return {
      forSale: !!(info.forSale || price || info.stream === 'marketplace' || info.stream === 'godaddy-premium'),
      price,
      checked: !!info.checked,
    };
  },

  // ── Toast ──
  showToast(msg) {
    const existing = document.querySelector('.toast');
    if (existing) existing.remove();
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 3500);
  },
};

// Boot
document.addEventListener('DOMContentLoaded', () => app.init());
