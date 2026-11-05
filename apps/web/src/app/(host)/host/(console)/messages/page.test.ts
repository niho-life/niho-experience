import { isValidElement, type ReactElement } from "react";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

type Load = Mock<(...args: unknown[]) => Promise<unknown>>;

/** Experience予約の会話と質問だけを開くホストメッセージ画面。 */
const state = vi.hoisted(() => ({
  memberRole: "OWNER" as string,
  questions: { status: "closed" } as Record<string, unknown>,
  loadGuestQuestions: null as null | Load,
}));
vi.mock("server-only", () => ({}));
vi.mock("next/navigation", async (importActual) => ({
  ...(await importActual<typeof import("next/navigation")>()),
  notFound: () => { throw new Error("NOT_FOUND"); },
}));
vi.mock("@/host/actions", () => ({
  loadMoreGuestQuestionThreads: vi.fn(), openGuestQuestionThread: vi.fn(), sendGuestQuestionReply: vi.fn(), draftReplyEnglish: vi.fn(),
}));
vi.mock("@/host/data", () => ({
  hostPageContext: async () => ({
    session: { nihoUserId: "sample-niho-user" },
    providers: [],
    provider: { id: "sample-provider", displayName: "Synthetic provider", memberRole: state.memberRole },
    providerNotFound: false,
    linkProviderId: "sample-provider",
  }),
}));
vi.mock("@/host/guest-questions-server", () => ({
  GUEST_QUESTION_LOAD_FAILED_TEXT: "synthetic load failure",
  loadGuestQuestions: (...args: unknown[]) => state.loadGuestQuestions!(...args),
}));

import HostMessagesPage from "./page";
import { HostMessages } from "@/components/host/HostMessages";

const BOOKING = "0f8fad5b-d9cb-469f-a165-708677289501";
const NEW_THREAD = { id: `new-booking-${BOOKING}`, experienceId: "walk", guest: "Sample Booker", topic: null, booking: { id: BOOKING, date: "2026-11-14", start: "10:00", guests: 3, site: true }, messages: [] };
const LIVE = { status: "live", threads: [], loaded: [NEW_THREAD.id], requestedMissing: false, newThread: NEW_THREAD, experiences: [{ id: "walk", title: "Synthetic walk" }], nextCursor: null, today: "2026-10-31", now: "2026-10-31T10:00" };

beforeEach(() => {
  state.memberRole = "OWNER";
  state.questions = { status: "closed" };
  state.loadGuestQuestions = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => state.questions);
});

async function page(query: Record<string, string> = {}): Promise<ReactElement<Record<string, unknown>>> {
  let element: unknown = await HostMessagesPage({ searchParams: Promise.resolve(query) });
  while (isValidElement(element) && typeof element.type === "function" && element.type.name === "SiteThreads") {
    element = (element.type as (props: unknown) => unknown)(element.props);
  }
  expect(isValidElement(element)).toBe(true);
  return element as ReactElement<Record<string, unknown>>;
}

describe("Experience messages", () => {
  it("opens an Experience booking's empty thread from its booking ID", async () => {
    state.questions = LIVE;
    const view = await page({ booking: BOOKING });
    expect(view.type).toBe(HostMessages);
    expect(view.props).toMatchObject({ newThread: NEW_THREAD, providerId: "sample-provider", linkProviderId: "sample-provider", live: { loaded: [NEW_THREAD.id], nextCursor: null } });
    expect(state.loadGuestQuestions).toHaveBeenCalledWith(expect.objectContaining({ id: "sample-provider" }), null, BOOKING);
  });

  it("opens a thread directly without legacy source selection", async () => {
    state.questions = { ...LIVE, newThread: null, loaded: [] };
    const view = await page({ thread: "th-3012" });
    expect(view.type).toBe(HostMessages);
    expect(state.loadGuestQuestions).toHaveBeenCalledWith(expect.objectContaining({ id: "sample-provider" }), "th-3012", null);
  });

  it("reports missing, unavailable and closed Experience threads without an old-system fallback", async () => {
    state.questions = { ...LIVE, requestedMissing: true };
    await expect(page({ booking: BOOKING })).rejects.toThrow("NOT_FOUND");
    state.questions = { status: "error" };
    expect((await page()).props).toMatchObject({ title: "メッセージを読み込めませんでした" });
    state.questions = { status: "closed" };
    expect((await page()).props).toMatchObject({ homeHref: "/host/home?providerId=sample-provider" });
  });

  it("keeps the message page OWNER-only", async () => {
    state.memberRole = "EDITOR";
    await expect(page()).rejects.toThrow("NOT_FOUND");
    expect(state.loadGuestQuestions).not.toHaveBeenCalled();
  });
});
