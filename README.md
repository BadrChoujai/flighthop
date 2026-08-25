# Flighthop

Find the flights an airline will not sell you.

Ryanair sells point-to-point tickets, so searching Vienna → Tangier returns nothing:
there is no such route. But the network connects those two cities fourteen different
ways — through Bergamo, Barcelona, Charleroi, Madrid and others. Nobody sells that
itinerary, so nobody shows it to you.

**Ryanair only.** Every route, fare and time here comes from Ryanair's own network, so a
connection exists only if Ryanair flies both legs. Trips that would work by pairing two
different airlines are invisible to this app. That is the deliberate scope, not a gap
waiting to be filled — see [What it does not do](#what-it-does-not-do).

Flighthop searches the **route graph** instead of the route list. It stitches separate
tickets into itineraries, joins them only when the layover is one a person could
realistically make, and ranks the results by what the trip actually costs someone —
money *and* the hours they lose in a terminal.

```
€35  Wed 9 Sept · via BGY   ▓1h25▓ ░░░ 7h 15m in Bergamo ░░░ ▓2h 50m▓
     VIE 05:45 → BGY 07:10 · wait 7h 15m · BGY 14:25 → TNG 16:15   comfortable · 11h 30m door to door
```

Real output. Ryanair's own site says that trip does not exist.

## Run it

```bash
cp .env.example .env      # then fill it in — see below
node app/server.mjs
```

Open <http://localhost:5173>. There are **no dependencies to install** — the app has
none, and uses Node's built-in SQLite for its cache. Node 22+ (tested on 24.16).

The interface runs before it is configured, so you can look around a fresh clone
immediately; searching is what needs the endpoints.

## Configuring the upstream

Flighthop reads the endpoints it calls from the environment rather than from source.
Nothing about them is secret — they are an airline's own website endpoints,
unauthenticated and visible in any browser's network tab. Keeping them in
configuration is a question of what this repository *distributes*: source that spells
them out makes the project a guide for calling them, which is a different thing from a
search engine that happens to call something.

[.env.example](.env.example) documents every variable: what the endpoint must return,
which `{placeholders}` it takes, and why the app needs it. Fill it in from your own
browser's network tab in about five minutes — devtools, Network, filter to Fetch/XHR,
and read the paths off the requests the site makes as you search.

Deployed, set the same variables in your host's project settings. `GET /api/health`
reports which are present without revealing their values:

```json
{ "ok": true, "ready": true, "upstream": { "base": true, "routes": true, … } }
```

`ready: false` means a variable is missing — which otherwise looks exactly like the
airline having blocked the host, and the two have very different fixes.

## What it does

- **Connect me** — origin, destination, date range. The destination takes an airport,
  a city, or a whole country (`TNG`, `Tangier`, `Morocco`). Direct flights appear
  first when they exist; everything else is a one-stop self-connection.
- **Anywhere under €X** — one upstream call ranks every destination out of an airport
  inside a budget, filterable by country and departure-time window.
- **Month view** — best price per departure day for the complete itinerary. Click a
  day to pin results to it. The Vienna→Tangier spread for one month runs €35 to €220;
  flexibility is worth more than any booking trick.
- **Luggage, priced in** — a bag is charged per booking, and every ticket in a
  self-connection is its own booking. A direct return pays the fee twice; the same trip
  through two hubs pays it four times. Say what you are carrying and every price becomes
  the all-in cost, which regularly promotes a direct flight above a "cheaper" connection.
  Ryanair publishes no fee endpoint, so the amounts are typical figures and the interface
  labels them as estimates.
- **Risk, stated plainly** — layover length, bag re-check, border crossing, and
  whether a later flight exists on the second leg if the first one runs late.

Filters re-rank instantly in the browser. Only a new origin, destination or date range
costs a round trip to the server.

## Three things worth knowing about the data

**Times arrive with no timezone.** The fare feed returns local wall-clock strings like
`2026-09-29T13:10:00` with no offset. Subtracting two of them across airports produces
layovers wrong by one to three hours — which is how you sell someone a connection they
cannot make. Everything is converted through the airport's IANA timezone before any
comparison (`localToUtc` in [app/lib/ryanair.mjs](app/lib/ryanair.mjs)). Madrid 13:10 →
Tangier 12:40 is a correct result: Morocco's DST is not the EU's.

**"Is there a later flight?" cannot be answered by the fare feed.** It only ever
returns the cheapest flight per day, so asking it always answers no. Flighthop reads
the published timetable instead, which lists every frequency. When no timetable is
available the interface says it does not know, rather than guessing.

**Self-transfer is two tickets.** If the first flight is late, nobody owes you the
second one or a refund for it, and bags are collected and re-checked at the hub. The
interface says exactly that, next to the booking buttons — not in a footnote.

## Layout

```
.env.example         every upstream endpoint, documented but not filled in
app/                 the application
  server.mjs         local dev server — wraps the handler in node:http
  lib/handler.mjs    routes, SSE search stream, static files
  lib/endpoints.mjs  the upstream surface, read from the environment
  lib/ryanair.mjs    API client — cached, concurrency-gated, timezone-correct
  lib/cache.mjs      TTL cache — SQLite on disk, memory when serverless
  lib/search.mjs     route graph, geographic pruning, stitching, scoring
  public/            interface — vanilla JS, no build step
api/index.mjs        Vercel entry point — exports the same handler
postman/             the public Postman collections, plus a verified API reference
prototype/           the standalone scripts the app grew out of
DESIGN.md            product and interface plan
product-plan.html    the same plan as a styled page
```

## Scoring

```
score = fare
      + luggage × number of flights                       (per booking, not per trip)
      + 25 €/h  for every hour the layover is under 3h    (missed-connection risk)
      + 8 €/h   for every hour it runs over 8h            (dead time)
      + 60 €    overnight connection
      + 30 €    a border crossing the trip did not already require
      + 20 €    per extra ticket                          (another chain to break)
```

The first two weights are sliders in the app — "cost of a rushed transfer" and "cost
of dead time" — so the ranking argues with you rather than at you. A €35 fare with a
seven-hour wait and a 05:45 alarm should not automatically beat €42 with a three-hour
wait, and out of the box it doesn't.

## What it does not do

- **One airline.** No easyJet, Wizz, Vueling or anyone else. The method reads a single
  carrier's route map as a graph; mixing carriers means per-carrier layover rules, bag
  policies and terminal transfers, and getting those wrong sells someone a connection
  they cannot make.
- **No booking.** Every leg links out to Ryanair and you buy them separately. Two
  tickets is two transactions, and one "Book" button would hide a real cost.
- **No protection.** If the first flight is late and you miss the second, nobody owes
  you a seat, a refund or a hotel. That risk is the reason these trips are cheap. The
  app can tell you whether a later flight exists that day; it cannot rebook you.
- **Estimated luggage.** Typical amounts, not quotes — real fees move with route,
  season and how late the bag is added.
- **Prices go stale.** Fares are cached for hours and can move within one.

## Manners, and the legal position

This talks to Ryanair's own undocumented backend. There is no official public API, no
key, and no developer portal. Requests are capped at four concurrent with backoff, and
the cache exists so the airline sees a fraction of the traffic.

Ryanair has litigated aggressively against automated access to its fares. The endpoints
are unauthenticated and the data is public, but the site terms prohibit automated
collection and resale. **This is personal tooling.** Turning it into a commercial
product is a different question with a different answer — the honest paths there are a
distribution agreement or a licensed aggregator feed.

Not affiliated with, endorsed by, or connected to Ryanair. Fares shown are for one adult
with a small bag under the seat. Luggage is estimated, not quoted; seats, priority and
other extras are not included. Ryanair's own page is always the truth.

## Deploying

The same handler runs locally and on Vercel — `app/server.mjs` wraps it in a
`node:http` server, `api/index.mjs` exports it as a function. One code path, so
local behaviour is the deployed behaviour.

The cache picks its backend from the environment: SQLite where there is a writable
disk, memory on a serverless filesystem. A cold search against a completely empty
cache takes about 1.5 seconds, which is why losing the disk cache is survivable
rather than fatal.

Import the repository at [vercel.com/new](https://vercel.com/new) — no build command
and nothing to install. Set the variables from `.env.example` in the project's
environment settings before the first search, and check `/api/health` reports
`ready: true` afterwards.

One caveat worth testing before wiring up a domain: this talks to an airline's
undocumented backend, and datacenter IP ranges get filtered far harder than home
connections. Hit `/api/search` once on the deployed URL. If it returns `403`, the
app is fine — the address it is calling from is not, and the fix is to run it
somewhere with a residential IP.

## License

[MIT](LICENSE)
