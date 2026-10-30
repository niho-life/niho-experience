import { channelJson, channelWatchdogEnabled, channelWatchdogIdentitySettings } from "@/lib/experience/channel-runtime";
import { channelRuntime } from "@/lib/experience/store-server";
import { verifyGoogleServiceIdentity } from "@/lib/google-service-identity";

export const runtime = "nodejs";

const WATCHDOG_BODY_LIMIT = 1024;

/** Cloud Scheduler sends no body or `{}`. Anything else is rejected before the store runs. */
async function emptyCommandBody(request: Request): Promise<Response | null> {
  if (new URL(request.url).search) return channelJson({ error: "invalid_input" }, 400);
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > WATCHDOG_BODY_LIMIT) return channelJson({ error: "payload_too_large" }, 413);
  if (!request.body) return null;
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > WATCHDOG_BODY_LIMIT) return channelJson({ error: "payload_too_large" }, 413);
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } catch {
    return channelJson({ error: "invalid_input" }, 400);
  } finally {
    try { await reader.cancel(); } catch { /* The read result above is authoritative. */ }
    finally { reader.releaseLock(); }
  }
  if (text.trim() === "") return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && Object.keys(parsed).length === 0) return null;
  } catch { /* fall through */ }
  return channelJson({ error: "invalid_input" }, 400);
}

export async function POST(request: Request) {
  const settings = channelWatchdogEnabled() ? channelWatchdogIdentitySettings() : null;
  if (!settings) return channelJson({ error: "not_found" }, 404);
  // Only the configured Google service identity (Cloud Scheduler OIDC). Worker bearers and cookies are never accepted.
  const identity = await verifyGoogleServiceIdentity(request, settings);
  if (!identity.ok) {
    return identity.kind === "outage"
      ? channelJson({ error: "identity_verification_unavailable" }, 503)
      : channelJson({ error: "unauthenticated" }, 401);
  }
  const invalidBody = await emptyCommandBody(request);
  if (invalidBody) return invalidBody;
  const store = channelRuntime();
  if (!store) return channelJson({ error: "runtime_unavailable" }, 503);
  try {
    const result = await store.runWatchdog();
    for (const item of result.transitions) {
      // Structured log only. Detail holds counts, ages, and internal reason codes; no external account ID, token, or traveler data.
      console.warn(JSON.stringify({
        event: "ota_runtime_incident", transition: item.transition, kind: item.kind, incidentId: item.incidentId,
        providerId: item.providerId ?? null, detail: item.detail,
      }));
    }
    return channelJson({
      ranAtUtc: result.ranAtUtc, skipped: result.skipped, opened: result.opened, escalated: result.escalated,
      resolved: result.resolved, openIncidents: result.openIncidents,
    });
  } catch {
    return channelJson({ error: "runtime_unavailable" }, 503);
  }
}
