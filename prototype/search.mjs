// Self-connect search across the Ryanair route graph.
//   node search.mjs VIE TNG 2026-09-01 2026-09-30
// Destination may be an IATA code or a 2-letter country code (e.g. "ma").

import { airports, routesFrom, cheapestPerDay, localToUtc, hours } from './ryanair.mjs';

const MIN_LAYOVER_H = 2;    // self-transfer: land, clear immigration, re-check bag, re-clear security
const MAX_LAYOVER_H = 18;   // above this it stops being a layover and becomes a stopover
const NIGHT_START = 23;     // local hour after which a layover is "sleep in the terminal"
const NIGHT_END = 6;

const [, , ORIGIN, DEST, FROM_DATE, TO_DATE] = process.argv;

const byCode = new Map((await airports()).map(a => [a.code, a]));
const tz = (code) => byCode.get(code)?.timeZone ?? 'UTC';
const label = (code) => `${code} ${byCode.get(code)?.name ?? '?'}`;

// Resolve destination: single airport, or every airport in a country.
const targets = DEST.length === 3 && byCode.has(DEST.toUpperCase())
  ? [DEST.toUpperCase()]
  : [...byCode.values()].filter(a => a.country.code === DEST.toLowerCase()).map(a => a.code);

console.log(`\n${label(ORIGIN)}  ->  ${targets.map(label).join(' | ')}   ${FROM_DATE}..${TO_DATE}\n`);

// --- 1. route graph: one hop out of origin, one hop into each target -----------
const out = await routesFrom(ORIGIN);
const outCodes = new Set(out.map(r => r.arrivalAirport.code));

const direct = targets.filter(t => outCodes.has(t));
if (direct.length) console.log(`direct routes exist: ${direct.join(', ')}\n`);

const hubs = new Map(); // hub -> [targets reachable from hub]
for (const t of targets) {
  for (const r of await routesFrom(t)) {           // Ryanair routes are symmetric
    const h = r.arrivalAirport.code;
    if (h !== ORIGIN && outCodes.has(h)) {
      if (!hubs.has(h)) hubs.set(h, []);
      hubs.get(h).push(t);
    }
  }
}
console.log(`${hubs.size} one-stop hubs: ${[...hubs.keys()].join(' ')}\n`);

// --- 2. price + time scan, one call per route per month ------------------------
const months = [...new Set([FROM_DATE, TO_DATE].map(d => d.slice(0, 7) + '-01'))];

async function legs(from, to) {
  const rows = [];
  for (const m of months) {
    let data;
    try { data = await cheapestPerDay(from, to, m); } catch { continue; }
    for (const f of data?.outbound?.fares ?? []) {
      if (!f.price || f.unavailable || f.soldOut) continue;
      if (f.day < FROM_DATE || f.day > TO_DATE) continue;
      rows.push({
        from, to, day: f.day,
        depLocal: f.departureDate, arrLocal: f.arrivalDate,
        dep: localToUtc(f.departureDate, tz(from)),
        arr: localToUtc(f.arrivalDate, tz(to)),
        price: f.price.value, currency: f.price.currencyCode,
      });
    }
  }
  return rows;
}

// --- 3. stitch legs into itineraries ------------------------------------------
const itineraries = [];
for (const [hub, reach] of hubs) {
  const leg1 = await legs(ORIGIN, hub);
  if (!leg1.length) continue;
  for (const t of new Set(reach)) {
    const leg2 = await legs(hub, t);
    for (const a of leg1) for (const b of leg2) {
      const layover = hours(b.dep - a.arr);
      if (layover < MIN_LAYOVER_H || layover > MAX_LAYOVER_H) continue;
      const h = Number(b.depLocal.slice(11, 13));
      itineraries.push({
        hub, target: t, layover,
        price: a.price + b.price,
        total: hours(b.arr - a.dep),
        overnight: h >= NIGHT_START || h < NIGHT_END,
        a, b,
      });
    }
  }
}

// --- 4. rank: price and layover comfort together, not price alone --------------
const comfort = (l) => (l < 3 ? 25 * (3 - l) : l > 8 ? 8 * (l - 8) : 0); // € of "pain"
itineraries.sort((x, y) =>
  (x.price + comfort(x.layover) + (x.overnight ? 60 : 0)) -
  (y.price + comfort(y.layover) + (y.overnight ? 60 : 0)));

console.log(`${itineraries.length} valid one-stop itineraries\n`);
for (const it of itineraries.slice(0, 12)) {
  console.log(
    `${String(Math.round(it.price)).padStart(4)} ${it.a.currency}  ` +
    `${it.a.day}  ${ORIGIN} ${it.a.depLocal.slice(11, 16)} -> ${it.hub} ${it.a.arrLocal.slice(11, 16)}` +
    `   [wait ${it.layover.toFixed(1)}h${it.overnight ? ' overnight' : ''}]   ` +
    `${it.hub} ${it.b.depLocal.slice(11, 16)} -> ${it.target} ${it.b.arrLocal.slice(11, 16)}` +
    `  (${it.b.day}, door-to-door ${it.total.toFixed(1)}h)`);
}
