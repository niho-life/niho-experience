import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createGygReservationReader } from "../src/gyg-reservation-reader.mjs";
import { CHROME, syntheticGyg } from "./helpers/synthetic-gyg.mjs";

const requireBrowser = (t) => {
  if (process.env.CODEX_SANDBOX === "seatbelt") { t.skip("Codex seatbelt blocks Chrome process control; run on the reviewed Studio executor."); return false; }
  if (!existsSync(CHROME)) {
    assert.ok(!process.env.CI, "CI must install the selected Chromium executable before browser tests");
    t.skip("Selected Chrome executable is not installed on this runner."); return false;
  }
  return true;
};

const coverage = Object.freeze({ coverageFromUtc: "2098-12-28T15:00:00.000Z", coverageToUtc: "2099-02-28T15:00:00.000Z" });
const targetFor = (state) => Object.freeze({
  site: "GetYourGuide", externalAccountId: state.accountId, externalProductId: state.productId, externalOptionId: state.optionId,
  timeZone: "Asia/Tokyo", adapter: "gyg-browser", adapterVersion: "1", connectionMode: "BROWSER",
});
const booking = (id, { optionId = 30003, productId = 20002, status = "ACTIVE" } = {}) => ({
  id, status, guideStatus: "CONFIRMED", isPending: false, totalNumberOfParticipants: 2, tourStart: "2099-01-01T10:00:00+09:00",
  activityOption: { id: optionId, activity: { id: productId }, duration: { value: 1, unit: "HOURS" } },
});

async function openReader(fixture, target) {
  const reader = await createGygReservationReader({ target, config: fixture.config, testOnlySupplierOrigin: fixture.origin,
    allowLocalTestOrigin: true, headless: true, browserFactory: fixture.browserFactory });
  return reader;
}

const input = (target, cursor) => ({ manifest: [], target, ...coverage, ...(cursor ? { cursor } : {}), signal: new AbortController().signal });

test("synthetic GYG bookings read completes with the app session headers and never forwards app writes", { timeout: 60_000 }, async (t) => {
  if (!requireBrowser(t)) return;
  const fixture = await syntheticGyg(); t.after(() => fixture.close());
  fixture.state.bookings = [
    ...Array.from({ length: 54 }, (_, index) => booking(`synthetic-${index + 1}`)),
    booking("synthetic-cancelled", { status: "CANCELED" }),
    booking("synthetic-other", { optionId: 40004, productId: 50005 }),
  ];
  const target = targetFor(fixture.state);
  const reader = await openReader(fixture, target);
  const pages = [];
  let cursor;
  for (let index = 0; index < 5; index += 1) {
    const page = await reader.readPage(input(target, cursor));
    pages.push(page);
    if (page.terminal) break;
    cursor = page.nextCursor;
  }
  assert.equal(pages.length, 2);
  assert.equal(pages[0].nextCursor, "o50");
  assert.deepEqual(pages[1].terminal, { status: "COMPLETE", allPagesRead: true, allStatusesIncluded: true, coverageComplete: true });
  const facts = pages.flatMap((page) => page.facts);
  assert.equal(facts.length, 55);
  assert.equal(facts.at(-1).status, "CANCELLED");
  assert.equal(facts[0].sourceStartAtUtc, "2099-01-01T01:00:00.000Z");
  assert.equal(facts[0].sourceEndAtUtc, "2099-01-01T02:00:00.000Z");
  assert.deepEqual(fixture.state.reservationRequests.map((request) => [request.authorization, request.client, request.input.offset]), [
    ["Bearer synthetic-session-token", "supplier-portal", 0],
    ["Bearer synthetic-session-token", "supplier-portal", 50],
  ]);
  assert.equal(fixture.state.unexpectedWrites, 0);
  assert.ok(reader.stats.refusedWrites >= 1);
  assert.ok(reader.stats.appReads >= 1);
  assert.equal(reader.stats.externalNavigationBlocked, false);
  assert.equal(await reader.stop(), true);
  await assert.rejects(reader.readPage(input(target)), (error) => error.code === "READER_STOPPED");
  assert.equal(fixture.state.reservationRequests.length, 2);
});

test("supplier account mismatch halts before any reservation query", { timeout: 60_000 }, async (t) => {
  if (!requireBrowser(t)) return;
  const fixture = await syntheticGyg(); t.after(() => fixture.close());
  const target = targetFor(fixture.state);
  fixture.state.accountId = "99999";
  const reader = await openReader(fixture, target);
  await assert.rejects(reader.readPage(input(target)), (error) => error.code === "ACCOUNT_MISMATCH");
  assert.equal(fixture.state.reservationRequests.length, 0);
  assert.equal(await reader.stop(), true);
});

test("a GYG 401 on the reservation query is AUTH_REQUIRED", { timeout: 60_000 }, async (t) => {
  if (!requireBrowser(t)) return;
  const fixture = await syntheticGyg(); t.after(() => fixture.close());
  fixture.state.bookings = [booking("synthetic-1")];
  fixture.state.reservationStatus = 401;
  const target = targetFor(fixture.state);
  const reader = await openReader(fixture, target);
  await assert.rejects(reader.readPage(input(target)), (error) => error.code === "AUTH_REQUIRED");
  assert.equal(fixture.state.reservationRequests.length, 1);
  assert.equal(fixture.state.unexpectedWrites, 0);
  assert.equal(await reader.stop(), true);
});
