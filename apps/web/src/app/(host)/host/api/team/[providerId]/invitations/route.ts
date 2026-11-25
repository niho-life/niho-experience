import { parseTeamInvitationRequest } from "@/lib/host/team-contract";
import { nativeInvitationsClosed, nativeTeamFailure, nativeTeamMutationAllowed, openNativeInvitations, requestJson } from "@/lib/host/team-server";
import { noStoreJson } from "@/lib/host/server";

type Context = { params: Promise<{ providerId: string }> };

/** The shape the owner's screen reads (team-contract.ts parseTeamInvitation). The link's token is never part of it. */
function view(item: { readonly invitationId: string; readonly email: string; readonly createdAtUtc: string; readonly expiresAtUtc: string; readonly state: string }) {
  return { id: item.invitationId, email: item.email, createdAt: item.createdAtUtc, expiresAt: item.expiresAtUtc, state: item.state };
}

export async function GET(request: Request, context: Context) {
  const closed = nativeInvitationsClosed();
  if (closed) return closed;
  if (new URL(request.url).search) return noStoreJson({ error: "invalid_request" }, 400);
  const opened = await openNativeInvitations((await context.params).providerId);
  if ("response" in opened) return opened.response;
  try {
    const invitations = await opened.invitations.list({ providerId: opened.providerId, hostAccountId: opened.hostAccountId, nowUtc: new Date().toISOString() });
    return noStoreJson({ contractVersion: 1, invitations: invitations.map(view) });
  } catch (error) {
    return nativeTeamFailure(error);
  }
}

export async function POST(request: Request, context: Context) {
  const closed = nativeInvitationsClosed();
  if (closed) return closed;
  if (!nativeTeamMutationAllowed(request)) return noStoreJson({ error: "forbidden" }, 403);
  if (new URL(request.url).search) return noStoreJson({ error: "invalid_request" }, 400);
  const parsed = await requestJson(request, 1024);
  if (!parsed.ok) return noStoreJson({ error: parsed.reason === "too_large" ? "payload_too_large" : "invalid_request" }, parsed.reason === "too_large" ? 413 : 400);
  const input = parseTeamInvitationRequest(parsed.value);
  if (!input) return noStoreJson({ error: "invalid_request" }, 400);
  const opened = await openNativeInvitations((await context.params).providerId);
  if ("response" in opened) return opened.response;
  try {
    const actor = { providerId: opened.providerId, hostAccountId: opened.hostAccountId };
    const now = new Date().toISOString();
    const created = await opened.invitations.create({ ...actor, email: input.email, nowUtc: now });
    if (created.kind === "already-member") return noStoreJson({ error: "already_member" }, 409);
    if (created.kind === "too-many-open") return noStoreJson({ error: "too_many_open" }, 409);
    // The row as the screen lists it (the address as stored, its state).
    const listed = (await opened.invitations.list({ ...actor, nowUtc: now })).find((item) => item.invitationId === created.invitationId);
    if (!listed) return noStoreJson({ error: "team_unavailable" }, 503);
    return noStoreJson({ kind: "created", invitation: view(listed) }, 201);
  } catch (error) {
    return nativeTeamFailure(error);
  }
}
