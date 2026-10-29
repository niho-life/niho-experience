import { EDITOR_REFRESH_PATH } from "./routes";

export const EDITOR_REFRESH_LOCK = "niho-editor-refresh";

export type EditorRefreshOutcome =
  | { status: "ok"; idTokenExpiresAt: number }
  | { status: "signed-out" }
  | { status: "reconnect" }
  | { status: "failed" };

export interface EditorClientDeps {
  fetch: typeof fetch;
  locks?: Pick<LockManager, "request"> | undefined;
}

function browserDeps(): EditorClientDeps {
  return {
    fetch: (...args) => fetch(...args),
    locks: typeof navigator !== "undefined" && "locks" in navigator ? navigator.locks : undefined,
  };
}

async function postRefresh(fetchImpl: typeof fetch): Promise<EditorRefreshOutcome> {
  try {
    const response = await fetchImpl(EDITOR_REFRESH_PATH, {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { accept: "application/json" },
    });
    if (response.status === 401) return { status: "signed-out" };
    if (!response.ok) return { status: "failed" };
    const body = await response.json() as { idTokenExpiresAt?: unknown };
    const idTokenExpiresAt = Number(body.idTokenExpiresAt);
    return Number.isFinite(idTokenExpiresAt) ? { status: "ok", idTokenExpiresAt } : { status: "failed" };
  } catch {
    return { status: "failed" };
  }
}

let inFlight: Promise<EditorRefreshOutcome> | null = null;

/**
 * Future editor UI must use this entry point rather than POSTing directly, so
 * tabs sharing the rotating refresh cookie serialize through Web Locks.
 */
export function refreshEditorSession(deps: EditorClientDeps = browserDeps()): Promise<EditorRefreshOutcome> {
  if (!inFlight) {
    const run = () => postRefresh(deps.fetch);
    const underLock = async (): Promise<EditorRefreshOutcome> => {
      // A lockless tab could submit a stale rotating token after another tab.
      // Ask the writer to reconnect instead of risking both sessions.
      if (!deps.locks) return { status: "reconnect" };
      try {
        return await deps.locks.request(EDITOR_REFRESH_LOCK, run);
      } catch {
        return { status: "failed" };
      }
    };
    inFlight = underLock().finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}
