import { shortDateTime } from "@/host/bookings";
import { hostBookingSupportPreview } from "@/support/mock";
import { HostSupportHistoryPanel } from "./HostSupportHistoryPanel";

export function HostBookingSupportPanel({ providerId, bookingId, preview, historyEnabled }: { providerId: string; bookingId: string; preview: boolean; historyEnabled: boolean }) {
  if (!preview) return <HostSupportHistoryPanel bookingId={bookingId} enabled={historyEnabled} />;
  const support = hostBookingSupportPreview(providerId, bookingId);
  if (!support) return null;
  return <section aria-labelledby="booking-support-heading" className="mt-3.5 border-t border-line pt-3.5"><h3 id="booking-support-heading" className="mb-2 font-sans text-xs font-extrabold tracking-[0.04em] text-ink-soft">NIHOサポート</h3><div className="flex flex-wrap items-center gap-2"><span className={`rounded-full px-2.5 py-1 text-xs font-extrabold ${support.snapshot.enabled ? "bg-leaf-pale text-moss" : "bg-sand text-ink-soft"}`}>サポート{support.snapshot.enabled ? "ON" : "OFF"}</span><span className="text-[0.8125rem]">手数料 {support.snapshot.feePercent}%（受付時）</span><span className="text-xs text-muted">受付 {shortDateTime(support.snapshot.acceptedAt)}</span></div><p className="mt-2 text-[0.8125rem] text-ink-soft">{support.snapshot.enabled ? (support.consultation || "現在、個別の相談はありません。") : "この予約はサポートOFFで受け付けました。現在の設定を変えても、受付時の条件は変わりません。"}</p>{support.assignee ? <p className="mt-1 text-[0.78125rem] text-muted">担当: {support.assignee}</p> : null}{support.history.length ? <ol className="mt-2 border-t border-line pt-2">{support.history.map((event, index) => <li key={`${event.at}-${index}`} className="grid grid-cols-[78px_minmax(0,1fr)] gap-2 py-1 text-[0.78125rem]"><time className="text-muted">{shortDateTime(event.at)}</time><span><strong>{event.actor}</strong><span className="block text-ink-soft">{event.text}</span></span></li>)}</ol> : null}</section>;
}
