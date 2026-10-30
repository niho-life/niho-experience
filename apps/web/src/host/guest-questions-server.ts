import "server-only";
import {
  StoreAccessDeniedError,
  StoreNotFoundError,
  StoreValidationError,
  type GuestQuestionMessage,
  type GuestQuestionRepository,
  type GuestQuestionThreadPage,
  type GuestQuestionThreadSummary,
  type GuestQuestionTopic,
  type HostActor,
} from "@niho-experience/experience-store";
import { guestQuestionRepository } from "@/lib/experience/store-server";
import type { HostProvider } from "@/lib/host/providers";
import { loadHostProviders, readHostSession } from "@/lib/host/server";
import { idTokenUsable } from "@/lib/host/session";
import { actionTime } from "./bookings";
import { HOST_INVALID_INPUT_TEXT, HOST_SESSION_ENDED_TEXT } from "./errors";
import { todayInJapan } from "./format";
import type { HostActionResult } from "./payout";
import type { HostThread, HostThreadMessage } from "./types";

/*
 * メッセージ's 予約前の質問 (#106) kept in the experience DB (migration 0021, docs/guest-questions.md).
 * NIHO proves the account and that it is the provider's OWNER; the experience store checks its own
 * OWNER membership as well (ADR 0002). The guest's address never reaches the console. Anyone else,
 * or a deployment without EXPERIENCE_GUEST_QUESTIONS_ENABLED and the DB, keeps today's screen.
 */

export const GUEST_QUESTION_OWNER_ONLY_TEXT = "予約前の質問はオーナーが読み書きできます";
export const GUEST_QUESTION_MISSING_TEXT = "このやりとりは見つかりませんでした。一覧から選び直してください。";
export const GUEST_QUESTION_LOAD_FAILED_TEXT = "やりとりを読み込めませんでした。時間をおいて、もう一度お試しください。";
export const GUEST_QUESTION_REPLY_FAILED_TEXT = "返信を送れませんでした。時間をおいて、もう一度お試しください。";

/** The list reads this many threads, the latest first. */
const LIST_LIMIT = 50;

/** What a question is about, as the host reads it; "Other" names nothing. */
const TOPIC_JA: Record<GuestQuestionTopic, string | null> = { CHILDREN: "子ども", FOOD: "食べもの", ACCESS: "アクセス", LANGUAGE: "言葉", OTHER: null };

