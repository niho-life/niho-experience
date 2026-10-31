"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { bookingsHref, bookingStatusLabel, respondByLabel } from "@/host/bookings";
import type { HostSessionView } from "@/host/console-data";
import { shortDateWithWeekdayJa } from "@/host/format";
import { messagesHref, type BookingConversation } from "@/host/messages";
import {
  ATTENDANCE_CHOICES,
  ATTENDANCE_LOCKED_TEXT,
  attendanceCounts,
  attendanceNotice,
  attendanceSummary,
  canCancelSession,
  canRecordAttendance,
  cancelOutcomeText,
  cancelResultText,
  cancelSession,
  dietarySummary,
  guestOrigin,
  guestTags,
  guestWords,
  mergeCancelResults,
  NO_DIETARY_TEXT,
  NO_SHOW_NOTE,
  peopleShort,
  recordAttendance,
  sessionCancelPlan,
  sessionCancelTargets,
  sessionCountLines,
  sessionHeading,
  sessionPhase,
  sessionPhaseLine,
  sessionSections,
  telHref,
  type SessionCancelReason,
  type SessionCancelResult,
} from "@/host/session";
import { SITE_BOOKING_PAYMENT_REVIEW_TEXT, SITE_BOOKING_READ_ONLY_TEXT } from "@/host/site-bookings";
import { siteSessionCountLines } from "@/host/site-sessions";
import type { HostAttendance, HostBooking } from "@/host/types";
import { DISABLED, useFocusAfterRender } from "./editor-parts";
import { DANGER_BUTTON } from "./HostBookingDialogs";
import { HostIcon } from "./HostIcon";
import { SessionCancelDialog, SessionContactDialog, type SessionContact } from "./HostSessionDialogs";
import { HostSubHeader } from "./HostSubHeader";
import { consoleButtonClass, HOST_SURFACE } from "./host-ui";
import { HostPageBody, InitialAvatar, SectionTitle, StatusPill, SubPageHead } from "./ui";

const CANCELLED_HEADING = "session-cancelled";
const NOTICE = "flex items-start gap-1.5 rounded-xl bg-leaf-pale px-3 py-2 text-[0.8125rem] leading-normal font-bold text-moss";

export interface HostSessionProps {
  session: HostSessionView;
  /** The moment the session is seen from (YYYY-MM-DDTHH:MM, JST; the preview's fixed one in mock mode): whether it has started, and when an action is dated. */
  now: string;
  /** The threads of the session's bookings (#106). */
  conversations: readonly BookingConversation[];
  /** The URL's own `?providerId=` (when well formed), carried on every link. */
  providerId: string | null;
  /**
   * Bookings made on this site (#285 slice 8b, experience DB, http mode), read only: no attendance, no thread with
   * the guest (slice 6) and no calling off (slice 7). `besideNiho`: NIHO's bookings are 予約's own and these are its
   * `?source=site`, where "‹ 予約" goes back. Absent in mock mode.
   */
  site?: { besideNiho: boolean } | null;
}

/** Label 72px + value, as a booking's 申込内容. */
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[72px_minmax(0,1fr)] gap-2 py-[5px] text-[0.8125rem] leading-normal">
      <dt className="font-bold text-muted">{label}</dt>
      <dd className="min-w-0 [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

/** A guest's food wishes and 支払い済み: words in small tags (not states: no dot). */
function Tags({ booking }: { booking: HostBooking }) {
  const tags = guestTags(booking);
  if (!tags.length) return null;
  return (
    <ul aria-label="タグ" className="mt-2 flex flex-wrap gap-1.5">
      {tags.map((tag) => (
        <li key={tag.label} className={`inline-flex h-6 items-center rounded-full px-2.5 text-xs font-extrabold ${tag.tone === "food" ? "bg-leaf-pale text-moss" : "bg-sand text-ink-soft"}`}>
          {tag.label}
        </li>
      ))}
    </ul>
  );
}

/** 申込メモ and the answers, in the guest's own words, two lines each at most. */
function Words({ booking }: { booking: HostBooking }) {
  const { note, answers } = guestWords(booking);
  if (!note && !answers.length) return null;
  return (
    <div lang={booking.language} className="mt-2 flex flex-col gap-1 rounded-xl bg-sand/60 px-3 py-2 text-[0.8125rem] leading-normal">
      {note ? <p className="line-clamp-2 [overflow-wrap:anywhere]">{note}</p> : null}
      {answers.map((answer, index) => (
        <p key={index} className="line-clamp-2 [overflow-wrap:anywhere]">
          <span className="text-xs text-muted">{answer.question} </span>
          {answer.answer}
        </p>
      ))}
    </div>
  );
}

const SEGMENT = "inline-flex h-11 items-center justify-center gap-1 rounded-full border px-3 text-[0.875rem] font-extrabold";

