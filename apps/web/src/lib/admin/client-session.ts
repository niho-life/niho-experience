import { ADMIN_ENTRY_PATH, ADMIN_REFRESH_PATH } from "./routes";

export const ADMIN_REFRESH_LOCK = "niho-admin-refresh";

export type AdminRefreshOutcome =
  | { status: "ok"; idTokenExpiresAt: number }
  | { status: "signed-out" }
  | { status: "failed" };

export interface AdminClientDeps {
  fetch: typeof fetch;
  locks?: Pick<LockManager, "request"> | undefined;
  onSignedOut: () => void;
}

function browserDeps(): AdminClientDeps {
  return {
    fetch: (...args) => fetch(...args),
    locks: typeof navigator !== "undefined" && "locks" in navigator ? navigator.locks : undefined,
    onSignedOut: () => window.location.assign(ADMIN_ENTRY_PATH),
  };
}

async function postRefresh(fetchImpl: typeof fetch): Promise<AdminRefreshOutcome> {
  try {
    const response = await fetchImpl(ADMIN_REFRESH_PATH, {
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

let inFlight: Promise<AdminRefreshOutcome> | null = null;

export function refreshAdminSession(deps: AdminClientDeps = browserDeps()): Promise<AdminRefreshOutcome> {
  if (!inFlight) {
    const run = () => postRefresh(deps.fetch);
    const underLock = async () => deps.locks ? await deps.locks.request(ADMIN_REFRESH_LOCK, run) : run();
    inFlight = underLock().finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}
