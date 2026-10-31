import { join } from "node:path";
import { chmod, mkdir } from "node:fs/promises";
import { CDN_ORIGIN, SUPPLIER_ORIGIN } from "./constants.mjs";
import { startManagedBrowser } from "./managed-browser.mjs";
import { createNetworkGuard } from "./network-guard.mjs";
import { ContractError, validateObservation } from "./validation.mjs";
import { selectAccountProfile } from "./config.mjs";
import { createGygEnsureOccurrence } from "./gyg-ensure-occurrence.mjs";

function fixedOrigin(value, testOnly) {
  if (value === undefined) return SUPPLIER_ORIGIN;
  const url = new URL(value);
  if (testOnly !== true || url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new ContractError("INVALID_DRIVER_ORIGIN");
  return url.origin;
}

export async function createGygDriver({ job, cloud, config, now = () => new Date(), testOnlySupplierOrigin, allowLocalTestOrigin = false, headless = false, browserFactory = startManagedBrowser }) {
  const supplierOrigin = fixedOrigin(testOnlySupplierOrigin, allowLocalTestOrigin);
  const profile = selectAccountProfile(config, job.target);
  const browser = await browserFactory({ executablePath: config.browserExecutable, userDataDir: profile, headless });
  try {
  const { context } = browser;
  const guard = createNetworkGuard({ job, cloud, supplierOrigin, cdnOrigin: supplierOrigin === SUPPLIER_ORIGIN ? CDN_ORIGIN : supplierOrigin });
  await context.route("**/*", guard.handle);
  let page = context.pages()[0] ?? await context.newPage();
  for (const extra of context.pages().filter((item) => item !== page)) await extra.close().catch(() => {});
  const session = await context.newCDPSession(page);
  await session.send("Browser.setDownloadBehavior", { behavior: "deny" });
  await session.send("Network.enable");
  await session.send("Network.setBypassServiceWorker", { bypass: true });
  await session.send("ServiceWorker.enable");
  await session.send("ServiceWorker.stopAllWorkers");
  await session.send("Storage.clearDataForOrigin", { origin: supplierOrigin, storageTypes: "service_workers" });
  await context.addInitScript(() => {
    if (globalThis.ServiceWorkerContainer?.prototype) {
      Object.defineProperty(globalThis.ServiceWorkerContainer.prototype, "register", {
        configurable: false,
        value: () => Promise.reject(new DOMException("Service workers are disabled by the NIHO OTA driver.", "NotAllowedError")),
      });
    }
  });
  page.setDefaultTimeout(15_000);
  page.on("popup", (popup) => popup.close().catch(() => {}));
  page.on("download", (download) => download.cancel().catch(() => {}));
  context.on("page", (opened) => { if (opened !== page) opened.close().catch(() => {}); });
  context.on("serviceworker", () => { void session.send("ServiceWorker.stopAllWorkers").catch(() => {}); });
  let accountVerified = false;
  let stopping = false;
  let stopPromise = null;

  const localDate = job.localDateTime.slice(0, 10);
  const rowId = `toggle-accept-bookings-${job.target.externalOptionId}-${job.localDateTime}`;
  const availabilityUrl = `${supplierOrigin}/manage/availability?filter_date_from=${localDate}&filter_date_to=${localDate}`;
  const companyUrl = `${supplierOrigin}/company-profile/company-details`;

  function assertActive() {
    if (stopping) throw new ContractError("DRIVER_STOPPED");
  }

  async function authOrDrift() {
    const current = new URL(page.url());
    const signIn = await page.getByText(/sign in|log in/i).count().catch(() => 0);
    const movedExternal = ["http:", "https:"].includes(current.protocol) && current.origin !== supplierOrigin;
    if (guard.externalNavigationBlocked || movedExternal || /login|signin|challenge|captcha/i.test(current.pathname) || signIn > 0) throw new ContractError("AUTH_REQUIRED");
    throw new ContractError("DOM_DRIFT");
  }

  async function verifyAccount() {
    assertActive();
    if (accountVerified) return;
    await page.goto(companyUrl, { waitUntil: "domcontentloaded" }).catch(() => authOrDrift());
    if (guard.fatalWrite) throw guard.fatalWrite;
    const label = page.getByText("Supplier ID:", { exact: true });
    await label.waitFor({ state: "visible" }).catch(() => authOrDrift());
    if (await label.count() !== 1) return authOrDrift();
    const parentText = await label.locator("..").innerText();
    const match = /(?:^|\s)Supplier ID:\s*(\d+)(?:\s|$)/.exec(parentText);
    if (!match || match[1] !== job.target.externalAccountId) throw new ContractError("ACCOUNT_MISMATCH");
    accountVerified = true;
  }

  async function findRow() {
    const toggle = page.getByTestId(rowId);
    await toggle.waitFor({ state: "attached" }).catch(() => authOrDrift());
    if (await toggle.count() !== 1) return authOrDrift();
    const row = toggle.locator(`xpath=ancestor::*[.//a[contains(@href,"/products/details?tour_id=")]][1]`);
    if (await row.count() !== 1
      || await row.locator(`a[href="/products/details?tour_id=${job.target.externalProductId}"]`).count() !== 1
      || await row.getByRole("switch").count() !== 1) throw new ContractError("PRODUCT_MISMATCH");
    return row;
  }

  async function observeAtCurrentPage() {
    if (guard.fatalWrite) throw guard.fatalWrite;
    const row = await findRow();
    const checked = await row.getByRole("switch").getAttribute("aria-checked");
    if (checked !== "true" && checked !== "false") throw new ContractError("DOM_DRIFT");
    const observation = {
      occurrenceId: job.occurrenceId,
      sourceStartAtUtc: job.sourceStartAtUtc,
      sourceEndAtUtc: job.sourceEndAtUtc,
      observedAtUtc: now().toISOString(),
      manuallyBlocked: checked === "true",
      bookable: await row.getByText("Bookable", { exact: true }).count() === 1,
    };
    return validateObservation(observation, job);
  }

  async function observeTarget() {
    assertActive();
    await verifyAccount();
    await page.goto(availabilityUrl, { waitUntil: "domcontentloaded" }).catch(() => authOrDrift());
    return observeAtCurrentPage();
  }

  async function applyDesiredState() {
    assertActive();
    if (job.action === "ENSURE_OCCURRENCE") throw new ContractError("WRITE_REFUSED");
    if (job.action === "OBSERVE") return Object.freeze({ changed: false, readOnly: true, observation: await observeTarget(), responseObserved: true });
    const before = await observeTarget();
    const desiredBlocked = job.desiredState === "CLOSED";
    if (before.manuallyBlocked === desiredBlocked) return Object.freeze({ changed: false, observation: before, responseObserved: true });
    await cloud.preflight(job);
    guard.beginUiAction();
    let responseObserved = false;
    let actionError = null;
    try {
      const row = await findRow();
      const response = page.waitForResponse((candidate) => {
        if (candidate.url() !== `${supplierOrigin}/graphql` || candidate.request().method() !== "POST") return false;
        try { return candidate.request().postDataJSON()?.operationName === "UpdateMultipleTimeSlots"; } catch { return false; }
      }, { timeout: 10_000 }).then(() => { responseObserved = true; }).catch(() => {});
      await row.getByRole("switch").setChecked(desiredBlocked).catch((error) => { actionError = error; });
      await response;
    } finally {
      guard.endUiAction();
    }
    try {
      await page.reload({ waitUntil: "domcontentloaded" });
      const observation = await observeAtCurrentPage();
      if (observation.manuallyBlocked !== desiredBlocked) throw new ContractError(responseObserved ? "SAVE_NOT_APPLIED" : "UNKNOWN_AFTER_SAVE");
      return Object.freeze({ changed: true, observation, responseObserved, actionError: actionError ? "UI_ACTION_ERROR" : undefined });
    } catch (error) {
      if (!responseObserved) throw new ContractError("UNKNOWN_AFTER_SAVE");
      throw error;
    }
  }

  async function verifyAfterReload() {
    assertActive();
    await verifyAccount();
    if (new URL(page.url()).pathname !== "/manage/availability") await page.goto(availabilityUrl, { waitUntil: "domcontentloaded" }).catch(() => authOrDrift());
    else await page.reload({ waitUntil: "domcontentloaded" }).catch(() => authOrDrift());
    const observation = await observeAtCurrentPage();
    if (job.action === "SET_CLOSED" && (!observation.manuallyBlocked || observation.bookable)) throw new ContractError("VERIFY_FAILED");
    if (job.action === "SET_OPEN" && (observation.manuallyBlocked || !observation.bookable)) throw new ContractError("VERIFY_FAILED");
    if (job.action === "OBSERVE" && observation.manuallyBlocked && observation.bookable) throw new ContractError("VERIFY_FAILED");
    return observation;
  }

  const ensureOccurrence = createGygEnsureOccurrence({
    job, page, guard, cloud, supplierOrigin, availabilityUrl, rowId,
    verifyAccount, observeAtCurrentPage, authOrDrift, assertActive,
  });

  return Object.freeze({
    pid: browser.pid,
    guard,
    observeTarget,
    applyDesiredState,
    verifyAfterReload,
    ensureOccurrence,
    async debugScreenshot() {
      if (!config.debugScreenshots) throw new ContractError("DEBUG_SCREENSHOT_DISABLED");
      const directory = join(config.privateDir, "debug");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
      const path = join(directory, `${job.id}.png`);
      await page.screenshot({ path });
      await chmod(path, 0o600);
    },
    async stop() {
      stopping = true;
      guard.freeze();
      stopPromise ??= browser.stop();
      return stopPromise;
    },
  });
  } catch (error) {
    const stopped = await browser.stop().catch(() => false);
    if (!stopped) throw new ContractError("PROCESS_STOP_UNCONFIRMED");
    throw error;
  }
}
