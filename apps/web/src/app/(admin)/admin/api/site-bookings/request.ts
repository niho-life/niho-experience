import type { SupportOperationPreviewInput, SupportRefundChoice } from "@niho-experience/experience-store";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH64 = /^[0-9a-f]{64}$/;

export type FinancialAction = SupportOperationPreviewInput["action"];
export type FinancialCommand = {
  readonly action: FinancialAction;
  readonly commandId: string;
  readonly expectedSnapshot: string;
  readonly publicBookingId?: string;
  readonly refundId?: string;
  readonly refund?: SupportRefundChoice;
  readonly reason?: string;
  readonly note?: string | null;
  readonly message?: string;
};
export type ContactCommand = {
  readonly action: "CONTACT_GUEST";
  readonly commandId: string;
  readonly publicBookingId: string;
  readonly message: string;
};

const object = (value: unknown): Record<string, unknown> | null => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
const keysAre = (value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean => {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => allowed.has(key));
};

function refundChoice(value: unknown): SupportRefundChoice | null {
  const choice = object(value);
  if (!choice) return null;
  if (choice.kind === "FULL" && keysAre(choice, ["kind"])) return { kind: "FULL" };
  if (choice.kind === "PARTIAL" && keysAre(choice, ["kind", "amount"]) && Number.isSafeInteger(choice.amount)) {
    return { kind: "PARTIAL", amount: choice.amount as number };
  }
  return null;
}

const string = (value: unknown): value is string => typeof value === "string";
const uuid = (value: unknown): value is string => string(value) && UUID.test(value);

export function parseFinancialCommand(value: unknown): FinancialCommand | null {
  const body = object(value);
  if (!body || !string(body.action) || !string(body.commandId) || !UUID_V4.test(body.commandId)
      || !string(body.expectedSnapshot) || !HASH64.test(body.expectedSnapshot)) return null;
  const base = { commandId: body.commandId, expectedSnapshot: body.expectedSnapshot };
  if (body.action === "CANCEL" && keysAre(body, ["action", "commandId", "expectedSnapshot", "publicBookingId", "reason", "refund"], ["note"]) && uuid(body.publicBookingId) && string(body.reason)) {
    const refund = refundChoice(body.refund);
    if (refund && (body.note === undefined || body.note === null || string(body.note))) return { action: body.action, ...base, publicBookingId: body.publicBookingId, reason: body.reason, note: body.note as string | null | undefined, refund };
  }
  if (body.action === "APPROVE_REQUEST" && keysAre(body, ["action", "commandId", "expectedSnapshot", "publicBookingId", "refund"], ["note"]) && uuid(body.publicBookingId)) {
    const refund = refundChoice(body.refund);
    if (refund && (body.note === undefined || body.note === null || string(body.note))) return { action: body.action, ...base, publicBookingId: body.publicBookingId, note: body.note as string | null | undefined, refund };
  }
  if (body.action === "DECLINE_REQUEST" && keysAre(body, ["action", "commandId", "expectedSnapshot", "publicBookingId", "message"]) && uuid(body.publicBookingId) && string(body.message)) {
    return { action: body.action, ...base, publicBookingId: body.publicBookingId, message: body.message };
  }
  if (body.action === "RESOLVE_PAYMENT_REVIEW" && keysAre(body, ["action", "commandId", "expectedSnapshot", "publicBookingId"]) && uuid(body.publicBookingId)) {
    return { action: body.action, ...base, publicBookingId: body.publicBookingId };
  }
  if (body.action === "RETRY_REFUND" && keysAre(body, ["action", "commandId", "expectedSnapshot", "refundId"]) && uuid(body.refundId)) {
    return { action: body.action, ...base, refundId: body.refundId };
  }
  if (body.action === "CLOSE_REFUND" && keysAre(body, ["action", "commandId", "expectedSnapshot", "refundId", "note"]) && uuid(body.refundId) && string(body.note)) {
    return { action: body.action, ...base, refundId: body.refundId, note: body.note };
  }
  return null;
}

export function parseContactCommand(value: unknown): ContactCommand | null {
  const body = object(value);
  return body && body.action === "CONTACT_GUEST" && keysAre(body, ["action", "commandId", "publicBookingId", "message"])
    && string(body.commandId) && UUID_V4.test(body.commandId) && uuid(body.publicBookingId) && string(body.message)
    ? { action: "CONTACT_GUEST", commandId: body.commandId, publicBookingId: body.publicBookingId, message: body.message }
    : null;
}

export function parseSupportPreview(value: unknown): SupportOperationPreviewInput | null {
  const body = object(value);
  if (!body || !string(body.action)) return null;
  if ((body.action === "CANCEL" || body.action === "APPROVE_REQUEST") && keysAre(body, ["action", "publicBookingId", "refund"]) && uuid(body.publicBookingId)) {
    const refund = refundChoice(body.refund);
    return refund ? { action: body.action, publicBookingId: body.publicBookingId, refund } : null;
  }
  if ((body.action === "DECLINE_REQUEST" || body.action === "RESOLVE_PAYMENT_REVIEW") && keysAre(body, ["action", "publicBookingId"]) && uuid(body.publicBookingId)) {
    return { action: body.action, publicBookingId: body.publicBookingId };
  }
  if ((body.action === "RETRY_REFUND" || body.action === "CLOSE_REFUND") && keysAre(body, ["action", "refundId"]) && uuid(body.refundId)) {
    return { action: body.action, refundId: body.refundId };
  }
  return null;
}
