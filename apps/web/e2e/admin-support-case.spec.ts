import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";

const support = { kind: "valid" as const, snapshot: { policyVersion: "2026-10-23" as const, enabled: true, baseRateBps: 1000 as const, supportRateBps: 500 as const, totalRateBps: 1500 as const, consentVersion: "2026-10-23" as const, consentedAt: "2026-10-23T01:00:00.000Z", consentedByUserId: "admin-1", agreementRevision: 2 }, normalOperationsAllowed: true };
const bookings = [
  { id: "booking-a", host: { kind: "EXPERIENCE_PROVIDER" as const, id: "provider-1", displayName: "合成工房", vesselSpotId: "spot-vessel" }, pageId: "page-a", experienceTitle: "合成の染め物", offerName: "午前", occurrenceDate: "2026-11-03", startAt: "2026-11-03T01:00:00.000Z", endAt: "2026-11-03T03:00:00.000Z", headCount: 2, totalYen: 12000, guestName: "Synthetic Guest A", status: "PENDING" as const, support, needsAttention: true, createdAt: "2026-10-23T04:00:00.000Z" },
  { id: "booking-b", host: { kind: "SPOT" as const, id: "spot-1", displayName: "合成拠点" }, pageId: "page-b", experienceTitle: "合成の散策", offerName: "午後", occurrenceDate: "2026-11-04", startAt: "2026-11-04T04:00:00.000Z", endAt: "2026-11-04T06:00:00.000Z", headCount: 1, totalYen: 6000, guestName: "Synthetic Guest B", status: "PENDING" as const, support, needsAttention: false, createdAt: "2026-10-23T03:00:00.000Z" },
];

function bookingDetail(id: string) {
  const source = bookings.find((item) => item.id === id)!;
  return { booking: { id: source.id, offerId: `offer-${id}`, offerName: source.offerName, occurrenceDate: source.occurrenceDate, startAt: source.startAt, endAt: source.endAt, headCount: source.headCount, adultCount: source.headCount, childCount: 0, guestName: source.guestName, guestEmail: "synthetic@example.invalid", languageSnapshot: "ja", note: null, answers: [], status: source.status, unitPriceYen: 6000, adultPriceYen: 6000, childPriceYen: null, totalYen: source.totalYen, paidAt: null, authorizedAt: source.createdAt, approvalDeadlineAt: null, travelerCancelRequestedAt: null, cancelledAt: null, cancelReason: null, cancelMessage: null, refundedYen: 0, createdAt: source.createdAt, salesChannel: "SYNTHETIC", hostMessages: [], pageId: source.pageId, page: { title: source.experienceTitle }, host: source.host, support: source.support }, supportAgreement: { agreementRevision: 2, sharedConsultationMemo: "ホストと共有する合成相談", matchesBookingSnapshot: true } };
}

type Assignment = { status: "ACTIVE"; id: string; displayName: string | null } | { status: "UNASSIGNED" | "UNAVAILABLE" };
interface CaseValue { bookingRequestId: string; assignedAdmin: Assignment; internalMemo: string | null; revision: number; createdAt: string | null; updatedAt: string | null }
type WriteReason = "WRITES_DISABLED" | "SUPPORT_OFF" | "SUPPORT_LEGACY" | "SUPPORT_INVALID" | "PII_RETENTION_EXPIRED";
interface CaseReply { status: number; delay?: number }
interface Backend {
  cases: Map<string, CaseValue>;
  writable: Map<string, { writable: true; reason: null } | { writable: false; reason: WriteReason }>;
  roster: { admins: { id: string; displayName: string | null }[]; truncated: boolean };
  rosterStatus: number;
  nextCaseStatus: number;
  nextPatch: "ok" | "unavailable" | "revision" | "assignee" | "permission" | "session";
  nextPermissionReason: WriteReason;
  caseDelay: Map<string, number>;
  caseReplies: Map<string, CaseReply[]>;
  patchGate: Promise<void> | null;
  patches: Record<string, unknown>[];
}

const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

