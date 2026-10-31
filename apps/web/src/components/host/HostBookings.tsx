"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, type MouseEvent } from "react";
import { cancelSiteBooking, loadMoreSiteBookingList } from "@/host/actions";
import {
  actionTime,
  approveBooking,
  bookingActions,
  BOOKING_FILTERS,
  bookingFilterOf,
  bookingGroups,
  bookingRowDetail,
  bookingsHref,
  bookingStatusLabel,
  cancelBooking,
  declineBooking,
  sessionHref,
  type BookingCancellation,
  type BookingExperience,
  type BookingGroup,
} from "@/host/bookings";
import { yen } from "@/host/format";
import { messagesHref, type BookingConversation } from "@/host/messages";
import { mergeSiteBookings, mergeSiteExperiences, SITE_BOOKING_LOAD_FAILED_TEXT } from "@/host/site-bookings";
import type { HostBooking } from "@/host/types";
import { useFocusAfterRender } from "./editor-parts";
import type { SiteCancelChoice } from "./HostSiteCancelDialogs";
import { HostBookingDetail, type BookingConversationLink } from "./HostBookingDetail";
import { HostIcon } from "./HostIcon";
import { HostSubHeader } from "./HostSubHeader";
import { consoleButtonClass, HOST_SURFACE } from "./host-ui";
import { HostPageBody, PageHead, StatusPill } from "./ui";

/** The list and one booking side by side from lg (64rem); below it, one of them at a time. */
const TWO_COLUMNS = "(min-width: 64rem)";
const DETAIL_HEADING = "booking-detail-heading";
const rowId = (id: string) => `booking-row-${id}`;

/** When an action happens (called from events, never while rendering). */
function actionNow(today: string): string {
  return actionTime(today, Date.now());
}

/** A plain left click moves inside the screen; a click meant for a new tab or window follows the link as usual. */
function plainClick(event: MouseEvent): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

/** A session heading's words: its day and time, the experience and the seats. */
function SessionWords({ group }: { group: BookingGroup }) {
  return (
    <>
      <span className="shrink-0">{group.label}</span>
      <span className="sr-only"> · </span>
      <span className="min-w-0 flex-1 truncate text-muted">{group.title}</span>
      <span className="sr-only"> · </span>
      <span className="shrink-0 tabular-nums">{group.seats}</span>
    </>
  );
}

export interface HostBookingsProps {
  bookings: readonly HostBooking[];
  experiences: readonly BookingExperience[];
  /** The day the list counts from (YYYY-MM-DD, JST). */
  today: string;
  /** The moment actions are dated with: the preview's fixed one (mock mode), or null for the clock. */
  now: string | null;
  /** The URL's own `?providerId=` (when well formed), carried on every link. */
  providerId: string | null;
  /** The provider actually shown (not only the optional URL query). */
  providerDataId: string;
  supportPreview: boolean;
  supportHistoryEnabled: boolean;
  feeSummaryEnabled: boolean;
  /** 通訳を始める (#181): whether the translate BFF is open. */
  translateEnabled: boolean;
  /** The last message of each booking's thread (メッセージ, #106). */
  conversations: readonly BookingConversation[];
  /**
   * Bookings made on this site (#285 slice 8, experience DB, http mode), read only: a session's heading opens
   * their この回 (slice 8b) and no booking leads to メッセージ yet. `nextCursor` reads the rest of the list (続きを見る),
   * null when it holds them all. `besideNiho`: NIHO's bookings are the screen's own and these are its
   * `?source=site`, which every link keeps, with the way back. Absent in mock mode.
   */
  live?: { nextCursor: string | null; besideNiho: boolean } | null;
}

/**
 * 予約 (#90, mock v2 `screenBookings`): the list on the left with its filter chips and the
 * experience select, one booking on the right (PC, 400px, sticky). On phones the booking is a
 * sub screen of its own (`?booking=`): "‹ 予約" instead of the header and the tabs.
 *
 * The filter, the experience and the booking live in the URL and change with pushState, so
 * the page is not loaded again and the bookings keep what happened to them on this screen
 * (mock mode: 承認・お断り・取消 change them here only; the preview note says nothing is kept).
 * メッセージ leads to the booking's thread (#106). TODO(#87): send the actions to NIHO and show
 * the booking it reads back. A session's heading opens its own screen (この回, #107).
 */
