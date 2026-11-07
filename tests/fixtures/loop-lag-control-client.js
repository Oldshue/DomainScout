'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');

// Starts the idle control; stop() resolves with its worst lag. A real block on
// the tested thread exceeds BASE_MS plus whatever the idle control also saw.
const BASE_MS = 400;

function startLagControl() {
  const child = spawn(process.execPath, [path.join(__dirname, 'loop-lag-control.js')], { stdio: ['pipe', 'pipe', 'ignore'] });
  let out = '';
  child.stdout.on('data', chunk => { out += chunk; });
  const exited = new Promise(resolve => child.once('exit', resolve));
  return {
    async limit() {
      child.stdin.end();
      await exited;
      return BASE_MS + (Number(out) || 0);
    },
  };
}

module.exports = { startLagControl };