async function installStubs(page: Page): Promise<Backend> {
  const backend: Backend = {
    cases: new Map([
      ["booking-a", { bookingRequestId: "booking-a", assignedAdmin: { status: "ACTIVE", id: "admin-1", displayName: "合成 管理者A" }, internalMemo: "Aの保存済みメモ", revision: 1, createdAt: "2026-10-23T01:00:00.000Z", updatedAt: "2026-10-23T02:00:00.000Z" }],
      ["booking-b", { bookingRequestId: "booking-b", assignedAdmin: { status: "ACTIVE", id: "outside-admin", displayName: "候補外の現担当" }, internalMemo: "Bの保存済みメモ", revision: 2, createdAt: "2026-10-23T01:00:00.000Z", updatedAt: "2026-10-23T02:00:00.000Z" }],
    ]),
    writable: new Map([
      ["booking-a", { writable: true, reason: null }],
      ["booking-b", { writable: true, reason: null }],
    ]),
    roster: { admins: [{ id: "admin-1", displayName: "合成 管理者A" }, { id: "admin-2", displayName: "合成 管理者B" }], truncated: false },
    rosterStatus: 200,
    nextCaseStatus: 200,
    nextPatch: "ok",
    nextPermissionReason: "SUPPORT_OFF",
    caseDelay: new Map(),
    caseReplies: new Map(),
    patchGate: null,
    patches: [],
  };

  await page.route("**/admin/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/admin/api/bookings" && request.method() === "POST") return json(route, 200, { bookings, nextCursor: null });
    if (url.pathname === "/admin/api/notifications") return json(route, 200, { notifications: [], unreadCount: 0, nextCursor: null });
    if (url.pathname === "/admin/api/support-admins") {
      return json(route, backend.rosterStatus, backend.rosterStatus === 200 ? backend.roster : { error: "unavailable" });
    }
    const match = url.pathname.match(/^\/admin\/api\/bookings\/([^/]+)(\/support-case)?$/);
    if (!match) return json(route, 404, { error: "not_found" });
    const id = decodeURIComponent(match[1]!);
    if (!match[2]) return json(route, bookings.some((item) => item.id === id) ? 200 : 404, bookings.some((item) => item.id === id) ? bookingDetail(id) : { error: "not_found" });
    if (request.method() === "GET") {
      const queued = backend.caseReplies.get(id)?.shift();
      const status = queued?.status ?? backend.nextCaseStatus;
      if (!queued) backend.nextCaseStatus = 200;
      const delay = queued?.delay ?? backend.caseDelay.get(id) ?? 0;
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      if (status !== 200) return json(route, status, { error: status === 401 ? "signed_out" : "unavailable" });
      return json(route, 200, { supportCase: backend.cases.get(id), writeCapability: backend.writable.get(id) });
    }
    const patch = request.postDataJSON() as Record<string, unknown>;
    backend.patches.push(patch);
    if (backend.patchGate) await backend.patchGate;
    const outcome = backend.nextPatch;
    backend.nextPatch = "ok";
    if (outcome === "session") return json(route, 401, { error: "signed_out" });
    if (outcome === "unavailable") return json(route, 503, { error: "unavailable" });
    if (outcome === "revision") {
      const current = backend.cases.get(id)!;
      backend.cases.set(id, { ...current, assignedAdmin: { status: "ACTIVE", id: "admin-2", displayName: "合成 管理者B" }, internalMemo: "別の管理者が保存したメモ", revision: current.revision + 1, updatedAt: "2026-10-23T03:00:00.000Z" });
      return json(route, 409, { error: "conflict", reason: "REVISION_CONFLICT" });
    }
    if (outcome === "assignee") return json(route, 409, { error: "conflict", reason: "ASSIGNED_ADMIN_UNAVAILABLE" });
    const current = backend.cases.get(id)!;
    if (patch.expectedRevision !== current.revision) return json(route, 409, { error: "conflict", reason: "REVISION_CONFLICT" });
    if (outcome === "permission") {
      backend.writable.set(id, { writable: false, reason: backend.nextPermissionReason });
      return json(route, 409, { error: "conflict", reason: backend.nextPermissionReason });
    }
    const next: CaseValue = {
      ...current,
      revision: current.revision + 1,
      createdAt: current.createdAt ?? "2026-10-23T03:00:00.000Z",
      updatedAt: "2026-10-23T03:00:00.000Z",
      assignedAdmin: Object.hasOwn(patch, "assignedAdminUserId")
        ? patch.assignedAdminUserId === null ? { status: "UNASSIGNED" } : { status: "ACTIVE", id: String(patch.assignedAdminUserId), displayName: backend.roster.admins.find((item) => item.id === patch.assignedAdminUserId)?.displayName ?? null }
        : current.assignedAdmin,
      internalMemo: Object.hasOwn(patch, "internalMemo") ? patch.internalMemo === null ? null : String(patch.internalMemo).replace(/\r\n?/g, "\n").trim() || null : current.internalMemo,
    };
    backend.cases.set(id, next);
    return json(route, 200, { supportCase: next });
  });
  return backend;
}

