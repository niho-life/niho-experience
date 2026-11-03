import { hostArticleLinkFailure, loadHostGuideLinkContext } from "@/lib/host/guide-link-api-server";
import { mutationFromSameOrigin } from "@/lib/host/relay";
import { noStoreJson, siteOrigin } from "@/lib/host/server";
import { readBoundedJson } from "@/lib/read-bounded-json";
type Context = { params: Promise<{ providerId: string }> };
export async function GET(request: Request, context: Context) {
  const loaded = await loadHostGuideLinkContext(); if (!loaded.ok) return loaded.response;
  if (new URL(request.url).search) return noStoreJson({ error: "invalid_input" }, 400);
  try { return noStoreJson({ items: await loaded.value.client.list((await context.params).providerId) }); } catch (error) { return hostArticleLinkFailure(error); }
}
export async function POST(request: Request, context: Context) {
  const loaded = await loadHostGuideLinkContext(); if (!loaded.ok) return loaded.response;
  if (!mutationFromSameOrigin("POST", request.headers, siteOrigin())) return noStoreJson({ error: "cross_site_request" }, 403);
  try {
    const body = await readBoundedJson(request, 4096, { fatalUtf8: true });
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1 || typeof (body as Record<string, unknown>).email !== "string") return noStoreJson({ error: "invalid_input" }, 400);
    return noStoreJson({ invitation: await loaded.value.client.invite((await context.params).providerId, (body as { email: string }).email) });
  } catch (error) { return hostArticleLinkFailure(error); }
}
