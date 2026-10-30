import { join } from "node:path";
import { selectDriverFactory } from "./driver-registry.mjs";
import { createSupervisorRpc } from "./mcp-rpc.mjs";
import { runClaude } from "./claude-runner.mjs";
import { ContractError, isGoogleDeliveryTarget, validateObservation } from "./validation.mjs";
import { MAX_JOB_MS } from "./constants.mjs";
import { executeReservationWindow } from "./reservation-executor.mjs";
import { selectReservationReaderFactory } from "./reservation-reader-registry.mjs";
import { executeGoogleDelivery } from "./google-delivery-executor.mjs";

const wait = (ms, signal) => new Promise((resolve) => {
  if (signal.aborted) return resolve(false);
  const timer = setTimeout(() => { cleanup(); resolve(true); }, ms);
  timer.unref?.();
  const abort = () => { clearTimeout(timer); cleanup(); resolve(false); };
  const cleanup = () => signal.removeEventListener("abort", abort);
  signal.addEventListener("abort", abort, { once: true });
});

function classify(error) {
  const code = error?.code ?? "EXECUTION_FAILED";
  if (["AUTH_REQUIRED", "CLAUDE_AUTH_REQUIRED"].includes(code)) return { outcome: "AUTH_REQUIRED", quarantine: true, halt: true, reason: code };
  if (code === "UNKNOWN_AFTER_SAVE") return { outcome: "UNKNOWN_AFTER_SAVE", quarantine: true, halt: true, reason: code };
  if (["DOM_DRIFT", "ACCOUNT_MISMATCH", "PRODUCT_MISMATCH", "TARGET_MISMATCH", "UNSUPPORTED_TARGET", "WRITE_REFUSED", "VERIFY_FAILED", "SAVE_NOT_APPLIED", "MCP_PROTOCOL_VIOLATION"].includes(code)) {
    return { outcome: "NEEDS_REVIEW", quarantine: true, halt: true, reason: code };
  }
  if (["LEASE_RENEW_FAILED", "DEADLINE_EXCEEDED", "STALE_PREFLIGHT", "HTTP_ERROR", "NETWORK_ERROR", "TIMEOUT"].includes(code)) {
    return { outcome: "RETRY_WAIT", quarantine: true, halt: false, reason: code };
  }
  return { outcome: "NEEDS_REVIEW", quarantine: true, halt: true, reason: code };
}

function verifiedObservation(job, value) {
  const observation = validateObservation(value, job);
  if (job.action === "SET_CLOSED" && (!observation.manuallyBlocked || observation.bookable)) throw new ContractError("VERIFY_FAILED");
  if (job.action === "SET_OPEN" && (observation.manuallyBlocked || !observation.bookable)) throw new ContractError("VERIFY_FAILED");
  if (job.action === "OBSERVE" && observation.manuallyBlocked && observation.bookable) throw new ContractError("VERIFY_FAILED");
  return observation;
}

