import { NextResponse } from "next/server";
import { config } from "@/lib/config";
import { noStoreJson } from "@/lib/host/server";
import { TRAVELER_HOME_PATH } from "@/lib/traveler/paths";
import { MOCK_TRAVELER_SESSION, TRAVELER_SESSION_COOKIE, TRAVELER_SESSION_COOKIE_PATH } from "@/lib/traveler/session";
import { hostCookieOptions } from "@/lib/host/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Preview only (EXPERIENCE_API_MODE=mock): logs in as a synthetic traveler, with no NIHO and no database. 404 in http mode. */
export function GET() {
  if (!config.travelerAccountsEnabled || config.apiMode === "http") return noStoreJson({ error: "not_found" }, 404);
  const response = new NextResponse(null, { status: 303, headers: { location: TRAVELER_HOME_PATH, "cache-control": "private, no-store" } });
  response.cookies.set(TRAVELER_SESSION_COOKIE, MOCK_TRAVELER_SESSION, hostCookieOptions(TRAVELER_SESSION_COOKIE_PATH, 24 * 60 * 60));
  return response;
}
