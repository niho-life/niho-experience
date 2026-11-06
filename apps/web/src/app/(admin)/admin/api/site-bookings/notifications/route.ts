import { StoreNotFoundError, StoreValidationError } from "@niho-experience/experience-store";
import { config } from "@/lib/config";
import { adminJson, adminMutationAllowed, isAdminHttp, loadAdminHttpSession } from "@/lib/admin/server";
import { experienceSupportRepository } from "@/lib/experience/store-server";
import { readBoundedJson } from "@/lib/read-bounded-json";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const enabled = () => config.guestBookingEnabled && isAdminHttp();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type CurrentAdmin =
  | { readonly kind: "ok"; readonly actor: { readonly nihoUserId: string } }
  | { readonly kind: "error"; readonly response: Response };

async function currentAdmin(): Promise<CurrentAdmin> {
  const session = await loadAdminHttpSession();
  if (session.status === "ok") return { kind: "ok", actor: { nihoUserId: session.actor.id } };
  return { kind: "error", response: adminJson({ error: session.status === "error" ? "unavailable" : "unauthenticated" }, session.status === "error" ? 503 : 401) };
}

export async function GET(request: Request) {
  if (!enabled()) return adminJson({ error: "not_found" }, 404);
  const url = new URL(request.url);
  const unreadOnly = url.searchParams.get("unreadOnly");
  if ([...url.searchParams.keys()].some((key) => key !== "unreadOnly") || url.searchParams.size > 1 || (unreadOnly !== null && unreadOnly !== "true" && unreadOnly !== "false")) return adminJson({ error: "invalid_input" }, 400);
  const session = await currentAdmin();
  if (session.kind === "error") return session.response;
  const repository = experienceSupportRepository();
  if (!repository) return adminJson({ error: "unavailable" }, 503);
  try {
    return adminJson({ notifications: await repository.listNotifications(session.actor, { limit: 50, unreadOnly: unreadOnly === "true" }) });
  } catch (error) {
    if (error instanceof StoreValidationError) return adminJson({ error: "invalid_input" }, 400);
    console.error("Experience support notifications failed", { error: error instanceof Error ? error.name : typeof error });
    return adminJson({ error: "unavailable" }, 503);
  }
}

export async function POST(request: Request) {
  if (!enabled()) return adminJson({ error: "not_found" }, 404);
  if (!adminMutationAllowed(request) || request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") return adminJson({ error: "forbidden" }, 403);
  const session = await currentAdmin();
  if (session.kind === "error") return session.response;
  let parsed: unknown;
  try { parsed = await readBoundedJson(request, 1024, { fatalUtf8: true }); }
  catch { return adminJson({ error: "invalid_input" }, 400); }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return adminJson({ error: "invalid_input" }, 400);
  const body = parsed as Record<string, unknown>;
  if (Object.keys(body).length !== 1 || !Object.hasOwn(body, "notificationId")) return adminJson({ error: "invalid_input" }, 400);
  const notificationId = body.notificationId;
  if (typeof notificationId !== "string" || !UUID.test(notificationId)) return adminJson({ error: "invalid_input" }, 400);
  const repository = experienceSupportRepository();
  if (!repository) return adminJson({ error: "unavailable" }, 503);
  try {
    await repository.markNotificationRead(session.actor, notificationId);
    return adminJson({ read: true });
  } catch (error) {
    if (error instanceof StoreNotFoundError) return adminJson({ error: "not_found" }, 404);
    if (error instanceof StoreValidationError) return adminJson({ error: "invalid_input" }, 400);
    console.error("Experience support notification read failed", { error: error instanceof Error ? error.name : typeof error });
    return adminJson({ error: "unavailable" }, 503);
  }
}
