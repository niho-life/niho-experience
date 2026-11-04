import { StoreAccessDeniedError, StoreConflictError, StoreValidationError, GuestBookingRepository } from "@niho-experience/experience-store";
import { experiencePool } from "@/lib/experience/store-server";
import { hostActor } from "@/lib/experience/host-actor";
import { readBoundedJson } from "@/lib/host/bounded-json";
import { mutationFromSameOrigin } from "@/lib/host/relay";
import { noStoreJson, siteOrigin } from "@/lib/host/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ providerId: string }> };
const BODY_LIMIT = 4096;

async function owner(context: Context) {
  const { providerId } = await context.params;
  const selected = await hostActor(providerId);
  if ("response" in selected) return { ok: false as const, response: selected.response };
  if (selected.nihoRole !== "OWNER") return { ok: false as const, response: noStoreJson({ error: "forbidden" }, 403) };
  const pool = experiencePool();
  if (!pool) return { ok: false as const, response: noStoreJson({ error: "unavailable" }, 503) };
  return { ok: true as const, actor: selected.actor, repository: new GuestBookingRepository(pool) };
}

function failure(error: unknown): Response {
  if (error instanceof StoreAccessDeniedError) return noStoreJson({ error: "forbidden" }, 403);
  if (error instanceof StoreConflictError) return noStoreJson({ error: "conflict" }, 409);
  if (error instanceof StoreValidationError) return noStoreJson({ error: "invalid_input" }, 400);
  console.error("Experience support settings failed", { error: error instanceof Error ? error.name : typeof error });
  return noStoreJson({ error: "unavailable" }, 503);
}

export async function GET(request: Request, context: Context) {
  if (new URL(request.url).search) return noStoreJson({ error: "invalid_input" }, 400);
  const loaded = await owner(context);
  if (!loaded.ok) return loaded.response;
  try {
    return noStoreJson({ setting: await loaded.repository.getProviderSupportSettings(loaded.actor) });
  } catch (error) {
    return failure(error);
  }
}

export async function PUT(request: Request, context: Context) {
  if (!mutationFromSameOrigin("PUT", request.headers, siteOrigin())) return noStoreJson({ error: "forbidden" }, 403);
  if (new URL(request.url).search || request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") return noStoreJson({ error: "invalid_input" }, 400);
  const loaded = await owner(context);
  if (!loaded.ok) return loaded.response;
  const parsed = await readBoundedJson(request, BODY_LIMIT);
  if (!parsed.ok || parsed.value === null || typeof parsed.value !== "object" || Array.isArray(parsed.value)) return noStoreJson({ error: "invalid_input" }, 400);
  const body = parsed.value as Record<string, unknown>;
  if (typeof body.supportEnabled !== "boolean" || typeof body.expectedVersion !== "number" || typeof body.consentVersion !== "string") return noStoreJson({ error: "invalid_input" }, 400);
  try {
    const setting = await loaded.repository.setProviderSupportSettings(loaded.actor, {
      supportEnabled: body.supportEnabled,
      expectedVersion: body.expectedVersion,
      consentVersion: body.consentVersion,
    });
    return noStoreJson({ setting });
  } catch (error) {
    return failure(error);
  }
}
