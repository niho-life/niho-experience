import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AIRBNB_CALENDAR_OPERATION, AIRBNB_PROFILE_OPERATION, AIRBNB_READ_HASHES, opaqueAirbnbId,
  parseAirbnbApiUrl, selectAirbnbCalendarObservation, validateAirbnbSelfProfile } from "../src/airbnb-protocol.mjs";
import { createAirbnbNetworkGuard } from "../src/airbnb-network-guard.mjs";
import { createAirbnbCalendarObserver } from "../src/airbnb-observer.mjs";
import { loadConfig, selectAccountProfile, selectAccountSessionPolicy } from "../src/config.mjs";

const accountId = "900719925474099312345678901234567890";
const productId = "900719925474099398765432109876543210";
const makeJob = () => ({
  id: randomUUID(), leaseToken: "lease", leaseExpiresAtUtc: new Date(Date.now() + 120_000).toISOString(),
  deadlineAtUtc: new Date(Date.now() + 180_000).toISOString(), action: "OBSERVE", occurrenceId: "occurrence-1",
  desiredVersion: 3, mappingVersion: 5, sourceStartAtUtc: "2099-01-01T04:00:00.000Z",
  sourceEndAtUtc: "2099-01-01T05:00:00.000Z", localDateTime: "2099-01-01T13:00:00",
  target: { site: "Airbnb", externalAccountId: accountId, externalProductId: productId, externalOptionId: "",
    timeZone: "Asia/Tokyo", adapter: "airbnb-google-busy", adapterVersion: "1", connectionMode: "GOOGLE" },
});
const calendarVariables = () => ({ startsAt: "2098-12-20T00:00:00.000Z", endsAt: "2099-01-31T00:00:00.000Z",
  listingIds: [], filters: [], filterByCoHostIds: [] });
const apiUrl = (operation, variables, origin = "https://www.airbnb.jp") => {
  const hash = AIRBNB_READ_HASHES[operation];
  const query = new URLSearchParams({ operationName: operation, locale: "ja", currency: "JPY", variables: JSON.stringify(variables),
    extensions: JSON.stringify({ persistedQuery: { version: 1, sha256Hash: hash } }) });
  return `${origin}/api/v3/${operation}/${hash}?${query}`;
};
const calendarRow = (overrides = {}) => ({
  __typename: "ExperienceCalendarItem", id: "selected-id", calendarEventId: "event-id",
  listingId: opaqueAirbnbId("ActivityListing", productId), itemType: "calendarInstance", productType: "EXPERIENCE",
  startsAt: "2099-01-01T04:00:00.000Z", endsAt: "2099-01-01T05:00:00.000Z", isAvailable: true,
  isVisible: true, remainingCapacity: 8, shareLink: `https://www.airbnb.com/book/experiences/${productId}?availabilityKey=opaque`, ...overrides,
});
const calendarResponse = (rows = [calendarRow()]) => ({ data: { presentation: { activityHostCalendarContainer: { iCalendarItemsConnection: rows } } } });

function observerJob(overrides = {}) {
  const value = { ...structuredClone(makeJob()), ...overrides };
  delete value.localDateTime;
  return value;
}

function controlledBrowser({ routeWebSocket = true, stopResult = true, stopped = () => {} } = {}) {
  const page = {
    setDefaultTimeout() {}, on() {},
    async goto() { throw new Error("synthetic navigation failure"); },
    url() { return "https://www.airbnb.jp/users/profile/about?context=host"; },
    getByText() { return { async count() { return 0; } }; },
  };
  const context = {
    async route() {}, pages: () => [page], async newCDPSession() { return { async send() {} }; },
    async addInitScript() {}, on() {},
    ...(routeWebSocket ? { async routeWebSocket() {} } : {}),
  };
  return { context, async stop() { stopped(); return stopResult; } };
}

const observerConfig = { browserExecutable: "/unused", siteAccountProfiles: { Airbnb: { [accountId]: "/private/profile" } } };

