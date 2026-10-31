import { describe, expect, it, vi } from "vitest";

import { createExperienceApiClient, isAllowedCheckoutRedirect, type FetchLike } from "../src/client.ts";
import type { ExperienceCheckoutRequest } from "../src/types.ts";

const ORIGIN = "https://niho.life";
const BODY: ExperienceCheckoutRequest = {
  offerId: "offer_dinner_seat",
  occurrenceDate: "2026-10-23",
  adultCount: 1,
  childCount: 0,
  expectedTotalYen: 6500,
  guestName: "Sample Guest",
  guestEmail: "guest@example.com",
  bookingQuestionsFingerprint: "a".repeat(64),
  consent: { agreedVersion: "2026-10-01" },
  clientRequestKey: "key-12345678",
};

function respond(status: number, body: unknown, headers: Record<string, string> = {}): FetchLike {
  return vi.fn(async () => new Response(body === null ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } }));
}

describe("isAllowedCheckoutRedirect", () => {
  it.each([
    ["https://checkout.stripe.com/c/pay/cs_test_abc", true],
    ["https://niho.life/living/nihokamakura/pages/community-dinner/bookings/tok.en?checkout=completed", true],
    ["http://checkout.stripe.com/c/pay/cs_test_abc", false],
    ["https://checkout.stripe.com.evil.example/c/pay", false],
    ["https://niho.life/auth/login?returnUrl=/", false],
    ["https://evil.example/living/x/pages/y/bookings/z", false],
    ["javascript:alert(1)", false],
    ["https://user:pass@checkout.stripe.com/c/pay", false],
  ])("%s → %s", (url, expected) => {
    expect(isAllowedCheckoutRedirect(url, ORIGIN)).toBe(expected);
  });
});

describe("isAllowedCheckoutRedirect on this site's own origin (#285)", () => {
  const SITE = "https://experience.example";
  it.each([
    ["https://checkout.stripe.com/c/pay/cs_test_abc", true],
    ["https://experience.example/booking/return?type=instant", true],
    ["https://experience.example/booking/return?type=approval", true],
    ["https://experience.example/booking/return", false],
    ["https://experience.example/booking/return?type=other", false],
    ["https://experience.example/booking/return?type=instant&next=https://evil.example", false],
    ["https://experience.example/booking/return?type=instant#x", false],
    ["https://experience.example/booking/return/x?type=instant", false],
    ["https://experience.example/experiences/bookings/tok", false],
    ["https://experience.example/experiences/sample-tea", false],
    ["http://experience.example/booking/return?type=instant", false],
    ["https://niho.life/booking/return?type=instant", false],
    ["https://niho.life/experiences/bookings/tok", false],
    ["https://user:pass@experience.example/booking/return?type=instant", false],
  ])("%s → %s", (url, expected) => {
    expect(isAllowedCheckoutRedirect(url, SITE, { thisSite: true })).toBe(expected);
  });

  it("is not accepted from NIHO's origin, and the client applies the option it was made with", async () => {
    expect(isAllowedCheckoutRedirect("https://niho.life/booking/return?type=instant", ORIGIN)).toBe(false);
    const paidReplay = { checkoutUrl: `${SITE}/booking/return?type=instant` };
    const site = createExperienceApiClient({ nihoWebOrigin: SITE, thisSite: true, fetch: respond(201, paidReplay) });
    expect(await site.startCheckout("sample-tea", BODY)).toEqual({ ok: true, checkoutUrl: paidReplay.checkoutUrl });
    const niho = createExperienceApiClient({ nihoWebOrigin: SITE, fetch: respond(201, paidReplay) });
    expect(await niho.startCheckout("sample-tea", BODY)).toEqual({ ok: false, kind: "unexpected_response", status: 201 });
    const nihoPage = createExperienceApiClient({ nihoWebOrigin: SITE, thisSite: true, fetch: respond(201, { checkoutUrl: `${SITE}/experiences/bookings/tok` }) });
    expect(await nihoPage.startCheckout("sample-tea", BODY)).toEqual({ ok: false, kind: "unexpected_response", status: 201 });
  });
});

