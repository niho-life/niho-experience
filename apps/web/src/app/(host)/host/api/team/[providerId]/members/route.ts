import { nativeTeamFailure, openNativeTeam } from "@/lib/host/team-server";
import { noStoreJson } from "@/lib/host/server";

type Context = { params: Promise<{ providerId: string }> };

export async function GET(request: Request, context: Context) {
  if (new URL(request.url).search) return noStoreJson({ error: "invalid_request" }, 400);
  const opened = await openNativeTeam((await context.params).providerId);
  if ("response" in opened) return opened.response;
  try {
    return noStoreJson(await opened.repository.list(opened));
  } catch (error) {
    return nativeTeamFailure(error);
  }
}
