import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  attestManagedProfile,
  beginManagedSession,
  MANAGED_SESSION_JOURNAL,
  MANAGED_SESSION_LOCK,
  managedSessionJournalInternals,
  markManagedSessionClean,
  releaseManagedSessionLock,
} from "../src/managed-session-journal.mjs";
import { managedBrowserInternals, startManagedBrowser } from "../src/managed-browser.mjs";

const TEST_PROFILE_STATE_HASH = "0".repeat(64);

async function makeProfile(t, prefix = "niho-managed-session-") {
  const profile = await mkdtemp(join(await realpath(tmpdir()), prefix));
  await chmod(profile, 0o700);
  await mkdir(join(profile, "Default"), { mode: 0o700 });
  await writeFile(join(profile, "Default", "Preferences"), "{}\n", { mode: 0o600 });
  t.after(() => rm(profile, { recursive: true, force: true }));
  return profile;
}

async function journal(profile) {
  return JSON.parse(await readFile(join(profile, MANAGED_SESSION_JOURNAL), "utf8"));
}

function fakeContext(pageCount = 1, order = []) {
  const listeners = new Set();
  const pages = Array.from({ length: pageCount }, (_, index) => {
    let url = `http://127.0.0.1/work/${index}`;
    const page = {
      async goto(next) { order.push("goto"); url = next; },
      async close(options) {
        assert.equal(options.runBeforeUnload, false);
        pages.splice(pages.indexOf(page), 1);
      },
      url() { return url; },
    };
    return page;
  });
  return {
    async route(pattern) { assert.equal(pattern, "**/*"); order.push("route"); },
    pages() { return [...pages]; },
    on(event, listener) { if (event === "page") listeners.add(listener); },
    off(event, listener) { if (event === "page") listeners.delete(listener); },
    emitPage(page = {}) { for (const listener of listeners) listener(page); },
    async newPage() { throw new Error("not expected"); },
  };
}

function fakeBrowser(onClose) {
  return { async newBrowserCDPSession() { return { async send() { onClose?.(); } }; } };
}

test("prepare writes DIRTY, a clean stop permits restore, and restore writes DIRTY before launch", async (t) => {
  const profile = await makeProfile(t);
  const prepared = await beginManagedSession(profile, "prepare");
  assert.equal(prepared.restore, false);
  assert.equal((await journal(profile)).phase, "DIRTY");
  await markManagedSessionClean(prepared);
  await releaseManagedSessionLock(prepared);
  assert.equal((await journal(profile)).phase, "CLEAN");

  const preparedAgain = await beginManagedSession(profile, "prepare");
  assert.equal(preparedAgain.restore, false);
  await markManagedSessionClean(preparedAgain);
  await releaseManagedSessionLock(preparedAgain);

  const restored = await beginManagedSession(profile, "restore");
  assert.equal(restored.restore, true);
  assert.equal((await journal(profile)).phase, "DIRTY");
  await markManagedSessionClean(restored);
  await releaseManagedSessionLock(restored);
});

test("restore rejects missing journals and both policies reject DIRTY journals", async (t) => {
  const missing = await makeProfile(t, "niho-session-missing-");
  await assert.rejects(beginManagedSession(missing, "restore"), (error) => error.code === "SESSION_JOURNAL_MISSING");

  const dirty = await makeProfile(t, "niho-session-dirty-");
  await writeFile(join(dirty, MANAGED_SESSION_JOURNAL), `${JSON.stringify({
    version: 1, phase: "DIRTY", profile: dirty, nonce: "opaque",
  })}\n`, { mode: 0o600 });
  await assert.rejects(beginManagedSession(dirty, "prepare"), (error) => error.code === "SESSION_JOURNAL_DIRTY");
  await assert.rejects(beginManagedSession(dirty, "restore"), (error) => error.code === "SESSION_JOURNAL_DIRTY");
});

