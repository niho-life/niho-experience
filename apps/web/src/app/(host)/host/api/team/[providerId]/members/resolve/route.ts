import { parseTeamResolve } from "@/lib/host/team-contract";
import { nativeTeamFailure, nativeTeamMutationAllowed, openNativeTeam, requestJson } from "@/lib/host/team-server";
import { noStoreJson } from "@/lib/host/server";

type Context = { params: Promise<{ providerId: string }> };

export async function POST(request: Request, context: Context) {
  if (!nativeTeamMutationAllowed(request)) return noStoreJson({ error: "forbidden" }, 403);
  if (new URL(request.url).search) return noStoreJson({ error: "invalid_request" }, 400);
  const parsed = await requestJson(request, 1024);
  if (!parsed.ok) return noStoreJson({ error: parsed.reason === "too_large" ? "payload_too_large" : "invalid_request" }, parsed.reason === "too_large" ? 413 : 400);
  const input = parseTeamResolve(parsed.value);
  if (!input) return noStoreJson({ error: "invalid_request" }, 400);
  const opened = await openNativeTeam((await context.params).providerId);
  if ("response" in opened) return opened.response;
  try {
    return noStoreJson(await opened.repository.resolve({ ...opened, email: input.email }));
  } catch (error) {
    return nativeTeamFailure(error);
  }
}
