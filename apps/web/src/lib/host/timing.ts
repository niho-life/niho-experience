/** Session timing shared by the server and the browser (#86). */

/** Refresh once less than this remains on the scoped Web access token. */
export const REFRESH_WINDOW_MS = 5 * 60 * 1000;
/** Never call NIHO with a scoped Web access token that has less than this left. */
export const ACCESS_TOKEN_MIN_REMAINING_MS = 60 * 1000;
/** Firebase ID-token expiry used by the separate Experience Admin session. */
export const ID_TOKEN_MIN_REMAINING_MS = ACCESS_TOKEN_MIN_REMAINING_MS;
