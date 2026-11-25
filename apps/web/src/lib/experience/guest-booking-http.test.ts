import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { embedOriginOf, readGuestCheckout, stripeReturnPath } from "./guest-booking-http";

/** 販売経路 (#638): what the checkout keeps of the framing page's address, and where Stripe sends the guest back. */
describe("embedOriginOf", () => {
  it("keeps only the lower-case https origin", () => {
    expect(embedOriginOf("https://host-site.example.test")).toBe("https://host-site.example.test");
    expect(embedOriginOf("https://Host-Site.Example.test/tours/tea?ref=1#book")).toBe("https://host-site.example.test");
    expect(embedOriginOf("https://host-site.example.test:8443/")).toBe("https://host-site.example.test:8443");
    expect(embedOriginOf("https://host-site.example.test:443")).toBe("https://host-site.example.test");
  });

  it("drops what is not an https origin it can keep", () => {
    for (const value of [
      "", "null", "host-site.example.test", "http://host-site.example.test", "javascript:alert(1)", "file:///tmp/a.html",
      "https://user:secret@host-site.example.test", "https://user@host-site.example.test", "https://[::1]", "https://127.0.0.1:x",
      `https://${"a".repeat(250)}.test`,
    ]) expect(embedOriginOf(value), value).toBeNull();
  });
});

describe("stripeReturnPath", () => {
  it("adds the Session's placeholder only for an embedded booking with a known origin", () => {
    expect(stripeReturnPath("/booking/return?type=instant", "https://host-site.example.test")).toBe("/booking/return?type=instant&cs={CHECKOUT_SESSION_ID}");
    expect(stripeReturnPath("/ja/booking/return?type=instant", "https://host-site.example.test")).toBe("/ja/booking/return?type=instant&cs={CHECKOUT_SESSION_ID}");
    expect(stripeReturnPath("/booking/return?type=instant", null)).toBe("/booking/return?type=instant");
  });
});

describe("readGuestCheckout under Do Not Track", () => {
  const BODY = {
    offerId: "sample-am", occurrenceDate: "2026-11-02", adultCount: 1, childCount: 0, expectedTotalYen: 4000,
    guestName: "Sample Guest", guestEmail: "guest@example.com", bookingQuestionsFingerprint: "a".repeat(64),
    consent: { agreedVersion: "sample-terms-2026-10" }, clientRequestKey: "00000000-0000-4000-8000-000000000638",
    utmSource: "provider", utmMedium: "embed", salesChannel: "embed", embedOrigin: "https://host-site.example.test/tours?x=1",
  };
  const post = (headers: Record<string, string> = {}) => new Request("https://experience.example/api/public/experiences/sample-tea/checkout", {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(BODY),
  });

  it("keeps the channel and drops the framing site's origin, as the UTM fields", async () => {
    const tracked = await readGuestCheckout(post(), { embedEnabled: true });
    expect(tracked.ok && tracked.fields).toMatchObject({ salesChannel: "EMBED", embedOrigin: "https://host-site.example.test", utm: { utmSource: "provider", utmMedium: "embed" } });
    const dnt = await readGuestCheckout(post({ dnt: "1" }), { embedEnabled: true });
    expect(dnt.ok).toBe(true);
    if (!dnt.ok) return;
    expect(dnt.fields.salesChannel).toBe("EMBED");
    expect(dnt.fields.embedOrigin).toBeNull();
    expect(dnt.fields.utm).toBeUndefined();
  });
});
