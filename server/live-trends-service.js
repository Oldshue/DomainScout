'use strict';
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { parseQuery } = require('./live-trends');

function createLiveTrendsService(options, { WorkerClass = Worker } = {}) {
  let worker = null;
  let sequence = 0;
  const pending = new Map();
  const inFlight = new Map();
  function start() {
    if (worker) return worker;
    const current = new WorkerClass(path.join(__dirname, 'live-trends-worker.js'), { workerData: options });
    worker = current;
    const fail = error => {
      if (worker !== current) return;
      worker = null;
      for (const request of pending.values()) request.reject(error);
      pending.clear();
      inFlight.clear();
    };
    current.on('message', message => {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.error) request.reject(Object.assign(new Error(message.error.message), { statusCode: message.error.statusCode }));
      else request.resolve(message.value);
      if (!pending.size) current.unref();
    });
    current.on('error', fail);
    current.on('exit', code => fail(new Error(`Live trends worker exited (${code})`)));
    current.unref();
    return current;
  }
  function request(method, input) {
    const key = JSON.stringify([method, input]);
    if (inFlight.has(key)) return inFlight.get(key);
    const current = start();
    const id = ++sequence;
    const result = new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      current.ref();
      current.postMessage({ id, method, input });
    });
    inFlight.set(key, result);
    const cleanup = () => { if (inFlight.get(key) === result) inFlight.delete(key); };
    result.then(cleanup, cleanup);
    return result;
  }
  return {
    query(input = {}) {
      // Validate and normalize before deduplication; equivalent visitors share
      // one build, without discarding any source records or query options.
      try { return request('query', parseQuery(input)); } catch (error) { return Promise.reject(error); }
    },
    refresh: () => request('refresh'),
    async close() { if (worker) await worker.terminate(); },
  };
}
module.exports = { createLiveTrendsService };
