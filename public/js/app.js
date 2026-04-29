/* DomainScout — frontend app */

const API = '';

const state = {
  stream: 'all',
  tld: 'all',
  q: '',
  sortField: 'discovered_at',
  sortDir: 'DESC',
  page: 1,
  limit: 100,
  // filters
  minLength: '', maxLength: '',
  minAge: '', maxAge: '',
  noNumbers: false, noHyphens: false,
  hasWayback: false, dnsAvailable: false,
  hideSkipped: false,
  total: 0,
  streamCounts: {}, // cached from stats — used to skip COUNT(*) on stream switches
};

let searchTimeout = null;

const app = {
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
    state.stream = stream;
    state.page = 1;
    document.querySelectorAll('.stream-tab').forEach(el => {
      el.classList.toggle('active', el.dataset.stream === stream);
    });
    // Expiring group tab stays highlighted when a sub-stream is active
    const expiringTab = document.getElementById('expiring-tab');
    if (expiringTab) expiringTab.classList.toggle('active', stream.startsWith('_expiring'));
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
    state.noNumbers = document.getElementById('noNumbers').checked;
    state.noHyphens = document.getElementById('noHyphens').checked;
    state.hasWayback = document.getElementById('hasWayback').checked;
    state.dnsAvailable = document.getElementById('dnsAvailable').checked;
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
    state.minLength = ''; state.maxLength = '';
    state.minAge = ''; state.maxAge = '';
    state.noNumbers = false; state.noHyphens = false;
    state.hasWayback = false; state.dnsAvailable = false;
    state.hideSkipped = false;
    state.page = 1;

    document.getElementById('search-input').value = '';
    document.getElementById('minLength').value = '';
    document.getElementById('maxLength').value = '';
    document.getElementById('minAge').value = '';
    document.getElementById('maxAge').value = '';
    document.getElementById('noNumbers').checked = false;
    document.getElementById('noHyphens').checked = false;
    document.getElementById('hasWayback').checked = false;
    document.getElementById('dnsAvailable').checked = false;
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
      state.sortDir = 'DESC';
    }
    state.page = 1;
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
      tlds_taken: 4, age_years: 5, wayback_snapshots: 6, auction_price: 8,
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
    if (state.q) params.set('q', state.q);
    if (state.minLength) params.set('minLength', state.minLength);
    if (state.maxLength) params.set('maxLength', state.maxLength);
    if (state.minAge) params.set('minAge', state.minAge);
    if (state.maxAge) params.set('maxAge', state.maxAge);
    if (state.noNumbers) params.set('noNumbers', '1');
    if (state.noHyphens) params.set('noHyphens', '1');
    if (state.hasWayback) params.set('hasWayback', '1');
    if (state.dnsAvailable) params.set('dnsAvailable', '1');
    if (state.hideSkipped) params.set('skipped', '0');
    params.set('sortField', state.sortField);
    params.set('sortDir', state.sortDir);
    params.set('page', state.page);
    params.set('limit', state.limit);

    // Pass cached count to skip server-side COUNT(*) when no filters are active
    const noFilters = !state.q && !state.minLength && !state.maxLength &&
      !state.minAge && !state.maxAge && !state.noNumbers && !state.noHyphens &&
      !state.hasWayback && !state.dnsAvailable && !state.hideSkipped &&
      state.tld === 'all';
    if (noFilters) {
      const cached = state.streamCounts[state.stream];
      if (cached != null) params.set('knownTotal', cached);
    }

    try {
      const resp = await fetch(`${API}/api/domains?${params}`);
      if (resp.status === 401) { window.location.href = '/login'; return; }
      const data = await resp.json();
      state.total = data.total;
      tbody.style.opacity = '';
      this.renderTable(data.domains);
      this.updatePagination(data.total, data.page, data.limit);
      document.getElementById('result-count').textContent =
        `${data.total.toLocaleString()} domains`;
    } catch (err) {
      console.error('Failed to load domains:', err);
      document.getElementById('result-count').textContent = 'Error loading';
      tbody.style.opacity = '';
    } finally {
      bar.style.display = 'none';
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

    tbody.innerHTML = domains.map(d => this.renderRow(d)).join('');

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
      'namecheap-auction': `<span class="badge badge-auction">Namecheap</span>`,
      'marketplace':       `<span class="badge badge-market">Market</span>`,
      'discovered':        `<span class="badge badge-discovered">Tracked</span>`,
    }[d.stream] || `<span class="badge">${d.stream}</span>`;

    // Hide stream column when already filtered to a specific stream
    const showStream = state.stream === 'all' || state.stream.startsWith('_');

    const dns = d.dns_available === 1
      ? `<span class="dot-green" title="Available">✓</span>`
      : d.dns_available === 0
      ? `<span class="dot-red" title="Taken">✗</span>`
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

    const domainLink = d.auction_url
      ? `<a class="domain-name" href="${d.auction_url}" target="_blank" rel="noopener">${d.domain}</a>`
      : `<span class="domain-name">${d.domain}</span>`;

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
      <td class="num">${d.tlds_taken > 1 ? `<span style="color:var(--accent);font-weight:600">${d.tlds_taken}</span>` : (d.tlds_taken === 1 ? `<span class="dot-muted">1</span>` : `<span class="dot-muted">—</span>`)}</td>
      <td>${age}</td>
      <td>${wb}</td>
      <td style="text-align:center">${dns}</td>
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
