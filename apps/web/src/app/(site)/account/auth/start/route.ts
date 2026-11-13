import { NextResponse, type NextRequest } from "next/server";
import { config } from "@/lib/config";
import { readSmallForm } from "@/lib/host/accounts";
import { startTravelerLogin } from "@/lib/host/niho-login";
import { mutationFromSameOrigin } from "@/lib/host/relay";
import { noStoreJson, siteOrigin } from "@/lib/host/server";
import { TRAVELER_HOME_PATH, TRAVELER_MOCK_LOGIN_PATH, travelerMethodOrNull } from "@/lib/traveler/paths";
import { readTravelerSession } from "@/lib/traveler/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NOT_FOUND = () => noStoreJson({ error: "not_found" }, 404);
const see = (location: string) => new NextResponse(null, { status: 303, headers: { location, "cache-control": "private, no-store" } });

/**
 * A traveler presses a way in (Epic #591, #597): `method=google|apple|line` goes to that provider through NIHO without NIHO's login
 * page; no method is the way in of someone who already has a NIHO account (NIHO's own login screen). Same-origin posts only, so a
 * page of another site cannot start a log in for the traveler. A traveler who is logged in goes on to their account.
 */
export async function POST(request: NextRequest) {
  if (!config.travelerAccountsEnabled) return NOT_FOUND();
  if (!mutationFromSameOrigin("POST", request.headers, siteOrigin())) return noStoreJson({ error: "cross_site_request" }, 403);
  const form = await readSmallForm(request, ["method"], [], 256);
  if (!form.ok) return noStoreJson({ error: form.status === 413 ? "payload_too_large" : form.status === 415 ? "unsupported_media_type" : "invalid_input" }, form.status);
  const rawMethod = form.values.get("method");
  const method = rawMethod === undefined || rawMethod === "" ? null : travelerMethodOrNull(rawMethod, config.travelerLineEnabled);
  if (rawMethod && method === null) return noStoreJson({ error: "invalid_input" }, 400);
  if (config.apiMode !== "http") return see(TRAVELER_MOCK_LOGIN_PATH);
  try {
    if (await readTravelerSession()) return see(TRAVELER_HOME_PATH);
  } catch {
    // A store failure reads as not signed in here: the log in below is the way forward.
  }
  return startTravelerLogin(method);
}
