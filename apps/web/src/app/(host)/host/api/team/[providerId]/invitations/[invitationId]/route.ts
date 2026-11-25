import { nativeInvitationsClosed, nativeTeamFailure, nativeTeamMutationAllowed, openNativeInvitations } from "@/lib/host/team-server";
import { noStoreJson } from "@/lib/host/server";

type Context = { params: Promise<{ providerId: string; invitationId: string }> };

/** The OWNER takes an open invitation back: 204, or 404 when it is not open (already used, taken back or run out). */
export async function DELETE(request: Request, context: Context) {
  const closed = nativeInvitationsClosed();
  if (closed) return closed;
  if (!nativeTeamMutationAllowed(request)) return noStoreJson({ error: "forbidden" }, 403);
  if (new URL(request.url).search) return noStoreJson({ error: "invalid_request" }, 400);
  const { providerId, invitationId } = await context.params;
  const opened = await openNativeInvitations(providerId);
  if ("response" in opened) return opened.response;
  try {
    const revoked = await opened.invitations.revoke({ providerId: opened.providerId, hostAccountId: opened.hostAccountId, invitationId, nowUtc: new Date().toISOString() });
    return revoked ? new Response(null, { status: 204, headers: { "cache-control": "private, no-store" } }) : noStoreJson({ error: "not_found" }, 404);
  } catch (error) {
    return nativeTeamFailure(error);
  }
}
