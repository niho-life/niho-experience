"use server";

import { revalidatePath } from "next/cache";
import type { ExperienceHostApiClient, ExperienceHostApiFailure, ExperienceProviderUpdateRequest } from "@niho-experience/api-client/legacy-host";
import { nihoIdOrNull, type HostProviderReviewStatus } from "@/lib/host/providers";
import { HOST_MOCK_LOGIN_PATH } from "@/lib/host/routes";
import { hostApiClient, isHostMock, readHostSession } from "@/lib/host/server";
import { accessTokenUsable } from "@/lib/host/session";
import { openStripe, stepNotice, syncStripe } from "./connect";
import { readMockHostPayout } from "./data";
import { pageTextFromInput } from "./editor";
import { HOST_INVALID_INPUT_TEXT, HOST_NETWORK_ERROR_TEXT, HOST_SESSION_ENDED_TEXT, hostFailureMessage } from "./errors";
import { draftGuestQuestionEnglish, loadMoreGuestQuestions, openGuestQuestion, replyToGuestQuestion, type HostGuestQuestionPage } from "./guest-questions-server";
import { draftGuestReviewEnglish } from "./guest-reviews-server";
import { MESSAGE_TEXT_LIMIT, REPLY_DRAFT_UNAVAILABLE_TEXT } from "./messages";
import { mockPageEnglishDraft } from "./mock/experiences";
import { mockReviewEnglishDraft } from "./mock/reviews";
import { mockEnglishDraft } from "./mock/threads";
import { normalizeMeetingPoint } from "./meeting-point";
import { changeNotificationAddress, confirmNotificationAddressToken } from "./notification-address-server";
import type { HostNotificationAddressView } from "./notification-address";
import { changeNotificationSettings } from "./notification-settings-server";
import { recordOtaAttendanceAsHost } from "./ota-bookings-server";
import { notificationChangesInput } from "./notifications";
import { PAGE_ENGLISH_UNAVAILABLE_TEXT, textHasWords } from "./page-english";
import { SITE_CANCEL_NOTE_MAX, SITE_CANCEL_REASONS, SITE_SESSION_CANCEL_REASONS } from "./site-bookings";
import { cancelSiteBookingAsOwner, loadMoreSiteBookings, type HostSiteBookingPage } from "./site-bookings-server";
import { cancelSiteSessionAsOwner, recordSiteAttendanceAsOwner } from "./site-sessions-server";
import type { HostSessionView } from "./console-data";
import { sessionQueryOf } from "./session";
import type { HostActionResult, HostPayoutLoad, ProviderProfile, ProviderProfileChange, RegisterProviderInput } from "./payout";
import { REVIEW_REPLY_TEXT_LIMIT } from "./reviews";
import type { HostAttendance, HostBooking, HostMeetingDefaults, HostNotificationItem, HostPageText, HostThread } from "./types";

/* Legacy provider operations below are synthetic-preview-only until their API contract is deployed. */
const invalid = { ok: false, message: HOST_INVALID_INPUT_TEXT } as const;
const LEGACY_HOST_OPERATION_UNAVAILABLE = "この操作は現在のNIHO契約では利用できません。体験の商品・販売条件の変更は新しい体験販売画面から行ってください。";

type LegacyRun<T extends object> = (client: ExperienceHostApiClient) => Promise<HostActionResult<T>>;

async function withLegacyHostMock<T extends object>(run: LegacyRun<T>): Promise<HostActionResult<T>> {
  const session = await readHostSession();
  if (!session || !accessTokenUsable(session, Date.now())) return { ok: false, message: HOST_SESSION_ENDED_TEXT };
  if (!isHostMock()) return { ok: false, message: LEGACY_HOST_OPERATION_UNAVAILABLE };
  try {
    return await run(hostApiClient(session));
  } catch {
    return { ok: false, message: HOST_NETWORK_ERROR_TEXT };
  }
}

const refused = (failure: ExperienceHostApiFailure): { ok: false; message: string } => ({ ok: false, message: hostFailureMessage(failure) });
function refreshConsole() { revalidatePath("/host", "layout"); }
const PREVIEW_AFTER_REGISTRATION = `${HOST_MOCK_LOGIN_PATH}?mock=payments-pending`;