async function signIn(page: Page) {
  await page.goto("/admin");
  await page.getByRole("button", { name: "合成Adminとして開く" }).click();
  await page.waitForURL(/\/admin\/bookings/);
}

async function openBooking(page: Page, name = "Synthetic Guest A") {
  await page.getByRole("button", { name: new RegExp(name) }).click();
  await expect(page.getByRole("region", { name: "NIHO事務局の内部メモ" })).toBeVisible();
}

async function cancelReloadWithDraft(page: Page) {
  const prompt = page.waitForEvent("dialog");
  // Dismissing beforeunload cancels the navigation. Bound that cancelled request
  // separately so it cannot consume the whole test's timeout before asserting the draft.
  const reload = page.reload({ timeout: 1_500, waitUntil: "commit" }).catch(() => undefined);
  const dialog = await prompt;
  expect(dialog.type()).toBe("beforeunload");
  await dialog.dismiss();
  await reload;
  expect(page.isClosed()).toBe(false);
}

test("saves only changed fields, normalizes the memo and reloads the saved DTO", async ({ page }) => {
  const backend = await installStubs(page);
  await signIn(page);
  await openBooking(page);
  const detail = page.getByRole("article");
  await expect(detail).toContainText("ホスト共有の相談メモ");
  await expect(detail).toContainText("Adminだけが確認できます");
  await detail.getByRole("combobox", { name: "NIHO事務局の担当" }).selectOption({ label: "合成 管理者B" });
  await detail.getByRole("textbox", { name: "内部メモ" }).fill("  one\r\ntwo  ");
  await detail.getByRole("button", { name: "担当・内部メモを保存" }).click();
  await expect(detail.getByRole("status")).toContainText("保存しました");
  expect(backend.patches).toEqual([{ expectedRevision: 1, assignedAdminUserId: "admin-2", internalMemo: "one\ntwo" }]);
  await page.reload();
  await expect(page.getByRole("textbox", { name: "内部メモ" })).toHaveValue("one\ntwo");
  await expect(page.getByRole("combobox", { name: "NIHO事務局の担当" })).toHaveValue("roster:1");
});

test("leaves an untouched legacy memo clean and saves assignment changes alone", async ({ page }) => {
  const backend = await installStubs(page);
  backend.cases.set("booking-a", { ...backend.cases.get("booking-a")!, internalMemo: "  保存済みメモ  " });
  await signIn(page);
  await openBooking(page);
  const save = page.getByRole("button", { name: "担当・内部メモを保存" });
  await expect(page.getByRole("textbox", { name: "内部メモ" })).toHaveValue("  保存済みメモ  ");
  await expect(save).toBeDisabled();
  await page.getByRole("combobox", { name: "NIHO事務局の担当" }).selectOption("roster:1");
  await save.click();
  await expect(page.getByRole("status")).toContainText("保存しました");
  expect(backend.patches).toEqual([{ expectedRevision: 1, assignedAdminUserId: "admin-2" }]);
  await expect(page.getByRole("textbox", { name: "内部メモ" })).toHaveValue("  保存済みメモ  ");
});

