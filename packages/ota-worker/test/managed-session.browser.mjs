import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, chmod, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { startManagedBrowser } from "../src/managed-browser.mjs";
import { CHROME } from "./helpers/synthetic-gyg.mjs";

async function syntheticExecutable(profile) {
  if (process.platform !== "linux" || !process.env.CI) return CHROME;
  // Hosted Linux blocks Chromium's namespace sandbox. This wrapper is scoped
  // to a fresh synthetic profile and loopback fixture; production flags stay fixed.
  const executablePath = join(profile, "synthetic-chromium.sh");
  const quotedChrome = `'${CHROME.replaceAll("'", "'\\''")}'`;
  await writeFile(executablePath, `#!/bin/sh
exec ${quotedChrome} --no-sandbox "$@"
`, { mode: 0o700 });
  return executablePath;
}

async function stopForCleanup(t, browser, profile) {
  try {
    const stopped = await browser.stop();
    if (!stopped) {
      t.diagnostic(`owned synthetic browser stop was unconfirmed for pid ${browser.pid}; retained ${profile}`);
    }
    return stopped;
  } catch (error) {
    t.diagnostic(`owned synthetic browser cleanup threw ${error?.code ?? error?.name ?? "ERROR"} for pid ${browser.pid}; retained ${profile}`);
    return false;
  }
}

test("owned browser shutdown persists its own expiring cookie across a real restart", { timeout: 30_000 }, async (t) => {
  if (process.env.CODEX_SANDBOX === "seatbelt") { t.skip("Seatbelt blocks owned Chrome process control."); return; }
  if (!existsSync(CHROME)) {
    assert.ok(!process.env.CI, "CI must install Chromium for session persistence acceptance");
    t.skip("Selected Chrome executable is not installed."); return;
  }
  const profile = await mkdtemp(join(await realpath(tmpdir()), "niho-ota-session-test-"));
  await chmod(profile, 0o700);
  const executablePath = await syntheticExecutable(profile);
  const server = createServer((request, response) => {
    if (request.url === "/login") response.setHeader("set-cookie", "niho_synthetic=synthetic; Max-Age=3600; HttpOnly; SameSite=Lax; Path=/");
    response.setHeader("content-type", "text/plain");
    response.setHeader("cache-control", "no-store");
    response.end(request.headers.cookie?.includes("niho_synthetic=synthetic") ? "SIGNED_IN" : "SIGNED_OUT");
  });
  let browser;
  let safeToRemove = true;
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const origin = `http://127.0.0.1:${server.address().port}`;
    for (let index = 0; index < 2; index += 1) {
      browser = await startManagedBrowser({ executablePath, userDataDir: profile, headless: true });
      safeToRemove = false;
      const page = await browser.context.newPage();
      if (index === 0) await page.goto(`${origin}/login`);
      await page.goto(`${origin}/check`);
      assert.equal(await page.locator("body").innerText(), "SIGNED_IN");
      assert.equal(await browser.stop(), true);
      browser = null;
      safeToRemove = true;
    }
  } finally {
    if (browser) safeToRemove = await stopForCleanup(t, browser, profile);
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    if (safeToRemove) await rm(profile, { recursive: true, force: true });
  }
});

test("prepare sanitizes a session-only login before restore and restore makes no business request before the guard", { timeout: 30_000 }, async (t) => {
  if (process.env.CODEX_SANDBOX === "seatbelt") { t.skip("Seatbelt blocks owned Chrome process control."); return; }
  if (!existsSync(CHROME)) {
    assert.ok(!process.env.CI, "CI must install Chromium for managed session acceptance");
    t.skip("Selected Chrome executable is not installed."); return;
  }
  const profile = await mkdtemp(join(await realpath(tmpdir()), "niho-ota-restore-test-"));
  await chmod(profile, 0o700);
  const executablePath = await syntheticExecutable(profile);
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    if (request.url === "/login") {
      response.setHeader("set-cookie", "niho_session_only=synthetic; HttpOnly; SameSite=Lax; Path=/");
    }
    response.setHeader("content-type", "text/plain");
    response.setHeader("cache-control", "no-store");
    response.end(request.headers.cookie?.includes("niho_session_only=synthetic") ? "SIGNED_IN" : "SIGNED_OUT");
  });
  let browser;
  let safeToRemove = true;
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const origin = `http://127.0.0.1:${server.address().port}`;

    browser = await startManagedBrowser({ executablePath, userDataDir: profile, headless: true, sessionPolicy: "prepare" });
    safeToRemove = false;
    let page = browser.context.pages()[0] ?? await browser.context.newPage();
    await page.goto(`${origin}/login`);
    await page.goto(`${origin}/check`);
    assert.equal(await page.locator("body").innerText(), "SIGNED_IN");
    assert.equal(await browser.stop(), true);
    browser = null;
    safeToRemove = true;

    requests.length = 0;
    browser = await startManagedBrowser({ executablePath, userDataDir: profile, headless: true, sessionPolicy: "restore" });
    safeToRemove = false;
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.deepEqual(requests, [], "restore must not load the prior business URL before guarded navigation");
    page = browser.context.pages()[0] ?? await browser.context.newPage();
    await page.goto(`${origin}/check`);
    assert.equal(await page.locator("body").innerText(), "SIGNED_IN");
    assert.equal(await browser.stop(), true);
    browser = null;
    safeToRemove = true;
  } finally {
    if (browser) safeToRemove = await stopForCleanup(t, browser, profile);
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    if (safeToRemove) await rm(profile, { recursive: true, force: true });
  }
});
