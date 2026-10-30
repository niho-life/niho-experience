import { forwardSingleWrite } from "./single-write.mjs";
import { JALAN_ORIGIN, MAX_JSON_BYTES } from "./constants.mjs";
import { ContractError, exactKeys } from "./validation.mjs";

const COMPLETE_SLOT_KEYS = ["slotId", "version", "frontOpenFlg", "bookingAvailableKbn", "cfmBookingLimMgrKbn", "cfmCapaCnt", "lessonSchdlId", "lessonSchdlVersion"];
const SUMMARY_QUERY_KEYS = ["callback", "dspBaseDate", "dspRange", "pageSize", "pageNo", "schdlKbn", "groupSchdlId", "lessonSchdlId", "includeSaleStops"];
const SUMMARY_OPTIONAL_QUERY_KEYS = ["_"];
const SCRIPT_PATHS = new Set([
  // Stock initialization calls this supplier-defined `s` global synchronously.
  // Its outbound analytics requests remain outside the GET allowlist.
  "/js/sitecatalyst/s_code.js",
  "/js/lib/jquery-2.1.1.min.js", "/js/com/jquery.serialize-object.min.js", "/js/com/jquery-ui.min.js",
  "/js/com/jquery-ui-i18n.min.js", "/js/com/jquery.ui.datepicker-ja.js", "/js/lib/datepicker.js",
  "/js/com/knockout-3.0.0rc.js", "/js/com/knockout.mapping-latest.js", "/js/com/jquery.cookie.js",
  "/js/lib/moment-with-locales.min.js", "/js/lib/jquery.placeholder.js", "/js/com/exValidation.js",
  "/js/com/exchecker-ja.js", "/js/lib/airCommonMenu.min.js", "/js/lib/jquery.floatThead.min.js",
  "/js/common_activeJalan.js", "/js/com/RSVConstants.js", "/js/com/AjaxCommon.js",
  "/js/com/ProductProcessingRegister.js", "/js/com/RSVBallon.js", "/js/com/Pagination.js",
  "/js/com/cl/headerNav.js", "/js/pc/modal/openCloseModal.js", "/js/pc/calendar/calendar.js",
]);
const STYLE_PATHS = new Set(["/css/common_activeJalan.css", "/css/calendar.css", "/css/common_headerNav.css"]);

function isStockAsset(request, url) {
  const version = url.searchParams.get("date");
  if ([...url.searchParams.keys()].some((key) => key !== "date") || url.searchParams.getAll("date").length > 1
    || (version !== null && !/^[A-Za-z0-9._-]{1,64}$/.test(version))) return false;
  return (request.resourceType?.() === "script" && SCRIPT_PATHS.has(url.pathname))
    || (request.resourceType?.() === "stylesheet" && STYLE_PATHS.has(url.pathname));
}

function isStockBackgroundRead(request, url) {
  if (url.pathname === "/activityboard/schedule/readOpenStatus/") {
    return ["xhr", "fetch"].includes(request.resourceType?.())
      && [...url.searchParams.keys()].every((key) => ["time", "_"].includes(key))
      && ["time", "_"].every((key) => url.searchParams.getAll(key).length === 1 && /^\d{10,16}$/.test(url.searchParams.get(key)));
  }
  if (url.pathname === "/stateful/booking/message/summary") {
    return ["xhr", "fetch"].includes(request.resourceType?.())
      && [...url.searchParams.keys()].every((key) => key === "_")
      && url.searchParams.getAll("_").length === 1 && /^\d{10,16}$/.test(url.searchParams.get("_"));
  }
  // The common header performs this read during stock-page initialization. Its
  // generic Ajax failure handler otherwise redirects the page to login.
  return ["/stateful/notice/summary", "/stateful/schdl/group/names", "/stateful/schdl/lesson/names"].includes(url.pathname)
    && [...url.searchParams.keys()].every((key) => ["callback", "_"].includes(key))
    && url.searchParams.getAll("callback").length === 1 && /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(url.searchParams.get("callback"))
    && url.searchParams.getAll("_").length === 1 && /^\d{10,16}$/.test(url.searchParams.get("_"));
}

