/**
 * Provider adapters for upstream proxies (`docs/lld/upstream-proxy.md`, HLD 8.12). A session asks
 * for an exit in provider-neutral terms (country, region, city, a sticky-session id and its
 * duration); an adapter writes that request into the credentials the way the provider documents
 * it. The egress gateway never sees any of this: it receives the final username and password.
 *
 * Only what each provider's own documentation states is implemented, cited beside it. Anything
 * a provider's documents leave open is refused with a message rather than guessed at. Providers
 * whose formats could not be confirmed (SOAX, which documents two incompatible gateways, and
 * NetNut, whose documentation could not be reached) are left out; `generic` works with them by
 * passing a username already written in their format.
 */

export const PROXY_PROVIDERS = [
  "generic",
  "brightdata",
  "oxylabs",
  "decodo",
  "iproyal",
] as const;
export type ProxyProvider = (typeof PROXY_PROVIDERS)[number];

export interface ExitRequest {
  country?: string;
  region?: string;
  city?: string;
  sticky?: string;
  stickyMinutes?: number;
}

export interface ProviderAdapter {
  readonly provider: Exclude<ProxyProvider, "generic">;
  /** Reasons this request cannot be written for the provider, by field. */
  check(p: ExitRequest & { username?: string; password?: string }): {
    path: string;
    message: string;
  }[];
  /** The credentials the proxy receives. Called only on a request `check` accepted. */
  apply(
    username: string,
    password: string | undefined,
    exit: ExitRequest,
  ): { username: string; password?: string };
}

type Issue = { path: string; message: string };

const ASCII_PLACE = /^[A-Za-z0-9][A-Za-z0-9 _]*$/;
/** `New York` or `new_york` becomes `new_york`. */
const underscored = (v: string): string =>
  v.trim().toLowerCase().replace(/[ _]+/g, "_");

/** Shared checks: the username is required; places are plain ASCII words. */
function common(
  name: string,
  p: ExitRequest & { username?: string },
  placeIssue = "must be ASCII letters, digits, spaces or '_'",
): Issue[] {
  const out: Issue[] = [];
  if (p.username === undefined)
    out.push({
      path: "username",
      message: `the ${name} adapter needs your ${name} username`,
    });
  for (const k of ["region", "city"] as const) {
    const v = p[k];
    if (v !== undefined && !ASCII_PLACE.test(v))
      out.push({ path: k, message: `${placeIssue} for ${name}` });
  }
  return out;
}

/**
 * Bright Data residential.
 * - Username `brd-customer-<id>-zone-<zone>-<parameters>`, as issued: parameters are appended.
 *   https://docs.brightdata.com/proxy-networks/config-options
 * - `-country-xx`, lowercase ISO 3166-1; `-state-<code>`, the lowercase ISO 3166-2 subdivision
 *   code without its country part (`ny`, `eng`, `47`); `-city-<name>`, lowercase with no spaces.
 *   https://docs.brightdata.com/api-reference/proxy/geolocation-targeting
 * - `-session-<id>`, alphanumeric only; no duration parameter (a session ends after 5 minutes
 *   idle). https://docs.brightdata.com/api-reference/proxy/rotate_ips
 */
const brightdata: ProviderAdapter = {
  provider: "brightdata",
  check(p) {
    const out = common("brightdata", p);
    if (
      p.username !== undefined &&
      !/^brd-customer-.+-zone-.+/.test(p.username)
    )
      out.push({
        path: "username",
        message:
          "must be the username Bright Data issued: brd-customer-<id>-zone-<zone>",
      });
    if (p.region !== undefined && !/^[A-Za-z0-9]{1,3}$/.test(p.region))
      out.push({
        path: "region",
        message:
          "for brightdata, the ISO 3166-2 subdivision code without the country part, such as ny",
      });
    if (p.stickyMinutes !== undefined)
      out.push({
        path: "stickyMinutes",
        message:
          "brightdata has no session duration: a sticky session lasts until 5 minutes idle",
      });
    return out;
  },
  apply(username, password, e) {
    let u = username;
    if (e.country) u += `-country-${e.country.toLowerCase()}`;
    if (e.region) u += `-state-${e.region.toLowerCase()}`;
    if (e.city) u += `-city-${e.city.toLowerCase().replace(/[ _]+/g, "")}`;
    if (e.sticky) u += `-session-${e.sticky}`;
    return { username: u, ...(password !== undefined ? { password } : {}) };
  },
};

/**
 * Oxylabs residential.
 * - `customer-<username>` is mandatory; `-cc-XX` (ISO 3166-1, case-insensitive).
 *   https://developers.oxylabs.io/products/proxies/residential-proxies.md
 * - `-city-<name>`, English, underscores for spaces, with `cc`; `-st-us_<state>`, US states only.
 *   The documents show `st` without `cc`, so with a region `cc` is left out (the state implies
 *   the US) and a city is refused.
 *   https://developers.oxylabs.io/products/proxies/residential-proxies/location-settings.md
 * - `-sessid-<id>` (alphanumeric), `-sesstime-<minutes>` up to 1440.
 *   https://developers.oxylabs.io/products/proxies/residential-proxies/session-control.md
 */
