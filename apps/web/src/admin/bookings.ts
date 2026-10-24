import { approveBooking, bookingActions, cancelBooking, declineBooking, type BookingCancellation } from "@/host/bookings";
import type { HostBookingStatus, HostCancelReason } from "@/host/types";
import type { AdminActor, AdminBooking, AdminBookingAction } from "./types";

export interface AdminBookingFilters {
  hostId: string;
  from: string;
  to: string;
  status: HostBookingStatus | "";
  support: "" | "on" | "off";
  attention: "" | "yes" | "no";
  search: string;
}

export function filterAdminBookings(bookings: readonly AdminBooking[], filters: AdminBookingFilters): AdminBooking[] {
  const needle = filters.search.trim().toLocaleLowerCase("ja");
  return bookings.filter((booking) => {
    if (filters.hostId && booking.hostId !== filters.hostId) return false;
    if (filters.from && booking.date < filters.from) return false;
    if (filters.to && booking.date > filters.to) return false;
    if (filters.status && booking.status !== filters.status) return false;
    if (filters.support && booking.support.enabled !== (filters.support === "on")) return false;
    if (filters.attention && booking.needsAttention !== (filters.attention === "yes")) return false;
    if (needle && !`${booking.bookingNumber} ${booking.guest}`.toLocaleLowerCase("ja").includes(needle)) return false;
    return true;
  });
}

export function adminBookingActions(booking: AdminBooking) {
  const state = bookingActions(booking.status);
  if (!booking.support.enabled || !booking.support.operationsAllowed) return { approve: false, decline: false, contact: false, cancel: false };
  return { approve: state.approve, decline: state.decline, contact: state.message, cancel: state.cancel };
}

export type AdminOperation =
  | { action: "approve" | "decline"; reason: string }
  | { action: "contact"; reason: string }
  | { action: "cancel"; reason: string; cancellation: BookingCancellation };

export type AdminOperationResult = { ok: true; booking: AdminBooking; message: string } | { ok: false; code: "support_off" | "invalid_state" | "invalid_input"; message: string };

export function adminCancellationMessage(booking: Pick<AdminBooking, "language">, reason: HostCancelReason): string {
  const messages = booking.language === "ja"
    ? { host: "誠に申し訳ありませんが、この日は開催できなくなったため、ご予約を取り消します。", guest: "ご依頼のとおり、ご予約を取り消しました。", other: "ホストと確認のうえ、ご予約を取り消しました。" }
    : { host: "We’re very sorry, but we have to cancel your booking: we are unable to host on this date.", guest: "At your request, we have cancelled your booking.", other: "After confirming with the host, we have cancelled your booking." };
  return messages[reason];
}

function appendAudit(booking: AdminBooking, actor: AdminActor, action: AdminBookingAction, detail: string, at: string): AdminBooking {
  return { ...booking, adminHistory: [...booking.adminHistory, { at, actorId: actor.id, actorName: actor.name, action: action === "contact" ? "contacted" : action === "cancel" ? "cancelled" : action === "approve" ? "approved" : "declined", detail }] };
}

/** Applies one synthetic admin operation while reusing the host booking state and refund rules. */
export function applyAdminOperation(booking: AdminBooking, operation: AdminOperation, actor: AdminActor, at: string): AdminOperationResult {
  if (!booking.support.enabled || !booking.support.operationsAllowed) return { ok: false, code: "support_off", message: "サポートOFFで受け付けた予約は、運営上の閲覧だけができます。" };
  const reason = operation.reason.trim();
  if (!reason || !actor.id || !actor.name) return { ok: false, code: "invalid_input", message: "対応理由を入力してください。" };
  const actions = adminBookingActions(booking);
  if (!actions[operation.action]) return { ok: false, code: "invalid_state", message: "予約の状態が変わったため、この操作は実行できません。" };

  if (operation.action === "contact") {
    return { ok: true, booking: appendAudit(booking, actor, operation.action, `連絡プレビュー · ${reason}`, at), message: "連絡内容を対応履歴へ追加しました。" };
  }
  let changed;
  switch (operation.action) {
    case "approve": changed = approveBooking(booking, at); break;
    case "decline": changed = declineBooking(booking, at); break;
    case "cancel": changed = cancelBooking(booking, operation.cancellation, at); break;
  }
  const detail = operation.action === "approve" ? `承認 · ${reason}` : operation.action === "decline" ? `辞退 · ${reason}` : `取消・返金 · ${reason}`;
  const message = operation.action === "approve" ? "予約を承認しました。" : operation.action === "decline" ? "申込を辞退しました。" : "予約を取り消しました。";
  return { ok: true, booking: appendAudit({ ...booking, ...changed, needsAttention: false, attentionReason: "" }, actor, operation.action, detail, at), message };
}

