import test from "node:test";
import assert from "node:assert/strict";
import { executeReservationWindow } from "../src/reservation-executor.mjs";

const now = Date.now();
const target = {
  site: "GetYourGuide", externalAccountId: "10001", externalProductId: "20002", externalOptionId: "30003",
  timeZone: "Asia/Tokyo", adapter: "gyg-browser", adapterVersion: "1", connectionMode: "BROWSER",
};
const job = {
  id: "00000000-0000-4000-8000-000000000001", leaseToken: "lease", purpose: "RESERVATION_WINDOW", action: "OBSERVE",
  leaseExpiresAtUtc: new Date(now + 120_000).toISOString(), deadlineAtUtc: new Date(now + 180_000).toISOString(), target,
};
const cycle = {
  readId: "00000000-0000-4000-8000-000000000002", receiptId: "00000000-0000-4000-8000-000000000003",
  manifest: [{ occurrenceId: "rule@2099-01-01", sourceStartAtUtc: "2099-01-01T01:00:00.000Z", sourceEndAtUtc: "2099-01-01T02:00:00.000Z" }],
  coverageFromUtc: "2098-12-28T15:00:00.000Z", coverageToUtc: "2099-02-28T15:00:00.000Z",
};
const makeFact = (index) => ({
  externalReservationId: `reservation-${index}`, externalProductId: "20002", externalOptionId: "30003",
  sourceStartAtUtc: "2099-01-01T01:00:00.000Z", sourceEndAtUtc: "2099-01-01T02:00:00.000Z",
  status: "CONFIRMED", seats: 1, sourceRevision: `revision-${index}-${"x".repeat(220)}`,
});
const journal = () => ({
  pending: [], acknowledged: [],
  async pendingReservationPage(page) { this.pending.push(JSON.stringify(page)); },
  async reservationPageAcknowledged(receiptId) { this.acknowledged.push(receiptId); },
});

test("reservation executor splits bounded immutable pages and retries one lost ACK byte-identically", async () => {
  const privateJournal = journal();
  const deliveries = [];
  let lost = true;
  const cloud = {
    async beginReservationWindow() { return cycle; },
    async renew() { return { leaseExpiresAtUtc: job.leaseExpiresAtUtc }; },
    async submitReservationWindowPage(_jobId, payload) {
      deliveries.push(JSON.stringify(payload));
      if (lost) { lost = false; throw Object.assign(new Error("lost"), { code: "NETWORK_ERROR" }); }
      const terminalStatus = payload.terminal?.status;
      return { receiptId: payload.receiptId, readId: payload.readId, pageNumber: payload.pageNumber,
        ...(terminalStatus ? { terminalStatus } : { nextReceiptId: "00000000-0000-4000-8000-000000000004" }) };
    },
  };
  let reads = 0;
  let stops = 0;
  const result = await executeReservationWindow({ job, cloud, config: {}, journal: privateJournal,
    readerFactory: async ({ target: fixedTarget }) => {
      assert.deepEqual(fixedTarget, target);
      return {
        async readPage(input) {
          reads += 1;
          assert.deepEqual(input.manifest, cycle.manifest);
          return { facts: Array.from({ length: 40 }, (_, index) => makeFact(index)),
            terminal: { status: "COMPLETE", allPagesRead: true, allStatusesIncluded: true, coverageComplete: true } };
        },
        async stop() { stops += 1; return true; },
      };
    }, now: () => now,
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
  assert.equal(privateJournal.pending[0], deliveries[0]);
});

test("reader privacy drift cannot be journaled or turned into an empty success", async () => {
  const privateJournal = journal();
  let submitted = 0;
  const result = await executeReservationWindow({ job, config: {}, journal: privateJournal, now: () => now,
    cloud: {
      async beginReservationWindow() { return cycle; }, async renew() { return { leaseExpiresAtUtc: job.leaseExpiresAtUtc }; },
      async submitReservationWindowPage() { submitted += 1; },
    },
    readerFactory: async () => ({
      async readPage() { return { facts: [{ ...makeFact(1), guestEmail: "synthetic@example.invalid" }],
        terminal: { status: "COMPLETE", allPagesRead: true, allStatusesIncluded: true, coverageComplete: true } }; },
      async stop() { return true; },
    }),
  });
  assert.equal(result.outcome, "NEEDS_REVIEW");
  assert.equal(result.halt, true);
  assert.equal(submitted, 0);
  assert.equal(privateJournal.pending.length, 0);
});

test("partial reader completion is delivered but never reported as verified freshness", async () => {
  const privateJournal = journal();
  const result = await executeReservationWindow({ job, config: {}, journal: privateJournal, now: () => now,
    cloud: {
      async beginReservationWindow() { return cycle; }, async renew() { return { leaseExpiresAtUtc: job.leaseExpiresAtUtc }; },
      async submitReservationWindowPage(_id, payload) { return { receiptId: payload.receiptId, readId: payload.readId,
        pageNumber: payload.pageNumber, terminalStatus: payload.terminal.status }; },
    },
    readerFactory: async () => ({
      async readPage() { return { facts: [makeFact(1)],
        terminal: { status: "PARTIAL", allPagesRead: false, allStatusesIncluded: true, coverageComplete: false } }; },
      async stop() { return true; },
    }),
  });
  assert.equal(result.outcome, "RETRY_WAIT");
  assert.equal(result.reservationReadId, undefined);
  assert.equal(result.reservationReceiptId, undefined);
});
