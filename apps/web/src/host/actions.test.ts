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
        idToken: "mock-id-token.actions-test",
        idTokenExpiresAt: state.expired ? now - 1000 : now + 3_600_000,
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

import { draftPageEnglish, draftReplyEnglish, draftReviewReplyEnglish, loadMoreGuestQuestionThreads, openGuestQuestionThread, openPayoutConnect, registerProvider, saveProviderMeetingPoint, saveProviderProfile, sendGuestQuestionReply, sharePayoutAccount, submitProviderReview, syncPayoutAccount } from "./actions";
import { PREVIEW_STRIPE_TEXT, STRIPE_LINK_UNUSABLE_TEXT, STRIPE_SYNCED_TEXT } from "./connect";
import { HOST_ERROR_REASON_TEXT, HOST_INVALID_INPUT_TEXT, HOST_SESSION_ENDED_TEXT } from "./errors";
import { GUEST_QUESTION_LOAD_FAILED_TEXT, GUEST_QUESTION_REPLY_FAILED_TEXT } from "./guest-questions-server";
import { MESSAGE_TEXT_LIMIT, REPLY_DRAFT_UNAVAILABLE_TEXT } from "./messages";
import { MOCK_KITCHEN_EXPERIENCES, MOCK_STUDIO_EXPERIENCES, PREVIEW_PAGE_ENGLISH } from "./mock/experiences";
import { MOCK_REVIEW_REPLY_EXAMPLES } from "./mock/reviews";
import { EMPTY_PAGE_TEXT, PAGE_ENGLISH_UNAVAILABLE_TEXT } from "./page-english";
import { MOCK_REPLY_EXAMPLES, PREVIEW_ENGLISH_DRAFT } from "./mock/threads";
import { REVIEW_REPLY_TEXT_LIMIT } from "./reviews";

// The contract mock's synthetic consents (packages/api-client/src/host/mock.ts).
const PROVIDER_CONSENT = "sample-provider-consent-1";
const REUSE_CONSENT = { version: "sample-payment-reuse-consent-1", text: "（サンプル）拠点の販売者口座を、体験の売上の受取に使うことに同意します。この文言は合成データです。" };
const KITCHEN = "sample-provider-kitchen";
const STUDIO = "sample-provider-studio";
const GARDEN = "sample-provider-garden";

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

const providerBody = (id: string) => ({
  id,
  ownerUserId: "sample-user",
  vesselSpotId: `${id}-vessel`,
  kind: "BUSINESS",
  displayName: "合成スタジオ",
  bio: "",
  sellerDisclosureUrl: null,
  reviewStatus: "DRAFT",
  consentVersion: PROVIDER_CONSENT,
  consentedAt: "2026-10-21T00:00:00.000Z",
  submittedAt: null,
  approvedAt: null,
  paymentReuseConsentVersion: null,
  paymentReuseConsentedAt: null,
  paymentReuseSourceSpotId: null,
  createdAt: "2026-10-21T00:00:00.000Z",
  updatedAt: "2026-10-21T00:00:00.000Z",
});
const consents = { consent: { version: PROVIDER_CONSENT, text: "合成の同意文" }, paymentReuseConsent: REUSE_CONSENT };

beforeEach(() => {
  state.config.apiMode = "mock";
  state.scenario = "default";
  state.expired = false;
  state.revalidated = [];
});
afterEach(() => vi.unstubAllGlobals());

const registration = { kind: "BUSINESS", displayName: "合成スタジオ", bio: "合成の紹介文", sellerDisclosureUrl: "", consentVersion: PROVIDER_CONSENT };

