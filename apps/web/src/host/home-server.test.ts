import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { HostReview, HostThread } from "./types";

/** ホーム's 次にすること in http mode, against stubbed sources (each read as its own screen reads it). */
type Load = Mock<(...args: unknown[]) => Promise<unknown>>;
const state = vi.hoisted(() => ({
  mock: false,
  providerOperations: false,
  questions: null as null | Load,
  reviews: null as null | Load,
  listPages: null as null | Load,
  listing: null as null | Load,
  client: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/host/server", () => ({
  isHostMock: () => state.mock,
  hostApiClient: (session: unknown) => {
    state.client(session);
    return { listExperienceProviderPages: state.listPages, getExperienceProviderPageListing: state.listing };
  },
}));
vi.mock("@/lib/host/session", () => ({ idTokenUsable: (session: { idTokenExpiresAt: number }, now: number) => session.idTokenExpiresAt > now }));
vi.mock("@/lib/host/provider-operations-server", () => ({ providerOperationsEnabled: () => state.providerOperations }));
vi.mock("./guest-questions-server", () => ({ loadGuestQuestions: (...args: unknown[]) => state.questions!(...args) }));
vi.mock("./guest-reviews-server", () => ({ loadGuestReviews: (...args: unknown[]) => state.reviews!(...args) }));

import { loadHomeTodos } from "./home-server";

const PROVIDER = { id: "sample-provider", displayName: "Synthetic provider", memberRole: "OWNER" } as never;
const SESSION = { nihoUserId: "sample-owner", idTokenExpiresAt: Number.MAX_SAFE_INTEGER } as never;

const THREAD: HostThread = {
  id: "thread-1", experienceId: "walk", guest: "Lucas", topic: null, booking: null,
  messages: [{ id: "m1", from: "guest", at: "2026-11-01T09:00", original: "Is it ok for kids?", language: "en", translation: "子どもでも大丈夫ですか？", viaEmail: false }],
};
const REVIEW: HostReview = {
  id: "review-1", experienceId: "walk", bookingId: "b1", sessionDate: "2026-10-30", reviewer: { name: "Mia", country: "" }, rating: 5, tags: [],
  body: { original: "Lovely morning", language: "en", translation: null }, privateNote: null, writtenAt: "2026-10-31T10:00", status: "published",
  publishedAt: "2026-10-31T10:00", reply: null, report: null,
};
const page = (id: string, status: string, title = `Synthetic ${id}`) => ({ id, slug: id, title, status, language: "EN", coverUrl: null, kind: "EXPERIENCE", listOnEntrance: false, updatedAt: "2026-10-30T00:00:00.000Z", bookingCounts: {} });
const listing = (status: string, consentedAt = "2026-10-29T16:00:00.000Z") => ({ ok: true, data: { consent: { text: "", version: "v1" }, listing: { status, consentedAt } } });

beforeEach(() => {
  vi.useFakeTimers({ now: new Date("2026-11-01T03:00:00.000Z"), toFake: ["Date"] });
  state.mock = false;
  state.providerOperations = false;
  state.client.mockClear();
  state.questions = vi.fn(async () => ({ status: "live", threads: [THREAD] }));
  state.reviews = vi.fn(async () => ({ status: "live", reviews: [REVIEW], experiences: [{ id: "walk", title: "Synthetic walk" }] }));
  state.listPages = vi.fn(async () => ({ ok: true, data: { checkoutEnabled: true, pages: [page("draft-a", "DRAFT"), page("live-a", "PUBLISHED"), page("live-b", "PUBLISHED"), page("off-a", "UNPUBLISHED")] } }));
  state.listing = vi.fn(async (_providerId: unknown, pageId: unknown) => (pageId === "live-a" ? listing("REQUESTED") : listing("ACTIVE")));
});

