/*
 * The upstream API surface, read from the environment rather than written here.
 *
 * Nothing in this file is a secret. These are an airline's own website endpoints —
 * unauthenticated, undocumented, and visible in any browser's network tab. Keeping
 * them in configuration is not about hiding them; it is about what this repository
 * distributes. Source that names them turns the project into a guide for calling
 * them, which is a different artefact from a flight search engine that happens to
 * call something.
 *
 * Copy .env.example to .env and fill it in — see "Configuring the upstream" in the
 * README. Values are resolved lazily, so the interface still runs unconfigured and
 * tells you what is missing at the point you search.
 */

const VARS = {
  base: 'FLIGHTHOP_API_BASE',
  airports: 'FLIGHTHOP_PATH_AIRPORTS',
  routes: 'FLIGHTHOP_PATH_ROUTES',
  cheapestPerDay: 'FLIGHTHOP_PATH_CHEAPEST_PER_DAY',
  timetable: 'FLIGHTHOP_PATH_TIMETABLE',
  availabilities: 'FLIGHTHOP_PATH_AVAILABILITIES',
  oneWayFares: 'FLIGHTHOP_PATH_ONE_WAY_FARES',
  roundTripFares: 'FLIGHTHOP_PATH_ROUND_TRIP_FARES',
  booking: 'FLIGHTHOP_URL_BOOKING',
};

function need(name) {
  const value = process.env[VARS[name]]?.trim();
  if (!value) {
    throw Object.assign(
      new Error(
        `${VARS[name]} is not set. Flighthop reads its upstream endpoints from the ` +
        `environment: copy .env.example to .env and fill it in, or set the variables ` +
        `in your host's dashboard. See "Configuring the upstream" in the README.`),
      { code: 500, config: true });
  }
  return value;
}

/**
 * Substitute {placeholders} in a path template.
 *
 * Templates are written in the environment as, for example,
 * `/some/path/{from}/{to}/by-day`, so a change upstream is a configuration change
 * rather than a code change.
 */
export function fill(template, values = {}) {
  return template.replace(/\{(\w+)\}/g, (whole, key) => {
    if (!(key in values)) throw new Error(`No value for ${whole} in ${template}`);
    return encodeURIComponent(values[key]);
  });
}

/** The origin every API path hangs off. */
export const base = () => need('base');

/** A configured path, with its placeholders filled. */
export const path = (name, values) => fill(need(name), values);

/** The public booking deep link — a normal page on the airline's own site. */
export const booking = (values) => fill(need('booking'), values);

/**
 * Which variables are set, without revealing what they are set to.
 *
 * A misconfigured deployment otherwise announces itself only as a failed search,
 * and the failure looks identical to the airline having blocked the host.
 */
export const configured = () =>
  Object.fromEntries(Object.entries(VARS).map(([k, v]) => [k, !!process.env[v]?.trim()]));
