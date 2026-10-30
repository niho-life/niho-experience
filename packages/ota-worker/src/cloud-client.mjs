import { MAX_JSON_BYTES } from "./constants.mjs";
import {
  ContractError, exactKeys, isGoogleDeliveryTarget, isPlainObject, validateClaim, validatePreflight, validateTarget,
} from "./validation.mjs";

export class CloudError extends Error {
  constructor(code, status) {
    super(code);
    this.name = "CloudError";
    this.code = code;
    this.status = status;
  }
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_MANIFEST_JSON_BYTES = 256 * 1024;
const GOOGLE_DELIVERY_TIMEOUT_MS = 60_000;
const GOOGLE_DELIVERY_PHASES = new Set(["DISPATCHING", "GOOGLE_VERIFIED", "UNCERTAIN", "NOT_MATCHED", "STOPPED"]);
const GOOGLE_DELIVERY_REASONS = new Set([
  "ANCHOR_MISSING", "TOMBSTONE", "CANCELLED_EVENT", "STATUS_MISMATCH", "ALL_DAY_EVENT", "FOREIGN_EVENT",
  "MAPPING_MISMATCH", "TIME_MISMATCH", "VISIBILITY_MISMATCH", "STALE_INTENT", "RECURRING_EVENT",
  "PRECONDITION_FAILED", "DESIRED_MISMATCH", "WRITE_UNCERTAIN", "AUTHORITY_CHANGED", "GOOGLE_UNAVAILABLE",
  "GOOGLE_REVOKED", "INVALID_RESPONSE", "NO_JOURNAL",
]);

function canonicalInstant(value) {
  const normalized = typeof value === "string" && value.endsWith("Z") && !value.includes(".") ? value.replace(/Z$/, ".000Z") : value;
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === normalized;
}

async function boundedBytes(response, signal, maxBytes = MAX_JSON_BYTES) {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const chunks = [];
  let size = 0;
  let abortListener;
  const aborted = new Promise((_, reject) => {
    if (signal.aborted) reject(new CloudError("TIMEOUT"));
    else {
      abortListener = () => reject(new CloudError("TIMEOUT"));
      signal.addEventListener("abort", abortListener, { once: true });
    }
  });
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new CloudError("RESPONSE_TOO_LARGE");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    if (abortListener) signal.removeEventListener("abort", abortListener);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

async function boundedJson(response, expectedKeys, signal, maxBytes = MAX_JSON_BYTES, optionalKeys = []) {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") throw new CloudError("INVALID_RESPONSE");
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > maxBytes) throw new CloudError("RESPONSE_TOO_LARGE");
  let value;
  try {
    const bytes = await boundedBytes(response, signal, maxBytes);
    if (bytes.byteLength < 1) throw new CloudError("INVALID_RESPONSE");
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    if (error instanceof CloudError) throw error;
    throw new CloudError("INVALID_RESPONSE");
  }
  if (!isPlainObject(value) || (expectedKeys && !exactKeys(value, expectedKeys, optionalKeys))) throw new CloudError("INVALID_RESPONSE");
  return value;
}

export function createCloudClient({ origin, token, fetchImpl = globalThis.fetch, timeoutMs = 10_000, now = () => Date.now() }) {
  const fixedOrigin = new URL(origin).origin;
  if (typeof token !== "string" || !token) throw new ContractError("INVALID_TOKEN");

  async function request(path, body, { allowIdle = false, responseKeys, requestTimeoutMs = timeoutMs,
    responseByteLimit = MAX_JSON_BYTES, responseOptionalKeys = [], signal } = {}) {
    const url = new URL(path, `${fixedOrigin}/`);
    if (url.origin !== fixedOrigin || !url.pathname.startsWith("/internal/ota/v1/")) throw new ContractError("INVALID_CLOUD_PATH");
    const controller = new AbortController();
    const abortFromCaller = () => controller.abort(signal?.reason);
    if (signal?.aborted) abortFromCaller();
    else signal?.addEventListener("abort", abortFromCaller, { once: true });
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    timer.unref?.();
    let requestAbortListener;
    try {
      if (controller.signal.aborted) throw new CloudError("TIMEOUT");
      const fetchPromise = Promise.resolve().then(() => {
        if (controller.signal.aborted) throw new CloudError("TIMEOUT");
        return fetchImpl(url, {
        method: "POST",
        redirect: "error",
        signal: controller.signal,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body),
        });
      });
      const aborted = new Promise((_, reject) => {
        requestAbortListener = () => reject(new CloudError("TIMEOUT"));
        if (controller.signal.aborted) requestAbortListener();
        else controller.signal.addEventListener("abort", requestAbortListener, { once: true });
      });
      const response = await Promise.race([fetchPromise, aborted]);
      if (response.redirected || new URL(response.url || url).origin !== fixedOrigin) throw new CloudError("REDIRECT_REFUSED", response.status);
      if (allowIdle && response.status === 204) {
        if ((await boundedBytes(response, controller.signal)).byteLength !== 0) throw new CloudError("INVALID_RESPONSE");
        return null;
      }
      if (response.status !== 200) throw new CloudError(response.status === 401 || response.status === 403 ? "AUTH" : response.status === 429 ? "RATE" : "HTTP_ERROR", response.status);
      return await boundedJson(response, responseKeys, controller.signal, responseByteLimit, responseOptionalKeys);
    } catch (error) {
      if (error instanceof CloudError) throw error;
      throw new CloudError(controller.signal.aborted || error?.name === "AbortError" ? "TIMEOUT" : "NETWORK_ERROR");
    } finally {
      clearTimeout(timer);
      if (requestAbortListener) controller.signal.removeEventListener("abort", requestAbortListener);
      signal?.removeEventListener("abort", abortFromCaller);
    }
  }

