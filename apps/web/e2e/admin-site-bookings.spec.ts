import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";

/*
 * サイト予約 (#121/#128): /admin/site-bookings with ADMIN_SITE_BOOKINGS_PREVIEW_ENABLED (mock mode). The page draws
 * synthetic fixtures (src/admin/site-bookings-preview.ts); every API call of the browser is stubbed here, so nothing
 * reaches a store, Stripe or an email.
 */

const IDS = {
  confirmed: "0f8fad5b-d9cb-469f-a165-708677289501",
  review: "1b4e28ba-2fa1-41d2-883f-0016d3cca427",
  cancelled: "6fa459ea-ee8a-4ca4-894e-db77e160355e",
  more: "3d813cbb-47fb-4ba7-a0f6-6f0e1b2c3d4e",
  off: "5c9e1a2b-3d4f-4e6a-8b7c-9d0e1f2a3b4c",
  lookupOnly: "7a1b2c3d-4e5f-4a6b-9c8d-7e6f5a4b3c2d",
  // The synthetic queue of the page (src/admin/site-bookings-preview.ts): a cancellation request, a payment to check, a failed refund.
  request: "16fd2706-8baf-433b-82eb-8c7fada847da",
  paymentReview: "2c8e3f4a-5b6d-4c7e-8f9a-0b1c2d3e4f50",
  refundBooking: "4e9a1b2c-6d7f-4a8b-9c0d-1e2f3a4b5c6d",
  refund: "a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
  notificationUnread: "7d1e2f3a-4b5c-4d6e-8f70-a1b2c3d4e5f6",
} as const;
const SNAPSHOT = "b".repeat(64);

const row = (publicBookingId: string, overrides: Record<string, unknown> = {}) => ({
  publicBookingId, providerId: "provider-sample", experienceTitle: "Synthetic indigo dyeing", status: "CONFIRMED", localDate: "2026-12-05",
  localStartTime: "10:00", timeZone: "Asia/Tokyo", startUtc: "2026-12-05T01:00:00.000Z", guestName: "Sample Guest A", totalAmount: 12000,
  currency: "JPY", cancellationPolicy: "FREE_UNTIL_48H", cancellationRefundBasisPoints: 10000, freeCancellationUntilUtc: "2026-12-03T01:00:00.000Z",
  supportEligible: true, ...overrides,
});

interface Backend {
  /** The answer to the next financial POST: ok, a conflict, or the session gone. */
  nextSend: "ok" | "conflict" | "session";
  /** The answer to the next contact POST: sent, or the server unavailable (the result is then unknown). */
  nextContact: "ok" | "unavailable";
  contacts: Record<string, unknown>[];
  sends: Record<string, unknown>[];
  previews: Record<string, unknown>[];
  notificationReads: Record<string, unknown>[];
  caseSaves: Record<string, unknown>[];
  bookingQueries: string[];
  cancelled: Set<string>;
  caseRevision: number;
  memo: string | null;
  assignee: string | null;
}

const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: "application/json", headers: { "cache-control": "private, no-store" }, body: JSON.stringify(body) });

