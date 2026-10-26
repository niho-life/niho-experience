import { expect, test, type Page, type Route } from "@playwright/test";

const content = (locale: string) => ({ lead: `${locale}の合成紹介`, facts: { language: "日本語・英語" }, highlights: ["合成の見どころ"], timeline: [], description: `${locale}の合成説明です。`, included: ["材料"], notIncluded: [], notSuitableFor: [], meetingPoint: { entranceNote: "合成の入口", exteriorPhotoObjectKey: null }, knowBeforeYouGo: [], hostUserIds: [] });
const proposal = {
  target: { mode: "NEW_PROVIDER", providerId: null }, provider: { kind: "BUSINESS", displayName: "合成ひとはこ商店", bio: "合成店舗", sellerDisclosureUrl: null }, pageSlugBase: "synthetic-workshop",
  pages: { ja: { title: "合成の手仕事体験", content: content("日本語") }, en: { title: "Synthetic craft workshop", content: content("English") } }, photos: [],
  offer: { nameJa: "合成の体験商品", nameEn: "Synthetic experience", shortDescriptionJa: null, shortDescriptionEn: null, priceYen: 5000, childPriceYen: null, childMinAge: null, childMaxAge: null, adultRequiredForChild: true, capacity: 4, maxPartySize: 4, minimumParticipants: 1, weekdays: [6], startTime: "10:00", durationMinutes: 90, cutoffDays: 2, closedDates: [], cancellationPolicy: "MODERATE", acceptanceMode: "REQUEST" },
  operatingRoles: [{ party: "PROVIDER", responsibilities: ["体験を実施する"] }, { party: "NIHO", responsibilities: ["掲載準備を支援する"] }],
  cohosts: [{ userId: "synthetic-cohost-1", displayName: "合成 サブホスト一郎" }, { userId: "synthetic-cohost-2", displayName: "合成 サブホスト二郎" }],
};
const consents = { preparation: { version: "v1", text: { content: "掲載内容", salesTerms: "販売条件", support: "支援", representative: "代表者" } }, provider: { required: true, version: "pv1", text: "提供者本人として掲載を許可します。" }, listing: { version: "lv1", text: "掲載許可" } };
const review = (revision = 1) => ({ caseId: "case_1", status: "REVIEW", revision, snapshotHash: String(revision).repeat(64), proposal: { ...proposal, pages: { ...proposal.pages, ja: { ...proposal.pages.ja, title: revision === 1 ? proposal.pages.ja.title : "更新された合成体験" } } }, consents, images: [], expiresAt: "2026-11-02T00:00:00.000Z" });
const acceptance = { id: "accept_1", acceptedBy: { userId: "user_1", displayName: "合成代表者" }, revision: 1, snapshotHash: "1".repeat(64), agreementVersion: "v1", providerConsentVersion: "pv1", listingConsentVersion: "lv1", acceptedAt: "2026-10-26T01:00:00.000Z", revokedAt: null };
const readiness = { representativeAcceptance: "ACCEPTED", representativeVerification: "WAITING", payment: "NOT_MATERIALIZED", providerReview: "NOT_MATERIALIZED", products: "NOT_MATERIALIZED", listing: "NOT_MATERIALIZED", support: { authorized: true, roles: proposal.operatingRoles }, blockers: [], nextAction: "事務局が代表者を確認します", waitingOn: "NIHO", providerId: null, editUrl: null, paymentUrl: null };
const adminCase = { id: "case_1", status: "ACCEPTED", revision: 1, snapshotHash: "1".repeat(64), proposal, contact: { name: "合成担当", email: "synthetic@example.test" }, currentAcceptance: acceptance, acceptanceHistory: [acceptance], representativeVerifiedAt: null, representativeVerifiedAcceptanceId: null, materialized: null, assignments: [], images: [], createdAt: "2026-10-26T00:00:00.000Z", updatedAt: "2026-10-26T01:00:00.000Z", pageSlugBase: "synthetic-workshop", supportScopes: ["DRAFT_EDITING", "TRANSLATION"] };

