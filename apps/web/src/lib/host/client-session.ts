import { HOST_APP_SIGN_IN_REQUIRED, HOST_DISPLAY_HEADER, HOST_DISPLAY_STANDALONE, isStandaloneDisplay } from "./display";
import { HOST_API_PREFIX, HOST_INTRO_PATH, HOST_LAUNCH_PATH, HOST_REFRESH_PATH } from "./routes";

/**
 * Browser side of the host session (#86). The tokens stay in an HttpOnly cookie;
 * this module only asks the server to refresh them, one request at a time across
 * every tab, because NIHO ends the connection if an old refresh token is reused.
 */
export const HOST_REFRESH_LOCK = "niho-host-refresh";

export type RefreshOutcome =
  | { status: "ok"; idTokenExpiresAt: number }
  | { status: "signed-out" }
  /** Inside the installed app with a session signed in elsewhere (cookies the OS copied in): sign in again here (#177). */
  | { status: "app-sign-in" }
  | { status: "failed" };

export interface HostClientDeps {
  fetch: typeof fetch;
  /** Web Locks when the browser has them; otherwise only this tab is serialised. */
  locks?: Pick<LockManager, "request"> | undefined;
  /** Inside the installed app (#177). The refresh call says so; the server then refreshes only a session signed in there. */
  standalone?: boolean;
  onSignedOut: () => void;
}

/** Where a host goes when the session ends: the app's start page inside the app, the introduction in a browser. */
export function hostSignedOutPath(standalone = isStandaloneDisplay()): string {
  return standalone ? HOST_LAUNCH_PATH : HOST_INTRO_PATH;
}

function browserDeps(): HostClientDeps {
  return {
    fetch: (...args) => fetch(...args),
    locks: typeof navigator !== "undefined" && "locks" in navigator ? navigator.locks : undefined,
    standalone: isStandaloneDisplay(),
    onSignedOut: () => window.location.assign(hostSignedOutPath()),
  };
}

async function errorCode(response: Response): Promise<unknown> {
  try {
    return ((await response.clone().json()) as { error?: unknown }).error;
  } catch {
    return undefined;
  }
}

async function postRefresh(fetchImpl: typeof fetch, standalone: boolean): Promise<RefreshOutcome> {
  try {
    const headers: Record<string, string> = { accept: "application/json" };
    if (standalone) headers[HOST_DISPLAY_HEADER] = HOST_DISPLAY_STANDALONE;
    const response = await fetchImpl(HOST_REFRESH_PATH, { method: "POST", credentials: "same-origin", cache: "no-store", headers });
    if (response.status === 401) return (await errorCode(response)) === HOST_APP_SIGN_IN_REQUIRED ? { status: "app-sign-in" } : { status: "signed-out" };
    if (!response.ok) return { status: "failed" };
    const body = (await response.json()) as { idTokenExpiresAt?: unknown };
    const idTokenExpiresAt = Number(body.idTokenExpiresAt);
    return Number.isFinite(idTokenExpiresAt) ? { status: "ok", idTokenExpiresAt } : { status: "failed" };
  } catch {
    return { status: "failed" };
  }
}

let inFlight: Promise<RefreshOutcome> | null = null;

/**
 * Asks the server to refresh the session if it is due. Calls in this tab share one
 * request; tabs queue on a Web Lock, and the server skips the refresh when another
 * tab has just done it.
 */
export function refreshHostSession(deps: HostClientDeps = browserDeps()): Promise<RefreshOutcome> {
  if (!inFlight) {
    const run = () => postRefresh(deps.fetch, deps.standalone === true);
    const underLock = async (): Promise<RefreshOutcome> => (deps.locks ? await deps.locks.request(HOST_REFRESH_LOCK, run) : run());
    inFlight = underLock().finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}

async function needsRefresh(response: Response): Promise<boolean> {
  return response.status === 401 && (await errorCode(response)) === "session_refresh_required";
}

/**
 * fetch for `/host/api/<path>`. When the relay says the ID token needs refreshing,
 * refreshes through the same single-flight path and retries once. Bodies must be
 * re-sendable (string, Blob, FormData, URLSearchParams), not streams.
 */
export async function hostFetch(path: string, init: RequestInit = {}, deps: HostClientDeps = browserDeps()): Promise<Response> {
  const url = `${HOST_API_PREFIX}${path.replace(/^\/+/, "")}`;
  const send = () => deps.fetch(url, { ...init, credentials: "same-origin", cache: "no-store" });
  const first = await send();
  if (!(await needsRefresh(first))) return first;
  const outcome = await refreshHostSession(deps);
  if (outcome.status === "signed-out" || outcome.status === "app-sign-in") {
    deps.onSignedOut();
    return first;
  }
  return outcome.status === "ok" ? send() : first;
}
