import { createHash } from "node:crypto";
import { ContractError, exactKeys, isPlainObject } from "./validation.mjs";
import { MAX_JOB_MS } from "./constants.mjs";

const MAX_PAGE_BYTES = 16 * 1024;
const MAX_FACTS = 32;
const MAX_READER_FACTS = 512;
const MAX_READER_PAGE_BYTES = 256 * 1024;
const MAX_PAGES = 4096;
const MAX_TOTAL_FACTS = MAX_PAGES * MAX_FACTS;
const MAX_SOURCE_CURSOR = 512;
const MAX_SNAPSHOT_TOKEN = 256;
const DEFAULT_STOP_TIMEOUT_MS = 10_000;
const CANONICAL_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const wait = (ms, signal) => new Promise((resolve) => {
  if (signal.aborted) return resolve(false);
  const timer = setTimeout(() => { cleanup(); resolve(true); }, ms);
  timer.unref?.();
  const abort = () => { clearTimeout(timer); cleanup(); resolve(false); };
  const cleanup = () => signal.removeEventListener("abort", abort);
  signal.addEventListener("abort", abort, { once: true });
});

const bytes = (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const digest = (value) => createHash("sha256").update(value, "utf8").digest("hex");
const opaqueCursor = (externalCursor, split) => `v1.${digest(externalCursor ?? "<initial>")}.${split}`;
const canonicalInstant = (value) => typeof value === "string" && CANONICAL_UTC.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;

function guarded(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason ?? new ContractError("DEADLINE_EXCEEDED"));
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(signal.reason ?? new ContractError("DEADLINE_EXCEEDED")); };
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(promise).then(
      (value) => { cleanup(); resolve(value); },
      (error) => { cleanup(); reject(error); },
    );
  });
}

