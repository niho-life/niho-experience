import { config } from "@/lib/config";
import { experiencePublicationRepository } from "@/lib/experience/store-server";
import { publicEmpty, publicJson } from "@/lib/experience/public-http";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/** The host UI and public consumers read the Experience-owned publication catalog. */
export async function GET() {
  if (config.apiMode !== "http" || !config.experiencePublicationsEnabled) return publicEmpty(404);
  try {
    const repository = experiencePublicationRepository();
    if (repository === null) return publicJson(503, { error: { code: "STORE_UNAVAILABLE" } });
    return publicJson(200, { experiences: await repository.listPublic() });
  } catch {
    return publicJson(503, { error: { code: "STORE_UNAVAILABLE" } });
  }
}
