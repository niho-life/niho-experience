import {
  StoreAccessDeniedError,
  StoreConflictError,
  StoreNotFoundError,
  StoreValidationError,
  type SupportActor,
} from "@niho-experience/experience-store";
import { config } from "@/lib/config";
import { adminJson, adminMutationAllowed, isAdminHttp, loadAdminHttpSession } from "@/lib/admin/server";
import { bookingCancellations } from "@/lib/experience/store-server";
import { readBoundedJson } from "@/lib/read-bounded-json";
import { parseSupportPreview } from "../request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BODY_LIMIT = 8 * 1024;
const enabled = () => config.guestBookingEnabled && isAdminHttp();

function failure(error: unknown): Response {
  if (error instanceof StoreConflictError) return adminJson({ error: "conflict" }, 409);
  if (error instanceof StoreNotFoundError) return adminJson({ error: "not_found" }, 404);
  if (error instanceof StoreValidationError) return adminJson({ error: "invalid_input" }, 400);
  if (error instanceof StoreAccessDeniedError) return adminJson({ error: "forbidden" }, 403);
  console.error("Experience support operation preview failed", { error: error instanceof Error ? error.name : typeof error });
  return adminJson({ error: "unavailable" }, 503);
}

async function signedIn(): Promise<{ ok: true; actor: SupportActor } | { ok: false; response: Response }> {
  const loaded = await loadAdminHttpSession();
  if (loaded.status === "ok") return { ok: true, actor: { nihoUserId: loaded.verified.actor.id } };
  return { ok: false, response: adminJson({ error: loaded.status === "error" ? "unavailable" : "unauthenticated" }, loaded.status === "error" ? 503 : 401) };
}

export async function POST(request: Request): Promise<Response> {
  if (!enabled()) return adminJson({ error: "not_found" }, 404);
  if (!adminMutationAllowed(request)) return adminJson({ error: "forbidden" }, 403);
  if (new URL(request.url).search || request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    return adminJson({ error: "invalid_input" }, 400);
  }
  const session = await signedIn();
  if (!session.ok) return session.response;
  let value: unknown;
  try {
    value = await readBoundedJson(request, BODY_LIMIT);
  } catch {
    return adminJson({ error: "invalid_input" }, 400);
  }
  const input = parseSupportPreview(value);
  if (!input) return adminJson({ error: "invalid_input" }, 400);
  const cancellations = bookingCancellations();
  if (!cancellations) return adminJson({ error: "unavailable" }, 503);
  try {
    return adminJson(await cancellations.previewSupportOperation(session.actor, input));
  } catch (error) {
    return failure(error);
  }
}
