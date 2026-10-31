import { expect, test, type Page, type Route } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const occurrenceId = "sample-rule@2099-01-01";
const setupCommand = "00000000-0000-4000-8000-000000000317";
const anchorCommand = "00000000-0000-4000-8000-000000000318";
const today = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

function calendarData(canManage = true) {
  const day = today();
  return {
    scope: "MEMBER", preview: false, canEdit: true,
    experiences: [{ id: "sample-experience", title: "合成の料理体験" }], rules: [], busyIntervals: [],
    occurrences: [{
      id: occurrenceId, ruleId: "sample-rule", sourceLocalDate: day, localDate: day, localStartTime: "10:00", timeZone: "Asia/Tokyo",
      startUtc: `${day}T01:00:00.000Z`, endUtc: `${day}T02:00:00.000Z`, durationMinutes: 60, capacity: 4,
      bookingCutoffMinutes: 120, busyBufferBeforeMinutes: 0, busyBufferAfterMinutes: 0, status: "OPEN", rescheduled: false,
      experienceId: "sample-experience", experienceTitle: "合成の料理体験", availableSeats: 4,
      availabilityReason: "AVAILABLE", confirmedSeats: 0, heldSeats: 0, canReschedule: true,
    }],
    google: { connected: true, canManage, blockingEnabled: false, syncStatus: "FRESH" },
  };
}

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    listingId: "listing-a", accountDisplayName: "合成アカウント", mappingVersion: 1, desiredVersion: 7,
    localDate: "2099-01-01",
    ...overrides,
  };
}

async function signIn(page: Page) {
  await page.goto("/host/auth/mock-login");
  await page.waitForURL(/\/host\/home/);
}

async function baseRoutes(page: Page, canManage = true) {
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (request.method() === "GET" && url.pathname === "/host/calendar/google-output") {
      expect([...url.searchParams.keys()].sort()).toEqual(["listingId", "providerId"]);
    }
  });
  await page.route("**/host/calendar/data**", (route) => route.fulfill({ status: 200, json: calendarData(canManage) }));
  await page.route("**/host/calendar/channels**", (route) => route.fulfill({ status: 200, json: { channels: [{
    occurrenceId, site: "Airbnb", desired: "OPEN", label: "UNVERIFIED",
  }] } }));
}

async function openOccurrence(page: Page) {
  await page.goto("/host/calendar");
  await page.getByRole("button", { name: /合成の料理体験/ }).click();
  const dialog = page.getByRole("dialog", { name: "合成の料理体験" });
  await expect(dialog).toBeVisible();
  return dialog;
}