test("journal rejects corruption, unknown keys, wrong profile binding, unsafe mode, symlinks, and oversized input", async (t) => {
  const cases = [
    ["corrupt", "not-json\n", undefined, "INVALID_SESSION_JOURNAL"],
    ["unknown", JSON.stringify({ version: 1, phase: "CLEAN", profile: "PROFILE", nonce: "opaque", profileStateHash: TEST_PROFILE_STATE_HASH, extra: true }), undefined, "INVALID_SESSION_JOURNAL"],
    ["binding", JSON.stringify({ version: 1, phase: "CLEAN", profile: "/wrong/profile", nonce: "opaque", profileStateHash: TEST_PROFILE_STATE_HASH }), undefined, "SESSION_PROFILE_MISMATCH"],
    ["mode", JSON.stringify({ version: 1, phase: "CLEAN", profile: "PROFILE", nonce: "opaque", profileStateHash: TEST_PROFILE_STATE_HASH }), 0o644, "INSECURE_SESSION_FILE"],
    ["oversized", "x".repeat(managedSessionJournalInternals.MAX_SESSION_FILE_BYTES + 1), undefined, "SESSION_FILE_TOO_LARGE"],
  ];
  for (const [name, rawTemplate, mode, code] of cases) {
    await t.test(name, async (t) => {
      const profile = await makeProfile(t, `niho-session-${name}-`);
      const raw = `${rawTemplate.replaceAll("PROFILE", profile)}\n`;
      await writeFile(join(profile, MANAGED_SESSION_JOURNAL), raw, { mode: mode ?? 0o600 });
      await assert.rejects(beginManagedSession(profile, "restore"), (error) => error.code === code);
    });
  }
  await t.test("symlink", async (t) => {
    const profile = await makeProfile(t, "niho-session-symlink-");
    const target = join(profile, "unrelated.json");
    await writeFile(target, "{}\n", { mode: 0o600 });
    await symlink(target, join(profile, MANAGED_SESSION_JOURNAL));
    await assert.rejects(beginManagedSession(profile, "restore"), (error) => error.code === "INSECURE_SESSION_FILE");
    assert.equal(await readFile(target, "utf8"), "{}\n");
  });
});

test("owner validation rejects a file belonging to another uid", () => {
  assert.equal(managedSessionJournalInternals.validatePrivateFileDetails({
    isFile: () => true,
    nlink: 1,
    uid: process.getuid() + 1,
    mode: 0o100600,
    size: 10,
  }), false);
});

test("restore rejects CLEAN after Preferences or Sessions changes without reading Cookies", async (t) => {
  for (const changed of ["Preferences", "Sessions"]) {
    await t.test(changed, async (t) => {
      const profile = await makeProfile(t, `niho-attestation-${changed.toLowerCase()}-`);
      await writeFile(join(profile, "Default", "Cookies"), "not inspected\n", { mode: 0o000 });
      const sessions = join(profile, "Default", "Sessions");
      await mkdir(sessions, { mode: 0o700 });
      await writeFile(join(sessions, "Session_1"), "blank-session\n", { mode: 0o600 });
      const prepared = await beginManagedSession(profile, "prepare");
      await markManagedSessionClean(prepared);
      await releaseManagedSessionLock(prepared);
      if (changed === "Preferences") {
        await writeFile(join(profile, "Default", "Preferences"), "{\"session\":\"changed\"}\n", { mode: 0o600 });
      } else {
        await writeFile(join(sessions, "Tabs_2"), "business-tab\n", { mode: 0o600 });
      }
      await assert.rejects(beginManagedSession(profile, "restore"), (error) => error.code === "SESSION_PROFILE_CHANGED");
      assert.equal((await journal(profile)).phase, "CLEAN");
      await chmod(join(profile, "Default", "Cookies"), 0o600);
    });
  }
});

test("profile attestation rejects unsafe, unknown, oversized, and multiple-profile state", async (t) => {
  await t.test("symlink session artifact", async (t) => {
    const profile = await makeProfile(t, "niho-attest-symlink-");
    const sessions = join(profile, "Default", "Sessions");
    await mkdir(sessions, { mode: 0o700 });
    await symlink(join(profile, "Default", "Preferences"), join(sessions, "Session_1"));
    await assert.rejects(attestManagedProfile(profile), (error) => error.code === "UNKNOWN_SESSION_ARTIFACT");
  });
  await t.test("unknown session artifact", async (t) => {
    const profile = await makeProfile(t, "niho-attest-unknown-");
    const sessions = join(profile, "Default", "Sessions");
    await mkdir(sessions, { mode: 0o700 });
    await writeFile(join(sessions, "Last Session"), "unknown\n", { mode: 0o600 });
    await assert.rejects(attestManagedProfile(profile), (error) => error.code === "UNKNOWN_SESSION_ARTIFACT");
  });
  await t.test("oversized preferences", async (t) => {
    const profile = await makeProfile(t, "niho-attest-oversized-");
    await writeFile(join(profile, "Default", "Preferences"), Buffer.alloc(4 * 1_024 * 1_024 + 1), { mode: 0o600 });
    await assert.rejects(attestManagedProfile(profile), (error) => error.code === "PROFILE_STATE_LIMIT");
  });
  await t.test("additional profile", async (t) => {
    const profile = await makeProfile(t, "niho-attest-multiple-");
    await mkdir(join(profile, "Profile 1"), { mode: 0o700 });
    await assert.rejects(attestManagedProfile(profile), (error) => error.code === "MULTIPLE_CHROME_PROFILES");
  });
  assert.equal(managedSessionJournalInternals.unchangedFile?.(
    { dev: 1n, ino: 2n, size: 3n, mtimeNs: 4n, ctimeNs: 5n },
    { dev: 1n, ino: 2n, size: 3n, mtimeNs: 6n, ctimeNs: 5n },
  ) ?? false, false);
});

