import { CDN_ORIGIN, SUPPLIER_ORIGIN } from "./constants.mjs";
import { selectAccountProfile } from "./config.mjs";
import { startManagedBrowser } from "./managed-browser.mjs";
import { isFirebaseSessionRefresh, isNamedReadOnlyQuery, isPermittedSubresourceGet } from "./network-guard.mjs";
import { assertAuthOrDrift, fixedTestOrigin, prepareGuardedPage } from "./browser-driver-common.mjs";
import {
  MAX_RESERVATION_RESPONSE_BYTES,
  RESERVATION_OPERATION_NAME,
  RESERVATION_QUERY,
  assertReaderTarget,
  createGygReservationReaderCore,
  sameReaderTarget,
} from "./gyg-reservation-protocol.mjs";
import { ContractError, exactKeys, isPlainObject } from "./validation.mjs";

const COMPANY_PATH = "/company-profile/company-details";
const BOOKINGS_PATH = "/bookings";
const FIXED_NAVIGATIONS = new Set([COMPANY_PATH, BOOKINGS_PATH]);
const APP_READ_TIMEOUT_MS = 15_000;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_SESSION_HEADERS = 32;
const MAX_SESSION_HEADER_LENGTH = 8_192;
const SESSION_HEADER = /^(?:authorization|x-[a-z0-9-]{1,64})$/;
const LOGIN_PATH = /login|signin|challenge|captcha|auth/i;

// Read-only guard for the reservation reader. It never carries a write permit:
// every non-query POST (including the supplier app's own side mutations) is
// aborted and only counted. The supplier app's own read queries reveal the
// session headers it sends; those stay in this closure and are never logged.
export function createGygReadOnlyGuard({ supplierOrigin = SUPPLIER_ORIGIN, cdnOrigin = CDN_ORIGIN } = {}) {
  const allowedOrigins = new Set([supplierOrigin, cdnOrigin]);
  let refused = 0;
  let refusedWrites = 0;
  let appReads = 0;
  let externalNavigationBlocked = false;
  let frozen = false;
  let sessionHeaders = Object.freeze({});
  const waiters = new Set();
  const forward = (route) => typeof route.fallback === "function" ? route.fallback() : route.continue();
  const refuse = (route) => { refused += 1; return route.abort("blockedbyclient"); };
  const refuseWrite = (route) => { refusedWrites += 1; return refuse(route); };

  function captureSession(request) {
    let headers;
    try { headers = request.headers?.() ?? {}; } catch { headers = {}; }
    const captured = {};
    let count = 0;
    for (const [rawName, value] of Object.entries(isPlainObject(headers) ? headers : {})) {
      const name = rawName.toLowerCase();
      if (!SESSION_HEADER.test(name) || typeof value !== "string" || value.length > MAX_SESSION_HEADER_LENGTH
        || /[\0\r\n]/.test(value) || count >= MAX_SESSION_HEADERS) continue;
      captured[name] = value;
      count += 1;
    }
    sessionHeaders = Object.freeze(captured);
    appReads += 1;
    for (const resolve of [...waiters]) resolve(true);
  }

  async function handle(route) {
    if (frozen) return refuse(route);
    const request = route.request();
    let url;
    try { url = new URL(request.url()); } catch { return refuse(route); }
    if (isFirebaseSessionRefresh(request, url)) return forward(route);
    const navigation = typeof request.isNavigationRequest === "function" && request.isNavigationRequest();
    if (!allowedOrigins.has(url.origin)) {
      if (navigation) externalNavigationBlocked = true;
      return request.method() === "GET" ? refuse(route) : refuseWrite(route);
    }
    if (request.method() === "GET") {
      if (navigation) {
        if (url.origin === supplierOrigin && FIXED_NAVIGATIONS.has(url.pathname) && url.search === "" && url.hash === "") return forward(route);
        externalNavigationBlocked = true;
        return refuse(route);
      }
      return isPermittedSubresourceGet(request, url, cdnOrigin) ? forward(route) : refuse(route);
    }
    if (navigation) externalNavigationBlocked = true;
    if (navigation || request.method() !== "POST" || url.origin !== supplierOrigin || url.pathname !== "/graphql") return refuseWrite(route);
    let body;
    try { body = request.postDataJSON(); } catch { return refuseWrite(route); }
    if (!isPlainObject(body) || !isNamedReadOnlyQuery(body.query, body.operationName)) return refuseWrite(route);
    if (body.operationName === RESERVATION_OPERATION_NAME) {
      if (body.query !== RESERVATION_QUERY) return refuseWrite(route);
    } else {
      captureSession(request);
    }
    return forward(route);
  }

  return Object.freeze({
    handle,
    freeze() {
      frozen = true;
      for (const resolve of [...waiters]) resolve(false);
    },
    waitForAppRead(after, timeoutMs) {
      if (appReads > after) return Promise.resolve(true);
      if (frozen) return Promise.resolve(false);
      return new Promise((resolve) => {
        const done = (value) => { clearTimeout(timer); waiters.delete(done); resolve(value); };
        const timer = setTimeout(() => done(false), timeoutMs);
        timer.unref?.();
        waiters.add(done);
      });
    },
    sessionHeaders() { return sessionHeaders; },
    get refused() { return refused; },
    get refusedWrites() { return refusedWrites; },
    get appReads() { return appReads; },
    get externalNavigationBlocked() { return externalNavigationBlocked; },
  });
}

