import { forwardSingleWrite } from "./single-write.mjs";
import { MAX_JSON_BYTES, VIATOR_ORIGIN } from "./constants.mjs";
import { ContractError, exactKeys, isPlainObject } from "./validation.mjs";

export const VIATOR_LIST_STATE_KEYS = Object.freeze([
  "startDate", "endDate", "jumpToDate", "filteredProducts", "filteredTourGrades", "loadDirection",
  "hasMoreAfter", "hasMoreBefore", "perDayPagination",
]);

const AVAILABILITY_KEY_KEYS = ["productCode", "tourGradeCode", "travelDate", "startTime"];
const AVAILABILITY_ROW_KEYS = ["productCode", "tourGradeCode", "startTime", "availability"];

function jsonBytes(request) {
  const raw = request.postData?.();
  return typeof raw === "string" ? Buffer.byteLength(raw) : Infinity;
}

function canonicalDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

const PRODUCT_CODE = /^\d{1,12}P\d{1,8}$/;
const OPTION_CODE = /^TG\d{1,8}$/;
const SCRIPT_NAMES = "rolldown-runtime|react-vendor|jumpstart-vendor|redux-form-vendor|recharts-vendor|vendor|intl-vendor|libphonenumber-vendor|common|Dial|BookingPerformanceDrivenReportUtils|AvailabilityProductFilter\\.module";
const SCRIPT_PATH = new RegExp(`^/static/js/client/(?:(?:${SCRIPT_NAMES})-[a-f0-9]{8}|AvailabilityPage\\.[a-f0-9]{8})\\.js$`);
const STYLE_PATH = /^\/static\/css\/(?:jumpstartUi|common|Dial|BookingPerformanceDrivenReportUtils|AvailabilityProductFilter|AvailabilityPage)\.[a-f0-9]{8}\.css$/;

function optionFilters(value) {
  return isPlainObject(value) && Object.keys(value).length <= 100
    && Object.entries(value).every(([product, options]) => PRODUCT_CODE.test(product) && Array.isArray(options)
      && options.length <= 100 && options.every((option) => typeof option === "string" && OPTION_CODE.test(option)));
}

function pagination(value) {
  return isPlainObject(value) && Object.keys(value).length <= 62
    && Object.entries(value).every(([date, page]) => canonicalDate(date) && exactKeys(page, ["cursor", "hasMore"])
      && Number.isSafeInteger(page.cursor) && page.cursor >= 0 && page.cursor <= 10_000 && typeof page.hasMore === "boolean");
}

function sameJsonValue(left, right) {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((item, index) => sameJsonValue(item, right[index]));
  if (!isPlainObject(left) || !isPlainObject(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index] && sameJsonValue(left[key], right[key]));
}

export function validateViatorListState(value) {
  if (!exactKeys(value, VIATOR_LIST_STATE_KEYS)) return false;
  if (![value.startDate, value.endDate, value.jumpToDate].every(canonicalDate)) return false;
  if (value.startDate > value.endDate || Date.parse(`${value.endDate}T00:00:00Z`) - Date.parse(`${value.startDate}T00:00:00Z`) > 62 * 86_400_000) return false;
  if (!Array.isArray(value.filteredProducts) || value.filteredProducts.length > 100
    || value.filteredProducts.some((item) => typeof item !== "string" || !PRODUCT_CODE.test(item))
    || !optionFilters(value.filteredTourGrades) || !pagination(value.perDayPagination)) return false;
  return ["FORWARD", "BACKWARD", "BIDIRECTIONAL"].includes(value.loadDirection)
    && typeof value.hasMoreAfter === "boolean" && typeof value.hasMoreBefore === "boolean";
}

export function validateViatorReadBody(body) {
  return validateViatorListState(body);
}

export function viatorListStateCoversTarget(value, job) {
  if (!validateViatorListState(value)) return false;
  const date = job.localDateTime.slice(0, 10);
  const productScope = value.filteredProducts.length === 0
    || (value.filteredProducts.length === 1 && value.filteredProducts[0] === job.target.externalProductId);
  const optionEntries = Object.entries(value.filteredTourGrades);
  const optionScope = optionEntries.length === 0 || (optionEntries.length === 1
    && optionEntries[0][0] === job.target.externalProductId
    && (optionEntries[0][1].length === 0 || (optionEntries[0][1].length === 1 && optionEntries[0][1][0] === job.target.externalOptionId)));
  return value.startDate <= date && value.endDate >= date && productScope && optionScope;
}

