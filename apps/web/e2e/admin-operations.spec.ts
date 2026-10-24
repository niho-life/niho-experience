import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";

const operationId = "123e4567-e89b-42d3-a456-426614174000";
const support = { kind: "valid" as const, snapshot: { policyVersion: "2026-10-23" as const, enabled: true, baseRateBps: 1000 as const, supportRateBps: 500 as const, totalRateBps: 1500 as const, consentVersion: "2026-10-23" as const, consentedAt: "2026-10-23T01:00:00.000Z", consentedByUserId: "admin-1", agreementRevision: 2 }, normalOperationsAllowed: true };
const bookings = [
  { id: "provider-booking", host: { kind: "EXPERIENCE_PROVIDER", id: "provider-1", displayName: "合成工房", vesselSpotId: "spot-vessel" }, guestName: "Provider Guest", totalYen: 12000 },
  { id: "spot-booking", host: { kind: "SPOT", id: "spot-1", displayName: "合成拠点" }, guestName: "Spot Guest", totalYen: 6000 },
] as const;
const list = bookings.map((item, index) => ({ ...item, pageId: `page-${item.id}`, experienceTitle: `合成体験${index}`, offerName: "午前", occurrenceDate: "2026-11-03", startAt: "2026-11-03T01:00:00.000Z", endAt: "2026-11-03T03:00:00.000Z", headCount: 2, status: "PENDING", support, needsAttention: true, createdAt: "2026-10-23T01:00:00.000Z" }));
const detail = (id: string) => { const source = list.find((item) => item.id === id)!; return { booking: { id, offerId: `offer-${id}`, offerName: "午前", occurrenceDate: source.occurrenceDate, startAt: source.startAt, endAt: source.endAt, headCount: 2, adultCount: 2, childCount: 0, guestName: source.guestName, guestEmail: "guest@example.invalid", languageSnapshot: "ja", note: null, answers: [], status: "PENDING", unitPriceYen: source.totalYen / 2, adultPriceYen: source.totalYen / 2, childPriceYen: null, totalYen: source.totalYen, paidAt: null, authorizedAt: source.createdAt, approvalDeadlineAt: "2026-10-24T01:00:00.000Z", travelerCancelRequestedAt: null, cancelledAt: null, cancelReason: null, cancelMessage: null, refundedYen: 0, createdAt: source.createdAt, salesChannel: "SYNTHETIC", hostMessages: [], pageId: source.pageId, page: { title: source.experienceTitle }, host: source.host, support }, supportAgreement: { agreementRevision: 2, sharedConsultationMemo: null, matchesBookingSnapshot: true } }; };
const snapshot = (id: string, revision = 1) => { const source = bookings.find((item) => item.id === id)!; return { booking: { bookingRequestId: id, revision, updatedAt: "2026-10-23T01:00:00.000Z", host: source.host, guest: { displayName: source.guestName }, status: "PROVISIONAL", totalYen: source.totalYen, refundedYen: 0, providerRefund: { status: "KNOWN", refundedYen: 0, observedAt: "2026-10-23T01:00:00.000Z" }, refundOptions: [{ choice: "FULL", refundAmountYen: source.totalYen, resultRefundedYen: source.totalYen }, { choice: "NONE", refundAmountYen: 0, resultRefundedYen: 0 }], occurrenceDate: "2026-11-03", startAt: "2026-11-03T01:00:00.000Z", endAt: "2026-11-03T03:00:00.000Z", approvalDeadlineAt: "2026-10-24T01:00:00.000Z", actions: { approve: { allowed: true, reason: null as string | null }, decline: { allowed: true, reason: null as string | null }, cancel: { allowed: false, reason: "STATUS" as string | null }, message: { allowed: true, reason: null as string | null } } }, operations: [], history: { limit: 50, truncated: false } }; };
const operation = (id: string, action = "APPROVE", state = "SUCCEEDED", retryAllowed = false) => ({ operationId: id, bookingRequestId: "provider-booking", action, actorKind: "NIHO_SUPPORT", expectedRevision: 1, expectedStatus: "PROVISIONAL", expectedTotalYen: 12000, expectedRefundedYen: 0, expectedProviderRefundedYen: null, requestedRefundAmountYen: null, reasonCode: "SUPPORT_REVIEWED", state, resultCode: state === "SUCCEEDED" ? "OK" : null, resultStatus: state === "SUCCEEDED" ? "CONFIRMED" : null, resultRefundedYen: 0, message: null, retryAllowed, firstExternalAttemptAt: "2026-10-23T01:00:00.000Z", lastReconciledAt: null, createdAt: "2026-10-23T01:00:00.000Z", updatedAt: "2026-10-23T01:00:00.000Z", completedAt: state === "SUCCEEDED" ? "2026-10-23T01:01:00.000Z" : null });
const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

