#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const SCHEMA = 'domainscout.source-manifest/v1';

function fail(message) {
  process.stderr.write(`[source-manifest][ERROR] ${message}\n`);
  process.exit(1);
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function safeRoot(value, label) {
  const resolved = path.resolve(String(value || ''));
  if (!path.isAbsolute(resolved) || resolved === path.parse(resolved).root) fail(`${label} must be an absolute non-root path`);
  return resolved;
}

function trackedFiles(source) {
  return execFileSync('git', ['-C', source, 'ls-files', '-z'], { encoding: 'buffer' })
    .toString('utf8').split('\0').filter(Boolean).sort();
}

function assertSafeRelative(relative) {
  if (!relative || path.isAbsolute(relative) || relative.split('/').includes('..')) fail(`unsafe manifest path: ${relative}`);
}

function create(source, target) {
  const commit = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim().toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(commit)) fail('source commit is invalid');
  const files = trackedFiles(source).map(relative => {
    assertSafeRelative(relative);
    return { path: relative, sha256: sha256(path.join(source, relative)) };
  });
  const manifest = { schema: SCHEMA, sourceCommit: commit, files };
  const destination = path.join(target, '.source-manifest.json');
  const temporary = `${destination}.tmp.${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, destination);
  process.stdout.write(`${commit} ${files.length}\n`);
}

function verify(target, expectedCommit = '') {
  const manifestPath = path.join(target, '.source-manifest.json');
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); }
  catch { fail('installed source manifest is missing or invalid'); }
  if (manifest.schema !== SCHEMA || !/^[a-f0-9]{40}$/.test(String(manifest.sourceCommit || ''))) fail('installed source manifest contract is invalid');
  if (expectedCommit && manifest.sourceCommit !== expectedCommit.toLowerCase()) fail('installed source manifest commit does not match desired release');
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) fail('installed source manifest has no tracked files');
  for (const entry of manifest.files) {
    assertSafeRelative(entry?.path);
    if (!/^[a-f0-9]{64}$/.test(String(entry?.sha256 || ''))) fail(`invalid digest for ${entry?.path || 'unknown file'}`);
    const filePath = path.join(target, entry.path);
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) fail(`installed tracked file is missing: ${entry.path}`);
    if (sha256(filePath) !== entry.sha256) fail(`installed tracked file drifted: ${entry.path}`);
  }
  process.stdout.write(`${manifest.sourceCommit} ${manifest.files.length}\n`);
}

const [command, ...args] = process.argv.slice(2);
const value = name => {
  const prefix = `--${name}=`;
  return args.find(arg => arg.startsWith(prefix))?.slice(prefix.length) || '';
};

if (command === 'create') create(safeRoot(value('source'), 'source'), safeRoot(value('target'), 'target'));
else if (command === 'verify') verify(safeRoot(value('target'), 'target'), value('commit'));
else fail('usage: source-manifest.js create --source=/path --target=/path | verify --target=/path [--commit=<sha>]');