/** 来た / 来なかった: 44px toggles, both unpressed while 未記録; disabled before the start. */
function Attendance({ booking, open, onMark }: { booking: HostBooking; open: boolean; onMark: (value: HostAttendance) => void }) {
  return (
    <>
      <div role="group" aria-label={`${booking.guest} さんの出欠`} className="mt-3 grid max-w-[320px] grid-cols-2 gap-2">
        {ATTENDANCE_CHOICES.map((choice) => {
          const pressed = booking.attendance === choice.value;
          return (
            <button
              key={choice.value}
              type="button"
              aria-pressed={pressed}
              disabled={!open}
              onClick={() => onMark(choice.value)}
              className={`${SEGMENT} ${DISABLED} ${pressed ? (choice.value === "attended" ? "border-moss bg-leaf-pale text-moss" : "border-ink-soft bg-sand text-ink") : "border-line-strong bg-canvas text-ink-soft hover:bg-sand"}`}
            >
              {pressed ? <HostIcon name="check" className="size-4" /> : null}
              {choice.label}
            </button>
          );
        })}
      </div>
      {booking.attendance === "no_show" ? <p className="mt-1.5 text-xs text-muted">{NO_SHOW_NOTE}</p> : null}
    </>
  );
}

/**
 * One guest: who, how many, from where, how to reach them on the day, what to look out for, and the way to their
 * thread (none for this site's bookings yet: `messageHref` null).
 */
function GuestRow({ booking, messageHref, aside, children }: { booking: HostBooking; messageHref: string | null; aside?: ReactNode; children?: (nameId: string) => ReactNode }) {
  const nameId = `guest-${booking.id}`;
  return (
    <li className="border-t border-line px-4 py-3.5 first:border-t-0 md:px-5">
      <div className="flex items-start gap-3">
        <InitialAvatar name={booking.guest} className="mt-0.5 size-9 text-[0.875rem]" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
            <div className="min-w-0 flex-[1_1_160px]">
              <h3 id={nameId} className="font-sans text-[0.9375rem] leading-[1.4] font-extrabold tracking-normal [overflow-wrap:anywhere]">
                {booking.guest}
              </h3>
              <p className="text-[0.78125rem] leading-normal text-muted">
                {peopleShort(booking)} · {guestOrigin(booking)}
                {booking.phone ? (
                  <>
                    {" · "}
                    <a href={telHref(booking.phone)} className="font-bold whitespace-nowrap text-moss underline underline-offset-2">
                      <span className="sr-only">電話 </span>
                      {booking.phone}
                    </a>
                  </>
                ) : null}
              </p>
              {aside}
            </div>
            {messageHref ? (
              <Link href={messageHref} aria-describedby={nameId} className={consoleButtonClass("secondary", "sm")}>
                メッセージ
              </Link>
            ) : null}
          </div>
          <Tags booking={booking} />
          <Words booking={booking} />
          {children?.(nameId)}
        </div>
      </div>
    </li>
  );
}

/**
 * この回 (#107, the journey mock's H3): one session on the day. Its times, guests, meeting line
 * and food wishes; each booking's guest with their phone (when they gave one, only here), their
 * words and 来た / 来なかった from the start; the requests apart, answered in 予約; 参加者に連絡する
 * (one thread at a time, #106) and, before the start, この回を中止.
 *
 * Mock mode: attendance and the cancellation change this screen only (the preview note says
 * nothing is kept), and no booking fails to cancel. TODO(#87): send them to NIHO
 * (niho-app#19321) and show what it reads back, with NIHO's result for each booking.
 *
 * This site's bookings (`site`, #285 slice 8b) are read only: the guests with their phones, words and payments under
 * review (確認待ち, counted with the participants as ホーム counts them), and where to ask for a cancellation.
 */
