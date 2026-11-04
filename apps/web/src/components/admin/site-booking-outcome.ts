type RefundState = "REQUESTED" | "PENDING" | "SUCCEEDED" | "FAILED";
type OutcomeMessage = { readonly tone: "ok" | "error"; readonly text: string };

const messages: Record<string, string> = {
  CONTACT_SENT: "NIHOサポートからの連絡を予約者へのメール配信キューに登録しました",
  CANCELLED: "予約の取消を確認しました。返金状況は一覧で確認してください",
  DECLINED: "お断りしました。予約者への連絡をメール配信キューに登録しました",
  REFUND_RETRIED: "返金の依頼を受け付けました。最新の返金状況は一覧で確認してください",
  REFUND_CLOSED: "手作業で済んだ返金として閉じました",
  NOT_CANCELLABLE: "状態が変わっていたため、何も変えませんでした。一覧を読み直しました",
  CHANGED: "状態が変わっていたため、何も変えませんでした",
  REQUESTED: "受け付けました",
};

/** An HTTP 200 alone does not confirm either the operation or the refund. */
export function siteBookingOutcome(value: unknown): OutcomeMessage | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const reply = value as Record<string, unknown>;
  if (typeof reply.outcome !== "string" || !Object.hasOwn(messages, reply.outcome)
      || typeof reply.repeated !== "boolean") return null;
  if (reply.outcome === "CONTACT_SENT") return { tone: "ok", text: messages.CONTACT_SENT! };
  if (!Array.isArray(reply.bookingIds) || !reply.bookingIds.every((id) => typeof id === "string")
      || !Array.isArray(reply.refunds)) return null;
  const states: RefundState[] = [];
  for (const item of reply.refunds) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return null;
    const refund = item as Record<string, unknown>;
    if (typeof refund.refundId !== "string" || typeof refund.status !== "string"
        || !["REQUESTED", "PENDING", "SUCCEEDED", "FAILED"].includes(refund.status)) return null;
    states.push(refund.status as RefundState);
  }
  const text = messages[reply.outcome]!;
  if (states.includes("FAILED")) return { tone: "error", text: `${text}。返金に失敗しています。返金状況を確認してください` };
  if (states.includes("REQUESTED")) return { tone: "error", text: `${text}。Stripeへの返金は受付待ちです。完了していません` };
  if (states.includes("PENDING")) return { tone: "ok", text: `${text}。Stripeで返金処理中です` };
  if (states.length > 0) return { tone: "ok", text: `${text}。今回の返金完了を確認しました` };
  return { tone: "ok", text };
}
