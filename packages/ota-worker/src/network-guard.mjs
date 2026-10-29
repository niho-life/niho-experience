import { CDN_ORIGIN, EXPECTED_MUTATION, SUPPLIER_ORIGIN } from "./constants.mjs";
import { ContractError, exactKeys, isPlainObject } from "./validation.mjs";

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

export function createNetworkGuard({ job, cloud, supplierOrigin = SUPPLIER_ORIGIN, cdnOrigin = CDN_ORIGIN }) {
  const allowedOrigins = new Set([supplierOrigin, cdnOrigin]);
  let permit = null;
  let writes = 0;
  let refused = 0;
  let fatalWrite = null;
  let externalNavigationBlocked = false;
  let frozen = false;
  const forward = (route) => typeof route.fallback === "function" ? route.fallback() : route.continue();

  async function handle(route) {
    if (frozen) { refused += 1; return route.abort("blockedbyclient"); }
    const request = route.request();
    const url = new URL(request.url());
    if (!allowedOrigins.has(url.origin)) {
      if (typeof request.isNavigationRequest === "function" && request.isNavigationRequest()) externalNavigationBlocked = true;
      refused += 1; return route.abort("blockedbyclient");
    }
    if (request.method() === "GET") {
      const navigation = typeof request.isNavigationRequest === "function" && request.isNavigationRequest();
      const date = job.localDateTime.slice(0, 10);
      const fixedNavigation = url.origin === supplierOrigin && (url.pathname === "/company-profile/company-details"
        || (url.pathname === "/manage/availability" && url.searchParams.size === 2
          && url.searchParams.get("filter_date_from") === date && url.searchParams.get("filter_date_to") === date));
      if (navigation && !fixedNavigation) { externalNavigationBlocked = true; refused += 1; return route.abort("blockedbyclient"); }
      const resourceType = typeof request.resourceType === "function" ? request.resourceType() : null;
      // Chromium reports Nuxt modulepreload GETs as "other", including the
      // scripts needed to hydrate an otherwise blank supplier page.
      const staticPreload = url.origin === cdnOrigin && resourceType === "other"
        && /^\/supplier-portal\/nuxt\/_nuxt\/[A-Za-z0-9._/-]+\.(?:m?js|css|svg|png|jpe?g|webp|woff2?)$/.test(url.pathname);
      if (!navigation && resourceType && !staticPreload && !["document", "stylesheet", "script", "image", "media", "font"].includes(resourceType)) {
        refused += 1; return route.abort("blockedbyclient");
      }
      return forward(route);
    }
    if (request.method() !== "POST" || url.origin !== supplierOrigin || url.pathname !== "/graphql") {
      refused += 1;
      if (permit && !/analytics|metric|logging|telemetry|track/i.test(url.pathname)) fatalWrite = new ContractError("WRITE_REFUSED");
      return route.abort("blockedbyclient");
    }
    let body;
    try { body = request.postDataJSON(); } catch { refused += 1; return route.abort("blockedbyclient"); }
    if (!isPlainObject(body)) { refused += 1; return route.abort("blockedbyclient"); }
    if (isNamedReadOnlyQuery(body.query, body.operationName)) return forward(route);
    if (!permit || !validateUpdateMutation(body, job)) {
      refused += 1;
      const expectedNoise = /analytics|metric|logging|telemetry|track|^Inbox_UnreadCountChanged$/i.test(String(body.operationName));
      if (body.operationName === "UpdateMultipleTimeSlots"
        || (permit && !expectedNoise && /\b(?:mutation|subscription)\b/.test(String(body.query)))) {
        fatalWrite = new ContractError("WRITE_REFUSED");
      }
      return route.abort("blockedbyclient");
    }
    // Reserve before awaiting preflight: two requests may arrive concurrently.
    // Re-requests reaching this interceptor are blocked; Chromium can still retry
    // below this layer. Only idempotent Boolean SET is supported, then read back.
    if (permit.used) { refused += 1; return route.abort("blockedbyclient"); }
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
      if (permit) throw new ContractError("WRITE_PERMIT_ACTIVE");
      permit = { used: false };
    },
    endUiAction() {
      const state = permit;
      permit = null;
      if (fatalWrite) { const error = fatalWrite; fatalWrite = null; throw error; }
      return Object.freeze({ writes: state?.used ? 1 : 0 });
    },
    freeze() {
      frozen = true;
      permit = null;
    },
    get writes() { return writes; },
    get refused() { return refused; },
    get fatalWrite() { return fatalWrite; },
    get externalNavigationBlocked() { return externalNavigationBlocked; },
  });
}

export const networkGuardInternals = Object.freeze({ tokenizeGraphql, normalizedWhitespace });
