# Reproducible movement reports

`node scripts/build-movement-report.js` builds a searchable HTML report and a streamed JSON index with source and coverage receipts. DNS changes and reported transactions are distinct observation types. Buyer appeal is a hypothesis; unknown motives stay unknown.

Use `--hours 72` for a rolling window, or `--from YYYY-MM-DD --through YYYY-MM-DD` for a calendar range. `--discovery source.json` and `--out output-directory` are required. Optional inputs are `--reported-sales`, `--prior-indexes` (comma-separated paths), `--site-observations`, `--reviews` (domain, analysis and optional original review time as TSV), and `--hypotheticals` (JSON examples excluded from record counts).

For recurring archive-backed reports, add `--audience internal --archive-cache cache-directory` in the existing configured evidence-store runtime. This reads the published completed-capture pointer, follows its immutable baseline links, verifies each selected movement object, and reuses hash-verified cached files. `--movement-tapes receipts.json` can provide existing verified file locations to avoid downloads; its hashes are checked again. Source preparation is included in the report receipt. No fixed tape-count or page limit is imposed.

Completed captures before the exact rolling-window start remain coverage evidence but their old movements are not imported. Missing days, nonconsecutive baselines, inaccessible research extensions and partial source visibility remain explicit gaps. A complete archive capture is not a complete transaction feed. Repeated checks of the same dated DNS state are merged; distinct days or before/after states remain inspectable. Changes between captures cannot be reconstructed without evidence.

The command returns exit code 2 when the research coverage gate is incomplete, while retaining a readable partial report. Use `--allow-partial` only to deliberately accept that status; it never changes the coverage claims. Input, archive integrity, authentication and rendering failures return 1. The last successful report is preserved when rendering fails. Account-licensed and zone-archive inputs require an internal report and must not enter a public artifact lineage.

The report exposes individual semantic reviews, preliminary automated naming hypotheses and unresolved readings separately. An unbuilt domain can have plausible naming appeal without buyer or operating-site evidence. Hypothetical examples must remain separate from trends and sales totals.
