import { beforeEach, describe, expect, it, vi } from "vitest";
import { StoreAccessDeniedError, StoreConflictError, type AssignmentOccurrence, type HostAssignmentList } from "@niho-experience/experience-store";
import type { HostProvider } from "@/lib/host/providers";

/** 開催回の担当 (#535) on the host side, against a stubbed store and provider list. */
const state = vi.hoisted(() => ({
  store: null as null | { list: ReturnType<typeof vi.fn>; claim: ReturnType<typeof vi.fn>; decline: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn>; history: ReturnType<typeof vi.fn> },
  session: null as null | { nihoUserId: string; accessTokenExpiresAt: number },
  providers: { status: "ok", providers: [] } as { status: string; providers?: Pick<HostProvider, "id" | "nihoUserId" | "memberRole">[] },
  mock: false,
  config: { occurrenceAssignmentEnabled: true, managedSalesEnabled: true },
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ config: state.config }));
vi.mock("@/lib/experience/store-server", () => ({ occurrenceAssignmentRepository: () => state.store }));
vi.mock("@/lib/host/server", () => ({ readHostSession: async () => state.session, loadHostProviders: async () => state.providers, isHostMock: () => state.mock }));
vi.mock("@/lib/host/session", () => ({ accessTokenUsable: (session: { accessTokenExpiresAt: number }, now: number) => session.accessTokenExpiresAt > now }));

import { assignmentFor } from "./assignments";
import { claimOccurrence, declineOccurrence, loadAssignments, readAssignmentHistory, releaseOccurrence } from "./assignments-server";

const COMMAND = "0f8fad5b-d9cb-469f-a165-708677289501";
const member = (memberRole: HostProvider["memberRole"], id = "sample-provider") => ({ id, nihoUserId: "sample-user", memberRole }) as HostProvider;
const item = (over: Partial<AssignmentOccurrence> = {}): AssignmentOccurrence => ({
  providerId: "sample-provider", occurrenceId: "occ-1", productId: "tea", ruleId: "rule-1", experienceTitle: "Synthetic", localDate: "2026-12-05", localStartTime: "10:00",
  startsAtUtc: "2026-12-05T01:00:00.000Z", bookingCount: 1, participants: 2, firstRequestedAtUtc: "2026-11-13T00:00:00.000Z", status: "OPEN",
  assignedToMe: false, assignedAtUtc: null, declinedByMe: false, agreedFeeYen: null, ...over,
});
const LIST: HostAssignmentList = { open: [item()], mine: [], taken: [] };

beforeEach(() => {
  state.mock = false;
  Object.assign(state.config, { occurrenceAssignmentEnabled: true, managedSalesEnabled: true });
  state.session = { nihoUserId: "sample-user", accessTokenExpiresAt: Date.now() + 60_000 };
  state.providers = { status: "ok", providers: [member("OWNER"), member("EDITOR", "sample-editor"), member("COHOST", "sample-cohost")] };
  state.store = {
    list: vi.fn(async () => LIST),
    claim: vi.fn(async () => ({ outcome: "ASSIGNED", repeated: false })),
    decline: vi.fn(async () => ({ outcome: "DECLINED", repeated: false })),
    release: vi.fn(async () => ({ outcome: "RELEASED", repeated: false })),
    history: vi.fn(async () => []),
  };
});

describe("loadAssignments", () => {
  it("is closed while the flag is off, in mock mode, and for people who cannot serve; the store is not read", async () => {
    state.config.occurrenceAssignmentEnabled = false;
    expect(await loadAssignments(member("OWNER"))).toEqual({ status: "closed" });
    state.config.occurrenceAssignmentEnabled = true; state.mock = true;
    expect(await loadAssignments(member("OWNER"))).toEqual({ status: "closed" });
    state.mock = false;
    expect(await loadAssignments(member("EDITOR"))).toEqual({ status: "closed" });
    expect(await loadAssignments(member("VIEWER"))).toEqual({ status: "closed" });
    expect(state.store!.list).not.toHaveBeenCalled();
  });

  it("reads the list for an OWNER or COHOST as the provider's reader, never as a higher role", async () => {
    expect(await loadAssignments(member("COHOST"))).toEqual({ status: "live", ...LIST });
    expect(state.store!.list).toHaveBeenCalledWith({ providerId: "sample-provider", nihoUserId: "sample-user", calendarRoleCeiling: "EDITOR" });
  });

  it("says closed when the store refuses and error when it fails", async () => {
    state.store!.list.mockRejectedValueOnce(new StoreAccessDeniedError());
    expect(await loadAssignments(member("OWNER"))).toEqual({ status: "closed" });
    state.store!.list.mockRejectedValueOnce(new Error("down"));
    expect(await loadAssignments(member("OWNER"))).toEqual({ status: "error" });
  });
});

