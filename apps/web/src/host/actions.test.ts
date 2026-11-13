import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostMockScenario } from "@/lib/host/session";

/**
 * The console's server actions against NIHO's host API: the contract mock (mock mode, the
 * session's scenario) and a stubbed NIHO (http mode). Only the session and revalidatePath are
 * stubbed; the typed client, the contract mock and the screens' rules are the real ones.
 */
const state = vi.hoisted(() => ({
  config: { apiMode: "mock" as "mock" | "http", nihoWebOrigin: "https://niho.example.test" },
  scenario: "default" as HostMockScenario,
  expired: false,
  revalidated: [] as string[],
}));
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: (path: string, type?: string) => state.revalidated.push(`${path} ${type ?? ""}`.trim()) }));
vi.mock("@/lib/config", () => ({ config: state.config, isPreview: true }));
vi.mock("@/lib/host/server", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/host/server")>();
  return {
    ...actual,
    readHostSession: async () => {
      const now = Date.now();
      return {
        refreshToken: "r",
        accessToken: "mock-access-token.actions-test",
        accessTokenExpiresAt: state.expired ? now - 1000 : now + 3_600_000,
        connectionId: "c",
        connectionExpiresAt: now + 86_400_000,
        expiresAt: now + 86_400_000,
        displayName: "サンプル ホスト",
        iconUrl: null,
        mockScenario: state.scenario,
      };
    },
  };
});

import { draftPageEnglish, draftReplyEnglish, draftReviewReplyEnglish, loadMoreGuestQuestionThreads, openGuestQuestionThread, openPayoutConnect, recordSiteAttendance, registerProvider, saveProviderMeetingPoint, saveProviderProfile, sendGuestQuestionReply, sharePayoutAccount, submitProviderReview, syncPayoutAccount } from "./actions";
import { HOST_INVALID_INPUT_TEXT, HOST_SESSION_ENDED_TEXT } from "./errors";
import { SITE_BOOKING_LOAD_FAILED_TEXT } from "./site-bookings";
import { GUEST_QUESTION_LOAD_FAILED_TEXT, GUEST_QUESTION_REPLY_FAILED_TEXT } from "./guest-questions-server";
import { MESSAGE_TEXT_LIMIT, REPLY_DRAFT_UNAVAILABLE_TEXT } from "./messages";
import { MOCK_KITCHEN_EXPERIENCES, MOCK_STUDIO_EXPERIENCES, PREVIEW_PAGE_ENGLISH } from "./mock/experiences";
import { MOCK_REVIEW_REPLY_EXAMPLES } from "./mock/reviews";
import { EMPTY_PAGE_TEXT, PAGE_ENGLISH_UNAVAILABLE_TEXT } from "./page-english";
import { MOCK_REPLY_EXAMPLES, PREVIEW_ENGLISH_DRAFT } from "./mock/threads";
import { REVIEW_REPLY_TEXT_LIMIT } from "./reviews";

const KITCHEN = "sample-provider-kitchen";
const STUDIO = "sample-provider-studio";

/** http mode: NIHO is the global fetch, answering `respond` and recording what was sent. */
function stubNiho(respond: (path: string) => Response) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  vi.stubGlobal("fetch", (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    calls.push({ method: init?.method ?? "GET", path, body: typeof init?.body === "string" ? JSON.parse(init.body) : null });
    return respond(path);
  }) as typeof fetch);
  return calls;
}

beforeEach(() => {
  state.config.apiMode = "mock";
  state.scenario = "default";
  state.expired = false;
  state.revalidated = [];
});
afterEach(() => vi.unstubAllGlobals());

const registration = { kind: "BUSINESS", displayName: "合成スタジオ", bio: "合成の紹介文", sellerDisclosureUrl: "", consentVersion: "synthetic-consent" };