async function boundedStop(stopPromise, timeoutMs) {
  if (!stopPromise) return false;
  let timer;
  try {
    return await Promise.race([
      stopPromise,
      new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function fact(value, target, cycle) {
  const required = ["externalReservationId", "externalProductId", "sourceStartAtUtc", "sourceEndAtUtc", "status", "seats"];
  const optional = ["externalOptionId", "sourceUpdatedAtUtc", "sourceRevision"];
  if (!isPlainObject(value) || !exactKeys(value, required, optional)
    || typeof value.externalReservationId !== "string" || value.externalReservationId.length < 1 || value.externalReservationId.length > 256
    || value.externalProductId !== target.externalProductId
    || value.externalOptionId !== target.externalOptionId
    || !canonicalInstant(value.sourceStartAtUtc) || !canonicalInstant(value.sourceEndAtUtc)
    || value.sourceStartAtUtc < cycle.coverageFromUtc || value.sourceStartAtUtc >= cycle.coverageToUtc
    || Date.parse(value.sourceEndAtUtc) <= Date.parse(value.sourceStartAtUtc)
    || !["PENDING", "CONFIRMED", "CANCELLED"].includes(value.status)
    || !Number.isSafeInteger(value.seats) || value.seats < 1 || value.seats > 1000
    || (value.sourceUpdatedAtUtc !== undefined && !canonicalInstant(value.sourceUpdatedAtUtc))
    || (value.sourceRevision !== undefined && (typeof value.sourceRevision !== "string" || value.sourceRevision.length < 1 || value.sourceRevision.length > 256))) {
    throw new ContractError("INVALID_READER_RESPONSE");
  }
  return Object.freeze({ ...value });
}

function readerPage(value, target, cycle) {
  if (!isPlainObject(value) || !exactKeys(value, ["facts"], ["nextCursor", "snapshotToken", "terminal"])
    || !Array.isArray(value.facts) || value.facts.length > MAX_READER_FACTS
    || (value.nextCursor !== undefined && (typeof value.nextCursor !== "string" || value.nextCursor.length < 1 || value.nextCursor.length > MAX_SOURCE_CURSOR))
    || (value.snapshotToken !== undefined && (typeof value.snapshotToken !== "string" || value.snapshotToken.length < 1 || value.snapshotToken.length > MAX_SNAPSHOT_TOKEN))) {
    throw new ContractError("INVALID_READER_RESPONSE");
  }
  let readerBytes;
  try { readerBytes = bytes(value); } catch { throw new ContractError("INVALID_READER_RESPONSE"); }
  if (readerBytes > MAX_READER_PAGE_BYTES) throw new ContractError("INVALID_READER_RESPONSE");
  if ((value.nextCursor === undefined) === (value.terminal === undefined)) throw new ContractError("INVALID_READER_RESPONSE");
  let terminal;
  if (value.terminal !== undefined) {
    if (!isPlainObject(value.terminal)
      || !exactKeys(value.terminal, ["status", "allPagesRead", "allStatusesIncluded", "coverageComplete"])
      || !["COMPLETE", "PARTIAL", "FAILED"].includes(value.terminal.status)
      || typeof value.terminal.allPagesRead !== "boolean" || typeof value.terminal.allStatusesIncluded !== "boolean"
      || typeof value.terminal.coverageComplete !== "boolean"
      || (value.terminal.status === "COMPLETE" && !(value.terminal.allPagesRead && value.terminal.allStatusesIncluded && value.terminal.coverageComplete))
      || (value.terminal.status === "FAILED" && value.facts.length !== 0)) throw new ContractError("INVALID_READER_RESPONSE");
    terminal = Object.freeze({ ...value.terminal });
  }
  return Object.freeze({
    facts: Object.freeze(value.facts.map((item) => fact(item, target, cycle))),
    ...(value.nextCursor === undefined ? {} : { nextCursor: value.nextCursor }),
    ...(value.snapshotToken === undefined ? {} : { snapshotToken: value.snapshotToken }),
    ...(terminal ? { terminal } : {}),
  });
}

export function unsupportedReservationReaderFactory() {
  throw new ContractError("UNSUPPORTED_READER");
}

function classify(error) {
  const code = typeof error?.code === "string" ? error.code : "RESERVATION_READ_FAILED";
  if (["AUTH", "AUTH_REQUIRED", "CHALLENGE_REQUIRED"].includes(code)) {
    return { outcome: "AUTH_REQUIRED", halt: true, reason: code === "AUTH" ? "AUTH_REQUIRED" : code };
  }
  if (["INVALID_READER", "INVALID_READER_RESPONSE", "UNSUPPORTED_READER", "INVALID_RESPONSE", "HTTP_ERROR",
    "ACCOUNT_MISMATCH", "PRODUCT_MISMATCH", "DOM_DRIFT",
    "FACT_TOO_LARGE", "PAGE_TOO_LARGE", "PAGE_LIMIT", "FACT_LIMIT", "CURSOR_CYCLE", "SNAPSHOT_CHANGED"].includes(code)) {
    return { outcome: "NEEDS_REVIEW", halt: true, reason: code };
  }
  if (["DEADLINE_EXCEEDED", "LEASE_RENEW_FAILED", "NETWORK_ERROR", "TIMEOUT"].includes(code)) {
    return { outcome: "RETRY_WAIT", halt: false, reason: code };
  }
  return { outcome: "RETRY_WAIT", halt: false, reason: "RESERVATION_READ_FAILED" };
}

async function sendPage(cloud, job, payload, journal, assertGate, signal, cycle) {
  await guarded(journal.pendingReservationPage(payload), signal);
  assertGate();
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    assertGate();
    try {
      const receipt = await guarded(cloud.submitReservationWindowPage(job.id, payload), signal);
      assertGate();
      if (!isPlainObject(receipt) || receipt.receiptId !== payload.receiptId || receipt.readId !== payload.readId
        || receipt.generation !== cycle.generation || receipt.pageNumber !== payload.pageNumber
        || (payload.terminal === undefined && (typeof receipt.nextReceiptId !== "string" || receipt.terminalStatus !== undefined))
        || (payload.terminal !== undefined && (receipt.terminalStatus !== payload.terminal.status || receipt.nextReceiptId !== undefined))) {
        throw new ContractError("INVALID_RESPONSE");
      }
      await guarded(journal.reservationPageAcknowledged(payload.receiptId), signal);
      assertGate();
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
  renewEveryMs = 20_000, stopTimeoutMs = DEFAULT_STOP_TIMEOUT_MS, now = () => Date.now(),
}) {
  const controller = new AbortController();
  const deadlineMs = Math.min(Date.parse(job.deadlineAtUtc), now() + MAX_JOB_MS);
  let leaseExpiresMs = Date.parse(job.leaseExpiresAtUtc);
  let abortReason = null;
  let reader = null;
  let stopPromise = null;
  let setupStarted = false;
  const startStop = () => {
    if (stopPromise || !reader || typeof reader.stop !== "function") return stopPromise;
    try { stopPromise = Promise.resolve(reader.stop()).then((value) => value === true, () => false); } catch { stopPromise = Promise.resolve(false); }
    return stopPromise;
  };
  const abort = (error) => {
    if (!controller.signal.aborted) {
      abortReason = error;
      controller.abort(error);
      startStop();
    }
  };
  const assertGate = () => {
    if (controller.signal.aborted || now() >= deadlineMs || now() >= leaseExpiresMs) {
      const failure = abortReason ?? new ContractError(now() >= deadlineMs ? "DEADLINE_EXCEEDED" : "LEASE_RENEW_FAILED");
      abort(failure);
      throw failure;
    }
  };
  const deadlineTimer = setTimeout(() => abort(new ContractError("DEADLINE_EXCEEDED")), Math.max(0, deadlineMs - now()));
  const renewLoop = (async () => {
    for (;;) {
      const delay = Math.max(1, Math.min(renewEveryMs, Math.max(0, leaseExpiresMs - now() - 5_000)));
      if (!await wait(delay, controller.signal)) return;
      try {
        assertGate();
        const renewed = await guarded(cloud.renew(job), controller.signal);
        assertGate();
        leaseExpiresMs = Date.parse(renewed?.leaseExpiresAtUtc);
        if (!Number.isFinite(leaseExpiresMs) || leaseExpiresMs <= now() || leaseExpiresMs > deadlineMs) {
          throw new ContractError("LEASE_RENEW_FAILED");
        }
      } catch (error) {
        abort(error?.code === "DEADLINE_EXCEEDED" ? error : new ContractError("LEASE_RENEW_FAILED"));
        return;
      }
    }
  })();

  let outcome = "RETRY_WAIT";
  let reason = null;
  let halt = false;
  let reservationReadId;
  let reservationReceiptId;
  try {
    assertGate();
    // The fixed empty registry has no process to stop and must not consume a
    // read generation or leave the global browser lease uncertain.
    if (readerFactory === unsupportedReservationReaderFactory) throw new ContractError("UNSUPPORTED_READER");
    const cycle = await guarded(cloud.beginReservationWindow(job), controller.signal);
    assertGate();
    setupStarted = true;
    const factoryPromise = Promise.resolve().then(() => readerFactory({ target: job.target, config }));
    factoryPromise.then((created) => {
      if (controller.signal.aborted && created && typeof created.stop === "function") {
        Promise.resolve().then(() => created.stop()).catch(() => {});
      }
    }, () => {});
    reader = await guarded(factoryPromise, controller.signal);
    assertGate();
    if (!reader || typeof reader.readPage !== "function" || typeof reader.stop !== "function") throw new ContractError("INVALID_READER");
    if (controller.signal.aborted) startStop();

    let externalCursor;
    let wireCursor;
    let receiptId = cycle.receiptId;
    let pageNumber = 0;
    let totalFacts = 0;
    let snapshotInitialized = false;
    let snapshotToken;
    const seenExternalCursors = new Set();
    for (;;) {
      assertGate();
      const rawPage = await guarded(reader.readPage(Object.freeze({
        manifest: cycle.manifest,
        target: job.target,
        coverageFromUtc: cycle.coverageFromUtc,
        coverageToUtc: cycle.coverageToUtc,
        ...(externalCursor === undefined ? {} : { cursor: externalCursor }),
        signal: controller.signal,
      })), controller.signal);
      assertGate();
      const external = readerPage(rawPage, job.target, cycle);
      if (!snapshotInitialized) {
        snapshotInitialized = true;
        snapshotToken = external.snapshotToken;
      } else if (external.snapshotToken !== snapshotToken) {
        throw new ContractError("SNAPSHOT_CHANGED");
      }
      totalFacts += external.facts.length;
      if (totalFacts > MAX_TOTAL_FACTS) throw new ContractError("FACT_LIMIT");
      if (external.nextCursor !== undefined) {
        const cursorKey = digest(external.nextCursor);
        if (external.nextCursor === externalCursor || seenExternalCursors.has(cursorKey)) throw new ContractError("CURSOR_CYCLE");
        seenExternalCursors.add(cursorKey);
      }

      let offset = 0;
      do {
        if (pageNumber >= MAX_PAGES) throw new ContractError("PAGE_LIMIT");
        const chunk = [];
        while (offset + chunk.length < external.facts.length && chunk.length < MAX_FACTS) {
          const candidate = [...chunk, external.facts[offset + chunk.length]];
          const finalChunk = offset + candidate.length === external.facts.length;
          const terminal = finalChunk && external.terminal
            ? { ...external.terminal, completedAtUtc: new Date(now()).toISOString() } : undefined;
          const nextSourceCursor = finalChunk
            ? external.nextCursor === undefined ? undefined : opaqueCursor(external.nextCursor, 0)
            : opaqueCursor(externalCursor, offset + candidate.length);
          const probe = {
            receiptId, readId: cycle.readId, leaseToken: job.leaseToken, pageNumber,
            ...(pageNumber === 0 ? {} : { previousReceiptId: reservationReceiptId, sourceCursor: wireCursor }),
            ...(nextSourceCursor === undefined ? {} : { nextSourceCursor }),
            ...(snapshotToken === undefined ? {} : { snapshotToken }),
            observations: candidate,
            ...(terminal ? { terminal } : {}),
          };
          if (bytes(probe) > MAX_PAGE_BYTES) {
            if (candidate.length === 1) throw new ContractError("FACT_TOO_LARGE");
            break;
          }
          chunk.push(external.facts[offset + chunk.length]);
        }
        const finalChunk = offset + chunk.length === external.facts.length;
        const nextSourceCursor = finalChunk
          ? external.nextCursor === undefined ? undefined : opaqueCursor(external.nextCursor, 0)
          : opaqueCursor(externalCursor, offset + chunk.length);
        const terminal = finalChunk && external.terminal
          ? { ...external.terminal, completedAtUtc: new Date(now()).toISOString() } : undefined;
        if (pageNumber === MAX_PAGES - 1 && terminal === undefined) throw new ContractError("PAGE_LIMIT");
        const payload = Object.freeze({
          receiptId, readId: cycle.readId, leaseToken: job.leaseToken, pageNumber,
          ...(pageNumber === 0 ? {} : { previousReceiptId: reservationReceiptId, sourceCursor: wireCursor }),
          ...(nextSourceCursor === undefined ? {} : { nextSourceCursor }),
          ...(snapshotToken === undefined ? {} : { snapshotToken }),
          observations: Object.freeze(chunk),
          ...(terminal ? { terminal: Object.freeze(terminal) } : {}),
        });
        if ((payload.sourceCursor?.length ?? 0) > MAX_SOURCE_CURSOR || (payload.nextSourceCursor?.length ?? 0) > MAX_SOURCE_CURSOR
          || (payload.snapshotToken?.length ?? 0) > MAX_SNAPSHOT_TOKEN || chunk.length > MAX_FACTS || bytes(payload) > MAX_PAGE_BYTES) {
          throw new ContractError("PAGE_TOO_LARGE");
        }
        const receipt = await sendPage(cloud, job, payload, journal, assertGate, controller.signal, cycle);
        reservationReceiptId = receipt.receiptId;
        offset += chunk.length;
        wireCursor = nextSourceCursor;
        pageNumber += 1;
        if (terminal) {
          const verified = terminal.status === "COMPLETE" && receipt.terminalStatus === "COMPLETE"
            && receipt.healthUpdated === true && receipt.missingActiveReservations === 0
            && receipt.needsReview === 0 && receipt.stale === 0 && receipt.nextReceiptId === undefined;
          outcome = verified ? "RESERVATION_VERIFIED" : "RETRY_WAIT";
          if (verified) reservationReadId = cycle.readId;
          else { reservationReadId = undefined; reservationReceiptId = undefined; }
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
    outcome = failure.outcome;
    halt = failure.halt;
    reason = failure.reason;
    reservationReadId = undefined;
    reservationReceiptId = undefined;
  } finally {
    abort(abortReason ?? new ContractError("EXECUTION_COMPLETE"));
    clearTimeout(deadlineTimer);
    await renewLoop;
    startStop();
  }

  const stopped = !setupStarted || await boundedStop(stopPromise, stopTimeoutMs);
  if (!stopped) {
    outcome = "NEEDS_REVIEW";
    halt = true;
    reason = "PROCESS_STOP_UNCONFIRMED";
    reservationReadId = undefined;
    reservationReceiptId = undefined;
  } else if (outcome === "RESERVATION_VERIFIED" && Math.min(deadlineMs, leaseExpiresMs) - now() < 15_000) {
    outcome = "RETRY_WAIT";
    reason = "RESULT_WINDOW_TOO_SHORT";
    reservationReadId = undefined;
    reservationReceiptId = undefined;
  }
  return Object.freeze({
    outcome,
    stopped,
    observation: null,
    quarantine: outcome !== "RESERVATION_VERIFIED",
    halt,
    reason,
    reservationReadId,
    reservationReceiptId,
    modelInvocations: 0,
  });
}

export const reservationExecutorInternals = Object.freeze({
  bytes,
  opaqueCursor,
  readerPage,
  limits: Object.freeze({
    maxPageBytes: MAX_PAGE_BYTES,
    maxFacts: MAX_FACTS,
    maxReaderFacts: MAX_READER_FACTS,
    maxReaderPageBytes: MAX_READER_PAGE_BYTES,
    maxPages: MAX_PAGES,
    maxTotalFacts: MAX_TOTAL_FACTS,
  }),
});