/** A string from the browser, at most `max` characters long (NIHO checks the rest). */
function text(value: unknown, max: number): string | null {
  return typeof value === "string" && value.length <= max ? value : null;
}

/** NIHO's limits (the contract), with room for the spaces NIHO trims. */
const LIMITS = { displayName: 200, bio: 4200, sellerDisclosureUrl: 2048, version: 100, spotId: 200, threadId: 200, reviewId: 200, experienceId: 200, cursor: 200 } as const;

/** 提供者の登録 (#88): NIHO makes the host the provider's OWNER. `next` is the new provider's home. */
type Registered = { next: string };
export async function registerProvider(input: RegisterProviderInput): Promise<HostActionResult<Registered>> {
  const kind = input?.kind === "INDIVIDUAL" || input?.kind === "BUSINESS" ? input.kind : null;
  const displayName = text(input?.displayName, LIMITS.displayName);
  const bio = text(input?.bio, LIMITS.bio);
  const sellerDisclosureUrl = text(input?.sellerDisclosureUrl, LIMITS.sellerDisclosureUrl);
  const consentVersion = text(input?.consentVersion, LIMITS.version);
  if (!kind || displayName === null || bio === null || sellerDisclosureUrl === null || consentVersion === null) return invalid;
  return withLegacyHostMock<Registered>(async (client) => {
    const result = await client.registerExperienceProvider({ kind, displayName, bio, sellerDisclosureUrl: sellerDisclosureUrl.trim() || null, consentVersion });
    if (!result.ok) return refused(result);
    return { ok: true, message: "登録しました。", next: PREVIEW_AFTER_REGISTRATION };
  });
}

/**
 * 設定 › 提供者情報 › 保存: only the fields that changed (the seller page is the owner's to
 * change; NIHO answers 403 to an editor). NIHO sends a reviewed provider back to review.
 */
type ProfileSaved = { profile: ProviderProfile; reviewStatus: HostProviderReviewStatus };
export async function saveProviderProfile(input: ProviderProfileChange): Promise<HostActionResult<ProfileSaved>> {
  const providerId = nihoIdOrNull(input?.providerId);
  const changed = (field: keyof ProviderProfile) => input?.[field] !== undefined;
  for (const field of ["displayName", "bio", "sellerDisclosureUrl"] as const) {
    if (changed(field) && text(input[field], LIMITS[field]) === null) return invalid;
  }
  if (!providerId || !Object.keys(input ?? {}).some((key) => ["displayName", "bio", "sellerDisclosureUrl"].includes(key))) return invalid;
  const body: ExperienceProviderUpdateRequest = {};
  if (changed("displayName")) body.displayName = input.displayName;
  if (changed("bio")) body.bio = input.bio;
  if (changed("sellerDisclosureUrl")) body.sellerDisclosureUrl = input.sellerDisclosureUrl?.trim() || null;
  return withLegacyHostMock<ProfileSaved>(async (client) => {
    const result = await client.updateExperienceProvider(providerId, body);
    if (!result.ok) return refused(result);
    refreshConsole();
    const { displayName, bio, sellerDisclosureUrl, reviewStatus } = result.data.provider;
    return { ok: true, message: "保存しました", profile: { displayName, bio, sellerDisclosureUrl: sellerDisclosureUrl ?? "" }, reviewStatus };
  });
}

/**
 * 設定 › 既定の集合案内 › 保存 (OWNER / EDITOR): all five fields, trimmed, the map URL empty or https.
 * NIHO stops every experience of the provider that is on the experience site until it checks them again.
 */
type MeetingPointSaved = { meetingPoint: HostMeetingDefaults };
export async function saveProviderMeetingPoint(input: { providerId: string; meetingPoint: HostMeetingDefaults }): Promise<HostActionResult<MeetingPointSaved>> {
  const providerId = nihoIdOrNull(input?.providerId);
  const meetingPoint = normalizeMeetingPoint(input?.meetingPoint);
  if (!providerId || !meetingPoint) return invalid;
  return withLegacyHostMock<MeetingPointSaved>(async (client) => {
    const result = await client.updateExperienceProviderMeetingPoint(providerId, meetingPoint);
    if (!result.ok) return refused(result);
    refreshConsole();
    return { ok: true, message: "保存しました", meetingPoint: result.data.meetingPoint };
  });
}

