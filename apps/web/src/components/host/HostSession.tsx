"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { actionTime, bookingsHref, bookingStatusLabel, respondByLabel } from "@/host/bookings";
import type { HostSessionView } from "@/host/console-data";
import { shortDateWithWeekdayJa, todayInJapan } from "@/host/format";
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
import { cancelSiteSession, recordSiteAttendance } from "@/host/actions";
import { SITE_BOOKING_LOAD_FAILED_TEXT, SITE_BOOKING_PAYMENT_REVIEW_TEXT, SITE_SESSION_SUPPORT_TEXT, siteCancellationLines } from "@/host/site-bookings";
import { SITE_ATTENDANCE_FAILED_TEXT, siteSessionCountLines } from "@/host/site-sessions";
import type { HostAttendance, HostBooking } from "@/host/types";
import { DISABLED, useFocusAfterRender } from "./editor-parts";
import { DANGER_BUTTON } from "./HostBookingDialogs";
import { HostIcon } from "./HostIcon";
import { SessionCancelDialog, SessionContactDialog, type SessionContact } from "./HostSessionDialogs";
import { SiteSessionCancelDialog, type SiteCancelChoice } from "./HostSiteCancelDialogs";
import { HostSubHeader } from "./HostSubHeader";
import { consoleButtonClass, HOST_SURFACE } from "./host-ui";
import { HostPageBody, InitialAvatar, SectionTitle, StatusPill, SubPageHead } from "./ui";

const CANCELLED_HEADING = "session-cancelled";
/** This site's bookings: how often the screen's clock moves on, so 出欠 opens at the start without a reload. */
const CLOCK_MS = 30_000;
const NOTICE = "flex items-start gap-1.5 rounded-xl bg-leaf-pale px-3 py-2 text-[0.8125rem] leading-normal font-bold text-moss";

