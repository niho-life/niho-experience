import type { ExperienceFeeSummary, ExperienceFeeSummaryAccounting, ExperienceFeeSummaryPolicy, ExperienceFeeSummaryResponse, ExperienceFeeSummaryStatus } from "./types.ts";

type JsonObject = Record<string, unknown>;

const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const STATUSES = ["LEGACY_NOT_RECORDED", "PREPARING", "PROCESSING_COST_PENDING", "PROCESSING", "RESULT_UNKNOWN", "REVIEW_REQUIRED", "SETTLED"] as const satisfies readonly ExperienceFeeSummaryStatus[];
const SUMMARY_KEYS = ["version", "bookingRequestId", "status", "feePolicy", "accounting", "needsAttention", "reason", "evidenceCheckedAt", "settledAt"] as const;
const POLICY_KEYS = ["supportEnabled", "totalRateBps", "originalGrossYen", "originalApplicationFeeYen", "processingFeesIncluded", "laborPaidDirectlyByHost"] as const;
const ACCOUNTING_KEYS = ["successfulRefundedYen", "pendingRefundedYen", "targetTotalFeeYen", "applicationFeeRefundedYen", "targetApplicationFeeRefundYen", "processingCompensatedYen", "targetProcessingCompensationYen", "hostRetainedAfterCreditsYen", "netNihoCashYen"] as const;

const isObject = (value: unknown): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);
const exact = (value: JsonObject, keys: readonly string[]) => Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key));
const text = (value: unknown): value is string => typeof value === "string" && !value.includes("\0") && (() => { try { encodeURIComponent(value); return true; } catch { return false; } })();
const dateTime = (value: unknown): value is string => text(value) && DATE_TIME.test(value) && Number.isFinite(Date.parse(value));
const nullableDateTime = (value: unknown): value is string | null => value === null || dateTime(value);
const nullableText = (value: unknown): value is string | null => value === null || text(value);
const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);
const nonNegative = (value: unknown): value is number => integer(value) && value >= 0;
const nullableNonNegative = (value: unknown): value is number | null => value === null || nonNegative(value);
const nullableInteger = (value: unknown): value is number | null => value === null || integer(value);

/** Safe path segment matching the selected contract's 1–200 Unicode code-point booking ID. */
export function isExperienceFeeSummaryBookingId(value: unknown): value is string {
  return text(value)
    && Array.from(value).length >= 1
    && Array.from(value).length <= 200
    && value !== "."
    && value !== ".."
    && !/[/\\%]/.test(value)
    && !Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}

function decodePolicy(value: unknown): ExperienceFeeSummaryPolicy | null {
  if (!isObject(value) || !exact(value, POLICY_KEYS)) return null;
  if (typeof value.supportEnabled !== "boolean") return null;
  if (value.totalRateBps !== 1000 && value.totalRateBps !== 1500) return null;
  if (!nonNegative(value.originalGrossYen) || !nonNegative(value.originalApplicationFeeYen)) return null;
  if (value.processingFeesIncluded !== true || value.laborPaidDirectlyByHost !== true) return null;
  return value as ExperienceFeeSummaryPolicy;
}

function decodeAccounting(value: unknown): ExperienceFeeSummaryAccounting | null {
  if (!isObject(value) || !exact(value, ACCOUNTING_KEYS)) return null;
  if (!nullableNonNegative(value.successfulRefundedYen) || !nullableNonNegative(value.pendingRefundedYen)) return null;
  if (!nullableNonNegative(value.targetTotalFeeYen) || !nullableNonNegative(value.applicationFeeRefundedYen) || !nullableNonNegative(value.targetApplicationFeeRefundYen)) return null;
  if (!nullableNonNegative(value.processingCompensatedYen) || !nullableNonNegative(value.targetProcessingCompensationYen)) return null;
  if (!nullableInteger(value.hostRetainedAfterCreditsYen) || !nullableInteger(value.netNihoCashYen)) return null;
  return value as ExperienceFeeSummaryAccounting;
}

export function decodeExperienceFeeSummaryResponse(value: unknown): ExperienceFeeSummaryResponse | null {
  if (!isObject(value) || !exact(value, ["feeSummary"]) || !isObject(value.feeSummary) || !exact(value.feeSummary, SUMMARY_KEYS)) return null;
  const summary = value.feeSummary;
  if (summary.version !== "1.0.0" || !isExperienceFeeSummaryBookingId(summary.bookingRequestId)) return null;
  if (!STATUSES.includes(summary.status as ExperienceFeeSummaryStatus) || typeof summary.needsAttention !== "boolean") return null;
  if (!nullableText(summary.reason) || !nullableDateTime(summary.evidenceCheckedAt) || !nullableDateTime(summary.settledAt)) return null;
  const feePolicy = summary.feePolicy === null ? null : decodePolicy(summary.feePolicy);
  const accounting = summary.accounting === null ? null : decodeAccounting(summary.accounting);
  if (summary.feePolicy !== null && !feePolicy) return null;
  if (summary.accounting !== null && !accounting) return null;
  return { feeSummary: { ...summary, feePolicy, accounting } as ExperienceFeeSummary };
}

