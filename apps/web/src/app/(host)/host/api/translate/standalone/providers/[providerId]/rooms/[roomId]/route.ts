import { isExperienceTranslateRoomPathId, isStandaloneTranslateRoomId } from "@niho-experience/api-client/experience-translate-rooms-schema";
import { loadStandaloneTranslateRoomsClient, translateRoomsFailure, translateRoomsJson } from "@/lib/host/translate-rooms-server";

type Context = { params: Promise<{ providerId: string; roomId: string }> };

export async function GET(request: Request, context: Context) {
  const { providerId, roomId } = await context.params;
  if (new URL(request.url).search || !isExperienceTranslateRoomPathId(providerId) || !isStandaloneTranslateRoomId(roomId)) return translateRoomsJson({ error: "not_found" }, 404);
  const loaded = await loadStandaloneTranslateRoomsClient(providerId);
  if (!loaded.ok) return loaded.response;
  const result = await loaded.client.getStandaloneRoom(loaded.providerApiId, roomId);
  return result.ok ? translateRoomsJson(result.data) : translateRoomsFailure(result, { serviceAuth: loaded.serviceAuth });
}