describe("claim / decline / release", () => {
  it("claims for a member and answers with the list as it is now", async () => {
    const answer = await claimOccurrence("sample-provider", "occ-1", COMMAND);
    expect(answer).toMatchObject({ ok: true, outcome: "ASSIGNED", list: LIST });
    expect(state.store!.claim).toHaveBeenCalledWith(expect.objectContaining({ providerId: "sample-provider", nihoUserId: "sample-user" }), { occurrenceId: "occ-1", commandId: COMMAND });
  });

  it("tells a late 対応する that someone else already is the assignee, with the list, and does not fail", async () => {
    state.store!.claim.mockResolvedValueOnce({ outcome: "TAKEN", repeated: false });
    state.store!.list.mockResolvedValueOnce({ open: [], mine: [], taken: [item({ status: "ASSIGNED" })] });
    const answer = await claimOccurrence("sample-provider", "occ-1", COMMAND);
    expect(answer.ok).toBe(false);
    expect(answer.outcome).toBe("TAKEN");
    expect(answer.message).toBe("すでに別の人が担当になっています。");
    expect(answer.list?.taken).toHaveLength(1);
  });

  it("refuses an editor, an unknown provider, a closed flag and an ended session without touching the store", async () => {
    expect((await claimOccurrence("sample-editor", "occ-1", COMMAND)).ok).toBe(false);
    expect((await claimOccurrence("other-provider", "occ-1", COMMAND)).ok).toBe(false);
    state.config.occurrenceAssignmentEnabled = false;
    expect((await claimOccurrence("sample-provider", "occ-1", COMMAND)).ok).toBe(false);
    state.config.occurrenceAssignmentEnabled = true;
    state.session = { nihoUserId: "sample-user", accessTokenExpiresAt: Date.now() - 1 };
    expect((await claimOccurrence("sample-provider", "occ-1", COMMAND)).message).toContain("ログイン");
    expect(state.store!.claim).not.toHaveBeenCalled();
  });

  it("maps a store refusal to a sentence and keeps the reason optional", async () => {
    state.store!.claim.mockRejectedValueOnce(new StoreAccessDeniedError());
    expect((await claimOccurrence("sample-provider", "occ-1", COMMAND)).ok).toBe(false);
    state.store!.claim.mockRejectedValueOnce(new StoreConflictError("closed"));
    expect((await claimOccurrence("sample-provider", "occ-1", COMMAND)).ok).toBe(false);
    expect(await declineOccurrence("sample-provider", "occ-1", COMMAND, "")).toMatchObject({ ok: true, outcome: "DECLINED" });
    expect(state.store!.decline).toHaveBeenCalledWith(expect.anything(), { occurrenceId: "occ-1", commandId: COMMAND, reason: "" });
    expect(await releaseOccurrence("sample-provider", "occ-1", COMMAND, "体調不良")).toMatchObject({ ok: true, outcome: "RELEASED" });
  });

  it("reads one occurrence's history only through the store's own check", async () => {
    expect(await readAssignmentHistory("sample-provider", "occ-1")).toMatchObject({ ok: true, history: [] });
    state.store!.history.mockRejectedValueOnce(new StoreAccessDeniedError());
    expect((await readAssignmentHistory("sample-provider", "occ-1")).ok).toBe(false);
  });
});

describe("assignmentFor", () => {
  it("matches a booking to its occurrence by experience, offer, day and start", () => {
    const list: HostAssignmentList = { open: [item()], mine: [item({ occurrenceId: "occ-2", localDate: "2026-12-06", status: "ASSIGNED", assignedToMe: true })], taken: [item({ occurrenceId: "occ-3", localDate: "2026-12-07", status: "ASSIGNED" })] };
    const booking = (date: string) => ({ experienceId: "tea", offerId: "rule-1", date, start: "10:00" });
    expect(assignmentFor(list, booking("2026-12-05"))?.kind).toBe("OPEN");
    expect(assignmentFor(list, booking("2026-12-06"))?.kind).toBe("MINE");
    expect(assignmentFor(list, booking("2026-12-07"))?.kind).toBe("TAKEN");
    expect(assignmentFor(list, booking("2026-12-08"))).toBeNull();
    expect(assignmentFor(null, booking("2026-12-05"))).toBeNull();
    expect(assignmentFor(list, { ...booking("2026-12-05"), experienceId: "other" })).toBeNull();
  });
});
