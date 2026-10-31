import { mkdir, realpath, stat } from "node:fs/promises";
import { chromium } from "playwright-core";
import { spawnOwned } from "./owned-process.mjs";
import {
  beginManagedSession,
  markManagedSessionClean,
  releaseManagedSessionLock,
  validateSessionPolicy,
} from "./managed-session-journal.mjs";
import { ContractError } from "./validation.mjs";
import { assertProfileAccessAvailable } from "./profile-access-hold.mjs";

const MAX_SANITIZE_PAGES = 16;
const SANITIZE_TIMEOUT_MS = 1_000;

async function privateProfile(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const canonical = await realpath(path);
  const details = await stat(canonical);
  if (canonical !== path || !details.isDirectory() || (details.mode & 0o777) !== 0o700 || details.uid !== process.getuid()) {
    throw new ContractError("INSECURE_PROFILE");
  }
  return path;
}

function waitForEndpoint(owned, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => finish(new ContractError("BROWSER_START_TIMEOUT")), timeoutMs);
    timer.unref?.();
    const finish = (error, value) => {
      clearTimeout(timer);
      owned.child.stderr.off("data", onData);
      owned.child.off("exit", onExit);
      if (error) reject(error); else resolve(value);
    };
    const onData = (chunk) => {
      buffer = `${buffer}${chunk.toString("utf8")}`.slice(-8192);
      const match = /DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[A-Za-z0-9-]+)/.exec(buffer);
      if (match) finish(null, match[1]);
    };
    const onExit = () => finish(new ContractError("BROWSER_START_FAILED"));
    owned.child.stderr.on("data", onData);
    owned.child.once("exit", onExit);
  });
}

export async function stopManagedBrowser(browser, owned, closeGraceMs = 1_000, naturalStopMs = 3_000) {
  let timer;
  try {
    await Promise.race([
      Promise.resolve().then(async () => {
        if (typeof browser?.newBrowserCDPSession === "function") {
          const session = await browser.newBrowserCDPSession();
          await session.send("Browser.close");
        } else {
          await browser?.close();
        }
      }).catch(() => {}),
      new Promise((resolve) => { timer = setTimeout(resolve, closeGraceMs); }),
    ]);
  } catch {
    // Process stop below remains mandatory even if the close transport fails.
  } finally {
    clearTimeout(timer);
  }
  // connectOverCDP.close() disconnects its transport. Chrome must first get a
  // chance to flush its own profile and exit, without terminating its network
  // process alongside it. Process ownership remains the final stop boundary.
  if (typeof owned.waitForStop === "function") {
    await owned.waitForStop(naturalStopMs).catch(() => false);
  }
  // CDP can be unresponsive. Process ownership is the independent stop boundary.
  return owned.stop();
}

function remaining(deadline) {
  return Math.max(1, deadline - Date.now());
}

async function bounded(operation, deadline) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new ContractError("SESSION_SANITIZE_TIMEOUT")), remaining(deadline));
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function trackManagedSessionPages(context) {
  let unexpectedPage = false;
  let creatingPage = false;
  let expectedPage;
  let creationEvents = [];
  const onPage = (page) => {
    if (creatingPage) creationEvents.push(page);
    else if (page !== expectedPage) unexpectedPage = true;
  };
  context.on("page", onPage);
  return Object.freeze({
    get unexpectedPage() { return unexpectedPage; },
    async createExpected(operation) {
      creatingPage = true;
      creationEvents = [];
      let page;
      try { page = await operation(); expectedPage = page; }
      finally {
        creatingPage = false;
        if (!page || creationEvents.some((candidate) => candidate !== page)) unexpectedPage = true;
      }
      return page;
    },
    stop() { try { context.off("page", onPage); } catch {} },
  });
}