describe("registerProvider", () => {
  it("mock: registers with the contract mock, then signs in again as a host whose provider starts where a new one does", async () => {
    state.scenario = "empty";
    expect(await registerProvider(registration)).toEqual({ ok: true, message: "登録しました。", next: "/host/auth/mock-login?mock=payments-pending" });
  });

  it("mock: says in one sentence why NIHO refused it", async () => {
    state.scenario = "empty";
    expect(await registerProvider({ ...registration, consentVersion: "sample-provider-consent-0" })).toEqual({ ok: false, message: HOST_ERROR_REASON_TEXT.PROVIDER_CONSENT_OUTDATED });
    expect(await registerProvider({ ...registration, sellerDisclosureUrl: "http://example.com/legal" })).toEqual({ ok: false, message: HOST_INVALID_INPUT_TEXT });
    expect(await registerProvider({ ...registration, displayName: "   " })).toEqual({ ok: false, message: HOST_INVALID_INPUT_TEXT });
  });

  it("http: sends the registration to NIHO and opens the new provider's home", async () => {
    state.config.apiMode = "http";
    const calls = stubNiho(() => Response.json({ provider: providerBody("p_new-1"), ...consents }, { status: 201 }));
    expect(await registerProvider({ ...registration, sellerDisclosureUrl: " https://example.com/legal " })).toEqual({ ok: true, message: "登録しました。", next: "/host/home?providerId=p_new-1" });
    expect(calls).toEqual([
      { method: "POST", path: "/api/experience-providers", body: { kind: "BUSINESS", displayName: "合成スタジオ", bio: "合成の紹介文", sellerDisclosureUrl: "https://example.com/legal", consentVersion: PROVIDER_CONSENT } },
    ]);
  });

  it("refuses what the form never sends without asking NIHO", async () => {
    state.config.apiMode = "http";
    const calls = stubNiho(() => new Response(null, { status: 500 }));
    for (const input of [{ ...registration, kind: "COMPANY" }, { ...registration, displayName: 1 }, { ...registration, bio: "x".repeat(5000) }, null]) {
      expect(await registerProvider(input as never)).toEqual({ ok: false, message: HOST_INVALID_INPUT_TEXT });
    }
    expect(calls).toEqual([]);
  });
});

describe("saveProviderProfile", () => {
  it("mock: saves what changed and shows what NIHO kept: a reviewed provider goes back to review", async () => {
    const result = await saveProviderProfile({ providerId: KITCHEN, bio: "  合成の新しい紹介  " });
    expect(result).toEqual({
      ok: true,
      message: "保存しました",
      profile: { displayName: "サンプルの台所", bio: "合成の新しい紹介", sellerDisclosureUrl: "https://example.com/sample-kitchen/legal" },
      reviewStatus: "REQUESTED",
    });
    expect(state.revalidated).toEqual(["/ layout"]);
  });

  it("mock: the seller page is the owner's; an editor changes the rest", async () => {
    expect(await saveProviderProfile({ providerId: STUDIO, sellerDisclosureUrl: "https://example.com/studio" })).toEqual({ ok: false, message: "この操作をする権限がありません。提供者のオーナーに依頼してください。" });
    expect(await saveProviderProfile({ providerId: STUDIO, displayName: "合成の工房" })).toMatchObject({ ok: true, profile: { displayName: "合成の工房", sellerDisclosureUrl: "" }, reviewStatus: "DRAFT" });
  });

  it("http: sends only the fields that changed, an empty seller page as none", async () => {
    state.config.apiMode = "http";
    const calls = stubNiho(() => Response.json({ provider: providerBody(KITCHEN) }));
    expect(await saveProviderProfile({ providerId: KITCHEN, sellerDisclosureUrl: "  " })).toMatchObject({ ok: true });
    expect(calls).toEqual([{ method: "PATCH", path: `/api/experience-providers/${KITCHEN}`, body: { sellerDisclosureUrl: null } }]);
  });

  it("refuses nothing to save, and ids that are not NIHO's, without asking NIHO", async () => {
    state.config.apiMode = "http";
    const calls = stubNiho(() => new Response(null, { status: 500 }));
    expect(await saveProviderProfile({ providerId: KITCHEN })).toEqual({ ok: false, message: HOST_INVALID_INPUT_TEXT });
    expect(await saveProviderProfile({ providerId: "../admin", bio: "x" })).toEqual({ ok: false, message: HOST_INVALID_INPUT_TEXT });
    expect(calls).toEqual([]);
  });
});