async function installStubs(page: Page): Promise<Backend> {
  const backend: Backend = { nextSend: "ok", nextContact: "ok", contacts: [], sends: [], previews: [], notificationReads: [], caseSaves: [], bookingQueries: [], cancelled: new Set(), caseRevision: 0, memo: null, assignee: null };
  const current = (id: string) => {
    const known: Record<string, ReturnType<typeof row>> = {
      [IDS.confirmed]: row(IDS.confirmed),
      [IDS.lookupOnly]: row(IDS.lookupOnly, { guestName: "Sample Guest F", experienceTitle: "Synthetic pottery", localDate: "2027-01-10" }),
      [IDS.more]: row(IDS.more, { guestName: "Sample Guest E", experienceTitle: "Synthetic river walk", localDate: "2026-11-30" }),
      [IDS.request]: row(IDS.request, { guestName: "Sample Guest D", experienceTitle: "Synthetic tea ceremony" }),
      [IDS.paymentReview]: row(IDS.paymentReview, { guestName: "Sample Guest G", experienceTitle: "Synthetic mountain hike", status: "PAYMENT_REVIEW" }),
      [IDS.refundBooking]: row(IDS.refundBooking, { guestName: "Sample Guest H", experienceTitle: "Synthetic pottery class" }),
    };
    const found = known[id];
    return found && backend.cancelled.has(id) ? { ...found, status: "CANCELLED" } : found;
  };
  await page.route("**/admin/api/support-admins", (route) => json(route, 200, { admins: [{ id: "admin-preview-1", displayName: "合成 管理者A" }], truncated: false }));
  await page.route("**/admin/api/site-bookings**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    if (url.pathname === "/admin/api/site-bookings/bookings" && method === "GET") {
      backend.bookingQueries.push(url.search);
      const id = url.searchParams.get("publicBookingId");
      if (id) {
        const found = current(id);
        return json(route, 200, { bookings: found ? [found] : [], nextCursor: null });
      }
      if (url.searchParams.get("cursor") === IDS.cancelled) {
        // A row that is not support ON never shows, even if an answer carried one.
        return json(route, 200, { bookings: [current(IDS.more), row(IDS.off, { guestName: "Sample Guest Off", supportEligible: false })], nextCursor: null });
      }
      return json(route, 400, { error: "invalid_input" });
    }
    if (url.pathname === "/admin/api/site-bookings/case") {
      if (method === "GET") {
        return json(route, 200, { case: backend.caseRevision === 0 ? null : { publicBookingId: url.searchParams.get("publicBookingId"), assignedAdminUserId: backend.assignee, internalMemo: backend.memo, revision: backend.caseRevision, updatedBy: "admin-preview-1", updatedAtUtc: "2026-11-06T01:00:00.000Z", events: [] }, currentAdminUserId: "admin-preview-1" });
      }
      const body = request.postDataJSON() as Record<string, unknown>;
      backend.caseSaves.push(body);
      backend.caseRevision += 1;
      backend.memo = body.internalMemo as string | null;
      backend.assignee = body.assignedAdminUserId as string | null;
      return json(route, 200, {
        case: { publicBookingId: body.publicBookingId, assignedAdminUserId: backend.assignee, internalMemo: backend.memo, revision: backend.caseRevision, updatedBy: "admin-preview-1", updatedAtUtc: "2026-11-06T01:00:00.000Z", events: [{ type: "INTERNAL_MEMO_CHANGED", revision: backend.caseRevision, actorAdminUserId: "admin-preview-1", occurredAtUtc: "2026-11-06T01:00:00.000Z", commandId: body.commandId, delivery: null }] },
        currentAdminUserId: "admin-preview-1",
      });
    }
    if (url.pathname === "/admin/api/site-bookings/preview" && method === "POST") {
      const body = request.postDataJSON() as Record<string, unknown>;
      backend.previews.push(body);
      // A refund's action names the refund, not the booking.
      const target = body.publicBookingId ? current(String(body.publicBookingId)) : current(IDS.refundBooking);
      if (!target) return json(route, 404, { error: "not_found" });
      return json(route, 200, {
        action: body.action, expectedSnapshot: SNAPSHOT, publicBookingId: target.publicBookingId, providerId: target.providerId, experienceTitle: target.experienceTitle,
        startUtc: target.startUtc, bookingStatus: "CONFIRMED", bookingStatusAfter: "CANCELLED", refundAmount: target.totalAmount, currency: "JPY", cancellationRequestStatus: null,
      });
    }
    if (url.pathname === "/admin/api/site-bookings/notifications") {
      backend.notificationReads.push(request.postDataJSON() as Record<string, unknown>);
      return json(route, 200, { ok: true });
    }
    if (url.pathname === "/admin/api/site-bookings" && method === "GET") return json(route, 200, { cancellationRequests: [], paymentReviews: [], refunds: [] });
    if (url.pathname === "/admin/api/site-bookings" && method === "POST") {
      const body = request.postDataJSON() as Record<string, unknown>;
      if (body.action === "CONTACT_GUEST") {
        backend.contacts.push(body);
        const contactOutcome = backend.nextContact;
        backend.nextContact = "ok";
        return contactOutcome === "unavailable" ? json(route, 503, { error: "unavailable" }) : json(route, 200, { outcome: "CONTACT_SENT", repeated: false });
      }
      backend.sends.push(body);
      const outcome = backend.nextSend;
      backend.nextSend = "ok";
      if (outcome === "session") return json(route, 401, { error: "unauthenticated" });
      if (outcome === "conflict") return json(route, 409, { error: "conflict" });
      const stubbed = { DECLINE_REQUEST: "DECLINED", RETRY_REFUND: "REFUND_RETRIED", CLOSE_REFUND: "REFUND_CLOSED" } as Record<string, string>;
      const resultOutcome = stubbed[String(body.action)];
      if (resultOutcome) return json(route, 200, { outcome: resultOutcome, repeated: false, bookingIds: [], refunds: [] });
      backend.cancelled.add(String(body.publicBookingId));
      return json(route, 200, { outcome: "CANCELLED", repeated: false, bookingIds: [body.publicBookingId], refunds: [{ refundId: "8b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e", status: "PENDING" }] });
    }
    return json(route, 404, { error: "not_found" });
  });
  return backend;
}

