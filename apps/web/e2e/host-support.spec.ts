import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";

const policy = { policyVersion: "2026-10-23", consentVersion: "2026-10-23", offTotalRateBps: 1000, onTotalRateBps: 1500, peopleCostPaidDirectlyByHost: true, processingFeesIncluded: true };
type HostFixture = { kind: "SPOT" | "EXPERIENCE_PROVIDER"; id: string; displayName: string };
type SettingFixture = { enabled: boolean; policyVersion: string; consentVersion: string; consentedAt: string; agreementRevision: number; sharedConsultationMemo: string | null; revision: number; updatedAt: string };
type StateFixture = { host: HostFixture; setting: SettingFixture | null; settingState: string; policy: typeof policy; writeCapability: { writable: boolean; reason: string | null } };
const spot: HostFixture = { kind: "SPOT", id: "spot-1", displayName: "合成の通常拠点" };
const provider: HostFixture = { kind: "EXPERIENCE_PROVIDER", id: "provider-1", displayName: "合成の外部提供者" };
const list = { hosts: [spot, provider], limit: 100, truncated: false };
const unset = (host: HostFixture = spot): StateFixture => ({ host, setting: null, settingState: "UNSET", policy, writeCapability: { writable: true, reason: null } });
const current = (host: HostFixture = spot, enabled = false, revision = 3): StateFixture => ({ host, setting: { enabled, policyVersion: policy.policyVersion, consentVersion: policy.consentVersion, consentedAt: "2026-10-23T01:00:00.000Z", agreementRevision: 2, sharedConsultationMemo: "合成の相談メモ", revision, updatedAt: "2026-10-23T01:00:00.000Z" }, settingState: "CURRENT", policy, writeCapability: { writable: true, reason: null } });
const reconsent = (host: HostFixture = spot): StateFixture => ({ ...current(host, true), setting: { ...current(host, true).setting!, policyVersion: "2026-01-01", consentVersion: "2026-01-01" }, settingState: "RECONSENT_REQUIRED" });

async function signIn(page: Page, empty = false) {
  await page.goto(`/host${empty ? "?mock=empty" : ""}`);
  await page.getByRole("link", { name: "NIHO でログイン" }).click();
  await page.waitForURL(/\/host\/home/);
}

async function attemptNavigation(page: Page) {
  const logout = page.getByRole("button", { name: "ログアウト" }).filter({ visible: true });
  if (await logout.count()) await logout.click();
  else await page.getByRole("link", { name: "ホームへ戻る", exact: true }).click();
}

const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", headers: { "cache-control": "private, no-store" }, body: JSON.stringify(body) });

async function stub(page: Page, options: { hosts?: typeof list; state?: StateFixture; onTarget?: (route: Route, method: string) => Promise<void> } = {}) {
  await page.route("**/host/api/support-settings**", async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    if (url.pathname === "/host/api/support-settings") return json(route, options.hosts ?? list);
    if (options.onTarget) return options.onTarget(route, method);
    return json(route, options.state ?? unset(url.pathname.includes("EXPERIENCE_PROVIDER") ? provider : spot));
  });
}

async function openSupport(page: Page, empty = false) {
  await signIn(page, empty);
  await page.goto("/host/support");
  await expect(page.getByRole("heading", { level: 1, name: "NIHOサポート", exact: true })).toBeVisible();
}

test("providers empty still reaches a normal Spot from prompt, PC footer and mobile account; 320/360/desktop stay accessible", async ({ page }, testInfo) => {
  await stub(page, { hosts: { hosts: [spot], limit: 100, truncated: false } });
  await signIn(page, true);
  await expect(page.getByRole("link", { name: "NIHOサポート設定" })).toBeVisible();
  if (testInfo.project.name === "host-desktop") {
    await expect(page.getByRole("banner").getByRole("link", { name: "NIHOサポート", exact: true })).toBeVisible();
  } else {
    await page.locator("summary:visible", { hasText: "のアカウント" }).click();
    await expect(page.getByRole("link", { name: "NIHOサポート", exact: true })).toBeVisible();
  }
  await page.getByRole("link", { name: "NIHOサポート設定" }).click();
  await expect(page.getByRole("region", { name: /合成の通常拠点/ })).toContainText("未設定");
  await expect(page.getByRole("radio", { name: /サポートOFF/ })).not.toBeChecked();
  await expect(page.getByRole("radio", { name: /サポートON/ })).not.toBeChecked();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  expect(axe.violations.filter((item) => item.impact === "serious" || item.impact === "critical")).toEqual([]);
});

