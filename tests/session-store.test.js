'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const session = require('express-session');
const { SqliteSessionStore } = require('../server/session-store');

async function boot(dataDir) {
  const app = express();
  app.use(session({ secret: 'the-same-secret', resave: false, saveUninitialized: false, store: new SqliteSessionStore({ dataDir }), cookie: { maxAge: 60000 } }));
  app.get('/login', (req, res) => { req.session.authed = true; res.end('in'); });
  app.get('/me', (req, res) => res.json({ authed: !!req.session.authed }));
  app.get('/logout', (req, res) => req.session.destroy(() => res.end('out')));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  return { base: 'http://127.0.0.1:' + server.address().port, close: () => new Promise(resolve => server.close(resolve)) };
}

test('a login survives a restart, and logging out or expiring ends it', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-sessions-'));
  let app = await boot(dataDir);
  const cookie = (await fetch(app.base + '/login')).headers.get('set-cookie').split(';')[0];
  assert.deepEqual(await (await fetch(app.base + '/me', { headers: { cookie } })).json(), { authed: true });
  await app.close();

  // A new process with the same data folder and secret: still signed in.
  app = await boot(dataDir);
  assert.deepEqual(await (await fetch(app.base + '/me', { headers: { cookie } })).json(), { authed: true });
  assert.deepEqual(await (await fetch(app.base + '/me')).json(), { authed: false });

  await fetch(app.base + '/logout', { headers: { cookie } });
  assert.deepEqual(await (await fetch(app.base + '/me', { headers: { cookie } })).json(), { authed: false });
  await app.close();

  const store = new SqliteSessionStore({ dataDir });
  store.db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run('old', JSON.stringify({ authed: true }), Date.now() - 1);
  assert.equal(await new Promise(resolve => store.get('old', (_e, s) => resolve(s))), null);
  store.sweep();
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
});