interface Backend { posts: Array<{ action: string; command: { operationId: string } }>; operationGets: string[]; snapshotReads: number; confirmationChange: "none" | "revision" | "actions" | "deadline" | "refund"; postConflict: string | null; firstPostUnknown: boolean; retryAllowed: boolean; operationLookup: "normal" | "not-found" | "invalid"; signedOut: boolean; invalidSnapshot: boolean; postGate: Promise<void> | null; releasePost: (() => void) | null }
async function install(page: Page): Promise<Backend> {
  const backend: Backend = { posts: [], operationGets: [], snapshotReads: 0, confirmationChange: "none", postConflict: null, firstPostUnknown: false, retryAllowed: true, operationLookup: "normal", signedOut: false, invalidSnapshot: false, postGate: null, releasePost: null };
  await page.route("**/admin/api/**", async (route) => {
    const request = route.request(); const url = new URL(request.url());
    if (backend.signedOut) return json(route, 401, { error: "signed_out" });
    if (url.pathname === "/admin/api/bookings" && request.method() === "POST") return json(route, 200, { bookings: list, nextCursor: null });
    if (url.pathname === "/admin/api/support-admins") return json(route, 200, { admins: [{ id: "admin-1", displayName: "合成管理者" }], truncated: false });
    const caseMatch = url.pathname.match(/^\/admin\/api\/bookings\/([^/]+)\/support-case$/);
    if (caseMatch) return json(route, 200, { supportCase: { bookingRequestId: decodeURIComponent(caseMatch[1]!), assignedAdmin: { status: "UNASSIGNED" }, internalMemo: null, revision: 0, createdAt: null, updatedAt: null }, writeCapability: { writable: true, reason: null } });
    const operationMatch = url.pathname.match(/^\/admin\/api\/bookings\/([^/]+)\/operations(?:\/([^/]+))?$/);
    if (operationMatch) {
      const id = decodeURIComponent(operationMatch[1]!); const knownId = operationMatch[2] ? decodeURIComponent(operationMatch[2]) : null;
      if (knownId) { backend.operationGets.push(knownId); if (backend.operationLookup === "not-found") return json(route, 404, { error: "not_found" }); if (backend.operationLookup === "invalid") return json(route, 200, { operation: { privateField: true } }); return json(route, 200, { operation: operation(knownId, "APPROVE", backend.firstPostUnknown ? "UNKNOWN" : "SUCCEEDED", backend.firstPostUnknown && backend.retryAllowed) }); }
      if (request.method() === "GET") {
        backend.snapshotReads += 1; if (backend.invalidSnapshot) return json(route, 200, { ...snapshot(id), privateField: true });
        const value = snapshot(id, backend.confirmationChange === "revision" && backend.snapshotReads > 1 ? 2 : 1);
        value.booking.providerRefund.observedAt = new Date(Date.parse("2026-10-23T01:00:00.000Z") + backend.snapshotReads * 1000).toISOString();
        if (backend.snapshotReads > 1 && backend.confirmationChange === "actions") value.booking.actions.approve = { allowed: false, reason: "STATUS" };
        if (backend.snapshotReads > 1 && backend.confirmationChange === "deadline") value.booking.approvalDeadlineAt = "2026-10-25T01:00:00.000Z";
        if (backend.snapshotReads > 1 && backend.confirmationChange === "refund") value.booking.refundOptions[0] = { choice: "FULL", refundAmountYen: Math.max(0, value.booking.totalYen - 1000), resultRefundedYen: Math.max(0, value.booking.totalYen - 1000) };
        return json(route, 200, value);
      }
      const body = request.postDataJSON() as { action: string; command: { operationId: string } }; backend.posts.push(body);
      if (backend.postGate) await backend.postGate;
      if (backend.postConflict) return json(route, 409, { error: "conflict", reason: backend.postConflict });
      if (backend.firstPostUnknown && backend.posts.length === 1) return json(route, 503, { error: "unavailable" });
      return json(route, 200, { operation: operation(body.command.operationId, body.action, "SUCCEEDED", false) });
    }
    const id = decodeURIComponent(url.pathname.split("/").at(-1) ?? ""); const found = list.some((item) => item.id === id); return json(route, found ? 200 : 404, found ? detail(id) : { error: "not_found" });
  });
  return backend;
}
async function signIn(page: Page) { await page.goto("/admin"); await page.getByRole("button", { name: "合成Adminとして開く" }).click(); await page.waitForURL(/\/admin\/bookings/); }
async function open(page: Page) { await page.getByRole("button", { name: /Provider Guest/ }).click(); await expect(page.getByRole("heading", { name: "予約対応" })).toBeVisible(); }

