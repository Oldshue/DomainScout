/* DomainScout Zone Intelligence — browser workspace over owned evidence */
(() => {
  'use strict';

  const FAVORITES_KEY = 'domainscout.zone-intelligence.favorites.v1';
  const zoneState = { mode: 'movement', rows: [], localRows: [], range: null, evidence: null, selectedToken: '' };

  function el(id) { return document.getElementById(id); }
  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<\"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', "'": '&#39;' }[char]));
  }
  function favorites() {
    try {
      const parsed = JSON.parse(localStorage.getItem(FAVORITES_KEY) || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch (_) { return []; }
  }
  function saveFavorites(rows) { localStorage.setItem(FAVORITES_KEY, JSON.stringify(rows)); }
  function favoriteKey(row) { return String(row.domain || row.token || '').toLowerCase(); }
  function isFavorite(row) { return favorites().some(item => item.key === favoriteKey(row)); }
  function favoriteButton(row) {
    const key = escapeHtml(favoriteKey(row));
    return `<button class="zi-favorite${isFavorite(row) ? ' active' : ''}" data-key="${key}" onclick="app.zoneToggleFavorite(this.dataset.key)" title="Save locally">★</button>`;
  }
  function csvCell(value) {
    const text = value == null ? '' : String(value);
    return /[\"\n,]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }
  function downloadCsv(filename, rows) {
    const columns = ['domain', 'token', 'mode', 'score', 'source', 'freshness'];
    const csv = [columns.join(','), ...rows.map(row => columns.map(column => csvCell(row[column])).join(','))].join('\n');
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 0);
  }
  function compactDate(value) { return value ? String(value).slice(0, 10) : '—'; }
  function sparkline(values) {
    const points = Array.isArray(values) && values.length ? values.map(Number) : [0];
    const max = Math.max(1, ...points.map(value => Math.abs(value)));
    const width = 92;
    const height = 24;
    const coordinates = points.map((value, index) => {
      const x = points.length === 1 ? width / 2 : (index / (points.length - 1)) * width;
      const y = (height / 2) - ((value / max) * (height / 2 - 2));
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    return `<svg class="zi-spark" viewBox="0 0 ${width} ${height}" role="img" aria-label="daily net movement"><line x1="0" y1="12" x2="92" y2="12"></line><polyline points="${coordinates}"></polyline></svg>`;
  }
  function sourceText(row) {
    const sources = Array.isArray(row.sources) ? row.sources.join(' + ') : (row.source || zoneState.evidence?.source || '');
    return sources || 'source unavailable';
  }
  function freshnessText(row) { return row.drop_date || row.event_date || row.com_availability_checked_at || zoneState.evidence?.freshestObservedAt || ''; }
  function rowFavoriteRecord(row) {
    return {
      key: favoriteKey(row),
      domain: row.domain || '',
      token: row.token || '',
      mode: zoneState.mode,
      score: row.gemScore == null ? '' : row.gemScore,
      source: sourceText(row),
      freshness: freshnessText(row),
    };
  }
  function evidenceText(data) {
    const evidence = data.evidence || {};
    const coverage = evidence.complete ? 'complete source receipts for selected range' : `partial/unknown coverage${evidence.coverage?.reason ? `: ${evidence.coverage.reason}` : ''}`;
    const errors = Array.isArray(evidence.errors) && evidence.errors.length ? ` · unavailable: ${evidence.errors.join('; ')}` : '';
    return `${evidence.source || 'Source unavailable'} · freshest ${compactDate(evidence.freshestObservedAt)} · ${Number(evidence.rowCount || 0).toLocaleString()} observed rows · ${coverage}${errors}`;
  }
  function queryParams() {
    const params = new URLSearchParams({
      mode: zoneState.mode,
      from: el('zi-from').value,
      to: el('zi-to').value,
      limit: el('zi-limit').value || '250',
    });
    const fields = ['keyword', 'keywordMode', 'minLength', 'maxLength', 'wordCount', 'tld'];
    fields.forEach(name => {
      const input = el(`zi-${name}`);
      if (input && input.value) params.set(name, input.value);
    });
    if (el('zi-noHyphens')?.checked) params.set('noHyphens', '1');
    if (el('zi-noNumbers')?.checked) params.set('noNumbers', '1');
    if (el('zi-onlyConfirmed')?.checked) params.set('onlyConfirmed', '1');
    return params;
  }
  function setBusy(busy, message = '') {
    el('zi-load').disabled = busy;
    el('zi-status').textContent = message;
  }
  function renderMovement(rows) {
    el('zi-head').innerHTML = '<tr><th></th><th>Rank</th><th>Token</th><th>Add</th><th>Drop</th><th>Net</th><th>Daily movement</th><th>Evidence</th></tr>';
    el('zi-body').innerHTML = rows.map(row => {
      const change = row.rankChange == null ? 'new' : row.rankChange === 0 ? '—' : `${row.rankChange > 0 ? '↑' : '↓'}${Math.abs(row.rankChange)}`;
      const token = escapeHtml(row.token);
      return `<tr><td>${favoriteButton(row)}</td><td class="zi-num">${row.rank} <small>${change}</small></td><td><button class="zi-link" data-token="${token}" onclick="app.zoneDrillToken(this.dataset.token)">${token}</button><small>${row.domainCount} domains</small></td><td class="zi-num zi-positive">+${row.additions}</td><td class="zi-num zi-negative">-${row.drops}</td><td class="zi-num">${row.net > 0 ? '+' : ''}${row.net}</td><td>${sparkline(row.sparkline)}</td><td><small>${escapeHtml(sourceText(row))}</small></td></tr>`;
    }).join('');
  }
  function renderDrops(rows, gems = false) {
    el('zi-head').innerHTML = `<tr><th></th>${gems ? '<th>Gem score</th>' : ''}<th>Domain</th><th>Drop date</th><th>Availability</th><th>Quality / observed evidence</th><th>Source</th></tr>`;
    el('zi-body').innerHTML = rows.map(row => {
      const availability = row.registration_available === 1 ? 'confirmed available' : row.registration_available === 0 ? 'confirmed unavailable' : 'unknown';
      const evidence = gems ? `${escapeHtml(row.formula)}<br>${escapeHtml((row.evidence || []).join(' · '))}` : escapeHtml(row.quality_reasons || 'quality evidence missing');
      return `<tr><td>${favoriteButton(row)}</td>${gems ? `<td class="zi-num zi-score">${row.gemScore}<small>quality ${row.qualityScore} + observed ${row.observedMarketBonus}</small></td>` : ''}<td><button class="zi-link" data-domain="${escapeHtml(row.domain)}" onclick="app.zoneResearch(this.dataset.domain)">${escapeHtml(row.domain)}</button></td><td>${compactDate(row.drop_date)}</td><td><span class="zi-state ${availability.replace(/ /g, '-')}">${availability}</span><small>${escapeHtml(row.availability_source || 'evidence missing')}</small></td><td><small>${evidence}</small></td><td><small>${escapeHtml(row.source || 'source unavailable')}</small></td></tr>`;
    }).join('');
  }
  function renderGaps(rows) {
    el('zi-head').innerHTML = '<tr><th></th><th>Domain</th><th>.com state</th><th>Coverage evidence</th><th>Drop source</th></tr>';
    el('zi-body').innerHTML = rows.map(row => `<tr><td>${favoriteButton(row)}</td><td><button class="zi-link" data-domain="${escapeHtml(row.domain)}" onclick="app.zoneResearch(this.dataset.domain)">${escapeHtml(row.domain)}</button></td><td><span class="zi-state ${row.comState}">${escapeHtml(row.comState)}</span></td><td><small>${escapeHtml(row.reason)}<br>${escapeHtml(row.coverage?.availabilitySource || 'availability source missing')} · ${compactDate(row.coverage?.availabilityCheckedAt)}</small></td><td><small>${escapeHtml(row.source || 'source unavailable')}</small></td></tr>`).join('');
  }
  function renderLocal(rows) {
    el('zi-head').innerHTML = '<tr><th></th><th>Token</th><th>Occurrences</th><th>Example inputs</th><th>Evidence</th></tr>';
    el('zi-body').innerHTML = rows.map(row => `<tr><td>${favoriteButton(row)}</td><td>${escapeHtml(row.token)}</td><td class="zi-num">${row.count}</td><td><small>${escapeHtml(row.examples.join(' · '))}</small></td><td><small>browser-local file analysis · not uploaded</small></td></tr>`).join('');
  }
  function showFilters() {
    const domainMode = ['drops', 'gems'].includes(zoneState.mode);
    el('zi-domain-filters').hidden = !domainMode;
    el('zi-gap-filters').hidden = zoneState.mode !== 'gaps';
    document.querySelectorAll('.zi-mode').forEach(button => button.classList.toggle('active', button.dataset.mode === zoneState.mode));
  }
  function emptyMessage() {
    return zoneState.evidence?.errors?.length ? 'Source data is unavailable. No rows were synthesized.' : 'No observed rows match this range and filter.';
  }

  const oldHide = app._hideAllToolPanels.bind(app);
  app._hideAllToolPanels = function zoneAwareHide() {
    oldHide();
    el('zone-intelligence-panel').style.display = 'none';
  };
  app._toolPanels.push('_zoneintel');
  const oldSetStream = app.setStream.bind(app);
  app.setStream = function zoneAwareSetStream(stream) {
    if (stream !== '_zoneintel') return oldSetStream(stream);
    state.stream = stream;
    document.querySelectorAll('.stream-tab').forEach(tab => tab.classList.toggle('active', tab.dataset.stream === stream));
    app._hideAllToolPanels();
    document.querySelector('.toolbar').style.display = 'none';
    document.getElementById('table-wrap').style.display = 'none';
    document.querySelector('.pagination').style.display = 'none';
    el('zone-intelligence-panel').style.display = 'block';
    if (!zoneState.rows.length) app.zoneLoad();
  };

  app.zoneSetMode = function zoneSetMode(mode) {
    zoneState.mode = mode;
    zoneState.selectedToken = '';
    el('zi-drill').hidden = true;
    showFilters();
    app.zoneLoad();
  };
  app.zoneLoad = async function zoneLoad() {
    setBusy(true, 'Loading observed evidence…');
    try {
      const response = await fetch(`/api/zone-intelligence?${queryParams()}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `request failed (${response.status})`);
      zoneState.rows = data.rows || [];
      zoneState.range = data.range;
      zoneState.evidence = data.evidence || null;
      el('zi-evidence').textContent = evidenceText(data);
      el('zi-empty').hidden = zoneState.rows.length > 0;
      el('zi-empty').textContent = emptyMessage();
      if (zoneState.mode === 'movement') renderMovement(zoneState.rows);
      else if (zoneState.mode === 'drops') renderDrops(zoneState.rows, false);
      else if (zoneState.mode === 'gems') renderDrops(zoneState.rows, true);
      else renderGaps(zoneState.rows);
      setBusy(false, `${zoneState.rows.length.toLocaleString()} rows · ${data.range.from} to ${data.range.to}`);
    } catch (error) {
      zoneState.rows = [];
      el('zi-body').innerHTML = '';
      el('zi-empty').hidden = false;
      el('zi-empty').textContent = `Data unavailable: ${error.message}. No rows were synthesized.`;
      el('zi-evidence').textContent = 'Network-backed evidence unavailable.';
      setBusy(false, 'Unavailable');
    }
  };
  app.zoneDrillToken = async function zoneDrillToken(token) {
    zoneState.selectedToken = token;
    const params = queryParams();
    params.set('mode', 'token-domains');
    params.set('token', token);
    el('zi-drill').hidden = false;
    el('zi-drill-title').textContent = `Observed domains for “${token}”`;
    el('zi-drill-body').textContent = 'Loading…';
    try {
      const response = await fetch(`/api/zone-intelligence?${params}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'request failed');
      el('zi-drill-body').innerHTML = (data.rows || []).map(row => `<button data-domain="${escapeHtml(row.domain)}" onclick="app.zoneResearch(this.dataset.domain)">${escapeHtml(row.domain)}</button><small>${escapeHtml(row.kind)} · ${compactDate(row.event_date)} · ${escapeHtml(row.source || 'source unavailable')}</small>`).join('') || '<small>No observed domains in range.</small>';
    } catch (error) { el('zi-drill-body').textContent = `Evidence unavailable: ${error.message}`; }
  };
  app.zoneToggleFavorite = function zoneToggleFavorite(key) {
    const matches = [...zoneState.rows, ...zoneState.localRows].filter(row => favoriteKey(row) === key);
    let stored = favorites();
    if (stored.some(row => row.key === key)) stored = stored.filter(row => row.key !== key);
    else if (matches[0]) stored.push(rowFavoriteRecord(matches[0]));
    saveFavorites(stored);
    if (zoneState.localRows.length && zoneState.mode === 'local') renderLocal(zoneState.localRows);
    else if (zoneState.mode === 'movement') renderMovement(zoneState.rows);
    else if (zoneState.mode === 'drops') renderDrops(zoneState.rows, false);
    else if (zoneState.mode === 'gems') renderDrops(zoneState.rows, true);
    else renderGaps(zoneState.rows);
    el('zi-favorite-count').textContent = stored.length;
  };
  app.zoneExport = function zoneExport() {
    const rows = favorites();
    if (!rows.length) return app.showToast('No local Zone Intelligence favorites to export');
    downloadCsv('domainscout-zone-favorites.csv', rows);
  };
  app.zoneResearch = function zoneResearch(domain) {
    const base = String(domain || '').toLowerCase().split('.')[0];
    app.setStream('_research');
    el('research-prefix').value = base;
    app.setResearchMode('prefix');
    app.runResearch();
  };
  app.zoneReadLocal = async function zoneReadLocal(input) {
    const file = input.files && input.files[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { app.showToast('Choose a CSV or TXT file smaller than 5 MB'); return; }
    const text = await file.text();
    const counts = new Map();
    const candidates = text.split(/[\s,;"']+/).map(value => value.trim().toLowerCase()).filter(Boolean);
    for (const candidate of candidates) {
      const host = candidate.replace(/^https?:\/\//, '').split('/')[0];
      const base = host.includes('.') ? host.split('.')[0] : host;
      const tokens = base.replace(/[^a-z0-9-]/g, '').split(/-+/).filter(token => /^[a-z]{2,}$/.test(token));
      for (const token of tokens) {
        if (!counts.has(token)) counts.set(token, { token, count: 0, examples: [], source: 'browser-local file', freshness: new Date().toISOString(), mode: 'local' });
        const row = counts.get(token);
        row.count += 1;
        if (row.examples.length < 3 && !row.examples.includes(candidate)) row.examples.push(candidate);
      }
    }
    zoneState.mode = 'local';
    zoneState.localRows = [...counts.values()].sort((a, b) => b.count - a.count || a.token.localeCompare(b.token));
    zoneState.rows = [];
    showFilters();
    renderLocal(zoneState.localRows);
    el('zi-empty').hidden = zoneState.localRows.length > 0;
    el('zi-empty').textContent = 'No supported tokens found in this local file.';
    el('zi-evidence').textContent = `${file.name} · ${file.size.toLocaleString()} bytes · analyzed only in this browser; no upload request was made`;
    el('zi-status').textContent = `${zoneState.localRows.length.toLocaleString()} local tokens`;
    input.value = '';
  };

  const today = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10);
  el('zi-from').value = from;
  el('zi-to').value = today;
  el('zi-favorite-count').textContent = favorites().length;
  showFilters();
})();
