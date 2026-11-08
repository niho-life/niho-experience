import "server-only";
import { redirect } from "next/navigation";
import { hostReturnPathOrNull, withQuery } from "@/lib/host/routes";
import { readHostSession } from "@/lib/host/server";
import { loadWriteContext, type WriteContext } from "./server";

type WritePageContext = WriteContext & { readonly account: { readonly displayName: string; readonly iconUrl: string | null } };
export type WritePageAccess =
  | { readonly ok: true; readonly context: WritePageContext }
  | { readonly ok: false; readonly reason: "forbidden" | "preparing" | "unavailable" };

const EXPERIENCE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function writeExperienceQuery(query: Record<string, string | string[] | undefined>):
  | { readonly ok: true; readonly experience: string | null }
  | { readonly ok: false } {
  if (Object.keys(query).some((key) => key !== "experience")) return { ok: false };
  const value = query.experience;
  if (value === undefined) return { ok: true, experience: null };
  return typeof value === "string" && value.length <= 160 && EXPERIENCE_SLUG.test(value)
    ? { ok: true, experience: value }
    : { ok: false };
}

/** Pages cannot rotate cookies while rendering, so auth/migration goes through the fixed /host bridge. */
export async function loadWritePageAccess(returnPath: string): Promise<WritePageAccess> {
  const safeReturn = hostReturnPathOrNull(returnPath) ?? "/write";
  const loaded = await loadWriteContext();
  if (loaded.ok) {
    let session: Awaited<ReturnType<typeof readHostSession>> = null;
    try { session = await readHostSession(); } catch { /* current OWNER resolution above remains authoritative */ }
    const account = session?.kind === "niho"
      ? { displayName: session.displayName || "NIHO アカウント", iconUrl: session.iconUrl }
      : { displayName: "NIHO アカウント", iconUrl: null };
    return { ok: true, context: { ...loaded.value, account } };
  }
  if (loaded.response.status === 401) redirect(withQuery("/host/auth/write-bridge", { returnTo: safeReturn }));
  if (loaded.response.status === 403) return { ok: false, reason: "forbidden" };
  try {
    const body = await loaded.response.clone().json() as { error?: string };
    if (body.error === "write_not_ready") return { ok: false, reason: "preparing" };
  } catch { /* malformed internal response remains unavailable */ }
  return { ok: false, reason: "unavailable" };
}
