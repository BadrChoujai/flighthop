// The request handler, shared by the local server and the Vercel function.
// Both runtimes speak Node's (req, res), so there is exactly one code path.

import { readFile } from 'node:fs/promises';
import { join, dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { search, allAirports, resolveTargets, nearestAirport, zoneOf } from './search.mjs';
import { anywhereFares, roundTripFares, bookingUrl, localToUtc, hours } from './ryanair.mjs';
import { stats } from './cache.mjs';
import { configured } from './endpoints.mjs';

const publicDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'public');

const isoDay = (d) => d.toISOString().slice(0, 10);

/**
 * The next N actual weekends, each as its own tight window.
 *
 * Asking the fare endpoint for a two-month span returns the cheapest trip per
 * destination, which is usually a fortnight — a true answer to a question
 * nobody asked. "Any weekend" has to mean weekends, so each one is queried on
 * its own dates: out Friday or Saturday, home on the Sunday.
 */
function weekendWindows(count, fromISO) {
  const now = fromISO ? new Date(fromISO + 'T00:00:00Z') : new Date();
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const isoDow = ((day.getUTCDay() + 6) % 7) + 1;          // Mon = 1 … Sun = 7
  day.setUTCDate(day.getUTCDate() + ((5 - isoDow + 7) % 7)); // forward to Friday

  const windows = [];
  for (let i = 0; i < count; i++) {
    const friday = new Date(day);
    friday.setUTCDate(friday.getUTCDate() + i * 7);
    const saturday = new Date(friday); saturday.setUTCDate(saturday.getUTCDate() + 1);
    const sunday = new Date(friday); sunday.setUTCDate(sunday.getUTCDate() + 2);
    windows.push({
      outFrom: isoDay(friday), outTo: isoDay(saturday),
      backFrom: isoDay(sunday), backTo: isoDay(sunday),
    });
  }
  return windows;
}

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
      const upstream = configured();
      const ready = Object.values(upstream).every(Boolean);
      return json(res, 200, { ok: true, ready, upstream, cache: stats() });
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

    /*
     * "Where can I get to?" — a whole trip that fits the time you actually have.
     *
     * Constraints on both ends, destination unknown. One upstream request answers
     * it: the round-trip endpoint honours a date window and a time-of-day window
     * in each direction, so "leave after work Friday, back before Monday
     * morning" is a query rather than a scan.
     */
    if (url.pathname === '/api/getaway') {
      const origin = (q.get('from') ?? '').toUpperCase();
      if (!origin) return json(res, 400, { message: 'Where are you starting from?' });

      const filters = {
        maxPrice: q.get('maxPrice') ? Number(q.get('maxPrice')) : undefined,
        outAfter: q.get('outAfter') || undefined,
        outBefore: q.get('outBefore') || undefined,
        backAfter: q.get('backAfter') || undefined,
        backBefore: q.get('backBefore') || undefined,
        currency: q.get('currency') ?? 'EUR',
      };
      const weekends = Math.min(Math.max(0, Number(q.get('weekends') ?? 0)), 10);

      // One request per weekend, run together — they share the cache and the
      // same concurrency gate as everything else.
      const windows = weekends
        ? weekendWindows(weekends, q.get('outFrom'))
        : [{ outFrom: q.get('outFrom'), outTo: q.get('outTo'),
             backFrom: q.get('backFrom'), backTo: q.get('backTo') }];

      const sets = await Promise.all(
        windows.map(w => roundTripFares(origin, { ...w, ...filters })));
      const data = { fares: sets.flatMap(set => set.fares ?? []) };

      const wanted = q.get('country') ? await resolveTargets(q.get('country')) : null;
      const codes = wanted ? new Set(wanted) : null;
      const homeZone = await zoneOf(origin);

      const rows = [];
      for (const fare of data.fares ?? []) {
        const { outbound: o, inbound: i, summary } = fare;
        const code = o.arrivalAirport.iataCode;
        if (codes && !codes.has(code)) continue;

        // The number that matters is not the fare or the nights — it is how long
        // you are actually there, landing to take-off, across two timezones.
        const zone = await zoneOf(code);
        const landed = localToUtc(o.arrivalDate, zone);
        const leaves = localToUtc(i.departureDate, zone);
        const onTheGround = hours(leaves - landed);
        if (onTheGround <= 0) continue;

        rows.push({
          code, city: o.arrivalAirport.city.name, country: o.arrivalAirport.countryName,
          price: summary.price.value, currency: summary.price.currencyCode,
          onTheGround: +onTheGround.toFixed(1),
          nights: Math.max(0, Math.round(onTheGround / 24)),
          out: {
            day: o.departureDate.slice(0, 10),
            dep: o.departureDate.slice(11, 16), arr: o.arrivalDate.slice(11, 16),
            flight: o.flightNumber, price: o.price.value,
            book: bookingUrl(origin, code, o.departureDate.slice(0, 10)),
          },
          back: {
            day: i.departureDate.slice(0, 10),
            dep: i.departureDate.slice(11, 16), arr: i.arrivalDate.slice(11, 16),
            flight: i.flightNumber, price: i.price.value,
            book: bookingUrl(code, origin, i.departureDate.slice(0, 10)),
          },
        });
      }

      if (weekends) {
        const best = new Map();
        for (const r of rows) {
          const seen = best.get(r.code);
          if (!seen || r.price < seen.price) best.set(r.code, r);
        }
        rows.length = 0;
        rows.push(...best.values());
      }

      rows.sort((a, b) => a.price - b.price);

      /*
       * An empty result should say which constraint is doing the emptying.
       * A budget plus "after work" is usually the pair that bites — evening
       * departures are the expensive ones — so when nothing fits, ask again
       * without the budget and report what the times alone would cost.
       */
      let cheapestThatFits = null;
      if (!rows.length && q.get('maxPrice')) {
        const open = await roundTripFares(origin, {
          outFrom: q.get('outFrom'), outTo: q.get('outTo'),
          backFrom: q.get('backFrom'), backTo: q.get('backTo'),
          outAfter: q.get('outAfter') || undefined,
          outBefore: q.get('outBefore') || undefined,
          backAfter: q.get('backAfter') || undefined,
          backBefore: q.get('backBefore') || undefined,
          currency: q.get('currency') ?? 'EUR',
        });
        const best = (open.fares ?? [])
          .filter(f => !codes || codes.has(f.outbound.arrivalAirport.iataCode))
          .sort((a, b) => a.summary.price.value - b.summary.price.value)[0];
        if (best) {
          cheapestThatFits = {
            price: best.summary.price.value,
            currency: best.summary.price.currencyCode,
            city: best.outbound.arrivalAirport.city.name,
          };
        }
      }

      return json(res, 200, { origin, homeZone, rows, cheapestThatFits, weekends });
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
