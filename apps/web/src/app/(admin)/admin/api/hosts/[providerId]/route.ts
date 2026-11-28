import { StoreNotFoundError } from "@niho-experience/experience-store";
import { experiencePublicationRepository } from "@/lib/experience/store-server";
import { adminJson } from "@/lib/admin/server";
import { hostAdminRun, validProviderId } from "@/lib/admin/admin-host-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ providerId: string }> };

/**
 * One host of the office's list, by its ID (#711): the CLI reads the host it is about to suspend or lift from here, so a host
 * older than the newest 500 of the list is still found. Read only.
 */
export async function GET(request: Request, context: Context) {
  const { providerId } = await context.params;
  if (!validProviderId(providerId)) return adminJson({ error: "invalid_input" }, 400);
  return hostAdminRun(request, { write: false }, async (actor) => {
    const repository = experiencePublicationRepository();
    if (!repository) throw new Error("unavailable");
    const host = await repository.getAdminHost(actor, providerId);
    if (host === null) throw new StoreNotFoundError("provider");
    return { host };
  });
}