test("both host kinds render contract snapshots and 320px keyboard/axe remain usable", async ({ page }, testInfo) => {
  const backend = await install(page); await signIn(page); await open(page); await expect(page.getByRole("article")).toContainText("外部提供者");
  if (testInfo.project.name === "admin-case-mobile-360") { await page.setViewportSize({ width: 320, height: 640 }); await page.keyboard.press("Tab"); expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0); const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag22aa"]).analyze(); expect(results.violations.filter((item) => item.impact === "serious" || item.impact === "critical")).toEqual([]); }
  if (testInfo.project.name === "admin-case-mobile-360") await page.getByRole("button", { name: /予約支援へ戻る/ }).click(); await page.getByRole("button", { name: /Spot Guest/ }).click(); await expect(page.getByRole("article")).toContainText("通常拠点");
  expect(backend.posts).toHaveLength(0);
});

test("confirmation is a modal, Escape restores focus, and normalized send content is keyboard accessible", async ({ page }) => {
  await install(page); await signIn(page); await open(page); await page.getByRole("combobox", { name: "予約対応", exact: true }).selectOption("MESSAGE"); await page.getByRole("combobox", { name: "定型理由" }).selectOption("BOOKING_DETAILS"); await page.getByRole("textbox", { name: "件名" }).fill("  日程\n 確認  "); await page.getByRole("textbox", { name: "旅行者に届く本文" }).fill(" 1行目\r\n2行目 ");
  const opener = page.getByRole("button", { name: /最新の予約情報を確認して予約者への連絡へ/ }); await opener.focus(); await page.keyboard.press("Enter"); const dialog = page.getByRole("dialog"); await expect(dialog).toBeVisible(); expect(await dialog.evaluate((element: HTMLDialogElement) => element.matches(":modal"))).toBe(true); await expect(dialog).toContainText("日程 確認"); await expect(dialog).toContainText("1行目\n2行目"); await expect(dialog.getByRole("button", { name: "戻る" })).toBeFocused(); const results = await new AxeBuilder({ page }).include("dialog").withTags(["wcag2a", "wcag2aa", "wcag22aa"]).analyze(); expect(results.violations.filter((item) => item.impact === "serious" || item.impact === "critical")).toEqual([]); await page.keyboard.press("Escape"); await expect(dialog).toBeHidden(); await expect(opener).toBeFocused();
});

