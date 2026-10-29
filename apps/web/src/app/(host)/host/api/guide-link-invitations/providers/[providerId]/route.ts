import { hostInvitation, writerIdentifier } from "@/lib/experience/guide-link-invitations";
import { loadHostGuideLinkContext } from "@/lib/host/guide-link-api-server";
import { mutationFromSameOrigin } from "@/lib/host/relay";
import { resolveGuideWriter } from "@/lib/host/guide-writer-resolver";
import { noStoreJson, siteOrigin } from "@/lib/host/server";
import { readBoundedJson } from "@/lib/read-bounded-json";
import { guideApiError } from "@/lib/editor/guide-api-server";

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

export async function POST(request: Request, context: Context) {
  const loaded = await loadHostGuideLinkContext();
  if (!loaded.ok) return loaded.response;
  if (!mutationFromSameOrigin("POST", request.headers, siteOrigin())) {
    return noStoreJson({ error: "cross_site_request" }, 403);
  }
  if (new URL(request.url).search || request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    return noStoreJson({ error: "invalid_input" }, 400);
  }
  let raw: unknown;
  try {
    raw = await readBoundedJson(request, 4096, { fatalUtf8: true });
  } catch {
    return noStoreJson({ error: "invalid_input" }, 400);
  }
  const identifier = writerIdentifier(raw);
  if (!identifier) return noStoreJson({ error: "invalid_input" }, 400);
  const { providerId } = await context.params;
  try {
    // Check current OWNER before looking up an account on NIHO; Store repeats the check when writing.
    await loaded.value.repository.listProviderLinkInvitations(loaded.value.actor, providerId);
    const writer = await resolveGuideWriter(loaded.value.session, identifier);
    if (writer.status === "not_found") return noStoreJson({ error: "not_found" }, 404);
    if (writer.status === "unavailable") return noStoreJson({ error: "unavailable" }, 503);
    if (writer.status === "rate_limited") {
      const response = noStoreJson({ error: "rate_limited" }, 429);
      if (writer.retryAfterSeconds !== null) response.headers.set("retry-after", String(writer.retryAfterSeconds));
      return response;
    }
    if (writer.status !== "ok") return noStoreJson({ error: "unavailable" }, 503);
    const invitation = await loaded.value.repository.inviteProductLinkWriter(loaded.value.actor, providerId, writer.writerNihoUserId);
    return noStoreJson({ invitation: hostInvitation(invitation) });
  } catch (error) {
    return guideApiError(error);
  }
}
