import { HOST_MESSAGES_PATH, withQuery } from "@/lib/host/routes";
import { BOOKING_TEXT_LIMITS } from "./bookings";
import { shortDateWithWeekdayJa } from "./format";
import type { HostBooking, HostGuestMessage, HostMessageStatus, HostThread, HostThreadMessage } from "./types";

/*
 * メッセージ (#106)'s rules, apart from the screen so they can be tested: which threads wait for
 * the host and in what order, how a guest's message reads (NIHO's translation and the guest's
 * own words), and when the English of a reply may be sent. NIHO translates and sends for real
 * threads; in mock mode the screen keeps a reply on the page only.
 * TODO(#87): send the reply to NIHO and show the thread it reads back.
 */

/** What one message may hold (the booking messages' body). */
export const MESSAGE_TEXT_LIMIT = BOOKING_TEXT_LIMITS.body;

/** 英語にする failed (NIHO or the network): the Japanese stays, and the host can try again or write the English. */
export const REPLY_DRAFT_FAILED_TEXT = "英語にできませんでした。作り直すか、英語を直接書いてください";
/** 英語にする before NIHO's API can make the English of a reply (http mode). */
export const REPLY_DRAFT_UNAVAILABLE_TEXT = "英語にする機能は準備中です。英語を直接書いてください。";

export interface MessagesQuery {
  providerId?: string | null;
  thread?: string | null;
  /** A booking's thread, or an empty one to start when it has none yet. */
  booking?: string | null;
}

/** The messages screen's address: `?providerId=`, then the thread or the booking. */
export function messagesHref({ providerId, thread, booking }: MessagesQuery = {}): string {
  return withQuery(HOST_MESSAGES_PATH, { providerId, thread, booking });
}

const LANGUAGE_NAMES: Record<string, string> = {
  en: "英語",
  ko: "韓国語",
  zh: "中国語",
  fr: "フランス語",
  de: "ドイツ語",
  es: "スペイン語",
  it: "イタリア語",
  pt: "ポルトガル語",
  th: "タイ語",
};

/** "英語" for "en" or "en-GB"; "外国語" for a language without a name here. */
export function languageNameJa(language: string): string {
  return LANGUAGE_NAMES[language.toLowerCase().split("-")[0] ?? ""] ?? "外国語";
}

const isJapanese = (language: string) => language.toLowerCase().split("-")[0] === "ja";

export interface GuestMessageView {
  /** The body: NIHO's Japanese translation, or the guest's own words when there is none. */
  text: string;
  /** The body's language (its `lang`). */
  lang: string;
  /** The guest's own words under the translation; null when the body already is them. */
  original: string | null;
  /** "英語から翻訳", "翻訳できませんでした", or null for a message written in Japanese. */
  note: string | null;
  /** NIHO could not translate it: the original is the body, and the host can still answer. */
  untranslated: boolean;
}

/** How a guest's message reads: the translation with the original under it, or the original when NIHO could not translate it. */
export function guestMessageView(message: Pick<HostGuestMessage, "original" | "language" | "translation">): GuestMessageView {
  if (isJapanese(message.language)) return { text: message.original, lang: message.language, original: null, note: null, untranslated: false };
  if (message.translation !== null) {
    return { text: message.translation, lang: "ja", original: message.original, note: `${languageNameJa(message.language)}から翻訳`, untranslated: false };
  }
  return { text: message.original, lang: message.language, original: null, note: "翻訳できませんでした", untranslated: true };
}

/** Whether the host's reply reached the guest (送信待ち: queued for the email). */
export const REPLY_STATUS: Record<HostMessageStatus, string> = { sent: "送信済み", failed: "送れませんでした", pending: "送信待ち" };

/** One line of a message for a list: the Japanese the host reads (or the English the host wrote directly), spaces collapsed. */
export function messagePreview(message: HostThreadMessage): string {
  const text = message.from === "guest" ? guestMessageView(message).text : message.japanese || message.english;
  return text.replace(/\s+/g, " ").trim();
}

/** 「…」 around one line, cut to `max` characters with "…". */
export function quoteJa(text: string, max = 32): string {
  const chars = Array.from(text.replace(/\s+/g, " ").trim());
  return `「${chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : chars.join("")}」`;
}

export function lastMessage(thread: Pick<HostThread, "messages">): HostThreadMessage | null {
  return thread.messages.at(-1) ?? null;
}

/** The guest's latest message: what ホーム quotes. */
export function lastGuestMessage(thread: Pick<HostThread, "messages">): HostGuestMessage | null {
  return thread.messages.findLast((message): message is HostGuestMessage => message.from === "guest") ?? null;
}

/**
 * Since when the guest has waited for the host: their first message after the host's last
 * sent (or queued) reply, or null when the thread does not wait (the host had the last word). A
 * reply that could not be sent answers nothing.
 */
