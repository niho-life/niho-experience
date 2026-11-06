/*
 * GA4 consent defaults for the public site (owner decision 2026-11-07: set the ID and the consent handling by the usual
 * recommendation; docs/growth/analytics-decision.md「GA4 を使う条件」). The site shows no consent banner, so the defaults
 * are the whole policy:
 *
 *  - Advertising storage, advertising user data and ad personalization are denied everywhere. GA4 is a page counter here.
 *  - Analytics storage (the _ga cookies) is granted where no prior consent is required, and denied in the EEA, the UK and
 *    Switzerland. There Google tags send cookieless pings and set no cookie, and nothing can switch it on because there
 *    is no consent tool. A consent tool, when it is added, calls gtag("consent", "update", …) and this stays the starting point.
 *
 * Google applies the most specific `region` default, so the second command overrides the first for those visitors.
 */

/** ISO 3166-1 codes of the EEA (EU member states, Iceland, Liechtenstein, Norway), the United Kingdom and Switzerland. */
export const GA4_CONSENT_DENIED_REGIONS = [
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE",
  "IS", "LI", "NO",
  "GB", "CH",
] as const;

type ConsentState = "granted" | "denied";
export type Ga4ConsentDefault = Readonly<{
  ad_storage: ConsentState;
  ad_user_data: ConsentState;
  ad_personalization: ConsentState;
  analytics_storage: ConsentState;
  region?: readonly string[];
}>;

/** The two `gtag("consent", "default", …)` payloads, in the order they must be issued: before `config`. */
export function ga4ConsentDefaults(): readonly [Ga4ConsentDefault, Ga4ConsentDefault] {
  const advertising = { ad_storage: "denied", ad_user_data: "denied", ad_personalization: "denied" } as const;
  return [
    { ...advertising, analytics_storage: "granted" },
    { ...advertising, analytics_storage: "denied", region: GA4_CONSENT_DENIED_REGIONS },
  ];
}

/** The _ga cookie lasts as long as GA4 keeps user data (the property's retention is 2 months): 60 days. */
export const GA4_COOKIE_EXPIRES_SECONDS = 60 * 24 * 60 * 60;
