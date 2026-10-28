import { NextResponse } from "next/server";
import { config } from "@/lib/config";
import { hostServiceWorkerSource } from "@/lib/host/service-worker";

/**
 * The app's service worker (#177). Never a 404, even with the console off: browsers keep the
 * installed worker when its update fails, so HOST_PWA_ENABLED=false serves one that removes itself.
 */
export function GET() {
  return new NextResponse(hostServiceWorkerSource(config.hostPwaEnabled), {
    headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "private, no-store", "x-robots-tag": "noindex, nofollow" },
  });
}
