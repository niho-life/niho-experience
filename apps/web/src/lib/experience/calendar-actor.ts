import "server-only";
import type { HostActor, ProductOperatorAssignment } from "@niho-experience/experience-store";
import { nihoIdOrNull, selectProvider, toProviderChoice, type HostConsoleChoice, type HostProvider, type HostProviderRole } from "@/lib/host/providers";
import { loadHostProviders, noStoreJson, readHostSession } from "@/lib/host/server";
import { idTokenUsable } from "@/lib/host/session";
import { productOperatorRepository } from "./store-server";

export type CalendarActorResult =
  | { actor: HostActor; access: { kind: "MEMBER"; nihoRole: HostProviderRole | null } | { kind: "OPERATOR"; assignments: readonly ProductOperatorAssignment[] } }
  | { response: Response };

/** Fresh NIHO identity is mandatory; Experience grants only add product calendar scope. */
export async function calendarActor(providerId: unknown): Promise<CalendarActorResult> {
  const id = nihoIdOrNull(providerId);
  if (!id) return { response: noStoreJson({ error: "invalid_provider" }, 400) };
  const session = await readHostSession();
  if (!session) return { response: noStoreJson({ error: "unauthenticated" }, 401) };
  if (!idTokenUsable(session, Date.now())) return { response: noStoreJson({ error: "session_refresh_required" }, 401) };
  const providers = await loadHostProviders();
  if (providers.status === "rejected" || providers.status === "refresh" || providers.status === "signed-out") return { response: noStoreJson({ error: "unauthenticated" }, 401) };
  if (providers.status !== "ok") return { response: noStoreJson({ error: "identity_unavailable" }, 503) };
  const provider = providers.providers.find((entry) => entry.id === id);
  const memberActor: HostActor = { providerId: id, nihoUserId: session.nihoUserId, calendarRoleCeiling: provider?.memberRole === "OWNER" ? "OWNER" : provider?.memberRole === "EDITOR" ? "EDITOR" : "VIEWER" };
  if (provider && (provider.memberRole === "OWNER" || provider.memberRole === "EDITOR")) return { actor: memberActor, access: { kind: "MEMBER", nihoRole: provider.memberRole } };
  const repository = productOperatorRepository();
  const assignments = repository ? (await repository.listAssignments(session.nihoUserId)).filter((entry) => entry.providerId === id) : [];
  if (assignments.length > 0) return { actor: { providerId: id, nihoUserId: session.nihoUserId, calendarScope: "OPERATOR" }, access: { kind: "OPERATOR", assignments } };
  if (provider) return { actor: memberActor, access: { kind: "MEMBER", nihoRole: provider.memberRole } };
  return { response: noStoreJson({ error: repository ? "forbidden" : "calendar_not_configured" }, repository ? 403 : 503) };
}

export interface CalendarPageContext {
  readonly choices: readonly HostConsoleChoice[];
  readonly choice: HostConsoleChoice | null;
  readonly providerNotFound: boolean;
}

export async function resolveCalendarContext(query: Record<string, string | string[] | undefined>): Promise<CalendarPageContext | null> {
  const session = await readHostSession();
  if (!session || !idTokenUsable(session, Date.now())) return null;
  const load = await loadHostProviders();
  if (load.status !== "ok") return null;
  const repository = productOperatorRepository();
  const assignments = repository ? await repository.listAssignments(session.nihoUserId) : [];
  const choices = calendarConsoleChoices(load.providers, assignments);
  const raw = typeof query.providerId === "string" ? query.providerId : null;
  const requested = nihoIdOrNull(raw);
  const selected = selectProvider(choices, requested);
  return { choices, choice: selected.provider, providerNotFound: raw !== null && (!requested || selected.requestedMissing) };
}

/** The page selector and HostShell must use the same product authority projection. */
export function calendarConsoleChoices(providers: readonly HostProvider[], assignments: readonly ProductOperatorAssignment[]): readonly HostConsoleChoice[] {
  const assignedIds = new Set(assignments.map((item) => item.providerId));
  const members = providers.filter((provider) => provider.memberRole === "OWNER" || provider.memberRole === "EDITOR" || !assignedIds.has(provider.id)).map(toProviderChoice);
  const memberIds = new Set(members.map((choice) => choice.id));
  const operators: HostConsoleChoice[] = [...new Map(assignments.filter((item) => !memberIds.has(item.providerId)).map((item) => [item.providerId, {
    kind: "OPERATOR" as const, id: item.providerId, displayName: item.sellerDisplayName, memberRole: null,
  }])).values()];
  return [...members, ...operators];
}
