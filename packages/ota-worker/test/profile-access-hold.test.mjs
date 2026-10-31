import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { constants as fsConstants } from "node:fs";
import { chmod, link, lstat, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startManagedBrowser } from "../src/managed-browser.mjs";
import {
  assertProfileAccessAvailable,
  holdProfileAccess,
  PROFILE_ACCESS_HOLD,
  profileAccessHoldInternals,
} from "../src/profile-access-hold.mjs";

async function makeProfile(t, prefix = "niho-access-hold-") {
  const profile = await realpath(await mkdtemp(join(await realpath(tmpdir()), prefix)));
  await chmod(profile, 0o700);
  t.after(() => rm(profile, { recursive: true, force: true }));
  return profile;
}

const holdPath = (profile) => join(profile, PROFILE_ACCESS_HOLD);

test("missing hold permits access and a private valid hold fails closed", async (t) => {
  const profile = await makeProfile(t);
  assert.equal(await assertProfileAccessAvailable(profile), true);
  const hold = await holdProfileAccess(profile, "BOT_CHALLENGE");
  assert.deepEqual(Object.keys(hold).sort(), ["heldAtUtc", "reasonCode", "version"]);
  assert.equal(hold.version, 1);
  assert.equal(hold.reasonCode, "BOT_CHALLENGE");
  assert.equal(new Date(hold.heldAtUtc).toISOString(), hold.heldAtUtc);
  const details = await lstat(holdPath(profile));
  assert.equal(details.mode & 0o777, 0o600);
  assert.equal(details.nlink, 1);
  await assert.rejects(assertProfileAccessAvailable(profile), (error) => error.code === "PROFILE_ACCESS_HELD"
    && error.reasonCode === "BOT_CHALLENGE" && error.heldAtUtc === hold.heldAtUtc);
  const repeated = await holdProfileAccess(profile, "RATE_LIMITED");
  assert.deepEqual(repeated, hold, "an existing hold is never overwritten or relaxed");
});

test("invalid, unsafe, linked and oversized hold files all fail closed", async (t) => {
  const cases = [
    ["invalid-json", "not-json\n", 0o600],
    ["unknown-key", `${JSON.stringify({ version: 1, reasonCode: "BOT_CHALLENGE", heldAtUtc: new Date().toISOString(), extra: true })}\n`, 0o600],
    ["invalid-reason", `${JSON.stringify({ version: 1, reasonCode: "UNKNOWN", heldAtUtc: new Date().toISOString() })}\n`, 0o600],
    ["invalid-date", `${JSON.stringify({ version: 1, reasonCode: "ACCESS_RESTRICTED", heldAtUtc: "today" })}\n`, 0o600],
    ["unsafe-mode", `${JSON.stringify({ version: 1, reasonCode: "ACCESS_RESTRICTED", heldAtUtc: new Date().toISOString() })}\n`, 0o644],
    ["oversized", "x".repeat(profileAccessHoldInternals.MAX_HOLD_BYTES + 1), 0o600],
  ];
  for (const [name, raw, mode] of cases) {
    await t.test(name, async (t) => {
      const profile = await makeProfile(t, `niho-hold-${name}-`);
      await writeFile(holdPath(profile), raw, { mode });
      await chmod(holdPath(profile), mode);
      await assert.rejects(assertProfileAccessAvailable(profile), (error) => error.code === "INVALID_PROFILE_ACCESS_HOLD");
    });
  }
  await t.test("symlink", async (t) => {
    const profile = await makeProfile(t, "niho-hold-symlink-");
    const target = join(profile, "unrelated.json");
    await writeFile(target, "{}\n", { mode: 0o600 });
    await symlink(target, holdPath(profile));
    await assert.rejects(assertProfileAccessAvailable(profile), (error) => error.code === "INVALID_PROFILE_ACCESS_HOLD");
    assert.equal(await readFile(target, "utf8"), "{}\n");
  });
  await t.test("hard link", async (t) => {
    const profile = await makeProfile(t, "niho-hold-hardlink-");
    await holdProfileAccess(profile, "OWNER_PAUSED");
    await link(holdPath(profile), join(profile, "second-link.json"));
    await assert.rejects(assertProfileAccessAvailable(profile), (error) => error.code === "INVALID_PROFILE_ACCESS_HOLD");
  });
});

test("a hold is profile-local and visible to a separate Node process", async (t) => {
  const held = await makeProfile(t, "niho-held-profile-");
  const available = await makeProfile(t, "niho-available-profile-");
  await holdProfileAccess(held, "ACCESS_RESTRICTED");
  assert.equal(await assertProfileAccessAvailable(available), true);

  const moduleUrl = new URL("../src/profile-access-hold.mjs", import.meta.url).href;
  const script = `import { assertProfileAccessAvailable } from ${JSON.stringify(moduleUrl)};
    try { await assertProfileAccessAvailable(process.argv[1]); process.exitCode = 2; }
    catch (error) { process.exitCode = error.code === "PROFILE_ACCESS_HELD" ? 0 : 3; }`;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", script, held], {
    stdio: ["ignore", "ignore", "ignore"],
  });
  const [code] = await once(child, "exit");
  assert.equal(code, 0);
});

test("none, prepare and restore reject a held profile before synthetic Chrome starts", async (t) => {
  for (const policy of ["none", "prepare", "restore"]) {
    await t.test(policy, async (t) => {
      const profile = await makeProfile(t, `niho-held-${policy}-`);
      await holdProfileAccess(profile, "OWNER_PAUSED");
      const counter = join(profile, "chrome-start-count");
      const executable = join(profile, "synthetic-chrome");
      const quotedCounter = counter.replaceAll("'", "'\\''");
      await writeFile(executable, `#!/bin/sh\nprintf x >> '${quotedCounter}'\nexit 1\n`, { mode: 0o700 });
      await chmod(executable, 0o700);
      await assert.rejects(startManagedBrowser({ executablePath: executable, userDataDir: profile, headless: true, sessionPolicy: policy }),
        (error) => error.code === "PROFILE_ACCESS_HELD");
      await assert.rejects(lstat(counter), (error) => error.code === "ENOENT");
    });
  }
});

test("hold file validation rejects a different owner without filesystem mutation", () => {
  assert.equal(profileAccessHoldInternals.safeHoldFile({
    isFile: () => true,
    nlink: 1n,
    uid: BigInt(process.getuid() + 1),
    mode: BigInt(fsConstants.S_IFREG | 0o600),
    size: 10n,
  }), false);
});

test("bounded hold reader never requests more than MAX_HOLD_BYTES plus one", async () => {
  let largestRead = 0;
  const handle = {
    async read(buffer, offset, length) {
      largestRead = Math.max(largestRead, length);
      buffer.fill(0x78, offset, offset + length);
      return { bytesRead: length };
    },
  };
  await assert.rejects(profileAccessHoldInternals.readBounded(handle), (error) => error.code === "INVALID_PROFILE_ACCESS_HOLD");
  assert.ok(largestRead <= profileAccessHoldInternals.MAX_HOLD_BYTES + 1);
});
