import { describe, expect, it } from "vitest";
import { createBookingAttributionStore } from "./booking-attribution";
import { PROVIDER_LINK_PLACEMENTS, providerBookingLink } from "./provider-booking-link";

/** 提供者経由の予約リンク (#531 v0): the mark is an existing booking UTM, so it reaches the booking as it is. Synthetic data only. */
const ORIGIN = "https://experience.example";

describe("providerBookingLink", () => {
  it("is the experience's public page with the provider mark and where the link is placed, nothing else", () => {
    expect(providerBookingLink({ origin: ORIGIN, slug: "kamakura-community-dinner", placement: "referral" }))
      .toBe("https://experience.example/experiences/kamakura-community-dinner?utm_source=provider&utm_medium=referral");
    expect(providerBookingLink({ origin: `${ORIGIN}/host/experiences?x=1`, slug: "tea-1", placement: "qr" }))
      .toBe("https://experience.example/experiences/tea-1?utm_source=provider&utm_medium=qr");
  });

  it("refuses what is not a link to hand out: another placement, an empty slug, an insecure or malformed origin", () => {
    expect(providerBookingLink({ origin: ORIGIN, slug: "tea", placement: "email" as never })).toBeNull();
    expect(providerBookingLink({ origin: ORIGIN, slug: "", placement: "qr" })).toBeNull();
    expect(providerBookingLink({ origin: "http://experience.example", slug: "tea", placement: "qr" })).toBeNull();
    expect(providerBookingLink({ origin: "not a url", slug: "tea", placement: "qr" })).toBeNull();
    expect(providerBookingLink({ origin: "http://localhost:3000", slug: "tea", placement: "qr" })).toBe("http://localhost:3000/experiences/tea?utm_source=provider&utm_medium=qr");
  });

  it("keeps the slug in one path segment and adds no name, address or phone", () => {
    const link = providerBookingLink({ origin: ORIGIN, slug: "a/b?c=d#e", placement: "social" })!;
    const url = new URL(link);
    expect(url.pathname).toBe("/experiences/a%2Fb%3Fc%3Dd%23e");
    expect([...url.searchParams.keys()]).toEqual(["utm_source", "utm_medium"]);
    expect(url.hash).toBe("");
  });

  it("is captured by the booking attribution as the provider's mark, for every placement, and unknown under Do Not Track", () => {
    for (const { value } of PROVIDER_LINK_PLACEMENTS) {
      const url = new URL(providerBookingLink({ origin: ORIGIN, slug: "tea", placement: value })!);
      const store = createBookingAttributionStore();
      store.capture(url.search, "0");
      expect(store.read("0")).toEqual({ utmSource: "provider", utmMedium: value });
      // Another link followed later in the visit does not take the booking away (first touch).
      store.capture("?utm_source=niho_instagram", "0");
      expect(store.read("0")).toEqual({ utmSource: "provider", utmMedium: value });
      const unknown = createBookingAttributionStore();
      unknown.capture(url.search, "1");
      expect(unknown.read("1")).toEqual({});
    }
  });
});