export function HostSession({ session, now, conversations, providerId, site = null }: HostSessionProps) {
  const [bookings, setBookings] = useState<readonly HostBooking[]>(session.bookings);
  const [notice, setNotice] = useState("");
  const [cancellation, setCancellation] = useState<{ reason: SessionCancelReason; results: SessionCancelResult[] } | null>(null);
  const [asking, setAsking] = useState<"contact" | "cancel" | null>(null);
  const focusLater = useFocusAfterRender();

  const heading = sessionHeading(session);
  const backHref = bookingsHref({ providerId, source: site?.besideNiho ? "site" : null });
  const phase = sessionPhase(session, now);
  const today = now.slice(0, 10);
  const { participants, requests } = sessionSections(session.bookings, bookings);
  const counts = site ? siteSessionCountLines(bookings) : sessionCountLines(bookings, session.capacity);
  const dietary = dietarySummary(bookings);
  const attendance = attendanceCounts(bookings);
  const failed = cancellation?.results.filter((result) => !result.ok) ?? [];

  const messageHref = (booking: HostBooking) => {
    // This site's bookings (#285) have no thread with the guest until slice 6.
    if (site) return null;
    const thread = conversations.find((conversation) => conversation.bookingId === booking.id);
    return thread ? messagesHref({ providerId, thread: thread.threadId }) : messagesHref({ providerId, booking: booking.id });
  };
  const contacts: SessionContact[] = [...participants, ...requests].flatMap((booking) => {
    const href = messageHref(booking);
    return href ? [{ id: booking.id, guest: booking.guest, people: `${booking.guests}名`, status: booking.status === "confirmed" ? null : bookingStatusLabel(booking, today), href }] : [];
  });
  // Nothing on this screen changes this site's bookings yet.
  const cancellable = !site && canCancelSession(bookings, phase, cancellation !== null);

  const mark = (id: string, value: HostAttendance) => {
    const booking = bookings.find((item) => item.id === id);
    if (!booking || !canRecordAttendance(booking, phase)) return;
    setBookings(bookings.map((item) => (item.id === id ? recordAttendance(item, value, phase) : item)));
    setNotice(attendanceNotice(booking, value));
  };

  /** 中止, or 失敗した予約をもう一度: only what is still to cancel is tried, and each booking's latest result is kept. */
  const cancel = (reason: SessionCancelReason) => {
    const done = cancelSession(bookings, reason, now);
    const results = cancellation ? mergeCancelResults(cancellation.results, done.results) : done.results;
    setBookings(done.bookings);
    setCancellation({ reason, results });
    focusLater(CANCELLED_HEADING);
  };

  return (
    <>
      <HostSubHeader backHref={backHref} backLabel="予約" title={heading} />
      <HostPageBody>
        <SubPageHead backHref={backHref} backLabel="予約" title={heading} />
        {site ? <p className="mb-2.5 text-[0.8125rem] leading-normal text-ink-soft">このサイトで受けた予約です</p> : null}

        {/* 中止 and its result for each booking. The status line stays in place so the result is announced. */}
        <section aria-labelledby={cancellation ? CANCELLED_HEADING : undefined} className={cancellation ? "mb-3.5 rounded-2xl border border-danger/20 bg-danger-pale px-4 py-3.5 md:px-5" : ""}>
          {cancellation ? (
            <h2 id={CANCELLED_HEADING} tabIndex={-1} className="font-sans text-[0.9375rem] leading-normal font-extrabold tracking-normal text-danger focus:outline-none">
              中止しました · 新しい予約は受け付けません
            </h2>
          ) : null}
          <p role="status" className={cancellation ? "mt-1 text-[0.8125rem] leading-normal font-bold" : "sr-only"}>
            {cancellation ? cancelOutcomeText(cancellation.results) : ""}
          </p>
          {cancellation ? (
            <>
              <ul aria-label="予約ごとの結果" className="mt-2">
                {cancellation.results.map((result) => (
                  <li key={result.bookingId} className="flex flex-wrap items-baseline justify-between gap-x-3 border-t border-danger/15 py-2 text-[0.8125rem] leading-normal">
                    <span className="font-extrabold [overflow-wrap:anywhere]">{result.guest}</span>
                    <span className={result.ok ? "text-ink-soft" : "font-bold text-danger"}>{cancelResultText(result)}</span>
                  </li>
                ))}
              </ul>
              {failed.length ? (
                <button type="button" onClick={() => cancel(cancellation.reason)} className={consoleButtonClass("secondary", "md", "mt-2")}>
                  失敗した予約をもう一度
                </button>
              ) : null}
            </>
          ) : null}
        </section>

        <section aria-labelledby="session-summary" className={`${HOST_SURFACE} px-4 pt-4 pb-3 md:px-5`}>
          <div className="mb-1 flex flex-wrap items-center justify-between gap-x-2.5 gap-y-1">
            <SectionTitle id="session-summary">この回</SectionTitle>
            {cancellation ? (
              <p className="text-xs font-extrabold text-danger">中止</p>
            ) : (
              <p className={`text-xs font-extrabold ${phase === "before" ? "text-muted" : "text-moss"}`}>{sessionPhaseLine(session, now)}</p>
            )}
          </div>
          <dl>
            <Row label="時間">
              <span className="font-extrabold tabular-nums">
                {session.start}–{session.end}
              </span>{" "}
              · {session.offer}
            </Row>
            <Row label="人数">
              <span className="block font-extrabold">{counts.main}</span>
              {counts.pending ? <span className="block font-bold text-warn">{counts.pending}</span> : null}
            </Row>
            {session.meetingArea ? (
              <Row label="集合">
                <span lang="en">{session.meetingArea}</span>
              </Row>
            ) : null}
            {/* This site's bookings keep food wishes only among the answers, shown with each guest; and no attendance. */}
            {site ? null : <Row label="食べもの">{dietary || <span className="text-muted">{NO_DIETARY_TEXT}</span>}</Row>}
            {phase !== "before" && !site ? <Row label="出欠">{attendanceSummary(attendance)}</Row> : null}
          </dl>
        </section>

        <section aria-labelledby="session-guests" className={`${HOST_SURFACE} mt-3.5`}>
          <div className="px-4 pt-4 pb-2 md:px-5">
            <SectionTitle id="session-guests">参加者</SectionTitle>
            {phase === "before" && !site && participants.some((booking) => booking.status === "confirmed") ? <p className="mt-0.5 text-xs text-muted">出欠は{ATTENDANCE_LOCKED_TEXT}</p> : null}
          </div>
          <p role="status" className={notice ? `${NOTICE} mx-4 mb-2 md:mx-5` : "sr-only"}>
            {notice ? (
              <>
                <HostIcon name="check" className="mt-0.5 size-4" />
                {notice}
              </>
            ) : null}
          </p>
          {participants.length ? (
            <ul>
              {participants.map((booking) => (
                <GuestRow key={booking.id} booking={booking} messageHref={messageHref(booking)}>
                  {() =>
                    site ? (
                      // A payment under review: paid after the hold ended, with no seat kept.
                      booking.status === "payment_review" ? (
                        <div className="mt-2.5">
                          <StatusPill status={bookingStatusLabel(booking, today)} />
                          <p className="mt-1.5 text-[0.78125rem] leading-normal font-extrabold text-warn">{SITE_BOOKING_PAYMENT_REVIEW_TEXT}</p>
                        </div>
                      ) : null
                    ) : booking.status === "confirmed" ? (
                      <Attendance booking={booking} open={canRecordAttendance(booking, phase)} onMark={(value) => mark(booking.id, value)} />
                    ) : (
                      <div className="mt-2.5">
                        <StatusPill status={bookingStatusLabel(booking, today)} />
                      </div>
                    )
                  }
                </GuestRow>
              ))}
            </ul>
          ) : (
            <p className="px-4 pb-4 text-muted md:px-5">確定した参加者はいません。</p>
          )}
        </section>

        {requests.length ? (
          <section aria-labelledby="session-requests" className={`${HOST_SURFACE} mt-3.5`}>
            <div className="px-4 pt-4 pb-2 md:px-5">
              <SectionTitle id="session-requests">承認待ち</SectionTitle>
              <p className="mt-0.5 text-xs text-muted">承認とお断りは予約の詳細で行います。</p>
            </div>
            <ul>
              {requests.map((booking) => (
                <GuestRow
                  key={booking.id}
                  booking={booking}
                  messageHref={messageHref(booking)}
                  aside={booking.status === "pending" && booking.respondBy ? <p className="text-xs leading-normal font-extrabold text-warn">承認期限 {respondByLabel(booking.respondBy, today)}</p> : null}
                >
                  {(nameId) =>
                    booking.status === "pending" ? (
                      <Link href={bookingsHref({ providerId, booking: booking.id })} aria-describedby={nameId} className={consoleButtonClass("secondary", "sm", "mt-2.5")}>
                        予約の詳細で承認する
                      </Link>
                    ) : (
                      <div className="mt-2.5">
                        <StatusPill status={bookingStatusLabel(booking, today)} />
                      </div>
                    )
                  }
                </GuestRow>
              ))}
            </ul>
          </section>
        ) : null}

        {site ? <p className="mt-5 text-[0.8125rem] leading-normal text-ink-soft">{SITE_BOOKING_READ_ONLY_TEXT}</p> : null}
        {contacts.length || cancellable ? (
          <div className="mt-5 flex flex-col gap-2.5 md:flex-row md:flex-wrap">
            {contacts.length ? (
              <button type="button" onClick={() => setAsking("contact")} className={consoleButtonClass("secondary", "md", "max-md:w-full")}>
                参加者に連絡する
              </button>
            ) : null}
            {cancellable ? (
              <button type="button" onClick={() => setAsking("cancel")} className={`${DANGER_BUTTON} max-md:w-full`}>
                この回を中止する（雨天・急病など）
              </button>
            ) : null}
          </div>
        ) : null}
      </HostPageBody>

      {asking === "contact" ? <SessionContactDialog contacts={contacts} onClose={() => setAsking(null)} /> : null}
      {asking === "cancel" ? (
        <SessionCancelDialog
          when={`${shortDateWithWeekdayJa(session.date)}${session.start}`}
          plan={sessionCancelPlan(sessionCancelTargets(bookings))}
          onConfirm={cancel}
          onClose={() => setAsking(null)}
        />
      ) : null}
    </>
  );
}
