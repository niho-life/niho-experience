import { ContractError, isPlainObject } from "./validation.mjs";

const MAX_SESSION_HEADERS = 32;
const MAX_SESSION_HEADER_LENGTH = 8_192;
const SESSION_HEADER = /^(?:authorization|x-[a-z0-9-]{1,64})$/;

export function fixedTestOrigin(value, productionOrigin, testOnly) {
  if (value === undefined) return productionOrigin;
  const url = new URL(value);
  if (testOnly !== true || url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new ContractError("INVALID_DRIVER_ORIGIN");
  return url.origin;
}

export async function prepareGuardedPage({ browser, guard, supplierOrigin }) {
  const { context } = browser;
  await context.route("**/*", guard.handle);
  const page = context.pages()[0] ?? await context.newPage();
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
  return page;
}

// A navigation that never finishes or cannot reach the supplier says nothing
// about the supplier's layout. The worker retries TIMEOUT and NETWORK_ERROR,
// while DOM_DRIFT halts the account for staff review, so these must not be
// reported as drift.
export function navigationFailureCode(error) {
  if (error?.name === "TimeoutError") return "TIMEOUT";
  if (/\bnet::ERR_(?:CONNECTION_|NETWORK_|INTERNET_|NAME_|TIMED_OUT|EMPTY_RESPONSE|ADDRESS_|SOCKET_|PROXY_)/.test(String(error?.message))) return "NETWORK_ERROR";
  return null;
}

// A locator count has no timeout of its own. After a navigation that never
// committed it stays pending, so the sign-in probe is bounded and counts as
// "no sign-in text" when it cannot answer in time.
export async function countWithin(locator, timeoutMs = 5_000) {
  let timer;
  try {
    return await Promise.race([locator.count().catch(() => 0), new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs, 0); })]);
  } finally { clearTimeout(timer); }
}

// `cause` is the error of the navigation or action that failed just before
// this check. It keeps the real reason on the thrown error instead of losing it.
export async function assertAuthOrDrift({ page, guard, supplierOrigin, signInPattern, cause }) {
  const current = new URL(page.url());
  const signIn = await countWithin(page.getByText(signInPattern));
  const movedExternal = ["http:", "https:"].includes(current.protocol) && current.origin !== supplierOrigin;
  if (guard.externalNavigationBlocked || movedExternal || /login|signin|challenge|captcha|auth/i.test(current.pathname) || signIn > 0) {
    throw new ContractError("AUTH_REQUIRED");
  }
  const options = cause === undefined ? undefined : { cause };
  throw new ContractError(navigationFailureCode(cause) ?? "DOM_DRIFT", undefined, options);
}

// Session headers the supplier app sends on its own read queries. Callers keep
// them in a closure and never log them.
export function sessionHeadersFromRequest(request) {
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
  return Object.freeze(captured);
}

// Runs inside the supplier page so the request carries the page's own
// same-origin cookies. Error bodies are never read; success bodies are capped.
export async function pageGraphqlFetch({ body, headers, maxBytes, timeoutMs }) {
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