for (const reason of ["WRITES_DISABLED", "SUPPORT_OFF", "SUPPORT_LEGACY", "SUPPORT_INVALID", "PII_RETENTION_EXPIRED"] as const) {
  test(`renders ${reason} as an explicit read-only case without inputs`, async ({ page }) => {
    const backend = await installStubs(page);
    backend.writable.set("booking-a", { writable: false, reason });
    await signIn(page);
    await openBooking(page);
    const region = page.getByRole("region", { name: "NIHO事務局の内部メモ" });
    await expect(region).toContainText("閲覧専用");
    await expect(region.getByRole("textbox")).toHaveCount(0);
    await expect(region.getByRole("combobox")).toHaveCount(0);
  });
}

test("does not show empty inputs on GET failure and retries the same booking", async ({ page }) => {
  const backend = await installStubs(page);
  backend.nextCaseStatus = 503;
  await signIn(page);
  await openBooking(page);
  const region = page.getByRole("region", { name: "NIHO事務局の内部メモ" });
  await expect(region.getByRole("alert")).toContainText("空の入力欄は表示していません");
  await expect(region.getByRole("textbox")).toHaveCount(0);
  await region.getByRole("button", { name: "もう一度試す" }).click();
  await expect(region.getByRole("textbox", { name: "内部メモ" })).toHaveValue("Aの保存済みメモ");
});

test("shows an uncreated revision-zero case without inventing dates or an assignee", async ({ page }) => {
  const backend = await installStubs(page);
  backend.cases.set("booking-a", { bookingRequestId: "booking-a", assignedAdmin: { status: "UNASSIGNED" }, internalMemo: null, revision: 0, createdAt: null, updatedAt: null });
  await signIn(page);
  await openBooking(page);
  const region = page.getByRole("region", { name: "NIHO事務局の内部メモ" });
  await expect(region).toContainText("未作成");
  await expect(region.getByRole("combobox", { name: "NIHO事務局の担当" })).toHaveValue("unassigned");
  await expect(region.getByRole("textbox", { name: "内部メモ" })).toHaveValue("");
});

test("keeps unavailable and candidate-outside assignments, and honors roster truncation", async ({ page }, testInfo) => {
  const backend = await installStubs(page);
  backend.cases.set("booking-a", { ...backend.cases.get("booking-a")!, assignedAdmin: { status: "UNAVAILABLE" } });
  backend.roster.truncated = true;
  await signIn(page);
  await openBooking(page);
  const detail = page.getByRole("article");
  await expect(detail.getByRole("combobox", { name: "NIHO事務局の担当" })).toHaveValue("unavailable");
  await expect(detail).toContainText("候補は先頭100件まで");
  await detail.getByRole("combobox", { name: "NIHO事務局の担当" }).selectOption("unassigned");
  await detail.getByRole("button", { name: "担当・内部メモを保存" }).click();
  await expect(detail.getByRole("status")).toContainText("保存しました");
  expect(backend.patches.at(-1)).toMatchObject({ assignedAdminUserId: null });
  if (testInfo.project.name === "admin-case-mobile-360") await page.getByRole("button", { name: /予約支援へ戻る/ }).click();
  await page.getByRole("button", { name: /Synthetic Guest B/ }).click();
  await expect(page.getByRole("article")).toContainText("候補外・維持");
});

test("a roster failure closes assignment selection but still permits a memo-only save", async ({ page }) => {
  const backend = await installStubs(page);
  backend.rosterStatus = 503;
  await signIn(page);
  await openBooking(page);
  const detail = page.getByRole("article");
  await expect(detail).toContainText("担当候補を確認できないため、担当は変更できません");
  await detail.getByRole("textbox", { name: "内部メモ" }).fill("roster failure draft");
  await detail.getByRole("button", { name: "担当・内部メモを保存" }).click();
  expect(backend.patches.at(-1)).toEqual({ expectedRevision: 1, internalMemo: "roster failure draft" });
});

