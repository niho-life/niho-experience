import type { GuideLinkInvitation } from "@niho-experience/experience-store";

export function invitationGeneration(value: unknown): number | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (Object.keys(body).length !== 1 || !Number.isSafeInteger(body.generation) || (body.generation as number) < 1) return null;
  return body.generation as number;
}

export function writerInvitation(invitation: GuideLinkInvitation) {
  return {
    id: invitation.id,
    providerId: invitation.providerId,
    state: invitation.state,
    generation: invitation.generation,
    invitedAtUtc: invitation.invitedAtUtc,
    ...(invitation.acceptedAtUtc ? { acceptedAtUtc: invitation.acceptedAtUtc } : {}),
    ...(invitation.declinedAtUtc ? { declinedAtUtc: invitation.declinedAtUtc } : {}),
  };
}

export function hostInvitation(invitation: GuideLinkInvitation) {
  return {
    id: invitation.id,
    state: invitation.state,
    generation: invitation.generation,
    invitedAtUtc: invitation.invitedAtUtc,
    ...(invitation.acceptedAtUtc ? { acceptedAtUtc: invitation.acceptedAtUtc } : {}),
    ...(invitation.declinedAtUtc ? { declinedAtUtc: invitation.declinedAtUtc } : {}),
    ...(invitation.revokedAtUtc ? { revokedAtUtc: invitation.revokedAtUtc } : {}),
  };
}
