import test from "node:test";
import assert from "node:assert/strict";
import { executeReservationWindow, reservationExecutorInternals } from "../src/reservation-executor.mjs";
import { executeJob } from "../src/supervisor.mjs";

const fixedNow = Date.now();
const target = {
  site: "GetYourGuide", externalAccountId: "10001", externalProductId: "20002", externalOptionId: "30003",
  timeZone: "Asia/Tokyo", adapter: "gyg-browser", adapterVersion: "1", connectionMode: "BROWSER",
};
const job = {
  id: "00000000-0000-4000-8000-000000000001", leaseToken: "lease", purpose: "RESERVATION_WINDOW", action: "OBSERVE",
  leaseExpiresAtUtc: new Date(fixedNow + 120_000).toISOString(), deadlineAtUtc: new Date(fixedNow + 180_000).toISOString(), target,
};
const cycle = {
  readId: "00000000-0000-4000-8000-000000000002", receiptId: "00000000-0000-4000-8000-000000000003",
  generation: 3,
  manifest: [{ occurrenceId: "rule@2099-01-01", sourceStartAtUtc: "2099-01-01T01:00:00.000Z", sourceEndAtUtc: "2099-01-01T02:00:00.000Z" }],
  coverageFromUtc: "2098-12-28T15:00:00.000Z", coverageToUtc: "2099-02-28T15:00:00.000Z",
};
const uuidFor = (number) => `00000000-0000-4000-8000-${number.toString(16).padStart(12, "0")}`;
const makeFact = (index, overrides = {}) => ({
  externalReservationId: `reservation-${index}`, externalProductId: "20002", externalOptionId: "30003",
  sourceStartAtUtc: "2099-01-01T01:00:00.000Z", sourceEndAtUtc: "2099-01-01T02:00:00.000Z",
  status: "CONFIRMED", seats: 1, sourceRevision: `revision-${index}-${"x".repeat(220)}`, ...overrides,
});
const terminal = (status = "COMPLETE") => ({
  status,
  allPagesRead: status === "COMPLETE",
  allStatusesIncluded: status !== "FAILED",
  coverageComplete: status === "COMPLETE",
});
const journal = (record = true) => ({
  pending: [], acknowledged: [],
  async pendingReservationPage(page) { if (record) this.pending.push(JSON.stringify(page)); },
  async reservationPageAcknowledged(receiptId) { if (record) this.acknowledged.push(receiptId); },
});
const pageReceipt = (payload, overrides = {}) => {
  const terminalStatus = payload.terminal?.status;
  return {
    receiptId: payload.receiptId, readId: payload.readId, generation: cycle.generation, pageNumber: payload.pageNumber,
    applied: payload.observations.length, duplicates: 0, duplicateFacts: 0, stale: 0, needsReview: 0,
    missingActiveReservations: 0, healthUpdated: terminalStatus === "COMPLETE", repeated: false,
    ...(terminalStatus ? { terminalStatus } : { nextReceiptId: uuidFor(payload.pageNumber + 100) }),
    ...overrides,
  };
};
const cloudFor = (submit = async (_jobId, payload) => pageReceipt(payload)) => ({
  async beginReservationWindow() { return cycle; },
  async renew() { return { leaseExpiresAtUtc: job.leaseExpiresAtUtc }; },
  submitReservationWindowPage: submit,
});
const readerFor = (readPage, stop = async () => true) => async () => ({ readPage, stop });

test("unsupported registry stops without starting a process or issuing a read generation", async () => {
  const result = await executeReservationWindow({ job, config: {}, journal: journal(false), now: () => fixedNow,
    cloud: { async beginReservationWindow() { throw new Error("must not issue a generation"); } },
  });
  assert.equal(result.outcome, "NEEDS_REVIEW");
  assert.equal(result.reason, "UNSUPPORTED_READER");
  assert.equal(result.stopped, true);
});

