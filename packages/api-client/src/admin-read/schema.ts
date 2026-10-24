import type {
  ExperienceAdminBookingAnswer,
  ExperienceAdminBookingDetail,
  ExperienceAdminBookingDetailResponse,
  ExperienceAdminBookingHost,
  ExperienceAdminBookingHostMessage,
  ExperienceAdminBookingListItem,
  ExperienceAdminBookingListResponse,
  ExperienceAdminBookingQuery,
  ExperienceAdminBookingStatus,
  ExperienceAdminNotification,
  ExperienceAdminNotificationListResponse,
  ExperienceAdminNotificationQuery,
  ExperienceAdminNotificationReadRequest,
  ExperienceAdminNotificationReadResponse,
  ExperienceAdminNotificationType,
  ExperienceAdminSupportSnapshotRead,
} from "./types.ts";

type JsonObject = Record<string, unknown>;

export const EXPERIENCE_ADMIN_BOOKING_STATUSES = ["PENDING", "PAYMENT_PENDING", "PROVISIONAL", "CONFIRMED", "DECLINED", "EXPIRED", "CANCELLED", "REFUND_NEEDED"] as const satisfies readonly ExperienceAdminBookingStatus[];
export const EXPERIENCE_ADMIN_NOTIFICATION_TYPES = ["APPLICATION_RECEIVED", "BOOKING_CONFIRMED", "BOOKING_DECLINED", "BOOKING_EXPIRED", "BOOKING_CANCELLED", "REFUND_NEEDED", "TRAVELER_CANCEL_REQUESTED"] as const satisfies readonly ExperienceAdminNotificationType[];
export const EXPERIENCE_ADMIN_NOTIFICATION_IDS_MAX = 64;
export const isExperienceAdminOpaqueId = (value: unknown): value is string => typeof value === "string" && value.length >= 1 && value.length <= 200;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const BOOKING_QUERY_KEYS = ["attention", "cursor", "fromDate", "hostId", "hostSearch", "limit", "search", "status", "support", "toDate"] as const;
const NOTIFICATION_QUERY_KEYS = ["cursor", "unread", "limit"] as const;

const isObject = (value: unknown): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === "string";
const isNullableString = (value: unknown): value is string | null => value === null || typeof value === "string";
const isInteger = (value: unknown, min = 0): value is number => typeof value === "number" && Number.isInteger(value) && value >= min;
const isOneOf = <T extends string>(values: readonly T[], value: unknown): value is T => typeof value === "string" && (values as readonly string[]).includes(value);
const isId = isExperienceAdminOpaqueId;
const isCursor = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 2048;
const isDateTime = (value: unknown): value is string => typeof value === "string" && DATE_TIME.test(value) && Number.isFinite(Date.parse(value));
const isNullableDateTime = (value: unknown): value is string | null => value === null || isDateTime(value);
const isDate = (value: unknown): value is string => {
  if (typeof value !== "string" || !DATE.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year!, month! - 1, day!));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() + 1 === month && parsed.getUTCDate() === day;
};