test("Airbnb standalone factory rejects reservation purpose and requires an explicitly empty option", async () => {
  const base = structuredClone(makeJob()); delete base.localDateTime;
  for (const job of [{ ...base, purpose: "RESERVATION_WINDOW" }, { ...base, target: { ...base.target, externalOptionId: undefined } }]) {
    await assert.rejects(createAirbnbCalendarObserver({ job, cloud: {}, config: {} }), (error) => error.code === "UNSUPPORTED_TARGET");
  }
});

test("Airbnb read-only observer accepts SET actions and pins preflight to their desired state", async () => {
  for (const [action, desiredState] of [["SET_OPEN", "OPEN"], ["SET_CLOSED", "CLOSED"]]) {
    let preflights = 0;
    const observer = await createAirbnbCalendarObserver({ job: observerJob({ action }),
      cloud: { async preflight() { preflights += 1; return { ready: true, desiredState }; } }, config: observerConfig,
      browserFactory: async () => controlledBrowser() });
    await assert.rejects(observer.observeTarget(), (error) => error.code === "DOM_DRIFT");
    assert.equal(preflights, 1);
  }
  for (const desiredState of ["OPEN", "CLOSED"]) {
    const observer = await createAirbnbCalendarObserver({ job: observerJob(),
      cloud: { async preflight() { return { ready: true, desiredState }; } }, config: observerConfig,
      browserFactory: async () => controlledBrowser() });
    await assert.rejects(observer.observeTarget(), (error) => error.code === "DOM_DRIFT");
  }
  const observer = await createAirbnbCalendarObserver({ job: observerJob({ action: "SET_CLOSED" }),
    cloud: { async preflight() { return { ready: true, desiredState: "OPEN" }; } }, config: observerConfig,
    browserFactory: async () => controlledBrowser() });
  await assert.rejects(observer.observeTarget(), (error) => error.code === "STALE_PREFLIGHT");
});

test("Airbnb standalone surface is frozen, has no write/model method, and preserves stop false", async () => {
  const job = structuredClone(makeJob()); delete job.localDateTime;
  const page = { setDefaultTimeout() {}, on() {} };
  const context = { async route() {}, pages: () => [page], async newCDPSession() { return { async send() {} }; },
    async addInitScript() {}, on() {}, async routeWebSocket() {} };
  let stops = 0;
  const observer = await createAirbnbCalendarObserver({ job, cloud: {}, config: { browserExecutable: "/unused",
    siteAccountProfiles: { Airbnb: { [accountId]: "/private/profile" } } }, browserFactory: async (options) => {
    assert.equal(options.sessionPolicy, "none");
    return { context, async stop() { stops += 1; return false; } };
  } });
  assert.ok(Object.isFrozen(observer)); assert.ok(Object.isFrozen(observer.guard));
  assert.equal(Object.hasOwn(observer, "applyDesiredState"), false); assert.equal(Object.hasOwn(observer, "model"), false);
  assert.equal(await observer.stop(), false); assert.equal(await observer.stop(), false); assert.equal(stops, 1); assert.equal(observer.guard.frozen, true);
});

test("Airbnb requires pre-connect websocket interception and stops before any read when unsupported", async () => {
  let stops = 0;
  await assert.rejects(createAirbnbCalendarObserver({ job: observerJob(), cloud: {}, config: observerConfig,
    browserFactory: async () => controlledBrowser({ routeWebSocket: false, stopped: () => { stops += 1; } }) }),
  (error) => error.code === "UNSAFE_REQUEST");
  assert.equal(stops, 1);
});