/** YYYY-MM-DDTHH:MM in Japan, as the console dates messages. */
function japanMinute(utc: string): string {
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

export function hostThread(thread: StoredThread, messages: readonly GuestQuestionMessage[]): HostThread {
  return {
    id: thread.id,
    experienceId: thread.productId,
    guest: thread.guestName,
    topic: TOPIC_JA[thread.topic] ?? null,
    booking: null,
    messages: messages.map((message) => hostThreadMessage(message, thread.language)),
  };
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

/** Opening a thread: it counts as read, then every message. */
async function openThread(questions: GuestQuestionRepository, actor: HostActor, threadId: string): Promise<{ thread: HostThread; experience: { id: string; title: string } }> {
  await questions.markThreadRead(actor, threadId);
  const stored = await questions.getThread(actor, threadId);
  return { thread: hostThread(stored, stored.messages), experience: { id: stored.productId, title: stored.productTitle } };
}

export type HostGuestQuestionsLoad =
  | {
      status: "live";
      /** The latest first. A thread not opened yet holds its last message only (`loaded` lists the whole ones). */
      threads: HostThread[];
      loaded: string[];
      /** `?thread=` names none of the provider's threads. */
      requestedMissing: boolean;
      experiences: { id: string; title: string }[];
      /** さらに表示 reads the older threads from here; null when every thread is on the list. */
      nextCursor: string | null;
      today: string;
      now: string;
    }
  /** Not kept here for them: the flag is off, no DB, not the OWNER (NIHO or the experience DB). Today's screen. */
  | { status: "closed" }
  | { status: "error" };

/** メッセージ for an OWNER (NIHO's role): the provider's questions, and the one `?thread=` names, opened. */
export async function loadGuestQuestions(provider: HostProvider, nihoUserId: string, requestedThread: string | null): Promise<HostGuestQuestionsLoad> {
  const questions = guestQuestionRepository();
  if (!questions || provider.memberRole !== "OWNER") return { status: "closed" };
  const actor = ownerActor(provider.id, nihoUserId);
  try {
    const page = await questions.listThreads(actor, { limit: LIST_LIMIT });
    const { threads } = listPage(page);
    const experiences = new Map(page.threads.map((summary) => [summary.productId, summary.productTitle]));
    const loaded: string[] = [];
    let requestedMissing = false;
    if (requestedThread) {
      try {
        const opened = await openThread(questions, actor, requestedThread);
        const index = threads.findIndex((thread) => thread.id === opened.thread.id);
        if (index >= 0) threads[index] = opened.thread;
        else threads.push(opened.thread);
        experiences.set(opened.experience.id, opened.experience.title);
        loaded.push(opened.thread.id);
      } catch (error) {
        if (!(error instanceof StoreNotFoundError || error instanceof StoreValidationError)) throw error;
        requestedMissing = true;
      }
    }
    const now = Date.now();
    const today = todayInJapan(now);
    return { status: "live", threads, loaded, requestedMissing, experiences: [...experiences].map(([id, title]) => ({ id, title })), nextCursor: page.nextCursor, today, now: actionTime(today, now) };
  } catch (error) {
    return error instanceof StoreAccessDeniedError ? { status: "closed" } : { status: "error" };
  }
}

type OwnerCheck = { ok: true; questions: GuestQuestionRepository; actor: HostActor } | { ok: false; message: string };

/** A usable session, the store, and NIHO saying this account owns the provider. */
async function asOwner(providerId: string, failed: string): Promise<OwnerCheck> {
  const session = await readHostSession();
  if (!session || !idTokenUsable(session, Date.now())) return { ok: false, message: HOST_SESSION_ENDED_TEXT };
  const questions = guestQuestionRepository();
  if (!questions) return { ok: false, message: failed };
  const providers = await loadHostProviders();
  if (providers.status !== "ok") return { ok: false, message: providers.status === "error" ? failed : HOST_SESSION_ENDED_TEXT };
  const provider = providers.providers.find((entry) => entry.id === providerId);
  if (provider?.memberRole !== "OWNER") return { ok: false, message: GUEST_QUESTION_OWNER_ONLY_TEXT };
  return { ok: true, questions, actor: ownerActor(providerId, session.nihoUserId) };
}

function failure(error: unknown, failed: string): { ok: false; message: string } {
  if (error instanceof StoreAccessDeniedError) return { ok: false, message: GUEST_QUESTION_OWNER_ONLY_TEXT };
  if (error instanceof StoreNotFoundError) return { ok: false, message: GUEST_QUESTION_MISSING_TEXT };
  if (error instanceof StoreValidationError) return { ok: false, message: HOST_INVALID_INPUT_TEXT };
  return { ok: false, message: failed };
}

/** A thread opened on the screen (the list holds its last message only): every message, and it counts as read. */
export async function openGuestQuestion(providerId: string, threadId: string): Promise<HostActionResult<{ thread: HostThread }>> {
  const owner = await asOwner(providerId, GUEST_QUESTION_LOAD_FAILED_TEXT);
  if (!owner.ok) return owner;
  try {
    return { ok: true, message: "", thread: (await openThread(owner.questions, owner.actor, threadId)).thread };
  } catch (error) {
    return failure(error, GUEST_QUESTION_LOAD_FAILED_TEXT);
  }
}

/** さらに表示: the threads older than the list's last one, from the cursor the previous page gave. */
export async function loadMoreGuestQuestions(providerId: string, cursor: string): Promise<HostActionResult<HostGuestQuestionPage>> {
  const owner = await asOwner(providerId, GUEST_QUESTION_LOAD_FAILED_TEXT);
  if (!owner.ok) return owner;
  try {
    return { ok: true, message: "", ...listPage(await owner.questions.listThreads(owner.actor, { limit: LIST_LIMIT, cursor })) };
  } catch (error) {
    return failure(error, GUEST_QUESTION_LOAD_FAILED_TEXT);
  }
}

/**
 * この英語で送る: the English the guest gets by email, with the Japanese the host wrote (none when they
 * wrote the English directly). `commandId` comes from the browser, so a retry is the same reply.
 * Answers the thread as it is now, the reply waiting for the email (送信待ち).
 */
export async function replyToGuestQuestion(providerId: string, threadId: string, reply: { japanese: string; english: string; commandId: string }): Promise<HostActionResult<{ thread: HostThread }>> {
  const owner = await asOwner(providerId, GUEST_QUESTION_REPLY_FAILED_TEXT);
  if (!owner.ok) return owner;
  try {
    await owner.questions.reply(owner.actor, threadId, { english: reply.english, japanese: reply.japanese.trim() || null, commandId: reply.commandId });
    const stored = await owner.questions.getThread(owner.actor, threadId);
    return { ok: true, message: "送りました", thread: hostThread(stored, stored.messages) };
  } catch (error) {
    return failure(error, GUEST_QUESTION_REPLY_FAILED_TEXT);
  }
}
