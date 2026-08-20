# Flighthop V1

Self-connect flight search over the Ryanair network. It finds itineraries the airline
does not sell: two separate tickets through a hub, joined only if the layover is one
a person could actually make.

```bash
node server.mjs
```

Then open <http://localhost:5173>. No install step — the app has **zero dependencies**
and uses Node's built-in SQLite for its cache. Node 22+ required (tested on 24.16).

## What it does

- **Connect me** — origin, destination, date range. The destination accepts an
  airport code, a city, or a country (`TNG`, `Tangier`, `Morocco`, `ma`). Direct
  flights are shown first when they exist; everything else is a one-stop
  self-connection, ranked by fare plus the cost of the discomfort.
- **Anywhere under** — one upstream call ranks every destination out of an airport
  inside a budget, optionally filtered by country and departure time window.
- **Month view** — best price per departure day for the whole itinerary, click a day
  to pin the results to it.
- **Filters re-rank instantly.** Only a new origin, destination or date range costs a
  round trip; the sliders operate on results already in the browser.

The search bar lives in the header and swaps with the tab. Its two controls are
hand-built in [public/components.js](public/components.js), because theming a picker
library to this palette costs about as much CSS as writing one, and the app stays
dependency-free and offline:

- **`PlacePicker`** searches code, city, airport name and country at once, ranks exact
  code matches first, and offers whole countries as first-class entries — "Morocco,
  13 airports" sits above the individual Moroccan airports. Full keyboard support.
- **`DateRange`** is a two-month range calendar with presets, because a whole month is
  the answer that finds the cheap days. Past dates are disabled; hovering previews the
  range before the second click.

## Correctness, and where it matters

The fare feed returns local wall-clock times with **no UTC offset**. Subtracting two
of them across airports produces layovers that are wrong by one to three hours, which
is how you sell someone a connection they cannot make. Every time is converted through
the airport's IANA timezone before anything is compared — see `localToUtc` in
[lib/ryanair.mjs](lib/ryanair.mjs). Madrid 13:10 → Tangier 12:40 is a correct result.

The **backup flight** ("if the first leg runs late, is there a later one?") comes from
the published timetable, not the fare feed. The fare feed only ever returns the
cheapest flight per day, so asking it that question always answers "no". When the
timetable is unavailable the UI says it does not know, rather than guessing.

Self-transfer means two tickets: a missed connection is not the airline's problem, and
bags are collected and re-checked at the hub. The interface says so, in those words,
next to the booking buttons.

## Layout

```
server.mjs          HTTP server, SSE search stream, static files
lib/ryanair.mjs     API client — cached, concurrency-gated, timezone-correct
lib/cache.mjs       TTL cache on node:sqlite (airports 30d, routes 3d, fares 6h)
lib/search.mjs      route graph, geographic pruning, stitching, scoring
public/             the interface — vanilla, no build step
.cache/             created on first run
```

## Endpoints

| Route | Returns |
|---|---|
| `GET /api/search?from&to&dateFrom&dateTo&minLayover&maxLayover` | Server-sent events: `progress` per hub, then `result` |
| `GET /api/explore?from&dateFrom&dateTo&maxPrice&country&after&before` | Ranked destinations |
| `GET /api/airports` | Airport list for autocomplete |
| `GET /api/health` | Cache size |

## Scoring

`score = fare + 25 €/h under a 3h layover + 8 €/h over 8h + 60 € overnight + 30 € for
a border crossing the trip did not already require`. The first two weights are sliders
in the rail — "cost of a rushed transfer" and "cost of dead time" — so the ranking
argues with the user rather than at them.

## Manners

Concurrency is capped at 4 with backoff on 429 and 5xx. These are an airline's own
undocumented endpoints, two of which already reject naive callers (see
[../postman/API-REFERENCE.md](../postman/API-REFERENCE.md)). Ryanair has litigated
against automated access to its fares; this is personal tooling, and turning it into a
commercial product is a different question with a different answer.
