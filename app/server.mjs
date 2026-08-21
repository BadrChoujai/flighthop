// Local development server. On Vercel the same handler runs as a function —
// see ../api/index.mjs.

import { createServer } from 'node:http';
import handler from './lib/handler.mjs';

const PORT = Number(process.env.PORT ?? 5173);

createServer(handler).listen(PORT, () => {
  console.log(`\n  Flighthop running at http://localhost:${PORT}\n`);
});
