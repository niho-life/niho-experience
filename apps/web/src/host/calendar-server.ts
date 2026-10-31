import "server-only";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { StoreAccessDeniedError, type HostActor, type HostCalendarSettings, type HostGoogleConnectionState } from "@niho-experience/experience-store";
import { config } from "@/lib/config";
import { googleRuntimeConfig } from "@/lib/experience/google-connection";
import { hostCalendarSettings } from "@/lib/experience/store-server";
import type { HostProvider } from "@/lib/host/providers";
import { HOST_CALENDAR_PATH } from "@/lib/host/routes";
import { isHostMock, loadHostProviders, readHostSession, siteOrigin } from "@/lib/host/server";
import { idTokenUsable } from "@/lib/host/session";
import { actionTime } from "./bookings";
import {
  CALENDAR_FEED_ISSUE_FAILED_TEXT,
  CALENDAR_FEED_ISSUED_TEXT,
  CALENDAR_FEED_OWNER_ONLY_TEXT,
  CALENDAR_FEED_RENEWED_TEXT,
  CALENDAR_FEED_REVOKE_FAILED_TEXT,
  CALENDAR_FEED_REVOKED_TEXT,
  GOOGLE_NOT_CONNECTED,
  type HostCalendarLoad,
} from "./calendar";
import { HOST_SESSION_ENDED_TEXT } from "./errors";
import { todayInJapan } from "./format";
import type { HostActionResult } from "./payout";
import type { HostGoogleCalendar } from "./types";

/*
 * 設定 › カレンダー (#109) and ホーム's card in http mode, from the experience DB for the provider's OWNER. NIHO proves the
 * account and that it is the provider's OWNER; the store checks its own OWNER membership as well (ADR 0002). The
 * Google Calendar is connected and disconnected by the host calendar routes (/host/calendar/google…); this reads where
 * it stands. The bookings feed (EXPERIENCE_HOST_CALENDAR_FEED_ENABLED) lives at an address derived from a key
 * (EXPERIENCE_CALENDAR_FEED_KEY) and a salt the store keeps per provider; the address itself is never stored or logged
 * and is recomputed for 設定 on every read.
 */

const CLOSED: HostCalendarLoad = { status: "closed" };
/** Ties an address to this feed and its version: another use of the key never yields the same value. */
const FEED_TOKEN_CONTEXT = "niho-experience/calendar-feed/v1";

function ownerActor(providerId: string, nihoUserId: string): HostActor {
  return { providerId, nihoUserId, calendarRoleCeiling: "OWNER" };
}

const errorName = (error: unknown) => (error instanceof Error ? error.name : typeof error);

/** The feed's key: base64 of at least 32 bytes (the start-up checks it with the flag on). Never in `config` or a log. */
function calendarFeedKey(): Buffer {
  const encoded = process.env.EXPERIENCE_CALENDAR_FEED_KEY?.trim() ?? "";
  const key = /^[A-Za-z0-9+/]+={0,2}$/.test(encoded) ? Buffer.from(encoded, "base64") : Buffer.alloc(0);
  if (key.byteLength < 32) throw new Error("The calendar feed key is unavailable.");
  return key;
}

/** The secret part of a provider's feed address: base64url of HMAC-SHA256 over the provider and its salt (43 characters). */
export function calendarFeedToken(providerId: string, salt: Buffer): string {
  return createHmac("sha256", calendarFeedKey()).update(`${FEED_TOKEN_CONTEXT}\0${providerId}\0`).update(salt).digest("base64url");
}