test("a cloud failure before reader setup has a truthful no-process stop proof", async () => {
  const result = await executeReservationWindow({ job, config: {}, journal: journal(false), now: () => fixedNow,
    cloud: { async beginReservationWindow() { throw Object.assign(new Error("synthetic timeout"), { code: "TIMEOUT" }); } },
    readerFactory: async () => { throw new Error("must not start a reader"); },
  });
  assert.equal(result.outcome, "RETRY_WAIT");
  assert.equal(result.stopped, true);
  assert.equal(result.reason, "TIMEOUT");
});

test("a slow confirmed stop keeps time for the result receipt instead of claiming success late", async () => {
  let now = fixedNow;
  const result = await executeReservationWindow({ job, cloud: cloudFor(), config: {}, journal: journal(false), now: () => now,
    readerFactory: readerFor(async () => ({ facts: [makeFact(1)], terminal: terminal() }), async () => {
      now = Date.parse(job.leaseExpiresAtUtc) - 10_000;
      return true;
    }),
  });
  assert.equal(result.stopped, true);
  assert.equal(result.outcome, "RETRY_WAIT");
  assert.equal(result.reason, "RESULT_WINDOW_TOO_SHORT");
  assert.equal(result.reservationReadId, undefined);
  assert.equal(result.reservationReceiptId, undefined);
});

test("reservation executor splits bounded immutable pages and retries one lost ACK byte-identically", async () => {
  const privateJournal = journal();
  const deliveries = [];
  let lost = true;
  const cloud = cloudFor(async (_jobId, payload) => {
    deliveries.push(JSON.stringify(payload));
    if (lost) { lost = false; throw Object.assign(new Error("lost"), { code: "NETWORK_ERROR" }); }
    return pageReceipt(payload);
  });
  let reads = 0;
  let stops = 0;
  const result = await executeReservationWindow({ job, cloud, config: {}, journal: privateJournal,
    readerFactory: async ({ target: fixedTarget }) => {
      assert.deepEqual(fixedTarget, target);
      return {
        async readPage(input) {
          reads += 1;
          assert.deepEqual(input.manifest, cycle.manifest);
          return { facts: Array.from({ length: 40 }, (_, index) => makeFact(index)), terminal: terminal() };
        },
        async stop() { stops += 1; return true; },
      };
    }, now: () => fixedNow,
  });
  assert.equal(deliveries[0], deliveries[1]);
  const distinct = deliveries.filter((item, index) => index === 0 || item !== deliveries[index - 1]).map(JSON.parse);
  assert.ok(distinct.length >= 2);
  assert.ok(distinct.every((page) => page.observations.length <= 32 && Buffer.byteLength(JSON.stringify(page)) <= 16 * 1024));
  assert.equal(distinct[0].terminal, undefined);
  assert.equal(distinct.at(-1).terminal.status, "COMPLETE");
  assert.equal(distinct[1].sourceCursor, distinct[0].nextSourceCursor);
  assert.equal(reads, 1);
  assert.equal(stops, 1);
  assert.equal(result.outcome, "RESERVATION_VERIFIED");
  assert.equal(result.reservationReadId, cycle.readId);
  assert.equal(result.reservationReceiptId, distinct.at(-1).receiptId);
  assert.equal(result.modelInvocations, 0);
  assert.equal(privateJournal.pending[0], deliveries[0]);
});

test("reader privacy drift and non-canonical or wrong-target facts never reach the journal", async () => {
  for (const fact of [
    { ...makeFact(1), guestEmail: "synthetic@example.invalid" },
    makeFact(2, { sourceStartAtUtc: "2099-01-01T01:00:00Z" }),
    makeFact(3, { externalProductId: "different-product" }),
    makeFact(4, { externalOptionId: "different-option" }),
  ]) {
    const privateJournal = journal();
    let submitted = 0;
    const result = await executeReservationWindow({ job, config: {}, journal: privateJournal, now: () => fixedNow,
      cloud: cloudFor(async () => { submitted += 1; }),
      readerFactory: readerFor(async () => ({ facts: [fact], terminal: terminal() })),
    });
    assert.equal(result.outcome, "NEEDS_REVIEW");
    assert.equal(result.halt, true);
    assert.equal(submitted, 0);
    assert.equal(privateJournal.pending.length, 0);
  }
});