const json = (route: Route, value: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value), headers: { "cache-control": "private, no-store" } });

async function stubReview(page: Page) {
  let revision = 1;
  await page.route("**/host/api/preparations/review", async (route) => json(route, review(revision)));
  await page.route("**/host/api/preparations/review/correction", async (route) => { revision = 2; return json(route, { request: { id: "correction_1", createdAt: "2026-10-26T02:00:00.000Z" } }, 201); });
}

test("anonymous review removes fragment and keeps the reviewed draft after requesting a correction", async ({ page }) => {
  await stubReview(page);
  await page.goto("/host/preparations/review#ttttttttttttttttttttttttttttttttttttttttttt");
  await expect(page).toHaveURL(/\/host\/preparations\/review$/);
  await expect(page.getByRole("heading", { name: "掲載内容のご確認" })).toBeVisible();
  await expect(page.getByText("合成の手仕事体験")).toBeVisible();
  await page.getByLabel("直したい内容").fill("題名を更新してください");
  await page.getByRole("button", { name: "修正依頼を送る" }).click();
  await expect(page.getByText(/現在表示している原稿は、依頼時に確認した旧版/)).toBeVisible();
  await expect(page.getByText("合成の手仕事体験")).toBeVisible();
  await expect(page.getByText("更新された合成体験")).not.toBeVisible();
  await page.goto("/host/preparations/review#uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu");
  await expect(page.getByText("更新された合成体験")).toBeVisible();
  await expect(page.getByText("確認版 2")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: test.info().outputPath("review.png") });
});

test("host explicitly accepts five items then waits for NIHO verification", async ({ page }) => {
  await stubReview(page);
  let accepted = false;
  await page.route("**/host/api/preparations/case_1", async (route) => accepted ? json(route, { case: { id: "case_1", status: "ACCEPTED", revision: 1, snapshotHash: "1".repeat(64), proposal, access: "REPRESENTATIVE", currentAcceptance: { ...acceptance, acceptedByMe: true, acceptedBy: undefined }, representativeVerifiedAt: null, materialized: null, consents, images: [], updatedAt: "2026-10-26T01:00:00.000Z" } }) : json(route, { error: "not_found" }, 404));
  await page.route("**/host/api/preparations/case_1/accept", async (route) => { accepted = true; return json(route, { acceptance: { ...acceptance, acceptedByMe: true } }); });
  await page.route("**/host/api/preparations/case_1/readiness", async (route) => json(route, { readiness }));
  await page.goto("/host/auth/mock-login?preparationCaseId=case_1");
  await expect(page).toHaveURL(/\/host\/preparations\/case_1$/);
  const acceptanceSection = page.getByRole("heading", { name: "本人として受け入れる" }).locator("..");
  await expect(acceptanceSection.getByRole("checkbox")).toHaveCount(6);
  for (const checkbox of await acceptanceSection.getByRole("checkbox").all()) await checkbox.check();
  await page.getByRole("button", { name: "同意して受け入れる" }).click();
  await expect(page.getByRole("status")).toContainText("受入を記録しました。事務局が代表者を確認中です。");
  await expect(page.getByRole("heading", { name: "この版を受け入れ済みです" })).toBeVisible();
});

