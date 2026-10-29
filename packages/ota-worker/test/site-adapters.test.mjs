import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, selectAccountProfile } from "../src/config.mjs";
import { DRIVER_REGISTRY_KEYS, adapterRegistryKey } from "../src/driver-registry.mjs";
import { createViatorNetworkGuard, selectViatorAvailability, validateViatorReadBody, validateViatorUpdate, viatorListStateCoversTarget, VIATOR_LIST_STATE_KEYS } from "../src/viator-network-guard.mjs";
import { createJalanNetworkGuard, parseJsonp, selectJalanSlot, validateJalanBootstrap, validateJalanComplete, validateJalanSummaryUrl } from "../src/jalan-network-guard.mjs";
import { validateTarget } from "../src/validation.mjs";
import { makeJob } from "./helpers/synthetic-gyg.mjs";

const listState = Object.freeze({ startDate: "2099-01-01", endDate: "2099-01-01", jumpToDate: "2099-01-01",
  filteredProducts: ["999999P1"], filteredTourGrades: ["TG1"], loadDirection: "INITIAL", hasMoreAfter: false,
  hasMoreBefore: false, perDayPagination: 10 });
const viatorJob = makeJob({ accountId: "999999", productId: "999999P1", optionId: "TG1", localDateTime: "2099-01-01T13:00:00" }, "SET_CLOSED", {
  target: Object.freeze({ site: "Viator", externalAccountId: "999999", externalProductId: "999999P1", externalOptionId: "TG1",
    timeZone: "Asia/Tokyo", adapter: "viator-browser", adapterVersion: "1", connectionMode: "BROWSER" }),
});
const viatorUpdate = () => ({ availabilityKeys: [{ productCode: "999999P1", tourGradeCode: "TG1", travelDate: "2099-01-01", startTime: "13:00:00" }],
  availability: "SOLD_OUT", prevAvailability: "AVAILABLE", isBulkUpdate: false, availabilityListState: structuredClone(listState) });
const jalanJob = makeJob({ accountId: "SyntheticAirId", productId: "l000000001", optionId: "1", localDateTime: "2099-01-01T13:00:00" }, "SET_CLOSED", {
  target: Object.freeze({ site: "Jalan", externalAccountId: "SyntheticAirId", externalProductId: "l000000001", externalOptionId: "1",
    timeZone: "Asia/Tokyo", adapter: "jalan-browser", adapterVersion: "1", connectionMode: "BROWSER" }),
});
const jalanSummary = (frontOpenFlg = true) => ({ dto: { dspBaseDate: "20990101", selectedLessonSchdlId: "l000000001",
  dispDays: [{ year: 2099, month: 1, day: 1 }], plans: [{ lessonSchdlId: "l000000001", version: 21, tmzs: [{ timeZoneSeqNo: 1,
    startHm: "13:00", endHm: "14:00", slots: [{ slotId: "T_SYNTHETIC", receptionStatus: frontOpenFlg ? "KeyOPEN" : "KeyCLOSE",
      frontOpenFlg, bookingAvailableKbn: "KeyUNCONFIRMED", cfmBookingLimMgrKbn: null, cfmCapaBookingCnt: 0, cfmCapaPaxCnt: 0,
      cfmEntryBookingCnt: 0, cfmEntryPaxCnt: 0, uncfmEntryBookingCnt: 0, uncfmEntryPaxCnt: 0, version: 1 }] }] }] } });

function route(url, method, body, calls) {
  return { request: () => ({ url: () => url, method: () => method, postData: () => body === undefined ? null : JSON.stringify(body),
    postDataJSON: () => body, isNavigationRequest: () => false, resourceType: () => "fetch", headers: () => ({ "content-type": "application/json" }) }),
    fetch: async (options) => { assert.equal(options.maxRetries, 0); assert.equal(options.maxRedirects, 0); return { async dispose() {} }; },
    fulfill: async () => { calls.push("continue"); },
    continue: async () => { calls.push("continue"); }, abort: async () => { calls.push("abort"); } };
}

