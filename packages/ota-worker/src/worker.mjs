import { randomUUID } from "node:crypto";
import { BACKOFF_MS, DEFAULT_POLL_MS } from "./constants.mjs";
import { executeJob } from "./supervisor.mjs";
import { isGoogleDeliveryTarget, makeGoogleAirbnbResult, makeReservationResult, makeResult } from "./validation.mjs";
import { restartDisposition } from "./journal.mjs";
import { createHaltLatch } from "./halt-latch.mjs";

const sleep = (ms, signal) => new Promise((resolve) => {
  if (signal?.aborted) return resolve();
  const cleanup = () => signal?.removeEventListener("abort", abort);
  // The polling wait owns the daemon's lifetime when the API is idle.
  const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
  const abort = () => { clearTimeout(timer); cleanup(); resolve(); };
  signal?.addEventListener("abort", abort, { once: true });
});

export async function resumeJournal(journal, cloud, haltLatch = null) {
  const record = journal.current ?? await journal.load();
  const disposition = restartDisposition(record);
  if (disposition === "EMPTY") return { status: "EMPTY", modelInvocations: 0 };
  if (disposition === "RETRY_IDENTICAL_RESULT") {
    if (record.reason) await haltLatch?.set(record.reason);
    let receipt;
    try { receipt = await cloud.result(record.job.id, record.result); }
    catch (error) {
      if (!["AUTH", "INVALID_RESPONSE"].includes(error?.code)) throw error;
      const reason = error.code === "AUTH" ? "RESULT_AUTH" : "RESULT_INVALID_RESPONSE";
      await haltLatch?.set(reason);
      return { status: "HALT_PENDING_RESULT", reason, modelInvocations: 0 };
    }
    await journal.clearAfterAcknowledged(record.result.resultId);
    return {
      status: record.reason ? "HALT_AFTER_RESULT" : receipt?.acceptedAsCurrent === false ? "RESULT_ACKNOWLEDGED_NOT_CURRENT" : "RESULT_ACKNOWLEDGED",
      reason: record.reason,
      acceptedAsCurrent: receipt?.acceptedAsCurrent !== false,
      modelInvocations: 0,
    };
  }
  if (record.phase !== "QUARANTINED") await journal.quarantine("RESTART_REQUIRES_EXPLICIT_RECOVERY");
  return { status: "HALT_QUARANTINED", modelInvocations: 0 };
}

export async function runWorkerOnce({ cloud, config, journal, executor = executeJob }) {
  const haltLatch = config.privateDir ? createHaltLatch(config.privateDir) : null;
  const resumed = await resumeJournal(journal, cloud, haltLatch);
  if (resumed.status !== "EMPTY") return resumed;
  const halted = await haltLatch?.read();
  if (halted) return { status: "HALT_LATCHED", reason: halted.reason };
  // Cloud-side Google work overlaps claim/browser work and never receives a
  // calendar ID locally, so an unavailable optional sync cannot stall OTA.
  const googleSync = typeof cloud.triggerResourceGoogleSync === "function"
    ? cloud.triggerResourceGoogleSync().catch(() => ({ processed: false, applied: false }))
    : Promise.resolve({ processed: false, applied: false });
  const job = await cloud.claimAllowIdle();
  if (!job) { await googleSync; return { status: "IDLE", modelInvocations: 0 }; }
  await journal.claimed(job);
  await journal.running();
  const execution = await executor({ job, cloud, config, journal });
  const modelInvocations = job.purpose === "RESERVATION_WINDOW" || isGoogleDeliveryTarget(job.target)
    ? 0 : config.mode === "claude-code" ? 1 : 0;
  const result = job.purpose === "RESERVATION_WINDOW"
    ? makeReservationResult({ resultId: randomUUID(), job, outcome: execution.outcome, stopped: execution.stopped,
      reservationReadId: execution.reservationReadId, reservationReceiptId: execution.reservationReceiptId })
    : execution.googleAirbnbProof !== undefined
      ? makeGoogleAirbnbResult({ resultId: randomUUID(), job, outcome: execution.outcome, stopped: execution.stopped,
        observation: execution.observation, googleAirbnbProof: execution.googleAirbnbProof,
        expectedDesiredState: execution.expectedDesiredState })
    : makeResult({ resultId: randomUUID(), job, outcome: execution.outcome, stopped: execution.stopped, observation: execution.observation });
  const haltReason = execution.stopped !== true ? "PROCESS_STOP_UNCONFIRMED"
    : execution.halt ? execution.reason ?? execution.outcome : undefined;
  await journal.pendingResult(result, haltReason);
  if (haltReason) await haltLatch?.set(haltReason);
  let receipt;
  try { receipt = await cloud.result(job.id, result); }
  catch (error) {
    if (!["AUTH", "INVALID_RESPONSE"].includes(error?.code)) throw error;
    const reason = error.code === "AUTH" ? "RESULT_AUTH" : "RESULT_INVALID_RESPONSE";
    await haltLatch?.set(reason);
    await googleSync;
    return { status: "HALT_PENDING_RESULT", outcome: execution.outcome, stopped: execution.stopped, reason,
      modelInvocations };
  }
  await journal.clearAfterAcknowledged(result.resultId);
  await googleSync;
  return {
    status: haltReason ? "HALT_AFTER_RESULT" : receipt?.acceptedAsCurrent === false ? "RESULT_ACKNOWLEDGED_NOT_CURRENT" : "RESULT_ACKNOWLEDGED",
    outcome: execution.outcome,
    stopped: execution.stopped,
    quarantine: execution.quarantine,
    reason: haltReason ?? execution.reason,
    acceptedAsCurrent: receipt?.acceptedAsCurrent !== false,
    modelInvocations,
  };
}

export async function runWorkerLoop({ cloud, config, journal, signal, executor, random = Math.random, onSummary = () => {} }) {
  let failures = 0;
  while (!signal.aborted) {
    const started = Date.now();
    try {
      const result = await runWorkerOnce({ cloud, config, journal, executor });
      failures = 0;
      onSummary({ status: result.status, outcome: result.outcome, stopped: result.stopped, modelInvocations: result.modelInvocations ?? 0, elapsedMs: Date.now() - started });
      if (result.status.startsWith("HALT_")) return result;
      await sleep(DEFAULT_POLL_MS + Math.floor(random() * 2_000), signal);
    } catch (error) {
      const delay = BACKOFF_MS[Math.min(failures, BACKOFF_MS.length - 1)] + Math.floor(random() * 2_000);
      failures += 1;
      onSummary({ status: "RETRY_WAIT", error: String(error?.code ?? "WORKER_ERROR").slice(0, 80), elapsedMs: Date.now() - started });
      await sleep(delay, signal);
    }
  }
  return { status: "STOPPED" };
}

export const workerInternals = Object.freeze({ sleep });