/**
 * 設定 › 通知 › 保存 (#109): the OWNER's three stoppable notifications, kept in the experience DB.
 * Only the ones that changed come; the answer is all seven as they are now.
 */
type NotificationsSaved = { items: HostNotificationItem[] };
export async function saveNotificationSettings(input: { providerId: string; changes: unknown }): Promise<HostActionResult<NotificationsSaved>> {
  const providerId = nihoIdOrNull(input?.providerId);
  const changes = notificationChangesInput(input?.changes);
  if (!providerId || !changes) return invalid;
  return changeNotificationSettings(providerId, changes);
}

/**
 * 設定 › 通知 › 宛先 (#194): the signed-in person's own address for this site's emails. 確認のメールを送る asks for a link
 * to the new address (nothing changes until it is opened); ログインのメールに戻す and 取り消す act at once. The NIHO user
 * is the session's; `providerId` is the settings page's provider, which the person must belong to in the experience DB.
 */
type AddressChanged = { address: HostNotificationAddressView };
export async function requestNotificationAddress(input: { providerId: string; email: string }): Promise<HostActionResult<AddressChanged>> {
  return changeNotificationAddress({ kind: "request", providerId: input?.providerId, email: input?.email });
}

export async function restoreLoginNotificationAddress(providerId: string): Promise<HostActionResult<AddressChanged>> {
  return changeNotificationAddress({ kind: "login", providerId });
}

export async function cancelNotificationAddress(providerId: string): Promise<HostActionResult<AddressChanged>> {
  return changeNotificationAddress({ kind: "cancel", providerId });
}

/**
 * 通知の宛先の確認 (#194): the link's token from `/host/notification-email#t=…`. No session: the link proves the inbox. `closed`
 * when the link no longer works (unknown, used, cancelled, an hour old, access ended; the page does not say which).
 */
export async function confirmNotificationAddress(input: { token: string }): Promise<{ ok: true; email: string } | { ok: false; closed: boolean }> {
  return confirmNotificationAddressToken(input?.token);
}

/** 審査を申請 (OWNER): NIHO checks the saved seller page and the consent, then the review waits for NIHO. */
type ReviewRequested = { reviewStatus: HostProviderReviewStatus };
export async function submitProviderReview(input: { providerId: string }): Promise<HostActionResult<ReviewRequested>> {
  const providerId = nihoIdOrNull(input?.providerId);
  if (!providerId) return invalid;
  return withLegacyHostMock<ReviewRequested>(async (client) => {
    const result = await client.submitExperienceProvider(providerId);
    if (!result.ok) return refused(result);
    const detail = await client.getExperienceProvider(providerId);
    refreshConsole();
    return { ok: true, message: "審査を申請しました。", reviewStatus: detail.ok && detail.data.provider ? detail.data.provider.reviewStatus : "REQUESTED" };
  });
}

/** The preview's payout state as the contract mock sees it after a change. */
async function mockPayoutNow(client: ExperienceHostApiClient, providerId: string): Promise<HostPayoutLoad> {
  const detail = await client.getExperienceProvider(providerId);
  if (!detail.ok || !detail.data.provider) return { status: "error" };
  return readMockHostPayout(client, {
    id: detail.data.provider.id,
    legacyProviderId: detail.data.provider.id,
    memberRole: "OWNER",
    paymentReuseSourceSpotId: detail.data.provider.paymentReuseSourceSpotId,
  });
}

/** 既存の口座を使う › 共有する (OWNER): one of the owner's spots' ready seller accounts, with NIHO's consent version. */
type PayoutChanged = { payout: HostPayoutLoad };
export async function sharePayoutAccount(input: { providerId: string; sourceSpotId: string; consentVersion: string }): Promise<HostActionResult<PayoutChanged>> {
  const providerId = nihoIdOrNull(input?.providerId);
  const sourceSpotId = text(input?.sourceSpotId, LIMITS.spotId);
  const consentVersion = text(input?.consentVersion, LIMITS.version);
  if (!providerId || !sourceSpotId || consentVersion === null) return invalid;
  return withLegacyHostMock<PayoutChanged>(async (client) => {
    const result = await client.reuseExperienceProviderPayment(providerId, { sourceSpotId, consentVersion });
    if (!result.ok) return refused(result);
    const payout = await mockPayoutNow(client, providerId);
    refreshConsole();
    const name = payout.status === "owner" ? payout.payout.sharedFrom : null;
    return { ok: true, message: name ? `${name}の口座を共有しました。` : "口座を共有しました。", payout };
  });
}