test("registry accepts exactly the three reviewed site/adapter versions and site ID grammars", () => {
  assert.deepEqual(DRIVER_REGISTRY_KEYS, ["GetYourGuide/gyg-browser@1", "Viator/viator-browser@1", "Jalan/jalan-browser@1"]);
  assert.equal(adapterRegistryKey(validateTarget(viatorJob.target)), "Viator/viator-browser@1");
  assert.equal(adapterRegistryKey(validateTarget(jalanJob.target)), "Jalan/jalan-browser@1");
  for (const target of [
    { ...viatorJob.target, externalProductId: "999999" }, { ...viatorJob.target, externalOptionId: "1" },
    { ...jalanJob.target, externalAccountId: "../escape" }, { ...jalanJob.target, externalProductId: "P1" },
    { ...jalanJob.target, externalOptionId: "TG1" }, { ...jalanJob.target, adapterVersion: "2" },
  ]) assert.throws(() => validateTarget(target));
});

test("Viator extracts only one canonical row and exact update preserves the fresh list snapshot", () => {
  assert.equal(VIATOR_LIST_STATE_KEYS.length, 9);
  assert.deepEqual(selectViatorAvailability({ availabilities: { "2099-01-01": [
    { productCode: "999999P1", tourGradeCode: "TG1", startTime: "13:00:00", availability: "AVAILABLE" },
  ] }, identity: { secret: "discarded" } }, viatorJob), { availability: "AVAILABLE" });
  assert.equal(validateViatorUpdate(viatorUpdate(), viatorJob, { authorized: true, availability: "AVAILABLE", listState }), true);
  for (const mutate of [
    (body) => { body.availabilityKeys.push(structuredClone(body.availabilityKeys[0])); },
    (body) => { body.isBulkUpdate = true; }, (body) => { body.availability = "CANCELLED"; },
    (body) => { body.price = 100; }, (body) => { body.availabilityKeys[0].startTime = "14:00:00"; },
    (body) => { body.availabilityListState.hasMoreAfter = true; },
  ]) { const body = viatorUpdate(); mutate(body); assert.equal(validateViatorUpdate(body, viatorJob, { authorized: true, availability: "AVAILABLE", listState }), false); }
  assert.equal(validateViatorUpdate(viatorUpdate(), viatorJob, { availability: "AVAILABLE", listState }), false);
  assert.throws(() => selectViatorAvailability({ availabilities: { "2099-01-01": [
    { productCode: "999999P1", tourGradeCode: "TG1", startTime: "13:00:00", availability: "AVAILABLE" },
    { productCode: "999999P1", tourGradeCode: "TG1", startTime: "13:00:00", availability: "SOLD_OUT" },
  ] } }, viatorJob));
});

test("Viator bootstrap read is bounded but cannot authorize a target write", () => {
  const bootstrap = { ...structuredClone(listState), startDate: "2098-12-19", endDate: "2098-12-19", jumpToDate: "2098-12-19",
    filteredProducts: [], filteredTourGrades: [], loadDirection: null, perDayPagination: null };
  assert.equal(validateViatorReadBody(bootstrap), true);
  assert.equal(viatorListStateCoversTarget(bootstrap, viatorJob), false);
  assert.equal(validateViatorUpdate(viatorUpdate(), viatorJob, { authorized: true, availability: "AVAILABLE", listState: bootstrap }), false);
  assert.equal(validateViatorReadBody({ ...bootstrap, initialLoad: true }), false);
});

test("Viator guard allows the bounded read POST and one exact write with interception preflight", async () => {
  let preflights = 0; let contextChecks = 0;
  const guard = createViatorNetworkGuard({ job: viatorJob, supplierOrigin: "http://127.0.0.1:4321",
    getSnapshot: () => ({ authorized: true, availability: "AVAILABLE", listState }),
    assertWriteContext: async () => { contextChecks += 1; }, cloud: { async preflight() { preflights += 1; } } });
  const calls = [];
  await guard.handle(route("http://127.0.0.1:4321/availability/api", "POST", listState, calls));
  guard.beginUiAction();
  await guard.handle(route("http://127.0.0.1:4321/availability/update", "POST", viatorUpdate(), calls));
  await guard.handle(route("http://127.0.0.1:4321/availability/update", "POST", viatorUpdate(), calls));
  assert.deepEqual(calls, ["continue", "continue", "abort"]);
  assert.equal(contextChecks, 1); assert.equal(preflights, 1); assert.equal(guard.writes, 1);
  assert.equal(guard.endUiAction().writes, 1);
});

