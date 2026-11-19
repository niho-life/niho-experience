import { writerArticleLinkClient, writerLinkFailure } from "@/lib/write/article-links-server";
import { writeJson } from "@/lib/write/server";

export async function GET(request: Request) {
  if (new URL(request.url).search) return writeJson({ error: "invalid_input" }, 400);
  try {
    const client = await writerArticleLinkClient();
    return client ? writeJson({ items: await client.list() }) : writeJson({ error: "forbidden" }, 403);
  } catch (error) { return writerLinkFailure(error); }
}