test("503 keeps the draft, while a revision conflict requires explicit comparison and inheritance", async ({ page }) => {
  const backend = await installStubs(page);
  backend.cases.set("booking-a", { ...backend.cases.get("booking-a")!, assignedAdmin: { status: "ACTIVE", id: "outside-old", displayName: "以前の候補外担当" } });
  await signIn(page);
  await openBooking(page);
  await expect(page.getByRole("combobox", { name: "NIHO事務局の担当" })).toHaveValue("current");
  const memo = page.getByRole("textbox", { name: "内部メモ" });
  await memo.fill("my retained draft");
  backend.nextPatch = "unavailable";
  await page.getByRole("button", { name: "担当・内部メモを保存" }).click();
  await expect(memo).toHaveValue("my retained draft");
  await expect(page.getByRole("alert").filter({ hasText: "保存結果を確認できません" })).toBeVisible();
  await expect(page.getByRole("button", { name: "担当・内部メモを保存" })).toBeDisabled();
  await page.getByRole("button", { name: "最新状態を再確認" }).click();
  await expect(page.getByRole("button", { name: "担当・内部メモを保存" })).toBeEnabled();
  backend.nextPatch = "revision";
  await page.getByRole("button", { name: "担当・内部メモを保存" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "別の管理者が先に更新" })).toBeVisible();
  const beforeCompare = backend.patches.length;
  await page.getByRole("button", { name: "最新を確認" }).click();
  await expect(page.getByText("別の管理者が保存したメモ")).toBeVisible();
  await expect(page.getByText("メモ: my retained draft", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "最新を基に入力を引き継ぐ" }).click();
  expect(backend.patches).toHaveLength(beforeCompare);
  await expect(memo).toHaveValue("my retained draft");
  await expect(page.getByRole("combobox", { name: "NIHO事務局の担当" })).toHaveValue("roster:1");
  await page.getByRole("button", { name: "担当・内部メモを保存" }).click();
  await expect(page.getByRole("status")).toContainText("保存しました");
  expect(backend.patches.at(-1)).toEqual({ expectedRevision: 2, internalMemo: "my retained draft" });
});

test("keeps a confirmed save when the capability re-read fails and preserves newer typing", async ({ page }) => {
  const backend = await installStubs(page);
  await signIn(page);
  await openBooking(page);
  const memo = page.getByRole("textbox", { name: "内部メモ" });
  await memo.fill("submitted draft");
  let release!: () => void;
  backend.patchGate = new Promise<void>((resolve) => { release = resolve; });
  backend.nextCaseStatus = 503;
  await page.getByRole("button", { name: "担当・内部メモを保存" }).click();
  await memo.fill("newer typing while saving");
  release();
  await expect(page.getByRole("status")).toContainText("保存しました。最新の編集可否だけ再確認できませんでした");
  await expect(memo).toHaveValue("newer typing while saving");
  expect(backend.cases.get("booking-a")?.internalMemo).toBe("submitted draft");
  await page.getByRole("button", { name: "最新状態を再確認" }).click();
  await expect(memo).toHaveValue("newer typing while saving");
  await expect(page.getByRole("button", { name: "担当・内部メモを保存" })).toBeEnabled();
});

test("a newer server revision after save requires explicit comparison without rebasing the draft", async ({ page }) => {
  const backend = await installStubs(page);
  await signIn(page);
  await openBooking(page);
  const memo = page.getByRole("textbox", { name: "内部メモ" });
  await memo.fill("submitted draft");
  let release!: () => void;
  backend.patchGate = new Promise<void>((resolve) => { release = resolve; });
  backend.caseReplies.set("booking-a", [{ status: 200, delay: 300 }]);
  await page.getByRole("button", { name: "担当・内部メモを保存" }).click();
  await memo.fill("newer local draft");
  release();
  await expect(page.getByRole("status")).toContainText("保存しました");
  const saved = backend.cases.get("booking-a")!;
  backend.cases.set("booking-a", { ...saved, internalMemo: "other admin draft", revision: saved.revision + 1, updatedAt: "2026-10-23T04:00:00.000Z" });
  await expect(page.getByText("最新の内容との照合が必要です")).toBeVisible();
  await expect(page.getByText("other admin draft")).toBeVisible();
  await expect(page.getByText("メモ: newer local draft", { exact: true })).toBeVisible();
  await expect(memo).toHaveValue("newer local draft");
  await expect(page.getByRole("button", { name: "担当・内部メモを保存" })).toBeDisabled();
});

