import { ContractError } from "./validation.mjs";

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

export async function assertAuthOrDrift({ page, guard, supplierOrigin, signInPattern }) {
  const current = new URL(page.url());
  const signIn = await page.getByText(signInPattern).count().catch(() => 0);
  const movedExternal = ["http:", "https:"].includes(current.protocol) && current.origin !== supplierOrigin;
  if (guard.externalNavigationBlocked || movedExternal || /login|signin|challenge|captcha|auth/i.test(current.pathname) || signIn > 0) {
    throw new ContractError("AUTH_REQUIRED");
  }
  throw new ContractError("DOM_DRIFT");
}
