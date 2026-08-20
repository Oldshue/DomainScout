'use strict';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

function renderPrefixReport({ prefix, coverage, rows, generatedAt = new Date().toISOString() }) {
  const names = Array.isArray(rows) ? rows : [];
  const hits = Number(coverage?.hits) || names.reduce((sum, row) => sum + (Number(row.tld_count) || 0), 0);
  const top = names.slice(0, 50);
  const title = `DomainScout ${prefix} universe — ${names.length.toLocaleString('en-US')} names across ${Number(coverage?.total_tlds || 0).toLocaleString('en-US')} zones`;
  const tableRows = top.map(row => `<tr><td>${escapeHtml(row.base_name)}</td><td>${Number(row.tld_count) || 0}</td><td>${escapeHtml((row.tld_list || []).join(', '))}</td></tr>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>body{font:16px system-ui;max-width:1100px;margin:40px auto;padding:0 20px;color:#171717}h1{font-size:28px}.facts{display:flex;gap:24px;flex-wrap:wrap}.fact{padding:14px 18px;background:#f3f5f7;border-radius:10px}.fact b{display:block;font-size:24px}table{width:100%;border-collapse:collapse;margin-top:24px}th,td{text-align:left;padding:10px;border-bottom:1px solid #ddd}th:nth-child(2),td:nth-child(2){text-align:right}.proof{margin-top:28px;padding:16px;border-left:4px solid #1f7a4d;background:#eef8f2}code{overflow-wrap:anywhere}</style></head><body><h1>${escapeHtml(prefix)} exact extension universe</h1><p>Deterministic descending counts from every ICANN CZDS zone accessible to this DomainScout account. Unknown or failed sources cannot publish as complete.</p><div class="facts"><div class="fact"><b>${names.length.toLocaleString('en-US')}</b>distinct names</div><div class="fact"><b>${hits.toLocaleString('en-US')}</b>registrations</div><div class="fact"><b>${Number(coverage?.checked_tlds || 0).toLocaleString('en-US')} / ${Number(coverage?.total_tlds || 0).toLocaleString('en-US')}</b>zones checked</div></div><div class="proof"><strong>Complete:</strong> ${coverage?.complete === true ? 'yes' : 'no'} · <strong>Failures:</strong> ${Number(coverage?.failed_tlds || 0)} · <strong>Run:</strong> <code>${escapeHtml(coverage?.runId || 'unknown')}</code> · <strong>Finished:</strong> ${escapeHtml(coverage?.last_finished_at || generatedAt)}</div><h2>Top names by registered extensions</h2><table><thead><tr><th>Base name</th><th>Extensions</th><th>Observed TLDs</th></tr></thead><tbody>${tableRows}</tbody></table><p>Generated ${escapeHtml(generatedAt)}. Counts describe the declared accessible-zone universe, not TLDs whose registries do not provide zone access.</p></body></html>`;
}

module.exports = { renderPrefixReport };
