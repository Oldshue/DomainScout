'use strict';

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_MAX_BYTES = 2147483648;

function requestError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function validDay(day) {
  const value = String(day || '');
  if (!DAY_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function tokenMatches(actual, expected) {
  const digest = value => crypto.createHash('sha256').update(String(value || '')).digest();
  return crypto.timingSafeEqual(digest(actual), digest(expected));
}

function createByteCapTransform(maxBytes, counter) {
  return new Transform({
    transform(chunk, encoding, callback) {
      counter.bytes += chunk.length;
      if (counter.bytes > maxBytes) {
        callback(requestError(`Universe summary tape exceeds max bytes (${maxBytes})`, 413));
        return;
      }
      callback(null, chunk);
    },
  });
}

function registerUniverseSummaryRoutes(app, { dataDir, summary = require('./universe-summary'), env = process.env, log = console } = {}) {
  const tapeDir = () => path.join(dataDir, 'universe-summary');
  let importing = null; // { day, startedAt, promise }

  function authorize(req) {
    const configured = [
      env.DOMAINSCOUT_UNIVERSE_IMPORT_TOKEN,
      env.DOMAINSCOUT_AGENT_TOKEN,
    ].filter(value => String(value || '').length > 0);
    if (!configured.length) throw requestError('Universe summary import token is not configured', 503);
    const supplied = [
      req.query?.token,
      req.get?.('X-DomainScout-Token') || req.headers?.['x-domainscout-token'],
    ].filter(value => value !== undefined && value !== null);
    let authorized = 0;
    for (const candidate of supplied) {
      for (const expected of configured) authorized |= Number(tokenMatches(candidate, expected));
    }
    if (!authorized) throw requestError('Unauthorized universe summary import', 401);
  }

  app.post('/api/universe/summary/import', async (req, res) => {
    let partPath = null;
    try {
      res.set('Cache-Control', 'no-store');
      authorize(req);
      const day = req.query?.day;
      if (!validDay(day)) throw requestError(`Unknown universe summary day: ${day || ''}`, 400);
      if (importing) throw requestError(`Universe summary import already running for ${importing.day}`, 409);

      const dir = tapeDir();
      await fsp.mkdir(dir, { recursive: true });
      const finalPath = path.join(dir, `universe-summary-${day}.tsv.gz`);
      partPath = `${finalPath}.part`;

      const configuredMax = Number(env.DOMAINSCOUT_UNIVERSE_SUMMARY_MAX_BYTES);
      const maxBytes = configuredMax > 0 ? configuredMax : DEFAULT_MAX_BYTES;

      const counter = { bytes: 0 };
      const cap = createByteCapTransform(maxBytes, counter);
      const output = fs.createWriteStream(partPath);
      await pipeline(req, cap, output);

      await fsp.rename(partPath, finalPath);
      partPath = null;

      const metaHeader = req.get?.('X-Universe-Summary-Meta') || req.headers?.['x-universe-summary-meta'];
      if (metaHeader) {
        const metaJson = Buffer.from(String(metaHeader), 'base64').toString('utf8');
        await fsp.writeFile(path.join(dir, `universe-summary-${day}.meta.json`), metaJson);
      }

      let willImport = false;
      if (String(req.query?.import) !== '0') {
        willImport = true;
        const startedAt = new Date().toISOString();
        const importPromise = summary.spawnUniverseSummaryImport({ tapePath: finalPath, dataDir, log })
          .then(meta => {
            log.log?.(`universe-summary import complete for ${day}`, meta);
          })
          .catch(error => {
            log.error?.(`universe-summary import failed for ${day}`, error);
          })
          .finally(() => {
            if (importing && importing.day === day) importing = null;
          });
        importing = { day, startedAt, promise: importPromise };
      }

      res.status(202).json({ day, bytes: counter.bytes, tapePath: finalPath, importing: willImport });
    } catch (error) {
      if (partPath) {
        try { await fsp.unlink(partPath); } catch (_) { /* ignore */ }
      }
      res.status(error.statusCode || 500).json({ error: error.message || 'Universe summary import failed' });
    }
  });

  app.get('/api/universe/summary/status', async (req, res) => {
    try {
      res.set('Cache-Control', 'no-store');
      const dir = tapeDir();
      let tapes = [];
      try {
        const entries = await fsp.readdir(dir);
        const tapeFiles = entries.filter(name => /^universe-summary-\d{4}-\d{2}-\d{2}\.tsv\.gz$/.test(name));
        tapes = await Promise.all(tapeFiles.map(async name => {
          const full = path.join(dir, name);
          const stat = await fsp.stat(full);
          const day = name.slice('universe-summary-'.length, name.length - '.tsv.gz'.length);
          return { day, bytes: stat.size, modifiedAt: stat.mtime.toISOString() };
        }));
        tapes.sort((a, b) => a.day.localeCompare(b.day));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      const handle = summary.openUniverseSummary(dataDir);
      res.json({
        summary: handle ? handle.status() : null,
        importing: importing ? { day: importing.day, startedAt: importing.startedAt } : null,
        tapes,
      });
    } catch (error) {
      res.status(error.statusCode || 500).json({ error: error.message || 'Universe summary status failed' });
    }
  });
}

module.exports = { registerUniverseSummaryRoutes };
