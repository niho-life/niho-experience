"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type MouseEvent } from "react";
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
import { nihoBookingExperiences, nihoBookingRow, nihoRowStatusLabel, type NihoBookingRow } from "@/host/niho-bookings";
import { mergeSiteBookings, mergeSiteExperiences, SITE_BOOKING_LOAD_FAILED_TEXT } from "@/host/site-bookings";
import type { HostBooking } from "@/host/types";
import { useFocusAfterRender } from "./editor-parts";
import type { SiteCancelChoice } from "./HostSiteCancelDialogs";
import { HostBookingDetail, type BookingConversationLink } from "./HostBookingDetail";
import { HostIcon } from "./HostIcon";
import { HostLeaveDialog, useHostLeaveGuard, type HostLeaveMode } from "./HostLeaveGuard";
import { HostNihoBookingDetail, type NihoDetailLock, type NihoReplyDraft } from "./HostNihoBookingDetail";
import { HostSubHeader } from "./HostSubHeader";
import { consoleButtonClass, HOST_SURFACE } from "./host-ui";
import { HostPageBody, PageHead, StatusPill } from "./ui";
import { useNihoBookingList } from "./use-niho-bookings";

/** The list and one booking side by side from lg (64rem); below it, one of them at a time. */
const TWO_COLUMNS = "(min-width: 64rem)";
const DETAIL_HEADING = "booking-detail-heading";
const rowId = (id: string) => `booking-row-${id}`;

/** When an action happens (called from events, never while rendering). */
function actionNow(today: string): string {
  return actionTime(today, Date.now());
}

/** Whether the list and one booking stand side by side (lg); false while rendering on the server. */
function useTwoColumns(): boolean {
  return useSyncExternalStore(
    (changed) => {
      const query = window.matchMedia(TWO_COLUMNS);
      query.addEventListener("change", changed);
      return () => query.removeEventListener("change", changed);
    },
    () => window.matchMedia(TWO_COLUMNS).matches,
    () => false,
  );
}

/** A row of the list: this site's or the preview's booking, or one of NIHO's beside them (#84). */
type ListRow = HostBooking | NihoBookingRow;
const isNiho = (row: ListRow): row is NihoBookingRow => "niho" in row;

/** The select's experiences: one per title (NIHO's page and this site's product of one experience are one choice). */
function experienceChoices(experiences: readonly BookingExperience[]): BookingExperience[] {
  const seen = new Set<string>();
  return experiences.filter((experience) => !seen.has(experience.title) && seen.add(experience.title));
}

/** NIHO's lock while nothing is with NIHO. */
const UNLOCKED: NihoDetailLock = { acting: false, uncertain: false };
const NO_DRAFTS: Readonly<Record<string, NihoReplyDraft>> = {};

/** A plain left click moves inside the screen; a click meant for a new tab or window follows the link as usual. */
function plainClick(event: MouseEvent): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

