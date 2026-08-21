// Self-connect search: treat the network as a graph, stitch separate tickets into
// itineraries, and rank them by what the trip actually costs a person — money and
// the hours they lose in a terminal.

import { airports, routesFrom, cheapestPerDay, timetable, localToUtc, bookingUrl, hours } from './ryanair.mjs';

export const DEFAULTS = {
  minLayover: 2,      // hours; below this a self-transfer is not realistic
  maxLayover: 18,
  detourFactor: 1.7,  // reject hubs this many times further than flying direct
  maxHubs: 22,
  tightBelow: 3,      // hours; comfort starts here
  longAbove: 8,
  tightPenalty: 25,   // € per hour under tightBelow
  longPenalty: 8,     // € per hour over longAbove
  overnightPenalty: 60,
  borderPenalty: 30,
};

let index = null;
async function airportIndex() {
  if (index) return index;
  const list = await airports();
  index = {
    byCode: new Map(list.map(a => [a.code, a])),
    list: list.map(a => ({
      code: a.code, name: a.name, city: a.city.name,
      country: a.country.name, countryCode: a.country.code,
    })),
  };
  return index;
}
export const allAirports = async () => (await airportIndex()).list;

/**
 * Closest served airport to a point. Used to guess where the visitor is starting
 * from, so the form arrives already filled in.
 */
export async function nearestAirport(lat, lon) {
  const { byCode } = await airportIndex();
  const here = { coordinates: { latitude: lat, longitude: lon } };
  let best = null;
  for (const a of byCode.values()) {
    if (!a.coordinates) continue;
    const km = distanceKm(here, a);
    if (!best || km < best.km) best = { code: a.code, city: a.city.name, country: a.country.name, km: Math.round(km) };
  }
  return best;
}

