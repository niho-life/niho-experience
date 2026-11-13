import { StoreNotFoundError, StoreValidationError } from "@niho-experience/experience-store";
import { config } from "@/lib/config";
import { adminJson, adminMutationAllowed, isAdminHttp, loadAdminHttpSession } from "@/lib/admin/server";
import { groupInquiryRepository } from "@/lib/experience/store-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The office's inbox of 団体・個別の相談 (#532, docs/group-inquiry.md). Only a signed-in Admin reads or changes it:
 * every request re-checks the Admin session, a change also the same-origin check. It holds the senders' names,
 * addresses and words, so the answers are never cached (adminJson). Nothing in a request or an answer is logged.
 */
const enabled = () => config.groupInquiryEnabled && isAdminHttp();

function failure(error: unknown) {
  if (error instanceof StoreNotFoundError) return adminJson({ error: "not_found" }, 404);
  if (error instanceof StoreValidationError) return adminJson({ error: "invalid_input" }, 400);
  return adminJson({ error: "unavailable" }, 503);
}

export async function GET(request: Request) {
  if (!enabled()) return adminJson({ error: "not_found" }, 404);
  const loaded = await loadAdminHttpSession();
  if (loaded.status !== "ok") return adminJson({ error: loaded.status === "error" ? "unavailable" : "unauthenticated" }, loaded.status === "error" ? 503 : 401);
  const url = new URL(request.url);
  if ([...url.searchParams.keys()].some((key) => key !== "status" && key !== "id")) return adminJson({ error: "invalid_input" }, 400);
  const repository = groupInquiryRepository();
  if (!repository) return adminJson({ error: "unavailable" }, 503);
  try { return adminJson(await repository.list({ status: url.searchParams.get("status"), id: url.searchParams.get("id") })); } catch (error) { return failure(error); }
}

export async function POST(request: Request) {
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
  if (body.action !== "update" || typeof body.id !== "string") return adminJson({ error: "invalid_input" }, 400);
  const repository = groupInquiryRepository();
  if (!repository) return adminJson({ error: "unavailable" }, 503);
  try {
    const inquiry = await repository.update(loaded.actor.id, body.id, { status: body.status, assigneeLabel: body.assigneeLabel, nextDueOn: body.nextDueOn, staffNote: body.staffNote });
    return adminJson({ inquiry });
  } catch (error) { return failure(error); }
}
