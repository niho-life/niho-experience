import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";

const PROVIDER = "sample-provider-kitchen";
const PAGE = "synthetic-page-1";
const now = "2026-10-27T01:00:00.000Z";
const later = "2026-10-27T02:00:00.000Z";
const finalVersion = "2026-10-27T03:00:00.000Z";

const content = {
  lead: "合成の短い紹介", facts: { language: "日本語" }, highlights: ["合成の見どころ"],
  timeline: [{ time: "10:00", title: "集合", text: "合成の案内", photoObjectKey: null }],
  description: "実データではない合成の体験です。", included: ["合成の材料"], notIncluded: [], notSuitableFor: [],
  meetingPoint: { entranceNote: "合成の入口", exteriorPhotoObjectKey: null }, knowBeforeYouGo: ["歩きやすい服装"], hostUserIds: [],
};
const offer = (id: string, name: string, time: string) => ({
  id, name, shortDescription: `${name}の合成説明`, sortOrder: id.endsWith("2") ? 1 : 0, isActive: true,
  priceYen: 5000, childPriceYen: 2500, childMinAge: 6, childMaxAge: 12, adultRequiredForChild: true,
  capacity: 6, maxPartySize: 4, minimumParticipants: 1, weekdays: [2, 6], startTime: time,
  durationMinutes: 90, cutoffDays: 2, closedDates: [], cancellationPolicy: "FREE_UNTIL_24H", acceptanceMode: "APPROVAL",
  spaceScope: "ENTIRE_FACILITY", useZone: [], bookingQuestions: [],
});
const pageDetail = {
  id: PAGE, kind: "EXPERIENCE", slug: "synthetic-workshop", language: "JA", title: "合成の手仕事体験", status: "DRAFT",
  listOnEntrance: false, publishedAt: null, unpublishedAt: null, content, photos: [], coverObjectKey: null,
  offer: offer("offer-1", "午前の合成商品", "10:00"), offers: [offer("offer-1", "午前の合成商品", "10:00"), offer("offer-2", "午後の合成商品", "14:00")],
  publishBlockers: [], publicPath: "/living/synthetic/pages/synthetic-workshop", createdAt: now, updatedAt: now, photoAlts: [],
};
const listPage = (detail = pageDetail) => ({ checkoutEnabled: true, pages: [{
  id: detail.id, kind: detail.kind, slug: detail.slug, language: detail.language, title: detail.title, coverUrl: null,
  status: detail.status, listOnEntrance: detail.listOnEntrance, bookingCounts: { confirmed: 0, thisWeek: 0 }, updatedAt: detail.updatedAt,
}] });

const bookingListItem = (id: string, title: string, status: "PENDING" | "PROVISIONAL" = "PROVISIONAL") => ({
  id, occurrenceDate: "2026-11-08", startAt: "2026-11-08T01:00:00.000Z",
  headCount: 2, offerName: "午前の合成商品", totalYen: 10000,
  guestName: `合成予約者 ${id}`, pageTitle: title, status, salesChannel: "EXPERIENCE_SITE",
});
const bookingDetail = (item: ReturnType<typeof bookingListItem>, status: string, messages: unknown[] = [], guestMessages: unknown[] = []) => ({
  booking: {
    id: item.id, pageId: PAGE, pageTitle: item.pageTitle, offerName: item.offerName, occurrenceDate: item.occurrenceDate, startAt: item.startAt, endAt: "2026-11-08T02:30:00.000Z",
    adultCount: item.headCount, childCount: 0, guestName: item.guestName,
    languageSnapshot: "EN", note: "アレルギーはありません（合成）", answers: null, status,
    totalYen: item.totalYen,
    salesChannel: "EXPERIENCE_SITE", hostMessages: messages, guestMessages,
  },
});

const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body), headers: { "cache-control": "private, no-store", "referrer-policy": "no-referrer" } });
const noOverflow = async (page: Page) => { expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true); await page.screenshot({ path: test.info().outputPath("screen.png"), scale: "css" }); };
const backToLiveList = async (page: Page, label: "予約一覧" | "会話一覧") => {
  const back = page.getByRole("button", { name: `‹ ${label}` });
  if (await back.isVisible()) await back.click();
};

test("owner adds two exact-email cohosts and removes one from the current backend roster", async ({ page }) => {
  const members = [{ userId: "sample-user", displayName: "サンプル ホスト", role: "OWNER" }];
  const candidates = new Map([
    ["cohost-one@example.test", { userId: "cohost-1", displayName: "合成 サブホスト一郎" }],
    ["cohost-two@example.test", { userId: "cohost-2", displayName: "合成 サブホスト二郎" }],
  ]);
  let releaseFirstLookup!: () => void;
  const firstLookupGate = new Promise<void>((resolve) => { releaseFirstLookup = resolve; });
  let finishFirstLookup!: () => void;
  const firstLookupFinished = new Promise<void>((resolve) => { finishFirstLookup = resolve; });
  let delayFirstLookup = true;
  await page.route(`**/host/api/provider-operations/${PROVIDER}/members**`, async (route) => {
    const request = route.request(); const path = new URL(request.url()).pathname; const method = request.method();
    if (path.endsWith("/members") && method === "GET") return json(route, { members });
    if (path.endsWith("/members/resolve") && method === "POST") {
      const email = request.postDataJSON().email;
      if (email === "cohost-one@example.test" && delayFirstLookup) { delayFirstLookup = false; await firstLookupGate; }
      const candidate = candidates.get(email);
      await (candidate ? json(route, { candidate }) : json(route, { error: "not_found" }, 404));
      if (email === "cohost-one@example.test") finishFirstLookup();
      return;
    }
    const userId = path.split("/").at(-1)!;
    if (method === "PUT") { const candidate = [...candidates.values()].find((item) => item.userId === userId)!; members.push({ ...candidate, role: "COHOST" }); return json(route, { member: members.at(-1) }); }
    if (method === "DELETE") { const at = members.findIndex((item) => item.userId === userId); if (at >= 0) members.splice(at, 1); return route.fulfill({ status: 204 }); }
    return json(route, { error: "not_found" }, 404);
  });
  await page.goto("/host/auth/mock-login");
  await page.goto(`/host/settings?providerId=${PROVIDER}`);
  await page.getByLabel("登録済みNIHOアカウントのメールアドレス").fill("cohost-one@example.test");
  await page.getByRole("button", { name: "アカウントを確認" }).click();
  await page.getByLabel("登録済みNIHOアカウントのメールアドレス").fill("cohost-two@example.test");
  await page.getByRole("button", { name: "アカウントを確認" }).click();
  await expect(page.getByText("合成 サブホスト二郎")).toBeVisible();
  releaseFirstLookup();
  await firstLookupFinished;
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.getByText("合成 サブホスト一郎")).toHaveCount(0);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "範囲を確認してサブホストにする" }).click();
  await expect(page.getByRole("status").filter({ hasText: "追加しました" })).toBeVisible();

  for (const email of ["cohost-one@example.test"]) {
    await page.getByLabel("登録済みNIHOアカウントのメールアドレス").fill(email);
    await page.getByRole("button", { name: "アカウントを確認" }).click();
    await expect(page.getByText(candidates.get(email)!.displayName)).toBeVisible();
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "範囲を確認してサブホストにする" }).click();
    await expect(page.getByRole("status").filter({ hasText: "追加しました" })).toBeVisible();
  }
  await expect(page.getByText("合成 サブホスト一郎")).toBeVisible();
  await expect(page.getByText("合成 サブホスト二郎")).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("listitem").filter({ hasText: "合成 サブホスト一郎" }).getByRole("button", { name: "外す" }).click();
  await expect(page.getByText("合成 サブホスト一郎")).toHaveCount(0);
  await expect(page.getByText("合成 サブホスト二郎")).toBeVisible();
  await noOverflow(page);
});