/**
 * Stripe で口座を接続 (`start`) / Stripe で本人確認を続ける (`resume`), OWNER: Stripe's page to
 * go to (`redirectTo`), or (the preview, or no page needed) the state the account is in now.
 */
type StripeOpened = { redirectTo: string | null; payout: HostPayoutLoad | null };
export async function openPayoutConnect(input: { providerId: string; step: "start" | "resume" }): Promise<HostActionResult<StripeOpened>> {
  const providerId = nihoIdOrNull(input?.providerId);
  const step = input?.step === "start" || input?.step === "resume" ? input.step : null;
  if (!providerId || !step) return invalid;
  return withLegacyHostMock<StripeOpened>(async (client) => {
    const opened = await openStripe(client, providerId, step);
    if (opened.kind === "stripe") return { ok: true, message: "Stripe の画面へ移ります。", redirectTo: opened.url, payout: null };
    const notice = stepNotice(opened);
    if (notice.tone === "error") return { ok: false, message: notice.message };
    const payout = await mockPayoutNow(client, providerId);
    refreshConsole();
    return { ok: true, message: notice.message, redirectTo: null, payout };
  });
}

/** 状態を再確認 (OWNER): NIHO reads the account from Stripe again. */
export async function syncPayoutAccount(input: { providerId: string }): Promise<HostActionResult<PayoutChanged>> {
  const providerId = nihoIdOrNull(input?.providerId);
  if (!providerId) return invalid;
  return withLegacyHostMock<PayoutChanged>(async (client) => {
    const synced = await syncStripe(client, providerId);
    if (synced.kind !== "state") return { ok: false, message: synced.kind === "failed" ? stepNotice(synced).message : HOST_INVALID_INPUT_TEXT };
    const payout = await mockPayoutNow(client, providerId);
    refreshConsole();
    return { ok: true, message: stepNotice(synced).message, payout };
  });
}

/**
 * 英語にする, once the input is checked: the session must still be usable; then NIHO's English
 * (http mode: not yet, the host writes it) or the preview's synthetic one. Nothing is sent here.
 */
type Drafted<T> = { english: T };
async function draftEnglish<T>(mockEnglish: () => T, { message = "英語にしました", unavailable = REPLY_DRAFT_UNAVAILABLE_TEXT } = {}): Promise<HostActionResult<Drafted<T>>> {
  const session = await readHostSession();
  if (!session || !accessTokenUsable(session, Date.now())) return { ok: false, message: HOST_SESSION_ENDED_TEXT };
  if (!isHostMock()) return { ok: false, message: unavailable };
  return { ok: true, message, english: mockEnglish() };
}

type EnglishDrafted = Drafted<string>;

/**
 * メッセージ › 英語にする (#106): an English draft of the host's Japanese reply, for the host to
 * check (and correct) before it is sent; nothing is sent here. In http mode, for a question kept in
 * the experience DB, the Claude API makes it (#285 slice 5); without it the host writes the English.
 * The preview answers with its own synthetic English.
 */
export async function draftReplyEnglish(input: { providerId: string; threadId: string; japanese: string }): Promise<HostActionResult<EnglishDrafted>> {
  const providerId = nihoIdOrNull(input?.providerId);
  const threadId = text(input?.threadId, LIMITS.threadId);
  const japanese = text(input?.japanese, MESSAGE_TEXT_LIMIT);
  if (!providerId || !threadId || !japanese?.trim()) return invalid;
  if (!isHostMock()) return draftGuestQuestionEnglish(providerId, threadId, japanese);
  return draftEnglish(() => mockEnglishDraft(threadId, japanese));
}

const COMMAND_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type GuestQuestionOpened = { thread: HostThread };

/** メッセージ (#106): a question to the host (experience DB) opened on the screen, read in full; it counts as read. */
export async function openGuestQuestionThread(input: { providerId: string; threadId: string }): Promise<HostActionResult<GuestQuestionOpened>> {
  const providerId = nihoIdOrNull(input?.providerId);
  const threadId = text(input?.threadId, LIMITS.threadId);
  if (!providerId || !threadId) return invalid;
  return openGuestQuestion(providerId, threadId);
}

