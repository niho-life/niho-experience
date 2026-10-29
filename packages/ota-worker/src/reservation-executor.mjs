import { ContractError, exactKeys, isPlainObject } from "./validation.mjs";
import { MAX_JOB_MS } from "./constants.mjs";

const MAX_PAGE_BYTES = 16 * 1024;
const MAX_FACTS = 32;
const wait = (ms, signal) => new Promise((resolve) => {
  if (signal.aborted) return resolve(false);
  const timer = setTimeout(() => { cleanup(); resolve(true); }, ms);
  timer.unref?.();
  const abort = () => { clearTimeout(timer); cleanup(); resolve(false); };
  const cleanup = () => signal.removeEventListener("abort", abort);
  signal.addEventListener("abort", abort, { once: true });
});
const bytes = (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const opaqueCursor = (externalCursor, split) => Buffer.from(JSON.stringify({ v: 1, externalCursor: externalCursor ?? "", split }), "utf8").toString("base64url");

function fact(value) {
  const required = ["externalReservationId", "externalProductId", "sourceStartAtUtc", "sourceEndAtUtc", "status", "seats"];
  const optional = ["externalOptionId", "sourceUpdatedAtUtc", "sourceRevision"];
  if (!exactKeys(value, required, optional)
    || typeof value.externalReservationId !== "string" || value.externalReservationId.length < 1 || value.externalReservationId.length > 256
    || typeof value.externalProductId !== "string" || value.externalProductId.length < 1 || value.externalProductId.length > 256
    || (value.externalOptionId !== undefined && (typeof value.externalOptionId !== "string" || value.externalOptionId.length > 256))
    || typeof value.sourceStartAtUtc !== "string" || typeof value.sourceEndAtUtc !== "string"
    || !Number.isFinite(Date.parse(value.sourceStartAtUtc)) || !Number.isFinite(Date.parse(value.sourceEndAtUtc))
    || Date.parse(value.sourceEndAtUtc) <= Date.parse(value.sourceStartAtUtc)
    || !["PENDING", "CONFIRMED", "CANCELLED"].includes(value.status)
    || !Number.isSafeInteger(value.seats) || value.seats < 1 || value.seats > 1000
    || (value.sourceUpdatedAtUtc !== undefined && (typeof value.sourceUpdatedAtUtc !== "string" || !Number.isFinite(Date.parse(value.sourceUpdatedAtUtc))))
    || (value.sourceRevision !== undefined && (typeof value.sourceRevision !== "string" || value.sourceRevision.length < 1 || value.sourceRevision.length > 256))) {
    throw new ContractError("INVALID_READER_RESPONSE");
  }
  return Object.freeze({ ...value });
}

function readerPage(value) {
  if (!exactKeys(value, ["facts"], ["nextCursor", "snapshotToken", "terminal"]) || !Array.isArray(value.facts)
    || (value.nextCursor !== undefined && (typeof value.nextCursor !== "string" || value.nextCursor.length < 1 || value.nextCursor.length > 512))
    || (value.snapshotToken !== undefined && (typeof value.snapshotToken !== "string" || value.snapshotToken.length < 1 || value.snapshotToken.length > 256))) {
    throw new ContractError("INVALID_READER_RESPONSE");
  }
  if ((value.nextCursor === undefined) === (value.terminal === undefined)) throw new ContractError("INVALID_READER_RESPONSE");
  let terminal;
  if (value.terminal !== undefined) {
    if (!exactKeys(value.terminal, ["status", "allPagesRead", "allStatusesIncluded", "coverageComplete"])
      || !["COMPLETE", "PARTIAL", "FAILED"].includes(value.terminal.status)
      || typeof value.terminal.allPagesRead !== "boolean" || typeof value.terminal.allStatusesIncluded !== "boolean"
      || typeof value.terminal.coverageComplete !== "boolean"
      || (value.terminal.status === "COMPLETE" && !(value.terminal.allPagesRead && value.terminal.allStatusesIncluded && value.terminal.coverageComplete))
      || (value.terminal.status === "FAILED" && value.facts.length !== 0)) throw new ContractError("INVALID_READER_RESPONSE");
    terminal = Object.freeze({ ...value.terminal });
  }
  return Object.freeze({ facts: Object.freeze(value.facts.map(fact)), ...(value.nextCursor ? { nextCursor: value.nextCursor } : {}),
    ...(value.snapshotToken ? { snapshotToken: value.snapshotToken } : {}), ...(terminal ? { terminal } : {}) });
}

export function unsupportedReservationReaderFactory() {
  throw new ContractError("UNSUPPORTED_READER");
}

function classify(error) {
  const code = error?.code ?? "RESERVATION_READ_FAILED";
  if (["AUTH_REQUIRED", "CHALLENGE_REQUIRED"].includes(code)) return { outcome: "AUTH_REQUIRED", halt: true, reason: code };
  if (["INVALID_READER_RESPONSE", "UNSUPPORTED_READER", "INVALID_RESPONSE", "HTTP_ERROR"].includes(code)) {
    return { outcome: "NEEDS_REVIEW", halt: true, reason: code };
  }
  return { outcome: "RETRY_WAIT", halt: false, reason: code };
}

async function sendPage(cloud, job, payload, journal, assertGate) {
  await journal.pendingReservationPage(payload);
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    assertGate();
    try {
      const receipt = await cloud.submitReservationWindowPage(job.id, payload);
      if (receipt.receiptId !== payload.receiptId || receipt.readId !== payload.readId || receipt.pageNumber !== payload.pageNumber) {
        throw new ContractError("INVALID_RESPONSE");
      }
      await journal.reservationPageAcknowledged(payload.receiptId);
      return receipt;
    } catch (error) {
      lastError = error;
      if (attempt > 0 || !["NETWORK_ERROR", "TIMEOUT"].includes(error?.code)) throw error;
    }
  }
  throw lastError;
}

