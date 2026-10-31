import "server-only";
import {
  BookingMessagesClosedError,
  StoreAccessDeniedError,
  StoreNotFoundError,
  StoreValidationError,
  type GuestBookingThreadStart,
  type GuestQuestionMessage,
  type GuestQuestionRepository,
  type GuestQuestionThreadBooking,
  type GuestQuestionThreadPage,
  type GuestQuestionThreadSummary,
  type GuestQuestionTopic,
  type GuestThreadKind,
  type HostActor,
} from "@niho-experience/experience-store";
import { siteThreadRepository } from "@/lib/experience/store-server";
import type { HostProvider } from "@/lib/host/providers";
import { loadHostProviders, readHostSession } from "@/lib/host/server";
import { idTokenUsable } from "@/lib/host/session";
import { anthropicTranslator, type Translator } from "@/lib/translation/anthropic";
import { hostReplyToEnglish } from "@/lib/translation/prompts";
import { actionTime } from "./bookings";
import { HOST_INVALID_INPUT_TEXT, HOST_SESSION_ENDED_TEXT } from "./errors";
import { todayInJapan } from "./format";
import { BOOKING_THREAD_CLOSED_TEXT, bookingOfNewThread, newBookingThreadId, REPLY_DRAFT_FAILED_TEXT, REPLY_DRAFT_UNAVAILABLE_TEXT } from "./messages";
import type { HostActionResult } from "./payout";
import type { HostThread, HostThreadBooking, HostThreadMessage } from "./types";

/*
 * メッセージ's 予約前の質問 (#106) kept in the experience DB (migration 0022, docs/guest-questions.md).
 * NIHO proves the account and that it is the provider's OWNER; the experience store checks its own
 * OWNER membership as well (ADR 0002). The guest's address never reaches the console. Anyone else,
 * or a deployment without EXPERIENCE_GUEST_QUESTIONS_ENABLED and the DB, keeps today's screen.
 *
 * A booking made on this site has its own thread in the same tables (#285 slice 6b, docs/guest-booking.md): the guest
 * writes on their booking page, the host reads and answers here. They are open with the guest's booking page
 * (siteThreadRepository): with only one of the two open, the screen shows that kind only. A booking without a thread
 * yet opens as an empty one (`?booking=`), which the host's first message starts.
 */

export const GUEST_QUESTION_OWNER_ONLY_TEXT = "予約前の質問はオーナーが読み書きできます";
export const GUEST_QUESTION_MISSING_TEXT = "このやりとりは見つかりませんでした。一覧から選び直してください。";
export const GUEST_QUESTION_LOAD_FAILED_TEXT = "やりとりを読み込めませんでした。時間をおいて、もう一度お試しください。";
export const GUEST_QUESTION_REPLY_FAILED_TEXT = "返信を送れませんでした。時間をおいて、もう一度お試しください。";

/** The list reads this many threads, the latest first. */
const LIST_LIMIT = 50;
/** 英語にする waits this long for the Claude API; after that the host writes the English. */
export const REPLY_DRAFT_TIMEOUT_MS = 15_000;

/** What a question is about, as the host reads it; "Other" names nothing. */
const TOPIC_JA: Record<GuestQuestionTopic, string | null> = { CHILDREN: "子ども", FOOD: "食べもの", ACCESS: "アクセス", LANGUAGE: "言葉", OTHER: null };

/** YYYY-MM-DDTHH:MM in Japan, as the console dates messages. */
export function japanMinute(utc: string): string {
  const at = Date.parse(utc);
  return actionTime(todayInJapan(at), at);
}

function ownerActor(providerId: string, nihoUserId: string): HostActor {
  return { providerId, nihoUserId, calendarRoleCeiling: "OWNER" };
}

/** One stored message as メッセージ shows it: the guest's words (translation still null) or the host's reply and its email. */
export function hostThreadMessage(message: GuestQuestionMessage, language: GuestQuestionThreadSummary["language"]): HostThreadMessage {
  const at = japanMinute(message.createdAtUtc);
  if (message.author === "GUEST") {
    return { id: message.id, from: "guest", at, original: message.body, language: language === "JA" ? "ja" : "en", translation: message.bodyJa, viaEmail: message.source === "REPLY_PAGE" };
  }
  const status = message.deliveryStatus === "SENT" ? "sent" : message.deliveryStatus === "FAILED" ? "failed" : "pending";
  return { id: message.id, from: "host", at, japanese: message.bodyJa ?? "", english: message.body, status };
}