/** メッセージ › さらに表示 (#106, experience DB): the questions older than the list's last one. */
export async function loadMoreGuestQuestionThreads(input: { providerId: string; cursor: string }): Promise<HostActionResult<HostGuestQuestionPage>> {
  const providerId = nihoIdOrNull(input?.providerId);
  const cursor = text(input?.cursor, LIMITS.cursor);
  if (!providerId || !cursor) return invalid;
  return loadMoreGuestQuestions(providerId, cursor);
}

/** 予約 › 続きを見る (#285 slice 8, experience DB): the bookings made on this site after the list's last one. */
export async function loadMoreSiteBookingList(input: { providerId: string; cursor: string }): Promise<HostActionResult<HostSiteBookingPage>> {
  const providerId = nihoIdOrNull(input?.providerId);
  const cursor = text(input?.cursor, LIMITS.cursor);
  if (!providerId || !cursor) return invalid;
  return loadMoreSiteBookings(providerId, cursor);
}

const BOOKING_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The reason and note a cancel dialog sends: one of the fixed reasons, and the host's own words (maybe none). */
function cancelInput(input: { commandId?: unknown; reason?: unknown; note?: unknown } | null | undefined, reasons: readonly { value: string }[]) {
  const commandId = typeof input?.commandId === "string" && COMMAND_ID.test(input.commandId) ? input.commandId : null;
  const reason = reasons.find((item) => item.value === input?.reason)?.value ?? null;
  const note = text(input?.note ?? "", SITE_CANCEL_NOTE_MAX);
  return commandId && reason && note !== null ? { commandId, reason: reason as (typeof SITE_CANCEL_REASONS)[number]["value"], note } : null;
}

/**
 * 予約 › 取り消して全額を返金する (#285 slice 7, experience DB): the OWNER cancels one booking made on this site. The
 * guest gets a full refund. `commandId` is the dialog's UUID: the same command again is the same cancellation.
 */
export async function cancelSiteBooking(input: { providerId: string; bookingId: string; commandId: string; reason: string; note: string }): Promise<HostActionResult<{ booking: HostBooking }>> {
  const providerId = nihoIdOrNull(input?.providerId);
  const bookingId = typeof input?.bookingId === "string" && BOOKING_ID.test(input.bookingId) ? input.bookingId.toLowerCase() : null;
  const cancellation = cancelInput(input, SITE_CANCEL_REASONS);
  if (!providerId || !bookingId || !cancellation) return invalid;
  return cancelSiteBookingAsOwner(providerId, bookingId, cancellation);
}

/**
 * この回 › この回を中止する (#285 slice 7, experience DB): every confirmed booking of the session made on this site is
 * cancelled with a full refund, and the session takes no new bookings.
 */
export async function cancelSiteSession(input: {
  providerId: string; date: string; start: string; experience: string; offer: string; commandId: string; reason: string; note: string;
}): Promise<HostActionResult<{ session: HostSessionView | null; cancelled: number }>> {
  const providerId = nihoIdOrNull(input?.providerId);
  const query = sessionQueryOf({ date: input?.date, start: input?.start, experience: input?.experience, offer: input?.offer });
  const cancellation = cancelInput(input, SITE_SESSION_CANCEL_REASONS);
  if (!providerId || !query || !cancellation) return invalid;
  return cancelSiteSessionAsOwner(providerId, query, cancellation);
}

const ATTENDANCE_VALUES: ReadonlySet<unknown> = new Set<HostAttendance>(["attended", "no_show"]);

/**
 * この回 › 来た / 来なかった (#107, experience DB): the OWNER marks a confirmed booking made on this site once its
 * session has started, or corrects the mark. The same mark again changes nothing.
 */
export async function recordSiteAttendance(input: { providerId: string; bookingId: string; attendance: HostAttendance }): Promise<HostActionResult<{ attendance: HostAttendance | null }>> {
  const providerId = nihoIdOrNull(input?.providerId);
  const bookingId = typeof input?.bookingId === "string" && BOOKING_ID.test(input.bookingId) ? input.bookingId.toLowerCase() : null;
  const attendance = ATTENDANCE_VALUES.has(input?.attendance) ? input.attendance : null;
  if (!providerId || !bookingId || !attendance) return invalid;
  return recordSiteAttendanceAsOwner(providerId, bookingId, attendance);
}

