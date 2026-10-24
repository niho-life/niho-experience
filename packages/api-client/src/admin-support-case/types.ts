import type { components } from "../generated/admin-support-case-openapi.ts";

type Schemas = components["schemas"];

export type ExperienceAdminSupportAdmin = Schemas["ExperienceAdminSupportAdmin"];
export type ExperienceAdminSupportAdminListResponse = Schemas["ExperienceAdminSupportAdminListResponse"];
export type ExperienceAdminSupportCase = Schemas["ExperienceAdminSupportCase"];
export type ExperienceAdminSupportCaseAssignment = Schemas["ExperienceAdminSupportCaseAssignment"];
export type ExperienceAdminSupportCasePatchRequest = Schemas["ExperienceAdminSupportCasePatchRequest"];
export type ExperienceAdminSupportCasePatchResponse = Schemas["ExperienceAdminSupportCasePatchResponse"];
export type ExperienceAdminSupportCaseReadResponse = Schemas["ExperienceAdminSupportCaseReadResponse"];
export type ExperienceAdminSupportCaseWriteCapability = Schemas["ExperienceAdminSupportCaseWriteCapability"];

export type ExperienceAdminSupportCaseWriteReason = Exclude<ExperienceAdminSupportCaseWriteCapability["reason"], null>;
export type ExperienceAdminSupportCaseConflictReason = "REVISION_CONFLICT" | "ASSIGNED_ADMIN_UNAVAILABLE" | ExperienceAdminSupportCaseWriteReason;