test("partial reader completion is delivered but never reported as verified freshness", async () => {
  const result = await executeReservationWindow({ job, cloud: cloudFor(), config: {}, journal: journal(), now: () => fixedNow,
    readerFactory: readerFor(async () => ({ facts: [makeFact(1)], terminal: terminal("PARTIAL") })),
  });
  assert.equal(result.outcome, "RETRY_WAIT");
  assert.equal(result.reservationReadId, undefined);
  assert.equal(result.reservationReceiptId, undefined);
});

test("a COMPLETE declaration requires current terminal server health", async () => {
  for (const override of [
    { healthUpdated: false }, { missingActiveReservations: 1 }, { needsReview: 1 }, { stale: 1 },
  ]) {
    const result = await executeReservationWindow({ job, config: {}, journal: journal(), now: () => fixedNow,
      cloud: cloudFor(async (_id, payload) => pageReceipt(payload, override)),
      readerFactory: readerFor(async () => ({ facts: [makeFact(1)], terminal: terminal() })),
    });
    assert.equal(result.outcome, "RETRY_WAIT");
    assert.equal(result.reservationReadId, undefined);
    assert.equal(result.reservationReceiptId, undefined);
  }
});

test("an altered page ACK is never accepted as the immutable receipt", async () => {
  const privateJournal = journal();
  const result = await executeReservationWindow({ job, config: {}, journal: privateJournal, now: () => fixedNow,
    cloud: cloudFor(async (_id, payload) => pageReceipt(payload, { generation: cycle.generation + 1 })),
    readerFactory: readerFor(async () => ({ facts: [makeFact(1)], terminal: terminal() })),
  });
  assert.equal(result.outcome, "NEEDS_REVIEW");
  assert.equal(result.reason, "INVALID_RESPONSE");
  assert.equal(privateJournal.pending.length, 1);
  assert.equal(privateJournal.acknowledged.length, 0);
});

test("external 512-character cursors become bounded opaque chain values and snapshot token stays exact", async () => {
  const pages = [];
  let read = 0;
  const longCursor = "c".repeat(512);
  const snapshotToken = "s".repeat(256);
  const result = await executeReservationWindow({ job, config: {}, journal: journal(), now: () => fixedNow,
    cloud: cloudFor(async (_id, payload) => { pages.push(payload); return pageReceipt(payload); }),
    readerFactory: readerFor(async ({ cursor }) => {
      read += 1;
      if (read === 1) return { facts: [], nextCursor: longCursor, snapshotToken };
      assert.equal(cursor, longCursor);
      return { facts: [makeFact(1)], snapshotToken, terminal: terminal() };
    }),
  });
  assert.equal(result.outcome, "RESERVATION_VERIFIED");
  assert.equal(pages.length, 2);
  assert.equal(pages[0].observations.length, 0);
  assert.equal(pages[0].snapshotToken, snapshotToken);
  assert.ok(pages[0].nextSourceCursor.length <= 512);
  assert.equal(pages[1].sourceCursor, pages[0].nextSourceCursor);
});

test("cursor cycles and snapshot changes stop without fabricating completion", async () => {
  for (const mode of ["cursor", "snapshot"]) {
    let read = 0;
    const result = await executeReservationWindow({ job, cloud: cloudFor(), config: {}, journal: journal(), now: () => fixedNow,
      readerFactory: readerFor(async () => {
        read += 1;
        if (read === 1) return { facts: [], nextCursor: "cursor-a", snapshotToken: "snapshot-a" };
        return mode === "cursor"
          ? { facts: [], nextCursor: "cursor-a", snapshotToken: "snapshot-a" }
          : { facts: [], nextCursor: "cursor-b", snapshotToken: "snapshot-b" };
      }),
    });
    assert.equal(result.outcome, "NEEDS_REVIEW");
    assert.equal(result.reservationReadId, undefined);
  }
});

