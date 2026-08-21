// The request handler, shared by the local server and the Vercel function.
// Both runtimes speak Node's (req, res), so there is exactly one code path.

import { readFile } from 'node:fs/promises';
import { join, dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { search, allAirports, resolveTargets, nearestAirport } from './search.mjs';
import { anywhereFares, bookingUrl } from './ryanair.mjs';
import { stats } from './cache.mjs';

const publicDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'public');

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

const notFound = (res) => {
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('Not found');
};

async function serveStatic(res, pathname) {
  const file = resolve(publicDir, '.' + (pathname === '/' ? '/index.html' : pathname));

  // Resolve first, then confirm the result is still inside public/. Cheaper to
  // reason about than trying to pattern-match traversal out of the request.
  if (file !== publicDir && !file.startsWith(publicDir + sep)) return notFound(res);

  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      // These filenames are not content-hashed, so any real max-age serves stale
      // JS and CSS after a deploy. They are a few KB — revalidate every time.
      'cache-control': 'no-cache',
    });
    res.end(body);
  } catch {
    notFound(res);
  }
}

export default async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  const q = url.searchParams;

  try {
    if (url.pathname === '/api/airports') {
      return json(res, 200, await allAirports());
    }

    if (url.pathname === '/api/health') {
      return json(res, 200, { ok: true, cache: stats() });
    }

    // Where the visitor is, so the origin field arrives filled in. Vercel attaches
    // the coordinates to the request, which beats asking the browser for permission
    // on page load. Locally the headers are absent and the field just stays empty.
    if (url.pathname === '/api/where') {
      const lat = Number(req.headers['x-vercel-ip-latitude']);
      const lon = Number(req.headers['x-vercel-ip-longitude']);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        return json(res, 200, { known: false });
      }
      const airport = await nearestAirport(lat, lon);
      return json(res, 200, {
        known: !!airport,
        country: req.headers['x-vercel-ip-country'] ?? null,
        airport,
      });
    }

    // Streaming search: hubs resolve one at a time and the UI says which.
    if (url.pathname === '/api/search') {
      const params = {
        origin: q.get('from') ?? '',
        destination: q.get('to') ?? '',
        from: q.get('dateFrom'),
        to: q.get('dateTo'),
        currency: q.get('currency') ?? 'EUR',
        maxStops: Number(q.get('maxStops') ?? 1),
        returnFrom: q.get('returnFrom') || undefined,
        returnTo: q.get('returnTo') || undefined,
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
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        // Proxies buffer responses unless told not to, and a buffered SSE stream
        // arrives all at once — the progress display would never move.
        'x-accel-buffering': 'no',
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
}