describe("registerProvider", () => {
  it("validates form shape and never calls the removed NIHO provider-registration API", async () => {
    state.config.apiMode = "http";
    const calls = stubNiho(() => new Response(null, { status: 500 }));
    expect(await registerProvider(registration)).toEqual({ ok: false, message: "この操作は現在のNIHO契約では利用できません。体験の商品・販売条件の変更は新しい体験販売画面から行ってください。" });
    for (const input of [{ ...registration, kind: "COMPANY" }, { ...registration, displayName: 1 }, { ...registration, bio: "x".repeat(5000) }, null]) {
      expect(await registerProvider(input as never)).toEqual({ ok: false, message: HOST_INVALID_INPUT_TEXT });
    }
    expect(calls).toEqual([]);
  });
});

describe("saveProviderProfile", () => {
  it("keeps validation but never calls the removed NIHO provider-profile API", async () => {
    state.config.apiMode = "http";
    const calls = stubNiho(() => new Response(null, { status: 500 }));
    expect(await saveProviderProfile({ providerId: KITCHEN, bio: "合成の新しい紹介" })).toEqual({ ok: false, message: "この操作は現在のNIHO契約では利用できません。体験の商品・販売条件の変更は新しい体験販売画面から行ってください。" });
    expect(await saveProviderProfile({ providerId: KITCHEN })).toEqual({ ok: false, message: HOST_INVALID_INPUT_TEXT });
    expect(await saveProviderProfile({ providerId: KITCHEN, sellerDisclosureUrl: "https://example.test/legal" })).toEqual({ ok: false, message: HOST_INVALID_INPUT_TEXT });
    expect(await saveProviderProfile({ providerId: "../admin", bio: "x" })).toEqual({ ok: false, message: HOST_INVALID_INPUT_TEXT });
    expect(calls).toEqual([]);
  });
});

describe("saveProviderMeetingPoint", () => {
  const meeting = { overview: "（合成）駅の近く", address: "（合成）サンプル町 1 丁目", accessNote: "", mapUrl: "https://maps.example.test/sample", entranceNote: "（合成）木の門" };

  it("keeps input validation but never calls the removed NIHO meeting-point API", async () => {
    state.config.apiMode = "http";
    const calls = stubNiho(() => new Response(null, { status: 500 }));
    expect(await saveProviderMeetingPoint({ providerId: KITCHEN, meetingPoint: meeting })).toEqual({ ok: false, message: "この操作は現在のNIHO契約では利用できません。体験の商品・販売条件の変更は新しい体験販売画面から行ってください。" });
    expect(await saveProviderMeetingPoint({ providerId: "../admin", meetingPoint: meeting })).toEqual({ ok: false, message: HOST_INVALID_INPUT_TEXT });
    expect(calls).toEqual([]);
  });
});

describe("submitProviderReview", () => {
  it("does not call the removed NIHO review operation", async () => {
    state.config.apiMode = "http";
    const calls = stubNiho(() => new Response(null, { status: 500 }));
    expect(await submitProviderReview({ providerId: KITCHEN })).toEqual({ ok: false, message: "この操作は現在のNIHO契約では利用できません。体験の商品・販売条件の変更は新しい体験販売画面から行ってください。" });
    expect(calls).toEqual([]);
  });
});

describe("sharePayoutAccount", () => {
  it("does not call the removed NIHO Connect-mutation operation", async () => {
    state.config.apiMode = "http";
    const calls = stubNiho(() => new Response(null, { status: 500 }));
    expect(await sharePayoutAccount({ providerId: KITCHEN, sourceSpotId: "synthetic-spot", consentVersion: "synthetic-consent" }))
      .toEqual({ ok: false, message: "この操作は現在のNIHO契約では利用できません。体験の商品・販売条件の変更は新しい体験販売画面から行ってください。" });
    expect(calls).toEqual([]);
  });
});

