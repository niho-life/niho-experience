import { StoreAccessDeniedError, StoreConflictError, StoreNotFoundError, StoreValidationError } from "@niho-experience/experience-store";
import { config } from "@/lib/config";
import { adminJson, isAdminHttp, loadAdminHttpSession } from "@/lib/admin/server";
import { bookingCancellations } from "@/lib/experience/store-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/*
 * サポートONの予約 (#121/#128): the paid bookings accepted with the current support ON consent, newest first, so NIHO
 * support can open the case of a booking that is not in the queue. `?cursor=` (the page before's nextCursor) or
 * `?publicBookingId=` (that booking only); nothing else. The store checks both are UUIDs and that the eligibility comes
 * from the booking's own snapshot. Answers carry the guest's name only and are never cached; the query is never logged.
 */

const enabled = () => config.guestBookingEnabled && isAdminHttp();
const KEYS = new Set(["cursor", "publicBookingId"]);
const VALUE_MAX = 64;

function failure(error: unknown): Response {
  if (error instanceof StoreConflictError) return adminJson({ error: "conflict" }, 409);
  if (error instanceof StoreNotFoundError) return adminJson({ error: "not_found" }, 404);
  if (error instanceof StoreValidationError) return adminJson({ error: "invalid_input" }, 400);
  if (error instanceof StoreAccessDeniedError) return adminJson({ error: "forbidden" }, 403);
  console.error("Experience support bookings failed", { error: error instanceof Error ? error.name : typeof error });
  return adminJson({ error: "unavailable" }, 503);
}

function query(url: URL): { cursor?: string; publicBookingId?: string } | null {
  const seen = new Map<string, string>();
  for (const [key, value] of url.searchParams) {
    if (!KEYS.has(key) || seen.has(key) || value.length === 0 || value.length > VALUE_MAX) return null;
    seen.set(key, value);
  }
  if (seen.has("cursor") && seen.has("publicBookingId")) return null;
  return Object.fromEntries(seen) as { cursor?: string; publicBookingId?: string };
}

export async function GET(request: Request): Promise<Response> {
  if (!enabled()) return adminJson({ error: "not_found" }, 404);
  const parsed = query(new URL(request.url));
  if (!parsed) return adminJson({ error: "invalid_input" }, 400);
  const loaded = await loadAdminHttpSession();
  if (loaded.status !== "ok") return adminJson({ error: loaded.status === "error" ? "unavailable" : "unauthenticated" }, loaded.status === "error" ? 503 : 401);
  const cancellations = bookingCancellations();
  if (!cancellations) return adminJson({ error: "unavailable" }, 503);
  try {
    const page = await cancellations.supportEnabledBookings(
      parsed.publicBookingId !== undefined ? { publicBookingId: parsed.publicBookingId } : { cursor: parsed.cursor ?? null },
    );
    return adminJson({ bookings: page.bookings, nextCursor: page.nextCursor });
  } catch (error) {
    return failure(error);
  }
}
