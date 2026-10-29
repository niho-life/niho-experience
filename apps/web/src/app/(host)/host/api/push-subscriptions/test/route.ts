import type { NextRequest } from "next/server";
import { noStoreJson } from "@/lib/host/server";
import { deliverHostPush } from "@/lib/host/push/notify";
import { hostPushTestPayload, hostPushTopic } from "@/lib/host/push/payload";
import { hostPushDeps, hostPushStore, isPushPreview, openPushBff, pushEndpointFrom, pushNotConfigured, pushUnavailable, takePushTestSlot } from "@/lib/host/push/server";

/** テスト通知 (#177 P2): one message to this device, only when its subscription is the signed-in host's. */
export async function POST(request: NextRequest) {
  const opened = await openPushBff(request);
  if ("response" in opened) return opened.response;
  const parsed = pushEndpointFrom(opened.body);
  if ("response" in parsed) return parsed.response;
  // The preview sends nothing, so it has nothing to limit (its hosts all share one synthetic user).
  if (isPushPreview()) return noStoreJson({ sent: false, preview: true });
  const wait = takePushTestSlot(opened.session.nihoUserId);
  if (wait > 0) return noStoreJson({ error: "rate_limited", retryAfterSeconds: wait }, 429);
  const store = hostPushStore();
  if (!store) return pushNotConfigured();
  let recipient;
  try {
    recipient = await store.find(opened.session.nihoUserId, parsed.endpoint);
  } catch {
    return pushUnavailable();
  }
  if (!recipient) return noStoreJson({ error: "not_subscribed" }, 404);
  const outcome = await deliverHostPush(recipient, { payload: hostPushTestPayload(), urgency: "high", ttlSeconds: 60, topic: hostPushTopic("host-push-test") }, hostPushDeps(store));
  if (outcome === "sent") return noStoreJson({ sent: true });
  if (outcome === "gone") return noStoreJson({ error: "subscription_gone" }, 410);
  return noStoreJson({ error: "push_failed" }, 502);
}
