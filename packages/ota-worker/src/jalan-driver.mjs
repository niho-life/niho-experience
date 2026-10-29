import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { JALAN_ORIGIN } from "./constants.mjs";
import { selectAccountProfile } from "./config.mjs";
import { startManagedBrowser } from "./managed-browser.mjs";
import { ContractError, tokyoLocalFromUtc, validateObservation } from "./validation.mjs";
import { createJalanNetworkGuard, parseJsonp, selectJalanSlot, validateJalanBootstrap } from "./jalan-network-guard.mjs";
import { assertAuthOrDrift, fixedTestOrigin, prepareGuardedPage } from "./browser-driver-common.mjs";

const normalizedText = (value) => value.replace(/\s+/g, " ").trim();

export async function createJalanDriver({ job, cloud, config, now = () => new Date(), testOnlySupplierOrigin,
  allowLocalTestOrigin = false, headless = false, browserFactory = startManagedBrowser, responseTimeoutMs = 15_000, writeResponseTimeoutMs = 10_000 }) {
  const supplierOrigin = fixedTestOrigin(testOnlySupplierOrigin, JALAN_ORIGIN, allowLocalTestOrigin);
  const profile = selectAccountProfile(config, job.target);
  const endLocal = tokyoLocalFromUtc(job.sourceEndAtUtc);
  if (endLocal.slice(0, 10) !== job.localDateTime.slice(0, 10)) throw new ContractError("UNSUPPORTED_TARGET");
  const browser = await browserFactory({ executablePath: config.browserExecutable, userDataDir: profile, headless });
  let guard;
  try {
    let snapshot = null;
    guard = createJalanNetworkGuard({ job, cloud, supplierOrigin, getSnapshot: () => snapshot,
      assertWriteContext: async () => verifyAccount() });
    const page = await prepareGuardedPage({ browser, guard, supplierOrigin });
    const stockUrl = `${supplierOrigin}/activityboard/bookingStockMgt/`;
    const expectedEndHm = endLocal.slice(11, 16);
    let stopping = false;
    let stopPromise = null;
    const authOrDrift = () => assertAuthOrDrift({ page, guard, supplierOrigin, signInPattern: /ログイン|sign in|log in|認証/i });
    const assertActive = () => { if (stopping) throw new ContractError("DRIVER_STOPPED"); };

    async function verifyAccount() {
      const banners = page.getByRole("banner");
      if (await banners.count() !== 1) return authOrDrift();
      const items = banners.getByRole("listitem");
      const expected = `AirID ${job.target.externalAccountId}`;
      const matches = [];
      for (let index = 0; index < await items.count(); index += 1) {
        const item = items.nth(index);
        if (!/^AirID [A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(normalizedText(await item.innerText()))) continue;
        const descendants = item.getByRole("listitem");
        let nestedMatch = false;
        for (let child = 0; child < await descendants.count(); child += 1) {
          if (normalizedText(await descendants.nth(child).innerText()) === expected) { nestedMatch = true; break; }
        }
        if (!nestedMatch) matches.push(item);
      }
      if (matches.length !== 1) return authOrDrift();
      if (normalizedText(await matches[0].innerText()) !== expected) throw new ContractError("ACCOUNT_MISMATCH");
    }

    async function receiveSummary(trigger, { targetRequired, expectedBaseDate }) {
      const responsePromise = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return url.origin === supplierOrigin && url.pathname === "/stateful/schdl/client/summary" && response.request().method() === "GET"
          && (expectedBaseDate === undefined || url.searchParams.get("dspBaseDate") === expectedBaseDate);
      }, { timeout: responseTimeoutMs }).catch(() => null);
      await trigger();
      const response = await responsePromise;
      if (!response) return authOrDrift();
      const contentType = response.headers()["content-type"]?.split(";")[0];
      if (response.status() !== 200 || !["application/javascript", "text/javascript"].includes(contentType)) throw new ContractError("DOM_DRIFT");
      const callback = new URL(response.url()).searchParams.get("callback");
      if (!callback) throw new ContractError("DOM_DRIFT");
      await verifyAccount();
      const parsed = parseJsonp(await response.text(), callback);
      const range = validateJalanBootstrap(parsed, job);
      let selected = null;
      try { selected = selectJalanSlot(parsed, job, expectedEndHm); }
      catch (error) { if (targetRequired || !["DOM_DRIFT", "UNSUPPORTED_TARGET"].includes(error.code)) throw error; }
      if (targetRequired && !selected) throw new ContractError("DOM_DRIFT");
      return Object.freeze({ range, selected });
    }

    async function findSlot(current) {
      const plan = page.locator(`select option[value=${JSON.stringify(job.target.externalProductId)}]`);
      if (await plan.count() !== 1 || await plan.locator("..").inputValue() !== job.target.externalProductId) throw new ContractError("PRODUCT_MISMATCH");
      if (await page.getByRole("heading").filter({ hasText: job.target.externalProductId }).count() !== 1) throw new ContractError("PRODUCT_MISMATCH");
      const slot = page.locator(`[id=${JSON.stringify(current.slotId)}]`);
      if (await slot.count() !== 1) throw new ContractError("TARGET_MISMATCH");
      const link = slot.locator('a[data-bind="click: $root.onClickSlot.bind($data, $index(), $parent, $parents[1])"]');
      if (await link.count() !== 1) throw new ContractError("DOM_DRIFT");
      const saleStop = (await slot.getAttribute("class") ?? "").split(/\s+/).includes("sale-stop");
      if (saleStop !== !current.frontOpenFlg || (current.frontOpenFlg && current.receptionStatus !== "KeyOPEN")) throw new ContractError("DOM_DRIFT");
      return { slot, link };
    }

    async function authorizeTarget(read) {
      if (!read.selected) throw new ContractError("DOM_DRIFT");
      await verifyAccount();
      await findSlot(read.selected);
      snapshot = Object.freeze({ ...read.selected, authorized: true });
      return snapshot;
    }

    async function moveToTargetDate() {
      const textbox = page.getByRole("textbox");
      if (await textbox.count() !== 1) throw new ContractError("DOM_DRIFT");
      const date = job.localDateTime.slice(0, 10);
      return receiveSummary(async () => {
        await textbox.click();
        const picker = page.locator(".ui-datepicker:visible");
        if (await picker.count() !== 1) throw new ContractError("DOM_DRIFT");
        const targetYear = Number(date.slice(0, 4));
        const targetMonth = Number(date.slice(5, 7));
        for (let step = 0; ; step += 1) {
          assertActive();
          const year = normalizedText(await picker.locator(".ui-datepicker-year").innerText());
          const month = normalizedText(await picker.locator(".ui-datepicker-month").innerText());
          if (!/^\d{4}$/.test(year) || !/^(?:[1-9]|1[0-2])月$/.test(month)) throw new ContractError("DOM_DRIFT");
          const difference = (targetYear - Number(year)) * 12 + targetMonth - Number(month.slice(0, -1));
          if (difference === 0) break;
          if (step >= 24 || Math.abs(difference) > 24) throw new ContractError("UNSUPPORTED_TARGET");
          const navigation = picker.locator(`a[data-handler="${difference > 0 ? "next" : "prev"}"]`);
          if (await navigation.count() !== 1) throw new ContractError("DOM_DRIFT");
          await navigation.click();
        }
        const day = picker.locator(`td[data-handler="selectDay"][data-year="${targetYear}"][data-month="${targetMonth - 1}"]`)
          .getByRole("link", { name: String(Number(date.slice(8, 10))), exact: true });
        if (await day.count() !== 1) throw new ContractError("DOM_DRIFT");
        await day.click();
      }, { targetRequired: true, expectedBaseDate: date.replaceAll("-", "") });
    }

    async function loadTarget(mode = "navigate") {
      assertActive();
      snapshot = null;
      let read;
      if (mode === "refresh") {
        const link = page.getByRole("link", { name: "最新の情報に更新", exact: true });
        if (await link.count() !== 1) throw new ContractError("DOM_DRIFT");
        read = await receiveSummary(() => link.click(), { targetRequired: true });
      } else {
        read = await receiveSummary(() => mode === "navigate"
          ? page.goto(stockUrl, { waitUntil: "domcontentloaded" }).catch(() => authOrDrift())
          : page.reload({ waitUntil: "domcontentloaded" }).catch(() => authOrDrift()), { targetRequired: false });
        await verifyAccount();
        if (!read.selected) read = await moveToTargetDate();
      }
      return authorizeTarget(read);
    }

    async function observationFrom(current) {
      await verifyAccount();
      await findSlot(current);
      const bookable = current.frontOpenFlg && current.receptionStatus === "KeyOPEN";
      return validateObservation({ occurrenceId: job.occurrenceId, sourceStartAtUtc: job.sourceStartAtUtc,
        sourceEndAtUtc: job.sourceEndAtUtc, observedAtUtc: now().toISOString(), manuallyBlocked: !current.frontOpenFlg, bookable }, job);
    }

    async function observeTarget() { return observationFrom(await loadTarget("navigate")); }

    async function applyDesiredState() {
      if (job.action === "OBSERVE") return Object.freeze({ changed: false, readOnly: true, observation: await observeTarget(), responseObserved: true });
      const before = await loadTarget("navigate");
      const beforeObservation = await observationFrom(before);
      const desiredOpen = job.desiredState === "OPEN";
      if (before.frontOpenFlg === desiredOpen) return Object.freeze({ changed: false, observation: beforeObservation, responseObserved: true });
      const selectedCount = page.getByText(/^\d+\/14$/);
      if (await selectedCount.count() !== 1 || normalizedText(await selectedCount.innerText()) !== "0/14") throw new ContractError("DOM_DRIFT");
      const { link } = await findSlot(before);
      await verifyAccount();
      await cloud.preflight(job);
      guard.beginUiAction();
      let ackAccepted = false;
      try {
        await link.click();
        if (normalizedText(await selectedCount.innerText()) !== "1/14") throw new ContractError("DOM_DRIFT");
        const palette = page.locator("select.js-panel-saleStatus");
        if (await palette.count() !== 1) throw new ContractError("DOM_DRIFT");
        await palette.selectOption({ label: desiredOpen ? "販売" : "売止" });
        const response = page.waitForResponse((candidate) => candidate.url() === `${supplierOrigin}/stateful/schdl/client/complete`
          && candidate.request().method() === "POST", { timeout: writeResponseTimeoutMs })
          .then((candidate) => { ackAccepted = candidate.status() >= 200 && candidate.status() < 300; }).catch(() => {});
        await page.getByRole("button", { name: "一括変更する", exact: true }).click();
        await response;
      } finally { guard.endUiAction(); }
      try {
        const after = await loadTarget("refresh");
        const observation = await observationFrom(after);
        if (after.frontOpenFlg !== desiredOpen) throw new ContractError(ackAccepted ? "SAVE_NOT_APPLIED" : "UNKNOWN_AFTER_SAVE");
        return Object.freeze({ changed: true, observation, responseObserved: ackAccepted });
      } catch (error) { if (!ackAccepted && error.code !== "UNKNOWN_AFTER_SAVE") throw new ContractError("UNKNOWN_AFTER_SAVE"); throw error; }
    }

    async function verifyAfterReload() {
      const observation = await observationFrom(await loadTarget(new URL(page.url()).pathname === "/activityboard/bookingStockMgt/" ? "reload" : "navigate"));
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
