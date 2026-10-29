import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.mjs";
import { createCloudClient, CloudError } from "../src/cloud-client.mjs";
import { makeJob } from "./helpers/synthetic-gyg.mjs";
import { validateClaim, validatePreflight } from "../src/validation.mjs";

async function configFixture(origin) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "niho-ota-config-")));
  const profiles = join(directory, "profiles"); await mkdir(profiles, { mode: 0o700 });
  const token = join(directory, "token"); await writeFile(token, "a".repeat(40), { mode: 0o600 });
  const path = join(directory, "config.json");
  await writeFile(path, JSON.stringify({ cloudOrigin: origin, tokenFile: token, privateDir: directory,
    accountProfiles: { "10001": join(profiles, "10001") }, browserExecutable: process.execPath, mode: "deterministic" }), { mode: 0o600 });
  return path;
}

test("production config rejects arbitrary/non-HTTPS origin; localhost requires explicit test injection", async () => {
  await assert.rejects(loadConfig(await configFixture("http://example.test")), (error) => error.code === "INVALID_CLOUD_ORIGIN");
  const local = await configFixture("http://127.0.0.1:4321");
  await assert.rejects(loadConfig(local), (error) => error.code === "INVALID_CLOUD_ORIGIN");
  assert.equal((await loadConfig(local, { allowLocalTestOrigin: true })).cloudOrigin, "http://127.0.0.1:4321");
});

test("config and token permissions are fail-closed", async () => {
  const path = await configFixture("https://cloud.example");
  await chmod(path, 0o644);
  await assert.rejects(loadConfig(path), (error) => error.code === "INSECURE_PRIVATE_PATH");
});

test("cloud client rejects redirects and oversized/extra-key JSON", async () => {
  const redirected = createCloudClient({ origin: "https://cloud.example", token: "x".repeat(40), fetchImpl: async () => new Response(null, { status: 302, headers: { location: "https://elsewhere.test" } }) });
  await assert.rejects(redirected.claimAllowIdle(), (error) => error instanceof CloudError);
  const extra = createCloudClient({ origin: "https://cloud.example", token: "x".repeat(40), fetchImpl: async () => new Response(JSON.stringify({ job: {}, extra: true }), {
    status: 200, headers: { "content-type": "application/json", "content-length": "23" },
  }) });
  await assert.rejects(extra.claimAllowIdle(), (error) => error.code === "INVALID_RESPONSE");
});

test("cloud result validates the exact 200 receipt and accepts a non-current audit receipt", async () => {
  const responses = [
    new Response(JSON.stringify({ acceptedAsCurrent: false, repeated: true }), { status: 200, headers: { "content-type": "application/json" } }),
    new Response(JSON.stringify({ acceptedAsCurrent: true, repeated: false, extra: true }), { status: 200, headers: { "content-type": "application/json" } }),
  ];
  const client = createCloudClient({ origin: "https://cloud.example", token: "x".repeat(40), fetchImpl: async () => responses.shift() });
  assert.deepEqual(await client.result("job", {}), { acceptedAsCurrent: false, repeated: true });
  await assert.rejects(client.result("job", {}), (error) => error.code === "INVALID_RESPONSE");
});

test("cloud timeout remains armed while reading a hanging response body", async () => {
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('{"job":')); },
    cancel() { cancelled = true; },
  });
  const client = createCloudClient({ origin: "https://cloud.example", token: "x".repeat(40), timeoutMs: 20,
    fetchImpl: async () => new Response(stream, { status: 200, headers: { "content-type": "application/json" } }) });
  await assert.rejects(client.claimAllowIdle(), (error) => error.code === "TIMEOUT");
  assert.equal(cancelled, true);
});

test("claim DTO requires a live lease and bounds the deadline with small clock skew", () => {
  const state = { accountId: "10001", productId: "20002", optionId: "30003", localDateTime: "2099-01-01T13:00:00" };
  const { localDateTime, desiredState, ...wire } = makeJob(state, "SET_CLOSED");
  assert.equal(validateClaim(wire).desiredState, "CLOSED");
  assert.throws(() => validateClaim({ ...wire, extra: true }));
  const now = Date.now();
  assert.equal(validateClaim(wire, now - 250).desiredState, "CLOSED");
  assert.throws(() => validateClaim({ ...wire, deadlineAtUtc: new Date(now + 185_001).toISOString() }, now));
  assert.throws(() => validateClaim({ ...wire, leaseExpiresAtUtc: new Date(Date.now() - 1).toISOString() }));
});

test("OBSERVE preflight accepts either strict state without inventing a desired state", () => {
  assert.equal(validatePreflight({ ready: true, desiredState: "OPEN" }, undefined).desiredState, "OPEN");
  assert.equal(validatePreflight({ ready: true, desiredState: "CLOSED" }, undefined).desiredState, "CLOSED");
  assert.throws(() => validatePreflight({ ready: true, desiredState: "UNKNOWN" }, undefined));
});
