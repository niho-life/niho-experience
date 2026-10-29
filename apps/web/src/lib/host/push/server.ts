import "server-only";
import type { NextRequest, NextResponse } from "next/server";
import { HostPushSubscriptions, type HostPushDeviceLabel } from "@niho-experience/experience-store";
import { isAllowedPushEndpoint, isPushSubscriptionKeys, type PushSubscriptionKeys } from "@niho-experience/web-push";
import { config } from "@/lib/config";
import { experiencePool } from "@/lib/experience/store-server";
import { readBoundedJson } from "../bounded-json";
import { mutationFromSameOrigin } from "../relay";
import { hostNotFound, isHostMock, noStoreJson, readHostSession, siteOrigin } from "../server";
import type { HostSession } from "../session";
import type { HostPushDeps } from "./notify";

/**
 * The host app's push subscriptions BFF (#177 P2, /host/api/push-subscriptions/*). The session comes
 * from the sealed cookie only (no NIHO call). An endpoint is a capability URL: it is never logged,
 * put in a URL or echoed back.
 */
const MAX_BODY_BYTES = 4096;

export type PushBffRequest = { response: NextResponse } | { session: HostSession; body: Record<string, unknown> };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** 404 while push is off, then same-origin, the signed-in host and a small JSON object. */
export async function openPushBff(request: NextRequest): Promise<PushBffRequest> {
  if (!config.hostPushEnabled) return { response: hostNotFound() };
  if (!mutationFromSameOrigin(request.method, request.headers, siteOrigin())) return { response: noStoreJson({ error: "cross_site_request" }, 403) };
  const session = await readHostSession();
  if (!session) return { response: noStoreJson({ error: "signed_out" }, 401) };
  const body = await readBoundedJson(request, MAX_BODY_BYTES);
  if (!body.ok) {
    const status = body.reason === "too_large" ? 413 : body.reason === "media_type" ? 415 : 400;
    return { response: noStoreJson({ error: body.reason === "too_large" ? "payload_too_large" : body.reason === "media_type" ? "unsupported_media_type" : "invalid_body" }, status) };
  }
  if (!isRecord(body.value)) return { response: noStoreJson({ error: "invalid_body" }, 400) };
  return { session, body: body.value };
}

/** `{ endpoint }` of a browser push service, or the 400 to answer. */
export function pushEndpointFrom(body: Record<string, unknown>): { endpoint: string } | { response: NextResponse } {
  return isAllowedPushEndpoint(body.endpoint) ? { endpoint: body.endpoint } : { response: noStoreJson({ error: "endpoint_not_allowed" }, 400) };
}

const unpadded = (value: unknown) => (typeof value === "string" ? value.replace(/=+$/, "") : "");

/** `PushSubscription.toJSON()`: the endpoint and its keys, stored without base64 padding. */
export function pushSubscriptionFrom(body: Record<string, unknown>): { subscription: PushSubscriptionKeys } | { response: NextResponse } {
  const endpoint = pushEndpointFrom(body);
  if ("response" in endpoint) return endpoint;
  const keys = isRecord(body.keys) ? body.keys : {};
  const p256dh = unpadded(keys.p256dh);
  const auth = unpadded(keys.auth);
  if (!isPushSubscriptionKeys(p256dh, auth)) return { response: noStoreJson({ error: "invalid_subscription" }, 400) };
  return { subscription: { endpoint: endpoint.endpoint, p256dh, auth } };
}

/** Coarse, from the User-Agent; an iPad that asks for desktop pages counts as a Mac. */
export function pushDeviceLabel(userAgent: string | null): HostPushDeviceLabel {
  const ua = userAgent ?? "";
  if (/iPhone|iPod/.test(ua)) return "iphone";
  if (/iPad/.test(ua)) return "ipad";
  if (/Android/.test(ua)) return "android";
  if (/Macintosh|Mac OS X/.test(ua)) return "mac";
  if (/Windows/.test(ua)) return "windows";
  return "other";
}

/** Mock previews validate and answer, but never store or send. */
export const isPushPreview = isHostMock;

/** null while EXPERIENCE_DATABASE_URL is not set: the BFF answers 503. */
export function hostPushStore(): HostPushSubscriptions | null {
  const pool = experiencePool();
  return pool ? new HostPushSubscriptions(pool) : null;
}

export const pushNotConfigured = () => noStoreJson({ error: "push_not_configured" }, 503);
export const pushUnavailable = () => noStoreJson({ error: "unavailable" }, 503);

export function hostPushDeps(subscriptions: HostPushDeps["subscriptions"]): HostPushDeps {
  return {
    subscriptions,
    vapid: { subject: config.hostPushVapidSubject, publicKey: config.hostPushVapidPublicKey, privateKey: config.hostPushVapidPrivateKey },
    fetch,
    now: Date.now(),
  };
}

const TEST_INTERVAL_MS = 30_000;
const lastTest = new Map<string, number>();

/** テスト通知: one per 30 seconds per NIHO user on this instance. Seconds to wait, or 0 when it may go. */
export function takePushTestSlot(nihoUserId: string, now = Date.now()): number {
  for (const [user, at] of lastTest) if (now - at >= TEST_INTERVAL_MS) lastTest.delete(user);
  const at = lastTest.get(nihoUserId);
  if (at !== undefined) return Math.ceil((TEST_INTERVAL_MS - (now - at)) / 1000);
  lastTest.set(nihoUserId, now);
  return 0;
}

const HOOK_TIMEOUT_MS = 1_500;

/** Sign-in bookkeeping never blocks or fails the auth flow: no store, an error or a slow DB is ignored. */
async function bestEffort(work: (store: HostPushSubscriptions) => Promise<unknown>): Promise<void> {
  if (!config.hostPushEnabled || isHostMock()) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const store = hostPushStore();
    if (!store) return;
    await Promise.race([work(store), new Promise((resolve) => { timer = setTimeout(resolve, HOOK_TIMEOUT_MS); })]);
  } catch {
    // The connection's devices are cleaned up later: 404/410 from the push service, or 30 days unseen.
  } finally {
    clearTimeout(timer);
  }
}

/** Logout or a connection NIHO ended: its devices stop receiving. */
export const forgetHostPushConnection = (connectionId: string) => bestEffort((store) => store.removeConnection(connectionId));

/** A refreshed connection: its devices count as seen (push skips devices unseen for 30 days). */
export const touchHostPushConnection = (connectionId: string) => bestEffort((store) => store.touchConnection(connectionId));
