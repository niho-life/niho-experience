import type { NextRequest } from "next/server";
import { getPayoutOnboardingRefresh } from "@/lib/experience/host-connect-onboarding-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = (request: NextRequest) => getPayoutOnboardingRefresh(request);