describe("openPayoutConnect and syncPayoutAccount", () => {
  it("does not call NIHO Connect mutation routes from the old host UI", async () => {
    state.config.apiMode = "http";
    const calls = stubNiho(() => new Response(null, { status: 500 }));
    expect(await openPayoutConnect({ providerId: KITCHEN, step: "resume" })).toEqual({ ok: false, message: "この操作は現在のNIHO契約では利用できません。体験の商品・販売条件の変更は新しい体験販売画面から行ってください。" });
    expect(await syncPayoutAccount({ providerId: KITCHEN })).toEqual({ ok: false, message: "この操作は現在のNIHO契約では利用できません。体験の商品・販売条件の変更は新しい体験販売画面から行ってください。" });
    expect(await openPayoutConnect({ providerId: KITCHEN, step: "elsewhere" as never })).toEqual({ ok: false, message: HOST_INVALID_INPUT_TEXT });
    expect(calls).toEqual([]);
  });
});

describe("英語にする (#106)", () => {
  const example = MOCK_REPLY_EXAMPLES[0]!;

  it("mock: the example reply's natural English, and a preview sentence for anything else", async () => {
    expect(await draftReplyEnglish({ providerId: KITCHEN, threadId: example.threadId, japanese: example.japanese })).toEqual({ ok: true, message: "英語にしました", english: example.english });
    expect(await draftReplyEnglish({ providerId: KITCHEN, threadId: "th-bk-2044", japanese: "ご予約ありがとうございます。" })).toEqual({ ok: true, message: "英語にしました", english: PREVIEW_ENGLISH_DRAFT });
    expect(state.revalidated).toEqual([]);
  });

  it("checks what the browser sent: a provider, a thread and Japanese that is not blank nor too long", async () => {
    const ok = { providerId: KITCHEN, threadId: example.threadId, japanese: "はい" };
    for (const input of [
      { ...ok, providerId: "../admin" },
      { ...ok, threadId: "" },
      { ...ok, threadId: "x".repeat(201) },
      { ...ok, japanese: "  \n" },
      { ...ok, japanese: "あ".repeat(MESSAGE_TEXT_LIMIT + 1) },
      { ...ok, japanese: 42 },
      null,
    ]) {
      expect(await draftReplyEnglish(input as never)).toEqual({ ok: false, message: HOST_INVALID_INPUT_TEXT });
    }
    expect((await draftReplyEnglish({ ...ok, japanese: "あ".repeat(MESSAGE_TEXT_LIMIT) })).ok).toBe(true);
  });

  it("http: without the Claude API (translation off) the host writes the English, and nothing is sent to NIHO", async () => {
    state.config.apiMode = "http";
    const calls = stubNiho(() => new Response(null, { status: 500 }));
    expect(await draftReplyEnglish({ providerId: KITCHEN, threadId: example.threadId, japanese: example.japanese })).toEqual({ ok: false, message: REPLY_DRAFT_UNAVAILABLE_TEXT });
    expect(calls).toEqual([]);
  });
});

describe("レビュー › 英語にする (#108)", () => {
  const example = MOCK_REVIEW_REPLY_EXAMPLES[0]!;

  it("mock: the example reply's natural English, and a preview sentence for anything else", async () => {
    expect(await draftReviewReplyEnglish({ providerId: KITCHEN, reviewId: example.reviewId, japanese: example.japanese })).toEqual({ ok: true, message: "英語にしました", english: example.english });
    expect(await draftReviewReplyEnglish({ providerId: KITCHEN, reviewId: example.reviewId, japanese: "ありがとうございました。" })).toEqual({ ok: true, message: "英語にしました", english: PREVIEW_ENGLISH_DRAFT });
    expect(state.revalidated).toEqual([]);
  });

  it("checks what the browser sent: a provider, a review and Japanese that is not blank nor too long", async () => {
    const ok = { providerId: KITCHEN, reviewId: example.reviewId, japanese: "はい" };
    for (const input of [
      { ...ok, providerId: "../admin" },
      { ...ok, reviewId: "" },
      { ...ok, reviewId: "x".repeat(201) },
      { ...ok, japanese: "  \n" },
      { ...ok, japanese: "あ".repeat(REVIEW_REPLY_TEXT_LIMIT + 1) },
      { ...ok, japanese: 42 },
      null,
    ]) {
      expect(await draftReviewReplyEnglish(input as never)).toEqual({ ok: false, message: HOST_INVALID_INPUT_TEXT });
    }
    expect((await draftReviewReplyEnglish({ ...ok, japanese: "あ".repeat(REVIEW_REPLY_TEXT_LIMIT) })).ok).toBe(true);
  });

  it("http: not until NIHO's API makes the English, and nothing is sent to NIHO", async () => {
    state.config.apiMode = "http";
    const calls = stubNiho(() => new Response(null, { status: 500 }));
    expect(await draftReviewReplyEnglish({ providerId: KITCHEN, reviewId: example.reviewId, japanese: example.japanese })).toEqual({ ok: false, message: REPLY_DRAFT_UNAVAILABLE_TEXT });
    expect(calls).toEqual([]);
  });
});