/** A session heading's words: its day and time, the experience and the seats. */
function SessionWords({ group }: { group: BookingGroup<ListRow> }) {
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
   * Bookings made on this site (#285 slice 8, experience DB, http mode): a session's heading opens their この回
   * (slice 8b), and the OWNER may cancel one with a full refund (slice 7). `nextCursor` reads the rest of the list
   * (続きを見る), null when it holds them all. `messages`: each booking leads to its messages with the guest (#285
   * slice 6b; メッセージ opens the booking's thread, or its empty one). `preview`: the preview's synthetic ones
   * (`?mock=site-bookings`), read only. Absent in mock mode otherwise.
   */
  live?: { nextCursor: string | null; messages?: boolean; preview?: boolean } | null;
  /**
   * NIHO's bookings beside this site's (#84, provider operations on): read from NIHO in the browser and put on the
   * same list, each with NIHO's channel ("NIHO", "NIHO（体験サイト）"). One of them opens NIHO's booking
   * (HostNihoBookingDetail) with what NIHO lets the host do with it. Their sessions have no この回 here (NIHO's
   * bookings keep NIHO's, ADR 0002). Absent while NIHO's bookings are not connected.
   */
  niho?: { providerId: string; translate: { today: string } | null } | null;
}

/**
 * 予約 (#90, mock v2 `screenBookings`): the list on the left with its filter chips and the
 * experience select, one booking on the right (PC, 400px, sticky). On phones the booking is a
 * sub screen of its own (`?booking=`): "‹ 予約" instead of the header and the tabs. With `niho`,
 * NIHO's bookings and this site's are one list (#84).
 *
 * The filter, the experience and the booking live in the URL and change with pushState, so
 * the page is not loaded again and the bookings keep what happened to them on this screen
 * (mock mode: 承認・お断り・取消 change them here only; the preview note says nothing is kept).
 * メッセージ leads to the booking's thread (#106). TODO(#87): send the actions to NIHO and show
 * the booking it reads back. A session's heading opens its own screen (この回, #107).
 */
export function HostBookings({ bookings: initialBookings, experiences: initialExperiences, today, now, providerId, providerDataId, supportPreview, supportHistoryEnabled, feeSummaryEnabled, translateEnabled, conversations, live = null, niho = null }: HostBookingsProps) {
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
  const twoColumns = useTwoColumns();

  // NIHO's bookings beside this site's (#84): the list NIHO reads, and the booking with NIHO now.
  const [nihoLock, setNihoLock] = useState<NihoDetailLock>(UNLOCKED);
  const [drafts, setDrafts] = useState<Readonly<Record<string, NihoReplyDraft>>>(NO_DRAFTS);
  const dropNihoLock = useCallback(() => setNihoLock(UNLOCKED), []);
  const nihoList = useNihoBookingList(niho?.providerId ?? providerDataId, { enabled: Boolean(niho), onRevoke: dropNihoLock });
  const nihoRows = useMemo(() => nihoList.items.map(nihoBookingRow), [nihoList.items]);
  const listExperiences = useMemo(() => (niho ? mergeSiteExperiences(experiences, nihoBookingExperiences(nihoList.items)) : experiences), [niho, experiences, nihoList.items]);
  const rows: readonly ListRow[] = niho ? [...bookings, ...nihoRows] : bookings;
  const nihoLocked = nihoLock.acting || nihoLock.uncertain;
  const hasDraft = Object.values(drafts).some((draft) => draft.subject.trim() || draft.body.trim());
  const leaveMode: HostLeaveMode = nihoLock.acting ? "saving" : nihoLock.uncertain ? "unknown" : hasDraft ? "dirty" : null;
  const leaveGuard = useHostLeaveGuard(leaveMode);

  const filter = bookingFilterOf(searchParams.get("filter"));
  const choices = experienceChoices(listExperiences);
  const requestedExperience = listExperiences.find((experience) => experience.id === searchParams.get("experience")) ?? null;
  // The select's choice for that title, and every experience of the title (NIHO's page and this site's product).
  const experienceId = requestedExperience ? (choices.find((choice) => choice.title === requestedExperience.title)?.id ?? null) : null;
  const sameExperience = requestedExperience ? new Set(listExperiences.filter((experience) => experience.title === requestedExperience.title).map((experience) => experience.id)) : null;
  const selectedId = searchParams.get("booking") || null;
  const sub = selectedId !== null;
  /** This site's sessions and messages keep `?source=site` beside NIHO's bookings: この回 and メッセージ read them there. */
  const siteSource = niho ? "site" : null;
  const query = { providerId, filter, experience: experienceId } as const;
  const listHref = bookingsHref(query);

  const groups = bookingGroups(sameExperience ? rows.filter((row) => sameExperience.has(row.experienceId)) : rows, listExperiences, { filter, experienceId: null }, today);
  const selected = selectedId ? (bookings.find((booking) => booking.id === selectedId) ?? null) : null;
  const first = groups[0]?.bookings[0] ?? null;
  /**
   * This site's or the preview's booking, or NIHO's (by id: one NIHO's list has not read yet is read on its own).
   * From lg the first booking of the list shows until one is chosen; below lg the list does.
   */
  const shown: { site: HostBooking } | { niho: string } | null = sub
    ? selected ? { site: selected } : niho && nihoList.state !== "revoked" && selectedId ? { niho: selectedId } : null
    : !first ? null : !isNiho(first) ? { site: first } : twoColumns ? { niho: first.id } : null;
  const shownSite = shown && "site" in shown ? shown.site : null;
  const shownNiho = shown && "niho" in shown ? shown.niho : null;
  const shownId = shownSite?.id ?? shownNiho;
  const titleOf = (id: string) => listExperiences.find((experience) => experience.id === id)?.title ?? "";
  /** The booking's thread, or the way to start one while the guest can still be written to. */
  const conversationOf = (booking: HostBooking): BookingConversationLink | null => {
    // This site's bookings (#285 slice 6b): メッセージ opens the booking's thread, or its empty one.
    if (booking.site) return live?.messages ? { href: messagesHref({ providerId, source: siteSource, booking: booking.id }), last: null, lastUnknown: true } : null;
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

  /** Another view of this screen, without loading the page again. Not while NIHO has an action of a booking. */
  const move = (event: MouseEvent<HTMLAnchorElement>, href: string) => {
    if (!plainClick(event)) return;
    event.preventDefault();
    if (nihoLocked) return;
    window.history.pushState(null, "", href);
  };

  const open = (event: MouseEvent<HTMLAnchorElement>, id: string) => {
    if (!plainClick(event)) return;
    event.preventDefault();
    if (nihoLocked) return;
    window.history.pushState(null, "", bookingsHref({ ...query, booking: id }));
    if (!window.matchMedia(TWO_COLUMNS).matches) {
      window.scrollTo(0, 0);
      focusDetail.current = true;
    }
  };

  /** NIHO changed one of its bookings: NIHO's list is read again, and that booking becomes the chosen one (it stays on screen). */
  const loadNiho = nihoList.load;
  const reloadNiho = useCallback((id: string) => {
    const url = new URL(window.location.href);
    if (url.searchParams.get("booking") !== id) {
      url.searchParams.set("booking", id);
      window.history.replaceState(null, "", `${url.pathname}${url.search}`);
    }
    void loadNiho();
  }, [loadNiho]);

  /** Applies an action to one booking. One shown without being chosen (the first of the list) becomes the chosen one, so it stays on screen. */
  const change = (id: string, apply: (booking: HostBooking, at: string) => HostBooking): { before: HostBooking; after: HostBooking } | null => {
    const before = bookings.find((booking) => booking.id === id);
    if (!before) return null;
    const after = apply(before, now ?? actionNow(today));
    setBookings(bookings.map((booking) => (booking.id === id ? after : booking)));
    if (selectedId !== id) window.history.replaceState(null, "", bookingsHref({ ...query, booking: id }));
    return { before, after };
  };

  /** 続きを見る: this site's next page joins the list (a booking already on it keeps what it holds), and NIHO's. */
  const loadMore = async () => {
    if (niho && nihoList.cursor && !nihoList.busy) void nihoList.load(nihoList.cursor);
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
                disabled={nihoLocked}
                onChange={(event) => window.history.pushState(null, "", bookingsHref({ providerId, filter, experience: event.currentTarget.value || null }))}
                className="block min-h-10 w-auto max-w-full min-w-0 rounded-[10px] border border-line-strong bg-canvas py-2 pr-2 pl-3 text-[1rem] leading-normal text-ink md:max-w-[300px] md:text-[0.875rem]"
              >
                <option value="">すべての体験</option>
                {choices.map((experience) => (
                  <option key={experience.id} value={experience.id}>
                    {experience.title}
                  </option>
                ))}
              </select>
            </PageHead>
            {live ? (
              <p className="mb-2.5 text-[0.8125rem] leading-normal text-ink-soft">
                {niho ? "NIHO の予約と、このサイトで受けた予約です。申込経路で見分けられます" : "このサイトで受けた予約です"}
              </p>
            ) : null}
            {niho && nihoList.state === "loading" ? (
              <p role="status" className="mb-2.5 text-[0.8125rem] leading-normal text-muted">
                NIHO の予約を読み込み中…
              </p>
            ) : null}
            {niho && (nihoList.state === "error" || nihoList.state === "revoked") ? (
              <div role="alert" className="mb-2.5 rounded-xl bg-danger-pale px-3 py-2.5 text-[0.8125rem] leading-normal font-bold text-danger">
                <p>{nihoList.state === "error" ? "NIHO の予約を読み込めませんでした。このサイトで受けた予約だけを表示しています。" : nihoList.error}</p>
                {nihoList.state === "error" ? (
                  <button type="button" disabled={nihoList.busy} onClick={() => void nihoList.load()} className={consoleButtonClass("secondary", "sm", "mt-2")}>
                    もう一度読み込む
                  </button>
                ) : null}
              </div>
            ) : null}

            <ul aria-label="予約の絞り込み" className="-mx-1.5 mb-1.5 flex gap-2 overflow-x-auto p-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {BOOKING_FILTERS.map((item) => {
                const current = item.value === filter;
                const href = bookingsHref({ providerId, filter: item.value, experience: experienceId });
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
                      {group.bookings.every(isNiho) ? (
                        // NIHO's sessions keep NIHO's この回 (ADR 0002): the heading names the session only.
                        <span className="flex min-h-9 items-center gap-2 bg-sand/60 px-3.5 py-2 md:px-4">
                          <SessionWords group={group} />
                        </span>
                      ) : (
                        // This site's sessions keep `?source=site` beside NIHO's bookings, so この回 reads them and leads back here (#285 slice 8b).
                        <Link href={sessionHref({ providerId, source: siteSource, ...group })} className="flex min-h-9 items-center gap-2 bg-sand/60 px-3.5 py-2 hover:bg-sand focus-visible:outline-offset-[-3px] md:px-4">
                          <SessionWords group={group} />
                          <HostIcon name="chevronRight" className="size-3.5 text-muted" />
                        </Link>
                      )}
                    </h2>
                    <ul>
                      {group.bookings.map((booking) => {
                        const chosen = booking.id === selectedId;
                        // From lg, the booking shown on the right without being chosen is marked the same way.
                        const marked = chosen ? "bg-sand" : booking.id === shownId ? "hover:bg-sand/60 lg:bg-sand" : "hover:bg-sand/60";
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
                              <StatusPill status={isNiho(booking) ? nihoRowStatusLabel(booking, today) : bookingStatusLabel(booking, today)} />
                              <HostIcon name="chevronRight" className="size-4 text-line-strong max-md:hidden" />
                            </a>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ))
              ) : (
                <p className="px-4 py-6 text-muted md:px-5">{rows.length ? "該当する予約はありません" : niho && nihoList.state === "loading" ? "読み込み中…" : "まだ予約はありません"}</p>
              )}
              {(live && cursor) || (niho && nihoList.cursor && nihoList.state === "ready") ? (
                <div className="border-t border-line p-3">
                  {more.failed ? <p role="alert" className="mb-2 text-[0.8125rem] text-ink-soft">{more.failed}</p> : null}
                  <button type="button" disabled={more.busy || nihoList.busy || nihoLocked} onClick={() => void loadMore()} className={consoleButtonClass("secondary", "sm")}>
                    {more.busy || nihoList.busy ? "読み込み中…" : "続きを見る"}
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
            {shownNiho && niho ? (
              <HostNihoBookingDetail
                // Each booking starts from NIHO's read of it; its draft stays with the page.
                key={shownNiho}
                providerId={niho.providerId}
                bookingId={shownNiho}
                translate={niho.translate}
                drafts={drafts}
                onDrafts={setDrafts}
                onLock={setNihoLock}
                onRevoke={nihoList.revoke}
                onChanged={reloadNiho}
              />
            ) : shownSite ? (
              <HostBookingDetail
                // Each booking starts with its dialogs closed.
                key={shownSite.id}
                booking={shownSite}
                experienceTitle={titleOf(shownSite.experienceId)}
                today={today}
                headingId={DETAIL_HEADING}
                notice={notice?.bookingId === shownSite.id ? notice.text : ""}
                conversation={conversationOf(shownSite)}
                providerId={providerDataId}
                supportPreview={supportPreview}
                supportHistoryEnabled={supportHistoryEnabled}
                feeSummaryEnabled={feeSummaryEnabled}
                translateEnabled={translateEnabled}
                onApprove={() => {
                  if (change(shownSite.id, approveBooking)) report(shownSite.id, "申込を承認しました。予約が確定しました");
                }}
                onDecline={() => {
                  if (change(shownSite.id, declineBooking)) report(shownSite.id, "申込をお断りしました");
                }}
                onSiteCancel={live && !live.preview && shownSite.site ? (choice) => void cancelSite(shownSite.id, choice) : undefined}
                siteCancel={siteCancel?.bookingId === shownSite.id ? siteCancel : undefined}
                onCancel={(cancellation: BookingCancellation) => {
                  const done = change(shownSite.id, (booking, at) => cancelBooking(booking, cancellation, at));
                  if (!done) return;
                  const refunded = done.after.refundedYen - done.before.refundedYen;
                  report(shownSite.id, refunded > 0 ? `予約を取り消し、${yen(refunded)} を返金しました` : "予約を取り消しました");
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
      {leaveGuard.asking && leaveMode ? <HostLeaveDialog mode={leaveMode} requestKey={leaveGuard.requestKey} onStay={leaveGuard.stay} onLeave={leaveGuard.leave} onDiscard={() => setDrafts(NO_DRAFTS)} /> : null}
    </>
  );
}
