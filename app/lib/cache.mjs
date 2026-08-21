// TTL cache. The cache is most of the architecture: a warm route answers in
// milliseconds, and the airline sees a fraction of the traffic.
//
// Two backends, same interface. On a machine with a writable disk it uses Node's
// built-in SQLite, so the cache survives restarts. On a read-only serverless
// filesystem it falls back to memory, which lasts as long as the instance —
// acceptable here because a cold search is only about a second anyway.

import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** How long each kind of data stays fresh. */
export const TTL = {
  airports: 30 * 24 * 3600e3,   // the airport table barely moves
  routes: 3 * 24 * 3600e3,      // routes change with the season
  fares: 6 * 3600e3,            // prices drift, but not minute to minute
  dates: 12 * 3600e3,
};

function memoryBackend() {
  const map = new Map();
  return {
    kind: 'memory',
    read(key) {
      const hit = map.get(key);
      if (!hit) return undefined;
      if (hit.expires <= Date.now()) { map.delete(key); return undefined; }
      return hit.value;
    },
    write(key, value, ttl) {
      map.set(key, { value, expires: Date.now() + ttl });
      return value;
    },
    size: () => map.size,
    sweep() {
      const now = Date.now();
      for (const [key, hit] of map) if (hit.expires <= now) map.delete(key);
    },
  };
}

async function sqliteBackend() {
  const { DatabaseSync } = await import('node:sqlite');
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

  return {
    kind: 'sqlite',
    read(key) {
      const row = readStmt.get(key, Date.now());
      return row ? JSON.parse(row.value) : undefined;
    },
    write(key, value, ttl) {
      writeStmt.run(key, JSON.stringify(value), Date.now() + ttl);
      return value;
    },
    size: () => countStmt.get(Date.now()).n,
    sweep: () => sweepStmt.run(Date.now()),
  };
}

// Serverless filesystems are read-only apart from /tmp, and an instance is gone
// before a disk cache would pay for itself. Anywhere else, prefer the disk — and
// if opening it fails for any reason, keep serving from memory rather than dying.
const serverless = !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
let backend;
if (serverless) {
  backend = memoryBackend();
} else {
  try {
    backend = await sqliteBackend();
  } catch (e) {
    console.warn(`cache: falling back to memory (${e.message})`);
    backend = memoryBackend();
  }
}

export const read = (key) => backend.read(key);
export const write = (key, value, ttl) => backend.write(key, value, ttl);

/** Fetch through the cache. Concurrent callers for the same key share one fetch. */
const inflight = new Map();
export async function through(key, ttl, producer) {
  const hit = backend.read(key);
  if (hit !== undefined) return hit;
  if (inflight.has(key)) return inflight.get(key);

  const p = (async () => {
    try {
      return backend.write(key, await producer(), ttl);
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

export const stats = () => ({ entries: backend.size(), backend: backend.kind });

setInterval(() => backend.sweep(), 3600e3).unref();
