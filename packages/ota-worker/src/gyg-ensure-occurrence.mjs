import { pageGraphqlFetch } from "./browser-driver-common.mjs";
import {
  MAX_SCHEDULE_RESPONSE_BYTES,
  SCHEDULE_STEP_OPERATION,
  normalizeScheduleRead,
  planEnsureOccurrence,
  sameSchedule,
  scheduleReadRequest,
  scheduleStepSucceeded,
} from "./gyg-schedule-protocol.mjs";
import { ContractError, exactKeys, isPlainObject, validatePreflight } from "./validation.mjs";

const APP_READ_TIMEOUT_MS = 15_000;
const AGENDA_IDLE_MS = 8_000;
const AGENDA_ROW_MS = 3_000;
const FETCH_TIMEOUT_MS = 15_000;
const UI_STEP_MS = 10_000;
const SAVE_RESPONSE_MS = 15_000;
const MAX_STEP_RESPONSE_BYTES = 64 * 1024;

// In-page: the "Show/Hide schedules" toggle of one option. Each option renders
// its edit testid twice (split button); deduplicated, the option order matches
// the order of the schedule toggles.
function findScheduleToggle({ optionId }) {
  const prefix = "product-option-edit-button-";
  const ids = [];
  for (const element of document.querySelectorAll(`[data-testid^="${prefix}"]`)) {
    const id = element.getAttribute("data-testid").slice(prefix.length);
    if (!ids.includes(id)) ids.push(id);
  }
  const toggles = [...document.querySelectorAll("button")]
    .filter((button) => /^(?:Show|Hide) schedules$/.test((button.textContent ?? "").replace(/\s+/g, " ").trim()));
  const index = ids.indexOf(optionId);
  return ids.length > 0 && ids.length === toggles.length && index >= 0 ? toggles[index] : null;
}

// In-page: the pencil button on the row showing the schedule name. Hidden
// copies of the name exist, so only visible leaves whose row (nearest ancestor
// with 1-4 buttons) holds exactly one visible, text-less pencil button count.
function findSchedulePencil({ name }) {
  const normalize = (text) => (text ?? "").replace(/\s+/g, " ").trim();
  const visible = (element) => element.getClientRects().length > 0
    && (typeof element.checkVisibility !== "function" || element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }));
  const wanted = normalize(name);
  const pencils = new Set();
  for (const leaf of document.querySelectorAll("body *")) {
    if (leaf.children.length !== 0 || normalize(leaf.textContent) !== wanted || !visible(leaf)) continue;
    let row = leaf.parentElement;
    while (row && row.querySelectorAll("button").length === 0) row = row.parentElement;
    if (!row) continue;
    const buttons = [...row.querySelectorAll("button")];
    if (buttons.length > 4) continue;
    const pens = buttons.filter((button) => visible(button) && normalize(button.innerText) === ""
      && (button.matches('[class*="i-pen-edit"]') || button.querySelector('[class*="i-pen-edit"]') !== null));
    if (pens.length === 1) pencils.add(pens[0]);
  }
  return pencils.size === 1 ? [...pencils][0] : null;
}

function isScheduleStepRequest(request, graphqlUrl) {
  if (request.url() !== graphqlUrl || request.method() !== "POST") return false;
  try { return request.postDataJSON()?.operationName === SCHEDULE_STEP_OPERATION; } catch { return false; }
}

