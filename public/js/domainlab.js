/* DomainScout DomainLab — unified cross-zone trending-terms workspace */
(() => {
  'use strict';

  const state = { rows: [], insights: [], zones: [], term: '', includeNoise: false, expandedZones: new Set() };
  const ZONE_CHIP_MAX = 6;

  function el(id) { return document.getElementById(id); }
  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function chip(text) { return `<span class="dl-chip">${escapeHtml(text)}</span>`; }
  function fmtNum(n) { return Number(n || 0).toLocaleString(); }

  const SIGNAL_CLASS = { quality: 'dl-signal-quality', mixed: 'dl-signal-mixed', noise: 'dl-signal-noise' };

  function signalBadge(row) {
    if (!row || !row.signal) return '';
    const cls = SIGNAL_CLASS[row.signal] || 'dl-signal-mixed';
    const title = (row.signalReasons || []).join('; ') || row.signal;
    return `<span class="dl-signal ${cls}" title="${escapeHtml(title)}">${escapeHtml(row.signal)}</span>`;
  }

  // Elided zone chips with a '+N more' expander (mirrors server elideZones).
  function zoneChips(term, zones) {
    const list = zones || [];
    const expanded = state.expandedZones.has(term);
    const shown = expanded ? list : list.slice(0, ZONE_CHIP_MAX);
    const chips = shown.map(z => chip('.' + z)).join(' ');
    if (list.length <= ZONE_CHIP_MAX) return chips;
    const label = expanded ? 'show fewer' : `+${list.length - ZONE_CHIP_MAX} more`;
    return `${chips} <button type="button" class="zi-link dl-zone-toggle" data-term="${escapeHtml(term)}" onclick="app.domainlabToggleZones(this.dataset.term)">${label}</button>`;
  }

  app.domainlabToggleZones = function domainlabToggleZones(term) {
    if (state.expandedZones.has(term)) state.expandedZones.delete(term);
    else state.expandedZones.add(term);
    renderTrending(state.rows);
  };

  // 'Show noise' toggle wired to ?includeNoise=1. Injected into the existing
  // filters bar rather than hand-edited into index.html so the panel keeps
  // working even if this script loads before/without a matching markup edit.
  function ensureNoiseToggle() {
    if (el('dl-includeNoise')) return;
    const filters = el('dl-filters');
    if (!filters) return;
    const label = document.createElement('label');
    label.innerHTML = '<input type="checkbox" id="dl-includeNoise"> Show noise';
    filters.appendChild(label);
    el('dl-includeNoise').addEventListener('change', (e) => {
      state.includeNoise = e.target.checked;
      app.domainlabLoadAll();
    });
  }

  const oldHide = app._hideAllToolPanels.bind(app);
  app._hideAllToolPanels = function domainlabAwareHide() {
    oldHide();
    el('domainlab-panel').style.display = 'none';
  };
  app._toolPanels.push('_domainlab');
  const oldSetStream = app.setStream.bind(app);
  app.setStream = function domainlabAwareSetStream(stream) {
    if (stream !== '_domainlab') return oldSetStream(stream);
    state.stream = stream;
    document.querySelectorAll('.stream-tab').forEach(tab => tab.classList.toggle('active', tab.dataset.stream === stream));
    app._hideAllToolPanels();
    document.querySelector('.toolbar').style.display = 'none';
    document.getElementById('table-wrap').style.display = 'none';
    document.querySelector('.pagination').style.display = 'none';
    el('domainlab-panel').style.display = 'block';
    ensureNoiseToggle();
    app.domainlabLoadAll();
  };

  function paramsFromForm() {
    const params = new URLSearchParams();
    params.set('window', el('dl-window').value || '7');
    params.set('baseline', el('dl-baseline').value || '28');
    params.set('limit', el('dl-limit').value || '100');
    params.set('mode', el('dl-mode').value || 'terms');
    if (el('dl-zones').value.trim()) params.set('zones', el('dl-zones').value.trim());
    if (el('dl-group').value) params.set('group', el('dl-group').value);
    if (el('dl-minZones').value) params.set('minZones', el('dl-minZones').value);
    if (el('dl-q').value.trim()) params.set('q', el('dl-q').value.trim());
    if (state.includeNoise) params.set('includeNoise', '1');
    return params;
  }

  function renderInsights(insights) {
    el('dl-insights').innerHTML = insights.length
      ? insights.map(i => `<div class="dl-insight">${signalBadge(i)} <strong>${escapeHtml(i.statement)}</strong></div>`).join('')
      : '<p class="zi-empty">No cross-zone co-movement clears the threshold for this window yet.</p>';
  }

  function renderTrending(rows) {
    el('dl-head').innerHTML = '<tr><th>Term</th><th>Signal</th><th>Spread</th><th>Zones</th><th>Groups</th><th>Momentum</th><th>Quality</th><th>Window</th><th>Baseline</th><th></th></tr>';
    el('dl-body').innerHTML = rows.map(row => `<tr>
      <td><button class="zi-link" data-term="${escapeHtml(row.term)}" onclick="app.domainlabDrill(this.dataset.term)">${escapeHtml(row.term)}</button>${row.worthWatching ? ' <span class="dl-watch" title="Cross-zone co-movement worth watching">&#9733; watch</span>' : ''}</td>
      <td>${signalBadge(row)}</td>
      <td class="zi-num">${row.spread}</td>
      <td>${zoneChips(row.term, row.zones)}</td>
      <td><small>${escapeHtml(row.semanticGroups.join(', '))}</small></td>
      <td class="zi-num">${row.momentum == null ? '—' : row.momentum + 'x'}${row.lowBaselineConfidence ? '<small>low-baseline</small>' : ''}</td>
      <td class="zi-num">${row.qualityScore == null ? '—' : row.qualityScore}</td>
      <td class="zi-num">${row.windowRegistrations}</td>
      <td class="zi-num">${row.baselineRegistrations}</td>
      <td><button class="zi-link" data-term="${escapeHtml(row.term)}" onclick="app.domainlabDrill(this.dataset.term)">drill &rarr;</button></td>
    </tr>`).join('');
    el('dl-empty').hidden = rows.length > 0;
  }

  function renderZones(data) {
    el('dl-zones-through').textContent = `Data through ${data.dataThrough || 'unknown'} · ${data.indexedTldCount || 0} TLDs indexed`;
    el('dl-zones-body').innerHTML = (data.zones || []).slice(0, 60).map(z => {
      const latest = z.series[z.series.length - 1] || {};
      return `<tr><td>.${escapeHtml(z.tld)}</td><td><small>${escapeHtml(z.semanticGroup)}</small></td><td class="zi-num">${fmtNum(latest.total)}</td><td class="zi-num">${latest.added == null ? '—' : '+' + fmtNum(latest.added)}</td><td class="zi-num">${latest.dropped == null ? '—' : '-' + fmtNum(latest.dropped)}</td><td><small>${z.indexed ? escapeHtml(z.indexed.file_date) : 'not indexed'}</small></td></tr>`;
    }).join('');
  }

  app.domainlabLoadAll = async function domainlabLoadAll() {
    ensureNoiseToggle();
    el('dl-status').textContent = 'Loading…';
    try {
      const params = paramsFromForm();
      const [trendingRes, insightsRes, zonesRes] = await Promise.all([
        fetch(`/api/domainlab/trending?${params}`).then(r => r.json()),
        fetch(`/api/domainlab/insights?${params}`).then(r => r.json()),
        fetch(`/api/domainlab/zones?window=${el('dl-window').value || 7}`).then(r => r.json()),
      ]);
      if (trendingRes.ok === false) throw new Error(trendingRes.error);
      state.rows = trendingRes.rows || [];
      renderTrending(state.rows);
      const noiseText = trendingRes.includeNoise ? 'noise included' : 'noise hidden (default)';
      el('dl-evidence').textContent = `Anchor (data-through) date ${trendingRes.anchor} · window ${trendingRes.window.from}–${trendingRes.window.to} vs baseline ${trendingRes.baseline.from}–${trendingRes.baseline.to} · sort ${trendingRes.sort || 'qualityScore'} · ${noiseText} · ${trendingRes.momentumFormula}${trendingRes.capped ? ' · result set capped' : ''}`;
      if (insightsRes.ok !== false) renderInsights(insightsRes.insights || []);
      if (zonesRes.ok !== false) renderZones(zonesRes);
      el('dl-status').textContent = `${state.rows.length.toLocaleString()} terms`;
    } catch (error) {
      el('dl-status').textContent = 'Unavailable';
      el('dl-evidence').textContent = `Data unavailable: ${error.message}. No rows were synthesized.`;
      el('dl-body').innerHTML = '';
      el('dl-empty').hidden = false;
      el('dl-empty').textContent = 'DomainLab evidence unavailable.';
    }
  };

  app.domainlabDrill = async function domainlabDrill(term) {
    state.term = term;
    el('dl-drill').hidden = false;
    el('dl-drill-title').textContent = `"${term}" across zones`;
    el('dl-drill-body').textContent = 'Loading…';
    try {
      const data = await fetch(`/api/domainlab/term/${encodeURIComponent(term)}`).then(r => r.json());
      if (data.ok === false) throw new Error(data.error);
      const historyRows = (data.history || []).map(h => `<tr><td>${escapeHtml(h.trend_date)}</td><td class="zi-num">${h.tld_count}</td><td>${(h.tlds || []).map(chip).join(' ')}</td><td><small>${escapeHtml(h.source)}</small></td></tr>`).join('');
      el('dl-drill-body').innerHTML = `
        <p><strong>Current zones:</strong> ${(data.currentZones || []).map(chip).join(' ') || '—'}</p>
        <p><strong>Cross-TLD ownership:</strong> ${data.crossTldOwnership ? `${data.crossTldOwnership.tld_count} TLDs (${escapeHtml(data.crossTldOwnership.tld_list)})` : 'not observed in name_summary'}</p>
        <p><strong>Component words:</strong> ${(data.words || []).join(', ') || '—'}</p>
        <p><strong>Example live domains:</strong> ${(data.exampleLiveDomains || []).slice(0, 20).join(', ') || '—'}</p>
        <table class="zi-table"><thead><tr><th>Date</th><th>TLD count</th><th>Zones</th><th>Source</th></tr></thead><tbody>${historyRows || '<tr><td colspan="4"><small>No trend history captured.</small></td></tr>'}</tbody></table>
      `;
    } catch (error) {
      el('dl-drill-body').textContent = `Evidence unavailable: ${error.message}`;
    }
  };

  document.addEventListener('DOMContentLoaded', () => {
    const btn = el('dl-refresh');
    if (btn) btn.addEventListener('click', () => app.domainlabLoadAll());
    ensureNoiseToggle();
  });
  if (document.readyState !== 'loading') {
    const btn = el('dl-refresh');
    if (btn) btn.addEventListener('click', () => app.domainlabLoadAll());
    ensureNoiseToggle();
  }
})();

  function domainlabRenderTokenList() {
    const total = dailyState.totalTokens;
    el('dl-count-line').textContent = `${fmtNum(total)} token${total === 1 ? '' : 's'}`;
    const rows = dailyState.tokens;
    el('dl-token-list').innerHTML = rows.length
      ? rows.map((t, i) => `<div class="dl-token-row">
          <span class="dl-token-rank">${i + 1}</span>
          <button type="button" class="dl-token-text zi-link" data-token="${escapeHtml(t.token)}">${escapeHtml(t.token)}</button>
          <span class="dl-token-count">${fmtNum(t.count)}</span>
        </div>`).join('')
      : '<p class="zi-empty">No tokens match.</p>';
    el('dl-token-list').querySelectorAll('[data-token]').forEach(node => {
      node.addEventListener('click', () => app.domainlabDrillToken(node.dataset.token));
    });
  }

  app.domainlabLoadTokens = async function domainlabLoadTokens() {
    el('dl-count-line').textContent = 'Loading…';
    try {
      const params = new URLSearchParams();
      if (dailyState.date) params.set('date', dailyState.date);
      if (dailyState.zone) params.set('zone', dailyState.zone);
      if (dailyState.words.size) params.set('words', [...dailyState.words].join(','));
      if (dailyState.q) params.set('q', dailyState.q);
      params.set('limit', '500');
      const data = await fetch(`/api/domainlab/daily?${params}`).then(r => r.json());
      if (data.ok === false) throw new Error(data.error);
      dailyState.tokens = data.tokens || [];
      dailyState.totalTokens = data.totalTokens || 0;
      domainlabRenderTokenList();
    } catch (error) {
      el('dl-count-line').textContent = 'Tokens unavailable.';
      el('dl-token-list').innerHTML = '';
    }
  };

  async function domainlabLoadFallbackTokens() {
    el('dl-count-line').textContent = 'Loading…';
    try {
      const params = new URLSearchParams({ mode: 'terms', window: '7', limit: '500' });
      const data = await fetch(`/api/domainlab/trending?${params}`).then(r => r.json());
      if (data.ok === false) throw new Error(data.error);
      let rows = data.rows || [];
      if (dailyState.q) rows = rows.filter(r => r.term.includes(dailyState.q));
      dailyState.tokens = rows.map(r => ({ token: r.term, count: r.windowRegistrations }));
      dailyState.totalTokens = dailyState.tokens.length;
      domainlabRenderTokenList();
    } catch (error) {
      el('dl-count-line').textContent = 'Tokens unavailable.';
      el('dl-token-list').innerHTML = '';
    }
  }

  function elideZonesClient(zones, max) {
    max = max || 3;
    const list = (zones || []).map(z => String(z).replace(/^\./, ''));
    if (list.length <= max) return list.map(z => `.${z}`).join(', ');
    return `${list.slice(0, max).map(z => `.${z}`).join(', ')} + ${list.length - max} more`;
  }

  async function domainlabLoadInsights() {
    try {
      const data = await fetch('/api/domainlab/insights?window=7&limit=25').then(r => r.json());
      if (data.ok === false) throw new Error(data.error);
      const quality = (data.insights || []).filter(i => i.signal === 'quality').slice(0, 3);
      if (!quality.length) { el('dl-insights-daily').innerHTML = ''; return; }
      el('dl-insights-daily').innerHTML = quality.map(i => `<div class="dl-insight-row" data-token="${escapeHtml(i.term)}">
        <span class="dl-insight-accent"></span>
        <span class="dl-insight-text">${escapeHtml(i.term)} is trending across ${elideZonesClient(i.zones, 3)} (${fmtNum(i.windowRegistrations)} regs, ${i.momentum == null ? 'no baseline yet' : i.momentum + 'x baseline'}).</span>
      </div>`).join('');
      el('dl-insights-daily').querySelectorAll('[data-token]').forEach(node => {
        node.addEventListener('click', () => app.domainlabDrillToken(node.dataset.token));
      });
    } catch (error) {
      el('dl-insights-daily').innerHTML = '';
    }
  }

  app.domainlabShowTokenList = function domainlabShowTokenList() {
    el('dl-token-view').hidden = false;
    el('dl-domain-view').hidden = true;
  };

  app.domainlabDrillToken = async function domainlabDrillToken(token) {
    dailyState.domainToken = token;
    dailyState.domainZone = dailyState.zone;
    dailyState.domainDate = dailyState.date;
    dailyState.domainOffset = 0;
    el('dl-token-view').hidden = true;
    el('dl-domain-view').hidden = false;
    el('dl-breadcrumb-token').textContent = token;
    await domainlabLoadDomains();
  };

  async function domainlabLoadDomains() {
    el('dl-domain-list').innerHTML = '<p class="zi-empty">Loading…</p>';
    try {
      const params = new URLSearchParams({
        date: dailyState.domainDate || '', zone: dailyState.domainZone || '',
        token: dailyState.domainToken || '', limit: String(dailyState.perPage),
        offset: String(dailyState.domainOffset),
      });
      const data = await fetch(`/api/domainlab/daily/domains?${params}`).then(r => r.json());
      if (data.ok === false) throw new Error(data.error);
      dailyState.domains = data.names || [];
      dailyState.domainTotal = data.total || 0;
      el('dl-breadcrumb-count').textContent = `${fmtNum(dailyState.domainTotal)} domains`;
      el('dl-domain-list').innerHTML = dailyState.domains.length
        ? dailyState.domains.map(name => `<div class="dl-domain-row">${escapeHtml(name)}</div>`).join('')
        : '<p class="zi-empty">No domains.</p>';
      const shown = Math.min(dailyState.domainOffset + dailyState.domains.length, dailyState.domainTotal);
      el('dl-domain-showing').textContent = `Showing ${fmtNum(shown)} of ${fmtNum(dailyState.domainTotal)}`;
    } catch (error) {
      el('dl-domain-list').innerHTML = '<p class="zi-empty">Domains unavailable.</p>';
    }
  }

  app.domainlabBackToTokens = function domainlabBackToTokens() {
    el('dl-domain-view').hidden = true;
    el('dl-token-view').hidden = false;
  };

  app.domainlabCopyTokens = function domainlabCopyTokens() {
    const text = dailyState.tokens.map(t => t.token).join('\n');
    if (navigator.clipboard) navigator.clipboard.writeText(text).catch(() => {});
  };

  app.domainlabCopyAllDomains = function domainlabCopyAllDomains() {
    const text = dailyState.domains.join('\n');
    if (navigator.clipboard) navigator.clipboard.writeText(text).catch(() => {});
  };

  app.domainlabToggleWordcountPopover = function domainlabToggleWordcountPopover() {
    const pop = el('dl-wordcount-popover');
    if (pop) pop.hidden = !pop.hidden;
  };

  app.domainlabApplyWordFilter = function domainlabApplyWordFilter() {
    dailyState.words = new Set();
    [1, 2, 3].forEach(n => { const cb = el(`dl-wc-${n}`); if (cb && cb.checked) dailyState.words.add(n); });
    domainlabLoadTokens();
  };

  app.domainlabClearWordFilter = function domainlabClearWordFilter() {
    [1, 2, 3].forEach(n => { const cb = el(`dl-wc-${n}`); if (cb) cb.checked = false; });
    dailyState.words = new Set();
    domainlabLoadTokens();
  };

  function wireDailyControls() {
    const dateSel = el('dl-date');
    if (dateSel) dateSel.addEventListener('change', async () => {
      dailyState.date = dateSel.value;
      await domainlabRefreshZonesForDate();
      await domainlabLoadTokens();
    });
    const zoneSel = el('dl-zone');
    if (zoneSel) zoneSel.addEventListener('change', () => { dailyState.zone = zoneSel.value; domainlabLoadTokens(); });
    const search = el('dl-search');
    if (search) search.addEventListener('input', debounce(() => {
      dailyState.q = search.value.trim().toLowerCase();
      domainlabLoadTokens();
    }, 250));
    const copyBtn = el('dl-copy-tokens-btn');
    if (copyBtn) copyBtn.addEventListener('click', () => app.domainlabCopyTokens());
    const copyAllBtn = el('dl-copy-all-btn');
    if (copyAllBtn) copyAllBtn.addEventListener('click', () => app.domainlabCopyAllDomains());
    const filterBtn = el('dl-keyword-filter-btn');
    if (filterBtn) filterBtn.addEventListener('click', () => { const s = el('dl-search'); if (s) s.focus(); });
    const wcBtn = el('dl-wordcount-btn');
    if (wcBtn) wcBtn.addEventListener('click', () => app.domainlabToggleWordcountPopover());
    [1, 2, 3].forEach(n => { const cb = el(`dl-wc-${n}`); if (cb) cb.addEventListener('change', () => app.domainlabApplyWordFilter()); });
    const clearBtn = el('dl-wc-clear');
    if (clearBtn) clearBtn.addEventListener('click', () => app.domainlabClearWordFilter());
    const backLink = el('dl-breadcrumb-back');
    if (backLink) backLink.addEventListener('click', () => app.domainlabBackToTokens());
    const perPage = el('dl-perpage');
    if (perPage) perPage.addEventListener('change', () => {
      dailyState.perPage = parseInt(perPage.value, 10) || 50;
      dailyState.domainOffset = 0;
      domainlabLoadDomains();
    });
  }

  document.addEventListener('DOMContentLoaded', wireDailyControls);
  if (document.readyState !== 'loading') wireDailyControls();

})();
