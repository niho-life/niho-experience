import { CDN_ORIGIN, EXPECTED_MUTATION, SUPPLIER_ORIGIN } from "./constants.mjs";
import { ContractError, exactKeys, isPlainObject, validatePreflight } from "./validation.mjs";
import { sessionHeadersFromRequest } from "./browser-driver-common.mjs";
import {
  SCHEDULE_READ_OPERATION,
  SCHEDULE_STEP_OPERATION,
  isScheduleReadRequest,
  rewriteScheduleStepVariables,
} from "./gyg-schedule-protocol.mjs";

function tokenizeGraphql(source) {
  if (typeof source !== "string" || source.length < 1 || source.length > 32_768) throw new ContractError("GRAPHQL_REFUSED");
  const tokens = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (/\s|,/.test(char)) { index += 1; continue; }
    if (char === "#") { while (index < source.length && source[index] !== "\n") index += 1; continue; }
    if (char === '"') {
      if (source.slice(index, index + 3) === '"""') {
        index += 3;
        const end = source.indexOf('"""', index);
        if (end < 0) throw new ContractError("GRAPHQL_REFUSED");
        index = end + 3;
      } else {
        index += 1;
        let closed = false;
        while (index < source.length) {
          if (source[index] === "\\") { index += 2; continue; }
          if (source[index] === '"') { index += 1; closed = true; break; }
          index += 1;
        }
        if (!closed) throw new ContractError("GRAPHQL_REFUSED");
      }
      tokens.push({ type: "STRING" });
      continue;
    }
    const name = /^[_A-Za-z][_0-9A-Za-z]*/.exec(source.slice(index));
    if (name) { tokens.push({ type: "NAME", value: name[0] }); index += name[0].length; continue; }
    if ("!$():=@[]{|}&".includes(char)) { tokens.push({ type: char, value: char }); index += 1; continue; }
    if (char === "." && source.slice(index, index + 3) === "...") { tokens.push({ type: "...", value: "..." }); index += 3; continue; }
    if (/[0-9+-]/.test(char)) {
      const number = /^[+-]?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(source.slice(index));
      if (!number) throw new ContractError("GRAPHQL_REFUSED");
      tokens.push({ type: "NUMBER" }); index += number[0].length; continue;
    }
    throw new ContractError("GRAPHQL_REFUSED");
  }
  return tokens;
}

function skipBalanced(tokens, at, open, close) {
  if (tokens[at]?.type !== open) throw new ContractError("GRAPHQL_REFUSED");
  let depth = 0;
  for (let index = at; index < tokens.length; index += 1) {
    if (tokens[index].type === open) depth += 1;
    if (tokens[index].type === close) depth -= 1;
    if (depth === 0) return index + 1;
  }
  throw new ContractError("GRAPHQL_REFUSED");
}

export function isNamedReadOnlyQuery(source, operationName) {
  try {
    if (typeof operationName !== "string" || !/^[_A-Za-z][_0-9A-Za-z]*$/.test(operationName)) return false;
    const tokens = tokenizeGraphql(source);
    let index = 0;
    const queries = [];
    while (index < tokens.length) {
      const keyword = tokens[index];
      if (keyword?.type !== "NAME") return false;
      if (keyword.value === "mutation" || keyword.value === "subscription") return false;
      if (keyword.value === "fragment") {
        if (tokens[index + 1]?.type !== "NAME" || tokens[index + 2]?.value !== "on" || tokens[index + 3]?.type !== "NAME") return false;
        index += 4;
      } else if (keyword.value === "query") {
        if (tokens[index + 1]?.type !== "NAME") return false;
        queries.push(tokens[index + 1].value);
        index += 2;
        if (tokens[index]?.type === "(") index = skipBalanced(tokens, index, "(", ")");
      } else {
        return false;
      }
      while (tokens[index]?.type === "@") {
        if (tokens[index + 1]?.type !== "NAME") return false;
        index += 2;
        if (tokens[index]?.type === "(") index = skipBalanced(tokens, index, "(", ")");
      }
      index = skipBalanced(tokens, index, "{", "}");
    }
    return queries.length > 0 && queries.includes(operationName);
  } catch {
    return false;
  }
}