export function createGygEnsureOccurrence({
  job, page, guard, cloud, supplierOrigin, availabilityUrl, rowId,
  verifyAccount, observeAtCurrentPage, authOrDrift, assertActive,
}) {
  const productUrl = `${supplierOrigin}/products/details?tour_id=${job.target.externalProductId}`;
  const graphqlUrl = `${supplierOrigin}/graphql`;
  const unknownAfterSave = () => new ContractError("UNKNOWN_AFTER_SAVE");

  // Leaving the saved step may raise beforeunload; the guard still owns writes.
  const onDialog = (dialog) => {
    void (dialog.type() === "beforeunload" ? dialog.accept() : dialog.dismiss()).catch(() => {});
  };

  function assertSupplierPage(pathname) {
    if (guard.fatalWrite) throw guard.fatalWrite;
    if (guard.externalNavigationBlocked) throw new ContractError("AUTH_REQUIRED");
    let current;
    try { current = new URL(page.url()); } catch { throw new ContractError("DOM_DRIFT"); }
    if (["http:", "https:"].includes(current.protocol) && current.origin !== supplierOrigin) throw new ContractError("AUTH_REQUIRED");
    if (current.origin !== supplierOrigin || current.pathname !== pathname) throw new ContractError("DOM_DRIFT");
  }

  // Returns the observation when the agenda already lists the occurrence,
  // otherwise null after the supplier app has loaded and gone quiet.
  async function findExistingOccurrence() {
    assertActive();
    const reads = guard.appReads;
    await page.goto(availabilityUrl, { waitUntil: "domcontentloaded" }).catch(() => authOrDrift());
    if (guard.fatalWrite) throw guard.fatalWrite;
    if (!await guard.waitForAppRead(reads, APP_READ_TIMEOUT_MS)) return authOrDrift();
    await page.waitForLoadState("networkidle", { timeout: AGENDA_IDLE_MS }).catch(() => {});
    const toggle = page.getByTestId(rowId);
    await toggle.waitFor({ state: "attached", timeout: AGENDA_ROW_MS }).catch(() => {});
    assertActive();
    if (await toggle.count() === 0) {
      assertSupplierPage("/manage/availability");
      return null;
    }
    return observeAtCurrentPage();
  }

  async function readSchedule() {
    assertActive();
    const readRequest = JSON.stringify(scheduleReadRequest(job.target.externalOptionId));
    const headers = { ...guard.sessionHeaders(), "content-type": "application/json" };
    let result;
    try {
      result = await page.evaluate(pageGraphqlFetch, {
        body: readRequest, headers, maxBytes: MAX_SCHEDULE_RESPONSE_BYTES, timeoutMs: FETCH_TIMEOUT_MS,
      });
    } catch {
      assertActive();
      throw new ContractError("NETWORK_ERROR");
    }
    assertActive();
    if (exactKeys(result, ["failure"]) && ["TIMEOUT", "NETWORK_ERROR"].includes(result.failure)) throw new ContractError(result.failure);
    if (!exactKeys(result, ["status", "bodyText"]) || !Number.isSafeInteger(result.status) || typeof result.bodyText !== "string") {
      throw new ContractError("DOM_DRIFT");
    }
    if (result.status === 401 || result.status === 403) throw new ContractError("AUTH_REQUIRED");
    if (result.status < 200 || result.status > 299) throw new ContractError("HTTP_ERROR");
    let body;
    try { body = JSON.parse(result.bodyText); } catch { throw new ContractError("DOM_DRIFT"); }
    return normalizeScheduleRead(body, job.target);
  }

  async function openScheduleEditor(name) {
    assertActive();
    await page.goto(productUrl, { waitUntil: "domcontentloaded" }).catch(() => authOrDrift());
    if (guard.fatalWrite) throw guard.fatalWrite;
    await page.getByTestId(`product-option-edit-button-${job.target.externalOptionId}`).first()
      .waitFor({ state: "attached" }).catch(() => authOrDrift());
    assertSupplierPage("/products/details");
    const toggle = (await page.evaluateHandle(findScheduleToggle, { optionId: job.target.externalOptionId })).asElement();
    if (!toggle) throw new ContractError("DOM_DRIFT");
    const label = ((await toggle.textContent()) ?? "").replace(/\s+/g, " ").trim();
    if (label === "Show schedules") await toggle.click({ timeout: UI_STEP_MS }).catch(() => { throw new ContractError("DOM_DRIFT"); });
    assertActive();
    const pencil = await page.waitForFunction(findSchedulePencil, { name }, { timeout: UI_STEP_MS })
      .then((handle) => handle.asElement()).catch(() => null);
    if (!pencil) throw new ContractError("DOM_DRIFT");
    await pencil.click({ timeout: UI_STEP_MS }).catch(() => { throw new ContractError("DOM_DRIFT"); });
    assertActive();
    const save = page.getByTestId("stepper-save-and-continue");
    await save.waitFor({ state: "visible", timeout: UI_STEP_MS }).catch(() => { throw new ContractError("DOM_DRIFT"); });
    if (await save.count() !== 1) throw new ContractError("DOM_DRIFT");
    return save;
  }

  // One click on step 1 save. The guard forwards at most one schedule step
  // mutation and only after matching the screen's variables to `plan`.
  async function saveOnce(save, plan) {
    validatePreflight(await cloud.preflight(job), "OPEN");
    assertActive();
    guard.beginScheduleWrite(plan);
    let settled = { timeout: true };
    let guardError = null;
    try {
      const outcome = Promise.race([
        page.waitForResponse((response) => isScheduleStepRequest(response.request(), graphqlUrl), { timeout: SAVE_RESPONSE_MS })
          .then((response) => ({ response })),
        page.waitForEvent("requestfailed", { predicate: (request) => isScheduleStepRequest(request, graphqlUrl), timeout: SAVE_RESPONSE_MS })
          .then(() => ({ failed: true })),
      ]).catch(() => ({ timeout: true }));
      await save.click({ timeout: UI_STEP_MS }).catch(() => {});
      settled = await outcome;
      if (settled.response) {
        const response = settled.response;
        let body = null;
        try {
          const text = await response.text();
          if (text.length <= MAX_STEP_RESPONSE_BYTES) body = JSON.parse(text);
        } catch {}
        settled = { status: response.status(), body };
      }
    } finally {
      try { guard.endScheduleWrite(); } catch (error) { guardError = error; }
    }
    // Read after the permit closed: a reservation still awaiting preflight can
    // no longer forward, so zero here means nothing reached the supplier.
    if (guard.writes === 0) throw guardError ?? new ContractError("DOM_DRIFT");
    if (guardError || !isPlainObject(settled.body)) throw unknownAfterSave();
    return settled.status >= 200 && settled.status <= 299 && scheduleStepSucceeded(settled.body);
  }

  async function confirmCreated(plan) {
    let after;
    try { after = await readSchedule(); } catch { throw unknownAfterSave(); }
    if (!sameSchedule(after, plan.expectedAfter)) throw unknownAfterSave();
    try {
      await page.goto(availabilityUrl, { waitUntil: "domcontentloaded" }).catch(() => authOrDrift());
      return await observeAtCurrentPage();
    } catch {
      throw unknownAfterSave();
    }
  }

  return async function ensureOccurrence() {
    assertActive();
    if (job.action !== "ENSURE_OCCURRENCE") throw new ContractError("WRITE_REFUSED");
    await verifyAccount();
    const existing = await findExistingOccurrence();
    if (existing) return Object.freeze({ created: false, observation: existing });
    const before = await readSchedule();
    const plan = planEnsureOccurrence(before, job);
    page.on("dialog", onDialog);
    const save = await openScheduleEditor(plan.block.name);
    assertActive();
    const succeeded = await saveOnce(save, plan);
    if (!succeeded) {
      let reread;
      try { reread = await readSchedule(); } catch { throw unknownAfterSave(); }
      throw sameSchedule(reread, before) ? new ContractError("SAVE_NOT_APPLIED") : unknownAfterSave();
    }
    return Object.freeze({ created: true, observation: await confirmCreated(plan) });
  };
}