function hasOnly(value: JsonObject, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function hasExactly(value: JsonObject, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && hasOnly(value, keys);
}

function readArray<T>(value: unknown, read: (item: unknown) => T | null): T[] | null {
  if (!Array.isArray(value)) return null;
  const result: T[] = [];
  for (const item of value) {
    const decoded = read(item);
    if (decoded === null) return null;
    result.push(decoded);
  }
  return result;
}

function readHost(value: unknown): ExperienceAdminBookingHost | null {
  if (!isObject(value) || !isId(value.id) || !isString(value.displayName)) return null;
  if (value.kind === "SPOT" && hasExactly(value, ["kind", "id", "displayName"])) return { kind: "SPOT", id: value.id, displayName: value.displayName };
  if (value.kind === "EXPERIENCE_PROVIDER" && hasExactly(value, ["kind", "id", "displayName", "vesselSpotId"]) && isId(value.vesselSpotId)) {
    return { kind: "EXPERIENCE_PROVIDER", id: value.id, displayName: value.displayName, vesselSpotId: value.vesselSpotId };
  }
  return null;
}

function readSupport(value: unknown): ExperienceAdminSupportSnapshotRead | null {
  if (!isObject(value) || !hasExactly(value, ["kind", "snapshot", "normalOperationsAllowed"])) return null;
  if (value.kind === "legacy" || value.kind === "invalid") {
    return value.snapshot === null && value.normalOperationsAllowed === false
      ? { kind: value.kind, snapshot: null, normalOperationsAllowed: false }
      : null;
  }
  if (value.kind !== "valid" || !isObject(value.snapshot) || typeof value.normalOperationsAllowed !== "boolean") return null;
  const snapshot = value.snapshot;
  if (!hasExactly(snapshot, ["policyVersion", "enabled", "baseRateBps", "supportRateBps", "totalRateBps", "consentVersion", "consentedAt", "consentedByUserId", "agreementRevision"])) return null;
  if (snapshot.policyVersion !== "2026-10-23" || snapshot.consentVersion !== "2026-10-23" || snapshot.baseRateBps !== 1000) return null;
  if (typeof snapshot.enabled !== "boolean" || !isDateTime(snapshot.consentedAt) || !isId(snapshot.consentedByUserId) || !isInteger(snapshot.agreementRevision)) return null;
  const validRates = snapshot.enabled
    ? snapshot.supportRateBps === 500 && snapshot.totalRateBps === 1500 && value.normalOperationsAllowed
    : snapshot.supportRateBps === 0 && snapshot.totalRateBps === 1000 && !value.normalOperationsAllowed;
  if (!validRates) return null;
  const supportRateBps = snapshot.enabled ? 500 : 0;
  const totalRateBps = snapshot.enabled ? 1500 : 1000;
  return {
    kind: "valid",
    snapshot: {
      policyVersion: "2026-10-23",
      enabled: snapshot.enabled,
      baseRateBps: 1000,
      supportRateBps,
      totalRateBps,
      consentVersion: "2026-10-23",
      consentedAt: snapshot.consentedAt,
      consentedByUserId: snapshot.consentedByUserId,
      agreementRevision: snapshot.agreementRevision,
    },
    normalOperationsAllowed: value.normalOperationsAllowed,
  };
}

function readListItem(value: unknown): ExperienceAdminBookingListItem | null {
  if (!isObject(value) || !hasExactly(value, ["id", "host", "pageId", "experienceTitle", "offerName", "occurrenceDate", "startAt", "endAt", "headCount", "totalYen", "guestName", "status", "support", "needsAttention", "createdAt"])) return null;
  const host = readHost(value.host);
  const support = readSupport(value.support);
  if (!isId(value.id) || !host || !isId(value.pageId) || !isString(value.experienceTitle) || !isString(value.offerName) || !isDate(value.occurrenceDate) || !isDateTime(value.startAt) || !isDateTime(value.endAt) || !isInteger(value.headCount, 1) || !isInteger(value.totalYen) || !isString(value.guestName) || !isOneOf(EXPERIENCE_ADMIN_BOOKING_STATUSES, value.status) || !support || typeof value.needsAttention !== "boolean" || !isDateTime(value.createdAt)) return null;
  return { id: value.id, host, pageId: value.pageId, experienceTitle: value.experienceTitle, offerName: value.offerName, occurrenceDate: value.occurrenceDate, startAt: value.startAt, endAt: value.endAt, headCount: value.headCount, totalYen: value.totalYen, guestName: value.guestName, status: value.status, support, needsAttention: value.needsAttention, createdAt: value.createdAt };
}

export function decodeExperienceAdminBookingListResponse(value: unknown): ExperienceAdminBookingListResponse | null {
  if (!isObject(value) || !hasExactly(value, ["bookings", "nextCursor"]) || !(value.nextCursor === null || isCursor(value.nextCursor))) return null;
  const bookings = readArray(value.bookings, readListItem);
  return bookings ? { bookings, nextCursor: value.nextCursor } : null;
}

function readAnswer(value: unknown): ExperienceAdminBookingAnswer | null {
  if (!isObject(value) || !hasExactly(value, ["questionId", "prompt", "inputType", "text", "options"]) || !isId(value.questionId) || !isString(value.prompt) || !isOneOf(["SHORT_TEXT", "LONG_TEXT", "SINGLE_SELECT", "MULTI_SELECT"] as const, value.inputType) || !isNullableString(value.text)) return null;
  const options = readArray(value.options, (option) => isObject(option) && hasExactly(option, ["id", "label"]) && isId(option.id) && isString(option.label) ? { id: option.id, label: option.label } : null);
  return options ? { questionId: value.questionId, prompt: value.prompt, inputType: value.inputType, text: value.text, options } : null;
}

function readHostMessage(value: unknown): ExperienceAdminBookingHostMessage | null {
  if (!isObject(value) || !hasExactly(value, ["id", "subject", "createdAt", "sentAt", "failed", "deliveryStatus"])) return null;
  if (!isId(value.id) || !isString(value.subject) || !isDateTime(value.createdAt) || !isNullableDateTime(value.sentAt) || typeof value.failed !== "boolean" || !isOneOf(["QUEUED", "SENT", "FAILED", "UNKNOWN"] as const, value.deliveryStatus)) return null;
  if ((value.deliveryStatus === "FAILED") !== value.failed) return null;
  return { id: value.id, subject: value.subject, createdAt: value.createdAt, sentAt: value.sentAt, failed: value.failed, deliveryStatus: value.deliveryStatus };
}

function readDetail(value: unknown): ExperienceAdminBookingDetail | null {
  const keys = ["id", "offerId", "offerName", "occurrenceDate", "startAt", "endAt", "headCount", "adultCount", "childCount", "guestName", "guestEmail", "languageSnapshot", "note", "answers", "status", "unitPriceYen", "adultPriceYen", "childPriceYen", "totalYen", "paidAt", "authorizedAt", "approvalDeadlineAt", "travelerCancelRequestedAt", "cancelledAt", "cancelReason", "cancelMessage", "refundedYen", "createdAt", "salesChannel", "hostMessages", "pageId", "page", "host", "support"] as const;
  if (!isObject(value) || !hasExactly(value, keys)) return null;
  const host = readHost(value.host);
  const support = readSupport(value.support);
  const answers = value.answers === null ? null : readArray(value.answers, readAnswer);
  const messages = readArray(value.hostMessages, readHostMessage);
  if (!isId(value.id) || !isId(value.offerId) || !isString(value.offerName) || !isDate(value.occurrenceDate) || !isDateTime(value.startAt) || !isDateTime(value.endAt) || !isInteger(value.headCount, 1) || !isInteger(value.adultCount) || !isInteger(value.childCount) || value.adultCount + value.childCount !== value.headCount || !isString(value.guestName) || !isString(value.guestEmail) || !isString(value.languageSnapshot) || !isNullableString(value.note) || (value.answers !== null && !answers) || !isOneOf(EXPERIENCE_ADMIN_BOOKING_STATUSES, value.status) || !isInteger(value.unitPriceYen) || !isInteger(value.adultPriceYen) || !(value.childPriceYen === null || isInteger(value.childPriceYen)) || !isInteger(value.totalYen) || !isNullableDateTime(value.paidAt) || !isNullableDateTime(value.authorizedAt) || !isNullableDateTime(value.approvalDeadlineAt) || !isNullableDateTime(value.travelerCancelRequestedAt) || !isNullableDateTime(value.cancelledAt) || !isNullableString(value.cancelReason) || !isNullableString(value.cancelMessage) || !isInteger(value.refundedYen) || value.refundedYen > value.totalYen || !isDateTime(value.createdAt) || !isString(value.salesChannel) || !messages || !isId(value.pageId) || !isObject(value.page) || !hasExactly(value.page, ["title"]) || !isString(value.page.title) || !host || !support) return null;
  return { ...value, answers, hostMessages: messages, page: { title: value.page.title }, host, support } as ExperienceAdminBookingDetail;
}

export function decodeExperienceAdminBookingDetailResponse(value: unknown): ExperienceAdminBookingDetailResponse | null {
  if (!isObject(value) || !hasExactly(value, ["booking", "supportAgreement"]) || !isObject(value.supportAgreement) || !hasExactly(value.supportAgreement, ["agreementRevision", "sharedConsultationMemo", "matchesBookingSnapshot"])) return null;
  const booking = readDetail(value.booking);
  const agreement = value.supportAgreement;
  if (!booking || !(agreement.agreementRevision === null || isInteger(agreement.agreementRevision)) || !isNullableString(agreement.sharedConsultationMemo) || (typeof agreement.sharedConsultationMemo === "string" && agreement.sharedConsultationMemo.length > 4000) || typeof agreement.matchesBookingSnapshot !== "boolean") return null;
  if (agreement.matchesBookingSnapshot && (booking.support.kind !== "valid" || agreement.agreementRevision !== booking.support.snapshot.agreementRevision)) return null;
  return { booking, supportAgreement: { agreementRevision: agreement.agreementRevision, sharedConsultationMemo: agreement.sharedConsultationMemo, matchesBookingSnapshot: agreement.matchesBookingSnapshot } };
}

function readNotification(value: unknown): ExperienceAdminNotification | null {
  if (!isObject(value) || !hasExactly(value, ["id", "type", "title", "body", "bookingRequestId", "occurredAt", "readAt"])) return null;
  if (!isId(value.id) || !isOneOf(EXPERIENCE_ADMIN_NOTIFICATION_TYPES, value.type) || !isString(value.title) || !isString(value.body) || !isId(value.bookingRequestId) || !isDateTime(value.occurredAt) || !isNullableDateTime(value.readAt)) return null;
  return { id: value.id, type: value.type, title: value.title, body: value.body, bookingRequestId: value.bookingRequestId, occurredAt: value.occurredAt, readAt: value.readAt };
}

export function decodeExperienceAdminNotificationListResponse(value: unknown): ExperienceAdminNotificationListResponse | null {
  if (!isObject(value) || !hasExactly(value, ["notifications", "unreadCount", "nextCursor"]) || !isInteger(value.unreadCount) || !(value.nextCursor === null || isCursor(value.nextCursor))) return null;
  const notifications = readArray(value.notifications, readNotification);
  if (notifications?.some((notification, index) => index > 0 && Date.parse(notification.occurredAt) > Date.parse(notifications[index - 1]!.occurredAt))) return null;
  return notifications ? { notifications, unreadCount: value.unreadCount, nextCursor: value.nextCursor } : null;
}

export function decodeExperienceAdminNotificationReadResponse(value: unknown): ExperienceAdminNotificationReadResponse | null {
  if (!isObject(value) || !hasExactly(value, ["notifications", "unreadCount"]) || !isInteger(value.unreadCount)) return null;
  const notifications = readArray(value.notifications, (item) => isObject(item) && hasExactly(item, ["id", "readAt"]) && isId(item.id) && isDateTime(item.readAt) ? { id: item.id, readAt: item.readAt } : null);
  return notifications ? { notifications, unreadCount: value.unreadCount } : null;
}

export function decodeExperienceAdminBookingQuery(value: unknown): ExperienceAdminBookingQuery | null {
  if (!isObject(value) || !hasOnly(value, BOOKING_QUERY_KEYS)) return null;
  if (value.cursor !== undefined && !isCursor(value.cursor)) return null;
  if (value.hostId !== undefined && (!isId(value.hostId) || value.hostId.length > 200)) return null;
  if (value.hostSearch !== undefined && (typeof value.hostSearch !== "string" || value.hostSearch.length < 1 || value.hostSearch.length > 200)) return null;
  if (value.fromDate !== undefined && !isDate(value.fromDate)) return null;
  if (value.toDate !== undefined && !isDate(value.toDate)) return null;
  if (value.fromDate && value.toDate && value.fromDate > value.toDate) return null;
  if (value.status !== undefined && !isOneOf(EXPERIENCE_ADMIN_BOOKING_STATUSES, value.status)) return null;
  if (value.support !== undefined && !isOneOf(["on", "off", "legacy"] as const, value.support)) return null;
  if (value.attention !== undefined && !isOneOf(["yes", "no"] as const, value.attention)) return null;
  if (value.search !== undefined && (typeof value.search !== "string" || value.search.length < 1 || value.search.length > 200)) return null;
  if (value.limit !== undefined && (!isInteger(value.limit, 1) || value.limit > 100)) return null;
  return { ...value } as ExperienceAdminBookingQuery;
}

export function decodeExperienceAdminNotificationQuery(value: unknown): ExperienceAdminNotificationQuery | null {
  if (!isObject(value) || !hasOnly(value, NOTIFICATION_QUERY_KEYS)) return null;
  if (value.cursor !== undefined && !isCursor(value.cursor)) return null;
  if (value.unread !== undefined && typeof value.unread !== "boolean") return null;
  if (value.limit !== undefined && (!isInteger(value.limit, 1) || value.limit > 100)) return null;
  return { ...value } as ExperienceAdminNotificationQuery;
}

export function decodeExperienceAdminNotificationReadRequest(value: unknown): ExperienceAdminNotificationReadRequest | null {
  if (!isObject(value) || !hasExactly(value, ["notificationIds"]) || !Array.isArray(value.notificationIds) || value.notificationIds.length < 1 || value.notificationIds.length > EXPERIENCE_ADMIN_NOTIFICATION_IDS_MAX) return null;
  if (value.notificationIds.some((id) => !isId(id)) || new Set(value.notificationIds).size !== value.notificationIds.length) return null;
  return { notificationIds: value.notificationIds as string[] };
}