test("an authoritative write denial keeps rejected input separately even when its refresh fails", async ({ page }) => {
  const backend = await installStubs(page);
  await signIn(page);
  await openBooking(page);
  await page.getByRole("textbox", { name: "内部メモ" }).fill("copy this rejected draft");
  backend.nextPatch = "permission";
  backend.nextPermissionReason = "SUPPORT_OFF";
  backend.caseReplies.set("booking-a", [{ status: 503 }]);
  await page.getByRole("button", { name: "担当・内部メモを保存" }).click();
  const region = page.getByRole("region", { name: "NIHO事務局の内部メモ" });
  await expect(region).toContainText("閲覧専用");
  await expect(region).toContainText("現在のメモ");
  await expect(region).toContainText("Aの保存済みメモ");
  await expect(region).toContainText("保存されなかった入力（コピーできます）");
  await expect(region.getByRole("textbox", { name: "内部メモ" })).toHaveValue("copy this rejected draft");
  await expect(region.getByRole("button", { name: "担当・内部メモを保存" })).toHaveCount(0);
  await region.getByRole("button", { name: "現在の保存内容を再確認" }).click();
  await expect(region.getByRole("textbox", { name: "内部メモ" })).toHaveValue("copy this rejected draft");
  await expect(region.getByRole("button", { name: "担当・内部メモを保存" })).toHaveCount(0);
});

test("an unavailable-assignee conflict requires a new selection or explicit clear", async ({ page }) => {
  const backend = await installStubs(page);
  await signIn(page);
  await openBooking(page);
  const assignee = page.getByRole("combobox", { name: "NIHO事務局の担当" });
  await assignee.selectOption({ label: "合成 管理者B" });
  backend.nextPatch = "assignee";
  await page.getByRole("button", { name: "担当・内部メモを保存" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "現在は利用できません" })).toBeVisible();
  await expect(page.getByRole("button", { name: "担当・内部メモを保存" })).toBeDisabled();
  await assignee.selectOption("unassigned");
  await expect(page.getByRole("button", { name: "担当・内部メモを保存" })).toBeEnabled();
});

test("save-in-flight and unsaved navigation are held behind the accessible leave dialog", async ({ page }) => {
  const backend = await installStubs(page);
  let release!: () => void;
  backend.patchGate = new Promise<void>((resolve) => { release = resolve; });
  await signIn(page);
  await openBooking(page);
  await page.getByRole("textbox", { name: "内部メモ" }).fill("draft before navigation");
  await page.getByRole("button", { name: "担当・内部メモを保存" }).click();
  await page.getByRole("link", { name: /^通知/ }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("保存結果を確認しています");
  await expect(dialog.getByRole("button", { name: "破棄して移動" })).toBeDisabled();
  release();
  await expect(page).toHaveURL(/\/admin\/notifications$/);
});

test("unsaved row, nav, logout, history and reload navigation require an explicit choice", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "admin-case-desktop");
  await installStubs(page);
  await signIn(page);
  await openBooking(page);
  const memo = page.getByRole("textbox", { name: "内部メモ" });
  await memo.fill("protected draft");

  const notifications = page.getByRole("link", { name: /^通知/ });
  await notifications.focus();
  await notifications.click();
  let dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("保存していない変更があります");
  await dialog.getByRole("button", { name: "編集を続ける" }).click();
  await expect(notifications).toBeFocused();
  await expect(memo).toHaveValue("protected draft");

  await page.getByRole("button", { name: "ログアウト" }).click();
  dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "編集を続ける" }).click();

  await page.evaluate(() => window.history.back());
  dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "編集を続ける" }).click();
  await expect(page).toHaveURL(/booking=booking-a/);

  await cancelReloadWithDraft(page);
  await expect(memo).toHaveValue("protected draft");

  await page.getByRole("button", { name: /Synthetic Guest B/ }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "破棄して移動" }).click();
  await expect(page).toHaveURL(/booking=booking-b/);
  const memoB = page.getByRole("textbox", { name: "内部メモ" });
  await memoB.fill("B must be protected again");

  await page.getByRole("link", { name: /^通知/ }).click();
  dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("保存していない変更があります");
  await dialog.getByRole("button", { name: "編集を続ける" }).click();

  await page.evaluate(() => window.history.back());
  dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("保存していない変更があります");
  await dialog.getByRole("button", { name: "編集を続ける" }).click();
  await expect(page).toHaveURL(/booking=booking-b/);

  await cancelReloadWithDraft(page);
  await expect(memoB).toHaveValue("B must be protected again");
});

