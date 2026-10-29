import type { NextRequest } from "next/server";
import { ResourceGoogleRepository, StoreAccessDeniedError, StoreConflictError, StoreValidationError } from "@niho-experience/experience-store";
import { config } from "@/lib/config";
import { calendarActor } from "@/lib/experience/calendar-actor";
import { refreshResourceGoogleOwnerSnapshot, resourceGoogleEnabled } from "@/lib/experience/resource-google";
import { experiencePool } from "@/lib/experience/store-server";
import { mutationFromSameOrigin } from "@/lib/host/relay";
import { hostNotFound, isHostMock, noStoreJson, siteOrigin } from "@/lib/host/server";
import { readBoundedJson, ResponseBodyTooLarge } from "@/lib/read-bounded-json";

export const runtime = "nodejs";
const MAX_BODY_BYTES = 8 * 1024;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function failure(error: unknown): Response {
  if (error instanceof StoreAccessDeniedError) return noStoreJson({ error: "forbidden" }, 403);
  if (error instanceof StoreConflictError) return noStoreJson({ error: "conflict" }, 409);
  if (error instanceof StoreValidationError) return noStoreJson({ error: "invalid_input" }, 400);
  if (error instanceof ResponseBodyTooLarge) return noStoreJson({ error: "payload_too_large" }, 413);
  return noStoreJson({ error: "google_unavailable" }, 503);
}

async function owner(providerId: unknown) {
  const opened = await calendarActor(providerId);
  if ("response" in opened) return opened;
  if (opened.access.kind !== "MEMBER" || opened.access.nihoRole !== "OWNER") return { response: noStoreJson({ error: "forbidden" }, 403) } as const;
  return opened;
}

export async function GET(request: NextRequest) {
  if (!config.hostConsoleEnabled || !resourceGoogleEnabled() || isHostMock()) return hostNotFound();
  if ([...request.nextUrl.searchParams.keys()].some((key) => key !== "providerId")) return noStoreJson({ error: "invalid_input" }, 400);
  const opened = await owner(request.nextUrl.searchParams.get("providerId"));
  if ("response" in opened) return opened.response;
  const pool = experiencePool();
  if (!pool) return noStoreJson({ error: "calendar_not_configured" }, 503);
  try { return noStoreJson(await refreshResourceGoogleOwnerSnapshot(pool, opened.actor)); }
  catch (error) { return failure(error); }
}

export async function PUT(request: NextRequest) {
  if (!config.hostConsoleEnabled || !resourceGoogleEnabled() || isHostMock()) return hostNotFound();
  if (!mutationFromSameOrigin("PUT", request.headers, siteOrigin())) return noStoreJson({ error: "cross_site_request" }, 403);
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") return noStoreJson({ error: "invalid_content_type" }, 415);
  let value: unknown;
  try { value = await readBoundedJson(request, MAX_BODY_BYTES, { fatalUtf8: true }); }
  catch (error) { return failure(error); }
  if (!value || typeof value !== "object" || Array.isArray(value)) return noStoreJson({ error: "invalid_input" }, 400);
  const body = value as Record<string, unknown>;
  const keys = Object.keys(body);
  if (keys.length !== 6 || !["providerId", "resourceId", "calendarId", "enabled", "expectedVersion", "commandId"].every((key) => key in body)
    || typeof body.providerId !== "string" || typeof body.resourceId !== "string" || typeof body.calendarId !== "string"
    || typeof body.enabled !== "boolean" || (body.expectedVersion !== null && (!Number.isSafeInteger(body.expectedVersion) || (body.expectedVersion as number) < 1))
    || typeof body.commandId !== "string" || !UUID_V4.test(body.commandId)) return noStoreJson({ error: "invalid_input" }, 400);
  const opened = await owner(body.providerId);
  if ("response" in opened) return opened.response;
  const pool = experiencePool();
  if (!pool) return noStoreJson({ error: "calendar_not_configured" }, 503);
  try {
    const saved = await new ResourceGoogleRepository(pool).save(opened.actor, {
      resourceId: body.resourceId, calendarId: body.calendarId, enabled: body.enabled,
    }, body.expectedVersion as number | null, body.commandId);
    return noStoreJson({ resourceId: body.resourceId, version: saved.version }, saved.repeated ? 200 : 201);
  } catch (error) { return failure(error); }
}
