import { StoreValidationError } from "@niho-experience/experience-store";
import { experiencePublicationRepository } from "@/lib/experience/store-server";
import { adminJson } from "@/lib/admin/server";
import { hostAdminRun, validProviderId, validReason } from "@/lib/admin/admin-host-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ providerId: string }> };

/** Suspends a whole host (#711): its public experiences close, new pages and bookings stay closed until lifted. */
export async function POST(request: Request, context: Context) {
  const { providerId } = await context.params;
  if (!validProviderId(providerId)) return adminJson({ error: "invalid_input" }, 400);
  return hostAdminRun(request, { write: true, keys: ["reasonCode"], required: ["reasonCode"] }, async (actor, body) => {
    if (!validReason(body.reasonCode)) throw new StoreValidationError("reasonCode must be an uppercase machine code.");
    const repository = experiencePublicationRepository();
    if (!repository) throw new Error("unavailable");
    return { providerId, ...(await repository.suspendProviderByOperations(actor, providerId, body.reasonCode)) };
  });
}
