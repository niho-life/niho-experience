import { config } from "@/lib/config";
import { guidePublicationRequirements } from "@/lib/editor-publication/requirements";
import { articleAuthorityRepository } from "@/lib/experience/store-server";

// Read at request time: the same image serves staging and production, each with its own SITE_URL.
export const dynamic = "force-dynamic";

/**
 * NIHO Experience's destination declaration: the publication conditions editor.niho.life shows before publishing here
 * (#253). Public, static per deployment and free of secrets, so it is served whatever the guide source and cached briefly
 * by anyone.
 */
export async function GET() {
  const repository = articleAuthorityRepository();
  if (!repository) return Response.json({ error: "unavailable" }, { status: 503, headers: { "cache-control": "no-store", "x-robots-tag": "noindex" } });
  let categories;
  try { categories = await repository.listActiveCategories(); }
  catch { return Response.json({ error: "unavailable" }, { status: 503, headers: { "cache-control": "no-store", "x-robots-tag": "noindex" } }); }
  if (categories.length === 0) return Response.json({ error: "categories_not_configured" }, { status: 503, headers: { "cache-control": "no-store", "x-robots-tag": "noindex" } });
  return Response.json(guidePublicationRequirements(config.siteUrl, categories), {
    headers: {
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      "x-content-type-options": "nosniff",
      "x-robots-tag": "noindex",
    },
  });
}