test("representative can accept a revised case after an older acceptance", async ({ page }) => {
  let acceptedRevision: number | null = null;
  const revised = review(2);
  await page.route("**/host/api/preparations/case_1", async (route) => json(route, { case: {
    id: "case_1", status: "REVIEW", revision: 2, snapshotHash: revised.snapshotHash, proposal: revised.proposal,
    access: "REPRESENTATIVE", currentAcceptance: { ...acceptance, acceptedByMe: true, acceptedBy: undefined },
    representativeVerifiedAt: null, materialized: null, consents, images: [], updatedAt: "2026-10-26T04:00:00.000Z",
  } }));
  await page.route("**/host/api/preparations/case_1/readiness", async (route) => json(route, { readiness }));
  await page.route("**/host/api/preparations/case_1/accept", async (route) => {
    acceptedRevision = route.request().postDataJSON().caseVersion;
    return json(route, { acceptance: { ...acceptance, revision: 2, snapshotHash: revised.snapshotHash } });
  });
  await page.goto("/host/auth/mock-login?preparationCaseId=case_1");
  await expect(page.getByText("更新された合成体験")).toBeVisible();
  const section = page.getByRole("heading", { name: "本人として受け入れる" }).locator("..");
  for (const checkbox of await section.getByRole("checkbox").all()) await checkbox.check();
  await section.getByRole("button", { name: "同意して受け入れる" }).click();
  await expect.poll(() => acceptedRevision).toBe(2);
});

