import Link from "next/link";
import { consoleButtonClass, HOST_SURFACE } from "./host-ui";
import type { PublicationAction, PublicationStages } from "./publication-stages";

/*
 * 体験の編集の上の「公開と予約の受付」(#706): the status, the two buttons (ページを公開する / 予約の受付を始める), the
 * stop button while bookings are open, and under each button, in words, why it cannot be pressed yet. Shown, not hidden:
 * a host who has no payout account can still publish the page, and sees what the second button waits for.
 */
export function HostPublicationStages({ stages, busy, publicHref, onRun, onShowBlockers }: {
  stages: PublicationStages;
  busy: boolean;
  /** The public page, when it is public. */
  publicHref: string | null;
  onRun: (action: Extract<PublicationAction, "publish-page" | "open-booking" | "stop-booking">) => void;
  /** Open the list of what is missing (with a link to where each is done). */
  onShowBlockers: (scope: "page" | "booking") => void;
}) {
  const { page, booking, stopBooking } = stages;
  const more = (scope: "page" | "booking", blockers: readonly string[]) => blockers.length ? (
    <button type="button" onClick={() => onShowBlockers(scope)} className="ml-1 font-extrabold whitespace-nowrap text-moss underline underline-offset-4">必要なことを見る</button>
  ) : null;
  return (
    <section aria-labelledby="publication-stages-title" className={`${HOST_SURFACE} mb-3.5 p-4 md:p-5`}>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <h2 id="publication-stages-title" className="text-xs font-extrabold text-muted">公開と予約の受付</h2>
        <p data-publication-status className="text-[0.9375rem] font-extrabold">{stages.statusLabel}</p>
      </div>
      <div className="mt-3 grid gap-4 md:grid-cols-2">
        {page.visible ? (
          <div>
            <button type="button" disabled={busy || !page.enabled} aria-describedby="publication-page-reason" onClick={() => onRun("publish-page")} className={consoleButtonClass(page.primary ? "primary" : "secondary", "md", "max-md:w-full")}>{page.label}</button>
            {page.reason ? <p id="publication-page-reason" className="mt-1.5 text-[0.8125rem] leading-normal text-ink-soft">{page.reason}{page.enabled ? null : more("page", page.blockers)}</p> : null}
          </div>
        ) : publicHref ? (
          <div>
            <Link href={publicHref} className={consoleButtonClass("secondary", "md", "max-md:w-full")}>公開ページを見る ↗</Link>
            <p className="mt-1.5 text-[0.8125rem] leading-normal text-ink-soft">ページは公開中です。</p>
          </div>
        ) : null}
        {booking.visible ? (
          <div>
            <button type="button" disabled={busy || !booking.enabled} aria-describedby="publication-booking-reason" onClick={() => onRun("open-booking")} className={consoleButtonClass(booking.primary && booking.enabled ? "primary" : "secondary", "md", "max-md:w-full")}>{booking.label}</button>
            {booking.reason ? <p id="publication-booking-reason" className="mt-1.5 text-[0.8125rem] leading-normal text-ink-soft">{booking.reason}{booking.enabled ? null : more("booking", booking.blockers)}</p> : null}
          </div>
        ) : stopBooking.visible ? (
          <div>
            <button type="button" disabled={busy || !stopBooking.enabled} aria-describedby="publication-stop-reason" onClick={() => onRun("stop-booking")} className={consoleButtonClass("secondary", "md", "max-md:w-full")}>予約の受付を止める</button>
            <p id="publication-stop-reason" className="mt-1.5 text-[0.8125rem] leading-normal text-ink-soft">予約を受け付けています。止めても、ページは公開のままです。{stopBooking.enabled ? null : "入力を保存してから止められます。"}</p>
          </div>
        ) : null}
      </div>
    </section>
  );
}
