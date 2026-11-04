import { isExperienceTranslateRoomPathId } from "@niho-experience/api-client/experience-translate-rooms-schema";
import { loadStandaloneTranslateRoomsClient, translateRoomsFailure, translateRoomsJson } from "@/lib/host/translate-rooms-server";

type Context = { params: Promise<{ providerId: string }> };

export async function GET(request: Request, context: Context) {
  const { providerId } = await context.params;
  if (new URL(request.url).search || !isExperienceTranslateRoomPathId(providerId)) return translateRoomsJson({ error: "not_found" }, 404);
  const loaded = await loadStandaloneTranslateRoomsClient(providerId);
  if (!loaded.ok) return loaded.response;
  const result = await loaded.client.getCurrentStandaloneRoom(loaded.nihoProviderId);
  return result.ok ? translateRoomsJson(result.data) : translateRoomsFailure(result);
}