test("cohost preserves edits across a version conflict and persists content and two offer schedules", async ({ page }) => {
  let serverPage = structuredClone(pageDetail); let patchCalls = 0; let listingCalls = 0;
  await page.route(`**/host/api/provider-pages/${PROVIDER}**`, async (route) => {
    const request = route.request(); const path = new URL(request.url()).pathname;
    if (path.endsWith("/listing")) listingCalls += 1;
    if (path.endsWith(`/${PROVIDER}`) && request.method() === "GET") return json(route, listPage(serverPage));
    if (path.endsWith(`/${PAGE}`) && request.method() === "GET") return json(route, serverPage);
    if (path.endsWith(`/${PAGE}`) && request.method() === "PATCH") {
      patchCalls += 1; const requestBody = request.postDataJSON();
      if (patchCalls === 1) { serverPage = { ...serverPage, title: "別端末で保存された合成題名", updatedAt: later }; return json(route, { error: "conflict" }, 409); }
      expect(requestBody.expectedUpdatedAt).toBe(later);
      expect(requestBody.patch.offers.map((item: { id: string }) => item.id)).toEqual(["offer-1", "offer-2"]);
      expect(requestBody.patch.offers[0].closedDates).toEqual(["2026-11-10", "2026-11-17"]);
      expect(requestBody.patch).not.toHaveProperty("content");
      serverPage = { ...serverPage, ...requestBody.patch, photos: serverPage.photos, coverObjectKey: null, offer: requestBody.patch.offers[0], updatedAt: finalVersion };
      return json(route, serverPage);
    }
    return json(route, { error: "not_found" }, 404);
  });
  await page.goto("/host/auth/mock-login?mock=cohost");
  await page.goto(`/host/experiences/${PAGE}?providerId=${PROVIDER}`);
  await page.getByLabel("題名").fill("サブホストが編集中の合成題名");
  await page.getByLabel("定員").first().fill("8");
  await page.getByLabel("休みの日").first().fill("2026-11-10\n2026-11-17");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "入力は保持しています" })).toBeVisible();
  await expect(page.getByLabel("題名")).toHaveValue("サブホストが編集中の合成題名");
  await expect(page.getByLabel("定員").first()).toHaveValue("8");
  await page.getByRole("button", { name: "最新の保存内容を読む" }).click();
  await expect(page.getByText("同じ項目が変更されています")).toBeVisible();
  await expect(page.getByLabel("題名")).toHaveValue("サブホストが編集中の合成題名");
  await page.getByRole("button", { name: "競合項目は自分の入力を残す" }).click();
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "保存しました" })).toBeVisible();
  // 掲載 is the owner's: a cohost neither sees it nor asks NIHO for it, and keeps 公開する.
  await expect(page.getByRole("region", { name: "掲載", exact: true })).toHaveCount(0);
  await expect(page.getByText("体験サイトへの掲載の申請はオーナーが行います。")).toBeVisible();
  await expect(page.getByRole("button", { name: "公開する" })).toBeVisible();
  // NIHO answers the meeting point to the owner and editors: the rest of the editor stays usable.
  await expect(page.getByRole("region", { name: "集合場所" })).toContainText("集合場所を読めませんでした。");
  expect(listingCalls).toBe(0);
  await noOverflow(page);
});

test("owner cannot settle a conflict until the meeting point is read again with the page", async ({ page }) => {
  const defaults = { overview: "（合成）駅から歩いて 10 分", address: "（合成）サンプル町 1 丁目", accessNote: "（合成）東口から川沿いに歩きます。", mapUrl: "https://maps.example.test/synthetic", entranceNote: "（合成）木の門の呼び鈴" };
  let serverPage = { ...structuredClone(pageDetail), language: "EN", updatedAt: now };
  let patchCalls = 0; let meetingReads = 0;
  await page.route(`**/host/api/provider-pages/${PROVIDER}**`, async (route) => {
    const request = route.request(); const path = new URL(request.url()).pathname; const method = request.method();
    if (path.endsWith(`/${PAGE}`) && method === "GET") return json(route, serverPage);
    if (path.endsWith(`/${PAGE}`) && method === "PATCH") {
      patchCalls += 1;
      if (patchCalls === 1) { serverPage = { ...serverPage, title: "別端末で保存された合成題名", updatedAt: later }; return json(route, { error: "conflict" }, 409); }
      return json(route, { error: "not_expected" }, 500);
    }
    if (path.endsWith("/meeting-point") && method === "GET") {
      meetingReads += 1;
      // The first check after the 409 reads the page but not the meeting point.
      if (meetingReads === 2) return json(route, { error: "unavailable" }, 503);
      return json(route, { mode: "INHERIT", meetingPoint: defaults });
    }
    if (path.endsWith("/listing") && method === "GET") return json(route, { listing: null, consent: { version: "synthetic-listing-consent-2", text: "（合成）同意の文言" } });
    return json(route, { error: "not_found" }, 404);
  });
  await page.goto("/host/auth/mock-login");
  await page.goto(`/host/experiences/${PAGE}?providerId=${PROVIDER}`);
  await expect(page.getByRole("region", { name: "集合場所" })).toContainText(defaults.address);
  await page.getByLabel("題名").fill("オーナーが編集中の合成題名");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "入力は保持しています" })).toBeVisible();

  await page.getByRole("button", { name: "最新の保存内容を読む" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "集合場所の最新の保存内容を読めませんでした" })).toBeVisible();
  await expect(page.getByText("最新の保存内容と照合")).toHaveCount(0);
  await expect(page.getByLabel("題名")).toHaveValue("オーナーが編集中の合成題名");

  await page.getByRole("button", { name: "最新の保存内容を読む" }).click();
  await expect(page.getByText("同じ項目が変更されています")).toBeVisible();
  expect(meetingReads).toBe(3);
  expect(patchCalls).toBe(1);
});