test("distinguishes list failure, zero targets and truncation", async ({ page }) => {
  await signIn(page);
  await page.route("**/host/api/support-settings", (route) => json(route, { error: "unavailable" }, 503));
  await page.goto("/host/support");
  await expect(page.getByRole("main").getByRole("alert")).toContainText("対象が0件なのではなく");
  await page.unroute("**/host/api/support-settings");
  await stub(page, { hosts: { hosts: [], limit: 100, truncated: false } });
  await page.reload();
  await expect(page.getByRole("heading", { name: "設定できる対象はありません" })).toBeVisible();
  await page.unroute("**/host/api/support-settings**");
  await stub(page, { hosts: { hosts: [spot], limit: 100, truncated: true } });
  await page.reload();
  await expect(page.getByText("最大100件まで表示しています。全件ではありません。")).toBeVisible();
});

test("invalid, incomplete or duplicate target query never falls through to another host", async ({ page }) => {
  let targetReads = 0;
  await stub(page, { onTarget: async (route) => { targetReads += 1; return json(route, current(spot, true)); } });
  await signIn(page);
  for (const query of ["hostKind=SPOT", "hostKind=ADMIN&hostId=spot-1", "hostKind=SPOT&hostKind=EXPERIENCE_PROVIDER&hostId=spot-1"]) {
    await page.goto(`/host/support?${query}`);
    await expect(page.getByRole("main").getByRole("alert")).toContainText("設定対象を選び直してください");
    await expect(page.getByRole("region", { name: /合成の通常拠点/ })).toHaveCount(0);
  }
  expect(targetReads).toBe(0);
  await page.getByRole("link", { name: /合成の通常拠点/ }).click();
  await expect(page.getByRole("region", { name: /合成の通常拠点/ })).toContainText("サポートON");
});

test("shows CURRENT ON/OFF, RECONSENT_REQUIRED and read-only write stop for both host kinds", async ({ page }) => {
  await stub(page, { onTarget: async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.includes("EXPERIENCE_PROVIDER")) return json(route, reconsent(provider));
    return json(route, { ...current(spot, false), writeCapability: { writable: false, reason: "SUPPORT_WRITES_DISABLED" } });
  } });
  await openSupport(page);
  const spotPanel = page.getByRole("region", { name: /合成の通常拠点/ });
  await expect(spotPanel).toContainText("サポートOFF");
  await expect(spotPanel).toContainText("現在は設定変更を受け付けていません");
  await page.getByRole("link", { name: /合成の外部提供者/ }).click();
  const providerPanel = page.getByRole("region", { name: /合成の外部提供者/ });
  await expect(providerPanel).toContainText("再同意が必要");
  await expect(providerPanel).toContainText("以前の設定は現在の規約版では有効ではありません");
  await expect(providerPanel.getByRole("radio", { name: /サポートON/ })).toBeChecked();
});

test("an initial target failure stays distinct from UNSET and offers an in-place reload", async ({ page }) => {
  let gets = 0;
  await stub(page, { onTarget: async (route) => {
    gets += 1;
    return gets === 1 ? json(route, { error: "unavailable" }, 503) : json(route, unset(spot));
  } });
  await openSupport(page);
  const alert = page.getByRole("main").getByRole("alert");
  await expect(alert).toContainText("未設定とは扱わず");
  await alert.getByRole("button", { name: "現在の設定をもう一度読み込む" }).click();
  await expect(page.getByRole("region", { name: /合成の通常拠点/ })).toContainText("まだ選ばれていません");
});

test("confirmation requires consent, re-GETs the policy/revision and double submit sends one immutable PUT", async ({ page }) => {
  let value = current(spot, false, 3);
  const puts: unknown[] = [];
  await stub(page, { state: value, onTarget: async (route, method) => {
    if (method === "GET") return json(route, value);
    puts.push(route.request().postDataJSON());
    value = current(spot, true, 4);
    return json(route, value, 201);
  } });
  await openSupport(page);
  const panel = page.getByRole("region", { name: /合成の通常拠点/ });
  await panel.getByRole("radio", { name: /サポートON/ }).check();
  await panel.getByRole("button", { name: "変更内容を確認" }).click();
  let dialog = page.getByRole("dialog", { name: /サポートをON/ });
  for (const text of ["合計手数料は15%", "決済手数料込み", "人件費", "新規予約", "規約版 2026-10-23"]) await expect(dialog).toContainText(text);
  await dialog.getByRole("checkbox").check();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "変更内容を確認" })).toBeFocused();
  await expect(panel.getByRole("radio", { name: /サポートON/ })).toBeChecked();
  await panel.getByRole("button", { name: "変更内容を確認" }).click();
  dialog = page.getByRole("dialog", { name: /サポートをON/ });
  await expect(dialog).toContainText("規約版 2026-10-23");
  await expect(dialog.getByRole("checkbox")).not.toBeChecked();
  await dialog.getByRole("button", { name: "同意して保存" }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button", { name: "同意して保存" }).evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
  await expect(panel.getByRole("status")).toContainText("NIHOサポート設定を保存しました");
  expect(puts).toEqual([{ enabled: true, consentVersion: "2026-10-23", expectedRevision: 3 }]);
});

