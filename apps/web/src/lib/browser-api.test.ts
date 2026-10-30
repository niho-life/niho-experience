import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExperienceCheckoutRequest } from "@niho-experience/api-client";
import { getBrowserApi, getSiteQuestionsApi } from "./browser-api";

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