test("an existing owner lock rejects concurrent launch and is not inferred stale", async (t) => {
  const profile = await makeProfile(t);
  const first = await beginManagedSession(profile, "prepare");
  await assert.rejects(beginManagedSession(profile, "prepare"), (error) => error.code === "SESSION_LOCKED");
  assert.equal(existsSync(join(profile, MANAGED_SESSION_LOCK)), true);
  await releaseManagedSessionLock(first);
});

test("a failed process stop retains the lock and a DIRTY journal", async (t) => {
  const profile = await makeProfile(t);
  const session = await beginManagedSession(profile, "prepare");
  const stopped = await managedBrowserInternals.stopManagedSessionBrowser(
    fakeBrowser(),
    fakeContext(),
    { async waitForStop() { return false; }, async stop() { return false; } },
    session,
    { closeGraceMs: 1, naturalStopMs: 1, sanitizeTimeoutMs: 50 },
  );
  assert.equal(stopped, false);
  assert.equal((await journal(profile)).phase, "DIRTY");
  assert.equal(existsSync(join(profile, MANAGED_SESSION_LOCK)), true);
});

test("sanitize failure still stops the owned process, keeps DIRTY, and may release its own lock", async (t) => {
  const profile = await makeProfile(t);
  const session = await beginManagedSession(profile, "prepare");
  let stopAttempts = 0;
  const stopped = await managedBrowserInternals.stopManagedSessionBrowser(
    fakeBrowser(),
    fakeContext(managedBrowserInternals.MAX_SANITIZE_PAGES + 1),
    { async waitForStop() { return true; }, async stop() { stopAttempts += 1; return true; } },
    session,
    { closeGraceMs: 1, naturalStopMs: 1, sanitizeTimeoutMs: 50 },
  );
  assert.equal(stopped, true);
  assert.equal(stopAttempts, 1);
  assert.equal((await journal(profile)).phase, "DIRTY");
  assert.equal(existsSync(join(profile, MANAGED_SESSION_LOCK)), false);
});

test("network abort route is installed before pages are blanked and a clean stopped session becomes CLEAN", async (t) => {
  const profile = await makeProfile(t);
  const session = await beginManagedSession(profile, "prepare");
  const order = [];
  const stopped = await managedBrowserInternals.stopManagedSessionBrowser(
    fakeBrowser(),
    fakeContext(2, order),
    { async waitForStop() { return true; }, async stop() { return true; } },
    session,
    { closeGraceMs: 1, naturalStopMs: 1, sanitizeTimeoutMs: 100 },
  );
  assert.equal(stopped, true);
  assert.deepEqual(order.slice(0, 2), ["route", "goto"]);
  assert.equal((await journal(profile)).phase, "CLEAN");
  assert.equal(existsSync(join(profile, MANAGED_SESSION_LOCK)), false);
});

test("a page created during Browser.close prevents CLEAN after process stop", async (t) => {
  const profile = await makeProfile(t);
  const session = await beginManagedSession(profile, "prepare");
  const context = fakeContext();
  const stopped = await managedBrowserInternals.stopManagedSessionBrowser(
    fakeBrowser(() => context.emitPage()),
    context,
    { async waitForStop() { return true; }, async stop() { return true; } },
    session,
    { closeGraceMs: 1, naturalStopMs: 1, sanitizeTimeoutMs: 100 },
  );
  assert.equal(stopped, true);
  assert.equal((await journal(profile)).phase, "DIRTY");
  assert.equal(existsSync(session.lockPath), false);
});

test("a page opened during sanitization makes the result unsafe", async () => {
  let pageListener;
  let url = "http://127.0.0.1/work";
  const page = {
    async goto(next) { url = next; pageListener?.({}); },
    url() { return url; },
  };
  const context = {
    async route() {},
    pages() { return [page]; },
    on(event, listener) { if (event === "page") pageListener = listener; },
    off() { pageListener = undefined; },
  };
  assert.equal(await managedBrowserInternals.sanitizeManagedSession(context, 100), false);
});

test("sanitize timeout still reaches the independent owned stop", async (t) => {
  const profile = await makeProfile(t);
  const session = await beginManagedSession(profile, "prepare");
  let stopAttempts = 0;
  const stopped = await managedBrowserInternals.stopManagedSessionBrowser(
    fakeBrowser(),
    { route: () => new Promise(() => {}) },
    { async waitForStop() { return true; }, async stop() { stopAttempts += 1; return true; } },
    session,
    { closeGraceMs: 1, naturalStopMs: 1, sanitizeTimeoutMs: 10 },
  );
  assert.equal(stopped, true);
  assert.equal(stopAttempts, 1);
  assert.equal((await journal(profile)).phase, "DIRTY");
  assert.equal(existsSync(session.lockPath), false);
});

