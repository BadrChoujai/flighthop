// Self-connect search: treat the network as a graph, stitch separate tickets into
// itineraries, and rank them by what the trip actually costs a person — money and
// the hours they lose in a terminal.

import { airports, routesFrom, cheapestPerDay, timetable, localToUtc, bookingUrl, hours } from './ryanair.mjs';

export const DEFAULTS = {
  minLayover: 2,      // hours; below this a self-transfer is not realistic
  maxLayover: 18,
  detourFactor: 1.7,  // reject routings this many times longer than flying direct
  perDepth: { 1: 40, 2: 45, 3: 35 },   // routings priced at each stop count
  expandFirst: 16,    // first-level hubs expanded when looking for two stops
  expandSecond: 12,   // second-level hubs expanded when looking for three
  maxPartials: 300,   // stitched part-itineraries kept per routing, cheapest first
  ticketPenalty: 20,  // € per extra ticket: more chances for the chain to break
  maxReturnOrigins: 4, // airports the return search flies home from
  pairEachSide: 60,   // itineraries per direction considered when pairing
  maxPairs: 400,      // return trips kept
  minStay: 4,         // hours on the ground before the flight home can leave
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

/** IANA zone for an airport — every duration in this app depends on getting it. */
export const zoneOf = async (code) =>
  (await airportIndex()).byCode.get(code)?.timeZone ?? 'UTC';

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

function assessLayover(a, b, layover, hub, byCode, w) {
  const depHour = +b.depLocal.slice(11, 13);
  const arrHour = +a.arrLocal.slice(11, 13);
  const overnight = depHour < 6 || arrHour >= 23 || b.day !== a.day;

  // A self-transfer always means entering the hub country — you collect your bag
  // landside. What varies is whether that entry needs different paperwork than the
  // trip already required, which is what makes it worth flagging.
  const originZone = byCode.get(a.from)?.country;
  const hubCountry = byCode.get(hub)?.country;
  const newZone = !!originZone?.schengen !== !!hubCountry?.schengen;

  const where = hubCountry?.name ?? hub;
  const flags = [];
  if (layover < w.tightBelow) flags.push({ id: 'tight', label: `Only ${layover.toFixed(1)}h in ${hub} to make the transfer` });
  if (layover > w.longAbove) flags.push({ id: 'long', label: `${Math.round(layover)}h waiting in ${hub}` });
  if (overnight) flags.push({ id: 'overnight', label: `Overnight stop in ${hub}` });
  flags.push({
    id: newZone ? 'border' : 'entry',
    label: newZone
      ? `Requires entry to ${where} — outside the Schengen area you started in`
      : `You clear immigration into ${where}`,
  });
  flags.push({ id: 'bags', label: `Collect and re-check bags in ${hub}` });

  const level = layover < w.tightBelow ? 'risky' : layover < 4.5 ? 'tight' : 'comfortable';
  return { flags, level, overnight, border: newZone };
}

const RANK = { comfortable: 0, tight: 1, risky: 2 };

/**
 * Candidate routings from origin to any target, using at most `maxStops` hubs.
 *
 * Expanding the graph blindly is not an option — three levels of ~230 airports is
 * millions of paths and thousands of upstream requests. Two things keep it small:
 * the set of airports that actually reach a target is known up front (routes are
 * symmetric, so it comes from the targets' own route lists), and every hop must
 * make geographic progress, judged against flying straight there.
 */
async function buildRoutings({ origin, targets, maxStops, byCode, w, onProgress }) {
  const km = (a, b) => distanceKm(byCode.get(a), byCode.get(b));
  const toNearestTarget = (code) => Math.min(...targets.map(t => km(code, t)));
  const baseline = Math.max(toNearestTarget(origin), 1);
  const budget = baseline * w.detourFactor;

  const outbound = (await routesFrom(origin)).map(r => r.code);

  // Which airports connect to a target, and to which one.
  let inboundDone = 0;
  const arrivals = new Map();
  await Promise.all(targets.map(async (target) => {
    for (const r of await routesFrom(target)) {
      if (!arrivals.has(r.code)) arrivals.set(r.code, new Set());
      arrivals.get(r.code).add(target);
    }
    onProgress({
      phase: 'inbound', done: ++inboundDone, total: targets.length,
      label: `Finding what connects to ${byCode.get(target)?.city?.name ?? target}`,
    });
  }));

  const routings = [];
  const seen = new Set();
  const add = (path, flown) => {
    const key = path.join('>');
    if (seen.has(key)) return;
    seen.add(key);
    routings.push({ path, stops: path.length - 2, detour: +(flown / baseline).toFixed(2) });
  };

  /**
   * Hops still worth taking: somewhere new, making progress toward a target, and
   * inside the detour budget. Without the `visited` check a routing will happily
   * fly out to an airport and back again — a real result before this existed.
   */
  const viable = (from, flown, candidates, visited) => candidates
    .filter(c => !visited.includes(c) && !targets.includes(c))
    .map(c => ({ code: c, flown: flown + km(from, c) }))
    .filter(c => c.flown + toNearestTarget(c.code) <= budget)
    .sort((a, b) => (a.flown + toNearestTarget(a.code)) - (b.flown + toNearestTarget(b.code)));

  // One stop.
  const firstHops = viable(origin, 0, outbound, [origin]);
  for (const h of firstHops) {
    for (const t of arrivals.get(h.code) ?? []) {
      if (h.flown + km(h.code, t) <= budget) add([origin, h.code, t], h.flown + km(h.code, t));
    }
  }

  // Two and three stops, expanding only the most promising hubs at each level.
  if (maxStops >= 2) {
    const expand = firstHops.slice(0, w.expandFirst);
    onProgress({ phase: 'deeper', label: `Looking for two-stop routings through ${expand.length} airports` });

    const second = await Promise.all(expand.map(async (h) => ({
      via: h,
      routes: (await routesFrom(h.code)).map(r => r.code),
    })));

    const thirdLevel = [];
    for (const { via, routes } of second) {
      for (const h2 of viable(via.code, via.flown, routes, [origin, via.code])) {
        for (const t of arrivals.get(h2.code) ?? []) {
          if (h2.flown + km(h2.code, t) <= budget) {
            add([origin, via.code, h2.code, t], h2.flown + km(h2.code, t));
          }
        }
        if (maxStops >= 3) thirdLevel.push({ prefix: [origin, via.code], hop: h2 });
      }
    }

    if (maxStops >= 3 && thirdLevel.length) {
      const expand3 = thirdLevel
        .sort((a, b) => (a.hop.flown + toNearestTarget(a.hop.code)) - (b.hop.flown + toNearestTarget(b.hop.code)))
        .slice(0, w.expandSecond);
      onProgress({ phase: 'deeper', label: `Looking for three-stop routings through ${expand3.length} airports` });

      await Promise.all(expand3.map(async ({ prefix, hop }) => {
        for (const h3 of viable(hop.code, hop.flown, (await routesFrom(hop.code)).map(r => r.code), [...prefix, hop.code])) {
          for (const t of arrivals.get(h3.code) ?? []) {
            if (h3.flown + km(h3.code, t) <= budget) {
              add([...prefix, hop.code, h3.code, t], h3.flown + km(h3.code, t));
            }
          }
        }
      }));
    }
  }

  // Budget the work per depth. A flat cap sorted by stop count would be filled
  // entirely by one- and two-stop routings, and the deeper ones — the only reason
  // the user asked for more tickets — would never get priced at all.
  const byDepth = new Map();
  for (const r of routings) {
    if (!byDepth.has(r.stops)) byDepth.set(r.stops, []);
    byDepth.get(r.stops).push(r);
  }
  return [...byDepth.keys()].sort((a, b) => a - b).flatMap(stops =>
    byDepth.get(stops)
      .sort((a, b) => a.detour - b.detour)
      .slice(0, w.perDepth[stops] ?? 30));
}

/** Every viable way to fly one routing, chronologically stitched. */
function stitch(legsPerHop, w) {
  let partials = legsPerHop[0].map(leg => ({ legs: [leg], layovers: [] }));

  for (let i = 1; i < legsPerHop.length; i++) {
    const next = [];
    for (const partial of partials) {
      const arrival = partial.legs.at(-1).arr;
      for (const leg of legsPerHop[i]) {
        const wait = hours(leg.dep - arrival);
        if (wait < w.minLayover) continue;
        if (wait > w.maxLayover) break;            // legs are sorted by departure
        next.push({ legs: [...partial.legs, leg], layovers: [...partial.layovers, wait] });
      }
    }
    // Keep the cheapest partials only — otherwise a three-stop routing explodes.
    next.sort((a, b) =>
      a.legs.reduce((s, l) => s + l.price, 0) - b.legs.reduce((s, l) => s + l.price, 0));
    partials = next.slice(0, w.maxPartials);
    if (!partials.length) return [];
  }
  return partials;
}

/**
 * @param onProgress called with { phase, label, done, total } throughout. The graph
 *   has to be built before any hub can be priced, so the early phases report too —
 *   otherwise a country search sits silent for ten seconds before the first hub.
 */
/** Everything that can fly one direction, priced and ranked. */
async function oneWay({ origin, targets, window, currency, maxStops, w, byCode, onProgress }) {
  const name = (code) => byCode.get(code)?.city?.name ?? byCode.get(code)?.name ?? code;

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

  const routings = await buildRoutings({ origin, targets, maxStops, byCode, w, onProgress });

  onProgress({
    phase: 'hubs', done: 0, total: routings.length,
    label: `${routings.length} routings could get you there — pricing each one`,
  });

  const itineraries = [];
  let done = 0;

  await Promise.all(routings.map(async (routing) => {
    const hops = routing.path.slice(0, -1).map((from_, i) => [from_, routing.path[i + 1]]);

    const [legsPerHop, schedulePerHop] = await Promise.all([
      Promise.all(hops.map(([a, b]) => legOptions(a, b, window, currency))),
      Promise.all(hops.map(([a, b]) => schedules(a, b, window))),
    ]);

    if (legsPerHop.every(l => l.length)) {
      for (const { legs, layovers } of stitch(legsPerHop, w)) {
        const hubs = routing.path.slice(1, -1);
        const target = routing.path.at(-1);

        const perLayover = layovers.map((wait, i) =>
          assessLayover(legs[i], legs[i + 1], wait, hubs[i], byCode, w));

        const price = legs.reduce((sum, l) => sum + l.price, 0);
        const penalty = layovers.reduce((sum, wait, i) =>
          sum
          + (wait < w.tightBelow ? (w.tightBelow - wait) * w.tightPenalty : 0)
          + (wait > w.longAbove ? (wait - w.longAbove) * w.longPenalty : 0)
          + (perLayover[i].overnight ? w.overnightPenalty : 0)
          + (perLayover[i].border ? w.borderPenalty : 0), 0)
          // Every extra ticket is another chance for the chain to break, and
          // another check-in queue. Cheap on paper is not cheap in a terminal.
          + (legs.length - 1) * w.ticketPenalty;

        itineraries.push({
          kind: 'connection',
          stops: hubs.length,
          tickets: legs.length,
          hubs,
          hub: hubs[0],                                   // the month view's label
          hubCity: byCode.get(hubs[0])?.city?.name,
          target, targetName: byCode.get(target)?.name ?? target,
          layovers: layovers.map(v => +v.toFixed(2)),
          layover: +Math.min(...layovers).toFixed(2),     // the tightest one
          level: perLayover.map(p => p.level).sort((a, b) => RANK[b] - RANK[a])[0],
          flags: perLayover.flatMap(p => p.flags),
          detour: routing.detour,
          price: +price.toFixed(2), currency: legs[0].currency,
          total: +hours(legs.at(-1).arr - legs[0].dep).toFixed(2),
          score: +(price + penalty).toFixed(1),
          legs: legs.map((leg, i) => shape(leg, schedulePerHop[i])),
          // If a leg runs late, is there another departure that day? The fare feed
          // only carries the cheapest flight per day, so this comes from the
          // published timetable — the only open source listing every frequency.
          backups: legs.slice(1).map((leg, i) => {
            const sameDay = schedulePerHop[i + 1][leg.day] ?? [];
            const later = sameDay.find(f => f.dep > leg.depLocal.slice(11, 16));
            return later
              ? { at: hubs[i], depLocal: later.dep, flight: later.number }
              : (sameDay.length ? null : undefined);
          }),
        });
      }
    }

    onProgress({
      phase: 'hubs', done: ++done, total: routings.length,
      label: routing.path.join(' → '),
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

  const byStops = {};
  for (const it of itineraries) byStops[it.stops] = (byStops[it.stops] ?? 0) + 1;

  return {
    hubs: [...new Set(routings.flatMap(r => r.path.slice(1, -1)))],
    direct: direct.slice(0, 40),
    itineraries: itineraries.slice(0, 400),
    month,
    routingsSearched: routings.length,
    byStops,
  };
}

/**
 * A search in one or both directions.
 *
 * A return trip is two one-way searches paired up, not a different algorithm.
 * The expensive part is pricing routes, so the two directions run concurrently
 * and share one cache and one concurrency gate — and the return leg only departs
 * from airports the outbound search actually reached.
 */
export async function search({
  origin, destination, from, to, returnFrom, returnTo,
  currency = 'EUR', maxStops = 1, weights = {}, onProgress = () => {},
}) {
  const w = { ...DEFAULTS, ...weights };
  maxStops = Math.min(Math.max(1, Number(maxStops) || 1), 3);   // 2 to 4 tickets
  const roundTrip = !!(returnFrom && returnTo);

  onProgress({ phase: 'airports', label: 'Loading the airport network' });
  const { byCode } = await airportIndex();

  origin = origin.trim().toUpperCase();
  if (!byCode.has(origin)) throw Object.assign(new Error(`Unknown origin ${origin}`), { code: 400 });

  const targets = await resolveTargets(destination);
  if (!targets.length) throw Object.assign(new Error(`No airport matches "${destination}"`), { code: 400 });

  // A return window that ends before the outbound window opens can never pair:
  // every candidate fails the minimum-stay test and the search returns nothing at
  // all, with no way for anyone to see why. Say so instead.
  if (roundTrip && returnTo < from) {
    throw Object.assign(
      new Error(`You have asked to fly home by ${returnTo}, before the outbound window opens on ${from}. Check the return dates.`),
      { code: 400 });
  }

  const window = { from, to };
  const shared = { currency, maxStops, w, byCode, onProgress };

  const out = await oneWay({ origin, targets, window, ...shared });

  const base = {
    origin, targets, from, to, currency, maxStops,
    roundTrip, returnFrom: returnFrom ?? null, returnTo: returnTo ?? null,
  };

  if (!roundTrip) {
    return {
      ...base,
      hubs: out.hubs,
      direct: out.direct,
      itineraries: out.itineraries,
      month: out.month,
      meta: {
        routingsSearched: out.routingsSearched,
        hubsSearched: out.hubs.length,
        found: out.itineraries.length,
        byStops: out.byStops,
      },
    };
  }

  // Only fly home from somewhere the outbound actually lands, cheapest first.
  const landed = [...new Set([...out.direct, ...out.itineraries]
    .sort((a, b) => a.price - b.price)
    .map(it => it.legs.at(-1).to))].slice(0, w.maxReturnOrigins);

  if (!landed.length) {
    return { ...base, hubs: out.hubs, direct: [], itineraries: [], trips: [], month: {},
             meta: { routingsSearched: out.routingsSearched, hubsSearched: out.hubs.length,
                     found: 0, byStops: {}, returnOrigins: [] } };
  }

  onProgress({ phase: 'return', label: `Finding the way home from ${landed.length} airport${landed.length === 1 ? '' : 's'}` });

  const returnWindow = { from: returnFrom, to: returnTo };
  const backs = await Promise.all(landed.map(async (code) => ({
    code,
    result: await oneWay({ origin: code, targets: [origin], window: returnWindow, ...shared }),
  })));

  const home = new Map(backs.map(b => [b.code, [...b.result.direct, ...b.result.itineraries]]));

  // Pair each outbound with a return that leaves after you have arrived. Both
  // sides are capped first — the full cross product is tens of thousands of rows
  // that nobody will ever scroll to.
  const trips = [];
  const outbounds = [...out.direct, ...out.itineraries]
    .sort((a, b) => a.score - b.score).slice(0, w.pairEachSide);

  for (const o of outbounds) {
    const arrival = o.legs.at(-1);
    const arrivedAt = new Date(`${arrival.arrDate}T${arrival.arrLocal}:00Z`);
    const candidates = (home.get(arrival.to) ?? [])
      .sort((a, b) => a.score - b.score).slice(0, w.pairEachSide);

    for (const b of candidates) {
      const departs = new Date(`${b.legs[0].depDate}T${b.legs[0].depLocal}:00Z`);
      const stay = (departs - arrivedAt) / 3_600_000;
      if (stay < w.minStay) continue;
      trips.push({
        kind: 'return',
        out: o, back: b,
        target: arrival.to,
        stay: +stay.toFixed(1),
        nights: Math.max(0, Math.round(stay / 24)),
        tickets: o.legs.length + b.legs.length,
        price: +(o.price + b.price).toFixed(2),
        currency: o.currency,
        total: +(o.total + b.total).toFixed(2),
        score: +(o.score + b.score).toFixed(1),
        level: RANK[o.level ?? 'comfortable'] >= RANK[b.level ?? 'comfortable']
          ? (o.level ?? 'comfortable') : (b.level ?? 'comfortable'),
      });
    }
  }

  trips.sort((a, b) => a.score - b.score);

  const month = {};
  for (const t of trips) {
    const day = t.out.legs[0].depDate;
    if (!month[day] || t.price < month[day].price) {
      month[day] = { price: Math.round(t.price), hub: t.out.hub ?? null, layover: t.out.layover ?? null };
    }
  }

  const byStops = {};
  for (const t of trips) byStops[t.tickets] = (byStops[t.tickets] ?? 0) + 1;

  return {
    ...base,
    hubs: [...new Set([...out.hubs, ...backs.flatMap(b => b.result.hubs)])],
    direct: [], itineraries: [],
    trips: trips.slice(0, w.maxPairs),
    month,
    meta: {
      routingsSearched: out.routingsSearched + backs.reduce((n, b) => n + b.result.routingsSearched, 0),
      hubsSearched: new Set([...out.hubs, ...backs.flatMap(b => b.result.hubs)]).size,
      found: trips.length,
      byStops,
      returnOrigins: landed,
    },
  };
}
