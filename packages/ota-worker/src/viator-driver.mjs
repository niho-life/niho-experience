import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { MAX_JSON_BYTES, VIATOR_ORIGIN } from "./constants.mjs";
import { selectAccountProfile } from "./config.mjs";
import { startManagedBrowser } from "./managed-browser.mjs";
import { ContractError, validateObservation } from "./validation.mjs";
import {
  createViatorNetworkGuard,
  deriveViatorDisplayedListState,
  selectViatorAvailability,
  validateViatorReadBody,
  viatorListStateCoversTarget,
} from "./viator-network-guard.mjs";
import { assertAuthOrDrift, fixedTestOrigin, prepareGuardedPage } from "./browser-driver-common.mjs";

export async function createViatorDriver({ job, cloud, config, now = () => new Date(), testOnlySupplierOrigin,
  allowLocalTestOrigin = false, headless = false, browserFactory = startManagedBrowser, responseTimeoutMs = 15_000, writeResponseTimeoutMs = 10_000 }) {
  const supplierOrigin = fixedTestOrigin(testOnlySupplierOrigin, VIATOR_ORIGIN, allowLocalTestOrigin);
  const profile = selectAccountProfile(config, job.target);
  const browser = await browserFactory({ executablePath: config.browserExecutable, userDataDir: profile, headless });
  let guard;
  try {
    let snapshot = null;
    guard = createViatorNetworkGuard({ job, cloud, supplierOrigin, getSnapshot: () => snapshot,
      assertWriteContext: async () => verifyAccount() });
    const page = await prepareGuardedPage({ browser, guard, supplierOrigin });
    const availabilityUrl = `${supplierOrigin}/availability/`;
    let stopping = false;
    let stopPromise = null;
    const authOrDrift = () => assertAuthOrDrift({ page, guard, supplierOrigin, signInPattern: /sign in|log in|ログイン/i });
    const assertActive = () => { if (stopping) throw new ContractError("DRIVER_STOPPED"); };

    async function verifyAccount() {
      const texts = await page.getByRole("button").allInnerTexts().catch(() => []);
      const matches = texts.map((text) => /（(\d+)）\s*$/.exec(text.replace(/\s+/g, " ").trim())).filter(Boolean);
      if (matches.length !== 1) return authOrDrift();
      if (matches[0][1] !== job.target.externalAccountId) throw new ContractError("ACCOUNT_MISMATCH");
    }

    async function receiveRead(trigger, { targetRequired }) {
      const responsePromise = page.waitForResponse((response) => response.url() === `${supplierOrigin}/availability/api`
        && response.request().method() === "POST", { timeout: responseTimeoutMs }).catch(() => null);
      await trigger();
      const response = await responsePromise;
      if (!response) return authOrDrift();
      if (response.status() !== 200 || response.headers()["content-type"]?.split(";")[0] !== "application/json") throw new ContractError("DOM_DRIFT");
      let requestState;
      try { requestState = response.request().postDataJSON(); } catch { throw new ContractError("DOM_DRIFT"); }
      if (!validateViatorReadBody(requestState)) throw new ContractError("DOM_DRIFT");
      const raw = await response.text();
      if (Buffer.byteLength(raw) > MAX_JSON_BYTES) throw new ContractError("DOM_DRIFT");
      let parsed;
      try { parsed = JSON.parse(raw); } catch { throw new ContractError("DOM_DRIFT"); }
      const listState = deriveViatorDisplayedListState(parsed);
      const selected = selectViatorAvailability(parsed, job, { allowMissing: !targetRequired });
      const coversTarget = viatorListStateCoversTarget(listState, job);
      if (targetRequired && (!selected || !coversTarget)) throw new ContractError("DOM_DRIFT");
      return Object.freeze({ selected, coversTarget, listState: structuredClone(listState) });
    }

    async function findRow(current) {
      const links = page.locator('a[href*="/bookings/search"]');
      const matchingLinks = new Set();
      for (let index = 0; index < await links.count(); index += 1) {
        const href = await links.nth(index).getAttribute("href");
        if (!href) continue;
        const url = new URL(href, supplierOrigin);
        if (url.origin === supplierOrigin && url.pathname === "/bookings/search" && url.searchParams.get("travelDate") === job.localDateTime.slice(0, 10)
          && url.searchParams.get("filteredTourGrade") === `${job.target.externalProductId}|${job.target.externalOptionId}`) matchingLinks.add(href);
      }
      if (matchingLinks.size !== 1) throw new ContractError("PRODUCT_MISMATCH");
      const linkSelector = `a[href=${JSON.stringify([...matchingLinks][0])}]`;
      // Each start time shares the same booking-search href. Scope by both
      // href and time before uniqueness; inner locators must have no global nth.
      const rows = page.locator('div[class*="_gridCol_"]')
        .filter({ has: page.locator(linkSelector) })
        .filter({ has: page.getByText(job.localDateTime.slice(11, 16), { exact: true }) });
      if (await rows.count() !== 1) throw new ContractError("PRODUCT_MISMATCH");
      const row = rows.first();
      if (await row.locator(linkSelector).count() !== 1) throw new ContractError("DOM_DRIFT");
      if (await row.getByText(job.localDateTime.slice(11, 16), { exact: true }).count() !== 1) throw new ContractError("TARGET_MISMATCH");
      const label = current.availability === "AVAILABLE" ? "予約可能" : "完売";
      const badge = row.locator("span.jumpstart_ui__Badge__badge");
      await badge.waitFor({ state: "visible", timeout: 5_000 }).catch(() => { throw new ContractError("DOM_DRIFT"); });
      if (await badge.count() !== 1 || (await badge.innerText()).trim() !== label) throw new ContractError("DOM_DRIFT");
      return row;
    }

    async function authorizeTarget(read) {
      if (!read.selected || !read.coversTarget) throw new ContractError("DOM_DRIFT");
      await verifyAccount();
      await findRow(read.selected);
      snapshot = Object.freeze({ authorized: true, availability: read.selected.availability, listState: read.listState });
      return snapshot;
    }

    async function moveToTargetDate() {
      const textbox = page.getByPlaceholder("日付を選択", { exact: true }).filter({ visible: true });
      if (await textbox.count() !== 1) throw new ContractError("DOM_DRIFT");
      const date = job.localDateTime.slice(0, 10);
      const target = new Date(`${date}T12:00:00.000Z`);
      const monthName = (value) => new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" }).format(value);
      const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
      await textbox.click();
      const grid = page.locator('table[role="grid"]');
      if (await grid.count() !== 1) throw new ContractError("DOM_DRIFT");
      const shown = /^(\w+) (\d{4})$/.exec(await grid.getAttribute("aria-label") ?? "");
      if (!shown || !months.includes(shown[1])) throw new ContractError("DOM_DRIFT");
      const shownIndex = Number(shown[2]) * 12 + months.indexOf(shown[1]);
      const distance = target.getUTCFullYear() * 12 + target.getUTCMonth() - shownIndex;
      if (Math.abs(distance) > 24) throw new ContractError("UNSUPPORTED_TARGET");
      for (let step = 1; step <= Math.abs(distance); step += 1) {
        const next = page.getByRole("button", { name: distance > 0 ? "Go to the Next Month" : "Go to the Previous Month", exact: true });
        if (await next.count() !== 1 || !await next.isEnabled()) throw new ContractError("DOM_DRIFT");
        await next.click();
        const expected = new Date(Date.UTC(Number(shown[2]), months.indexOf(shown[1]) + Math.sign(distance) * step, 1, 12));
        await page.locator(`table[role="grid"][aria-label=${JSON.stringify(monthName(expected))}]`).waitFor({ state: "visible", timeout: 2_000 });
      }
      const dayName = `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][target.getUTCDay()]} ${months[target.getUTCMonth()].slice(0, 3)} ${String(target.getUTCDate()).padStart(2, "0")} ${target.getUTCFullYear()}`;
      const day = page.getByRole("button", { name: dayName, exact: true });
      if (await day.count() !== 1 || !await day.isEnabled()) throw new ContractError("DOM_DRIFT");
      return receiveRead(async () => {
        await day.click();
      }, { targetRequired: true });
    }

    async function loadTarget(mode = "navigate") {
      assertActive();
      snapshot = null;
      const bootstrap = await receiveRead(() => mode === "navigate"
        ? page.goto(availabilityUrl, { waitUntil: "domcontentloaded" }).catch(() => authOrDrift())
        : page.reload({ waitUntil: "domcontentloaded" }).catch(() => authOrDrift()), { targetRequired: false });
      await verifyAccount();
      if (bootstrap.selected && bootstrap.coversTarget) return authorizeTarget(bootstrap);
      return authorizeTarget(await moveToTargetDate());
    }

    async function observationFrom(current) {
      await verifyAccount();
      await findRow(current);
      const open = current.availability === "AVAILABLE";
      return validateObservation({ occurrenceId: job.occurrenceId, sourceStartAtUtc: job.sourceStartAtUtc,
        sourceEndAtUtc: job.sourceEndAtUtc, observedAtUtc: now().toISOString(), manuallyBlocked: !open, bookable: open }, job);
    }

    async function observeTarget() { return observationFrom(await loadTarget("navigate")); }

    async function applyDesiredState() {
      if (job.action === "OBSERVE") return Object.freeze({ changed: false, readOnly: true, observation: await observeTarget(), responseObserved: true });
      const before = await loadTarget("navigate");
      const beforeObservation = await observationFrom(before);
      const desiredAvailability = job.desiredState === "OPEN" ? "AVAILABLE" : "SOLD_OUT";
      if (before.availability === desiredAvailability) return Object.freeze({ changed: false, observation: beforeObservation, responseObserved: true });
      const row = await findRow(before);
      const actionName = desiredAvailability === "AVAILABLE" ? "予約可能" : "完売";
      const action = row.getByRole("button", { name: actionName, exact: true });
      if (await action.count() !== 1) throw new ContractError("DOM_DRIFT");
      await verifyAccount();
      await cloud.preflight(job);
      guard.beginUiAction();
      let ackAccepted = false;
      try {
        const response = page.waitForResponse((candidate) => candidate.url() === `${supplierOrigin}/availability/update`
          && candidate.request().method() === "POST", { timeout: writeResponseTimeoutMs })
          .then((candidate) => { ackAccepted = candidate.status() >= 200 && candidate.status() < 300; }).catch(() => {});
        await action.click();
        await response;
      } finally { guard.endUiAction(); }
      try {
        const after = await loadTarget("reload");
        const observation = await observationFrom(after);
        if (after.availability !== desiredAvailability) throw new ContractError(ackAccepted ? "SAVE_NOT_APPLIED" : "UNKNOWN_AFTER_SAVE");
        return Object.freeze({ changed: true, observation, responseObserved: ackAccepted });
      } catch (error) { if (!ackAccepted && error.code !== "UNKNOWN_AFTER_SAVE") throw new ContractError("UNKNOWN_AFTER_SAVE"); throw error; }
    }

    async function verifyAfterReload() {
      const observation = await observationFrom(await loadTarget(new URL(page.url()).pathname === "/availability/" ? "reload" : "navigate"));
      if (job.action === "SET_CLOSED" && (!observation.manuallyBlocked || observation.bookable)) throw new ContractError("VERIFY_FAILED");
      if (job.action === "SET_OPEN" && (observation.manuallyBlocked || !observation.bookable)) throw new ContractError("VERIFY_FAILED");
      return observation;
    }

    return Object.freeze({ pid: browser.pid, guard, observeTarget, applyDesiredState, verifyAfterReload,
      async debugScreenshot() { if (!config.debugScreenshots) throw new ContractError("DEBUG_SCREENSHOT_DISABLED"); const directory = join(config.privateDir, "debug"); await mkdir(directory, { recursive: true, mode: 0o700 }); await chmod(directory, 0o700); const path = join(directory, `${job.id}.png`); await page.screenshot({ path }); await chmod(path, 0o600); },
      async stop() { stopping = true; guard.freeze(); stopPromise ??= browser.stop(); return stopPromise; } });
  } catch (error) {
    guard?.freeze();
    const stopped = await browser.stop().catch(() => false);
    if (!stopped) throw new ContractError("PROCESS_STOP_UNCONFIRMED");
    throw error;
  }
}
