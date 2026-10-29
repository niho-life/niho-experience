import { isExperienceTranslateRoomPathId } from "@niho-experience/api-client/experience-translate-rooms-schema";
import { projectTranslateRoomStatus } from "@/host/translate";
import { loadTranslateRoomsClient, translateRoomsFailure, translateRoomsJson } from "@/lib/host/translate-rooms-server";

type Context = { params: Promise<{ providerId: string; bookingId: string; roomId: string }> };

/** 参加状況 (#181): the screen reads this every 3 seconds while it is visible. */
export async function GET(request: Request, context: Context) {
  const { providerId, bookingId, roomId } = await context.params;
  if (new URL(request.url).search || !isExperienceTranslateRoomPathId(providerId) || !isExperienceTranslateRoomPathId(bookingId) || !isExperienceTranslateRoomPathId(roomId)) return translateRoomsJson({ error: "not_found" }, 404);
  const loaded = await loadTranslateRoomsClient(); if (!loaded.ok) return loaded.response;
  const result = await loaded.client.getRoom(providerId, bookingId, roomId);
  return result.ok ? translateRoomsJson(projectTranslateRoomStatus(result.data)) : translateRoomsFailure(result);
}
