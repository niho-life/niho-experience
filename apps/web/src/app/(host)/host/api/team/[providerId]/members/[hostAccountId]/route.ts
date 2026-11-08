import { parseTeamCommand } from "@/lib/host/team-contract";
import { nativeTeamFailure, nativeTeamMutationAllowed, openNativeTeam, requestJson } from "@/lib/host/team-server";
import { noStoreJson } from "@/lib/host/server";

type Context = { params: Promise<{ providerId: string; hostAccountId: string }> };

async function mutate(request: Request, context: Context, operation: "add" | "remove") {
  if (!nativeTeamMutationAllowed(request)) return noStoreJson({ error: "forbidden" }, 403);
  if (new URL(request.url).search) return noStoreJson({ error: "invalid_request" }, 400);
  const parsed = await requestJson(request, 256);
  if (!parsed.ok) return noStoreJson({ error: parsed.reason === "too_large" ? "payload_too_large" : "invalid_request" }, parsed.reason === "too_large" ? 413 : 400);
  const input = parseTeamCommand(parsed.value);
  if (!input) return noStoreJson({ error: "invalid_request" }, 400);
  const { providerId, hostAccountId } = await context.params;
  const opened = await openNativeTeam(providerId);
  if ("response" in opened) return opened.response;
  try {
    const command = { ...opened, targetHostAccountId: hostAccountId, ...input };
    return noStoreJson(operation === "add" ? await opened.repository.addCohost(command) : await opened.repository.removeCohost(command));
  } catch (error) {
    return nativeTeamFailure(error);
  }
}

export const PUT = (request: Request, context: Context) => mutate(request, context, "add");
export const DELETE = (request: Request, context: Context) => mutate(request, context, "remove");
