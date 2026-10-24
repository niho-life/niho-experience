import type {
  ExperienceAdminSupportAdmin,
  ExperienceAdminSupportAdminListResponse,
  ExperienceAdminSupportCase,
  ExperienceAdminSupportCaseAssignment,
  ExperienceAdminSupportCaseConflictReason,
  ExperienceAdminSupportCasePatchRequest,
  ExperienceAdminSupportCasePatchResponse,
  ExperienceAdminSupportCaseReadResponse,
  ExperienceAdminSupportCaseWriteCapability,
  ExperienceAdminSupportCaseWriteReason,
} from "./types.ts";

type JsonObject = Record<string, unknown>;

export const EXPERIENCE_ADMIN_SUPPORT_CASE_MAX_REVISION = 2_147_483_647;
export const EXPERIENCE_ADMIN_SUPPORT_CASE_MEMO_MAX_CODE_POINTS = 4_000;
export const EXPERIENCE_ADMIN_SUPPORT_CASE_ROSTER_MAX = 100;
export const EXPERIENCE_ADMIN_SUPPORT_CASE_WRITE_REASONS = [
  "WRITES_DISABLED",
  "SUPPORT_OFF",
  "SUPPORT_LEGACY",
  "SUPPORT_INVALID",
  "PII_RETENTION_EXPIRED",
] as const satisfies readonly ExperienceAdminSupportCaseWriteReason[];
export const EXPERIENCE_ADMIN_SUPPORT_CASE_CONFLICT_REASONS = [
  "REVISION_CONFLICT",
  "ASSIGNED_ADMIN_UNAVAILABLE",
  ...EXPERIENCE_ADMIN_SUPPORT_CASE_WRITE_REASONS,
] as const satisfies readonly ExperienceAdminSupportCaseConflictReason[];

const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const PATCH_KEYS = ["expectedRevision", "assignedAdminUserId", "internalMemo"] as const;

const isObject = (value: unknown): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);
const hasOnly = (value: JsonObject, keys: readonly string[]) => Object.keys(value).every((key) => keys.includes(key));
const hasExactly = (value: JsonObject, keys: readonly string[]) => Object.keys(value).length === keys.length && hasOnly(value, keys);
const codePoints = (value: string) => Array.from(value).length;
const isWellFormed = (value: string) => {
  try {
    encodeURIComponent(value);
    return true;
  } catch {
    return false;
  }
};
const isDateTime = (value: unknown): value is string => typeof value === "string" && DATE_TIME.test(value) && Number.isFinite(Date.parse(value));
const isNullableDateTime = (value: unknown): value is string | null => value === null || isDateTime(value);
const isRevision = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= EXPERIENCE_ADMIN_SUPPORT_CASE_MAX_REVISION;
const isOneOf = <T extends string>(values: readonly T[], value: unknown): value is T => typeof value === "string" && (values as readonly string[]).includes(value);

export function isExperienceAdminSupportCaseOpaqueId(value: unknown): value is string {
  return typeof value === "string" && isWellFormed(value) && codePoints(value) >= 1 && codePoints(value) <= 200;
}

export function isExperienceAdminSupportCasePathId(value: unknown): value is string {
  if (!isExperienceAdminSupportCaseOpaqueId(value) || value === "." || value === ".." || /[/\\%]/.test(value)) return false;
  return !Array.from(value).some((character) => {
    const point = character.codePointAt(0)!;
    return point < 32 || point === 127;
  });
}

function readAssignment(value: unknown): ExperienceAdminSupportCaseAssignment | null {
  if (!isObject(value) || typeof value.status !== "string") return null;
  if (value.status === "ACTIVE" && hasExactly(value, ["status", "id", "displayName"]) && isExperienceAdminSupportCaseOpaqueId(value.id) && (value.displayName === null || typeof value.displayName === "string")) {
    return { status: "ACTIVE", id: value.id, displayName: value.displayName };
  }
  if ((value.status === "UNASSIGNED" || value.status === "UNAVAILABLE") && hasExactly(value, ["status"])) return { status: value.status };
  return null;
}

