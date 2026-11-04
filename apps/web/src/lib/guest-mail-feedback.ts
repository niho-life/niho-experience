import "server-only";
import type { Pool } from "pg";
import { GuestMailOutbox, type GuestMailDeliveryFeedback } from "@niho-experience/experience-store";
import { config } from "@/lib/config";
import { experiencePool } from "@/lib/experience/store-server";
import { verifyGoogleServiceIdentity, type GoogleServiceTokenVerifier } from "@/lib/google-service-identity";

const EVENT_ID = /^[A-Za-z0-9_-]{10,80}$/;
const DELIVERY_REF = /^ex1_[0-9a-f]{32}$/;
const CLASSIFICATIONS = new Set([
  "NO_SUCH_ADDRESS", "NO_SUCH_DOMAIN", "REJECTED_BY_SERVER", "MAILBOX_FULL", "TEMPORARY_FAILED", "SPAM_COMPLAINT", "OTHER",
]);
const KEYS = ["classification", "deliveryRef", "eventId", "reportType", "reportedAt", "verification"];
const MAX_BODY_BYTES = 2_048;

export interface GuestMailFeedbackSettings {
  readonly enabled: boolean;
  readonly audience: string;
  readonly serviceAccountEmail: string;
}

export interface GuestMailFeedbackDependencies {
  readonly settings?: GuestMailFeedbackSettings;
  readonly verifier?: GoogleServiceTokenVerifier;
  readonly pool?: () => Pool | null;
  readonly record?: (pool: Pool, feedback: GuestMailDeliveryFeedback) => Promise<"RECORDED" | "DUPLICATE" | "UNMATCHED">;
}

function response(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      "x-robots-tag": "noindex, nofollow",
    },
  });
}

async function readJson(request: Request): Promise<unknown | null> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return null;
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    return null;
  }
}

function feedback(value: unknown): GuestMailDeliveryFeedback | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== KEYS.length || keys.some((key, index) => key !== KEYS[index])) return null;
  if (typeof record.eventId !== "string" || !EVENT_ID.test(record.eventId)) return null;
  if (typeof record.deliveryRef !== "string" || !DELIVERY_REF.test(record.deliveryRef)) return null;
  if (record.reportType !== "BOUNCE" && record.reportType !== "COMPLAINT") return null;
  if (record.verification !== "CORRELATED_DSN" && record.verification !== "UNVERIFIED_ARF") return null;
  if (typeof record.classification !== "string" || !CLASSIFICATIONS.has(record.classification)) return null;
  if (typeof record.reportedAt !== "string") return null;
  const reportedAt = new Date(record.reportedAt);
  if (!Number.isFinite(reportedAt.getTime()) || reportedAt.toISOString() !== record.reportedAt) return null;
  const isBounce = record.reportType === "BOUNCE" && record.verification === "CORRELATED_DSN" && record.classification !== "SPAM_COMPLAINT";
  const isComplaint = record.reportType === "COMPLAINT" && record.verification === "UNVERIFIED_ARF" && record.classification === "SPAM_COMPLAINT";
  if (!isBounce && !isComplaint) return null;
  return {
    eventId: record.eventId,
    deliveryRef: record.deliveryRef,
    reportType: record.reportType,
    verification: record.verification,
    classification: record.classification as GuestMailDeliveryFeedback["classification"],
    reportedAt,
  };
}

/** NIHO callback for one verified DSN or an explicitly unverified ARF candidate. The event carries no PII. */
export async function guestMailFeedbackResponse(request: Request, dependencies: GuestMailFeedbackDependencies = {}): Promise<Response> {
  const settings = dependencies.settings ?? {
    enabled: config.guestMailFeedbackEnabled,
    audience: config.guestMailFeedbackAudience,
    serviceAccountEmail: config.guestMailFeedbackServiceAccountEmail,
  };
  if (!settings.enabled) return response({ error: "not_found" }, 404);
  const identity = await verifyGoogleServiceIdentity(request, settings, dependencies.verifier);
  if (!identity.ok) return response({ error: identity.kind === "outage" ? "identity_verification_unavailable" : "invalid_identity" }, identity.kind === "outage" ? 503 : 401);
  const input = feedback(await readJson(request));
  if (!input) return response({ error: "invalid_feedback" }, 400);
  const pool = (dependencies.pool ?? experiencePool)();
  if (!pool) return response({ error: "unavailable" }, 503);
  try {
    const result = await (dependencies.record ?? ((db, value) => new GuestMailOutbox(db).recordDeliveryFeedback(value)))(pool, input);
    if (result === "UNMATCHED") return response({ accepted: false, result }, 202);
    return response({ accepted: true, result });
  } catch (error) {
    console.error(`[experience-mail-feedback] event failed: ${error instanceof Error ? error.name : "unknown error"}`);
    return response({ error: "unavailable" }, 503);
  }
}
