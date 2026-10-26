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
export type ExperienceProviderKnownBookingStatus = Schemas["KnownBookingStatus"];
export type ExperienceProviderBookingListItem = Schemas["BookingListItem"];
export type ExperienceProviderBookingListResponse = Schemas["BookingListResponse"];
export type ExperienceProviderBookingDetail = Schemas["BookingDetail"];
export type ExperienceProviderBookingDetailResponse = Schemas["BookingDetailResponse"];
export type ExperienceProviderBookingStatusResponse = Schemas["BookingStatusResponse"];
export type ExperienceProviderCancelBookingInput = Schemas["CancelBookingInput"];
export type ExperienceProviderCancelBookingResponse = Schemas["CancelBookingResponse"];
export type ExperienceProviderMessageInput = Schemas["MessageInput"];
export type ExperienceProviderMessageResponse = Schemas["MessageResponse"];

export type ExperienceProviderBookingListQuery = {
  cursor?: string;
  pageId?: string;
  fromDate?: string;
  toDate?: string;
  status?: ExperienceProviderKnownBookingStatus;
};

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
export const EXPERIENCE_PROVIDER_BOOKING_STATUSES = ["PENDING", "PAYMENT_PENDING", "PROVISIONAL", "CONFIRMED", "DECLINED", "EXPIRED", "CANCELLED", "REFUND_NEEDED"] as const satisfies readonly ExperienceProviderKnownBookingStatus[];
