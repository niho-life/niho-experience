import type { components } from "../generated/experience-provider-operations-openapi.ts";

type Schemas = components["schemas"];

export type ExperienceProviderOperationRole = Schemas["ProviderRole"];
export type ExperienceProviderOperationalRole = Schemas["OperationalProviderRole"];
export type ExperienceProviderMember = Schemas["Member"];
export type ExperienceProviderMemberListResponse = Schemas["MemberListResponse"];
export type ExperienceProviderResolveMemberInput = Schemas["ResolveMemberInput"];
export type ExperienceProviderResolveMemberResponse = Schemas["ResolveMemberResponse"];
export type ExperienceProviderPutMemberInput = Schemas["PutMemberInput"];
export type ExperienceProviderMemberResponse = Schemas["MemberResponse"];

export type ExperienceProviderOperationsFailure =
  | { ok: false; kind: "invalid_request" }
  | { ok: false; kind: "rejected"; status: 401 | 403 }
  | { ok: false; kind: "not_found" }
  | { ok: false; kind: "conflict" }
  | { ok: false; kind: "network_error" }
  | { ok: false; kind: "unexpected_response"; status: number };

export type ExperienceProviderOperationsResult<T> = { ok: true; data: T } | ExperienceProviderOperationsFailure;

export const EXPERIENCE_PROVIDER_OPERATION_ROLES = ["OWNER", "EDITOR", "COHOST"] as const satisfies readonly ExperienceProviderOperationRole[];
export const EXPERIENCE_PROVIDER_OPERATIONAL_ROLES = ["OWNER", "COHOST"] as const satisfies readonly ExperienceProviderOperationalRole[];