export function HostBookings({ bookings: initialBookings, experiences: initialExperiences, today, now, providerId, providerDataId, supportPreview, supportHistoryEnabled, feeSummaryEnabled, translateEnabled, conversations, live = null }: HostBookingsProps) {
  const searchParams = useSearchParams();
  const [bookings, setBookings] = useState<readonly HostBooking[]>(initialBookings);
  /** Live: the experiences the loaded bookings name, and where the rest of the list starts (null once all are here). */
  const [experiences, setExperiences] = useState(initialExperiences);
  const [cursor, setCursor] = useState<string | null>(live?.nextCursor ?? null);
  const [more, setMore] = useState<{ busy: boolean; failed: string | null }>({ busy: false, failed: null });
  const [notice, setNotice] = useState<{ bookingId: string; text: string } | null>(null);
  /** 取り消して全額を返金する on a booking made here (#285 slice 7): the one being sent, and what failed. */
  const [siteCancel, setSiteCancel] = useState<{ bookingId: string; busy: boolean; error: string | null } | null>(null);
  const focusLater = useFocusAfterRender();
  const focusDetail = useRef(false);
  const lastOpened = useRef<string | null>(null);

  const filter = bookingFilterOf(searchParams.get("filter"));
  const requestedExperience = searchParams.get("experience");
  const experienceId = experiences.some((experience) => experience.id === requestedExperience) ? requestedExperience : null;
  const selectedId = searchParams.get("booking") || null;
  const sub = selectedId !== null;
  const source = live?.besideNiho ? "site" : null;
  const query = { providerId, source, filter, experience: experienceId } as const;
  const listHref = bookingsHref(query);

  const groups = bookingGroups(bookings, experiences, { filter, experienceId }, today);
  const selected = selectedId ? (bookings.find((booking) => booking.id === selectedId) ?? null) : null;
  // From lg the first booking of the list shows until one is chosen; below lg the list does.
  const shown = sub ? selected : (groups[0]?.bookings[0] ?? null);
  const titleOf = (id: string) => experiences.find((experience) => experience.id === id)?.title ?? "";
  /** The booking's thread, or the way to start one while the guest can still be written to. */
  const conversationOf = (booking: HostBooking): BookingConversationLink | null => {
    // This site's bookings (#285) have no thread with the guest until slice 6.
    if (booking.site) return null;
    const thread = conversations.find((conversation) => conversation.bookingId === booking.id);
    if (thread) return { href: messagesHref({ providerId, thread: thread.threadId }), last: { text: thread.text, at: thread.at } };
    return bookingActions(booking.status).message ? { href: messagesHref({ providerId, booking: booking.id }), last: null } : null;
  };

  // Below lg, opening a booking replaces the list: focus its name. Coming back puts focus on its row again.
  useEffect(() => {
    if (selectedId) {
      lastOpened.current = selectedId;
      if (focusDetail.current) document.getElementById(DETAIL_HEADING)?.focus();
      focusDetail.current = false;
      return;
    }
    const back = lastOpened.current;
    lastOpened.current = null;
    if (back && !window.matchMedia(TWO_COLUMNS).matches) document.getElementById(rowId(back))?.focus();
  }, [selectedId]);

  /** Another view of this screen, without loading the page again. */
  const move = (event: MouseEvent<HTMLAnchorElement>, href: string) => {
    if (!plainClick(event)) return;
    event.preventDefault();
    window.history.pushState(null, "", href);
  };

  const open = (event: MouseEvent<HTMLAnchorElement>, id: string) => {
    if (!plainClick(event)) return;
    event.preventDefault();
    window.history.pushState(null, "", bookingsHref({ ...query, booking: id }));
    if (!window.matchMedia(TWO_COLUMNS).matches) {
      window.scrollTo(0, 0);
      focusDetail.current = true;
    }
  };

  /** Applies an action to one booking. One shown without being chosen (the first of the list) becomes the chosen one, so it stays on screen. */
  const change = (id: string, apply: (booking: HostBooking, at: string) => HostBooking): { before: HostBooking; after: HostBooking } | null => {
    const before = bookings.find((booking) => booking.id === id);
    if (!before) return null;
    const after = apply(before, now ?? actionNow(today));
    setBookings(bookings.map((booking) => (booking.id === id ? after : booking)));
    if (selectedId !== id) window.history.replaceState(null, "", bookingsHref({ ...query, booking: id }));
    return { before, after };
  };

  /** Live: 続きを見る joins the next page to the list (a booking already on it keeps what it holds). */
  const loadMore = async () => {
    if (!cursor || more.busy) return;
    setMore({ busy: true, failed: null });
    let result: Awaited<ReturnType<typeof loadMoreSiteBookingList>>;
    try {
      result = await loadMoreSiteBookingList({ providerId: providerDataId, cursor });
    } catch {
      setMore({ busy: false, failed: SITE_BOOKING_LOAD_FAILED_TEXT });
      return;
    }
    if (!result.ok) {
      setMore({ busy: false, failed: result.message });
      return;
    }
    setBookings((current) => mergeSiteBookings(current, result.bookings));
    setExperiences((current) => mergeSiteExperiences(current, result.experiences));
    setCursor(result.nextCursor);
    setMore({ busy: false, failed: null });
  };

  /**
   * Live: the OWNER cancels a booking made here with a full refund. The store answers the booking as it is now, which
   * replaces the one on the list. The command's UUID is new for each confirmation: a second confirmation of a booking
   * already cancelled changes nothing and says so.
   */
  const cancelSite = async (id: string, choice: SiteCancelChoice) => {
    if (siteCancel?.busy) return;
    setSiteCancel({ bookingId: id, busy: true, error: null });
    let result: Awaited<ReturnType<typeof cancelSiteBooking>>;
    try {
      result = await cancelSiteBooking({ providerId: providerDataId, bookingId: id, commandId: crypto.randomUUID(), reason: choice.reason, note: choice.note });
    } catch {
      setSiteCancel({ bookingId: id, busy: false, error: SITE_BOOKING_LOAD_FAILED_TEXT });
      return;
    }
    if (!result.ok) {
      setSiteCancel({ bookingId: id, busy: false, error: result.message });
      return;
    }
    const updated = result.booking;
    setBookings((current) => current.map((booking) => (booking.id === id ? updated : booking)));
    if (selectedId !== id) window.history.replaceState(null, "", bookingsHref({ ...query, booking: id }));
    setSiteCancel(null);
    report(id, result.message);
  };

  /** After 承認・お断り・取消: the result in words, and focus on the booking's name (the button pressed is gone). */
  const report = (id: string, text: string) => {
    setNotice({ bookingId: id, text });
    focusLater(DETAIL_HEADING);
  };

  return (
    <>
      {sub ? <HostSubHeader backHref={listHref} backLabel="予約" title={selected?.guest ?? "予約"} onBack={(event) => move(event, listHref)} /> : null}
      <HostPageBody>
        <div data-sub={sub ? "detail" : undefined} className="lg:grid lg:grid-cols-[minmax(0,1fr)_400px] lg:items-start lg:gap-5">
          <div className={`min-w-0 ${sub ? "max-lg:hidden" : ""}`}>
            <PageHead title="予約">
              <select
                aria-label="体験"
                value={experienceId ?? ""}
                onChange={(event) => window.history.pushState(null, "", bookingsHref({ providerId, source, filter, experience: event.currentTarget.value || null }))}
                className="block min-h-10 w-auto max-w-full min-w-0 rounded-[10px] border border-line-strong bg-canvas py-2 pr-2 pl-3 text-[1rem] leading-normal text-ink md:max-w-[300px] md:text-[0.875rem]"
              >
                <option value="">すべての体験</option>
                {experiences.map((experience) => (
                  <option key={experience.id} value={experience.id}>
                    {experience.title}
                  </option>
                ))}
              </select>
            </PageHead>
            {live ? (
              <p className="mb-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.8125rem] leading-normal text-ink-soft">
                <span>このサイトで受けた予約です</span>
                {live.besideNiho ? (
                  <Link href={bookingsHref({ providerId })} className="inline-flex items-center font-extrabold text-ink underline-offset-2 hover:underline">
                    <HostIcon name="chevronLeft" className="size-4" />
                    NIHO の予約に戻る
                  </Link>
                ) : null}
              </p>
            ) : null}

            <ul aria-label="予約の絞り込み" className="-mx-1.5 mb-1.5 flex gap-2 overflow-x-auto p-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {BOOKING_FILTERS.map((item) => {
                const current = item.value === filter;
                const href = bookingsHref({ providerId, source, filter: item.value, experience: experienceId });
                return (
                  <li key={item.value} className="shrink-0">
                    <a
                      href={href}
                      aria-current={current ? "page" : undefined}
                      onClick={(event) => move(event, href)}
                      className={`inline-flex h-8 items-center rounded-full border px-3 text-[0.8125rem] font-bold whitespace-nowrap ${current ? "border-leaf bg-leaf-pale text-moss" : "border-line-strong bg-canvas text-ink-soft hover:bg-sand"}`}
                    >
                      {item.label}
                    </a>
                  </li>
                );
              })}
            </ul>

            <section aria-label="予約の一覧" className={`${HOST_SURFACE} overflow-hidden`}>
              {groups.length ? (
                groups.map((group) => (
                  <div key={group.key} className="border-t border-line first:border-t-0">
                    {/* One session: its day and time, the experience and the seats its requests and bookings keep. It opens the session (この回), apart from the rows' bookings. */}
                    <h2 className="font-sans text-xs leading-normal font-extrabold tracking-normal text-ink-soft">
                      {/* This site's sessions keep `?source=site` beside NIHO's bookings, so この回 leads back here (#285 slice 8b). */}
                      <Link href={sessionHref({ providerId, source, ...group })} className="flex min-h-9 items-center gap-2 bg-sand/60 px-3.5 py-2 hover:bg-sand focus-visible:outline-offset-[-3px] md:px-4">
                        <SessionWords group={group} />
                        <HostIcon name="chevronRight" className="size-3.5 text-muted" />
                      </Link>
                    </h2>
                    <ul>
                      {group.bookings.map((booking) => {
                        const chosen = booking.id === selectedId;
                        // From lg, the booking shown on the right without being chosen is marked the same way.
                        const marked = chosen ? "bg-sand" : booking.id === shown?.id ? "hover:bg-sand/60 lg:bg-sand" : "hover:bg-sand/60";
                        return (
                          <li key={booking.id} className="border-t border-line">
                            <a
                              id={rowId(booking.id)}
                              href={bookingsHref({ ...query, booking: booking.id })}
                              aria-current={chosen ? "true" : undefined}
                              onClick={(event) => open(event, booking.id)}
                              className={`flex min-h-[52px] items-center gap-3 px-3.5 py-3 focus-visible:outline-offset-[-3px] md:px-4 ${marked}`}
                            >
                              <span className="min-w-0 flex-1">
                                <span className="block text-[0.875rem] leading-[1.4] font-extrabold [overflow-wrap:anywhere]">{booking.guest}</span>
                                <span className="block text-[0.78125rem] leading-normal text-muted">{bookingRowDetail(booking)}</span>
                              </span>
                              <StatusPill status={bookingStatusLabel(booking, today)} />
                              <HostIcon name="chevronRight" className="size-4 text-line-strong max-md:hidden" />
                            </a>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ))
              ) : (
                <p className="px-4 py-6 text-muted md:px-5">{bookings.length ? "該当する予約はありません" : "まだ予約はありません"}</p>
              )}
              {live && cursor ? (
                <div className="border-t border-line p-3">
                  {more.failed ? <p role="alert" className="mb-2 text-[0.8125rem] text-ink-soft">{more.failed}</p> : null}
                  <button type="button" disabled={more.busy} onClick={() => void loadMore()} className={consoleButtonClass("secondary", "sm")}>
                    {more.busy ? "読み込み中…" : "続きを見る"}
                  </button>
                </div>
              ) : null}
            </section>
          </div>

          <div className={`min-w-0 ${sub ? "" : "max-lg:hidden"} lg:sticky lg:top-4 lg:max-h-[calc(100dvh-2rem)] lg:overflow-y-auto`}>
            {sub ? (
              <>
                {/* The list, with the page's title, is hidden below lg while one booking is open. */}
                <h1 className="sr-only lg:hidden">予約</h1>
                <a href={listHref} onClick={(event) => move(event, listHref)} className="mb-3 hidden h-9 items-center pr-1.5 text-[0.9375rem] font-extrabold md:inline-flex lg:hidden">
                  <HostIcon name="chevronLeft" className="size-5" />
                  予約<span className="sr-only">へ戻る</span>
                </a>
              </>
            ) : null}
            {shown ? (
              <HostBookingDetail
                // Each booking starts with its dialogs closed.
                key={shown.id}
                booking={shown}
                experienceTitle={titleOf(shown.experienceId)}
                today={today}
                headingId={DETAIL_HEADING}
                notice={notice?.bookingId === shown.id ? notice.text : ""}
                conversation={conversationOf(shown)}
                providerId={providerDataId}
                supportPreview={supportPreview}
                supportHistoryEnabled={supportHistoryEnabled}
                feeSummaryEnabled={feeSummaryEnabled}
                translateEnabled={translateEnabled}
                onApprove={() => {
                  if (change(shown.id, approveBooking)) report(shown.id, "申込を承認しました。予約が確定しました");
                }}
                onDecline={() => {
                  if (change(shown.id, declineBooking)) report(shown.id, "申込をお断りしました");
                }}
                onSiteCancel={live && shown.site ? (choice) => void cancelSite(shown.id, choice) : undefined}
                siteCancel={siteCancel?.bookingId === shown.id ? siteCancel : undefined}
                onCancel={(cancellation: BookingCancellation) => {
                  const done = change(shown.id, (booking, at) => cancelBooking(booking, cancellation, at));
                  if (!done) return;
                  const refunded = done.after.refundedYen - done.before.refundedYen;
                  report(shown.id, refunded > 0 ? `予約を取り消し、${yen(refunded)} を返金しました` : "予約を取り消しました");
                }}
              />
            ) : sub ? (
              <section className={`${HOST_SURFACE} px-5 py-8`}>
                <h2 className="font-sans text-[0.9375rem] leading-normal font-extrabold tracking-normal">この予約は見つかりませんでした</h2>
                <p className="mt-1 text-ink-soft">一覧から選び直してください。</p>
              </section>
            ) : null}
          </div>
        </div>
      </HostPageBody>
    </>
  );
}
