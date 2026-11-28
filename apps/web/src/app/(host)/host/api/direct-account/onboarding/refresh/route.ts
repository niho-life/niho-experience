import type { NextRequest } from "next/server";
import { getDirectOnboardingRefresh } from "@/lib/experience/host-direct-account-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = (request: NextRequest) => getDirectOnboardingRefresh(request);
