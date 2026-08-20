// Best one-stop price per departure day — the data behind the month view.
//   node heatmap.mjs VIE TNG 2026-09-01 2026-09-30
import { airports, routesFrom, cheapestPerDay, localToUtc, hours } from './ryanair.mjs';

const [, , ORIGIN, DEST, FROM, TO] = process.argv;
const MIN_LAYOVER_H = 2, MAX_LAYOVER_H = 18;

const byCode = new Map((await airports()).map(a => [a.code, a]));
const tz = (c) => byCode.get(c)?.timeZone ?? 'UTC';

const outCodes = new Set((await routesFrom(ORIGIN)).map(r => r.arrivalAirport.code));
const hubs = (await routesFrom(DEST)).map(r => r.arrivalAirport.code)
  .filter(h => h !== ORIGIN && outCodes.has(h));

const month = FROM.slice(0, 7) + '-01';
const legs = async (a, b) => ((await cheapestPerDay(a, b, month).catch(() => null))?.outbound?.fares ?? [])
  .filter(f => f.price && !f.unavailable && !f.soldOut && f.day >= FROM && f.day <= TO)
  .map(f => ({ day: f.day, dep: localToUtc(f.departureDate, tz(a)), arr: localToUtc(f.arrivalDate, tz(b)), price: f.price.value }));

const best = {};
for (const hub of hubs) {
  const l1 = await legs(ORIGIN, hub), l2 = await legs(hub, DEST);
  for (const a of l1) for (const b of l2) {
    const w = hours(b.dep - a.arr);
    if (w < MIN_LAYOVER_H || w > MAX_LAYOVER_H) continue;
    const p = Math.round(a.price + b.price);
    if (!best[a.day] || p < best[a.day].price) best[a.day] = { price: p, hub, wait: +w.toFixed(1) };
  }
}
console.log(JSON.stringify(best));
