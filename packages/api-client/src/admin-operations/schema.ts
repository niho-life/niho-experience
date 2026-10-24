import type {
  ExperienceAdminApproveRequest,
  ExperienceAdminCancelRequest,
  ExperienceAdminDeclineRequest,
  ExperienceAdminMessageRequest,
  ExperienceAdminOperationAction,
  ExperienceAdminOperationRequest,
  ExperienceAdminSupportOperation,
  ExperienceAdminSupportOperationBookingSnapshot,
  ExperienceAdminSupportOperationDetailResponse,
  ExperienceAdminSupportOperationError,
  ExperienceAdminSupportOperationMessage,
  ExperienceAdminSupportOperationSnapshotResponse,
} from "./types.ts";

type JsonObject = Record<string, unknown>;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const isObject = (value: unknown): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);
const exact = (value: JsonObject, keys: readonly string[]) => Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key));
const oneOf = <T extends string>(values: readonly T[], value: unknown): value is T => typeof value === "string" && values.includes(value as T);
const integer = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 2_147_483_647;
const finiteString = (value: unknown): value is string => typeof value === "string" && !value.includes("\0") && (() => { try { encodeURIComponent(value); return true; } catch { return false; } })();
const dateTime = (value: unknown): value is string => finiteString(value) && DATE_TIME.test(value) && Number.isFinite(Date.parse(value));
const nullableDateTime = (value: unknown): value is string | null => value === null || dateTime(value);
const uuid = (value: unknown): value is string => typeof value === "string" && UUID.test(value);
export const isExperienceAdminOperationId = (value: unknown): value is string => typeof value === "string" && UUID_V4.test(value);
export const isExperienceAdminOperationsPathId = (value: unknown): value is string => finiteString(value) && Array.from(value).length >= 1 && Array.from(value).length <= 200 && value !== "." && value !== ".." && !/[/\\%]/.test(value) && !Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);

const ACTIONS = ["APPROVE", "DECLINE", "CANCEL", "MESSAGE"] as const;
const STATES = ["ACCEPTED", "PROCESSING", "UNKNOWN", "SUCCEEDED", "REJECTED", "FAILED"] as const;
const DELIVERY = ["PENDING", "SENT", "FAILED", "UNKNOWN"] as const;

function decodeMessage(value: unknown): ExperienceAdminSupportOperationMessage | undefined {
  if (value === null) return null;
  if (!isObject(value) || !exact(value, ["messageId", "subject", "body", "retained", "deliveryStatus"])) return undefined;
  if (!(value.messageId === null || finiteString(value.messageId)) || !(value.subject === null || finiteString(value.subject)) || !(value.body === null || finiteString(value.body)) || typeof value.retained !== "boolean" || !(value.deliveryStatus === null || oneOf(DELIVERY, value.deliveryStatus))) return undefined;
  return value as ExperienceAdminSupportOperationMessage;
}

export function decodeExperienceAdminSupportOperation(value: unknown): ExperienceAdminSupportOperation | null {
  const keys = ["operationId", "bookingRequestId", "action", "actorKind", "expectedRevision", "expectedStatus", "expectedTotalYen", "expectedRefundedYen", "expectedProviderRefundedYen", "requestedRefundAmountYen", "reasonCode", "state", "resultCode", "resultStatus", "resultRefundedYen", "message", "retryAllowed", "firstExternalAttemptAt", "lastReconciledAt", "createdAt", "updatedAt", "completedAt"];
  if (!isObject(value) || !exact(value, keys) || !uuid(value.operationId) || !isExperienceAdminOperationsPathId(value.bookingRequestId) || !oneOf(ACTIONS, value.action) || value.actorKind !== "NIHO_SUPPORT" || !integer(value.expectedRevision) || !finiteString(value.expectedStatus) || !integer(value.expectedTotalYen) || !integer(value.expectedRefundedYen) || !(value.expectedProviderRefundedYen === null || integer(value.expectedProviderRefundedYen)) || !(value.requestedRefundAmountYen === null || integer(value.requestedRefundAmountYen)) || !(value.reasonCode === null || finiteString(value.reasonCode)) || !oneOf(STATES, value.state) || !(value.resultCode === null || finiteString(value.resultCode)) || !(value.resultStatus === null || finiteString(value.resultStatus)) || !(value.resultRefundedYen === null || integer(value.resultRefundedYen)) || typeof value.retryAllowed !== "boolean" || !nullableDateTime(value.firstExternalAttemptAt) || !nullableDateTime(value.lastReconciledAt) || !dateTime(value.createdAt) || !dateTime(value.updatedAt) || !nullableDateTime(value.completedAt)) return null;
  const message = decodeMessage(value.message);
  if (message === undefined) return null;
  return { ...value, message } as ExperienceAdminSupportOperation;
}

