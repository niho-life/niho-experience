import "server-only";
import { StoreAccessDeniedError, StoreValidationError, type HostActor, type HostNotificationChanges } from "@niho-experience/experience-store";
import { providerNotificationSettings } from "@/lib/experience/store-server";
import type { HostProvider } from "@/lib/host/providers";
import { loadHostProviders, readHostSession } from "@/lib/host/server";
import { idTokenUsable } from "@/lib/host/session";
import { HOST_INVALID_INPUT_TEXT, HOST_SESSION_ENDED_TEXT } from "./errors";
import { NOTIFICATION_OWNER_ONLY_TEXT, NOTIFICATION_SAVE_FAILED_TEXT } from "./notifications";
import type { HostActionResult } from "./payout";
import type { HostNotificationItem } from "./types";

/*
 * 設定 › 通知 (#109) kept in the experience DB (migration 0020). NIHO proves the account and that it
 * is the provider's OWNER; the experience store checks its own OWNER membership as well (ADR 0002:
 * both are checked). Closed (準備中) until HOST_NOTIFICATION_SETTINGS_ENABLED and the DB are set.
 */

export type HostNotificationSettingsLoad =
  /** 保存 changes them. */
  | { status: "live"; items: HostNotificationItem[] }
  /** Not kept here yet: the flag is off, no DB, or the experience DB has no OWNER membership for them. */
  | { status: "preparing" }
  | { status: "error" };

function ownerActor(providerId: string, nihoUserId: string): HostActor {
  return { providerId, nihoUserId, calendarRoleCeiling: "OWNER" };
}

/** The settings page's 通知 for an OWNER (NIHO's role); anyone else never reads them. */
export async function loadNotificationSettings(provider: HostProvider, nihoUserId: string): Promise<HostNotificationSettingsLoad> {
  const settings = providerNotificationSettings();
  if (!settings || provider.memberRole !== "OWNER") return { status: "preparing" };
  try {
    return { status: "live", items: await settings.get(ownerActor(provider.id, nihoUserId)) };
  } catch (error) {
    return error instanceof StoreAccessDeniedError ? { status: "preparing" } : { status: "error" };
  }
}

/** 保存: the changes the browser sent (already checked for shape), for a provider NIHO says this account owns. */
export async function changeNotificationSettings(providerId: string, changes: HostNotificationChanges): Promise<HostActionResult<{ items: HostNotificationItem[] }>> {
  const session = await readHostSession();
  if (!session || !idTokenUsable(session, Date.now())) return { ok: false, message: HOST_SESSION_ENDED_TEXT };
  const settings = providerNotificationSettings();
  if (!settings) return { ok: false, message: NOTIFICATION_SAVE_FAILED_TEXT };
  const providers = await loadHostProviders();
  if (providers.status !== "ok") return { ok: false, message: providers.status === "error" ? NOTIFICATION_SAVE_FAILED_TEXT : HOST_SESSION_ENDED_TEXT };
  const provider = providers.providers.find((entry) => entry.id === providerId);
  if (provider?.memberRole !== "OWNER") return { ok: false, message: NOTIFICATION_OWNER_ONLY_TEXT };
  try {
    return { ok: true, message: "保存しました", items: await settings.update(ownerActor(providerId, session.nihoUserId), changes) };
  } catch (error) {
    if (error instanceof StoreAccessDeniedError) return { ok: false, message: NOTIFICATION_OWNER_ONLY_TEXT };
    if (error instanceof StoreValidationError) return { ok: false, message: HOST_INVALID_INPUT_TEXT };
    return { ok: false, message: NOTIFICATION_SAVE_FAILED_TEXT };
  }
}
