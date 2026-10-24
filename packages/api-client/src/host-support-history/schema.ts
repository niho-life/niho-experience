import type { ExperienceHostSupportCommunication, ExperienceHostSupportHistoryDetail, ExperienceHostSupportHistoryDetailResponse, ExperienceHostSupportHistoryItem, ExperienceHostSupportHistoryResponse } from "./types.ts";
type JsonObject = Record<string, unknown>;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isObject = (value: unknown): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);
const exact = (value: JsonObject, keys: readonly string[]) => Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key));
const text = (value: unknown): value is string => typeof value === "string" && !value.includes("\0") && (() => { try { encodeURIComponent(value); return true; } catch { return false; } })();
const dateTime = (value: unknown): value is string => text(value) && DATE_TIME.test(value) && Number.isFinite(Date.parse(value));
const nullableDateTime = (value: unknown): value is string | null => value === null || dateTime(value);
const nullableText = (value: unknown): value is string | null => value === null || text(value);
const nullableYen = (value: unknown): value is number | null => value === null || (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 2_147_483_647);
const oneOf = <T extends string>(values: readonly T[], value: unknown): value is T => typeof value === "string" && values.includes(value as T);
const ACTIONS = ["APPROVE", "DECLINE", "CANCEL", "MESSAGE"] as const;
const STATES = ["ACCEPTED", "PROCESSING", "UNKNOWN", "SUCCEEDED", "REJECTED", "FAILED"] as const;
const DELIVERY = ["PENDING", "SENT", "FAILED", "UNKNOWN"] as const;
export const isExperienceHostSupportHistoryPathId = (value: unknown): value is string => text(value) && Array.from(value).length >= 1 && Array.from(value).length <= 200 && value !== "." && value !== ".." && !/[/\\%]/.test(value) && !Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
export const isExperienceHostSupportHistoryOperationId = (value: unknown): value is string => typeof value === "string" && UUID.test(value);

function item(value: unknown): ExperienceHostSupportHistoryItem | null {
  const keys = ["operationId", "bookingRequestId", "action", "actorKind", "reasonCode", "state", "resultCode", "resultStatus", "resultRefundedYen", "hasMessage", "createdAt", "completedAt"];
  if (!isObject(value) || !exact(value, keys) || !isExperienceHostSupportHistoryOperationId(value.operationId) || !isExperienceHostSupportHistoryPathId(value.bookingRequestId) || !oneOf(ACTIONS, value.action) || value.actorKind !== "NIHO_SUPPORT" || !nullableText(value.reasonCode) || !oneOf(STATES, value.state) || !nullableText(value.resultCode) || !nullableText(value.resultStatus) || !nullableYen(value.resultRefundedYen) || typeof value.hasMessage !== "boolean" || !dateTime(value.createdAt) || !nullableDateTime(value.completedAt)) return null;
  return value as ExperienceHostSupportHistoryItem;
}

function communication(value: unknown): ExperienceHostSupportCommunication | undefined {
  if (value === null) return null;
  if (!isObject(value) || !exact(value, ["messageId", "subject", "body", "retained", "deliveryStatus"]) || !nullableText(value.messageId) || !nullableText(value.subject) || !nullableText(value.body) || typeof value.retained !== "boolean" || !(value.deliveryStatus === null || oneOf(DELIVERY, value.deliveryStatus))) return undefined;
  return value as ExperienceHostSupportCommunication;
}

export function decodeExperienceHostSupportHistoryResponse(value: unknown): ExperienceHostSupportHistoryResponse | null {
  if (!isObject(value) || !exact(value, ["bookingRequestId", "operations", "history"]) || !isExperienceHostSupportHistoryPathId(value.bookingRequestId) || !Array.isArray(value.operations) || value.operations.length > 50 || !isObject(value.history) || !exact(value.history, ["limit", "truncated"]) || value.history.limit !== 50 || typeof value.history.truncated !== "boolean") return null;
  const operations = value.operations.map(item); if (operations.some((operation) => operation === null)) return null;
  return { bookingRequestId: value.bookingRequestId, operations: operations as ExperienceHostSupportHistoryItem[], history: { limit: 50, truncated: value.history.truncated } };
}

export function decodeExperienceHostSupportHistoryDetailResponse(value: unknown): ExperienceHostSupportHistoryDetailResponse | null {
  if (!isObject(value) || !exact(value, ["operation"]) || !isObject(value.operation)) return null;
  if (!exact(value.operation, ["operationId", "bookingRequestId", "action", "actorKind", "reasonCode", "state", "resultCode", "resultStatus", "resultRefundedYen", "communication", "createdAt", "completedAt"])) return null;
  const base = item({ operationId: value.operation.operationId, bookingRequestId: value.operation.bookingRequestId, action: value.operation.action, actorKind: value.operation.actorKind, reasonCode: value.operation.reasonCode, state: value.operation.state, resultCode: value.operation.resultCode, resultStatus: value.operation.resultStatus, resultRefundedYen: value.operation.resultRefundedYen, hasMessage: value.operation.communication !== null, createdAt: value.operation.createdAt, completedAt: value.operation.completedAt });
  if (!base) return null;
  const decodedCommunication = communication(value.operation.communication); if (decodedCommunication === undefined) return null;
  const { hasMessage: _hasMessage, ...rest } = base;
  return { operation: { ...rest, communication: decodedCommunication } as ExperienceHostSupportHistoryDetail };
}
