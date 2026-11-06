import test from "node:test";
import assert from "node:assert/strict";
import { errors } from "playwright-core";
import { assertAuthOrDrift, countWithin, navigationFailureCode } from "../src/browser-driver-common.mjs";
import { ContractError } from "../src/validation.mjs";
import { retryOnStall } from "./helpers/stall-retry.mjs";

const ORIGIN = "http://127.0.0.1:4010";
const pattern = /sign in|log in/i;
const fakePage = ({ url = `${ORIGIN}/availability/`, signInCount = 0 } = {}) =>
  ({ url: () => url, getByText: () => ({ count: async () => signInCount }) });
const guard = (externalNavigationBlocked = false) => ({ externalNavigationBlocked });
const timeout = () => new errors.TimeoutError("page.goto: Timeout 15000ms exceeded.");
const failureOf = async (options) => {
  try { await assertAuthOrDrift({ supplierOrigin: ORIGIN, signInPattern: pattern, guard: guard(), page: fakePage(), ...options }); }
  catch (error) { return error; }
  assert.fail("assertAuthOrDrift must throw");
};

test("a navigation timeout is TIMEOUT, not DOM_DRIFT, and keeps the real error", async () => {
  const cause = timeout();
  const error = await failureOf({ cause });
  assert.equal(error.code, "TIMEOUT");
  assert.equal(error.cause, cause);
  assert.ok(error instanceof ContractError);
});

test("an unreachable supplier is NETWORK_ERROR", async () => {
  for (const reason of ["ERR_CONNECTION_REFUSED", "ERR_CONNECTION_RESET", "ERR_NETWORK_CHANGED", "ERR_INTERNET_DISCONNECTED",
    "ERR_NAME_NOT_RESOLVED", "ERR_TIMED_OUT", "ERR_EMPTY_RESPONSE", "ERR_ADDRESS_UNREACHABLE", "ERR_SOCKET_NOT_CONNECTED", "ERR_PROXY_CONNECTION_FAILED"]) {
    const cause = new Error(`page.goto: net::${reason} at ${ORIGIN}/availability/`);
    assert.equal((await failureOf({ cause })).code, "NETWORK_ERROR", reason);
  }
});

test("other failures and a missing cause stay DOM_DRIFT", async () => {
  const aborted = new Error(`page.goto: net::ERR_ABORTED at ${ORIGIN}/availability/`);
  const drift = await failureOf({ cause: aborted });
  assert.equal(drift.code, "DOM_DRIFT"); assert.equal(drift.cause, aborted);
  const bare = await failureOf({});
  assert.equal(bare.code, "DOM_DRIFT"); assert.equal("cause" in bare, false);
});

test("authentication evidence wins over a timed-out navigation", async () => {
  const cause = timeout();
  assert.equal((await failureOf({ cause, guard: guard(true) })).code, "AUTH_REQUIRED");
  assert.equal((await failureOf({ cause, page: fakePage({ url: `${ORIGIN}/login` }) })).code, "AUTH_REQUIRED");
  assert.equal((await failureOf({ cause, page: fakePage({ signInCount: 1 }) })).code, "AUTH_REQUIRED");
  assert.equal((await failureOf({ cause, page: fakePage({ url: "https://accounts.example.com/" }) })).code, "AUTH_REQUIRED");
});

test("only timeouts and unreachable-network failures are classified", () => {
  assert.equal(navigationFailureCode(timeout()), "TIMEOUT");
  assert.equal(navigationFailureCode(new Error("net::ERR_CONNECTION_REFUSED")), "NETWORK_ERROR");
  assert.equal(navigationFailureCode(new Error("Target page, context or browser has been closed")), null);
  assert.equal(navigationFailureCode(undefined), null);
});

test("a sign-in probe that never answers does not hang the check", async () => {
  const hung = { count: () => new Promise(() => {}) };
  assert.equal(await countWithin(hung, 20), 0);
  assert.equal(await countWithin({ count: async () => 3 }, 20), 3);
  assert.equal(await countWithin({ count: async () => { throw new Error("frame detached"); } }, 20), 0);
  const stuckPage = { url: () => `${ORIGIN}/availability/`, getByText: () => hung };
  const started = Date.now();
  const error = await failureOf({ page: stuckPage, cause: timeout() }).catch((e) => e);
  assert.equal(error.code, "TIMEOUT");
  assert.ok(Date.now() - started < 8_000);
});

const diagnostics = () => { const lines = []; return { lines, diagnostic: (line) => lines.push(line) }; };

test("retryOnStall retries a stalled scenario once on a fresh fixture and cleans up both attempts", async () => {
  const t = diagnostics();
  const events = [];
  const result = await retryOnStall(t, async (after) => {
    const attempt = events.filter((event) => event.startsWith("open")).length + 1;
    events.push(`open ${attempt}`); after(() => events.push(`close ${attempt}`));
    if (attempt === 1) throw new ContractError("TIMEOUT");
    return "done";
  });
  assert.equal(result, "done");
  assert.deepEqual(events, ["open 1", "close 1", "open 2", "close 2"]);
  assert.equal(t.lines.length, 1);
});

test("retryOnStall also recognises the error that assert.rejects reports as actual", async () => {
  let attempts = 0;
  await retryOnStall(diagnostics(), async () => {
    attempts += 1;
    if (attempts === 1) await assert.rejects(Promise.reject(new ContractError("TIMEOUT")), (error) => error.code === "DOM_DRIFT");
  });
  assert.equal(attempts, 2);
});

test("retryOnStall surfaces a second stall and every other failure at once", async () => {
  let stalls = 0;
  await assert.rejects(retryOnStall(diagnostics(), async () => { stalls += 1; throw new ContractError("NETWORK_ERROR"); }), { code: "NETWORK_ERROR" });
  assert.equal(stalls, 2);
  for (const code of ["DOM_DRIFT", "AUTH_REQUIRED", "ACCOUNT_MISMATCH"]) {
    let runs = 0;
    await assert.rejects(retryOnStall(diagnostics(), async () => { runs += 1; throw new ContractError(code); }), { code });
    assert.equal(runs, 1, code);
  }
  let plain = 0;
  await assert.rejects(retryOnStall(diagnostics(), async () => { plain += 1; assert.equal(1, 2); }), { code: "ERR_ASSERTION" });
  assert.equal(plain, 1);
});

test("retryOnStall reports a failing cleanup when the scenario passed, but not over the scenario's own failure", async () => {
  await assert.rejects(retryOnStall(diagnostics(), async (after) => { after(() => { throw new Error("close failed"); }); }), /close failed/);
  await assert.rejects(retryOnStall(diagnostics(), async (after) => {
    after(() => { throw new Error("close failed"); });
    throw new ContractError("DOM_DRIFT");
  }), { code: "DOM_DRIFT" });
});
