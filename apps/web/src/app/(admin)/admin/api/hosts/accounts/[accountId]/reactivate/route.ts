import { adminHostAccounts } from "@/lib/experience/store-server";
import { adminJson } from "@/lib/admin/server";
import { hostAdminRun, validAccountId } from "@/lib/admin/admin-host-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ accountId: string }> };

/** ホストのアカウント: `reactivateHostAccount` for the office (#711). Suspending ends its sessions and sign-in links; memberships stay. */
export async function POST(request: Request, context: Context) {
  const { accountId } = await context.params;
  if (!validAccountId(accountId)) return adminJson({ error: "invalid_input" }, 400);
  return hostAdminRun(request, { write: true }, async (actor) => {
    const accounts = adminHostAccounts();
    if (!accounts) throw new Error("unavailable");
    const change = await accounts.reactivateHostAccount({ hostAccountId: accountId, actorId: actor.nihoUserId, nowUtc: new Date().toISOString() });
    return { hostAccountId: accountId, changed: change === "CHANGED" };
  });
}
