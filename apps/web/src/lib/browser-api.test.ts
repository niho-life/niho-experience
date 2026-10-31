import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExperienceCheckoutRequest } from "@niho-experience/api-client";
import { getBrowserApi, getSiteQuestionsApi, getSiteReviewsApi } from "./browser-api";

afterEach(() => vi.unstubAllGlobals());

describe("HTTP guest checkout boundary", () => {
  it("posts directly to NIHO with the canonical request and no credentials", async () => {
    const body: ExperienceCheckoutRequest = {
      offerId: "offer_dinner_seat", occurrenceDate: "2026-10-23", adultCount: 2, childCount: 1,
      expectedTotalYen: 16000, bookingQuestionsFingerprint: "fingerprint", clientRequestKey: "key-12345678",
      guestName: "Sample Guest", guestEmail: "guest@example.com", answers: [{ questionId: "q_diet", text: "Vegetarian" }],
      consent: { agreedVersion: "2026-10-01" },
    };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ checkoutUrl: "https://checkout.stripe.com/c/pay/example" }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await (await getBrowserApi(false, "https://niho.life")).startCheckout("home-cooked-dinner-with-locals", body);
    expect(result).toEqual({ ok: true, checkoutUrl: "https://checkout.stripe.com/c/pay/example" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://niho.life/api/public/experiences/home-cooked-dinner-with-locals/checkout");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("omit");
    expect(init.cache).toBe("no-store");
    expect(init.referrerPolicy).toBe("no-referrer");
    expect(JSON.parse(init.body as string)).toEqual(body);
  });
});

describe("questions to the host (#105)", () => {
  it("post to this site's own route with a same-origin referrer policy, so the route sees this site's Origin", async () => {
    const fetchMock = vi.fn(async () => Response.json({ accepted: true }, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const request = { topic: "FOOD" as const, message: "Is there a vegetarian option?", guestName: "Sample Guest", guestEmail: "guest@example.com", clientRequestKey: "key-12345678" };
    expect(await getSiteQuestionsApi("https://experience.example").askHost("sample-tea", request)).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://experience.example/api/public/experiences/sample-tea/questions");
    expect(init.referrerPolicy).toBe("same-origin");
    expect(init.credentials).toBe("omit");
    expect(JSON.parse(init.body as string)).toEqual(request);
  });
});

describe("guest reviews (#104)", () => {
  it("read this site's own route, which answers from the experience DB, without credentials", async () => {
    const body = { summary: { count: 1, average: 5, tags: [] }, reviews: [{ id: "00000000-0000-4000-8000-000000000104", rating: 5, body: "Lovely.", tags: [], displayName: "Sample Guest", originLabel: null, publishedAt: "2026-10-30T01:00:00.000Z", fromBooking: true, reply: null }] };
    const fetchMock = vi.fn(async () => Response.json(body));
    vi.stubGlobal("fetch", fetchMock);
    expect(await getSiteReviewsApi("https://experience.example").listReviews("sample-tea", { limit: 50 })).toEqual({ ok: true, data: body });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://experience.example/api/public/experiences/sample-tea/reviews?limit=50");
    expect(init.method).toBe("GET");
    expect(init.credentials).toBe("omit");
    expect(init.referrerPolicy).toBe("no-referrer");
  });
});