test("Airbnb observe cycle expires a hanging preflight, requests one stop, and never emits a late fact", { timeout: 2_000 }, async () => {
  const current = Date.now();
  let releasePreflight;
  let stops = 0;
  const observer = await createAirbnbCalendarObserver({
    job: observerJob({ leaseExpiresAtUtc: new Date(current + 150).toISOString(), deadlineAtUtc: new Date(current + 500).toISOString() }),
    cloud: { preflight() { return new Promise((resolve) => { releasePreflight = resolve; }); } }, config: observerConfig,
    browserFactory: async () => controlledBrowser({ stopped: () => { stops += 1; } }),
  });
  let emitted = false;
  const observation = observer.observeTarget();
  void observation.then(() => { emitted = true; }, () => {});
  await assert.rejects(observation, (error) => error.code === "INVALID_JOB_DEADLINE");
  assert.equal(stops, 1);
  releasePreflight({ ready: true, desiredState: "OPEN" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(emitted, false);
  assert.equal(stops, 1);
});

test("Airbnb protocol preserves large decimal identities and requires canonical primary GET variables", () => {
  const job = makeJob();
  const userId = opaqueAirbnbId("User", accountId);
  assert.equal(Buffer.from(userId, "base64").toString(), `User:${accountId}`);
  const profile = parseAirbnbApiUrl(new URL(apiUrl(AIRBNB_PROFILE_OPERATION,
    { userId, mockIdentifier: null, userProfileType: "HOST", isEditMode: true })), job);
  assert.equal(profile.variables.userId, userId);
  assert.deepEqual(parseAirbnbApiUrl(new URL(apiUrl(AIRBNB_CALENDAR_OPERATION, calendarVariables())), job).variables, calendarVariables());
  for (const mutate of [
    (url) => url.searchParams.append("locale", "ja"),
    (url) => url.searchParams.set("price", "1"),
    (url) => url.searchParams.set("locale", "en"),
    (url) => url.searchParams.set("extensions", JSON.stringify({ persistedQuery: { version: 1, sha256Hash: "a".repeat(64) } })),
  ]) {
    const url = new URL(apiUrl(AIRBNB_CALENDAR_OPERATION, calendarVariables())); mutate(url);
    assert.throws(() => parseAirbnbApiUrl(url, job), (error) => error.code === "UNSAFE_REQUEST");
  }
});

test("Airbnb auxiliary queries may omit variables, while primary queries cannot", () => {
  const job = makeJob();
  const auxiliary = new URL(apiUrl("IsHostQuery", {})); auxiliary.searchParams.delete("variables");
  assert.deepEqual(parseAirbnbApiUrl(auxiliary, job).variables, {});
  for (const operation of [AIRBNB_PROFILE_OPERATION, AIRBNB_CALENDAR_OPERATION]) {
    const primary = new URL(apiUrl(operation, {})); primary.searchParams.delete("variables");
    assert.throws(() => parseAirbnbApiUrl(primary, job), (error) => error.code === "UNSAFE_REQUEST");
  }
  auxiliary.searchParams.append("locale", "ja");
  assert.throws(() => parseAirbnbApiUrl(auxiliary, job), (error) => error.code === "UNSAFE_REQUEST");
});

test("Airbnb profile proof accepts only the requested User and viewer-owned ContextualUser", () => {
  const job = makeJob(); const id = opaqueAirbnbId("User", accountId);
  const value = { data: { node: { __typename: "User", id, owner: { __typename: "ContextualUser", id: "different-owner-id", isViewerProfileOwner: true } } } };
  assert.equal(validateAirbnbSelfProfile(value, job), true);
  for (const broken of [
    { data: { node: { ...value.data.node, id: opaqueAirbnbId("User", "1") } } },
    { data: { node: { ...value.data.node, owner: { ...value.data.node.owner, isViewerProfileOwner: false } } } },
    { data: { node: { __typename: "User", id } } },
    { data: { node: null } },
    { ...value, errors: [{ message: "partial" }] },
  ]) assert.throws(() => validateAirbnbSelfProfile(broken, job));
});

test("Airbnb calendar selects exactly one visible slot and distinguishes OPEN from explicit CLOSED", () => {
  const job = makeJob();
  assert.deepEqual(selectAirbnbCalendarObservation(calendarResponse(), job, calendarVariables()), { bookable: true });
  assert.deepEqual(selectAirbnbCalendarObservation(calendarResponse([calendarRow({ isAvailable: false, remainingCapacity: 8 })]), job, calendarVariables()), { bookable: false });
  assert.deepEqual(selectAirbnbCalendarObservation(calendarResponse([calendarRow({ remainingCapacity: 0 })]), job, calendarVariables()), { bookable: false });
  const unrelated = calendarRow({ id: "other", calendarEventId: "other-event", listingId: opaqueAirbnbId("ActivityListing", "7"),
    shareLink: "https://www.airbnb.jp/book/experiences/7", startsAt: "2099-01-02T04:00:00.000Z", endsAt: "2099-01-02T05:00:00.000Z" });
  const privateCalendar = { __typename: "PrivateCalendarItem", id: "private", itemType: "privateCalendar",
    startsAt: "not-public-data", numGuests: 99, privateTitle: "discard" };
  const malformedOther = { listingId: opaqueAirbnbId("ActivityListing", "8"), shareLink: "https://evil.example/private",
    startsAt: null, numGuests: 500, privateTitle: "discard" };
  assert.deepEqual(selectAirbnbCalendarObservation(
    calendarResponse([privateCalendar, unrelated, malformedOther, calendarRow()]), job, calendarVariables()), { bookable: true });
});

test("Airbnb calendar never turns missing, duplicate, partial, drift or malformed target data into CLOSED", () => {
  const job = makeJob();
  const brokenRows = [
    [], [calendarRow(), calendarRow({ id: "duplicate" })], [calendarRow({ listingId: opaqueAirbnbId("ActivityListing", "7") })],
    [calendarRow({ shareLink: `https://evil.example/book/experiences/${productId}` })],
    [calendarRow({ shareLink: "https://www.airbnb.com/book/experiences/7" })],
    [calendarRow({ listingId: opaqueAirbnbId("ActivityListing", "7"),
      shareLink: `https://www.airbnb.com/book/experiences/${productId}` })],
    [calendarRow({ shareLink: `https://www.airbnb.com/book/experiences/${productId}#fragment` })],
    [calendarRow({ startsAt: "2099-01-01T04:00:00Z" })], [calendarRow({ remainingCapacity: -1 })],
    [calendarRow({ remainingCapacity: 1.5 })], [calendarRow({ isVisible: false })], [calendarRow({ itemType: "manualBlock" })],
  ];
  for (const rows of brokenRows) assert.throws(() => selectAirbnbCalendarObservation(calendarResponse(rows), job, calendarVariables()));
  for (const value of [
    { data: { presentation: { activityHostCalendarContainer: {} } } },
    { ...calendarResponse(), errors: [{ message: "partial" }] },
    { data: null },
  ]) assert.throws(() => selectAirbnbCalendarObservation(value, job, calendarVariables()));
  for (const variables of [
    { ...calendarVariables(), startsAt: "2099-01-01T04:30:00.000Z" },
    { ...calendarVariables(), endsAt: "2099-03-01T00:00:00.000Z" },
    { ...calendarVariables(), filters: ["one"] },
    { ...calendarVariables(), listingIds: [opaqueAirbnbId("ActivityListing", productId)] },
    { ...calendarVariables(), startsAt: "2098-12-20T00:00:00Z" },
  ]) assert.throws(() => selectAirbnbCalendarObservation(calendarResponse(), job, variables));
});

function route(url, { method = "GET", navigation = false, type = "xhr", redirected = false,
  frameUrl = "http://127.0.0.1:4321/users/profile/about?context=host" } = {}, calls = []) {
  return {
    request: () => ({ url: () => url, method: () => method, isNavigationRequest: () => navigation, resourceType: () => type,
      redirectedFrom: () => redirected ? ({}) : null, frame: () => ({ url: () => frameUrl }) }),
    continue: async () => calls.push("continue"), fallback: async () => calls.push("continue"),
    abort: async () => calls.push("abort"),
  };
}

test("Airbnb guard admits only exact navigation, pinned GET reads and fixed-origin assets", async () => {
  const origin = "http://127.0.0.1:4321"; const job = makeJob(); const calls = [];
  const guard = createAirbnbNetworkGuard({ job, supplierOrigin: origin, assetOrigin: origin });
  await guard.handle(route(`${origin}/users/profile/about?context=host`, { navigation: true, type: "document" }, calls));
  await guard.handle(route(`${origin}/users/profile/about?context=host&editMode=true`, { navigation: true, type: "document" }, calls));
  await guard.handle(route(apiUrl(AIRBNB_PROFILE_OPERATION, { userId: opaqueAirbnbId("User", accountId), mockIdentifier: null,
    userProfileType: "HOST", isEditMode: true }, origin), {}, calls));
  await guard.handle(route(apiUrl(AIRBNB_PROFILE_OPERATION, { userId: opaqueAirbnbId("User", accountId), mockIdentifier: null,
    userProfileType: "HOST", isEditMode: true }, origin),
  { frameUrl: `${origin}/users/profile/about?context=host&editMode=true` }, calls));
  await guard.handle(route(`${origin}/users/profile/about?context=host&editMode=true&extra=1`, { navigation: true, type: "document" }, calls));
  const mutationLooking = new URL(apiUrl(AIRBNB_PROFILE_OPERATION, { userId: opaqueAirbnbId("User", accountId), mockIdentifier: null,
    userProfileType: "HOST", isEditMode: true }, origin));
  mutationLooking.pathname = `/api/v3/SaveProfileMutation/${AIRBNB_READ_HASHES.UserProfileQuery}`;
  mutationLooking.searchParams.set("operationName", "SaveProfileMutation");
  await guard.handle(route(mutationLooking.href, {}, calls));
  await guard.handle(route(`${origin}/api/v3/unknown`, {}, calls));
  await guard.handle(route(apiUrl(AIRBNB_PROFILE_OPERATION, { userId: opaqueAirbnbId("User", accountId), mockIdentifier: null,
    userProfileType: "HOST", isEditMode: true }, origin), { method: "POST", type: "fetch" }, calls));
  await guard.handle(route(`${origin}/users/profile/about?context=host`, { method: "POST", type: "fetch" }, calls));
  await guard.handle(route("https://extra.example/business", { type: "fetch" }, calls));
  assert.deepEqual(calls, ["continue", "continue", "continue", "continue", "abort", "abort", "abort", "abort", "abort", "abort"]);
  assert.equal(guard.profileReads, 2); assert.equal(guard.writes, 0); assert.equal(guard.writeAttempts, 2);
  assert.equal(guard.refused, 6); assert.equal(guard.fatalRead.code, "UNSAFE_REQUEST");
  assert.ok(Object.isFrozen(guard)); guard.freeze(); assert.equal(guard.frozen, true);
});

test("Airbnb guard blocks redirects, off-target navigation, hash drift and extra asset origins", async () => {
  const origin = "http://127.0.0.1:4321"; const calls = []; const guard = createAirbnbNetworkGuard({ job: makeJob(), supplierOrigin: origin, assetOrigin: origin });
  await guard.handle(route(`${origin}/users/profile/about?context=host`, { navigation: true, type: "document", redirected: true }, calls));
  await guard.handle(route(`${origin}/multicalendar/experiences-and-services/2099-01-02/week`, { navigation: true, type: "document" }, calls));
  const mismatch = new URL(apiUrl(AIRBNB_PROFILE_OPERATION, { userId: opaqueAirbnbId("User", accountId), mockIdentifier: null,
    userProfileType: "HOST", isEditMode: true }, origin));
  mismatch.pathname = mismatch.pathname.replace(AIRBNB_READ_HASHES.UserProfileQuery, "a".repeat(64));
  await guard.handle(route(mismatch.href, {}, calls));
  await guard.handle(route(`${origin.replace("://", "://attacker@")}/users/profile/about?context=host`,
    { navigation: true, type: "document" }, calls));
  await guard.handle(route(`${origin}/users/profile/about?context=host#edit`, { navigation: true, type: "document" }, calls));
  await guard.handle(route(`${origin}/users/profile/about?context=host&context=host`, { navigation: true, type: "document" }, calls));
  await guard.handle(route("https://a0.muscache.com/airbnb/static/app.js", { type: "script" }, calls));
  assert.deepEqual(calls, ["abort", "abort", "abort", "abort", "abort", "abort", "abort"]);
  assert.equal(guard.externalNavigationBlocked, true); assert.equal(guard.writes, 0);
  guard.noteWebSocket(); assert.equal(guard.webSockets, 1); assert.equal(guard.fatalRead.code, "UNSAFE_REQUEST");
});

test("Airbnb aborts unrelated observed profile requests without authorizing them or stopping the required read", async () => {
  const origin = "http://127.0.0.1:4321"; const calls = [];
  const guard = createAirbnbNetworkGuard({ job: makeJob(), supplierOrigin: origin });
  await guard.handle(route(`${origin}/api/v2/client_configs?locale=ja&currency=JPY`, { method: "POST", type: "fetch" }, calls));
  await guard.handle(route(`${origin}/api/v2/get_travel_guides_by_user?user_id=7`, { type: "fetch" }, calls));
  assert.deepEqual(calls, ["abort", "abort"]);
  guard.assertSafe(); assert.equal(guard.writes, 0); assert.equal(guard.allowed, 0);
  await guard.handle(route(`${origin}/api/v2/client_configs/save`, { method: "POST", type: "fetch" }, calls));
  assert.throws(() => guard.assertSafe(), (error) => error.code === "UNSAFE_REQUEST");
});

test("Airbnb config uses only private profiles/airbnb/<positive decimal> and never enables restore", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "niho-airbnb-config-"))); await chmod(directory, 0o700);
  const profiles = join(directory, "profiles"); const airbnb = join(profiles, "airbnb");
  await mkdir(profiles, { mode: 0o700 }); await mkdir(airbnb, { mode: 0o700 });
  const profile = join(airbnb, accountId); await mkdir(profile, { mode: 0o700 });
  const token = join(directory, "token"); await writeFile(token, "a".repeat(40), { mode: 0o600 });
  const path = join(directory, "config.json");
  const raw = { cloudOrigin: "https://cloud.example", tokenFile: token, privateDir: directory, accountProfiles: {},
    siteAccountProfiles: { Airbnb: { [accountId]: profile } }, browserExecutable: process.execPath, mode: "deterministic" };
  await writeFile(path, JSON.stringify(raw), { mode: 0o600 });
  const config = await loadConfig(path);
  assert.equal(selectAccountProfile(config, makeJob().target), profile);
  assert.equal(selectAccountSessionPolicy(config, makeJob().target), "none");
  assert.throws(() => selectAccountProfile({ accountProfiles: { [accountId]: "/gyg/fallback" }, siteAccountProfiles: {} }, makeJob().target),
    (error) => error.code === "PROFILE_MAPPING_MISSING");
  await writeFile(path, JSON.stringify({ ...raw, siteAccountSessionPolicies: { Airbnb: { [accountId]: "restore" } } }));
  await assert.rejects(loadConfig(path), (error) => error.code === "INVALID_CONFIG");
  for (const bad of ["0", "01", "../1"]) {
    await writeFile(path, JSON.stringify({ ...raw, siteAccountProfiles: { Airbnb: { [bad]: join(airbnb, bad) } } }));
    await assert.rejects(loadConfig(path));
  }
});
