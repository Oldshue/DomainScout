/* DomainScout DomainLab — unified cross-zone trending-terms workspace */
(() => {
  'use strict';

  const state = { rows: [], insights: [], zones: [], term: '' };

  function el(id) { return document.getElementById(id); }
  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function chip(text) { return `<span class="dl-chip">${escapeHtml(text)}</span>`; }
  function fmtNum(n) { return Number(n || 0).toLocaleString(); }

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
    return params;
  }

  function renderInsights(insights) {
    el('dl-insights').innerHTML = insights.length
      ? insights.map(i => `<div class="dl-insight"><strong>${escapeHtml(i.statement)}</strong></div>`).join('')
      : '<p class="zi-empty">No cross-zone co-movement clears the threshold for this window yet.</p>';
  }

  function renderTrending(rows) {
    el('dl-head').innerHTML = '<tr><th>Term</th><th>Spread</th><th>Zones</th><th>Groups</th><th>Momentum</th><th>Window</th><th>Baseline</th><th></th></tr>';
    el('dl-body').innerHTML = rows.map(row => `<tr>
      <td><button class="zi-link" data-term="${escapeHtml(row.term)}" onclick="app.domainlabDrill(this.dataset.term)">${escapeHtml(row.term)}</button>${row.worthWatching ? ' <span class="dl-watch" title="Cross-zone co-movement worth watching">&#9733; watch</span>' : ''}</td>
      <td class="zi-num">${row.spread}</td>
      <td>${row.zones.map(z => chip('.' + z)).join(' ')}</td>
      <td><small>${escapeHtml(row.semanticGroups.join(', '))}</small></td>
      <td class="zi-num">${row.momentum == null ? '—' : row.momentum + 'x'}${row.lowBaselineConfidence ? '<small>low-baseline</small>' : ''}</td>
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
      el('dl-evidence').textContent = `Anchor (data-through) date ${trendingRes.anchor} · window ${trendingRes.window.from}–${trendingRes.window.to} vs baseline ${trendingRes.baseline.from}–${trendingRes.baseline.to} · ${trendingRes.momentumFormula}${trendingRes.capped ? ' · result set capped' : ''}`;
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
  });
  if (document.readyState !== 'loading') {
    const btn = el('dl-refresh');
    if (btn) btn.addEventListener('click', () => app.domainlabLoadAll());
  }
})();
