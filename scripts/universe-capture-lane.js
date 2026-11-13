#!/usr/bin/env node
"use strict";
// Runs the daily universe capture on a host other than the web deployment.
// The capture host downloads the registry zones, stores the immutable source
// receipts and publishes the day to the shared evidence store. The web
// deployment sets DOMAINSCOUT_UNIVERSE_PULL_DEFER_MINUTES, materializes the
// published day from the store, and captures by itself only when this host
// has not published before the window closes.
//
// Safe to start on any interval: it exits at once outside the capture window,
// when the day is already published by this host, or when a run is active.
const fs = require("node:fs");
const path = require("node:path");
const { createUniversePuller, expectedDay } = require("../server/universe-puller");

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function plan({ now = new Date(), windowMinutes = 170, state = null } = {}) {
  const day = expectedDay(now);
  const opens = Date.parse(day + "T07:00:00Z") + 5 * 60000;
  const closes = Date.parse(day + "T07:00:00Z") + windowMinutes * 60000;
  if (state?.day === day && state.complete) return { day, run: false, reason: "published" };
  if (now.getTime() < opens) return { day, run: false, reason: "before-window" };
  // A capture that cannot finish before the window closes would overlap the
  // web deployment's own attempt; leave the day to that host instead.
  if (now.getTime() >= closes - 20 * 60000) return { day, run: false, reason: "window-closed" };
  return { day, run: true, closes };
}

function holdLock(file) {
  try {
    const pid = Number(fs.readFileSync(file, "utf8"));
    if (pid && pid !== process.pid) {
      try { process.kill(pid, 0); return false; } catch (error) { if (error.code !== "ESRCH") return false; }
    }
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  fs.writeFileSync(file, String(process.pid));
  return true;
}

// A connection the registry or the evidence store drops mid-transfer can
// surface as an 'error' event on a socket nobody is listening to any more.
// The transfer it belonged to already fails and retries through its own
// promise, so that event must not end the whole capture (2026-11-13: a late
// EPIPE killed a run holding 1,037 of 1,069 zones).
const STRAY_SOCKET_CODES = new Set(["EPIPE", "ECONNRESET", "ETIMEDOUT", "ECONNABORTED", "ENETDOWN", "ENETUNREACH", "EHOSTUNREACH", "ERR_SOCKET_CLOSED", "UND_ERR_SOCKET"]);
function isStraySocketError(error) {
  return !!error && STRAY_SOCKET_CODES.has(error.code) && !!(error.syscall || /socket/i.test(String(error.message)) || error.code.startsWith("UND_"));
}

// launchd appends both streams to one file; without a time on each line a
// slow night cannot be told from a stuck one.
function stampLogs(target = console) {
  for (const level of ["log", "error", "warn"]) {
    const original = target[level].bind(target);
    target[level] = (...args) => original(new Date().toISOString(), ...args);
  }
}

async function main() {
  stampLogs();
  process.on("uncaughtException", (error) => {
    if (isStraySocketError(error)) {
      console.error("[CaptureLane] ignored dropped connection: " + error.code + " " + (error.syscall || ""));
      return;
    }
    console.error("[CaptureLane] fatal: " + (error?.stack || error));
    try { fs.unlinkSync(path.join(process.env.DOMAINSCOUT_DATA_DIR || "", "capture-lane.pid")); } catch {}
    process.exit(1);
  });
  const dataDir = process.env.DOMAINSCOUT_DATA_DIR;
  if (!dataDir) throw Error("DOMAINSCOUT_DATA_DIR is required");
  const universeDir = process.env.DOMAINSCOUT_UNIVERSE_DIR || path.join(dataDir, "universe");
  fs.mkdirSync(dataDir, { recursive: true });
  const statePath = path.join(dataDir, "capture-lane.json");
  const lockPath = path.join(dataDir, "capture-lane.pid");
  let state = null;
  try { state = JSON.parse(fs.readFileSync(statePath, "utf8")); } catch {}
  const step = plan({ windowMinutes: Number(process.env.DOMAINSCOUT_CAPTURE_WINDOW_MINUTES) || 170, state });
  if (!step.run) return;
  if (!holdLock(lockPath)) return;
  const write = (value) => fs.writeFileSync(statePath, JSON.stringify({ day: step.day, at: new Date().toISOString(), ...value }));
  const stop = setTimeout(() => {
    write({ complete: false, error: "capture window closed before the day was published" });
    console.error("[CaptureLane] window closed; leaving " + step.day + " to the web deployment");
    try { fs.unlinkSync(lockPath); } catch {}
    process.exit(75);
  }, step.closes - Date.now());
  try {
    // The capture host keeps no query database; the web deployment builds its own.
    const env = { ...process.env, DOMAINSCOUT_UNIVERSE_MATERIALIZE_SUMMARY: "0", DOMAINSCOUT_UNIVERSE_PULL_DEFER_MINUTES: "" };
    const result = await createUniversePuller({ dataDir, universeDir, env }).runDay({ day: step.day });
    write({ complete: !!result.complete, zonesOk: result.health?.zonesOk, failedZones: result.health?.failedZones });
    console.log("[CaptureLane] " + JSON.stringify({ day: result.day, complete: result.complete, ok: result.ok, skipped: result.skipped }));
    if (!result.complete) process.exitCode = 1;
    // Published days live in the shared store; keep only the latest two here.
    const days = fs.existsSync(universeDir) ? fs.readdirSync(universeDir).filter((name) => DAY.test(name)).sort() : [];
    for (const old of days.slice(0, -2)) fs.rmSync(path.join(universeDir, old), { recursive: true, force: true });
  } catch (error) {
    write({ complete: false, error: error.message });
    console.error("[CaptureLane] " + error.message);
    process.exitCode = 1;
  } finally {
    clearTimeout(stop);
    try { fs.unlinkSync(lockPath); } catch {}
  }
}

if (require.main === module) main();
module.exports = { plan, isStraySocketError };
