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
  caseSaves: Record<string, unknown>[];
  bookingQueries: string[];
  cancelled: Set<string>;
  caseRevision: number;
  memo: string | null;
  assignee: string | null;
}

const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: "application/json", headers: { "cache-control": "private, no-store" }, body: JSON.stringify(body) });

async function installStubs(page: Page): Promise<Backend> {
  const backend: Backend = { nextSend: "ok", nextContact: "ok", contacts: [], sends: [], previews: [], caseSaves: [], bookingQueries: [], cancelled: new Set(), caseRevision: 0, memo: null, assignee: null };
  const current = (id: string) => {
    const known: Record<string, ReturnType<typeof row>> = {
      [IDS.confirmed]: row(IDS.confirmed),
      [IDS.lookupOnly]: row(IDS.lookupOnly, { guestName: "Sample Guest F", experienceTitle: "Synthetic pottery", localDate: "2027-01-10" }),
      [IDS.more]: row(IDS.more, { guestName: "Sample Guest E", experienceTitle: "Synthetic river walk", localDate: "2026-11-30" }),
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
      const target = current(String(body.publicBookingId));
      if (!target) return json(route, 404, { error: "not_found" });
      return json(route, 200, {
        action: body.action, expectedSnapshot: SNAPSHOT, publicBookingId: target.publicBookingId, providerId: target.providerId, experienceTitle: target.experienceTitle,
        startUtc: target.startUtc, bookingStatus: "CONFIRMED", bookingStatusAfter: "CANCELLED", refundAmount: target.totalAmount, currency: "JPY", cancellationRequestStatus: null,
      });
    }
    if (url.pathname === "/admin/api/site-bookings/notifications") return json(route, 200, { ok: true });
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
  await expect(page.getByRole("heading", { name: /サポートONの予約/ })).toBeVisible();
  return backend;
}

const supportList = (page: Page) => page.getByRole("list", { name: "サポートONの予約一覧" });
const rowOf = (page: Page, id: string) => supportList(page).getByRole("listitem").filter({ hasText: id });

async function expectNoAxeViolations(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(results.violations.map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(" ")).join(", ")}`)).toEqual([]);
}

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

test("lists only support-ON bookings with their state, loads more, and stays readable and accessible", async ({ page }) => {
  const backend = await openPage(page);
  const list = supportList(page);
  await expect(list.getByRole("listitem")).toHaveCount(3);
  await expect(rowOf(page, IDS.confirmed)).toContainText("確定");
  await expect(rowOf(page, IDS.review)).toContainText("確認待ち");
  await expect(rowOf(page, IDS.cancelled)).toContainText("取消済み");
  // Only a confirmed booking offers support's cancellation.
  await expect(rowOf(page, IDS.confirmed).getByRole("button", { name: "この予約を取り消す" })).toBeVisible();
  await expect(rowOf(page, IDS.review).getByRole("button", { name: "この予約を取り消す" })).toHaveCount(0);
  await expect(rowOf(page, IDS.cancelled).getByRole("button", { name: "この予約を取り消す" })).toHaveCount(0);
  await expectNoHorizontalScroll(page);
  await expectNoAxeViolations(page);

  await page.getByRole("button", { name: "もっと見る" }).click();
  await expect(list.getByRole("listitem")).toHaveCount(4);
  await expect(rowOf(page, IDS.more)).toContainText("Sample Guest E");
  await expect(page.getByText("Sample Guest Off")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "もっと見る" })).toHaveCount(0);
  expect(backend.bookingQueries).toEqual([`?cursor=${IDS.cancelled}`]);
  await expectNoHorizontalScroll(page);
});

test("opens a booking's case from its row by keyboard and saves the assignee and internal memo", async ({ page }) => {
  const backend = await openPage(page);
  const target = rowOf(page, IDS.confirmed);
  const summary = target.getByText("Admin案件 · 担当・内部メモ・操作履歴");
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
  const input = page.getByRole("textbox", { name: "予約番号で開く" });
  await input.fill("not-a-booking");
  await page.getByRole("button", { name: "開く", exact: true }).click();
  await expect(page.getByText("予約番号の形式が違います")).toBeVisible();
  expect(backend.bookingQueries).toEqual([]);

  await input.fill(IDS.off);
  await input.press("Enter");
  await expect(page.getByText("サポートONで受け付けた予約に、この予約番号はありません。")).toBeVisible();

  await input.fill(IDS.lookupOnly);
  await input.press("Enter");
  const opened = page.getByRole("list", { name: "予約番号で開いた予約" });
  await expect(opened).toContainText("Sample Guest F");
  await expect(opened.getByText("Admin案件 · 担当・内部メモ・操作履歴")).toBeVisible();
  expect(backend.bookingQueries).toEqual([`?publicBookingId=${IDS.off}`, `?publicBookingId=${IDS.lookupOnly}`]);
  await expectNoAxeViolations(page);
});

test("keeps the opened booking, and opens no other, while a contact's result is unknown", async ({ page }) => {
  const backend = await openPage(page);
  const input = page.getByRole("textbox", { name: "予約番号で開く" });
  const open = page.getByRole("button", { name: "開く", exact: true });
  await input.fill(IDS.lookupOnly);
  await input.press("Enter");
  const opened = page.getByRole("list", { name: "予約番号で開いた予約" });
  await opened.getByText("Admin案件 · 担当・内部メモ・操作履歴").click();
  await opened.getByRole("textbox", { name: /予約者へNIHOサポートから連絡/ }).fill("Synthetic contact text");

  // The server cannot say whether the contact was sent: the command must be repeated from this very panel.
  backend.nextContact = "unavailable";
  await opened.getByRole("button", { name: "NIHOサポートとして連絡" }).click();
  const retry = opened.getByRole("button", { name: "同じ連絡を再試行" });
  await expect(retry).toBeVisible();
  // Searching again would replace this panel and lose the command and the lock's owner, locking the screen until a reload.
  await expect(input).toBeDisabled();
  await expect(open).toBeDisabled();
  await expect(page.getByText("いまの操作（結果の確認を含む）を終えるまで、別の予約は開けません。")).toBeVisible();
  await expect(opened).toContainText("Sample Guest F");
  await expectNoAxeViolations(page);
  await expectNoHorizontalScroll(page);

  // The same command goes again from the same panel; once it is settled the search opens again.
  await retry.click();
  await expect(input).toBeEnabled();
  await expect(open).toBeEnabled();
  expect(backend.contacts).toHaveLength(2);
  expect(backend.contacts[1]!.commandId).toBe(backend.contacts[0]!.commandId);
  expect(backend.contacts[1]!.message).toBe("Synthetic contact text");
});

test("cancels from a row in two steps, asks to check again after a conflict, and shows the new state", async ({ page }) => {
  const backend = await openPage(page);
  const target = rowOf(page, IDS.confirmed);
  await target.getByRole("button", { name: "この予約を取り消す" }).click();
  await target.getByRole("combobox", { name: "取消理由" }).selectOption("HOST_UNAVAILABLE");
  await target.getByRole("textbox", { name: /メモ（任意/ }).fill("合成の取消メモ");
  await expectNoAxeViolations(page);
  await expectNoHorizontalScroll(page);

  await target.getByRole("button", { name: "最新の状態と金額を確認" }).click();
  await expect(target.getByText("最新の状態と金額", { exact: true })).toBeVisible();
  await expect(target).toContainText("今回の返金 ¥12,000");
  expect(backend.previews).toEqual([{ action: "CANCEL", publicBookingId: IDS.confirmed, refund: { kind: "FULL" } }]);
  // While this cancellation is open, no other operation can start.
  await expect(page.getByRole("textbox", { name: "予約番号", exact: true })).toBeDisabled();

  backend.nextSend = "conflict";
  await target.getByRole("button", { name: "取り消して返金する" }).click();
  await expect(page.getByText("状態または返金額が確認後に変わりました。最新の状態と金額をもう一度確認してください。")).toBeVisible();
  await expect(target.getByRole("button", { name: "最新の状態と金額を確認" })).toBeVisible();

  await target.getByRole("button", { name: "最新の状態と金額を確認" }).click();
  await target.getByRole("button", { name: "取り消して返金する" }).click();
  await expect(page.getByText(/予約の取消を確認しました/)).toBeVisible();
  expect(backend.sends).toHaveLength(2);
  expect(backend.sends[0]!.commandId).not.toBe(backend.sends[1]!.commandId);
  expect(backend.sends[1]).toMatchObject({ action: "CANCEL", publicBookingId: IDS.confirmed, reason: "HOST_UNAVAILABLE", note: "合成の取消メモ", refund: { kind: "FULL" }, expectedSnapshot: SNAPSHOT });
  await expect(rowOf(page, IDS.confirmed)).toContainText("取消済み");
  await expect(rowOf(page, IDS.confirmed).getByRole("button", { name: "この予約を取り消す" })).toHaveCount(0);
});

test("a lost session clears the lists, the case and what was typed", async ({ page }) => {
  const backend = await openPage(page);
  await page.getByRole("textbox", { name: "予約番号で開く" }).fill(IDS.lookupOnly);
  const target = rowOf(page, IDS.confirmed);
  await target.getByRole("button", { name: "この予約を取り消す" }).click();
  await target.getByRole("combobox", { name: "取消理由" }).selectOption("WEATHER");
  await target.getByRole("button", { name: "最新の状態と金額を確認" }).click();
  backend.nextSend = "session";
  await target.getByRole("button", { name: "取り消して返金する" }).click();
  await expect(page.getByRole("heading", { name: "Adminの再ログインが必要です" })).toBeVisible();
  await expect(page.getByText("Sample Guest A")).toHaveCount(0);
  await expect(page.getByRole("textbox")).toHaveCount(0);
  await expect(page.getByText(IDS.lookupOnly)).toHaveCount(0);
  await expectNoAxeViolations(page);
});
