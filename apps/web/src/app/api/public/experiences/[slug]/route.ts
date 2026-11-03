import { config } from "@/lib/config";
import { experiencePublicationRepository } from "@/lib/experience/store-server";
import { publicEmpty, publicJson } from "@/lib/experience/public-http";

type Context = { params: Promise<{ slug: string }> };

export const dynamic = "force-dynamic";
export const revalidate = 0;

/** Stopped, suspended, stale-readiness and duplicate slugs share the same public 404. */
export async function GET(_request: Request, context: Context) {
  if (!config.experiencePublicationsEnabled) return publicEmpty(404);
  const { slug } = await context.params;
  try {
    const repository = experiencePublicationRepository();
    if (repository === null) return publicJson(503, { error: { code: "STORE_UNAVAILABLE" } });
    const experience = await repository.getPublicBySlug(slug);
    return experience === null ? publicEmpty(404) : publicJson(200, { experience });
  } catch {
    return publicJson(503, { error: { code: "STORE_UNAVAILABLE" } });
  }
}
