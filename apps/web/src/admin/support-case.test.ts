import { describe, expect, it } from "vitest";
import { buildSupportCasePatch, draftAfterConfirmedPatch, draftAfterConflictChoice, normalizeSupportCaseMemo, reconcileLatestSupportCase, supportCaseDraft } from "./support-case";

const baseline = {
  bookingRequestId: "booking-1",
  assignedAdmin: { status: "ACTIVE" as const, id: "admin-1", displayName: "合成 管理者" },
  internalMemo: "保存済み",
  revision: 4,
  createdAt: "2026-10-23T01:00:00.000Z",
  updatedAt: "2026-10-23T02:00:00.000Z",
};

describe("Admin support case draft helpers", () => {
  it("normalizes CRLF, trims and maps an empty memo to null", () => {
    expect(normalizeSupportCaseMemo("  one\r\ntwo  ")).toBe("one\ntwo");
    expect(normalizeSupportCaseMemo(" \r\n ")).toBeNull();
  });

  it("patches only fields that changed and carries the baseline revision", () => {
    const unchanged = supportCaseDraft(baseline);
    expect(buildSupportCasePatch(baseline, unchanged)).toBeNull();
    expect(buildSupportCasePatch(baseline, { ...unchanged, memo: " 新しいメモ " })).toEqual({ expectedRevision: 4, internalMemo: "新しいメモ" });
    expect(buildSupportCasePatch(baseline, { ...unchanged, assignment: { kind: "unassigned" } })).toEqual({ expectedRevision: 4, assignedAdminUserId: null });
  });

  it("does not invent an ID for an unavailable assignee", () => {
    const unavailable = { ...baseline, assignedAdmin: { status: "UNAVAILABLE" as const } };
    const draft = supportCaseDraft(unavailable);
    expect(buildSupportCasePatch(unavailable, { ...draft, memo: "changed" })).toEqual({ expectedRevision: 4, internalMemo: "changed" });
    expect(buildSupportCasePatch(unavailable, draft)).toBeNull();
  });

  it("does not trim untouched legacy memo content or include it in assignment-only saves", () => {
    const legacy = { ...baseline, internalMemo: "  保存済み\r\nメモ  " };
    const draft = supportCaseDraft(legacy);
    expect(buildSupportCasePatch(legacy, draft)).toBeNull();
    expect(buildSupportCasePatch(legacy, { ...draft, assignment: { kind: "unassigned" } })).toEqual({ expectedRevision: 4, assignedAdminUserId: null });
    expect(buildSupportCasePatch(legacy, { ...draft, memo: "" })).toEqual({ expectedRevision: 4, internalMemo: null });
  });

  it("keeps only edited fields after explicit conflict inheritance", () => {
    const current = { ...baseline, assignedAdmin: { status: "ACTIVE" as const, id: "outside-old", displayName: "以前の担当" } };
    const latest = { ...baseline, assignedAdmin: { status: "ACTIVE" as const, id: "outside-new", displayName: "現在の担当" }, revision: 5, internalMemo: "別の入力" };
    const draft = { ...supportCaseDraft(current), memo: "自分の変更" };
    const rebased = draftAfterConflictChoice(current, draft, latest);
    expect(rebased.assignment).toEqual({ kind: "active", id: "outside-new" });
    expect(buildSupportCasePatch(latest, rebased)).toEqual({ expectedRevision: 5, internalMemo: "自分の変更" });
    const changedAssignment = { ...draft, assignment: { kind: "active" as const, id: "my-choice" } };
    expect(draftAfterConflictChoice(current, changedAssignment, latest).assignment).toEqual(changedAssignment.assignment);
  });

  it("applies a confirmed PATCH without erasing fields changed while it was in flight", () => {
    const submitted = { ...supportCaseDraft(baseline), memo: "submitted" };
    const current = { ...submitted, memo: "newer typing" };
    const saved = { ...baseline, internalMemo: "submitted", revision: 5, updatedAt: "2026-10-23T03:00:00.000Z" };
    expect(draftAfterConfirmedPatch(current, submitted, saved)).toEqual({ ...current, assignment: { kind: "active", id: "admin-1" } });
  });

  it("refreshes capability at the same exact revision without touching the draft", () => {
    const response = { supportCase: baseline, writeCapability: { writable: true as const, reason: null } };
    const draft = { ...supportCaseDraft(baseline), memo: "newer typing" };
    const latest = { ...response, writeCapability: { writable: false as const, reason: "WRITES_DISABLED" as const } };
    expect(reconcileLatestSupportCase(response, draft, latest)).toEqual({ kind: "confirmed", baseline: latest, draft });
  });

  it("never auto-rebases a dirty draft onto a newer revision", () => {
    const response = { supportCase: baseline, writeCapability: { writable: true as const, reason: null } };
    const draft = { ...supportCaseDraft(baseline), memo: "my draft" };
    const latest = { ...response, supportCase: { ...baseline, internalMemo: "other admin", revision: 5, updatedAt: "2026-10-23T03:00:00.000Z" } };
    expect(reconcileLatestSupportCase(response, draft, latest)).toEqual({ kind: "conflict", latest });
  });

  it("adopts a newer revision only when the local draft is clean", () => {
    const response = { supportCase: baseline, writeCapability: { writable: true as const, reason: null } };
    const latest = { ...response, supportCase: { ...baseline, internalMemo: "other admin", revision: 5, updatedAt: "2026-10-23T03:00:00.000Z" } };
    expect(reconcileLatestSupportCase(response, supportCaseDraft(baseline), latest)).toEqual({ kind: "adopt", baseline: latest, draft: supportCaseDraft(latest.supportCase) });
  });

  it("compares User projection changes at the same revision without discarding a draft", () => {
    const response = { supportCase: baseline, writeCapability: { writable: true as const, reason: null } };
    for (const assignedAdmin of [
      { ...baseline.assignedAdmin, displayName: "変更後の表示名" },
      { status: "UNAVAILABLE" as const },
    ]) {
      const latest = { ...response, supportCase: { ...baseline, assignedAdmin } };
      const dirty = { ...supportCaseDraft(baseline), memo: "保存前の入力" };
      expect(reconcileLatestSupportCase(response, dirty, latest)).toEqual({ kind: "conflict", latest });
      expect(reconcileLatestSupportCase(response, supportCaseDraft(baseline), latest)).toEqual({ kind: "adopt", baseline: latest, draft: supportCaseDraft(latest.supportCase) });
    }
  });

  it("rejects inconsistent stored contents at the same revision", () => {
    const response = { supportCase: baseline, writeCapability: { writable: true as const, reason: null } };
    const latest = { ...response, supportCase: { ...baseline, internalMemo: "版が変わらない不整合な本文" } };
    expect(reconcileLatestSupportCase(response, supportCaseDraft(baseline), latest)).toEqual({ kind: "unknown" });
  });
});