test("OWNER prepares, confirms, activates, and sees configuration status only after readback", async ({ page }, testInfo) => {
  await signIn(page); await baseRoutes(page);
  let setupState: "missing" | "ready" | "uncertain" = "missing";
  let anchorReady = false;
  let active = false;
  const writes: Record<string, unknown>[] = [];
  await page.route("**/host/calendar/google-output/options**", (route) => route.fulfill({ status: 200, json: { connected: true, candidates: [candidate()] } }));
  await page.route(/\/host\/calendar\/google-output(?:\?.*)?$/, async (route) => {
    if (route.request().method() === "POST") {
      writes.push(route.request().postDataJSON()); setupState = "ready";
      await route.fulfill({ status: 200, json: { commandId: writes.at(-1)!.commandId, listingId: "listing-a", state: "READY_FOR_CONNECTION", calendarName: "NIHO Airbnb | 合成の料理体験" } });
      return;
    }
    if (setupState === "missing") await route.fulfill({ status: 404, json: { error: "not_found" } });
    else await route.fulfill({ status: 200, json: { commandId: setupCommand, listingId: "listing-a", state: setupState === "uncertain" ? "UNCERTAIN" : "READY_FOR_CONNECTION", calendarName: "NIHO Airbnb | 合成の料理体験" } });
  });
  await page.route("**/host/calendar/google-output/anchors**", async (route) => {
    if (route.request().method() === "POST") {
      writes.push(route.request().postDataJSON()); anchorReady = true;
      await route.fulfill({ status: 200, json: { commandId: writes.at(-1)!.commandId, listingId: "listing-a", occurrenceId, state: "GOOGLE_VERIFIED" } });
      return;
    }
    if (!anchorReady) await route.fulfill({ status: 404, json: { error: "not_found" } });
    else await route.fulfill({ status: 200, json: { commandId: anchorCommand, listingId: "listing-a", occurrenceId, state: "GOOGLE_VERIFIED" } });
  });
  await page.route("**/host/calendar/google-output/activation**", async (route) => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON(); writes.push(body); active = true; setupState = "uncertain";
      await route.fulfill({ status: 200, json: { commandId: body.commandId, listingId: "listing-a", occurrenceId, state: "APPLIED" } });
      return;
    }
    if (!anchorReady) await route.fulfill({ status: 409, json: { error: "conflict" } });
    else await route.fulfill({ status: 200, json: { listingId: "listing-a", occurrenceId, state: active ? "ACTIVE" : "READY", expectedMappingVersion: 1, expectedBindingVersion: active ? 2 : 1, expectedDesiredVersion: 7 } });
  });

  const dialog = await openOccurrence(page);
  const summary = dialog.locator("summary").filter({ hasText: "Airbnb連携" });
  await summary.focus(); await page.keyboard.press("Enter");
  await dialog.getByRole("button", { name: "カレンダーを準備" }).click();
  await expect(dialog.getByText("NIHO Airbnb | 合成の料理体験", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "予約枠を準備" }).click();
  const airbnb = dialog.getByRole("link", { name: "Airbnbを開く" });
  await expect(airbnb).toHaveAttribute("href", "https://www.airbnb.jp/multicalendar/experiences-and-services/2099-01-01/week");
  await expect(airbnb).toHaveAttribute("target", "_blank");
  const confirmation = dialog.getByRole("checkbox", { name: /Airbnbで「NIHO Airbnb/ });
  await expect(dialog.getByRole("button", { name: "連携を開始" })).toBeDisabled();
  await page.screenshot({ path: testInfo.outputPath("airbnb-ready.png"), fullPage: true });
  await confirmation.check();
  await dialog.getByRole("button", { name: "連携を開始" }).click();
  await expect(dialog.getByText("連携中", { exact: true })).toBeVisible();
  await expect(dialog.getByText("反映済み", { exact: true })).toHaveCount(0);
  expect(writes).toHaveLength(3);
  expect(writes[2]).toMatchObject({ connectionConfirmed: true, expectedMappingVersion: 1, expectedBindingVersion: 1, expectedDesiredVersion: 7 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(axe.violations.map((violation) => violation.id)).toEqual([]);
});

test("flag-off and role-off stay hidden; malformed acknowledgement permits GET-only recovery", async ({ page }) => {
  await signIn(page); await baseRoutes(page);
  let optionReads = 0;
  await page.route("**/host/calendar/google-output/options**", async (route) => { optionReads += 1; await route.fulfill({ status: 404 }); });
  let dialog = await openOccurrence(page);
  await expect(dialog.getByText("Airbnb連携", { exact: true })).toHaveCount(0);
  expect(optionReads).toBeGreaterThanOrEqual(1);

  await page.unroute("**/host/calendar/data**"); await page.unroute("**/host/calendar/google-output/options**");
  await baseRoutes(page, false);
  optionReads = 0;
  await page.route("**/host/calendar/google-output/options**", async (route) => { optionReads += 1; await route.fulfill({ status: 200, json: { connected: true, candidates: [candidate()] } }); });
  dialog = await openOccurrence(page);
  await expect(dialog.getByText("Airbnb連携", { exact: true })).toHaveCount(0);
  expect(optionReads).toBe(0);

  await page.unroute("**/host/calendar/data**"); await baseRoutes(page, true);
  let setupPosts = 0;
  await page.route(/\/host\/calendar\/google-output(?:\?.*)?$/, async (route) => {
    if (route.request().method() === "POST") { setupPosts += 1; await route.fulfill({ status: 200, json: { state: "READY_FOR_CONNECTION" } }); }
    else await route.fulfill({ status: 404, json: { error: "not_found" } });
  });
  await page.route("**/host/calendar/google-output/anchors**", (route) => route.fulfill({ status: 404, json: { error: "not_found" } }));
  await page.route("**/host/calendar/google-output/activation**", (route) => route.fulfill({ status: 409, json: { error: "conflict" } }));
  dialog = await openOccurrence(page);
  await dialog.getByText("Airbnb連携", { exact: true }).click();
  await dialog.getByRole("button", { name: "カレンダーを準備" }).click();
  await expect(dialog.getByRole("button", { name: "状態を確認" })).toBeVisible();
  await dialog.getByRole("button", { name: "状態を確認" }).click();
  expect(setupPosts).toBe(1);
});

