import type { components } from "../generated/experience-preparations-openapi.ts";

type Schemas = components["schemas"];

export type ExperiencePreparationStatus = Schemas["Status"];
export type ExperiencePreparationRole = Schemas["AssignmentRole"];
export type ExperiencePreparationAccess = Schemas["Access"];
export type ExperiencePreparationTarget = Schemas["Target"];
export type ExperiencePreparationDraft = Schemas["Draft"];
export type ExperiencePreparationCohostPatchInput = Schemas["CohostPatchInput"];
export type ExperiencePreparationProposal = Schemas["Proposal"];
export type ExperiencePreparationReview = Schemas["ReviewResponse"];
export type ExperiencePreparationHostCase = Schemas["HostCase"];
export type ExperiencePreparationAdminCase = Schemas["AdminCase"];
export type ExperiencePreparationAdminCaseDetail = Schemas["AdminCaseDetailResponse"];
export type ExperiencePreparationAdminCaseListItem = Schemas["AdminCaseListItem"];
export type ExperiencePreparationAcceptanceInput = Schemas["AcceptanceInput"];
export type ExperiencePreparationAcceptance = Schemas["Acceptance"];
export type ExperiencePreparationMyAcceptance = Schemas["MyAcceptance"];
export type ExperiencePreparationReadiness = Schemas["Readiness"];
export type ExperiencePreparationLockedAcceptanceInput = Schemas["LockedAcceptanceInput"];
export type ExperiencePreparationPreviewToken = Schemas["PreviewTokenResponse"];
export type ExperiencePreparationUploadPolicyInput = Schemas["UploadPolicyInput"];
export type ExperiencePreparationUploadPolicy = Schemas["UploadPolicyResponse"];
export type ExperiencePreparationAssignment = Schemas["Assignment"];
export type ExperiencePreparationUserLabel = Schemas["UserLabel"];
export type ExperiencePreparationImage = Schemas["Image"];
export type ExperiencePreparationCorrectionCreated = Schemas["CorrectionCreated"];
export type ExperiencePreparationMaterializeResult = Schemas["MaterializeResult"];

export type ExperiencePreparationCaseListResponse = { cases: ExperiencePreparationAdminCaseListItem[] };
export type ExperiencePreparationHostCaseListResponse = { cases: ExperiencePreparationHostCase[] };
export type ExperiencePreparationAdminCaseResponse = { case: ExperiencePreparationAdminCase };
export type ExperiencePreparationHostCaseResponse = { case: ExperiencePreparationHostCase };
export type ExperiencePreparationAcceptanceResponse = { acceptance: ExperiencePreparationMyAcceptance };
export type ExperiencePreparationReadinessResponse = { readiness: ExperiencePreparationReadiness };
export type ExperiencePreparationCorrectionResponse = { request: ExperiencePreparationCorrectionCreated };
export type ExperiencePreparationAssignmentCandidatesResponse = { candidates: ExperiencePreparationUserLabel[] };
export type ExperiencePreparationAssignmentResponse = { assignment: ExperiencePreparationAssignment };
export type ExperiencePreparationMaterializeResponse = { materialized: ExperiencePreparationMaterializeResult };
export type ExperiencePreparationCancelledResponse = { cancelled: true; materialized: boolean };
export type ExperiencePreparationRevokedResponse = { revoked: true };

export type ExperiencePreparationFailure =
  | { ok: false; kind: "invalid_request" }
  | { ok: false; kind: "rejected"; status: 401 | 403 }
  | { ok: false; kind: "not_found" }
  | { ok: false; kind: "conflict"; reason: string | null }
  | { ok: false; kind: "unprocessable"; reason: string | null }
  | { ok: false; kind: "network_error" }
  | { ok: false; kind: "unexpected_response"; status: number };

export type ExperiencePreparationResult<T> = { ok: true; data: T } | ExperiencePreparationFailure;