test("owner saves a page-only meeting point, applies for the listing, withdraws it and is asked before a save pauses it", async ({ page }) => {
  const version = (hour: number) => `2026-10-27T${String(hour).padStart(2, "0")}:00:00.000Z`;
  const defaults = { overview: "（合成）駅から歩いて 10 分", address: "（合成）サンプル町 1 丁目", accessNote: "（合成）東口から川沿いに歩きます。", mapUrl: "https://maps.example.test/synthetic", entranceNote: "（合成）木の門の呼び鈴" };
  const consent = { version: "synthetic-listing-consent-2", text: "（合成）体験サイトへの掲載と、NIHO の確認に同意します。" };
  let serverPage = { ...structuredClone(pageDetail), language: "EN", updatedAt: version(1) };
  let serverMeeting: { mode: "INHERIT" | "OVERRIDE"; meetingPoint: typeof defaults } = { mode: "INHERIT", meetingPoint: defaults };
  let listing: Record<string, unknown> | null = null;
  const calls: string[] = []; const sent: Record<string, unknown>[] = [];
  const listingOf = (status: string, slug: string | null = null) => ({
    id: "synthetic-listing", spotId: "synthetic-spot", campaignPageId: PAGE, status, slug, regionKey: null, consentVersion: consent.version,
    consentedAt: version(1), approvedAt: null, pausedAt: null, withdrawnAt: null, createdAt: version(1), updatedAt: version(1),
  });
  const pause = () => { if (listing?.status === "ACTIVE") listing = { ...listing, status: "PAUSED" }; };
  await page.route(`**/host/api/provider-pages/${PROVIDER}**`, async (route) => {
    const request = route.request(); const path = new URL(request.url()).pathname; const method = request.method();
    if (method !== "GET") { calls.push(`${method} ${path.split("/").at(-1)}`); sent.push(request.postDataJSON() ?? {}); }
    if (path.endsWith(`/${PAGE}`) && method === "GET") return json(route, serverPage);
    if (path.endsWith(`/${PAGE}`) && method === "PATCH") {
      const body = request.postDataJSON();
      expect(body.expectedUpdatedAt).toBe(serverPage.updatedAt);
      serverPage = { ...serverPage, ...body.patch, updatedAt: version(5) }; pause();
      return json(route, serverPage);
    }
    if (path.endsWith("/meeting-point") && method === "GET") return json(route, serverMeeting);
    if (path.endsWith("/meeting-point") && method === "PUT") {
      const body = request.postDataJSON();
      if (body.expectedUpdatedAt !== serverPage.updatedAt) return json(route, { error: "PROVIDER_PAGE_CONFLICT" }, 409);
      serverMeeting = body.mode === "OVERRIDE" ? { mode: "OVERRIDE", meetingPoint: body.meetingPoint } : { mode: "INHERIT", meetingPoint: defaults };
      serverPage = { ...serverPage, updatedAt: version(2) }; pause();
      return json(route, { mode: body.mode, updatedAt: serverPage.updatedAt, ...(body.mode === "OVERRIDE" ? { meetingPoint: body.meetingPoint } : {}) });
    }
    if (path.endsWith("/publish") && method === "POST") {
      if (request.postDataJSON().expectedUpdatedAt !== serverPage.updatedAt) return json(route, { error: "PAGE_UPDATED" }, 409);
      serverPage = { ...serverPage, status: "PUBLISHED", updatedAt: version(3) };
      return json(route, serverPage);
    }
    if (path.endsWith("/listing") && method === "GET") return json(route, { listing, consent });
    if (path.endsWith("/listing") && method === "PUT") { listing = listingOf("REQUESTED"); return json(route, { listing, consent }); }
    if (path.endsWith("/listing") && method === "DELETE") { listing = { ...listing!, status: "WITHDRAWN" }; return json(route, { listing, consent }); }
    return json(route, { error: "not_found" }, 404);
  });
  await page.goto("/host/auth/mock-login");
  await page.goto(`/host/experiences/${PAGE}?providerId=${PROVIDER}`);
  const listingPanel = page.getByRole("region", { name: "掲載", exact: true });
  await expect(listingPanel).toContainText("未申請");
  await expect(listingPanel).toContainText(consent.text);
  await expect(page.getByRole("button", { name: "公開する" })).toHaveCount(0);

  // Only the meeting point changed: no PATCH, and the PUT carries the page's own version.
  const meeting = page.getByRole("region", { name: "集合場所" });
  await expect(meeting).toContainText(defaults.address);
  await meeting.getByRole("radio", { name: "この体験だけ別の場所にする" }).check();
  await expect(page.getByLabel("公開する大まかな場所")).toHaveValue(defaults.overview);
  await page.getByLabel("住所").fill("（合成）この体験だけの集合場所");
  await expect(listingPanel.getByRole("button", { name: "同意して掲載を申請" })).toBeDisabled();
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "保存しました" })).toBeVisible();
  expect(calls).toEqual(["PUT meeting-point"]);
  expect(sent[0]).toEqual({ mode: "OVERRIDE", meetingPoint: { ...defaults, address: "（合成）この体験だけの集合場所" }, expectedUpdatedAt: version(1) });
  await expect(page.getByLabel("住所")).toHaveValue("（合成）この体験だけの集合場所");

  // 申請 publishes the saved page with the version the meeting point moved it to, then sends NIHO's consent version.
  await listingPanel.getByRole("button", { name: "同意して掲載を申請" }).click();
  await expect(listingPanel).toContainText("審査待ち");
  await expect(listingPanel).toContainText("NIHO が確認しています。");
  expect(calls.slice(1)).toEqual(["POST publish", "PUT listing"]);
  expect(sent.slice(1)).toEqual([{ expectedUpdatedAt: version(2) }, { consentVersion: consent.version }]);

  await listingPanel.getByRole("button", { name: "申請を取り下げる" }).click();
  const withdrawDialog = page.getByRole("dialog");
  await expect(withdrawDialog).toContainText("もう一度載せるには、申請と NIHO の確認が必要です。");
  await withdrawDialog.getByRole("button", { name: "申請を取り下げる" }).click();
  await expect(listingPanel).toContainText("未申請");
  expect(calls.at(-1)).toBe("DELETE listing");

  // NIHO approved it: a save would pause it, so the owner is asked first.
  listing = listingOf("ACTIVE", "synthetic-workshop");
  await page.reload();
  await expect(listingPanel).toContainText("掲載中");
  await expect(listingPanel.getByRole("link", { name: "体験サイトで見る" })).toHaveAttribute("href", /\/experiences\/synthetic-workshop$/);
  await listingPanel.getByRole("button", { name: "掲載を止める" }).click();
  await expect(page.getByRole("dialog")).toContainText("受け付けた予約は残ります。");
  await page.getByRole("dialog").getByRole("button", { name: "やめる" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByLabel("題名").fill("オーナーが直した合成題名");
  await expect(listingPanel.getByRole("button", { name: "掲載を止める" })).toBeDisabled();
  const before = calls.length;
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("体験サイトから一時的に外れ、NIHO が確認すると掲載に戻ります。");
  expect(calls.length).toBe(before);
  await page.getByRole("dialog").getByRole("button", { name: "保存して掲載を止める" }).click();
  await expect(page.getByRole("status").filter({ hasText: "保存しました" })).toBeVisible();
  expect(calls.slice(before)).toEqual(["PATCH " + PAGE]);
  await expect(listingPanel).toContainText("停止中");
  await expect(listingPanel).toContainText("内容を変えたため掲載を止めています。");
  await noOverflow(page);
});