describe("createExperienceApiClient", () => {
  it("日本語releaseのcopy・catalog・availabilityをlocale pathからno-storeで読む", async () => {
    const values = Object.fromEntries(Array.from({ length: 342 }, (_, index) => [`copy.${index}`, `値${index}`]));
    const bodies = [
      { schemaVersion: 2, releaseId: "release-ja-1", locale: "ja", values },
      { releaseId: "release-ja-1", locale: "ja", displayLocale: "ja", copySchemaVersion: 2, experiences: [] },
      { releaseId: "release-ja-1", locale: "ja", generatedAt: "2026-10-22T00:00:00.000Z", timeZone: "Asia/Tokyo", windowDays: 90, occurrences: [] },
    ];
    const fetchMock: FetchLike = vi.fn(async () => Response.json(bodies.shift()));
    const client = createExperienceApiClient({ nihoWebOrigin: ORIGIN, fetch: fetchMock, cacheableReadInit: { cache: "force-cache" } });
    expect((await client.getJapaneseSiteCopy()).ok).toBe(true);
    expect((await client.listJapaneseExperiences({ region: "kamakura" })).ok).toBe(true);
    expect((await client.getJapaneseAvailability("x-y", { offerId: "offer_1" })).ok).toBe(true);
    const calls = (fetchMock as ReturnType<typeof vi.fn>).mock.calls as Array<[string, RequestInit]>;
    expect(calls.map(([url]) => url)).toEqual([
      `${ORIGIN}/api/public/experiences/v1.2/ja/site`,
      `${ORIGIN}/api/public/experiences/v1.2/ja/catalog?region=kamakura`,
      `${ORIGIN}/api/public/experiences/v1.2/ja/x-y/availability?offerId=offer_1`,
    ]);
    expect(calls.every(([, init]) => init.cache === "no-store" && init.credentials === "omit")).toBe(true);
  });

  it("日本語release identityの欠落・不一致形を拒否する", async () => {
    const client = createExperienceApiClient({ nihoWebOrigin: ORIGIN, fetch: respond(200, { releaseId: "", locale: "en", displayLocale: "ja", copySchemaVersion: 2, experiences: [] }) });
    expect(await client.listJapaneseExperiences()).toEqual({ ok: false, kind: "unexpected_response", status: 200 });
  });

  it("未公開・撤回済みの日本語releaseを404のまま扱う", async () => {
    const client = createExperienceApiClient({ nihoWebOrigin: ORIGIN, fetch: respond(404, null) });
    expect(await client.getJapaneseSiteCopy()).toEqual({ ok: false, kind: "not_found" });
    expect(await client.listJapaneseExperiences()).toEqual({ ok: false, kind: "not_found" });
  });

  it("日本語checkoutでtermsの更新を専用結果にし、入力をURLへ出さない", async () => {
    const fetchMock = respond(409, { error: { code: "LOCALIZATION_OUTDATED", message: "Published terms changed" } });
    const client = createExperienceApiClient({ nihoWebOrigin: ORIGIN, fetch: fetchMock });
    expect(await client.startJapaneseCheckout("x-y", BODY)).toEqual({ ok: false, kind: "localization_outdated", status: 409, error: { code: "LOCALIZATION_OUTDATED", message: "Published terms changed" } });
    const [url, init] = (fetchMock as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${ORIGIN}/api/public/experiences/v1.2/ja/x-y/checkout`);
    expect(url).not.toContain(BODY.guestEmail);
    expect(init).toMatchObject({ cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer" });
  });

  it("cookie を送らず、旅行者の入力を URL に載せない", async () => {
    const fetchMock = respond(201, { checkoutUrl: "https://checkout.stripe.com/c/pay/cs_test_abc" });
    const client = createExperienceApiClient({ nihoWebOrigin: ORIGIN, fetch: fetchMock });
    const result = await client.startCheckout("home-cooked-dinner-with-locals", BODY);
    expect(result).toEqual({ ok: true, checkoutUrl: "https://checkout.stripe.com/c/pay/cs_test_abc" });
    const [url, init] = (fetchMock as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://niho.life/api/public/experiences/home-cooked-dinner-with-locals/checkout");
    expect(url).not.toContain("example.com");
    expect(init.credentials).toBe("omit");
    expect(init.cache).toBe("no-store");
    expect(init.referrerPolicy).toBe("no-referrer");
  });

  it("許可していない遷移先は unexpected_response として扱う", async () => {
    const client = createExperienceApiClient({ nihoWebOrigin: ORIGIN, fetch: respond(201, { checkoutUrl: "https://evil.example/pay" }) });
    expect(await client.startCheckout("x-y", BODY)).toEqual({ ok: false, kind: "unexpected_response", status: 201 });
  });

  it("契約のエラーは rejected と Retry-After を返す", async () => {
    const error = { code: "RATE_LIMITED", message: "Too many", retryable: true, field: null, questionId: null, seatsLeft: null, occurrenceReason: null, currentTotalYen: null };
    const client = createExperienceApiClient({ nihoWebOrigin: ORIGIN, fetch: respond(429, { error }, { "retry-after": "60" }) });
    expect(await client.startCheckout("x-y", BODY)).toEqual({ ok: false, kind: "rejected", status: 429, error, retryAfterSeconds: 60 });
  });

  it("未知・不完全・status 不一致の checkout error は unexpected_response", async () => {
    const error = { code: "RATE_LIMITED", message: "Too many", retryable: true, field: null, questionId: null, seatsLeft: null, occurrenceReason: null, currentTotalYen: null };
    for (const [status, responseError] of [
      [429, { ...error, code: "BOGUS" }],
      [429, { code: "RATE_LIMITED", message: "Too many", retryable: true }],
      [409, error],
      [429, { ...error, extra: "unexpected" }],
    ] as const) {
      const client = createExperienceApiClient({ nihoWebOrigin: ORIGIN, fetch: respond(status, { error: responseError }) });
      expect(await client.startCheckout("x-y", BODY)).toEqual({ ok: false, kind: "unexpected_response", status });
    }
  });

  it("404 は not_found・形の違う本文は unexpected_response", async () => {
    expect(await createExperienceApiClient({ nihoWebOrigin: ORIGIN, fetch: respond(404, null) }).getExperience("x-y")).toEqual({ ok: false, kind: "not_found" });
    expect(await createExperienceApiClient({ nihoWebOrigin: ORIGIN, fetch: respond(200, [1, 2]) }).listExperiences()).toEqual({
      ok: false,
      kind: "unexpected_response",
      status: 200,
    });
    expect(await createExperienceApiClient({ nihoWebOrigin: ORIGIN, fetch: respond(200, {}) }).listExperiences()).toEqual({
      ok: false,
      kind: "unexpected_response",
      status: 200,
    });
    expect(await createExperienceApiClient({ nihoWebOrigin: ORIGIN, fetch: respond(200, { experience: {} }) }).getExperience("x-y")).toEqual({
      ok: false,
      kind: "unexpected_response",
      status: 200,
    });
    expect(await createExperienceApiClient({ nihoWebOrigin: ORIGIN, fetch: respond(200, { occurrences: [null] }) }).getAvailability("x-y")).toEqual({
      ok: false,
      kind: "unexpected_response",
      status: 200,
    });
  });

  it("一覧・詳細だけ cacheableReadInit を使い、残席は no-store", async () => {
    const fetchMock: FetchLike = vi.fn(async (input) =>
      new Response(JSON.stringify(input.endsWith("/availability?offerId=offer_1") ? { occurrences: [] } : { experiences: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = createExperienceApiClient({ nihoWebOrigin: ORIGIN, fetch: fetchMock, cacheableReadInit: { cache: "force-cache" } });
    await client.listExperiences({ region: "kamakura" });
    await client.getAvailability("x-y", { offerId: "offer_1" });
    const calls = (fetchMock as ReturnType<typeof vi.fn>).mock.calls as Array<[string, RequestInit]>;
    expect(calls[0]?.[0]).toBe("https://niho.life/api/public/experiences?region=kamakura");
    expect(calls[0]?.[1].cache).toBe("force-cache");
    expect(calls[1]?.[0]).toBe("https://niho.life/api/public/experiences/x-y/availability?offerId=offer_1");
    expect(calls[1]?.[1].cache).toBe("no-store");
  });

  it("時間切れは network_error（同じ key で再送できる）", async () => {
    const hanging: FetchLike = (_input, init) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    const client = createExperienceApiClient({ nihoWebOrigin: ORIGIN, fetch: hanging, timeoutMs: 10 });
    expect(await client.startCheckout("x-y", BODY)).toEqual({ ok: false, kind: "network_error" });
  });

  it("origin に path や http を渡すと作れない", () => {
    expect(() => createExperienceApiClient({ nihoWebOrigin: "https://niho.life/api" })).toThrow();
    expect(() => createExperienceApiClient({ nihoWebOrigin: "http://niho.life" })).toThrow();
  });
});