type StoredThread = Omit<GuestQuestionThreadSummary, "lastMessage">;

/** This site's booking as a thread shows it: its date, start and party, and whether it still takes messages. */
export function hostThreadBooking(booking: GuestQuestionThreadBooking): HostThreadBooking {
  return {
    id: booking.publicBookingId,
    date: booking.localDate,
    start: booking.localStartTime,
    guests: booking.adultCount + booking.childCount,
    site: true,
    ...(booking.open ? {} : { closed: true as const }),
  };
}

export function hostThread(thread: Pick<StoredThread, "id" | "productId" | "guestName" | "topic" | "language" | "booking">, messages: readonly GuestQuestionMessage[]): HostThread {
  return {
    id: thread.id,
    experienceId: thread.productId,
    guest: thread.guestName,
    topic: thread.topic ? (TOPIC_JA[thread.topic] ?? null) : null,
    booking: thread.booking ? hostThreadBooking(thread.booking) : null,
    messages: messages.map((message) => hostThreadMessage(message, thread.language)),
  };
}

/** A booking made on this site before anyone wrote: its empty thread, which the host's first message starts. */
export function emptyBookingThread(start: GuestBookingThreadStart): HostThread {
  return hostThread({ id: newBookingThreadId(start.booking.publicBookingId), productId: start.productId, guestName: start.guestName, topic: null, language: start.language, booking: start.booking }, []);
}

/** One page of the list as メッセージ shows it: each thread holds its last message only. */
export interface HostGuestQuestionPage {
  threads: HostThread[];
  experiences: { id: string; title: string }[];
  nextCursor: string | null;
}

function listPage(page: GuestQuestionThreadPage): HostGuestQuestionPage {
  return {
    threads: page.threads.map((summary) => hostThread(summary, [summary.lastMessage])),
    experiences: [...new Map(page.threads.map((summary) => [summary.productId, summary.productTitle]))].map(([id, title]) => ({ id, title })),
    nextCursor: page.nextCursor,
  };
}

/** Whether a stored thread is of the kind open here (null: both). */
function ofKind(thread: { booking: unknown }, kind: GuestThreadKind | null): boolean {
  return kind === null || (kind === "BOOKING") === (thread.booking !== null);
}

/** Opening a thread: every message, then it counts as read. A thread of a kind closed here is not found. */
async function openThread(questions: GuestQuestionRepository, actor: HostActor, threadId: string, kind: GuestThreadKind | null): Promise<{ thread: HostThread; experience: { id: string; title: string } }> {
  const stored = await questions.getThread(actor, threadId);
  if (!ofKind(stored, kind)) throw new StoreNotFoundError("guest question");
  await questions.markThreadRead(actor, threadId);
  return { thread: hostThread(stored, stored.messages), experience: { id: stored.productId, title: stored.productTitle } };
}

export type HostGuestQuestionsLoad =
  | {
      status: "live";
      /** The latest first. A thread not opened yet holds its last message only (`loaded` lists the whole ones). */
      threads: HostThread[];
      loaded: string[];
      /** `?thread=` (or `?booking=`) names none of the provider's threads or bookings made on this site. */
      requestedMissing: boolean;
      /** `?booking=` names this site's booking nobody wrote in yet: its empty thread, which the first reply starts. */
      newThread: HostThread | null;
      experiences: { id: string; title: string }[];
      /** さらに表示 reads the older threads from here; null when every thread is on the list. */
      nextCursor: string | null;
      today: string;
      now: string;
    }
  /** Not kept here for them: the flag is off, no DB, not the OWNER (NIHO or the experience DB). Today's screen. */
  | { status: "closed" }
  | { status: "error" };

/**
 * メッセージ for an OWNER (NIHO's role): the provider's questions and this site's bookings' threads, and the one
 * `?thread=` names, opened; or this site's booking `?booking=` names (#285 slice 6b), its thread opened or, before
 * anyone wrote, its empty one.
 */
