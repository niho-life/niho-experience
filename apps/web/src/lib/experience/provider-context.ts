import "server-only";
import type { HostAccountMembership, HostActor } from "@niho-experience/experience-store";
import { noStoreJson } from "@/lib/host/server";
import { nihoIdOrNull } from "@/lib/host/providers";
import type { ExperienceHostSession } from "@/lib/host/session";
import { experiencePublicationRepository } from "./store-server";

/*
 * The one entry point that decides WHICH provider (ホスト) a host screen API acts for and WHETHER the signed-in
 * Experience host account may act for it (#703, epic #700). It reads membership only: no seller, no Stripe, no readiness
 * snapshot. What the sale needs on top (seller profile and 受取口座の readiness) is the SalesContext in
 * publication-host-boundary.ts, resolved only by the operations that need it.
 *
 * A providerId from the URL is a hint, never authority: it is checked against the account's active memberships on every
 * request, in the store.
 */

export type ProviderRole = HostAccountMembership["role"];

/** The provider and role a request acts as. `actor` is what the store checks again with its own membership lock. */
export interface HostProviderContext {
  readonly actor: HostActor;
  readonly role: ProviderRole;
  /** The host account's status as read here. */
  readonly accountActive: boolean;
}

export type ProviderContextResult =
  | { readonly ok: true; readonly value: HostProviderContext }
  | { readonly ok: false; readonly response: Response };

type MembershipReader = Pick<NonNullable<ReturnType<typeof experiencePublicationRepository>>, "listHostAccountMemberships">;

const error = (code: string, status: number) => noStoreJson({ error: { code } }, status);

/**
 * `roles` are the roles the operation needs. Today every host experience API needs OWNER (the store checks it again).
 *
 * - `requestedProviderId` given: the account must hold an active membership in that provider with one of `roles`
 *   (not a member, or another role: 403 FORBIDDEN).
 * - not given: the one provider the account is an active member of with one of `roles` (none: 403 FORBIDDEN; two or
 *   more: 409 PROVIDER_REQUIRED, the caller must say which).
 */
export async function resolveProviderContext(
  session: Pick<ExperienceHostSession, "hostAccountId">,
  requestedProviderId: string | null,
  roles: readonly ProviderRole[] = ["OWNER"],
  repository: MembershipReader | null = experiencePublicationRepository(),
): Promise<ProviderContextResult> {
  if (!repository) return { ok: false, response: error("READINESS_UNAVAILABLE", 502) };
  let memberships: readonly HostAccountMembership[];
  try {
    memberships = requestedProviderId === null
      ? await repository.listHostAccountMemberships(session.hostAccountId)
      : await repository.listHostAccountMemberships(session.hostAccountId, requestedProviderId);
  } catch { return { ok: false, response: error("READINESS_UNAVAILABLE", 502) }; }
  // A suspended account normally never gets here (its session ends: 401). If a suspension lands between the session read
  // and this one, refuse before anything else, so no other answer (409 included) depends on a suspended account.
  if (memberships.some((membership) => !membership.accountActive)) return { ok: false, response: error("FORBIDDEN", 403) };
  const eligible = memberships.filter((membership) => roles.includes(membership.role)
    && (requestedProviderId === null || membership.providerId === requestedProviderId));
  if (eligible.length === 0) return { ok: false, response: error("FORBIDDEN", 403) };
  if (eligible.length > 1) return { ok: false, response: error("PROVIDER_REQUIRED", 409) };
  const membership = eligible[0]!;
  return {
    ok: true,
    value: {
      actor: { providerId: membership.providerId, nihoUserId: session.hostAccountId },
      role: membership.role,
      accountActive: membership.accountActive,
    },
  };
}

export type RequestedProvider =
  | { readonly ok: true; readonly providerId: string | null }
  | { readonly ok: false; readonly response: Response };

/**
 * The `?providerId=` a request names, if any. The hint is the only query parameter these APIs accept: any other query
 * answers `unexpected` (the status each route has always used for a query it does not take), an id that is not an id
 * answers 422 INVALID_INPUT.
 */
export function requestedProviderId(request: Request, unexpected: { readonly code: string; readonly status: number }): RequestedProvider {
  const query = new URL(request.url).searchParams;
  if (query.size === 0) return { ok: true, providerId: null };
  const values = query.getAll("providerId");
  if (query.size !== 1 || values.length !== 1) return { ok: false, response: error(unexpected.code, unexpected.status) };
  const providerId = nihoIdOrNull(values[0]);
  return providerId === null ? { ok: false, response: error("INVALID_INPUT", 422) } : { ok: true, providerId };
}
