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
  id, spotId: "synthetic-spot", pageId: PAGE, offerId: "offer-1", occurrenceDate: "2026-11-08", startAt: "2026-11-08T01:00:00.000Z", endAt: "2026-11-08T02:30:00.000Z",
  headCount: 2, adultCount: 2, childCount: 0, offerNameSnapshot: "午前の合成商品", totalYenSnapshot: 10000,
  guestName: `合成予約者 ${id}`, guestEmail: `${id}@example.test`, note: "アレルギーはありません（合成）", questionAnswersJson: null,
  paidAt: null, authorizedAt: null, cancelledAt: null, refundedYen: 0, createdAt: now, experienceSiteListingId: null,
  sellerDisplayNameSnapshot: "合成提供者", page: { title }, status, salesChannel: "EXPERIENCE_SITE",
});
const bookingDetail = (item: ReturnType<typeof bookingListItem>, status: string, messages: unknown[] = []) => ({
  booking: {
    id: item.id, offerId: item.offerId, offerName: item.offerNameSnapshot, occurrenceDate: item.occurrenceDate, startAt: item.startAt, endAt: item.endAt,
    headCount: item.headCount, adultCount: item.adultCount, childCount: item.childCount, guestName: item.guestName, guestEmail: item.guestEmail,
    languageSnapshot: "JA", note: item.note, answers: null, status, unitPriceYen: 5000, adultPriceYen: 5000, childPriceYen: 2500,
    totalYen: item.totalYenSnapshot, paidAt: null, authorizedAt: null, approvalDeadlineAt: "2026-11-01T00:00:00.000Z",
    travelerCancelRequestedAt: null, cancelledAt: null, cancelReason: null, cancelMessage: null, refundedYen: 0, createdAt: now,
    salesChannel: "EXPERIENCE_SITE", hostMessages: messages, pageId: PAGE, page: item.page,
  },
  sender: { displayName: "合成提供者", replyToEmails: ["synthetic-provider@example.test"] },
});

const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body), headers: { "cache-control": "private, no-store", "referrer-policy": "no-referrer" } });
const noOverflow = async (page: Page) => { expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true); await page.screenshot({ path: test.info().outputPath("screen.png"), scale: "css" }); };

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
  let serverPage = structuredClone(pageDetail); let patchCalls = 0;
  await page.route(`**/host/api/provider-pages/${PROVIDER}**`, async (route) => {
    const request = route.request(); const path = new URL(request.url()).pathname;
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
  await noOverflow(page);
});

