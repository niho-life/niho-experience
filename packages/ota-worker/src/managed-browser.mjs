import { mkdir, realpath, stat } from "node:fs/promises";
import { chromium } from "playwright-core";
import { spawnOwned } from "./owned-process.mjs";
import { ContractError } from "./validation.mjs";

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

export async function startManagedBrowser({ executablePath, userDataDir, headless = false }) {
  await privateProfile(userDataDir);
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
  if (headless) args.unshift("--headless=new", "--disable-gpu");
  const owned = spawnOwned(executablePath, args, { stdio: ["ignore", "ignore", "pipe"], env: {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    LANG: "en_US.UTF-8",
  } });
  let browser;
  try {
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
        stopPromise ??= (async () => {
          await browser.close().catch(() => {});
          return owned.stop();
        })();
        return stopPromise;
      },
    });
  } catch (error) {
    await browser?.close().catch(() => {});
    if (!await owned.stop().catch(() => false)) throw new ContractError("PROCESS_STOP_UNCONFIRMED");
    throw error;
  }
}