describe("loadHomeTodos", () => {
  it("lists the threads, then the reviews, reading them as メッセージ and レビュー do (nothing marked read)", async () => {
    const load = await loadHomeTodos(PROVIDER, SESSION);
    expect(state.questions).toHaveBeenCalledWith(PROVIDER, "sample-owner", null);
    expect(state.reviews).toHaveBeenCalledWith(PROVIDER, "sample-owner");
    expect(load.failed).toEqual([]);
    expect(load.todos.map((todo) => [todo.key, todo.status?.label, todo.title, todo.detail])).toEqual([
      ["thread-thread-1", "返信待ち", "「子どもでも大丈夫ですか？」", "Lucas さん · 3 時間前 · 英語から翻訳"],
      ["guest-review-review-1", "未返信", "「Lovely morning」", "Mia さん · Synthetic walk"],
    ]);
    // Provider operations off: NIHO's pages are not read.
    expect(state.client).not.toHaveBeenCalled();
  });

  it("adds NIHO's drafts and the listings it is checking after them, with provider operations on", async () => {
    state.providerOperations = true;
    const load = await loadHomeTodos(PROVIDER, SESSION);
    expect(state.listing!.mock.calls.map(([, pageId]) => pageId)).toEqual(["live-a", "live-b"]);
    expect(load.failed).toEqual([]);
    expect(load.todos.map((todo) => todo.key)).toEqual(["thread-thread-1", "guest-review-review-1", "draft-draft-a", "review-live-a"]);
    expect(load.todos[2]).toMatchObject({ status: { label: "下書き" }, title: "Synthetic draft-a の原稿を仕上げる", detail: "", action: { label: "編集する", href: "/host/experiences/draft-a" } });
    expect(load.todos[3]).toMatchObject({ status: { label: "審査待ち" }, title: "Synthetic live-a", detail: "10月30日に申請 · NIHO が確認中", action: null });
  });

  it("reads the listings of 20 published pages at most", async () => {
    state.providerOperations = true;
    state.listPages!.mockResolvedValueOnce({ ok: true, data: { checkoutEnabled: true, pages: Array.from({ length: 25 }, (_, index) => page(`p${index}`, "PUBLISHED")) } });
    await loadHomeTodos(PROVIDER, SESSION);
    expect(state.listing).toHaveBeenCalledTimes(20);
  });

  it("says which sources could not be read, and still shows the others", async () => {
    state.providerOperations = true;
    state.questions!.mockResolvedValueOnce({ status: "error" });
    state.listing!.mockImplementation(async (_providerId: unknown, pageId: unknown) => (pageId === "live-a" ? listing("REQUESTED") : { ok: false, kind: "network_error" }));
    const partly = await loadHomeTodos(PROVIDER, SESSION);
    expect(partly.failed).toEqual(["messages", "experiences"]);
    expect(partly.todos.map((todo) => todo.key)).toEqual(["guest-review-review-1", "draft-draft-a", "review-live-a"]);

    state.reviews!.mockResolvedValueOnce({ status: "error" });
    state.listPages!.mockResolvedValueOnce({ ok: false, kind: "error", status: 503, code: "SERVICE_UNAVAILABLE", reason: null, message: "" });
    const failed = await loadHomeTodos(PROVIDER, SESSION);
    expect(failed.failed).toEqual(["reviews", "experiences"]);
    expect(failed.todos.map((todo) => todo.key)).toEqual(["thread-thread-1"]);

    state.listPages!.mockRejectedValueOnce(new Error("down"));
    expect((await loadHomeTodos(PROVIDER, SESSION)).failed).toEqual(["experiences"]);
  });

  it("adds nothing for closed sources, NIHO refusing the account, or an ID token about to expire", async () => {
    state.providerOperations = true;
    state.questions!.mockResolvedValueOnce({ status: "closed" });
    state.reviews!.mockResolvedValueOnce({ status: "owner-only" });
    state.listPages!.mockResolvedValueOnce({ ok: false, kind: "error", status: 403, code: "FORBIDDEN", reason: null, message: "" });
    expect(await loadHomeTodos(PROVIDER, SESSION)).toEqual({ todos: [], failed: [] });

    state.listing!.mockResolvedValue({ ok: false, kind: "error", status: 404, code: "NOT_FOUND", reason: null, message: "" });
    expect((await loadHomeTodos(PROVIDER, SESSION)).failed).toEqual([]);

    state.client.mockClear();
    await loadHomeTodos(PROVIDER, { nihoUserId: "sample-owner", idTokenExpiresAt: 0 } as never);
    expect(state.client).not.toHaveBeenCalled();
  });

  it("is empty in the preview, which has its own", async () => {
    state.mock = true;
    expect(await loadHomeTodos(PROVIDER, SESSION)).toEqual({ todos: [], failed: [] });
    expect(state.questions).not.toHaveBeenCalled();
    expect(state.reviews).not.toHaveBeenCalled();
  });
});
