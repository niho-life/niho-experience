import test from "node:test";
import assert from "node:assert/strict";
import { EXPECTED_MUTATION } from "../src/constants.mjs";
import { createNetworkGuard, isNamedReadOnlyQuery, validateUpdateMutation } from "../src/network-guard.mjs";
import { makeJob } from "./helpers/synthetic-gyg.mjs";
import { validateTarget } from "../src/validation.mjs";

const state = { accountId: "10001", productId: "20002", optionId: "30003", localDateTime: "2099-01-01T13:00:00" };
const job = makeJob(state, "SET_CLOSED");
const validBody = () => ({ operationName: "UpdateMultipleTimeSlots", query: EXPECTED_MUTATION,
  variables: { input: { isBlocked: true, type: "IS_BLOCKED", timeSlots: [{ dateTime: "2099-01-01T13:00", tourOptionId: "30003" }] } } });
const graphqlRoute = (body, calls = []) => ({
  request: () => ({ url: () => "http://127.0.0.1:1234/graphql", method: () => "POST", postDataJSON: () => body }),
  continue: async () => { calls.push("continue"); },
  abort: async () => { calls.push("abort"); },
});

test("fragment-first named query is allowed but mutation/subscription/anonymous query are refused", () => {
  assert.equal(isNamedReadOnlyQuery("fragment Fields on Query { viewer { id } } query Availability { ...Fields }", "Availability"), true);
  assert.equal(isNamedReadOnlyQuery("fragment Fields on Query { viewer { id } } mutation Availability { update { ok } }", "Availability"), false);
  assert.equal(isNamedReadOnlyQuery("subscription Availability { changed { id } }", "Availability"), false);
  assert.equal(isNamedReadOnlyQuery("{ viewer { id } }", "Availability"), false);
  assert.equal(isNamedReadOnlyQuery("query Other { viewer { id } }", "Availability"), false);
});

test("only the exact GYG browser v1 numeric target is accepted", () => {
  assert.equal(validateTarget(job.target).adapter, "gyg-browser");
  for (const patch of [{ site: "Other" }, { adapter: "gyg-browser-v2" }, { connectionMode: "API" }, { timeZone: "UTC" },
    { externalAccountId: "account-name" }, { externalProductId: "" }, { externalOptionId: "option-1" }]) {
    assert.throws(() => validateTarget({ ...job.target, ...patch }));
  }
});

test("mutation requires exact option, minute time, desired state, keys, and canonical query", () => {
  assert.equal(validateUpdateMutation(validBody(), job), true);
  for (const mutate of [
    (body) => { body.variables.input.timeSlots[0].tourOptionId = "99999"; },
    (body) => { body.variables.input.timeSlots[0].dateTime = "2099-01-01T13:00:00"; },
    (body) => { body.variables.input.isBlocked = false; },
    (body) => { body.variables.input.timeSlots.push({ dateTime: "2099-01-01T13:00", tourOptionId: "30003" }); },
    (body) => { body.variables.input.extra = true; },
    (body) => { body.query = "mutation Other { update { ok } }"; },
  ]) {
    const body = structuredClone(validBody()); mutate(body);
    assert.equal(validateUpdateMutation(body, job), false);
  }
});

test("write permit is one-shot and performs interception-time preflight", async () => {
  let preflights = 0;
  const cloud = { async preflight() { preflights += 1; return { ready: true, desiredState: "CLOSED" }; } };
  const guard = createNetworkGuard({ job, cloud, supplierOrigin: "http://127.0.0.1:1234", cdnOrigin: "http://127.0.0.1:1234" });
  const calls = [];
  const route = (body) => ({
    request: () => ({ url: () => "http://127.0.0.1:1234/graphql", method: () => "POST", postDataJSON: () => body }),
    continue: async () => { calls.push("continue"); },
    abort: async () => { calls.push("abort"); },
  });
  guard.beginUiAction();
  await guard.handle(route(validBody()));
  await guard.handle(route(validBody()));
  assert.deepEqual(calls, ["continue", "abort"]);
  assert.equal(preflights, 1);
  assert.equal(guard.endUiAction().writes, 1);
});

test("a new UI permit cannot authorize a second GYG business write in one job", async () => {
  const guard = createNetworkGuard({ job, cloud: { async preflight() {} }, supplierOrigin: "http://127.0.0.1:1234", cdnOrigin: "http://127.0.0.1:1234" });
  const calls = [];
  guard.beginUiAction();
  await guard.handle(graphqlRoute(validBody(), calls));
  assert.equal(guard.endUiAction().writes, 1);
  guard.beginUiAction();
  await guard.handle(graphqlRoute(validBody(), calls));
  assert.throws(() => guard.endUiAction(), (error) => error.code === "WRITE_REFUSED");
  assert.deepEqual(calls, ["continue", "abort"]);
  assert.equal(guard.writes, 1);
});

test("concurrent exact requests reserve one permit and a frozen preflight never writes", async () => {
  let release;
  const cloud = { preflight: () => new Promise((resolve) => { release = resolve; }) };
  const guard = createNetworkGuard({ job, cloud, supplierOrigin: "http://127.0.0.1:1234", cdnOrigin: "http://127.0.0.1:1234" });
  const calls = [];
  guard.beginUiAction();
  const first = guard.handle(graphqlRoute(validBody(), calls));
  await guard.handle(graphqlRoute(validBody(), calls));
  assert.deepEqual(calls, ["abort"]);
  guard.freeze();
  release();
  await first;
  assert.deepEqual(calls, ["abort", "abort"]);
  assert.equal(guard.writes, 0);
});

