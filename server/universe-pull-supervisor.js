"use strict";
const path = require("node:path");
const { spawn } = require("node:child_process");
const { createRefreshLeaseManager } = require("./refresh-lease");
const {
  expectedDay,
  atomicJson,
  readJson,
  materialized,
} = require("./universe-puller");
function createUniverseSupervisor({
  dataDir,
  universeDir,
  env = process.env,
  spawnImpl = spawn,
  leaseManager,
  killImpl = (pid, signal) => process.kill(pid, signal),
  now = () => new Date(),
} = {}) {
  const leases =
    leaseManager ||
    createRefreshLeaseManager({ root: path.join(dataDir, "refresh-leases") });
  const healthPath = path.join(dataDir, "universe", "health.json");
  let child = null;
  const policy = {
    maxHeartbeatAgeMs: 5 * 60000,
    terminationGraceMs: 10000,
    maxRunAgeMs: Number(env.DOMAINSCOUT_UNIVERSE_RUN_TIMEOUT_MS) || 6 * 3600000,
  };
  async function health() {
    const h = (await readJson(healthPath).catch((e) => ({
      status: "failed",
      alerts: [e.message],
    }))) || { status: "unknown", alerts: ["Universe lane has not run yet"] };
    const record = h.lastRun?.day ? await readJson(path.join(dataDir, "universe", "pull", h.lastRun.day + ".json")).catch(() => null) : null;
    const requiredZones = require('./registration-coverage').researchZones(env.DOMAINSCOUT_RESEARCH_ZONES);
    const inventory = new Set(record?.inventory || []);
    const successful = new Set((record?.zones || []).map(z => z.tld));
    const missingZones = requiredZones.filter(z => !inventory.has(z));
    const pendingZones = requiredZones.filter(z => inventory.has(z) && !successful.has(z));
    const researchCoverage = {
      scope: 'configured_zone_account', requiredZones, missingZones, pendingZones,
      complete: !!record && h.status === 'ok' && h.lastCompleteDay === expectedDay(now()) && !missingZones.length && !pendingZones.length,
      globalComplete: false,
      notice: 'Collection health covers the configured zone account only. Missing research zones require an additional dated source; download success does not establish market coverage or end-user demand.',
    };
    const lease = leases.inspect("zone-universe", policy);
    return {
      ...h,
      researchCoverage,
      ...(!lease && h.status === "running"
        ? {
            status: "failed",
            retryable: true,
            alerts: [
              ...(h.alerts || []),
              "Interrupted worker; saved zones will resume automatically",
            ],
          }
        : {}),
      worker: lease
        ? {
            pid: lease.pid,
            heartbeatAt: lease.heartbeatAt,
            reaping: !!lease.reaping,
          }
        : null,
      stale: h.lastCompleteDay !== expectedDay(now()),
      nextCheckWithinSeconds: 300,
    };
  }
  async function runDay({ day = expectedDay(now()) } = {}) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day !== expectedDay(now()))
      throw new Error(
        "Live registry downloads require the current expected source day",
      );
    if (leases.inspect("zone-universe", policy)) return { skipped: "running" };
    const record = await readJson(
      path.join(dataDir, "universe", "pull", day + ".json"),
    ).catch(() => null);
    if (
      record?.schema === "domainscout.zone-universe/v2" &&
      materialized(record, dataDir, universeDir)
    )
      return { skipped: "complete", day };
    let lease;
    try {
      lease = leases.reserve("zone-universe", { day });
    } catch (e) {
      if (e.code === "EEXIST") return { skipped: "running" };
      throw e;
    }
    try {
      child = spawnImpl(
        process.execPath,
        [path.join(__dirname, "universe-pull-worker.js"), day],
        {
          detached: true,
          env: {
            ...env,
            DOMAINSCOUT_DATA_DIR: dataDir,
            DOMAINSCOUT_UNIVERSE_DIR: universeDir,
            DOMAINSCOUT_REFRESH_LEASE_PATH: lease.filePath,
            DOMAINSCOUT_REFRESH_LEASE_TOKEN: lease.token,
          },
          stdio: ["ignore", "inherit", "inherit"],
        },
      );
      leases.activate("zone-universe", lease.token, child.pid, {
        processGroup: true,
      });
      const current = child;
      // Bound the entire process tree, including native sorts and stalled SDKs.
      // A killed worker retains per-zone receipts; the next scheduled pass resumes.
      const timer = setTimeout(
        () => {
          try {
            killImpl(-current.pid, "SIGKILL");
          } catch {}
        },
        Number(env.DOMAINSCOUT_UNIVERSE_RUN_TIMEOUT_MS) || 6 * 3600000,
      );
      timer.unref?.();
      let finished = false;
      const finish = async (error) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (child === current) child = null;
        if (error) {
          const h = (await readJson(healthPath).catch(() => null)) || {};
          await atomicJson(healthPath, {
            ...h,
            status: "failed",
            retryable: true,
            alerts: [...(h.alerts || []), error],
            lastRun: {
              ...h.lastRun,
              error,
              finishedAt: new Date(now()).toISOString(),
            },
          }).catch(() => {});
        }
        leases.release("zone-universe", lease.token);
      };
      current.once("error", (e) => {
        finish(e.message);
      });
      current.once("exit", (code, signal) => {
        finish(
          code === 0
            ? null
            : `Universe worker exited ${signal || code}; saved zones will resume automatically`,
        );
      });
      return { started: true, day, pid: current.pid };
    } catch (e) {
      if (child?.pid) {
        try {
          killImpl(-child.pid, "SIGKILL");
        } catch {}
      }
      child = null;
      leases.release("zone-universe", lease.token);
      throw e;
    }
  }
  return {
    runDay,
    retryIncomplete: () => runDay(),
    health,
    isRunning: () => !!leases.inspect("zone-universe", policy),
  };
}
module.exports = { createUniverseSupervisor };
