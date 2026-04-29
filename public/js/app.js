/* DomainScout — frontend app */

const API = '';

const state = {
  stream: 'all',
  tld: 'all',
  q: '',
  searchMode: 'contains',
  sortField: 'discovered_at',
  sortDir: 'DESC',
  page: 1,
  limit: 100,
  // filters
  minLength: '', maxLength: '',
  minAge: '', maxAge: '',
  maxPrice: '',
  noNumbers: false, noHyphens: false,
  hasWayback: false, dnsAvailable: false, hasBids: false,
  hideSkipped: false,
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

  // ── Init ──
  async init() {
    await Promise.all([this.loadStats(), this.loadDomains(), this.checkConfig()]);
    setInterval(() => this.loadStats(), 30000);
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
  setStream(stream) {
    // Handle research mode toggle
    if (stream === '_research') {
      state.stream = '_research';
      document.querySelectorAll('.stream-tab').forEach(el =>
        el.classList.toggle('active', el.dataset.stream === '_research'));
      this.showResearchPanel();
      return;
    }

    // Leaving research mode — restore main UI
    if (state.stream === '_research') {
      this.hideResearchPanel();
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

    const sortVal = document.getElementById('sort-select').value;
    const [sf, sd] = sortVal.split('|');
    state.sortField = sf;
    state.sortDir = sd;
    state.limit = parseInt(document.getElementById('limit-select').value);
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
    state.hideSkipped = false;
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
    document.getElementById('sort-select').value = 'discovered_at|DESC';

    document.querySelectorAll('.stream-tab').forEach(el => el.classList.toggle('active', el.dataset.stream === 'all'));
    document.querySelectorAll('.tld-pill').forEach(el => el.classList.toggle('active', el.dataset.tld === 'all'));
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
    params.set('sortField', state.sortField);
    params.set('sortDir', state.sortDir);
    params.set('page', state.page);
    params.set('limit', state.limit);

    // Skip server-side COUNT on page 2+ — total doesn't change while paginating.
    // Exception: auction_end ASC applies a "future only" filter that changes the real count,
    // so never use a cached total for that sort (it would show wrong pagination).
    const auctionEndSort = state.sortField === 'auction_end' && state.sortDir === 'ASC';
    if (!auctionEndSort && state.page > 1 && state.total != null) {
      params.set('knownTotal', state.total);
    } else if (!auctionEndSort) {
      // Page 1: use stream count cache when no filters active
      const noFilters = !state.q && !state.maxPrice && !state.minLength && !state.maxLength &&
        !state.minAge && !state.maxAge && !state.noNumbers && !state.noHyphens &&
        !state.hasWayback && !state.dnsAvailable && !state.hideSkipped && !state.hasBids &&
        state.tld === 'all';
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
        state.hasWayback || state.dnsAvailable;
      if (isFiltered) {
        emptyState.style.display = 'flex';
        document.getElementById('empty-msg').textContent = 'No domains match your current filters.';
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

    return `<tr class="${rowClass}" id="row-${d.id}">
      <td class="col-domain-cell">${domainLink}</td>
      <td class="col-stream-cell" style="${showStream ? '' : 'display:none'}">${streamBadge}</td>
      <td class="tld-text">${d.tld}</td>
      <td class="num">${d.length}</td>
      <td class="num" id="tld-cell-${d.id}"${(d.tlds_taken == null || d.tlds_taken === 0) ? ` data-needs-tld="1" data-base-name="${d.domain.slice(0, d.domain.lastIndexOf('.'))}" data-domain-id="${d.id}"` : ''}>${d.tlds_taken > 0 ? (d.tlds_taken > 3 ? `<span style="color:var(--accent);font-weight:600;cursor:pointer" onclick="app.openModal(${d.id})">${d.tlds_taken}</span>` : `<span class="dot-muted" style="cursor:pointer" onclick="app.openModal(${d.id})">${d.tlds_taken}</span>`) : `<span class="dot-muted">—</span>`}</td>
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
    const cells = document.querySelectorAll('[data-needs-tld]');
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
      const resp = await fetch(`${API}/api/tlds-check?baseName=${encodeURIComponent(baseName)}`);
      const data = await resp.json();
      if (data.error) throw new Error(data.error);
      const total = data.all ? data.all.length : this.tldTotal;
      this.tldTotal = total;
      if (state.domainMap[id]) {
        state.domainMap[id].tlds_taken = data.count;
        state.domainMap[id].tlds_checked_at = data.checkedAt;
      }
      if (cell && cell.isConnected) {
        cell.innerHTML = data.count > 3
          ? `<span style="color:var(--accent);font-weight:600;cursor:pointer" onclick="app.openModal(${id})">${data.count}</span>`
          : data.count > 0 ? `<span class="dot-muted" style="cursor:pointer" onclick="app.openModal(${id})">${data.count}</span>`
          : `<span class="dot-muted">0</span>`;
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
    const checkedAt = d.tlds_checked_at;
    const checkedAgo = checkedAt ? (() => {
      const mins = Math.floor((Date.now() - new Date(checkedAt)) / 60000);
      return mins < 60 ? `${mins}m ago` : `${Math.floor(mins/60)}h ago`;
    })() : null;
    document.getElementById('modal-tlds-meta').textContent = checkedAgo ? `checked ${checkedAgo}` : '';
    document.getElementById('modal-check-btn').disabled = false;
    document.getElementById('modal-check-btn').textContent = '↻ Re-check';

    // Always auto-run the check on open — show spinner immediately
    document.getElementById('modal-tlds-result').innerHTML =
      `<div class="tlds-checking"><span class="tlds-spinner"></span> Checking ~160 TLDs via DNS...</div>`;

    // Actions
    const saveBtn = document.getElementById('modal-save-btn');
    const skipBtn = document.getElementById('modal-skip-btn');
    saveBtn.className = 'modal-action-btn' + (d.saved ? ' active-save' : '');
    saveBtn.textContent = d.saved ? '★ Saved' : '★ Save';
    skipBtn.className = 'modal-action-btn modal-skip-btn' + (d.skipped ? ' active-skip' : '');
    skipBtn.textContent = d.skipped ? '✗ Skipped' : '✗ Skip';

    document.getElementById('domain-modal').style.display = 'flex';
    document.addEventListener('keydown', this._modalKeyHandler);

    // Auto-run TLD check
    this.checkTLDs();
  },

  closeModal() {
    document.getElementById('domain-modal').style.display = 'none';
    document.removeEventListener('keydown', this._modalKeyHandler);
    state.modalDomain = null;
  },

  _modalKeyHandler(e) {
    if (e.key === 'Escape') app.closeModal();
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
      const resp = await fetch(`${API}/api/tlds-check?baseName=${encodeURIComponent(baseName)}`);
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
  _researchPage: 1,
  _researchPageSize: 200,

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

  async runResearch() {
    const prefix = document.getElementById('research-prefix').value.trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
    if (!prefix || prefix.length < 2) {
      this.showToast('Enter at least 2 characters');
      return;
    }
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
      const resp = await fetch(`${API}/api/name-research?prefix=${encodeURIComponent(prefix)}&limit=4000`);
      const data = await resp.json();
      const names = data.names || [];

      if (!names.length) {
        status.textContent = `No base names found starting with "${prefix}" with TLD data`;
        help.style.display = 'block';
        return;
      }

      this._researchAllNames = names;
      this._researchPage = 1;
      status.textContent = `${names.length} base names found`;
      this.renderResearchResults();
      results.style.display = 'block';
      document.getElementById('research-check-all-btn').style.display = '';
    } catch (err) {
      status.textContent = 'Error: ' + err.message;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Analyze →';
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

    const tbody = document.getElementById('research-tbody');
    tbody.innerHTML = slice.map((n, i) => {
      const absIdx = start + i;
      const comCell = this._researchTldCell(n.base_name, '.com', n.com, absIdx);
      const aiCell  = this._researchTldCell(n.base_name, '.ai',  n.ai,  absIdx);
      return `<tr id="research-row-${absIdx}" style="border-bottom:1px solid var(--border-light)">
        <td style="padding:7px 10px 7px 0">
          <a href="https://${n.base_name}.com/" target="_blank" rel="noopener" style="color:var(--accent);text-decoration:none;font-weight:600">${n.base_name}</a>
          <span style="color:var(--muted);font-size:10px;margin-left:6px">
            <a href="https://www.godaddy.com/domainsearch/find?checkAvail=1&domainToCheck=${n.base_name}" target="_blank" rel="noopener" style="color:var(--blue);text-decoration:none">gd↗</a>
          </span>
        </td>
        <td style="text-align:center;padding:7px 10px">
          <span style="color:var(--accent);font-weight:600">${n.tlds_taken}</span>
        </td>
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

    document.getElementById('research-status').textContent = `${total.toLocaleString()} names — click "Check Lander" or "Check All Landers" for this page`;
  },

  researchGoPage(page) {
    this._researchPage = page;
    this.renderResearchResults();
    document.getElementById('research-panel').scrollTop = 0;
  },

  _researchTldCell(baseName, tld, info, rowIdx) {
    const domain = `${baseName}${tld}`;
    const idSuffix = tld === '.com' ? `com-${rowIdx}` : `ai-${rowIdx}`;

    if (info) {
      // In our DB
      const isMarket = info.stream === 'marketplace' || info.stream === 'godaddy-premium';
      if (info.price) {
        const priceStr = `$${Number(info.price).toLocaleString()}`;
        const urlAttr = info.url ? ` href="${info.url}" target="_blank" rel="noopener"` : '';
        return `<a${urlAttr} style="color:var(--green);font-weight:600;text-decoration:none" title="${info.source || info.stream}">${priceStr} 💰</a>`;
      } else if (isMarket) {
        const urlAttr = info.url ? ` href="${info.url}" target="_blank" rel="noopener"` : '';
        return `<a${urlAttr} style="color:var(--yellow);text-decoration:none" title="In marketplace DB">${domain} ↗</a>`;
      } else {
        return `<span style="color:var(--muted)" title="Registered (stream: ${info.stream})">${domain}</span>`;
      }
    }

    // Not in DB — show check button
    return `<button class="research-check-btn" id="research-btn-${idSuffix}" onclick="app.researchCheckLander('${domain}','${idSuffix}')">Check Lander</button>`;
  },

  async researchCheckLander(domain, idSuffix) {
    const cell = document.getElementById(`research-${idSuffix}`);
    const btn = document.getElementById(`research-btn-${idSuffix}`);
    if (!cell || !btn) return;

    btn.disabled = true;
    btn.textContent = '…';

    try {
      const resp = await fetch(`${API}/api/lander-check?domain=${encodeURIComponent(domain)}`);
      const data = await resp.json();
      cell.innerHTML = this._formatLanderResult(domain, data);
    } catch (err) {
      cell.innerHTML = `<span style="color:var(--muted);font-size:10px">err</span>`;
    }
  },

  _formatLanderResult(domain, data) {
    if (data.error && !data.forSale) {
      return `<span style="color:var(--muted);font-size:10px" title="${data.error}">—</span>`;
    }
    if (!data.forSale) {
      return `<span style="color:var(--muted);font-size:10px">not for sale</span>`;
    }
    const platformStr = data.platform ? ` · ${data.platform}` : '';
    if (data.price) {
      const priceStr = `$${Number(data.price).toLocaleString()}`;
      const urlAttr = data.url ? ` href="${data.url}" target="_blank" rel="noopener"` : ` href="https://${domain}/" target="_blank" rel="noopener"`;
      return `<a${urlAttr} style="color:var(--green);font-weight:600;text-decoration:none" title="${data.source}${platformStr}">${priceStr} 💰</a>`;
    }
    const href = data.url || `https://${domain}/`;
    return `<a href="${href}" target="_blank" rel="noopener" style="color:var(--yellow);text-decoration:none" title="${data.source}${platformStr}">For Sale${platformStr} ↗</a>`;
  },

  async researchCheckAll() {
    const all  = this._researchAllNames || [];
    if (!all.length) return;

    const ps    = this._researchPageSize;
    const page  = this._researchPage;
    const start = (page - 1) * ps;
    const slice = all.slice(start, start + ps);

    const allBtn = document.getElementById('research-check-all-btn');
    allBtn.disabled = true;
    allBtn.textContent = '⟳ Checking...';

    // Build queue of unchecked cells on the current page only
    const queue = [];
    slice.forEach((n, i) => {
      const absIdx = start + i;
      if (!n.com) queue.push({ domain: `${n.base_name}.com`, idSuffix: `com-${absIdx}` });
      if (!n.ai)  queue.push({ domain: `${n.base_name}.ai`,  idSuffix: `ai-${absIdx}` });
    });

    const status = document.getElementById('research-status');
    let done = 0;
    const total = queue.length;

    const worker = async () => {
      while (queue.length > 0) {
        const item = queue.shift();
        await this.researchCheckLander(item.domain, item.idSuffix);
        done++;
        status.textContent = `Checking landers… ${done}/${total}`;
        await new Promise(r => setTimeout(r, 200));
      }
    };

    await Promise.all([worker(), worker(), worker(), worker()]);
    status.textContent = `Done — checked ${total} domains on page ${page}`;
    allBtn.disabled = false;
    allBtn.textContent = 'Check All Landers';
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
