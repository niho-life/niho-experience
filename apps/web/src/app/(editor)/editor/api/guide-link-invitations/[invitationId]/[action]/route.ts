import { guideApiError, guideApiJson, guideApiMutationAllowed, loadGuideApiContext, readGuideApiJson } from "@/lib/editor/guide-api-server";
import { invitationGeneration, writerInvitation } from "@/lib/experience/guide-link-invitations";

type Context = { params: Promise<{ invitationId: string; action: string }> };

export async function POST(request: Request, context: Context) {
  const loaded = await loadGuideApiContext();
  if (!loaded.ok) return loaded.response;
  if (!guideApiMutationAllowed(request)) return guideApiJson({ error: "cross_site_request" }, 403);
  const { invitationId, action } = await context.params;
  if (action !== "accept" && action !== "decline") return guideApiJson({ error: "not_found" }, 404);
  const raw = await readGuideApiJson(request);
  const generation = raw.ok ? invitationGeneration(raw.value) : null;
  if (generation === null) return guideApiJson({ error: "invalid_input" }, 400);
  try {
    const invitation = action === "accept"
      ? await loaded.value.repository.acceptLinkInvitation(loaded.value.actor, invitationId, generation)
      : await loaded.value.repository.declineLinkInvitation(loaded.value.actor, invitationId, generation);
    return guideApiJson({ invitation: writerInvitation(invitation) });
  } catch (error) {
    return guideApiError(error);
  }
}
