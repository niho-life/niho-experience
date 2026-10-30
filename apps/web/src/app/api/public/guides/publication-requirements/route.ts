import { config } from "@/lib/config";
import { guidePublicationRequirements } from "@/lib/editor-publication/requirements";

// Read at request time: the same image serves staging and production, each with its own SITE_URL.
export const dynamic = "force-dynamic";

/**
 * The publication conditions editor.niho.life shows before publishing to NIHO Experience (#253). Public, static per
 * deployment and free of secrets, so it is served whatever the guide source and cached briefly by anyone.
 */
export function GET() {
  return Response.json(guidePublicationRequirements(config.siteUrl), {
    headers: {
      "cache-control": "public, max-age=300",
      "access-control-allow-origin": "*",
      "x-content-type-options": "nosniff",
      "x-robots-tag": "noindex",
    },
  });
}