test("interception-time stale preflight aborts the mutation and surfaces the failure", async () => {
  const stale = Object.assign(new Error("stale"), { code: "STALE_PREFLIGHT" });
  const guard = createNetworkGuard({ job, cloud: { async preflight() { throw stale; } }, supplierOrigin: "http://127.0.0.1:1234", cdnOrigin: "http://127.0.0.1:1234" });
  const calls = [];
  const route = {
    request: () => ({ url: () => "http://127.0.0.1:1234/graphql", method: () => "POST", postDataJSON: validBody }),
    continue: async () => { calls.push("continue"); }, abort: async () => { calls.push("abort"); },
  };
  guard.beginUiAction();
  await guard.handle(route);
  assert.deepEqual(calls, ["abort"]);
  assert.throws(() => guard.endUiAction(), (error) => error.code === "STALE_PREFLIGHT");
});

test("background Inbox subscription is expected noise but a wrong target mutation is always fatal", async () => {
  const guard = createNetworkGuard({ job, cloud: { async preflight() {} }, supplierOrigin: "http://127.0.0.1:1234", cdnOrigin: "http://127.0.0.1:1234" });
  await guard.handle(graphqlRoute({ operationName: "Inbox_UnreadCountChanged", query: "subscription Inbox_UnreadCountChanged { inbox { unread } }", variables: {} }));
  assert.equal(guard.fatalWrite, null);
  const wrong = validBody();
  wrong.variables.input.timeSlots[0].tourOptionId = "99999";
  await guard.handle(graphqlRoute(wrong));
  assert.equal(guard.fatalWrite.code, "WRITE_REFUSED");
});

test("unknown background mutations become fatal only during a UI action", async () => {
  const guard = createNetworkGuard({ job, cloud: { async preflight() {} }, supplierOrigin: "http://127.0.0.1:1234", cdnOrigin: "http://127.0.0.1:1234" });
  const unknown = { operationName: "UnknownWrite", query: "mutation UnknownWrite { unknown }", variables: {} };
  await guard.handle(graphqlRoute(unknown));
  assert.equal(guard.fatalWrite, null);
  guard.beginUiAction();
  await guard.handle(graphqlRoute(unknown));
  assert.throws(() => guard.endUiAction(), (error) => error.code === "WRITE_REFUSED");
});

test("external and non-fixed document navigation is aborted", async () => {
  const guard = createNetworkGuard({ job, cloud: { async preflight() {} } });
  let aborted = 0;
  const routeFor = (url) => ({
    request: () => ({ url: () => url, method: () => "GET", isNavigationRequest: () => true, resourceType: () => "document" }),
    continue: async () => {}, abort: async () => { aborted += 1; },
  });
  await guard.handle(routeFor("https://example.test/login"));
  await guard.handle(routeFor("https://supplier.getyourguide.com/unexpected"));
  assert.equal(aborted, 2);
  assert.equal(guard.externalNavigationBlocked, true);
});

test("Nuxt static modulepreloads labelled other are allowed, but arbitrary other requests stay blocked", async () => {
  const guard = createNetworkGuard({ job, cloud: { async preflight() {} } });
  const calls = [];
  for (const path of ["/supplier-portal/nuxt/_nuxt/synthetic.js", "/private-api/synthetic.json"]) {
    await guard.handle({
      request: () => ({ url: () => `https://cdn.getyourguide.com${path}`, method: () => "GET",
        isNavigationRequest: () => false, resourceType: () => "other" }),
      continue: async () => { calls.push("continue"); }, abort: async () => { calls.push("abort"); },
    });
  }
  assert.deepEqual(calls, ["continue", "abort"]);
});

test("only the observed Firebase session refresh form is permitted outside supplier origins", async () => {
  const guard = createNetworkGuard({ job, cloud: { async preflight() {} } });
  const calls = [];
  const refresh = { url: "https://securetoken.googleapis.com/v1/token?key=synthetic_public_api_key_12345", method: "POST",
    type: "fetch", contentType: "application/x-www-form-urlencoded", body: "grant_type=refresh_token&refresh_token=synthetic-private-token" };
  for (const patch of [{}, { method: "GET" }, { url: "https://securetoken.googleapis.com/v1/signin?key=synthetic_public_api_key_12345" },
    { body: "grant_type=password&refresh_token=synthetic" }, { body: "grant_type=refresh_token&refresh_token=synthetic&extra=x" },
    { body: "grant_type=refresh_token&grant_type=refresh_token" }, { contentType: "application/json" }, { type: "document" },
    { url: "https://example.test/v1/token?key=synthetic_public_api_key_12345" }]) {
    const value = { ...refresh, ...patch };
    await guard.handle({ request: () => ({ url: () => value.url, method: () => value.method, resourceType: () => value.type,
      isNavigationRequest: () => false, headers: () => ({ "content-type": value.contentType }), postData: () => value.body }),
      continue: async () => { calls.push("continue"); }, abort: async () => { calls.push("abort"); } });
  }
  assert.deepEqual(calls, ["continue", ...Array(8).fill("abort")]);
  assert.equal(guard.writes, 0);
});
