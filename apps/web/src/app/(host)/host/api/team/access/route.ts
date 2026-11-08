import { config } from "@/lib/config";
import { productOperatorRepository } from "@/lib/experience/store-server";
import { renderedHostAccessFingerprint } from "@/lib/host/access-fingerprint";
import { loadHostProvidersFresh, noStoreJson, readHostSession } from "@/lib/host/server";

export async function GET(request: Request) {
  if (new URL(request.url).search || !config.hostTeamEnabled || !config.hostAccountsEnabled || config.apiMode !== "http") return noStoreJson({ error: "not_found" }, 404);
  let session: Awaited<ReturnType<typeof readHostSession>>;
  try { session = await readHostSession(); }
  catch { return noStoreJson({ error: "access_unavailable" }, 503); }
  if (!session || session.kind !== "experience") return noStoreJson({ error: "unauthenticated" }, 401);
  try {
    const providers = await loadHostProvidersFresh();
    if (providers.status === "signed-out" || providers.status === "rejected" || providers.status === "refresh") return noStoreJson({ error: "unauthenticated" }, 401);
    if (providers.status !== "ok" || providers.nihoUserId !== session.hostAccountId) return noStoreJson({ error: "access_unavailable" }, 503);
    const operators = productOperatorRepository();
    const assignments = operators ? await operators.listAssignments(session.hostAccountId) : [];
    return noStoreJson({ contractVersion: 1, fingerprint: renderedHostAccessFingerprint(providers.providers, assignments) });
  } catch {
    return noStoreJson({ error: "access_unavailable" }, 503);
  }
}
