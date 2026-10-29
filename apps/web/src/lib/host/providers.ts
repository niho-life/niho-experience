import type { ExperienceProviderKind, ExperienceProviderMemberRole, ExperienceProviderReviewStatus, ExperienceProviderWithMemberRole } from "@niho-experience/api-client/host";

/**
 * Providers as NIHO's host API returns them. The shapes come from the host
 * contract (#87, `@niho-experience/api-client/host`); this file only holds the
 * console's rules for choosing and labelling them. Type-only import: client
 * components may use these helpers without pulling in the server-only client.
 */

/** NIHO ids are opaque url-safe tokens; same rule as offer ids in the api-client mock. */
export const NIHO_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function nihoIdOrNull(value: unknown): string | null {
  return typeof value === "string" && NIHO_ID_PATTERN.test(value) ? value : null;
}

/** A provider in the signed-in host's list (server side only: it carries NIHO's internal ids). */
export type HostProvider = ExperienceProviderWithMemberRole;
export type HostProviderRole = ExperienceProviderMemberRole;
export type HostProviderKind = ExperienceProviderKind;
export type HostProviderReviewStatus = ExperienceProviderReviewStatus;

/** What the sidebar's and the phone menu's provider switch (client components) receive: the id for `?providerId=`, the name and the role. */
export type HostProviderChoice = Pick<HostProvider, "id" | "displayName" | "memberRole">;
export type HostConsoleChoice =
  | (HostProviderChoice & { readonly kind: "MEMBER" })
  | { readonly kind: "OPERATOR"; readonly id: string; readonly displayName: string; readonly memberRole: null };

const ROLE_LABELS: Record<HostProviderRole, string> = { OWNER: "オーナー", EDITOR: "編集者", COHOST: "サブホスト" };

export function providerRoleLabel(role: HostProviderRole | null): string | null {
  return role ? ROLE_LABELS[role] : null;
}

/**
 * The providers the console can open. An id that cannot travel in
 * `?providerId=` or a blank name is left out rather than shown half-filled.
 */
export function usableProviders<T extends Pick<HostProvider, "id" | "displayName">>(providers: readonly T[]): T[] {
  return providers.filter((provider) => nihoIdOrNull(provider.id) !== null && provider.displayName.trim() !== "");
}

export function toProviderChoice({ id, displayName, memberRole }: HostProviderChoice): HostConsoleChoice {
  return { kind: "MEMBER", id, displayName: displayName.trim(), memberRole };
}

/** The provider to open: the one asked for if this account has it, else the first. */
export function selectProvider<T extends { id: string }>(providers: readonly T[], requestedId: string | null): { provider: T | null; requestedMissing: boolean } {
  const requested = requestedId ? providers.find((provider) => provider.id === requestedId) : undefined;
  return { provider: requested ?? providers[0] ?? null, requestedMissing: Boolean(requestedId) && !requested };
}
