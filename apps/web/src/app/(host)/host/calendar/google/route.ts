import type { NextRequest } from "next/server";
import { config } from "@/lib/config";
import { disconnectGoogleCalendar, syncGoogleBusy } from "@/lib/experience/google-connection";
import { hostActor } from "@/lib/experience/host-actor";
import { experiencePool, experienceStore } from "@/lib/experience/store-server";
import { mutationFromSameOrigin } from "@/lib/host/relay";
import { hostNotFound, isHostMock, noStoreJson, siteOrigin } from "@/lib/host/server";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  if (!config.hostConsoleEnabled || isHostMock()) return hostNotFound();
  if (!mutationFromSameOrigin("POST", request.headers, siteOrigin())) return noStoreJson({ error: "cross_site_request" }, 403);
  if (Number(request.headers.get("content-length") ?? 0) > 1024) return noStoreJson({ error: "payload_too_large" }, 413);
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > 1024) return noStoreJson({ error: "payload_too_large" }, 413);
  let body: { providerId?: unknown; action?: unknown };
  try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch { return noStoreJson({ error: "invalid_body" }, 400); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return noStoreJson({ error: "invalid_body" }, 400);
  const result = await hostActor(body.providerId);
  if ("response" in result) return result.response;
  const pool = experiencePool();
  const store = experienceStore();
  if (!pool || !store) return noStoreJson({ error: "calendar_not_configured" }, 503);
  try {
    const membership = await store.verifyActiveMembership(result.actor);
    if (!membership) return noStoreJson({ error: "forbidden" }, 403);
    if (body.action === "disconnect") {
      if (membership.role !== "OWNER" || result.nihoRole !== "OWNER") return noStoreJson({ error: "forbidden" }, 403);
      await disconnectGoogleCalendar(pool, result.actor);
      return noStoreJson({ ok: true });
    }
    if (body.action === "sync") {
      const status = await store.getGoogleCalendar(result.actor);
      if (!status) return noStoreJson({ error: "not_connected" }, 404);
      if (status.syncStatus === "FRESH" && status.freshUntilUtc && status.freshUntilUtc > new Date().toISOString()) return noStoreJson({ ok: true });
      await syncGoogleBusy(pool, store, result.actor.providerId);
      return noStoreJson({ ok: true });
    }
    return noStoreJson({ error: "invalid_action" }, 400);
  } catch {
    return noStoreJson({ error: "calendar_unavailable" }, 503);
  }
}
