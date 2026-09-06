/* DomainScout DomainLab — unified cross-zone trending-terms workspace */
(() => {
  'use strict';

  const state = {
    rows: [], insights: [], zones: [], rawZones: [], zonesData: null,
    term: '', includeNoise: false, includeAllZones: false, expandedZones: new Set(),
    sortBy: 'qualityScore', sortDir: 'desc',
    zonesSortBy: null, zonesSortDir: 'asc',
  };
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

  // Sortable trending-table header cell. Column -> API sortBy key mapping is
  // fixed (Term/Signal/Spread/Momentum/Quality/Window/Baseline); Zones/Groups
  // and the trailing actions column are never sortable (key is falsy).
  function sortHeaderCell(label, key) {
    if (!key) return `<th>${escapeHtml(label)}</th>`;
    const active = state.sortBy === key;
    const arrow = active ? (state.sortDir === 'asc' ? ' ▲' : ' ▼') : '';
    return `<th class="dl-sortable" style="cursor:pointer" onclick="app.domainlabSort('${key}')">${escapeHtml(label)}${arrow}</th>`;
  }

  // Same key -> toggle direction; new key -> set key with its default
  // direction (asc for term, desc otherwise); then re-fetch through the
  // existing loadAll path so sorting is applied server-side over the FULL
  // filtered set, not just the currently-rendered page.
  app.domainlabSort = function domainlabSort(key) {
    if (state.sortBy === key) {
      state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
    } else {
      state.sortBy = key;
      state.sortDir = key === 'term' ? 'asc' : 'desc';
    }
    return app.domainlabLoadAll();
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
    return app.domainlabLoadAll();
  };

  app.domainlabCaptureNavigation=()=>({settings:Object.fromEntries(['term','includeNoise','includeAllZones','sortBy','sortDir','zonesSortBy','zonesSortDir'].map(k=>[k,state[k]])),expandedZones:[...state.expandedZones],inputs:[...document.querySelectorAll('#domainlab-panel input[id],#domainlab-panel select[id]')].map(e=>({id:e.id,value:e.value,checked:e.checked}))});
  app.domainlabApplyNavigation=s=>{if(!s)return;Object.assign(state,s.settings);state.expandedZones=new Set(s.expandedZones||[]);for(const input of s.inputs||[]){const e=el(input.id);if(e){e.value=input.value;if(typeof input.checked==='boolean')e.checked=input.checked;}}};

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
    if (state.includeAllZones) params.set('includeAllZones', '1');
    params.set('sortBy', state.sortBy);
    params.set('sortDir', state.sortDir);
    return params;
  }

  function renderTrending(rows) {
    el('dl-head').innerHTML = '<tr>'
      + sortHeaderCell('Term', 'term')
      + sortHeaderCell('Signal', 'signal')
      + sortHeaderCell('Spread', 'spread')
      + '<th>Zones</th>'
      + '<th>Groups</th>'
      + sortHeaderCell('Momentum', 'momentum')
      + sortHeaderCell('Quality', 'qualityScore')
      + sortHeaderCell('Window', 'windowRegistrations')
      + sortHeaderCell('Baseline', 'baselineRegistrations')
      + '<th></th>'
      + '</tr>';
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

  // Zone-health column sort values. Null totals/added/dropped sort last in
  // both directions; tld/group compare alphabetically.
  function zoneLatestStat(z) {
    return (z.series && z.series[z.series.length - 1]) || {};
  }
  function zoneSortValue(z, key) {
    const latest = zoneLatestStat(z);
    if (key === 'tld') return z.tld;
    if (key === 'group') return z.semanticGroup;
    if (key === 'total') return latest.total;
    if (key === 'added') return latest.added;
    if (key === 'dropped') return latest.dropped;
    return null;
  }
  function compareZoneRows(a, b, key, dir) {
    const av = zoneSortValue(a, key);
    const bv = zoneSortValue(b, key);
    if (key === 'tld' || key === 'group') {
      const cmp = String(av || '').localeCompare(String(bv || ''));
      return dir === 'asc' ? cmp : -cmp;
    }
    const aNull = av == null;
    const bNull = bv == null;
    if (aNull !== bNull) return aNull ? 1 : -1;
    if (aNull && bNull) return 0;
    const cmp = av - bv;
    return dir === 'asc' ? cmp : -cmp;
  }

  // The zone-health thead is static markup in index.html (onclick handlers
  // only — see app.domainlabZonesSort below). Update the ▲/▼ affordance by
  // reading each th's own onclick attribute rather than requiring extra ids.
  function updateZonesHeaderIndicators() {
    const body = el('dl-zones-body');
    const table = body && body.closest ? body.closest('table') : null;
    const headRow = table ? table.querySelector('thead tr') : null;
    if (!headRow) return;
    Array.from(headRow.children).forEach(th => {
      const onclickAttr = th.getAttribute('onclick') || '';
      const match = onclickAttr.match(/domainlabZonesSort\('([a-z]+)'\)/);
      const baseLabel = (th.textContent || '').replace(/\s*[▲▼]\s*$/, '').trim();
      if (!match) { th.textContent = baseLabel; return; }
      const key = match[1];
      const active = state.zonesSortBy === key;
      const arrow = active ? (state.zonesSortDir === 'asc' ? ' ▲' : ' ▼') : '';
      th.textContent = baseLabel + arrow;
    });
  }

  // Renders from state.rawZones/state.zonesData — never re-fetches. Default
  // (zonesSortBy === null) preserves today's server-provided relevance order.
  function renderZonesTable() {
    const data = state.zonesData || {};
    el('dl-zones-through').textContent = (data.indexedTldCount === 0 && data.dataThrough)
      ? `Data through ${data.dataThrough} · observational NRD feed (no authoritative zone snapshots)`
      : `Data through ${data.dataThrough || 'unknown'} · ${data.indexedTldCount || 0} TLDs indexed`;
    const zones = (state.rawZones || []).slice();
    if (state.zonesSortBy) zones.sort((a, b) => compareZoneRows(a, b, state.zonesSortBy, state.zonesSortDir));
    el('dl-zones-body').innerHTML = zones.slice(0, 60).map(z => {
      const latest = zoneLatestStat(z);
      return `<tr><td>.${escapeHtml(z.tld)}</td><td><small>${escapeHtml(z.semanticGroup)}</small></td><td class="zi-num">${latest.total == null ? '—' : fmtNum(latest.total)}</td><td class="zi-num">${latest.added == null ? '—' : '+' + fmtNum(latest.added)}</td><td class="zi-num">${latest.dropped == null ? '—' : '-' + fmtNum(latest.dropped)}</td><td><small>${z.indexed ? escapeHtml(z.indexed.file_date) : 'not indexed'}</small></td></tr>`;
    }).join('');
    updateZonesHeaderIndicators();
  }

  // Same key -> toggle direction; new key -> alpha columns default asc,
  // numeric columns default desc. Client-side only — never re-fetches.
  app.domainlabZonesSort = function domainlabZonesSort(key) {
    if (state.zonesSortBy === key) {
      state.zonesSortDir = state.zonesSortDir === 'asc' ? 'desc' : 'asc';
    } else {
      state.zonesSortBy = key;
      state.zonesSortDir = (key === 'tld' || key === 'group') ? 'asc' : 'desc';
    }
    renderZonesTable();
  };

  app.domainlabLoadAll = async function domainlabLoadAll() {
    ensureNoiseToggle();
    el('dl-status').textContent = 'Loading…';
    try {
      const params = paramsFromForm();
      const [trendingRes, zonesRes] = await Promise.all([
        fetch(`/api/domainlab/trending?${params}`).then(r => r.json()),
        fetch(`/api/domainlab/zones?window=${el('dl-window').value || 7}`).then(r => r.json()),
      ]);
      if (trendingRes.ok === false) throw new Error(trendingRes.error);
      state.rows = trendingRes.rows || [];
      renderTrending(state.rows);
      const noiseText = trendingRes.includeNoise ? 'noise included' : 'noise hidden (default)';
      const zoneText = trendingRes.includeAllZones ? 'all accessible zones' : 'market-relevant zones (default)';
      el('dl-evidence').textContent = `Anchor (data-through) date ${trendingRes.anchor} · window ${trendingRes.window.from}–${trendingRes.window.to} vs baseline ${trendingRes.baseline.from}–${trendingRes.baseline.to} · sort ${trendingRes.sort || 'qualityScore'} · ${zoneText} · ${noiseText} · ${trendingRes.momentumFormula}${trendingRes.capped ? ' · result set capped' : ''}`;
      if (zonesRes.ok !== false) {
        state.zonesData = zonesRes;
        state.rawZones = zonesRes.zones || [];
        renderZonesTable();
      }
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
    const trendRow = state.rows.find(row => row.term === term) || null;
    el('dl-drill').hidden = false;
    el('dl-drill-title').textContent = `"${term}" across zones`;
    el('dl-drill-body').textContent = 'Loading…';
    try {
      const data = await fetch(`/api/domainlab/term/${encodeURIComponent(term)}`).then(r => r.json());
      if (data.ok === false) throw new Error(data.error);
      const observedNames = trendRow?.sourceDomains || [];
      const observedNameCount = Number(trendRow?.sourceDomainCount || observedNames.length);
      const observedNamesHtml = observedNames.length
        ? observedNames.map(name => chip(name)).join(' ')
        : '—';
      const historyRows = (data.history || []).map(h => `<tr><td>${escapeHtml(h.trend_date)}</td><td class="zi-num">${h.tld_count}</td><td>${(h.tlds || []).map(chip).join(' ')}</td><td><small>${escapeHtml(h.source)}</small></td></tr>`).join('');
      el('dl-drill-body').innerHTML = `
        <p><strong>Names observed in this window (${fmtNum(observedNameCount)}):</strong> ${observedNamesHtml}${observedNameCount > observedNames.length ? ` <small>showing first ${fmtNum(observedNames.length)}</small>` : ''}</p>
        ${trendRow?.mode === 'words' ? `<p><strong>Source phrases:</strong> ${(trendRow.sourceTerms || []).map(chip).join(' ') || '—'}</p>` : ''}
        <p><strong>Current zones for the exact base "${escapeHtml(term)}":</strong> ${(data.currentZones || []).map(chip).join(' ') || '—'}</p>
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
