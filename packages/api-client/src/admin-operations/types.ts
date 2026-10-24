import type { components } from "../generated/admin-operations-openapi.ts";

type Schemas = components["schemas"];

export type ExperienceAdminApproveRequest = Schemas["ExperienceAdminApproveRequest"];
export type ExperienceAdminCancelRequest = Schemas["ExperienceAdminCancelRequest"];
export type ExperienceAdminDeclineRequest = Schemas["ExperienceAdminDeclineRequest"];
export type ExperienceAdminMessageRequest = Schemas["ExperienceAdminMessageRequest"];
export type ExperienceAdminOperationRequest = ExperienceAdminApproveRequest | ExperienceAdminCancelRequest | ExperienceAdminDeclineRequest | ExperienceAdminMessageRequest;
export type ExperienceAdminOperationAction = Schemas["ExperienceAdminSupportOperation"]["action"];
export type ExperienceAdminSupportOperation = Schemas["ExperienceAdminSupportOperation"];
export type ExperienceAdminSupportOperationBookingSnapshot = Schemas["ExperienceAdminSupportOperationBookingSnapshot"];
export type ExperienceAdminSupportOperationDetailResponse = Schemas["ExperienceAdminSupportOperationDetailResponse"];
export type ExperienceAdminSupportOperationSnapshotResponse = Schemas["ExperienceAdminSupportOperationSnapshotResponse"];
export type ExperienceAdminSupportOperationMessage = Schemas["ExperienceAdminSupportOperationMessage"];
export type ExperienceAdminSupportOperationError = Schemas["ExperienceAdminSupportOperationError"];
