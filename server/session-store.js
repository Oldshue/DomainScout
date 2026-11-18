'use strict';

// Login sessions that survive a restart.
//
// express-session keeps sessions in memory by default, so every deploy logged
// everyone out. This keeps them in a small SQLite file on the data volume,
// separate from the main database so it never waits on it.

const path = require('node:path');
const Database = require('better-sqlite3');
const session = require('express-session');

const DAY_MS = 24 * 60 * 60 * 1000;

class SqliteSessionStore extends session.Store {
  constructor({ dataDir, ttlMs = 30 * DAY_MS }) {
    super();
    this.ttlMs = ttlMs;
    this.db = new Database(path.join(dataDir, 'sessions.db'));
    this.db.pragma('journal_mode = WAL');
    this.db.exec('CREATE TABLE IF NOT EXISTS sessions (sid TEXT PRIMARY KEY, data TEXT NOT NULL, expires INTEGER NOT NULL)');
    this.sweep();
    this.timer = setInterval(() => this.sweep(), 6 * 60 * 60 * 1000);
    this.timer.unref();
  }

  sweep() {
    try { this.db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now()); } catch { /* next pass */ }
  }

  expiry(sess) {
    const at = sess?.cookie?.expires ? new Date(sess.cookie.expires).getTime() : NaN;
    return Number.isFinite(at) ? at : Date.now() + this.ttlMs;
  }

  get(sid, done) {
    try {
      const row = this.db.prepare('SELECT data, expires FROM sessions WHERE sid = ?').get(sid);
      if (!row || row.expires < Date.now()) return done(null, null);
      done(null, JSON.parse(row.data));
    } catch (err) { done(err); }
  }

  set(sid, sess, done = () => {}) {
    try {
      this.db.prepare('INSERT INTO sessions VALUES (?, ?, ?) ON CONFLICT(sid) DO UPDATE SET data = excluded.data, expires = excluded.expires')
        .run(sid, JSON.stringify(sess), this.expiry(sess));
      done(null);
    } catch (err) { done(err); }
  }

  touch(sid, sess, done = () => {}) {
    try {
      this.db.prepare('UPDATE sessions SET expires = ? WHERE sid = ?').run(this.expiry(sess), sid);
      done(null);
    } catch (err) { done(err); }
  }

  destroy(sid, done = () => {}) {
    try {
      this.db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
      done(null);
    } catch (err) { done(err); }
  }
}

module.exports = { SqliteSessionStore };
