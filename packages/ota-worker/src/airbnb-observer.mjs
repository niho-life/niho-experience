import { AIRBNB_ASSET_ORIGIN, AIRBNB_CALENDAR_OPERATION, AIRBNB_MAX_RESPONSE_BYTES, AIRBNB_ORIGIN,
  AIRBNB_PROFILE_OPERATION, parseAirbnbApiUrl, selectAirbnbCalendarObservation, validateAirbnbSelfProfile } from "./airbnb-protocol.mjs";
import { airbnbCalendarUrl, airbnbProfileUrl, createAirbnbNetworkGuard } from "./airbnb-network-guard.mjs";
import { assertAuthOrDrift, fixedTestOrigin, prepareGuardedPage } from "./browser-driver-common.mjs";
import { selectAccountProfile } from "./config.mjs";
import { startManagedBrowser } from "./managed-browser.mjs";
import { ContractError, validateClaim, validatePreflight } from "./validation.mjs";

function currentDate(now) {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new ContractError("INVALID_JOB_DEADLINE");
  return value;
}

function assertJobActive(job, now) {
  const current = currentDate(now).getTime();
  if (current >= Date.parse(job.deadlineAtUtc) || current >= Date.parse(job.leaseExpiresAtUtc)) {
    throw new ContractError("INVALID_JOB_DEADLINE");
  }
}

function sanitized(error) {
  return error instanceof ContractError ? error : new ContractError("DOM_DRIFT");
}

