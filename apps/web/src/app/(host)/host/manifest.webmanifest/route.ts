import { NextResponse } from "next/server";
import { config } from "@/lib/config";
import { hostWebManifest } from "@/lib/host/pwa";
import { hostNotFound } from "@/lib/host/server";

/** The installable app's manifest (#177). Only the host root layout links it; 404 while HOST_PWA_ENABLED is off. */
export function GET() {
  if (!config.hostPwaEnabled) return hostNotFound();
  return new NextResponse(JSON.stringify(hostWebManifest()), {
    headers: { "content-type": "application/manifest+json; charset=utf-8", "cache-control": "private, no-store", "x-robots-tag": "noindex, nofollow" },
  });
}
