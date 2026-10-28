import type { NextRequest } from "next/server";
import { noStoreJson } from "@/lib/host/server";
import { hostPushStore, isPushPreview, openPushBff, pushEndpointFrom, pushNotConfigured, pushUnavailable } from "@/lib/host/push/server";

/**
 * Whether this device's subscription is still the host's (#177 P2): a logout or a revoked connection
 * elsewhere removes it on the server while the browser keeps its own. A row still there moves to this
 * session's connection, so a later sign-in on the device keeps it. The preview trusts the browser.
 */
export async function POST(request: NextRequest) {
  const opened = await openPushBff(request);
  if ("response" in opened) return opened.response;
  const parsed = pushEndpointFrom(opened.body);
  if ("response" in parsed) return parsed.response;
  if (isPushPreview()) return noStoreJson({ subscribed: true, preview: true });
  const store = hostPushStore();
  if (!store) return pushNotConfigured();
  try {
    return noStoreJson({ subscribed: await store.claim(opened.session.nihoUserId, parsed.endpoint, opened.session.connectionId) });
  } catch {
    return pushUnavailable();
  }
}