test("Admin edits, issues a fragment link, verifies, materializes and refreshes readiness", async ({ page }) => {
  let current: Omit<typeof adminCase, "representativeVerifiedAt" | "currentAcceptance"> & { representativeVerifiedAt: string | null; currentAcceptance: typeof acceptance | null } = { ...structuredClone(adminCase), status: "REVIEW", currentAcceptance: null, acceptanceHistory: [] };
  await page.route("**/admin/api/preparations/case_1", async (route) => {
    if (route.request().method() === "PATCH") { const body = route.request().postDataJSON(); current = { ...current, revision: current.revision + 1, proposal: { ...current.proposal!, pages: body.draft.pages }, snapshotHash: "2".repeat(64) }; return json(route, { case: current }); }
    return json(route, { case: current, correctionRequests: [], audits: [{ id: "audit_1", actorUserId: null, action: "CREATED", revision: 1, targetId: null, createdAt: "2026-10-26T00:00:00.000Z" }], readiness });
  });
  await page.route("**/admin/api/preparations/case_1/preview-token", async (route) => { current = { ...current, status: "ACCEPTED", currentAcceptance: acceptance, acceptanceHistory: [acceptance] }; return json(route, { token: "t".repeat(43), expiresAt: "2026-11-02T00:00:00.000Z", revision: current.revision }, 201); });
  await page.route("**/admin/api/preparations/case_1/verify-representative", async (route) => { current.representativeVerifiedAt = "2026-10-26T03:00:00.000Z"; return json(route, { case: current }); });
  await page.route("**/admin/api/preparations/case_1/materialize", async (route) => json(route, { materialized: { providerId: "provider_1", pageJaId: "ja_1", pageEnId: "en_1", created: true } }));
  await page.goto("/admin");
  await page.getByRole("button", { name: "合成Adminとして開く" }).click();
  await page.goto("/admin/preparations/case_1");
  await expect(page.getByRole("heading", { name: "合成ひとはこ商店", level: 1 })).toBeVisible();
  await page.getByRole("button", { name: "限定リンクを発行" }).click();
  await expect(page.getByText(/#tttttt/)).toBeVisible();
  await page.getByRole("button", { name: "最新状態を確認" }).click();
  await expect(page.getByRole("button", { name: "限定リンクを発行" })).toBeDisabled();
  await page.getByRole("button", { name: "代表者を確認" }).click();
  await page.getByRole("button", { name: "正式な店舗・商品へ反映" }).click();
  await expect(page.getByRole("status")).toContainText("店舗・商品に承認済みの内容を反映しました。");
});

test("expired or revoked review and forbidden host case fail closed", async ({ page }) => {
  await page.route("**/host/api/preparations/review", async (route) => json(route, { error: "not_found" }, 404));
  await page.goto("/host/preparations/review#ttttttttttttttttttttttttttttttttttttttttttt");
  await expect(page.getByText(/期限切れ、撤回済み、または原稿更新/)).toBeVisible();
  await page.unroute("**/host/api/preparations/review");
  await page.route("**/host/api/preparations/review", async (route) => json(route, review()));
  await page.route("**/host/api/preparations/case_1", async (route) => json(route, { error: "forbidden" }, 403));
  await page.goto("/host/auth/mock-login?preparationCaseId=case_1");
  await expect(page.getByText("この案件を管理する権限がありません。")).toBeVisible();
});


test("authorized owner uses ordinary operations after the anonymous preview token expires", async ({ page }) => {
  let anonymousRequests = 0;
  await page.route("**/host/api/preparations/review", async (route) => { anonymousRequests += 1; return json(route, { error: "not_found" }, 404); });
  await page.route("**/host/api/preparations/case_1", async (route) => json(route, { case: {
    id: "case_1", status: "MATERIALIZED", revision: 1, snapshotHash: "1".repeat(64), proposal, access: "REPRESENTATIVE",
    currentAcceptance: { ...acceptance, acceptedByMe: true, acceptedBy: undefined }, representativeVerifiedAt: "2026-10-26T02:00:00.000Z",
    materialized: { providerId: "provider_1", pageJaId: "ja_1", pageEnId: "en_1", at: "2026-10-26T03:00:00.000Z" }, consents, images: [], updatedAt: "2026-10-26T03:00:00.000Z",
  } }));
  await page.route("**/host/api/preparations/case_1/readiness", async (route) => json(route, { readiness: {
    ...readiness, representativeVerification: "VERIFIED", payment: "NOT_CONNECTED", providerId: "provider_1",
    nextAction: "売上受取を設定する", paymentUrl: "/experiences/provider?providerId=provider_1&tab=payments",
  } }));
  await page.goto("/host/auth/mock-login?preparationCaseId=case_1");
  await expect(page.getByRole("heading", { name: "通常の運営画面" })).toBeVisible();
  await expect(page.getByText("合成 サブホスト一郎")).toBeVisible();
  await expect(page.getByRole("link", { name: "体験を管理" })).toHaveAttribute("href", "/host/experiences?providerId=provider_1");
  await expect(page.getByRole("link", { name: "予約を管理" })).toHaveAttribute("href", "/host/bookings?providerId=provider_1");
  await expect(page.getByRole("link", { name: "オーナーが売上受取を設定" })).toBeVisible();
  await expect(page.getByRole("button", { name: "同意して受け入れる" })).toHaveCount(0);
  expect(anonymousRequests).toBe(0);
});


test("cohost sees immutable roster and ordinary operations without representative or payment actions", async ({ page }) => {
  await page.route("**/host/api/preparations/case_1", async (route) => json(route, { case: {
    id: "case_1", status: "MATERIALIZED", revision: 1, snapshotHash: "1".repeat(64), proposal, access: "COHOST",
    currentAcceptance: null, representativeVerifiedAt: "2026-10-26T02:00:00.000Z",
    materialized: { providerId: "provider_1", pageJaId: "ja_1", pageEnId: "en_1", at: "2026-10-26T03:00:00.000Z" }, consents, images: [], updatedAt: "2026-10-26T03:00:00.000Z",
  } }));
  await page.route("**/host/api/preparations/case_1/readiness", async (route) => json(route, { readiness: {
    ...readiness, representativeVerification: "VERIFIED", payment: "NOT_CONNECTED", providerId: "provider_1",
    nextAction: "店舗本人の売上受取設定を待っています", editUrl: "/experiences/provider?providerId=provider_1",
    paymentUrl: "/experiences/provider?providerId=provider_1&tab=payments",
  } }));
  await page.goto("/host/auth/mock-login?preparationCaseId=case_1");
  await expect(page.getByRole("heading", { name: "通常の運営画面" })).toBeVisible();
  await expect(page.getByText("初回の承認内容とサブホスト名簿を証跡として表示しています")).toBeVisible();
  await expect(page.getByRole("link", { name: "体験を管理" })).toBeVisible();
  await expect(page.getByRole("link", { name: "予約を管理" })).toBeVisible();
  await expect(page.getByRole("button", { name: "同意して受け入れる" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: /売上受取/ })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "NIHOで商品を確認" })).toHaveCount(0);
});