test("double click creates one immutable UUID and actions-only fresh change posts nothing", async ({ page }) => {
  const backend = await install(page); await signIn(page); await open(page); await page.getByRole("button", { name: /最新の予約情報を確認して承認へ/ }).click(); await page.getByRole("dialog").getByRole("button", { name: /この内容で承認/ }).evaluate((button: HTMLButtonElement) => { button.click(); button.click(); }); await expect(page.getByText(/完了/).last()).toBeVisible(); expect(backend.posts).toHaveLength(1); expect(backend.posts[0]!.command.operationId).toMatch(/^[0-9a-f-]{36}$/);
  await page.goto("/admin/bookings?booking=provider-booking"); backend.confirmationChange = "actions"; backend.snapshotReads = 0; await expect(page.getByRole("article")).toBeVisible(); await page.getByRole("button", { name: /最新の予約情報を確認して承認へ/ }).click(); await page.getByRole("dialog").getByRole("button", { name: /この内容で承認/ }).click(); await expect(page.getByRole("article").getByRole("status")).toContainText("利用できる対応が変わりました"); expect(backend.posts).toHaveLength(1);
});

test("an explicitly reused UUID never completes or clears the current message from an unrelated terminal operation", async ({ page }) => {
  const backend = await install(page);
  let posts = 0;
  await page.route("**/admin/api/bookings/provider-booking/operations", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    posts += 1;
    return json(route, 409, { error: "operation_id_reused" });
  });
  await signIn(page); await open(page);
  await page.getByRole("combobox", { name: "予約対応", exact: true }).selectOption("MESSAGE");
  await page.getByRole("combobox", { name: "定型理由" }).selectOption("BOOKING_DETAILS");
  await page.getByRole("textbox", { name: "件名" }).fill("今回の確認");
  await page.getByRole("textbox", { name: "旅行者に届く本文" }).fill("未送信の本文を保持する");
  await page.getByRole("button", { name: /最新の予約情報を確認して予約者への連絡へ/ }).click();
  await page.getByRole("dialog").getByRole("button", { name: "この内容で予約者への連絡" }).click();
  await expect(page.getByRole("article")).toContainText("今回の依頼の完了とは扱いません");
  await page.getByRole("button", { name: "同じ受付番号を再確認" }).click();
  await expect(page.getByRole("article")).toContainText("既存の対応は今回の依頼の結果ではありません");
  await expect(page.getByRole("textbox", { name: "件名" })).toHaveValue("今回の確認");
  await expect(page.getByRole("textbox", { name: "旅行者に届く本文" })).toHaveValue("未送信の本文を保持する");
  await expect(page.getByRole("button", { name: /最新の予約情報を確認して予約者への連絡へ/ })).toBeDisabled();
  expect(posts).toBe(1); expect(backend.operationGets).toHaveLength(1);
});

test("POST 409 keeps input and requires an explicit fresh confirmation before a new ID", async ({ page }) => {
  const backend = await install(page); backend.postConflict = "BOOKING_SNAPSHOT_CHANGED"; await signIn(page); await open(page);
  await page.getByRole("combobox", { name: "予約対応", exact: true }).selectOption("MESSAGE"); await page.getByRole("combobox", { name: "定型理由" }).selectOption("BOOKING_DETAILS"); await page.getByRole("textbox", { name: "件名" }).fill("  日程  確認  "); await page.getByRole("textbox", { name: "旅行者に届く本文" }).fill("本文\r\n確認");
  await page.getByRole("button", { name: /最新の予約情報を確認して予約者への連絡へ/ }).click(); const dialog = page.getByRole("dialog"); await expect(dialog).toContainText("日程 確認"); await expect(dialog).toContainText("本文\n確認"); await dialog.getByRole("button", { name: /この内容で予約者への連絡/ }).click();
  await expect(page.getByRole("alert").filter({ hasText: "受理されませんでした" })).toContainText("受理されませんでした"); await expect(page.getByRole("textbox", { name: "件名" })).toHaveValue("  日程  確認  "); expect(backend.posts).toHaveLength(1);
});

