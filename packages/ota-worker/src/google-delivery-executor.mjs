import { MAX_JOB_MS } from "./constants.mjs";
import { createAirbnbCalendarObserver } from "./airbnb-observer.mjs";
import { CloudError } from "./cloud-client.mjs";
import { ContractError, projectRawClaim, validateGoogleAirbnbObservation, validatePreflight } from "./validation.mjs";

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

const stoppedReview = (reason, outcome = "NEEDS_REVIEW") => Object.freeze({
  outcome, stopped: true, observation: null, quarantine: true, halt: true, reason,
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

function confirmedReadResult(delivery) {
  return stoppedReview(delivery.reason ?? delivery.phase);
}

function observerFailure(error, stopped) {
  if (stopped !== true) return Object.freeze({
    outcome: "NEEDS_REVIEW", stopped: false, observation: null, quarantine: true, halt: true,
    reason: "PROCESS_STOP_UNCONFIRMED", modelInvocations: 0,
  });
  const code = String(error?.code ?? "AIRBNB_OBSERVATION_FAILED").slice(0, 80);
  return stoppedReview(code, code === "AUTH_REQUIRED" ? "AUTH_REQUIRED" : "NEEDS_REVIEW");
}

export async function executeGoogleDelivery({ job, cloud, config, renewEveryMs = 20_000, now = () => Date.now(),
  airbnbObserverFactory = createAirbnbCalendarObserver }) {
  if (config.googleDeliveryEnabled !== true) return stoppedReview("GOOGLE_DELIVERY_DISABLED");
  const markedObserve = job.action === "OBSERVE" && job.googleDeliveryOperation === "observe";
  if (markedObserve && config.googleAirbnbObservationEnabled !== true) {
    return stoppedReview("GOOGLE_AIRBNB_OBSERVATION_DISABLED");
  }

  const controller = new AbortController();
  const deadlineMs = Math.min(Date.parse(job.deadlineAtUtc), now() + MAX_JOB_MS);
  let leaseExpiresMs = Date.parse(job.leaseExpiresAtUtc);
  let writeUncertain = false;
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
    try { promise = factory(); } catch (error) { promise = Promise.reject(error); }
    return settleWithin(promise, controller.signal);
  };

  try {
    assertLocal();
    const initialPreflight = await call(() => cloud.preflight(job));
    if (initialPreflight.status !== "FULFILLED") throw initialPreflight.error ?? new ContractError("DEADLINE_EXCEEDED");
    const expectedDesiredState = validatePreflight(initialPreflight.value, job.desiredState).desiredState;
    assertLocal();

    const renewal = await call(() => cloud.renew(job));
    if (renewal.status !== "FULFILLED") throw renewal.error ?? new ContractError("LEASE_RENEW_FAILED");
    leaseExpiresMs = Date.parse(renewal.value?.leaseExpiresAtUtc);
    if (!Number.isFinite(leaseExpiresMs) || leaseExpiresMs <= now() || leaseExpiresMs > deadlineMs) throw new ContractError("LEASE_RENEW_FAILED");
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

    const legacyObserve = job.action === "OBSERVE" && !markedObserve;
    const firstOperation = markedObserve ? "observe" : legacyObserve ? "reconcile" : "dispatch";
    assertLocal();
    writeUncertain = firstOperation === "dispatch";
    const firstDelivery = await call(() => cloud.googleDelivery(job, firstOperation, { signal: controller.signal }));
    if (firstDelivery.status !== "FULFILLED") {
      const error = firstDelivery.error;
      if (error instanceof CloudError && error.code === "HTTP_ERROR" && error.status === 404) {
        return stoppedReview("GOOGLE_DELIVERY_UNAVAILABLE");
      }
      return writeUncertain ? uncertainAfterSend() : stoppedReview(String(error?.code ?? "GOOGLE_OBSERVATION_FAILED").slice(0, 80));
    }
    writeUncertain = false;
    assertLocal();
    if (legacyObserve || config.googleAirbnbObservationEnabled !== true) return confirmedResult(firstDelivery.value);
    if (firstDelivery.value.phase !== "GOOGLE_VERIFIED") {
      return firstOperation === "dispatch" ? confirmedResult(firstDelivery.value) : confirmedReadResult(firstDelivery.value);
    }

    let verifiedDelivery = firstDelivery.value;
    if (firstOperation === "dispatch") {
      const fresh = await call(() => cloud.googleDelivery(job, "observe", { signal: controller.signal }));
      if (fresh.status !== "FULFILLED") {
        return stoppedReview(String(fresh.error?.code ?? "GOOGLE_OBSERVATION_FAILED").slice(0, 80));
      }
      assertLocal();
      if (fresh.value.phase !== "GOOGLE_VERIFIED") return confirmedReadResult(fresh.value);
      if (fresh.value.deliveryId !== firstDelivery.value.deliveryId) return stoppedReview("GOOGLE_DELIVERY_MISMATCH");
      verifiedDelivery = fresh.value;
    }
    const googleVerifiedAtMs = now();
    assertLocal();

    const rawObserverJob = projectRawClaim(job, new Date(leaseExpiresMs).toISOString(), now());
    const observerCloud = Object.freeze({
      async preflight(currentJob) {
        const value = validatePreflight(await cloud.preflight(currentJob), undefined);
        if (value.desiredState !== expectedDesiredState) throw new ContractError("STALE_PREFLIGHT");
        return value;
      },
    });
    let observer;
    let lateStopPromise = null;
    let factoryPromise;
    try {
      factoryPromise = Promise.resolve(airbnbObserverFactory({
        job: rawObserverJob, cloud: observerCloud, config, now: () => new Date(now()),
      }));
    } catch (error) { factoryPromise = Promise.reject(error); }
    factoryPromise.then((value) => {
      if (controller.signal.aborted) lateStopPromise ??= Promise.resolve().then(() => value?.stop?.()).catch(() => false);
    }, () => {});
    const created = await settleWithin(factoryPromise, controller.signal);
    if (created.status !== "FULFILLED") {
      const confirmed = created.status === "REJECTED" && airbnbObserverFactory === createAirbnbCalendarObserver
        && created.error?.code !== "PROCESS_STOP_UNCONFIRMED";
      return observerFailure(created.error, confirmed);
    }
    observer = created.value;
    if (!observer || typeof observer.observeTarget !== "function" || typeof observer.stop !== "function") {
      return observerFailure(new ContractError("INVALID_OBSERVER"), false);
    }
    let stopConfirmed = false;
    let stopPromise = null;
    const initiateStop = () => {
      stopPromise ??= Promise.resolve().then(() => observer.stop()).then((value) => {
        stopConfirmed = value === true;
        return stopConfirmed;
      }).catch(() => false);
      return stopPromise;
    };
    const stopOnAbort = () => { void initiateStop(); };
    controller.signal.addEventListener("abort", stopOnAbort, { once: true });
    try {
      const observed = await call(() => observer.observeTarget());
      if (observed.status !== "FULFILLED") {
        const stopped = await settleWithin(initiateStop(), controller.signal);
        return observerFailure(observed.error, stopConfirmed || (stopped.status === "FULFILLED" && stopped.value === true));
      }
      assertLocal();
      const observation = validateGoogleAirbnbObservation(observed.value, rawObserverJob, {
        notBeforeMs: googleVerifiedAtMs,
        deadlineMs: Math.min(deadlineMs, leaseExpiresMs),
      });
      const stopped = await settleWithin(initiateStop(), controller.signal);
      if (!stopConfirmed && !(stopped.status === "FULFILLED" && stopped.value === true)) {
        return observerFailure(new ContractError("PROCESS_STOP_UNCONFIRMED"), false);
      }
      assertLocal();
      const outcome = observation.bookable === (expectedDesiredState === "OPEN") ? "VERIFIED" : "RETRY_WAIT";
      return Object.freeze({
        outcome, stopped: true, observation, expectedDesiredState,
        googleAirbnbProof: Object.freeze({ deliveryId: verifiedDelivery.deliveryId, evidence: "EXACT_SLOT_V1", partySize: 1 }),
        quarantine: false, halt: false, reason: outcome === "RETRY_WAIT" ? "GOOGLE_PROPAGATION_PENDING" : undefined,
        modelInvocations: 0,
      });
    } catch (error) {
      const stopped = await settleWithin(initiateStop(), controller.signal);
      return observerFailure(error, stopConfirmed || (stopped.status === "FULFILLED" && stopped.value === true));
    } finally {
      controller.signal.removeEventListener("abort", stopOnAbort);
    }
  } catch (error) {
    if (writeUncertain) return uncertainAfterSend();
    return stoppedReview(String(error?.code ?? "GOOGLE_DELIVERY_PREFLIGHT_FAILED").slice(0, 80));
  } finally {
    abort(new ContractError("EXECUTION_COMPLETE"));
    clearTimeout(deadlineTimer);
    clearTimeout(leaseTimer);
    await renewLoop;
  }
}

export const googleDeliveryExecutorInternals = Object.freeze({ confirmedReadResult, confirmedResult, observerFailure, settleWithin, wait });