test("site guards refuse a second business write even under a new UI permit", async () => {
  const calls = [];
  const guard = createViatorNetworkGuard({ job: viatorJob, supplierOrigin: "http://127.0.0.1:4321",
    getSnapshot: () => ({ authorized: true, availability: "AVAILABLE", listState }), cloud: { async preflight() {} } });
  guard.beginUiAction();
  await guard.handle(route("http://127.0.0.1:4321/availability/update", "POST", viatorUpdate(), calls));
  assert.equal(guard.endUiAction().writes, 1);
  guard.beginUiAction();
  await guard.handle(route("http://127.0.0.1:4321/availability/update", "POST", viatorUpdate(), calls));
  assert.throws(() => guard.endUiAction(), (error) => error.code === "WRITE_REFUSED");
  assert.deepEqual(calls, ["continue", "abort"]);
  assert.equal(guard.writes, 1);
});

test("Jalan JSONP is parsed without evaluation and selects the exact date/plan/time slot", () => {
  const parsed = parseJsonp(`syntheticCallback(${JSON.stringify(jalanSummary())});`, "syntheticCallback");
  const selected = selectJalanSlot(parsed, jalanJob, "14:00");
  assert.deepEqual(selected, { slotId: "T_SYNTHETIC", version: 1, frontOpenFlg: true, receptionStatus: "KeyOPEN",
    bookingAvailableKbn: "KeyUNCONFIRMED", cfmBookingLimMgrKbn: null, cfmCapaCnt: 0, lessonSchdlId: "l000000001", lessonSchdlVersion: 21 });
  assert.throws(() => parseJsonp("otherCallback({});", "syntheticCallback"));
  assert.throws(() => parseJsonp("syntheticCallback(globalThis.pwned=true);", "syntheticCallback"));
  const duplicate = jalanSummary(); duplicate.dto.dispDays.push({ year: 2099, month: 1, day: 1 });
  duplicate.dto.plans[0].tmzs[0].slots.push(structuredClone(duplicate.dto.plans[0].tmzs[0].slots[0]));
  assert.throws(() => selectJalanSlot(duplicate, jalanJob, "14:00"));
});

test("Jalan bootstrap validates a non-target range without inventing a target slot", () => {
  const bootstrap = jalanSummary();
  bootstrap.dto.dspBaseDate = "20981219";
  bootstrap.dto.dispDays = [{ year: 2098, month: 12, day: 19 }];
  bootstrap.dto.plans[0].tmzs[0].slots[0].slotId = "T_BOOTSTRAP";
  assert.deepEqual(validateJalanBootstrap(bootstrap, jalanJob), { firstDate: "2098-12-19", lastDate: "2098-12-19" });
  assert.throws(() => selectJalanSlot(bootstrap, jalanJob, "14:00"));
});

test("Jalan summary query requires the observed exact keys, bounded values and no duplicates", () => {
  const base = "http://127.0.0.1/stateful/schdl/client/summary?callback=cb&dspBaseDate=20990101&dspRange=14&pageSize=14&pageNo=1&schdlKbn=&groupSchdlId=&lessonSchdlId=l000000001&includeSaleStops=true&_=1";
  assert.equal(validateJalanSummaryUrl(new URL(base), jalanJob), true);
  assert.equal(validateJalanSummaryUrl(new URL(`${base}&pageNo=2`), jalanJob), false);
  assert.equal(validateJalanSummaryUrl(new URL(`${base}&price=1`), jalanJob), false);
  assert.equal(validateJalanSummaryUrl(new URL(base.replace("dspRange=14", "dspRange=99")), jalanJob), false);
});