function decodeCapability(value: unknown) {
  if (!isObject(value) || !exact(value, ["allowed", "reason"]) || typeof value.allowed !== "boolean" || !(value.reason === null || finiteString(value.reason))) return null;
  return { allowed: value.allowed, reason: value.reason };
}

export function decodeExperienceAdminSupportOperationBookingSnapshot(value: unknown): ExperienceAdminSupportOperationBookingSnapshot | null {
  const keys = ["bookingRequestId", "revision", "updatedAt", "host", "guest", "status", "totalYen", "refundedYen", "providerRefund", "refundOptions", "occurrenceDate", "startAt", "endAt", "approvalDeadlineAt", "actions"];
  if (!isObject(value) || !exact(value, keys) || !isExperienceAdminOperationsPathId(value.bookingRequestId) || !integer(value.revision) || !dateTime(value.updatedAt) || !finiteString(value.status) || !integer(value.totalYen) || !integer(value.refundedYen) || !finiteString(value.occurrenceDate) || !DATE.test(value.occurrenceDate) || !dateTime(value.startAt) || !dateTime(value.endAt) || !nullableDateTime(value.approvalDeadlineAt)) return null;
  if (!isObject(value.host) || !finiteString(value.host.id) || Array.from(value.host.id).length < 1 || Array.from(value.host.id).length > 200 || !finiteString(value.host.displayName)) return null;
  if (value.host.kind === "SPOT") { if (!exact(value.host, ["kind", "id", "displayName"])) return null; }
  else if (value.host.kind === "EXPERIENCE_PROVIDER") { if (!exact(value.host, ["kind", "id", "displayName", "vesselSpotId"]) || !finiteString(value.host.vesselSpotId) || Array.from(value.host.vesselSpotId).length < 1 || Array.from(value.host.vesselSpotId).length > 200) return null; }
  else return null;
  if (!isObject(value.guest) || !exact(value.guest, ["displayName"]) || !finiteString(value.guest.displayName)) return null;
  if (!isObject(value.providerRefund) || !exact(value.providerRefund, ["status", "refundedYen", "observedAt"]) || !oneOf(["KNOWN", "NOT_APPLICABLE", "UNAVAILABLE"] as const, value.providerRefund.status) || !(value.providerRefund.refundedYen === null || integer(value.providerRefund.refundedYen)) || !dateTime(value.providerRefund.observedAt)) return null;
  if (!Array.isArray(value.refundOptions) || value.refundOptions.length > 3 || value.refundOptions.some((option) => !isObject(option) || !exact(option, ["choice", "refundAmountYen", "resultRefundedYen"]) || !oneOf(["FULL", "HALF", "NONE"] as const, option.choice) || !integer(option.refundAmountYen) || !integer(option.resultRefundedYen))) return null;
  if (!isObject(value.actions) || !exact(value.actions, ["approve", "decline", "cancel", "message"])) return null;
  const approve = decodeCapability(value.actions.approve); const decline = decodeCapability(value.actions.decline); const cancel = decodeCapability(value.actions.cancel); const message = decodeCapability(value.actions.message);
  if (!approve || !decline || !cancel || !message) return null;
  return { ...value, actions: { approve, decline, cancel, message } } as ExperienceAdminSupportOperationBookingSnapshot;
}

export function decodeExperienceAdminSupportOperationDetailResponse(value: unknown): ExperienceAdminSupportOperationDetailResponse | null {
  if (!isObject(value) || !exact(value, ["operation"])) return null;
  const operation = decodeExperienceAdminSupportOperation(value.operation);
  return operation ? { operation } : null;
}