/** What the store keeps to find an address: its SHA-256. */
export function calendarFeedTokenHash(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

export function calendarFeedUrl(token: string): string {
  return `${siteOrigin()}${HOST_CALENDAR_PATH}/feed/${token}/bookings.ics`;
}

/** The Google row as the store has it: no account or calendars are kept, so only the state and 予定がある時間は受け付けない. */
function googleCalendarOf(connection: HostGoogleConnectionState | null): HostGoogleCalendar {
  if (!connection) return GOOGLE_NOT_CONNECTED;
  return { ...GOOGLE_NOT_CONNECTED, status: connection.revoked ? "revoked" : "connected", blockBusy: connection.blockingEnabled };
}

/** YYYY-MM-DDTHH:MM in Japan. */
function japanMinute(utc: string): string {
  const at = Date.parse(utc);
  return actionTime(todayInJapan(at), at);
}

/**
 * カレンダー for an OWNER (NIHO's role): the Google Calendar's state where Google's sign-in is configured, and with
 * `feed` (設定 only) the bookings feed's address while its flag is on. Closed in the preview, for anyone else, without
 * the experience DB, or when the store does not count them as the OWNER.
 */
export async function loadHostCalendar(provider: Pick<HostProvider, "id" | "memberRole">, nihoUserId: string, options: { feed: boolean }): Promise<HostCalendarLoad> {
  if (isHostMock() || provider.memberRole !== "OWNER") return CLOSED;
  const settings = hostCalendarSettings();
  if (!settings) return CLOSED;
  const actor = ownerActor(provider.id, nihoUserId);
  const withFeed = options.feed && config.hostCalendarFeedEnabled;
  try {
    // The connection's read is also the store's OWNER check, so it runs with Google's sign-in off too.
    const [connection, feed] = await Promise.all([settings.googleConnection(actor), withFeed ? settings.getFeed(actor) : null]);
    const google = googleRuntimeConfig() ? googleCalendarOf(connection) : null;
    return {
      status: "live",
      google,
      googleSync: google?.status === "connected" && connection
        ? { lastCheckedAt: connection.lastSucceededAtUtc ? japanMinute(connection.lastSucceededAtUtc) : null, failing: connection.syncStatus === "FAILED" }
        : null,
      feed: withFeed ? { url: feed ? calendarFeedUrl(calendarFeedToken(provider.id, feed.salt)) : null } : null,
    };
  } catch (error) {
    if (error instanceof StoreAccessDeniedError) return CLOSED;
    console.error("Experience host calendar read failed", { error: errorName(error) });
    return { status: "error" };
  }
}

type FeedOwner = { ok: true; settings: HostCalendarSettings; actor: HostActor } | { ok: false; message: string };

/** The feed's flag, a usable session, the store, and NIHO saying this account owns the provider. */
async function asFeedOwner(providerId: string, failed: string): Promise<FeedOwner> {
  if (isHostMock() || !config.hostCalendarFeedEnabled) return { ok: false, message: failed };
  const session = await readHostSession();
  if (!session || !idTokenUsable(session, Date.now())) return { ok: false, message: HOST_SESSION_ENDED_TEXT };
  const settings = hostCalendarSettings();
  if (!settings) return { ok: false, message: failed };
  const providers = await loadHostProviders();
  if (providers.status !== "ok") return { ok: false, message: providers.status === "error" ? failed : HOST_SESSION_ENDED_TEXT };
  const provider = providers.providers.find((entry) => entry.id === providerId);
  if (provider?.memberRole !== "OWNER") return { ok: false, message: CALENDAR_FEED_OWNER_ONLY_TEXT };
  return { ok: true, settings, actor: ownerActor(providerId, session.nihoUserId) };
}

/** URL を作る / URL を作り直す: a new salt, so a new address; the old one stops working at once. */
export async function issueCalendarFeedAsOwner(providerId: string): Promise<HostActionResult<{ url: string | null }>> {
  const owner = await asFeedOwner(providerId, CALENDAR_FEED_ISSUE_FAILED_TEXT);
  if (!owner.ok) return owner;
  try {
    const salt = randomBytes(32);
    const token = calendarFeedToken(providerId, salt);
    const issued = await owner.settings.issueFeed(owner.actor, { salt, tokenHash: calendarFeedTokenHash(token) });
    return { ok: true, message: issued.replaced ? CALENDAR_FEED_RENEWED_TEXT : CALENDAR_FEED_ISSUED_TEXT, url: calendarFeedUrl(token) };
  } catch (error) {
    if (error instanceof StoreAccessDeniedError) return { ok: false, message: CALENDAR_FEED_OWNER_ONLY_TEXT };
    console.error("Experience calendar feed issue failed", { error: errorName(error) });
    return { ok: false, message: CALENDAR_FEED_ISSUE_FAILED_TEXT };
  }
}

/** URL を止める: the address answers nothing from now on. */
export async function revokeCalendarFeedAsOwner(providerId: string): Promise<HostActionResult<{ url: string | null }>> {
  const owner = await asFeedOwner(providerId, CALENDAR_FEED_REVOKE_FAILED_TEXT);
  if (!owner.ok) return owner;
  try {
    await owner.settings.revokeFeed(owner.actor);
    return { ok: true, message: CALENDAR_FEED_REVOKED_TEXT, url: null };
  } catch (error) {
    if (error instanceof StoreAccessDeniedError) return { ok: false, message: CALENDAR_FEED_OWNER_ONLY_TEXT };
    console.error("Experience calendar feed revoke failed", { error: errorName(error) });
    return { ok: false, message: CALENDAR_FEED_REVOKE_FAILED_TEXT };
  }
}
