import { isExperienceTranslateBookingId, isExperienceTranslateRoomPathId } from "@niho-experience/api-client/experience-translate-rooms-schema";
import { projectTranslateRoom } from "@/host/translate";
import { loadSiteTranslateRoomsClient, readEmptyTranslateBody, translateRoomsFailure, translateRoomsJson, translateRoomsMutationAllowed } from "@/lib/host/translate-rooms-server";

type Context = { params: Promise<{ providerId: string; bookingId: string }> };

/** Experience DBで受けた確定予約から日英2人通訳を始める。予約状態・言語・個人情報はNIHOへ送らない。 */
export async function POST(request: Request, context: Context) {
  const { providerId, bookingId } = await context.params;
  if (new URL(request.url).search || !isExperienceTranslateRoomPathId(providerId) || !isExperienceTranslateBookingId(bookingId)) return translateRoomsJson({ error: "not_found" }, 404);
  if (!translateRoomsMutationAllowed(request)) return translateRoomsJson({ error: "forbidden" }, 403);
  if (!(await readEmptyTranslateBody(request))) return translateRoomsJson({ error: "invalid_input" }, 400);
  const loaded = await loadSiteTranslateRoomsClient(providerId, bookingId, "create");
  if (!loaded.ok) return loaded.response;
  const result = await loaded.client.createSiteRoom(providerId, bookingId);
  return result.ok ? translateRoomsJson(projectTranslateRoom(result.data), 201) : translateRoomsFailure(result);
}