test("Jalan complete changes only frontOpenFlg and rejects capacity, mode, bulk, price and other slot", () => {
  const snapshot = selectJalanSlot(jalanSummary(), jalanJob, "14:00");
  const complete = () => ({ groups: [], slots: [{ slotId: "T_SYNTHETIC", version: 1, frontOpenFlg: "false",
    bookingAvailableKbn: "KeyUNCONFIRMED", cfmBookingLimMgrKbn: null, cfmCapaCnt: 0, lessonSchdlId: "l000000001", lessonSchdlVersion: 21 }] });
  assert.equal(validateJalanComplete(complete(), jalanJob, { ...snapshot, authorized: true }), true);
  for (const mutate of [(body) => { body.groups.push({}); }, (body) => { body.slots[0].slotId = "OTHER"; },
    (body) => { body.slots[0].cfmCapaCnt = 1; }, (body) => { body.slots[0].bookingAvailableKbn = "KeyCONFIRMED"; },
    (body) => { body.price = 100; }]) { const body = complete(); mutate(body); assert.equal(validateJalanComplete(body, jalanJob, { ...snapshot, authorized: true }), false); }
});

test("Jalan guard allows only summary GET and one exact complete POST", async () => {
  const snapshot = { ...selectJalanSlot(jalanSummary(), jalanJob, "14:00"), authorized: true };
  let preflights = 0; let contextChecks = 0; const calls = [];
  const guard = createJalanNetworkGuard({ job: jalanJob, supplierOrigin: "http://127.0.0.1:4322", getSnapshot: () => snapshot,
    assertWriteContext: async () => { contextChecks += 1; }, cloud: { async preflight() { preflights += 1; } } });
  await guard.handle(route("http://127.0.0.1:4322/stateful/schdl/client/summary?callback=syntheticCallback&dspBaseDate=20990101&dspRange=14&pageSize=14&pageNo=1&schdlKbn=&groupSchdlId=&lessonSchdlId=l000000001&includeSaleStops=true&_=1", "GET", undefined, calls));
  guard.beginUiAction();
  const complete = { groups: [], slots: [{ slotId: "T_SYNTHETIC", version: 1, frontOpenFlg: "false", bookingAvailableKbn: "KeyUNCONFIRMED",
    cfmBookingLimMgrKbn: null, cfmCapaCnt: 0, lessonSchdlId: "l000000001", lessonSchdlVersion: 21 }] };
  await guard.handle(route("http://127.0.0.1:4322/stateful/schdl/client/complete", "POST", complete, calls));
  assert.deepEqual(calls, ["continue", "continue"]); assert.equal(contextChecks, 1); assert.equal(preflights, 1);
  assert.equal(guard.endUiAction().writes, 1);
});

test("namespaced profiles are exact, private, site-separated and never fall back", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "niho-ota-sites-"))); await chmod(directory, 0o700);
  const profiles = join(directory, "profiles"); await mkdir(profiles, { mode: 0o700 });
  const viator = join(profiles, "viator"); const jalan = join(profiles, "jalan");
  await mkdir(viator, { mode: 0o700 }); await mkdir(jalan, { mode: 0o700 });
  const token = join(directory, "token"); await writeFile(token, "a".repeat(40), { mode: 0o600 });
  const path = join(directory, "config.json"); await writeFile(path, JSON.stringify({ cloudOrigin: "https://cloud.example", tokenFile: token,
    privateDir: directory, accountProfiles: { "999999": join(profiles, "999999") }, siteAccountProfiles: {
      Viator: { "999999": join(viator, "999999") }, Jalan: { SyntheticAirId: join(jalan, "SyntheticAirId") },
    }, browserExecutable: process.execPath, mode: "deterministic" }), { mode: 0o600 });
  const config = await loadConfig(path);
  assert.equal(selectAccountProfile(config, viatorJob.target), join(await realpath(viator), "999999"));
  assert.equal(selectAccountProfile(config, jalanJob.target), join(await realpath(jalan), "SyntheticAirId"));
  assert.throws(() => selectAccountProfile(config, { ...jalanJob.target, externalAccountId: "Missing" }), (error) => error.code === "PROFILE_MAPPING_MISSING");
  const alias = join(profiles, "viator-alias"); await symlink(viator, alias);
  await writeFile(path, JSON.stringify({ cloudOrigin: "https://cloud.example", tokenFile: token, privateDir: directory,
    accountProfiles: {}, siteAccountProfiles: { Viator: { "999999": join(alias, "999999") } }, browserExecutable: process.execPath,
    mode: "deterministic" }), { mode: 0o600 });
  await assert.rejects(loadConfig(path), (error) => error.code === "INSECURE_PRIVATE_PATH" || error.code === "INVALID_PROFILE_MAPPING");
});