test("a transient fresh check keeps the selection and can be explicitly checked again", async ({ page }) => {
  let gets = 0;
  let puts = 0;
  await stub(page, { onTarget: async (route, method) => {
    if (method === "PUT") { puts += 1; return json(route, current(spot, true, 4)); }
    gets += 1;
    return gets === 2 ? json(route, { error: "unavailable" }, 503) : json(route, current(spot, false, 3));
  } });
  await openSupport(page);
  const panel = page.getByRole("region", { name: /合成の通常拠点/ });
  await panel.getByRole("radio", { name: /サポートON/ }).check();
  const confirm = async () => {
    await panel.getByRole("button", { name: /変更内容を確認/ }).click();
    const dialog = page.getByRole("dialog", { name: /サポートをON/ });
    await dialog.getByRole("checkbox").check();
    await dialog.getByRole("button", { name: "同意して保存" }).click();
  };
  await confirm();
  await expect(panel.getByRole("status")).toContainText("選択は残しています");
  await expect(panel.getByRole("radio", { name: /サポートON/ })).toBeChecked();
  expect(puts).toBe(0);
  await confirm();
  await expect(panel.getByRole("status")).toContainText("保存しました");
  expect(puts).toBe(1);
});

test("a pre-confirm state change preserves the choice and requires a fresh confirmation", async ({ page }) => {
  let gets = 0;
  let puts = 0;
  await stub(page, { onTarget: async (route, method) => {
    if (method === "PUT") { puts += 1; return json(route, current(spot, true, 5)); }
    gets += 1;
    return json(route, gets === 1 ? current(spot, false, 3) : current(spot, false, 4));
  } });
  await openSupport(page);
  const panel = page.getByRole("region", { name: /合成の通常拠点/ });
  await panel.getByRole("radio", { name: /サポートON/ }).check();
  await panel.getByRole("button", { name: "変更内容を確認" }).click();
  const dialog = page.getByRole("dialog", { name: /サポートをON/ });
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button", { name: "同意して保存" }).click();
  await expect(panel.getByRole("status")).toContainText("確認中に設定・規約・変更可否が変わりました");
  await expect(panel.getByRole("radio", { name: /サポートON/ })).toBeChecked();
  expect(puts).toBe(0);
});

test("409 preserves input; an unknown result never claims success and retries the identical payload", async ({ page }) => {
  let mode: "conflict" | "unknown" | "success" = "conflict";
  const puts: unknown[] = [];
  await stub(page, { onTarget: async (route, method) => {
    if (method === "GET") return json(route, current(spot, false, 4));
    puts.push(route.request().postDataJSON());
    if (mode === "conflict") return json(route, { error: "conflict" }, 409);
    if (mode === "unknown") return json(route, { error: "unavailable" }, 503);
    return json(route, current(spot, true, 5));
  } });
  await openSupport(page);
  const panel = page.getByRole("region", { name: /合成の通常拠点/ });
  const save = async () => {
    await panel.getByRole("button", { name: /変更内容を確認/ }).click();
    const dialog = page.getByRole("dialog", { name: /サポートをON/ });
    await dialog.getByRole("checkbox").check();
    await dialog.getByRole("button", { name: "同意して保存" }).click();
  };
  await panel.getByRole("radio", { name: /サポートON/ }).check();
  await save();
  await expect(panel.getByRole("status")).toContainText("入力は残しています");
  mode = "unknown";
  await save();
  await expect(panel.getByRole("status")).toContainText("今回の保存成功を証明するものではありません");
  mode = "success";
  await panel.getByRole("button", { name: "同じ内容を再送" }).click();
  await expect(panel.getByRole("status")).toContainText("保存しました");
  expect(puts.at(-1)).toEqual(puts.at(-2));
});

