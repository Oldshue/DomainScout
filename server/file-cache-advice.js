'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');

const HELPER = path.join(__dirname, '../scripts/posix-fadvise.py');

function releaseOwnFileCache(files, { timeoutMs = 15_000 } = {}) {
  const paths = [...new Set((files || []).filter(file => typeof file === 'string' && path.isAbsolute(file)))];
  if (!paths.length || process.platform !== 'linux') return Promise.resolve({ supported: false, advised: 0 });
  return new Promise(resolve => {
    const child = spawn(process.env.DOMAINSCOUT_PYTHON || 'python3', [HELPER], { stdio: ['pipe', 'pipe', 'ignore'] });
    let output = '', settled = false;
    const finish = value => { if (settled) return; settled = true; clearTimeout(timer); resolve(value); };
    const timer = setTimeout(() => { child.kill('SIGTERM'); finish({ supported: false, advised: 0, timeout: true }); }, timeoutMs);
    timer.unref?.();
    child.stdout.on('data', chunk => { if (output.length < 4096) output += chunk; });
    child.on('error', () => finish({ supported: false, advised: 0 }));
    child.on('close', code => {
      if (code !== 0) return finish({ supported: false, advised: 0 });
      try { finish(JSON.parse(output)); } catch { finish({ supported: false, advised: 0 }); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(paths));
  });
}

module.exports = { releaseOwnFileCache };