test("reader page fact and byte bounds reject input before private persistence", async () => {
  for (const facts of [
    Array.from({ length: 513 }, (_, index) => makeFact(index)),
    Array.from({ length: 512 }, (_, index) => makeFact(index, {
      externalReservationId: `${index}`.padEnd(256, "r"), sourceRevision: `${index}`.padEnd(256, "v"),
    })),
  ]) {
    const privateJournal = journal();
    const result = await executeReservationWindow({ job, cloud: cloudFor(), config: {}, journal: privateJournal, now: () => fixedNow,
      readerFactory: readerFor(async () => ({ facts, terminal: terminal() })),
    });
    assert.equal(result.outcome, "NEEDS_REVIEW");
    assert.equal(privateJournal.pending.length, 0);
  }
});

test("page 4095 must be terminal and 4096 total pages are accepted", async () => {
  let reads = 0;
  let submitted = 0;
  const result = await executeReservationWindow({ job, config: {}, journal: journal(false), now: () => fixedNow,
    cloud: cloudFor(async (_id, payload) => { submitted += 1; return pageReceipt(payload); }),
    readerFactory: readerFor(async () => {
      reads += 1;
      return { facts: [], nextCursor: `cursor-${reads}` };
    }),
  });
  assert.equal(submitted, reservationExecutorInternals.limits.maxPages - 1);
  assert.equal(reads, reservationExecutorInternals.limits.maxPages);
  assert.equal(result.outcome, "NEEDS_REVIEW");
  assert.equal(result.reason, "PAGE_LIMIT");

  reads = 0;
  submitted = 0;
  const bounded = await executeReservationWindow({ job, config: {}, journal: journal(false), now: () => fixedNow,
    cloud: cloudFor(async (_id, payload) => { submitted += 1; return pageReceipt(payload); }),
    readerFactory: readerFor(async () => {
      reads += 1;
      return reads === reservationExecutorInternals.limits.maxPages
        ? { facts: [], terminal: terminal() }
        : { facts: [], nextCursor: `bounded-cursor-${reads}` };
    }),
  });
  assert.equal(submitted, reservationExecutorInternals.limits.maxPages);
  assert.equal(bounded.outcome, "RESERVATION_VERIFIED");
});

test("lease/deadline abort starts stop immediately even when readPage ignores its signal", async () => {
  const started = Date.now();
  const shortJob = {
    ...job,
    leaseExpiresAtUtc: new Date(started + 80).toISOString(),
    deadlineAtUtc: new Date(started + 40).toISOString(),
  };
  let stoppedAt;
  const result = await executeReservationWindow({ job: shortJob, config: {}, journal: journal(false),
    cloud: {
      async beginReservationWindow() { return cycle; },
      async renew() { return { leaseExpiresAtUtc: shortJob.deadlineAtUtc }; },
      async submitReservationWindowPage() { throw new Error("unreachable"); },
    },
    readerFactory: readerFor(async () => new Promise(() => {}), async () => { stoppedAt = Date.now(); return true; }),
    stopTimeoutMs: 20,
  });
  assert.equal(result.stopped, true);
  assert.equal(result.outcome, "RETRY_WAIT");
  assert.ok(stoppedAt - started < 150);
  assert.ok(Date.now() - started < 250);
});

test("an unbounded stop is downgraded after the bounded proof window", async () => {
  const started = Date.now();
  const result = await executeReservationWindow({ job, cloud: cloudFor(), config: {}, journal: journal(false), now: () => fixedNow,
    readerFactory: readerFor(async () => ({ facts: [makeFact(1)], terminal: terminal() }), async () => new Promise(() => {})),
    stopTimeoutMs: 20,
  });
  assert.equal(result.stopped, false);
  assert.equal(result.outcome, "NEEDS_REVIEW");
  assert.equal(result.reason, "PROCESS_STOP_UNCONFIRMED");
  assert.ok(Date.now() - started < 200);
});

