// Client for the public Ryanair endpoints. Everything goes through the cache and
// a concurrency gate — these are an airline's own backend, not a public API.
//
// The endpoints themselves live in the environment, not here; see endpoints.mjs.

import { through, TTL } from './cache.mjs';
import { base, path, booking } from './endpoints.mjs';

const UA = 'Mozilla/5.0 (Flighthop)';
const MAX_CONCURRENT = 4;

let active = 0;
const queue = [];

function gate() {
  if (active < MAX_CONCURRENT) { active++; return Promise.resolve(); }
  return new Promise(resolve => queue.push(resolve));
}
function release() {
  active--;
  const next = queue.shift();
  if (next) { active++; next(); }
}

async function fetchJson(url, attempt = 0) {
  await gate();
  try {
    const res = await fetch(base() + url, {
      headers: { 'User-Agent': UA, accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 429 || res.status >= 500) throw new Error(`upstream ${res.status}`);
    if (!res.ok) {
      const err = new Error(`${res.status} on ${url}`);
      err.status = res.status;
      throw err;
    }
    return await res.json();
  } catch (e) {
    if (attempt < 2 && !e.status) {
      await new Promise(r => setTimeout(r, 400 * 2 ** attempt));
      return fetchJson(url, attempt + 1);
    }
    throw e;
  } finally {
    release();
  }
}

/** Airport master table: country, coordinates, IANA timezone. */
export const airports = () =>
  through('airports:v5', TTL.airports, () => fetchJson(path('airports')));

/** Every route out of an airport — the edge list of the network. */
export const routesFrom = (code) =>
  through(`routes:${code}`, TTL.routes, async () => {
    const rows = await fetchJson(path('routes', { code }));
    return rows.map(r => ({
      code: r.arrivalAirport.code,
      seasonal: !!r.seasonal,
      recent: !!r.recent,
    }));
  });

/** One month of a route: cheapest fare per day, with local departure/arrival times. */
export const cheapestPerDay = (from, to, month, currency = 'EUR') =>
  through(`fares:${from}:${to}:${month}:${currency}`, TTL.fares, () =>
    fetchJson(path('cheapestPerDay', { from, to }) +
              `?outboundMonthOfDate=${month}&currency=${currency}`));

/**
 * Published timetable for one route in one month: every frequency with its flight
 * number. The fare endpoints only ever return the cheapest flight per day, so this
 * is the only open source of truth for "is there a later flight if I miss this one".
 * Returns { "2026-09-09": [{ number, dep, arr }], … }
 */
export const timetable = (from, to, month) =>
  through(`timtbl:${from}:${to}:${month}`, TTL.routes, async () => {
    const [year, mon] = month.split('-');
    const data = await fetchJson(path('timetable', { from, to, year, month: Number(mon) }));
    const out = {};
    for (const d of data?.days ?? []) {
      if (!d.flights?.length) continue;
      const key = `${year}-${mon}-${String(d.day).padStart(2, '0')}`;
      out[key] = d.flights.map(f => ({
        number: `${f.carrierCode}${f.number}`,
        dep: f.departureTime,
        arr: f.arrivalTime,
      })).sort((a, b) => a.dep.localeCompare(b.dep));
    }
    return out;
  });

/** Dates a route operates at all. Cheap pre-filter. */
export const availableDates = (from, to) =>
  through(`dates:${from}:${to}`, TTL.dates, () =>
    fetchJson(path('availabilities', { from, to })));

/** "Anywhere" search: one call ranks every destination, and returns flight numbers. */
export function anywhereFares(origin, opts = {}) {
  const q = new URLSearchParams({
    departureAirportIataCode: origin,
    outboundDepartureDateFrom: opts.from,
    outboundDepartureDateTo: opts.to,
    market: 'en-gb',
    currency: opts.currency ?? 'EUR',
    limit: String(opts.limit ?? 250),
    offset: '0',
  });
  if (opts.maxPrice) q.set('priceValueTo', String(opts.maxPrice));
  if (opts.arrivals?.length) q.set('arrivalAirportIataCodes', opts.arrivals.join(','));
  if (opts.timeFrom) q.set('outboundDepartureTimeFrom', opts.timeFrom);
  if (opts.timeTo) q.set('outboundDepartureTimeTo', opts.timeTo);
  return through(`anywhere:${q}`, TTL.fares, () => fetchJson(`${path('oneWayFares')}?${q}`));
}

/**
 * Every round trip out of an airport inside two date windows, in one request.
 *
 * Deliberately no `limit`: anything over about twenty is rejected outright with
 * InvalidLimit, and omitting it returns the full set anyway. The time-of-day
 * filters are honoured on both directions, which is what makes a "leave after
 * work, back before Monday" search a single call rather than one per destination.
 */
export function roundTripFares(origin, opts = {}) {
  const q = new URLSearchParams({
    departureAirportIataCode: origin,
    outboundDepartureDateFrom: opts.outFrom,
    outboundDepartureDateTo: opts.outTo,
    inboundDepartureDateFrom: opts.backFrom,
    inboundDepartureDateTo: opts.backTo,
    market: 'en-gb',
    currency: opts.currency ?? 'EUR',
  });
  if (opts.maxPrice) q.set('priceValueTo', String(opts.maxPrice));
  if (opts.outAfter) q.set('outboundDepartureTimeFrom', opts.outAfter);
  if (opts.outBefore) q.set('outboundDepartureTimeTo', opts.outBefore);
  if (opts.backAfter) q.set('inboundDepartureTimeFrom', opts.backAfter);
  if (opts.backBefore) q.set('inboundDepartureTimeTo', opts.backBefore);
  return through(`round:${q}`, TTL.fares, () => fetchJson(`${path('roundTripFares')}?${q}`));
}

/**
 * The fare endpoints return local wall-clock times with no offset. Subtracting two
 * of them across airports is how you compute a layover that is wrong by hours —
 * and sell someone a connection they cannot make.
 */
export function localToUtc(localIso, timeZone) {
  const naive = new Date(localIso + 'Z');
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = Object.fromEntries(fmt.formatToParts(naive).map(x => [x.type, x.value]));
  const asZone = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return new Date(naive.getTime() - (asZone - naive.getTime()));
}

/** Deep link into Ryanair's own booking flow for a single leg. */
export const bookingUrl = (from, to, date) => booking({ from, to, date });

export const hours = (ms) => ms / 3_600_000;