export function decodeExperienceAdminSupportOperationError(value: unknown): ExperienceAdminSupportOperationError | null {
  if (!isObject(value) || !exact(value, ["error"]) || !isObject(value.error) || !exact(value.error, ["code", "message", "details"]) || !finiteString(value.error.code) || !finiteString(value.error.message) || !isObject(value.error.details)) return null;
  return value as ExperienceAdminSupportOperationError;
}

export function decodeExperienceAdminSupportOperationSnapshotResponse(value: unknown): ExperienceAdminSupportOperationSnapshotResponse | null {
  if (!isObject(value) || !exact(value, ["booking", "operations", "history"]) || !Array.isArray(value.operations) || value.operations.length > 50 || !isObject(value.history) || !exact(value.history, ["limit", "truncated"]) || value.history.limit !== 50 || typeof value.history.truncated !== "boolean") return null;
  const booking = decodeExperienceAdminSupportOperationBookingSnapshot(value.booking);
  const operations = value.operations.map(decodeExperienceAdminSupportOperation);
  if (!booking || operations.some((operation) => operation === null)) return null;
  return { booking, operations: operations as ExperienceAdminSupportOperation[], history: { limit: 50, truncated: value.history.truncated } };
}

function requestBase(value: JsonObject, keys: readonly string[]) {
  return exact(value, keys) && isExperienceAdminOperationId(value.operationId) && integer(value.expectedRevision) && finiteString(value.expectedStatus) && integer(value.expectedTotalYen) && integer(value.expectedRefundedYen);
}

export function decodeExperienceAdminOperationRequest(action: ExperienceAdminOperationAction, value: unknown): ExperienceAdminOperationRequest | null {
  if (!isObject(value)) return null;
  if (action === "APPROVE" && requestBase(value, ["operationId", "expectedRevision", "expectedStatus", "expectedTotalYen", "expectedRefundedYen", "reasonCode"]) && value.expectedStatus === "PROVISIONAL" && oneOf(["HOST_CONFIRMED", "SUPPORT_REVIEWED"] as const, value.reasonCode)) return value as ExperienceAdminApproveRequest;
  if (action === "DECLINE" && requestBase(value, ["operationId", "expectedRevision", "expectedStatus", "expectedTotalYen", "expectedRefundedYen", "reasonCode"]) && value.expectedStatus === "PROVISIONAL" && oneOf(["HOST_CANNOT_HOST", "OTHER"] as const, value.reasonCode)) return value as ExperienceAdminDeclineRequest;
  if (action === "MESSAGE" && requestBase(value, ["operationId", "expectedRevision", "expectedStatus", "expectedTotalYen", "expectedRefundedYen", "reasonCode", "subject", "body"]) && oneOf(["PROVISIONAL", "CONFIRMED", "REFUND_NEEDED", "CANCELLED"] as const, value.expectedStatus) && oneOf(["BOOKING_DETAILS", "SCHEDULE_COORDINATION", "OTHER"] as const, value.reasonCode) && finiteString(value.subject) && Array.from(value.subject).length >= 1 && Array.from(value.subject).length <= 200 && finiteString(value.body) && Array.from(value.body).length >= 1 && Array.from(value.body).length <= 4000) return value as ExperienceAdminMessageRequest;
  if (action === "CANCEL" && requestBase(value, ["operationId", "expectedRevision", "expectedStatus", "expectedTotalYen", "expectedRefundedYen", "expectedProviderRefundedYen", "expectedRefundAmountYen", "refund", "reasonCode", "message"]) && oneOf(["CONFIRMED", "REFUND_NEEDED"] as const, value.expectedStatus) && integer(value.expectedProviderRefundedYen) && integer(value.expectedRefundAmountYen) && oneOf(["FULL", "HALF", "NONE"] as const, value.refund) && oneOf(["HOST_CANNOT_HOST", "GUEST_REQUEST", "OTHER"] as const, value.reasonCode) && finiteString(value.message) && Array.from(value.message).length >= 1 && Array.from(value.message).length <= 2000) return value as ExperienceAdminCancelRequest;
  return null;
}
