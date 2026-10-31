import { isValidElement, type ReactElement } from "react";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

type Load = Mock<(...args: unknown[]) => Promise<unknown>>;

/** メッセージ's choice between NIHO's booking messages and this site's threads (#106, #285 slice 6b), against stubbed data. */
const state = vi.hoisted(() => ({
  providerOperations: false,
  memberRole: "OWNER" as string,
  site: { status: "closed" } as Record<string, unknown>,
  count: 0,
  loadGuestQuestions: null as null | Load,
  countSiteBookingThreads: null as null | Load,
  loadHostMessages: null as null | Load,
}));
vi.mock("server-only", () => ({}));
vi.mock("next/navigation", async (importActual) => ({
  ...(await importActual<typeof import("next/navigation")>()),
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
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
  loadHostMessages: (...args: unknown[]) => state.loadHostMessages!(...args),
}));
vi.mock("@/host/guest-questions-server", () => ({
  GUEST_QUESTION_LOAD_FAILED_TEXT: "synthetic load failure",
  loadGuestQuestions: (...args: unknown[]) => state.loadGuestQuestions!(...args),
  countSiteBookingThreads: (...args: unknown[]) => state.countSiteBookingThreads!(...args),
}));
vi.mock("@/lib/host/server", () => ({ isHostMock: () => false }));
vi.mock("@/lib/host/provider-operations-server", () => ({ providerOperationsEnabled: () => state.providerOperations }));

import HostMessagesPage from "./page";
import { HostLiveBookings } from "@/components/host/HostLiveBookings";
import { HostMessages } from "@/components/host/HostMessages";

const BOOKING = "0f8fad5b-d9cb-469f-a165-708677289501";
const NEW_THREAD = { id: `new-booking-${BOOKING}`, experienceId: "walk", guest: "Sample Booker", topic: null, booking: { id: BOOKING, date: "2026-11-14", start: "10:00", guests: 3, site: true }, messages: [] };
const LIVE = { status: "live", threads: [], loaded: [NEW_THREAD.id], requestedMissing: false, newThread: NEW_THREAD, experiences: [{ id: "walk", title: "Synthetic walk" }], nextCursor: null, today: "2026-10-31", now: "2026-10-31T10:00" };

beforeEach(() => {
  state.providerOperations = false;
  state.memberRole = "OWNER";
  state.site = { status: "closed" };
  state.count = 0;
  state.loadGuestQuestions = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => state.site);
  state.countSiteBookingThreads = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => state.count);
  state.loadHostMessages = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({ list: { status: "unavailable" }, requested: null, experiences: [], today: "2026-10-31", now: "2026-10-31T10:00" }));
});

/** The page, with its own local views (SiteThreads) rendered down to the screen component they choose. */
async function page(query: Record<string, string> = {}): Promise<ReactElement<Record<string, unknown>>> {
  let element: unknown = await HostMessagesPage({ searchParams: Promise.resolve(query) });
  while (isValidElement(element) && typeof element.type === "function" && element.type.name === "SiteThreads") {
    element = (element.type as (props: unknown) => unknown)(element.props);
  }
  expect(isValidElement(element)).toBe(true);
  return element as ReactElement<Record<string, unknown>>;
}

/** HostLiveBookings inside the page's fragment (with its sub header). */
function liveBookings(view: ReactElement<Record<string, unknown>>): ReactElement<Record<string, unknown>> {
  const children = (view.props.children as unknown[]).filter(isValidElement) as ReactElement<Record<string, unknown>>[];
  const live = children.find((child) => child.type === HostLiveBookings);
  expect(live).toBeTruthy();
  return live!;
}

describe("メッセージ without NIHO's booking messages (provider operations off)", () => {
  it("opens a booking made on this site from ?booking=, its empty thread before anyone wrote", async () => {
    state.site = LIVE;
    const view = await page({ booking: BOOKING });
    expect(view.type).toBe(HostMessages);
    expect(view.props).toMatchObject({ newThread: NEW_THREAD, providerId: "sample-provider", linkProviderId: "sample-provider", live: { loaded: [NEW_THREAD.id], nextCursor: null, besideNiho: false } });
    expect(state.loadGuestQuestions).toHaveBeenCalledWith(expect.objectContaining({ id: "sample-provider" }), "sample-niho-user", null, BOOKING);
    expect(state.loadHostMessages).not.toHaveBeenCalled();
  });

  it("finds no booking or thread that is not the provider's, and says when the threads could not be read", async () => {
    state.site = { ...LIVE, requestedMissing: true };
    await expect(page({ booking: BOOKING })).rejects.toThrow("NOT_FOUND");
    state.site = { status: "error" };
    expect((await page()).props).toMatchObject({ title: "メッセージを読み込めませんでした" });
  });

  it("keeps today's screen while the threads are closed to the account", async () => {
    const view = await page();
    expect((view.type as { name: string }).name).toBe("MessagesUnavailable");
    expect(state.loadHostMessages).toHaveBeenCalled();
  });
});

describe("メッセージ beside NIHO's booking messages (provider operations on)", () => {
  beforeEach(() => {
    state.providerOperations = true;
  });

  it("keeps NIHO's messages, with a notice of this site's bookings' threads when there are any", async () => {
    state.count = 3;
    const live = liveBookings(await page({ booking: "niho-1" }));
    expect(live.props).toMatchObject({ providerId: "sample-provider", initialBookingId: "niho-1", mode: "messages" });
    const notice = live.props.siteNotice as ReactElement<{ count: number; href: string }>;
    expect(notice.props).toEqual({ count: 3, href: "/host/messages?providerId=sample-provider&source=site" });
    expect(state.loadGuestQuestions).not.toHaveBeenCalled();

    state.count = 0;
    expect(liveBookings(await page()).props.siteNotice).toBeNull();
  });

  it("shows this site's threads for ?source=site, with every link keeping it", async () => {
    state.site = LIVE;
    const view = await page({ source: "site", booking: BOOKING });
    expect(view.type).toBe(HostMessages);
    expect(view.props.live).toEqual({ loaded: [NEW_THREAD.id], nextCursor: null, besideNiho: true });
    expect(state.countSiteBookingThreads).not.toHaveBeenCalled();
  });

  it("falls back to NIHO's messages when ?source=site is closed to the account", async () => {
    const live = liveBookings(await page({ source: "site" }));
    expect(live.props.siteNotice).toBeNull();
    expect(state.countSiteBookingThreads).toHaveBeenCalled();
  });
});