function readSupportCase(value: unknown): ExperienceAdminSupportCase | null {
  if (!isObject(value) || !hasExactly(value, ["bookingRequestId", "assignedAdmin", "internalMemo", "revision", "createdAt", "updatedAt"])) return null;
  const assignedAdmin = readAssignment(value.assignedAdmin);
  const internalMemo = value.internalMemo;
  if (!isExperienceAdminSupportCaseOpaqueId(value.bookingRequestId) || !assignedAdmin || !(internalMemo === null || (typeof internalMemo === "string" && isWellFormed(internalMemo) && codePoints(internalMemo) >= 1 && codePoints(internalMemo) <= EXPERIENCE_ADMIN_SUPPORT_CASE_MEMO_MAX_CODE_POINTS)) || !isRevision(value.revision) || !isNullableDateTime(value.createdAt) || !isNullableDateTime(value.updatedAt)) return null;
  if ((value.createdAt === null) !== (value.updatedAt === null) || (value.revision === 0 && value.createdAt !== null)) return null;
  return { bookingRequestId: value.bookingRequestId, assignedAdmin, internalMemo, revision: value.revision, createdAt: value.createdAt, updatedAt: value.updatedAt };
}

function readWriteCapability(value: unknown): ExperienceAdminSupportCaseWriteCapability | null {
  if (!isObject(value) || !hasExactly(value, ["writable", "reason"])) return null;
  if (value.writable === true && value.reason === null) return { writable: true, reason: null };
  if (value.writable === false && isOneOf(EXPERIENCE_ADMIN_SUPPORT_CASE_WRITE_REASONS, value.reason)) return { writable: false, reason: value.reason };
  return null;
}

export function decodeExperienceAdminSupportCaseReadResponse(value: unknown): ExperienceAdminSupportCaseReadResponse | null {
  if (!isObject(value) || !hasExactly(value, ["supportCase", "writeCapability"])) return null;
  const supportCase = readSupportCase(value.supportCase);
  const writeCapability = readWriteCapability(value.writeCapability);
  return supportCase && writeCapability ? { supportCase, writeCapability } : null;
}

export function decodeExperienceAdminSupportCasePatchResponse(value: unknown): ExperienceAdminSupportCasePatchResponse | null {
  if (!isObject(value) || !hasExactly(value, ["supportCase"])) return null;
  const supportCase = readSupportCase(value.supportCase);
  return supportCase ? { supportCase } : null;
}

export function decodeExperienceAdminSupportAdminListResponse(value: unknown): ExperienceAdminSupportAdminListResponse | null {
  if (!isObject(value) || !hasExactly(value, ["admins", "truncated"]) || !Array.isArray(value.admins) || value.admins.length > EXPERIENCE_ADMIN_SUPPORT_CASE_ROSTER_MAX || typeof value.truncated !== "boolean") return null;
  const admins: ExperienceAdminSupportAdmin[] = [];
  const ids = new Set<string>();
  for (const item of value.admins) {
    if (!isObject(item) || !hasExactly(item, ["id", "displayName"]) || !isExperienceAdminSupportCaseOpaqueId(item.id) || !(item.displayName === null || typeof item.displayName === "string") || ids.has(item.id)) return null;
    ids.add(item.id);
    admins.push({ id: item.id, displayName: item.displayName });
  }
  return { admins, truncated: value.truncated };
}

export function decodeExperienceAdminSupportCasePatchRequest(value: unknown): ExperienceAdminSupportCasePatchRequest | null {
  if (!isObject(value) || !hasOnly(value, PATCH_KEYS) || !Object.hasOwn(value, "expectedRevision") || !isRevision(value.expectedRevision)) return null;
  const hasAssignee = Object.hasOwn(value, "assignedAdminUserId");
  const hasMemo = Object.hasOwn(value, "internalMemo");
  if (!hasAssignee && !hasMemo) return null;
  if (hasAssignee && !(value.assignedAdminUserId === null || isExperienceAdminSupportCaseOpaqueId(value.assignedAdminUserId))) return null;
  if (hasMemo && !(value.internalMemo === null || (typeof value.internalMemo === "string" && isWellFormed(value.internalMemo) && codePoints(value.internalMemo) <= EXPERIENCE_ADMIN_SUPPORT_CASE_MEMO_MAX_CODE_POINTS && !value.internalMemo.includes("\0")))) return null;
  return { ...value } as ExperienceAdminSupportCasePatchRequest;
}

export function decodeExperienceAdminSupportCaseConflictReason(value: unknown): ExperienceAdminSupportCaseConflictReason | null {
  if (!isObject(value) || !isObject(value.error) || !isObject(value.error.details)) return null;
  return isOneOf(EXPERIENCE_ADMIN_SUPPORT_CASE_CONFLICT_REASONS, value.error.details.reason) ? value.error.details.reason : null;
}