async function sanitizeManagedSession(context, timeoutMs = SANITIZE_TIMEOUT_MS, maxPages = MAX_SANITIZE_PAGES, existingTracker) {
  const deadline = Date.now() + timeoutMs;
  let tracker = existingTracker;
  let ownsTracker = false;
  try {
    if (!tracker) { tracker = trackManagedSessionPages(context); ownsTracker = true; }
    await bounded(() => context.route("**/*", (route) => route.abort("blockedbyclient")), deadline);
    let pages = context.pages();
    if (pages.length > maxPages) return false;
    if (pages.length === 0) {
      pages = [await tracker.createExpected(() => bounded(() => context.newPage(), deadline))];
    }
    for (const page of pages) {
      await bounded(() => page.goto("about:blank", { waitUntil: "commit", timeout: remaining(deadline) }), deadline);
    }
    for (const page of pages.slice(1)) {
      await bounded(() => page.close({ runBeforeUnload: false }), deadline);
    }
    await bounded(() => new Promise((resolve) => setImmediate(resolve)), deadline);
    const finalPages = context.pages();
    if (tracker.unexpectedPage || finalPages.length !== 1 || finalPages[0].url() !== "about:blank") return false;
    await bounded(() => new Promise((resolve) => setImmediate(resolve)), deadline);
    return !tracker.unexpectedPage && context.pages().length === 1 && context.pages()[0] === finalPages[0]
      && finalPages[0].url() === "about:blank";
  } catch {
    return false;
  } finally {
    if (ownsTracker) tracker?.stop();
  }
}

async function stopManagedSessionBrowser(browser, context, owned, session, options = {}) {
  let tracker;
  try { tracker = trackManagedSessionPages(context); } catch {}
  const sanitized = tracker ? await sanitizeManagedSession(
    context, options.sanitizeTimeoutMs ?? SANITIZE_TIMEOUT_MS, options.maxPages ?? MAX_SANITIZE_PAGES, tracker,
  ).catch(() => false) : false;
  const stopped = await stopManagedBrowser(
    browser,
    owned,
    options.closeGraceMs,
    options.naturalStopMs,
  ).catch(() => false);
  const noLatePage = tracker ? !tracker.unexpectedPage : false;
  tracker?.stop();
  if (!stopped) return false;
  if (sanitized && noLatePage) await markManagedSessionClean(session).catch(() => {});
  await releaseManagedSessionLock(session).catch(() => false);
  return true;
}

function managedBrowserArguments(userDataDir, headless, sessionEnabled, restore) {
  const args = [
    `--user-data-dir=${userDataDir}`,
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-sync",
    "--disable-features=OptimizationHints,Translate,ServiceWorker",
    "about:blank",
  ];
  // The attestation covers Default. Do not let Local State select another
  // profile before the network guard has been attached.
  if (sessionEnabled) args.splice(args.length - 1, 0, "--disable-extensions", "--profile-directory=Default");
  if (restore) args.splice(args.length - 1, 0, "--restore-last-session");
  if (headless) args.unshift("--headless=new", "--disable-gpu");
  return args;
}

export async function startManagedBrowser({ executablePath, userDataDir, headless = false, sessionPolicy = "none" }) {
  validateSessionPolicy(sessionPolicy);
  await privateProfile(userDataDir);
  await assertProfileAccessAvailable(userDataDir);
  const session = sessionPolicy === "none" ? null : await beginManagedSession(userDataDir, sessionPolicy);
  const args = managedBrowserArguments(userDataDir, headless, session !== null, session?.restore === true);
  let owned;
  let browser;
  try {
    owned = spawnOwned(executablePath, args, { stdio: ["ignore", "ignore", "pipe"], env: {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR ?? "/tmp",
      LANG: "en_US.UTF-8",
    } });
    const endpoint = await waitForEndpoint(owned);
    owned.child.stderr.resume();
    browser = await chromium.connectOverCDP(endpoint, { timeout: 10_000 });
    const context = browser.contexts()[0];
    if (!context) throw new ContractError("BROWSER_CONTEXT_MISSING");
    let stopPromise = null;
    return Object.freeze({
      pid: owned.pid,
      browser,
      context,
      async stop() {
        stopPromise ??= session
          ? stopManagedSessionBrowser(browser, context, owned, session)
          : stopManagedBrowser(browser, owned);
        return stopPromise;
      },
    });
  } catch (error) {
    const stopped = owned ? await stopManagedBrowser(browser, owned).catch(() => false) : true;
    if (session && stopped) await releaseManagedSessionLock(session).catch(() => false);
    if (!stopped) throw new ContractError("PROCESS_STOP_UNCONFIRMED");
    throw error;
  }
}

export const managedBrowserInternals = Object.freeze({
  managedBrowserArguments,
  trackManagedSessionPages,
  sanitizeManagedSession,
  stopManagedSessionBrowser,
  MAX_SANITIZE_PAGES,
  SANITIZE_TIMEOUT_MS,
});
