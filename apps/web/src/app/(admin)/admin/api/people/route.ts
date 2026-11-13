import { StoreConflictError, StoreNotFoundError, StoreValidationError } from "@niho-experience/experience-store";
import { config } from "@/lib/config";
import { adminJson, adminMutationAllowed, isAdminHttp, loadAdminHttpSession } from "@/lib/admin/server";
import { peopleListingRepository } from "@/lib/experience/store-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 街の人 (#564, docs/people.md): the Admin lists a provider on the Japanese site's 街の人 and edits how they appear.
 * A signed-in Admin only; every request re-checks the session and a change also the same-origin check. Nothing here
 * reads seller, payout, member or booking data: the public profile, the photo and the bio are reused as they are.
 */
const enabled = () => isAdminHttp() && config.experiencePublicationsEnabled;

function failure(error: unknown) {
  if (error instanceof StoreNotFoundError) return adminJson({ error: "not_found" }, 404);
  if (error instanceof StoreConflictError) return adminJson({ error: "conflict" }, 409);
  if (error instanceof StoreValidationError) return adminJson({ error: "invalid_input" }, 400);
  return adminJson({ error: "unavailable" }, 503);
}

export async function GET(request: Request) {
  if (!enabled()) return adminJson({ error: "not_found" }, 404);
  if (new URL(request.url).search) return adminJson({ error: "invalid_input" }, 400);
  const loaded = await loadAdminHttpSession();
  if (loaded.status !== "ok") return adminJson({ error: loaded.status === "error" ? "unavailable" : "unauthenticated" }, loaded.status === "error" ? 503 : 401);
  const repository = peopleListingRepository();
  if (!repository) return adminJson({ error: "unavailable" }, 503);
  try { return adminJson({ people: await repository.adminList() }); } catch (error) { return failure(error); }
}

async function mutation(request: Request, run: (actorId: string, body: Record<string, unknown>) => Promise<void>) {
  if (!enabled()) return adminJson({ error: "not_found" }, 404);
  if (!adminMutationAllowed(request)) return adminJson({ error: "forbidden" }, 403);
  if (request.headers.get("content-type")?.split(";", 1)[0] !== "application/json") return adminJson({ error: "invalid_content_type" }, 415);
  const loaded = await loadAdminHttpSession();
  if (loaded.status !== "ok") return adminJson({ error: loaded.status === "error" ? "unavailable" : "unauthenticated" }, loaded.status === "error" ? 503 : 401);
  let body: Record<string, unknown>;
  try {
    const value: unknown = await request.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
    body = value as Record<string, unknown>;
  } catch { return adminJson({ error: "invalid_input" }, 400); }
  if (typeof body.providerId !== "string") return adminJson({ error: "invalid_input" }, 400);
  const repository = peopleListingRepository();
  if (!repository) return adminJson({ error: "unavailable" }, 503);
  try {
    await run(loaded.actor.id, body);
    return adminJson({ people: await repository.adminList() });
  } catch (error) { return failure(error); }
}

/** List a provider (expectedVersion null) or change their row. */
export async function PUT(request: Request) {
  return mutation(request, async (actorId, body) => {
    const listing = body.listing;
    if (!listing || typeof listing !== "object" || Array.isArray(listing)) throw new StoreValidationError("listing is required.");
    const value = listing as Record<string, unknown>;
    const expected = body.expectedVersion;
    if (expected !== null && typeof expected !== "number") throw new StoreValidationError("expectedVersion must be null or a number.");
    await peopleListingRepository()!.adminSave(actorId, body.providerId as string, expected as number | null, {
      slug: value.slug as string, roleJa: value.roleJa as string, areaJa: value.areaJa as string,
      quoteJa: (value.quoteJa ?? null) as string | null, introJa: (value.introJa ?? null) as string | null, sortOrder: value.sortOrder as number,
    });
  });
}

/** Take a provider off 街の人 (the version the Admin saw). */
export async function DELETE(request: Request) {
  return mutation(request, async (actorId, body) => {
    if (typeof body.expectedVersion !== "number") throw new StoreValidationError("expectedVersion is required.");
    await peopleListingRepository()!.adminWithdraw(actorId, body.providerId as string, body.expectedVersion);
  });
}
