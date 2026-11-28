import type { NextRequest } from "next/server";
import { config } from "@/lib/config";
import { hostMockScenario, MOCK_ACCESS_TOKEN_PREFIX, mockHostDisplayName, mockToken } from "@/lib/host/mock-niho";
import { nihoIdOrNull } from "@/lib/host/providers";
import { HOST_AUTH_ERROR_PATH, HOST_HOME_PATH, HOST_START_PATH, hostInvitationPath, hostPreparationPath, hostReturnPathOrNull, invitationIdOrNull, preparationCaseIdOrNull, withProvider, withQuery } from "@/lib/host/routes";
import { hostNotFound, isHostMock, MOCK_ACCESS_TOKEN_TTL_MS, noStoreJson, seeOther, setRegistrationCookie, setSessionCookie } from "@/lib/host/server";
import { REGISTRATION_MAX_AGE_SECONDS, startSession } from "@/lib/host/session";

const MOCK_CONNECTION_TTL_MS = 90 * 24 * 60 * 60 * 1000;
/** The NIHO name a synthetic, unregistered NIHO account brings to the registration form (a made-up person). */
const MOCK_NIHO_DISPLAY_NAME = "森 ゆき";

/**
 * Preview only (EXPERIENCE_API_MODE=mock): signs in as a synthetic host.
 * `?mock=empty` gives an account with no providers, `?mock=payments-pending`
 * one whose payout account is not connected and `?mock=calendar-revoked` the
 * usual two with the kitchen's Google Calendar access taken away in Google
 * (#109), `?mock=site-sales` the usual two with 売上 read from a synthetic ledger
 * of bookings made on this site (#91), `?mock=site-bookings` the usual two with
 * 予約 showing synthetic bookings made on this site (#285); `?expired=1` starts with an
 * expired NIHO Web access token to exercise the refresh-then-reload path, and `?surface=app`
 * signs in as the installed app does (#177). `?mock=unregistered` is a NIHO account no host account is bound to
 * (EXPERIENCE_HOST_NIHO_LOGIN_ENABLED, Epic #591): it ends on the 「ホストに登録されていません」 page. With
 * EXPERIENCE_HOST_SELF_REGISTRATION_ENABLED (#708) that NIHO account (and `intent=register` from /host/auth/login) goes on to
 * /host/start with a synthetic NIHO name in the sealed registration cookie; nothing is kept. 404 in http mode.
 */
export async function GET(request: NextRequest) {
  if (!config.hostConsoleEnabled || !isHostMock()) return hostNotFound();
  const params = request.nextUrl.searchParams;
  const preparationCaseId = preparationCaseIdOrNull(params.get("preparationCaseId"));
  const invitationId = invitationIdOrNull(params.get("invitationId"));
  const returnPath = hostReturnPathOrNull(params.get("returnTo"));
  if (preparationCaseId && invitationId) return noStoreJson({ error: "conflicting_login_intent" }, 400);
  if (config.hostSelfRegistrationEnabled && (params.get("mock") === "unregistered" || params.get("intent") === "register")) {
    const response = seeOther(HOST_START_PATH);
    setRegistrationCookie(response, { nihoUserId: mockToken("mock-niho-user-"), authTimeMs: Date.now(), displayName: MOCK_NIHO_DISPLAY_NAME, expiresAt: Date.now() + REGISTRATION_MAX_AGE_SECONDS * 1000 });
    return response;
  }
  if (config.hostNihoLoginEnabled && params.get("mock") === "unregistered") return seeOther(withQuery(HOST_AUTH_ERROR_PATH, { reason: "unregistered", invitationId }));
  const now = Date.now();
  const session = startSession(
    {
      refreshToken: mockToken("mock-refresh-token."),
      accessToken: mockToken(MOCK_ACCESS_TOKEN_PREFIX),
      accessTokenExpiresAt: params.get("expired") === "1" ? now - 1000 : now + MOCK_ACCESS_TOKEN_TTL_MS,
      connectionId: mockToken("mock-connection-"),
      connectionExpiresAt: now + MOCK_CONNECTION_TTL_MS,
      displayName: await mockHostDisplayName(),
      iconUrl: null,
      mockScenario: hostMockScenario(params.get("mock")),
      ...(params.get("surface") === "app" ? { surface: "app" as const } : {}),
    },
    now,
  );
  const response = seeOther(invitationId ? hostInvitationPath(invitationId) : preparationCaseId ? hostPreparationPath(preparationCaseId) : returnPath ?? withProvider(HOST_HOME_PATH, nihoIdOrNull(params.get("providerId"))));
  setSessionCookie(response, session, now);
  return response;
}
