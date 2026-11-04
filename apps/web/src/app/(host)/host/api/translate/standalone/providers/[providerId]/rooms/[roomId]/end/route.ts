import { isExperienceTranslateRoomPathId, isStandaloneTranslateRoomId } from "@niho-experience/api-client/experience-translate-rooms-schema";
import {
  loadStandaloneTranslateRoomsClient,
  readEmptyTranslateBody,
  translateRoomsFailure,
  translateRoomsJson,
  translateRoomsMutationAllowed,
} from "@/lib/host/translate-rooms-server";

type Context = { params: Promise<{ providerId: string; roomId: string }> };

export async function POST(request: Request, context: Context) {
  const { providerId, roomId } = await context.params;
  if (new URL(request.url).search || !isExperienceTranslateRoomPathId(providerId) || !isStandaloneTranslateRoomId(roomId)) return translateRoomsJson({ error: "not_found" }, 404);
  if (!translateRoomsMutationAllowed(request)) return translateRoomsJson({ error: "forbidden" }, 403);
  if (!(await readEmptyTranslateBody(request))) return translateRoomsJson({ error: "invalid_input" }, 400);
  const loaded = await loadStandaloneTranslateRoomsClient(providerId);
  if (!loaded.ok) return loaded.response;
  const result = await loaded.client.endStandaloneRoom(loaded.nihoProviderId, roomId);
  return result.ok ? translateRoomsJson(result.data) : translateRoomsFailure(result);
}
