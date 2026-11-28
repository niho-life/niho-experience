import { experiencePublicationRepository } from "@/lib/experience/store-server";
import { hostAdminRun } from "@/lib/admin/admin-host-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The office's list of hosts (#711, docs/host-operations.md). Read only. */
export async function GET(request: Request) {
  return hostAdminRun(request, { write: false }, async (actor) => {
    const repository = experiencePublicationRepository();
    if (!repository) throw new Error("unavailable");
    return { hosts: await repository.listAdminHosts(actor) };
  });
}