export async function loadGuestQuestions(provider: HostProvider, nihoUserId: string, requestedThread: string | null, requestedBooking: string | null = null): Promise<HostGuestQuestionsLoad> {
  const site = siteThreadRepository();
  if (!site || provider.memberRole !== "OWNER") return { status: "closed" };
  const { repository: questions, kind } = site;
  const actor = ownerActor(provider.id, nihoUserId);
  try {
    const page = await questions.listThreads(actor, { limit: LIST_LIMIT, kind });
    const { threads } = listPage(page);
    const experiences = new Map(page.threads.map((summary) => [summary.productId, summary.productTitle]));
    const loaded: string[] = [];
    let requestedMissing = false;
    let newThread: HostThread | null = null;
    const show = (opened: { thread: HostThread; experience: { id: string; title: string } }) => {
      const index = threads.findIndex((thread) => thread.id === opened.thread.id);
      if (index >= 0) threads[index] = opened.thread;
      else threads.push(opened.thread);
      experiences.set(opened.experience.id, opened.experience.title);
      loaded.push(opened.thread.id);
    };
    try {
      if (requestedThread) {
        show(await openThread(questions, actor, requestedThread, kind));
      } else if (requestedBooking && kind !== "QUESTION") {
        const start = await questions.findBookingThread(actor, requestedBooking);
        if (start.threadId) {
          show(await openThread(questions, actor, start.threadId, kind));
        } else {
          newThread = emptyBookingThread(start);
          experiences.set(start.productId, start.productTitle);
          loaded.push(newThread.id);
        }
      }
    } catch (error) {
      if (!(error instanceof StoreNotFoundError || error instanceof StoreValidationError)) throw error;
      requestedMissing = true;
    }
    const now = Date.now();
    const today = todayInJapan(now);
    return { status: "live", threads, loaded, requestedMissing, newThread, experiences: [...experiences].map(([id, title]) => ({ id, title })), nextCursor: page.nextCursor, today, now: actionTime(today, now) };
  } catch (error) {
    return error instanceof StoreAccessDeniedError ? { status: "closed" } : { status: "error" };
  }
}

/**
 * Beside NIHO's booking messages (provider operations): how many bookings made on this site have a thread, for the
 * notice that leads to them (`?source=site`). 0 when they are closed here, for anyone but the OWNER, or unreadable.
 */
export async function countSiteBookingThreads(provider: HostProvider, nihoUserId: string): Promise<number> {
  const site = siteThreadRepository();
  if (!site || site.kind === "QUESTION" || provider.memberRole !== "OWNER") return 0;
  try {
    return await site.repository.countThreads(ownerActor(provider.id, nihoUserId), { kind: "BOOKING" });
  } catch {
    return 0;
  }
}

type OwnerCheck = { ok: true; questions: GuestQuestionRepository; kind: GuestThreadKind | null; actor: HostActor } | { ok: false; message: string };

/** A usable session, the store, and NIHO saying this account owns the provider. */
async function asOwner(providerId: string, failed: string): Promise<OwnerCheck> {
  const session = await readHostSession();
  if (!session || !idTokenUsable(session, Date.now())) return { ok: false, message: HOST_SESSION_ENDED_TEXT };
  const site = siteThreadRepository();
  if (!site) return { ok: false, message: failed };
  const providers = await loadHostProviders();
  if (providers.status !== "ok") return { ok: false, message: providers.status === "error" ? failed : HOST_SESSION_ENDED_TEXT };
  const provider = providers.providers.find((entry) => entry.id === providerId);
  if (provider?.memberRole !== "OWNER") return { ok: false, message: GUEST_QUESTION_OWNER_ONLY_TEXT };
  return { ok: true, questions: site.repository, kind: site.kind, actor: ownerActor(providerId, session.nihoUserId) };
}

function failure(error: unknown, failed: string): { ok: false; message: string } {
  if (error instanceof StoreAccessDeniedError) return { ok: false, message: GUEST_QUESTION_OWNER_ONLY_TEXT };
  if (error instanceof StoreNotFoundError) return { ok: false, message: GUEST_QUESTION_MISSING_TEXT };
  if (error instanceof StoreValidationError) return { ok: false, message: HOST_INVALID_INPUT_TEXT };
  if (error instanceof BookingMessagesClosedError) return { ok: false, message: BOOKING_THREAD_CLOSED_TEXT };
  return { ok: false, message: failed };
}

/** A thread opened on the screen (the list holds its last message only): every message, and it counts as read. */
export async function openGuestQuestion(providerId: string, threadId: string): Promise<HostActionResult<{ thread: HostThread }>> {
  const owner = await asOwner(providerId, GUEST_QUESTION_LOAD_FAILED_TEXT);
  if (!owner.ok) return owner;
  try {
    return { ok: true, message: "", thread: (await openThread(owner.questions, owner.actor, threadId, owner.kind)).thread };
  } catch (error) {
    return failure(error, GUEST_QUESTION_LOAD_FAILED_TEXT);
  }
}

