import type {
  ExperienceAdminSupportCase,
  ExperienceAdminSupportCaseAssignment,
  ExperienceAdminSupportCasePatchRequest,
  ExperienceAdminSupportCaseReadResponse,
} from "@niho-experience/api-client/admin-support-case";

export type AdminSupportCaseDraftAssignment =
  | { kind: "active"; id: string }
  | { kind: "unassigned" }
  | { kind: "unavailable" };

export interface AdminSupportCaseDraft {
  assignment: AdminSupportCaseDraftAssignment;
  memo: string;
}

export function supportCaseDraftAssignment(assignment: ExperienceAdminSupportCaseAssignment): AdminSupportCaseDraftAssignment {
  if (assignment.status === "ACTIVE") return { kind: "active", id: assignment.id };
  return assignment.status === "UNASSIGNED" ? { kind: "unassigned" } : { kind: "unavailable" };
}

export function supportCaseDraft(value: ExperienceAdminSupportCase): AdminSupportCaseDraft {
  return { assignment: supportCaseDraftAssignment(value.assignedAdmin), memo: value.internalMemo ?? "" };
}

export function normalizeSupportCaseMemo(value: string): string | null {
  const normalized = value.replace(/\r\n?/g, "\n").trim();
  return normalized || null;
}

export function sameDraftAssignment(left: AdminSupportCaseDraftAssignment, right: AdminSupportCaseDraftAssignment): boolean {
  return left.kind === right.kind && (left.kind !== "active" || (right.kind === "active" && left.id === right.id));
}

export function buildSupportCasePatch(baseline: ExperienceAdminSupportCase, draft: AdminSupportCaseDraft): ExperienceAdminSupportCasePatchRequest | null {
  const patch: ExperienceAdminSupportCasePatchRequest = { expectedRevision: baseline.revision };
  const baselineAssignment = supportCaseDraftAssignment(baseline.assignedAdmin);
  if (!sameDraftAssignment(baselineAssignment, draft.assignment)) {
    if (draft.assignment.kind === "unavailable") return null;
    patch.assignedAdminUserId = draft.assignment.kind === "active" ? draft.assignment.id : null;
  }
  if (draft.memo !== (baseline.internalMemo ?? "")) {
    const memo = normalizeSupportCaseMemo(draft.memo);
    if (memo !== baseline.internalMemo) patch.internalMemo = memo;
  }
  return Object.keys(patch).length > 1 ? patch : null;
}

/** An explicit conflict choice carries local edits; untouched fields follow the latest save. */
export function draftAfterConflictChoice(baseline: ExperienceAdminSupportCase, draft: AdminSupportCaseDraft, latest: ExperienceAdminSupportCase): AdminSupportCaseDraft {
  const changed = buildSupportCasePatch(baseline, draft);
  return {
    assignment: changed && Object.hasOwn(changed, "assignedAdminUserId") ? draft.assignment : supportCaseDraftAssignment(latest.assignedAdmin),
    memo: changed && Object.hasOwn(changed, "internalMemo") ? draft.memo : latest.internalMemo ?? "",
  };
}

/** Apply a confirmed PATCH DTO without overwriting fields edited after that PATCH started. */
export function draftAfterConfirmedPatch(current: AdminSupportCaseDraft, submitted: AdminSupportCaseDraft, saved: ExperienceAdminSupportCase): AdminSupportCaseDraft {
  return {
    assignment: sameDraftAssignment(current.assignment, submitted.assignment) ? supportCaseDraftAssignment(saved.assignedAdmin) : current.assignment,
    memo: current.memo === submitted.memo ? saved.internalMemo ?? "" : current.memo,
  };
}

function sameServerAssignment(left: ExperienceAdminSupportCaseAssignment, right: ExperienceAdminSupportCaseAssignment): boolean {
  if (left.status !== right.status) return false;
  return left.status !== "ACTIVE" || (right.status === "ACTIVE" && left.id === right.id && left.displayName === right.displayName);
}

function sameStoredCaseContents(left: ExperienceAdminSupportCase, right: ExperienceAdminSupportCase): boolean {
  return left.bookingRequestId === right.bookingRequestId
    && left.internalMemo === right.internalMemo
    && left.revision === right.revision
    && left.createdAt === right.createdAt
    && left.updatedAt === right.updatedAt;
}

export type LatestCaseReconciliation =
  | { kind: "confirmed"; baseline: ExperienceAdminSupportCaseReadResponse; draft: AdminSupportCaseDraft }
  | { kind: "adopt"; baseline: ExperienceAdminSupportCaseReadResponse; draft: AdminSupportCaseDraft }
  | { kind: "conflict"; latest: ExperienceAdminSupportCaseReadResponse }
  | { kind: "unknown" };

/**
 * A GET is observation, not consent. It may refresh capability at the same exact revision,
 * or adopt a newer revision only when no local draft exists. Otherwise comparison is explicit.
 */
export function reconcileLatestSupportCase(
  baseline: ExperienceAdminSupportCaseReadResponse,
  draft: AdminSupportCaseDraft,
  latest: ExperienceAdminSupportCaseReadResponse,
): LatestCaseReconciliation {
  const baselineCase = baseline.supportCase;
  const latestCase = latest.supportCase;
  if (latestCase.revision < baselineCase.revision) return { kind: "unknown" };
  if (latestCase.revision === baselineCase.revision) {
    if (!sameStoredCaseContents(latestCase, baselineCase)) return { kind: "unknown" };
    if (sameServerAssignment(latestCase.assignedAdmin, baselineCase.assignedAdmin)) {
      return { kind: "confirmed", baseline: latest, draft };
    }
    // Names and current ADMIN eligibility are User projections, not case fields:
    // they can change without advancing the case revision. Keep local edits behind
    // the explicit comparison rather than trapping the editor in repeated retries.
    return buildSupportCasePatch(baselineCase, draft)
      ? { kind: "conflict", latest }
      : { kind: "adopt", baseline: latest, draft: supportCaseDraft(latestCase) };
  }
  return buildSupportCasePatch(baselineCase, draft)
    ? { kind: "conflict", latest }
    : { kind: "adopt", baseline: latest, draft: supportCaseDraft(latestCase) };
}

export function supportCaseWriteReasonLabel(reason: string): string {
  switch (reason) {
    case "WRITES_DISABLED": return "NIHO側で編集機能がまだ有効になっていません。";
    case "SUPPORT_OFF": return "受付時にサポートOFFだった予約のため閲覧専用です。";
    case "SUPPORT_LEGACY": return "支援条件が記録されていない旧予約のため閲覧専用です。";
    case "SUPPORT_INVALID": return "受付時の支援条件を確認できないため閲覧専用です。";
    case "PII_RETENTION_EXPIRED": return "取引情報の保持期間を過ぎたため閲覧専用です。";
    default: return "現在は編集できません。";
  }
}
