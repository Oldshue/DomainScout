# Live sites: site observation stage and public feed

FrontierUpdate.com's stream of newly live websites reads from DomainScout's cloud deployment. Railway prod is the system of record; desktop installs are secondary. Two parts make this work:

1. **Site-observation stage** (`server/live-sites.js`, `server/live-sites-stage.js`, `server/live-sites-worker.js`). It fetches the site behind every `went-live` name in a day's nameserver-movement tape and classifies what is there.
2. **Public feed** (`server/live-sites-feed.js`). `GET /api/public/live-sites` is the only unauthenticated data route.

## How the stage is triggered

- **Universe lane completion.** When the cloud pull supervisor publishes a day (`onDayPublished`), the stage gets that day. So does an ns-movement import (`registerUniverseRoutes({ onNsMovementImportComplete })`). This follows the same pattern imports already use to start follow-up work.
- **Backfill cron.** `DOMAINSCOUT_LIVE_SITES_CRON` (default `15 */3 * * *`, UTC) queues the most recent `DOMAINSCOUT_LIVE_SITES_BACKFILL_DAYS` tape days (default 3) that are missing, incomplete or observed by an older classifier version.
- **Boot backfill.** The same backfill also runs 60 seconds after the server starts. Together with the resume journal, this lets a redeploy pick up where the last run stopped.
- The cron and boot backfill are active when `DOMAINSCOUT_UNIVERSE_PULL_ENABLED=1` or `DOMAINSCOUT_LIVE_SITES_ENABLED=1`. Setting `DOMAINSCOUT_LIVE_SITES_ENABLED=0` disables the stage completely.

`trigger()` only adds the day to an in-memory queue and returns synchronously. It never throws and never waits on network work, so the lane is never blocked or slowed. Days run one at a time, newest first, each in a child process (`node server/live-sites-worker.js <day> [--force]`). That process is bounded by `DOMAINSCOUT_LIVE_SITES_RUN_TIMEOUT_MS` (default 4 hours), so the fetch work stays off the API process's event loop. Worker exit codes: 0 means complete, 2 means there is no tape for that day, and 1 means failure.

## What each name gets

For each went-live name the stage fetches `https://<name>/` first and falls back to `http://` if that fails. It works within these limits:

- Concurrency is bounded (`DOMAINSCOUT_LIVE_SITES_CONCURRENCY`, default 48). A rolling error guard watches the last 1,000 observations: if more than 50% are errors (class `error`, which includes timeouts), concurrency is halved for the rest of the day (floor 16) and recorded as `throttle` in the day summary and in `liveSites.days[].throttle` of health.
- A strict per-attempt deadline covers every redirect hop and the body (`DOMAINSCOUT_LIVE_SITES_TIMEOUT_MS`, default 8000).
- Redirects are followed manually, up to `DOMAINSCOUT_LIVE_SITES_MAX_REDIRECTS` (default 5).
- The body is capped at `DOMAINSCOUT_LIVE_SITES_MAX_BYTES` (default 256 KiB).
- Requests send an honest User-Agent that identifies DomainScout (`DOMAINSCOUT_LIVE_SITES_USER_AGENT` overrides it).

It records the final URL, HTTP status, title, and meta or OG description. It then assigns one of these classes: `built`, `parked`, `for_sale`, `placeholder`, `redirect_offsite` or `error`. Classification uses the repo's existing parking and seller nameserver knowledge and lander-host lists (`classifyLander`, `hasParkingClassNameserver`, `websitePurpose`) together with page signals.

**Kit collapse.** Within one day, names that share a page template or skeleton (5 or more, `DOMAINSCOUT_LIVE_SITES_KIT_THRESHOLD`) are marked as one actor's kit. So are names that share a normalised title (8 or more, `DOMAINSCOUT_LIVE_SITES_KIT_TITLE_THRESHOLD`). Kit members never count as distinct built sites. `DOMAINSCOUT_LIVE_SITES_MAX_NAMES` (default 150000) bounds a single day.

## Storage (next to the tape, on the data volume)

```
<universeDir>/<day>/ns/movement.jsonl                 existing tape (input)
<universeDir>/<day>/sites/observations.partial.jsonl  resume journal
<universeDir>/<day>/sites/observations.jsonl          final, kit-collapsed
<universeDir>/<day>/sites/summary.json                status, counts, kits, duration
<dataDir>/universe/live-sites-health.json             last run, last success, failures
```

In prod, `universeDir` sits under `RAILWAY_VOLUME_MOUNT_PATH`, so the files survive redeploys. A day that is already complete under the current classifier version is skipped. A crashed or timed-out run resumes from its journal. Expect roughly 15-25 MB per day of observations.

## Health

