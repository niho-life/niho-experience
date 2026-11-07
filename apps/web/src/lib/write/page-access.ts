import "server-only";
import { redirect } from "next/navigation";
import { hostReturnPathOrNull, withQuery } from "@/lib/host/routes";
import { loadWriteContext, type WriteContext } from "./server";

export type WritePageAccess =
  | { readonly ok: true; readonly context: WriteContext }
  | { readonly ok: false; readonly reason: "forbidden" | "unavailable" };

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
  if (loaded.ok) return { ok: true, context: loaded.value };
  if (loaded.response.status === 401) redirect(withQuery("/host/auth/write-bridge", { returnTo: safeReturn }));
  return { ok: false, reason: loaded.response.status === 403 ? "forbidden" : "unavailable" };
}
