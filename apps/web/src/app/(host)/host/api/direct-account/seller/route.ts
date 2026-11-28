import type { NextRequest } from "next/server";
import { postDirectSeller } from "@/lib/experience/host-direct-account-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = (request: NextRequest) => postDirectSeller(request);
