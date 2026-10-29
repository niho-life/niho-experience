import { isExperienceTranslateRoomPathId } from "@niho-experience/api-client/experience-translate-rooms-schema";
import { loadTranslateRoomsClient, readEmptyTranslateBody, translateRoomsFailure, translateRoomsJson, translateRoomsMutationAllowed } from "@/lib/host/translate-rooms-server";

type Context = { params: Promise<{ providerId: string; bookingId: string; roomId: string }> };

/** 通訳を終了 (#181): ends the room; the invite URLs stop working. */
export async function POST(request: Request, context: Context) {
  const { providerId, bookingId, roomId } = await context.params;
  if (new URL(request.url).search || !isExperienceTranslateRoomPathId(providerId) || !isExperienceTranslateRoomPathId(bookingId) || !isExperienceTranslateRoomPathId(roomId)) return translateRoomsJson({ error: "not_found" }, 404);
  if (!translateRoomsMutationAllowed(request)) return translateRoomsJson({ error: "forbidden" }, 403);
  if (!(await readEmptyTranslateBody(request))) return translateRoomsJson({ error: "invalid_input" }, 400);
  const loaded = await loadTranslateRoomsClient(); if (!loaded.ok) return loaded.response;
  const result = await loaded.client.endRoom(providerId, bookingId, roomId);
  return result.ok ? translateRoomsJson({ state: result.data.state }) : translateRoomsFailure(result);
}