test("cohost approves, declines and replies only after authoritative booking re-reads", async ({ page }) => {
  const first = bookingListItem("booking-1", "合成の手仕事体験");
  const second = bookingListItem("booking-2", "午後の合成体験");
  const pending = bookingListItem("booking-pending", "支払い確認中の合成体験", "PENDING");
  const allBookings = [first, second, pending];
  const statuses = new Map<string, string>(allBookings.map((item) => [item.id, item.status]));
  const messages = new Map<string, unknown[]>(allBookings.map((item) => [item.id, []]));
  const guestMessages = new Map<string, unknown[]>(allBookings.map((item) => [item.id, item.id === first.id ? [{ id: "guest-message-1", body: "Thank you. We will be there.", createdAt: now }] : []]));
  let revoked = false; let approveAttempts = 0; let failDetailAfterMessage = false;
  await page.route(`**/host/api/provider-operations/${PROVIDER}/bookings**`, async (route) => {
    if (revoked) return json(route, { error: "permission_ended" }, 404);
    const request = route.request(); const path = new URL(request.url()).pathname; const parts = path.split("/"); const bookingId = parts.at(-1)!;
    if (path.endsWith("/bookings") && request.method() === "GET") return json(route, { bookings: allBookings.map((item) => ({ ...item, status: statuses.get(item.id) })), nextCursor: null });
    if (request.method() === "GET") {
      if (failDetailAfterMessage) { failDetailAfterMessage = false; return json(route, { error: "upstream_unavailable" }, 502); }
      const item = allBookings.find((candidate) => candidate.id === bookingId)!;
      return json(route, bookingDetail(item, statuses.get(item.id)!, messages.get(item.id), guestMessages.get(item.id)));
    }
    const action = bookingId; const id = parts.at(-2)!; const item = allBookings.find((candidate) => candidate.id === id)!;
    if (action === "approve") { approveAttempts += 1; if (approveAttempts === 1) return route.abort("failed"); statuses.set(id, "CONFIRMED"); return json(route, { status: "CONFIRMED" }); }
    if (action === "decline") { statuses.set(id, "DECLINED"); return json(route, { status: "DECLINED" }); }
    if (action === "message") { const sent = { id: "message-1", subject: request.postDataJSON().subject, body: request.postDataJSON().body, createdAt: later, sentAt: null, failed: false, deliveryStatus: "QUEUED" }; messages.get(id)!.push(sent); failDetailAfterMessage = true; return json(route, { message: { id: sent.id } }, 201); }
    return json(route, bookingDetail(item, statuses.get(id)!, messages.get(id), guestMessages.get(id)));
  });
  await page.goto("/host/auth/mock-login?mock=cohost");
  await page.goto(`/host/bookings?providerId=${PROVIDER}`);
  await page.getByRole("button", { name: /合成の手仕事体験/ }).click();
  await expect(page.getByText("Thank you. We will be there.")).toBeVisible();
  await expect(page.getByText("予約者（Web）・原文")).toBeVisible();
  await expect(page.getByText(/@example\.test/)).toHaveCount(0);
  await page.getByRole("button", { name: "承認する" }).click();
  const approvalDialog = page.getByRole("dialog");
  await expect(approvalDialog.getByText("カードに請求し、決済できたら予約が確定します。")).toBeVisible();
  await expect(approvalDialog.getByText("合成予約者 booking-1")).toBeVisible();
  await expect(approvalDialog.getByText("¥10,000")).toBeVisible();
  await page.getByRole("button", { name: "決済して承認" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "再送していません" })).toBeVisible();
  await expect(page.getByRole("button", { name: "承認する" })).toBeDisabled();
  const backToBookings = page.getByRole("button", { name: "‹ 予約一覧" });
  if ((page.viewportSize()?.width ?? 0) < 1024) await expect(backToBookings).toBeDisabled();
  await page.getByRole("button", { name: "最新状態を確認" }).click();
  await expect(page.getByRole("status").filter({ hasText: "まだ承認待ちです" })).toBeVisible();
  await page.getByRole("button", { name: "確認結果を了承する" }).click();
  await page.getByRole("button", { name: "承認する" }).click();
  await page.getByRole("button", { name: "決済して承認" }).click();
  await expect(page.getByRole("status").filter({ hasText: "予約を承認しました" })).toBeVisible();
  await backToLiveList(page, "予約一覧");
  await page.getByRole("button", { name: /支払い確認中の合成体験/ }).click();
  await expect(page.getByRole("button", { name: "承認する" })).toHaveCount(0);
  await backToLiveList(page, "予約一覧");
  await page.getByRole("button", { name: /午後の合成体験/ }).click();
  await page.getByRole("button", { name: "お断りする" }).click();
  await page.getByRole("button", { name: "申込を断る" }).click();
  await expect(page.getByRole("status").filter({ hasText: "予約をお断りしました" })).toBeVisible();
  await page.getByLabel("件名").fill("  合成の開催案内  ");
  await page.getByLabel("本文").fill("  集合時刻をご確認ください（合成）。\n");
  await page.getByRole("button", { name: "送信内容を確認" }).click();
  const messageDialog = page.getByRole("dialog");
  await expect(messageDialog).toContainText("合成の開催案内");
  await expect(messageDialog).toContainText("集合時刻をご確認ください（合成）。");
  await page.getByRole("button", { name: "この内容で送る" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "履歴を確認するまで次の送信はできません" })).toBeVisible();
  await expect(page.getByLabel("件名")).toHaveValue("  合成の開催案内  ");
  await expect(page.getByRole("button", { name: "送信内容を確認" })).toBeDisabled();
  if ((page.viewportSize()?.width ?? 0) < 1024) await expect(backToBookings).toBeDisabled();
  await page.getByRole("button", { name: "最新状態を確認" }).click();
  await expect(page.getByText("合成の開催案内")).toBeVisible();
  await expect(page.getByText(/配信待ち/)).toBeVisible();
  await page.getByRole("button", { name: "確認結果を了承する" }).click();
  await expect(page.getByLabel("件名")).toHaveValue("");
  await expect(page.getByLabel("本文")).toHaveValue("");
  await page.getByRole("region", { name: "予約の詳細" }).evaluate((element) => element.scrollIntoView({ block: "start" }));
  await page.screenshot({ path: test.info().outputPath("booking-reply.png"), scale: "css" });
  revoked = true; await page.reload();
  await expect(page.getByRole("alert").filter({ hasText: "権限がありません" })).toBeVisible();
  await noOverflow(page);
});