export async function executeJob({
  job,
  cloud,
  config,
  driverFactory = selectDriverFactory,
  claudeExecutor = runClaude,
  rpcFactory = createSupervisorRpc,
  renewEveryMs = 20_000,
  now = () => Date.now(),
  driverOptions = {},
  journal,
  reservationReaderFactory,
}) {
  if (job.purpose === "RESERVATION_WINDOW") {
    if (!journal) throw new ContractError("INVALID_JOURNAL");
    // Without an injected factory, only a config-enabled registry reader runs;
    // otherwise the unsupported sentinel halts before any read generation.
    const readerFactory = reservationReaderFactory ?? selectReservationReaderFactory({ job, config });
    return executeReservationWindow({ job, cloud, config, journal, readerFactory, renewEveryMs, now });
  }
  if (isGoogleDeliveryTarget(job.target)) {
    return executeGoogleDelivery({ job, cloud, config, renewEveryMs, now });
  }
  const controller = new AbortController();
  let gateActive = true;
  let abortReason = null;
  let driver = null;
  let rpc = null;
  let driverStopPromise = null;
  let modelStopped = true;
  let modelReturned = false;
  let observation = null;
  let outcome = null;
  let quarantine = false;
  let halt = false;
  let reason = null;
  let setupStopUnconfirmed = false;

  const abort = (error) => {
    if (!gateActive) return;
    gateActive = false;
    abortReason = error;
    controller.abort(error);
    if (driver && !driverStopPromise) driverStopPromise = driver.stop();
  };
  const assertGate = () => {
    if (!gateActive || controller.signal.aborted || now() >= deadlineMs || now() >= leaseExpiresMs) {
      throw abortReason ?? new ContractError(now() >= deadlineMs ? "DEADLINE_EXCEEDED" : "LEASE_RENEW_FAILED");
    }
  };
  const deadlineMs = Math.min(Date.parse(job.deadlineAtUtc), now() + MAX_JOB_MS);
  let leaseExpiresMs = Date.parse(job.leaseExpiresAtUtc);
  const deadlineTimer = setTimeout(() => abort(new ContractError("DEADLINE_EXCEEDED")), Math.max(0, deadlineMs - now()));
  deadlineTimer.unref?.();

  const gatedCloud = Object.freeze({
    async preflight(currentJob) {
      if (!gateActive || now() >= deadlineMs || now() >= leaseExpiresMs) throw abortReason ?? new ContractError(now() >= deadlineMs ? "DEADLINE_EXCEEDED" : "LEASE_RENEW_FAILED");
      let result;
      try { result = await cloud.preflight(currentJob); }
      catch (error) { abort(error); throw error; }
      if (!gateActive || now() >= deadlineMs || now() >= leaseExpiresMs) throw abortReason ?? new ContractError(now() >= deadlineMs ? "DEADLINE_EXCEEDED" : "LEASE_RENEW_FAILED");
      return result;
    },
  });

  const renewLoop = (async () => {
    for (;;) {
      const delayMs = Math.max(0, Math.min(renewEveryMs, leaseExpiresMs - now() - 5_000));
      if (!await wait(delayMs, controller.signal)) return;
      try {
        if (now() >= deadlineMs || now() >= leaseExpiresMs) throw new ContractError(now() >= deadlineMs ? "DEADLINE_EXCEEDED" : "LEASE_RENEW_FAILED");
        const renewed = await cloud.renew(job);
        leaseExpiresMs = Date.parse(renewed.leaseExpiresAtUtc);
        if (!Number.isFinite(leaseExpiresMs) || leaseExpiresMs <= now() || leaseExpiresMs > deadlineMs) throw new ContractError("LEASE_RENEW_FAILED");
      } catch (error) {
        abort(error?.code === "DEADLINE_EXCEEDED" ? error : new ContractError("LEASE_RENEW_FAILED"));
        return;
      }
    }
  })();

  try {
    driver = await driverFactory({ job, cloud: gatedCloud, config, ...driverOptions });
    if (!gateActive) throw abortReason;
    const tools = Object.freeze({
      observe_target: () => { assertGate(); return driver.observeTarget(); },
      apply_desired_state: () => { assertGate(); return driver.applyDesiredState(); },
      verify_after_reload: () => { assertGate(); return driver.verifyAfterReload(); },
    });
    if (config.mode === "claude-code") {
      const socketPath = join(config.privateDir, "ota-supervisor.sock");
      rpc = await rpcFactory(socketPath, tools, {
        onProtocolViolation: () => abort(new ContractError("MCP_PROTOCOL_VIOLATION")),
        onToolFailure: (error) => abort(error instanceof Error ? error : new ContractError("TOOL_FAILED")),
        assertGate,
      });
      modelStopped = false;
      const model = await claudeExecutor({ config, socketPath, signal: controller.signal });
      modelReturned = true;
      modelStopped = model.stopped === true;
      if (model.status === "RATE") { outcome = "NEEDS_REVIEW"; quarantine = false; halt = true; reason = "RATE"; }
      else if (model.status === "AUTH") { outcome = "AUTH_REQUIRED"; quarantine = true; halt = true; reason = "AUTH"; }
      else if (model.status !== "DONE") throw new ContractError("MODEL_FAILED");
    } else {
      await tools.observe_target();
      if (job.action !== "OBSERVE") await tools.apply_desired_state();
      await tools.verify_after_reload();
    }
    if (!outcome) {
      if (!gateActive) throw abortReason;
      observation = verifiedObservation(job, await driver.verifyAfterReload());
      if (!gateActive) throw abortReason;
      outcome = "VERIFIED";
    }
  } catch (error) {
    if ((abortReason ?? error)?.code === "PROCESS_STOP_UNCONFIRMED") setupStopUnconfirmed = true;
    if (config.mode === "claude-code" && !modelReturned) modelStopped = error?.stopped === true;
    const result = classify(abortReason ?? error);
    outcome = result.outcome; quarantine = result.quarantine; halt = result.halt; reason = result.reason;
  } finally {
    gateActive = false;
    controller.abort(abortReason ?? new ContractError("EXECUTION_COMPLETE"));
    clearTimeout(deadlineTimer);
    await renewLoop;
    await rpc?.close().catch(() => {});
    if (driver && !driverStopPromise) driverStopPromise = driver.stop();
  }
  const browserStopped = driver ? await driverStopPromise.catch(() => false) : !setupStopUnconfirmed;
  const stopped = browserStopped === true && modelStopped === true;
  if (outcome === "VERIFIED" && Math.min(deadlineMs, leaseExpiresMs) - now() < 15_000) {
    outcome = "RETRY_WAIT"; quarantine = true; halt = false; reason = "RESULT_WINDOW_TOO_SHORT";
  }
  if (!stopped) {
    if (outcome === "VERIFIED") outcome = "NEEDS_REVIEW";
    quarantine = true; halt = true; reason = "PROCESS_STOP_UNCONFIRMED";
  }
  return Object.freeze({ outcome, stopped, observation, quarantine, halt, reason });
}

export const supervisorInternals = Object.freeze({ classify, wait, verifiedObservation });
