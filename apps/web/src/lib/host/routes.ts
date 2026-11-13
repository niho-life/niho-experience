/** Host console URLs (#86). Shared by server routes and client components. */
export const HOST_INTRO_PATH = "/host";
export const HOST_HOME_PATH = "/host/home";
export const HOST_REGISTER_PATH = "/host/register";
export const HOST_LOGIN_PATH = "/host/auth/login";
export const HOST_MOCK_LOGIN_PATH = "/host/auth/mock-login";
export const HOST_REFRESH_PATH = "/host/auth/refresh";
export const HOST_LOGOUT_PATH = "/host/auth/logout";
export const HOST_AUTH_ERROR_PATH = "/host/auth/error";
/**
 * Experience host accounts (ADR 0003, EXPERIENCE_HOST_ACCOUNTS_ENABLED): the email form (HOST_LOGIN_PATH sends hosts
 * there), where it posts, and the emailed link (`/host/auth/open#t=<token>`; its page posts the token to the same path).
 */
export const HOST_EMAIL_SIGN_IN_PATH = "/host/auth/sign-in";
export const HOST_EMAIL_LOGIN_PATH = "/host/auth/email";
export const HOST_LOGIN_LINK_PATH = "/host/auth/open";
/**
 * The invitation link of a registered host (Epic #591, #596): `/host/auth/invite#t=<token>` from the email. Its page posts the
 * token to the same path; the browser that does so first is the one the invitation belongs to. The sign-in that follows
 * is `/host/auth/login?invite=1` (HOST_LOGIN_PATH), whose return binds the NIHO account to the invited host account.
 */
export const HOST_INVITE_PATH = "/host/auth/invite";
export const HOST_INVITATIONS_PATH = "/host/invitations";
export const HOST_API_PREFIX = "/host/api/";
/** Creates a short-lived Express dashboard login link after server-side OWNER checks. */
export const HOST_STRIPE_LOGIN_PATH = "/host/api/stripe-login";
/**
 * The console as an installed app (#177). The app's scope is `/host/` (the English
 * introduction at /host stays outside it), and it opens on /host/launch.
 */
export const HOST_LAUNCH_PATH = "/host/launch";
export const HOST_APP_SCOPE = "/host/";
export const HOST_MANIFEST_PATH = "/host/manifest.webmanifest";
export const HOST_SW_PATH = "/host/sw.js";
/**
 * Android's share sheet posts a photo here (#177 P3, manifest `share_target`). The worker answers it and sends the
 * host on to 体験 with `?shared=photo`; without a worker the route sends them there with `?shared=none`.
 */
export const HOST_SHARE_TARGET_PATH = "/host/share-target";
export const HOST_SHARED_QUERY = "shared";
/** Console sections (#84). HOST_NAV below lists the same paths for the menu. */
export const HOST_EXPERIENCES_PATH = "/host/experiences";
export const HOST_CALENDAR_PATH = "/host/calendar";
export const HOST_BOOKINGS_PATH = "/host/bookings";
/** この回 (#107): one session's guests and attendance, a screen under 予約. */
export const HOST_BOOKING_SESSION_PATH = "/host/bookings/session";
export const HOST_SALES_PATH = "/host/sales";
export const HOST_SETTINGS_PATH = "/host/settings";
/** The confirmation link of a new notification address (#194): `#t=<token>`, outside the console frame. */
export const HOST_NOTIFICATION_EMAIL_PATH = "/host/notification-email";
/** 本人OWNERの通常Spot / 外部Providerに独立したNIHOサポート設定。 */
export const HOST_SUPPORT_PATH = "/host/support";
/** OWNERが公開専用の販売者情報を入力・撤回する独立画面。 */
export const HOST_SELLER_PATH = "/host/seller";
/** ホスト紹介 (#146): OWNERが提供者ごとに1つの公開用ホスト紹介文を書く・撤回する画面。 */
export const HOST_PROFILE_PATH = "/host/profile";
/** メッセージ (#106): a screen under ホーム, not in the menu. */
export const HOST_MESSAGES_PATH = "/host/messages";
/** レビュー (#108): a screen under ホーム, not in the menu. */
export const HOST_REVIEWS_PATH = "/host/reviews";
/** 予約に紐づかないOWNER専用の対面通訳。ホームの下位画面で、下端タブは増やさない。 */
export const HOST_TRANSLATE_PATH = "/host/translate";
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
 * The five places a host uses during day-to-day operations. Settings remains in
 * HOST_NAV because it is still a permissioned console section, but it is opened
 * from the account menu instead of competing with daily work in the sidebar or
 * phone tab bar.
 */
