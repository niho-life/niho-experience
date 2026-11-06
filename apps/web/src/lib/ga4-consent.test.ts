import { describe, expect, it } from "vitest";
import { GA4_CONSENT_DENIED_REGIONS, GA4_COOKIE_EXPIRES_SECONDS, ga4ConsentDefaults } from "./ga4-consent";

describe("GA4 consent defaults", () => {
  it("denies advertising storage, user data and personalization everywhere, in both commands", () => {
    for (const command of ga4ConsentDefaults()) {
      expect([command.ad_storage, command.ad_user_data, command.ad_personalization]).toEqual(["denied", "denied", "denied"]);
    }
  });

  it("grants analytics storage by default and denies it in the EEA, the UK and Switzerland only", () => {
    const [everywhere, restricted] = ga4ConsentDefaults();
    expect(everywhere.analytics_storage).toBe("granted");
    expect(everywhere.region).toBeUndefined();
    expect(restricted.analytics_storage).toBe("denied");
    expect(restricted.region).toBe(GA4_CONSENT_DENIED_REGIONS);
    // Japan, where the site is run from, and the United States are not restricted.
    expect(GA4_CONSENT_DENIED_REGIONS).not.toContain("JP");
    expect(GA4_CONSENT_DENIED_REGIONS).not.toContain("US");
  });

  it("lists the 27 EU member states, Iceland, Liechtenstein, Norway, the UK and Switzerland once each", () => {
    expect(GA4_CONSENT_DENIED_REGIONS).toHaveLength(32);
    expect(new Set(GA4_CONSENT_DENIED_REGIONS).size).toBe(32);
    for (const code of ["DE", "FR", "IT", "ES", "NL", "IE", "SE", "PL", "IS", "LI", "NO", "GB", "CH"]) expect(GA4_CONSENT_DENIED_REGIONS).toContain(code);
    for (const code of GA4_CONSENT_DENIED_REGIONS) expect(code).toMatch(/^[A-Z]{2}$/);
  });

  it("keeps the cookie no longer than the 2-month data retention", () => {
    expect(GA4_COOKIE_EXPIRES_SECONDS).toBe(60 * 24 * 60 * 60);
  });
});
