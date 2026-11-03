import { articleAuthorityRepository } from "@/lib/experience/store-server";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const repository = articleAuthorityRepository();
  if (!repository) return Response.json({ error: "unavailable" }, { status: 503, headers: { "cache-control": "no-store", "x-robots-tag": "noindex" } });
  try {
    return Response.json({ version: 1, items: await repository.listActiveCategories() }, {
      headers: { "cache-control": "no-store", "access-control-allow-origin": "*", "x-content-type-options": "nosniff", "x-robots-tag": "noindex" },
    });
  } catch {
    return Response.json({ error: "unavailable" }, { status: 503, headers: { "cache-control": "no-store", "x-robots-tag": "noindex" } });
  }
}
