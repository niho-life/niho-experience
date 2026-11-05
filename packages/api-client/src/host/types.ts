import type { components } from "../generated/host-openapi.ts";

export type ExperienceHostIdentity = components["schemas"]["ExperienceHostIdentityResponse"];
export type ExperienceHostLegacyConnectAccount = components["schemas"]["ExperienceHostLegacyConnectAccountResponse"];
export type ExperienceHostPaymentReuseConsent = components["schemas"]["ExperienceHostPaymentReuseConsent"];
export type ExperienceHostPaymentReadinessReason = components["schemas"]["ExperienceProviderPaymentReadinessReason"];

export type ExperienceHostApiResult<T> = { readonly ok: true; readonly data: T } | ExperienceHostApiFailure;
export type ExperienceHostApiFailure =
  | { readonly ok: false; readonly kind: "invalid_request" }
  | { readonly ok: false; readonly kind: "network_error" }
  | { readonly ok: false; readonly kind: "unexpected_response"; readonly status: number }
  | { readonly ok: false; readonly kind: "error"; readonly status: number };
