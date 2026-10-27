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

- The feed only includes sites classified `built` that are not in a kit and have a real title. Results are ordered newest day first, then by domain. `q` matches the domain or title case-insensitively. `zone` is an exact extension match (`si` never matches `site`). `total` counts after all filters. The response also carries `zones`: up to 50 `{zone,count}` entries for the window (with `q` applied, ignoring `zone`), most sites first.
- `nextCursor` is opaque and tied to the query. Pass it back unchanged with the same `q` and `zone`. `null` means the end of the feed.
- Errors return a non-200 status with `{"error"}`: 400 for invalid parameters or cursor, 429 with `Retry-After` when rate-limited, 503 when the observation store can't be read.
- The route needs no authentication. The auth gate admits only GET and OPTIONS on exactly `/api/public/live-sites`. Responses send `Access-Control-Allow-Origin: *` and `Cache-Control: public, max-age=60`. Each client is limited to `DOMAINSCOUT_LIVE_SITES_RATE_LIMIT` requests per minute (default 120), keyed on the `X-Real-IP` header (which Railway's edge overwrites with the connecting client's address), falling back to the socket's remote address when it is absent. `X-Forwarded-For` is never read for this decision, so a caller-supplied value cannot dodge the limit.
- The feed exposes only the fields above. It never returns nameservers, providers, internal classes or any other DomainScout data.

## Prod requirements

- `DOMAINSCOUT_UNIVERSE_PULL_ENABLED=1` (already set for the cloud lane) or `DOMAINSCOUT_LIVE_SITES_ENABLED=1`.
- The persistent data volume at `RAILWAY_VOLUME_MOUNT_PATH` with room for about 25 MB per day of observations.
- Outbound HTTP and HTTPS egress from the service.
