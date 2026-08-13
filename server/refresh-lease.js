'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function safeLane(value) {
  const lane = String(value || '');
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(lane)) throw new Error('refresh lane must be a bounded lowercase identifier');
  return lane;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function atomicWrite(filePath, value) {
  const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, filePath);
}

function createRefreshLeaseManager(options) {
  const root = path.resolve(String(options?.root || ''));
  if (!path.isAbsolute(root) || root === path.parse(root).root) throw new Error('refresh lease root must be a scoped absolute directory');
  const now = typeof options?.now === 'function' ? options.now : () => Date.now();
  const isAlive = typeof options?.isAlive === 'function' ? options.isAlive : pid => {
    try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
  };
  const signal = typeof options?.signal === 'function' ? options.signal : (pid, name) => process.kill(pid, name);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('unsafe refresh lease root');
  try { fs.chmodSync(root, 0o700); } catch (_) {}

  const pathFor = lane => path.join(root, `${safeLane(lane)}.json`);
  const remove = filePath => { try { fs.unlinkSync(filePath); } catch (_) {} };

  function inspect(lane, policy = {}) {
    const filePath = pathFor(lane);
    if (!fs.existsSync(filePath)) return null;
    let lease;
    try { lease = readJson(filePath); } catch (_) { remove(filePath); return null; }
    if (lease.lane !== safeLane(lane) || !Number.isInteger(Number(lease.pid)) || !lease.token) {
      remove(filePath);
      return null;
    }
    const pid = Number(lease.pid);
    if (!isAlive(pid)) { remove(filePath); return null; }
    const maxHeartbeatAgeMs = Math.max(60_000, Number(policy.maxHeartbeatAgeMs) || 60 * 60_000);
    const terminationGraceMs = Math.max(1_000, Number(policy.terminationGraceMs) || 5_000);
    const heartbeatMs = Date.parse(lease.heartbeatAt || lease.startedAt || '');
    const ageMs = Number.isFinite(heartbeatMs) ? Math.max(0, now() - heartbeatMs) : Infinity;
    if (lease.reapingAt) {
      const reapingAgeMs = Math.max(0, now() - Date.parse(lease.reapingAt));
      if (Number.isFinite(reapingAgeMs) && reapingAgeMs >= terminationGraceMs) {
        try { signal(pid, 'SIGKILL'); } catch (_) {}
        remove(filePath);
        return null;
      }
      return { ...lease, stale: true, reaping: true, heartbeatAgeMs: ageMs };
    }
    if (ageMs > maxHeartbeatAgeMs) {
      try { signal(pid, 'SIGTERM'); } catch (_) {}
      const updated = { ...lease, reapingAt: new Date(now()).toISOString(), stale: true };
      atomicWrite(filePath, updated);
      return { ...updated, reaping: true, heartbeatAgeMs: ageMs };
    }
    return { ...lease, stale: false, reaping: false, heartbeatAgeMs: ageMs };
  }

  function reserve(lane, metadata = {}) {
    const cleanLane = safeLane(lane);
    const filePath = pathFor(cleanLane);
    const token = crypto.randomBytes(24).toString('hex');
    const timestamp = new Date(now()).toISOString();
    const lease = {
      lane: cleanLane,
      token,
      pid: process.pid,
      parentPid: process.pid,
      reserving: true,
      startedAt: timestamp,
      heartbeatAt: timestamp,
      ...metadata,
    };
    fs.writeFileSync(filePath, JSON.stringify(lease, null, 2), { mode: 0o600, flag: 'wx' });
    return { ...lease, filePath };
  }

  function activate(lane, token, pid, metadata = {}) {
    const filePath = pathFor(lane);
    const current = readJson(filePath);
    if (current.token !== token) throw new Error('refresh lease reservation was superseded');
    const timestamp = new Date(now()).toISOString();
    const lease = { ...current, ...metadata, pid: Number(pid), reserving: false, heartbeatAt: timestamp };
    atomicWrite(filePath, lease);
    return { ...lease, filePath };
  }

  function release(lane, identity) {
    const filePath = pathFor(lane);
    try {
      const current = readJson(filePath);
      if (current.token === identity || Number(current.pid) === Number(identity)) remove(filePath);
    } catch (_) {}
  }

  return { inspect, reserve, activate, release, pathFor };
}

function startRefreshLeaseHeartbeat(env = process.env, options = {}) {
  const filePath = String(env.DOMAINSCOUT_REFRESH_LEASE_PATH || '');
  const token = String(env.DOMAINSCOUT_REFRESH_LEASE_TOKEN || '');
  if (!filePath || !token || !path.isAbsolute(filePath)) return () => {};
  const intervalMs = Math.max(10_000, Number(options.intervalMs) || 30_000);
  const beat = () => {
    try {
      const current = readJson(filePath);
      if (current.token !== token || Number(current.pid) !== process.pid) return;
      atomicWrite(filePath, { ...current, heartbeatAt: new Date().toISOString() });
    } catch (_) {}
  };
  beat();
  const timer = setInterval(beat, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

module.exports = {
  createRefreshLeaseManager,
  startRefreshLeaseHeartbeat,
};
