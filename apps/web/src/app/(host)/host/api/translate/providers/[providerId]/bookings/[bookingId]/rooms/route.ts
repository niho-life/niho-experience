import { isExperienceTranslateRoomPathId } from "@niho-experience/api-client/experience-translate-rooms-schema";
import { projectTranslateRoom } from "@/host/translate";
import { loadTranslateRoomsClient, readEmptyTranslateBody, translateRoomsFailure, translateRoomsJson, translateRoomsMutationAllowed } from "@/lib/host/translate-rooms-server";

type Context = { params: Promise<{ providerId: string; bookingId: string }> };

/** 通訳を始める (#181): makes the room for this booking and returns the two invite URLs (never the codes on their own). */
export async function POST(request: Request, context: Context) {
  const { providerId, bookingId } = await context.params;
  if (new URL(request.url).search || !isExperienceTranslateRoomPathId(providerId) || !isExperienceTranslateRoomPathId(bookingId)) return translateRoomsJson({ error: "not_found" }, 404);
  if (!translateRoomsMutationAllowed(request)) return translateRoomsJson({ error: "forbidden" }, 403);
  if (!(await readEmptyTranslateBody(request))) return translateRoomsJson({ error: "invalid_input" }, 400);
  const loaded = await loadTranslateRoomsClient(); if (!loaded.ok) return loaded.response;
  const result = await loaded.client.createRoom(providerId, bookingId);
  return result.ok ? translateRoomsJson(projectTranslateRoom(result.data), 201) : translateRoomsFailure(result);
}