test("an inconsistent success revision remains unknown and replay is one-shot", async ({ page }) => {
  const puts: unknown[] = [];
  await stub(page, { onTarget: async (route, method) => {
    if (method === "GET") return json(route, current(spot, false, 3));
    puts.push(route.request().postDataJSON());
    return json(route, current(spot, true, 5));
  } });
  await openSupport(page);
  const panel = page.getByRole("region", { name: /合成の通常拠点/ });
  await panel.getByRole("radio", { name: /サポートON/ }).check();
  await panel.getByRole("button", { name: "変更内容を確認" }).click();
  const dialog = page.getByRole("dialog", { name: /サポートをON/ });
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button", { name: "同意して保存" }).click();
  await expect(panel.getByRole("status")).toContainText("今回の保存成功を証明するものではありません");
  await panel.getByRole("button", { name: "同じ内容を再送" }).click();
  await expect(panel.getByRole("status")).toContainText("繰り返し送らず事務局へ確認してください");
  await expect(panel.getByRole("button", { name: "同じ内容を再送" })).toHaveCount(0);
  expect(puts).toHaveLength(2);
  expect(puts[1]).toEqual(puts[0]);
});

test("409 follow-up read keeps the save lock until reconciliation finishes", async ({ page }) => {
  let gets = 0;
  let markPutStarted: (() => void) | undefined;
  const putStarted = new Promise<void>((resolve) => { markPutStarted = resolve; });
  let releasePut: (() => void) | undefined;
  const delayedPut = new Promise<void>((resolve) => { releasePut = resolve; });
  let releaseFollow: (() => void) | undefined;
  const follow = new Promise<void>((resolve) => { releaseFollow = resolve; });
  let puts = 0;
  await stub(page, { onTarget: async (route, method) => {
    if (method === "PUT") { puts += 1; markPutStarted?.(); await delayedPut; return json(route, { error: "conflict" }, 409); }
    gets += 1;
    if (gets === 3) await follow;
    return json(route, current(spot, false, 4));
  } });
  await openSupport(page);
  const panel = page.getByRole("region", { name: /合成の通常拠点/ });
  await panel.getByRole("radio", { name: /サポートON/ }).check();
  await panel.getByRole("button", { name: "変更内容を確認" }).click();
  const dialog = page.getByRole("dialog", { name: /サポートをON/ });
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button", { name: "同意して保存" }).click();
  await putStarted;
  await expect(panel.getByRole("button", { name: "確認中…" })).toBeDisabled();
  await attemptNavigation(page);
  const leave = page.getByRole("dialog", { name: "保存の通信中です" });
  await expect(leave).toBeVisible();
  await leave.getByRole("button", { name: "この画面で待つ" }).click();
  releasePut?.();
  await expect.poll(() => gets).toBe(3);
  await expect(panel.getByRole("button", { name: "確認中…" })).toBeDisabled();
  releaseFollow?.();
  await expect(panel.getByRole("status")).toContainText("入力は残しています");
  expect(puts).toBe(1);
});

test("an unknown result with writes disabled explains why the same payload cannot be retried", async ({ page }) => {
  let gets = 0;
  await stub(page, { onTarget: async (route, method) => {
    if (method === "PUT") return json(route, { error: "unavailable" }, 503);
    gets += 1;
    const value = current(spot, false, 3);
    return json(route, gets >= 3 ? { ...value, writeCapability: { writable: false, reason: "SUPPORT_WRITES_DISABLED" } } : value);
  } });
  await openSupport(page);
  const panel = page.getByRole("region", { name: /合成の通常拠点/ });
  await panel.getByRole("radio", { name: /サポートON/ }).check();
  await panel.getByRole("button", { name: "変更内容を確認" }).click();
  const dialog = page.getByRole("dialog", { name: /サポートをON/ });
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button", { name: "同意して保存" }).click();
  await expect(panel.getByRole("status")).toContainText("現在は設定変更を受け付けていないため再送できません");
  await expect(panel.getByRole("button", { name: "同じ内容を再送" })).toHaveCount(0);
});