const oxylabs: ProviderAdapter = {
  provider: "oxylabs",
  check(p) {
    const out = common("oxylabs", p);
    if (p.region !== undefined && p.country !== "US")
      out.push({
        path: "region",
        message: "oxylabs targets states in the US only (country US)",
      });
    if (p.region !== undefined && p.city !== undefined)
      out.push({
        path: "city",
        message:
          "oxylabs documents a state or a city, not both: give one of them",
      });
    return out;
  },
  apply(username, password, e) {
    let u = username.startsWith("customer-")
      ? username
      : `customer-${username}`;
    if (e.region) u += `-st-us_${underscored(e.region).replace(/^us_/, "")}`;
    else if (e.country) u += `-cc-${e.country}`;
    if (e.city) u += `-city-${underscored(e.city)}`;
    if (e.sticky) u += `-sessid-${e.sticky}`;
    if (e.stickyMinutes !== undefined) u += `-sesstime-${e.stickyMinutes}`;
    return { username: u, ...(password !== undefined ? { password } : {}) };
  },
};

/**
 * Decodo (formerly Smartproxy) residential.
 * - `user-<username>`; `-country-xx` (lowercase); `-state-us_<state>`, US only; `-city-<name>`,
 *   underscores for spaces, with `country`; `-session-<id>`.
 *   https://help.decodo.com/docs/residential-proxy-user-pass-requests
 *   https://help.decodo.com/docs/residential-proxy-advanced-parameters
 * - `-sessionduration-<minutes>`, 1 to 1440, with `session`.
 *   https://help.decodo.com/docs/residential-proxy-custom-sticky-sessions
 */
const decodo: ProviderAdapter = {
  provider: "decodo",
  check(p) {
    const out = common("decodo", p);
    if (p.region !== undefined && p.country !== "US")
      out.push({
        path: "region",
        message: "decodo targets states in the US only (country US)",
      });
    return out;
  },
  apply(username, password, e) {
    let u = username.startsWith("user-") ? username : `user-${username}`;
    if (e.country) u += `-country-${e.country.toLowerCase()}`;
    if (e.region) u += `-state-us_${underscored(e.region).replace(/^us_/, "")}`;
    if (e.city) u += `-city-${underscored(e.city)}`;
    if (e.sticky) u += `-session-${e.sticky}`;
    if (e.stickyMinutes !== undefined)
      u += `-sessionduration-${e.stickyMinutes}`;
    return { username: u, ...(password !== undefined ? { password } : {}) };
  },
};

/**
 * IPRoyal residential: the parameters go in the password, `<password>_key-value_...`.
 * https://docs.iproyal.com/proxies/residential/proxy.md
 * - `_country-xx`; `_state-<name>` (US); `_city-<name>`, with a country. How names of more
 *   than one word are written is not documented (IPRoyal lists the values through its API), so
 *   only single-word names are accepted.
 *   https://docs.iproyal.com/proxies/residential/proxy/location.md
 * - `_session-<id>`, exactly 8 alphanumeric characters; `_lifetime-<n>m`, 1 second to 7 days.
 *   https://docs.iproyal.com/proxies/residential/proxy/rotation.md
 */
const iproyal: ProviderAdapter = {
  provider: "iproyal",
  check(p) {
    const out = common(
      "iproyal",
      p,
      "must be one word of ASCII letters (IPRoyal does not document multi-word names)",
    );
    if (p.password === undefined)
      out.push({
        path: "password",
        message: "the iproyal adapter writes the exit into the password",
      });
    for (const k of ["region", "city"] as const) {
      const v = p[k];
      if (v !== undefined && !/^[A-Za-z]+$/.test(v))
        out.push({
          path: k,
          message:
            "must be one word of ASCII letters for iproyal (multi-word names are not documented)",
        });
    }
    if (p.region !== undefined && p.country !== "US")
      out.push({
        path: "region",
        message: "iproyal targets states in the US only (country US)",
      });
    if (p.sticky !== undefined && !/^[A-Za-z0-9]{8}$/.test(p.sticky))
      out.push({
        path: "sticky",
        message: "iproyal needs a session id of exactly 8 letters and digits",
      });
    return out;
  },
  apply(username, password, e) {
    let pw = password ?? "";
    if (e.country) pw += `_country-${e.country.toLowerCase()}`;
    if (e.region) pw += `_state-${e.region.toLowerCase()}`;
    if (e.city) pw += `_city-${e.city.toLowerCase()}`;
    if (e.sticky) pw += `_session-${e.sticky}`;
    if (e.stickyMinutes !== undefined) pw += `_lifetime-${e.stickyMinutes}m`;
    return { username, password: pw };
  },
};

const ADAPTERS: Record<Exclude<ProxyProvider, "generic">, ProviderAdapter> = {
  brightdata,
  oxylabs,
  decodo,
  iproyal,
};

/** The adapter for a provider, or undefined for `generic` (credentials sent as given). */
export function providerAdapter(
  provider: ProxyProvider | undefined,
): ProviderAdapter | undefined {
  return provider === undefined || provider === "generic"
    ? undefined
    : ADAPTERS[provider];
}
