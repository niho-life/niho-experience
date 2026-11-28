import { experiencePublicationRepository } from "@/lib/experience/store-server";
import { adminJson } from "@/lib/admin/server";
import { hostAdminRun, validProviderId } from "@/lib/admin/admin-host-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ providerId: string }> };

/** Lifts a host's suspension (#711). Each experience it closed waits for its owner to restart it. */
export async function POST(request: Request, context: Context) {
  const { providerId } = await context.params;
  if (!validProviderId(providerId)) return adminJson({ error: "invalid_input" }, 400);
  return hostAdminRun(request, { write: true }, async (actor) => {
    const repository = experiencePublicationRepository();
    if (!repository) throw new Error("unavailable");
    return { providerId, ...(await repository.clearProviderOperationsSuspension(actor, providerId)) };
  });
}
