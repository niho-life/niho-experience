import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.mjs";
import { createCloudClient, CloudError } from "../src/cloud-client.mjs";
import { makeJob } from "./helpers/synthetic-gyg.mjs";
import { validateClaim, validatePreflight } from "../src/validation.mjs";

async function configFixture(origin, overrides = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "niho-ota-config-")));
  const profiles = join(directory, "profiles"); await mkdir(profiles, { mode: 0o700 });
  const token = join(directory, "token"); await writeFile(token, "a".repeat(40), { mode: 0o600 });
  const path = join(directory, "config.json");
  await writeFile(path, JSON.stringify({ cloudOrigin: origin, tokenFile: token, privateDir: directory,
    accountProfiles: { "10001": join(profiles, "10001") }, browserExecutable: process.execPath, mode: "deterministic",
    ...overrides }), { mode: 0o600 });
  return path;
}

test("production config rejects arbitrary/non-HTTPS origin; localhost requires explicit test injection", async () => {
  await assert.rejects(loadConfig(await configFixture("http://example.test")), (error) => error.code === "INVALID_CLOUD_ORIGIN");
  const local = await configFixture("http://127.0.0.1:4321");
  await assert.rejects(loadConfig(local), (error) => error.code === "INVALID_CLOUD_ORIGIN");
  assert.equal((await loadConfig(local, { allowLocalTestOrigin: true })).cloudOrigin, "http://127.0.0.1:4321");
});

test("Google delivery config is optional, defaults off, and accepts only booleans", async () => {
  const defaults = await loadConfig(await configFixture("https://cloud.example"));
  assert.equal(defaults.googleDeliveryEnabled, false);
  assert.equal(defaults.googleAirbnbObservationEnabled, false);
  assert.equal((await loadConfig(await configFixture("https://cloud.example", { googleDeliveryEnabled: false }))).googleDeliveryEnabled, false);
  assert.equal((await loadConfig(await configFixture("https://cloud.example", { googleDeliveryEnabled: true }))).googleDeliveryEnabled, true);
  assert.equal((await loadConfig(await configFixture("https://cloud.example", {
    googleDeliveryEnabled: true, googleAirbnbObservationEnabled: true,
  }))).googleAirbnbObservationEnabled, true);
  await assert.rejects(loadConfig(await configFixture("https://cloud.example", { googleDeliveryEnabled: "true" })),
    (error) => error.code === "INVALID_CONFIG");
  await assert.rejects(loadConfig(await configFixture("https://cloud.example", { googleAirbnbObservationEnabled: true })),
    (error) => error.code === "INVALID_CONFIG");
  await assert.rejects(loadConfig(await configFixture("https://cloud.example", {
    googleDeliveryEnabled: true, googleAirbnbObservationEnabled: "true",
  })), (error) => error.code === "INVALID_CONFIG");
});