describe("体験の編集 › 英語の下書きを作る (#110)", () => {
  const dinner = MOCK_KITCHEN_EXPERIENCES.find((experience) => experience.id === "community-dinner")!;
  const calligraphy = MOCK_STUDIO_EXPERIENCES[0]!;

  it("mock: the sample's English for its Japanese, a preview sentence for other Japanese, and blank for blank", async () => {
    const result = await draftPageEnglish({ providerId: STUDIO, experienceId: "calligraphy", japanese: calligraphy.japanese! });
    expect(result.ok && [result.message, result.english.title, result.english.dayLanguage, result.english.description]).toEqual(["英語の下書きを作りました", "Write Your Own Kanji with a Kamakura Calligrapher", "Japanese and English", ""]);
    const changed = await draftPageEnglish({ providerId: KITCHEN, experienceId: "community-dinner", japanese: { ...dinner.japanese!, description: "季節の料理を、地元の人といっしょに。" } });
    expect(changed.ok && [changed.english.description, changed.english.lead]).toEqual([PREVIEW_PAGE_ENGLISH, dinner.lead]);
    expect(state.revalidated).toEqual([]);
  });

  it("checks what the browser sent: a provider, an experience and Japanese within the editor's limits, not all blank", async () => {
    const ok = { providerId: KITCHEN, experienceId: "community-dinner", japanese: dinner.japanese! };
    for (const input of [
      { ...ok, providerId: "../admin" },
      { ...ok, experienceId: "" },
      { ...ok, experienceId: "x".repeat(201) },
      { ...ok, japanese: EMPTY_PAGE_TEXT },
      { ...ok, japanese: { ...dinner.japanese!, title: "あ".repeat(96) } },
      { ...ok, japanese: { ...dinner.japanese!, conditions: { RAIN: "雨" } } },
      { ...ok, japanese: "鎌倉の夕食" },
      null,
    ]) {
      expect(await draftPageEnglish(input as never)).toEqual({ ok: false, message: HOST_INVALID_INPUT_TEXT });
    }
  });

  it("http: not until NIHO's API drafts a page's English, and nothing is sent to NIHO", async () => {
    state.config.apiMode = "http";
    const calls = stubNiho(() => new Response(null, { status: 500 }));
    expect(await draftPageEnglish({ providerId: KITCHEN, experienceId: "community-dinner", japanese: dinner.japanese! })).toEqual({ ok: false, message: PAGE_ENGLISH_UNAVAILABLE_TEXT });
    expect(calls).toEqual([]);
  });

  it("asks for a reload when the session has ended", async () => {
    state.expired = true;
    expect(await draftPageEnglish({ providerId: KITCHEN, experienceId: "community-dinner", japanese: dinner.japanese! })).toEqual({ ok: false, message: HOST_SESSION_ENDED_TEXT });
  });
});