function canonicalCompactDate(value) {
  if (!/^\d{8}$/.test(value)) return false;
  const iso = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  const parsed = new Date(`${iso}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === iso;
}

export function validateJalanSummaryUrl(url, job) {
  const allowed = new Set([...SUMMARY_QUERY_KEYS, ...SUMMARY_OPTIONAL_QUERY_KEYS]);
  if (url.pathname !== "/stateful/schdl/client/summary" || [...url.searchParams.keys()].some((key) => !allowed.has(key))) return false;
  if (SUMMARY_QUERY_KEYS.some((key) => url.searchParams.getAll(key).length !== 1)
    || SUMMARY_OPTIONAL_QUERY_KEYS.some((key) => url.searchParams.getAll(key).length > 1)) return false;
  const one = (key) => url.searchParams.get(key) ?? "";
  return /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(one("callback"))
    && (one("dspBaseDate") === "" || canonicalCompactDate(one("dspBaseDate")))
    && /^\d{1,2}$/.test(one("dspRange")) && Number(one("dspRange")) >= 1 && Number(one("dspRange")) <= 31
    && /^\d{1,3}$/.test(one("pageSize")) && Number(one("pageSize")) <= 100
    && /^\d{1,4}$/.test(one("pageNo")) && Number(one("pageNo")) >= 1
    && /^[A-Za-z0-9_-]{0,64}$/.test(one("schdlKbn"))
    && /^[A-Za-z0-9_-]{0,128}$/.test(one("groupSchdlId"))
    && one("lessonSchdlId") === job.target.externalProductId
    && /^(?:true|false)$/.test(one("includeSaleStops"))
    && (one("_") === "" || /^\d{1,20}$/.test(one("_")));
}

export function parseJsonp(raw, callback) {
  if (typeof raw !== "string" || Buffer.byteLength(raw) > MAX_JSON_BYTES || !/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(callback)) {
    throw new ContractError("DOM_DRIFT");
  }
  const source = raw.trim();
  if (!source.startsWith(callback) || !source.endsWith(");")) throw new ContractError("DOM_DRIFT");
  // The observed supplier response uses `callback (`. Permit only whitespace
  // between the exact requested callback and its JSON argument; never evaluate it.
  const invocation = /^[\t\r\n ]*\(/.exec(source.slice(callback.length));
  if (!invocation) throw new ContractError("DOM_DRIFT");
  try { return JSON.parse(source.slice(callback.length + invocation[0].length, -2)); }
  catch { throw new ContractError("DOM_DRIFT"); }
}

function dateKey(day) {
  if (!Number.isInteger(day?.year) || !Number.isInteger(day?.month) || !Number.isInteger(day?.day)) return null;
  const value = `${String(day.year).padStart(4, "0")}-${String(day.month).padStart(2, "0")}-${String(day.day).padStart(2, "0")}`;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? value : null;
}

export function selectJalanSlot(value, job, expectedEndHm) {
  const dto = value?.dto;
  if (!dto || !Array.isArray(dto.dispDays) || !Array.isArray(dto.plans) || dto.plans.length > 100 || dto.dispDays.length > 31) throw new ContractError("DOM_DRIFT");
  const date = job.localDateTime.slice(0, 10);
  const dayIndexes = dto.dispDays.map((day, index) => dateKey(day) === date ? index : -1).filter((index) => index >= 0);
  const plans = dto.plans.filter((plan) => plan?.lessonSchdlId === job.target.externalProductId);
  if (dayIndexes.length !== 1 || plans.length !== 1 || dto.selectedLessonSchdlId !== job.target.externalProductId || !Array.isArray(plans[0].tmzs)) throw new ContractError("DOM_DRIFT");
  const seq = Number(job.target.externalOptionId);
  const tmzs = plans[0].tmzs.filter((tmz) => tmz?.timeZoneSeqNo === seq && tmz.startHm === job.localDateTime.slice(11, 16) && tmz.endHm === expectedEndHm);
  if (tmzs.length !== 1 || !Array.isArray(tmzs[0].slots) || tmzs[0].slots.length !== dto.dispDays.length) throw new ContractError("DOM_DRIFT");
  const slot = tmzs[0].slots[dayIndexes[0]];
  if (!slot || typeof slot.slotId !== "string" || slot.slotId.length < 1 || slot.slotId.length > 128
    || typeof slot.frontOpenFlg !== "boolean" || !["KeyOPEN", "KeyCLOSE"].includes(slot.receptionStatus)
    || slot.bookingAvailableKbn !== "KeyUNCONFIRMED" || slot.cfmBookingLimMgrKbn !== null
    || slot.cfmCapaBookingCnt !== 0 || slot.cfmCapaPaxCnt !== 0
    || slot.cfmEntryBookingCnt !== 0 || slot.cfmEntryPaxCnt !== 0
    || slot.uncfmEntryBookingCnt !== 0 || slot.uncfmEntryPaxCnt !== 0
    || !Number.isSafeInteger(slot.version) || !Number.isSafeInteger(plans[0].version)) throw new ContractError("UNSUPPORTED_TARGET");
  let slotIdMatches = 0;
  for (const plan of dto.plans) for (const tmz of plan?.tmzs ?? []) for (const candidate of tmz?.slots ?? []) {
    if (candidate?.slotId === slot.slotId) slotIdMatches += 1;
  }
  if (slotIdMatches !== 1) throw new ContractError("DOM_DRIFT");
  return Object.freeze({
    slotId: slot.slotId, version: slot.version, frontOpenFlg: slot.frontOpenFlg, receptionStatus: slot.receptionStatus,
    bookingAvailableKbn: slot.bookingAvailableKbn, cfmBookingLimMgrKbn: slot.cfmBookingLimMgrKbn,
    cfmCapaCnt: 0, lessonSchdlId: plans[0].lessonSchdlId, lessonSchdlVersion: plans[0].version,
  });
}

export function validateJalanBootstrap(value, job) {
  const dto = value?.dto;
  if (!dto || !Array.isArray(dto.dispDays) || dto.dispDays.length < 1 || dto.dispDays.length > 31
    || dto.dispDays.some((day) => dateKey(day) === null) || !Array.isArray(dto.plans) || dto.plans.length < 1 || dto.plans.length > 100) {
    throw new ContractError("DOM_DRIFT");
  }
  const plans = dto.plans.filter((plan) => plan?.lessonSchdlId === job.target.externalProductId);
  if (plans.length !== 1 || dto.selectedLessonSchdlId !== job.target.externalProductId || !Array.isArray(plans[0].tmzs)
    || plans[0].tmzs.length > 100) throw new ContractError("DOM_DRIFT");
  for (const tmz of plans[0].tmzs) {
    if (!Array.isArray(tmz?.slots) || tmz.slots.length !== dto.dispDays.length || tmz.slots.length > 31) throw new ContractError("DOM_DRIFT");
  }
  return Object.freeze({ firstDate: dateKey(dto.dispDays[0]), lastDate: dateKey(dto.dispDays.at(-1)) });
}

export function validateJalanComplete(body, job, snapshot) {
  if (!exactKeys(body, ["groups", "slots"]) || !Array.isArray(body.groups) || body.groups.length !== 0
    || !Array.isArray(body.slots) || body.slots.length !== 1 || snapshot?.authorized !== true) return false;
  const slot = body.slots[0];
  return exactKeys(slot, COMPLETE_SLOT_KEYS)
    && slot.slotId === snapshot.slotId && slot.version === snapshot.version
    && slot.frontOpenFlg === (job.desiredState === "OPEN" ? "true" : "false")
    && slot.bookingAvailableKbn === snapshot.bookingAvailableKbn
    && slot.cfmBookingLimMgrKbn === snapshot.cfmBookingLimMgrKbn && slot.cfmCapaCnt === snapshot.cfmCapaCnt
    && slot.lessonSchdlId === job.target.externalProductId && slot.lessonSchdlId === snapshot.lessonSchdlId
    && slot.lessonSchdlVersion === snapshot.lessonSchdlVersion;
}

export function validateJalanCompleteUrl(url) {
  if (url.pathname !== "/stateful/schdl/client/complete") return false;
  if (url.search === "") return true;
  const callback = url.searchParams.get("callback");
  return [...url.searchParams.keys()].every((key) => key === "callback")
    && url.searchParams.getAll("callback").length === 1 && callback.length <= 128
    && /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(callback);
}

export function createJalanNetworkGuard({ job, cloud, getSnapshot, assertWriteContext = async () => {}, supplierOrigin = JALAN_ORIGIN }) {
  let permit = null;
  let writes = 0;
  let refused = 0;
  let fatalWrite = null;
  let externalNavigationBlocked = false;
  let frozen = false;
  const forward = (route) => typeof route.fallback === "function" ? route.fallback() : route.continue();
  const refuse = (route, fatal = false) => { refused += 1; if (fatal) fatalWrite = new ContractError("WRITE_REFUSED"); return route.abort("blockedbyclient"); };
  async function handle(route) {
    if (frozen) return refuse(route);
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== supplierOrigin) { if (request.isNavigationRequest?.()) externalNavigationBlocked = true; return refuse(route); }
    if (request.method() === "GET") {
      const navigation = request.isNavigationRequest?.() === true;
      const fixedPage = url.pathname === "/activityboard/bookingStockMgt/" && url.searchParams.size === 0;
      const summary = !navigation && validateJalanSummaryUrl(url, job);
      const asset = !navigation && isStockAsset(request, url);
      const backgroundRead = !navigation && isStockBackgroundRead(request, url);
      if (navigation && !fixedPage) externalNavigationBlocked = true;
      return fixedPage || summary || asset || backgroundRead ? forward(route) : refuse(route);
    }
    if (request.method() !== "POST" || !validateJalanCompleteUrl(url)) return refuse(route, permit !== null);
    if (request.headers?.()["content-type"]?.split(";")[0] !== "application/json") return refuse(route, true);
    const raw = request.postData?.();
    if (typeof raw !== "string" || Buffer.byteLength(raw) > MAX_JSON_BYTES) return refuse(route, true);
    let body;
    try { body = request.postDataJSON(); } catch { return refuse(route, true); }
    if (!permit || !validateJalanComplete(body, job, getSnapshot())) return refuse(route, permit !== null || url.pathname.includes("complete"));
    if (permit.used) return refuse(route);
    if (writes >= 1) return refuse(route, true);
    const reserved = permit; reserved.used = true;
    try {
      await assertWriteContext();
      await cloud.preflight(job);
    } catch (error) { fatalWrite = error; return refuse(route); }
    if (frozen || permit !== reserved || fatalWrite) return refuse(route);
    writes += 1; return forwardSingleWrite(route);
  }
  return Object.freeze({
    handle,
    beginUiAction() { if (permit) throw new ContractError("WRITE_PERMIT_ACTIVE"); permit = { used: false }; },
    endUiAction() { const current = permit; permit = null; if (fatalWrite) { const error = fatalWrite; fatalWrite = null; throw error; } return Object.freeze({ writes: current?.used ? 1 : 0 }); },
    freeze() { frozen = true; permit = null; },
    get writes() { return writes; }, get refused() { return refused; }, get fatalWrite() { return fatalWrite; }, get externalNavigationBlocked() { return externalNavigationBlocked; },
  });
}
