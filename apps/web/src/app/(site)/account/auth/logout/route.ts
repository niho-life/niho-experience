import { NextResponse, type NextRequest } from "next/server";
import { config } from "@/lib/config";
import { travelerAccounts } from "@/lib/experience/store-server";
import { mutationFromSameOrigin } from "@/lib/host/relay";
import { noStoreJson, siteOrigin } from "@/lib/host/server";
import { TRAVELER_SIGN_IN_PATH } from "@/lib/traveler/paths";
import { TRAVELER_SESSION_COOKIE } from "@/lib/traveler/session";
import { clearTravelerSessionCookie, isTravelerSessionToken } from "@/lib/traveler/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Logs the traveler out (Epic #591, #597): the session ends at the server and the cookie goes. Same-origin posts only. */
export async function POST(request: NextRequest) {
  if (!config.travelerAccountsEnabled) return noStoreJson({ error: "not_found" }, 404);
  if (!mutationFromSameOrigin("POST", request.headers, siteOrigin())) return noStoreJson({ error: "cross_site_request" }, 403);
  const token = request.cookies.get(TRAVELER_SESSION_COOKIE)?.value;
  if (config.apiMode === "http" && isTravelerSessionToken(token)) {
    try { await travelerAccounts()?.revokeSession({ sessionToken: token, nowUtc: new Date().toISOString() }); }
    catch (error) { console.error(`[traveler-auth] session not ended: ${error instanceof Error ? error.name : "unknown error"}`); }
  }
  // The cookie goes whatever happened at the server: the traveler asked to leave.
  const response = new NextResponse(null, { status: 303, headers: { location: TRAVELER_SIGN_IN_PATH, "cache-control": "private, no-store" } });
  clearTravelerSessionCookie(response);
  return response;
}
