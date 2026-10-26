/** Host console URLs (#86). Shared by server routes and client components. */
export const HOST_INTRO_PATH = "/host";
export const HOST_HOME_PATH = "/host/home";
export const HOST_REGISTER_PATH = "/host/register";
export const HOST_LOGIN_PATH = "/host/auth/login";
export const HOST_MOCK_LOGIN_PATH = "/host/auth/mock-login";
export const HOST_REFRESH_PATH = "/host/auth/refresh";
export const HOST_LOGOUT_PATH = "/host/auth/logout";
export const HOST_AUTH_ERROR_PATH = "/host/auth/error";
export const HOST_API_PREFIX = "/host/api/";
/** Console sections (#84). HOST_NAV below lists the same paths for the menu. */
export const HOST_EXPERIENCES_PATH = "/host/experiences";
export const HOST_CALENDAR_PATH = "/host/calendar";
export const HOST_BOOKINGS_PATH = "/host/bookings";
/** この回 (#107): one session's guests and attendance, a screen under 予約. */
export const HOST_BOOKING_SESSION_PATH = "/host/bookings/session";
export const HOST_SALES_PATH = "/host/sales";
export const HOST_SETTINGS_PATH = "/host/settings";
/** 本人OWNERの通常Spot / 外部Providerに独立したNIHOサポート設定。 */
export const HOST_SUPPORT_PATH = "/host/support";
/** メッセージ (#106): a screen under ホーム, not in the menu. */
export const HOST_MESSAGES_PATH = "/host/messages";
/** レビュー (#108): a screen under ホーム, not in the menu. */
export const HOST_REVIEWS_PATH = "/host/reviews";
export const HOST_PREPARATIONS_PATH = "/host/preparations";
export const HOST_PREPARATION_REVIEW_PATH = "/host/preparations/review";

export const HOST_NAV = [
  { href: HOST_HOME_PATH, label: "ホーム" },
  { href: "/host/experiences", label: "体験" },
  { href: HOST_CALENDAR_PATH, label: "カレンダー" },
  { href: "/host/bookings", label: "予約" },
  { href: "/host/sales", label: "売上" },
  { href: "/host/settings", label: "設定" },
] as const;

/**
 * `href` with these query values set, after the query it already has. Empty values are left
 * out, so `withQuery("/host/bookings", { filter: null })` stays "/host/bookings". A `#hash`
 * (one review, #108) stays at the end.
 */
export function withQuery(href: string, values: Record<string, string | null | undefined>): string {
  const hashAt = href.indexOf("#");
  const hash = hashAt < 0 ? "" : href.slice(hashAt);
  const rest = hashAt < 0 ? href : href.slice(0, hashAt);
  const at = rest.indexOf("?");
  const path = at < 0 ? rest : rest.slice(0, at);
  const query = new URLSearchParams(at < 0 ? "" : rest.slice(at + 1));
  for (const [key, value] of Object.entries(values)) if (value) query.set(key, value);
  const search = query.toString();
  return `${search ? `${path}?${search}` : path}${hash}`;
}

/**
 * `path?providerId=…` when a provider is chosen: the query every console link carries between
 * pages. A page's own query (the bookings screen's `?filter=`) stays in front of it.
 */
export function withProvider(path: string, providerId: string | null | undefined): string {
  return withQuery(path, { providerId });
}

/** Only an opaque case id is allowed to select the single assisted-launch return page. */
export function preparationCaseIdOrNull(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : null;
}

export function hostPreparationPath(caseId: string): string {
  const safe = preparationCaseIdOrNull(caseId);
  return safe ? `${HOST_PREPARATIONS_PATH}/${safe}` : HOST_PREPARATIONS_PATH;
}

export function hostPreparationLoginPath(caseId: string): string {
  const safe = preparationCaseIdOrNull(caseId);
  return safe ? withQuery(HOST_LOGIN_PATH, { preparationCaseId: safe }) : HOST_LOGIN_PATH;
}

export function hostSupportPath(kind?: "SPOT" | "EXPERIENCE_PROVIDER" | null, id?: string | null): string {
  return kind && id ? withQuery(HOST_SUPPORT_PATH, { hostKind: kind, hostId: id }) : HOST_SUPPORT_PATH;
}

/**
 * Where a signed-in host lands from /host: the home, or 設定 when Stripe sends them back from the
 * payout account's page (`?connect=return|refresh`, which 設定 handles). Only `providerId` and a
 * known `connect` are carried.
 */
export function hostLandingPath(providerId: string | null, connect: unknown): string {
  return connect === "return" || connect === "refresh" ? withQuery(HOST_SETTINGS_PATH, { providerId, connect }) : withProvider(HOST_HOME_PATH, providerId);
}

/** Why the login did not finish; each has its own message on /host/auth/error. */
export const LOGIN_ERROR_REASONS = ["expired", "state", "denied", "rejected", "unavailable"] as const;
export type LoginErrorReason = (typeof LOGIN_ERROR_REASONS)[number];