async function openPage(page: Page): Promise<Backend> {
  const backend = await installStubs(page);
  await page.goto("/admin");
  await page.getByRole("button", { name: "合成Adminとして開く" }).click();
  await page.waitForURL(/\/admin\/bookings/);
  await page.getByRole("link", { name: "予約", exact: true }).click();
  await page.waitForURL(/\/admin\/site-bookings/);
  await expect(page.getByRole("tab", { name: /^要対応/ })).toBeVisible();
  return backend;
}

// PC (1280px) shows the list and the opened booking side by side; a phone shows one at a time.
const sideBySide = (page: Page) => (page.viewportSize()?.width ?? 0) >= 1280;
const tabOf = (page: Page, name: string) => page.getByRole("tab", { name: new RegExp(`^${name}`) });
const todoList = (page: Page) => page.getByRole("list", { name: "要対応の予約" });
const supportList = (page: Page) => page.getByRole("list", { name: "サポートONの予約一覧" });
/** The opened booking: of all the faces the page keeps, the one that is shown. */
const opened = (page: Page) => page.getByRole("article");
const dialogOf = (page: Page) => page.getByRole("dialog");
const searchBox = (page: Page) => page.getByRole("textbox", { name: "予約番号", exact: true });

async function backToList(page: Page) {
  const back = page.getByRole("button", { name: "一覧", exact: true });
  if (await back.isVisible()) await back.click();
}