function countRootFields(tokens, start, end) {
  let index = start;
  let count = 0;
  while (index < end) {
    if (tokens[index]?.type !== "NAME") return -1;
    index += 1;
    if (tokens[index]?.type === ":") {
      if (tokens[index + 1]?.type !== "NAME") return -1;
      index += 2;
    }
    if (tokens[index]?.type === "(") index = skipBalanced(tokens, index, "(", ")");
    while (tokens[index]?.type === "@") {
      if (tokens[index + 1]?.type !== "NAME") return -1;
      index += 2;
      if (tokens[index]?.type === "(") index = skipBalanced(tokens, index, "(", ")");
    }
    if (tokens[index]?.type === "{") index = skipBalanced(tokens, index, "{", "}");
    count += 1;
  }
  return index === end ? count : -1;
}

// One named mutation with exactly one root field (fragments allowed). The
// field name itself is not pinned; the variables are checked separately.
export function isSingleRootMutation(source, operationName) {
  try {
    if (typeof operationName !== "string" || !/^[_A-Za-z][_0-9A-Za-z]*$/.test(operationName)) return false;
    const tokens = tokenizeGraphql(source);
    let index = 0;
    let mutations = 0;
    let rootFields = -1;
    while (index < tokens.length) {
      const keyword = tokens[index];
      if (keyword?.type !== "NAME") return false;
      if (keyword.value === "fragment") {
        if (tokens[index + 1]?.type !== "NAME" || tokens[index + 2]?.value !== "on" || tokens[index + 3]?.type !== "NAME") return false;
        index += 4;
      } else if (keyword.value === "mutation" && tokens[index + 1]?.type === "NAME" && tokens[index + 1].value === operationName) {
        mutations += 1;
        index += 2;
        if (tokens[index]?.type === "(") index = skipBalanced(tokens, index, "(", ")");
      } else {
        return false;
      }
      while (tokens[index]?.type === "@") {
        if (tokens[index + 1]?.type !== "NAME") return false;
        index += 2;
        if (tokens[index]?.type === "(") index = skipBalanced(tokens, index, "(", ")");
      }
      const end = skipBalanced(tokens, index, "{", "}");
      if (keyword.value === "mutation") rootFields = countRootFields(tokens, index + 1, end - 1);
      index = end;
    }
    return mutations === 1 && rootFields === 1;
  } catch {
    return false;
  }
}

// ENSURE_OCCURRENCE: the body the screen sent, with only specialDates replaced,
// or null when anything else differs from the schedule read before the write.
export function rewriteScheduleStepBody(body, plan) {
  if (!exactKeys(body, ["operationName", "query", "variables"]) || body.operationName !== SCHEDULE_STEP_OPERATION
    || !isSingleRootMutation(body.query, SCHEDULE_STEP_OPERATION) || !plan) return null;
  const variables = rewriteScheduleStepVariables(body.variables, plan);
  return variables ? { ...body, variables } : null;
}

function normalizedWhitespace(value) {
  return value.replace(/\s+/g, " ").trim();
}

export function validateUpdateMutation(body, job) {
  if (!exactKeys(body, ["operationName", "query", "variables"]) || body.operationName !== "UpdateMultipleTimeSlots"
    || typeof body.query !== "string" || normalizedWhitespace(body.query) !== EXPECTED_MUTATION
    || !exactKeys(body.variables, ["input"])) return false;
  const input = body.variables.input;
  if (!exactKeys(input, ["isBlocked", "type", "timeSlots"]) || input.type !== "IS_BLOCKED"
    || input.isBlocked !== (job.desiredState === "CLOSED") || !Array.isArray(input.timeSlots) || input.timeSlots.length !== 1) return false;
  const slot = input.timeSlots[0];
  return exactKeys(slot, ["dateTime", "tourOptionId"])
    && slot.dateTime === job.localDateTime.slice(0, 16)
    && slot.tourOptionId === job.target.externalOptionId;
}

// Firebase refreshes the existing browser session before hydrating the
// supplier page. Permit only that form, never sign-in or arbitrary writes.
export function isFirebaseSessionRefresh(request, url) {
  if (url.origin === "https://securetoken.googleapis.com" && url.pathname === "/v1/token"
    && request.method() === "POST" && request.resourceType?.() === "fetch"
    && !request.isNavigationRequest?.() && url.searchParams.size === 1
    && /^[A-Za-z0-9_-]{20,100}$/.test(url.searchParams.get("key") ?? "")
    && request.headers?.()["content-type"]?.split(";")[0] === "application/x-www-form-urlencoded") {
    const raw = request.postData?.();
    const form = typeof raw === "string" && raw.length <= 16_384 ? new URLSearchParams(raw) : null;
    return Boolean(form && form.size === 2 && form.get("grant_type") === "refresh_token"
      && (form.get("refresh_token")?.length ?? 0) > 0);
  }
  return false;
}

