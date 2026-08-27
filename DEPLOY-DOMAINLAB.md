# Deploy: DomainLab (cross-zone trending-terms analysis)

Target: `/Users/hamp/DomainScout`, port 51551.

## 1. Pull the branch
```bash
cd /Users/hamp/DomainScout
git fetch origin domainlab
git checkout domainlab
git pull origin domainlab
```

## 2. Sanity-check the changed server-side files
```bash
node -c server/domainlab.js
node -c server/index.js
node -c scrapers/czds.js
node --check public/js/domainlab.js
```
All four must exit 0 before restarting the service.

## 3. Run the relevant tests
```bash
node --test tests/domainlab.test.js
node --test tests/czds-maintenance-responsiveness.test.js
```
`tests/domainlab.test.js` covers the new `/api/domainlab/*` routes (11/11 passing at authoring time). `tests/czds-maintenance-responsiveness.test.js` covers the `scrapers/czds.js` skip-set fix that unblocked `zone_keyword_trends` capture.

## 4. Restart the service
Restart whatever process manager runs the app on port 51551 (e.g. `pm2 restart domainscout` or the equivalent supervisor reload) so the new `server/domainlab.js` routes and the updated `public/index.html` / `public/js/domainlab.js` / `public/css/app.css` are served.

## 5. Index migration: `idx_zone_daily_stats_date`
No manual step is strictly required — the index is auto-created on the first DomainLab request. To pre-build it once (recommended before/at a high-traffic cutover, so the first request isn't slow):
```bash
sqlite3 data/zone_index.db "CREATE INDEX IF NOT EXISTS idx_zone_daily_stats_date ON zone_daily_stats(stat_date, tld);"
```

## 6. Root cause: why `zone_keyword_trends` had a capture gap
The original zone-indexer pipeline had a bug that stalled `zone_keyword_trends` capture: the CZDS skip-set was keyed on "indexed today" instead of "ever indexed," so once a TLD zone file had been indexed once in a run, subsequent legitimate re-indexing needed to populate `zone_keyword_trends` for later days could be skipped incorrectly. The fix (already committed to this branch, in `scrapers/czds.js`) rekeys the skip-set on ever-indexed status so keyword-trend capture runs correctly going forward. This fix only prevents *future* gaps — it does not retroactively produce data for days that were already skipped.

## 7. Honest backfill assessment — NO backfill is possible for 2026-08-15..today
A backfill of `zone_keyword_trends` for the gap window (2026-08-15 through today) from retained zone files is **not feasible**, and no attempt was made to fabricate one:

- `zone-indexer.js`'s `indexZoneStream()` deletes every zone file (`fs.unlinkSync`) immediately after indexing.
- `czds.js`'s `cleanOldZones()` additionally retains only 1 day of files per TLD.
- As a result, no raw daily zone snapshots survive on disk for the gap window.
- `zone_keyword_trends` and `zone_keyword_tld_history` are themselves the *only* record of which specific base names were newly added to which TLDs on a given day. Once a day's diff wasn't captured (due to the bug above), that per-day detail is genuinely gone — there is no alternate source to reconstruct it from.

**Recommended verification step before relying on the fix in production:**
```bash
ls -la data/zones/
```
Run this on the production machine to confirm no unexpectedly-retained files exist from the 2026-08-15..today window. It is expected to find none (per the deletion/cleanup logic above); if a supervisor crashed mid-run before its own cleanup ran, a recoverable file could theoretically still be sitting there, so this check is worth doing once rather than assumed. If none are found — the expected outcome — accept the gap as permanent and rely on the UI's `dataThrough` / anchor-date banner (rendered by `public/js/domainlab.js` via `dl-evidence` / `dl-zones-through`) to show the coverage honestly, rather than fabricating or interpolating values for the missing window.
