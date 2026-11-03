import { hostArticleLinkFailure, loadHostGuideLinkContext } from "@/lib/host/guide-link-api-server";
import { mutationFromSameOrigin } from "@/lib/host/relay";
import { noStoreJson, siteOrigin } from "@/lib/host/server";
import { readBoundedJson } from "@/lib/read-bounded-json";
type Context = { params: Promise<{ providerId: string; invitationId: string }> };
export async function POST(request: Request, context: Context) {
  const loaded = await loadHostGuideLinkContext(); if (!loaded.ok) return loaded.response;
  if (!mutationFromSameOrigin("POST", request.headers, siteOrigin())) return noStoreJson({ error: "cross_site_request" }, 403);
  try {
    const body = await readBoundedJson(request, 16, { fatalUtf8: true });
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 0) return noStoreJson({ error: "invalid_input" }, 400);
    const { providerId, invitationId } = await context.params; await loaded.value.client.revoke(providerId, invitationId);
    return noStoreJson({ state: "REVOKED" });
  } catch (error) { return hostArticleLinkFailure(error); }
}
