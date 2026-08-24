/* DomainScout DomainLab — unified cross-zone trending-terms workspace */
(() => {
  'use strict';

  const state = { rows: [], insights: [], zones: [], term: '', includeNoise: false, includeAllZones: false, expandedZones: new Set(), loadGeneration: 0 };
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
    const allZones = document.createElement('label');
    allZones.innerHTML = '<input type="checkbox" id="dl-includeAllZones"> Show restricted/local zones';
    filters.appendChild(allZones);
    el('dl-includeAllZones').addEventListener('change', (e) => {
      state.includeAllZones = e.target.checked;
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
    params.set('baseline', el('dl-baseline').value || '14');
    params.set('limit', el('dl-limit').value || '100');
    params.set('mode', el('dl-mode').value || 'fragments');
    if (el('dl-zones').value.trim()) params.set('zones', el('dl-zones').value.trim());
    if (el('dl-group').value) params.set('group', el('dl-group').value);
    if (el('dl-minZones').value) params.set('minZones', el('dl-minZones').value);
    if (el('dl-q').value.trim()) params.set('q', el('dl-q').value.trim());
    if (state.includeNoise) params.set('includeNoise', '1');
    if (state.includeAllZones) params.set('includeAllZones', '1');
    return params;
  }

  function renderInsights(insights) {
    el('dl-insights').innerHTML = insights.length
      ? insights.map(i => `<div class="dl-insight">${signalBadge(i)} <strong>${escapeHtml(i.statement)}</strong></div>`).join('')
      : '<p class="zi-empty">No cross-zone co-movement clears the threshold for this window yet.</p>';
  }

  function renderTrending(rows) {
    const fragments = (el('dl-mode')?.value || 'fragments') !== 'terms';
    el('dl-head').innerHTML = fragments
      ? '<tr><th>Fragment</th><th>Signal</th><th>Independent names</th><th>Contexts</th><th>Mirror rate</th><th>Zones</th><th>Days</th><th>Momentum</th><th>Evidence rank</th><th></th></tr>'
      : '<tr><th>Exact name</th><th>Batch classification</th><th>Observed event days</th><th>TLD spread</th><th>Zones</th><th>Momentum</th><th>Batch rank</th><th></th></tr>';
    el('dl-body').innerHTML = rows.map(row => fragments ? `<tr>
      <td><button class="zi-link" data-term="${escapeHtml(row.term)}" data-mode="${escapeHtml(row.mode || 'terms')}" onclick="app.domainlabDrill(this.dataset.term, this.dataset.mode)">${escapeHtml(row.term)}</button>${row.worthWatching ? ' <span class="dl-watch" title="Repeated across independently distributed names">&#9733; watch</span>' : ''}</td>
      <td>${signalBadge(row)}</td>
      <td class="zi-num">${row.independentNames == null ? '—' : fmtNum(row.independentNames)}</td>
      <td class="zi-num">${row.contextCount == null ? '—' : fmtNum(row.contextCount)}</td>
      <td class="zi-num">${row.mirrorRate == null ? '—' : Math.round(row.mirrorRate * 100) + '%'}</td>
      <td>${zoneChips(row.term, row.zones)}</td>
      <td class="zi-num">${row.recurrenceDays == null ? '—' : row.recurrenceDays}</td>
      <td class="zi-num">${row.momentum == null ? '—' : row.momentum + 'x'}${row.lowBaselineConfidence ? '<small>low-baseline</small>' : ''}</td>
      <td class="zi-num">${row.qualityScore == null ? '—' : row.qualityScore}</td>
      <td><button class="zi-link" data-term="${escapeHtml(row.term)}" data-mode="${escapeHtml(row.mode || 'terms')}" onclick="app.domainlabDrill(this.dataset.term, this.dataset.mode)">evidence &rarr;</button></td>
    </tr>` : `<tr>
      <td><button class="zi-link" data-term="${escapeHtml(row.term)}" data-mode="terms" onclick="app.domainlabDrill(this.dataset.term, this.dataset.mode)">${escapeHtml(row.term)}</button></td>
      <td>${signalBadge(row)}</td>
      <td class="zi-num">${fmtNum(row.windowRegistrations)}</td>
      <td class="zi-num">${fmtNum(row.spread)}</td>
      <td>${zoneChips(row.term, row.zones)}</td>
      <td class="zi-num">${row.momentum == null ? '—' : row.momentum + 'x'}</td>
      <td class="zi-num">${row.qualityScore == null ? '—' : row.qualityScore}</td>
      <td><button class="zi-link" data-term="${escapeHtml(row.term)}" data-mode="terms" onclick="app.domainlabDrill(this.dataset.term, this.dataset.mode)">batch evidence &rarr;</button></td>
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
    const generation = ++state.loadGeneration;
    ensureNoiseToggle();
    el('dl-status').textContent = 'Loading…';
    try {
      const params = paramsFromForm();
      const [trendingRes, insightsRes, zonesRes] = await Promise.all([
        fetch(`/api/domainlab/trending?${params}`).then(r => r.json()),
        fetch(`/api/domainlab/insights?${params}`).then(r => r.json()),
        fetch(`/api/domainlab/zones?window=${el('dl-window').value || 7}`).then(r => r.json()),
      ]);
      if (generation !== state.loadGeneration || !el('dl-body')) return;
      if (trendingRes.ok === false) throw new Error(trendingRes.error);
      state.rows = trendingRes.rows || [];
      renderTrending(state.rows);
      const noiseText = trendingRes.includeNoise ? 'noise included' : 'noise hidden (default)';
      const zoneText = trendingRes.includeAllZones ? 'all accessible zones' : 'market-relevant zones (default)';
      const skippedPartial = trendingRes.anchorReceipt?.skippedNewerDates?.length
        ? ` · skipped partial newer dates ${trendingRes.anchorReceipt.skippedNewerDates.map(row => `${row.date} (${row.observedTlds} TLDs)`).join(', ')}`
        : '';
      el('dl-evidence').textContent = `Anchor (latest comparable coverage) ${trendingRes.anchor}${skippedPartial} · window ${trendingRes.window.from}–${trendingRes.window.to} vs baseline ${trendingRes.baseline.from}–${trendingRes.baseline.to} · ${trendingRes.coverageNote || 'coverage receipt unavailable'} · sort ${trendingRes.sort || 'evidence'} · ${zoneText} · ${noiseText} · ${trendingRes.qualityScoreFormula}${trendingRes.capped ? ' · result set capped' : ''}`;
      if (insightsRes.ok !== false) renderInsights(insightsRes.insights || []);
      if (zonesRes.ok !== false) renderZones(zonesRes);
      el('dl-status').textContent = `${state.rows.length.toLocaleString()} ${trendingRes.mode === 'fragments' ? 'fragments' : 'exact-name batches'}`;
    } catch (error) {
      el('dl-status').textContent = 'Unavailable';
      el('dl-evidence').textContent = `Data unavailable: ${error.message}. No rows were synthesized.`;
      el('dl-body').innerHTML = '';
      el('dl-empty').hidden = false;
      el('dl-empty').textContent = 'DomainLab evidence unavailable.';
    }
  };

  app.domainlabCancelAnalytics = function domainlabCancelAnalytics() {
    state.loadGeneration += 1;
  };

  app.domainlabDrill = async function domainlabDrill(term, mode = 'fragments') {
    state.term = term;
    el('dl-drill').hidden = false;
    el('dl-drill-title').textContent = `"${term}" across zones`;
    el('dl-drill-body').textContent = 'Loading…';
    try {
      const data = await fetch(`/api/domainlab/term/${encodeURIComponent(term)}?mode=${encodeURIComponent(mode)}`).then(r => r.json());
      if (data.ok === false) throw new Error(data.error);
      const historyRows = mode === 'fragments'
        ? (data.history || []).flatMap(h => (h.registrations || []).map(r => `<tr><td>${escapeHtml(h.trend_date)}</td><td>${escapeHtml(r.domain)}</td><td>${chip('.' + r.tld)}</td><td><small>${escapeHtml(data.source)}</small></td></tr>`)).join('')
        : (data.history || []).map(h => `<tr><td>${escapeHtml(h.trend_date)}</td><td class="zi-num">${h.tld_count}</td><td>${(h.tlds || []).map(chip).join(' ')}</td><td><small>${escapeHtml(h.source)}</small></td></tr>`).join('');
      el('dl-drill-body').innerHTML = `
        <p><strong>Current zones:</strong> ${(data.currentZones || []).map(chip).join(' ') || '—'}</p>
        ${mode === 'fragments' ? '' : `<p><strong>Cross-TLD ownership:</strong> ${data.crossTldOwnership ? `${data.crossTldOwnership.tld_count} TLDs (${escapeHtml(data.crossTldOwnership.tld_list)})` : 'not observed in name_summary'}</p><p><strong>Component words:</strong> ${(data.words || []).join(', ') || '—'}</p>`}
        <p><strong>Observed domains:</strong> ${(data.exampleLiveDomains || []).slice(0, 20).join(', ') || '—'}</p>
        <table class="zi-table"><thead><tr><th>Date</th><th>${mode === 'fragments' ? 'Domain' : 'TLD count'}</th><th>Zone evidence</th><th>Source</th></tr></thead><tbody>${historyRows || '<tr><td colspan="4"><small>No trend history captured.</small></td></tr>'}</tbody></table>
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
