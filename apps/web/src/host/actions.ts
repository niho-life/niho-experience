"use server";

import { revalidatePath } from "next/cache";
import type { ExperienceHostApiClient, ExperienceHostApiFailure, ExperienceProviderUpdateRequest } from "@niho-experience/api-client/host";
import { nihoIdOrNull, type HostProviderReviewStatus } from "@/lib/host/providers";
import { HOST_HOME_PATH, HOST_MOCK_LOGIN_PATH, withProvider } from "@/lib/host/routes";
import { hostApiClient, isHostMock, readHostSession } from "@/lib/host/server";
import { idTokenUsable } from "@/lib/host/session";
import { openStripe, stepNotice, syncStripe } from "./connect";
import { readHostPayout } from "./data";
import { pageTextFromInput } from "./editor";
import { HOST_INVALID_INPUT_TEXT, HOST_NETWORK_ERROR_TEXT, HOST_SESSION_ENDED_TEXT, hostFailureMessage } from "./errors";
import { loadMoreGuestQuestions, openGuestQuestion, replyToGuestQuestion, type HostGuestQuestionPage } from "./guest-questions-server";
import { MESSAGE_TEXT_LIMIT, REPLY_DRAFT_UNAVAILABLE_TEXT } from "./messages";
import { mockPageEnglishDraft } from "./mock/experiences";
import { mockReviewEnglishDraft } from "./mock/reviews";
import { mockEnglishDraft } from "./mock/threads";
import { changeNotificationSettings } from "./notification-settings-server";
import { notificationChangesInput } from "./notifications";
import { PAGE_ENGLISH_UNAVAILABLE_TEXT, textHasWords } from "./page-english";
import type { HostActionResult, HostPayoutLoad, ProviderProfile, ProviderProfileChange, RegisterProviderInput } from "./payout";
import { REVIEW_REPLY_TEXT_LIMIT } from "./reviews";
import type { HostNotificationItem, HostPageText, HostThread } from "./types";

/*
 * The host console's changes to NIHO (#88/#91), as server actions: each reads the session,
 * calls NIHO's host API through the typed client (hostApiClient: NIHO in http mode, the
 * contract mock in mock mode) and answers `{ ok, message }` with what NIHO has now. Arguments
 * come from the browser, so each is checked here; NIHO decides what the host may do.
 *
 * The contract mock keeps a write only within one client (docs/api-contract.md §9.1), so an
 * action reads the result back with the client that wrote it: the screen shows NIHO's answer,
 * also in the preview, where the next page load starts from the synthetic data again.
 */

type Run<T extends object> = (client: ExperienceHostApiClient) => Promise<HostActionResult<T>>;

async function withHostApi<T extends object>(run: Run<T>): Promise<HostActionResult<T>> {
  const session = await readHostSession();
  if (!session || !idTokenUsable(session, Date.now())) return { ok: false, message: HOST_SESSION_ENDED_TEXT };
  try {
    return await run(hostApiClient(session));
  } catch {
    return { ok: false, message: HOST_NETWORK_ERROR_TEXT };
  }
}

const refused = (failure: ExperienceHostApiFailure): { ok: false; message: string } => ({ ok: false, message: hostFailureMessage(failure) });
const invalid = { ok: false, message: HOST_INVALID_INPUT_TEXT } as const;

/** A string from the browser, at most `max` characters long (NIHO checks the rest). */
function text(value: unknown, max: number): string | null {
  return typeof value === "string" && value.length <= max ? value : null;
}

/** NIHO's limits (the contract), with room for the spaces NIHO trims. */
const LIMITS = { displayName: 200, bio: 4200, sellerDisclosureUrl: 2048, version: 100, spotId: 200, threadId: 200, reviewId: 200, experienceId: 200, cursor: 200 } as const;

/** Pages that show the provider (the frame's name, 設定, 売上 and ホーム) read it again. */
function refreshConsole() {
  revalidatePath("/", "layout");
}

/**
 * The preview's way on after a registration: the contract mock forgets the new provider after
 * this request, so the synthetic host signs in again with a provider in the state a new one
 * starts in (未申請, no payout account; scenario `payments-pending`), where the next steps work.
 */
const PREVIEW_AFTER_REGISTRATION = `${HOST_MOCK_LOGIN_PATH}?mock=payments-pending`;