export const HOST_DAILY_NAV = HOST_NAV.filter((item) => item.href !== HOST_SETTINGS_PATH);

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

export function invitationIdOrNull(value: unknown): string | null {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) ? value : null;
}

export function hostInvitationPath(invitationId: string): string {
  const safe = invitationIdOrNull(invitationId);
  return safe ? `${HOST_INVITATIONS_PATH}/${safe}` : HOST_INVITATIONS_PATH;
}

export function hostInvitationLoginPath(invitationId: string): string {
  const safe = invitationIdOrNull(invitationId);
  return safe ? withQuery(HOST_LOGIN_PATH, { invitationId: safe }) : HOST_LOGIN_PATH;
}

export function hostSupportPath(kind?: "SPOT" | "EXPERIENCE_PROVIDER" | null, id?: string | null): string {
  return kind && id ? withQuery(HOST_SUPPORT_PATH, { hostKind: kind, hostId: id }) : HOST_SUPPORT_PATH;
}

/**
 * 受取口座の利用同意 (ADR 0003 slice 3, EXPERIENCE_HOST_ACCOUNTS_ENABLED): the form of 設定 › 受取口座 posts here, and the
 * section's anchor on 設定.
 */
export const HOST_PAYOUT_CONSENT_PATH = "/host/api/payout-account-consent";
export const HOST_SETTINGS_PAYOUT_ANCHOR = "settings-payout";

/**
 * NIHO アカウントの結び付け (Epic #591, #595): the form of 設定 › ログイン情報 posts here (`action=link` or `unlink`), and the
 * section's own page, where a sign-in (the emailed link or NIHO's) comes back to and the outcome is told (`?niho=`).
 */
export const HOST_NIHO_IDENTITY_PATH = "/host/api/niho-identity";

/** 設定 › ログイン情報 of a provider (the NIHO account's section). */
export function hostAccountSettingsPath(providerId: string | null): string {
  return withQuery(HOST_SETTINGS_PATH, { providerId, section: "account" });
}

/**
 * The sign-in a sensitive change asks for again, for a host bound to a NIHO account: NIHO's own login, which asks NIHO to
 * sign the person in again (`reauth=1`), then back to `returnTo` (an allowlisted page, hostReturnPathOrNull).
 */
export function hostNihoReauthPath(returnTo: string): string {
  return withQuery(HOST_LOGIN_PATH, { reauth: "1", returnTo });
}

/** 設定 › 受取口座 of a provider: where the consent form returns, and where a sign-in for it comes back to. */
export function hostPayoutSettingsPath(providerId: string | null): string {
  return `${withProvider(HOST_SETTINGS_PATH, providerId)}#${HOST_SETTINGS_PAYOUT_ANCHOR}`;
}

const RETURN_PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const WRITE_ARTICLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const WRITE_EXPERIENCE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * A page an emailed or NIHO sign-in may return to: one of the fixed /write
 * routes (with only a validated experience slug), 設定 › 受取口座 or 設定 ›
 * ログイン情報 with at most their providerId, or a product operator invitation. Anything else is null, so
 * the value can never send a host off this site or to an arbitrary local path.
 */