  return Object.freeze({
    async beginReservationWindow(job) {
      const value = await request(`internal/ota/v1/jobs/${encodeURIComponent(job.id)}/reservation-window-read`,
        { leaseToken: job.leaseToken }, {
          responseKeys: ["readId", "generation", "scope", "repeated", "coverageFromUtc", "coverageToUtc", "readStartedAtUtc", "pageNumber", "receiptId", "manifest"],
          responseByteLimit: MAX_MANIFEST_JSON_BYTES,
        });
      if (!UUID_V4.test(value.readId) || !UUID_V4.test(value.receiptId) || !Number.isSafeInteger(value.generation) || value.generation < 1
        || value.scope !== "WINDOW" || typeof value.repeated !== "boolean" || value.pageNumber !== 0
        || !canonicalInstant(value.coverageFromUtc) || !canonicalInstant(value.coverageToUtc) || !canonicalInstant(value.readStartedAtUtc)
        || Date.parse(value.coverageToUtc) <= Date.parse(value.coverageFromUtc)
        || Date.parse(value.coverageToUtc) - Date.parse(value.coverageFromUtc) !== 62 * 24 * 60 * 60 * 1_000
        || !Array.isArray(value.manifest) || value.manifest.length > 512) throw new CloudError("INVALID_RESPONSE");
      const occurrenceIds = new Set();
      let previous = "";
      for (const item of value.manifest) {
        if (!exactKeys(item, ["occurrenceId", "sourceStartAtUtc", "sourceEndAtUtc"])
          || typeof item.occurrenceId !== "string" || item.occurrenceId.length < 1 || item.occurrenceId.length > 256
          || occurrenceIds.has(item.occurrenceId) || !canonicalInstant(item.sourceStartAtUtc) || !canonicalInstant(item.sourceEndAtUtc)
          || item.sourceStartAtUtc < value.coverageFromUtc || item.sourceStartAtUtc >= value.coverageToUtc
          || item.sourceEndAtUtc <= item.sourceStartAtUtc) throw new CloudError("INVALID_RESPONSE");
        const order = `${item.sourceStartAtUtc}\n${item.sourceEndAtUtc}\n${item.occurrenceId}`;
        if (order < previous) throw new CloudError("INVALID_RESPONSE");
        previous = order;
        occurrenceIds.add(item.occurrenceId);
      }
      return Object.freeze({ ...value, manifest: Object.freeze(value.manifest.map((item) => Object.freeze({ ...item }))) });
    },
    async submitReservationWindowPage(jobId, payload) {
      const value = await request(`internal/ota/v1/jobs/${encodeURIComponent(jobId)}/reservation-window-pages`, payload);
      const required = ["receiptId", "readId", "generation", "pageNumber", "applied", "duplicates", "duplicateFacts", "stale", "needsReview", "missingActiveReservations", "healthUpdated", "repeated"];
      if (!exactKeys(value, required, ["terminalStatus", "nextReceiptId"])
        || !UUID_V4.test(value.receiptId) || !UUID_V4.test(value.readId) || !Number.isSafeInteger(value.generation) || value.generation < 1
        || !Number.isSafeInteger(value.pageNumber) || value.pageNumber < 0
        || !["applied", "duplicates", "duplicateFacts", "stale", "needsReview", "missingActiveReservations"].every((key) => Number.isSafeInteger(value[key]) && value[key] >= 0)
        || typeof value.healthUpdated !== "boolean" || typeof value.repeated !== "boolean"
        || (value.terminalStatus !== undefined && !["COMPLETE", "PARTIAL", "FAILED"].includes(value.terminalStatus))
        || (value.nextReceiptId !== undefined && !UUID_V4.test(value.nextReceiptId))
        || (value.terminalStatus === undefined) === (value.nextReceiptId === undefined)) throw new CloudError("INVALID_RESPONSE");
      return Object.freeze(value);
    },
    async triggerResourceGoogleSync() {
      try {
        const value = await request("internal/ota/v1/google-sync", {}, { responseKeys: ["processed", "applied"], requestTimeoutMs: 25_000 });
        if (typeof value.processed !== "boolean" || typeof value.applied !== "boolean") throw new CloudError("INVALID_RESPONSE");
        return Object.freeze(value);
      } catch (error) {
        // Older cloud revisions and a closed feature flag must not block OTA jobs.
        if (error instanceof CloudError && error.code === "HTTP_ERROR" && error.status === 404) return Object.freeze({ processed: false, applied: false });
        throw error;
      }
    },
    async claimAllowIdle() {
      const value = await request("internal/ota/v1/claim", {}, { allowIdle: true, responseKeys: ["job"] });
      if (!value) return null;
      return validateClaim(value.job, now());
    },
    async renew(job) {
      const value = await request(`internal/ota/v1/jobs/${encodeURIComponent(job.id)}/renew`, { leaseToken: job.leaseToken }, { responseKeys: ["leaseExpiresAtUtc"] });
      const expiresMs = typeof value.leaseExpiresAtUtc === "string" ? Date.parse(value.leaseExpiresAtUtc) : NaN;
      if (!Number.isFinite(expiresMs) || new Date(expiresMs).toISOString() !== value.leaseExpiresAtUtc
        || expiresMs <= now() || expiresMs > Date.parse(job.deadlineAtUtc)) throw new CloudError("INVALID_RESPONSE");
      return value;
    },
    async preflight(job) {
      const value = await request(`internal/ota/v1/jobs/${encodeURIComponent(job.id)}/preflight`, { leaseToken: job.leaseToken }, { responseKeys: ["ready", "desiredState"] });
      return validatePreflight(value, job.desiredState);
    },
    async googleDelivery(job, operation, { signal } = {}) {
      if (!isGoogleDeliveryTarget(validateTarget(job.target)) || job.purpose === "RESERVATION_WINDOW") {
        throw new ContractError("INVALID_GOOGLE_DELIVERY_TARGET");
      }
      const expectedOperation = job.action === "OBSERVE" ? "reconcile"
        : ["SET_OPEN", "SET_CLOSED"].includes(job.action) ? "dispatch" : null;
      if (!expectedOperation || operation !== expectedOperation) throw new ContractError("INVALID_GOOGLE_DELIVERY_OPERATION");
      const remainingMs = Date.parse(job.deadlineAtUtc) - now();
      if (!Number.isFinite(remainingMs) || remainingMs <= 0) throw new CloudError("TIMEOUT");
      const value = await request(`internal/ota/v1/jobs/${encodeURIComponent(job.id)}/google-delivery`,
        { leaseToken: job.leaseToken, operation }, {
          responseKeys: ["deliveryId", "phase", "airbnb"],
          responseOptionalKeys: ["reason"],
          requestTimeoutMs: Math.max(1, Math.min(GOOGLE_DELIVERY_TIMEOUT_MS, remainingMs)),
          signal,
        });
      if (!UUID_V4.test(value.deliveryId) || !GOOGLE_DELIVERY_PHASES.has(value.phase) || value.airbnb !== "UNVERIFIED"
        || (value.reason !== undefined && !GOOGLE_DELIVERY_REASONS.has(value.reason))) throw new CloudError("INVALID_RESPONSE");
      return Object.freeze(value);
    },
    async result(jobId, payload) {
      const value = await request(`internal/ota/v1/jobs/${encodeURIComponent(jobId)}/result`, payload,
        { responseKeys: ["acceptedAsCurrent", "repeated"] });
      if (typeof value.acceptedAsCurrent !== "boolean" || typeof value.repeated !== "boolean") throw new CloudError("INVALID_RESPONSE");
      return Object.freeze(value);
    },
  });
}
