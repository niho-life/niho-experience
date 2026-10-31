import { describe, expect, it } from "vitest";
import {
  addReply,
  bookingConversations,
  bookingOfNewThread,
  emptyThreadFor,
  guestMessageView,
  languageNameJa,
  listTimeLabel,
  messagePreview,
  messagesHref,
  newBookingThreadId,
  quoteJa,
  replyDraftState,
  sortThreads,
  threadContext,
  threadHeading,
  threadKind,
  threadWhen,
  waitingSince,
} from "./messages";
import { MOCK_KITCHEN_BOOKINGS, MOCK_NOW, MOCK_TODAY } from "./mock/bookings";
import { MOCK_KITCHEN_THREADS, MOCK_REPLY_EXAMPLES, mockEnglishDraft, PREVIEW_ENGLISH_DRAFT } from "./mock/threads";
import type { HostThread } from "./types";

const byId = (id: string): HostThread => MOCK_KITCHEN_THREADS.find((thread) => thread.id === id)!;
const AT = "2026-10-21T15:30";

describe("the threads", () => {
  it("lists the waiting threads first, the longest wait first, then the others, the latest first", () => {
    expect(sortThreads(MOCK_KITCHEN_THREADS).map((thread) => [thread.id, waitingSince(thread)])).toEqual([
      ["th-3010", "2026-10-21T08:47"],
      ["th-3004", "2026-10-21T11:05"],
      ["th-3012", "2026-10-21T13:24"],
      ["th-3007", null],
    ]);
  });

  it("waits from the guest's first message after the host's last sent reply; a reply that was not sent answers nothing", () => {
    const thread = byId("th-3004");
    const answered = addReply(thread, { japanese: "はい", english: "Yes." }, AT);
    expect(waitingSince(answered)).toBeNull();
    const again = { ...answered, messages: [...answered.messages, { ...thread.messages[1]!, id: "x", at: "2026-10-21T16:00" }, { ...thread.messages[1]!, id: "y", at: "2026-10-21T17:00" }] };
    expect(waitingSince(again)).toBe("2026-10-21T16:00");
    const failed = { ...thread, messages: [...thread.messages, { id: "z", from: "host" as const, at: AT, japanese: "", english: "Yes.", status: "failed" as const }] };
    expect(waitingSince(failed)).toBe("2026-10-21T11:05");
    // A question's reply queued for the email (#105) has answered the guest.
    const queued = { ...thread, messages: [...thread.messages, { id: "q", from: "host" as const, at: AT, japanese: "", english: "Yes.", status: "pending" as const }] };
    expect(waitingSince(queued)).toBeNull();
    expect(waitingSince({ messages: [] })).toBeNull();
  });

  it("names a question before booking and the messages of a booking", () => {
    expect([threadHeading(byId("th-3012")), threadKind(byId("th-3012")), threadWhen(byId("th-3012")), threadContext(byId("th-3012"))]).toEqual(["Emma Wilson さんの質問", "予約前の質問", "予約前", "予約前 · 子ども"]);
    expect([threadHeading(byId("th-3004")), threadKind(byId("th-3004")), threadWhen(byId("th-3004")), threadContext(byId("th-3004"))]).toEqual(["Sofia Rossi さんとの連絡", "予約者からの連絡", "10/27（火）予約", "10/27（火）18:00 · 3名"]);
    expect(threadContext(byId("th-3010"))).toBe("予約前");
  });

  it("reads a guest's message in Japanese with the original under it, or the original alone when NIHO could not translate it", () => {
    expect(guestMessageView(byId("th-3012").messages[0] as never)).toEqual({
      text: "こんにちは！ 9 歳の娘と一緒にディナーに参加できますか？ 料理は大好きですが、好き嫌いがあります。",
      lang: "ja",
      original: "Hi! Can I bring my 9-year-old daughter to the dinner? She loves cooking but is a picky eater.",
      note: "英語から翻訳",
      untranslated: false,
    });
    expect(guestMessageView(byId("th-3010").messages[0] as never)).toMatchObject({ lang: "ko", original: null, note: "翻訳できませんでした", untranslated: true });
    expect(guestMessageView({ original: "17時に着きます。", language: "ja", translation: null })).toEqual({ text: "17時に着きます。", lang: "ja", original: null, note: null, untranslated: false });
    expect(guestMessageView({ original: "Merci !", language: "fr-CA", translation: "ありがとう！" }).note).toBe("フランス語から翻訳");
    expect([languageNameJa("EN-gb"), languageNameJa("sv")]).toEqual(["英語", "外国語"]);
  });

  it("shows one line of the last message: the Japanese, or the English a host wrote directly", () => {
    expect(messagePreview(byId("th-3007").messages[1]!)).toBe("はい、ご用意できます。ご予約のときに申込メモへ書いていただければ、だしも野菜でお作りします。");
    expect(messagePreview({ id: "r", from: "host", at: AT, japanese: "", english: "See you\n soon!", status: "sent" })).toBe("See you soon!");
    expect(quoteJa("  short\n text ")).toBe("「short text」");
    expect(quoteJa("あいうえおかきくけこ", 5)).toBe("「あいうえ…」");
    expect([listTimeLabel("2026-10-21T13:24", MOCK_TODAY), listTimeLabel("2026-10-05T09:12", MOCK_TODAY)]).toEqual(["13:24", "10/5"]);
  });

  it("writes the screen's address with ?providerId= first", () => {
    expect(messagesHref()).toBe("/host/messages");
    expect(messagesHref({ thread: "th-3012" })).toBe("/host/messages?thread=th-3012");
    expect(messagesHref({ providerId: "sample-provider-kitchen", booking: "bk-2044" })).toBe("/host/messages?providerId=sample-provider-kitchen&booking=bk-2044");
    // This site's threads beside NIHO's (#285 slice 6b) keep ?source=site.
    expect(messagesHref({ providerId: "sample-provider-kitchen", source: "site", thread: "th-1" })).toBe("/host/messages?providerId=sample-provider-kitchen&source=site&thread=th-1");
  });

  it("names this site's booking without a thread by an id only that booking reads back (#285 slice 6b)", () => {
    const booking = "0F8FAD5B-D9CB-469F-A165-708677289501";
    const id = newBookingThreadId(booking);
    expect(id).toBe("new-booking-0f8fad5b-d9cb-469f-a165-708677289501");
    expect(bookingOfNewThread(id)).toBe(booking.toLowerCase());
    for (const other of ["00000000-0000-4000-8000-000000000106", "th-bk-2044", "new-booking-../admin", "new-booking-"]) expect(bookingOfNewThread(other)).toBeNull();
  });
});