test("reservation readers are optional, default to none, and accept only unique registered keys", async () => {
  const defaults = await loadConfig(await configFixture("https://cloud.example"));
  assert.deepEqual(defaults.reservationReaders, []);
  assert.ok(Object.isFrozen(defaults.reservationReaders));
  assert.deepEqual((await loadConfig(await configFixture("https://cloud.example", { reservationReaders: [] }))).reservationReaders, []);
  const enabled = await loadConfig(await configFixture("https://cloud.example", { reservationReaders: ["GetYourGuide/gyg-browser@1"] }));
  assert.deepEqual(enabled.reservationReaders, ["GetYourGuide/gyg-browser@1"]);
  assert.ok(Object.isFrozen(enabled.reservationReaders));
  for (const reservationReaders of [
    ["Viator/viator-browser@1"], ["GetYourGuide/gyg-browser@2"], ["GetYourGuide/gyg-browser@1", "GetYourGuide/gyg-browser@1"],
    "GetYourGuide/gyg-browser@1", { "GetYourGuide/gyg-browser@1": true }, [1], null, true,
  ]) {
    await assert.rejects(loadConfig(await configFixture("https://cloud.example", { reservationReaders })),
      (error) => error.code === "INVALID_CONFIG");
  }
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

test("reservation window client pins paths and validates bounded manifests and page receipts", async () => {
  const job = { id: "00000000-0000-4000-8000-000000000001", leaseToken: "lease" };
  const cycle = {
    readId: "00000000-0000-4000-8000-000000000002", generation: 3, scope: "WINDOW", repeated: false,
    coverageFromUtc: "2098-12-28T15:00:00.000Z", coverageToUtc: "2099-02-28T15:00:00.000Z",
    readStartedAtUtc: "2099-01-01T00:00:00.000Z", pageNumber: 0,
    receiptId: "00000000-0000-4000-8000-000000000003",
    manifest: [{ occurrenceId: "rule@2099-01-01", sourceStartAtUtc: "2099-01-01T01:00:00.000Z", sourceEndAtUtc: "2099-01-01T02:00:00.000Z" }],
  };
  const page = {
    receiptId: cycle.receiptId, readId: cycle.readId, generation: 3, pageNumber: 0,
    applied: 1, duplicates: 0, duplicateFacts: 0, stale: 0, needsReview: 0,
    missingActiveReservations: 0, healthUpdated: false, repeated: false,
    nextReceiptId: "00000000-0000-4000-8000-000000000004",
  };
  const paths = [];
  const responses = [cycle, page];
  const client = createCloudClient({ origin: "https://cloud.example", token: "x".repeat(40), fetchImpl: async (url) => {
    paths.push(new URL(url).pathname);
    return new Response(JSON.stringify(responses.shift()), { status: 200, headers: { "content-type": "application/json" } });
  } });
  assert.deepEqual(await client.beginReservationWindow(job), cycle);
  assert.deepEqual(await client.submitReservationWindowPage(job.id, {}), page);
  assert.deepEqual(paths, [
    "/internal/ota/v1/jobs/00000000-0000-4000-8000-000000000001/reservation-window-read",
    "/internal/ota/v1/jobs/00000000-0000-4000-8000-000000000001/reservation-window-pages",
  ]);

  const invalid = createCloudClient({ origin: "https://cloud.example", token: "x".repeat(40), fetchImpl: async () => new Response(JSON.stringify({
    ...cycle, manifest: [...cycle.manifest, cycle.manifest[0]],
  }), { status: 200, headers: { "content-type": "application/json" } }) });
  await assert.rejects(invalid.beginReservationWindow(job), (error) => error.code === "INVALID_RESPONSE");

  const tooWide = createCloudClient({ origin: "https://cloud.example", token: "x".repeat(40), fetchImpl: async () => new Response(JSON.stringify({
    ...cycle, coverageToUtc: "2099-03-01T15:00:00.000Z",
  }), { status: 200, headers: { "content-type": "application/json" } }) });
  await assert.rejects(tooWide.beginReservationWindow(job), (error) => error.code === "INVALID_RESPONSE");

  const oversized = createCloudClient({ origin: "https://cloud.example", token: "x".repeat(40), fetchImpl: async () => new Response("x", {
    status: 200, headers: { "content-type": "application/json", "content-length": String(256 * 1024 + 1) },
  }) });
  await assert.rejects(oversized.beginReservationWindow(job), (error) => error.code === "RESPONSE_TOO_LARGE");
});

test("resource Google trigger returns no calendar identifiers and tolerates an older disabled endpoint", async () => {
  let path;
  const client = createCloudClient({ origin: "https://cloud.example", token: "x".repeat(40), fetchImpl: async (url) => {
    path = new URL(url).pathname;
    return new Response(JSON.stringify({ processed: true, applied: false }), { status: 200, headers: { "content-type": "application/json" } });
  } });
  assert.deepEqual(await client.triggerResourceGoogleSync(), { processed: true, applied: false });
  assert.equal(path, "/internal/ota/v1/google-sync");
  const disabled = createCloudClient({ origin: "https://cloud.example", token: "x".repeat(40), fetchImpl: async () => new Response(null, { status: 404 }) });
  assert.deepEqual(await disabled.triggerResourceGoogleSync(), { processed: false, applied: false });
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