export function waitingSince(thread: Pick<HostThread, "messages">): string | null {
  let since: string | null = null;
  for (const message of thread.messages) {
    if (message.from === "host") {
      if (message.status !== "failed") since = null;
    } else {
      since ??= message.at;
    }
  }
  return since;
}

/** The list's order: the threads that wait (the longest wait first), then the others (the latest first). */
export function sortThreads<T extends HostThread>(threads: readonly T[]): T[] {
  const keyed = threads.map((thread) => ({ thread, since: waitingSince(thread), last: lastMessage(thread)?.at ?? "" }));
  return keyed
    .sort((a, b) => {
      if (a.since && b.since) return a.since.localeCompare(b.since) || a.thread.id.localeCompare(b.thread.id);
      if (a.since || b.since) return a.since ? -1 : 1;
      return b.last.localeCompare(a.last) || a.thread.id.localeCompare(b.thread.id);
    })
    .map((item) => item.thread);
}

/** The thread's title: a question before booking, or the messages with someone who booked. */
export function threadHeading(thread: Pick<HostThread, "guest" | "booking">): string {
  return thread.booking ? `${thread.guest} さんとの連絡` : `${thread.guest} さんの質問`;
}

/** ホーム's label for a waiting thread. */
export function threadKind(thread: Pick<HostThread, "booking">): string {
  return thread.booking ? "予約者からの連絡" : "予約前の質問";
}

/** A list row's "予約前", or the booked day: "10/27（火）予約". */
export function threadWhen(thread: Pick<HostThread, "booking">): string {
  return thread.booking ? `${shortDateWithWeekdayJa(thread.booking.date)}予約` : "予約前";
}

/** Under the thread's title, after the experience: "予約前 · 子ども", or the booking's "10/27（火）18:00 · 3名". */
export function threadContext(thread: Pick<HostThread, "booking" | "topic">): string {
  const booking = thread.booking;
  const head = booking ? [`${shortDateWithWeekdayJa(booking.date)}${booking.start}`, `${booking.guests}名`] : ["予約前"];
  return [...head, ...(thread.topic ? [thread.topic] : [])].join(" · ");
}

/** A list row's time: "13:24" today, "10/20" before. */
export function listTimeLabel(at: string, today: string): string {
  const [date = "", time = ""] = at.split("T");
  if (date === today) return time;
  const [, month = "", day = ""] = date.split("-");
  return `${Number(month)}/${Number(day)}`;
}

/**
 * The reply being written: the host's Japanese and the English the guest will get. `madeFrom` is
 * the Japanese NIHO made the English from; null when the host wrote or corrected the English
 * themselves (英語を直す), which makes the English theirs to send.
 */
export interface ReplyDraft {
  japanese: string;
  english: string;
  madeFrom: string | null;
}

export interface ReplyDraftState {
  /** The Japanese changed after NIHO made the English: make it again (or correct it) first. */
  stale: boolean;
  canSend: boolean;
}

/** この英語で送る waits for an English that is there and not older than the Japanese. */
export function replyDraftState(draft: ReplyDraft): ReplyDraftState {
  const stale = draft.madeFrom !== null && draft.japanese.trim() !== draft.madeFrom.trim();
  return { stale, canSend: !stale && draft.english.trim() !== "" };
}

/** The host's reply joins the thread as sent (mock mode: on this screen only). Nothing happens without English. */
export function addReply(thread: HostThread, reply: { japanese: string; english: string }, at: string): HostThread {
  const english = reply.english.trim();
  if (!english) return thread;
  return { ...thread, messages: [...thread.messages, { id: `${thread.id}-reply-${thread.messages.length + 1}`, from: "host", at, japanese: reply.japanese.trim(), english, status: "sent" }] };
}

/** A booking without a thread yet (メッセージを送る): an empty one, which the first reply starts. */
export function emptyThreadFor(booking: Pick<HostBooking, "id" | "experienceId" | "guest" | "date" | "start" | "guests">): HostThread {
  return {
    id: `th-${booking.id}`,
    experienceId: booking.experienceId,
    guest: booking.guest,
    topic: null,
    booking: { id: booking.id, date: booking.date, start: booking.start, guests: booking.guests },
    messages: [],
  };
}

/** What a booking shows of its thread: the last message in one line and when it was written. */
export interface BookingConversation {
  bookingId: string;
  threadId: string;
  text: string;
  /** YYYY-MM-DDTHH:MM in Japan. */
  at: string;
}

/** The threads joined to a booking, for 予約's メッセージ (#90 → #106). */
export function bookingConversations(threads: readonly HostThread[]): BookingConversation[] {
  return threads.flatMap((thread) => {
    const last = lastMessage(thread);
    return thread.booking && last ? [{ bookingId: thread.booking.id, threadId: thread.id, text: messagePreview(last), at: last.at }] : [];
  });
}
