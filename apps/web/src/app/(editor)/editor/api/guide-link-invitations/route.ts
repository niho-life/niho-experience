import { guideApiError, guideApiJson, loadGuideApiContext } from "@/lib/editor/guide-api-server";
import { writerInvitation } from "@/lib/experience/guide-link-invitations";

export async function GET(request: Request) {
  const context = await loadGuideApiContext();
  if (!context.ok) return context.response;
  if (new URL(request.url).search) return guideApiJson({ error: "invalid_input" }, 400);
  try {
    const invitations = await context.value.repository.listOwnPendingLinkInvitations(context.value.actor);
    return guideApiJson({ invitations: invitations.map(writerInvitation) });
  } catch (error) {
    return guideApiError(error);
  }
}
