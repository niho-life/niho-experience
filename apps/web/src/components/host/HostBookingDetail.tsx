"use client";

import Link from "next/link";
import { useId, useState, type ReactNode } from "react";
import {
  bookingActions,
  bookingRequestRows,
  bookingStateRows,
  bookingStatusLabel,
  bookingWhen,
  respondByLabel,
  shortDateTime,
  type BookingCancellation,
  type BookingRow,
} from "@/host/bookings";
import { monthDayJa, yen } from "@/host/format";
import { translationOffered } from "@/host/translate";
import type { HostBooking } from "@/host/types";
import { BookingCancelDialog, BookingDecisionDialog, DANGER_BUTTON } from "./HostBookingDialogs";
import { consoleButtonClass, HOST_SURFACE } from "./host-ui";
import { HostIcon } from "./HostIcon";
import { HostBookingSupportPanel } from "./HostBookingSupportPanel";
import { HostTranslatePanel } from "./HostTranslatePanel";
import { StatusPill } from "./ui";
import { FeeSummaryPanel } from "@/components/FeeSummaryPanel";

/** One part of the booking (申込内容, 状態, メッセージ, 時系列) under a hairline. */
function DetailSection({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="mt-3.5 border-t border-line pt-3.5">
      <h3 id={id} className="mb-2 font-sans text-xs leading-normal font-extrabold tracking-[0.04em] text-ink-soft">
        {title}
      </h3>
      {children}
    </section>
  );
}

/** Label 72px + value, the mock's `.dkv`. */
function Rows({ rows }: { rows: readonly BookingRow[] }) {
  return (
    <dl>
      {rows.map((row) => (
        <div key={row.label} className="grid grid-cols-[72px_minmax(0,1fr)] gap-2 py-[5px] text-[0.8125rem] leading-normal">
          <dt className="font-bold text-muted">{row.label}</dt>
          {"answers" in row ? (
            <dd className="min-w-0">
              <ul className="flex flex-col gap-1.5">
                {row.answers.map((answer, index) => (
                  <li key={index} className="[overflow-wrap:anywhere]">
                    <span className="block text-xs text-muted">{answer.question}</span>
                    <span className="block">{answer.answer}</span>
                  </li>
                ))}
              </ul>
            </dd>
          ) : (
            <dd className={`min-w-0 [overflow-wrap:anywhere] ${row.multiline ? "whitespace-pre-wrap" : ""}`}>{row.value}</dd>
          )}
        </div>
      ))}
    </dl>
  );
}

const WAIT_LINE = "mb-2.5 text-[0.78125rem] leading-normal font-extrabold text-warn";

/** メッセージ: the booking's thread (#106), with its last message, or the way to start one. */
export interface BookingConversationLink {
  /** /host/messages?thread=… (or ?booking=… to start one). */
  href: string;
  /** The last message in one line and when it was written; null before anyone wrote. */
  last: { text: string; at: string } | null;
}

/** メッセージ: the last word of the booking's thread and the way into it. Messages are read and written in メッセージ. */
function ConversationSection({ conversation }: { conversation: BookingConversationLink }) {
  const { last } = conversation;
  return (
    <DetailSection title="メッセージ">
      {last ? (
        <p className="flex items-baseline gap-2.5 text-[0.8125rem] leading-normal">
          <span className="min-w-0 flex-1 truncate">{last.text}</span>
          <time dateTime={`${last.at}+09:00`} className="shrink-0 text-xs text-muted tabular-nums">
            {shortDateTime(last.at)}
          </time>
        </p>
      ) : (
        <p className="text-[0.8125rem] text-muted">まだやりとりはありません。</p>
      )}
      <Link href={conversation.href} className={consoleButtonClass("secondary", "sm", "mt-2.5")}>
        {last ? "やりとりを開く" : "メッセージを送る"}
      </Link>
    </DetailSection>
  );
}

export interface HostBookingDetailProps {
  booking: HostBooking;
  experienceTitle: string;
  today: string;
  /** The name's id: the page moves focus there after an action. */
  headingId: string;
  /** What the last action did (role=status); empty until then. */
  notice: string;
  /** The booking's thread, or the way to start one; null when the guest cannot be written to (お断り・期限切れ). */
  conversation: BookingConversationLink | null;
  providerId: string;
  supportPreview: boolean;
  supportHistoryEnabled: boolean;
  feeSummaryEnabled: boolean;
  /** 通訳を始める (#181): whether the translate BFF is open (the mock always is). */
  translateEnabled: boolean;
  onApprove: () => void;
  onDecline: () => void;
  onCancel: (cancellation: BookingCancellation) => void;
}

/**
 * One booking (mock v2 `bookingDetail`): the guest and the state, 申込内容, 状態, what the
 * host can do now, メッセージ (the way into its thread) and 時系列. 承認・お断り・取消 are
 * asked in a dialog first.
 */