describe("the session", () => {
  it("asks for a reload instead of sending an expired token", async () => {
    state.config.apiMode = "http";
    state.expired = true;
    const calls = stubNiho(() => new Response(null, { status: 500 }));
    expect(await submitProviderReview({ providerId: KITCHEN })).toEqual({ ok: false, message: HOST_SESSION_ENDED_TEXT });
    expect(await saveProviderProfile({ providerId: KITCHEN, bio: "x" })).toEqual({ ok: false, message: HOST_SESSION_ENDED_TEXT });
    expect(await draftReplyEnglish({ providerId: KITCHEN, threadId: "th-3012", japanese: "はい" })).toEqual({ ok: false, message: HOST_SESSION_ENDED_TEXT });
    expect(await draftReviewReplyEnglish({ providerId: KITCHEN, reviewId: "rv-5020", japanese: "はい" })).toEqual({ ok: false, message: HOST_SESSION_ENDED_TEXT });
    expect(calls).toEqual([]);
  });
});

describe("出欠 of the bookings made on this site (#107)", () => {
  const mark = { providerId: KITCHEN, bookingId: "00000000-0000-4000-8000-000000000107", attendance: "attended" as const };

  it("refuses what is not a provider, a booking and one of the two marks before reaching the store", async () => {
    for (const input of [
      { ...mark, providerId: "" },
      { ...mark, bookingId: "bk-2038" },
      { ...mark, attendance: "late" },
      { ...mark, attendance: undefined },
      null,
    ]) {
      expect(await recordSiteAttendance(input as never)).toEqual({ ok: false, message: HOST_INVALID_INPUT_TEXT });
    }
  });

  it("keeps nothing where the bookings made here are not kept (the mock, or the flag off)", async () => {
    expect(await recordSiteAttendance(mark)).toEqual({ ok: false, message: SITE_BOOKING_LOAD_FAILED_TEXT });
  });
});

describe("questions to the host kept in the experience DB (#106)", () => {
  const reply = { providerId: KITCHEN, threadId: "00000000-0000-4000-8000-000000000106", japanese: "はい", english: "Yes.", commandId: "00000000-0000-4000-8000-0000000c0106" };

  it("checks what the browser sent before anything else", async () => {
    for (const input of [{}, { ...reply, providerId: "../admin" }, { ...reply, threadId: "x".repeat(201) }, { ...reply, japanese: "  ", english: "" }, { ...reply, english: 5 }, { ...reply, english: "x".repeat(MESSAGE_TEXT_LIMIT + 1) }, { ...reply, japanese: 1 }, { ...reply, commandId: "retry-1" }]) {
      expect(await sendGuestQuestionReply(input as never)).toEqual({ ok: false, message: HOST_INVALID_INPUT_TEXT });
    }
    expect(await openGuestQuestionThread({ providerId: KITCHEN } as never)).toEqual({ ok: false, message: HOST_INVALID_INPUT_TEXT });
    for (const input of [{ providerId: KITCHEN }, { providerId: KITCHEN, cursor: "x".repeat(201) }, { providerId: "../admin", cursor: "sample-cursor" }]) {
      expect(await loadMoreGuestQuestionThreads(input as never)).toEqual({ ok: false, message: HOST_INVALID_INPUT_TEXT });
    }
  });

  it("is closed in the preview, which keeps its synthetic threads on the screen", async () => {
    expect(await openGuestQuestionThread({ providerId: KITCHEN, threadId: reply.threadId })).toEqual({ ok: false, message: GUEST_QUESTION_LOAD_FAILED_TEXT });
    expect(await sendGuestQuestionReply(reply)).toEqual({ ok: false, message: GUEST_QUESTION_REPLY_FAILED_TEXT });
    expect(await loadMoreGuestQuestionThreads({ providerId: KITCHEN, cursor: "sample-cursor" })).toEqual({ ok: false, message: GUEST_QUESTION_LOAD_FAILED_TEXT });
  });
});
