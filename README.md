# DomainScout


### Reproducible movement reporting

Run `node scripts/build-movement-report.js --discovery <immutable-discovery.json> --from YYYY-MM-DD --through YYYY-MM-DD --out <report-directory>` after collecting source evidence. Optional `--manifests <comma-separated-complete-manifest-paths>` attaches dated full-zone receipts. Optional `--reviews <domain-tab-analysis.tsv>` supplies analyst semantic hypotheses; `--hypotheticals <cases.json>` keeps illustrative cases outside observed rows and totals.

The command writes `index.json`, `coverage.json`, `receipt.json` and a searchable mobile `report.html`. Preserve the input bytes with the receipt's SHA-256. Search, classification filters and JSON export operate on the whole retained index; display pagination does not truncate it. Repeated departures are keyed by domain, source day and normalized before/observed-destination nameserver sets. Destination probes are later observations, not necessarily the exact destination at departure.

Incomplete requested-extension daily coverage exits with status 2 after writing the inspectable partial report. Use `--allow-partial` only when deliberately publishing a clearly labelled lower bound. A fresh discovery timestamp, capped public archive, a complete account inventory without requested ccTLDs, or a nonconsecutive baseline never establishes complete market coverage. Public-provider HTTP 429 defers remaining source requests; it does not turn failed sources into empty results. An unbuilt website never prevents semantic review of a captured lead. Semantic appeal and evidence of a purchase remain separate.

For a rolling window use `--hours 72` instead of `--from`/`--through`; `--checked-at <UTC timestamp>` pins a reproducible endpoint. The overlapping boundary calendar day remains included and marked uncertain when the source supplies no intraday timestamp.

Optional `--site-observations <observation-receipts.json>` merges newer website evidence without rewriting the source snapshot. The report re-assesses evidence, retains the separate DNS observation time, and records a digest of the supplemental observations. A failed or unbuilt website does not prove the absence of a purchase.

Use `--prior-indexes <comma-separated-index-paths>` to reconcile earlier immutable normalized indexes. Distinct older destination states remain inspectable as historical observations; they never resurrect superseded sale conclusions or count as independent transactions. Each supplemental index is bound by SHA-256.

Semantic review TSV may include a third UTC timestamp column. Missing review timestamps remain null; rendering an old interpretation never fabricates a fresh analyst-review date.

Full-zone collection streams the hash-verified prior compressed snapshot from object storage rather than staging a second baseline file. `DOMAINSCOUT_UNIVERSE_MATERIALIZE_SUMMARY=0` keeps the complete hashed cloud summary tape and local movement tapes but skips the optional local SQLite summary mirror. The default still materializes that mirror; switching back to the default requires its actual local receipt rather than accepting a cloud-only capture as a local database.
