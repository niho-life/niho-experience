import { expect, test, type Page, type Route } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const today = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const addDays = (day: string, count: number) => new Date(Date.parse(`${day}T00:00:00.000Z`) + count * 86_400_000).toISOString().slice(0, 10);
const startOfWeek = (day: string) => addDays(day, -((new Date(`${day}T00:00:00.000Z`).getUTCDay() + 6) % 7));
const instant = (day: string, hour = 10) => `${day}T${String(hour - 9).padStart(2, "0")}:00:00.000Z`;

function occurrence(day = today(), status: "OPEN" | "CLOSED" = "OPEN") {
  return {
    id: `sample-rule@${today()}`, ruleId: "sample-rule", sourceLocalDate: today(), localDate: day, localStartTime: "10:00", timeZone: "Asia/Tokyo",
    startUtc: instant(day), endUtc: instant(day, 11), durationMinutes: 60, capacity: 4, bookingCutoffMinutes: 120,
    busyBufferBeforeMinutes: 0, busyBufferAfterMinutes: 0, status, rescheduled: day !== today(), experienceId: "sample-experience",
    experienceTitle: "合成の料理体験", availableSeats: status === "OPEN" ? 4 : 0,
    availabilityReason: status === "OPEN" ? "AVAILABLE" : "MANUALLY_CLOSED", confirmedSeats: 0, heldSeats: 0, canReschedule: true,
    ...(day === today() ? {} : { overrideVersion: 1 }), ...(status === "CLOSED" ? { salesStateVersion: 1 } : {}),
  } as const;
}

function calendarData(item = occurrence(), canEdit = true, preview = false) {
  return {
    scope: "MEMBER", preview, canEdit, experiences: [{ id: "sample-experience", title: "合成の料理体験" }], rules: [], occurrences: [item], busyIntervals: [],
    google: { connected: false, canManage: canEdit && !preview, blockingEnabled: false, syncStatus: "STALE" },
  };
}

async function signIn(page: Page) {
  await page.goto("/host/auth/mock-login");
  await page.waitForURL(/\/host\/home/);
}

async function stubCalendar(page: Page, handler: (route: Route) => Promise<void> | void) {
  await page.route("**/host/calendar/data**", handler);
}

async function stubChannels(page: Page, handler: (route: Route) => Promise<void> | void) {
  await page.route("**/host/calendar/channels**", handler);
}

