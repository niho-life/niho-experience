import { MAX_JSON_BYTES } from "./constants.mjs";
import { ContractError, exactKeys, isPlainObject, validateClaim, validatePreflight } from "./validation.mjs";

export class CloudError extends Error {
  constructor(code, status) {
    super(code);
    this.name = "CloudError";
    this.code = code;
    this.status = status;
  }
}

async function boundedBytes(response, signal) {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const chunks = [];
  let size = 0;
  const aborted = new Promise((_, reject) => {
    if (signal.aborted) reject(new CloudError("TIMEOUT"));
    else signal.addEventListener("abort", () => reject(new CloudError("TIMEOUT")), { once: true });
  });
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      size += value.byteLength;
      if (size > MAX_JSON_BYTES) throw new CloudError("RESPONSE_TOO_LARGE");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

async function boundedJson(response, expectedKeys, signal) {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") throw new CloudError("INVALID_RESPONSE");
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_JSON_BYTES) throw new CloudError("RESPONSE_TOO_LARGE");
  let value;
  try {
    const bytes = await boundedBytes(response, signal);
    if (bytes.byteLength < 1) throw new CloudError("INVALID_RESPONSE");
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    if (error instanceof CloudError) throw error;
    throw new CloudError("INVALID_RESPONSE");
  }
  if (!isPlainObject(value) || (expectedKeys && !exactKeys(value, expectedKeys))) throw new CloudError("INVALID_RESPONSE");
  return value;
}

export function createCloudClient({ origin, token, fetchImpl = globalThis.fetch, timeoutMs = 10_000, now = () => Date.now() }) {
  const fixedOrigin = new URL(origin).origin;
  if (typeof token !== "string" || !token) throw new ContractError("INVALID_TOKEN");

  async function request(path, body, { allowIdle = false, responseKeys, requestTimeoutMs = timeoutMs } = {}) {
    const url = new URL(path, `${fixedOrigin}/`);
    if (url.origin !== fixedOrigin || !url.pathname.startsWith("/internal/ota/v1/")) throw new ContractError("INVALID_CLOUD_PATH");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    timer.unref?.();
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        redirect: "error",
        signal: controller.signal,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body),
      });
      if (response.redirected || new URL(response.url || url).origin !== fixedOrigin) throw new CloudError("REDIRECT_REFUSED", response.status);
      if (allowIdle && response.status === 204) {
        if ((await boundedBytes(response, controller.signal)).byteLength !== 0) throw new CloudError("INVALID_RESPONSE");
        return null;
      }
      if (response.status !== 200) throw new CloudError(response.status === 401 || response.status === 403 ? "AUTH" : response.status === 429 ? "RATE" : "HTTP_ERROR", response.status);
      return await boundedJson(response, responseKeys, controller.signal);
    } catch (error) {
      if (error instanceof CloudError) throw error;
      throw new CloudError(controller.signal.aborted || error?.name === "AbortError" ? "TIMEOUT" : "NETWORK_ERROR");
    } finally {
      clearTimeout(timer);
    }
  }

  return Object.freeze({
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
    async result(jobId, payload) {
      const value = await request(`internal/ota/v1/jobs/${encodeURIComponent(jobId)}/result`, payload,
        { responseKeys: ["acceptedAsCurrent", "repeated"] });
      if (typeof value.acceptedAsCurrent !== "boolean" || typeof value.repeated !== "boolean") throw new CloudError("INVALID_RESPONSE");
      return Object.freeze(value);
    },
  });
}
