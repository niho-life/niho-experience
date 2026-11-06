// CI runners sometimes freeze for tens of seconds: in one run three test files
// that ran side by side were each slowed by about 40 seconds. Playwright's
// timers use wall-clock time, so a navigation that was in flight expires
// although the loopback fixture was healthy. The drivers report such a
// navigation as TIMEOUT or NETWORK_ERROR, which the worker retries too.
//
// A scenario that fails on exactly those codes gets one more attempt on a fresh
// fixture, so nothing is shared with the stalled attempt. Every other failure,
// including a second stall, surfaces at once.
const STALL_CODES = new Set(["TIMEOUT", "NETWORK_ERROR"]);
// `assert.rejects` throws an AssertionError (code ERR_ASSERTION) and reports
// the error it received as `actual`.
const stallCodeOf = (error) => [error?.code, error?.actual?.code].find((code) => STALL_CODES.has(code));

export async function retryOnStall(t, scenario, { attempts = 2 } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    const cleanups = [];
    let result;
    let failed = false;
    let failure;
    try { result = await scenario((cleanup) => { cleanups.push(cleanup); }); } catch (error) { failed = true; failure = error; }
    let cleanupFailure;
    for (const cleanup of cleanups) {
      try { await cleanup(); } catch (error) { cleanupFailure ??= error; }
    }
    if (!failed) {
      if (cleanupFailure) throw cleanupFailure;
      return result;
    }
    const stallCode = stallCodeOf(failure);
    if (attempt >= attempts || !stallCode) throw failure;
    t.diagnostic(`attempt ${attempt} failed with ${stallCode}; the runner may have stalled, retrying on a fresh fixture`);
  }
}