test("recovery uses original versions and a 409 clears confirmation before reread", async ({ page }) => {
  await signIn(page); await baseRoutes(page);
  let mode: "setup" | "anchor" | "activate" = "setup";
  const writes: Record<string, unknown>[] = [];
  await page.route("**/host/calendar/google-output/options**", (route) => route.fulfill({ status: 200, json: {
    connected: true, candidates: [candidate(mode === "setup"
      ? { mappingVersion: 9, pendingSetup: { commandId: setupCommand, expectedMappingVersion: 3 } }
      : mode === "anchor" ? { mappingVersion: 9, desiredVersion: 11, pendingAnchor: { commandId: anchorCommand, expectedMappingVersion: 2, expectedDesiredVersion: 5 } } : {})],
  } }));
  await page.route(/\/host\/calendar\/google-output(?:\?.*)?$/, async (route) => {
    if (route.request().method() === "POST") { writes.push(route.request().postDataJSON()); await route.fulfill({ status: 200, json: { commandId: setupCommand, listingId: "listing-a", state: "FAILED_BEFORE_CREATE", calendarName: "NIHO Airbnb | 合成" } }); return; }
    await route.fulfill({ status: 200, json: { commandId: setupCommand, listingId: "listing-a", state: mode === "setup" ? "PREPARING" : "READY_FOR_CONNECTION", calendarName: "NIHO Airbnb | 合成" } });
  });
  await page.route("**/host/calendar/google-output/anchors**", async (route) => {
    if (route.request().method() === "POST") { writes.push(route.request().postDataJSON()); await route.fulfill({ status: 200, json: { commandId: anchorCommand, listingId: "listing-a", occurrenceId, state: "UNCERTAIN" } }); return; }
    if (mode === "setup") await route.fulfill({ status: 404, json: { error: "not_found" } });
    else await route.fulfill({ status: 200, json: { commandId: anchorCommand, listingId: "listing-a", occurrenceId, state: mode === "anchor" ? "UNCERTAIN" : "GOOGLE_VERIFIED" } });
  });
  await page.route("**/host/calendar/google-output/activation**", async (route) => {
    if (route.request().method() === "POST") { writes.push(route.request().postDataJSON()); await route.fulfill({ status: 409, json: { error: "conflict" } }); return; }
    if (mode !== "activate") await route.fulfill({ status: 409, json: { error: "conflict" } });
    else await route.fulfill({ status: 200, json: { listingId: "listing-a", occurrenceId, state: "READY", expectedMappingVersion: 9, expectedBindingVersion: 4, expectedDesiredVersion: 11 } });
  });

  let dialog = await openOccurrence(page); await dialog.getByText("Airbnb連携", { exact: true }).click();
  await dialog.getByRole("button", { name: "準備を中止" }).click();
  expect(writes[0]).toMatchObject({ commandId: setupCommand, expectedMappingVersion: 3, operation: "cancel_preparing" });

  mode = "anchor"; await page.reload();
  await page.getByRole("button", { name: /合成の料理体験/ }).click(); dialog = page.getByRole("dialog", { name: "合成の料理体験" });
  await dialog.getByText("Airbnb連携", { exact: true }).click();
  await dialog.getByRole("button", { name: "状態を確認" }).click();
  expect(writes[1]).toMatchObject({ commandId: anchorCommand, expectedMappingVersion: 2, expectedDesiredVersion: 5, operation: "inspect" });

  mode = "activate"; await page.reload();
  await page.getByRole("button", { name: /合成の料理体験/ }).click(); dialog = page.getByRole("dialog", { name: "合成の料理体験" });
  await dialog.getByText("Airbnb連携", { exact: true }).click();
  const checkbox = dialog.getByRole("checkbox", { name: /Airbnbで/ });
  await checkbox.check(); await dialog.getByRole("button", { name: "連携を開始" }).click();
  await expect(checkbox).not.toBeChecked();
  expect(writes[2]).toMatchObject({ expectedMappingVersion: 9, expectedBindingVersion: 4, expectedDesiredVersion: 11 });
});