test("browser back and forward stay actions re-arm the single history guard", async ({ page }) => {
  await stub(page, { onTarget: async (route) => json(route, current(new URL(route.request().url()).pathname.includes("EXPERIENCE_PROVIDER") ? provider : spot, false)) });
  await openSupport(page);
  await page.getByRole("link", { name: /合成の外部提供者/ }).click();
  await expect(page.getByRole("region", { name: /合成の外部提供者/ })).toBeVisible();
  await page.getByRole("link", { name: /合成の通常拠点/ }).click();
  await expect(page.getByRole("region", { name: /合成の通常拠点/ })).toBeVisible();
  await page.getByRole("link", { name: /^(ホーム|ホームへ戻る)$/ }).filter({ visible: true }).first().click();
  await page.waitForURL(/\/host\/home/);
  await page.goBack();
  const panel = page.getByRole("region", { name: /合成の通常拠点/ });
  await panel.getByRole("radio", { name: /サポートON/ }).check();
  const ask = page.getByRole("dialog", { name: "保存していない変更があります" });
  for (const move of [() => page.goForward(), () => page.goForward(), () => page.goBack(), () => page.goBack()]) {
    await move();
    await expect(ask).toBeVisible();
    await ask.getByRole("button", { name: "編集を続ける" }).click();
    await expect(ask).toHaveCount(0);
    await expect(panel.getByRole("radio", { name: /サポートON/ })).toBeChecked();
  }
});

test("dirty link, host switch, logout and browser history stay guarded; unknown can be explicitly discarded", async ({ page }) => {
  await stub(page, { onTarget: async (route, method) => method === "PUT" ? json(route, { error: "unavailable" }, 503) : json(route, current(new URL(route.request().url()).pathname.includes("EXPERIENCE_PROVIDER") ? provider : spot, false, 3)) });
  await openSupport(page);
  await page.getByRole("link", { name: /合成の外部提供者/ }).click();
  await expect(page.getByRole("region", { name: /合成の外部提供者/ })).toBeVisible();
  await page.getByRole("link", { name: /合成の通常拠点/ }).click();
  const panel = page.getByRole("region", { name: /合成の通常拠点/ });
  await panel.getByRole("radio", { name: /サポートON/ }).check();
  await page.getByRole("link", { name: /合成の外部提供者/ }).click();
  let leave = page.getByRole("dialog", { name: "保存していない変更があります" });
  await expect(leave.getByRole("button", { name: "編集を続ける" })).toBeFocused();
  await leave.getByRole("button", { name: "編集を続ける" }).click();
  await page.goBack();
  await expect(leave).toBeVisible();
  await leave.getByRole("button", { name: "編集を続ける" }).click();
  await attemptNavigation(page);
  await expect(leave).toBeVisible();
  await leave.getByRole("button", { name: "編集を続ける" }).click();
  await panel.getByRole("button", { name: "変更内容を確認" }).click();
  const confirm = page.getByRole("dialog", { name: /サポートをON/ });
  await confirm.getByRole("checkbox").check();
  await confirm.getByRole("button", { name: "同意して保存" }).click();
  await expect(panel.getByRole("button", { name: "同じ内容を再送" })).toBeVisible();
  await page.getByRole("link", { name: /合成の外部提供者/ }).click();
  leave = page.getByRole("dialog", { name: "保存結果を確認できていません" });
  await expect(leave).toContainText("受付済みの処理があっても取り消されません");
  await leave.getByRole("button", { name: "確認を破棄して移動" }).click();
  await expect(page).toHaveURL(/hostKind=EXPERIENCE_PROVIDER/);
  const nextPanel = page.getByRole("region", { name: /合成の外部提供者/ });
  await nextPanel.getByRole("radio", { name: /サポートON/ }).check();
  await page.getByRole("link", { name: /合成の通常拠点/ }).click();
  await expect(page.getByRole("dialog", { name: "保存していない変更があります" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(nextPanel.getByRole("radio", { name: /サポートON/ })).toBeChecked();
});

test("401 clears target/input and a slow response from another target is ignored", async ({ page }) => {
  let reject = false;
  await stub(page, { onTarget: async (route) => {
    const providerRequest = new URL(route.request().url()).pathname.includes("EXPERIENCE_PROVIDER");
    if (providerRequest) { await new Promise((resolve) => setTimeout(resolve, 200)); return json(route, current(provider, true)); }
    if (reject) return json(route, { error: "unauthenticated" }, 401);
    return json(route, current(spot, false));
  } });
  await openSupport(page);
  await page.getByRole("link", { name: /合成の外部提供者/ }).click();
  await page.goto("/host/support?hostKind=SPOT&hostId=spot-1");
  await expect(page.getByRole("region", { name: /合成の通常拠点/ })).toContainText("サポートOFF");
  await expect(page.getByText("サポートON", { exact: true })).toHaveCount(0);
  reject = true;
  await page.reload();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("読み込んだ設定と入力を消去しました");
  await page.waitForTimeout(300);
  await expect(page.getByRole("region", { name: /合成の外部提供者/ })).toHaveCount(0);
  expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
});
