import { guideApiError, readGuideApiJson } from "@/lib/editor/guide-api-server";
import { invitationGeneration, hostInvitation } from "@/lib/experience/guide-link-invitations";
import { mutationFromSameOrigin } from "@/lib/host/relay";
import { loadHostGuideLinkContext } from "@/lib/host/guide-link-api-server";
import { noStoreJson, siteOrigin } from "@/lib/host/server";

type Context = { params: Promise<{ invitationId: string }> };

export async function POST(request: Request, context: Context) {
  const loaded = await loadHostGuideLinkContext();
  if (!loaded.ok) return loaded.response;
  if (!mutationFromSameOrigin("POST", request.headers, siteOrigin())) {
    return noStoreJson({ error: "cross_site_request" }, 403);
  }
  const raw = await readGuideApiJson(request);
  const generation = raw.ok ? invitationGeneration(raw.value) : null;
  if (generation === null) return noStoreJson({ error: "invalid_input" }, 400);
  const { invitationId } = await context.params;
  try {
    const invitation = await loaded.value.repository.revokeLinkInvitation(loaded.value.actor, invitationId, generation);
    return noStoreJson({ invitation: hostInvitation(invitation) });
  } catch (error) {
    return guideApiError(error);
  }
}