test("late responses from a previous listing are ignored", async ({ page }) => {
  await signIn(page); await baseRoutes(page);
  await page.route("**/host/calendar/google-output/options**", (route) => route.fulfill({ status: 200, json: { connected: true, candidates: [
    candidate({ listingId: "listing-a", accountDisplayName: "最初のアカウント" }),
    candidate({ listingId: "listing-b", accountDisplayName: "次のアカウント" }),
  ] } }));
  const delayed = async (route: Route, body: unknown) => {
    if (new URL(route.request().url()).searchParams.get("listingId") === "listing-a") await new Promise((resolve) => setTimeout(resolve, 150));
    await route.fulfill({ status: 200, json: body });
  };
  await page.route(/\/host\/calendar\/google-output(?:\?.*)?$/, (route) => delayed(route, {
    commandId: setupCommand, listingId: new URL(route.request().url()).searchParams.get("listingId"), state: "READY_FOR_CONNECTION",
    calendarName: new URL(route.request().url()).searchParams.get("listingId") === "listing-a" ? "最初のカレンダー" : "次のカレンダー",
  }));
  await page.route("**/host/calendar/google-output/anchors**", (route) => route.fulfill({ status: 404, json: { error: "not_found" } }));
  await page.route("**/host/calendar/google-output/activation**", (route) => route.fulfill({ status: 409, json: { error: "conflict" } }));
  const dialog = await openOccurrence(page); await dialog.getByText("Airbnb連携", { exact: true }).click();
  await dialog.getByLabel("アカウント").selectOption("listing-b");
  await expect(dialog.getByText("次のカレンダー", { exact: true })).toBeVisible();
  await page.waitForTimeout(200);
  await expect(dialog.getByText("最初のカレンダー", { exact: true })).toHaveCount(0);
});


test("first Google connection remains available without preparation requests", async ({ page }) => {
  await signIn(page); await baseRoutes(page);
  let preparationReads = 0;
  await page.route(/\/host\/calendar\/google-output(?:\/(?:anchors|activation))?(?:\?.*)?$/, (route) => {
    preparationReads += 1;
    return route.fulfill({ status: 403, json: { error: "forbidden" } });
  });
  await page.route("**/host/calendar/google-output/options**", (route) => route.fulfill({ status: 200, json: {
    connected: false, candidates: [candidate()],
  } }));
  const dialog = await openOccurrence(page);
  await dialog.locator("summary").filter({ hasText: "Airbnb連携" }).click();
  await expect(dialog.getByRole("link", { name: "Google カレンダーをつなぐ" })).toHaveAttribute("href", /\/host\/calendar\/google\/connect\?providerId=/);
  await expect(dialog.getByRole("button", { name: "カレンダーを準備" })).toHaveCount(0);
  expect(preparationReads).toBe(0);
});

test("options timeout offers a bounded read-only recovery", async ({ page }) => {
  await signIn(page); await baseRoutes(page); await page.clock.install();
  let ready = false;
  let reads = 0;
  await page.route("**/host/calendar/google-output/options**", (route) => {
    reads += 1;
    if (ready) return route.fulfill({ status: 200, json: { connected: false, candidates: [candidate()] } });
  });
  const dialog = await openOccurrence(page);
  await expect.poll(() => reads).toBeGreaterThanOrEqual(1);
  await page.clock.fastForward(16_000);
  await dialog.locator("summary").filter({ hasText: "Airbnb連携" }).click();
  await expect(dialog.getByRole("button", { name: "再読込" })).toBeEnabled();
  ready = true;
  await dialog.getByRole("button", { name: "再読込" }).click();
  await expect(dialog.getByRole("link", { name: "Google カレンダーをつなぐ" })).toBeVisible();
});