describe("saveProviderMeetingPoint", () => {
  const meeting = { overview: "（合成）駅の近く", address: "（合成）サンプル町 1 丁目", accessNote: "", mapUrl: "https://maps.example.test/sample", entranceNote: "（合成）木の門" };

  it("mock: NIHO keeps all five fields trimmed and answers what it kept", async () => {
    const result = await saveProviderMeetingPoint({ providerId: KITCHEN, meetingPoint: { ...meeting, overview: "  （合成）駅の近く  " } });
    expect(result).toEqual({ ok: true, message: "保存しました", meetingPoint: meeting });
    expect(state.revalidated).toContain("/ layout");
  });

  it("http: sends the trimmed values in one PUT", async () => {
    state.config.apiMode = "http";
    const calls = stubNiho(() => Response.json({ meetingPoint: meeting }));
    expect(await saveProviderMeetingPoint({ providerId: KITCHEN, meetingPoint: { ...meeting, entranceNote: " （合成）木の門\n" } })).toMatchObject({ ok: true, meetingPoint: meeting });
    expect(calls).toEqual([{ method: "PUT", path: `/api/experience-providers/${KITCHEN}/meeting-point`, body: meeting }]);
  });

  it("refuses a missing or unknown field, a value over NIHO's limit and a map URL that is not https, without asking NIHO", async () => {
    state.config.apiMode = "http";
    const calls = stubNiho(() => new Response(null, { status: 500 }));
    for (const meetingPoint of [
      { ...meeting, overview: "x".repeat(201) },
      { ...meeting, address: "x".repeat(501) },
      { ...meeting, accessNote: "x".repeat(2001) },
      { ...meeting, entranceNote: "x".repeat(2001) },
      { ...meeting, mapUrl: "http://maps.example.test/sample" },
      { ...meeting, mapUrl: "https://user:secret@maps.example.test/sample" },
      { ...meeting, mapUrl: "javascript:alert(1)" },
      { overview: "", address: "", accessNote: "", mapUrl: "" },
      { ...meeting, phone: "000" },
      { ...meeting, overview: 1 },
      null,
    ]) expect(await saveProviderMeetingPoint({ providerId: KITCHEN, meetingPoint: meetingPoint as never })).toEqual({ ok: false, message: HOST_INVALID_INPUT_TEXT });
    expect(await saveProviderMeetingPoint({ providerId: "../admin", meetingPoint: meeting })).toEqual({ ok: false, message: HOST_INVALID_INPUT_TEXT });
    // Spaces NIHO trims do not count toward the limit; an empty map URL is no map.
    expect(await saveProviderMeetingPoint({ providerId: KITCHEN, meetingPoint: { ...meeting, overview: ` ${"x".repeat(200)} `, mapUrl: "" } })).toMatchObject({ ok: false });
    expect(calls).toEqual([{ method: "PUT", path: `/api/experience-providers/${KITCHEN}/meeting-point`, body: { ...meeting, overview: "x".repeat(200), mapUrl: "" } }]);
  });

  it("answers NIHO's refusal in words", async () => {
    state.config.apiMode = "http";
    stubNiho(() => Response.json({ error: { code: "NOT_FOUND", message: "x", details: {} } }, { status: 404 }));
    expect(await saveProviderMeetingPoint({ providerId: KITCHEN, meetingPoint: meeting })).toEqual({ ok: false, message: "提供者が見つかりません。権限が無いか、URL が正しくありません。" });
  });
});

describe("submitProviderReview", () => {
  it("mock: a provider not submitted yet, with its https seller page, waits for NIHO's review", async () => {
    state.scenario = "payments-pending";
    expect(await submitProviderReview({ providerId: GARDEN })).toEqual({ ok: true, message: "審査を申請しました。", reviewStatus: "REQUESTED" });
  });

  it("mock: a reviewed provider cannot ask again, and an editor cannot ask at all", async () => {
    expect(await submitProviderReview({ providerId: KITCHEN })).toEqual({ ok: false, message: HOST_ERROR_REASON_TEXT.PROVIDER_REVIEW_STATE_CONFLICT });
    expect(await submitProviderReview({ providerId: STUDIO })).toEqual({ ok: false, message: "提供者が見つかりません。権限が無いか、URL が正しくありません。" });
  });
});