/** 提供者の登録 (#88): NIHO makes the host the provider's OWNER. `next` is the new provider's home. */
type Registered = { next: string };
export async function registerProvider(input: RegisterProviderInput): Promise<HostActionResult<Registered>> {
  const kind = input?.kind === "INDIVIDUAL" || input?.kind === "BUSINESS" ? input.kind : null;
  const displayName = text(input?.displayName, LIMITS.displayName);
  const bio = text(input?.bio, LIMITS.bio);
  const sellerDisclosureUrl = text(input?.sellerDisclosureUrl, LIMITS.sellerDisclosureUrl);
  const consentVersion = text(input?.consentVersion, LIMITS.version);
  if (!kind || displayName === null || bio === null || sellerDisclosureUrl === null || consentVersion === null) return invalid;
  return withHostApi<Registered>(async (client) => {
    const result = await client.registerExperienceProvider({ kind, displayName, bio, sellerDisclosureUrl: sellerDisclosureUrl.trim() || null, consentVersion });
    if (!result.ok) return refused(result);
    const next = isHostMock() ? PREVIEW_AFTER_REGISTRATION : withProvider(HOST_HOME_PATH, nihoIdOrNull(result.data.provider.id));
    return { ok: true, message: "登録しました。", next };
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
  const body: ExperienceProviderUpdateRequest = {};
  for (const field of ["displayName", "bio", "sellerDisclosureUrl"] as const) {
    if (changed(field) && text(input[field], LIMITS[field]) === null) return invalid;
  }
  if (changed("displayName")) body.displayName = input.displayName;
  if (changed("bio")) body.bio = input.bio;
  if (changed("sellerDisclosureUrl")) body.sellerDisclosureUrl = input.sellerDisclosureUrl?.trim() || null;
  if (!providerId || Object.keys(body).length === 0) return invalid;
  return withHostApi<ProfileSaved>(async (client) => {
    const result = await client.updateExperienceProvider(providerId, body);
    if (!result.ok) return refused(result);
    refreshConsole();
    const { displayName, bio, sellerDisclosureUrl, reviewStatus } = result.data.provider;
    return { ok: true, message: "保存しました", profile: { displayName, bio, sellerDisclosureUrl: sellerDisclosureUrl ?? "" }, reviewStatus };
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

/** 審査を申請 (OWNER): NIHO checks the saved seller page and the consent, then the review waits for NIHO. */
type ReviewRequested = { reviewStatus: HostProviderReviewStatus };
export async function submitProviderReview(input: { providerId: string }): Promise<HostActionResult<ReviewRequested>> {
  const providerId = nihoIdOrNull(input?.providerId);
  if (!providerId) return invalid;
  return withHostApi<ReviewRequested>(async (client) => {
    const result = await client.submitExperienceProvider(providerId);
    if (!result.ok) return refused(result);
    const detail = await client.getExperienceProvider(providerId);
    refreshConsole();
    return { ok: true, message: "審査を申請しました。", reviewStatus: detail.ok && detail.data.provider ? detail.data.provider.reviewStatus : "REQUESTED" };
  });
}

/** The payout account as NIHO has it now, read with the client that changed it. */
async function payoutNow(client: ExperienceHostApiClient, providerId: string): Promise<HostPayoutLoad> {
  const detail = await client.getExperienceProvider(providerId);
  if (!detail.ok || !detail.data.provider) return { status: "error" };
  return readHostPayout(client, detail.data.provider);
}

/** 既存の口座を使う › 共有する (OWNER): one of the owner's spots' ready seller accounts, with NIHO's consent version. */
type PayoutChanged = { payout: HostPayoutLoad };
export async function sharePayoutAccount(input: { providerId: string; sourceSpotId: string; consentVersion: string }): Promise<HostActionResult<PayoutChanged>> {
  const providerId = nihoIdOrNull(input?.providerId);
  const sourceSpotId = text(input?.sourceSpotId, LIMITS.spotId);
  const consentVersion = text(input?.consentVersion, LIMITS.version);
  if (!providerId || !sourceSpotId || consentVersion === null) return invalid;
  return withHostApi<PayoutChanged>(async (client) => {
    const result = await client.reuseExperienceProviderPayment(providerId, { sourceSpotId, consentVersion });
    if (!result.ok) return refused(result);
    const payout = await payoutNow(client, providerId);
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
  return withHostApi<StripeOpened>(async (client) => {
    const opened = await openStripe(client, providerId, step);
    if (opened.kind === "stripe") return { ok: true, message: "Stripe の画面へ移ります。", redirectTo: opened.url, payout: null };
    const notice = stepNotice(opened);
    if (notice.tone === "error") return { ok: false, message: notice.message };
    const payout = await payoutNow(client, providerId);
    refreshConsole();
    return { ok: true, message: notice.message, redirectTo: null, payout };
  });
}

/** 状態を再確認 (OWNER): NIHO reads the account from Stripe again. */
export async function syncPayoutAccount(input: { providerId: string }): Promise<HostActionResult<PayoutChanged>> {
  const providerId = nihoIdOrNull(input?.providerId);
  if (!providerId) return invalid;
  return withHostApi<PayoutChanged>(async (client) => {
    const synced = await syncStripe(client, providerId);
    if (synced.kind !== "state") return { ok: false, message: synced.kind === "failed" ? stepNotice(synced).message : HOST_INVALID_INPUT_TEXT };
    const payout = await payoutNow(client, providerId);
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
  if (!session || !idTokenUsable(session, Date.now())) return { ok: false, message: HOST_SESSION_ENDED_TEXT };
  if (!isHostMock()) return { ok: false, message: unavailable };
  return { ok: true, message, english: mockEnglish() };
}

type EnglishDrafted = Drafted<string>;

/**
 * メッセージ › 英語にする (#106): NIHO's English of the host's Japanese reply, for the host to
 * check (and correct) before it is sent; nothing is sent here. The preview answers with its own
 * synthetic English.
 */
export async function draftReplyEnglish(input: { providerId: string; threadId: string; japanese: string }): Promise<HostActionResult<EnglishDrafted>> {
  const providerId = nihoIdOrNull(input?.providerId);
  const threadId = text(input?.threadId, LIMITS.threadId);
  const japanese = text(input?.japanese, MESSAGE_TEXT_LIMIT);
  if (!providerId || !threadId || !japanese?.trim()) return invalid;
  // TODO(#87): NIHO's translation for the thread (niho-app#19319/#19238) once the host contract has it.
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
 * レビュー › 英語にする (#108): NIHO's English of the host's Japanese reply to a review, for the
 * host to check (and correct) before it is published; nothing is published here. The preview
 * answers with its own synthetic English.
 */
export async function draftReviewReplyEnglish(input: { providerId: string; reviewId: string; japanese: string }): Promise<HostActionResult<EnglishDrafted>> {
  const providerId = nihoIdOrNull(input?.providerId);
  const reviewId = text(input?.reviewId, LIMITS.reviewId);
  const japanese = text(input?.japanese, REVIEW_REPLY_TEXT_LIMIT);
  if (!providerId || !reviewId || !japanese?.trim()) return invalid;
  // TODO(#87): NIHO's translation for the review's reply (niho-app#19314) once the host contract has it.
  return draftEnglish(() => mockReviewEnglishDraft(reviewId, japanese));
}

/**
 * 体験の編集 › 英語の下書きを作る / 英語を作り直す (#110): NIHO's English of the page's Japanese,
 * field by field, for the host to check, correct and confirm; nothing is saved or published here.
 * The preview answers with its own synthetic English.
 */
type PageEnglishDrafted = Drafted<HostPageText>;
export async function draftPageEnglish(input: { providerId: string; experienceId: string; japanese: HostPageText }): Promise<HostActionResult<PageEnglishDrafted>> {
  const providerId = nihoIdOrNull(input?.providerId);
  const experienceId = text(input?.experienceId, LIMITS.experienceId);
  const japanese = pageTextFromInput(input?.japanese);
  if (!providerId || !experienceId || !japanese || !textHasWords(japanese)) return invalid;
  // TODO(#87): NIHO's English draft of the page (niho-coliving/niho-app#19320) once the host contract has it.
  return draftEnglish(() => mockPageEnglishDraft(experienceId, japanese), { message: "英語の下書きを作りました", unavailable: PAGE_ENGLISH_UNAVAILABLE_TEXT });
}