export async function executeReservationWindow({
  job, cloud, config, journal, readerFactory = unsupportedReservationReaderFactory,
  renewEveryMs = 20_000, now = () => Date.now(),
}) {
  const controller = new AbortController();
  const deadlineMs = Math.min(Date.parse(job.deadlineAtUtc), now() + MAX_JOB_MS);
  let leaseExpiresMs = Date.parse(job.leaseExpiresAtUtc);
  let abortReason = null;
  let reader = null;
  let readerStopped = true;
  const abort = (error) => { if (!controller.signal.aborted) { abortReason = error; controller.abort(error); } };
  const assertGate = () => {
    if (controller.signal.aborted || now() >= deadlineMs || now() >= leaseExpiresMs) {
      throw abortReason ?? new ContractError(now() >= deadlineMs ? "DEADLINE_EXCEEDED" : "LEASE_RENEW_FAILED");
    }
  };
  const deadlineTimer = setTimeout(() => abort(new ContractError("DEADLINE_EXCEEDED")), Math.max(0, deadlineMs - now()));
  deadlineTimer.unref?.();
  const renewLoop = (async () => {
    for (;;) {
      const delay = Math.max(0, Math.min(renewEveryMs, leaseExpiresMs - now() - 5_000));
      if (!await wait(delay, controller.signal)) return;
      try {
        assertGate();
        const renewed = await cloud.renew(job);
        leaseExpiresMs = Date.parse(renewed.leaseExpiresAtUtc);
        if (!Number.isFinite(leaseExpiresMs) || leaseExpiresMs <= now() || leaseExpiresMs > deadlineMs) throw new ContractError("LEASE_RENEW_FAILED");
      } catch (error) { abort(error?.code === "DEADLINE_EXCEEDED" ? error : new ContractError("LEASE_RENEW_FAILED")); return; }
    }
  })();

  let outcome = "RETRY_WAIT";
  let reason = null;
  let halt = false;
  let reservationReadId;
  let reservationReceiptId;
  try {
    assertGate();
    const cycle = await cloud.beginReservationWindow(job);
    assertGate();
    reader = await readerFactory({ target: job.target, config });
    readerStopped = false;
    if (!reader || typeof reader.readPage !== "function" || typeof reader.stop !== "function") throw new ContractError("INVALID_READER");
    let externalCursor;
    let wireCursor;
    let receiptId = cycle.receiptId;
    let pageNumber = 0;
    for (;;) {
      assertGate();
      const external = readerPage(await reader.readPage(Object.freeze({
        manifest: cycle.manifest, target: job.target, coverageFromUtc: cycle.coverageFromUtc,
        coverageToUtc: cycle.coverageToUtc, ...(externalCursor ? { cursor: externalCursor } : {}), signal: controller.signal,
      })));
      let offset = 0;
      do {
        const chunk = [];
        const remaining = external.facts.length - offset;
        const atEndWith = (count) => count === remaining;
        while (offset + chunk.length < external.facts.length && chunk.length < MAX_FACTS) {
          const candidate = [...chunk, external.facts[offset + chunk.length]];
          const finalChunk = atEndWith(candidate.length);
          const terminal = finalChunk && external.terminal ? { ...external.terminal, completedAtUtc: new Date(now()).toISOString() } : undefined;
          const nextSourceCursor = finalChunk
            ? external.nextCursor ? opaqueCursor(external.nextCursor, 0) : undefined
            : opaqueCursor(externalCursor, offset + candidate.length);
          const probe = { receiptId, readId: cycle.readId, leaseToken: job.leaseToken, pageNumber,
            ...(pageNumber ? { previousReceiptId: reservationReceiptId, sourceCursor: wireCursor } : {}),
            ...(nextSourceCursor ? { nextSourceCursor } : {}), ...(external.snapshotToken ? { snapshotToken: external.snapshotToken } : {}),
            observations: candidate, ...(terminal ? { terminal } : {}) };
          if (bytes(probe) > MAX_PAGE_BYTES) {
            if (candidate.length === 1) throw new ContractError("FACT_TOO_LARGE");
            break;
          }
          chunk.push(external.facts[offset + chunk.length]);
        }
        const finalChunk = offset + chunk.length === external.facts.length;
        const nextSourceCursor = finalChunk
          ? external.nextCursor ? opaqueCursor(external.nextCursor, 0) : undefined
          : opaqueCursor(externalCursor, offset + chunk.length);
        const terminal = finalChunk && external.terminal
          ? { ...external.terminal, completedAtUtc: new Date(now()).toISOString() } : undefined;
        const payload = Object.freeze({ receiptId, readId: cycle.readId, leaseToken: job.leaseToken, pageNumber,
          ...(pageNumber ? { previousReceiptId: reservationReceiptId, sourceCursor: wireCursor } : {}),
          ...(nextSourceCursor ? { nextSourceCursor } : {}), ...(external.snapshotToken ? { snapshotToken: external.snapshotToken } : {}),
          observations: Object.freeze(chunk), ...(terminal ? { terminal: Object.freeze(terminal) } : {}) });
        if (chunk.length > MAX_FACTS || bytes(payload) > MAX_PAGE_BYTES) throw new ContractError("PAGE_TOO_LARGE");
        const receipt = await sendPage(cloud, job, payload, journal, assertGate);
        reservationReceiptId = receipt.receiptId;
        offset += chunk.length;
        wireCursor = nextSourceCursor;
        pageNumber += 1;
        if (terminal) {
          outcome = terminal.status === "COMPLETE" ? "RESERVATION_VERIFIED" : "RETRY_WAIT";
          reservationReadId = cycle.readId;
          if (outcome !== "RESERVATION_VERIFIED") { reservationReadId = undefined; reservationReceiptId = undefined; }
          break;
        }
        receiptId = receipt.nextReceiptId;
        if (!receiptId) throw new ContractError("INVALID_RESPONSE");
      } while (offset < external.facts.length);
      if (external.terminal) break;
      externalCursor = external.nextCursor;
    }
  } catch (error) {
    const failure = classify(abortReason ?? error);
    outcome = failure.outcome; halt = failure.halt; reason = failure.reason;
    reservationReadId = undefined; reservationReceiptId = undefined;
  } finally {
    abort(abortReason ?? new ContractError("EXECUTION_COMPLETE"));
    clearTimeout(deadlineTimer);
    await renewLoop;
    if (reader) readerStopped = await reader.stop().then((value) => value === true).catch(() => false);
  }
  if (!readerStopped) { outcome = "NEEDS_REVIEW"; halt = true; reason = "PROCESS_STOP_UNCONFIRMED"; }
  return Object.freeze({ outcome, stopped: readerStopped, observation: null, quarantine: outcome !== "RESERVATION_VERIFIED",
    halt, reason, reservationReadId, reservationReceiptId, modelInvocations: 0 });
}

export const reservationExecutorInternals = Object.freeze({ bytes, opaqueCursor, readerPage });
