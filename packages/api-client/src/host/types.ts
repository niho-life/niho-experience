import type { components } from "../generated/host-openapi.ts";

export type ExperienceHostIdentity = components["schemas"]["ExperienceHostIdentityResponse"];
export type ExperienceHostLegacyConnectAccount = components["schemas"]["ExperienceHostLegacyConnectAccountResponse"];
export type ExperienceHostPaymentReuseConsent = components["schemas"]["ExperienceHostPaymentReuseConsent"];
export type ExperienceHostPaymentReadinessReason = components["schemas"]["ExperienceProviderPaymentReadinessReason"];
export type ExperienceHostBookingListResponse = components["schemas"]["ExperienceHostBookingBookingListResponse"];
export type ExperienceHostBookingDetailResponse = components["schemas"]["ExperienceHostBookingBookingDetailResponse"];
export type ExperienceHostBookingStatusResponse = components["schemas"]["ExperienceHostBookingBookingStatusResponse"];
export type ExperienceHostBookingCancelInput = components["schemas"]["ExperienceHostBookingCancelBookingInput"];
export type ExperienceHostBookingCancelResponse = components["schemas"]["ExperienceHostBookingCancelBookingResponse"];
export type ExperienceHostBookingMessageInput = components["schemas"]["ExperienceHostBookingMessageInput"];
export type ExperienceHostBookingMessageResponse = components["schemas"]["ExperienceHostBookingMessageResponse"];
export type ExperienceHostBookingKnownStatus = components["schemas"]["ExperienceHostBookingKnownBookingStatus"];

export type ExperienceHostBookingListQuery = {
  readonly cursor?: string;
  readonly pageId?: string;
  readonly fromDate?: string;
  readonly toDate?: string;
  readonly status?: ExperienceHostBookingKnownStatus;
};

export type ExperienceHostApiResult<T> = { readonly ok: true; readonly data: T } | ExperienceHostApiFailure;
export type ExperienceHostApiFailure =
  | { readonly ok: false; readonly kind: "invalid_request" }
  | { readonly ok: false; readonly kind: "network_error" }
  | { readonly ok: false; readonly kind: "unexpected_response"; readonly status: number }
  | { readonly ok: false; readonly kind: "error"; readonly status: number };