test("503 reconciles the same ID and retryAllowed controls same-ID resend", async ({ page }) => {
  const backend = await install(page); backend.firstPostUnknown = true; await signIn(page); await open(page); await page.getByRole("button", { name: /最新の予約情報を確認して承認へ/ }).click(); await page.getByRole("dialog").getByRole("button", { name: /この内容で承認/ }).click(); await expect(page.getByRole("button", { name: "同じ受付番号・内容で再送" })).toBeVisible(); expect(backend.operationGets).toEqual([backend.posts[0]!.command.operationId]); await page.getByRole("button", { name: "同じ受付番号・内容で再送" }).click(); expect(backend.posts[1]!.command.operationId).toBe(backend.posts[0]!.command.operationId);
});

test("query UUID recovery performs GET only and terminal recovery returns to latest booking data", async ({ page }) => {
  const backend = await install(page); await signIn(page); await page.goto(`/admin/bookings?booking=provider-booking&operation=${operationId}`); await expect(page.getByText(/完了/).last()).toBeVisible(); await expect(page.getByRole("article")).toContainText("合成工房"); expect(backend.operationGets).toEqual([operationId]); expect(backend.posts).toHaveLength(0); expect(backend.snapshotReads).toBe(1);
});

test("query 404 keeps the same UUID GET control and never creates a replacement ID", async ({ page }) => {
  const backend = await install(page); backend.operationLookup = "not-found"; await signIn(page); await page.goto(`/admin/bookings?booking=provider-booking&operation=${operationId}`); await expect(page.getByText(/未実行とは断定せず/)).toBeVisible(); const recheck = page.getByRole("button", { name: "同じ受付番号を再確認" }); await expect(recheck).toBeVisible(); backend.operationLookup = "normal"; await recheck.click(); await expect(page.getByText(/完了/).last()).toBeVisible(); expect(backend.operationGets).toEqual([operationId, operationId]); expect(backend.posts).toHaveLength(0);
  backend.operationLookup = "invalid"; await page.goto(`/admin/bookings?booking=provider-booking&operation=223e4567-e89b-42d3-a456-426614174000`); await expect(page.getByRole("alert").filter({ hasText: "安全に読み取れません" })).toContainText("安全に読み取れません"); expect(backend.posts).toHaveLength(0);
});

test("retryAllowed=false blocks POST retry but same-ID GET can complete", async ({ page }) => {
  const backend = await install(page); backend.firstPostUnknown = true; backend.retryAllowed = false; await signIn(page); await open(page); await page.getByRole("button", { name: /最新の予約情報を確認して承認へ/ }).click(); await page.getByRole("dialog").getByRole("button", { name: /この内容で承認/ }).click(); await expect(page.getByText(/同じ内容の再送はできません/)).toBeVisible(); await expect(page.getByRole("button", { name: "同じ受付番号・内容で再送" })).toHaveCount(0); backend.firstPostUnknown = false; await page.getByRole("button", { name: "同じ受付番号を再確認" }).click(); await expect(page.getByText(/完了/).last()).toBeVisible(); expect(backend.posts).toHaveLength(1);
});

test("401 clears parent, case, operation and draft content", async ({ page }) => {
  const backend = await install(page); await signIn(page); await open(page); await page.getByRole("combobox", { name: "予約対応", exact: true }).selectOption("MESSAGE"); await page.getByRole("combobox", { name: "定型理由" }).selectOption("BOOKING_DETAILS"); await page.getByRole("textbox", { name: "件名" }).fill("secret draft"); await page.getByRole("textbox", { name: "旅行者に届く本文" }).fill("secret body"); backend.signedOut = true; await page.getByRole("button", { name: /最新の予約情報を確認して予約者への連絡へ/ }).click(); await page.getByRole("dialog").getByRole("button", { name: /この内容で予約者への連絡/ }).click(); await expect(page.getByRole("alert").filter({ hasText: "もう一度サインイン" })).toBeVisible(); await expect(page.getByText("secret draft")).toHaveCount(0); await expect(page.getByText("Provider Guest", { exact: true })).toHaveCount(0);
});

