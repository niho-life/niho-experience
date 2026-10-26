import type { NextRequest } from "next/server";
import { exchangeGoogleCode, listGoogleCalendars } from "@niho-experience/google-calendar";
import { config } from "@/lib/config";
import { googleRuntimeConfig, initializeBookingCalendar, saveGoogleConnection, syncGoogleBusy } from "@/lib/experience/google-connection";
import { hostActor } from "@/lib/experience/host-actor";
import { decodeGoogleOAuthState, GOOGLE_OAUTH_COOKIE, GOOGLE_OAUTH_COOKIE_PATH } from "@/lib/experience/google-oauth-state";
import { experiencePool, experienceStore } from "@/lib/experience/store-server";
import { loginStatesMatch } from "@/lib/host/pkce";
import { HOST_CALENDAR_PATH, withQuery } from "@/lib/host/routes";
import { hostNotFound, isHostMock, seeOther } from "@/lib/host/server";
import { hostCookieOptions } from "@/lib/host/session";

export const runtime = "nodejs";

function finish(providerId: string | null, result: "connected" | "sync-failed" | "failed") {
  const response = seeOther(withQuery(HOST_CALENDAR_PATH, { providerId, google: result }));
  response.cookies.set(GOOGLE_OAUTH_COOKIE, "", hostCookieOptions(GOOGLE_OAUTH_COOKIE_PATH, 0));
  return response;
}

export async function GET(request: NextRequest) {
  if (!config.hostConsoleEnabled || isHostMock()) return hostNotFound();
  const saved = decodeGoogleOAuthState(request.cookies.get(GOOGLE_OAUTH_COOKIE)?.value, Date.now());
  if (!saved) return finish(null, "failed");
  const done = (result: "connected" | "sync-failed" | "failed") => finish(saved.providerId, result);
  if (request.nextUrl.searchParams.has("error") || !loginStatesMatch(saved.state, request.nextUrl.searchParams.get("state"))) return done("failed");
  const code = request.nextUrl.searchParams.get("code");
  if (!code || code.length > 2048) return done("failed");
  const actor = await hostActor(saved.providerId);
  if ("response" in actor || actor.actor.nihoUserId !== saved.nihoUserId) return done("failed");
  const pool = experiencePool();
  const store = experienceStore();
  const runtime = googleRuntimeConfig();
  if (!pool || !store || !runtime) return done("failed");
  try {
    const membership = await store.verifyActiveMembership(actor.actor);
    if (membership?.role !== "OWNER") return done("failed");
    const token = await exchangeGoogleCode(runtime.google, code, saved.verifier);
    if (!token.refreshToken) return done("failed");
    const calendars = await listGoogleCalendars(runtime.google, token.accessToken);
    const busyCalendarId = calendars.find((calendar) => calendar.primary)?.id ?? calendars[0]?.id;
    if (!busyCalendarId) return done("failed");
    const bookingCalendarId = await initializeBookingCalendar(token);
    await saveGoogleConnection(pool, actor.actor, token, busyCalendarId, bookingCalendarId);
    try {
      await syncGoogleBusy(pool, store, actor.actor.providerId);
      return done("connected");
    } catch {
      return done("sync-failed");
    }
  } catch {
    return done("failed");
  }
}