async function expectNoAxeViolations(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(results.violations.map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(" ")).join(", ")}`)).toEqual([]);
}

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

/** The support-ON list (すべて), and one of its rows opened. */
async function openSupportRow(page: Page, needle: string) {
  await tabOf(page, "すべて").click();
  await supportList(page).getByRole("listitem").filter({ hasText: needle }).getByRole("button").click();
}

test("lists only support-ON bookings with their state, loads more, and stays readable and accessible", async ({ page }) => {
  const backend = await openPage(page);
  await tabOf(page, "すべて").click();
  const list = supportList(page);
  const rowFor = (needle: string) => list.getByRole("listitem").filter({ hasText: needle });
  await expect(list.getByRole("listitem")).toHaveCount(3);
  await expect(rowFor("2026-12-05")).toContainText("確定");
  await expect(rowFor("2026-12-06")).toContainText("確認待ち");
  await expect(rowFor("2026-12-07")).toContainText("取消済み");
  await expectNoHorizontalScroll(page);
  await expectNoAxeViolations(page);

  // Only a confirmed booking offers support's cancellation.
  await rowFor("2026-12-05").getByRole("button").click();
  await expect(opened(page).getByRole("button", { name: "この予約を取り消す" })).toBeVisible();
  await expectNoHorizontalScroll(page);
  await expectNoAxeViolations(page);
  await backToList(page);
  await rowFor("2026-12-06").getByRole("button").click();
  await expect(opened(page).getByRole("button", { name: "この予約を取り消す" })).toHaveCount(0);
  await backToList(page);
  await rowFor("2026-12-07").getByRole("button").click();
  await expect(opened(page).getByRole("button", { name: "この予約を取り消す" })).toHaveCount(0);
  await backToList(page);

  await page.getByRole("button", { name: "もっと見る" }).click();
  await expect(list.getByRole("listitem")).toHaveCount(4);
  await expect(rowFor("Sample Guest E")).toBeVisible();
  await expect(page.getByText("Sample Guest Off")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "もっと見る" })).toHaveCount(0);
  expect(backend.bookingQueries).toEqual([`?cursor=${IDS.cancelled}`]);
  await expectNoHorizontalScroll(page);
});

test("opens a booking's case from its row by keyboard and saves the assignee and internal memo", async ({ page }) => {
  const backend = await openPage(page);
  await openSupportRow(page, "2026-12-05");
  const target = opened(page);
  const summary = target.locator("summary").filter({ hasText: "案件" });
  await summary.focus();
  await page.keyboard.press("Enter");
  const memo = target.getByRole("textbox", { name: /内部メモ/ });
  await expect(memo).toBeVisible();
  await target.getByRole("combobox", { name: "担当Admin" }).selectOption("admin-preview-1");
  await memo.fill("合成の内部メモ");
  await target.getByRole("button", { name: "案件情報を保存" }).click();
  await expect(target.getByRole("status").filter({ hasText: "担当・内部メモを保存しました。" })).toBeVisible();
  expect(backend.caseSaves).toHaveLength(1);
  expect(backend.caseSaves[0]).toMatchObject({ publicBookingId: IDS.confirmed, expectedRevision: 0, assignedAdminUserId: "admin-preview-1", internalMemo: "合成の内部メモ" });
  await expectNoAxeViolations(page);
  await expectNoHorizontalScroll(page);
});

test("opens a booking by its number, and says when it is malformed or not a support-ON booking", async ({ page }) => {
  const backend = await openPage(page);
  const input = searchBox(page);
  await input.fill("not-a-booking");
  await input.press("Enter");
  await expect(page.getByText("予約番号の形式が違います")).toBeVisible();
  expect(backend.bookingQueries).toEqual([]);

  // A number that is not a support-ON booking still opens a face of its own, from which it can be cancelled.
  await input.fill(IDS.off);
  await input.press("Enter");
  const face = page.getByRole("article", { name: `予約 ${IDS.off}` });
  await expect(face).toBeVisible();
  await expect(face.getByText("サポートONで受け付けた予約に、この予約番号はありません。")).toBeVisible();
  await expect(face.getByText("案件", { exact: true })).toHaveCount(0);
  await face.getByRole("button", { name: "この予約を取り消す" }).click();
  await expect(dialogOf(page).getByRole("heading", { name: `予約 ${IDS.off} を取り消します` })).toBeVisible();
  await dialogOf(page).getByRole("button", { name: "最新の状態と金額を確認" }).click();
  await expect(dialogOf(page).getByText("予約が見つかりませんでした")).toBeVisible();
  expect(backend.previews).toEqual([{ action: "CANCEL", publicBookingId: IDS.off, refund: { kind: "FULL" } }]);
  await dialogOf(page).getByRole("button", { name: "やめる" }).click();
  await expect(dialogOf(page)).toHaveCount(0);

  await input.fill(IDS.lookupOnly);
  await input.press("Enter");
  const found = opened(page);
  await expect(found).toContainText("Sample Guest F");
  await expect(found.getByText("案件", { exact: true })).toBeVisible();
  expect(backend.bookingQueries).toEqual([`?publicBookingId=${IDS.off}`, `?publicBookingId=${IDS.lookupOnly}`]);
  await expectNoAxeViolations(page);
  await expectNoHorizontalScroll(page);
});

test("keeps the opened booking, and opens no other, while a contact's result is unknown", async ({ page }) => {
  const backend = await openPage(page);
  const input = searchBox(page);
  await input.fill(IDS.lookupOnly);
  await input.press("Enter");
  const found = opened(page);
  await found.getByText("案件", { exact: true }).click();
  await found.getByRole("textbox", { name: /予約者へNIHOサポートから連絡/ }).fill("Synthetic contact text");

  // The server cannot say whether the contact was sent: the command must be repeated from this very panel.
  backend.nextContact = "unavailable";
  await found.getByRole("button", { name: "NIHOサポートとして連絡" }).click();
  const retry = found.getByRole("button", { name: "同じ連絡を再試行" });
  await expect(retry).toBeVisible();
  // Choosing another booking would replace this panel and lose the command and the lock's owner, locking the screen until a reload.
  await expect(input).toBeDisabled();
  await expect(page.getByText("いまの操作（結果の確認を含む）を終えるまで、別の予約は開けません。")).toBeVisible();
  await expect(found).toContainText("Sample Guest F");
  await expectNoAxeViolations(page);
  await expectNoHorizontalScroll(page);
  if (!sideBySide(page)) {
    await expect(page.getByRole("button", { name: "一覧", exact: true })).toBeDisabled();
  } else {
    await expect(tabOf(page, "要対応")).toBeDisabled();
    await expect(tabOf(page, "すべて")).toBeDisabled();
    await expect(todoList(page).getByRole("button").first()).toBeDisabled();
  }

  // The same command goes again from the same panel; once it is settled the search opens again.
  await retry.click();
  await expect(input).toBeEnabled();
  if (sideBySide(page)) await expect(tabOf(page, "すべて")).toBeEnabled();
  else await expect(page.getByRole("button", { name: "一覧", exact: true })).toBeEnabled();
  expect(backend.contacts).toHaveLength(2);
  expect(backend.contacts[1]!.commandId).toBe(backend.contacts[0]!.commandId);
  expect(backend.contacts[1]!.message).toBe("Synthetic contact text");
});

test("cancels from the opened booking in two steps, asks to check again after a conflict, and shows the new state", async ({ page }) => {
  const backend = await openPage(page);
  await openSupportRow(page, "2026-12-05");
  await opened(page).getByRole("button", { name: "この予約を取り消す" }).click();
  const dialog = dialogOf(page);
  await expect(dialog.getByRole("heading", { name: `予約 ${IDS.confirmed} を取り消します` })).toBeVisible();
  await dialog.getByRole("combobox", { name: "取消理由" }).selectOption("HOST_UNAVAILABLE");
  await dialog.getByRole("textbox", { name: /メモ（任意/ }).fill("合成の取消メモ");
  await expectNoAxeViolations(page);
  await expectNoHorizontalScroll(page);

  await dialog.getByRole("button", { name: "最新の状態と金額を確認" }).click();
  await expect(dialog.getByText("最新の状態と金額", { exact: true })).toBeVisible();
  await expect(dialog).toContainText("今回の返金 ¥12,000");
  expect(backend.previews).toEqual([{ action: "CANCEL", publicBookingId: IDS.confirmed, refund: { kind: "FULL" } }]);
  // While this cancellation is open, no other operation can start.
  await expect(page.locator('input[aria-label="予約番号"]')).toBeDisabled();

  backend.nextSend = "conflict";
  await dialog.getByRole("button", { name: "取り消して返金する" }).click();
  await expect(dialog.getByText("状態または返金額が確認後に変わりました。最新の状態と金額をもう一度確認してください。")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "最新の状態と金額を確認" })).toBeVisible();

  await dialog.getByRole("button", { name: "最新の状態と金額を確認" }).click();
  await dialog.getByRole("button", { name: "取り消して返金する" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText(/予約の取消を確認しました/)).toBeVisible();
  expect(backend.sends).toHaveLength(2);
  expect(backend.sends[0]!.commandId).not.toBe(backend.sends[1]!.commandId);
  expect(backend.sends[1]).toMatchObject({ action: "CANCEL", publicBookingId: IDS.confirmed, reason: "HOST_UNAVAILABLE", note: "合成の取消メモ", refund: { kind: "FULL" }, expectedSnapshot: SNAPSHOT });
  await expect(opened(page)).toContainText("取消済み");
  await expect(opened(page).getByRole("button", { name: "この予約を取り消す" })).toHaveCount(0);
});

test("a lost session clears the lists, the case and what was typed", async ({ page }) => {
  const backend = await openPage(page);
  await searchBox(page).fill(IDS.lookupOnly);
  await openSupportRow(page, "2026-12-05");
  await opened(page).getByRole("button", { name: "この予約を取り消す" }).click();
  const dialog = dialogOf(page);
  await dialog.getByRole("combobox", { name: "取消理由" }).selectOption("WEATHER");
  await dialog.getByRole("button", { name: "最新の状態と金額を確認" }).click();
  backend.nextSend = "session";
  await dialog.getByRole("button", { name: "取り消して返金する" }).click();
  await expect(page.getByRole("heading", { name: "Adminの再ログインが必要です" })).toBeVisible();
  await expect(page.getByText("Sample Guest A")).toHaveCount(0);
  await expect(page.getByRole("textbox")).toHaveCount(0);
  await expect(page.getByText(IDS.lookupOnly)).toHaveCount(0);
  await expect(dialogOf(page)).toHaveCount(0);
  await expectNoAxeViolations(page);
});

test("switches between the four lists, with the counts of what waits, and marks the opened row", async ({ page }) => {
  await openPage(page);
  // 取消の依頼 1 + 確認待ちの支払い 1 + 返金 1; one unread notification.
  await expect(tabOf(page, "要対応")).toHaveText("要対応3");
  await expect(tabOf(page, "要対応")).toHaveAttribute("aria-selected", "true");
  await expect(tabOf(page, "すべて")).toHaveText("すべて");
  await expect(tabOf(page, "通知")).toHaveText("通知1");
  await expect(tabOf(page, "精算")).toHaveText("精算");
  await expect(todoList(page).getByRole("listitem")).toHaveCount(3);
  await expect(page.getByText("いま対応が必要なことはありません。")).toHaveCount(0);

  const row = todoList(page).getByRole("listitem").filter({ hasText: "Synthetic mountain hike" });
  await row.getByRole("button").click();
  await expect(opened(page)).toContainText("Synthetic mountain hike");
  await expect(opened(page).getByText("確認待ち", { exact: true })).toBeVisible();
  if (sideBySide(page)) {
    await expect(row.getByRole("button")).toHaveAttribute("aria-current", "true");
    await expect(todoList(page).locator('[aria-current="true"]')).toHaveCount(1);
  } else {
    await expect(todoList(page)).toBeHidden();
    await backToList(page);
  }

  await tabOf(page, "すべて").click();
  await expect(tabOf(page, "すべて")).toHaveAttribute("aria-selected", "true");
  await expect(supportList(page).getByRole("listitem")).toHaveCount(3);
  await expect(todoList(page)).toBeHidden();

  await tabOf(page, "精算").click();
  await expect(page.getByRole("region", { name: "決済費用" })).toBeVisible();
  await expect(page.getByText("照合するExperience予約はありません。")).toBeVisible();
  await expectNoAxeViolations(page);
});

test("marks a notification read", async ({ page }) => {
  const backend = await openPage(page);
  await tabOf(page, "通知").click();
  await expect(page.getByText("予約を受け付けました")).toBeVisible();
  await expect(page.getByText("取消依頼が届きました")).toBeVisible();
  await expect(page.getByText("既読", { exact: true })).toHaveCount(1);
  await page.getByRole("button", { name: "既読にする" }).click();
  await expect(page.getByRole("button", { name: "既読にする" })).toHaveCount(0);
  await expect(page.getByText("既読", { exact: true })).toHaveCount(2);
  await expect(tabOf(page, "通知")).toHaveText("通知");
  expect(backend.notificationReads).toEqual([{ notificationId: IDS.notificationUnread }]);
  await expectNoAxeViolations(page);
});

const QUEUE_ACTIONS = [
  { name: "取消の依頼を承認して返金する", row: "Synthetic tea ceremony", pill: "取消の依頼", button: "取り消して返金する", title: "依頼のとおり取り消します", confirm: "取り消して返金する", action: "APPROVE_REQUEST", preview: { publicBookingId: IDS.request, refund: { kind: "FULL" } }, done: /予約の取消を確認しました/ },
  { name: "取消の依頼をお断りする", row: "Synthetic tea ceremony", pill: "取消の依頼", button: "お断りする", title: "依頼をお断りします（予約は確定のまま）", note: [/予約者へのメッセージ/, "Synthetic decline message"] as const, confirm: "お断りを送る", action: "DECLINE_REQUEST", preview: { publicBookingId: IDS.request }, done: /お断りしました/ },
  { name: "確認待ちの支払いを全額返金して取り消す", row: "Synthetic mountain hike", pill: "確認待ち", button: "全額を返金して取り消す", title: "最新の受領額を全額返金して取り消します", confirm: "返金して取り消す", action: "RESOLVE_PAYMENT_REVIEW", preview: { publicBookingId: IDS.paymentReview }, done: /予約の取消を確認しました/ },
  { name: "失敗した返金をもう一度送る", row: "Synthetic pottery class", pill: "返金", button: "もう一度返金する", title: "対象の返金を Stripe へ送ります", confirm: "送る", action: "RETRY_REFUND", preview: { refundId: IDS.refund }, done: /返金の依頼を受け付けました/ },
  { name: "失敗した返金を手作業で済ませたとして閉じる", row: "Synthetic pottery class", pill: "返金", button: "手作業で済ませた", title: "この返金を一覧から外します（Stripe では返金しません）", note: [/どう済ませたか/, "Synthetic manual note"] as const, confirm: "閉じる", action: "CLOSE_REFUND", preview: { refundId: IDS.refund }, done: /手作業で済んだ返金として閉じました/ },
];

for (const item of QUEUE_ACTIONS) {
  test(`opens the queue item and its dialog in two steps: ${item.name}`, async ({ page }) => {
    const backend = await openPage(page);
    await todoList(page).getByRole("listitem").filter({ hasText: item.row }).getByRole("button").click();
    const face = opened(page);
    await expect(face).toContainText(item.row);
    await expect(face.getByText(item.pill, { exact: true })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await face.getByRole("button", { name: item.button, exact: true }).click();

    const dialog = dialogOf(page);
    await expect(dialog.getByRole("heading", { name: item.title })).toBeVisible();
    if (item.note) await dialog.getByRole("textbox", { name: item.note[0] }).fill(item.note[1]);
    await expectNoAxeViolations(page);
    await dialog.getByRole("button", { name: "最新の状態と金額を確認" }).click();
    await expect(dialog.getByText("最新の状態と金額", { exact: true })).toBeVisible();
    expect(backend.previews).toEqual([{ action: item.action, ...item.preview }]);
    await dialog.getByRole("button", { name: item.confirm, exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText(item.done)).toBeVisible();
    expect(backend.sends).toHaveLength(1);
    expect(backend.sends[0]).toMatchObject({ action: item.action, ...item.preview, expectedSnapshot: SNAPSHOT });
    if (item.note) expect(JSON.stringify(backend.sends[0])).toContain(item.note[1]);
  });
}

test("Esc in the dialog is the same as やめる, and nothing is sent", async ({ page }) => {
  const backend = await openPage(page);
  await todoList(page).getByRole("listitem").filter({ hasText: "Synthetic mountain hike" }).getByRole("button").click();
  await opened(page).getByRole("button", { name: "全額を返金して取り消す" }).click();
  await expect(dialogOf(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialogOf(page)).toHaveCount(0);
  await expect(opened(page).getByRole("button", { name: "全額を返金して取り消す" })).toBeEnabled();
  await expect(searchBox(page)).toBeEnabled();
  expect(backend.previews).toEqual([]);
  expect(backend.sends).toEqual([]);
});

test("a phone opens the list, then one booking, then goes back; a PC shows the first booking beside the list", async ({ page }) => {
  await openPage(page);
  await expectNoHorizontalScroll(page);
  if (sideBySide(page)) {
    // Nothing chosen: the first of the list is opened on the right.
    await expect(todoList(page)).toBeVisible();
    await expect(opened(page)).toHaveCount(1);
    await expect(opened(page)).toContainText("Synthetic tea ceremony");
    await expect(page.getByRole("button", { name: "一覧", exact: true })).toBeHidden();
    return;
  }
  await expect(todoList(page)).toBeVisible();
  await expect(opened(page)).toHaveCount(0);
  await todoList(page).getByRole("listitem").filter({ hasText: "Synthetic pottery class" }).getByRole("button").click();
  await expect(opened(page)).toContainText("Synthetic pottery class");
  await expect(todoList(page)).toBeHidden();
  await expectNoHorizontalScroll(page);
  await page.getByRole("button", { name: "一覧", exact: true }).click();
  await expect(todoList(page)).toBeVisible();
  await expect(opened(page)).toHaveCount(0);
  await expectNoHorizontalScroll(page);
});
