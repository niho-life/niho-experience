import { acceptResourceGoogleWatch } from "@/lib/experience/resource-google";
import { experiencePool } from "@/lib/experience/store-server";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const pool = experiencePool();
  if (!pool) return new Response(null, { status: 404 });
  // Google bodies and headers are intentionally neither parsed nor logged.
  const accepted = await acceptResourceGoogleWatch(pool, request.headers).catch(() => false);
  return new Response(null, { status: accepted ? 204 : 404, headers: { "cache-control": "no-store" } });
}
