import "server-only";
import { StoreRateLimitedError, StoreValidationError, type HostNotificationAddresses } from "@niho-experience/experience-store";
import { hostNotificationAddresses } from "@/lib/experience/store-server";
import { nihoIdOrNull } from "@/lib/host/providers";
import { loadHostProviders, readHostSession } from "@/lib/host/server";
import { accessTokenUsable } from "@/lib/host/session";
import { HOST_SESSION_ENDED_TEXT } from "./errors";
import { NOTIFICATION_ADDRESS_TEXT, notificationAddressInput, notificationAddressView, type HostNotificationAddressView } from "./notification-address";
import type { HostActionResult } from "./payout";

/*
 * 設定 › 通知 › 宛先 (#194) kept in the experience DB (migration 0038). Use the current NIHO identity from contract v1;
 * Experience membership or an operator grant determines whether the caller can act for a provider.
 */

export type HostNotificationAddressLoad =
  | { status: "off" }
  | { status: "live"; address: HostNotificationAddressView }
  | { status: "error" };

type Store = Pick<HostNotificationAddresses, "get" | "requestChange" | "useLoginEmail" | "cancelChange" | "confirm">;

async function currentUserId(providerId: string): Promise<string | null> {
  const providers = await loadHostProviders();
  if (providers.status !== "ok") return null;
  const provider = providers.providers.find((entry) => entry.id === providerId);
  if (provider && provider.memberRole !== "OWNER") return null;
  return providers.nihoUserId;
}

export async function loadNotificationAddress(providerId: string, addresses: () => Store | null = hostNotificationAddresses): Promise<HostNotificationAddressLoad> {
  const store = addresses();
  if (!store) return { status: "off" };
  const nihoUserId = await currentUserId(providerId);
  if (!nihoUserId) return { status: "error" };
  try {
    return { status: "live", address: notificationAddressView(await store.get(nihoUserId)) };
  } catch {
    return { status: "error" };
  }
}

export type NotificationAddressChange =
  | { kind: "request"; providerId: unknown; email: unknown }
  | { kind: "login"; providerId: unknown }
  | { kind: "cancel"; providerId: unknown };

type AddressChanged = { address: HostNotificationAddressView };

/** 確認のメールを送る / ログインのメールに戻す / 取り消す, for the session's own NIHO user. */
export async function changeNotificationAddress(change: NotificationAddressChange, addresses: () => Store | null = hostNotificationAddresses): Promise<HostActionResult<AddressChanged>> {
  const session = await readHostSession();
  if (!session || !accessTokenUsable(session, Date.now())) return { ok: false, message: HOST_SESSION_ENDED_TEXT };
  const store = addresses();
  if (!store) return { ok: false, message: NOTIFICATION_ADDRESS_TEXT.failed };
  const providerId = nihoIdOrNull(change.providerId);
  const nihoUserId = providerId ? await currentUserId(providerId) : null;
  if (!providerId || !nihoUserId) return { ok: false, message: NOTIFICATION_ADDRESS_TEXT.failed };
  try {
    if (change.kind === "request") {
      const email = notificationAddressInput(change.email);
      if (!email) return { ok: false, message: NOTIFICATION_ADDRESS_TEXT.invalid };
      const result = await store.requestChange({ nihoUserId, providerId, email });
      const message = result.kind === "PENDING" ? NOTIFICATION_ADDRESS_TEXT.sent : result.kind === "DEFAULT" ? NOTIFICATION_ADDRESS_TEXT.backToLogin : NOTIFICATION_ADDRESS_TEXT.unchanged;
      return { ok: true, message, address: notificationAddressView(result.address) };
    }
    if (change.kind === "login") return { ok: true, message: NOTIFICATION_ADDRESS_TEXT.backToLogin, address: notificationAddressView(await store.useLoginEmail(nihoUserId)) };
    return { ok: true, message: NOTIFICATION_ADDRESS_TEXT.cancelled, address: notificationAddressView(await store.cancelChange(nihoUserId)) };
  } catch (error) {
    if (error instanceof StoreRateLimitedError) return { ok: false, message: NOTIFICATION_ADDRESS_TEXT.rateLimited };
    if (error instanceof StoreValidationError) return { ok: false, message: NOTIFICATION_ADDRESS_TEXT.invalid };
    return { ok: false, message: NOTIFICATION_ADDRESS_TEXT.failed };
  }
}

/** The confirmation link (#194): its token makes its address the one in use, if the link is still good. */
export async function confirmNotificationAddressToken(token: unknown, addresses: () => Store | null = hostNotificationAddresses): Promise<{ ok: true; email: string } | { ok: false; closed: boolean }> {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) return { ok: false, closed: true };
  const store = addresses();
  if (!store) return { ok: false, closed: true };
  try {
    const confirmed = await store.confirm(token);
    return confirmed ? { ok: true, email: confirmed.email } : { ok: false, closed: true };
  } catch {
    return { ok: false, closed: false };
  }
}
