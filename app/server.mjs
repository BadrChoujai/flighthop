// Flighthop V1 — zero-dependency Node server.
// The fare endpoints refuse cross-origin browser calls, so search runs here.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

import { search, allAirports, resolveTargets } from './lib/search.mjs';
import { anywhereFares, bookingUrl } from './lib/ryanair.mjs';
import { stats } from './lib/cache.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 5173);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
};

async function serveStatic(res, pathname) {
  const rel = normalize(pathname === '/' ? '/index.html' : pathname).replace(/^(\.\.[/\\])+/, '');
  const file = join(root, 'public', rel);
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const q = url.searchParams;

  try {
    if (url.pathname === '/api/airports') {
      return json(res, 200, await allAirports());
    }

    if (url.pathname === '/api/health') {
      return json(res, 200, { ok: true, cache: stats() });
    }

    // Streaming search: hubs resolve one at a time and the UI says which.
    if (url.pathname === '/api/search') {
      const params = {
        origin: q.get('from') ?? '',
        destination: q.get('to') ?? '',
        from: q.get('dateFrom'),
        to: q.get('dateTo'),
        currency: q.get('currency') ?? 'EUR',
        weights: {
          minLayover: Number(q.get('minLayover') ?? 2),
          maxLayover: Number(q.get('maxLayover') ?? 18),
          tightPenalty: Number(q.get('tightPenalty') ?? 25),
          longPenalty: Number(q.get('longPenalty') ?? 8),
          overnightPenalty: Number(q.get('overnightPenalty') ?? 60),
        },
      };

      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

      try {
        const result = await search({ ...params, onProgress: (p) => send('progress', p) });
        send('result', result);
      } catch (e) {
        send('failed', { message: e.message });
      }
      return res.end();
    }

    // "Anywhere under €X" — one upstream call.
    if (url.pathname === '/api/explore') {
      const origin = (q.get('from') ?? '').toUpperCase();
      const data = await anywhereFares(origin, {
        from: q.get('dateFrom'), to: q.get('dateTo'),
        maxPrice: q.get('maxPrice') ? Number(q.get('maxPrice')) : undefined,
        timeFrom: q.get('after') || undefined,
        timeTo: q.get('before') || undefined,
        currency: q.get('currency') ?? 'EUR',
      });
      const wanted = q.get('country') ? await resolveTargets(q.get('country')) : null;
      const codes = wanted ? new Set(wanted) : null;

      const rows = (data.fares ?? [])
        .filter(f => !codes || codes.has(f.outbound.arrivalAirport.iataCode))
        .map(({ outbound: o, summary }) => ({
          code: o.arrivalAirport.iataCode,
          city: o.arrivalAirport.city.name,
          country: o.arrivalAirport.countryName,
          price: o.price.value, currency: o.price.currencyCode,
          day: o.departureDate.slice(0, 10),
          depLocal: o.departureDate.slice(11, 16),
          arrLocal: o.arrivalDate.slice(11, 16),
          flight: o.flightNumber,
          wasPrice: o.previousPrice?.value ?? null,
          newRoute: !!summary?.newRoute,
          book: bookingUrl(origin, o.arrivalAirport.iataCode, o.departureDate.slice(0, 10)),
        }))
        .sort((a, b) => a.price - b.price);

      return json(res, 200, { origin, rows });
    }

    return serveStatic(res, url.pathname);
  } catch (e) {
    return json(res, e.code === 400 ? 400 : 500, { message: e.message });
  }
});

server.listen(PORT, () => {
  console.log(`\n  Flighthop running at http://localhost:${PORT}\n`);
});