test("a hung page navigation still reaches the independent owned stop", async (t) => {
  const profile = await makeProfile(t);
  const session = await beginManagedSession(profile, "prepare");
  const context = fakeContext();
  context.pages()[0].goto = () => new Promise(() => {});
  let stopAttempts = 0;
  const stopped = await managedBrowserInternals.stopManagedSessionBrowser(
    fakeBrowser(),
    context,
    { async waitForStop() { return true; }, async stop() { stopAttempts += 1; return true; } },
    session,
    { closeGraceMs: 1, naturalStopMs: 1, sanitizeTimeoutMs: 10 },
  );
  assert.equal(stopped, true);
  assert.equal(stopAttempts, 1);
  assert.equal((await journal(profile)).phase, "DIRTY");
});

test("journal failure cannot skip the mandatory owned stop", async (t) => {
  const profile = await makeProfile(t);
  const session = await beginManagedSession(profile, "prepare");
  await chmod(session.journalPath, 0o000);
  let stopAttempts = 0;
  const stopped = await managedBrowserInternals.stopManagedSessionBrowser(
    fakeBrowser(),
    fakeContext(),
    { async waitForStop() { return true; }, async stop() { stopAttempts += 1; return true; } },
    session,
    { closeGraceMs: 1, naturalStopMs: 1, sanitizeTimeoutMs: 100 },
  );
  assert.equal(stopped, true);
  assert.equal(stopAttempts, 1);
  assert.equal(existsSync(session.lockPath), false);
  await chmod(session.journalPath, 0o600);
  assert.equal((await journal(profile)).phase, "DIRTY");
});

test("lock release refuses a different nonce without deleting the replacement", async (t) => {
  const profile = await makeProfile(t);
  const session = await beginManagedSession(profile, "prepare");
  await writeFile(session.lockPath, `${JSON.stringify({ version: 1, profile, nonce: "replacement-nonce" })}\n`, { mode: 0o600 });
  await assert.rejects(markManagedSessionClean(session), (error) => error.code === "SESSION_LOCK_CHANGED");
  assert.equal((await journal(profile)).phase, "DIRTY");
  assert.equal(await releaseManagedSessionLock(session), false);
  assert.equal(existsSync(session.lockPath), true);
});

test("missing own lock prevents CLEAN", async (t) => {
  const profile = await makeProfile(t);
  const session = await beginManagedSession(profile, "prepare");
  await unlink(session.lockPath);
  await assert.rejects(markManagedSessionClean(session), (error) => error.code === "SESSION_LOCK_MISSING");
  assert.equal((await journal(profile)).phase, "DIRTY");
});

test("default none rejects no existing behavior and never creates session metadata", async (t) => {
  const profile = await makeProfile(t);
  await assert.rejects(startManagedBrowser({
    executablePath: join(profile, "missing-chrome"),
    userDataDir: profile,
    headless: true,
  }), (error) => error.code === "PROCESS_START_FAILED");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(existsSync(join(profile, MANAGED_SESSION_JOURNAL)), false);
  assert.equal(existsSync(join(profile, MANAGED_SESSION_LOCK)), false);
});

test("unknown session policy is rejected before profile or process access", async () => {
  await assert.rejects(startManagedBrowser({
    executablePath: "/not-used",
    userDataDir: "/not-used",
    sessionPolicy: "custom-flags",
  }), (error) => error.code === "INVALID_SESSION_POLICY");
});

test("only accepted restore adds the one fixed Chrome flag", () => {
  const normal = managedBrowserInternals.managedBrowserArguments("/private/profile", false, false, false);
  const prepare = managedBrowserInternals.managedBrowserArguments("/private/profile", false, true, false);
  const restore = managedBrowserInternals.managedBrowserArguments("/private/profile", false, true, true);
  assert.equal(normal.includes("--restore-last-session"), false);
  assert.equal(normal.includes("--disable-extensions"), false);
  assert.equal(normal.includes("--profile-directory=Default"), false);
  assert.equal(prepare.includes("--disable-extensions"), true);
  assert.equal(prepare.includes("--profile-directory=Default"), true);
  assert.equal(restore.includes("--profile-directory=Default"), true);
  assert.equal(restore.filter((argument) => argument === "--restore-last-session").length, 1);
  assert.equal(restore.includes("--no-sandbox"), false);
  assert.equal(restore.at(-1), "about:blank");
  assert.equal(managedBrowserInternals.SANITIZE_TIMEOUT_MS, 1_000);
});
