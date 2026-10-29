import { guideApiError } from "@/lib/editor/guide-api-server";
import { hostInvitation } from "@/lib/experience/guide-link-invitations";
import { loadHostGuideLinkContext } from "@/lib/host/guide-link-api-server";
import { noStoreJson } from "@/lib/host/server";

type Context = { params: Promise<{ providerId: string }> };

export async function GET(request: Request, context: Context) {
  const loaded = await loadHostGuideLinkContext();
  if (!loaded.ok) return loaded.response;
  if (new URL(request.url).search) return noStoreJson({ error: "invalid_input" }, 400);
  const { providerId } = await context.params;
  try {
    const invitations = await loaded.value.repository.listProviderLinkInvitations(loaded.value.actor, providerId);
    return noStoreJson({ invitations: invitations.map(hostInvitation) });
  } catch (error) {
    return guideApiError(error);
  }
}