/**
 * この回 › 来た / 来なかった for a booking made on a reservation site (#194 PR B): the product's OWNER or its operator,
 * once its session has started. `ref` is the booking's handle (never the site's IDs).
 */
export async function recordOtaAttendance(input: { providerId: string; ref: string; attendance: HostAttendance }): Promise<HostActionResult<{ attendance: HostAttendance | null }>> {
  const providerId = nihoIdOrNull(input?.providerId);
  const ref = typeof input?.ref === "string" && BOOKING_ID.test(input.ref) ? input.ref.toLowerCase() : null;
  const attendance = ATTENDANCE_VALUES.has(input?.attendance) ? input.attendance : null;
  if (!providerId || !ref || !attendance) return invalid;
  return recordOtaAttendanceAsHost(providerId, ref, attendance);
}

/**
 * メッセージ › この英語で送る for a question to the host (#106, experience DB): the English the guest gets
 * by email, and the Japanese the host wrote. `commandId` is the browser's UUID for this reply, so
 * sending it again after a lost answer is the same reply.
 */
export async function sendGuestQuestionReply(input: { providerId: string; threadId: string; japanese: string; english: string; commandId: string }): Promise<HostActionResult<GuestQuestionOpened>> {
  const providerId = nihoIdOrNull(input?.providerId);
  const threadId = text(input?.threadId, LIMITS.threadId);
  const japanese = text(input?.japanese, MESSAGE_TEXT_LIMIT);
  const english = text(input?.english, MESSAGE_TEXT_LIMIT);
  const commandId = typeof input?.commandId === "string" && COMMAND_ID.test(input.commandId) ? input.commandId : null;
  if (!providerId || !threadId || japanese === null || !english?.trim() || !commandId) return invalid;
  return replyToGuestQuestion(providerId, threadId, { japanese, english, commandId });
}

/**
 * レビュー › 英語にする (#108): an English draft of the host's Japanese reply to a review, for the
 * host to check (and correct) before it is published; nothing is published here. In http mode, for a
 * review kept in the experience DB, the Claude API makes it as for a question (EXPERIENCE_TRANSLATION_ENABLED);
 * without it the host writes the English. The preview answers with its own synthetic English.
 */
export async function draftReviewReplyEnglish(input: { providerId: string; reviewId: string; japanese: string }): Promise<HostActionResult<EnglishDrafted>> {
  const providerId = nihoIdOrNull(input?.providerId);
  const reviewId = text(input?.reviewId, LIMITS.reviewId);
  const japanese = text(input?.japanese, REVIEW_REPLY_TEXT_LIMIT);
  if (!providerId || !reviewId || !japanese?.trim()) return invalid;
  if (!isHostMock()) return draftGuestReviewEnglish(providerId, reviewId, japanese);
  return draftEnglish(() => mockReviewEnglishDraft(reviewId, japanese));
}

/**
 * 体験の編集 › 英語の下書きを作る / 英語を作り直す (#110): NIHO's English of the page's Japanese,
 * field by field, for the host to check, correct and confirm; nothing is saved or published here.
 * The preview answers with its own synthetic English. Only the mock editor calls this: the host contract
 * (0.2.0) has no call to draft, correct or confirm a page's English, so http mode answers that NIHO makes it
 * and the NIHO-connected editor reads NIHO's own English from the preview (live-english.ts).
 */
type PageEnglishDrafted = Drafted<HostPageText>;
export async function draftPageEnglish(input: { providerId: string; experienceId: string; japanese: HostPageText }): Promise<HostActionResult<PageEnglishDrafted>> {
  const providerId = nihoIdOrNull(input?.providerId);
  const experienceId = text(input?.experienceId, LIMITS.experienceId);
  const japanese = pageTextFromInput(input?.japanese);
  if (!providerId || !experienceId || !japanese || !textHasWords(japanese)) return invalid;
  return draftEnglish(() => mockPageEnglishDraft(experienceId, japanese), { message: "英語の下書きを作りました", unavailable: PAGE_ENGLISH_UNAVAILABLE_TEXT });
}
