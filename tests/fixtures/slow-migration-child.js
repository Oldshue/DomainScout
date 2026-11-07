'use strict';

// Test double for the off-main boot migration / maintenance children. It runs
// in its own process (like the real ones), so the parent's HTTP server stays
// free while it "migrates". Env:
//   SLOW_MIGRATION_MS        how long the fake migration takes (default 3000)
//   SLOW_MIGRATION_FAIL_FILE if set and the file does not exist, create it and
//                            fail this attempt (the next attempt succeeds)
const fs = require('node:fs');

const ms = Number(process.env.SLOW_MIGRATION_MS || 3000);

function finish(type) {
  const failFile = process.env.SLOW_MIGRATION_FAIL_FILE;
  if (failFile && !fs.existsSync(failFile)) {
    fs.writeFileSync(failFile, 'failed once');
    process.send({ type: 'error', error: 'injected first-attempt failure' });
    setImmediate(() => process.exit(1));
    return;
  }
  process.send({ type });
  setImmediate(() => { try { process.disconnect(); } catch (_) { /* ignore */ } process.exit(0); });
}

if (process.argv.includes('--run')) {
  setTimeout(() => finish('maintained'), ms);
} else {
  process.on('message', message => {
    if (message && message.type === 'migrate') setTimeout(() => finish('migrated'), ms);
  });
}
