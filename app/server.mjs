// Local development server. On Vercel the same handler runs as a function —
// see ../api/index.mjs.

import { createServer } from 'node:http';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// The upstream endpoints come from the environment (see lib/endpoints.mjs). A
// host supplies them from its own settings; locally they live in .env, which is
// not committed. Absent, the interface still runs and searches explain what is
// missing — so a fresh clone is browsable before it is configured.
try {
  process.loadEnvFile(resolve(dirname(fileURLToPath(import.meta.url)), '..', '.env'));
} catch {
  if (!process.env.FLIGHTHOP_API_BASE) {
    console.log('\n  No .env found. Copy .env.example to .env to run a search.');
  }
}

const { default: handler } = await import('./lib/handler.mjs');

const PORT = Number(process.env.PORT ?? 5173);

createServer(handler).listen(PORT, () => {
  console.log(`\n  Flighthop running at http://localhost:${PORT}\n`);
});
