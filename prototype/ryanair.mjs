// Thin client over the public Ryanair endpoints documented in ../postman/*.json
// No auth, no keys. Be polite: cache aggressively, keep concurrency low.

const BASE = 'https://www.ryanair.com';
const UA = 'Mozilla/5.0 (flighthop prototype)';

const cache = new Map();

async function get(path) {
  if (cache.has(path)) return cache.get(path);
  const res = await fetch(BASE + path, { headers: { 'User-Agent': UA, accept: 'application/json' } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${path}`);
  const json = await res.json();
  cache.set(path, json);
  return json;
}

/** Full airport master table: code, name, country, coordinates, IANA timeZone. */
export const airports = () => get('/api/views/locate/5/airports/en/active');

/** Every route out of `code`. This is the edge list of the route graph. */
export const routesFrom = (code) =>
  get(`/api/views/locate/searchWidget/routes/en/airport/${code}`);

/** Dates the route actually operates on, as YYYY-MM-DD strings. */
export const availableDates = (from, to) =>
  get(`/api/farfnd/v4/oneWayFares/${from}/${to}/availabilities`);

/** One month of a route: per day, cheapest fare + local departure/arrival times. */
export const cheapestPerDay = (from, to, monthFirstDay, currency = 'EUR') =>
  get(`/api/farfnd/v4/oneWayFares/${from}/${to}/cheapestPerDay?outboundMonthOfDate=${monthFirstDay}&currency=${currency}`);

/**
 * "Anywhere" fare search. One call ranks every destination reachable from an
 * origin inside a date range, and it returns flight numbers — which the gated
 * availability endpoint would otherwise be needed for.
 *
 * Returns the single cheapest fare per route, not per day. Use cheapestPerDay
 * when you need every day of a known route.
 *
 * opts: { to, from, maxPrice, arrivals[], timeFrom, timeTo, limit, currency }
 */
export function anywhereFares(origin, opts = {}) {
  const q = new URLSearchParams({
    departureAirportIataCode: origin,
    outboundDepartureDateFrom: opts.from,
    outboundDepartureDateTo: opts.to,
    market: opts.market ?? 'en-gb',
    currency: opts.currency ?? 'EUR',
    limit: String(opts.limit ?? 200),
    offset: '0',
  });
  if (opts.maxPrice) q.set('priceValueTo', String(opts.maxPrice));
  if (opts.arrivals?.length) q.set('arrivalAirportIataCodes', opts.arrivals.join(','));
  if (opts.timeFrom) q.set('outboundDepartureTimeFrom', opts.timeFrom);
  if (opts.timeTo) q.set('outboundDepartureTimeTo', opts.timeTo);
  return get(`/api/farfnd/v4/oneWayFares?${q}`);
}

/** Round trips in a single call, same filter vocabulary. */
export function roundTripFares(origin, opts = {}) {
  const q = new URLSearchParams({
    departureAirportIataCode: origin,
    outboundDepartureDateFrom: opts.outFrom,
    outboundDepartureDateTo: opts.outTo,
    inboundDepartureDateFrom: opts.backFrom,
    inboundDepartureDateTo: opts.backTo,
    market: opts.market ?? 'en-gb',
    currency: opts.currency ?? 'EUR',
    limit: String(opts.limit ?? 200),
    offset: '0',
  });
  if (opts.maxPrice) q.set('priceValueTo', String(opts.maxPrice));
  if (opts.arrivals?.length) q.set('arrivalAirportIataCodes', opts.arrivals.join(','));
  return get(`/api/farfnd/3/roundTripFares?${q}`);
}

/** Published timetable for one route in one month. No prices, but no 409 either. */
export const timetable = (from, to, year, month) =>
  get(`/api/timtbl/3/schedules/${from}/${to}/years/${year}/months/${month}`);

/** All frequencies on a date, incl. flight numbers and true UTC times. */
export const availability = (from, to, date) =>
  get(`/api/booking/v4/en-gb/availability?ADT=1&CHD=0&DateIn=&DateOut=${date}` +
      `&Destination=${to}&Disc=0&INF=0&Origin=${from}&TEEN=0&promoCode=` +
      `&IncludeConnectingFlights=false&FlexDaysBeforeOut=0&FlexDaysOut=0` +
      `&FlexDaysBeforeIn=0&FlexDaysIn=0&RoundTrip=false&ToUs=AGREED`);

/**
 * The fare endpoints return LOCAL wall-clock times with no offset.
 * Comparing them across two airports without converting is the single easiest
 * way to compute a layover that is wrong by hours. Convert via the airport's
 * IANA timeZone from the airport master table.
 */
export function localToUtc(localIso, timeZone) {
  const naive = new Date(localIso + 'Z');           // read the wall clock as if UTC
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = Object.fromEntries(fmt.formatToParts(naive).map(x => [x.type, x.value]));
  const asZone = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  const offset = asZone - naive.getTime();          // zone offset at that instant
  return new Date(naive.getTime() - offset);
}

export const hours = (ms) => ms / 3_600_000;