/** さらに表示: the threads older than the list's last one, from the cursor the previous page gave. */
export async function loadMoreGuestQuestions(providerId: string, cursor: string): Promise<HostActionResult<HostGuestQuestionPage>> {
  const owner = await asOwner(providerId, GUEST_QUESTION_LOAD_FAILED_TEXT);
  if (!owner.ok) return owner;
  try {
    return { ok: true, message: "", ...listPage(await owner.questions.listThreads(owner.actor, { limit: LIST_LIMIT, cursor, kind: owner.kind })) };
  } catch (error) {
    return failure(error, GUEST_QUESTION_LOAD_FAILED_TEXT);
  }
}

/**
 * この英語で送る: the English the guest gets by email, with the Japanese the host wrote (none when they
 * wrote the English directly). `commandId` comes from the browser, so a retry is the same reply.
 * Answers the thread as it is now, the reply waiting for the email (送信待ち). The empty thread of this site's
 * booking (#285 slice 6b) is started by it, and answered with its stored id.
 */
export async function replyToGuestQuestion(providerId: string, threadId: string, reply: { japanese: string; english: string; commandId: string }): Promise<HostActionResult<{ thread: HostThread }>> {
  const owner = await asOwner(providerId, GUEST_QUESTION_REPLY_FAILED_TEXT);
  if (!owner.ok) return owner;
  const input = { english: reply.english, japanese: reply.japanese.trim() || null, commandId: reply.commandId };
  const bookingId = bookingOfNewThread(threadId);
  try {
    let storedId = threadId;
    if (bookingId) {
      if (owner.kind === "QUESTION") throw new StoreNotFoundError("guest booking");
      storedId = (await owner.questions.replyToBooking(owner.actor, bookingId, input)).threadId;
    } else {
      if (owner.kind !== null && !ofKind(await owner.questions.getThread(owner.actor, threadId), owner.kind)) throw new StoreNotFoundError("guest question");
      await owner.questions.reply(owner.actor, threadId, input);
    }
    const stored = await owner.questions.getThread(owner.actor, storedId);
    return { ok: true, message: "送りました", thread: hostThread(stored, stored.messages) };
  } catch (error) {
    return failure(error, GUEST_QUESTION_REPLY_FAILED_TEXT);
  }
}

/**
 * 英語にする for a question kept here (#285 slice 5, owner decision 2026-10-31): the Claude API's English of
 * the host's Japanese, with the guest's last message for context, for the host to check and correct before
 * sending; nothing is sent or saved here. Translation off: the host writes the English, as before
 * (REPLY_DRAFT_UNAVAILABLE_TEXT). On, but the API unreachable, slow (15 s), declining or answering nothing
 * usable: the host may try again or write the English (REPLY_DRAFT_FAILED_TEXT).
 */
export async function draftGuestQuestionEnglish(
  providerId: string,
  threadId: string,
  japanese: string,
  translator: () => Translator | null = () => anthropicTranslator({ timeoutMs: REPLY_DRAFT_TIMEOUT_MS }),
): Promise<HostActionResult<{ english: string }>> {
  const session = await readHostSession();
  if (!session || !idTokenUsable(session, Date.now())) return { ok: false, message: HOST_SESSION_ENDED_TEXT };
  const translate = translator();
  if (!translate) return { ok: false, message: REPLY_DRAFT_UNAVAILABLE_TEXT };
  const owner = await asOwner(providerId, REPLY_DRAFT_UNAVAILABLE_TEXT);
  if (!owner.ok) return owner;
  let guestMessage: string | null = null;
  try {
    // The OWNER's thread only; its last guest message is the context. This site's booking nobody wrote in yet has none.
    const bookingId = bookingOfNewThread(threadId);
    const storedId = bookingId ? (await owner.questions.findBookingThread(owner.actor, bookingId)).threadId : threadId;
    if (storedId) {
      const thread = await owner.questions.getThread(owner.actor, storedId);
      guestMessage = thread.messages.findLast((message) => message.author === "GUEST")?.body ?? null;
    }
  } catch (error) {
    return failure(error, REPLY_DRAFT_FAILED_TEXT);
  }
  const result = await translate(hostReplyToEnglish({ japanese, guestMessage }));
  return result.ok ? { ok: true, message: "英語にしました", english: result.text } : { ok: false, message: REPLY_DRAFT_FAILED_TEXT };
}
