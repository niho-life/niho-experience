import test from "node:test";
import assert from "node:assert/strict";
import { forwardSingleWrite } from "../src/single-write.mjs";

function fixture(overrides = {}) {
  const calls = [];
  const request = {
    url: () => "https://supplier.example/availability/update",
    frame: () => ({ url: () => "https://supplier.example/availability/" }),
    resourceType: () => "xhr", method: () => "POST", isNavigationRequest: () => false, redirectedFrom: () => null,
    headers: () => ({ origin: "https://supplier.example", referer: "https://supplier.example/availability/", cookie: "synthetic=fixture", "content-type": "application/json" }),
    ...overrides,
  };
  const response = { async dispose() { calls.push({ kind: "dispose" }); } };
  const route = {
    request: () => request,
    async fetch(options) { calls.push({ kind: "fetch", options }); return response; },
    async fulfill(options) { assert.equal(options.response, response); calls.push({ kind: "fulfill" }); },
    async abort(reason) { calls.push({ kind: "abort", reason }); },
  };
  return { route, calls };
}

const options = { sameOriginXhrPage: "https://supplier.example/availability/" };

test("single forward preserves a proven same-origin XHR context and the retry/redirect bounds", async () => {
  const { route, calls } = fixture();
  await forwardSingleWrite(route, options);
  assert.deepEqual(calls.map((call) => call.kind), ["fetch", "fulfill", "dispose"]);
  const value = calls[0].options;
  assert.equal(value.maxRetries, 0); assert.equal(value.maxRedirects, 0); assert.equal(value.timeout, 10_000);
  assert.equal(value.headers.cookie, "synthetic=fixture");
  assert.equal(value.headers["sec-fetch-site"], "same-origin");
  assert.equal(value.headers["sec-fetch-mode"], "cors");
  assert.equal(value.headers["sec-fetch-dest"], "empty");
});

test("cross-origin, redirected, non-XHR or conflicting browser context never reaches the network", async () => {
  for (const overrides of [
    { frame: () => ({ url: () => "https://foreign.example/availability/" }) },
    { url: () => "https://foreign.example/availability/update" },
    { resourceType: () => "fetch" }, { isNavigationRequest: () => true }, { redirectedFrom: () => ({}) },
    { headers: () => ({ origin: "https://foreign.example" }) },
    { headers: () => ({ origin: "https://supplier.example", "sec-fetch-site": "cross-site" }) },
    { headers: () => ({ origin: "https://supplier.example", "sec-fetch-mode": "navigate" }) },
    { headers: () => ({ origin: "https://supplier.example", "sec-fetch-user": "?1" }) },
  ]) {
    const { route, calls } = fixture(overrides);
    await forwardSingleWrite(route, options);
    assert.deepEqual(calls, [{ kind: "abort", reason: "failed" }]);
  }
});

test("default forwarding remains unchanged and a network failure is never replayed", async () => {
  const ordinary = fixture(); await forwardSingleWrite(ordinary.route);
  assert.equal(ordinary.calls[0].options.headers, undefined);
  const failed = fixture();
  failed.route.fetch = async () => { failed.calls.push({ kind: "fetch" }); throw new Error("synthetic socket reset"); };
  await forwardSingleWrite(failed.route, options);
  assert.deepEqual(failed.calls, [{ kind: "fetch" }, { kind: "abort", reason: "failed" }]);
});