describe("sharePayoutAccount", () => {
  beforeEach(() => {
    state.scenario = "payments-pending";
  });

  it("mock: shares a spot's ready account with NIHO's consent, and reads the account back", async () => {
    expect(await sharePayoutAccount({ providerId: GARDEN, sourceSpotId: "sample-spot-house", consentVersion: REUSE_CONSENT.version })).toEqual({
      ok: true,
      message: "サンプルの拠点の口座を共有しました。",
      payout: { status: "owner", payout: { reason: "READY", sharedFrom: "サンプルの拠点", candidates: [{ id: "sample-spot-house", name: "サンプルの拠点" }], reuseConsent: REUSE_CONSENT } },
    });
  });

  it("mock: says why a spot's account cannot be shared", async () => {
    const share = (sourceSpotId: string, consentVersion = REUSE_CONSENT.version) => sharePayoutAccount({ providerId: GARDEN, sourceSpotId, consentVersion });
    expect(await share("sample-spot-annex")).toEqual({ ok: false, message: HOST_ERROR_REASON_TEXT.PROVIDER_PAYMENT_SOURCE_NOT_READY });
    expect(await share("someone-elses-spot")).toEqual({ ok: false, message: HOST_ERROR_REASON_TEXT.PROVIDER_PAYMENT_SOURCE_FORBIDDEN });
    expect(await share("sample-spot-house", "sample-payment-reuse-consent-0")).toEqual({ ok: false, message: HOST_ERROR_REASON_TEXT.PROVIDER_PAYMENT_CONSENT_OUTDATED });
    state.scenario = "default";
    expect(await sharePayoutAccount({ providerId: KITCHEN, sourceSpotId: "sample-spot-house", consentVersion: REUSE_CONSENT.version })).toEqual({ ok: false, message: "申込があるため口座は変更できません。" });
  });
});

describe("openPayoutConnect and syncPayoutAccount", () => {
  it("mock: Stripe's page does not exist, so finishing it is stood in for and the account is read back", async () => {
    state.scenario = "payments-pending";
    expect(await openPayoutConnect({ providerId: GARDEN, step: "start" })).toEqual({
      ok: true,
      message: PREVIEW_STRIPE_TEXT,
      redirectTo: null,
      payout: { status: "owner", payout: { reason: "READY", sharedFrom: null, candidates: [{ id: "sample-spot-house", name: "サンプルの拠点" }], reuseConsent: REUSE_CONSENT } },
    });
  });

  it("mock: reading an account that was never connected says so; a connected one is read again", async () => {
    state.scenario = "payments-pending";
    expect(await syncPayoutAccount({ providerId: GARDEN })).toEqual({ ok: false, message: HOST_ERROR_REASON_TEXT.PROVIDER_PAYMENT_NOT_CONNECTED });
    state.scenario = "default";
    expect(await syncPayoutAccount({ providerId: KITCHEN })).toMatchObject({ ok: true, message: STRIPE_SYNCED_TEXT, payout: { status: "owner", payout: { reason: "READY" } } });
  });

  it("http: follows only Stripe's own page", async () => {
    state.config.apiMode = "http";
    const link = (url: string) => () => Response.json({ url, expiresAt: "2026-10-21T00:05:00.000Z", ready: false, reason: "VERIFICATION_REQUIRED" });
    stubNiho(link("https://connect.stripe.com/setup/e/acct_sample/abc"));
    expect(await openPayoutConnect({ providerId: KITCHEN, step: "resume" })).toEqual({ ok: true, message: "Stripe の画面へ移ります。", redirectTo: "https://connect.stripe.com/setup/e/acct_sample/abc", payout: null });
    stubNiho(link("https://connect.stripe.example.test/setup"));
    expect(await openPayoutConnect({ providerId: KITCHEN, step: "start" })).toEqual({ ok: false, message: STRIPE_LINK_UNUSABLE_TEXT });
    stubNiho(() => Response.json({ error: { code: "CONFLICT", message: "shared", details: { reason: "PROVIDER_PAYMENT_SHARED_ACCOUNT" } } }, { status: 409 }));
    expect(await openPayoutConnect({ providerId: KITCHEN, step: "start" })).toEqual({ ok: false, message: HOST_ERROR_REASON_TEXT.PROVIDER_PAYMENT_SHARED_ACCOUNT });
    expect(await openPayoutConnect({ providerId: KITCHEN, step: "elsewhere" as never })).toEqual({ ok: false, message: HOST_INVALID_INPUT_TEXT });
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

  it("http: not until NIHO's API makes the English, and nothing is sent to NIHO", async () => {
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

describe("questions to the host kept in the experience DB (#106)", () => {
  const reply = { providerId: KITCHEN, threadId: "00000000-0000-4000-8000-000000000106", japanese: "はい", english: "Yes.", commandId: "00000000-0000-4000-8000-0000000c0106" };

  it("checks what the browser sent before anything else", async () => {
    for (const input of [{}, { ...reply, providerId: "../admin" }, { ...reply, threadId: "x".repeat(201) }, { ...reply, english: "  " }, { ...reply, english: "x".repeat(MESSAGE_TEXT_LIMIT + 1) }, { ...reply, japanese: 1 }, { ...reply, commandId: "retry-1" }]) {
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