export function HostBookingDetail({ booking, experienceTitle, today, headingId, notice, conversation, providerId, supportPreview, supportHistoryEnabled, feeSummaryEnabled, translateEnabled, onApprove, onDecline, onCancel }: HostBookingDetailProps) {
  const [asking, setAsking] = useState<"approve" | "decline" | "cancel" | null>(null);
  const actions = bookingActions(booking.status);
  // 通訳を始める: a confirmed booking of an English-speaking guest whose day has not passed (#181).
  const translate = translateEnabled && translationOffered({ confirmed: booking.status === "confirmed", language: booking.language, date: booking.date }, today);

  let next: ReactNode = null;
  if (actions.approve) {
    next = (
      <>
        {booking.respondBy ? <p className={WAIT_LINE}>承認期限 {respondByLabel(booking.respondBy, today)}</p> : null}
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => setAsking("approve")} className={consoleButtonClass("primary")}>
            承認する
          </button>
          <button type="button" onClick={() => setAsking("decline")} className={consoleButtonClass("secondary")}>
            お断りする
          </button>
        </div>
      </>
    );
  } else if (actions.cancel) {
    next = (
      <>
        {booking.status === "refund_needed" ? <p className={WAIT_LINE}>旅行者が取消を依頼しています</p> : null}
        <button type="button" onClick={() => setAsking("cancel")} className={DANGER_BUTTON}>
          取り消して返金する
        </button>
      </>
    );
  } else if (booking.status === "cancelled" && booking.cancelledAt) {
    next = (
      <p className="text-[0.8125rem] text-ink-soft">
        {monthDayJa(booking.cancelledAt.slice(0, 10))}に取消 · {booking.refundedYen > 0 ? `${yen(booking.refundedYen)} を返金済み` : "返金なし"}
      </p>
    );
  }

  return (
    <section aria-labelledby={headingId} className={`${HOST_SURFACE} p-4 md:px-5 md:py-[18px]`}>
      <div className="flex items-start justify-between gap-2.5">
        <div className="min-w-0">
          <h2 id={headingId} tabIndex={-1} className="font-sans text-[1.125rem] leading-[1.3] font-extrabold tracking-normal [overflow-wrap:anywhere] focus:outline-none">
            {booking.guest}
          </h2>
          <p className="mt-0.5 text-[0.78125rem] leading-normal text-muted">{bookingWhen(booking)}</p>
        </div>
        <StatusPill status={bookingStatusLabel(booking, today)} />
      </div>
      <p role="status" className={notice ? "mt-3 flex items-start gap-1.5 rounded-xl bg-leaf-pale px-3 py-2 text-[0.8125rem] leading-normal font-bold text-moss" : "sr-only"}>
        {notice ? (
          <>
            <HostIcon name="check" className="mt-0.5 size-4" />
            {notice}
          </>
        ) : null}
      </p>

      <DetailSection title="申込内容">
        <Rows rows={bookingRequestRows(booking, experienceTitle)} />
      </DetailSection>
      <DetailSection title="状態">
        <Rows rows={bookingStateRows(booking)} />
      </DetailSection>
      <HostBookingSupportPanel providerId={providerId} bookingId={booking.id} preview={supportPreview} historyEnabled={supportHistoryEnabled} />
      <FeeSummaryPanel key={`host-fee-${booking.id}`} audience="host" bookingId={booking.id} actorKey={providerId} enabled={feeSummaryEnabled} />
      {next || translate ? (
        <div className="mt-3.5 border-t border-line pt-3.5">
          {next}
          {translate ? <HostTranslatePanel key={booking.id} providerId={providerId} bookingId={booking.id} className={next ? "mt-3" : ""} /> : null}
        </div>
      ) : null}
      {conversation ? <ConversationSection conversation={conversation} /> : null}
      <DetailSection title="時系列">
        <ol>
          {booking.timeline.map((event, index) => (
            <li key={index} className="flex gap-2.5 py-1 text-[0.78125rem] leading-normal">
              <time dateTime={`${event.at}+09:00`} className="w-[92px] shrink-0 text-muted tabular-nums">
                {shortDateTime(event.at)}
              </time>
              <span className="min-w-0 [overflow-wrap:anywhere]">{event.text}</span>
            </li>
          ))}
        </ol>
      </DetailSection>

      {asking === "approve" || asking === "decline" ? (
        <BookingDecisionDialog kind={asking} booking={booking} onConfirm={asking === "approve" ? onApprove : onDecline} onClose={() => setAsking(null)} />
      ) : null}
      {asking === "cancel" ? <BookingCancelDialog booking={booking} onConfirm={onCancel} onClose={() => setAsking(null)} /> : null}
    </section>
  );
}
