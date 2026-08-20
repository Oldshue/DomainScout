'use strict';

const crypto = require('crypto');

function normalizeTld(value) {
  const clean = String(value || '').trim().toLowerCase().replace(/^\./, '');
  return clean ? `.${clean}` : null;
}

function runIdFor(prefix, startedAt) {
  return `${startedAt.replace(/[-:.TZ]/g, '').slice(0, 14)}-${crypto.randomBytes(6).toString('hex')}-${prefix}`;
}

class CloudPrefixCorpusWriter {
  constructor({ store, prefix, totalTlds, startedAt = new Date().toISOString() }) {
    if (!store || !prefix || !Number.isSafeInteger(totalTlds) || totalTlds < 1) {
      throw new Error('Cloud prefix corpus requires a store, prefix, and positive TLD count');
    }
    this.store = store;
    this.prefix = prefix;
    this.totalTlds = totalTlds;
    this.startedAt = startedAt;
    this.runId = runIdFor(prefix, startedAt);
    this.checkedTlds = 0;
    this.failedTlds = [];
    this.hits = 0;
    this.names = new Map();
  }

  async start() {
    await this.checkpoint('running');
  }

  async recordTld(tldValue, names, source = 'czds-stream') {
    const tld = normalizeTld(tldValue);
    if (!tld) throw new Error('A normalized TLD is required');
    const unique = [...new Set((names || []).map(name => String(name || '').toLowerCase()).filter(Boolean))].sort();
    for (const name of unique) {
      if (!this.names.has(name)) this.names.set(name, new Set());
      this.names.get(name).add(tld);
    }
    this.hits += unique.length;
    this.checkedTlds += 1;
    await this.store.putJson(
      `prefix-corpora/${this.prefix}/runs/${this.runId}/tlds/${tld.slice(1)}.json`,
      { version: 1, prefix: this.prefix, tld, source, names: unique },
      { gzip: true, metadata: { kind: 'prefix-tld-evidence', prefix: this.prefix, tld } },
    );
  }

  async recordFailure(tldValue, error) {
    const tld = normalizeTld(tldValue);
    this.failedTlds.push({ tld, error: String(error?.message || error || 'unknown').slice(0, 500) });
  }

  status(state = 'running', finishedAt = null) {
    return {
      version: 1,
      prefix: this.prefix,
      runId: this.runId,
      status: state,
      total_tlds: this.totalTlds,
      checked_tlds: this.checkedTlds,
      failed_tlds: this.failedTlds.length,
      names: this.names.size,
      hits: this.hits,
      last_started_at: this.startedAt,
      last_finished_at: finishedAt,
      updated_at: finishedAt || new Date().toISOString(),
      complete: state === 'complete' && this.checkedTlds === this.totalTlds && this.failedTlds.length === 0,
      failures: this.failedTlds,
      storage: this.store.descriptor,
    };
  }

  async checkpoint(state = 'running') {
    const status = this.status(state);
    await this.store.putJson(`prefix-corpora/${this.prefix}/status.json`, status, {
      metadata: { kind: 'prefix-status', prefix: this.prefix, runid: this.runId },
    });
    return status;
  }

  async finish() {
    const finishedAt = new Date().toISOString();
    const complete = this.checkedTlds === this.totalTlds && this.failedTlds.length === 0;
    const rows = [...this.names.entries()].map(([base_name, tlds]) => ({
      base_name,
      tld_count: tlds.size,
      tld_list: [...tlds].sort(),
    })).sort((a, b) => b.tld_count - a.tld_count || a.base_name.localeCompare(b.base_name));
    const corpus = {
      version: 1,
      prefix: this.prefix,
      runId: this.runId,
      generatedAt: finishedAt,
      rows,
    };
    const corpusObject = await this.store.putJson(
      `prefix-corpora/${this.prefix}/runs/${this.runId}/corpus.json`, corpus,
      { gzip: true, metadata: { kind: 'prefix-corpus', prefix: this.prefix, runid: this.runId } },
    );
    const receipt = {
      ...this.status(complete ? 'complete' : 'partial', finishedAt),
      corpus: corpusObject,
    };
    await this.store.putJson(`prefix-corpora/${this.prefix}/runs/${this.runId}/receipt.json`, receipt, {
      metadata: { kind: 'prefix-receipt', prefix: this.prefix, runid: this.runId },
    });
    await this.store.putJson(`prefix-corpora/${this.prefix}/status.json`, receipt, {
      metadata: { kind: 'prefix-status', prefix: this.prefix, runid: this.runId },
    });
    if (complete) {
      await this.store.putJson(`prefix-corpora/${this.prefix}/latest.json`, receipt, {
        metadata: { kind: 'prefix-latest', prefix: this.prefix, runid: this.runId },
      });
    }
    return receipt;
  }
}

async function readCloudPrefixStatus(store, prefix) {
  return (await store?.getJson(`prefix-corpora/${prefix}/status.json`))?.value || null;
}

async function readCloudPrefixCorpus(store, prefix) {
  const latest = (await store?.getJson(`prefix-corpora/${prefix}/latest.json`))?.value;
  if (!latest?.complete || !latest?.corpus?.key) return null;
  const relativeKey = latest.corpus.key.replace(`${store.descriptor.prefix}/`, '');
  const corpus = (await store.getJson(relativeKey))?.value;
  if (!corpus || corpus.runId !== latest.runId || corpus.prefix !== prefix) return null;
  return { coverage: latest, rows: corpus.rows || [] };
}

module.exports = { CloudPrefixCorpusWriter, readCloudPrefixCorpus, readCloudPrefixStatus };
