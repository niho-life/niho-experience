import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { build } from "vite";

// A browser-only synthetic harness exercises the real components without host credentials or a production API.
const ORIGIN = "https://host-settings.example.test";
let bundle: string;

test.beforeAll(async () => {
  const result = await build({
    configFile: false, envDir: false, logLevel: "error",
    root: fileURLToPath(new URL("..", import.meta.url)),
    resolve: { alias: { "@": fileURLToPath(new URL("../src", import.meta.url)) } },
    define: { "process.env.NODE_ENV": JSON.stringify("development") },
    build: {
      lib: { entry: fileURLToPath(new URL("./fixtures/host-settings-client.tsx", import.meta.url)), name: "HostSettingsTest", formats: ["iife"] },
      write: false, minify: false,
    },
  });
  const outputs = Array.isArray(result) ? result : "output" in result ? [result] : [];
  const chunk = outputs.flatMap((output) => output.output).find((output) => output.type === "chunk");
  if (!chunk) throw new Error("Synthetic host client was not built");
  bundle = chunk.code;
});

async function mountHarness(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route(`${ORIGIN}/`, (route) => route.fulfill({ contentType: "text/html", body: '<!doctype html><meta charset="utf-8"><div id="root"></div>' }));
  await page.goto(`${ORIGIN}/`);
  await page.evaluate(() => Object.defineProperty(globalThis, "process", { value: { env: { NODE_ENV: "development" } } }));
  await page.addScriptTag({ content: bundle });
  return errors;
}

test("StrictMode revalidates after remount and unmounts a revoked private view", async ({ page }) => {
  const errors = await mountHarness(page);
  let calls = 0;
  let revoked = false;
  await page.route(`${ORIGIN}/host/api/team/access`, (route) => {
    calls += 1;
    return route.fulfill({ json: { contractVersion: 1, fingerprint: (revoked ? "b" : "a").repeat(64) } });
  });
  await page.evaluate(() => window.mountHostGuard("a".repeat(64)));
  await expect(page.getByTestId("private")).toBeVisible();
  await expect.poll(() => calls).toBeGreaterThan(0);
  // Finish the first verification before changing the response; the next check comes from focus.
  await page.waitForTimeout(75);
  const before = calls;
  revoked = true;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(() => calls).toBeGreaterThan(before);
  await expect(page.getByTestId("private")).toHaveCount(0);
  await expect(page.getByRole("alert")).toContainText("アクセス権が変更");
  expect(errors).toEqual([]);
});

test("a delayed mutation from a former provider cannot repopulate the current team", async ({ page }) => {
  const errors = await mountHarness(page);
  const ownerA = `hst_${"1".repeat(32)}`, ownerB = `hst_${"2".repeat(32)}`, member = `hst_${"3".repeat(32)}`;
  let release!: () => void;
  let started = false;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  await page.route(`${ORIGIN}/host/api/team/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.endsWith("/resolve")) return route.fulfill({ json: { contractVersion: 1, teamRevision: 0, candidate: { hostAccountId: member, label: "member@example.test" } } });
    if (request.method() === "PUT") {
      const body = request.postDataJSON() as { commandId: string };
      started = true;
      await pending;
      return route.fulfill({ json: {
        contractVersion: 1, teamRevision: 1,
        members: [{ hostAccountId: ownerA, role: "OWNER", label: "owner-a@example.test" }, { hostAccountId: member, role: "COHOST", label: "member@example.test" }],
        receipt: { commandId: body.commandId, operation: "ADD_COHOST", fingerprint: "a".repeat(64), version: 1, repeated: false },
      } });
    }
    const providerB = path.includes("/provider-b/");
    return route.fulfill({ json: { contractVersion: 1, teamRevision: 0, members: [{ hostAccountId: providerB ? ownerB : ownerA, role: "OWNER", label: providerB ? "owner-b@example.test" : "owner-a@example.test" }] } });
  });
  page.on("dialog", (dialog) => dialog.accept());
  try {
    await page.evaluate(() => window.mountHostTeam("provider-a"));
    await expect(page.getByText("owner-a@example.test", { exact: true })).toBeVisible();
    await page.getByLabel("登録済み Experience ホストのメールアドレス").fill("member@example.test");
    await page.getByRole("button", { name: "アカウントを確認", exact: true }).click();
    await page.getByRole("button", { name: /範囲を確認して/ }).click();
    await expect.poll(() => started).toBe(true);
    await page.evaluate(() => window.mountHostTeam("provider-b"));
    await expect(page.getByText("owner-b@example.test", { exact: true })).toBeVisible();
    release();
    await page.waitForTimeout(100);
    await expect(page.getByText("owner-a@example.test", { exact: true })).toHaveCount(0);
    await expect(page.getByText("owner-b@example.test", { exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    release();
  }
});

test("unknown and unavailable mutation results keep one command until a verified retry succeeds", async ({ page }) => {
  const errors = await mountHarness(page);
  const owner = `hst_${"1".repeat(32)}`, member = `hst_${"3".repeat(32)}`;
  const payloads: string[] = [];
  await page.route(`${ORIGIN}/host/api/team/**`, async (route) => {
    const request = route.request();
    if (request.url().endsWith("/resolve")) return route.fulfill({ json: { contractVersion: 1, teamRevision: 0, candidate: { hostAccountId: member, label: "member@example.test" } } });
    const ownerRow = { hostAccountId: owner, role: "OWNER", label: "owner@example.test" };
    if (request.method() !== "PUT") return route.fulfill({ json: { contractVersion: 1, teamRevision: 0, members: [ownerRow] } });
    payloads.push(request.postData()!);
    const body = request.postDataJSON() as { commandId: string };
    if (payloads.length === 2) return route.fulfill({ status: 503, json: { error: "team_unavailable" } });
    return route.fulfill({ json: {
      contractVersion: 1, teamRevision: 1,
      // The first 200 has a valid shape but does not show the requested member: it is not success.
      members: payloads.length === 1 ? [ownerRow] : [ownerRow, { hostAccountId: member, role: "COHOST", label: "member@example.test" }],
      receipt: { commandId: body.commandId, operation: "ADD_COHOST", fingerprint: "a".repeat(64), version: 1, repeated: payloads.length > 1 },
    } });
  });
  page.on("dialog", (dialog) => dialog.accept());
  await page.evaluate(() => window.mountHostTeam("provider-a"));
  await expect(page.getByText("owner@example.test", { exact: true })).toBeVisible();
  await page.getByLabel("登録済み Experience ホストのメールアドレス").fill("member@example.test");
  await page.getByRole("button", { name: "アカウントを確認", exact: true }).click();
  await page.getByRole("button", { name: /範囲を確認して/ }).click();
  const retry = page.getByRole("button", { name: "同じ操作を再送", exact: true });
  await expect(retry).toBeEnabled();
  await expect(page.getByRole("status")).toHaveCount(0);
  await retry.click();
  await expect(retry).toBeEnabled();
  await expect(page.getByRole("status")).toHaveCount(0);
  await retry.click();
  await expect(page.getByRole("status")).toContainText("追加しました");
  await expect(retry).toHaveCount(0);
  expect(payloads).toHaveLength(3);
  expect(new Set(payloads).size).toBe(1);
  expect(errors).toEqual([]);
});
