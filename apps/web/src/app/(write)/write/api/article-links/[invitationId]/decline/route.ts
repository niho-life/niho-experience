import { writerArticleLinkClient, writerLinkFailure } from "@/lib/write/article-links-server";
import { mutationFromSameOrigin } from "@/lib/host/relay";
import { siteOrigin } from "@/lib/host/server";
import { writeJson } from "@/lib/write/server";
type Context = { params: Promise<{ invitationId: string }> };
export async function POST(request: Request, context: Context) {
  if (!mutationFromSameOrigin("POST", request.headers, siteOrigin())) return writeJson({ error: "cross_site_request" }, 403);
  if (new URL(request.url).search || request.body !== null) return writeJson({ error: "invalid_input" }, 400);
  try {
    const client = await writerArticleLinkClient();
    return client ? writeJson({ invitation: await client.decide((await context.params).invitationId, "decline") }) : writeJson({ error: "forbidden" }, 403);
  } catch (error) { return writerLinkFailure(error); }
}