test("a late booking response cannot replace the selected recipient and reply drafts stay with their booking", async ({ page }) => {
  const slow = bookingListItem("booking-slow", "遅い合成予約");
  const fast = bookingListItem("booking-fast", "選択中の合成予約");
  let releaseSlow!: () => void;
  let markSlowStarted!: () => void;
  let markSlowFinished!: () => void;
  const slowStarted = new Promise<void>((resolve) => { markSlowStarted = resolve; });
  const slowFinished = new Promise<void>((resolve) => { markSlowFinished = resolve; });
  const slowGate = new Promise<void>((resolve) => { releaseSlow = resolve; });
  await page.route(`**/host/api/provider-operations/${PROVIDER}/bookings**`, async (route) => {
    const request = route.request(); const path = new URL(request.url()).pathname;
    if (path.endsWith("/bookings")) return json(route, { bookings: [slow, fast], nextCursor: null });
    const item = path.endsWith(slow.id) ? slow : fast;
    if (item.id === slow.id) {
      markSlowStarted();
      await slowGate;
      try { await json(route, bookingDetail(item, "PROVISIONAL")); } finally { markSlowFinished(); }
      return;
    }
    return json(route, bookingDetail(item, "PROVISIONAL"));
  });
  await page.goto("/host/auth/mock-login?mock=cohost");
  await page.goto(`/host/messages?providerId=${PROVIDER}`);
  await page.getByRole("button", { name: /遅い合成予約/ }).click();
  await slowStarted;
  await backToLiveList(page, "会話一覧");
  await page.getByRole("button", { name: /選択中の合成予約/ }).click();
  const detailRegion = page.getByRole("region", { name: "予約者との会話" });
  await expect(detailRegion.getByText("合成予約者 booking-fast")).toBeVisible();
  releaseSlow();
  await slowFinished;
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(detailRegion.getByText("合成予約者 booking-fast")).toBeVisible();
  await expect(detailRegion.getByText("合成予約者 booking-slow")).toHaveCount(0);
  await page.getByLabel("件名").fill("fastだけの下書き");
  await page.getByLabel("本文").fill("別の予約には表示しない合成本文");
  await backToLiveList(page, "会話一覧");
  await page.getByRole("button", { name: /遅い合成予約/ }).click();
  await expect(page.getByLabel("件名")).toHaveValue("");
  await backToLiveList(page, "会話一覧");
  await page.getByRole("button", { name: /選択中の合成予約/ }).click();
  await expect(page.getByLabel("件名")).toHaveValue("fastだけの下書き");
  await noOverflow(page);
});

test("cohost has operational navigation but no sales, Stripe or member controls", async ({ page }) => {
  await page.goto("/host/auth/mock-login?mock=cohost");
  await page.goto(`/host/settings?providerId=${PROVIDER}`);
  await expect(page.getByText("あなたはサブホストです")).toBeVisible();
  await expect(page.getByLabel("登録済みNIHOアカウントのメールアドレス")).toHaveCount(0);
  await expect(page.getByText("売上受取口座")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "売上", exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "予約", exact: true })).toBeVisible();
  await page.keyboard.press("Tab");
  expect(await page.evaluate(() => document.activeElement !== document.body)).toBe(true);
  await noOverflow(page);
  const response = await page.goto(`/host/sales?providerId=${PROVIDER}`);
  expect(response?.status()).toBe(404);
  await expect(page.getByRole("heading", { name: "売上", exact: true })).toHaveCount(0);
});

