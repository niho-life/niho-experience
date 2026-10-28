import type { NextRequest } from "next/server";
import { noStoreJson } from "@/lib/host/server";
import { hostPushStore, isPushPreview, openPushBff, pushDeviceLabel, pushEndpointFrom, pushNotConfigured, pushSubscriptionFrom, pushUnavailable } from "@/lib/host/push/server";

/** 設定 › この端末 › 通知 (#177 P2): this device's subscription, tied to the host and the session's NIHO connection. */
export async function POST(request: NextRequest) {
  const opened = await openPushBff(request);
  if ("response" in opened) return opened.response;
  const parsed = pushSubscriptionFrom(opened.body);
  if ("response" in parsed) return parsed.response;
  if (isPushPreview()) return noStoreJson({ ok: true, preview: true });
  const store = hostPushStore();
  if (!store) return pushNotConfigured();
  try {
    await store.save({ nihoUserId: opened.session.nihoUserId, connectionId: opened.session.connectionId, ...parsed.subscription, deviceLabel: pushDeviceLabel(request.headers.get("user-agent")) });
  } catch {
    return pushUnavailable();
  }
  return noStoreJson({ ok: true });
}

/** この端末の通知を止める: only the host's own row for this endpoint. */
export async function DELETE(request: NextRequest) {
  const opened = await openPushBff(request);
  if ("response" in opened) return opened.response;
  const parsed = pushEndpointFrom(opened.body);
  if ("response" in parsed) return parsed.response;
  if (isPushPreview()) return noStoreJson({ ok: true, preview: true });
  const store = hostPushStore();
  if (!store) return pushNotConfigured();
  try {
    await store.remove(opened.session.nihoUserId, parsed.endpoint);
  } catch {
    return pushUnavailable();
  }
  return noStoreJson({ ok: true });
}