// Non-navigation GETs on allowed origins are limited to static resource types.
export function isPermittedSubresourceGet(request, url, cdnOrigin) {
  const resourceType = typeof request.resourceType === "function" ? request.resourceType() : null;
  // Chromium reports Nuxt modulepreload GETs as "other", including the
  // scripts needed to hydrate an otherwise blank supplier page.
  const staticPreload = url.origin === cdnOrigin && resourceType === "other"
    && /^\/supplier-portal\/nuxt\/_nuxt\/[A-Za-z0-9._/-]+\.(?:m?js|css|svg|png|jpe?g|webp|woff2?)$/.test(url.pathname);
  return !resourceType || staticPreload || ["document", "stylesheet", "script", "image", "media", "font"].includes(resourceType);
}

export function createNetworkGuard({ job, cloud, supplierOrigin = SUPPLIER_ORIGIN, cdnOrigin = CDN_ORIGIN }) {
  const allowedOrigins = new Set([supplierOrigin, cdnOrigin]);
  const ensureJob = job.action === "ENSURE_OCCURRENCE";
  let permit = null;
  let schedulePermit = null;
  let writes = 0;
  let refused = 0;
  let fatalWrite = null;
  let externalNavigationBlocked = false;
  let frozen = false;
  let appReads = 0;
  let sessionHeaders = Object.freeze({});
  const readWaiters = new Set();
  const forward = (route) => typeof route.fallback === "function" ? route.fallback() : route.continue();
  const forwardWith = (route, overrides) => typeof route.fallback === "function" ? route.fallback(overrides) : route.continue(overrides);
  const writeWindowOpen = () => Boolean(permit || schedulePermit);

  // ENSURE_OCCURRENCE also opens the product page whose schedule it edits.
  function isEnsureNavigation(url) {
    if (!ensureJob || url.origin !== supplierOrigin || url.pathname !== "/products/details" || url.hash) return false;
    const keys = [...url.searchParams.keys()];
    return url.searchParams.get("tour_id") === job.target.externalProductId
      && ((keys.length === 1 && keys[0] === "tour_id")
        || (keys.length === 2 && keys.includes("optionId") && url.searchParams.get("optionId") === job.target.externalOptionId));
  }

  function captureSession(request) {
    sessionHeaders = sessionHeadersFromRequest(request);
    appReads += 1;
    for (const resolve of [...readWaiters]) resolve(true);
  }

  async function handleScheduleStep(route, body) {
    const plan = schedulePermit && !schedulePermit.used && writes < 1 ? schedulePermit.plan : null;
    const rewritten = plan ? rewriteScheduleStepBody(body, plan) : null;
    if (!rewritten) {
      refused += 1;
      fatalWrite = new ContractError("WRITE_REFUSED");
      return route.abort("blockedbyclient");
    }
    const reservedPermit = schedulePermit;
    reservedPermit.used = true;
    try {
      validatePreflight(await cloud.preflight(job), "OPEN");
    } catch (error) {
      fatalWrite = error;
      return route.abort("blockedbyclient");
    }
    if (frozen || schedulePermit !== reservedPermit || fatalWrite) { refused += 1; return route.abort("blockedbyclient"); }
    writes += 1;
    return forwardWith(route, { postData: JSON.stringify(rewritten) });
  }

  async function handle(route) {
    if (frozen) { refused += 1; return route.abort("blockedbyclient"); }
    const request = route.request();
    const url = new URL(request.url());
    if (isFirebaseSessionRefresh(request, url)) return forward(route);
    if (!allowedOrigins.has(url.origin)) {
      if (typeof request.isNavigationRequest === "function" && request.isNavigationRequest()) externalNavigationBlocked = true;
      refused += 1; return route.abort("blockedbyclient");
    }
    if (request.method() === "GET") {
      const navigation = typeof request.isNavigationRequest === "function" && request.isNavigationRequest();
      const date = job.localDateTime.slice(0, 10);
      const fixedNavigation = url.origin === supplierOrigin && (url.pathname === "/company-profile/company-details"
        || (url.pathname === "/manage/availability" && url.searchParams.size === 2
          && url.searchParams.get("filter_date_from") === date && url.searchParams.get("filter_date_to") === date))
        || isEnsureNavigation(url);
      if (navigation && !fixedNavigation) { externalNavigationBlocked = true; refused += 1; return route.abort("blockedbyclient"); }
      if (!navigation && !isPermittedSubresourceGet(request, url, cdnOrigin)) {
        refused += 1; return route.abort("blockedbyclient");
      }
      return forward(route);
    }
    if (request.method() !== "POST" || url.origin !== supplierOrigin || url.pathname !== "/graphql") {
      refused += 1;
      if (writeWindowOpen() && !/analytics|metric|logging|telemetry|track/i.test(url.pathname)) fatalWrite = new ContractError("WRITE_REFUSED");
      return route.abort("blockedbyclient");
    }
    let body;
    try { body = request.postDataJSON(); } catch { refused += 1; return route.abort("blockedbyclient"); }
    if (!isPlainObject(body)) { refused += 1; return route.abort("blockedbyclient"); }
    if (isNamedReadOnlyQuery(body.query, body.operationName)) {
      if (body.operationName !== SCHEDULE_READ_OPERATION) captureSession(request);
      else if (!isScheduleReadRequest(body, job.target.externalOptionId)) { refused += 1; return route.abort("blockedbyclient"); }
      return forward(route);
    }
    if (ensureJob && body.operationName === SCHEDULE_STEP_OPERATION) return handleScheduleStep(route, body);
    if (!permit || !validateUpdateMutation(body, job)) {
      refused += 1;
      const expectedNoise = /analytics|metric|logging|telemetry|track|^Inbox_UnreadCountChanged$/i.test(String(body.operationName));
      if (body.operationName === "UpdateMultipleTimeSlots"
        || (writeWindowOpen() && !expectedNoise && /\b(?:mutation|subscription)\b/.test(String(body.query)))) {
        fatalWrite = new ContractError("WRITE_REFUSED");
      }
      return route.abort("blockedbyclient");
    }
    // Reserve before awaiting preflight: two requests may arrive concurrently.
    // Re-requests reaching this interceptor are blocked; Chromium can still retry
    // below this layer. Only idempotent Boolean SET is supported, then read back.
    if (permit.used) { refused += 1; return route.abort("blockedbyclient"); }
    if (writes >= 1) { refused += 1; fatalWrite = new ContractError("WRITE_REFUSED"); return route.abort("blockedbyclient"); }
    const reservedPermit = permit;
    reservedPermit.used = true;
    try {
      await cloud.preflight(job);
    } catch (error) {
      fatalWrite = error;
      return route.abort("blockedbyclient");
    }
    if (frozen || permit !== reservedPermit || fatalWrite) { refused += 1; return route.abort("blockedbyclient"); }
    writes += 1;
    return forward(route);
  }

  return Object.freeze({
    handle,
    beginUiAction() {
      if (ensureJob) throw new ContractError("WRITE_REFUSED");
      if (permit || schedulePermit) throw new ContractError("WRITE_PERMIT_ACTIVE");
      permit = { used: false };
    },
    // plan: { block, specialDates } from planEnsureOccurrence.
    beginScheduleWrite(plan) {
      if (!ensureJob || frozen || !plan) throw new ContractError("WRITE_REFUSED");
      if (permit || schedulePermit) throw new ContractError("WRITE_PERMIT_ACTIVE");
      schedulePermit = { used: false, plan };
    },
    endScheduleWrite() {
      const state = schedulePermit;
      schedulePermit = null;
      if (fatalWrite) { const error = fatalWrite; fatalWrite = null; throw error; }
      return Object.freeze({ writes: state?.used ? 1 : 0 });
    },
    waitForAppRead(after, timeoutMs) {
      if (appReads > after) return Promise.resolve(true);
      if (frozen) return Promise.resolve(false);
      return new Promise((resolve) => {
        const done = (value) => { clearTimeout(timer); readWaiters.delete(done); resolve(value); };
        const timer = setTimeout(() => done(false), timeoutMs);
        timer.unref?.();
        readWaiters.add(done);
      });
    },
    sessionHeaders() { return sessionHeaders; },
    endUiAction() {
      const state = permit;
      permit = null;
      if (fatalWrite) { const error = fatalWrite; fatalWrite = null; throw error; }
      return Object.freeze({ writes: state?.used ? 1 : 0 });
    },
    freeze() {
      frozen = true;
      permit = null;
      schedulePermit = null;
      for (const resolve of [...readWaiters]) resolve(false);
    },
    get writes() { return writes; },
    get appReads() { return appReads; },
    get refused() { return refused; },
    get fatalWrite() { return fatalWrite; },
    get externalNavigationBlocked() { return externalNavigationBlocked; },
  });
}

export const networkGuardInternals = Object.freeze({ tokenizeGraphql, normalizedWhitespace });
