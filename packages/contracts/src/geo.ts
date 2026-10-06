import { z } from "zod";

/**
 * Exit geography and time zones for upstream proxies (`docs/lld/upstream-proxy.md`, HLD 8.12:
 * "geographic targeting, sticky exits, time zone ... aligned with the exit").
 */

/** ISO 3166-1 alpha-2: every officially assigned code, and nothing else. */
export const COUNTRY_CODES: ReadonlySet<string> = new Set(
  (
    "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ " +
    "BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM " +
    "DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS " +
    "GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN " +
    "KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ " +
    "MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM " +
    "PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV " +
    "SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI " +
    "VN VU WF WS YE YT ZA ZM ZW"
  ).split(" "),
);

export const CountryCode = z
  .string()
  .refine(
    (c) => COUNTRY_CODES.has(c),
    "must be an uppercase ISO 3166-1 alpha-2 country code, such as US or DE",
  )
  .describe("An ISO 3166-1 alpha-2 country code, uppercase.");

/** An IANA zone name that this runtime's ICU knows: `Europe/Berlin`, `America/Argentina/Buenos_Aires`, `UTC`. */
const ZONE_SHAPE = /^(UTC|[A-Z][A-Za-z_-]{1,30}(\/[A-Za-z0-9_+-]{1,30}){1,2})$/;

export function isTimezone(tz: string): boolean {
  if (!ZONE_SHAPE.test(tz)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const Timezone = z
  .string()
  .max(64)
  .refine(isTimezone, "must be an IANA time zone name, such as Europe/Berlin")
  .describe(
    "An IANA time zone name, such as `Europe/Berlin`. Pages see it in `Date` and `Intl`.",
  );

/**
 * The time zone a session gets by default when its proxy names an exit country and no
 * `timezone` was given. Only countries with one zone, or one zone that clearly dominates by
 * population, are listed; for the rest (US, CA, MX, BR, RU, AU, ID, KZ, CL and others) the
 * time zone is left unset and should be given explicitly.
 */
export const COUNTRY_TIMEZONES: Readonly<Record<string, string>> = {
  AD: "Europe/Andorra",
  AE: "Asia/Dubai",
  AF: "Asia/Kabul",
  AL: "Europe/Tirane",
  AM: "Asia/Yerevan",
  AO: "Africa/Luanda",
  AR: "America/Argentina/Buenos_Aires",
  AT: "Europe/Vienna",
  AZ: "Asia/Baku",
  BA: "Europe/Sarajevo",
  BD: "Asia/Dhaka",
  BE: "Europe/Brussels",
  BG: "Europe/Sofia",
  BH: "Asia/Bahrain",
  BN: "Asia/Brunei",
  BO: "America/La_Paz",
  BT: "Asia/Thimphu",
  BY: "Europe/Minsk",
  CH: "Europe/Zurich",
  CN: "Asia/Shanghai",
  CO: "America/Bogota",
  CR: "America/Costa_Rica",
  CU: "America/Havana",
  CY: "Asia/Nicosia",
  CZ: "Europe/Prague",
  DE: "Europe/Berlin",
  DK: "Europe/Copenhagen",
  DO: "America/Santo_Domingo",
  DZ: "Africa/Algiers",
  EC: "America/Guayaquil",
  EE: "Europe/Tallinn",
  EG: "Africa/Cairo",
  ES: "Europe/Madrid",
  ET: "Africa/Addis_Ababa",
  FI: "Europe/Helsinki",
  FR: "Europe/Paris",
  GB: "Europe/London",
  GE: "Asia/Tbilisi",
  GH: "Africa/Accra",
  GR: "Europe/Athens",
  GT: "America/Guatemala",
  HK: "Asia/Hong_Kong",
  HN: "America/Tegucigalpa",
  HR: "Europe/Zagreb",
  HU: "Europe/Budapest",
  IE: "Europe/Dublin",
  IL: "Asia/Jerusalem",
  IN: "Asia/Kolkata",
  IQ: "Asia/Baghdad",
  IR: "Asia/Tehran",
  IS: "Atlantic/Reykjavik",
  IT: "Europe/Rome",
  JM: "America/Jamaica",
  JO: "Asia/Amman",
  JP: "Asia/Tokyo",
  KE: "Africa/Nairobi",
  KR: "Asia/Seoul",
  KW: "Asia/Kuwait",
  LB: "Asia/Beirut",
  LK: "Asia/Colombo",
  LT: "Europe/Vilnius",
  LU: "Europe/Luxembourg",
  LV: "Europe/Riga",
  MA: "Africa/Casablanca",
  MD: "Europe/Chisinau",
  ME: "Europe/Podgorica",
  MK: "Europe/Skopje",
  MT: "Europe/Malta",
  MY: "Asia/Kuala_Lumpur",
  NG: "Africa/Lagos",
  NL: "Europe/Amsterdam",
  NO: "Europe/Oslo",
  NP: "Asia/Kathmandu",
  NZ: "Pacific/Auckland",
  OM: "Asia/Muscat",
  PA: "America/Panama",
  PE: "America/Lima",
  PH: "Asia/Manila",
  PK: "Asia/Karachi",
  PL: "Europe/Warsaw",
  PR: "America/Puerto_Rico",
  PT: "Europe/Lisbon",
  PY: "America/Asuncion",
  QA: "Asia/Qatar",
  RO: "Europe/Bucharest",
  RS: "Europe/Belgrade",
  SA: "Asia/Riyadh",
  SE: "Europe/Stockholm",
  SG: "Asia/Singapore",
  SI: "Europe/Ljubljana",
  SK: "Europe/Bratislava",
  SV: "America/El_Salvador",
  TH: "Asia/Bangkok",
  TN: "Africa/Tunis",
  TR: "Europe/Istanbul",
  TW: "Asia/Taipei",
  TZ: "Africa/Dar_es_Salaam",
  UA: "Europe/Kyiv",
  UY: "America/Montevideo",
  UZ: "Asia/Tashkent",
  VE: "America/Caracas",
  VN: "Asia/Ho_Chi_Minh",
  ZA: "Africa/Johannesburg",
};

/** The default time zone for an exit country, or undefined where there is no clear one. */
export function defaultTimezoneFor(
  country: string | undefined,
): string | undefined {
  return country === undefined ? undefined : COUNTRY_TIMEZONES[country];
}