test("a late POST response cannot restore booking data after another request expires the session", async ({ page }) => {
  const backend = await install(page); backend.postGate = new Promise<void>((resolve) => { backend.releasePost = resolve; }); await signIn(page); await open(page); await page.getByRole("button", { name: /最新の予約情報を確認して承認へ/ }).click(); await page.getByRole("dialog").getByRole("button", { name: /この内容で承認/ }).click(); await expect.poll(() => backend.posts.length).toBe(1);
  backend.signedOut = true; await page.getByRole("textbox", { name: "内部メモ", exact: true }).fill("expire now"); await page.getByRole("button", { name: "担当・内部メモを保存" }).click(); await expect(page.getByRole("alert").filter({ hasText: "もう一度サインイン" })).toBeVisible(); backend.signedOut = false; backend.releasePost?.(); await expect(page.getByText("Provider Guest", { exact: true })).toHaveCount(0); await expect(page.getByText(/受付番号/)).toHaveCount(0);
});

test("case and operation drafts compose in the keyed leave guard", async ({ page }) => {
  await install(page); await signIn(page); await open(page); await page.getByRole("textbox", { name: "内部メモ", exact: true }).fill("case draft"); await page.getByRole("combobox", { name: "予約対応", exact: true }).selectOption("MESSAGE"); await page.getByRole("textbox", { name: "件名" }).fill("operation draft"); await page.getByRole("link", { name: /^通知/ }).click(); const dialog = page.getByRole("dialog"); await expect(dialog).toContainText("担当・内部メモまたは入力中の予約対応"); await dialog.getByRole("button", { name: "編集を続ける" }).click(); await expect(page.getByRole("textbox", { name: "内部メモ", exact: true })).toHaveValue("case draft");
});

test("invalid DTO is shown honestly without mock fallback", async ({ page }) => {
  const backend = await install(page); backend.invalidSnapshot = true; await signIn(page); await open(page); await expect(page.getByRole("alert").filter({ hasText: "確認結果を安全に読み取れません" })).toContainText("確認結果を安全に読み取れません"); await expect(page.getByRole("button", { name: /最新の予約情報を確認して/ })).toHaveCount(0);
});


test("tracking URL updates preserve the immutable message while its response is pending", async ({ page }) => {
  const backend = await install(page);
  backend.postGate = new Promise<void>((resolve) => { backend.releasePost = resolve; });
  await signIn(page); await open(page);
  await page.getByRole("combobox", { name: "予約対応", exact: true }).selectOption("MESSAGE");
  await page.getByRole("combobox", { name: "定型理由" }).selectOption("BOOKING_DETAILS");
  await page.getByRole("textbox", { name: "件名" }).fill("連絡内容を保持");
  await page.getByRole("textbox", { name: "旅行者に届く本文" }).fill("当日は集合場所の案内をご確認ください。");
  await page.getByRole("button", { name: /最新の予約情報を確認して予約者への連絡へ/ }).click();
  await page.getByRole("dialog").getByRole("button", { name: /この内容で予約者への連絡/ }).click();
  await expect.poll(() => backend.posts.length).toBe(1);
  await expect(page).toHaveURL(new RegExp(`operation=${backend.posts[0]!.command.operationId}`));
  await expect(page.getByRole("textbox", { name: "件名" })).toHaveValue("連絡内容を保持");
  expect(backend.operationGets).toHaveLength(0);
  backend.releasePost?.();
  await expect(page.getByText(/完了/).last()).toBeVisible();
  expect(backend.posts).toHaveLength(1);
});