export function validateViatorUpdate(body, job, snapshot) {
  if (!exactKeys(body, ["availabilityKeys", "availability", "prevAvailability", "isBulkUpdate", "availabilityListState"])
    || !Array.isArray(body.availabilityKeys) || body.availabilityKeys.length !== 1 || body.isBulkUpdate !== false
    || !["AVAILABLE", "SOLD_OUT"].includes(body.availability)
    || !["AVAILABLE", "SOLD_OUT"].includes(body.prevAvailability)
    || body.availability !== (job.desiredState === "OPEN" ? "AVAILABLE" : "SOLD_OUT")
    || snapshot?.authorized !== true || body.prevAvailability !== snapshot.availability
    || !viatorListStateCoversTarget(snapshot.listState, job) || !sameJsonValue(body.availabilityListState, snapshot.listState)) return false;
  const key = body.availabilityKeys[0];
  return exactKeys(key, AVAILABILITY_KEY_KEYS)
    && key.productCode === job.target.externalProductId
    && key.tourGradeCode === job.target.externalOptionId
    && key.travelDate === job.localDateTime.slice(0, 10)
    && key.startTime === `${job.localDateTime.slice(11, 19)}`;
}

export function selectViatorAvailability(value, job, { allowMissing = false } = {}) {
  if (!isPlainObject(value) || !isPlainObject(value.availabilities)) throw new ContractError("DOM_DRIFT");
  const dates = Object.keys(value.availabilities);
  if (dates.length > 62 || dates.some((date) => !canonicalDate(date))) throw new ContractError("DOM_DRIFT");
  for (const rowsForDate of Object.values(value.availabilities)) {
    if (!Array.isArray(rowsForDate) || rowsForDate.length > 500) throw new ContractError("DOM_DRIFT");
  }
  const date = job.localDateTime.slice(0, 10);
  const rows = value.availabilities[date];
  if (rows === undefined && allowMissing) return null;
  if (!Array.isArray(rows) || rows.length > 500) throw new ContractError("DOM_DRIFT");
  const matches = rows.filter((row) => exactKeys(row, AVAILABILITY_ROW_KEYS)
    && row.productCode === job.target.externalProductId && row.tourGradeCode === job.target.externalOptionId
    && row.startTime === job.localDateTime.slice(11, 19)
    && ["AVAILABLE", "SOLD_OUT"].includes(row.availability));
  if (matches.length === 0 && allowMissing) return null;
  if (matches.length !== 1) throw new ContractError("DOM_DRIFT");
  return Object.freeze({ availability: matches[0].availability });
}

export function createViatorNetworkGuard({ job, cloud, getSnapshot, assertWriteContext = async () => {}, supplierOrigin = VIATOR_ORIGIN }) {
  let permit = null;
  let writes = 0;
  let refused = 0;
  let fatalWrite = null;
  let externalNavigationBlocked = false;
  let frozen = false;
  const forward = (route) => typeof route.fallback === "function" ? route.fallback() : route.continue();
  const refuse = (route, fatal = false) => {
    refused += 1;
    if (fatal) fatalWrite = new ContractError("WRITE_REFUSED");
    return route.abort("blockedbyclient");
  };

  async function handle(route) {
    if (frozen) return refuse(route);
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== supplierOrigin) {
      if (request.isNavigationRequest?.()) externalNavigationBlocked = true;
      return refuse(route);
    }
    const method = request.method();
    if (method === "GET") {
      const navigation = request.isNavigationRequest?.() === true;
      const fixedPage = url.pathname === "/availability/" && url.searchParams.size === 0;
      const type = request.resourceType?.();
      const asset = !navigation && url.search === ""
        && ((type === "script" && SCRIPT_PATH.test(url.pathname)) || (type === "stylesheet" && STYLE_PATH.test(url.pathname)));
      if (navigation && !fixedPage) externalNavigationBlocked = true;
      return fixedPage || asset ? forward(route) : refuse(route);
    }
    if (method !== "POST" || url.search !== "" || jsonBytes(request) > MAX_JSON_BYTES) return refuse(route, permit !== null);
    if (request.headers?.()["content-type"]?.split(";")[0] !== "application/json") return refuse(route, permit !== null);
    let body;
    try { body = request.postDataJSON(); } catch { return refuse(route, permit !== null); }
    if (url.pathname === "/availability/api" && validateViatorReadBody(body)) return forward(route);
    if (url.pathname !== "/availability/update" || !permit || !validateViatorUpdate(body, job, getSnapshot())) {
      return refuse(route, permit !== null || url.pathname === "/availability/update");
    }
    if (permit.used) return refuse(route);
    if (writes >= 1) return refuse(route, true);
    const reserved = permit;
    reserved.used = true;
    try {
      await assertWriteContext();
      await cloud.preflight(job);
    } catch (error) { fatalWrite = error; return refuse(route); }
    if (frozen || permit !== reserved || fatalWrite) return refuse(route);
    writes += 1;
    return forwardSingleWrite(route);
  }

  return Object.freeze({
    handle,
    beginUiAction() { if (permit) throw new ContractError("WRITE_PERMIT_ACTIVE"); permit = { used: false }; },
    endUiAction() { const current = permit; permit = null; if (fatalWrite) { const error = fatalWrite; fatalWrite = null; throw error; } return Object.freeze({ writes: current?.used ? 1 : 0 }); },
    freeze() { frozen = true; permit = null; },
    get writes() { return writes; }, get refused() { return refused; }, get fatalWrite() { return fatalWrite; }, get externalNavigationBlocked() { return externalNavigationBlocked; },
  });
}
