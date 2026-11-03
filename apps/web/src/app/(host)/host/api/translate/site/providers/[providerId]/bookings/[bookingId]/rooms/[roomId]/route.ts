import { isExperienceTranslateBookingId, isExperienceTranslateRoomPathId } from "@niho-experience/api-client/experience-translate-rooms-schema";
import { projectTranslateRoomStatus } from "@/host/translate";
import { loadSiteTranslateRoomsClient, translateRoomsFailure, translateRoomsJson } from "@/lib/host/translate-rooms-server";

type Context = { params: Promise<{ providerId: string; bookingId: string; roomId: string }> };

/** 取消・日付変更後も、Experience DBで所属を再確認した同じ予約のroomを読める。 */
export async function GET(request: Request, context: Context) {
  const { providerId, bookingId, roomId } = await context.params;
  if (new URL(request.url).search || !isExperienceTranslateRoomPathId(providerId) || !isExperienceTranslateBookingId(bookingId) || !isExperienceTranslateRoomPathId(roomId)) return translateRoomsJson({ error: "not_found" }, 404);
  const loaded = await loadSiteTranslateRoomsClient(providerId, bookingId, "status");
  if (!loaded.ok) return loaded.response;
  const result = await loaded.client.getSiteRoom(providerId, bookingId, roomId);
  return result.ok ? translateRoomsJson(projectTranslateRoomStatus(result.data)) : translateRoomsFailure(result);
}
