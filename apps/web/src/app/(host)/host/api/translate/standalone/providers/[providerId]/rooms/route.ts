import { isExperienceTranslateRoomPathId } from "@niho-experience/api-client/experience-translate-rooms-schema";
import {
  loadStandaloneTranslateRoomsClient,
  readStandaloneTranslateCreateBody,
  translateRoomsFailure,
  translateRoomsJson,
  translateRoomsMutationAllowed,
} from "@/lib/host/translate-rooms-server";

type Context = { params: Promise<{ providerId: string }> };

export async function POST(request: Request, context: Context) {
  const { providerId } = await context.params;
  if (new URL(request.url).search || !isExperienceTranslateRoomPathId(providerId)) return translateRoomsJson({ error: "not_found" }, 404);
  if (!translateRoomsMutationAllowed(request)) return translateRoomsJson({ error: "forbidden" }, 403);
  const body = await readStandaloneTranslateCreateBody(request);
  if (!body) return translateRoomsJson({ error: "invalid_input" }, 400);
  const loaded = await loadStandaloneTranslateRoomsClient(providerId);
  if (!loaded.ok) return loaded.response;
  const result = await loaded.client.createStandaloneRoom(loaded.providerApiId, body.hostLanguage);
  return result.ok ? translateRoomsJson(result.data, 201) : translateRoomsFailure(result, { serviceAuth: loaded.serviceAuth });
}