test("a capture confirmation conflict requires a fresh authoritative read before any retry", async ({ page }) => {
  const item = bookingListItem("booking-capture-pending", "決済確認中の合成予約");
  let status = "PROVISIONAL";
  let captures = 0;
  await page.route(`**/host/api/provider-operations/${PROVIDER}/bookings**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/bookings")) return json(route, { bookings: [{ ...item, status }], nextCursor: null });
    if (path.endsWith("/approve")) {
      captures += 1;
      status = "CONFIRMED";
      return json(route, { error: "conflict", reason: "PAGE_BOOKING_CONFIRMATION_PENDING" }, 409);
    }
    return json(route, bookingDetail(item, status));
  });
  await page.goto("/host/auth/mock-login?mock=cohost");
  await page.goto(`/host/bookings?providerId=${PROVIDER}`);
  await page.getByRole("button", { name: /決済確認中の合成予約/ }).click();
  await page.getByRole("button", { name: "承認する", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("10:00");
  await page.getByRole("button", { name: "決済して承認" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "再送していません" })).toBeVisible();
  await expect(page.getByRole("button", { name: "承認する", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "最新状態を確認" }).click();
  await expect(page.getByRole("region", { name: "予約の詳細" }).getByText("確定", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "確認結果を了承する" }).click();
  await expect(page.getByRole("button", { name: "承認する", exact: true })).toHaveCount(0);
  expect(captures).toBe(1);
  await noOverflow(page);
});

const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const svgImage = (label: string) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="#e8dcc8"/><text x="24" y="160" font-size="28">${label}</text></svg>`)}`;
const consent = { version: "synthetic-listing-consent-2", text: "（合成）体験サイトへの掲載と、NIHO の確認に同意します。" };
const inheritedMeeting = { mode: "INHERIT", meetingPoint: { overview: "（合成）駅から歩いて 10 分", address: "（合成）サンプル町 1 丁目", accessNote: "（合成）東口から歩きます。", mapUrl: "https://maps.example.test/synthetic", entranceNote: "（合成）木の門の呼び鈴" } };

test("owner reorders photos, picks the cover and removes one: one PATCH carries the order, and a clash with another editor's photos never overwrites theirs", async ({ page }) => {
  const version = (hour: number) => `2026-10-27T${String(hour).padStart(2, "0")}:00:00.000Z`;
  const photo = (key: string) => ({ objectKey: key, url: svgImage(key) });
  let serverPage = { ...structuredClone(pageDetail), language: "EN", updatedAt: version(1), photos: ["photo-a", "photo-b", "photo-c"].map(photo), photoAlts: ["入口", "道場", "食卓"] };
  const patches: { expectedUpdatedAt: string; patch: Record<string, unknown> }[] = [];
  await page.route(`**/host/api/provider-pages/${PROVIDER}**`, async (route) => {
    const request = route.request(); const path = new URL(request.url()).pathname; const method = request.method();
    if (path.endsWith(`/${PAGE}`) && method === "GET") return json(route, serverPage);
    if (path.endsWith(`/${PAGE}`) && method === "PATCH") {
      const body = request.postDataJSON(); patches.push(body);
      if (body.expectedUpdatedAt !== serverPage.updatedAt) return json(route, { error: "PAGE_UPDATED" }, 409);
      const keys: string[] = body.patch.photoObjectKeys ?? serverPage.photos.map((item) => item.objectKey);
      const known = new Map(serverPage.photos.map((item) => [item.objectKey, item]));
      serverPage = { ...serverPage, ...body.patch, photos: keys.map((key) => known.get(key)!), photoAlts: body.patch.photoAlts ?? serverPage.photoAlts, updatedAt: version(2) };
      return json(route, serverPage);
    }
    if (path.endsWith("/meeting-point") && method === "GET") return json(route, inheritedMeeting);
    if (path.endsWith("/listing") && method === "GET") return json(route, { listing: null, consent });
    return json(route, { error: "not_found" }, 404);
  });
  await page.goto("/host/auth/mock-login");
  await page.goto(`/host/experiences/${PAGE}?providerId=${PROVIDER}`);
  const section = page.getByRole("region", { name: "写真", exact: true });
  const alts = () => section.getByRole("textbox").evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value));
  await expect(section.getByRole("listitem")).toHaveCount(3);
  await expect(section).toContainText("3 / 20 枚");
  await expect(section.getByRole("listitem").first()).toContainText("表紙");
  await expect(section.getByRole("button", { name: "写真 1 を前へ" })).toBeDisabled();
  await expect(section.getByRole("button", { name: "写真 3 を後ろへ" })).toBeDisabled();
  await expect(section.getByRole("button", { name: "写真 1 を表紙にする" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "保存", exact: true })).toBeDisabled();

  // 表紙にする: the photo and its description go first; focus stays in that photo's row (the cover has no 前へ or 表紙にする left).
  await section.getByRole("button", { name: "写真 3 を表紙にする" }).click();
  expect(await alts()).toEqual(["食卓", "入口", "道場"]);
  await expect(section.getByRole("button", { name: "写真 1 を後ろへ" })).toBeFocused();
  await expect(section.getByRole("status")).toContainText("写真 3 を表紙にしました。");
  // 後ろへ: the focus follows the same button to its new place.
  await section.getByRole("button", { name: "写真 1 を後ろへ" }).click();
  expect(await alts()).toEqual(["入口", "食卓", "道場"]);
  await expect(section.getByRole("button", { name: "写真 2 を後ろへ" })).toBeFocused();
  await expect(section.getByRole("status")).toContainText("写真 1 を 2 番目にしました。");
  // 外す: the focus goes to a photo still there.
  await section.getByRole("button", { name: "写真 3 を外す" }).click();
  expect(await alts()).toEqual(["入口", "食卓"]);
  await expect(section.getByRole("button", { name: "写真 2 を外す" })).toBeFocused();
  await section.getByLabel("写真 1 の説明（表紙）").fill(" 入口の門 ");
  expect(patches).toEqual([]);

  // One 保存: the order and the descriptions together, against the version that was read.
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "保存しました" })).toBeVisible();
  expect(patches).toEqual([{ expectedUpdatedAt: version(1), patch: { photoObjectKeys: ["photo-a", "photo-c"], photoAlts: ["入口の門", "食卓"] } }]);
  expect(await alts()).toEqual(["入口の門", "食卓"]);

  // Another editor changes a description while I change the order: the save is refused, and neither side is overwritten.
  await section.getByRole("button", { name: "写真 2 を表紙にする" }).click();
  expect(await alts()).toEqual(["食卓", "入口の門"]);
  serverPage = { ...serverPage, photoAlts: ["別の人が直した説明", "食卓"], updatedAt: version(4) };
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "ほかの人が先に保存しました" })).toBeVisible();
  expect(patches).toHaveLength(2);
  expect(patches[1]).toEqual({ expectedUpdatedAt: version(2), patch: { photoObjectKeys: ["photo-c", "photo-a"], photoAlts: ["食卓", "入口の門"] } });
  expect(await alts()).toEqual(["食卓", "入口の門"]);
  await page.getByRole("button", { name: "最新の保存内容を読む" }).click();
  await expect(page.getByText("同じ項目が変更されています")).toBeVisible();
  await expect(page.getByText("写真・並び・説明", { exact: true })).toBeVisible();
  await expect(page.getByText("写真の並び・説明: 別の人が直した説明、食卓")).toBeVisible();
  await page.getByRole("button", { name: "競合項目は最新を残す" }).click();
  expect(await alts()).toEqual(["別の人が直した説明", "食卓"]);
  await expect(page.getByRole("button", { name: "保存", exact: true })).toBeDisabled();
  expect(patches).toHaveLength(2);
  await noOverflow(page);
  const axe = await new AxeBuilder({ page }).include("section[aria-labelledby]").withTags(WCAG_TAGS).analyze();
  expect(axe.violations.filter((item) => item.impact === "serious" || item.impact === "critical")).toEqual([]);
});

test("a page with no photo says a cover is needed, and 20 photos is the most", async ({ page }) => {
  const photos = Array.from({ length: 20 }, (_, at) => ({ objectKey: `photo-${at}`, url: svgImage(`${at + 1}`) }));
  let serverPage = { ...structuredClone(pageDetail), language: "EN", photos: [] as typeof photos, photoAlts: [] as string[], publishBlockers: ["COVER_REQUIRED"] };
  await page.route(`**/host/api/provider-pages/${PROVIDER}**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith(`/${PAGE}`)) return json(route, serverPage);
    if (path.endsWith("/meeting-point")) return json(route, inheritedMeeting);
    if (path.endsWith("/listing")) return json(route, { listing: null, consent });
    return json(route, { error: "not_found" }, 404);
  });
  await page.goto("/host/auth/mock-login");
  await page.goto(`/host/experiences/${PAGE}?providerId=${PROVIDER}`);
  const section = page.getByRole("region", { name: "写真", exact: true });
  await expect(section).toContainText("表紙の写真がありません。掲載を申請するには、写真を 1 枚以上追加して保存してください。");
  await expect(page.getByText("表紙の写真を追加してください。")).toBeVisible();
  await expect(section.getByLabel("写真を追加")).toBeEnabled();
  serverPage = { ...serverPage, photos, photoAlts: photos.map((_, at) => `説明 ${at + 1}`), publishBlockers: [] };
  await page.reload();
  await expect(section.getByRole("listitem")).toHaveCount(20);
  await expect(section).toContainText("20 / 20 枚");
  await expect(section.getByLabel("写真を追加")).toBeDisabled();
  await expect(section).toContainText("写真は 20 枚までです。追加するには、どれかを外してください。");
  await section.getByRole("button", { name: "写真 20 を外す" }).click();
  await expect(section.getByLabel("写真を追加")).toBeEnabled();
});

