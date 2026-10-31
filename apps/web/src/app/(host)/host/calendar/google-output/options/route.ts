import type { NextRequest } from "next/server";
import {
  GoogleChannelOptionsRepository,
  StoreAccessDeniedError,
  StoreValidationError,
} from "@niho-experience/experience-store";
import { calendarActor } from "@/lib/experience/calendar-actor";
import { googleChannelActivationEnabled } from "@/lib/experience/google-channel-activation";
import { experiencePool } from "@/lib/experience/store-server";
import { hostNotFound, noStoreJson } from "@/lib/host/server";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  if (!googleChannelActivationEnabled()) return hostNotFound();
  const allowed = ["providerId", "productId", "occurrenceId"];
  if ([...request.nextUrl.searchParams.keys()].some((key) => !allowed.includes(key))
    || allowed.some((key) => request.nextUrl.searchParams.getAll(key).length !== 1)) {
    return noStoreJson({ error: "invalid_input" }, 400);
  }
  const providerId = request.nextUrl.searchParams.get("providerId");
  const productId = request.nextUrl.searchParams.get("productId");
  const occurrenceId = request.nextUrl.searchParams.get("occurrenceId");
  if (!productId || productId.length > 256 || !occurrenceId || occurrenceId.length > 256) {
    return noStoreJson({ error: "invalid_input" }, 400);
  }
  const opened = await calendarActor(providerId);
  if ("response" in opened) return opened.response;
  if (opened.access.kind !== "MEMBER" || opened.access.nihoRole !== "OWNER"
    || opened.actor.calendarScope === "OPERATOR" || opened.actor.calendarRoleCeiling !== "OWNER") {
    return noStoreJson({ error: "forbidden" }, 403);
  }
  const pool = experiencePool();
  if (!pool) return noStoreJson({ error: "calendar_not_configured" }, 503);
  try {
    const value = await new GoogleChannelOptionsRepository(pool).get(opened.actor, productId, occurrenceId);
    return noStoreJson({ connected: value.connected, candidates: value.candidates.map((candidate) => ({
      listingId: candidate.listingId,
      accountDisplayName: candidate.accountDisplayName,
      mappingVersion: candidate.mappingVersion,
      localDate: candidate.localDate,
      ...(candidate.desiredVersion ? { desiredVersion: candidate.desiredVersion } : {}),
      ...(candidate.pendingSetup ? { pendingSetup: {
        commandId: candidate.pendingSetup.commandId,
        expectedMappingVersion: candidate.pendingSetup.expectedMappingVersion,
      } } : {}),
      ...(candidate.pendingAnchor ? { pendingAnchor: {
        commandId: candidate.pendingAnchor.commandId,
        expectedMappingVersion: candidate.pendingAnchor.expectedMappingVersion,
        expectedDesiredVersion: candidate.pendingAnchor.expectedDesiredVersion,
      } } : {}),
    })) });
  } catch (error) {
    if (error instanceof StoreAccessDeniedError) return noStoreJson({ error: "forbidden" }, 403);
    if (error instanceof StoreValidationError) return noStoreJson({ error: "invalid_input" }, 400);
    return noStoreJson({ error: "options_unavailable" }, 503);
  }
}