test("invalid setup is controlled and cannot claim a stop proof", async () => {
  const result = await executeReservationWindow({ job, cloud: cloudFor(), config: {}, journal: journal(false), now: () => fixedNow,
    readerFactory: async () => ({ async readPage() { return { facts: [], terminal: terminal() }; } }),
    stopTimeoutMs: 10,
  });
  assert.equal(result.stopped, false);
  assert.equal(result.outcome, "NEEDS_REVIEW");
  assert.equal(result.reason, "PROCESS_STOP_UNCONFIRMED");
});

test("a callback returning after deadline cannot produce verified freshness", async () => {
  let clock = fixedNow;
  const result = await executeReservationWindow({ job, config: {}, journal: journal(false), now: () => clock,
    cloud: cloudFor(async (_id, payload) => { clock = Date.parse(job.deadlineAtUtc); return pageReceipt(payload); }),
    readerFactory: readerFor(async () => ({ facts: [makeFact(1)], terminal: terminal() })),
  });
  assert.equal(result.outcome, "RETRY_WAIT");
  assert.equal(result.reason, "DEADLINE_EXCEEDED");
  assert.equal(result.reservationReadId, undefined);
});

test("reader error reasons are allowlisted and auth/challenge remain explicit halts", async () => {
  for (const [code, outcome, reason] of [
    ["CUSTOM_SECRET_SHAPED_REASON", "RETRY_WAIT", "RESERVATION_READ_FAILED"],
    ["AUTH_REQUIRED", "AUTH_REQUIRED", "AUTH_REQUIRED"],
    ["CHALLENGE_REQUIRED", "AUTH_REQUIRED", "CHALLENGE_REQUIRED"],
  ]) {
    const result = await executeReservationWindow({ job, cloud: cloudFor(), config: {}, journal: journal(false), now: () => fixedNow,
      readerFactory: readerFor(async () => { throw Object.assign(new Error("private body"), { code }); }),
    });
    assert.equal(result.outcome, outcome);
    assert.equal(result.reason, reason);
    assert.equal(result.halt, outcome === "AUTH_REQUIRED");
  }
});

test("supervisor reservation dispatch invokes only the fixed reader path", async () => {
  let drivers = 0;
  let models = 0;
  let reads = 0;
  const result = await executeJob({
    job, cloud: cloudFor(), config: { mode: "claude-code" }, journal: journal(false), now: () => fixedNow,
    driverFactory: async () => { drivers += 1; throw new Error("availability driver must not run"); },
    claudeExecutor: async () => { models += 1; throw new Error("model must not run"); },
    reservationReaderFactory: readerFor(async () => { reads += 1; return { facts: [makeFact(1)], terminal: terminal() }; }),
  });
  assert.equal(result.outcome, "RESERVATION_VERIFIED");
  assert.equal(result.modelInvocations, 0);
  assert.equal(reads, 1);
  assert.equal(drivers, 0);
  assert.equal(models, 0);
});

test("RESERVATION_WINDOW remains on the reader path even for the Google target shape", async () => {
  let deliveries = 0;
  let reads = 0;
  const googleReservationJob = { ...job, target: { site: "Airbnb", externalAccountId: "12345", externalProductId: "67890",
    timeZone: "Asia/Tokyo", adapter: "airbnb-google-busy", adapterVersion: "1", connectionMode: "GOOGLE" } };
  const result = await executeJob({
    job: googleReservationJob,
    cloud: { ...cloudFor(), async googleDelivery() { deliveries += 1; } },
    config: { mode: "claude-code", googleDeliveryEnabled: true }, journal: journal(false), now: () => fixedNow,
    reservationReaderFactory: readerFor(async () => { reads += 1; return { facts: [makeFact(1)], terminal: terminal() }; }),
    driverFactory: async () => { throw new Error("browser must not run"); },
    claudeExecutor: async () => { throw new Error("model must not run"); },
  });
  // The existing reader does not support this target, but the job must remain
  // on that fail-closed path instead of being misrouted to Google delivery.
  assert.equal(result.outcome, "NEEDS_REVIEW");
  assert.equal(result.modelInvocations, 0);
  assert.equal(reads, 1);
  assert.equal(deliveries, 0);
});
