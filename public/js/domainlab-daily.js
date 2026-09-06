// DomainLab Daily — the ZoneReports-style daily token report view.
// Loads after domainlab.js (the analytics view) and takes over the panel's
// default presentation: date → zone → ranked tokens → domains. The analytics
// view stays reachable behind the small "Analytics" link.
(function () {
  'use strict';
  function el(id) { return document.getElementById(id); }
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function fmt(n) { return Number(n || 0).toLocaleString(); }

  const state = {
    dates: [], zones: [], date: null, zone: 'com',
    words: new Set(), q: '', perPage: 50, page: 0,
    tokens: [], totalTokens: 0, view: 'tokens', token: null,
    fallback: false, includeAllZones: false, mode: 'fragments', offset: 0, report: null, requestId: 0,
  };

  // ---- data ----
  async function fetchDaily() {
    const p = new URLSearchParams();
    if (state.date) p.set('date', state.date);
    if (state.zone) p.set('zone', state.zone);
    if (state.words.size) p.set('words', [...state.words].join(','));
    if (state.q) p.set('q', state.q);
    if (state.includeAllZones) p.set('includeAllZones', '1');
    p.set('limit', '100');
    p.set('offset', String(state.offset));
    p.set('mode', state.mode);
    const r = await fetch(`/api/domainlab/daily?${p}`);
    if (!r.ok) throw new Error('Daily data request failed (' + r.status + ')');
    return r.json();
  }
  async function fetchDomains() {
    const p = new URLSearchParams({
      date: state.date || '', zone: state.zone || '', token: state.token || '', mode: state.mode,
      limit: String(state.perPage), offset: String(state.page * state.perPage),
    });
    const r = await fetch(`/api/domainlab/daily/domains?${p}`);
    if (!r.ok) throw new Error('Daily data request failed (' + r.status + ')');
    return r.json();
  }
  async function fetchFallbackTokens() {
    const p = new URLSearchParams({ window: '7', baseline: '28', mode: 'terms', limit: '200' });
    if (state.q) p.set('q', state.q);
    const r = await fetch(`/api/domainlab/trending?${p}`);
    const d = await r.json();
    return (d.rows || []).map(row => ({ token: row.term, count: row.spread, wordCount: 1 }));
  }
  // ---- render ----
  function render() {
    const panel = el('domainlab-panel');
    if (!panel) return;
    if (state.view === 'domains') return renderDomains();
    renderTokens();
  }
  function controlBar() {
    const dates = state.dates.length
      ? [...new Set([state.date, ...state.dates].filter(Boolean))].map(d => `<option value="${esc(d)}"${d === state.date ? ' selected' : ''}>${esc(d)}</option>`).join('')
      : '<option value="">no daily data yet</option>';
    const zoneSet = state.zones.length ? state.zones : ['com', 'app', 'dev', 'bot', 'net', 'org'];
    const lead = ['com', 'app', 'dev', 'bot', 'net', 'org'];
    const ordered = [...lead.filter(z => zoneSet.includes(z)), ...zoneSet.filter(z => !lead.includes(z)).sort()];
    const zones = ordered.map(z => `<option value="${esc(z)}"${z === state.zone ? ' selected' : ''}>${esc(z.toUpperCase())}</option>`).join('');
    const wc = [1, 2, 3].map(n => `<label class="dl-wc"><input type="checkbox" data-wc="${n}"${state.words.has(String(n)) ? ' checked' : ''} onchange="app.dlDailyWordFilter(this)"> ${n} word${n > 1 ? 's' : ''}</label>`).join('');
    return `
      <div class="dl-bar">
        <select id="dl-date" onchange="app.dlDailySetDate(this.value)">${dates}</select>
        <select id="dl-zone" onchange="app.dlDailySetZone(this.value)">${zones}</select>
        <label class="dl-wc"><input type="checkbox"${state.includeAllZones ? ' checked' : ''} onchange="app.dlDailyToggleAllZones(this.checked)"> All zones</label>
        <select aria-label="Analysis mode" onchange="app.dlDailyMode(this.value)">
          <option value="fragments"${state.mode === 'fragments' ? ' selected' : ''}>Emerging patterns</option>
          <option value="words"${state.mode === 'words' ? ' selected' : ''}>Dictionary tokens</option>
        </select>
        <button class="dl-btn" onclick="app.dlDailyCopyTokens()">⧉ Copy page</button>
        <span class="dl-pop-wrap" style="${state.mode === 'fragments' ? 'display:none' : ''}">
          <button class="dl-btn" title="Filter by number of tokens" onclick="app.dlDailyTogglePopover()">☰</button>
          <span id="dl-wc-pop" class="dl-pop" style="display:none">
            <span class="dl-pop-title">TOKENS</span>${wc}
            <button class="dl-btn dl-btn-small" onclick="app.dlDailyClearWords()">Clear</button>
            <span class="dl-pop-note">None checked = show all.</span>
          </span>
        </span>
        <a class="zi-link dl-analytics-link" onclick="app.dlShowAnalytics()">Analytics</a>
      </div>
      <input id="dl-search" class="dl-search" type="search" placeholder="Search tokens..." value="${esc(state.q)}"
             oninput="app.dlDailySearch(this.value)">`;
  }
  function renderTokens() {
    const panel = el('domainlab-panel');
    const rows = state.tokens.map((t, n) => `
      <div class="dl-row" onclick="app.dlDailyOpenToken('${esc(t.token)}')">
        <span class="dl-rank">${state.offset + n + 1}</span>
        <span class="dl-token">${esc(t.token)}${state.mode === 'fragments' ? `<small style="display:block;font-size:12px;font-weight:400">${esc(t.strength)} · ${fmt(t.contexts)} contexts${t.lift !== null ? ` · ${Number(t.lift).toFixed(1)}× conservative baseline` : ''}</small>` : ''}</span>
        <span class="dl-count">${fmt(t.count)}</span>
      </div>`).join('');
    panel.innerHTML = `
      ${controlBar()}
      <div class="dl-note">${esc(state.date)} (UTC feed day) · ${fmt(state.report?.coverage?.names)} observed domains · ${esc(state.report?.coverage?.status || 'missing')}<br>${esc(state.report?.coverage?.note || 'No verified feed for this date.')}${state.report?.baseline ? `<br>Baseline: ${state.report.baseline.dates.length}/7 prior days. Counts are distinct names in the feed; registration patterns do not establish buyer demand.` : ''}</div>
      <div class="dl-count-line">${fmt(state.offset + (state.tokens.length ? 1 : 0))}–${fmt(state.offset + state.tokens.length)} of ${fmt(state.totalTokens)} ${state.mode === 'fragments' ? 'patterns' : 'tokens'}</div>
      <div class="dl-list">${rows || '<div class="dl-note">No observations match this date and filter. The selected date has not been changed.</div>'}</div><div class="dl-bar"><button class="dl-btn" ${state.offset ? '' : 'disabled'} onclick="app.dlDailyTokenPage(-1)">Previous</button><button class="dl-btn" ${state.offset + state.tokens.length < state.totalTokens ? '' : 'disabled'} onclick="app.dlDailyTokenPage(1)">Next</button></div>`;
  }
  async function renderDomains() {
    const panel = el('domainlab-panel');
    const per0 = [25, 50, 100].map(n => `<option value="${n}"${n === state.perPage ? ' selected' : ''}>${n}</option>`).join('');
    panel.innerHTML = `
      ${controlBar()}
      <div class="dl-crumb">
        <a class="zi-link" onclick="app.dlDailyBack()">&lt; Tokens</a>
        <strong>${esc(state.token)}</strong>
        <span class="dl-muted">loading…</span>
        <span class="dl-crumb-right">Per page <select onchange="app.dlDailyPerPage(this.value)">${per0}</select></span>
      </div>
      <div class="dl-list" id="dl-domains"><div class="dl-note">Loading domains…</div></div>`;
    const renderToken = state.token;
    const requestId = ++state.requestId;
    let names = [], total = 0;
    if (!state.fallback) {
      try {
        const d = await fetchDomains();
        names = d.names || d.domains || [];
        total = d.total != null ? d.total : names.length;
      } catch (error) {
        if (requestId === state.requestId) panel.innerHTML = `${controlBar()}<div class="dl-note" role="alert">${esc(error.message)}. <button class="dl-btn" onclick="app.dlDailyBack()">Back to patterns</button></div>`;
        return;
      }
    } else {
      try {
        const r = await fetch(`/api/domainlab/term/${encodeURIComponent(state.token)}`);
        const d = await r.json();
        names = (d.exampleLiveDomains || d.exampleDomains || d.examples || []).slice(0, state.perPage);
        total = names.length;
      } catch { names = []; }
    }
    if (requestId !== state.requestId || state.view !== 'domains' || state.token !== renderToken) return;
    const per = [25, 50, 100].map(n => `<option value="${n}"${n === state.perPage ? ' selected' : ''}>${n}</option>`).join('');
    panel.innerHTML = `
      ${controlBar()}
      <div class="dl-crumb">
        <a class="zi-link" onclick="app.dlDailyBack()">&lt; Tokens</a>
        <strong>${esc(state.token)}</strong>
        <span class="dl-muted">${fmt(total)} domains</span>
        <span class="dl-crumb-right">
          Per page <select onchange="app.dlDailyPerPage(this.value)">${per}</select>
          <button class="dl-btn" onclick="app.dlDailyCopyDomains()">⧉ Copy page</button>
        </span>
      </div>
      <div class="dl-list" id="dl-domains">${names.map(n => `<div class="dl-row dl-domain-row">${esc(typeof n === 'string' ? n : n.domain || n.name)}</div>`).join('') || '<div class="dl-note">No domains recorded for this token on this day.</div>'}</div>
      <div class="dl-count-line">Showing ${fmt(state.page * state.perPage + (names.length ? 1 : 0))}–${fmt(state.page * state.perPage + names.length)} of ${fmt(total)}</div><div class="dl-bar"><button class="dl-btn" ${state.page ? '' : 'disabled'} onclick="app.dlDailyDomainPage(-1)">Previous</button><button class="dl-btn" ${(state.page + 1) * state.perPage < total ? '' : 'disabled'} onclick="app.dlDailyDomainPage(1)">Next</button></div>`;
  }

  // ---- actions ----
  /* the app object is a top-level lexical binding (let app), not window.app —
     resolve the same binding the panel's inline handlers see */
  const appObj = (function () { try { return app; } catch { return (window.app = window.app || {}); } })();
  appObj.dlDailyMode = v => { state.mode = v; state.offset = 0; state.view = 'tokens'; load(); };
  appObj.dlDailyTokenPage = n => { state.offset = Math.max(0, state.offset + n * 100); load(); };
  appObj.dlDailyDomainPage = n => { state.page = Math.max(0, state.page + n); render(); };
  appObj.dlDailySetDate = v => { state.date = v || null; state.view = 'tokens'; state.offset = 0; load(); };
  appObj.dlDailySetZone = v => { state.zone = v; state.view = 'tokens'; state.offset = 0; load(); };
  appObj.dlDailyToggleAllZones = checked => { state.includeAllZones = !!checked; state.view = 'tokens'; state.offset = 0; load(); };
  appObj.dlDailySearch = (v) => { state.q = v.trim(); state.offset = 0; state.requestId++; state.view = 'tokens'; clearTimeout(state._t); state._t = setTimeout(load, 250); };
  appObj.dlDailyPerPage = v => { state.perPage = Number(v) || 50; state.page = 0; render(); };
  appObj.dlDailyWordFilter = (box) => {
    const n = box.dataset.wc;
    if (box.checked) state.words.add(n); else state.words.delete(n);
    load();
  };
  appObj.dlDailyClearWords = () => { state.words.clear(); load(); };
  appObj.dlDailyTogglePopover = () => {
    const p = el('dl-wc-pop');
    if (p) p.style.display = p.style.display === 'none' ? 'inline-flex' : 'none';
  };
  appObj.dlDailyOpenToken = (token) => { state.token = token; state.view = 'domains'; state.page = 0; render(); };
  appObj.dlDailyBack = () => { state.requestId++; state.view = 'tokens'; state.token = null; render(); };
  appObj.dlDailyCopyTokens = () => {
    navigator.clipboard.writeText(state.tokens.map(t => t.token).join('\n')).catch(() => {});
  };
  appObj.dlDailyCopyDomains = () => {
    const rows = [...document.querySelectorAll('#dl-domains .dl-domain-row')].map(r => r.textContent);
    navigator.clipboard.writeText(rows.join('\n')).catch(() => {});
  };
  appObj.dlShowAnalytics = () => {
    state.requestId++; state.view = 'analytics';
    const panel = el('domainlab-panel');
    if (state._originalPanel != null) panel.innerHTML = state._originalPanel;
    const back = document.createElement('div');
    back.innerHTML = '<a class="zi-link" onclick="app.domainlabLoadAll()">&lt; Daily view</a>';
    panel.prepend(back);
    // Restoring the analytics shell via innerHTML creates a fresh Refresh button.
    // Its original inline handler points at domainlabLoadAll, which Daily replaces
    // with its own loader. Bind this restored button to the preserved analytics
    // loader so changing window/baseline refreshes Analytics instead of bouncing
    // back to Daily.
    const refresh = el('dl-refresh');
    if (refresh) refresh.onclick = (event) => {
      event.preventDefault();
      if (typeof appObj.domainlabRenderAnalyticsShell === 'function') {
        appObj.domainlabRenderAnalyticsShell();
      }
    };
    if (typeof appObj.domainlabRenderAnalyticsShell === 'function') appObj.domainlabRenderAnalyticsShell();
  };

  async function load() {
    clearTimeout(state._t);
    const requestId = ++state.requestId;
    const panel = el('domainlab-panel');
    if (panel && state._originalPanel == null) state._originalPanel = panel.innerHTML;
    if (panel) panel.innerHTML = `${controlBar()}<div class="dl-note">Loading daily evidence…</div>`;
    try {
      const d = await fetchDaily();
      if (requestId !== state.requestId) return;
      if (d.ok === false) throw new Error(d.error || 'Daily data unavailable');
      state.report = d;
      state.date = d.date || state.date;
      state.dates = d.dates || [];
      state.zones = (d.zones || []).map(z => String(typeof z === 'string' ? z : z.zone || z.tld || '').replace(/^\./, '')).filter(Boolean);
      if (state.zone && !state.zones.includes(state.zone)) state.zones.unshift(state.zone);
      state.tokens = d.tokens || [];
      state.totalTokens = d.totalTokens ?? state.tokens.length;
      state.fallback = false;
      if (state.view === 'tokens') render();
    } catch (error) {
      if (requestId !== state.requestId) return;
      if (panel) panel.innerHTML = `${controlBar()}<div class="dl-note" role="alert">${esc(error.message)}. <button class="dl-btn" onclick="app.domainlabLoadAll()">Retry</button></div>`;
    }
  }

  // Take over the panel default: wrap the analytics loader so the Daily view
  // renders first; analytics renders only via the explicit link.
  const analyticsLoad = appObj.domainlabLoadAll ? appObj.domainlabLoadAll.bind(appObj) : null;
  appObj.domainlabRenderAnalyticsShell = analyticsLoad;
  appObj.domainlabLoadAll = function dailyFirst() { state.view = 'tokens'; load(); };
})();
