# Flighthop — self-connect search on the Ryanair network

## The problem

Ryanair sells point-to-point tickets. Its own site will happily tell you "no flights"
for Vienna → Tangier, because it only looks for a route it already stitched together.
But the network *does* connect those cities — via Bergamo, Barcelona, Charleroi,
Madrid and about ten other airports. Nobody sells that itinerary, so nobody shows it
to you. You have to know to look.

Flighthop searches the route graph instead of the route list: it finds every pair
(or triple) of flights that physically connects your origin to your destination with
a layover you'd actually accept, prices the whole chain, and ranks the results by
cost *and* by how unpleasant the connection is.

Proven working: `node prototype/search.mjs VIE TNG 2026-09-01 2026-09-30` returns
145 valid one-stop itineraries, cheapest at €35 (VIE 05:45 → Bergamo, 7.3h wait,
→ Tangier 16:15) and the best-balanced at €42 (VIE 06:15 → Barcelona, 3.3h wait,
→ Tangier 12:00, 6.8h door to door).

## Why this API makes it possible

Three endpoints do almost all the work, and none of them need a key:

| Need | Endpoint | Cost |
|---|---|---|
| The route graph (which airports connect at all) | `/api/views/locate/searchWidget/routes/en/airport/{IATA}` | 1 call per airport, changes ~seasonally → cache for days |
| Airport master data: country, coordinates, **IANA timezone** | `/api/views/locate/5/airports/en/active` | 1 call, ~87 KB, cache for weeks |
| A whole month of one route: price + departure/arrival times per day | `/api/farfnd/v4/oneWayFares/{A}/{B}/cheapestPerDay?outboundMonthOfDate=YYYY-MM-01&currency=EUR` | 1 call per route per month |
| Every frequency on a given date, with flight numbers and true UTC times | `/api/booking/v4/en-gb/availability?...&ToUs=AGREED` | 1 call per route per date — **currently returns 409 without a live `client-version` header, see postman/API-REFERENCE.md** |
| Which dates a route runs at all | `/api/farfnd/v4/oneWayFares/{A}/{B}/availabilities` | 1 call, cheap pre-filter |

The month-scan endpoint is the one that makes this viable. A conventional flight
search needs one query per date pair; here a single call returns 30 days of prices
*with times attached*, so a full month of a candidate hub costs two HTTP requests.

## Search algorithm

**1 stop.** Take `routesFrom(origin)` and `routesFrom(destination)` (Ryanair routes
are symmetric). Intersect them — that's the hub set, typically 10–20 airports out of
~230. For each hub, month-scan both legs, then join leg pairs where
`MIN_LAYOVER ≤ departure(leg2) − arrival(leg1) ≤ MAX_LAYOVER` in **UTC**.

**2 stops.** The naive version is 230² route scans and will get you rate-limited.
Prune hard, in this order:

- Only consider first hops whose destination airport has a route toward the
  destination *region* — build the reachability set from the destination backwards
  two levels first, then intersect with the origin's outbound set.
- Geographic pruning: drop any hub whose great-circle detour exceeds ~1.6× the
  direct distance (coordinates come free in the airport table). Vienna → Tangier via
  Stockholm is a route the graph allows and no human wants.
- Score hubs by `min(price of leg 1) + min(price of leg 2)` from the month scan
  before expanding date-level combinations; expand only the top ~15.
- Cap the connection count: two stops only when one stop yields nothing under the
  user's budget, or when the user explicitly asks.

**Ranking.** Cheapest-first is the wrong default — a €35 fare with a 7-hour wait and
a 05:45 departure is worse than €42 with a 3-hour wait. Convert discomfort to money
and add it to the fare:

```
score = fare
      + 25 €/h  for every hour the layover is under 3h      (missed-connection risk)
      + 8 €/h   for every hour the layover is over 8h        (dead time)
      + 60 €    if the connection is overnight
      + 40 €    if the two legs use different airports in the same city
      + 30 €    if a border crossing (Schengen in/out) sits between the legs
```

Expose the weights as sliders. "I don't mind waiting, I mind paying" is a real user;
so is the opposite.

## The traps that will make results wrong

These are not edge cases, they are the whole difficulty of the product:

