import { config } from "@/lib/config";
import { HOST_EXPERIENCES_PATH, HOST_SHARED_QUERY } from "@/lib/host/routes";
import { hostNotFound, seeOther } from "@/lib/host/server";

/**
 * Android's share sheet posts a photo here (#177 P3, the manifest's `share_target`). /host/sw.js answers that request itself,
 * keeps the photo in its memory and sends the host on to 体験. This route is only reached when no worker controls the page
 * (the app was just installed, or the worker was replaced). It reads and keeps nothing of the upload: it sends the host to 体験
 * with `?shared=none`, where the console says the photo did not arrive and asks them to share it again.
 */
export function POST() {
  if (!config.hostPwaEnabled) return hostNotFound();
  return seeOther(`${HOST_EXPERIENCES_PATH}?${HOST_SHARED_QUERY}=none`);
}
