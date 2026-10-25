# Reproducible movement reports

`node scripts/build-movement-report.js` builds a searchable HTML report and a streamed JSON index with source and coverage receipts. DNS changes and reported transactions are distinct observation types. Buyer appeal is a hypothesis; unknown motives stay unknown.

Use `--hours 72` for a rolling window, or `--from YYYY-MM-DD --through YYYY-MM-DD` for a calendar range. `--discovery source.json` and `--out output-directory` are required. Optional inputs are `--reported-sales`, `--prior-indexes` (comma-separated paths), `--site-observations`, `--reviews` (domain, analysis and optional original review time as TSV), and `--hypotheticals` (JSON examples excluded from record counts).

For recurring archive-backed reports, add `--audience internal --archive-cache cache-directory` in the existing configured evidence-store runtime. This reads the published completed-capture pointer, follows its immutable baseline links, verifies each selected movement object, and reuses hash-verified cached files. `--movement-tapes receipts.json` can provide existing verified file locations to avoid downloads; its hashes are checked again. Source preparation is included in the report receipt. No fixed tape-count or page limit is imposed.

Completed captures before the exact rolling-window start remain coverage evidence but their old movements are not imported. Missing days, nonconsecutive baselines, inaccessible research extensions and partial source visibility remain explicit gaps. A complete archive capture is not a complete transaction feed. Repeated checks of the same dated DNS state are merged; distinct days or before/after states remain inspectable. Changes between captures cannot be reconstructed without evidence.

The command returns exit code 2 when the research coverage gate is incomplete, while retaining a readable partial report. Use `--allow-partial` only to deliberately accept that status; it never changes the coverage claims. Input, archive integrity, authentication and rendering failures return 1. The last successful report is preserved when rendering fails. Account-licensed and zone-archive inputs require an internal report and must not enter a public artifact lineage.

The report exposes individual semantic reviews, preliminary automated naming hypotheses and unresolved readings separately. An unbuilt domain can have plausible naming appeal without buyer or operating-site evidence. Hypothetical examples must remain separate from trends and sales totals.


Removed delegations retain their original nameservers as `kind: dropped`, with an empty destination and no inferred sale, expiry, or registration status. New capture receipts explicitly declare `retainsAllRemovedDelegations`; daily completeness requires both changed and removed delegation retention. Legacy captures without this proof remain partial. Removal tape imports verify the declared raw dropped count separately from seller/parking rows selected for the report. An empty destination never forms a learned migration cohort.

`server/movement-removal-recovery.js` reconstructs historical removed rows from hash-verified archived inputs without materializing a full zone snapshot locally. It either merge-joins a complete drop list with the original baseline or compares both snapshots when a legacy drop list omitted additional label levels. Every input is drained to EOF for integrity verification, every declared removal must be recovered, and failed output stays unpublished. Original capture/source times remain separate from reconstruction time. These inputs retain organization-only access.


For a supervised recurring build, use `node scripts/run-movement-report.js --config /absolute/path/config.json`. The configuration supplies absolute `discoveryPath`, `outputRoot`, and `archiveCacheDir` paths. Optional fields are `environmentFile`, `stateRoot`, `reportedSalesPath`, `reviewsPath`, `hypotheticalsPath`, `siteObservationsPath`, `priorIndexPaths`, `hours` (default 72), and `timeoutMs`. Existing device-stored evidence connections can be referenced from the environment file; never put credentials in the configuration or command arguments.

The runner uses the existing refresh-lease primitive to avoid overlapping builds, skips while a zone capture is active, and retains the previous successful `latest-built.json` pointer on failure. A shared `stateRoot` preserves these guarantees when each execution uses a different scratch output directory. It losslessly compresses the streamed index and verifies its complete restored byte count and SHA-256 before deleting the plain working file. Its `built` status means construction finished; publication, recipient access, and inbox delivery require their own acceptance evidence. Partial source coverage stays partial.


### Browser memory acceptance

Run the generated standalone HTML under a specified browser heap budget before
publishing a large report. The check exercises exact-name and broad searches,
zero-result searches, reset, pagination and an optional hypothetical section.
It fails on renderer crashes, runtime errors, incorrect counts or page overflow.
It retains screenshots and a receipt bound to the exact HTML SHA-256.

Run `node scripts/check-movement-report-browser.js --config /absolute/check.json`.
The JSON configuration requires absolute `reportPath`, `executablePath` (Chromium),
`outputDirectory`, the audited `expectedTotal`, and a `queries` array. Each query
has `query` and either `expectedCount` or `minimumCount`; `expectedText` optionally
checks visible result evidence. Optional `hypothetical` has `label` and
`expectedText`. `heapMb` defaults to 512; `timeoutMs` defaults to 60000 per
viewport. Default viewports are 1440×900 and 390×844; `viewports` is configurable.
No network resources are loaded by this offline acceptance check. Production
access, privacy and live-link behavior require their own verification.

Search normalization is transient. A corpus-sized lowercase cache previously
allowed a report to load but exhausted a constrained renderer during the first
search. Keep the real full-report browser acceptance separate from small unit
fixtures; a successful initial render alone does not verify interactive use.