test("week, day agenda and add dialog work without overflow", async ({ page }, testInfo) => {
  await signIn(page);
  const selectedDay = addDays(today(), new Date(`${today()}T00:00:00.000Z`).getUTCDay() === 0 ? -1 : 1);
  const posts: Record<string, unknown>[] = [];
  await stubCalendar(page, async (route) => {
    if (route.request().method() === "POST") { posts.push(route.request().postDataJSON()); await route.fulfill({ status: 201, json: { id: "new", version: 1 } }); }
    else await route.fulfill({ status: 200, json: calendarData() });
  });
  await page.goto("/host/calendar");
  await expect(page.getByRole("heading", { name: "カレンダー" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  await expect(page.locator("[data-calendar-day]:visible")).toHaveCount(7);
  if (testInfo.project.name === "calendar-desktop") await expect(page.getByRole("region", { name: "週カレンダー" })).toBeVisible();
  await testInfo.attach("calendar", { body: await page.screenshot({ path: testInfo.outputPath("calendar.png") }), contentType: "image/png" });

  await page.locator(`[data-calendar-day="${selectedDay}"]:visible`).click();
  await expect(page.getByRole("heading", { name: new RegExp(`${Number(selectedDay.slice(5, 7))}月${Number(selectedDay.slice(8))}日`) })).toBeVisible();
  const addButton = page.getByRole("button", { name: "枠を追加" });
  await addButton.click();
  let dialog = page.getByRole("dialog", { name: "枠を追加" });
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(addButton).toBeFocused();
  await addButton.click();
  dialog = page.getByRole("dialog", { name: "枠を追加" });
  const dialogAction = await dialog.getByRole("button", { name: "追加する" }).boundingBox();
  expect(dialogAction && dialogAction.height >= 44 && dialogAction.y + dialogAction.height <= page.viewportSize()!.height).toBe(true);
  await testInfo.attach("add-dialog", { body: await page.screenshot({ path: testInfo.outputPath("add-dialog.png") }), contentType: "image/png" });
  await expect(dialog.getByRole("checkbox", { name: "繰り返す" })).not.toBeChecked();
  await expect(dialog.getByLabel("終了日")).toHaveCount(0);
  await expect(dialog.getByLabel("日付")).toHaveValue(selectedDay);
  await dialog.getByLabel("定員（人）").fill("7");
  await dialog.getByRole("button", { name: "追加する" }).click();
  await expect(dialog).toHaveCount(0);
  expect(posts).toHaveLength(1);
  expect(posts[0]).toMatchObject({ action: "createRule", experienceId: "sample-experience", rule: { startsOn: selectedDay, endsOn: selectedDay, capacity: 7, recurrence: { kind: "WEEKLY" } } });
  expect(posts[0]?.commandId).toMatch(/^[0-9a-f-]{36}$/);
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag22aa"]).analyze();
  expect(axe.violations.map((violation) => violation.id)).toEqual([]);

  await expect(page.getByRole("region", { name: new RegExp(`${Number(selectedDay.slice(5, 7))}月`) })).toBeVisible();
});

test("selected weekdays can be checked, unchecked and saved", async ({ page }) => {
  await signIn(page);
  const posts: Record<string, unknown>[] = [];
  await stubCalendar(page, async (route) => {
    if (route.request().method() === "POST") {
      posts.push(route.request().postDataJSON());
      await route.fulfill({ status: 201, json: { id: "new", version: 1 } });
    } else await route.fulfill({ status: 200, json: calendarData() });
  });
  await page.goto("/host/calendar");
  await page.getByRole("button", { name: "枠を追加" }).click();
  const dialog = page.getByRole("dialog", { name: "枠を追加" });
  await dialog.getByRole("checkbox", { name: "繰り返す" }).check();
  await dialog.getByRole("combobox", { name: "繰り返し", exact: true }).selectOption("SELECTED_WEEKDAYS");
  const monday = dialog.getByRole("checkbox", { name: "月", exact: true });
  const saturday = dialog.getByRole("checkbox", { name: "土", exact: true });
  await monday.check();
  await saturday.check();
  await monday.uncheck();
  await expect(monday).not.toBeChecked();
  await expect(saturday).toBeChecked();
  await dialog.getByLabel("終了日").fill(addDays(today(), 14));
  await dialog.getByRole("button", { name: "追加する" }).click();
  await expect(dialog).toHaveCount(0);
  expect(posts).toHaveLength(1);
  expect(posts[0]).toMatchObject({ rule: { recurrence: { kind: "SELECTED_WEEKDAYS", weekdays: ["SATURDAY"] } } });
});

test("409 keeps input; successful save followed by GET failure is not resubmitted", async ({ page }) => {
  await signIn(page);
  const posts: Record<string, unknown>[] = [];
  let failReadAfterSave = false;
  await stubCalendar(page, async (route) => {
    if (route.request().method() === "POST") {
      posts.push(route.request().postDataJSON());
      if (posts.length === 1) await route.fulfill({ status: 409, json: { error: "conflict" } });
      else { failReadAfterSave = true; await route.fulfill({ status: 201, json: { id: "new", version: 1 } }); }
    } else if (failReadAfterSave) await route.fulfill({ status: 503, json: { error: "unavailable" } });
    else await route.fulfill({ status: 200, json: calendarData() });
  });
  await page.goto("/host/calendar");
  await page.getByRole("button", { name: "枠を追加" }).click();
  const dialog = page.getByRole("dialog", { name: "枠を追加" });
  await dialog.getByLabel("定員（人）").fill("9");
  await dialog.getByRole("button", { name: "追加する" }).click();
  await expect(dialog.getByRole("alert")).toContainText("入力は残っています");
  await expect(dialog.getByLabel("定員（人）")).toHaveValue("9");
  await dialog.getByRole("button", { name: "再読込" }).click();
  await expect(dialog.getByRole("button", { name: "追加する" })).toBeEnabled();
  await dialog.getByRole("button", { name: "追加する" }).click();
  await expect(page.getByRole("status")).toContainText("保存済み・表示を更新できません");
  expect(posts).toHaveLength(2);
  expect(posts[1]?.commandId).not.toBe(posts[0]?.commandId);
  await expect.poll(() => posts.length).toBe(2);
});

test("an unknown create result retries the exact immutable command", async ({ page }) => {
  await signIn(page);
  const requests: Record<string, unknown>[] = [];
  await stubCalendar(page, async (route) => {
    if (route.request().method() === "GET") { await route.fulfill({ status: 200, json: calendarData() }); return; }
    requests.push(route.request().postDataJSON());
    if (requests.length === 1) await route.abort("connectionreset");
    else await route.fulfill({ status: 201, json: { id: "new", version: 1 } });
  });
  await page.goto("/host/calendar");
  await page.getByRole("button", { name: "枠を追加" }).click();
  const dialog = page.getByRole("dialog", { name: "枠を追加" });
  await dialog.getByLabel("定員（人）").fill("8");
  await dialog.getByRole("button", { name: "追加する" }).click();
  await expect(dialog.getByRole("alert")).toContainText("保存結果を確認できません");
  await expect(dialog.getByRole("button", { name: "追加する" })).toBeDisabled();
  await dialog.getByRole("button", { name: "同じ内容で再送" }).click();
  await expect(dialog).toHaveCount(0);
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual(requests[0]);
});

test("channel labels never turn old observations into a successful reflection", async ({ page }) => {
  await signIn(page);
  let paused = false;
  await stubCalendar(page, async (route) => {
    if (route.request().method() === "POST") {
      paused = true;
      await route.fulfill({ status: 200, json: { occurrenceId: occurrence().id, version: 1 } });
    } else await route.fulfill({ status: 200, json: calendarData(occurrence(today(), paused ? "CLOSED" : "OPEN")) });
  });
  await stubChannels(page, (route) => route.fulfill({ status: 200, json: { channels: [{ occurrenceId: occurrence().id, site: "Synthetic OTA", desired: "CLOSED", observed: "CLOSED", label: "PENDING", lastVerifiedAtUtc: "2099-01-01T00:00:00.000Z" }] } }));
  await page.goto("/host/calendar");
  await page.getByRole("button", { name: /合成の料理体験/ }).click();
  let dialog = page.getByRole("dialog", { name: "合成の料理体験" });
  await expect(dialog.locator("summary").filter({ hasText: "掲載先" }).getByText("反映待ち", { exact: true })).toBeVisible();
  await expect(dialog.getByText("反映済み", { exact: true })).toHaveCount(0);
  await dialog.getByText("掲載先", { exact: true }).click();
  await expect(dialog.getByText("Synthetic OTA", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "受付を休止" }).click();
  await expect(page.getByRole("status")).toContainText("保存しました");
  await page.getByRole("button", { name: /合成の料理体験/ }).click();
  dialog = page.getByRole("dialog", { name: "合成の料理体験" });
  await expect(dialog.locator("summary").filter({ hasText: "掲載先" }).getByText("反映待ち", { exact: true })).toBeVisible();
});

test("saving invalidates a previously synced channel until the new read finishes", async ({ page }) => {
  await signIn(page);
  let paused = false;
  let readsAfterSave = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await stubCalendar(page, async (route) => {
    if (route.request().method() === "POST") {
      paused = true;
      await route.fulfill({ status: 200, json: { version: 1 } });
    } else await route.fulfill({ status: 200, json: calendarData(occurrence(today(), paused ? "CLOSED" : "OPEN")) });
  });
  await stubChannels(page, async (route) => {
    if (paused) { readsAfterSave += 1; await gate; }
    await route.fulfill({ status: 200, json: { channels: [{ occurrenceId: occurrence().id, site: "Synthetic OTA", desired: paused ? "CLOSED" : "OPEN", label: paused ? "PENDING" : "SYNCED" }] } });
  });
  await page.goto("/host/calendar");
  await page.getByRole("button", { name: /合成の料理体験/ }).click();
  let dialog = page.getByRole("dialog", { name: "合成の料理体験" });
  await expect(dialog.locator("summary").getByText("反映済み", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "受付を休止" }).click();
  await expect(page.getByRole("status")).toContainText("保存しました");
  await page.getByRole("button", { name: /合成の料理体験/ }).click();
  dialog = page.getByRole("dialog", { name: "合成の料理体験" });
  await expect.poll(() => readsAfterSave).toBeGreaterThan(0);
  await expect(dialog.getByText("反映済み", { exact: true })).toHaveCount(0);
  await expect(dialog.locator("summary").getByText("確認中", { exact: true })).toBeVisible();
  release();
  await expect(dialog.locator("summary").getByText("反映待ち", { exact: true })).toBeVisible();
});

test("channel read failures are a check-needed state, not an empty success", async ({ page }) => {
  await signIn(page);
  await stubCalendar(page, (route) => route.fulfill({ status: 200, json: calendarData() }));
  await stubChannels(page, (route) => route.fulfill({ status: 503, json: { error: "runtime_unavailable" } }));
  await page.goto("/host/calendar");
  await page.getByRole("button", { name: /合成の料理体験/ }).click();
  const dialog = page.getByRole("dialog", { name: "合成の料理体験" });
  await expect(dialog.getByText("要確認", { exact: true })).toBeVisible();
  await expect(dialog.getByText("反映済み", { exact: true })).toHaveCount(0);
});

test("preview and VIEWER cannot mutate", async ({ page }) => {
  await signIn(page);
  let posts = 0;
  await stubCalendar(page, async (route) => {
    if (route.request().method() === "POST") { posts += 1; await route.fulfill({ status: 403 }); }
    else await route.fulfill({ status: 200, json: calendarData(occurrence(), false, true) });
  });
  await page.goto("/host/calendar");
  await expect(page.getByRole("button", { name: "枠を追加" })).toBeDisabled();
  await page.getByRole("button", { name: /合成の料理体験/ }).click();
  const dialog = page.getByRole("dialog", { name: "合成の料理体験" });
  await expect(dialog).toContainText("このカレンダーは変更できません");
  await expect(dialog.getByRole("button", { name: /休止|再開|日時を変更/ })).toHaveCount(0);
  expect(posts).toBe(0);
});

test("a failed week read never exposes the previous range for editing", async ({ page }) => {
  await signIn(page);
  let failRead = false;
  await stubCalendar(page, async (route) => {
    if (failRead) await route.fulfill({ status: 503, json: { error: "unavailable" } });
    else await route.fulfill({ status: 200, json: calendarData() });
  });
  await page.goto("/host/calendar");
  await expect(page.getByRole("button", { name: /合成の料理体験/ })).toBeVisible();
  failRead = true;
  await page.getByRole("button", { name: "次の週" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("準備しています");
  await expect(page.getByText("合成の料理体験", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "枠を追加" })).toBeDisabled();
  failRead = false;
  await page.getByRole("button", { name: "再読込" }).click();
  if (page.viewportSize()!.width >= 1024) await expect(page.getByRole("region", { name: "週カレンダー" })).toBeVisible();
  else await expect(page.getByRole("group", { name: "日を選ぶ" })).toBeVisible();
});

test("an aborted old week response cannot replace the current week", async ({ page }) => {
  await signIn(page);
  const nextWeek = addDays(startOfWeek(today()), 7);
  let nextRequested = false;
  let delayedFinished = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await stubCalendar(page, async (route) => {
    const fromDate = new URL(route.request().url()).searchParams.get("fromDate");
    const data = calendarData();
    if (fromDate === nextWeek) {
      nextRequested = true;
      await gate;
      try {
        await route.fulfill({ status: 200, json: { ...data, experiences: [{ id: "sample-experience", title: "古い週の体験" }], occurrences: data.occurrences.map((item) => ({ ...item, experienceTitle: "古い週の体験" })) } });
      } catch { /* The AbortController may have already ended this request. */ }
      delayedFinished = true;
      return;
    }
    await route.fulfill({ status: 200, json: { ...data, experiences: [{ id: "sample-experience", title: "現在の週の体験" }], occurrences: data.occurrences.map((item) => ({ ...item, experienceTitle: "現在の週の体験" })) } });
  });
  await page.goto("/host/calendar");
  await expect(page.getByRole("button", { name: /現在の週の体験/ })).toBeVisible();
  await page.getByRole("button", { name: "次の週" }).click();
  await expect.poll(() => nextRequested).toBe(true);
  await page.getByRole("button", { name: "前の週" }).click();
  await page.getByRole("button", { name: "今日", exact: true }).click();
  await expect(page.getByRole("button", { name: /現在の週の体験/ })).toBeVisible();
  release();
  await expect.poll(() => delayedFinished).toBe(true);
  await expect(page.getByText("古い週の体験", { exact: true })).toHaveCount(0);
});

test("Google busy continuing into the selected JST day is clipped", async ({ page }) => {
  await signIn(page);
  await stubCalendar(page, async (route) => {
    const data = calendarData();
    await route.fulfill({ status: 200, json: { ...data, busyIntervals: [{ startUtc: `${addDays(today(), -1)}T14:00:00.000Z`, endUtc: `${today()}T02:00:00.000Z` }] } });
  });
  await page.goto("/host/calendar");
  await expect(page.getByRole("note", { name: /00:00–11:00 予定あり/ })).toBeVisible();
});

test("a moved occurrence keeps its time through pause and reopen", async ({ page }) => {
  await signIn(page);
  const movedDay = addDays(today(), 1);
  let item = occurrence();
  const actions: string[] = [];
  await stubCalendar(page, async (route) => {
    if (route.request().method() === "GET") { await route.fulfill({ status: 200, json: calendarData(item) }); return; }
    const body = route.request().postDataJSON() as Record<string, unknown>;
    actions.push(String(body.action));
    if (body.action === "rescheduleOccurrence") item = occurrence(String(body.localDate));
    if (body.action === "setSalesState") item = occurrence(movedDay, body.desiredState === "CLOSED" ? "CLOSED" : "OPEN");
    await route.fulfill({ status: 200, json: { occurrenceId: item.id, version: 1 } });
  });
  await page.goto("/host/calendar");
  await page.getByRole("button", { name: /合成の料理体験/ }).click();
  let dialog = page.getByRole("dialog", { name: "合成の料理体験" });
  await dialog.locator("summary").filter({ hasText: "日時を変更" }).click();
  await dialog.getByLabel("日付").fill(movedDay);
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await page.getByRole("button", { name: /合成の料理体験/ }).click();
  dialog = page.getByRole("dialog", { name: "合成の料理体験" });
  await expect(dialog).toContainText("10:00–11:00");
  await dialog.getByRole("button", { name: "受付を休止" }).click();
  await page.getByRole("button", { name: /合成の料理体験/ }).click();
  dialog = page.getByRole("dialog", { name: "合成の料理体験" });
  await expect(dialog).toContainText("10:00–11:00");
  await dialog.getByRole("button", { name: "受付を再開" }).click();
  await expect(page.getByRole("button", { name: /合成の料理体験.*受付中/ })).toBeVisible();
  expect(actions).toEqual(["rescheduleOccurrence", "setSalesState", "setSalesState"]);
});

test("provider route switching unmounts the old dialog and product", async ({ page }) => {
  await signIn(page);
  await stubCalendar(page, async (route) => {
    const providerId = new URL(route.request().url()).searchParams.get("providerId");
    const next = calendarData();
    const title = providerId === "sample-provider-studio" ? "合成の工房体験" : "合成の料理体験";
    await route.fulfill({ status: 200, json: { ...next, experiences: [{ id: "sample-experience", title }], occurrences: next.occurrences.map((item) => ({ ...item, experienceTitle: title })) } });
  });
  await page.goto("/host/calendar?providerId=sample-provider-kitchen");
  await page.getByRole("button", { name: /合成の料理体験/ }).click();
  await expect(page.getByRole("dialog", { name: "合成の料理体験" })).toBeVisible();
  await page.goto("/host/calendar?providerId=sample-provider-studio");
  await expect(page).toHaveURL(/providerId=sample-provider-studio/);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /合成の工房体験/ })).toBeVisible();
  await expect(page.getByText("合成の料理体験", { exact: true })).toHaveCount(0);
});

test("operator calendar omits private counts and Google controls while keeping availability actions", async ({ page }, testInfo) => {
  await signIn(page);
  let paused = false;
  const actions: Record<string, unknown>[] = [];
  await stubCalendar(page, async (route) => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON(); actions.push(body); paused = body.desiredState === "CLOSED";
      await route.fulfill({ status: 200, json: { occurrenceId: occurrence().id, version: 1 } }); return;
    }
    const own = { ...occurrence(today(), paused ? "CLOSED" : "OPEN"), availableSeats: undefined, confirmedSeats: undefined, heldSeats: undefined };
    await route.fulfill({ status: 200, json: { ...calendarData(), scope: "OPERATOR",
      occurrences: [{ ...own, canReschedule: false }], google: { connected: false, canManage: false, blockingEnabled: false, syncStatus: "STALE" } } });
  });
  await page.goto("/host/calendar");
  await expect(page.getByRole("button", { name: /合成の料理体験/ })).toBeVisible();
  await expect(page.getByText("Google カレンダー", { exact: true })).toHaveCount(0);
  await expect(page.getByText("予約あり", { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  await testInfo.attach("operator-calendar-synthetic", { body: await page.screenshot({ path: testInfo.outputPath("operator-calendar.png") }), contentType: "image/png" });
  await page.getByRole("button", { name: /合成の料理体験/ }).click();
  const dialog = page.getByRole("dialog", { name: "合成の料理体験" });
  await expect(dialog.getByRole("button", { name: "日時を変更" })).toHaveCount(0);
  await expect(dialog.getByText(/定員|名|人/)).toHaveCount(0);
  await dialog.getByRole("button", { name: "受付を休止" }).click();
  await page.getByRole("button", { name: /合成の料理体験/ }).click();
  await page.getByRole("button", { name: "受付を再開" }).click();
  expect(actions.map((item) => item.desiredState)).toEqual(["CLOSED", "OPEN"]);
});

test("invitation clears the secret from the URL and shows a readable invalid state", async ({ page }, testInfo) => {
  const id = "00000000-0000-4000-8000-000000000001";
  const secret = "Z".repeat(43);
  await page.route(`**/host/invitations/${id}/prepare`, (route) => route.fulfill({ status: 403, json: { error: "invalid_invitation" } }));
  await page.goto(`/host/invitations/${id}#${secret}`);
  await expect(page.getByRole("heading", { name: "体験への招待" })).toBeVisible();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("期限");
  expect(page.url()).not.toContain(secret);
  expect(page.url()).not.toContain("#");
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  await testInfo.attach("invitation-invalid-synthetic", { body: await page.screenshot({ path: testInfo.outputPath("invitation-invalid.png") }), contentType: "image/png" });
});
