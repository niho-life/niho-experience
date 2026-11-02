import { describe, expect, it, vi } from "vitest";

import {
  createExperienceHostApiClient,
  isStripeConnectUrl,
  toExperienceProviderPhotoUploadForm,
  type ExperienceProviderUploadPolicyResponse,
  type FetchLike,
} from "../src/host/index.ts";
import { createMockExperienceHostFetch } from "../src/host/mock.ts";

const ORIGIN = "https://niho.life";
const TOKEN = "header.payload.signature";

function respond(status: number, body: unknown): ReturnType<typeof vi.fn<FetchLike>> {
  return vi.fn<FetchLike>(async () => new Response(body === null ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
}

function lastCall(fetchMock: ReturnType<typeof vi.fn<FetchLike>>): [string, RequestInit] {
  return fetchMock.mock.calls.at(-1) as [string, RequestInit];
}

const PROVIDER = {
  id: "cm0provider01",
  ownerUserId: "cm0user01",
  vesselSpotId: "cm0spot01",
  kind: "INDIVIDUAL",
  displayName: "合成の台所",
  bio: "",
  sellerDisclosureUrl: null,
  reviewStatus: "DRAFT",
  consentVersion: "v1",
  consentedAt: "2026-10-01T00:00:00.000Z",
  submittedAt: null,
  approvedAt: null,
  paymentReuseConsentVersion: null,
  paymentReuseConsentedAt: null,
  paymentReuseSourceSpotId: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};
const CONSENT = { version: "v1", text: "同意の文言" };
const LIST = { providers: [{ ...PROVIDER, memberRole: "OWNER" }], platformAdmin: false, consent: CONSENT, paymentReuseConsent: CONSENT };

describe("isStripeConnectUrl", () => {
  it.each([
    ["https://connect.stripe.com/setup/e/acct_x/abc", true],
    ["http://connect.stripe.com/setup/e/acct_x/abc", false],
    ["https://connect.stripe.com.evil.example/setup", false],
    ["https://user:pass@connect.stripe.com/setup", false],
    ["https://connect.stripe.test/setup/x/1#niho-mock-connect", false],
    ["javascript:alert(1)", false],
  ])("%s → %s", (url, expected) => {
    expect(isStripeConnectUrl(url)).toBe(expected);
  });
});

describe("createExperienceHostApiClient", () => {
  it("Bearer を付け、cookie を送らず、リダイレクトに従わず、キャッシュしない", async () => {
    const fetchMock = respond(200, LIST);
    const api = createExperienceHostApiClient({ nihoWebOrigin: ORIGIN, accessToken: TOKEN, fetch: fetchMock });
    expect(await api.listExperienceProviders()).toEqual({ ok: true, data: LIST });
    const [url, init] = lastCall(fetchMock);
    expect(url).toBe("https://niho.life/api/experience-providers");
    expect(init).toMatchObject({ method: "GET", credentials: "omit", redirect: "error", cache: "no-store", referrerPolicy: "no-referrer" });
    expect(init.headers).toEqual({ accept: "application/json", authorization: `Bearer ${TOKEN}` });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("本文のある操作は JSON で送り、path の ID を符号化する", async () => {
    const fetchMock = respond(200, { provider: PROVIDER });
    const api = createExperienceHostApiClient({ nihoWebOrigin: `${ORIGIN}/`, accessToken: TOKEN, fetch: fetchMock });
    await api.updateExperienceProvider("cm0provider01", { displayName: "新しい名前" });
    const [url, init] = lastCall(fetchMock);
    expect(url).toBe("https://niho.life/api/experience-providers/cm0provider01");
    expect(init.method).toBe("PATCH");
    expect(init.headers).toMatchObject({ "content-type": "application/json" });
    expect(init.body).toBe(JSON.stringify({ displayName: "新しい名前" }));

    await api.submitExperienceProvider("cm0provider01");
    expect(lastCall(fetchMock)[1]).not.toHaveProperty("body");
  });

  it("確かめられない provider ID では NIHO を呼ばない", async () => {
    const fetchMock = respond(200, {});
    const api = createExperienceHostApiClient({ nihoWebOrigin: ORIGIN, accessToken: TOKEN, fetch: fetchMock });
    for (const id of ["..", ".", "", "a/b", "x".repeat(201)]) {
      expect(await api.getExperienceProvider(id)).toEqual({ ok: false, kind: "error", status: 404, code: "NOT_FOUND", reason: null, message: "" });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("origin と token の規則", () => {
    expect(() => createExperienceHostApiClient({ nihoWebOrigin: "http://niho.life", accessToken: TOKEN })).toThrow(/https/);
    expect(() => createExperienceHostApiClient({ nihoWebOrigin: "https://niho.life/api", accessToken: TOKEN })).toThrow(/origin/);
    expect(() => createExperienceHostApiClient({ nihoWebOrigin: "http://localhost:3000", accessToken: TOKEN })).not.toThrow();
    for (const accessToken of ["", "a b", "a\r\nx-evil: 1"]) {
      expect(() => createExperienceHostApiClient({ nihoWebOrigin: ORIGIN, accessToken })).toThrow(/accessToken/);
    }
  });

  it("NIHO のエラーは status・code・reason で返す", async () => {
    const body = { error: { code: "CONFLICT", message: "処理できませんでした", details: { reason: "PROVIDER_PAYMENT_LOCKED" } } };
    const api = createExperienceHostApiClient({ nihoWebOrigin: ORIGIN, accessToken: TOKEN, fetch: respond(409, body) });
    expect(await api.reuseExperienceProviderPayment("cm0provider01", { sourceSpotId: "cm0spot02", consentVersion: "v1" })).toEqual({
      ok: false, kind: "error", status: 409, code: "CONFLICT", reason: "PROVIDER_PAYMENT_LOCKED", message: "処理できませんでした",
    });
    const unauthorized = createExperienceHostApiClient({ nihoWebOrigin: ORIGIN, accessToken: TOKEN, fetch: respond(401, { error: { code: "UNAUTHORIZED", message: "認証が必要です", details: {} } }) });
    expect(await unauthorized.getAuthMe()).toMatchObject({ ok: false, kind: "error", status: 401, code: "UNAUTHORIZED", reason: null });
  });

  it("形の違う応答・本文の無いエラーは unexpected_response", async () => {
    const cases: Array<[number, unknown]> = [
      [200, { providers: [{ ...PROVIDER, memberRole: "ADMIN" }], platformAdmin: false, consent: CONSENT, paymentReuseConsent: CONSENT }],
      [200, { providers: [{ ...PROVIDER, kind: "COMPANY", memberRole: null }], platformAdmin: false, consent: CONSENT, paymentReuseConsent: CONSENT }],
      [200, { providers: [], platformAdmin: false, consent: CONSENT }],
      [502, null],
      [404, { error: "not_found" }],
    ];
    for (const [status, body] of cases) {
      const api = createExperienceHostApiClient({ nihoWebOrigin: ORIGIN, accessToken: TOKEN, fetch: respond(status, body) });
      expect(await api.listExperienceProviders()).toEqual({ ok: false, kind: "unexpected_response", status });
    }
  });

  it("契約に無い項目は取り出さない（me は表示名と顔写真だけ）", async () => {
    const me = { user: { id: "cm0user01", displayName: "合成 ホスト", handle: "x", email: "someone@example.com" }, userIconImage: null, memberships: [{ spotId: "s" }] };
    const api = createExperienceHostApiClient({ nihoWebOrigin: ORIGIN, accessToken: TOKEN, fetch: respond(200, me) });
    expect(await api.getAuthMe()).toEqual({ ok: true, data: { user: { displayName: "合成 ホスト" }, userIconImage: null } });
    const extra = createExperienceHostApiClient({ nihoWebOrigin: ORIGIN, accessToken: TOKEN, fetch: respond(200, { ...LIST, providers: [{ ...LIST.providers[0], internalNote: "x" }] }) });
    const result = await extra.listExperienceProviders();
    expect(result.ok && result.data.providers[0]).not.toHaveProperty("internalNote");
  });

  it("接続の URL は https だけを受け取る", async () => {
    const connect = { url: "javascript:alert(1)", expiresAt: null, ready: false, reason: "NOT_CONNECTED" };
    const api = createExperienceHostApiClient({ nihoWebOrigin: ORIGIN, accessToken: TOKEN, fetch: respond(200, connect) });
    expect(await api.startExperienceProviderPaymentConnect("cm0provider01")).toEqual({ ok: false, kind: "unexpected_response", status: 200 });
  });

  it("通信の失敗と時間切れは network_error", async () => {
    const failing = createExperienceHostApiClient({ nihoWebOrigin: ORIGIN, accessToken: TOKEN, fetch: vi.fn<FetchLike>(async () => { throw new TypeError("fetch failed"); }) });
    expect(await failing.listExperienceProviders()).toEqual({ ok: false, kind: "network_error" });

    const hanging: FetchLike = (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    });
    const slow = createExperienceHostApiClient({ nihoWebOrigin: ORIGIN, accessToken: TOKEN, fetch: hanging, timeoutMs: 20 });
    expect(await slow.getAuthMe()).toEqual({ ok: false, kind: "network_error" });
  });

  it("mock とつないで使える", async () => {
    const api = createExperienceHostApiClient({ nihoWebOrigin: ORIGIN, accessToken: TOKEN, fetch: createMockExperienceHostFetch({ scenario: "two-providers" }) });
    const result = await api.listExperienceProviders();
    expect(result.ok && result.data.providers.map((provider) => provider.id)).toEqual(["sample-provider-kitchen", "sample-provider-studio"]);
  });
});

const PAGE = {
  id: "cm0page01",
  kind: "EXPERIENCE",
  slug: "sample-page",
  language: "EN",
  title: "合成の体験",
  status: "DRAFT",
  listOnEntrance: false,
  publishedAt: null,
  unpublishedAt: null,
  content: {
    lead: "",
    facts: { language: "" },
    highlights: [],
    timeline: [{ time: "10:00", title: "集合", text: "", photoObjectKey: null }],
    description: "",
    included: [],
    notIncluded: [],
    notSuitableFor: [],
    meetingPoint: { entranceNote: "", exteriorPhotoObjectKey: null },
    knowBeforeYouGo: [],
    hostUserIds: ["cm0user01"],
    participationConditions: { age: null, physical: null, hostLanguages: null, food: null, accessibility: null, weather: null },
  },
  photos: [{ objectKey: "sample-photos/x/1.jpg", url: "https://storage.example.com/w1024/1.jpg" }, { objectKey: "sample-photos/x/2.jpg", url: null }],
  coverObjectKey: "sample-photos/x/1.jpg",
  offer: null,
  offers: [],
  publishBlockers: ["OFFER_ACTIVE_REQUIRED"],
  publicPath: "/living/sample/pages/sample-page",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-02T03:04:05.678Z",
  photoAlts: ["", ""],
};

describe("createExperienceHostApiClient：体験ページ・集合場所・掲載・写真", () => {
  it("保存と公開は読んだ版を x-niho-page-updated-at に載せ、null なら載せない", async () => {
    const fetchMock = respond(200, PAGE);
    const api = createExperienceHostApiClient({ nihoWebOrigin: ORIGIN, accessToken: TOKEN, fetch: fetchMock });
    expect(await api.updateExperienceProviderPage("cm0provider01", "cm0page01", { title: "新しい題名" }, PAGE.updatedAt)).toEqual({ ok: true, data: PAGE });
    let [url, init] = lastCall(fetchMock);
    expect(url).toBe("https://niho.life/api/experience-providers/cm0provider01/pages/cm0page01");
    expect(init).toMatchObject({ method: "PATCH", body: JSON.stringify({ title: "新しい題名" }) });
    expect(init.headers).toEqual({ accept: "application/json", authorization: `Bearer ${TOKEN}`, "content-type": "application/json", "x-niho-page-updated-at": PAGE.updatedAt });

    await api.publishExperienceProviderPage("cm0provider01", "cm0page01", PAGE.updatedAt);
    [url, init] = lastCall(fetchMock);
    expect(url).toBe("https://niho.life/api/experience-providers/cm0provider01/pages/cm0page01/publish");
    expect(init).toMatchObject({ method: "POST" });
    expect(init).not.toHaveProperty("body");
    expect(init.headers).toEqual({ accept: "application/json", authorization: `Bearer ${TOKEN}`, "x-niho-page-updated-at": PAGE.updatedAt });

    await api.publishExperienceProviderPage("cm0provider01", "cm0page01", null);
    expect(lastCall(fetchMock)[1].headers).not.toHaveProperty("x-niho-page-updated-at");
  });

  it("版の形でない expectedUpdatedAt では呼ばず、409 PAGE_UPDATED（読み直す）と同じに返す", async () => {
    const fetchMock = respond(200, PAGE);
    const api = createExperienceHostApiClient({ nihoWebOrigin: ORIGIN, accessToken: TOKEN, fetch: fetchMock });
    for (const version of ["", "yesterday", `${PAGE.updatedAt}\r\nx-evil: 1`]) {
      expect(await api.updateExperienceProviderPage("cm0provider01", "cm0page01", {}, version)).toEqual({ ok: false, kind: "error", status: 409, code: "CONFLICT", reason: "PAGE_UPDATED", message: "" });
      expect(await api.publishExperienceProviderPage("cm0provider01", "cm0page01", version)).toMatchObject({ status: 409, reason: "PAGE_UPDATED" });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("method と path（PUT・DELETE を含む）", async () => {
    const cases: Array<[string, (api: ReturnType<typeof createExperienceHostApiClient>) => Promise<unknown>, string, string]> = [
      ["getExperienceProviderMeetingPoint", (api) => api.getExperienceProviderMeetingPoint("p1"), "GET", "/api/experience-providers/p1/meeting-point"],
      ["updateExperienceProviderMeetingPoint", (api) => api.updateExperienceProviderMeetingPoint("p1", { overview: "", address: "", accessNote: "", mapUrl: "", entranceNote: "" }), "PUT", "/api/experience-providers/p1/meeting-point"],
      ["listExperienceProviderPages", (api) => api.listExperienceProviderPages("p1"), "GET", "/api/experience-providers/p1/pages"],
      ["createExperienceProviderPage", (api) => api.createExperienceProviderPage("p1", { kind: "EXPERIENCE", language: "EN" }), "POST", "/api/experience-providers/p1/pages"],
      ["getExperienceProviderPage", (api) => api.getExperienceProviderPage("p1", "g1"), "GET", "/api/experience-providers/p1/pages/g1"],
      ["deleteExperienceProviderPage", (api) => api.deleteExperienceProviderPage("p1", "g1"), "DELETE", "/api/experience-providers/p1/pages/g1"],
      ["unpublishExperienceProviderPage", (api) => api.unpublishExperienceProviderPage("p1", "g1"), "POST", "/api/experience-providers/p1/pages/g1/unpublish"],
      ["getExperienceProviderPagePreview", (api) => api.getExperienceProviderPagePreview("p1", "g1"), "GET", "/api/experience-providers/p1/pages/g1/preview"],
      ["getExperienceProviderPageMeetingPoint", (api) => api.getExperienceProviderPageMeetingPoint("p1", "g1"), "GET", "/api/experience-providers/p1/pages/g1/meeting-point"],
      ["updateExperienceProviderPageMeetingPoint", (api) => api.updateExperienceProviderPageMeetingPoint("p1", "g1", { mode: "INHERIT", expectedUpdatedAt: PAGE.updatedAt }), "PUT", "/api/experience-providers/p1/pages/g1/meeting-point"],
      ["getExperienceProviderPageListing", (api) => api.getExperienceProviderPageListing("p1", "g1"), "GET", "/api/experience-providers/p1/pages/g1/experience-site-listing"],
      ["requestExperienceProviderPageListing", (api) => api.requestExperienceProviderPageListing("p1", "g1", { consentVersion: "v1" }), "PUT", "/api/experience-providers/p1/pages/g1/experience-site-listing"],
      ["withdrawExperienceProviderPageListing", (api) => api.withdrawExperienceProviderPageListing("p1", "g1"), "DELETE", "/api/experience-providers/p1/pages/g1/experience-site-listing"],
      ["createExperienceProviderUploadPolicy", (api) => api.createExperienceProviderUploadPolicy("p1", { purpose: "ARTICLE_IMAGE", contentType: "image/jpeg" }), "POST", "/api/experience-providers/p1/uploads/policies"],
      ["createExperienceProviderUploadSignedUrl", (api) => api.createExperienceProviderUploadSignedUrl("p1", { objectKey: "k" }), "POST", "/api/experience-providers/p1/uploads/signed-url"],
    ];
    for (const [name, invoke, method, path] of cases) {
      const fetchMock = respond(204, null);
      await invoke(createExperienceHostApiClient({ nihoWebOrigin: ORIGIN, accessToken: TOKEN, fetch: fetchMock }));
      const [url, init] = lastCall(fetchMock);
      expect(`${name} ${init.method} ${url}`).toBe(`${name} ${method} https://niho.life${path}`);
    }
  });

  it("確かめられない page ID では呼ばず、その操作が無いページに返す 404 と同じに返す", async () => {
    const fetchMock = respond(200, {});
    const api = createExperienceHostApiClient({ nihoWebOrigin: ORIGIN, accessToken: TOKEN, fetch: fetchMock });
    const notFound = (reason: string) => ({ ok: false, kind: "error", status: 404, code: "NOT_FOUND", reason, message: "" });
    for (const pageId of ["..", "", "a/b", "x".repeat(201)]) {
      expect(await api.getExperienceProviderPage("cm0provider01", pageId)).toEqual(notFound("PAGE_NOT_FOUND"));
      expect(await api.updateExperienceProviderPage("cm0provider01", pageId, {}, null)).toEqual(notFound("PAGE_NOT_FOUND"));
      expect(await api.getExperienceProviderPageMeetingPoint("cm0provider01", pageId)).toEqual(notFound("PROVIDER_PAGE_NOT_FOUND"));
      expect(await api.getExperienceProviderPageListing("cm0provider01", pageId)).toEqual(notFound("PROVIDER_PAGE_NOT_FOUND"));
      expect(await api.withdrawExperienceProviderPageListing("cm0provider01", pageId)).toEqual(notFound("EXPERIENCE_LISTING_NOT_FOUND"));
    }
    expect(await api.getExperienceProviderPage("..", "cm0page01")).toMatchObject({ status: 404, reason: null });
    expect(await api.listExperienceProviderPages("a/b")).toMatchObject({ status: 404, reason: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("失敗の理由ごとの項目（field・slug・blockers・supportId）を足す", async () => {
    const error = (status: number, code: string, supportId: string | null, details: Record<string, unknown>) => ({ error: { code, message: "合成の失敗", supportId, details } });
    const call = async (status: number, body: unknown) =>
      createExperienceHostApiClient({ nihoWebOrigin: ORIGIN, accessToken: TOKEN, fetch: respond(status, body) }).updateExperienceProviderPage("p1", "g1", {}, null);

    expect(await call(400, error(400, "VALIDATION_ERROR", null, { reason: "PAGE_TITLE_INVALID", field: "title" }))).toEqual({
      ok: false, kind: "error", status: 400, code: "VALIDATION_ERROR", reason: "PAGE_TITLE_INVALID", message: "合成の失敗", field: "title",
    });
    expect(await call(409, error(409, "CONFLICT", "s-1", { reason: "PAGE_SLUG_LOCKED", field: "slug", slug: "old-slug", supportId: "s-1", requestId: "r-1" }))).toEqual({
      ok: false, kind: "error", status: 409, code: "CONFLICT", reason: "PAGE_SLUG_LOCKED", message: "合成の失敗", field: "slug", slug: "old-slug", supportId: "s-1",
    });
    // 契約に無い公開の前提は落とす
    expect(await call(422, error(422, "UNPROCESSABLE_ENTITY", "s-2", { reason: "PAGE_PUBLISH_BLOCKED", blockers: ["COVER_REQUIRED", "NEW_BLOCKER"], supportId: "s-2", requestId: "r-2" }))).toMatchObject({
      reason: "PAGE_PUBLISH_BLOCKED", blockers: ["COVER_REQUIRED"], supportId: "s-2",
    });
    // 写真の識別子・署名の失敗の中身は渡さない
    const signing = await call(503, error(503, "SERVICE_UNAVAILABLE", "s-3", { reason: "signing_transient_failure", spotId: "cm0spot01", objectKey: "k", signingErrorName: "Error", signingErrorCode: 500, supportId: "s-3", requestId: "r-3" }));
    expect(signing).toEqual({ ok: false, kind: "error", status: 503, code: "SERVICE_UNAVAILABLE", reason: "signing_transient_failure", message: "合成の失敗", supportId: "s-3" });
  });

  it("体験ページの詳細は契約の項目だけを取り出し、写真の URL は https だけを受け取る", async () => {
    const extra = createExperienceHostApiClient({ nihoWebOrigin: ORIGIN, accessToken: TOKEN, fetch: respond(200, { ...PAGE, internalNote: "x", content: { ...PAGE.content, draftNote: "x" } }) });
    expect(await extra.getExperienceProviderPage("p1", "g1")).toEqual({ ok: true, data: PAGE });

    const cases: unknown[] = [
      { ...PAGE, photos: [{ objectKey: "k", url: "http://storage.example.com/1.jpg" }] },
      { ...PAGE, status: "ARCHIVED" },
      { ...PAGE, publishBlockers: ["NEW_BLOCKER"] },
      { ...PAGE, offers: [{ id: "o1" }] },
      { ...PAGE, photoAlts: undefined },
    ];
    for (const body of cases) {
      const api = createExperienceHostApiClient({ nihoWebOrigin: ORIGIN, accessToken: TOKEN, fetch: respond(200, body) });
      expect(await api.getExperienceProviderPage("p1", "g1")).toEqual({ ok: false, kind: "unexpected_response", status: 200 });
    }
  });

  it("集合場所の上書きの応答は mode ごとの形だけを受け取る", async () => {
    const read = async (body: unknown) =>
      createExperienceHostApiClient({ nihoWebOrigin: ORIGIN, accessToken: TOKEN, fetch: respond(200, body) })
        .updateExperienceProviderPageMeetingPoint("p1", "g1", { mode: "INHERIT", expectedUpdatedAt: PAGE.updatedAt });
    const meetingPoint = { overview: "駅の近く", address: "合成の住所", accessNote: "", mapUrl: "https://example.com/map", entranceNote: "" };
    expect(await read({ mode: "INHERIT", updatedAt: PAGE.updatedAt, meetingPoint })).toEqual({ ok: true, data: { mode: "INHERIT", updatedAt: PAGE.updatedAt } });
    expect(await read({ mode: "OVERRIDE", updatedAt: PAGE.updatedAt, meetingPoint })).toEqual({ ok: true, data: { mode: "OVERRIDE", updatedAt: PAGE.updatedAt, meetingPoint } });
    expect(await read({ mode: "OVERRIDE", updatedAt: PAGE.updatedAt })).toMatchObject({ ok: false, kind: "unexpected_response" });
    expect(await read({ mode: "OVERRIDE", updatedAt: PAGE.updatedAt, meetingPoint: { ...meetingPoint, mapUrl: "javascript:alert(1)" } })).toMatchObject({ ok: false, kind: "unexpected_response" });
  });

  it("写真の署名つき POST は https の送り先と文字列の項目だけを受け取り、ブラウザへ渡す形にできる", async () => {
    const policy: ExperienceProviderUploadPolicyResponse = {
      uploadId: "u1",
      objectKey: "sample-photos/x/1.jpg",
      upload: { url: "https://uploads.example.com/bucket", fields: { key: "sample-photos/x/1.jpg", policy: "c2FtcGxl", "x-goog-signature": "abc" } },
      expiresAt: "2026-10-21T01:15:00.000Z",
      maxSizeBytes: 10485760,
    };
    const ok = createExperienceHostApiClient({ nihoWebOrigin: ORIGIN, accessToken: TOKEN, fetch: respond(201, policy) });
    const result = await ok.createExperienceProviderUploadPolicy("p1", { purpose: "ARTICLE_IMAGE", contentType: "image/jpeg", contentLength: 1000 });
    expect(result).toEqual({ ok: true, data: policy });
    expect(result.ok && toExperienceProviderPhotoUploadForm(result.data)).toEqual({
      url: "https://uploads.example.com/bucket", fields: policy.upload.fields, objectKey: policy.objectKey, expiresAt: policy.expiresAt, maxSizeBytes: 10485760,
    });

    for (const upload of [{ ...policy.upload, url: "http://uploads.example.com/bucket" }, { ...policy.upload, fields: { key: 1 } }, { url: policy.upload.url }]) {
      const api = createExperienceHostApiClient({ nihoWebOrigin: ORIGIN, accessToken: TOKEN, fetch: respond(201, { ...policy, upload }) });
      expect(await api.createExperienceProviderUploadPolicy("p1", { purpose: "ARTICLE_IMAGE", contentType: "image/jpeg" })).toEqual({ ok: false, kind: "unexpected_response", status: 201 });
    }
  });
});
