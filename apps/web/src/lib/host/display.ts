/**
 * Whether the console is open as an installed app (#177): a home-screen app on phones,
 * a Dock or desktop app on computers. Browser code only; the server learns it from
 * HOST_DISPLAY_HEADER, which the refresh call sends from inside the app.
 */
export const HOST_DISPLAY_HEADER = "x-niho-host-display";
export const HOST_DISPLAY_STANDALONE = "standalone";
/** The refresh call's 401 when the app holds a session signed in elsewhere: sign in inside the app instead. */
export const HOST_APP_SIGN_IN_REQUIRED = "app_sign_in_required";

const STANDALONE_QUERY = "(display-mode: standalone)";

export function isStandaloneDisplay(): boolean {
  if (typeof window === "undefined") return false;
  // `navigator.standalone`: iOS home-screen apps from before display-mode was supported.
  return window.matchMedia?.(STANDALONE_QUERY).matches === true || (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
}

/** For useSyncExternalStore: Chrome on computers can move an open tab into the app's window and back. */
export function subscribeDisplayMode(onChange: () => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const query = window.matchMedia(STANDALONE_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}
