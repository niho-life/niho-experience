export const ADMIN_ENTRY_PATH = "/admin";
export const ADMIN_BOOKINGS_PATH = "/admin/bookings";
export const ADMIN_NOTIFICATIONS_PATH = "/admin/notifications";
export const ADMIN_LOGIN_PATH = "/admin/auth/login";
export const ADMIN_CALLBACK_PATH = "/admin/auth/callback";
export const ADMIN_AUTH_ERROR_PATH = "/admin/auth/error";
export const ADMIN_REFRESH_PATH = "/admin/auth/refresh";
export const ADMIN_LOGOUT_PATH = "/admin/auth/logout";
export const ADMIN_LOGOUT_UNCONFIRMED_PATH = "/admin/auth/logout-unconfirmed";
/** The Google login (ADR 0003 decision 4, EXPERIENCE_ADMIN_GOOGLE_LOGIN_ENABLED). */
export const ADMIN_GOOGLE_LOGIN_PATH = "/admin/auth/google/login";
/** The redirect URI registered on the Google OAuth client, after the site's origin. */
export const ADMIN_GOOGLE_CALLBACK_PATH = "/admin/auth/google/callback";

const RETURN_TO = new Set([ADMIN_BOOKINGS_PATH, ADMIN_NOTIFICATIONS_PATH]);

/** Admin login can return only to an explicit console page on this site. */
export function safeAdminReturnTo(value: string | null | undefined): string {
  return value && RETURN_TO.has(value) ? value : ADMIN_BOOKINGS_PATH;
}