export interface HostSessionProps {
  session: HostSessionView;
  /**
   * The moment the session is seen from (YYYY-MM-DDTHH:MM, JST; the preview's fixed one in mock mode): whether it has
   * started, and when an action is dated. This site's bookings move on from it with the time in Japan.
   */
  now: string;
  /** The threads of the session's bookings (#106). */
  conversations: readonly BookingConversation[];
  /** The URL's own `?providerId=` (when well formed), carried on every link. */
  providerId: string | null;
  /**
   * Bookings made on this site (#285 slice 8b, experience DB, http mode): calling the session off cancels every
   * confirmed booking with a full refund (slice 7, `providerId` is the provider shown). `messages`: each guest leads
   * to their booking's thread (slice 6b). `attendance`: 出欠 is kept in the experience DB (#107, its flag), sent for
   * `providerId`. `besideNiho`: NIHO's bookings are 予約's own and these are its `?source=site`, where "‹ 予約" goes
   * back. Absent in mock mode.
   */
  site?: { besideNiho: boolean; providerId?: string; messages?: boolean; attendance?: boolean } | null;
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

/**
 * 来た / 来なかった: 44px toggles, both unpressed while 未記録; disabled before the start, and while a mark is being
 * kept (`saving`, this site's bookings). `noShowNote`: what 来なかった means for the guest, where it is so.
 */
function Attendance({ booking, open, saving = false, noShowNote = true, onMark }: { booking: HostBooking; open: boolean; saving?: boolean; noShowNote?: boolean; onMark: (value: HostAttendance) => void }) {
  return (
    <>
      <div role="group" aria-label={`${booking.guest} さんの出欠`} aria-busy={saving || undefined} className="mt-3 grid max-w-[320px] grid-cols-2 gap-2">
        {ATTENDANCE_CHOICES.map((choice) => {
          const pressed = booking.attendance === choice.value;
          return (
            <button
              key={choice.value}
              type="button"
              aria-pressed={pressed}
              disabled={!open || saving}
              onClick={() => onMark(choice.value)}
              className={`${SEGMENT} ${DISABLED} ${pressed ? (choice.value === "attended" ? "border-moss bg-leaf-pale text-moss" : "border-ink-soft bg-sand text-ink") : "border-line-strong bg-canvas text-ink-soft hover:bg-sand"}`}
            >
              {pressed ? <HostIcon name="check" className="size-4" /> : null}
              {choice.label}
            </button>
          );
        })}
      </div>
      {saving ? <p className="mt-1.5 text-xs text-muted">記録しています…</p> : booking.attendance === "no_show" && noShowNote ? <p className="mt-1.5 text-xs text-muted">{NO_SHOW_NOTE}</p> : null}
    </>
  );
}

/**
 * One guest: who, how many, from where, how to reach them on the day, what to look out for, and the way to their
 * thread (`messageHref` null where there is none).
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
 * This site's bookings (`site`, #285 slices 8b and 7): the guests with their phones, words and payments under review
 * (確認待ち, counted with the participants as ホーム counts them), and, before the start, この回を中止 with full refunds;
 * afterwards each guest's row says how their booking was cancelled and where its refund is. With `site.attendance`
 * (#107) the capacity and 来た / 来なかった, kept in the experience DB one booking at a time: the screen shows what the
 * store kept, and a failure leaves the mark as it was.
 */
export function HostSession({ session, now, conversations, providerId, site = null }: HostSessionProps) {
  const [bookings, setBookings] = useState<readonly HostBooking[]>(session.bookings);
  const [notice, setNotice] = useState("");
  const [cancellation, setCancellation] = useState<{ reason: SessionCancelReason; results: SessionCancelResult[] } | null>(null);
  const [asking, setAsking] = useState<"contact" | "cancel" | "siteCancel" | null>(null);
  /** この回を中止 of this site's bookings (#285 slice 7): while it is sent, and what failed. */
  const [siteCancel, setSiteCancel] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  /** 出欠 of this site's bookings (#107): the bookings whose mark is being kept, and the last failure. */
  const [saving, setSaving] = useState<ReadonlySet<string>>(() => new Set());
  const [attendanceError, setAttendanceError] = useState("");
  const focusLater = useFocusAfterRender();
  // The moment the screen stands at: the page's for the preview (fixed) and the first render; this site's bookings
  // follow the time in Japan from then on (the store still decides by its own clock).
  const [clock, setClock] = useState(now);
  const live = site !== null;
  useEffect(() => {
    if (!live) return;
    const tick = () => {
      const at = Date.now();
      setClock(actionTime(todayInJapan(at), at));
    };
    const timer = window.setInterval(tick, CLOCK_MS);
    return () => window.clearInterval(timer);
  }, [live]);

  const heading = sessionHeading(session);
  const backHref = bookingsHref({ providerId, source: site?.besideNiho ? "site" : null });
  const phase = sessionPhase(session, clock);
  const today = clock.slice(0, 10);
  const { participants, requests } = sessionSections(session.bookings, bookings);
  const counts = site ? siteSessionCountLines(bookings, session.capacity) : sessionCountLines(bookings, session.capacity);
  // 出欠 is recorded in mock mode (on this screen) and for this site's bookings where it is kept (#107).
  const recordsAttendance = !site || Boolean(site.attendance && site.providerId);
  const dietary = dietarySummary(bookings);
  const attendance = attendanceCounts(bookings);
  const failed = cancellation?.results.filter((result) => !result.ok) ?? [];

  const messageHref = (booking: HostBooking) => {
    // This site's bookings (#285 slice 6b): the booking's thread, or its empty one, among this site's threads.
    if (site) return site.messages ? messagesHref({ providerId, source: site.besideNiho ? "site" : null, booking: booking.id }) : null;
    const thread = conversations.find((conversation) => conversation.bookingId === booking.id);
    return thread ? messagesHref({ providerId, thread: thread.threadId }) : messagesHref({ providerId, booking: booking.id });
  };
  const contacts: SessionContact[] = [...participants, ...requests].flatMap((booking) => {
    const href = messageHref(booking);
    return href ? [{ id: booking.id, guest: booking.guest, people: `${booking.guests}名`, status: booking.status === "confirmed" ? null : bookingStatusLabel(booking, today), href }] : [];
  });
  // This site's bookings are called off with their own action (full refunds, by the store), below.
  const cancellable = !site && canCancelSession(bookings, phase, cancellation !== null);
  const siteConfirmed = site ? bookings.filter((booking) => booking.status === "confirmed") : [];
  const siteCancellable = Boolean(site?.providerId) && phase === "before" && siteConfirmed.length > 0;

  /** Live: the OWNER calls the session off; the store answers the session as it is now. */
  const cancelSite = async (choice: SiteCancelChoice) => {
    if (!site?.providerId || siteCancel.busy) return;
    setSiteCancel({ busy: true, error: null });
    let result: Awaited<ReturnType<typeof cancelSiteSession>>;
    try {
      result = await cancelSiteSession({
        providerId: site.providerId, date: session.date, start: session.start, experience: session.experienceId, offer: session.offerId,
        commandId: crypto.randomUUID(), reason: choice.reason, note: choice.note,
      });
    } catch {
      setSiteCancel({ busy: false, error: SITE_BOOKING_LOAD_FAILED_TEXT });
      return;
    }
    if (!result.ok) {
      setSiteCancel({ busy: false, error: result.message });
      return;
    }
    if (result.session) setBookings(result.session.bookings);
    setSiteCancel({ busy: false, error: null });
    setNotice(result.message);
  };

  const mark = (id: string, value: HostAttendance) => {
    const booking = bookings.find((item) => item.id === id);
    if (!booking || !canRecordAttendance(booking, phase)) return;
    if (site) {
      void markSite(booking, value);
      return;
    }
    setBookings(bookings.map((item) => (item.id === id ? recordAttendance(item, value, phase) : item)));
    setNotice(attendanceNotice(booking, value));
  };

  /** Live (#107): the store keeps the mark once the session has started by its clock; the row shows what it kept. */
  const markSite = async (booking: HostBooking, value: HostAttendance) => {
    if (!site?.providerId || saving.has(booking.id)) return;
    setSaving((current) => new Set(current).add(booking.id));
    setAttendanceError("");
    let result: Awaited<ReturnType<typeof recordSiteAttendance>>;
    try {
      result = await recordSiteAttendance({ providerId: site.providerId, bookingId: booking.id, attendance: value });
    } catch {
      result = { ok: false, message: SITE_ATTENDANCE_FAILED_TEXT };
    }
    setSaving((current) => {
      const next = new Set(current);
      next.delete(booking.id);
      return next;
    });
    if (!result.ok) {
      setAttendanceError(`${booking.guest} さん: ${result.message}`);
      return;
    }
    const kept = result.attendance;
    setBookings((current) => current.map((item) => (item.id === booking.id ? { ...item, attendance: kept } : item)));
    setNotice(kept ? attendanceNotice(booking, kept) : "");
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
              <p className={`text-xs font-extrabold ${phase === "before" ? "text-muted" : "text-moss"}`}>{sessionPhaseLine(session, clock)}</p>
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
            {phase !== "before" && recordsAttendance ? <Row label="出欠">{attendanceSummary(attendance)}</Row> : null}
          </dl>
        </section>

        <section aria-labelledby="session-guests" className={`${HOST_SURFACE} mt-3.5`}>
          <div className="px-4 pt-4 pb-2 md:px-5">
            <SectionTitle id="session-guests">参加者</SectionTitle>
            {phase === "before" && recordsAttendance && participants.some((booking) => booking.status === "confirmed") ? <p className="mt-0.5 text-xs text-muted">出欠は{ATTENDANCE_LOCKED_TEXT}</p> : null}
          </div>
          {attendanceError ? <p role="alert" className="mx-4 mb-2 text-[0.8125rem] leading-normal font-bold text-danger md:mx-5">{attendanceError}</p> : null}
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
                      ) : booking.status === "cancelled" ? (
                        // Cancelled on this screen (この回を中止): how it went for this booking, and where its refund is.
                        <div className="mt-2.5">
                          <StatusPill status={bookingStatusLabel(booking, today)} />
                          <ul aria-label="取消と返金" className="mt-1.5 text-[0.78125rem] leading-normal">
                            {siteCancellationLines(booking).map((line) => (
                              <li key={line} className={line.startsWith("返金に失敗") ? "font-extrabold text-danger" : "text-ink-soft"}>{line}</li>
                            ))}
                          </ul>
                        </div>
                      ) : recordsAttendance ? (
                        // 来なかった keeps the guest's thanks and review request as they are: nothing here holds them back yet.
                        <Attendance booking={booking} open={canRecordAttendance(booking, phase)} saving={saving.has(booking.id)} noShowNote={false} onMark={(value) => mark(booking.id, value)} />
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

        {site ? (
          <div className="mt-5">
            {siteCancel.error ? <p role="alert" className="mb-2 text-[0.8125rem] leading-normal font-bold text-danger">{siteCancel.error}</p> : null}
            {siteCancellable ? (
              <button type="button" disabled={siteCancel.busy} aria-busy={siteCancel.busy || undefined} onClick={() => setAsking("siteCancel")} className={`${DANGER_BUTTON} mb-2 max-md:w-full`}>
                {siteCancel.busy ? "中止しています…" : "この回を中止する（全員に全額返金）"}
              </button>
            ) : null}
            <p className="text-[0.8125rem] leading-normal text-ink-soft">{SITE_SESSION_SUPPORT_TEXT}</p>
          </div>
        ) : null}
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
      {asking === "siteCancel" ? (
        <SiteSessionCancelDialog
          when={`${shortDateWithWeekdayJa(session.date)}${session.start}`}
          bookings={siteConfirmed.length}
          refundYen={siteConfirmed.reduce((total, booking) => total + booking.amountYen, 0)}
          onConfirm={(choice) => void cancelSite(choice)}
          onClose={() => setAsking(null)}
        />
      ) : null}
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
