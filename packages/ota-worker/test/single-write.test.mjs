import test from "node:test";
import assert from "node:assert/strict";
import { forwardSingleWrite } from "../src/single-write.mjs";

function fixture({ failFetch = false, failFulfill = false } = {}) {
  const calls = [];
  const response = { async dispose() { calls.push("dispose"); } };
  const route = {
    async fetch(options) {
      calls.push("fetch");
      assert.deepEqual(options, { maxRetries: 0, maxRedirects: 0, timeout: 10_000 });
      if (failFetch) throw new Error("synthetic socket reset");
      return response;
    },
    async fulfill(options) { assert.equal(options.response, response); calls.push("fulfill"); if (failFulfill) throw new Error("synthetic page closed"); },
    async abort(reason) { assert.equal(reason, "failed"); calls.push("abort"); },
    async continue() { assert.fail("must not fall back to native transport"); },
  };
  return { route, calls };
}

test("bounded forward fulfills the original response and disposes it", async () => {
  const { route, calls } = fixture(); await forwardSingleWrite(route);
  assert.deepEqual(calls, ["fetch", "fulfill", "dispose"]);
});

test("a transport failure consumes the attempt without retry or native fallback", async () => {
  const { route, calls } = fixture({ failFetch: true }); await forwardSingleWrite(route);
  assert.deepEqual(calls, ["fetch", "abort"]);
});

test("a failed fulfillment still disposes the response without resending", async () => {
  const { route, calls } = fixture({ failFulfill: true });
  await assert.rejects(forwardSingleWrite(route), /synthetic page closed/);
  assert.deepEqual(calls, ["fetch", "fulfill", "dispose"]);
});