export function hostReturnPathOrNull(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 300 || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return null;
  let url: URL;
  try { url = new URL(value, "https://return.invalid"); }
  catch { return null; }
  if (url.origin !== "https://return.invalid") return null;
  if (url.pathname === "/write" || url.pathname === "/write/new") {
    if (url.hash !== "") return null;
    const keys = [...url.searchParams.keys()];
    if (keys.length > 1 || (keys.length === 1 && keys[0] !== "experience")) return null;
    const experience = url.searchParams.get("experience");
    if (experience !== null && (experience.length > 160 || !WRITE_EXPERIENCE_SLUG.test(experience))) return null;
    return withQuery(url.pathname, { experience });
  }
  const writeMatch = /^\/write\/([^/]+)(\/preview)?$/.exec(url.pathname);
  if (writeMatch) {
    let articleId: string;
    try { articleId = decodeURIComponent(writeMatch[1]!); }
    catch { return null; }
    if (!WRITE_ARTICLE_ID.test(articleId) || url.search !== "" || url.hash !== "") return null;
    return `/write/${encodeURIComponent(articleId)}${writeMatch[2] ?? ""}`;
  }
  if (!url.pathname.startsWith("/host/")) return null;
  // A product operator's invitation (docs/product-operators.md): a host who signs in from it comes back to accept it.
  if (url.pathname.startsWith(`${HOST_INVITATIONS_PATH}/`)) {
    const invitationId = invitationIdOrNull(url.pathname.slice(HOST_INVITATIONS_PATH.length + 1));
    return invitationId && url.search === "" && url.hash === "" ? hostInvitationPath(invitationId) : null;
  }
  // 設定 › ログイン情報 (Epic #591): where a NIHO account's binding and its re-login come back to.
  if (url.pathname === HOST_SETTINGS_PATH && url.hash === "" && url.searchParams.get("section") === "account") {
    const keys = [...url.searchParams.keys()].sort();
    if (keys.some((key) => key !== "providerId" && key !== "section") || keys.length > 2) return null;
    const providerId = url.searchParams.get("providerId");
    if (providerId !== null && !RETURN_PROVIDER_ID.test(providerId)) return null;
    return hostAccountSettingsPath(providerId);
  }
  if (url.pathname !== HOST_SETTINGS_PATH || url.hash !== `#${HOST_SETTINGS_PAYOUT_ANCHOR}`) return null;
  const keys = [...url.searchParams.keys()];
  if (keys.length > 1 || (keys.length === 1 && keys[0] !== "providerId")) return null;
  const providerId = url.searchParams.get("providerId");
  if (providerId !== null && !RETURN_PROVIDER_ID.test(providerId)) return null;
  return hostPayoutSettingsPath(providerId);
}

/**
 * Where a signed-in host lands from /host: the home, or 設定 when Stripe sends them back from the
 * payout account's page (`?connect=return|refresh`, which 設定 handles). Only `providerId` and a
 * known `connect` are carried.
 */
export function hostLandingPath(providerId: string | null, connect: unknown): string {
  return connect === "return" || connect === "refresh" ? withQuery(HOST_SETTINGS_PATH, { providerId, connect }) : withProvider(HOST_HOME_PATH, providerId);
}

/**
 * Why the login did not finish; each has its own message on /host/auth/error. `link`: an emailed sign-in link that is
 * expired, used, or opened in another browser than the one that asked for it (Experience host accounts). With the NIHO
 * account login (Epic #591): `unregistered` is a NIHO account no host account is bound to (usually another method than
 * the one the host was registered with), `suspended` a bound host account that is suspended. `invite-*` (#596): the
 * invitation link ran out or was replaced (`expired`), was used (`used`), belongs to another browser (`browser`), or is
 * unknown or no longer open when the NIHO sign-in came back (`invalid`); the NIHO account is bound to another host
 * account (`in-use`) or the invited host account has another NIHO account (`has-identity`).
 */
export const LOGIN_ERROR_REASONS = [
  "expired", "state", "denied", "rejected", "unavailable", "link", "unregistered", "suspended",
  "invite-expired", "invite-used", "invite-browser", "invite-invalid", "invite-in-use", "invite-has-identity",
] as const;
export type LoginErrorReason = (typeof LOGIN_ERROR_REASONS)[number];