`GET /api/universe/health` includes a `liveSites` object with `status` (`ok`, `running`, `failed`, `disabled` or `idle`), `running`, `queued`, `lastRun`, `lastSuccess`, per-day summaries and `alerts`. These alerts are merged into the lane's top-level `alerts`. A failed or timed-out run, an unreadable health file, a stale partial day, and a latest tape day with no complete observation all raise an alert. Failures are never silent.

**Re-observation.** A complete day whose summary error share (`counts.error` / names) is above 90% is stale (`DOMAINSCOUT_LIVE_SITES_REOBSERVE_ERROR_SHARE`; a healthy day's genuine error share is ~70-77%, and the rolling concurrency guard trips above 92%, `DOMAINSCOUT_LIVE_SITES_ERROR_GUARD_THRESHOLD`). A day mid-retry that no longer qualifies is finished normally, and an existing retried mark is kept. The backfill re-observes it once, newest first: successfully observed rows are kept and only the error rows are refetched (`--retry-errors`). The retry is recorded in the health file (`reobservations`) before it is queued and in the day summary (`reobservation`), so a day is never retried twice; health shows `errorShare` and `reobservation` per day.

## Throughput

At 48 concurrent fetches with a typical 1-2 s median response, about 40,000 names take roughly 30-60 minutes. A default of 128 was tried and exhausted the Railway container (resolver/socket limits), turning most fetches into errors; raise it only with evidence that the error share stays low. In the worst case every name hits the 8 s deadline, sometimes on both HTTPS and the HTTP fallback, and the day stays within the 4-hour run timeout. That timeout keeps the journal so the next backfill resumes. Raise `DOMAINSCOUT_LIVE_SITES_CONCURRENCY` to go faster if egress allows.

## Public endpoint contract

```
GET /api/public/live-sites?limit=<1-1000, default 50>&cursor=<opaque>&q=<text>&zone=<extension without dot>
200 {"items":[{"domain","zone","day":"YYYY-MM-DD","title","description"|null,"url","observedAt"}],
     "nextCursor":<opaque>|null, "days":["YYYY-MM-DD", ...],
     "progress":[{"day":"YYYY-MM-DD","status":"queued|running|complete|failed",
                  "checked":<n>,"total":<n>,"kept":<n>,"errors":<n>,"updatedAt":<ISO>|null}]}
```

- `progress` is on every successful response, newest day first, for up to 14 recent days the stage knows about (a tape exists, a summary exists, or a failure is recorded). `items`/`days` only include complete days, so use `progress` to tell "still checking" (`queued`/`running`, with `checked` of `total` advancing) from "broken" (`failed`). `checked`/`total` are name counts; `kept` is the number of publishable sites and is 0 until the day is `complete`. `errors` is the count of error/timeout outcomes (class `error`): the final count once `complete`, the running count while `running`. `updatedAt` is the last summary or failure time, or null. No domains, nameservers, error messages or other internal detail appear.
- It is derived from each day's small `sites/summary.json` (rewritten during the run), the tape's presence and `live-sites-health.json`. It never reads the journal or observations, so it stays cheap and never waits on the stage. A day with a recorded failure and no complete summary is `failed`; an interrupted summary is `failed`; a running summary is `running`; a tape with no summary yet is `queued`. With no state the array is empty.

- The feed only includes sites classified `built` that are not in a kit and have a real title. Results are ordered newest day first, then by domain. `q` matches the domain, title, description or the stored page text case-insensitively. When it matched only the page text, the item also carries `snippet` (about 160 characters around the match), which `/live` shows under the title. `zone` is an exact extension match (`si` never matches `site`). `total` counts after all filters. The response also carries `zones`: up to 50 `{zone,count}` entries for the window (with `q` applied, ignoring `zone`), most sites first.
- **Page text.** Each observation stores `text`: title, meta/OG description, h1-h3 headings (up to 600 chars) and the first 1,500 characters of visible body text (scripts, styles, nav and footer removed, whitespace collapsed), capped at 2,600 characters. It is never a public field. The feed builds one lowercase haystack per row once per cache load. Older rows without `text` still match on domain, title and description; old days are not refetched.
- `nextCursor` is opaque and tied to the query. Pass it back unchanged with the same `q` and `zone`. `null` means the end of the feed.
- Errors return a non-200 status with `{"error"}`: 400 for invalid parameters or cursor, 429 with `Retry-After` when rate-limited, 503 when the observation store can't be read.
- The route needs no authentication. The auth gate admits only GET and OPTIONS on exactly `/api/public/live-sites`. Responses send `Access-Control-Allow-Origin: *` and `Cache-Control: public, max-age=60`. Each client is limited to `DOMAINSCOUT_LIVE_SITES_RATE_LIMIT` requests per minute (default 120), keyed on the `X-Real-IP` header (which Railway's edge overwrites with the connecting client's address), falling back to the socket's remote address when it is absent. `X-Forwarded-For` is never read for this decision, so a caller-supplied value cannot dodge the limit.
- The feed exposes only the fields above. It never returns nameservers, providers, internal classes or any other DomainScout data.

## Near-live launches from Certificate Transparency

The daily stage only sees a name once the next CZDS zone diff lands. The CT launch detector (`server/ct-log.js`, `server/ct-launches.js`, `server/ct-launch-worker.js`) makes the feed show sites minutes after they get a certificate.

**Process.** `createCtLaunchSupervisor` starts one child process (`node server/ct-launch-worker.js`) 20 s after boot, with the same gate as the live-sites stage: on when `DOMAINSCOUT_UNIVERSE_PULL_ENABLED=1` or `DOMAINSCOUT_LIVE_SITES_ENABLED=1`. It is off when `DOMAINSCOUT_LIVE_SITES_ENABLED=0` or `DOMAINSCOUT_CT_LAUNCHES_ENABLED=0`, and `DOMAINSCOUT_CT_LAUNCHES_ENABLED=1` forces it on. A crashed worker is restarted with exponential backoff (30 s up to 10 min). A lock file (`tailer.lock`, with a liveness check) allows only one tailer per data volume. Certificate parsing and homepage fetches therefore never run on the API event loop or in the zone-diff stage.

**Logs.** Chrome's v3 log list (`https://www.gstatic.com/ct/log_list/v3/log_list.json`) is re-read daily. The detector keeps logs in the `usable` state whose temporal shard covers *now + 60 days* (`DOMAINSCOUT_CT_SHARD_OFFSET_DAYS`), because shards are split by certificate expiry. It prefers Let's Encrypt, Google and Cloudflare (`DOMAINSCOUT_CT_OPERATORS`), round-robin, up to `DOMAINSCOUT_CT_MAX_LOGS` (default 6). Both APIs are supported:

- RFC 6962 logs use `ct/v1/get-sth` and `ct/v1/get-entries`.
- C2SP static-ct-api tiled logs use `checkpoint` and `tile/data/<N>[.p/<W>]`, read from the log's monitoring URL.

`DOMAINSCOUT_CT_LOGS` overrides the set. It takes a comma-separated list of `rfc6962:<url>`, `static:<url>` or a description substring.

**Tailing.** The tailer starts at the current tree head (no historical replay). Each log's next index is persisted in `<dataDir>/universe/ct/positions.json` (at most every 2 s, and on stop), so a restart resumes where it left off. If a log falls more than `DOMAINSCOUT_CT_MAX_LAG` entries behind (default 1,000,000), the tailer skips to the head and raises an alert. Limits on request rate:

- Requests per log are paced by `DOMAINSCOUT_CT_REQUEST_INTERVAL_MS` (default 250) and `DOMAINSCOUT_CT_MAX_ENTRIES_PER_SEC` (default 400).
- Batches are `DOMAINSCOUT_CT_BATCH` entries (default 256) or one tile.
- A log that is caught up is polled every `DOMAINSCOUT_CT_POLL_MS` (default 10 s).
- Errors back off exponentially (`DOMAINSCOUT_CT_BACKOFF_MS` 5 s up to `DOMAINSCOUT_CT_BACKOFF_MAX_MS` 5 min), and `Retry-After` is honoured.

**Parsing.** Certificates and precertificates (from `extra_data` or the tile's `pre_certificate`) are parsed with `node:crypto` `X509Certificate`. A minimal DER walker is the fallback for TBS-only input. DNS SANs are reduced to registrable domains: wildcards and subdomains collapse, IP literals are dropped, and common ccTLD second levels such as `co.uk` count as suffixes. The final label check is the observed-zones `registrableName` helper.

**Launch rule.** Each registrable domain is emitted at most once, deduplicated in sqlite (`emitted`, 30-day retention). An in-memory LRU of 100k entries skips repeats cheaply. A domain is a launch when it appears in CT and either of these holds:

- **(a) Zones with zone data.** It was added in `<day>/tape/adds.tsv` within `DOMAINSCOUT_CT_LAUNCH_WINDOW_DAYS` (default 14), or it is a `went-live` row in a recent `ns/movement.jsonl` or `ns-observed/<tld>/movement.jsonl`. A certificate for an older domain (a renewal) is never a launch. The index of recent adds is refreshed from the tapes every 10 minutes and imports each tape only once.
- **(b) Zones without zone files.** This covers `DOMAINSCOUT_CT_ZONELESS_ZONES` (default `ai,io,sh,si`). The domain must be seen in CT for the first time, after `DOMAINSCOUT_CT_WARMUP_DAYS` (default 7) of accumulated tailing time (persisted in `state.json`). The first-seen store is sqlite (`launches.db`), capped at `DOMAINSCOUT_CT_FIRST_SEEN_MAX` rows (default 3M; the oldest are trimmed).

If sqlite is unavailable through better-sqlite3's native binding, the store falls back to Node's built-in `node:sqlite`.

- **(c) Every zone, first CT sighting.** Every registrable domain's first CT sighting is recorded (`seen_any`, a 53-bit hash per domain, capped at `DOMAINSCOUT_CT_SEEN_ANY_MAX`, default 50M). Once that store holds `DOMAINSCOUT_CT_FIRST_SEEN_HISTORY_DAYS` (default 90) days of accumulated tailing history, a domain seen for the first time counts as a launch, because certificate renewals cycle within that window. Before then the rule is off, and health shows `firstSeen.daysRemaining`. Downtime does not count toward the history. A trim at the cap shortens the history to the trim point and raises an alert while it is below 90 days. Zone-less zones keep rule (b).

**Launch source.** Every observation row carries `launchSource`: `zone-diff` (daily stage), `ct-recent-registration` (rule a) or `ct-first-seen` (rules b and c). Health counts launches per source in `counters.sources`.

**Observation and journal.** Each launch goes through the existing `fetchSite` and `classifyObservation` with bounded concurrency (`DOMAINSCOUT_CT_OBSERVE_CONCURRENCY`, default 8) and a bounded queue (`DOMAINSCOUT_CT_MAX_QUEUE`, default 5000). A full queue drops the launch and raises an alert. A non-built first look is rechecked once after `DOMAINSCOUT_CT_RECHECK_MS` (default 20 min), because a certificate often comes before the site. Each result is appended, one serialized append at a time, to `<universeDir>/<UTC day>/sites/ct-launches.jsonl` with `observedAt = now`, `source: "ct"`, `rule`, `ctLog` and `ctSeenAt`. The CT worker is the only writer of that file, and the daily stage never touches it, so the two never contend. The feed merges it with the day's `observations.jsonl`/`partial` (daily rows win on duplicates) under the unchanged filter (built, real title, not spam, not a kit) and the same repeated-title kit guard.

**Health.** `GET /api/universe/health` → `liveSites.ctLaunches` includes:

- each log's `position`, `treeSize`, `lag`, error counts and last error;
- launches total and last hour, with an hourly histogram;
- observer queue and class counts;
- warm-up progress, recent errors, and the memory in use (RSS, heap, memo size).

Alerts are raised for a stale health file, no logs, repeated log errors, large lag, skipped entries, dropped launches, zone-index failures and a dead worker; they are merged into the top-level `alerts`. The public feed adds `live: {status: live|starting|degraded|stale|off, lastLaunchAt, launchesLastHour, warmingUp}` (no domains or errors), and `/live` shows "live: last launch N min ago".

**Expected volume and resources (estimates, not yet measured in prod).** Six preferred logs carry on the order of 50-300 entries/s combined, under the 400/s per-log cap. That is about 0.2-1M entries/hour, nearly all for domains that are not new. With roughly 100-150k recent adds per day in the zone tapes, expect a few hundred to about 2,000 launch candidates per hour. With the daily stage's observed built share of about 10-25%, that is a few dozen to a few hundred publishable sites per hour. The first-seen rule for `.ai/.io/.sh/.si` adds nothing during the first 7 days. Expected footprint: about 80-150 MB RSS (LRU memo of 100k entries plus parse buffers for one batch per log), CPU of a few percent of a core at these rates, sqlite on the order of 100-300 MB at the 3M first-seen cap, and journals of well under 1 MB per day. The all-zone first-seen store (rule c) is larger: about 40-60 bytes per row with its index, so roughly 2-3 GB at the default 50M-row cap (estimate, not measured); lower DOMAINSCOUT_CT_SEEN_ANY_MAX on a small volume, accepting that a trim shortens the 90-day history.

State files: `<dataDir>/universe/ct/{positions.json,state.json,launches.db,health.json,tailer.lock}`.

## Prod requirements

- `DOMAINSCOUT_UNIVERSE_PULL_ENABLED=1` (already set for the cloud lane) or `DOMAINSCOUT_LIVE_SITES_ENABLED=1`.
- The persistent data volume at `RAILWAY_VOLUME_MOUNT_PATH` with room for about 25 MB per day of observations.
- Outbound HTTP and HTTPS egress from the service (CT logs at ct.googleapis.com, ct.cloudflare.com, *.ct.letsencrypt.org and www.gstatic.com for the log list).
- Room on the data volume for the CT state (<dataDir>/universe/ct, up to a few hundred MB at the first-seen cap).
