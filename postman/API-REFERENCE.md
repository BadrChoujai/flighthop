# Ryanair API surface — what actually exists (verified 2026-08-20)

There is **no official public Ryanair API**. No developer portal, no OpenAPI/Swagger
document, no key you can sign up for. Everything below is the private backend of
ryanair.com, reverse-engineered by the community. Treat it as undocumented and
unstable: shapes change without notice, and endpoints get gated over time.

Distribution partners (Kiwi, TUI, loveholidays and similar) get real feeds through
signed "Approved OTA" agreements negotiated commercially, not through a self-serve
portal.

## Live hosts

| Host | Status |
|---|---|
| `www.ryanair.com/api/*` | **alive** — the main surface, used by the website |
| `services-api.ryanair.com/*` | **alive** — same handlers, no `/api` prefix |
| `api.ryanair.com` | **dead** (NXDOMAIN) — the host in most pre-2020 blog posts and gists |
| `desktopapps.ryanair.com` | **dead** (NXDOMAIN) |
| `developer.ryanair.com` | **dead** (NXDOMAIN) — no such portal |

Anything you find referencing the last three is stale. That includes the widely
cited 2015 gist.

## Verified endpoint status

| Endpoint | Status | Notes |
|---|---|---|
| `/api/views/locate/5/airports/en/active` | 200 | 87 KB airport master table |
| `/api/views/locate/3/airports/en/active` | 200 | older shape |
| `/api/views/locate/5/airports/en/{IATA}` | 200 | single airport |
| `/api/views/locate/searchWidget/routes/en/airport/{IATA}` | 200 | route graph edge list |
| `/api/views/locate/3/countries/en` | 200 | country list (`locate/5/countries` is 404) |
| `/api/geoloc/v5/nearbyAirports?market=` | 200 | IP-based |
| `/api/geoloc/v5/defaultAirport?market=` | 200 | IP-based |
| `/api/farfnd/v4/oneWayFares/{A}/{B}/cheapestPerDay?outboundMonthOfDate=&currency=` | 200 | month of prices + times |
| `/api/farfnd/v4/oneWayFares/{A}/{B}/availabilities` | 200 | operating dates |
| `/api/farfnd/v4/oneWayFares?departureAirportIataCode=…&priceValueTo=…` | 200 | **"anywhere" search** — not in the Postman workspace |
| `/api/farfnd/3/roundTripFares?…` | 200 | **round trips** — not in the workspace |
| `/api/timtbl/3/schedules/{IATA}/periods` | 200 | bookable window |
| `/api/timtbl/3/schedules/{A}/{B}/years/{Y}/months/{M}` | 200 | **per-route timetable** — not in the workspace |
| `/api/booking/v4/en-gb/availability?…&ToUs=AGREED` | **409** | `{"message":"Availability declined"}` — now gated |
| `/api/locate/v1/autocomplete/airports?phrase=` | **403** | the workspace's "Private" folder |
| `/api/locate/v1/autocomplete/routes?…` | **403** | same |
| `/api/flightinfo/3/flights?…` | 404 | gone |

### The two gates

**409 on `availability`.** The site sends a `client-version` header taken from its
own runtime config, plus an `fr-correlation-id` cookie. A hardcoded version does not
work — I tested `3.9.0`, `0.160.2` and `21.1.1`, all 409. The working pattern (used
by `@2bad/ryanair`) is to scrape the version the site is currently serving, pin it
in memory, and re-scrape on the next 409.

**403 on `locate/v1/autocomplete/*`.** Bot filtering. Not needed — the airport master
table gives you better autocomplete offline anyway.

Neither gate blocks Flighthop: the whole one-stop search runs on `cheapestPerDay`
plus the route graph, which are both open. `availability` is only needed for exact
flight numbers and multiple daily frequencies.

## Endpoints worth adding to the app

Three useful ones the Postman workspace never captured:

```
# every destination from VIE under €60 in September, ranked
GET /api/farfnd/v4/oneWayFares?departureAirportIataCode=VIE
    &outboundDepartureDateFrom=2026-09-01&outboundDepartureDateTo=2026-09-30
    &market=en-gb&limit=20&priceValueTo=60

# round trips in one call
GET /api/farfnd/3/roundTripFares?departureAirportIataCode=VIE
    &outboundDepartureDateFrom=…&inboundDepartureDateFrom=…&priceValueTo=…

# published timetable for one route in one month (frequencies, no prices)
GET /api/timtbl/3/schedules/VIE/BGY/years/2026/months/9
```

The first turns "fly me somewhere warm and cheap" into a single request. The third
gives frequencies without touching the gated availability endpoint — useful for
sanity-checking that a connection has a later backup flight.

## Community sources

- [`2BAD/ryanair`](https://github.com/2BAD/ryanair) — TypeScript client, best-maintained, handles the 409 version pinning
- [`cohaolain/ryanair-py`](https://github.com/cohaolain/ryanair-py) — Python equivalent
- [`W95Psp/RyanairJs`](https://github.com/W95Psp/RyanairJs) — older TS lib, useful data structures
- [vool's gist](https://gist.github.com/vool/bbd64eeee313d27a82ab) — the canonical 2015 endpoint list; hosts are dead, kept for archaeology
- [`mbalos16/ryanair_timecapsule`](https://github.com/mbalos16/ryanair_timecapsule) — price-history scraping setup

## Legal note

Ryanair has litigated aggressively against automated access to its site and fares
(the Booking.com CFAA case in the US, PR Aviation at the CJEU, and a long line of
actions against screen-scraping OTAs). The endpoints are unauthenticated and the
data is public, but the website terms prohibit automated collection and commercial
resale. Personal or research tooling is a very different risk position from a
public commercial product. If Flighthop is ever meant to make money, the honest
paths are a distribution agreement or a licensed aggregator feed (Amadeus, Duffel,
Kiwi Tequila) rather than scaling this up quietly.
