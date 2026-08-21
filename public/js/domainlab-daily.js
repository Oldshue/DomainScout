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
    fallback: false, includeAllZones: false,
  };

  // ---- data ----
  async function fetchDaily() {
    const p = new URLSearchParams();
    if (state.date) p.set('date', state.date);
    if (state.zone) p.set('zone', state.zone);
    if (state.words.size) p.set('words', [...state.words].join(','));
    if (state.q) p.set('q', state.q);
    if (state.includeAllZones) p.set('includeAllZones', '1');
    p.set('limit', '1000');
    const r = await fetch(`/api/domainlab/daily?${p}`);
    return r.json();
  }
  async function fetchDomains() {
    const p = new URLSearchParams({
      date: state.date || '', zone: state.zone || '', token: state.token || '',
      limit: String(state.perPage), offset: String(state.page * state.perPage),
    });
    const r = await fetch(`/api/domainlab/daily/domains?${p}`);
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
      ? state.dates.map(d => `<option value="${esc(d)}"${d === state.date ? ' selected' : ''}>${esc(d)}</option>`).join('')
      : '<option value="">no daily data yet</option>';
    const zoneSet = state.zones.length ? state.zones : ['com', 'app', 'dev', 'net', 'org'];
    const lead = ['com', 'app', 'dev', 'net', 'org'];
    const ordered = [...lead.filter(z => zoneSet.includes(z)), ...zoneSet.filter(z => !lead.includes(z)).sort()];
    const zones = ordered.map(z => `<option value="${esc(z)}"${z === state.zone ? ' selected' : ''}>${esc(z.toUpperCase())}</option>`).join('');
    const wc = [1, 2, 3].map(n => `<label class="dl-wc"><input type="checkbox" data-wc="${n}"${state.words.has(String(n)) ? ' checked' : ''} onchange="app.dlDailyWordFilter(this)"> ${n} word${n > 1 ? 's' : ''}</label>`).join('');
    return `
      <div class="dl-bar">
        <select id="dl-date" onchange="app.dlDailySetDate(this.value)">${dates}</select>
        <select id="dl-zone" onchange="app.dlDailySetZone(this.value)">${zones}</select>
        <label class="dl-wc"><input type="checkbox"${state.includeAllZones ? ' checked' : ''} onchange="app.dlDailyToggleAllZones(this.checked)"> All zones</label>
        <button class="dl-btn" onclick="app.dlDailyCopyTokens()">⧉ Copy tokens</button>
        <span class="dl-pop-wrap">
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
        <span class="dl-rank">${n + 1}</span>
        <span class="dl-token">${esc(t.token)}</span>
        <span class="dl-count">${fmt(t.count)}</span>
      </div>`).join('');
    panel.innerHTML = `
      ${controlBar()}
      ${state.fallback ? '<div class="dl-note">Daily reports begin with the next zone sync — cross-zone history below.</div>' : ''}
      <div class="dl-count-line">${fmt(state.tokens.length)} tokens</div>
      <div class="dl-list">${rows || '<div class="dl-note">No tokens match.</div>'}</div>`;
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
    let names = [], total = 0;
    if (!state.fallback) {
      const d = await fetchDomains();
      names = d.names || d.domains || [];
      total = d.total != null ? d.total : names.length;
    } else {
      try {
        const r = await fetch(`/api/domainlab/term/${encodeURIComponent(state.token)}`);
        const d = await r.json();
        names = (d.exampleLiveDomains || d.exampleDomains || d.examples || []).slice(0, state.perPage);
        total = names.length;
      } catch { names = []; }
    }
    if (state.view !== 'domains' || state.token !== renderToken) return;
    const per = [25, 50, 100].map(n => `<option value="${n}"${n === state.perPage ? ' selected' : ''}>${n}</option>`).join('');
    panel.innerHTML = `
      ${controlBar()}
      <div class="dl-crumb">
        <a class="zi-link" onclick="app.dlDailyBack()">&lt; Tokens</a>
        <strong>${esc(state.token)}</strong>
        <span class="dl-muted">${fmt(total)} domains</span>
        <span class="dl-crumb-right">
          Per page <select onchange="app.dlDailyPerPage(this.value)">${per}</select>
          <button class="dl-btn" onclick="app.dlDailyCopyDomains()">⧉ Copy all</button>
        </span>
      </div>
      <div class="dl-list" id="dl-domains">${names.map(n => `<div class="dl-row dl-domain-row">${esc(typeof n === 'string' ? n : n.domain || n.name)}</div>`).join('') || '<div class="dl-note">No domains recorded for this token on this day.</div>'}</div>
      <div class="dl-count-line">Showing ${fmt(names.length)} of ${fmt(total)}</div>`;
  }

  // ---- actions ----
  /* the app object is a top-level lexical binding (let app), not window.app —
     resolve the same binding the panel's inline handlers see */
  const appObj = (function () { try { return app; } catch { return (window.app = window.app || {}); } })();
  appObj.dlDailySetDate = v => { state.date = v || null; state.view = 'tokens'; load(); };
  appObj.dlDailySetZone = v => { state.zone = v; state.view = 'tokens'; load(); };
  appObj.dlDailyToggleAllZones = checked => { state.includeAllZones = !!checked; state.view = 'tokens'; load(); };
  appObj.dlDailySearch = (v) => { state.q = v.trim(); state.view = 'tokens'; clearTimeout(state._t); state._t = setTimeout(load, 250); };
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
  appObj.dlDailyBack = () => { state.view = 'tokens'; state.token = null; render(); };
  appObj.dlDailyCopyTokens = () => {
    navigator.clipboard.writeText(state.tokens.map(t => t.token).join('\n')).catch(() => {});
  };
  appObj.dlDailyCopyDomains = () => {
    const rows = [...document.querySelectorAll('#dl-domains .dl-domain-row')].map(r => r.textContent);
    navigator.clipboard.writeText(rows.join('\n')).catch(() => {});
  };
  appObj.dlShowAnalytics = () => {
    const panel = el('domainlab-panel');
    if (state._originalPanel != null) panel.innerHTML = state._originalPanel;
    const back = document.createElement('div');
    back.innerHTML = '<a class="zi-link" onclick="app.domainlabLoadAll()">&lt; Daily view</a>';
    panel.prepend(back);
    if (typeof appObj.domainlabRenderAnalyticsShell === 'function') appObj.domainlabRenderAnalyticsShell();
  };

  async function load() {
    const panel = el('domainlab-panel');
    if (panel && state._originalPanel == null) state._originalPanel = panel.innerHTML;
    if (panel && state.view === 'tokens') {
      panel.innerHTML = `${controlBar()}<div class="dl-note">Loading tokens…</div>`;
    }
    try {
      const d = await fetchDaily();
      const dates = d.dates || [];
      if (dates.length) {
        state.fallback = false;
        state.dates = dates;
        if (!state.date || !dates.includes(state.date)) state.date = dates[0];
        state.zones = (d.zones || []).map(z => String(typeof z === 'string' ? z : z.zone || z.tld || '').replace(/^\./, '')).filter(Boolean);
        state.tokens = d.tokens || [];
        state.totalTokens = d.totalTokens || state.tokens.length;
      } else {
        state.fallback = true;
        state.dates = [];
        state.tokens = await fetchFallbackTokens();
      }
    } catch {
      state.fallback = true;
      state.tokens = await fetchFallbackTokens().catch(() => []);
    }
    const STOP = new Set(['the','and','ing','for','you','your','our','with','from','this','that','get','all','are','can','has','have','not','new','one','two','out','off','online','web','www','net','com']);
    if (!state.q) state.tokens = state.tokens.filter(t => String(t.token).length >= 4 && !STOP.has(String(t.token)));
    state.tokens.sort((a, b) => (b.count || 0) - (a.count || 0) || String(a.token).localeCompare(String(b.token)));
    // A fresh/partial newest date can be empty for the selected zone (capture
    // mid-accrual): step back to the newest date that has tokens.
    if (!state.tokens.length && !state.q && !state.words.size && state.dates.length > 1) {
      state._stepBack = (state._stepBack || 0) + 1;
      const idx = state.dates.indexOf(state.date);
      if (state._stepBack <= 4 && idx >= 0 && idx + 1 < state.dates.length) {
        state.date = state.dates[idx + 1];
        return load();
      }
    }
    state._stepBack = 0;
    if (state.view === 'tokens') render();
  }

  // Take over the panel default: wrap the analytics loader so the Daily view
  // renders first; analytics renders only via the explicit link.
  const analyticsLoad = appObj.domainlabLoadAll ? appObj.domainlabLoadAll.bind(appObj) : null;
  appObj.domainlabRenderAnalyticsShell = analyticsLoad;
  appObj.domainlabLoadAll = function dailyFirst() { load(); };
})();
