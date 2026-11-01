import { afterEach, describe, expect, it } from "vitest";

import {
  createExperienceHostApiClient,
  toExperienceProviderPhotoUploadForm,
  type ExperienceHostApiResult,
  type ExperienceProviderMeetingPoint,
  type FetchLike,
} from "../src/host/index.ts";
import {
  createMockExperienceHostFetch,
  isMockConnectUrl,
  isMockPhotoUrl,
  MOCK_HOST_SCENARIOS,
  MOCK_HOST_USER,
  MOCK_LISTING_CONSENT,
  MOCK_PAYMENT_REUSE_CONSENT,
  MOCK_PROVIDER_CONSENT,
  type MockExperienceHostFetchOptions,
  type MockHostScenario,
} from "../src/host/mock.ts";
import { createHostContractValidator, EXPERIENCE_HOST_CONTRACT_DOCUMENT, findSensitiveValues } from "../src/testing/index.ts";

type AnyRecord = Record<string, any>;

const ORIGIN = "https://niho.life";
const NOW = new Date("2026-10-21T01:00:00.000Z");
const validator = createHostContractValidator();

/** 契約の path（`{providerId}` 付き）と method から operationId を引く。 */
const OPERATIONS = Object.entries(EXPERIENCE_HOST_CONTRACT_DOCUMENT.paths as AnyRecord).flatMap(([path, item]) =>
  Object.entries(item as AnyRecord)
    .filter(([method]) => method !== "parameters")
    .map(([method, operation]) => ({
      method: method.toUpperCase(),
      pattern: new RegExp(`^${path.replace(/\{[^}]+\}/g, "[^/]+")}$`),
      operationId: (operation as AnyRecord).operationId as string,
    })),
);

function operationFor(method: string, pathname: string): string | null {
  return OPERATIONS.find((operation) => operation.method === method && operation.pattern.test(pathname))?.operationId ?? null;
}

type Recorded = { operationId: string | null; status: number; body: unknown };
let recorded: Recorded[] = [];
/** 全 scenario で検証した「operationId status」（成功と主なエラーを全部見たかを最後に確かめる）。 */
const covered = new Set<string>();

/** mock の応答を全部記録する fetch。test の終わりに、全応答が契約の schema に合うことを確かめる。 */
function recordingFetch(scenario: MockHostScenario, options: Omit<MockExperienceHostFetchOptions, "scenario" | "now"> = {}): FetchLike {
  const mock = createMockExperienceHostFetch({ ...options, scenario, now: () => NOW });
  return async (input, init) => {
    const response = await mock(input, init);
    const text = await response.clone().text();
    recorded.push({ operationId: operationFor((init?.method ?? "GET").toUpperCase(), new URL(input).pathname), status: response.status, body: text ? JSON.parse(text) : null });
    return response;
  };
}

function client(scenario: MockHostScenario, idToken = "sample-id-token", options: Omit<MockExperienceHostFetchOptions, "scenario" | "now"> = {}) {
  return createExperienceHostApiClient({ nihoWebOrigin: ORIGIN, idToken, fetch: recordingFetch(scenario, options) });
}