test("a PATCH 401 cancels a pending destination and enters terminal reauthentication", async ({ page }) => {
  const backend = await installStubs(page);
  let release!: () => void;
  backend.patchGate = new Promise<void>((resolve) => { release = resolve; });
  backend.nextPatch = "session";
  await signIn(page);
  await openBooking(page);
  await page.getByRole("textbox", { name: "内部メモ" }).fill("pending session expiry");
  await page.getByRole("button", { name: "担当・内部メモを保存" }).click();
  await page.getByRole("link", { name: /^通知/ }).click();
  await expect(page.getByRole("dialog")).toContainText("保存結果を確認しています");
  release();
  await expect(page.getByRole("alert").filter({ hasText: "有効期限が切れました" })).toBeVisible();
  await expect(page).toHaveURL(/\/admin\/bookings\?booking=booking-a/);
  await expect(page).not.toHaveURL(/\/admin\/notifications/);
});

test("late case responses from booking A cannot replace booking B", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "admin-case-desktop");
  const backend = await installStubs(page);
  backend.caseDelay.set("booking-a", 650);
  await signIn(page);
  await page.getByRole("button", { name: /Synthetic Guest A/ }).click();
  await expect(page.getByRole("region", { name: "NIHO事務局の内部メモ" })).toContainText("読み込んでいます");
  await page.getByRole("button", { name: /Synthetic Guest B/ }).click();
  await expect(page.getByRole("textbox", { name: "内部メモ" })).toHaveValue("Bの保存済みメモ");
  await page.waitForTimeout(750);
  await expect(page.getByRole("textbox", { name: "内部メモ" })).toHaveValue("Bの保存済みメモ");
});

test("a delayed post-save 401 from booking A cannot expire booking B", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "admin-case-desktop");
  const backend = await installStubs(page);
  await signIn(page);
  await openBooking(page);
  backend.caseReplies.set("booking-a", [{ status: 401, delay: 650 }]);
  await page.getByRole("textbox", { name: "内部メモ" }).fill("saved before switching");
  await page.getByRole("button", { name: "担当・内部メモを保存" }).click();
  await expect(page.getByRole("status")).toContainText("保存しました");
  await page.getByRole("button", { name: /Synthetic Guest B/ }).click();
  await expect(page).toHaveURL(/booking=booking-b/);
  await expect(page.getByRole("textbox", { name: "内部メモ" })).toHaveValue("Bの保存済みメモ");
  await page.waitForTimeout(750);
  await expect(page.getByRole("textbox", { name: "内部メモ" })).toHaveValue("Bの保存済みメモ");
  await expect(page.getByRole("alert").filter({ hasText: "有効期限が切れました" })).toHaveCount(0);
});

test("a case 401 clears list, detail, search and draft into a terminal reauth state", async ({ page }) => {
  const backend = await installStubs(page);
  await signIn(page);
  await expect(page.getByRole("region", { name: "予約一覧" })).toContainText("Synthetic Guest A");
  backend.nextCaseStatus = 401;
  await page.getByRole("button", { name: /Synthetic Guest A/ }).click();
  const alert = page.getByRole("alert").filter({ hasText: "有効期限が切れました" });
  await expect(alert).toBeVisible();
  await expect(page.getByText("Synthetic Guest A")).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "内部メモ" })).toHaveCount(0);
  await expect(alert.getByRole("link", { name: "もう一度サインイン" })).toBeVisible();
});

test("320px, keyboard focus and axe remain usable", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "admin-case-mobile-360");
  await page.setViewportSize({ width: 320, height: 640 });
  await installStubs(page);
  await signIn(page);
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "本文へ移動" })).toBeFocused();
  await openBooking(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag22aa"]).analyze();
  expect(results.violations.filter((item) => item.impact === "serious" || item.impact === "critical")).toEqual([]);
});
