import "server-only";
import type { HostActor, ProductOperatorAssignment } from "@niho-experience/experience-store";
import { config } from "@/lib/config";
import { nihoIdOrNull, selectProvider, toProviderChoice, type HostConsoleChoice, type HostProvider, type HostProviderRole } from "@/lib/host/providers";
import { HOST_BOOKINGS_PATH, HOST_CALENDAR_PATH, HOST_SETTINGS_PATH } from "@/lib/host/routes";
import { loadHostProviders, noStoreJson, readHostSession } from "@/lib/host/server";
import { accessTokenUsable } from "@/lib/host/session";
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
  if (!accessTokenUsable(session, Date.now())) return { response: noStoreJson({ error: "session_refresh_required" }, 401) };
  const providers = await loadHostProviders();
  if (providers.status === "rejected" || providers.status === "refresh" || providers.status === "signed-out") return { response: noStoreJson({ error: "unauthenticated" }, 401) };
  if (providers.status !== "ok") return { response: noStoreJson({ error: "identity_unavailable" }, 503) };
  const provider = providers.providers.find((entry) => entry.id === id);
  if (provider && (provider.memberRole === "OWNER" || provider.memberRole === "EDITOR" || provider.memberRole === "COHOST")) {
    const currentIdentity = providers.nihoUserId;
    if (!currentIdentity || provider.nihoUserId !== currentIdentity) return { response: noStoreJson({ error: "identity_unavailable" }, 503) };
    return {
      actor: { providerId: id, nihoUserId: currentIdentity, calendarRoleCeiling: provider.memberRole === "OWNER" ? "OWNER" : "EDITOR" },
      access: { kind: "MEMBER", nihoRole: provider.memberRole },
    };
  }
  const identity = providers.nihoUserId;
  if (!identity) return { response: noStoreJson({ error: "identity_unavailable" }, 503) };
  const repository = productOperatorRepository();
  const assignments = repository ? (await repository.listAssignments(identity)).filter((entry) => entry.providerId === id) : [];
  if (assignments.length) return { actor: { providerId: id, nihoUserId: identity, calendarScope: "OPERATOR" }, access: { kind: "OPERATOR", assignments } };
  return { response: noStoreJson({ error: repository ? "forbidden" : "calendar_not_configured" }, repository ? 403 : 503) };
}

export interface CalendarPageContext {
  readonly choices: readonly HostConsoleChoice[];
  readonly choice: HostConsoleChoice | null;
  readonly providerNotFound: boolean;
}

export async function resolveCalendarContext(query: Record<string, string | string[] | undefined>): Promise<CalendarPageContext | null> {
  const session = await readHostSession();
  if (!session || !accessTokenUsable(session, Date.now())) return null;
  const load = await loadHostProviders();
  if (load.status !== "ok") return null;
  const identity = load.nihoUserId;
  const repository = productOperatorRepository();
  const assignments = identity && repository ? await repository.listAssignments(identity) : [];
  const choices = calendarConsoleChoices(load.providers, assignments);
  const raw = typeof query.providerId === "string" ? query.providerId : null;
  const explicitRequested = nihoIdOrNull(raw);
  const productEntry = nihoIdOrNull(typeof query.experience === "string" ? query.experience : null);
  const ownerChoices = choices.filter((choice) => choice.kind === "MEMBER" && choice.memberRole === "OWNER");
  // Product creation is OWNER-only. When the editor sends a product, select the one exact current
  // OWNER workspace instead of falling back to an unrelated editor/operator workspace.
  if (raw === null && productEntry && ownerChoices.length !== 1) {
    return { choices, choice: null, providerNotFound: true };
  }
  const requested = raw === null && productEntry ? ownerChoices[0]!.id : explicitRequested;
  const selected = selectProvider(choices, requested);
  return { choices, choice: selected.provider, providerNotFound: raw !== null && (!explicitRequested || selected.requestedMissing) };
}

/** The page selector and HostShell must use the same product authority projection. */
export function calendarConsoleChoices(providers: readonly HostProvider[], assignments: readonly ProductOperatorAssignment[]): readonly HostConsoleChoice[] {
  const assignedIds = new Set(assignments.map((item) => item.providerId));
  const members = providers.filter((provider) => provider.memberRole === "OWNER" || provider.memberRole === "EDITOR" || !assignedIds.has(provider.id)).map(toProviderChoice);
  const memberIds = new Set(members.map((choice) => choice.id));
  // カレンダー, 予約 for the OTA bookings of their products while they are shown (#194 PR B), and 設定 for the operator's own
  // email address while this site emails hosts (#194).
  const screens = [HOST_CALENDAR_PATH, ...(config.otaGuestDetailsEnabled ? [HOST_BOOKINGS_PATH] : []), ...(config.hostMailEnabled ? [HOST_SETTINGS_PATH] : [])];
  const operators: HostConsoleChoice[] = [...new Map(assignments.filter((item) => !memberIds.has(item.providerId)).map((item) => [item.providerId, {
    kind: "OPERATOR" as const, id: item.providerId, displayName: item.sellerDisplayName, memberRole: null, screens,
  }])).values()];
  return [...members, ...operators];
}