// Runs inside the supplier page so the request carries the page's own
// same-origin cookies. Error bodies are never read; success bodies are capped.
async function pageFetch({ body, headers, maxBytes, timeoutMs }) {
  let response;
  try {
    response = await fetch("/graphql", {
      method: "POST", credentials: "same-origin", redirect: "error", headers, body, signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return { failure: error?.name === "TimeoutError" ? "TIMEOUT" : "NETWORK_ERROR" };
  }
  if (response.status < 200 || response.status > 299) {
    try { await response.body?.cancel(); } catch {}
    return { status: response.status, bodyText: "" };
  }
  try {
    const reader = response.body?.getReader();
    if (!reader) return { status: response.status, bodyText: "" };
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        try { await reader.cancel(); } catch {}
        return { status: response.status, tooLarge: true };
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return { status: response.status, bodyText: new TextDecoder().decode(bytes) };
  } catch (error) {
    return { failure: error?.name === "TimeoutError" ? "TIMEOUT" : "NETWORK_ERROR" };
  }
}

export async function createGygReservationReader({
  target, config, testOnlySupplierOrigin, allowLocalTestOrigin = false, headless = true, browserFactory = startManagedBrowser,
}) {
  const fixedTarget = assertReaderTarget(target);
  const supplierOrigin = fixedTestOrigin(testOnlySupplierOrigin, SUPPLIER_ORIGIN, allowLocalTestOrigin);
  const cdnOrigin = supplierOrigin === SUPPLIER_ORIGIN ? CDN_ORIGIN : supplierOrigin;
  const profile = selectAccountProfile(config, fixedTarget);
  const browser = await browserFactory({ executablePath: config.browserExecutable, userDataDir: profile, headless });
  const guard = createGygReadOnlyGuard({ supplierOrigin, cdnOrigin });
  try {
    const page = await prepareGuardedPage({ browser, guard, supplierOrigin });
    const companyUrl = `${supplierOrigin}${COMPANY_PATH}`;
    const bookingsUrl = `${supplierOrigin}${BOOKINGS_PATH}`;
    let stopping = false;
    let stopPromise = null;
    let ready = null;
    const authOrDrift = () => assertAuthOrDrift({ page, guard, supplierOrigin, signInPattern: /sign in|log in/i });
    const assertActive = () => { if (stopping) throw new ContractError("READER_STOPPED"); };

    function assertSessionPage() {
      if (guard.externalNavigationBlocked) throw new ContractError("AUTH_REQUIRED");
      let current;
      try { current = new URL(page.url()); } catch { throw new ContractError("DOM_DRIFT"); }
      if (["http:", "https:"].includes(current.protocol) && current.origin !== supplierOrigin) throw new ContractError("AUTH_REQUIRED");
      if (current.origin === supplierOrigin && LOGIN_PATH.test(current.pathname)) throw new ContractError("AUTH_REQUIRED");
      if (current.origin !== supplierOrigin) throw new ContractError("DOM_DRIFT");
    }

    // Account and session checks run on the first read, not in the factory, so
    // every failure is raised while the executor already holds stop().
    async function prepareSession() {
      assertActive();
      await page.goto(companyUrl, { waitUntil: "domcontentloaded" }).catch(() => authOrDrift());
      assertActive();
      const label = page.getByText("Supplier ID:", { exact: true });
      await label.waitFor({ state: "visible" }).catch(() => authOrDrift());
      if (await label.count() !== 1) return authOrDrift();
      const parentText = await label.locator("..").innerText();
      const match = /(?:^|\s)Supplier ID:\s*(\d+)(?:\s|$)/.exec(parentText);
      if (!match || match[1] !== fixedTarget.externalAccountId) throw new ContractError("ACCOUNT_MISMATCH");
      assertActive();
      const before = guard.appReads;
      await page.goto(bookingsUrl, { waitUntil: "domcontentloaded" }).catch(() => authOrDrift());
      assertActive();
      if (!await guard.waitForAppRead(before, APP_READ_TIMEOUT_MS)) return authOrDrift();
      assertActive();
      assertSessionPage();
    }

    async function transport(requestBody, signal) {
      if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new ContractError("DEADLINE_EXCEEDED");
      assertActive();
      assertSessionPage();
      const headers = { ...guard.sessionHeaders(), "content-type": "application/json" };
      let result;
      try {
        result = await page.evaluate(pageFetch, {
          body: JSON.stringify(requestBody), headers, maxBytes: MAX_RESERVATION_RESPONSE_BYTES, timeoutMs: FETCH_TIMEOUT_MS,
        });
      } catch {
        assertActive();
        assertSessionPage();
        throw new ContractError("NETWORK_ERROR");
      }
      assertActive();
      if (!isPlainObject(result)) throw new ContractError("INVALID_RESPONSE");
      if (exactKeys(result, ["failure"]) && ["TIMEOUT", "NETWORK_ERROR"].includes(result.failure)) throw new ContractError(result.failure);
      if (exactKeys(result, ["status", "tooLarge"]) && result.tooLarge === true) throw new ContractError("PAGE_TOO_LARGE");
      if (!exactKeys(result, ["status", "bodyText"]) || !Number.isSafeInteger(result.status) || typeof result.bodyText !== "string") {
        throw new ContractError("INVALID_RESPONSE");
      }
      return Object.freeze({ status: result.status, bodyText: result.bodyText });
    }

    const core = createGygReservationReaderCore({ target: fixedTarget, transport });
    return Object.freeze({
      pid: browser.pid,
      get stats() {
        return Object.freeze({
          refused: guard.refused,
          refusedWrites: guard.refusedWrites,
          appReads: guard.appReads,
          externalNavigationBlocked: guard.externalNavigationBlocked,
        });
      },
      async readPage(input) {
        assertActive();
        if (!isPlainObject(input) || !sameReaderTarget(input.target, fixedTarget)) throw new ContractError("INVALID_READER");
        ready ??= prepareSession();
        await ready;
        assertActive();
        return core.readPage(input);
      },
      async stop() {
        stopping = true;
        guard.freeze();
        stopPromise ??= browser.stop();
        return stopPromise;
      },
    });
  } catch (error) {
    guard.freeze();
    const stopped = await browser.stop().catch(() => false);
    if (!stopped) throw new ContractError("PROCESS_STOP_UNCONFIRMED");
    throw error;
  }
}
