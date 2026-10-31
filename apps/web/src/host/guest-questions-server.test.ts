import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BookingMessagesClosedError,
  StoreAccessDeniedError,
  StoreConflictError,
  StoreNotFoundError,
  StoreValidationError,
  type GuestBookingThreadStart,
  type GuestQuestionMessage,
  type GuestQuestionThread,
  type GuestQuestionThreadBooking,
  type GuestQuestionThreadSummary,
  type GuestThreadKind,
  type HostActor,
} from "@niho-experience/experience-store";
import type { HostProvider } from "@/lib/host/providers";

/** メッセージ's questions against a stubbed experience store and NIHO provider list (#106). */
const state = vi.hoisted(() => ({
  store: null as null | Record<string, ReturnType<typeof vi.fn>>,
  kind: null as GuestThreadKind | null,
  session: null as null | { nihoUserId: string; idTokenExpiresAt: number },
  providers: { status: "ok", providers: [] } as { status: string; providers?: Pick<HostProvider, "id" | "memberRole">[] },
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/experience/store-server", () => ({ siteThreadRepository: () => (state.store ? { repository: state.store, kind: state.kind } : null) }));
vi.mock("@/lib/host/server", () => ({ readHostSession: async () => state.session, loadHostProviders: async () => state.providers }));
vi.mock("@/lib/host/session", () => ({ idTokenUsable: (session: { idTokenExpiresAt: number }, now: number) => session.idTokenExpiresAt > now }));

import { APIConnectionTimeoutError, InternalServerError } from "@anthropic-ai/sdk";
import { createTranslator, type Translator } from "@/lib/translation/anthropic";
import { HOST_TO_ENGLISH_SYSTEM, TRANSLATION_MODEL } from "@/lib/translation/prompts";
import { HOST_INVALID_INPUT_TEXT, HOST_SESSION_ENDED_TEXT } from "./errors";
import {
  draftGuestQuestionEnglish,
  GUEST_QUESTION_LOAD_FAILED_TEXT,
  GUEST_QUESTION_MISSING_TEXT,
  GUEST_QUESTION_OWNER_ONLY_TEXT,
  GUEST_QUESTION_REPLY_FAILED_TEXT,
  countSiteBookingThreads,
  hostThread,
  loadGuestQuestions,
  loadMoreGuestQuestions,
  openGuestQuestion,
  replyToGuestQuestion,
  REPLY_DRAFT_TIMEOUT_MS,
} from "./guest-questions-server";
import { BOOKING_THREAD_CLOSED_TEXT, REPLY_DRAFT_FAILED_TEXT, REPLY_DRAFT_UNAVAILABLE_TEXT } from "./messages";

const THREAD_ID = "00000000-0000-4000-8000-000000000106";
const COMMAND_ID = "00000000-0000-4000-8000-0000000c0106";
const OWNER = { id: "sample-provider", memberRole: "OWNER" } as HostProvider;
const ACTOR: HostActor = { providerId: "sample-provider", nihoUserId: "sample-niho-user", calendarRoleCeiling: "OWNER" };

const QUESTION: GuestQuestionMessage = { id: "m-1", author: "GUEST", source: "SITE_FORM", body: "Is there a vegetarian option?", bodyJa: null, createdAtUtc: "2026-10-31T01:02:03.000Z", deliveryStatus: null };
const REPLY: GuestQuestionMessage = { id: "m-2", author: "HOST", source: "HOST_CONSOLE", body: "Yes, we can.", bodyJa: "はい、できます。", createdAtUtc: "2026-10-31T02:00:00.000Z", deliveryStatus: "PENDING" };
const ANSWER: GuestQuestionMessage = { id: "m-3", author: "GUEST", source: "REPLY_PAGE", body: "Thank you!", bodyJa: null, createdAtUtc: "2026-10-31T15:30:00.000Z", deliveryStatus: null };
const STORED: Omit<GuestQuestionThreadSummary, "lastMessage"> = {
  id: THREAD_ID, productId: "tea", productTitle: "Synthetic tea", guestName: "Sample Guest", topic: "FOOD", language: "EN",
  needsReply: true, read: false, lastMessageAtUtc: ANSWER.createdAtUtc, createdAtUtc: QUESTION.createdAtUtc, booking: null,
};
const SUMMARY: GuestQuestionThreadSummary = { ...STORED, lastMessage: ANSWER };
const THREAD: GuestQuestionThread = { ...STORED, messages: [QUESTION, REPLY, ANSWER] };

beforeEach(() => {
  state.store = {
    listThreads: vi.fn(async () => ({ threads: [SUMMARY], nextCursor: null })),
    markThreadRead: vi.fn(async () => undefined),
    getThread: vi.fn(async () => THREAD),
    reply: vi.fn(async () => REPLY),
  };
  state.kind = null;
  state.session = { nihoUserId: "sample-niho-user", idTokenExpiresAt: Date.now() + 60_000 };
  state.providers = { status: "ok", providers: [OWNER, { id: "sample-other", memberRole: "EDITOR" }] };
});

describe("hostThread", () => {
  it("shows the guest's words untranslated, the host's English and Japanese, and each reply's email, dated in Japan", () => {
    expect(hostThread(STORED, THREAD.messages)).toEqual({
      id: THREAD_ID,
      experienceId: "tea",
      guest: "Sample Guest",
      topic: "食べもの",
      booking: null,
      messages: [
        { id: "m-1", from: "guest", at: "2026-10-31T10:02", original: "Is there a vegetarian option?", language: "en", translation: null, viaEmail: false },
        { id: "m-2", from: "host", at: "2026-10-31T11:00", japanese: "はい、できます。", english: "Yes, we can.", status: "pending" },
        { id: "m-3", from: "guest", at: "2026-11-01T00:30", original: "Thank you!", language: "en", translation: null, viaEmail: true },
      ],
    });
  });

  it("names no topic for Other and reads every delivery state", () => {
    expect(hostThread({ ...STORED, topic: "OTHER", language: "JA" }, []).topic).toBeNull();
    const statuses = (["PENDING", "SENDING", "SENT", "FAILED"] as const).map((deliveryStatus) => hostThread(STORED, [{ ...REPLY, bodyJa: null, deliveryStatus }]).messages[0]);
    expect(statuses).toEqual(["pending", "pending", "sent", "failed"].map((status) => expect.objectContaining({ from: "host", japanese: "", status })));
    expect(hostThread({ ...STORED, language: "JA" }, [QUESTION]).messages[0]).toMatchObject({ language: "ja" });
  });
});

describe("loadGuestQuestions", () => {
  it("lists the OWNER's questions with their last message, and opens the one asked for in full (read)", async () => {
    const list = await loadGuestQuestions(OWNER, "sample-niho-user", null);
    expect(list).toMatchObject({ status: "live", loaded: [], requestedMissing: false, experiences: [{ id: "tea", title: "Synthetic tea" }] });
    expect(list.status === "live" && list.threads[0]?.messages.map((message) => message.id)).toEqual(["m-3"]);
    expect(state.store?.listThreads).toHaveBeenCalledWith(ACTOR, { limit: 50, kind: null });
    expect(state.store?.markThreadRead).not.toHaveBeenCalled();

    const opened = await loadGuestQuestions(OWNER, "sample-niho-user", THREAD_ID);
    expect(opened).toMatchObject({ status: "live", loaded: [THREAD_ID], requestedMissing: false });
    expect(opened.status === "live" && opened.threads[0]?.messages).toHaveLength(3);
    expect(state.store?.markThreadRead).toHaveBeenCalledWith(ACTOR, THREAD_ID);
    expect(JSON.stringify(opened)).not.toMatch(/@/);
  });

  it("marks a thread that is not the provider's as missing", async () => {
    state.store!.markThreadRead!.mockRejectedValueOnce(new StoreNotFoundError("guest question"));
    expect(await loadGuestQuestions(OWNER, "sample-niho-user", THREAD_ID)).toMatchObject({ status: "live", requestedMissing: true, loaded: [] });
  });

  it("keeps today's screen while closed, for anyone but the owner, and while the experience DB has no OWNER for them", async () => {
    expect(await loadGuestQuestions({ ...OWNER, memberRole: "EDITOR" }, "sample-niho-user", null)).toEqual({ status: "closed" });
    state.store!.listThreads!.mockRejectedValueOnce(new StoreAccessDeniedError());
    expect(await loadGuestQuestions(OWNER, "sample-niho-user", null)).toEqual({ status: "closed" });
    state.store = null;
    expect(await loadGuestQuestions(OWNER, "sample-niho-user", null)).toEqual({ status: "closed" });
  });

  it("says the questions could not be read when the DB fails", async () => {
    state.store!.listThreads!.mockRejectedValueOnce(new Error("synthetic outage"));
    expect(await loadGuestQuestions(OWNER, "sample-niho-user", null)).toEqual({ status: "error" });
  });

  it("hands the screen the cursor of the older threads, so none drops off the list", async () => {
    expect(await loadGuestQuestions(OWNER, "sample-niho-user", null)).toMatchObject({ status: "live", nextCursor: null });
    state.store!.listThreads!.mockResolvedValueOnce({ threads: [SUMMARY], nextCursor: "sample-cursor" });
    expect(await loadGuestQuestions(OWNER, "sample-niho-user", null)).toMatchObject({ status: "live", nextCursor: "sample-cursor" });
  });
});

describe("loadMoreGuestQuestions", () => {
  it("reads the next page from the cursor as the OWNER, each thread with its last message", async () => {
    const older = { ...SUMMARY, id: "00000000-0000-4000-8000-000000000107", productId: "walk", productTitle: "Synthetic walk", lastMessage: QUESTION };
    state.store!.listThreads!.mockResolvedValueOnce({ threads: [older], nextCursor: "sample-cursor-2" });
    const page = await loadMoreGuestQuestions("sample-provider", "sample-cursor");
    expect(state.store?.listThreads).toHaveBeenCalledWith(ACTOR, { limit: 50, cursor: "sample-cursor", kind: null });
    expect(page).toMatchObject({ ok: true, experiences: [{ id: "walk", title: "Synthetic walk" }], nextCursor: "sample-cursor-2" });
    expect(page.ok && page.threads.map((thread) => [thread.id, thread.messages.map((message) => message.id)])).toEqual([[older.id, ["m-1"]]]);
    expect(JSON.stringify(page)).not.toMatch(/@/);
  });

  it("reads nothing for anyone but the OWNER, and says when the cursor or the DB fails", async () => {
    expect(await loadMoreGuestQuestions("sample-other", "sample-cursor")).toEqual({ ok: false, message: GUEST_QUESTION_OWNER_ONLY_TEXT });
    state.store!.listThreads!.mockRejectedValueOnce(new StoreValidationError("cursor is invalid."));
    expect(await loadMoreGuestQuestions("sample-provider", "broken")).toEqual({ ok: false, message: HOST_INVALID_INPUT_TEXT });
    state.store!.listThreads!.mockRejectedValueOnce(new Error("synthetic outage"));
    expect(await loadMoreGuestQuestions("sample-provider", "sample-cursor")).toEqual({ ok: false, message: GUEST_QUESTION_LOAD_FAILED_TEXT });
  });
});

describe("openGuestQuestion and replyToGuestQuestion", () => {
  it("open a thread in full and send a reply as the OWNER, answering the thread as it is now", async () => {
    expect(await openGuestQuestion("sample-provider", THREAD_ID)).toMatchObject({ ok: true, thread: { id: THREAD_ID } });
    expect(state.store?.markThreadRead).toHaveBeenCalledWith(ACTOR, THREAD_ID);
    const sent = await replyToGuestQuestion("sample-provider", THREAD_ID, { japanese: "はい、できます。", english: "Yes, we can.", commandId: COMMAND_ID });
    expect(sent).toMatchObject({ ok: true, message: "送りました", thread: { id: THREAD_ID } });
    expect(state.store?.reply).toHaveBeenCalledWith(ACTOR, THREAD_ID, { english: "Yes, we can.", japanese: "はい、できます。", commandId: COMMAND_ID });
    await replyToGuestQuestion("sample-provider", THREAD_ID, { japanese: "  ", english: "See you.", commandId: COMMAND_ID });
    expect(state.store?.reply).toHaveBeenLastCalledWith(ACTOR, THREAD_ID, { english: "See you.", japanese: null, commandId: COMMAND_ID });
  });

  it("do nothing unless the session is usable and NIHO says this account is the OWNER", async () => {
    state.session = null;
    expect(await openGuestQuestion("sample-provider", THREAD_ID)).toEqual({ ok: false, message: HOST_SESSION_ENDED_TEXT });
    state.session = { nihoUserId: "sample-niho-user", idTokenExpiresAt: Date.now() + 60_000 };
    for (const providerId of ["sample-other", "sample-unknown"]) {
      expect(await replyToGuestQuestion(providerId, THREAD_ID, { japanese: "", english: "Yes.", commandId: COMMAND_ID })).toEqual({ ok: false, message: GUEST_QUESTION_OWNER_ONLY_TEXT });
    }
    expect(state.store?.reply).not.toHaveBeenCalled();
    state.providers = { status: "error" };
    expect(await openGuestQuestion("sample-provider", THREAD_ID)).toEqual({ ok: false, message: GUEST_QUESTION_LOAD_FAILED_TEXT });
    state.store = null;
    expect(await replyToGuestQuestion("sample-provider", THREAD_ID, { japanese: "", english: "Yes.", commandId: COMMAND_ID })).toEqual({ ok: false, message: GUEST_QUESTION_REPLY_FAILED_TEXT });
  });

  it("tell the host what the store refused", async () => {
    state.store!.reply!.mockRejectedValueOnce(new StoreAccessDeniedError());
    expect(await replyToGuestQuestion("sample-provider", THREAD_ID, { japanese: "", english: "Yes.", commandId: COMMAND_ID })).toEqual({ ok: false, message: GUEST_QUESTION_OWNER_ONLY_TEXT });
    state.store!.reply!.mockRejectedValueOnce(new StoreNotFoundError("guest question"));
    expect(await replyToGuestQuestion("sample-provider", THREAD_ID, { japanese: "", english: "Yes.", commandId: COMMAND_ID })).toEqual({ ok: false, message: GUEST_QUESTION_MISSING_TEXT });
    state.store!.reply!.mockRejectedValueOnce(new StoreConflictError("synthetic"));
    expect(await replyToGuestQuestion("sample-provider", THREAD_ID, { japanese: "", english: "Yes.", commandId: COMMAND_ID })).toEqual({ ok: false, message: GUEST_QUESTION_REPLY_FAILED_TEXT });
    state.store!.getThread!.mockRejectedValueOnce(new StoreValidationError("synthetic"));
    expect(await openGuestQuestion("sample-provider", "not-a-uuid")).toEqual({ ok: false, message: HOST_INVALID_INPUT_TEXT });
  });
});

describe("draftGuestQuestionEnglish (英語にする, #285 slice 5)", () => {
  const JAPANESE = "はい、ベジタリアンの方にも対応できます。";
  const reply = (text: string) => ({ content: [{ type: "text" as const, text }], stop_reason: "end_turn" as const });
  /** The real translator over a stubbed Claude API call. */
  function api(answer: () => Promise<ReturnType<typeof reply> | { content: []; stop_reason: "refusal" }>) {
    const create = vi.fn(answer);
    return { create, translator: () => createTranslator(create as never, REPLY_DRAFT_TIMEOUT_MS) as Translator };
  }

  it("drafts the English of the OWNER's Japanese with the guest's last message as context, waiting 15 s once", async () => {
    const { create, translator } = api(async () => reply("Yes, we can also cater for vegetarians."));
    expect(await draftGuestQuestionEnglish("sample-provider", THREAD_ID, JAPANESE, translator)).toEqual({ ok: true, message: "英語にしました", english: "Yes, we can also cater for vegetarians." });
    expect(state.store?.getThread).toHaveBeenCalledWith(ACTOR, THREAD_ID);
    expect(create).toHaveBeenCalledOnce();
    const [body, options] = create.mock.calls[0] as unknown as [Record<string, unknown>, Record<string, unknown>];
    expect(options).toEqual({ timeout: 15_000, maxRetries: 0 });
    expect(body).toMatchObject({ model: TRANSLATION_MODEL, system: HOST_TO_ENGLISH_SYSTEM });
    // The guest's last message (the answer from the reply page), then the host's Japanese; nothing else.
    expect(body.messages).toEqual([{ role: "user", content: `<traveler_message>\nThank you!\n</traveler_message>\n\n<reply>\n${JAPANESE}\n</reply>` }]);
    expect(JSON.stringify(body)).not.toMatch(/Sample Guest|sample-provider|sample-niho-user|Synthetic tea|00000000-/);
    // Nothing is sent or saved.
    expect(state.store?.reply).not.toHaveBeenCalled();
    expect(state.store?.markThreadRead).not.toHaveBeenCalled();
  });

  it("lets the host write the English when translation is off, and try again when the API times out, fails, declines or answers nothing usable", async () => {
    // Off: as before this slice.
    expect(await draftGuestQuestionEnglish("sample-provider", THREAD_ID, JAPANESE, () => null)).toEqual({ ok: false, message: REPLY_DRAFT_UNAVAILABLE_TEXT });
    for (const answer of [
      async () => Promise.reject(new APIConnectionTimeoutError()),
      async () => Promise.reject(new InternalServerError(529, undefined, "overloaded", new Headers())),
      async () => ({ content: [] as [], stop_reason: "refusal" as const }),
      async () => reply("   "),
    ]) {
      const { translator } = api(answer as never);
      expect(await draftGuestQuestionEnglish("sample-provider", THREAD_ID, JAPANESE, translator)).toEqual({ ok: false, message: REPLY_DRAFT_FAILED_TEXT });
    }
  });

  it("calls nothing unless the session is usable and this account is the OWNER of the thread", async () => {
    const { create, translator } = api(async () => reply("Yes."));
    state.session = null;
    expect(await draftGuestQuestionEnglish("sample-provider", THREAD_ID, JAPANESE, translator)).toEqual({ ok: false, message: HOST_SESSION_ENDED_TEXT });
    state.session = { nihoUserId: "sample-niho-user", idTokenExpiresAt: Date.now() + 60_000 };
    expect(await draftGuestQuestionEnglish("sample-other", THREAD_ID, JAPANESE, translator)).toEqual({ ok: false, message: GUEST_QUESTION_OWNER_ONLY_TEXT });
    state.store!.getThread!.mockRejectedValueOnce(new StoreNotFoundError("guest question"));
    expect(await draftGuestQuestionEnglish("sample-provider", THREAD_ID, JAPANESE, translator)).toEqual({ ok: false, message: GUEST_QUESTION_MISSING_TEXT });
    state.store!.getThread!.mockRejectedValueOnce(new Error("synthetic"));
    expect(await draftGuestQuestionEnglish("sample-provider", THREAD_ID, JAPANESE, translator)).toEqual({ ok: false, message: REPLY_DRAFT_FAILED_TEXT });
    state.store = null;
    expect(await draftGuestQuestionEnglish("sample-provider", THREAD_ID, JAPANESE, translator)).toEqual({ ok: false, message: REPLY_DRAFT_UNAVAILABLE_TEXT });
    expect(create).not.toHaveBeenCalled();
  });
});

describe("this site's bookings' threads (#285 slice 6b)", () => {
  const BOOKING_ID = "0f8fad5b-d9cb-469f-a165-708677289501";
  const BOOKING_THREAD_ID = "00000000-0000-4000-8000-000000000285";
  const BOOKING: GuestQuestionThreadBooking = {
    publicBookingId: BOOKING_ID, status: "CONFIRMED", localDate: "2026-11-14", localStartTime: "10:00", startUtc: "2026-11-14T01:00:00.000Z",
    adultCount: 2, childCount: 1, open: true,
  };
  const MESSAGE: GuestQuestionMessage = { id: "m-9", author: "GUEST", source: "BOOKING_PAGE", body: "Is there parking?", bodyJa: "駐車場はありますか？", createdAtUtc: "2026-11-01T01:00:00.000Z", deliveryStatus: null };
  const STORED_BOOKING: GuestQuestionThread = { ...STORED, id: BOOKING_THREAD_ID, productId: "walk", productTitle: "Synthetic walk", topic: null, booking: BOOKING, messages: [MESSAGE] };
  const START: GuestBookingThreadStart = { threadId: null, productId: "walk", productTitle: "Synthetic walk", guestName: "Sample Booker", language: "EN", booking: BOOKING };
  const NEW_ID = `new-booking-${BOOKING_ID}`;

  beforeEach(() => {
    state.store!.findBookingThread = vi.fn(async () => START);
    state.store!.replyToBooking = vi.fn(async () => ({ threadId: BOOKING_THREAD_ID, message: REPLY }));
    state.store!.countThreads = vi.fn(async () => 2);
    state.store!.getThread = vi.fn(async (_actor: HostActor, id: string) => (id === BOOKING_THREAD_ID ? STORED_BOOKING : THREAD));
  });

  it("shows the booking's date, start and party, from this site, closed once it takes no messages", () => {
    expect(hostThread(STORED_BOOKING, STORED_BOOKING.messages)).toMatchObject({
      id: BOOKING_THREAD_ID, topic: null, booking: { id: BOOKING_ID, date: "2026-11-14", start: "10:00", guests: 3, site: true },
      messages: [{ from: "guest", original: "Is there parking?", translation: "駐車場はありますか？", viaEmail: false }],
    });
    expect(hostThread(STORED_BOOKING, []).booking).not.toHaveProperty("closed");
    expect(hostThread({ ...STORED_BOOKING, booking: { ...BOOKING, open: false } }, []).booking).toMatchObject({ closed: true });
  });

  it("opens a booking's thread from ?booking=, or its empty one before anyone wrote", async () => {
    state.store!.findBookingThread!.mockResolvedValueOnce({ ...START, threadId: BOOKING_THREAD_ID });
    const opened = await loadGuestQuestions(OWNER, "sample-niho-user", null, BOOKING_ID);
    expect(opened).toMatchObject({ status: "live", loaded: [BOOKING_THREAD_ID], requestedMissing: false, newThread: null });
    expect(state.store?.markThreadRead).toHaveBeenCalledWith(ACTOR, BOOKING_THREAD_ID);

    const empty = await loadGuestQuestions(OWNER, "sample-niho-user", null, BOOKING_ID);
    expect(empty).toMatchObject({
      status: "live", loaded: [NEW_ID], requestedMissing: false,
      newThread: { id: NEW_ID, guest: "Sample Booker", experienceId: "walk", booking: { id: BOOKING_ID, guests: 3, site: true }, messages: [] },
    });
    expect(empty.status === "live" && empty.experiences).toContainEqual({ id: "walk", title: "Synthetic walk" });

    state.store!.findBookingThread!.mockRejectedValueOnce(new StoreNotFoundError("guest booking"));
    expect(await loadGuestQuestions(OWNER, "sample-niho-user", null, BOOKING_ID)).toMatchObject({ status: "live", requestedMissing: true, newThread: null });
  });

  it("keeps to the kind that is open: questions only, or bookings only", async () => {
    state.kind = "QUESTION";
    expect(await loadGuestQuestions(OWNER, "sample-niho-user", null, BOOKING_ID)).toMatchObject({ status: "live", requestedMissing: false, newThread: null });
    expect(state.store?.findBookingThread).not.toHaveBeenCalled();
    expect(state.store?.listThreads).toHaveBeenLastCalledWith(ACTOR, { limit: 50, kind: "QUESTION" });
    expect(await loadGuestQuestions(OWNER, "sample-niho-user", BOOKING_THREAD_ID)).toMatchObject({ status: "live", requestedMissing: true });
    expect(await replyToGuestQuestion("sample-provider", NEW_ID, { japanese: "", english: "Hi.", commandId: COMMAND_ID })).toEqual({ ok: false, message: GUEST_QUESTION_MISSING_TEXT });

    state.kind = "BOOKING";
    expect(await openGuestQuestion("sample-provider", THREAD_ID)).toEqual({ ok: false, message: GUEST_QUESTION_MISSING_TEXT });
    expect(await replyToGuestQuestion("sample-provider", THREAD_ID, { japanese: "", english: "Hi.", commandId: COMMAND_ID })).toEqual({ ok: false, message: GUEST_QUESTION_MISSING_TEXT });
    expect(state.store?.reply).not.toHaveBeenCalled();
    expect(await openGuestQuestion("sample-provider", BOOKING_THREAD_ID)).toMatchObject({ ok: true, thread: { id: BOOKING_THREAD_ID } });
  });

  it("starts the booking's thread with the host's first reply and answers it with its stored id", async () => {
    const sent = await replyToGuestQuestion("sample-provider", NEW_ID, { japanese: "ようこそ", english: "Welcome!", commandId: COMMAND_ID });
    expect(state.store?.replyToBooking).toHaveBeenCalledWith(ACTOR, BOOKING_ID, { english: "Welcome!", japanese: "ようこそ", commandId: COMMAND_ID });
    expect(state.store?.reply).not.toHaveBeenCalled();
    expect(sent).toMatchObject({ ok: true, thread: { id: BOOKING_THREAD_ID, booking: { id: BOOKING_ID } } });
    state.store!.replyToBooking!.mockRejectedValueOnce(new BookingMessagesClosedError());
    expect(await replyToGuestQuestion("sample-provider", NEW_ID, { japanese: "", english: "Hi.", commandId: COMMAND_ID })).toEqual({ ok: false, message: BOOKING_THREAD_CLOSED_TEXT });
    state.store!.reply!.mockRejectedValueOnce(new BookingMessagesClosedError());
    expect(await replyToGuestQuestion("sample-provider", BOOKING_THREAD_ID, { japanese: "", english: "Hi.", commandId: COMMAND_ID })).toEqual({ ok: false, message: BOOKING_THREAD_CLOSED_TEXT });
  });

  it("drafts the English of a first message without a guest message for context", async () => {
    const create = vi.fn(async () => ({ content: [{ type: "text" as const, text: "Welcome!" }], stop_reason: "end_turn" as const }));
    const translator = () => createTranslator(create as never, REPLY_DRAFT_TIMEOUT_MS) as Translator;
    expect(await draftGuestQuestionEnglish("sample-provider", NEW_ID, "ようこそ", translator)).toEqual({ ok: true, message: "英語にしました", english: "Welcome!" });
    expect(state.store?.findBookingThread).toHaveBeenCalledWith(ACTOR, BOOKING_ID);
    expect(state.store?.getThread).not.toHaveBeenCalled();
    const [body] = create.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(JSON.stringify(body.messages)).not.toContain("traveler_message");
  });

  it("counts the bookings' threads for the notice beside NIHO's messages, 0 when closed or unreadable", async () => {
    expect(await countSiteBookingThreads(OWNER, "sample-niho-user")).toBe(2);
    expect(state.store?.countThreads).toHaveBeenCalledWith(ACTOR, { kind: "BOOKING" });
    expect(await countSiteBookingThreads({ ...OWNER, memberRole: "EDITOR" }, "sample-niho-user")).toBe(0);
    state.store!.countThreads!.mockRejectedValueOnce(new Error("synthetic outage"));
    expect(await countSiteBookingThreads(OWNER, "sample-niho-user")).toBe(0);
    state.kind = "QUESTION";
    expect(await countSiteBookingThreads(OWNER, "sample-niho-user")).toBe(0);
  });
});
