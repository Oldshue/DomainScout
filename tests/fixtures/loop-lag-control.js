'use strict';

// An idle process measuring its own timer lag. Run beside a main-thread timing
// test: lag it sees too is the host starving everything, not a blocked thread.
// Prints the worst lag (ms) when stdin closes.
let worst = 0;
let last = Date.now();
setInterval(() => { const now = Date.now(); worst = Math.max(worst, now - last - 10); last = now; }, 10);
process.stdin.resume();
process.stdin.on('end', () => { process.stdout.write(String(worst)); process.exit(0); });