function data<T>(result: ExperienceHostApiResult<T>): T {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result)}`);
  return result.data;
}

/** 成功なら、クライアントが取り出した値が mock の本文（契約の項目だけ）と同じことを確かめる。 */
async function run<T>(pending: Promise<ExperienceHostApiResult<T>>): Promise<ExperienceHostApiResult<T>> {
  const result = await pending;
  if (result.ok) expect(result.data).toEqual(recorded.at(-1)?.body);
  else expect(result.kind).toBe("error");
  return result;
}

/** 合成でない URL（実在しうる host）と、合成でない写真の識別子を探す（公開リポに実データを入れない）。 */
function findNonSyntheticValues(value: unknown, path = "$", key = ""): string[] {
  if (typeof value === "string") {
    const findings: string[] = [];
    if (/^https?:\/\//.test(value)) {
      const { hostname } = new URL(value);
      if (!hostname.endsWith(".test") && hostname !== "example.com") findings.push(`${path}: 合成でない host（${hostname}）`);
    }
    if (/objectkeys?$/i.test(key) && !value.startsWith("sample-photos/")) findings.push(`${path}: 合成でない写真の識別子`);
    return findings;
  }
  if (Array.isArray(value)) return value.flatMap((item, index) => findNonSyntheticValues(item, `${path}[${index}]`, key));
  if (typeof value === "object" && value !== null) return Object.entries(value).flatMap(([name, child]) => findNonSyntheticValues(child, `${path}.${name}`, name));
  return [];
}

afterEach(() => {
  const invalid = recorded.flatMap(({ operationId, status, body }) => {
    if (!operationId) return [`unknown operation (status ${status})`];
    covered.add(`${operationId} ${status}`);
    const result = validator.validateResponse(operationId, status, body);
    return result.ok ? [] : [`${operationId} ${status}: ${result.errors.join("; ")}`];
  });
  const bodies = recorded.map((entry) => entry.body);
  const sensitive = [...findSensitiveValues(bodies), ...findNonSyntheticValues(bodies)];
  recorded = [];
  expect(invalid).toEqual([]);
  expect(sensitive).toEqual([]);
});

const MEETING_POINT: ExperienceProviderMeetingPoint = {
  overview: "（sample）駅の近く",
  address: "（sample）サンプル町 2 丁目（架空）",
  accessNote: "（sample）改札を出て右へ。",
  mapUrl: "https://example.com/sample/map",
  entranceNote: "（sample）白い扉です。",
};
const STALE = "2000-01-01T00:00:00.000Z";
const SOMEONE_ELSES_PHOTO = "sample-photos/someone-else/photo.jpg";

type HostApi = ReturnType<typeof client>;

/** 提供者 1 件について、集合場所・写真・体験ページ・掲載の全操作を、成功と主な失敗の両方で呼ぶ。 */
async function exercisePages(api: HostApi, providerId: string): Promise<void> {
  await run(api.getExperienceProviderMeetingPoint(providerId));
  await run(api.updateExperienceProviderMeetingPoint(providerId, { ...MEETING_POINT, mapUrl: "http://example.com/map" }));
  await run(api.updateExperienceProviderMeetingPoint(providerId, MEETING_POINT));

  const policy = await run(api.createExperienceProviderUploadPolicy(providerId, { purpose: "ARTICLE_IMAGE", contentType: "image/jpeg", contentLength: 1024 }));
  await run(api.createExperienceProviderUploadPolicy(providerId, { purpose: "ARTICLE_IMAGE", contentType: "image/gif" as "image/png" }));
  const photo = policy.ok ? policy.data.objectKey : SOMEONE_ELSES_PHOTO;
  await run(api.createExperienceProviderUploadSignedUrl(providerId, { objectKey: photo }));
  await run(api.createExperienceProviderUploadSignedUrl(providerId, { objectKey: SOMEONE_ELSES_PHOTO }));
  await run(api.createExperienceProviderUploadSignedUrl(providerId, { objectKey: "" }));

  await run(api.createExperienceProviderPage(providerId, { kind: "EXPERIENCE", language: "EN", title: "Sample tea ceremony" }));
  await run(api.createExperienceProviderPage(providerId, { kind: "EXPERIENCE", language: "EN", title: "x".repeat(96) }));
  await run(api.createExperienceProviderPage(providerId, { kind: "EXPERIENCE", language: "JA", slug: "sample-tea-ceremony" }));
  const list = await run(api.listExperienceProviderPages(providerId));
  const pageIds = [...(list.ok ? list.data.pages.map((page) => page.id) : []), "missing-page"];

  for (const pageId of pageIds) {
    const detail = await run(api.getExperienceProviderPage(providerId, pageId));
    let version = detail.ok ? detail.data.updatedAt : NOW.toISOString();
    await run(api.getExperienceProviderPagePreview(providerId, pageId));
    await run(api.getExperienceProviderPageMeetingPoint(providerId, pageId));
    await run(api.updateExperienceProviderPageMeetingPoint(providerId, pageId, { mode: "INHERIT", expectedUpdatedAt: STALE }));
    await run(api.updateExperienceProviderPageMeetingPoint(providerId, pageId, { mode: "OVERRIDE", meetingPoint: { ...MEETING_POINT, overview: "x".repeat(201) }, expectedUpdatedAt: version }));
    const moved = await run(api.updateExperienceProviderPageMeetingPoint(providerId, pageId, { mode: "OVERRIDE", meetingPoint: MEETING_POINT, expectedUpdatedAt: version }));
    if (moved.ok) version = moved.data.updatedAt;

    await run(api.updateExperienceProviderPage(providerId, pageId, { title: "（sample）古い版で直す" }, STALE));
    await run(api.updateExperienceProviderPage(providerId, pageId, { offer: { priceYen: -1 } }, null));
    await run(api.updateExperienceProviderPage(providerId, pageId, { photoObjectKeys: [SOMEONE_ELSES_PHOTO] }, null));
    const saved = await run(api.updateExperienceProviderPage(providerId, pageId, {
      photoObjectKeys: [photo],
      photoAlts: ["（sample）写真の説明"],
      offer: { priceYen: 5000, weekdays: [1, 3] },
      content: { lead: "（sample）直した紹介", highlights: ["（sample）見どころ", null] },
    }, version));
    if (saved.ok) version = saved.data.updatedAt;

    await run(api.publishExperienceProviderPage(providerId, pageId, STALE));
    await run(api.publishExperienceProviderPage(providerId, pageId, version));
    await run(api.getExperienceProviderPagePreview(providerId, pageId));
    await run(api.getExperienceProviderPageListing(providerId, pageId));
    await run(api.requestExperienceProviderPageListing(providerId, pageId, { consentVersion: "sample-old-consent" }));
    await run(api.requestExperienceProviderPageListing(providerId, pageId, { consentVersion: "" }));
    await run(api.requestExperienceProviderPageListing(providerId, pageId, { consentVersion: MOCK_LISTING_CONSENT.version }));
    await run(api.withdrawExperienceProviderPageListing(providerId, pageId));
    await run(api.unpublishExperienceProviderPage(providerId, pageId));
    await run(api.deleteExperienceProviderPage(providerId, pageId));
  }
}

describe("ホスト API の mock：全 scenario・全操作の応答が契約に合う", () => {
  const runs: Array<{ name: string; scenario: MockHostScenario; uploadsDisabled?: boolean }> = [
    ...MOCK_HOST_SCENARIOS.map((scenario) => ({ name: scenario, scenario })),
    { name: "two-providers（写真の保存が止まっている）", scenario: "two-providers", uploadsDisabled: true },
  ];
  it.each(runs)("$name", async ({ scenario, uploadsDisabled }) => {
    const api = client(scenario, "sample-id-token", { uploadsDisabled: uploadsDisabled ?? false });
    const list = data(await api.listExperienceProviders());
    await api.getAuthMe();
    const ids = [...list.providers.map((provider) => provider.id), "someone-elses-provider"];
    for (const id of ids) {
      await api.getExperienceProvider(id);
      await api.updateExperienceProvider(id, { bio: "（sample）紹介を直しました。" });
      await api.getExperienceProviderPaymentReadiness(id);
      await api.listExperienceProviderPaymentReuseCandidates(id);
      await api.reuseExperienceProviderPayment(id, { sourceSpotId: "sample-spot-house", consentVersion: MOCK_PAYMENT_REUSE_CONSENT.version });
      await api.syncExperienceProviderPaymentConnect(id);
      await api.startExperienceProviderPaymentConnect(id);
      await api.resumeExperienceProviderPaymentConnect(id);
      await api.syncExperienceProviderPaymentConnect(id);
      await api.submitExperienceProvider(id);
      await exercisePages(api, id);
    }
    await api.registerExperienceProvider({ kind: "BUSINESS", displayName: "（sample）新しい提供者", bio: "", sellerDisclosureUrl: null, consentVersion: MOCK_PROVIDER_CONSENT.version });
    await api.registerExperienceProvider({ kind: "INDIVIDUAL", displayName: " ", bio: "", sellerDisclosureUrl: null, consentVersion: MOCK_PROVIDER_CONSENT.version });
    expect(recorded.length).toBeGreaterThan(5);
  });

  it("Bearer が無ければ 401", async () => {
    const mock = createMockExperienceHostFetch({ scenario: "two-providers", now: () => NOW });
    const paths = [
      "/api/auth/me",
      "/api/experience-providers",
      "/api/experience-providers/sample-provider-kitchen",
      "/api/experience-providers/sample-provider-kitchen/pages",
      "/api/experience-providers/sample-provider-kitchen/pages/sample-page-kitchen-cooking",
    ];
    for (const path of paths) {
      const response = await mock(`${ORIGIN}${path}`, { headers: { authorization: "Bearer " } });
      recorded.push({ operationId: operationFor("GET", path), status: response.status, body: await response.json() });
      expect(response.status).toBe(401);
    }
  });

  it("全操作の成功と主な失敗を、契約の schema で検証した", () => {
    const operations = new Set(OPERATIONS.map((operation) => operation.operationId));
    expect(operations.size).toBe(29);
    const succeeded = [...operations].filter((operationId) => [...covered].some((entry) => entry.startsWith(`${operationId} 2`)));
    expect(succeeded.sort()).toEqual([...operations].sort());
    expect([...covered]).toEqual(expect.arrayContaining([
      "updateExperienceProviderMeetingPoint 400",
      "createExperienceProviderPage 400",
      "createExperienceProviderPage 404",
      "createExperienceProviderPage 409",
      "getExperienceProviderPage 404",
      "updateExperienceProviderPage 400",
      "updateExperienceProviderPage 404",
      "updateExperienceProviderPage 409",
      "updateExperienceProviderPage 422",
      "deleteExperienceProviderPage 409",
      "publishExperienceProviderPage 409",
      "publishExperienceProviderPage 422",
      "unpublishExperienceProviderPage 409",
      "getExperienceProviderPagePreview 404",
      "getExperienceProviderPageMeetingPoint 404",
      "updateExperienceProviderPageMeetingPoint 400",
      "updateExperienceProviderPageMeetingPoint 409",
      "getExperienceProviderPageListing 404",
      "requestExperienceProviderPageListing 400",
      "requestExperienceProviderPageListing 404",
      "requestExperienceProviderPageListing 422",
      "withdrawExperienceProviderPageListing 404",
      "createExperienceProviderUploadPolicy 400",
      "createExperienceProviderUploadPolicy 503",
      "createExperienceProviderUploadSignedUrl 400",
      "createExperienceProviderUploadSignedUrl 404",
      "createExperienceProviderUploadSignedUrl 503",
      "getExperienceProviderPage 401",
    ]));
  });
});

describe("ホスト API の mock：scenario", () => {
  it("empty は提供者 0 件で、登録すると OWNER の下書きが増える（同じインスタンスの中だけ）", async () => {
    const api = client("empty");
    const before = data(await api.listExperienceProviders());
    expect(before.providers).toEqual([]);
    expect(before.consent).toEqual(MOCK_PROVIDER_CONSENT);

    const outdated = await api.registerExperienceProvider({ kind: "INDIVIDUAL", displayName: "（sample）台所", bio: "", sellerDisclosureUrl: null, consentVersion: "old" });
    expect(outdated).toMatchObject({ ok: false, kind: "error", status: 422, code: "UNPROCESSABLE_ENTITY", reason: "PROVIDER_CONSENT_OUTDATED" });

    const created = data(await api.registerExperienceProvider({ kind: "INDIVIDUAL", displayName: "  （sample）台所  ", bio: "紹介", sellerDisclosureUrl: null, consentVersion: MOCK_PROVIDER_CONSENT.version }));
    expect(created.provider).toMatchObject({ displayName: "（sample）台所", reviewStatus: "DRAFT", ownerUserId: MOCK_HOST_USER.id, createdAt: NOW.toISOString() });
    const after = data(await api.listExperienceProviders());
    expect(after.providers).toEqual([{ ...created.provider, memberRole: "OWNER" }]);
    expect(data(await client("empty").listExperienceProviders()).providers).toEqual([]);
  });

  it("two-providers は OWNER・承認済み・口座準備済みの台所と、EDITOR・下書きの工房", async () => {
    const api = client("two-providers");
    const { providers } = data(await api.listExperienceProviders());
    expect(providers.map(({ id, displayName, memberRole, reviewStatus }) => ({ id, displayName, memberRole, reviewStatus }))).toEqual([
      { id: "sample-provider-kitchen", displayName: "サンプルの台所", memberRole: "OWNER", reviewStatus: "APPROVED" },
      { id: "sample-provider-studio", displayName: "サンプル工房", memberRole: "EDITOR", reviewStatus: "DRAFT" },
    ]);
    expect(data(await api.getExperienceProviderPaymentReadiness("sample-provider-kitchen"))).toMatchObject({ ready: true, reason: "READY" });
    // 申込があるので口座を切り替えられない
    expect(await api.reuseExperienceProviderPayment("sample-provider-kitchen", { sourceSpotId: "x", consentVersion: MOCK_PAYMENT_REUSE_CONSENT.version }))
      .toMatchObject({ ok: false, status: 409, reason: "PROVIDER_PAYMENT_LOCKED" });

    // EDITOR は OWNER だけの操作が 404・販売者表示の変更が 403・紹介は直せる
    expect(await api.getExperienceProviderPaymentReadiness("sample-provider-studio")).toMatchObject({ ok: false, status: 404, code: "NOT_FOUND", reason: null });
    expect(await api.submitExperienceProvider("sample-provider-studio")).toMatchObject({ ok: false, status: 404 });
    expect(await api.updateExperienceProvider("sample-provider-studio", { sellerDisclosureUrl: "https://example.com/legal" })).toMatchObject({ ok: false, status: 403, code: "FORBIDDEN" });
    expect(data(await api.updateExperienceProvider("sample-provider-studio", { displayName: "サンプル工房（改）" })).provider.displayName).toBe("サンプル工房（改）");

    // 承認済みの紹介を直すと再審査（REQUESTED）に戻る
    expect(data(await api.updateExperienceProvider("sample-provider-kitchen", { bio: "直した紹介" })).provider.reviewStatus).toBe("REQUESTED");
    expect(await api.updateExperienceProvider("sample-provider-kitchen", {})).toMatchObject({ ok: false, status: 400, code: "VALIDATION_ERROR" });
    expect(await api.updateExperienceProvider("sample-provider-kitchen", { sellerDisclosureUrl: "http://example.com/legal" })).toMatchObject({ ok: false, status: 400 });
  });

  it("payments-pending は口座が未接続で、準備済みの拠点の口座を再利用できる", async () => {
    const api = client("payments-pending");
    const [garden] = data(await api.listExperienceProviders()).providers;
    expect(garden).toMatchObject({ id: "sample-provider-garden", memberRole: "OWNER", reviewStatus: "DRAFT" });
    const id = garden!.id;
    expect(data(await api.getExperienceProviderPaymentReadiness(id))).toEqual({ ready: false, reason: "NOT_CONNECTED", paymentReuseConsent: MOCK_PAYMENT_REUSE_CONSENT });
    expect(data(await api.listExperienceProviderPaymentReuseCandidates(id)).spots).toEqual([
      { id: "sample-spot-house", name: "サンプルの拠点", ready: true, reason: "READY" },
      { id: "sample-spot-annex", name: "サンプルの別館", ready: false, reason: "VERIFICATION_REQUIRED" },
    ]);
    const consentVersion = MOCK_PAYMENT_REUSE_CONSENT.version;
    expect(await api.reuseExperienceProviderPayment(id, { sourceSpotId: "sample-spot-house", consentVersion: "old" })).toMatchObject({ status: 422, reason: "PROVIDER_PAYMENT_CONSENT_OUTDATED" });
    expect(await api.reuseExperienceProviderPayment(id, { sourceSpotId: "sample-spot-annex", consentVersion })).toMatchObject({ status: 422, reason: "PROVIDER_PAYMENT_SOURCE_NOT_READY" });
    expect(await api.reuseExperienceProviderPayment(id, { sourceSpotId: "someone-elses-spot", consentVersion })).toMatchObject({ status: 404, reason: "PROVIDER_PAYMENT_SOURCE_FORBIDDEN" });

    const reused = data(await api.reuseExperienceProviderPayment(id, { sourceSpotId: "sample-spot-house", consentVersion }));
    expect(reused.provider).toMatchObject({ paymentReuseSourceSpotId: "sample-spot-house", paymentReuseConsentVersion: consentVersion, paymentReuseConsentedAt: NOW.toISOString() });
    expect(data(await api.getExperienceProviderPaymentReadiness(id))).toMatchObject({ ready: true, reason: "READY" });
    expect(await api.startExperienceProviderPaymentConnect(id)).toMatchObject({ ok: false, status: 409, reason: "PROVIDER_PAYMENT_SHARED_ACCOUNT" });
  });

  it("Stripe の接続は合成の URL を返し、sync で準備済みになる", async () => {
    const api = client("payments-pending");
    const id = "sample-provider-garden";
    expect(await api.syncExperienceProviderPaymentConnect(id)).toMatchObject({ ok: false, status: 409, code: "CONFLICT", reason: "PROVIDER_PAYMENT_NOT_CONNECTED" });
    const started = data(await api.startExperienceProviderPaymentConnect(id));
    expect(started).toMatchObject({ ready: false, reason: "VERIFICATION_REQUIRED", expiresAt: "2026-10-21T01:05:00.000Z" });
    expect(new URL(started.url!).origin).toBe("https://connect.stripe.test");
    expect(isMockConnectUrl(started.url!)).toBe(true);
    const resumed = data(await api.resumeExperienceProviderPaymentConnect(id));
    expect(resumed.url).not.toBe(started.url);
    expect(data(await api.syncExperienceProviderPaymentConnect(id))).toEqual({ url: null, expiresAt: null, ready: true, reason: "READY" });
  });

  it("審査の申請は販売者表示と今の同意の版がそろったときだけ", async () => {
    const api = client("two-providers");
    // 承認済みのまま申請はできない
    expect(await api.submitExperienceProvider("sample-provider-kitchen")).toMatchObject({ ok: false, status: 409, reason: "PROVIDER_REVIEW_STATE_CONFLICT" });
    const fresh = client("empty");
    const { provider } = data(await fresh.registerExperienceProvider({ kind: "BUSINESS", displayName: "（sample）工房", bio: "", sellerDisclosureUrl: null, consentVersion: MOCK_PROVIDER_CONSENT.version }));
    expect(await fresh.submitExperienceProvider(provider.id)).toMatchObject({ ok: false, status: 409, reason: "PROVIDER_REVIEW_STATE_CONFLICT" });
    await fresh.updateExperienceProvider(provider.id, { sellerDisclosureUrl: "https://example.com/sample/legal" });
    expect(data(await fresh.submitExperienceProvider(provider.id))).toEqual({ submitted: true });
    expect(data(await fresh.getExperienceProvider(provider.id)).provider).toMatchObject({ reviewStatus: "REQUESTED", submittedAt: NOW.toISOString() });
  });

  it("me は合成の本人だけを返す", async () => {
    expect(data(await client("empty").getAuthMe())).toEqual({ user: { id: MOCK_HOST_USER.id, displayName: MOCK_HOST_USER.displayName }, userIconImage: null });
  });
});

describe("ホスト API の mock：体験ページ・集合場所・掲載・写真", () => {
  const KITCHEN = "sample-provider-kitchen";
  const PUBLISHED = "sample-page-kitchen-cooking";
  const DRAFT = "sample-page-kitchen-market";

  it("two-providers の OWNER は公開中（英語・掲載中）と下書き（日本語）の 2 件を持つ", async () => {
    const api = client("two-providers");
    const { pages, checkoutEnabled } = data(await api.listExperienceProviderPages(KITCHEN));
    expect(checkoutEnabled).toBe(true);
    expect(pages.map(({ id, status, language, bookingCounts }) => ({ id, status, language, bookingCounts }))).toEqual([
      { id: DRAFT, status: "DRAFT", language: "JA", bookingCounts: { confirmed: 0, thisWeek: 0 } },
      { id: PUBLISHED, status: "PUBLISHED", language: "EN", bookingCounts: { confirmed: 3, thisWeek: 1 } },
    ]);
    expect(isMockPhotoUrl(pages[1]!.coverUrl!)).toBe(true);

    const published = data(await api.getExperienceProviderPage(KITCHEN, PUBLISHED));
    expect(published).toMatchObject({ publishBlockers: [], publicPath: "/living/sample-kitchen/pages/seasonal-home-cooking", coverObjectKey: published.photos[0]!.objectKey });
    expect(published.photos).toHaveLength(3);
    expect(published.photoAlts).toHaveLength(3);
    expect(published.photos.every((photo) => photo.url !== null && isMockPhotoUrl(photo.url))).toBe(true);
    expect(published.offer).toEqual(published.offers[0]);
    expect(data(await api.getExperienceProviderPageListing(KITCHEN, PUBLISHED))).toMatchObject({ listing: { status: "ACTIVE", regionKey: "kamakura" }, consent: MOCK_LISTING_CONSENT });

    const draft = data(await api.getExperienceProviderPage(KITCHEN, DRAFT));
    expect(draft.publishBlockers).toEqual(["COVER_REQUIRED", "OFFER_PRICE_REQUIRED", "OFFER_WEEKDAYS_REQUIRED"]);
    expect(data(await api.getExperienceProviderPageListing(KITCHEN, DRAFT)).listing).toBeNull();
    expect(data(await api.getExperienceProviderPageMeetingPoint(KITCHEN, DRAFT)).mode).toBe("OVERRIDE");
    expect(data(await api.getExperienceProviderPageMeetingPoint(KITCHEN, PUBLISHED))).toEqual({ mode: "INHERIT", meetingPoint: data(await api.getExperienceProviderMeetingPoint(KITCHEN)).meetingPoint });

    // ほかの scenario の提供者は体験ページが無く、集合場所は未設定
    const empty = data(await client("payments-pending").getExperienceProviderMeetingPoint("sample-provider-garden")).meetingPoint;
    expect(Object.values(empty).every((value) => value === "")).toBe(true);
  });

  it("保存は読んだ版（updatedAt）が今の版のときだけで、保存すると版が進み掲載は止まる", async () => {
    const api = client("two-providers");
    const before = data(await api.getExperienceProviderPage(KITCHEN, PUBLISHED));
    expect(await api.updateExperienceProviderPage(KITCHEN, PUBLISHED, { title: "Changed (sample)" }, STALE)).toMatchObject({ ok: false, status: 409, code: "CONFLICT", reason: "PAGE_UPDATED" });

    const saved = data(await api.updateExperienceProviderPage(KITCHEN, PUBLISHED, { title: "  Changed (sample)  " }, before.updatedAt));
    expect(saved.title).toBe("Changed (sample)");
    expect(saved.updatedAt > before.updatedAt).toBe(true);
    // 時計が止まっていても、続けて保存すると版は進む
    const again = data(await api.updateExperienceProviderPage(KITCHEN, PUBLISHED, { listOnEntrance: false }, saved.updatedAt));
    expect(again.updatedAt > saved.updatedAt).toBe(true);
    expect(await api.updateExperienceProviderPage(KITCHEN, PUBLISHED, { listOnEntrance: true }, saved.updatedAt)).toMatchObject({ status: 409, reason: "PAGE_UPDATED" });
    expect(data(await api.updateExperienceProviderPage(KITCHEN, PUBLISHED, { listOnEntrance: true }, null)).listOnEntrance).toBe(true);
    expect(data(await api.getExperienceProviderPageListing(KITCHEN, PUBLISHED)).listing).toMatchObject({ status: "PAUSED", pausedAt: NOW.toISOString() });
  });

  it("体験ページの入力の失敗は理由と項目の場所を返す", async () => {
    const api = client("two-providers");
    expect(await api.updateExperienceProviderPage(KITCHEN, PUBLISHED, { slug: "another-slug" }, null)).toMatchObject({ status: 409, reason: "PAGE_SLUG_LOCKED", field: "slug", slug: "seasonal-home-cooking" });
    expect(await api.updateExperienceProviderPage(KITCHEN, DRAFT, { slug: "Seasonal Home Cooking" }, null)).toMatchObject({ status: 409, reason: "PAGE_SLUG_TAKEN", field: "slug" });
    expect(await api.updateExperienceProviderPage(KITCHEN, DRAFT, { slug: "x" }, null)).toMatchObject({ status: 400, code: "VALIDATION_ERROR", reason: "PAGE_SLUG_INVALID", field: "slug" });
    expect(await api.updateExperienceProviderPage(KITCHEN, DRAFT, { photoAlts: ["a"] }, null)).toMatchObject({ status: 400, reason: "PAGE_PHOTOS_INVALID", field: "photoAlts" });
    expect(await api.updateExperienceProviderPage(KITCHEN, DRAFT, { photoObjectKeys: [SOMEONE_ELSES_PHOTO] }, null)).toMatchObject({ status: 422, reason: "PAGE_PHOTOS_INVALID", field: "photoObjectKeys.0" });
    expect(await api.updateExperienceProviderPage(KITCHEN, DRAFT, { offers: [{ capacity: 2, maxPartySize: 3 }] }, null)).toMatchObject({ status: 400, reason: "PAGE_OFFER_INVALID", field: "offers.0.maxPartySize" });
    expect(await api.updateExperienceProviderPage(KITCHEN, DRAFT, { offer: { bookingQuestions: [{ prompt: "?", inputType: "SINGLE_SELECT" }] } }, null)).toMatchObject({ status: 400, reason: "PAGE_OFFER_QUESTIONS_INVALID", field: "offer.bookingQuestions.0.options" });
    expect(await api.updateExperienceProviderPage(KITCHEN, DRAFT, { content: { highlights: Array(7).fill("x") } }, null)).toMatchObject({ status: 400, reason: "PAGE_CONTENT_INVALID", field: "content.highlights" });
    // 申込のある商品は外せない・公開中のページを公開の前提を満たさない内容へは変えられない
    expect(await api.updateExperienceProviderPage(KITCHEN, PUBLISHED, { offers: [{ name: "New (sample)" }] }, null)).toMatchObject({ status: 409, reason: "PAGE_OFFER_HAS_BOOKINGS" });
    expect(await api.updateExperienceProviderPage(KITCHEN, PUBLISHED, { offer: { priceYen: 0 } }, null)).toMatchObject({ status: 422, reason: "PAGE_PUBLISH_BLOCKED", blockers: ["OFFER_PRICE_REQUIRED"] });
    expect(await api.getExperienceProviderPage(KITCHEN, "missing-page")).toMatchObject({ status: 404, code: "NOT_FOUND", reason: "PAGE_NOT_FOUND" });
  });

  it("写真を上げて下書きを公開し、英語のページだけ掲載を申請・取り下げできる", async () => {
    const api = client("two-providers");
    const draft = data(await api.getExperienceProviderPage(KITCHEN, DRAFT));
    expect(await api.publishExperienceProviderPage(KITCHEN, DRAFT, draft.updatedAt)).toMatchObject({ status: 422, reason: "PAGE_PUBLISH_BLOCKED", blockers: draft.publishBlockers });
    expect(await api.unpublishExperienceProviderPage(KITCHEN, DRAFT)).toMatchObject({ status: 409, reason: "PAGE_NOT_PUBLISHED" });

    const policy = data(await api.createExperienceProviderUploadPolicy(KITCHEN, { purpose: "ARTICLE_IMAGE", contentType: "image/webp" }));
    const form = toExperienceProviderPhotoUploadForm(policy);
    expect(form).toEqual({ url: "https://uploads.niho-mock.test/sample-bucket", fields: policy.upload.fields, objectKey: policy.objectKey, expiresAt: "2026-10-21T01:15:00.000Z", maxSizeBytes: 10 * 1024 * 1024 });
    expect(form.fields).toMatchObject({ key: policy.objectKey, "Content-Type": "image/webp" });
    expect(data(await api.createExperienceProviderUploadSignedUrl(KITCHEN, { objectKey: policy.objectKey })).signedUrl).toMatch(/^https:\/\/uploads\.niho-mock\.test\//);
    // 別の提供者の上げ口の写真は見られない
    expect(await api.createExperienceProviderUploadSignedUrl("sample-provider-studio", { objectKey: policy.objectKey })).toMatchObject({ status: 404, reason: null });

    const ready = data(await api.updateExperienceProviderPage(KITCHEN, DRAFT, { photoObjectKeys: [policy.objectKey], offer: { priceYen: 6000, weekdays: [0] } }, draft.updatedAt));
    expect(ready).toMatchObject({ publishBlockers: [], coverObjectKey: policy.objectKey, photoAlts: [""] });
    const published = data(await api.publishExperienceProviderPage(KITCHEN, DRAFT, ready.updatedAt));
    expect(published).toMatchObject({ status: "PUBLISHED", publishedAt: NOW.toISOString() });
    expect(await api.deleteExperienceProviderPage(KITCHEN, DRAFT)).toMatchObject({ status: 409, reason: "PAGE_DELETE_PUBLISHED" });

    const consentVersion = MOCK_LISTING_CONSENT.version;
    expect(await api.requestExperienceProviderPageListing(KITCHEN, DRAFT, { consentVersion })).toMatchObject({ status: 422, reason: "EXPERIENCE_LISTING_PAGE_NOT_ELIGIBLE" });
    await api.updateExperienceProviderPage(KITCHEN, DRAFT, { language: "EN" }, null);
    expect(await api.requestExperienceProviderPageListing(KITCHEN, DRAFT, { consentVersion: "sample-old" })).toMatchObject({ status: 422, reason: "EXPERIENCE_LISTING_CONSENT_OUTDATED" });
    expect(await api.withdrawExperienceProviderPageListing(KITCHEN, DRAFT)).toMatchObject({ status: 404, reason: "EXPERIENCE_LISTING_NOT_FOUND" });
    expect(data(await api.requestExperienceProviderPageListing(KITCHEN, DRAFT, { consentVersion })).listing).toMatchObject({ status: "REQUESTED", campaignPageId: DRAFT, consentedAt: NOW.toISOString() });
    expect(data(await api.withdrawExperienceProviderPageListing(KITCHEN, DRAFT)).listing).toMatchObject({ status: "WITHDRAWN", withdrawnAt: NOW.toISOString() });
    expect(data(await api.requestExperienceProviderPageListing(KITCHEN, DRAFT, { consentVersion })).listing?.status).toBe("REQUESTED");

    const stopped = data(await api.unpublishExperienceProviderPage(KITCHEN, PUBLISHED));
    expect(stopped).toMatchObject({ status: "UNPUBLISHED", unpublishedAt: NOW.toISOString() });
    expect(data(await api.getExperienceProviderPageListing(KITCHEN, PUBLISHED)).listing?.status).toBe("PAUSED");
  });

  it("下書きを作って消せる（slug は題名から決め、重ならない）", async () => {
    const api = client("two-providers");
    expect(await api.createExperienceProviderPage(KITCHEN, { kind: "EXPERIENCE", language: "EN", slug: "seasonal-home-cooking" })).toMatchObject({ status: 409, reason: "PAGE_SLUG_TAKEN", field: "slug" });
    expect(await api.createExperienceProviderPage(KITCHEN, { kind: "EXPERIENCE", language: "EN", title: "x".repeat(96) })).toMatchObject({ status: 400, reason: "PAGE_TITLE_INVALID", field: "title" });
    const created = data(await api.createExperienceProviderPage(KITCHEN, { kind: "EXPERIENCE", language: "EN", title: "Seasonal home cooking" }));
    expect(created).toMatchObject({ slug: "seasonal-home-cooking-2", status: "DRAFT", createdAt: NOW.toISOString(), publishedAt: null });
    expect(created.offers).toHaveLength(1);
    expect(created.publishBlockers).toEqual(["COVER_REQUIRED", "OFFER_PRICE_REQUIRED", "OFFER_WEEKDAYS_REQUIRED"]);
    expect(data(await api.createExperienceProviderPage(KITCHEN, { kind: "EXPERIENCE", language: "JA", title: "（サンプル）題名" })).slug).toMatch(/^page-\d+$/);
    expect(data(await api.deleteExperienceProviderPage(KITCHEN, created.id))).toEqual({ id: created.id, deleted: true });
    expect(await api.getExperienceProviderPage(KITCHEN, created.id)).toMatchObject({ status: 404, reason: "PAGE_NOT_FOUND" });
  });

  it("集合場所：既定を直すと掲載が止まり、ページの上書きは版を確かめる", async () => {
    const api = client("two-providers");
    expect(await api.updateExperienceProviderMeetingPoint(KITCHEN, { ...MEETING_POINT, mapUrl: "https://user:pass@example.com/map" })).toMatchObject({ status: 400, code: "VALIDATION_ERROR", reason: null });
    expect(data(await api.updateExperienceProviderMeetingPoint(KITCHEN, { ...MEETING_POINT, overview: "  （sample）駅の近く  " })).meetingPoint.overview).toBe("（sample）駅の近く");
    expect(data(await api.getExperienceProviderPageListing(KITCHEN, PUBLISHED)).listing?.status).toBe("PAUSED");
    expect(data(await api.getExperienceProviderPageMeetingPoint(KITCHEN, PUBLISHED)).meetingPoint).toEqual(MEETING_POINT);

    const { updatedAt } = data(await api.getExperienceProviderPage(KITCHEN, DRAFT));
    expect(await api.updateExperienceProviderPageMeetingPoint(KITCHEN, DRAFT, { mode: "INHERIT", expectedUpdatedAt: STALE })).toMatchObject({ status: 409, reason: "PROVIDER_PAGE_CONFLICT" });
    const inherited = data(await api.updateExperienceProviderPageMeetingPoint(KITCHEN, DRAFT, { mode: "INHERIT", expectedUpdatedAt: updatedAt }));
    expect(inherited).toEqual({ mode: "INHERIT", updatedAt: NOW.toISOString() });
    expect(data(await api.getExperienceProviderPage(KITCHEN, DRAFT)).updatedAt).toBe(inherited.updatedAt);
    expect(await api.getExperienceProviderPageMeetingPoint(KITCHEN, "missing-page")).toMatchObject({ status: 404, reason: "PROVIDER_PAGE_NOT_FOUND" });
  });

  it("プレビューは公開ページと同じ組み立てで、口座が準備できていなければ予約できない", async () => {
    const api = client("two-providers");
    const preview = data(await api.getExperienceProviderPagePreview(KITCHEN, PUBLISHED));
    expect(preview.spot).toMatchObject({ slug: "sample-kitchen", name: "サンプルの台所", meetingPoint: null });
    expect(preview.hosts).toEqual([{ displayName: MOCK_HOST_USER.displayName, avatarUrl: null }]);
    expect(preview.page.photos).toHaveLength(3);
    expect(preview.page.content.timeline[0]!.photoIndex).toBe(0);
    expect(preview.offer.bookingQuestionsFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(preview.offers[0]!.occurrences).toEqual(preview.occurrences);
    // 2026-10-21（水）JST から 90 日の火・木・土。翌日（木）の回は締切（前日 23:59）前なので予約できる
    expect(preview.occurrences[0]).toEqual({ date: "2026-10-22", startAt: "2026-10-22T01:00:00.000Z", endAt: "2026-10-22T04:00:00.000Z", seatsLeft: 6, bookable: true });
    expect(preview.occurrences.every((occurrence) => [2, 4, 6].includes(new Date(`${occurrence.date}T00:00:00Z`).getUTCDay()))).toBe(true);

    const fresh = client("payments-pending");
    const page = data(await fresh.createExperienceProviderPage("sample-provider-garden", { kind: "EXPERIENCE", language: "JA", title: "（サンプル）庭" }));
    await fresh.updateExperienceProviderPage("sample-provider-garden", page.id, { offer: { weekdays: [1, 2, 3, 4, 5] } }, null);
    const pending = data(await fresh.getExperienceProviderPagePreview("sample-provider-garden", page.id));
    expect(pending.occurrences.length).toBeGreaterThan(0);
    expect(pending.occurrences.every((occurrence) => !occurrence.bookable && occurrence.reason === "unavailable")).toBe(true);
    expect(data(await fresh.getExperienceProviderPage("sample-provider-garden", page.id)).publishBlockers).toContain("STRIPE_NOT_READY");

    // 有効な商品が無ければプレビューは無い
    await fresh.updateExperienceProviderPage("sample-provider-garden", page.id, { offer: { isActive: false } }, null);
    expect(await fresh.getExperienceProviderPagePreview("sample-provider-garden", page.id)).toMatchObject({ status: 404, reason: "PAGE_NOT_FOUND" });
  });

  it("日本語のページのプレビューは、今の原文と合う英訳だけを返し、日本語を直した項目は null に戻る（英語のページに英訳は無い）", async () => {
    const api = client("two-providers");
    const before = data(await api.getExperienceProviderPagePreview(KITCHEN, DRAFT)).page;
    expect(before.language).toBe("JA");
    expect(before.titleEn).toBe("(Sample) Shop at the morning market, cook in the kitchen");
    expect(before.content.highlightsEn).toEqual(["(Sample) Choose seasonal vegetables at the market", "(Sample) Finish a dish with the vegetables you chose", null]);
    expect(before.content.knowBeforeYouGoEn).toEqual([null]);
    expect(before.content.timeline.map((step) => [step.titleEn, step.textEn])).toEqual([["(Sample) Shopping at the market", "(Sample) You choose the vegetables."], [null, null]]);

    const page = data(await api.getExperienceProviderPage(KITCHEN, DRAFT));
    data(await api.updateExperienceProviderPage(KITCHEN, DRAFT, { content: { lead: "（サンプル）直したひとこと", highlights: ["（サンプル）朝市で旬の野菜を選ぶ", "（サンプル）新しい見どころ"] } }, page.updatedAt));
    const after = data(await api.getExperienceProviderPagePreview(KITCHEN, DRAFT)).page;
    expect(after.content.leadEn).toBeNull();
    expect(after.content.highlightsEn).toEqual(["(Sample) Choose seasonal vegetables at the market", null]);
    expect(after.content.descriptionEn).toBe("(Sample) Walk the market, choose ingredients and cook together in the kitchen. Synthetic data.");

    const english = data(await api.getExperienceProviderPagePreview(KITCHEN, PUBLISHED)).page;
    expect(english.titleEn).toBeNull();
    expect(english.content.highlightsEn).toEqual([null, null]);
  });

  it("当日の流れは時刻・題・一言のどれも無い段を保存せず、写真から外した段と外観写真は null になる", async () => {
    const api = client("two-providers");
    const page = data(await api.getExperienceProviderPage(KITCHEN, PUBLISHED));
    const [first, second, third] = page.photos.map((photo) => photo.objectKey) as [string, string, string];
    const saved = data(await api.updateExperienceProviderPage(KITCHEN, PUBLISHED, {
      content: { timeline: [{ time: "10:00", title: "Welcome", text: "", photoObjectKey: first }, { time: "", title: " ", text: "", photoObjectKey: second }, null], meetingPoint: { entranceNote: "Gate", exteriorPhotoObjectKey: second } },
    }, page.updatedAt));
    expect(saved.content.timeline).toEqual([{ time: "10:00", title: "Welcome", text: "", photoObjectKey: first }]);
    expect(saved.content.meetingPoint).toEqual({ entranceNote: "Gate", exteriorPhotoObjectKey: second });

    const kept = data(await api.updateExperienceProviderPage(KITCHEN, PUBLISHED, { photoObjectKeys: [first, third] }, saved.updatedAt));
    expect(kept.content.meetingPoint).toEqual({ entranceNote: "Gate", exteriorPhotoObjectKey: null });
    expect(kept.content.timeline[0]!.photoObjectKey).toBe(first);
    const none = data(await api.updateExperienceProviderPage(KITCHEN, PUBLISHED, { photoObjectKeys: [third] }, kept.updatedAt));
    expect(none.content.timeline[0]!.photoObjectKey).toBeNull();

    const step = { time: "", title: "段", text: "", photoObjectKey: null };
    expect(await api.updateExperienceProviderPage(KITCHEN, PUBLISHED, { content: { timeline: Array.from({ length: 7 }, () => step) } }, null)).toMatchObject({ status: 400, reason: "PAGE_CONTENT_INVALID", field: "content.timeline" });
  });

  it("EDITOR は体験ページと写真を扱えるが、掲載は 404（理由なし）", async () => {
    const api = client("two-providers");
    const studio = "sample-provider-studio";
    expect(data(await api.listExperienceProviderPages(studio)).pages).toEqual([]);
    const page = data(await api.createExperienceProviderPage(studio, { kind: "EXPERIENCE", language: "EN", title: "Sample pottery" }));
    expect(data(await api.createExperienceProviderUploadPolicy(studio, { purpose: "ARTICLE_IMAGE", contentType: "image/png" })).objectKey).toMatch(/^sample-photos\/sample-studio\/upload-\d+\.png$/);
    for (const result of [
      await api.getExperienceProviderPageListing(studio, page.id),
      await api.requestExperienceProviderPageListing(studio, page.id, { consentVersion: MOCK_LISTING_CONSENT.version }),
      await api.withdrawExperienceProviderPageListing(studio, page.id),
    ]) {
      expect(result).toMatchObject({ ok: false, status: 404, code: "NOT_FOUND", reason: null });
    }
    // 所属していない提供者の体験ページは 404（理由なし）
    expect(await api.getExperienceProviderPage("someone-elses-provider", page.id)).toMatchObject({ status: 404, reason: null });
  });

  it("写真の保存が止まっていれば上げ口は 503（uploads_disabled）", async () => {
    const api = client("two-providers", "sample-id-token", { uploadsDisabled: true });
    const result = await api.createExperienceProviderUploadPolicy(KITCHEN, { purpose: "ARTICLE_IMAGE", contentType: "image/jpeg" });
    expect(result).toMatchObject({ ok: false, status: 503, code: "SERVICE_UNAVAILABLE", reason: "uploads_disabled" });
    expect(!result.ok && result.kind === "error" && result.supportId).toMatch(/^sample-support-\d+$/);
  });
});