const rad = (d) => d * Math.PI / 180;
function distanceKm(a, b) {
  const [la1, lo1, la2, lo2] = [a.coordinates.latitude, a.coordinates.longitude,
                                b.coordinates.latitude, b.coordinates.longitude].map(rad);
  const h = Math.sin((la2 - la1) / 2) ** 2 +
            Math.cos(la1) * Math.cos(la2) * Math.sin((lo2 - lo1) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

/** "TNG", "ma", or "morocco" all resolve to a list of destination airports. */
export async function resolveTargets(input) {
  const { byCode, list } = await airportIndex();
  const q = input.trim();
  if (byCode.has(q.toUpperCase())) return [q.toUpperCase()];
  const lower = q.toLowerCase();
  const inCountry = list.filter(a => a.countryCode === lower || a.country.toLowerCase() === lower);
  if (inCountry.length) return inCountry.map(a => a.code);
  const byCity = list.filter(a => a.city.toLowerCase() === lower || a.name.toLowerCase() === lower);
  if (byCity.length) return byCity.map(a => a.code);
  return [];
}

const monthsBetween = (from, to) => {
  const out = [];
  const d = new Date(from + 'T00:00:00Z');
  const end = new Date(to + 'T00:00:00Z');
  while (d <= end) {
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`);
    d.setUTCMonth(d.getUTCMonth() + 1);
  }
  return [...new Set(out)];
};

/** Merged timetable for a route across the whole search window. */
async function schedules(from, to, window) {
  const merged = {};
  for (const month of monthsBetween(window.from, window.to)) {
    try { Object.assign(merged, await timetable(from, to, month.slice(0, 7))); } catch { /* schedule is optional */ }
  }
  return merged;
}

async function legOptions(from, to, window, currency) {
  const { byCode } = await airportIndex();
  const tzFrom = byCode.get(from)?.timeZone ?? 'UTC';
  const tzTo = byCode.get(to)?.timeZone ?? 'UTC';
  const out = [];
  for (const month of monthsBetween(window.from, window.to)) {
    let data;
    try { data = await cheapestPerDay(from, to, month, currency); } catch { continue; }
    for (const f of data?.outbound?.fares ?? []) {
      if (!f.price || f.unavailable || f.soldOut) continue;
      if (f.day < window.from || f.day > window.to) continue;
      out.push({
        from, to, day: f.day,
        depLocal: f.departureDate, arrLocal: f.arrivalDate,
        dep: localToUtc(f.departureDate, tzFrom),
        arr: localToUtc(f.arrivalDate, tzTo),
        price: f.price.value,
        currency: f.price.currencyCode,
        book: bookingUrl(from, to, f.day),
      });
    }
  }
  return out.sort((a, b) => a.dep - b.dep);
}

/** Match a fare to its scheduled flight so the itinerary can name the flight number. */
function flightNumber(schedule, day, depLocal) {
  return schedule?.[day]?.find(f => f.dep === depLocal.slice(11, 16))?.number ?? null;
}

function shape(leg, schedule) {
  return {
    from: leg.from, to: leg.to, day: leg.day,
    depLocal: leg.depLocal.slice(11, 16), arrLocal: leg.arrLocal.slice(11, 16),
    depDate: leg.depLocal.slice(0, 10), arrDate: leg.arrLocal.slice(0, 10),
    duration: +hours(leg.arr - leg.dep).toFixed(2),
    price: +leg.price.toFixed(2), currency: leg.currency, book: leg.book,
    flight: flightNumber(schedule, leg.day, leg.depLocal),
  };
}

function assess(a, b, layover, hub, byCode, w) {
  const depHour = +b.depLocal.slice(11, 13);
  const arrHour = +a.arrLocal.slice(11, 13);
  const overnight = depHour < 6 || arrHour >= 23 || b.day !== a.day;

  // A self-transfer always means entering the hub country — you collect your bag
  // landside. What varies is whether that entry needs different paperwork than the
  // trip already required, which is what makes it worth flagging.
  const originZone = byCode.get(a.from)?.country;
  const hubCountry = byCode.get(hub)?.country;
  const newZone = !!originZone?.schengen !== !!hubCountry?.schengen;

  const flags = [];
  if (layover < w.tightBelow) flags.push({ id: 'tight', label: `Only ${layover.toFixed(1)}h to make the transfer` });
  if (layover > w.longAbove) flags.push({ id: 'long', label: `${Math.round(layover)}h waiting at the airport` });
  if (overnight) flags.push({ id: 'overnight', label: 'Overnight connection' });
  flags.push({
    id: newZone ? 'border' : 'entry',
    label: newZone
      ? `Requires entry to ${hubCountry?.name ?? hub} — outside the Schengen area you started in`
      : `You clear immigration into ${hubCountry?.name ?? hub}`,
  });
  flags.push({ id: 'bags', label: 'Collect and re-check bags between flights' });

  const level = layover < w.tightBelow ? 'risky' : layover < 4.5 ? 'tight' : 'comfortable';
  return { flags, level, overnight, border: newZone };
}

/**
 * @param onProgress called with { phase, label, done, total } throughout. The graph
 *   has to be built before any hub can be priced, so the early phases report too —
 *   otherwise a country search sits silent for ten seconds before the first hub.
 */
export async function search({
  origin, destination, from, to, currency = 'EUR', weights = {}, onProgress = () => {},
}) {
  const w = { ...DEFAULTS, ...weights };

  onProgress({ phase: 'airports', label: 'Loading the airport network' });
  const { byCode } = await airportIndex();
  const name = (code) => byCode.get(code)?.city?.name ?? byCode.get(code)?.name ?? code;

  origin = origin.trim().toUpperCase();
  if (!byCode.has(origin)) throw Object.assign(new Error(`Unknown origin ${origin}`), { code: 400 });

  const targets = await resolveTargets(destination);
  if (!targets.length) throw Object.assign(new Error(`No airport matches "${destination}"`), { code: 400 });

  const window = { from, to };

  onProgress({ phase: 'graph', label: `Mapping every route out of ${name(origin)}` });
  const outbound = new Set((await routesFrom(origin)).map(r => r.code));

  // Direct routes first — if one exists the whole exercise may be unnecessary.
  // Fan out across targets: a country search has a dozen of them, and doing these
  // one after another is most of the wait before the first result appears. The
  // client is capped at four concurrent requests regardless.
  const directTargets = targets.filter(t => outbound.has(t));
  let directDone = 0;
  const direct = (await Promise.all(directTargets.map(async (t) => {
    const [schedule, legs] = await Promise.all([
      schedules(origin, t, window),
      legOptions(origin, t, window, currency),
    ]);
    onProgress({
      phase: 'direct', done: ++directDone, total: directTargets.length,
      label: `Pricing direct flights to ${name(t)}`,
    });
    return legs.map(leg => ({
      kind: 'direct', target: t, price: leg.price, currency: leg.currency,
      total: +hours(leg.arr - leg.dep).toFixed(2), score: leg.price,
      legs: [shape(leg, schedule)],
    }));
  }))).flat();
  direct.sort((a, b) => a.price - b.price);

  // Candidate hubs: reachable from origin and connected to a target.
  let inboundDone = 0;
  const inbound = await Promise.all(targets.map(async (target) => {
    const routes = await routesFrom(target);
    onProgress({
      phase: 'inbound', done: ++inboundDone, total: targets.length,
      label: `Finding what connects to ${name(target)}`,
    });
    return { target, routes };
  }));

  const candidates = new Map();
  for (const { target, routes } of inbound) {
    for (const r of routes) {
      if (r.code === origin || !outbound.has(r.code)) continue;
      if (!candidates.has(r.code)) candidates.set(r.code, new Set());
      candidates.get(r.code).add(target);
    }
  }

  // Geographic pruning: the graph allows Vienna to Tangier via Stockholm. Nobody wants it.
  const ranked = [...candidates.entries()]
    .map(([hub, reach]) => {
      const detour = Math.min(...[...reach].map(t => {
        const straight = distanceKm(byCode.get(origin), byCode.get(t));
        const viaHub = distanceKm(byCode.get(origin), byCode.get(hub)) +
                       distanceKm(byCode.get(hub), byCode.get(t));
        return viaHub / Math.max(straight, 1);
      }));
      return { hub, reach: [...reach], detour };
    })
    .filter(h => h.detour <= w.detourFactor)
    .sort((a, b) => a.detour - b.detour)
    .slice(0, w.maxHubs);

  onProgress({
    phase: 'hubs', done: 0, total: ranked.length,
    label: `${ranked.length} airports could connect you — pricing each one`,
  });

  const itineraries = [];
  let done = 0;
  await Promise.all(ranked.map(async ({ hub, reach, detour }) => {
    const first = await legOptions(origin, hub, window, currency);
    const firstSchedule = await schedules(origin, hub, window);
    if (first.length) {
      for (const t of reach) {
        const second = await legOptions(hub, t, window, currency);
        const secondSchedule = await schedules(hub, t, window);
        for (const a of first) {
          for (const b of second) {
            const layover = hours(b.dep - a.arr);
            if (layover < w.minLayover || layover > w.maxLayover) continue;
            const { flags, level, overnight, border } = assess(a, b, layover, hub, byCode, w);
            const price = a.price + b.price;
            const penalty =
              (layover < w.tightBelow ? (w.tightBelow - layover) * w.tightPenalty : 0) +
              (layover > w.longAbove ? (layover - w.longAbove) * w.longPenalty : 0) +
              (overnight ? w.overnightPenalty : 0) +
              (border ? w.borderPenalty : 0);
            itineraries.push({
              kind: 'connection', hub, hubName: byCode.get(hub)?.name ?? hub,
              hubCity: byCode.get(hub)?.city?.name, target: t,
              targetName: byCode.get(t)?.name ?? t,
              layover: +layover.toFixed(2), level, flags, detour: +detour.toFixed(2),
              price: +price.toFixed(2), currency: a.currency,
              total: +hours(b.arr - a.dep).toFixed(2),
              score: +(price + penalty).toFixed(1),
              legs: [shape(a, firstSchedule), shape(b, secondSchedule)],
              // If leg 1 runs late, is there another departure that day? The fare feed
              // only carries the cheapest flight per day, so this comes from the
              // published timetable — the only open source that lists every frequency.
              backup: (() => {
                const sameDay = secondSchedule[b.day] ?? [];
                const later = sameDay.find(f => f.dep > b.depLocal.slice(11, 16));
                return later
                  ? { depLocal: later.dep, flight: later.number }
                  : (sameDay.length ? null : undefined);
              })(),
            });
          }
        }
      }
    }
    onProgress({
      phase: 'hubs', done: ++done, total: ranked.length,
      hub, hubName: byCode.get(hub)?.name ?? hub,
      label: `${byCode.get(hub)?.name ?? hub} (${hub})`,
    });
  }));

  itineraries.sort((a, b) => a.score - b.score);

  // Best price per departure day, for the month view.
  const month = {};
  for (const it of [...direct, ...itineraries]) {
    const day = it.legs[0].depDate;
    if (!month[day] || it.price < month[day].price) {
      month[day] = { price: Math.round(it.price), hub: it.hub ?? null, layover: it.layover ?? null };
    }
  }

  return {
    origin, targets, from, to, currency,
    hubs: ranked.map(r => r.hub),
    direct: direct.slice(0, 20),
    itineraries: itineraries.slice(0, 200),
    month,
    meta: { hubsSearched: ranked.length, found: itineraries.length },
  };
}