1. **Local time with no offset.** `cheapestPerDay` returns `2026-09-29T13:10:00`
   with no zone. Subtracting two of those across airports produces layovers that are
   off by one to three hours — enough to sell someone a connection they cannot make.
   Convert with the airport's IANA `timeZone` from the master table (see
   `localToUtc` in `prototype/ryanair.mjs`), or read `timeUTC` from the availability
   endpoint. Morocco's DST is not the EU's; Madrid 13:10 → Tangier 12:40 is a real
   result and is correct.

2. **Self-transfer is not a protected connection.** Two separate tickets: if leg 1 is
   late, leg 2 is gone and Ryanair owes nothing. This has to be stated in the UI, not
   buried. It also justifies a minimum layover well above the airline's own MCT —
   2h is the floor, 3h is the honest default, more if bags are checked.

3. **Bags must be re-checked** at almost every self-transfer, which means clearing
   arrivals, landside, check-in desk (often only open ~2h before), security again.
   Airports where the desk opens late are a real constraint; a per-airport
   `minSelfConnect` override table is worth maintaining by hand.

4. **Ryanair's "city" airports aren't in the city.** BGY is Milan-ish, CRL is
   Brussels-ish, BVA is 80 km from Paris, STN is not central London. This matters
   for the hub choice only if the passenger leaves the airport — but it matters
   enormously if the itinerary is overnight.

5. **Border control between legs.** VIE → BGY → TNG stays inside Schengen then exits;
   VIE → STN → anywhere means a UK entry stamp for a passenger who may need a visa
   just to sit in the terminal. Flag it from the `schengen` and country fields, and
   let the user filter on nationality.

6. **Overnight connections need a bed.** If the layover crosses 23:00–06:00 local,
   either surface it as "sleep in terminal" or add an estimated hotel cost to the
   score so the comparison against a €200 direct flight is honest.

## Product shape

**MVP (the version worth building first).** One origin, one destination that can be
an airport *or a country*, a date range up to a month, one stop only. Results as a
ranked list with the full timeline of each itinerary and a deep link per leg to
Ryanair's booking page. This alone is already something no site gives you.

**The features that make it worth using twice:**

- *"Anywhere in Morocco"* — destination as a country code fans out over every airport
  in it. Already implemented in the prototype. Extend to "anywhere warm in November
  under €80", which is the search everyone actually wants to do.
- *Month heat map* — price of the best itinerary per departure day, so flexible
  travellers see the cheap week at a glance. One month scan already contains this.
- *Risk badge per itinerary* — layover length, airport size, bag re-check, border
  crossing, last-flight-of-the-day-ness rolled into green/amber/red.
- *Backup flight* — for red connections, show the next departure on leg 2 and what
  it would cost to rebook. Turns "risky" into "risky, and here's the €29 insurance".
- *Alerts* — re-run a saved search nightly, notify on a price drop or a new route.
  Cheap: one month scan per watched route.
- *Mixed carriers, later.* The graph idea is airline-agnostic; Wizz and easyJet have
  similar endpoints. Ryanair alone is enough to prove the product.

## Engineering notes

- **Caching is the whole architecture.** Airport table: weeks. Route graph: days.
  Month fares: hours (they move, but not minute to minute). Availability: minutes.
  A SQLite or Postgres table keyed `(from, to, month)` with a fetched-at column, and
  a worker that refreshes popular routes, keeps live search under a second.
- **Be a good citizen.** These are undocumented endpoints on a real airline's
  infrastructure. Serialise requests, cap concurrency at ~4, back off on 403/429,
  set a real User-Agent, and never fan out a 3-stop search unbounded. The two
  endpoints the workspace author marked "Private" (`/api/locate/v1/autocomplete/*`)
  are the most likely to break or start rejecting non-browser callers.
- **Everything is unauthenticated and CORS-restricted** — the fare endpoints will not
  answer a browser fetch from your own origin, so the search has to run server-side
  (or in a small proxy). That is also where the cache belongs.
- **Prices are per adult, cabin bag only.** The comparison against a legacy carrier's
  all-in fare is dishonest unless you let the user add bags/seats; Ryanair's ancillary
  pricing is not in these endpoints, so a flat configurable "+€X per bag per leg" is
  the pragmatic answer.

## Files

- `postman/Airports.postman_collection.json` — 10 requests, importable into Postman
- `postman/Fares.postman_collection.json` — the month-scan endpoint
- `postman/Flights.postman_collection.json` — availability + operating dates
- `prototype/ryanair.mjs` — typed-ish client, caching, timezone conversion
- `prototype/search.mjs` — working one-stop search, run it as shown above
