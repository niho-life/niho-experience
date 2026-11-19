import { describe, expect, it } from "vitest";
import {
  GA4_CONSENT_RETENTION_MS,
  GA4_CONSENT_STORAGE_KEY,
  GA4_COOKIE_EXPIRES_SECONDS,
  GA4_COOKIE_PREFIX,
  GA4_COOKIE_SETTINGS,
  createGa4ConsentChoiceStore,
  ga4ConsentDefaults,
  ga4CookieNames,
  isGa4ExcludedPath,
  parseStoredGa4Consent,
  serializeGa4Consent,
  shouldLoadGa4,
  shouldMeasureGa4Path,
  shouldStopGa4,
} from "./ga4-consent";

describe("GA4 basic consent", () => {
  it("denies analytics and all advertising consent by default", () => {
    expect(ga4ConsentDefaults()).toEqual({
      analytics_storage: "denied",
      ad_storage: "denied",
      ad_user_data: "denied",
      ad_personalization: "denied",
    });
  });

  it("loads the tag only after an affirmative choice and when Do Not Track is off", () => {
    expect(shouldLoadGa4(null, undefined)).toBe(false);
    expect(shouldLoadGa4("denied", undefined)).toBe(false);
    expect(shouldLoadGa4("granted", "1")).toBe(false);
    expect(shouldLoadGa4("granted", "yes")).toBe(false);
    expect(shouldLoadGa4("granted", "0")).toBe(true);
    expect(shouldLoadGa4("granted", undefined)).toBe(true);
  });

  it("does not stop the tag before the browser's saved consent has hydrated", () => {
    expect(shouldStopGa4(null, false, undefined)).toBe(false);
    expect(shouldStopGa4(null, true, undefined)).toBe(true);
    expect(shouldStopGa4("denied", true, undefined)).toBe(true);
    expect(shouldStopGa4("granted", true, undefined)).toBe(false);
    expect(shouldStopGa4("granted", true, "1")).toBe(true);
  });

  it("keeps an explicit choice for this tab when localStorage writes fail", () => {
    const values = new Map<string, string>([
      [GA4_CONSENT_STORAGE_KEY, serializeGa4Consent("denied", 1_800_000_000_000)],
    ]);
    let failWrites = true;
    const store = createGa4ConsentChoiceStore({
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        if (failWrites) throw new Error("storage is full");
        values.set(key, value);
      },
    });

    store.save("granted", 1_800_000_000_000);
    expect(store.read(1_800_000_000_001)).toBe("granted");
    store.save("denied", 1_800_000_000_000);
    expect(store.read(1_800_000_000_001)).toBe("denied");

    failWrites = false;
    store.save("granted", 1_800_000_000_000);
    expect(values.has(GA4_CONSENT_STORAGE_KEY)).toBe(true);
    expect(store.read(1_800_000_000_001)).toBe("granted");
  });

  it("stops analytics on booking and private paths even after consent", () => {
    expect(shouldMeasureGa4Path("granted", undefined, "/experiences")).toBe(true);
    expect(shouldMeasureGa4Path("granted", undefined, "/booking/complete")).toBe(false);
    expect(shouldMeasureGa4Path("granted", undefined, "/account")).toBe(false);
    expect(shouldMeasureGa4Path("denied", undefined, "/experiences")).toBe(false);
    expect(shouldMeasureGa4Path("granted", "1", "/experiences")).toBe(false);
  });

  it("remembers either choice for 180 days and ignores malformed or expired values", () => {
    const now = 1_800_000_000_000;
    expect(GA4_CONSENT_RETENTION_MS).toBe(180 * 24 * 60 * 60 * 1000);
    expect(parseStoredGa4Consent(serializeGa4Consent("granted", now), now)).toBe("granted");
    expect(parseStoredGa4Consent(serializeGa4Consent("denied", now), now)).toBe("denied");
    expect(parseStoredGa4Consent(serializeGa4Consent("granted", now), now + GA4_CONSENT_RETENTION_MS)).toBeNull();
    expect(parseStoredGa4Consent("not-json", now)).toBeNull();
    expect(parseStoredGa4Consent(JSON.stringify({ choice: "unknown", expiresAt: now + 1 }), now)).toBeNull();
  });

  it("uses an Experience-only cookie prefix and fixed 60-day expiry", () => {
    expect(GA4_COOKIE_EXPIRES_SECONDS).toBe(60 * 24 * 60 * 60);
    expect(GA4_COOKIE_SETTINGS).toEqual({
      cookie_domain: "experience.niho.life",
      cookie_expires: GA4_COOKIE_EXPIRES_SECONDS,
      cookie_path: "/",
      cookie_prefix: GA4_COOKIE_PREFIX,
      cookie_update: false,
    });
  });

  it("clears only cookies owned by the Experience GA4 prefix", () => {
    expect(ga4CookieNames("niho_experience_ga=one; niho_experience_ga_123=two; _ga=other; niho_ga=other")).toEqual([
      "niho_experience_ga",
      "niho_experience_ga_123",
    ]);
    expect(ga4CookieNames("niho_experience_ga=one; niho_experience_ga=two")).toEqual(["niho_experience_ga"]);
  });

  it("excludes booking, member, host and admin paths from GA4 and the consent prompt", () => {
    for (const path of ["/booking", "/booking/complete", "/bookings", "/bookings/abc", "/experiences/kayak/book", "/account", "/host", "/host/experiences", "/admin", "/admin/reports", "/reviews/write"]) {
      expect(isGa4ExcludedPath(path), path).toBe(true);
    }
    expect(isGa4ExcludedPath("/")).toBe(false);
    expect(isGa4ExcludedPath("/experiences")).toBe(false);
    expect(isGa4ExcludedPath("/experiences/kayak")).toBe(false);
  });
});
