import { config } from "@/lib/config";
import { hostCalendarSettings } from "@/lib/experience/store-server";
import { providerOperationsEnabled } from "@/lib/host/provider-operations-server";
import { isHostMock, siteOrigin } from "@/lib/host/server";
import { bookingsIcs } from "@/host/calendar-feed";
import { calendarFeedTokenHash, calendarFeedTokenMatches } from "@/host/calendar-server";
import { addDays, todayInJapan } from "@/host/format";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** What calendar-server.ts makes: base64url of 32 bytes. */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
/** From 30 days before today in Japan to 400 days after: what a calendar shows of past and coming sessions. */
const DAYS_BEFORE = 30;
const DAYS_AFTER = 400;
const PRIVATE = { "cache-control": "private, no-store, max-age=0", "x-robots-tag": "noindex, nofollow, noarchive", "referrer-policy": "no-referrer" };

/**
 * Every miss looks the same (no body): the flag off, a malformed, unknown or stopped address, one made under an earlier
 * key, an issuer no longer the OWNER.
 */
const notFound = () => new Response(null, { status: 404, headers: PRIVATE });

function startOfJapanDay(date: string): string {
  return new Date(`${date}T00:00:00+09:00`).toISOString();
}

/**
 * 設定 › カレンダー's bookings feed (#109): the provider's confirmed bookings made on this site as an iCalendar file, at
 * the secret address its OWNER issued. Calendar apps fetch it without cookies, so the address is the only proof: it is
 * found by its digest, then derived again from the provider and salt under the current key and compared in constant
 * time, so changing EXPERIENCE_CALENDAR_FEED_KEY stops every issued address at once. It is never logged (a failure
 * logs the error's name only), and the answer is private and never indexed.
 */
export async function GET(_request: Request, context: { params: Promise<{ token: string }> }): Promise<Response> {
  if (!config.hostConsoleEnabled || isHostMock() || !config.hostCalendarFeedEnabled) return notFound();
  const { token } = await context.params;
  if (!TOKEN.test(token)) return notFound();
  const settings = hostCalendarSettings();
  if (!settings) return new Response(null, { status: 503, headers: PRIVATE });
  try {
    const now = Date.now();
    const today = todayInJapan(now);
    const window = { fromUtc: startOfJapanDay(addDays(today, -DAYS_BEFORE)), toUtc: startOfJapanDay(addDays(today, DAYS_AFTER)) };
    const feed = await settings.readFeed(calendarFeedTokenHash(token), window, (issue) => calendarFeedTokenMatches(token, issue));
    if (!feed) return notFound();
    const body = bookingsIcs(feed.bookings, { origin: siteOrigin(), providerId: feed.providerId, now, besideNiho: providerOperationsEnabled() });
    return new Response(body, {
      status: 200,
      headers: { ...PRIVATE, "content-type": "text/calendar; charset=utf-8", "content-disposition": 'inline; filename="bookings.ics"' },
    });
  } catch (error) {
    console.error("Experience calendar feed read failed", { error: error instanceof Error ? error.name : typeof error });
    return new Response(null, { status: 503, headers: PRIVATE });
  }
}