async function responseJson(response, runWithinCycle) {
  if (response.status() !== 200 || response.headers()["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new ContractError("DOM_DRIFT");
  }
  const declared = response.headers()["content-length"];
  if (declared !== undefined && (!/^\d+$/.test(declared) || BigInt(declared) > BigInt(AIRBNB_MAX_RESPONSE_BYTES))) {
    throw new ContractError("DOM_DRIFT");
  }
  const body = await runWithinCycle(() => response.body().catch(() => null));
  if (!Buffer.isBuffer(body) || body.byteLength > AIRBNB_MAX_RESPONSE_BYTES) throw new ContractError("DOM_DRIFT");
  try { return JSON.parse(body.toString("utf8")); } catch { throw new ContractError("DOM_DRIFT"); }
}

export async function createAirbnbCalendarObserver({ job: rawJob, cloud, config, now = () => new Date(),
  testOnlySupplierOrigin, allowLocalTestOrigin = false, headless = false, browserFactory = startManagedBrowser,
  responseTimeoutMs = 15_000 }) {
  const job = validateClaim(rawJob, currentDate(now).getTime());
  if (job.purpose !== undefined || job.target.site !== "Airbnb" || job.target.externalOptionId !== "") {
    throw new ContractError("UNSUPPORTED_TARGET");
  }
  const supplierOrigin = fixedTestOrigin(testOnlySupplierOrigin, AIRBNB_ORIGIN, allowLocalTestOrigin);
  const assetOrigin = supplierOrigin === AIRBNB_ORIGIN ? AIRBNB_ASSET_ORIGIN : supplierOrigin;
  const profile = selectAccountProfile(config, job.target);
  const browser = await browserFactory({ executablePath: config.browserExecutable, userDataDir: profile, headless, sessionPolicy: "none" });
  let guard;
  let stopping = false;
  let stopPromise = null;
  const confirmedStop = async () => {
    stopping = true;
    guard?.freeze();
    stopPromise ??= Promise.resolve().then(() => browser.stop()).then((value) => value === true).catch(() => false);
    return stopPromise;
  };
  try {
    guard = createAirbnbNetworkGuard({ job, supplierOrigin, assetOrigin });
    const page = await prepareGuardedPage({ browser, guard, supplierOrigin });
    if (typeof browser.context.routeWebSocket !== "function") throw new ContractError("UNSAFE_REQUEST");
    const cacheSession = await browser.context.newCDPSession(page);
    await cacheSession.send("Network.enable");
    await cacheSession.send("Network.setCacheDisabled", { cacheDisabled: true });
    await browser.context.routeWebSocket("**/*", (socket) => {
      guard.noteWebSocket();
      void socket.close({ code: 1008, reason: "Read-only observer" }).catch(() => {});
    });
    const profileUrl = airbnbProfileUrl(supplierOrigin);
    const calendarUrl = airbnbCalendarUrl(job, supplierOrigin);

    const authOrDrift = async () => {
      if (guard.externalNavigationBlocked) {
        return assertAuthOrDrift({ page, guard, supplierOrigin, signInPattern: /ログイン|sign in|log in/i });
      }
      const current = new URL(page.url());
      if (/login|signin|challenge|captcha|auth/i.test(current.pathname)) {
        return assertAuthOrDrift({ page, guard, supplierOrigin, signInPattern: /ログイン|sign in|log in/i });
      }
      guard.assertSafe();
      return assertAuthOrDrift({ page, guard, supplierOrigin, signInPattern: /ログイン|sign in|log in/i });
    };
    const assertActive = () => {
      if (stopping) throw new ContractError("DRIVER_STOPPED");
      assertJobActive(job, now);
      guard.assertSafe();
    };
    const createObserveCycle = () => {
      assertActive();
      const expiresAt = Math.min(Date.parse(job.deadlineAtUtc), Date.parse(job.leaseExpiresAtUtc));
      const remainingMs = expiresAt - currentDate(now).getTime();
      if (remainingMs <= 0) throw new ContractError("INVALID_JOB_DEADLINE");
      const expiryError = new ContractError("INVALID_JOB_DEADLINE");
      let expired = false;
      let rejectExpiry;
      const expiry = new Promise((_resolve, reject) => { rejectExpiry = reject; });
      void expiry.catch(() => {});
      const timer = setTimeout(() => {
        expired = true;
        void confirmedStop();
        rejectExpiry(expiryError);
      }, remainingMs);
      timer.unref?.();
      return Object.freeze({
        assert() {
          if (expired) throw expiryError;
          assertActive();
        },
        async run(operation) {
          if (expired) throw expiryError;
          assertActive();
          return Promise.race([Promise.resolve().then(operation), expiry]);
        },
        close() { clearTimeout(timer); },
        get expired() { return expired; },
      });
    };
    const preflight = async (cycle) => {
      cycle.assert();
      validatePreflight(await cycle.run(() => cloud.preflight(job)), job.desiredState);
      cycle.assert();
    };

    async function waitForApi(operationName, beforeCount, trigger, cycle) {
      cycle.assert();
      const pending = Promise.resolve().then(() => page.waitForResponse((response) => {
        try {
          const url = new URL(response.url());
          return url.origin === supplierOrigin && response.request().method() === "GET"
            && parseAirbnbApiUrl(url, job).operationName === operationName;
        } catch { return false; }
      }, { timeout: responseTimeoutMs })).catch(() => null);
      try { await cycle.run(trigger); } catch (error) {
        if (cycle.expired) throw error;
        return cycle.run(() => authOrDrift());
      }
      const response = await cycle.run(() => pending);
      if (!response) return cycle.run(() => authOrDrift());
      cycle.assert();
      const count = operationName === AIRBNB_PROFILE_OPERATION ? guard.profileReads : guard.calendarReads;
      if (count !== beforeCount + 1 || response.fromServiceWorker()) throw new ContractError("DOM_DRIFT");
      const descriptor = parseAirbnbApiUrl(new URL(response.url()), job);
      return Object.freeze({ descriptor, body: await responseJson(response, cycle.run) });
    }

    async function readSelfProfile(cycle) {
      cycle.assert();
      try { await cycle.run(() => page.goto(profileUrl, { waitUntil: "domcontentloaded" })); } catch (error) {
        if (cycle.expired) throw error;
        return cycle.run(() => authOrDrift());
      }
      cycle.assert();
      const main = page.locator("main");
      const heading = main.getByRole("heading", { name: "自己紹介", exact: true });
      const edit = main.getByRole("button", { name: "編集", exact: true });
      try { await cycle.run(() => heading.waitFor({ state: "visible", timeout: 5_000 })); } catch (error) {
        if (cycle.expired) throw error;
        return cycle.run(() => authOrDrift());
      }
      if (await cycle.run(() => heading.count()) !== 1 || await cycle.run(() => edit.count()) !== 1) {
        return cycle.run(() => authOrDrift());
      }
      const before = guard.profileReads;
      const read = await waitForApi(AIRBNB_PROFILE_OPERATION, before, () => edit.click(), cycle);
      validateAirbnbSelfProfile(read.body, job);
      cycle.assert();
    }

    async function readCalendar(cycle) {
      const before = guard.calendarReads;
      const read = await waitForApi(AIRBNB_CALENDAR_OPERATION, before,
        () => page.goto(calendarUrl, { waitUntil: "domcontentloaded" }), cycle);
      cycle.assert();
      return selectAirbnbCalendarObservation(read.body, job, read.descriptor.variables);
    }

    async function observeTarget() {
      let cycle;
      try {
        cycle = createObserveCycle();
        await preflight(cycle);
        await readSelfProfile(cycle);
        const selected = await readCalendar(cycle);
        await preflight(cycle);
        const observedAt = currentDate(now);
        assertJobActive(job, () => observedAt);
        cycle.assert();
        return Object.freeze({
          occurrenceId: job.occurrenceId,
          sourceStartAtUtc: job.sourceStartAtUtc,
          sourceEndAtUtc: job.sourceEndAtUtc,
          observedAtUtc: observedAt.toISOString(),
          bookable: selected.bookable,
          evidence: "EXACT_SLOT_V1",
          partySize: 1,
        });
      } catch (error) {
        const stopped = await confirmedStop();
        if (!stopped) throw new ContractError("PROCESS_STOP_UNCONFIRMED");
        throw sanitized(error);
      } finally {
        cycle?.close();
      }
    }

    return Object.freeze({
      guard,
      observeTarget,
      async stop() { return confirmedStop(); },
    });
  } catch (error) {
    const stopped = await confirmedStop();
    if (!stopped) throw new ContractError("PROCESS_STOP_UNCONFIRMED");
    throw sanitized(error);
  }
}
