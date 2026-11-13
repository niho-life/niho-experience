/**
 * 旅行者のアカウント (Epic #591, #597): the traveler's session cookie. It is not the host account's cookie
 * (`__Host-niho_host_account_session`): a traveler session opens nothing on /host or /write, and a host session is not a
 * traveler's. `__Host-` pins it to this origin and Path=/; the value is the store's opaque session token (only its SHA-256 is
 * stored server-side).
 */
export const TRAVELER_SESSION_COOKIE = "__Host-niho_traveler_session";
export const TRAVELER_SESSION_COOKIE_PATH = "/";
/**
 * Beside the login cookie (Path=/host/auth, 10 minutes): a hint, never read as a decision, that the round trip in flight is a
 * traveler's. It is only for the page a return goes to when its sealed state is gone (expired), so a traveler is not sent to
 * the host console's error page.
 */
export const TRAVELER_LOGIN_HINT_COOKIE = "__Secure-niho_traveler_login";
/** Preview only (mock mode): the synthetic traveler's cookie value. It stands for nobody and never works against the DB. */
export const MOCK_TRAVELER_SESSION = "mock-traveler-session-preview-only";
