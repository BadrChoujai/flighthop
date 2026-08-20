// Disk-backed TTL cache. Node's built-in SQLite, so the app has no dependencies.
// The cache is most of the architecture: a warm route answers in milliseconds,
// and the airline sees a fraction of the traffic.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '.cache');
mkdirSync(dir, { recursive: true });

const db = new DatabaseSync(join(dir, 'flighthop.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS entries (
    key      TEXT PRIMARY KEY,
    value    TEXT NOT NULL,
    expires  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS entries_expires ON entries(expires);
`);

const readStmt = db.prepare('SELECT value FROM entries WHERE key = ? AND expires > ?');
const writeStmt = db.prepare('INSERT INTO entries (key, value, expires) VALUES (?, ?, ?) ' +
                             'ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires = excluded.expires');
const sweepStmt = db.prepare('DELETE FROM entries WHERE expires <= ?');
const countStmt = db.prepare('SELECT COUNT(*) AS n FROM entries WHERE expires > ?');

/** How long each kind of data stays fresh. */
export const TTL = {
  airports: 30 * 24 * 3600e3,   // the airport table barely moves
  routes: 3 * 24 * 3600e3,      // routes change with the season
  fares: 6 * 3600e3,            // prices drift, but not minute to minute
  dates: 12 * 3600e3,
};

export function read(key) {
  const row = readStmt.get(key, Date.now());
  return row ? JSON.parse(row.value) : undefined;
}

export function write(key, value, ttl) {
  writeStmt.run(key, JSON.stringify(value), Date.now() + ttl);
  return value;
}

/** Fetch through the cache. Concurrent callers for the same key share one fetch. */
const inflight = new Map();
export async function through(key, ttl, producer) {
  const hit = read(key);
  if (hit !== undefined) return hit;
  if (inflight.has(key)) return inflight.get(key);

  const p = (async () => {
    try {
      return write(key, await producer(), ttl);
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

export const stats = () => ({ entries: countStmt.get(Date.now()).n });

setInterval(() => sweepStmt.run(Date.now()), 3600e3).unref();
