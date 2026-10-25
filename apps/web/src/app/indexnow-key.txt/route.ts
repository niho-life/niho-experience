import { config } from "@/lib/config";
import { INDEXNOW_KEY } from "@/lib/indexnow";

export const dynamic = "force-dynamic";

/** The IndexNow key file, served only while the site may be indexed: a preview never invites a crawl. */
export function GET(): Response {
  if (!config.indexingAllowed) return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  return new Response(INDEXNOW_KEY, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
