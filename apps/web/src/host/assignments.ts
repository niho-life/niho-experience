import type { AssignmentAction, AssignmentOccurrence, HostAssignmentList } from "@niho-experience/experience-store";
import type { HostBooking } from "./types";

/*
 * 開催回の担当 (#535 v0), what the screens say. The assignee is internal: the guest never sees it (no guest screen or mail
 * reads this). Assigning is not approving the guest, not payment and not confirmation.
 */

export const ASSIGNMENT_NOTE = "担当は社内の記録です。予約者には表示も通知もされません。担当になっても、予約者への承認・支払い・予約の確定は済みになりません。";
export const ASSIGNMENT_LOAD_FAILED_TEXT = "担当を読み込めませんでした。時間をおいて、もう一度お試しください。";
export const ASSIGNMENT_ACTION_FAILED_TEXT = "記録できませんでした。時間をおいて、もう一度お試しください。";
export const ASSIGNMENT_TAKEN_TEXT = "すでに別の人が担当になっています。";
export const ASSIGNMENT_CLOSED_TEXT = "この回は担当を受け付けていません。画面を読み直してください。";

export const ASSIGNMENT_ACTION_LABEL: Record<AssignmentAction, string> = {
  CLAIM: "対応する",
  DECLINE: "行けません",
  RELEASE: "担当を外れた",
  SET_FEE: "合意した額",
};

/** The same session key the bookings use (体験, 開催ルール, 日, 開始): matches a booking to its occurrence. */
export function assignmentFor(list: HostAssignmentList | null, booking: Pick<HostBooking, "experienceId" | "offerId" | "date" | "start">): { kind: "OPEN" | "MINE" | "TAKEN"; occurrence: AssignmentOccurrence } | null {
  if (!list) return null;
  const same = (item: AssignmentOccurrence) => item.productId === booking.experienceId && item.ruleId === booking.offerId && item.localDate === booking.date && item.localStartTime === booking.start;
  const open = list.open.find(same); if (open) return { kind: "OPEN", occurrence: open };
  const mine = list.mine.find(same); if (mine) return { kind: "MINE", occurrence: mine };
  const taken = list.taken.find(same); return taken ? { kind: "TAKEN", occurrence: taken } : null;
}

export interface AssignmentHistoryLine { readonly id: string; readonly atUtc: string; readonly text: string }