describe("the reply", () => {
  const made = "ご質問ありがとうございます。";

  it("waits for an English that is there and not older than the Japanese", () => {
    expect(replyDraftState({ japanese: "", english: "", madeFrom: null })).toEqual({ stale: false, canSend: false });
    expect(replyDraftState({ japanese: made, english: "Thank you.", madeFrom: made })).toEqual({ stale: false, canSend: true });
    // Spaces around it are not a change.
    expect(replyDraftState({ japanese: `${made}\n`, english: "Thank you.", madeFrom: made })).toEqual({ stale: false, canSend: true });
    // The Japanese changed after NIHO made the English: make it again (or correct the English) first.
    expect(replyDraftState({ japanese: `${made}またね。`, english: "Thank you.", madeFrom: made })).toEqual({ stale: true, canSend: false });
    expect(replyDraftState({ japanese: "", english: "Thank you.", madeFrom: made })).toEqual({ stale: true, canSend: false });
    // The host corrected (or wrote) the English: theirs to send, whatever the Japanese says.
    expect(replyDraftState({ japanese: `${made}またね。`, english: "Thank you!", madeFrom: null })).toEqual({ stale: false, canSend: true });
    expect(replyDraftState({ japanese: made, english: "  ", madeFrom: null })).toEqual({ stale: false, canSend: false });
  });

  it("joins the thread as sent; nothing happens without English", () => {
    const thread = byId("th-3012");
    const replied = addReply(thread, { japanese: " はい。 ", english: " Yes!\n" }, AT);
    expect(replied.messages.at(-1)).toEqual({ id: "th-3012-reply-2", from: "host", at: AT, japanese: "はい。", english: "Yes!", status: "sent" });
    expect(addReply(thread, { japanese: "はい。", english: " " }, AT)).toBe(thread);
  });

  it("starts an empty thread for a booking without one", () => {
    const booking = MOCK_KITCHEN_BOOKINGS.find((candidate) => candidate.id === "bk-2044")!;
    expect(emptyThreadFor(booking)).toEqual({
      id: "th-bk-2044",
      experienceId: "community-dinner",
      guest: "Ana Souza",
      topic: null,
      booking: { id: "bk-2044", date: "2026-10-29", start: "18:00", guests: 3 },
      messages: [],
    });
  });

  it("gives each booking with a thread its last message", () => {
    expect(bookingConversations(MOCK_KITCHEN_THREADS)).toEqual([
      { bookingId: "bk-2031", threadId: "th-3004", text: "ありがとうございます！ 電車は 17:40 ごろに着きます。ディナーの間、スーツケースを置いておける場所はありますか？", at: "2026-10-21T11:05" },
    ]);
  });
});

describe("the synthetic threads", () => {
  it("are invented, before the preview's moment, in time order, without any address", () => {
    for (const thread of MOCK_KITCHEN_THREADS) {
      const times = thread.messages.map((message) => message.at);
      expect(times, thread.id).toEqual([...times].sort());
      expect(times.every((at) => at < MOCK_NOW), thread.id).toBe(true);
      expect(JSON.stringify(thread), thread.id).not.toMatch(/@/);
    }
  });

  it("join Sofia Rossi's thread to her booking as 予約 has it", () => {
    const booking = MOCK_KITCHEN_BOOKINGS.find((candidate) => candidate.id === "bk-2031")!;
    expect(byId("th-3004")).toMatchObject({ guest: booking.guest, experienceId: booking.experienceId, booking: { id: booking.id, date: booking.date, start: booking.start, guests: booking.guests } });
  });

  it("make a natural English for the example replies, and say it is a preview for anything else", () => {
    for (const example of MOCK_REPLY_EXAMPLES) {
      expect(byId(example.threadId), example.threadId).toBeDefined();
      expect(waitingSince(byId(example.threadId)), example.threadId).not.toBeNull();
      expect(mockEnglishDraft(example.threadId, ` ${example.japanese}\n`)).toBe(example.english);
    }
    expect(mockEnglishDraft("th-3012", "ほかの文です。")).toBe(PREVIEW_ENGLISH_DRAFT);
    expect(mockEnglishDraft("th-3007", MOCK_REPLY_EXAMPLES[0]!.japanese)).toBe(PREVIEW_ENGLISH_DRAFT);
  });
});