test("owner previews the saved page as the experience site shows it, and is told that unsaved changes wait for 保存", async ({ page }) => {
  const image = (label: string) => svgImage(label);
  const occurrence = (date: string, hour: number, bookable = true) => ({ date, startAt: `${date}T${String(hour - 9).padStart(2, "0")}:00:00.000Z`, endAt: `${date}T${String(hour - 7).padStart(2, "0")}:00:00.000Z`, seatsLeft: 5, bookable, ...(bookable ? {} : { reason: "full" }) });
  const previewOffer = { id: "offer-1", name: "午前の合成商品", shortDescription: null, sortOrder: 0, priceYen: 5000, childPriceYen: null, childMinAge: null, childMaxAge: null, adultRequiredForChild: false, currency: "JPY", capacity: 6, maxPartySize: 4, minimumParticipants: 1, durationMinutes: 120, startTime: "10:00", cancellationPolicy: "FREE_UNTIL_24H", acceptanceMode: "APPROVAL", bookingQuestions: [], bookingQuestionsFingerprint: "0".repeat(64), occurrences: [occurrence("2026-11-03", 10), occurrence("2026-11-03", 14), occurrence("2026-11-07", 10, false), occurrence("2026-11-10", 10)] };
  const previewBody = {
    page: { slug: "synthetic-workshop", kind: "EXPERIENCE", language: "EN", title: "（合成）Morning craft workshop", titleEn: null, content: { lead: "（合成）A calm morning making something by hand.", leadEn: null, facts: { language: "English, with an English-speaking guide", languageEn: null }, highlights: ["（合成）Tea with your host"], highlightsEn: [null], timeline: [], description: "（合成）First paragraph.\n\n（合成）Second paragraph.", descriptionEn: null, included: ["（合成）Materials"], includedEn: [null], notIncluded: [], notIncludedEn: [], notSuitableFor: [], notSuitableForEn: [], knowBeforeYouGo: ["（合成）Wear comfortable clothes"], knowBeforeYouGoEn: [null] }, photos: [{ url: image("one") }, { url: image("two") }], coverUrl: image("one") },
    spot: { slug: "synthetic-provider", name: "（合成）Garden House", logoUrl: null, tagline: null, taglineEn: null, landingGround: "LIGHT", landingAccent: "LEAF", landingFont: "MARU", meetingPoint: null },
    hosts: [{ displayName: "（合成）Yuki", avatarUrl: null }], offers: [previewOffer], offer: { ...previewOffer, occurrences: undefined }, occurrences: previewOffer.occurrences,
  };
  let previewStatus = 200; const previewCalls: string[] = []; const nonGet: string[] = [];
  await page.route(`**/host/api/provider-pages/${PROVIDER}**`, async (route) => {
    const request = route.request(); const path = new URL(request.url()).pathname;
    if (request.method() !== "GET") nonGet.push(`${request.method()} ${path}`);
    if (path.endsWith("/preview")) { previewCalls.push(request.url()); return previewStatus === 200 ? json(route, previewBody) : json(route, { error: "permission_ended" }, previewStatus); }
    if (path.endsWith(`/${PAGE}`)) return json(route, { ...structuredClone(pageDetail), language: "EN", title: "（合成）Morning craft workshop" });
    if (path.endsWith("/meeting-point")) return json(route, inheritedMeeting);
    if (path.endsWith("/listing")) return json(route, { listing: null, consent });
    return json(route, { error: "not_found" }, 404);
  });
  await page.goto("/host/auth/mock-login");
  await page.goto(`/host/experiences/${PAGE}?providerId=${PROVIDER}`);
  const open = page.getByRole("button", { name: "プレビュー", exact: true });
  await expect(page.getByLabel("題名")).toBeVisible();
  await open.click();
  const preview = page.getByRole("dialog", { name: /プレビュー/ });
  // The traveler's detail: its h1, its price card with the next bookable days, the host line.
  await expect(preview.getByRole("heading", { level: 1, name: "（合成）Morning craft workshop" })).toBeVisible();
  await expect(preview).toContainText("保存した内容を表示しています。");
  await expect(preview).toContainText("（合成）Yuki");
  await expect(preview).toContainText("¥5,000");
  await expect(preview).toContainText("Tue, Nov 3");
  await expect(preview).toContainText("Tue, Nov 10");
  await expect(preview).toContainText("集合場所は予約が確定した方にだけ届くため、プレビューには出ません。");
  await expect(preview).toContainText("The meeting point is shared after your booking is confirmed.");
  await expect(preview.getByRole("link")).toHaveCount(0);
  // One read per opening (the dev server's StrictMode may repeat the effect): only ever the same query-less GET.
  const firstReads = previewCalls.length;
  expect(firstReads).toBeGreaterThan(0);
  expect(previewCalls.every((url) => new URL(url).search === "")).toBe(true);
  expect(nonGet).toEqual([]);
  expect(await preview.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  const axe = await new AxeBuilder({ page }).include("[data-testid='host-preview']").withTags(WCAG_TAGS).analyze();
  expect(axe.violations.filter((item) => item.impact === "serious" || item.impact === "critical")).toEqual([]);
  await page.screenshot({ path: test.info().outputPath("preview.png"), scale: "css" });

  // Esc closes it and the focus is back on プレビュー; the editor underneath is as it was.
  await page.keyboard.press("Escape");
  await expect(preview).toHaveCount(0);
  await expect(open).toBeFocused();

  // An unsaved change: the preview still shows the saved page and says that 保存 puts the change in.
  await page.getByLabel("題名").fill("（合成）まだ保存していない題名");
  await expect(page.getByText("プレビューには保存した内容が出ます。保存すると反映されます。")).toBeVisible();
  await open.click();
  await expect(preview).toContainText("未保存の変更があります。プレビューには保存した内容だけが出ます。保存すると反映されます。");
  await expect(preview.getByRole("heading", { level: 1 })).toHaveText("（合成）Morning craft workshop");
  expect(previewCalls.length).toBeGreaterThan(firstReads);
  await preview.getByRole("button", { name: "閉じる" }).click();
  await expect(preview).toHaveCount(0);
  await expect(page.getByLabel("題名")).toHaveValue("（合成）まだ保存していない題名");

  // A page NIHO cannot assemble (no active offer) says what is missing, with nothing invented.
  previewStatus = 404;
  await open.click();
  await expect(preview.getByRole("alert")).toContainText("プレビューできる状態ではありません。");
  await expect(preview.getByRole("heading", { level: 1 })).toHaveCount(0);
  await page.keyboard.press("Escape");
  expect(nonGet).toEqual([]);
});

test("against the mock NIHO: the photos show their order and the preview shows the traveler's detail for an English page and a Japanese draft", async ({ page }) => {
  // The mock NIHO is rebuilt for every request (nothing a save sends is kept), so this reads only: the order is changed on the screen, not saved.
  await page.goto("/host/auth/mock-login");
  await page.goto("/host/experiences/sample-page-kitchen-cooking?providerId=sample-provider-kitchen");
  const section = page.getByRole("region", { name: "写真", exact: true });
  const alts = () => section.getByRole("textbox").evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value));
  await expect(page.getByLabel("題名")).toBeVisible();
  const before = await alts();
  expect(before.length).toBeGreaterThanOrEqual(2);
  await expect(section.getByRole("listitem").first()).toContainText("表紙");
  await section.getByRole("button", { name: "写真 2 を表紙にする" }).click();
  expect(await alts()).toEqual([before[1], before[0], ...before.slice(2)]);
  await expect(page.getByRole("button", { name: "保存", exact: true })).toBeEnabled();

  const open = page.getByRole("button", { name: "プレビュー", exact: true });
  await open.click();
  const preview = page.getByRole("dialog", { name: /プレビュー/ });
  await expect(preview.getByRole("heading", { level: 1 })).toHaveText(/Cook a seasonal home meal together/);
  // The unsaved order is not in the preview: it shows what NIHO has.
  await expect(preview).toContainText("未保存の変更があります。プレビューには保存した内容だけが出ます。保存すると反映されます。");
  await expect(preview).toContainText("The meeting point is shared after your booking is confirmed.");
  await expect(preview).not.toContainText("この体験ページは日本語です");
  await page.keyboard.press("Escape");
  await expect(preview).toHaveCount(0);
  expect(await alts()).toEqual([before[1], before[0], ...before.slice(2)]);

  // A Japanese page: the experience site lists English pages only, and the preview says so.
  await page.goto("/host/experiences/sample-page-kitchen-market?providerId=sample-provider-kitchen");
  await expect(page.getByLabel("題名")).toBeVisible();
  await open.click();
  await expect(preview.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(preview).toContainText("この体験ページは日本語です。体験サイトに載るのは英語のページだけです。");
  const axe = await new AxeBuilder({ page }).include("[data-testid='host-preview']").withTags(WCAG_TAGS).analyze();
  expect(axe.violations.filter((item) => item.impact === "serious" || item.impact === "critical")).toEqual([]);
});