test("a lost acknowledgement releases the dialog and recovers with GET only", async ({ page }) => {
  await signIn(page); await baseRoutes(page); await page.clock.install();
  let posts = 0;
  await page.route("**/host/calendar/google-output/options**", (route) => route.fulfill({ status: 200, json: { connected: true, candidates: [candidate()] } }));
  await page.route(/\/host\/calendar\/google-output(?:\?.*)?$/, (route) => {
    if (route.request().method() === "POST") { posts += 1; return; }
    return route.fulfill({ status: 404, json: { error: "not_found" } });
  });
  await page.route("**/host/calendar/google-output/anchors**", (route) => route.fulfill({ status: 404, json: { error: "not_found" } }));
  await page.route("**/host/calendar/google-output/activation**", (route) => route.fulfill({ status: 409, json: { error: "conflict" } }));
  const dialog = await openOccurrence(page);
  await dialog.locator("summary").filter({ hasText: "Airbnb連携" }).click();
  await dialog.getByRole("button", { name: "カレンダーを準備" }).click();
  await expect.poll(() => posts).toBe(1);
  await expect(dialog.getByRole("button", { name: "受付を休止" })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "閉じる" })).toBeDisabled();
  await dialog.locator("summary").filter({ hasText: "日時を変更" }).click();
  await expect(dialog.getByLabel("日付", { exact: true })).toBeDisabled();
  await page.clock.fastForward(46_000);
  await expect(dialog.getByRole("button", { name: "状態を確認" })).toBeEnabled();
  await expect(dialog.getByRole("button", { name: "閉じる" })).toBeEnabled();
  await dialog.getByRole("button", { name: "状態を確認" }).click();
  await expect(dialog.getByRole("button", { name: "カレンダーを準備" })).toBeVisible();
  expect(posts).toBe(1);
});

test("reread refreshes versions and retains the selected listing", async ({ page }) => {
  await signIn(page); await baseRoutes(page);
  let current = false;
  const writes: Record<string, unknown>[] = [];
  await page.route("**/host/calendar/google-output/options**", (route) => route.fulfill({ status: 200, json: { connected: true, candidates: [
    candidate({ listingId: "listing-a", accountDisplayName: "最初のアカウント" }),
    candidate({ listingId: "listing-b", accountDisplayName: "次のアカウント", mappingVersion: current ? 2 : 1, desiredVersion: current ? 8 : undefined }),
  ] } }));
  await page.route(/\/host\/calendar\/google-output(?:\?.*)?$/, (route) => route.fulfill({ status: 200, json: {
    commandId: setupCommand, listingId: new URL(route.request().url()).searchParams.get("listingId"), state: "READY_FOR_CONNECTION", calendarName: "NIHO Airbnb | 合成",
  } }));
  await page.route("**/host/calendar/google-output/anchors**", (route) => {
    if (route.request().method() === "POST") { writes.push(route.request().postDataJSON()); return route.fulfill({ status: 409, json: { error: "conflict" } }); }
    return route.fulfill({ status: 404, json: { error: "not_found" } });
  });
  await page.route("**/host/calendar/google-output/activation**", (route) => route.fulfill({ status: 409, json: { error: "conflict" } }));
  const dialog = await openOccurrence(page);
  await dialog.locator("summary").filter({ hasText: "Airbnb連携" }).click();
  await dialog.getByLabel("アカウント", { exact: true }).selectOption("listing-b");
  await expect(dialog.getByRole("button", { name: "再読込" })).toBeEnabled();
  current = true;
  await dialog.getByRole("button", { name: "再読込" }).click();
  await expect(dialog.getByLabel("アカウント", { exact: true })).toHaveValue("listing-b");
  await dialog.getByRole("button", { name: "予約枠を準備" }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toMatchObject({ listingId: "listing-b", expectedMappingVersion: 2, expectedDesiredVersion: 8, operation: "initialize" });
});
