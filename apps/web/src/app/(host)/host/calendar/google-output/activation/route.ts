import type { NextRequest } from "next/server";
import {
  GoogleChannelActivationRepository,
  StoreAccessDeniedError,
  StoreConflictError,
  StoreValidationError,
} from "@niho-experience/experience-store";
import { calendarActor } from "@/lib/experience/calendar-actor";
import {
  executeGoogleChannelActivation,
  googleChannelActivationAppliedDto,
  googleChannelActivationEnabled,
  googleChannelActivationStatusDto,
} from "@/lib/experience/google-channel-activation";
import { experiencePool } from "@/lib/experience/store-server";
import { mutationFromSameOrigin } from "@/lib/host/relay";
import { hostNotFound, noStoreJson, siteOrigin } from "@/lib/host/server";
import { readBoundedJson, ResponseBodyTooLarge } from "@/lib/read-bounded-json";

export const runtime = "nodejs";
const MAX_BODY_BYTES = 8 * 1024;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function failure(error: unknown): Response {
  if (error instanceof StoreAccessDeniedError) return noStoreJson({ error: "forbidden" }, 403);
  if (error instanceof StoreConflictError) return noStoreJson({ error: "conflict" }, 409);
  if (error instanceof StoreValidationError) return noStoreJson({ error: "invalid_input" }, 400);
  if (error instanceof ResponseBodyTooLarge) return noStoreJson({ error: "payload_too_large" }, 413);
  return noStoreJson({ error: "activation_unavailable" }, 503);
}

async function owner(providerId: unknown) {
  const opened = await calendarActor(providerId);
  if ("response" in opened) return opened;
  if (opened.access.kind !== "MEMBER" || opened.access.nihoRole !== "OWNER"
    || opened.actor.calendarScope === "OPERATOR" || opened.actor.calendarRoleCeiling !== "OWNER") {
    return { response: noStoreJson({ error: "forbidden" }, 403) } as const;
  }
  return opened;
}

export async function GET(request: NextRequest) {
  if (!googleChannelActivationEnabled()) return hostNotFound();
  const allowed = ["providerId", "listingId", "occurrenceId"];
  if ([...request.nextUrl.searchParams.keys()].some((key) => !allowed.includes(key))
    || allowed.some((key) => request.nextUrl.searchParams.getAll(key).length !== 1)) {
    return noStoreJson({ error: "invalid_input" }, 400);
  }
  const providerId = request.nextUrl.searchParams.get("providerId");
  const listingId = request.nextUrl.searchParams.get("listingId");
  const occurrenceId = request.nextUrl.searchParams.get("occurrenceId");
  if (!listingId || !occurrenceId) return noStoreJson({ error: "invalid_input" }, 400);
  const opened = await owner(providerId);
  if ("response" in opened) return opened.response;
  const pool = experiencePool();
  if (!pool) return noStoreJson({ error: "calendar_not_configured" }, 503);
  try {
    const value = await new GoogleChannelActivationRepository(pool).get(opened.actor, listingId, occurrenceId);
    return noStoreJson(googleChannelActivationStatusDto(value));
  } catch (error) { return failure(error); }
}

export async function POST(request: NextRequest) {
  if (!googleChannelActivationEnabled()) return hostNotFound();
  if (request.nextUrl.search) return noStoreJson({ error: "invalid_input" }, 400);
  if (!mutationFromSameOrigin("POST", request.headers, siteOrigin())) return noStoreJson({ error: "cross_site_request" }, 403);
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    return noStoreJson({ error: "invalid_content_type" }, 415);
  }
  let value: unknown;
  try { value = await readBoundedJson(request, MAX_BODY_BYTES, { fatalUtf8: true }); }
  catch (error) { return failure(error); }
  if (!value || typeof value !== "object" || Array.isArray(value)) return noStoreJson({ error: "invalid_input" }, 400);
  const body = value as Record<string, unknown>;
  const keys = ["providerId", "listingId", "occurrenceId", "expectedMappingVersion", "expectedBindingVersion",
    "expectedDesiredVersion", "commandId", "connectionConfirmed"];
  if (Object.keys(body).some((key) => !keys.includes(key)) || keys.some((key) => !(key in body))
    || typeof body.providerId !== "string"
    || typeof body.listingId !== "string" || body.listingId.length < 1 || body.listingId.length > 256
    || typeof body.occurrenceId !== "string" || body.occurrenceId.length < 1 || body.occurrenceId.length > 256
    || ![body.expectedMappingVersion, body.expectedBindingVersion, body.expectedDesiredVersion]
      .every((item) => Number.isSafeInteger(item) && (item as number) > 0)
    || typeof body.commandId !== "string" || !UUID_V4.test(body.commandId)
    || body.connectionConfirmed !== true) {
    return noStoreJson({ error: "invalid_input" }, 400);
  }
  const opened = await owner(body.providerId);
  if ("response" in opened) return opened.response;
  const pool = experiencePool();
  if (!pool) return noStoreJson({ error: "calendar_not_configured" }, 503);
  try {
    const applied = await executeGoogleChannelActivation(pool, opened.actor, {
      listingId: body.listingId,
      occurrenceId: body.occurrenceId,
      expectedMappingVersion: body.expectedMappingVersion as number,
      expectedBindingVersion: body.expectedBindingVersion as number,
      expectedDesiredVersion: body.expectedDesiredVersion as number,
      commandId: body.commandId,
      connectionConfirmed: true,
    });
    return noStoreJson(googleChannelActivationAppliedDto(applied));
  } catch (error) { return failure(error); }
}
