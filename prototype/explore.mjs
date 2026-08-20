// "Fly me anywhere under €X" — the discovery half of Flighthop.
//   node explore.mjs VIE 2026-09-01 2026-09-30 60
//   node explore.mjs VIE 2026-09-01 2026-09-30 60 --country=es,it --after=09:00 --before=20:00
//
// One HTTP call ranks every destination reachable from the origin in the window.

import { airports, anywhereFares, localToUtc, hours } from './ryanair.mjs';

const [, , ORIGIN, FROM, TO, MAX = '100', ...flags] = process.argv;
const flag = (n) => flags.find(f => f.startsWith(`--${n}=`))?.split('=')[1];

const countries = flag('country')?.toLowerCase().split(',');
const timeFrom = flag('after');
const timeTo = flag('before');

const byCode = new Map((await airports()).map(a => [a.code, a]));

const data = await anywhereFares(ORIGIN, {
  from: FROM, to: TO, maxPrice: Number(MAX), timeFrom, timeTo,
});

const rows = (data.fares ?? [])
  .map(f => f.outbound)
  .filter(o => !countries || countries.includes(o.arrivalAirport.city.countryCode))
  .map(o => {
    const dst = o.arrivalAirport.iataCode;
    const dep = localToUtc(o.departureDate, byCode.get(ORIGIN)?.timeZone ?? 'UTC');
    const arr = localToUtc(o.arrivalDate, byCode.get(dst)?.timeZone ?? 'UTC');
    return {
      dst, city: o.arrivalAirport.city.name, country: o.arrivalAirport.countryName,
      price: o.price.value, cur: o.price.currencySymbol,
      day: o.departureDate.slice(0, 10),
      depT: o.departureDate.slice(11, 16), arrT: o.arrivalDate.slice(11, 16),
      flight: o.flightNumber,
      dur: hours(arr - dep),
      wasPrice: o.previousPrice,
      newRoute: o.newRoute,
    };
  })
  .sort((a, b) => a.price - b.price);

console.log(`\n${ORIGIN} -> anywhere under ${MAX}, ${FROM}..${TO}` +
            `${countries ? ' in ' + countries.join('/').toUpperCase() : ''}` +
            `${timeFrom || timeTo ? ` departing ${timeFrom ?? '00:00'}-${timeTo ?? '23:59'}` : ''}\n`);
console.log(`${rows.length} destinations\n`);

for (const r of rows) {
  console.log(
    `${(r.cur + r.price.toFixed(2)).padStart(8)}  ${r.dst}  ${r.city.padEnd(18)}` +
    `${r.country.padEnd(16)} ${r.day} ${r.depT}->${r.arrT}  ${r.dur.toFixed(1)}h  ${r.flight}` +
    `${r.wasPrice ? `  (was ${r.cur}${r.wasPrice.value})` : ''}${r.newRoute ? '  NEW' : ''}`);
}