test("cohost approves, declines and replies only after authoritative booking re-reads", async ({ page }) => {
  const first = bookingListItem("booking-1", "合成の手仕事体験");
  const second = bookingListItem("booking-2", "午後の合成体験");
  const pending = bookingListItem("booking-pending", "支払い確認中の合成体験", "PENDING");
  const allBookings = [first, second, pending];
  const statuses = new Map<string, string>(allBookings.map((item) => [item.id, item.status]));
  const messages = new Map<string, unknown[]>(allBookings.map((item) => [item.id, []]));
  let revoked = false; let approveAttempts = 0; let failDetailAfterMessage = false;
  await page.route(`**/host/api/provider-operations/${PROVIDER}/bookings**`, async (route) => {
    if (revoked) return json(route, { error: "permission_ended" }, 404);
    const request = route.request(); const path = new URL(request.url()).pathname; const parts = path.split("/"); const bookingId = parts.at(-1)!;
    if (path.endsWith("/bookings") && request.method() === "GET") return json(route, { bookings: allBookings.map((item) => ({ ...item, status: statuses.get(item.id) })), nextCursor: null });
    if (request.method() === "GET") {
      if (failDetailAfterMessage) { failDetailAfterMessage = false; return json(route, { error: "upstream_unavailable" }, 502); }
      const item = allBookings.find((candidate) => candidate.id === bookingId)!;
      return json(route, bookingDetail(item, statuses.get(item.id)!, messages.get(item.id)));
    }
    const action = bookingId; const id = parts.at(-2)!; const item = allBookings.find((candidate) => candidate.id === id)!;
    if (action === "approve") { approveAttempts += 1; if (approveAttempts === 1) return route.abort("failed"); statuses.set(id, "CONFIRMED"); return json(route, { status: "CONFIRMED" }); }
    if (action === "decline") { statuses.set(id, "DECLINED"); return json(route, { status: "DECLINED" }); }
    if (action === "message") { const sent = { id: "message-1", subject: request.postDataJSON().subject, createdAt: later, sentAt: null, failed: false, deliveryStatus: "QUEUED" }; messages.get(id)!.push(sent); failDetailAfterMessage = true; return json(route, { message: sent }, 201); }
    return json(route, bookingDetail(item, statuses.get(id)!, messages.get(id)));
  });
  await page.goto("/host/auth/mock-login?mock=cohost");
  await page.goto(`/host/bookings?providerId=${PROVIDER}`);
  await page.getByRole("button", { name: /合成の手仕事体験/ }).click();
  await page.getByRole("button", { name: "承認する" }).click();
  const approvalDialog = page.getByRole("dialog");
  await expect(approvalDialog.getByText("カードに請求し、決済できたら予約が確定します。")).toBeVisible();
  await expect(approvalDialog.getByText("合成予約者 booking-1")).toBeVisible();
  await expect(approvalDialog.getByText("¥10,000")).toBeVisible();
  await page.getByRole("button", { name: "決済して承認" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "再送していません" })).toBeVisible();
  await expect(page.getByRole("button", { name: "承認する" })).toBeDisabled();
  await page.getByRole("button", { name: "最新状態を確認" }).click();
  await expect(page.getByRole("status").filter({ hasText: "まだ承認待ちです" })).toBeVisible();
  await page.getByRole("button", { name: "確認結果を了承する" }).click();
  await page.getByRole("button", { name: "承認する" }).click();
  await page.getByRole("button", { name: "決済して承認" }).click();
  await expect(page.getByRole("status").filter({ hasText: "予約を承認しました" })).toBeVisible();
  await page.getByRole("button", { name: /支払い確認中の合成体験/ }).click();
  await expect(page.getByRole("button", { name: "承認する" })).toHaveCount(0);
  await page.getByRole("button", { name: /午後の合成体験/ }).click();
  await page.getByRole("button", { name: "お断りする" }).click();
  await page.getByRole("button", { name: "申込を断る" }).click();
  await expect(page.getByRole("status").filter({ hasText: "予約をお断りしました" })).toBeVisible();
  await page.getByLabel("件名").fill("合成の開催案内");
  await page.getByLabel("本文").fill("集合時刻をご確認ください（合成）。");
  await page.getByRole("button", { name: "返信を送る" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "履歴を確認するまで次の送信はできません" })).toBeVisible();
  await expect(page.getByLabel("件名")).toHaveValue("合成の開催案内");
  await expect(page.getByRole("button", { name: "返信を送る" })).toBeDisabled();
  await page.getByRole("button", { name: "最新状態を確認" }).click();
  await expect(page.getByText("合成の開催案内")).toBeVisible();
  await expect(page.getByText(/配信待ち/)).toBeVisible();
  await page.getByRole("button", { name: "確認結果を了承する" }).click();
  await expect(page.getByLabel("件名")).toHaveValue("");
  await page.getByRole("region", { name: "予約の詳細" }).evaluate((element) => element.scrollIntoView({ block: "start" }));
  await page.screenshot({ path: test.info().outputPath("booking-reply.png"), scale: "css" });
  revoked = true; await page.reload();
  await expect(page.getByRole("alert").filter({ hasText: "権限が終了しています" })).toBeVisible();
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
  await page.getByRole("button", { name: /選択中の合成予約/ }).click();
  const detailRegion = page.getByRole("region", { name: "予約の詳細" });
  await expect(detailRegion.getByText("合成予約者 booking-fast")).toBeVisible();
  releaseSlow();
  await slowFinished;
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(detailRegion.getByText("合成予約者 booking-fast")).toBeVisible();
  await expect(page.getByRole("region", { name: "予約の詳細" }).getByText("合成予約者 booking-slow")).toHaveCount(0);
  await page.getByLabel("件名").fill("fastだけの下書き");
  await page.getByLabel("本文").fill("別の予約には表示しない合成本文");
  await page.getByRole("button", { name: /遅い合成予約/ }).click();
  await expect(page.getByLabel("件名")).toHaveValue("");
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
