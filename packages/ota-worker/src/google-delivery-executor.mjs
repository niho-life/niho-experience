import { MAX_JOB_MS } from "./constants.mjs";
import { CloudError } from "./cloud-client.mjs";
import { ContractError } from "./validation.mjs";

const wait = (ms, signal) => new Promise((resolve) => {
  if (signal.aborted) return resolve(false);
  const cleanup = () => signal.removeEventListener("abort", abort);
  const timer = setTimeout(() => { cleanup(); resolve(true); }, ms);
  timer.unref?.();
  const abort = () => { clearTimeout(timer); cleanup(); resolve(false); };
  signal.addEventListener("abort", abort, { once: true });
});

function settleWithin(promise, signal) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const onAbort = () => finish({ status: "ABORTED", error: signal.reason });
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    Promise.resolve(promise).then(
      (value) => finish({ status: "FULFILLED", value }),
      (error) => finish({ status: "REJECTED", error }),
    );
  });
}

const stoppedReview = (reason) => Object.freeze({
  outcome: "NEEDS_REVIEW", stopped: true, observation: null, quarantine: true, halt: true, reason,
  modelInvocations: 0,
});

const uncertainAfterSend = () => Object.freeze({
  outcome: "UNKNOWN_AFTER_SAVE", stopped: false, observation: null, quarantine: true, halt: true,
  reason: "UNKNOWN_AFTER_SAVE", modelInvocations: 0,
});

function confirmedResult(delivery) {
  if (delivery.phase === "GOOGLE_VERIFIED") return stoppedReview("AIRBNB_OBSERVATION_REQUIRED");
  if (["DISPATCHING", "UNCERTAIN"].includes(delivery.phase)) {
    return Object.freeze({
      outcome: "UNKNOWN_AFTER_SAVE", stopped: true, observation: null, quarantine: true, halt: true,
      reason: delivery.reason ?? delivery.phase, modelInvocations: 0,
    });
  }
  return stoppedReview(delivery.reason ?? delivery.phase);
}

export async function executeGoogleDelivery({ job, cloud, config, renewEveryMs = 20_000, now = () => Date.now() }) {
  if (config.googleDeliveryEnabled !== true) return stoppedReview("GOOGLE_DELIVERY_DISABLED");

  const controller = new AbortController();
  const deadlineMs = Math.min(Date.parse(job.deadlineAtUtc), now() + MAX_JOB_MS);
  let leaseExpiresMs = Date.parse(job.leaseExpiresAtUtc);
  let sent = false;
  let renewLoop = Promise.resolve();
  let leaseTimer;
  const armLeaseTimer = () => {
    clearTimeout(leaseTimer);
    leaseTimer = setTimeout(() => controller.abort(new ContractError("LEASE_RENEW_FAILED")), Math.max(0, leaseExpiresMs - now()));
    leaseTimer.unref?.();
  };
  armLeaseTimer();
  const deadlineTimer = setTimeout(() => controller.abort(new ContractError("DEADLINE_EXCEEDED")), Math.max(0, deadlineMs - now()));
  deadlineTimer.unref?.();

  const assertLocal = () => {
    if (controller.signal.aborted || now() >= deadlineMs || now() >= leaseExpiresMs) {
      throw controller.signal.reason ?? new ContractError(now() >= deadlineMs ? "DEADLINE_EXCEEDED" : "LEASE_RENEW_FAILED");
    }
  };
  const abort = (error) => {
    if (!controller.signal.aborted) controller.abort(error);
  };
  const call = (factory) => {
    let promise;
    try { promise = factory(); }
    catch (error) { promise = Promise.reject(error); }
    return settleWithin(promise, controller.signal);
  };

  try {
    assertLocal();
    const preflight = await call(() => cloud.preflight(job));
    if (preflight.status !== "FULFILLED") throw preflight.error ?? new ContractError("DEADLINE_EXCEEDED");
    assertLocal();

    const renewal = await call(() => cloud.renew(job));
    if (renewal.status !== "FULFILLED") throw renewal.error ?? new ContractError("LEASE_RENEW_FAILED");
    leaseExpiresMs = Date.parse(renewal.value?.leaseExpiresAtUtc);
    if (!Number.isFinite(leaseExpiresMs) || leaseExpiresMs <= now() || leaseExpiresMs > deadlineMs) {
      throw new ContractError("LEASE_RENEW_FAILED");
    }
    armLeaseTimer();

    renewLoop = (async () => {
      for (;;) {
        const delayMs = Math.max(0, Math.min(renewEveryMs, leaseExpiresMs - now() - 5_000));
        if (!await wait(delayMs, controller.signal)) return;
        const renewed = await call(() => cloud.renew(job));
        if (renewed.status !== "FULFILLED") {
          abort(renewed.error ?? new ContractError("LEASE_RENEW_FAILED"));
          return;
        }
        const nextLeaseMs = Date.parse(renewed.value?.leaseExpiresAtUtc);
        if (!Number.isFinite(nextLeaseMs) || nextLeaseMs <= now() || nextLeaseMs > deadlineMs) {
          abort(new ContractError("LEASE_RENEW_FAILED"));
          return;
        }
        leaseExpiresMs = nextLeaseMs;
        armLeaseTimer();
      }
    })();

    assertLocal();
    const operation = job.action === "OBSERVE" ? "reconcile" : "dispatch";
    sent = true;
    const delivery = await call(() => cloud.googleDelivery(job, operation, { signal: controller.signal }));
    if (delivery.status !== "FULFILLED") {
      const error = delivery.error;
      if (error instanceof CloudError && error.code === "HTTP_ERROR" && error.status === 404) {
        return stoppedReview("GOOGLE_DELIVERY_UNAVAILABLE");
      }
      return uncertainAfterSend();
    }
    assertLocal();
    return confirmedResult(delivery.value);
  } catch (error) {
    if (sent) return uncertainAfterSend();
    return stoppedReview(String(error?.code ?? "GOOGLE_DELIVERY_PREFLIGHT_FAILED").slice(0, 80));
  } finally {
    abort(new ContractError("EXECUTION_COMPLETE"));
    clearTimeout(deadlineTimer);
    clearTimeout(leaseTimer);
    await renewLoop;
  }
}

export const googleDeliveryExecutorInternals = Object.freeze({ confirmedResult, settleWithin, wait });
